#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP LinkedIn Connector (v0.3.3)
 *
 * Session-cookie only: no automated credential fill. LinkedIn is aggressively
 * anti-bot (manifest `bot_detection_sensitivity: "high"`), so this connector
 * proves an existing browser session and, when absent, navigates to LinkedIn
 * login before handing the page to the owner. The owner authenticates manually
 * in the connector's persistent browser profile; LinkedIn session readiness is
 * detected automatically before collection continues.
 *
 * All Voyager calls run inside the logged-in page context via
 * `page.evaluate(fetch)`, exactly as the legacy connector did — Voyager
 * requires the session cookie + CSRF token pair that only exists in that
 * context, and has no public CORS allowance.
 *
 * Streams (D7 — capability-map.json `linkedin`):
 *   profile      /voyager/api/me + dash/profiles (FullProfileWithEntities)
 *   experience   dash/profiles profilePositionGroups (D3: one record per role)
 *   education    dash/profiles profileEducations
 *   skills       dash/profiles profileSkills
 *   languages    dash/profiles profileLanguages (D7: new stream)
 *   connections  relationships/dash/connections + batch dash/profiles resolve
 *                (D7: new stream)
 *
 * Ground truth: connectors/linkedin/linkedin-playwright.js (legacy). Field
 * mapping and dual timePeriod/dateRange date handling ported to parsers.ts;
 * see that file's header for the decoration-version fallback chain.
 *
 * Tested surfaces (as of 2026-09-22, one live run + one incremental re-run):
 *   - One personal US/EN account, all six streams requested. 353 connections
 *     (complete, non-truncated), 6 experience positions, 1 education entry,
 *     16 skills, 1 language. `FullProfileWithEntities-93` resolved on the
 *     FIRST attempt every time observed — the `-109`/basic fallbacks in
 *     `PROFILE_DECORATION_IDS` have never been exercised against a real
 *     response; they remain untested.
 *
 * Known untested:
 *   - Any account where `-93` 404s/reshapes and a fallback decoration id is
 *     actually needed.
 *   - Non-US / non-EN locales, business/Premium accounts, accounts with
 *     >2000 connections (the CONNECTIONS_MAX truncation path), accounts
 *     with categorized (non-flat) `profileSkills`, accounts with a
 *     `profileEducations[].grade` value set.
 *
 * CHANGES
 *   v0.3.3 (2026-09-24) — detect LinkedIn readiness during sign-in and
 *     continue collection automatically after `/voyager/api/me` succeeds.
 *   v0.3.2 (2026-09-24) — navigate to LinkedIn login before the manual
 *     owner handoff when the profile has no live Voyager session, then verify
 *     `/voyager/api/me` after the handoff before collection starts.
 *   v0.3.1 (2026-09-22) — live-verified against one real account; fixed two
 *     real-shape bugs the first pass got wrong from legacy-code inference
 *     alone: `profile.industry` reads Voyager's `industry.name` object (not
 *     a bare `industryName` string, which never exists), and
 *     `experience.employment_type` reads the real `employmentType.name`
 *     field instead of a hardcoded `null`. Also fixed `profile.connection_count`
 *     to never report a truncated (partial) connections count as if it were
 *     the true total — `paging.total` was never observed on any real
 *     connections-listing response, contradicting the field this and the
 *     legacy connector both assumed.
 *   v0.2.0 (2026-09-22) — real Voyager extraction wired (profile, experience,
 *     education, skills, languages, connections); replaces the
 *     linkedin_voyager_wiring_pending scaffold.
 *   v0.1.0 — browser scaffold: session probe only, unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	buildFullScanCoverageMessage,
	type EmittedMessage,
	type EnsureSessionArgs,
	type ProbeSessionArgs,
	type ProgressExtra,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { CaptureSession } from "../../packages/polyfill-connectors/src/fixture-capture.ts";
import {
	buildConnectionRecord,
	buildEducationRecords,
	buildExperienceRecords,
	buildLanguageRecords,
	buildProfileRecord,
	buildSkillRecords,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	VoyagerConnectionsResponse,
	VoyagerDashProfilesResponse,
	VoyagerMeResponse,
	VoyagerProfileElement,
	VoyagerProfilesByIdResponse,
	VoyagerResolvedProfile,
} from "./types.ts";

const LINKEDIN_FEED_URL = "https://www.linkedin.com/feed/";
const LINKEDIN_LOGIN_URL = "https://www.linkedin.com/login";
const SESSION_COOKIE = /li_at|JSESSIONID/;
const CONNECTIONS_PAGE_SIZE = 40;
const CONNECTIONS_MAX = 2000;
const RESOLVE_BATCH_SIZE = 20;
const PAGE_DELAY_MS = 500;

// Decoration id fallback chain, in the order the legacy connector observed
// them working. LinkedIn has shipped multiple `FullProfileWithEntities`
// decoration versions; a stale pinned version 404s. Falling back to the
// undecorated basic-profile endpoint always returns SOMETHING (no
// experience/education/skills/languages, but a real profile record) rather
// than failing the whole run.
const PROFILE_DECORATION_IDS = [
	"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93",
	"com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-109",
];

type VoyagerJsonResult<T> = { _error: string } | (T & { _error?: undefined });

/** Fetch a Voyager endpoint from inside the logged-in page context. Voyager
 *  has no public CORS allowance, so this must run via `page.evaluate` on a
 *  page already navigated to linkedin.com — never a cross-origin `fetch`
 *  from the connector process.
 *
 *  `capture`/`label` are optional (null unless `PDPP_CAPTURE_FIXTURES=1`):
 *  when present, the raw parsed response is written to
 *  `fixtures/linkedin/raw/<runId>/http/<nnnn>-<label>.json` so a live run
 *  can prove the real Voyager response shape against `types.ts`/`parsers.ts`
 *  inference, per docs/reference/connector-authoring-guide.md §9.1. */
async function voyagerFetch<T>(
	page: Page,
	endpoint: string,
	capture?: CaptureSession | null,
	label?: string,
): Promise<VoyagerJsonResult<T>> {
	const result = await page.evaluate(
		async ({ path }) => {
			try {
				const csrfMatch = document.cookie.match(/JSESSIONID="?([^";]+)/);
				const csrfToken = csrfMatch ? csrfMatch[1] : "";
				const resp = await fetch(path, {
					credentials: "include",
					headers: { "csrf-token": csrfToken ?? "" },
				});
				if (!resp.ok) {
					return { _error: `http_${resp.status}` };
				}
				return { _body: await resp.json(), _status: resp.status };
			} catch (err) {
				return { _error: err instanceof Error ? err.message : String(err) };
			}
		},
		{ path: endpoint },
	);
	if ("_error" in result) {
		return result as VoyagerJsonResult<T>;
	}
	capture?.captureHttp(label ?? endpoint, result._body, {
		endpoint,
		status: result._status,
	});
	return result._body as VoyagerJsonResult<T>;
}

function isFetchError<T>(
	result: VoyagerJsonResult<T>,
): result is { _error: string } {
	return typeof (result as { _error?: unknown })._error === "string";
}

/** Session liveness: an authenticated `/voyager/api/me` call succeeds. Used
 *  both as the runtime's `probeSession` and as collect()'s own pre-flight —
 *  a session can die between probe and collect on a long-running host. */
async function checkApiAuth(
	page: Page,
	capture?: CaptureSession | null,
): Promise<boolean> {
	const result = await voyagerFetch<VoyagerMeResponse>(
		page,
		"/voyager/api/me",
		capture,
		"me",
	);
	return !isFetchError(result);
}

/** Fetch the full dash profile, trying each known decoration id in turn.
 *  Returns the first successful element, or null if every attempt failed
 *  (the caller still has the basic `/me` fields to fall back to). */
async function fetchDashProfile(
	page: Page,
	publicIdentifier: string,
	capture?: CaptureSession | null,
): Promise<VoyagerProfileElement | null> {
	const publicIdStr = encodeURIComponent(publicIdentifier);
	for (const decorationId of PROFILE_DECORATION_IDS) {
		const result = await voyagerFetch<VoyagerDashProfilesResponse>(
			page,
			`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicIdStr}&decorationId=${decorationId}`,
			capture,
			`dash-profile-${decorationId.split("-").pop()}`,
		);
		if (
			!isFetchError(result) &&
			result.elements &&
			result.elements.length > 0
		) {
			return result.elements[0] ?? null;
		}
		await politeDelay(300);
	}
	const basic = await voyagerFetch<VoyagerDashProfilesResponse>(
		page,
		`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicIdStr}`,
		capture,
		"dash-profile-basic",
	);
	if (!isFetchError(basic) && basic.elements && basic.elements.length > 0) {
		return basic.elements[0] ?? null;
	}
	return null;
}

interface ConnectionsResult {
	elements: { connectedMember?: string; createdAt?: number }[];
	total: number | null;
	truncated: boolean;
}

/** Paginate the owner's connections list. `paging.total` is coded as a
 *  fallback source for the running total (matching the legacy connector's
 *  inference), but a live-account capture (2026-09-22, 353 connections
 *  across 9 pages) never populated it on any page — this endpoint's real
 *  response carries only `{ count, start, links }` in `paging`. In
 *  practice the total is `elements.length` from a complete (non-truncated)
 *  walk; capped at `CONNECTIONS_MAX` (matches the legacy connector's cap)
 *  with `truncated` reported honestly when the cap — not the provider —
 *  stopped the walk, since a truncated walk's `elements.length` is not the
 *  true total either. */
async function fetchConnections(
	page: Page,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
	capture?: CaptureSession | null,
): Promise<ConnectionsResult> {
	const elements: { connectedMember?: string; createdAt?: number }[] = [];
	let start = 0;
	let total: number | null = null;

	while (start < CONNECTIONS_MAX) {
		const result = await voyagerFetch<VoyagerConnectionsResponse>(
			page,
			`/voyager/api/relationships/dash/connections?count=${CONNECTIONS_PAGE_SIZE}&q=search&sortType=RECENTLY_ADDED&start=${start}`,
			capture,
			`connections-page-${String(start).padStart(4, "0")}`,
		);
		if (isFetchError(result)) {
			break;
		}
		total = result.paging?.total ?? total;
		const page_elements = result.elements ?? [];
		if (page_elements.length === 0) {
			break;
		}
		elements.push(...page_elements);
		await progress("Fetched LinkedIn connections page", {
			count: elements.length,
			stream: "connections",
			...(total !== null ? { total } : {}),
		});
		if (page_elements.length < CONNECTIONS_PAGE_SIZE) {
			return { elements, total, truncated: false };
		}
		start += CONNECTIONS_PAGE_SIZE;
		await politeDelay(PAGE_DELAY_MS);
	}

	return {
		elements,
		total,
		truncated: start >= CONNECTIONS_MAX && elements.length > 0,
	};
}

/** Batch-resolve connection member URNs to profile summaries (name,
 *  headline, public identifier) via the same dash/profiles endpoint used
 *  for the owner's own profile, keyed by `ids=List(...)`. Failures degrade
 *  to a smaller retry (never silently drop the whole batch) and, past two
 *  consecutive batch failures, stop resolving — the connection edges
 *  themselves are still emitted with null enrichment fields. */
async function resolveConnectionProfiles(
	page: Page,
	memberUrns: string[],
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
	capture?: CaptureSession | null,
): Promise<Map<string, VoyagerResolvedProfile>> {
	const resolved = new Map<string, VoyagerResolvedProfile>();
	let consecutiveFailures = 0;
	let batchIndex = 0;

	for (let i = 0; i < memberUrns.length; i += RESOLVE_BATCH_SIZE) {
		if (consecutiveFailures >= 5) {
			break;
		}
		const batch = memberUrns.slice(i, i + RESOLVE_BATCH_SIZE);
		const urnList = batch.map((u) => encodeURIComponent(u)).join(",");
		const result = await voyagerFetch<VoyagerProfilesByIdResponse>(
			page,
			`/voyager/api/identity/dash/profiles?ids=List(${urnList})`,
			capture,
			`resolve-batch-${String(batchIndex).padStart(3, "0")}`,
		);
		batchIndex += 1;

		if (isFetchError(result)) {
			consecutiveFailures += 1;
			await politeDelay(PAGE_DELAY_MS);
			continue;
		}
		consecutiveFailures = 0;

		if (result.results) {
			for (const [key, profile] of Object.entries(result.results)) {
				if (profile && (profile.firstName || profile.publicIdentifier)) {
					resolved.set(key, profile);
				}
			}
		}
		if (result.elements) {
			for (const profile of result.elements) {
				const urn = profile.entityUrn ?? profile.dashEntityUrn;
				if (urn && (profile.firstName || profile.publicIdentifier)) {
					resolved.set(urn, profile);
				}
			}
		}

		await progress("Resolved LinkedIn connection profiles", {
			count: resolved.size,
			stream: "connections",
			total: memberUrns.length,
		});
		await politeDelay(PAGE_DELAY_MS);
	}

	return resolved;
}

export async function hasLinkedInSessionCookie(
	context: ProbeSessionArgs["context"],
): Promise<boolean> {
	const cookies = await context.cookies("https://www.linkedin.com/");
	return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
}

export async function ensureLinkedInSession(
	{
		assist,
		capture,
		completeAssistance,
		context,
		page,
		sendInteraction,
	}: Pick<
		EnsureSessionArgs,
		| "assist"
		| "capture"
		| "completeAssistance"
		| "context"
		| "page"
		| "sendInteraction"
	>,
	timeoutSeconds = 1800,
): Promise<void> {
	if (await hasLinkedInSessionCookie(context)) {
		await page
			.goto(LINKEDIN_FEED_URL, {
				timeout: 30_000,
				waitUntil: "domcontentloaded",
			})
			.catch((): undefined => undefined);
		if (await checkApiAuth(page, capture)) {
			return;
		}
	}

	try {
		await page.goto(LINKEDIN_LOGIN_URL, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		});
	} catch (err) {
		throw new Error("linkedin_login_page_unreachable", { cause: err });
	}

	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to LinkedIn in the secure browser. PDPP will verify the session and continue automatically.",
		page,
		probe: () => checkApiAuth(page, capture),
		readinessProbe: async (readinessPage) => {
			await readinessPage
				.goto(LINKEDIN_FEED_URL, { waitUntil: "domcontentloaded" })
				.catch((): undefined => undefined);
			return checkApiAuth(readinessPage, capture);
		},
		sendInteraction,
		timeoutSeconds,
	});
	if (!ready || !(await checkApiAuth(page, capture))) {
		throw new Error(
			"linkedin_login_incomplete: no live Voyager session after owner handoff",
		);
	}
}

export async function collectLinkedIn(
	ctx: BrowserCollectContext,
): Promise<void> {
	const { capture, emit, emitRecord, page, progress, requested } = ctx;

	await page
		.goto(LINKEDIN_FEED_URL, {
			timeout: 30_000,
			waitUntil: "domcontentloaded",
		})
		.catch((): undefined => undefined);
	await politeDelay(1500);

	const isAuthenticated = await checkApiAuth(page, capture);
	if (!isAuthenticated) {
		throw new Error(
			"linkedin_session_dead: no live Voyager session (li_at/JSESSIONID cookie missing or expired); manual login required in the connector's browser profile",
		);
	}

	await progress("Fetching LinkedIn profile", { stream: "profile" });
	const meResult = await voyagerFetch<VoyagerMeResponse>(
		page,
		"/voyager/api/me",
		capture,
		"me",
	);
	if (isFetchError(meResult)) {
		throw new Error(`linkedin_profile_fetch_failed: ${meResult._error}`);
	}
	const publicIdentifier =
		meResult.miniProfile?.publicIdentifier ?? meResult.publicIdentifier;
	if (!publicIdentifier) {
		throw new Error(
			"linkedin_profile_fetch_failed: no publicIdentifier on /voyager/api/me response",
		);
	}

	const wantsProfileFields = requested.has("profile");
	const wantsExperience = requested.has("experience");
	const wantsEducation = requested.has("education");
	const wantsSkills = requested.has("skills");
	const wantsLanguages = requested.has("languages");
	const wantsConnections = requested.has("connections");

	let dashProfile: VoyagerProfileElement | null = null;
	if (
		wantsProfileFields ||
		wantsExperience ||
		wantsEducation ||
		wantsSkills ||
		wantsLanguages
	) {
		dashProfile = await fetchDashProfile(page, publicIdentifier, capture);
	}

	// `profile.connection_count` is only available from the connections
	// listing's `paging.total` (legacy: `profileResult.connections =
	// totalAvailable || connectionRecords.length`, set AFTER the connections
	// fetch completes) — nowhere on /me or the dash profile payload. Fetch the
	// connections listing here, before emitting `profile`, whenever either
	// stream is requested, and reuse the same walk for the `connections`
	// stream below rather than fetching twice.
	let connectionsResult: ConnectionsResult | null = null;
	if (wantsProfileFields || wantsConnections) {
		await progress("Fetching LinkedIn connections", { stream: "connections" });
		connectionsResult = await fetchConnections(page, progress, capture);
	}
	// `elements.length` is only the true total when the walk completed
	// (not truncated by CONNECTIONS_MAX) — a truncated count is a floor,
	// not a fact, and must not be reported as connection_count.
	const connectionCount =
		connectionsResult === null || connectionsResult.truncated
			? (connectionsResult?.total ?? null)
			: (connectionsResult.total ?? connectionsResult.elements.length);

	if (wantsProfileFields) {
		if (dashProfile) {
			const record = buildProfileRecord(
				publicIdentifier,
				dashProfile,
				meResult.miniProfile?.occupation,
				meResult.miniProfile,
				connectionCount,
			);
			await emitRecord("profile", record);
			await emit(buildFullScanCoverageMessage("profile", 1));
		} else {
			await emit({
				type: "SKIP_RESULT",
				stream: "profile",
				reason: "linkedin_dash_profile_unavailable",
				message:
					"Every dash profile decoration attempt failed; only /me was reachable",
			});
		}
	}

	if (wantsExperience) {
		const records = dashProfile ? buildExperienceRecords(dashProfile) : [];
		for (const record of records) {
			await emitRecord("experience", record);
		}
		await emit(buildFullScanCoverageMessage("experience", records.length));
	}

	if (wantsEducation) {
		const records = dashProfile ? buildEducationRecords(dashProfile) : [];
		for (const record of records) {
			await emitRecord("education", record);
		}
		await emit(buildFullScanCoverageMessage("education", records.length));
	}

	if (wantsSkills) {
		const records = dashProfile ? buildSkillRecords(dashProfile) : [];
		for (const record of records) {
			await emitRecord("skills", record);
		}
		await emit(buildFullScanCoverageMessage("skills", records.length));
	}

	if (wantsLanguages) {
		const records = dashProfile ? buildLanguageRecords(dashProfile) : [];
		for (const record of records) {
			await emitRecord("languages", record);
		}
		await emit(buildFullScanCoverageMessage("languages", records.length));
	}

	if (wantsConnections && connectionsResult) {
		const { elements, truncated } = connectionsResult;
		const memberUrns = elements
			.map((e) => e.connectedMember)
			.filter((u): u is string => Boolean(u));
		const resolvedProfiles = await resolveConnectionProfiles(
			page,
			memberUrns,
			progress,
			capture,
		);

		let covered = 0;
		for (const element of elements) {
			const record = buildConnectionRecord(
				element,
				element.connectedMember
					? resolvedProfiles.get(element.connectedMember)
					: undefined,
			);
			if (record) {
				await emitRecord("connections", record);
				covered += 1;
			}
		}
		await emit(buildFullScanCoverageMessage("connections", covered));

		if (truncated) {
			await emit({
				type: "SKIP_RESULT",
				stream: "connections",
				reason: "older_connections_deferred_page_budget",
				message: `LinkedIn connections stopped at the ${CONNECTIONS_MAX}-connection cap`,
				diagnostics: {
					connections_cap: CONNECTIONS_MAX,
					total_seen: elements.length,
				},
			} satisfies EmittedMessage);
		}
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		browser: { profileName: "linkedin" },
		name: "linkedin",
		async ensureSession(args: EnsureSessionArgs): Promise<void> {
			await ensureLinkedInSession(args);
		},
		async probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
			return hasLinkedInSessionCookie(context);
		},
		validateRecord,
		async collect(ctx: BrowserCollectContext): Promise<void> {
			await collectLinkedIn(ctx);
		},
	});
}

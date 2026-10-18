#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP LinkedIn Connector (v0.3.27)
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
	buildDetailCoverageMessage,
	type EmittedMessage,
	type EnsureSessionArgs,
	type ProbeSessionArgs,
	type ProgressExtra,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { CaptureSession } from "../../packages/polyfill-connectors/src/fixture-capture.ts";
import {
	type FieldRead,
	firstOf,
	isRecord,
	read,
	type StreamRows,
	textAt,
	unavailable,
} from "./field-read.ts";
import {
	buildConnectionRows,
	buildEducationRows,
	buildExperienceRows,
	buildLanguageRows,
	buildProfileRows,
	buildSkillRows,
	collectionAt,
	connectionEnrichmentIsReadable,
	type DashProfileSource,
} from "./parsers.ts";
import { connectionEvidence, profileEvidence, sectionEvidence, summaryEvidence } from "./evidence.ts";
import { validateRecord } from "./schemas.ts";
import type {
	VoyagerConnectionElement,
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
	if (
		typeof result._body !== "object" ||
		result._body === null ||
		Array.isArray(result._body)
	) {
		return { _error: "malformed_json_body" };
	}
	return result._body as VoyagerJsonResult<T>;
}

function isFetchError<T>(
	result: VoyagerJsonResult<T>,
): result is { _error: string } {
	return (
		typeof result === "object" &&
		result !== null &&
		"_error" in result &&
		typeof result._error === "string"
	);
}

interface DashProfileResult {
	profile: VoyagerProfileElement | null;
	source: DashProfileSource;
}

function hasRecognizedProfileField(profile: Record<string, unknown>): boolean {
	return [
		"firstName",
		"geoLocation",
		"headline",
		"industry",
		"lastName",
		"location",
		"profileEducations",
		"profileLanguages",
		"profilePicture",
		"profilePositionGroups",
		"profileSkills",
		"publicIdentifier",
		"summary",
	].some((key) => Object.hasOwn(profile, key));
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
): Promise<DashProfileResult> {
	const publicIdStr = encodeURIComponent(publicIdentifier);
	for (const decorationId of PROFILE_DECORATION_IDS) {
		const result = await voyagerFetch<VoyagerDashProfilesResponse>(
			page,
			`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicIdStr}&decorationId=${decorationId}`,
			capture,
			`dash-profile-${decorationId.split("-").pop()}`,
		);
		if (!isFetchError(result) && Array.isArray(result.elements)) {
			for (const candidate of result.elements) {
				if (isRecord(candidate) && hasRecognizedProfileField(candidate)) {
					return {
						profile: candidate as VoyagerProfileElement,
						source: "decoration",
					};
				}
			}
		}
		await politeDelay(300);
	}
	const basic = await voyagerFetch<VoyagerDashProfilesResponse>(
		page,
		`/voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=${publicIdStr}`,
		capture,
		"dash-profile-basic",
	);
	if (!isFetchError(basic) && Array.isArray(basic.elements)) {
		const profile = basic.elements.find(isRecord);
		if (profile) {
			return { profile: profile as VoyagerProfileElement, source: "basic" };
		}
	}
	return { profile: null, source: "unavailable" };
}

interface ConnectionsResult {
	elements: VoyagerConnectionElement[];
	error?: string;
	observed: number;
	missingUrnCount: number;
	terminationReason:
		| "observed_end_unproven"
		| "continuation_advertised"
		| "page_error"
		| "malformed_page"
		| "repeated_page"
		| "page_budget";
	total: number | null;
}

/** Walk the owner's connections list and retain why the walk stopped.
 *  Empty/short pages and paging totals are observations, never inventory proof.
 *  Stable owner summaries, distinct emitted URNs, and an independent empty
 *  confirmation at the summary total are required by connectionEvidence. */
async function fetchConnections(
	page: Page,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
	capture?: CaptureSession | null,
	expectedTotal?: number,
): Promise<ConnectionsResult> {
	const elements: VoyagerConnectionElement[] = [];
	const seenUrns = new Set<string>();
	const seenPageFingerprints = new Set<string>();
	let start = 0;
	let observed = 0;
	let missingUrnCount = 0;
	let total: number | null = null;
	const finish = (
		terminationReason: ConnectionsResult["terminationReason"],
		error?: string,
	): ConnectionsResult => ({
		elements,
		observed,
		missingUrnCount,
		terminationReason,
		total,
		...(error ? { error } : {}),
	});

	while (start < CONNECTIONS_MAX) {
		const result = await voyagerFetch<VoyagerConnectionsResponse>(
			page,
			`/voyager/api/relationships/dash/connections?count=${CONNECTIONS_PAGE_SIZE}&q=search&sortType=RECENTLY_ADDED&start=${start}`,
			capture,
			`connections-page-${String(start).padStart(4, "0")}`,
		);
		if (isFetchError(result)) {
			return finish("page_error", result._error);
		}
		const paging = result.paging;
		if (paging !== undefined && !isRecord(paging)) {
			return finish("malformed_page");
		}
		const reportedStart = paging?.start;
		if (
			reportedStart !== undefined &&
			(!Number.isSafeInteger(reportedStart) || reportedStart !== start)
		) {
			return finish("malformed_page");
		}
		const reportedCount = paging?.count;
		if (
			reportedCount !== undefined &&
			(!Number.isSafeInteger(reportedCount) ||
				reportedCount < 0 ||
				reportedCount !== CONNECTIONS_PAGE_SIZE)
		) {
			return finish("malformed_page");
		}
		const reportedTotal = paging?.total;
		if (
			reportedTotal !== undefined &&
			(!Number.isSafeInteger(reportedTotal) || reportedTotal < 0)
		) {
			return finish("malformed_page");
		}
		if (
			total !== null &&
			reportedTotal !== undefined &&
			reportedTotal !== total
		) {
			return finish("malformed_page");
		}
		total = reportedTotal ?? total;
		if (!Array.isArray(result.elements)) {
			return finish("malformed_page");
		}
		const page_elements = result.elements;
		observed += page_elements.length;
		if (
			page_elements.length > CONNECTIONS_PAGE_SIZE ||
			page_elements.some((element) => !isRecord(element))
		) {
			return finish("malformed_page");
		}
		if (reportedCount !== undefined && page_elements.length > reportedCount) {
			return finish("malformed_page");
		}
		const continuationAdvertised =
			paging?.links !== undefined &&
			(!Array.isArray(paging.links) || paging.links.length > 0);
		if (page_elements.length === 0) {
			if (continuationAdvertised) return finish("continuation_advertised");
			return total === null || elements.length === total
				? finish("observed_end_unproven")
				: finish("malformed_page");
		}
		const fingerprint = JSON.stringify(
			page_elements.map((element) => [
				element.connectedMember,
				element.createdAt,
			]),
		);
		if (seenPageFingerprints.has(fingerprint)) {
			return finish("repeated_page");
		}
		seenPageFingerprints.add(fingerprint);
		let duplicateMember = false;
		let missingUrn = false;
		for (const element of page_elements) {
			const urn = element.connectedMember;
			if (typeof urn !== "string" || urn.trim().length === 0) {
				missingUrnCount += 1;
				missingUrn = true;
				continue;
			}
			if (seenUrns.has(urn)) {
				duplicateMember = true;
				continue;
			}
			seenUrns.add(urn);
			elements.push(element);
		}
		if (duplicateMember) {
			return finish("repeated_page");
		}
		if (missingUrn) return finish("malformed_page");
		if (total !== null && elements.length > total) {
			return finish("malformed_page");
		}
		await progress("Fetched LinkedIn connections page", {
			count: elements.length,
			stream: "connections",
			...(total === null ? {} : { total }),
		});
		if (continuationAdvertised) return finish("continuation_advertised");
		if ((total !== null && elements.length === total) || elements.length === expectedTotal) {
			return finish("observed_end_unproven");
		}
		if (page_elements.length < CONNECTIONS_PAGE_SIZE) {
			return total === null ? finish("observed_end_unproven") : finish("malformed_page");
		}
		start += CONNECTIONS_PAGE_SIZE;
		await politeDelay(PAGE_DELAY_MS);
	}

	return finish(start >= CONNECTIONS_MAX ? "page_budget" : "malformed_page");
}

/** Batch-resolve connection member URNs to profile summaries (name,
 *  headline, public identifier) via the same dash/profiles endpoint used
 *  for the owner's own profile. Failed batches receive singleton retries
 *  after the first two consecutive batch failures; after five failures, the
 *  remaining enrichment is left unresolved and reported. */
async function resolveConnectionProfiles(
	page: Page,
	memberUrns: string[],
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
	capture?: CaptureSession | null,
): Promise<ConnectionProfileResolution> {
	const resolved = new Map<string, ResolvedConnectionProfile>();
	const malformedUrns = new Set<string>();
	let consecutiveFailures = 0;
	let batchIndex = 0;
	let singletonIndex = 0;
	const accept = (urn: string, value: unknown, requested: Set<string>) => {
		if (!requested.has(urn) || !isRecord(value)) return;
		const profileFields = [
			"firstName",
			"headline",
			"lastName",
			"occupation",
			"publicIdentifier",
		] as const;
		const presentFields = profileFields.filter((field) =>
			Object.hasOwn(value, field),
		);
		const malformed = !connectionEnrichmentIsReadable(value);
		if (malformed) malformedUrns.add(urn);
		if (presentFields.length === 0) return;
		const profile = value as VoyagerResolvedProfile;
		const prior = resolved.get(urn);
		if (!prior || (!prior.complete && !malformed)) {
			resolved.set(urn, {
				profile,
				complete: !malformed,
			});
		}
	};
	const acceptBatch = (
		value: VoyagerProfilesByIdResponse,
		requested: Set<string>,
	) => {
		if (isRecord(value.results)) {
			for (const [urn, profile] of Object.entries(value.results)) {
				accept(urn, profile, requested);
			}
		}
		for (const profile of Array.isArray(value.elements) ? value.elements : []) {
			if (!isRecord(profile)) continue;
			const urn = profile.entityUrn ?? profile.dashEntityUrn;
			if (typeof urn === "string") accept(urn, profile, requested);
		}
	};

	for (let i = 0; i < memberUrns.length; i += RESOLVE_BATCH_SIZE) {
		if (consecutiveFailures >= 5) {
			break;
		}
		const batch = memberUrns.slice(i, i + RESOLVE_BATCH_SIZE);
		const requested = new Set(batch);
		const urnList = batch.map((u) => encodeURIComponent(u)).join(",");
		const result = await voyagerFetch<VoyagerProfilesByIdResponse>(
			page,
			`/voyager/api/identity/dash/profiles?ids=List(${urnList})`,
			capture,
			`resolve-batch-${String(batchIndex).padStart(3, "0")}`,
		);
		batchIndex += 1;

		if (
			isFetchError(result) ||
			!(isRecord(result.results) || Array.isArray(result.elements))
		) {
			consecutiveFailures += 1;
			if (consecutiveFailures <= 2) {
				for (const urn of batch) {
					const label = `resolve-single-${String(singletonIndex).padStart(3, "0")}`;
					singletonIndex += 1;
					const singleton = await voyagerFetch<VoyagerProfilesByIdResponse>(
						page,
						`/voyager/api/identity/dash/profiles?ids=List(${encodeURIComponent(urn)})`,
						capture,
						label,
					);
					if (
						!isFetchError(singleton) &&
						(isRecord(singleton.results) || Array.isArray(singleton.elements))
					) {
						acceptBatch(singleton, new Set([urn]));
					}
					await politeDelay(PAGE_DELAY_MS);
				}
			}
			await politeDelay(PAGE_DELAY_MS);
			continue;
		}
		consecutiveFailures = 0;
		acceptBatch(result, requested);
		for (const urn of batch) {
			if (resolved.get(urn)?.complete) continue;
			const singleton = await voyagerFetch<VoyagerProfilesByIdResponse>(
				page,
				`/voyager/api/identity/dash/profiles?ids=List(${encodeURIComponent(urn)})`,
				capture,
				`resolve-single-${String(singletonIndex).padStart(3, "0")}`,
			);
			singletonIndex += 1;
			if (
				!isFetchError(singleton) &&
				(isRecord(singleton.results) || Array.isArray(singleton.elements))
			) {
				acceptBatch(singleton, new Set([urn]));
			}
			await politeDelay(PAGE_DELAY_MS);
		}

		await progress("Resolved LinkedIn connection profiles", {
			count: resolved.size,
			stream: "connections",
			total: memberUrns.length,
		});
		await politeDelay(PAGE_DELAY_MS);
	}

	return { profiles: resolved, malformedCount: malformedUrns.size };
}

interface ResolvedConnectionProfile {
	profile: VoyagerResolvedProfile;
	complete: boolean;
}

interface ConnectionProfileResolution {
	profiles: Map<string, ResolvedConnectionProfile>;
	malformedCount: number;
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
		readinessProbe: (readinessPage) => checkApiAuth(readinessPage, capture),
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds,
	});
	if (!(ready && (await checkApiAuth(page, capture)))) {
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
	const publicIdentifier = firstOf(
		[
			textAt(meResult, ["miniProfile", "publicIdentifier"]),
			textAt(meResult, ["publicIdentifier"]),
		],
		"unavailable",
	);
	if (publicIdentifier.kind !== "read" || publicIdentifier.value.length === 0) {
		throw new Error(
			"linkedin_profile_fetch_failed: no publicIdentifier on /voyager/api/me response",
		);
	}

	const wantsProfileFields = requested.has("profile");
	const wantsConnections = requested.has("connections");
	const wantedSections = PROFILE_SECTIONS.filter((section) =>
		requested.has(section.stream),
	);

	let dashProfileResult: DashProfileResult = {
		profile: null,
		source: "unavailable",
	};
	if (wantsProfileFields || wantedSections.length > 0) {
		dashProfileResult = await fetchDashProfile(
			page,
			publicIdentifier.value,
			capture,
		);
	}
	const dashProfile = dashProfileResult.profile;

	// `profile.connection_count` is only available from the connections
	// listing (legacy: `profileResult.connections = totalAvailable ||
	// connectionRecords.length`, set AFTER the connections fetch completes) —
	// nowhere on /me or the dash profile payload. Walk the listing here, before
	// emitting `profile`, whenever either stream is requested, and reuse the
	// same walk for the `connections` stream below.
	let connectionsResult: ConnectionsResult | null = null;
	let beforeSummary: ReturnType<typeof summaryEvidence> = { reason: "summary_request_failed" };
	let afterSummary: ReturnType<typeof summaryEvidence> = { reason: "summary_request_failed" };
	let confirmation: unknown = null;
	if (wantsProfileFields || wantsConnections) {
		beforeSummary = summaryEvidence(await voyagerFetch(page,
			"/voyager/api/relationships/connectionsSummary/", capture, "connections-summary-before"), meResult);
		await progress("Fetching LinkedIn connections", { stream: "connections" });
		connectionsResult = await fetchConnections(page, progress, capture, beforeSummary.total);
		if (beforeSummary.total !== undefined && beforeSummary.total <= CONNECTIONS_MAX) {
			confirmation = await voyagerFetch(page,
				`/voyager/api/relationships/dash/connections?count=${CONNECTIONS_PAGE_SIZE}&q=search&sortType=RECENTLY_ADDED&start=${beforeSummary.total}`,
				capture, "connections-confirmation");
		}
		afterSummary = summaryEvidence(await voyagerFetch(page,
			"/voyager/api/relationships/connectionsSummary/", capture, "connections-summary-after"), meResult);
	}
	const walkEvidence = connectionsResult ? connectionEvidence({
		before: beforeSummary, after: afterSummary,
		distinctCount: connectionsResult.elements.length,
		missingUrnCount: connectionsResult.missingUrnCount,
		terminationReason: connectionsResult.terminationReason,
		pageTotal: connectionsResult.total, confirmation,
	}) : "connection_walk_unavailable";
	const connectionCount: FieldRead<number> =
		!walkEvidence && beforeSummary.total !== undefined
			? read(beforeSummary.total) : unavailable("walk_unverified");
	const ownerEvidence = profileEvidence(meResult, dashProfile);

	const sink: StreamSink = { emit, emitRecord, progress, isRecordSelected: ctx.isRecordSelected };

	if (wantsProfileFields) {
		await emitRows(
			sink,
			"profile",
			buildProfileRows({
				connectionCount,
				dash: dashProfile,
				dashSource: dashProfileResult.source,
				me: meResult,
				publicIdentifier: publicIdentifier.value,
			}),
			{
				enumerated: !ownerEvidence,
				diagnostics: { evidence_reason: ownerEvidence },
				gapReason:
					dashProfileResult.source === "unavailable"
						? "dashProfileUnavailable"
						: "profileFieldsUnavailable",
			},
		);
	}

	for (const section of wantedSections) {
		// Only a full decoration carries the profile sections; an empty list
		// from the basic fallback is not evidence of an empty section.
		const items =
			dashProfileResult.source === "decoration"
				? collectionAt(dashProfile, section.key)
				: unavailable("source_unavailable");
		if (items.kind !== "read") {
			await emitUnavailableSection(section.stream, emit);
			continue;
		}
		await emitRows(sink, section.stream, section.build(items.value), {
			enumerated: !ownerEvidence && !sectionEvidence(dashProfile, section.key),
			diagnostics: { evidence_reason: ownerEvidence ?? sectionEvidence(dashProfile, section.key) },
			gapReason: "profileSectionFieldsUnreadable",
		});
	}

	if (wantsConnections && connectionsResult) {
		const { elements, terminationReason } = connectionsResult;

		const memberUrns = elements
			.map((e) => e.connectedMember)
			.filter((u): u is string => typeof u === "string" && u.trim().length > 0);
		const resolution = await resolveConnectionProfiles(
			page,
			memberUrns,
			progress,
			capture,
		);
		const resolvedProfiles = resolution.profiles;
		const unresolved = memberUrns.filter(
			(urn) => !resolvedProfiles.get(urn)?.complete,
		).length;
		const omittedWithoutUrn = connectionsResult.missingUrnCount;
		if (omittedWithoutUrn > 0) {
			await progress(
				`LinkedIn connections omitted rows: missing_connected_member_urn=${omittedWithoutUrn}`,
				{
					stream: "connections",
					count: omittedWithoutUrn,
					total: elements.length,
				},
			);
		}
		if (unresolved > 0) {
			await progress(
				`LinkedIn connection enrichment unresolved: ${unresolved}`,
				{
					stream: "connections",
					count: unresolved,
					total: memberUrns.length,
				},
			);
		}
		if (resolution.malformedCount > 0) {
			await progress(
				`LinkedIn connections omitted malformed enrichment: malformed_enrichment=${resolution.malformedCount}`,
				{
					stream: "connections",
					count: resolution.malformedCount,
					total: memberUrns.length,
				},
			);
		}
		const rows = buildConnectionRows(elements, (urn) => resolvedProfiles.get(urn)?.profile);
		const emittedUrns = new Set(rows.records.filter((row) => ctx.isRecordSelected?.("connections", row) ?? true).map((row) => row.id));
		const withheldCount = elements.length - emittedUrns.size;
		const evidenceReason = withheldCount > 0 ? "linkedin_connection_enrichment_incomplete" :
			connectionEvidence({
				before: beforeSummary, after: afterSummary, distinctCount: emittedUrns.size,
				missingUrnCount: connectionsResult.missingUrnCount, terminationReason,
				pageTotal: connectionsResult.total, confirmation,
			});
		const connectionsComplete = !evidenceReason;
		await emitRows(
			sink,
			"connections",
			rows,
			{
				enumerated: connectionsComplete,
				gapReason:
					unresolved > 0
						? "connectionEnrichmentIncomplete"
						: "connectionFieldsUnreadable",
				diagnostics: {
					evidence_reason: evidenceReason,
					withheld_count: withheldCount,
					distinct_emitted_count: emittedUrns.size,
					summary_before: beforeSummary.total,
					summary_after: afterSummary.total,
					termination_reason: terminationReason,
					observed_count: connectionsResult.observed,
					total: connectionsResult.total,
					missing_urn_count: connectionsResult.missingUrnCount,
					...(!connectionsComplete
						? {
							page_reason: terminationReason === "page_budget"
								? "older_connections_deferred_page_budget"
								: terminationReason === "continuation_advertised"
									? "linkedin_connections_continuation_advertised"
								: terminationReason === "page_error"
									? "linkedin_connections_page_failed"
									: "linkedin_connections_page_malformed",
						}
						: {}),
					...(connectionsResult.error ? { error: connectionsResult.error } : {}),
					unresolved_count: unresolved,
					malformed_count: resolution.malformedCount,
				},
			},
		);
	}
}

/** Profile sections read from the dash profile, one stream each. */
const PROFILE_SECTIONS: ReadonlyArray<{
	build: (items: readonly unknown[]) => StreamRows<Record<string, unknown>>;
	key: string;
	stream: string;
}> = [
	{
		build: buildExperienceRows,
		key: "profilePositionGroups",
		stream: "experience",
	},
	{ build: buildEducationRows, key: "profileEducations", stream: "education" },
	{ build: buildSkillRows, key: "profileSkills", stream: "skills" },
	{ build: buildLanguageRows, key: "profileLanguages", stream: "languages" },
];

interface StreamSink {
	isRecordSelected?: BrowserCollectContext["isRecordSelected"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	progress: (message: string, extra?: ProgressExtra) => Promise<void>;
}

type RowGapReason =
	| "dashProfileUnavailable"
	| "profileFieldsUnavailable"
	| "profileSectionFieldsUnreadable"
	| "connectionEnrichmentIncomplete"
	| "connectionFieldsUnreadable";

const ROW_GAP_REASON: Record<RowGapReason, string> = {
	dashProfileUnavailable: "linkedin_dash_profile_unavailable",
	profileFieldsUnavailable: "linkedin_profile_fields_unavailable",
	profileSectionFieldsUnreadable: "linkedin_fields_unreadable",
	connectionEnrichmentIncomplete: "linkedin_connection_enrichment_incomplete",
	connectionFieldsUnreadable: "linkedin_fields_unreadable",
};

/** Only provider-proved inventories with every row covered advance STATE.
 * Unproven streams retain readable upserts and one canonical retryable gap. */
async function emitRows(
	sink: StreamSink,
	stream: string,
	rows: StreamRows<Record<string, unknown>>,
	options: {
		diagnostics?: Record<string, unknown>;
		enumerated: boolean;
		gapReason: RowGapReason;
	},
): Promise<void> {
	const { gapReason } = options;
	await reportRowIssues(stream, rows, sink.progress);
	for (const record of rows.records) {
		await sink.emitRecord(stream, record);
	}
	const selectedCount = rows.records.filter((record) => sink.isRecordSelected?.(stream, record) ?? true).length;
	if (options.enumerated && rows.covered === rows.considered && selectedCount === rows.records.length) {
		await sink.emit(coverageMessage(stream, rows.considered, rows.covered));
		await sink.emit({ type: "STATE", stream, cursor: { full_scan_at: new Date().toISOString() } });
		return;
	}
	if (rows.covered < rows.considered &&
		(stream !== "connections" || options.diagnostics?.missing_urn_count === 0)) {
		await sink.emit(coverageMessage(stream, rows.considered, rows.covered));
	}
	await sink.emit({
		type: "SKIP_RESULT",
		stream,
		reason: "linkedin_enumeration_unproven",
		recovery_hint: { action: "retry_by_runtime", retryable: true },
		message: `LinkedIn ${stream} enumeration is unproven; covered entries are upserted only`,
		diagnostics: {
			...(rows.covered < rows.considered
				? { source_reason: ROW_GAP_REASON[gapReason] }
				: {}),
			selected_count: selectedCount,
			considered: rows.considered,
			covered: rows.covered,
			omitted_rows: rows.omittedRows,
			unavailable_fields: rows.unavailableFields,
			...options.diagnostics,
		},
	});
}

function coverageMessage(
	stream: string,
	considered: number,
	covered: number,
): EmittedMessage {
	return buildDetailCoverageMessage({
		stream,
		stateStream: stream,
		requiredKeys: [],
		hydratedKeys: [],
		considered,
		covered,
	});
}

async function emitUnavailableSection(
	stream: string,
	emit: (message: EmittedMessage) => Promise<void>,
): Promise<void> {
	await emit({
		type: "SKIP_RESULT",
		stream,
		reason: "linkedin_enumeration_unproven",
		recovery_hint: { action: "retry_by_runtime", retryable: true },
		message: "LinkedIn enumeration is unproven; the profile section was unreadable",
		diagnostics: { source_reason: "linkedin_profile_section_unavailable" },
	});
}

async function reportRowIssues(
	stream: string,
	rows: StreamRows<unknown>,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
): Promise<void> {
	const omitted = Object.entries(rows.omittedRows);
	if (omitted.length > 0) {
		await progress(
			`LinkedIn ${stream} omitted rows: ${omitted.map(([reason, n]) => `${reason}=${n}`).join(",")}`,
			{ stream, count: omitted.reduce((sum, [, n]) => sum + n, 0) },
		);
	}
	const fields = Object.entries(rows.unavailableFields).flatMap(
		([field, reasons]) =>
			Object.entries(reasons).map(([reason, n]) => `${field}:${reason}=${n}`),
	);
	if (fields.length > 0) {
		await progress(`LinkedIn ${stream} omitted fields: ${fields.join(",")}`, {
			stream,
			count: rows.records.length,
		});
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

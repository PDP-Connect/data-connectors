#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP LinkedIn Connector (v0.3.26)
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
	buildEducationRecordsWithOmissions,
	buildExperienceRecordsWithOmissions,
	buildLanguageRecordsWithOmissions,
	buildProfileRecord,
	buildSkillRecordsWithOmissions,
	type OmissionSummary,
} from "./parsers.ts";
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type DashProfileSource = "decoration" | "basic" | "unavailable";

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

function unavailableProfileFields(
	profile: VoyagerProfileElement | null,
	source: DashProfileSource,
	connectionCount: number | null,
): string[] {
	const unavailable: string[] = [];
	const raw = profile as unknown as Record<string, unknown> | null;
	if (source !== "decoration" || !raw) {
		unavailable.push(
			"current_company",
			"current_position_title",
			"industry",
			"location",
			"summary",
		);
	} else {
		const groups = raw.profilePositionGroups;
		const groupsReadable =
			isObjectRecord(groups) &&
			Array.isArray(groups.elements) &&
			groups.elements.every((group) => {
				if (!isObjectRecord(group)) return false;
				if (!Object.hasOwn(group, "profilePositionInPositionGroup")) return true;
				const nested = group.profilePositionInPositionGroup;
				return (
					isObjectRecord(nested) &&
					Array.isArray(nested.elements) &&
					nested.elements.every(isObjectRecord)
				);
			});
		if (!groupsReadable) {
			unavailable.push("current_company", "current_position_title");
		}

		const industry = raw.industry;
		if (
			!Object.hasOwn(raw, "industry") ||
			(industry !== null &&
				(!isObjectRecord(industry) ||
					!(industry.name === null || typeof industry.name === "string")))
		) {
			unavailable.push("industry");
		}

		const locationIsReadable = ["location", "geoLocation"].some((key) => {
			if (!Object.hasOwn(raw, key)) return false;
			return raw[key] === null || isObjectRecord(raw[key]);
		});
		if (!locationIsReadable) unavailable.push("location");

		if (
			!Object.hasOwn(raw, "summary") ||
			!(raw.summary === null || typeof raw.summary === "string")
		) {
			unavailable.push("summary");
		}
	}
	if (connectionCount === null) unavailable.push("connection_count");
	return unavailable;
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
				if (
					isObjectRecord(candidate) &&
					hasRecognizedProfileField(candidate)
				) {
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
		const profile = basic.elements.find(isObjectRecord);
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
		| "verified_end"
		| "page_error"
		| "malformed_page"
		| "repeated_page"
		| "page_budget";
	total: number | null;
}

/** Walk the owner's connections list and retain why the walk stopped.
 *  Empty and short pages, or a page that reaches a verified provider total,
 *  prove the list end. Fetch errors, malformed pages, and the local page cap
 *  do not. `paging.total` was absent from the observed live response, so a
 *  complete walk commonly uses its observed row count. */
async function fetchConnections(
	page: Page,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
	capture?: CaptureSession | null,
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
		if (paging !== undefined && !isObjectRecord(paging)) {
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
				reportedCount > CONNECTIONS_PAGE_SIZE)
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
		if (total !== null && reportedTotal !== undefined && reportedTotal !== total) {
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
			page_elements.some((element) => !isObjectRecord(element))
		) {
			return finish("malformed_page");
		}
		if (
			reportedCount !== undefined &&
			page_elements.length > reportedCount
		) {
			return finish("malformed_page");
		}
		if (page_elements.length === 0) {
			return total === null || elements.length === total
				? finish("verified_end")
				: finish("malformed_page");
		}
		const fingerprint = JSON.stringify(
			page_elements.map((element) => [element.connectedMember, element.createdAt]),
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
		if (total !== null && elements.length === total) {
			return finish("verified_end");
		}
		if (page_elements.length < CONNECTIONS_PAGE_SIZE) {
			return total === null ? finish("verified_end") : finish("malformed_page");
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
		if (!requested.has(urn) || !isObjectRecord(value)) return;
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
		const malformed = presentFields.some(
			(field) => typeof value[field] !== "string",
		);
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
		if (isObjectRecord(value.results)) {
			for (const [urn, profile] of Object.entries(value.results)) {
				accept(urn, profile, requested);
			}
		}
		for (const profile of Array.isArray(value.elements) ? value.elements : []) {
			if (!isObjectRecord(profile)) continue;
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
			!(isObjectRecord(result.results) || Array.isArray(result.elements))
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
						(isObjectRecord(singleton.results) ||
							Array.isArray(singleton.elements))
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
				(isObjectRecord(singleton.results) || Array.isArray(singleton.elements))
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

	let dashProfileResult: DashProfileResult = {
		profile: null,
		source: "unavailable",
	};
	if (
		wantsProfileFields ||
		wantsExperience ||
		wantsEducation ||
		wantsSkills ||
		wantsLanguages
	) {
		dashProfileResult = await fetchDashProfile(page, publicIdentifier, capture);
	}
	const dashProfile = dashProfileResult.profile;

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
	// A partial walk never supplies an exact connection_count. Even when the
	// server gave a total earlier in the walk, completion still needs positive
	// end-of-list evidence.
	const connectionCount =
		connectionsResult === null ||
		connectionsResult.terminationReason !== "verified_end"
			? null
			: connectionsResult.elements.length;

	if (wantsProfileFields) {
		const unavailableFields = unavailableProfileFields(
			dashProfile,
			dashProfileResult.source,
			connectionCount,
		);
		if (unavailableFields.length > 0) {
			await emit({
				type: "SKIP_RESULT",
				stream: "profile",
				reason:
					dashProfileResult.source === "unavailable"
						? "linkedin_dash_profile_unavailable"
						: "linkedin_profile_fields_unavailable",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				message: "Some LinkedIn profile fields were not readable this run",
				diagnostics: { unavailable_fields: unavailableFields },
			});
		}
		const record = buildProfileRecord(
			publicIdentifier,
			dashProfile ?? {},
			meResult.miniProfile?.occupation,
			meResult.miniProfile,
			connectionCount,
		);
		const profileValid = validateRecord("profile", record).ok;
		if (profileValid) {
			await emitRecord("profile", record);
		} else {
			await reportInvalidRecords("profile", 1, progress);
		}
		if (unavailableFields.length === 0 && profileValid) {
			await emit(buildFullScanCoverageMessage("profile", 1));
		}
	}

	if (wantsExperience) {
		const section = dashProfile?.profilePositionGroups?.elements;
		if (Array.isArray(section)) {
			const { considered, covered, omissions, records } =
				buildExperienceRecordsWithOmissions(dashProfile ?? {});
			await reportOmissions("experience", omissions, progress);
			const validRecords = records.filter(
				(record) => validateRecord("experience", record).ok,
			);
			await reportInvalidRecords(
				"experience",
				records.length - validRecords.length,
				progress,
			);
			for (const record of validRecords) {
				await emitRecord("experience", record);
			}
			await emit(
				coverageMessage(
					"experience",
					considered,
					Math.min(covered, validRecords.length),
				),
			);
		} else {
			await emitUnavailableSection("experience", emit);
		}
	}

	if (wantsEducation) {
		const section = dashProfile?.profileEducations?.elements;
		if (Array.isArray(section)) {
			const { considered, covered, omissions, records } =
				buildEducationRecordsWithOmissions(dashProfile ?? {});
			await reportOmissions("education", omissions, progress);
			const validRecords = records.filter(
				(record) => validateRecord("education", record).ok,
			);
			await reportInvalidRecords(
				"education",
				records.length - validRecords.length,
				progress,
			);
			for (const record of validRecords) {
				await emitRecord("education", record);
			}
			await emit(
				coverageMessage(
					"education",
					considered,
					Math.min(covered, validRecords.length),
				),
			);
		} else {
			await emitUnavailableSection("education", emit);
		}
	}

	if (wantsSkills) {
		const section = dashProfile?.profileSkills?.elements;
		if (Array.isArray(section)) {
			const { considered, covered, omissions, records } =
				buildSkillRecordsWithOmissions(dashProfile ?? {});
			await reportOmissions("skills", omissions, progress);
			const validRecords = records.filter(
				(record) => validateRecord("skills", record).ok,
			);
			await reportInvalidRecords(
				"skills",
				records.length - validRecords.length,
				progress,
			);
			for (const record of validRecords) {
				await emitRecord("skills", record);
			}
			await emit(
				coverageMessage(
					"skills",
					considered,
					Math.min(covered, validRecords.length),
				),
			);
		} else {
			await emitUnavailableSection("skills", emit);
		}
	}

	if (wantsLanguages) {
		const section = dashProfile?.profileLanguages?.elements;
		if (Array.isArray(section)) {
			const { considered, covered, omissions, records } =
				buildLanguageRecordsWithOmissions(dashProfile ?? {});
			await reportOmissions("languages", omissions, progress);
			const validRecords = records.filter(
				(record) => validateRecord("languages", record).ok,
			);
			await reportInvalidRecords(
				"languages",
				records.length - validRecords.length,
				progress,
			);
			for (const record of validRecords) {
				await emitRecord("languages", record);
			}
			await emit(
				coverageMessage(
					"languages",
					considered,
					Math.min(covered, validRecords.length),
				),
			);
		} else {
			await emitUnavailableSection("languages", emit);
		}
	}

	if (wantsConnections && connectionsResult) {
		const { elements, terminationReason } = connectionsResult;
		const connectionsComplete = terminationReason === "verified_end";
		if (!connectionsComplete) {
			const pageBudget = terminationReason === "page_budget";
			await emit({
				type: "SKIP_RESULT",
				stream: "connections",
				reason: pageBudget
					? "older_connections_deferred_page_budget"
					: terminationReason === "page_error"
						? "linkedin_connections_page_failed"
						: "linkedin_connections_page_malformed",
				recovery_hint: {
					action: pageBudget
						? "retry_on_connector_upgrade"
						: "retry_by_runtime",
					retryable: !pageBudget,
				},
				message:
					"LinkedIn connections listing did not provide verified end-of-list evidence",
				diagnostics: {
					termination_reason: terminationReason,
					observed_count: connectionsResult.observed,
					total: connectionsResult.total,
					missing_urn_count: connectionsResult.missingUrnCount,
					...(connectionsResult.error
						? { error: connectionsResult.error }
						: {}),
				},
			});
		}
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

		const omittedWithoutUrn = connectionsResult.missingUrnCount;
		const unresolved = memberUrns.filter(
			(urn) => !resolvedProfiles.get(urn)?.complete,
		).length;
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
			await emit({
				type: "SKIP_RESULT",
				stream: "connections",
				reason: "linkedin_connection_enrichment_incomplete",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
				message: "Some LinkedIn connections could not be enriched this run",
				diagnostics: {
					unresolved_count: unresolved,
					malformed_count: resolution.malformedCount,
				},
			});
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

		const builtRecords = elements.map((element) => ({
			element,
			record: buildConnectionRecord(
				element,
				element.connectedMember
					? resolvedProfiles.get(element.connectedMember)?.profile
					: undefined,
			),
		}));
		const validRecords = builtRecords.filter(
			(
				item,
			): item is {
				element: VoyagerConnectionElement;
				record: NonNullable<typeof item.record>;
			} =>
				item.record !== null && validateRecord("connections", item.record).ok,
		);
		const invalidRecordCount = builtRecords.filter(
			(item) =>
				item.record !== null && !validateRecord("connections", item.record).ok,
		).length;
		await reportInvalidRecords("connections", invalidRecordCount, progress);

		let covered = 0;
		for (const { element, record } of validRecords) {
			await emitRecord("connections", record);
			if (
				element.connectedMember &&
				resolvedProfiles.get(element.connectedMember)?.complete
			) {
				covered += 1;
			}
		}
		if (connectionsComplete) {
			await emit(coverageMessage("connections", elements.length, covered));
		}
	}
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
		reason: "linkedin_profile_section_unavailable",
		recovery_hint: { action: "retry_by_runtime", retryable: true },
		message: "LinkedIn did not return a readable profile section",
	});
}

async function reportOmissions(
	stream: string,
	omissions: OmissionSummary,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
): Promise<void> {
	if (omissions.count === 0) {
		return;
	}
	const omittedRows = Object.entries(omissions.omittedReasons)
		.map(([reason, omitted]) => `${reason}=${omitted}`)
		.join(",");
	if (omissions.omittedCount > 0) {
		await progress(`LinkedIn ${stream} omitted rows: ${omittedRows}`, {
			stream,
			count: omissions.omittedCount,
		});
	}
	const preservedIssues = Object.entries(omissions.reasons)
		.filter(([reason]) => !(reason in omissions.omittedReasons))
		.map(([reason, count]) => `${reason}=${count}`)
		.join(",");
	if (preservedIssues) {
		await progress(
			`LinkedIn ${stream} preserved malformed rows: ${preservedIssues}`,
			{
				stream,
				count: omissions.count - omissions.omittedCount,
			},
		);
	}
}

async function reportInvalidRecords(
	stream: string,
	count: number,
	progress: (message: string, extra?: ProgressExtra) => Promise<void>,
): Promise<void> {
	if (count === 0) return;
	await progress(
		`LinkedIn ${stream} omitted rows: invalid_record_shape=${count}`,
		{
			stream,
			count,
		},
	);
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

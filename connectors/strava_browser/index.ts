#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Strava browser connector (v0.1.2).
 *
 * The browser-session profile of the Strava source. `strava` stays the
 * account-export profile; both declare the same source, streams and record
 * contracts, so a reader cannot tell which profile collected an activity
 * except by `freshness` ("live" here, "snapshot" there).
 *
 * Collection runs in the owner's own signed-in strava.com session and reads
 * the JSON behind "My Activities", each activity's detail HTML, and the
 * heartrate stream used by its page. The list is
 * `GET /athlete/training_activities?page=N&per_page=20`, newest first. There
 * is no credential in this code and no credential form: the owner signs in in
 * the browser.
 *
 * The first run inventories the full activity list and emits each summary.
 * Later runs discover new activities at the front of the list and backfill
 * the resumable detail queue at MAX_DETAILS_PER_RUN per run.
 *
 * Stream: activities.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	activityGearId,
	parseActivityCalories,
	parseGearNames,
	parseHeartRateStream,
} from "./details.ts";
import {
	buildActivityRecord,
	parseTrainingActivitiesPage,
	startInstant,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const ORIGIN = "https://www.strava.com";
export const TRAINING_URL = `${ORIGIN}/athlete/training`;
export const LOGIN_URL = `${ORIGIN}/login`;
const PROBE_URL = `${ORIGIN}/athlete/training_activities?page=1&per_page=1`;
/** Without X-Requested-With, strava.com answers the list URL with HTML. */
const LIST_HEADERS = {
	Accept: "application/json, text/javascript",
	"X-Requested-With": "XMLHttpRequest",
};
const ACTIVITIES_STREAM = "activities";
const PER_PAGE = 20;
export const MAX_DETAILS_PER_RUN = 100;
export const PAGE_DELAY_MS = 1000;
export const ACTIVITY_DELAY_MS = 1500;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DELAY_MS = 30_000;
const GEAR_LIST_DELAY_MS = 1000;

/** The coverage reasons a browser run can end on; the others are export-only. */
type CoverageReason =
	| "collection_interrupted"
	| "covered_in_full"
	| "nothing_in_range"
	| "records_unreadable"
	| "sign_in_required"
	| "source_limit_reached"
	| "source_unreadable";

/** The SKIP_RESULT reason for each coverage reason a run can end on. */
const SKIP_REASON: Record<CoverageReason, string> = {
	collection_interrupted: "collection_interrupted",
	covered_in_full: "covered_in_full",
	nothing_in_range: "nothing_in_range",
	records_unreadable: "records_unreadable",
	sign_in_required: "sign_in_required",
	source_limit_reached: "source_limit_reached",
	source_unreadable: "source_unreadable",
};

/**
 * The part of the collect context this connector uses. Structural, so the
 * desktop runtime and the PageShim runtime (which has no collection mode and
 * no cursor store) both satisfy it.
 */
export interface StravaCollectContext {
	collectionMode?: BrowserCollectContext["collectionMode"];
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	page: Pick<Page, "context" | "evaluate" | "goto">;
	requested: BrowserCollectContext["requested"];
	state: Record<string, unknown>;
}

export interface StravaCollectOptions {
	maxDetails?: number;
	pageDelayMs?: number;
	activityDelayMs?: number;
	rateLimitDelayMs?: number;
}

interface ActivitiesState {
	/** IDs whose summary records are already in the Desktop snapshot. */
	known_ids?: string[];
	/** Summary records still waiting for their detail fields, newest first. */
	pending_detail_ids?: string[];
	/** Set after a complete initial inventory; detail work starts next run. */
	list_complete?: boolean;
	/** Earliest requested day represented by known_ids, when range-limited. */
	requested_since?: string | null;
}

/** What the in-page fetch returns. It never throws: PageShim turns a throw into null. */
type ListResponse =
	| { kind: "wrong_origin"; origin: string }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			url: string;
			contentType: string;
			body: string;
	  };

const delay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

function isJson(text: string): boolean {
	try {
		JSON.parse(text);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether the browser profile holds a signed-in strava.com session: asks for
 * the first list entry over the browser context's cookie jar. Signed in,
 * Strava answers 200 with JSON; signed out, 401. It never
 * navigates, so it is safe to run while the owner is part way through
 * signing in, including on another origin during single sign-on.
 */
export async function probeStravaSession(
	page: Pick<Page, "context">,
): Promise<boolean> {
	try {
		const response = await page.context().request.get(PROBE_URL, {
			headers: LIST_HEADERS,
			timeout: 15_000,
		});
		try {
			// Only whether the answer is the signed-in JSON. Whether Strava still
			// sends the list shape this connector reads is collection's question,
			// and it fails closed there; asking it here would send a signed-in
			// owner back to the login page when Strava changes its format.
			return response.status() === 200 && isJson(await response.text());
		} finally {
			await response.dispose();
		}
	} catch {
		return false;
	}
}

export async function ensureStravaSession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	if (await probeStravaSession(page)) {
		return;
	}
	await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to Strava in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => probeStravaSession(page),
		readinessProbe: probeStravaSession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("strava_session_dead");
	}
}

/** Put the page on strava.com, where the in-page fetch carries the session. */
async function ensureStravaOrigin(page: StravaCollectContext["page"]) {
	const origin = await page.evaluate(() => location.origin);
	if (origin !== ORIGIN) {
		await page.goto(TRAINING_URL, { waitUntil: "domcontentloaded" });
	}
}

async function fetchListPage(
	page: StravaCollectContext["page"],
	pageNumber: number,
): Promise<ListResponse> {
	const result = await page.evaluate(
		async ({ headers, origin, pageNumber, perPage }) => {
			if (location.origin !== origin) {
				return { kind: "wrong_origin", origin: location.origin };
			}
			const query = new URLSearchParams({
				keywords: "",
				new_activity_only: "false",
				page: String(pageNumber),
				per_page: String(perPage),
			});
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30_000);
			try {
				const response = await fetch(`/athlete/training_activities?${query}`, {
					credentials: "include",
					headers,
					signal: controller.signal,
				});
				return {
					kind: "response",
					status: response.status,
					url: response.url,
					contentType: response.headers.get("content-type") ?? "",
					body: await response.text(),
				};
			} catch (error) {
				return {
					kind: "network_error",
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				clearTimeout(timeout);
			}
		},
		{ headers: LIST_HEADERS, origin: ORIGIN, pageNumber, perPage: PER_PAGE },
	);
	// PageShim reports an evaluate that failed in the page as null.
	return (
		(result as ListResponse | null) ?? {
			kind: "network_error",
			message: "the page did not return a result",
		}
	);
}

/** Fetch only the detail document and the heartrate stream the page needs. */
async function fetchActivityResource(
	page: StravaCollectContext["page"],
	pathname: string,
	accept: string,
): Promise<ListResponse> {
	const result = await page.evaluate(
		async ({ accept, origin, pathname }) => {
			if (location.origin !== origin) {
				return { kind: "wrong_origin", origin: location.origin };
			}
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 30_000);
			try {
				const response = await fetch(pathname, {
					credentials: "include",
					headers: {
						Accept: accept,
						...(accept.includes("json")
							? { "X-Requested-With": "XMLHttpRequest" }
							: {}),
					},
					signal: controller.signal,
				});
				return {
					kind: "response",
					status: response.status,
					url: response.url,
					contentType: response.headers.get("content-type") ?? "",
					body: await response.text(),
				};
			} catch (error) {
				return {
					kind: "network_error",
					message: error instanceof Error ? error.message : String(error),
				};
			} finally {
				clearTimeout(timeout);
			}
		},
		{ accept, origin: ORIGIN, pathname },
	);
	return (
		(result as ListResponse | null) ?? {
			kind: "network_error",
			message: "the page did not return an activity detail result",
		}
	);
}

function classifyActivityResponse(
	response: ListResponse,
	expectedContentType: "html" | "json",
	label: string,
): PageOutcome {
	if (response.kind === "wrong_origin" || response.kind === "network_error") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message:
				response.kind === "wrong_origin"
					? `The browser left strava.com while reading ${label}.`
					: `Strava could not be reached while reading ${label}.`,
		};
	}
	let onLogin = false;
	try {
		onLogin = new URL(response.url).pathname.startsWith("/login");
	} catch {
		// A missing response URL is not itself a sign-in failure.
	}
	if (response.status === 401 || response.status === 403 || onLogin) {
		return {
			ok: false,
			reason: "sign_in_required",
			message: `Strava asked for sign-in while reading ${label}.`,
		};
	}
	if (response.status === 429 || response.status >= 500) {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `Strava answered ${label} with HTTP ${response.status}; the run stopped to respect the rate limit or server error.`,
		};
	}
	const hasExpectedType =
		expectedContentType === "html"
			? /html/i.test(response.contentType)
			: /json/i.test(response.contentType);
	if (response.status !== 200 || !hasExpectedType) {
		return {
			ok: false,
			reason: "source_unreadable",
			message: `Strava answered ${label} with HTTP ${response.status} (${response.contentType || "no content type"}), not the expected ${expectedContentType}.`,
		};
	}
	return { ok: true, body: response.body };
}

async function fetchActivityRecordFields(
	page: StravaCollectContext["page"],
	model: unknown,
	activityId: string,
	resolveGearName: (gearId: string) => Promise<GearResolution>,
): Promise<
	| {
			ok: true;
			gearReason?: string;
			fields: {
				average_heartrate: number | null;
				max_heartrate: number | null;
				calories_kcal: number | null;
				gear: string | null;
			};
	  }
	| { ok: false; reason: CoverageReason; message: string }
> {
	const detail = classifyActivityResponse(
		await fetchActivityResource(
			page,
			`/activities/${encodeURIComponent(activityId)}`,
			"text/html",
		),
		"html",
		"activity detail",
	);
	if (!detail.ok) return detail;
	const query = new URLSearchParams();
	query.append("stream_types[]", "heartrate");
	const stream = classifyActivityResponse(
		await fetchActivityResource(
			page,
			`/activities/${encodeURIComponent(activityId)}/streams?${query}`,
			"application/json, text/javascript",
		),
		"json",
		"activity heartrate stream",
	);
	if (!stream.ok) return stream;
	const heartRate = parseHeartRateStream(stream.body);
	if (!heartRate) {
		return {
			ok: false,
			reason: "source_unreadable",
			message: "Strava returned an unknown activity heartrate stream shape.",
		};
	}
	const gearId = activityGearId(model);
	const gear = gearId ? await resolveGearName(gearId) : { name: null };
	return {
		ok: true,
		...(gear.reason ? { gearReason: gear.reason } : {}),
		fields: {
			average_heartrate: heartRate.average,
			max_heartrate: heartRate.maximum,
			calories_kcal: parseActivityCalories(detail.body),
			gear: gear.name,
		},
	};
}

type GearResolution = { name: string | null; reason?: string };

type GearLookup =
	| { ok: true; names: Map<string, string> }
	| { ok: false; reason: string };

/** Observe the gear settings JSON routes and read both owner gear lists. */
async function fetchGearNames(
	page: StravaCollectContext["page"],
): Promise<GearLookup> {
	await page.goto(`${ORIGIN}/settings/gear`, { waitUntil: "domcontentloaded" });
	const readPaths = () => page.evaluate(() => {
		const found = new Set<string>();
		for (const entry of performance.getEntriesByType("resource")) {
			try {
				const path = new URL(entry.name).pathname;
				if (/^\/athletes\/\d+\/gear\/(?:bikes|shoes)$/.test(path)) {
					found.add(path);
				}
			} catch {
				// Ignore non-URL performance entries.
			}
		}
		return [...found];
	});
	const categories = new Map<string, string>();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const paths = await readPaths();
		for (const path of paths ?? []) {
			const match = /^\/athletes\/\d+\/gear\/(bikes|shoes)$/.exec(path);
			if (match?.[1]) categories.set(match[1], path);
		}
		if (categories.has("bikes") && categories.has("shoes")) break;
		await delay(500);
	}
	if (!categories.has("bikes") || !categories.has("shoes")) {
		return { ok: false, reason: "gear_lists_unavailable" };
	}
	const names = new Map<string, string>();
	for (const category of ["bikes", "shoes"] as const) {
		if (category === "shoes") await delay(GEAR_LIST_DELAY_MS);
		const response = classifyActivityResponse(
			await fetchActivityResource(
				page,
				categories.get(category) as string,
				"application/json, text/javascript",
			),
			"json",
			"gear list",
		);
		if (!response.ok) return { ok: false, reason: `gear_${response.reason}` };
		const parsed = parseGearNames(response.body);
		if (!parsed) return { ok: false, reason: "gear_list_unreadable" };
		for (const [id, name] of parsed) names.set(id, name);
	}
	return { ok: true, names };
}

type PageOutcome =
	| { ok: true; body: string }
	| { ok: false; reason: CoverageReason; message: string };

/** Classify one list response. Anything not plainly the JSON list fails. */
function classify(response: ListResponse): PageOutcome {
	if (response.kind === "wrong_origin") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `The browser left strava.com (now on ${response.origin}).`,
		};
	}
	if (response.kind === "network_error") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `Strava could not be reached: ${response.message}`,
		};
	}
	const onLogin = (() => {
		try {
			return new URL(response.url).pathname.startsWith("/login");
		} catch {
			return false;
		}
	})();
	if (response.status === 401 || response.status === 403 || onLogin) {
		return {
			ok: false,
			reason: "sign_in_required",
			message: "Strava asked for sign-in while reading the activity list.",
		};
	}
	if (response.status === 429 || response.status >= 500) {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `Strava answered the activity list with HTTP ${response.status}.`,
		};
	}
	if (response.status !== 200 || !/json/i.test(response.contentType)) {
		return {
			ok: false,
			reason: "source_unreadable",
			message: `Strava answered the activity list with HTTP ${response.status} (${response.contentType || "no content type"}), not the JSON list.`,
		};
	}
	return { ok: true, body: response.body };
}

async function fetchPageWithRetry(
	ctx: StravaCollectContext,
	pageNumber: number,
	rateLimitDelayMs: number,
): Promise<PageOutcome> {
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetchListPage(ctx.page, pageNumber);
		const rateLimited = response.kind === "response" && response.status === 429;
		if (!rateLimited || attempt >= RATE_LIMIT_RETRIES) {
			return classify(response);
		}
		await ctx.emit({
			type: "PROGRESS",
			stream: ACTIVITIES_STREAM,
			message: `Strava asked us to slow down; waiting before page ${pageNumber} again.`,
		});
		await delay(rateLimitDelayMs * (attempt + 1));
	}
}

const earlier = (a: string | null, b: string): string =>
	a !== null && a < b ? a : b;

const later = (a: string | null, b: string | null): string | null =>
	!a ? b : !b ? a : a > b ? a : b;

/**
 * The runtime's time-range rule, applied here too so the coverage record
 * describes the records the run keeps: by calendar day, since inclusive and
 * until exclusive, on `start_date`.
 */
function isOutsideTimeRange(
	startDate: string,
	range: { since?: string; until?: string } | undefined,
): boolean {
	if (range?.since && startDate < range.since.slice(0, 10)) {
		return true;
	}
	return Boolean(range?.until && startDate >= range.until.slice(0, 10));
}

export async function collectStravaBrowser(
	ctx: StravaCollectContext,
	options: StravaCollectOptions = {},
): Promise<void> {
	if (!ctx.requested.has(ACTIVITIES_STREAM)) {
		return;
	}
	const maxDetails = options.maxDetails ?? MAX_DETAILS_PER_RUN;
	const pageDelayMs = options.pageDelayMs ?? PAGE_DELAY_MS;
	const activityDelayMs = options.activityDelayMs ?? ACTIVITY_DELAY_MS;
	const rateLimitDelayMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
	const fullRefresh = ctx.collectionMode === "full_refresh";
	const stored =
		(ctx.state[ACTIVITIES_STREAM] as ActivitiesState | undefined) ?? {};
	const timeRange = ctx.requested.get(ACTIVITIES_STREAM)?.time_range;
	const rangeSinceDay = timeRange?.since?.slice(0, 10) ?? null;
	const priorKnownIds = new Set(
		Array.isArray(stored.known_ids)
			? stored.known_ids.filter((id): id is string => typeof id === "string")
			: [],
	);
	const priorPendingIds = Array.isArray(stored.pending_detail_ids)
		? stored.pending_detail_ids.filter(
				(id): id is string => typeof id === "string",
			)
		: [];
	const rangeExpanded =
		stored.requested_since != null &&
		(rangeSinceDay == null || rangeSinceDay < stored.requested_since);
	const fullListWalk =
		fullRefresh || stored.list_complete !== true || rangeExpanded;
	const wasInventoryComplete = stored.list_complete === true;

	await ensureStravaOrigin(ctx.page);

	let pageNumber = 1;
	let pagesRead = 0;
	let emitted = 0;
	let detailAttempts = 0;
	let detailsUpdated = 0;
	let detailsDeferred = 0;
	let unreadable = 0;
	let earliest: string | null = null;
	let latest: string | null = null;
	let previousFirstId: string | null = null;
	let failure: { reason: CoverageReason; message: string } | null = null;
	let listFinished = false;
	let gearLookupPromise: Promise<GearLookup> | null = null;
	const modelsById = new Map<string, unknown>();
	const listed: Array<{
		model: unknown;
		record: NonNullable<ReturnType<typeof buildActivityRecord>>;
	}> = [];
	const newlyListed: typeof listed = [];
	const gearUnresolvedReasons: Record<string, number> = {};
	const resolveGearName = async (gearId: string): Promise<GearResolution> => {
		gearLookupPromise ??= fetchGearNames(ctx.page);
		const lookup = await gearLookupPromise;
		if (!lookup.ok) return { name: null, reason: lookup.reason };
		const name = lookup.names.get(gearId);
		return name
			? { name }
			: { name: null, reason: "gear_id_unmatched" };
	};

	while (true) {
		if (pagesRead > 0) {
			await delay(pageDelayMs);
		}
		const outcome = await fetchPageWithRetry(ctx, pageNumber, rateLimitDelayMs);
		if (!outcome.ok) {
			failure = outcome;
			break;
		}
		const parsed = parseTrainingActivitiesPage(outcome.body);
		if (!parsed.ok) {
			failure = { reason: "source_unreadable", message: parsed.message };
			break;
		}
		pagesRead += 1;
		if (parsed.models.length === 0) {
			listFinished = true;
			break;
		}
		const records = parsed.models.map((model) => ({
			model,
			record: buildActivityRecord(model),
		}));
		const firstId = records.find(({ record }) => record !== null)?.record?.id ?? null;
		if (firstId !== null && firstId === previousFirstId) {
			failure = {
				reason: "source_unreadable",
				message: `Strava returned the same activities for page ${pageNumber} as for the page before it.`,
			};
			break;
		}
		previousFirstId = firstId;
		let pageHasKnown = false;
		for (const { model, record } of records) {
			if (!record) {
				unreadable += 1;
				continue;
			}
			const inRequestedRange = !isOutsideTimeRange(
				record.start_date,
				timeRange,
			);
			if (!inRequestedRange) {
				continue;
			}
			modelsById.set(record.id, model);
			listed.push({ model, record });
			if (priorKnownIds.has(record.id)) {
				pageHasKnown = true;
			} else {
				newlyListed.push({ model, record });
			}
		}
		await ctx.emit({
			type: "PROGRESS",
			stream: ACTIVITIES_STREAM,
			message: `Strava activity list page ${pageNumber} read`,
			count: listed.length,
			...(parsed.total > 0 ? { total: parsed.total } : {}),
		});
		if (failure) break;
		const pendingBeforeDetails = fullRefresh
			? [...listed.map(({ record }) => record.id), ...priorPendingIds]
			: [...newlyListed.map(({ record }) => record.id), ...priorPendingIds];
		const detailTargets = [...new Set(pendingBeforeDetails)].slice(
			0,
			maxDetails,
		);
		const detailTargetsFound = detailTargets.every((id) => modelsById.has(id));
		if (
			(!fullListWalk && pageHasKnown && detailTargetsFound) ||
			pageNumber * parsed.perPage >= parsed.total
		) {
			listFinished = true;
			break;
		}
		pageNumber += 1;
	}

	const summaryRecords = fullRefresh ? listed : newlyListed;
	for (const { record } of summaryRecords) {
		await ctx.emitRecord(ACTIVITIES_STREAM, { ...record });
		emitted += 1;
		const instant = startInstant(record);
		earliest = earlier(earliest, instant);
		latest = later(latest, instant);
	}

	let pendingIds = fullRefresh
		? [...listed.map(({ record }) => record.id), ...priorPendingIds]
		: [...newlyListed.map(({ record }) => record.id), ...priorPendingIds];
	pendingIds = [...new Set(pendingIds)];
	const knownIds = new Set(priorKnownIds);
	for (const { record } of listed) knownIds.add(record.id);

	// The initial inventory run only emits summaries. Start detail work after
	// Desktop has committed that complete inventory and its queue checkpoint.
	const canBackfill = wasInventoryComplete && !failure && maxDetails > 0;
	const detailCandidates = canBackfill
		? pendingIds.slice(0, maxDetails)
		: [];
	const completedDetails = new Set<string>();
	const deferredDetails: string[] = [];
	if (canBackfill) {
		for (const id of detailCandidates) {
			const model = modelsById.get(id);
			if (model === undefined) continue;
			if (detailAttempts > 0) await delay(activityDelayMs);
			const detail = await fetchActivityRecordFields(
				ctx.page,
				model,
				id,
				resolveGearName,
			);
			detailAttempts += 1;
			if (!detail.ok) {
				if (
					detail.reason === "sign_in_required" ||
					detail.reason === "collection_interrupted"
				) {
					failure = detail;
					break;
				}
				deferredDetails.push(id);
				detailsDeferred += 1;
				continue;
			}
			if (detail.gearReason) {
				gearUnresolvedReasons[detail.gearReason] =
					(gearUnresolvedReasons[detail.gearReason] ?? 0) + 1;
			}
			const record = buildActivityRecord(model);
			if (!record) continue;
			await ctx.emitRecord(ACTIVITIES_STREAM, { ...record, ...detail.fields });
			completedDetails.add(id);
			detailsUpdated += 1;
			emitted += 1;
			const instant = startInstant(record);
			earliest = earlier(earliest, instant);
			latest = later(latest, instant);
		}
	}
	pendingIds = pendingIds.filter(
		(id) => !completedDetails.has(id) && !deferredDetails.includes(id),
	);
	pendingIds.push(...deferredDetails);

	if (failure || unreadable > 0) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: SKIP_REASON[failure?.reason ?? "records_unreadable"],
			...(failure?.reason === "collection_interrupted"
				? { recovery_hint: { action: "retry_by_runtime", retryable: true } }
				: {}),
			message: failure?.message ??
				`${unreadable} activities in the Strava list had no usable id or start time.`,
			diagnostics: {
				pages_read: pagesRead,
				unreadable,
				details_updated: detailsUpdated,
				details_pending: pendingIds.length,
				...(Object.keys(gearUnresolvedReasons).length > 0
					? {
							gear_name_unresolved: Object.values(
								gearUnresolvedReasons,
							).reduce((sum, count) => sum + count, 0),
							gear_name_reasons: gearUnresolvedReasons,
						}
					: {}),
			},
		});
	}

	const listComplete = wasInventoryComplete || (listFinished && !failure);
	const requestedSince = rangeSinceDay;
	const cursor: ActivitiesState = {
		known_ids: [...knownIds],
		pending_detail_ids: pendingIds,
		list_complete: listComplete,
		requested_since: requestedSince,
	};
	const requestedFrom = timeRange?.since ?? "none";
	const requestedTo = timeRange?.until ?? "none";
	await ctx.emit({
		type: "PROGRESS",
		stream: ACTIVITIES_STREAM,
		count: emitted,
		message: [
			"Strava phase=coverage stream=activities",
			`status=${failure || unreadable > 0 ? "partial" : listed.length === 0 ? "empty" : "complete"}`,
			`pages_read=${pagesRead}`,
			`unreadable=${unreadable}`,
			`summary_records=${summaryRecords.length}`,
			`details_updated=${detailsUpdated}`,
			`details_deferred=${detailsDeferred}`,
			`details_pending=${pendingIds.length}`,
			`window_requested_from=${requestedFrom}`,
			`window_requested_to=${requestedTo}`,
			`window_covered_from=${earliest ?? "none"}`,
			`window_covered_to=${latest ?? "none"}`,
			...(Object.keys(gearUnresolvedReasons).length > 0
				? [
						`gear_name_unresolved=${Object.values(gearUnresolvedReasons).reduce((sum, count) => sum + count, 0)}`,
						`gear_name_reasons=${Object.entries(gearUnresolvedReasons).map(([reason, count]) => `${reason}:${count}`).join(",")}`,
					]
				: []),
		].join(" "),
	});
	await ctx.emit({ type: "STATE", stream: ACTIVITIES_STREAM, cursor });
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "strava_browser",
		validateRecord,
		timeRangeField: "start_time",
		browser: { profileName: "strava_browser" },
		ensureSession: ensureStravaSession,
		probeSession: ({ page }) => probeStravaSession(page),
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collectStravaBrowser(ctx),
	});
}

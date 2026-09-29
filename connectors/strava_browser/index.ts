#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Strava browser connector (v0.1.0).
 *
 * The browser-session profile of the Strava source. `strava` stays the
 * account-export profile; both declare the same source, streams and record
 * contracts, so a reader cannot tell which profile collected an activity
 * except by `freshness` ("live" here, "snapshot" there).
 *
 * Collection runs in the owner's own signed-in strava.com session and reads
 * the JSON strava.com's "My Activities" page loads:
 * `GET /athlete/training_activities?page=N&per_page=20`, newest first. There
 * is no credential in this code and no credential form: the owner signs in in
 * the browser. Heart rate, calories and gear are not in that list, so those
 * fields are null and the coverage record says so.
 *
 * Bounds: one page at a time, a pause between pages, at most
 * MAX_PAGES_PER_RUN pages per run. A run that stops at the bound saves the
 * next page and the next run continues from it. A resumed walk can re-see an
 * activity when new ones push the list down; the primary key collapses it.
 *
 * Streams: activities, coverage_diagnostics (one per run).
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { COVERAGE_REASONS } from "../strava/schemas.ts";
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
const DIAGNOSTICS_STREAM = "coverage_diagnostics";
const PER_PAGE = 20;
export const MAX_PAGES_PER_RUN = 100;
export const PAGE_DELAY_MS = 1000;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DELAY_MS = 30_000;
/** Always absent from the list, so always named in `fields_unavailable`. */
const LIST_LACKS = [
	"average_heartrate",
	"max_heartrate",
	"calories_kcal",
	"gear",
] as const;

/** The coverage reasons a browser run can end on; the others are export-only. */
type CoverageReason = Exclude<
	(typeof COVERAGE_REASONS)[number],
	"awaiting_upload" | "window_unavailable"
>;

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
	maxPages?: number;
	pageDelayMs?: number;
	rateLimitDelayMs?: number;
}

interface ActivitiesState {
	/** Newest start collected by a finished walk, as a UTC instant. */
	last_start_time?: string | null;
	/** Set only while a walk is unfinished: the page to continue from. */
	resume_page?: number | null;
	/** Newest start collected so far by the unfinished walk, as a UTC instant. */
	walk_newest_start_time?: string | null;
	/**
	 * Earliest local day the cursor covers, from the requested start of the
	 * walk that set it. Absent when the walk had no start, so the cursor
	 * covers the whole history.
	 */
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

const isoOrNull = (value: string | undefined): string | null =>
	value ? new Date(value).toISOString() : null;

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
	if (
		!ctx.requested.has(ACTIVITIES_STREAM) &&
		!ctx.requested.has(DIAGNOSTICS_STREAM)
	) {
		return;
	}
	const maxPages = options.maxPages ?? MAX_PAGES_PER_RUN;
	const pageDelayMs = options.pageDelayMs ?? PAGE_DELAY_MS;
	const rateLimitDelayMs = options.rateLimitDelayMs ?? RATE_LIMIT_DELAY_MS;
	const runStartedAt = new Date().toISOString();
	const fullRefresh = ctx.collectionMode === "full_refresh";
	const stored =
		(ctx.state[ACTIVITIES_STREAM] as ActivitiesState | undefined) ?? {};
	const timeRange = ctx.requested.get(ACTIVITIES_STREAM)?.time_range;
	const rangeSinceDay = timeRange?.since?.slice(0, 10) ?? null;
	// A cursor covers only back to the start its walk requested. When this run
	// asks for an earlier start, or none, the cursor would hide the gap, so the
	// walk ignores it and goes down to the new start.
	const storedFloor = stored.requested_since ?? null;
	const cursorCovers =
		(stored.last_start_time != null || stored.resume_page != null) &&
		(storedFloor === null ||
			(rangeSinceDay !== null && rangeSinceDay >= storedFloor));
	// A full refresh ignores the cursor: activities are edited and deleted at
	// the source, and only a whole walk can see that.
	const prior: ActivitiesState = !fullRefresh && cursorCovers ? stored : {};
	const floor = !fullRefresh && cursorCovers ? storedFloor : rangeSinceDay;
	const since = prior.last_start_time ?? null;
	const firstPage = prior.resume_page ?? 1;

	await ensureStravaOrigin(ctx.page);

	let pageNumber = firstPage;
	let pagesRead = 0;
	let emitted = 0;
	let unreadable = 0;
	let earliest: string | null = null;
	let latest: string | null = null;
	let walkNewest = prior.walk_newest_start_time ?? null;
	let previousFirstId: string | null = null;
	let failure: { reason: CoverageReason; message: string } | null = null;
	let finished = false;
	const seenFields = new Set<string>();

	while (pagesRead < maxPages) {
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
			finished = true;
			break;
		}
		const records = parsed.models.map(buildActivityRecord);
		const firstId = records.find((record) => record !== null)?.id ?? null;
		if (firstId !== null && firstId === previousFirstId) {
			failure = {
				reason: "source_unreadable",
				message: `Strava returned the same activities for page ${pageNumber} as for the page before it.`,
			};
			break;
		}
		previousFirstId = firstId;
		let pageHasNewer = false;
		for (const record of records) {
			if (!record) {
				unreadable += 1;
				continue;
			}
			const instant = startInstant(record);
			// The list is newest first, so a page with nothing after the cursor
			// and the requested start ends the walk.
			if (
				(!since || instant > since) &&
				(!rangeSinceDay || record.start_date >= rangeSinceDay)
			) {
				pageHasNewer = true;
			}
			if (
				(since && instant <= since) ||
				isOutsideTimeRange(record.start_date, timeRange)
			) {
				continue;
			}
			for (const field of [
				"distance_m",
				"moving_time_s",
				"elapsed_time_s",
				"total_elevation_gain_m",
			] as const) {
				if (record[field] !== null) {
					seenFields.add(field);
				}
			}
			await ctx.emitRecord(ACTIVITIES_STREAM, { ...record });
			emitted += 1;
			earliest = earlier(earliest, instant);
			latest = later(latest, instant);
			walkNewest = later(walkNewest, instant);
		}
		await ctx.emit({
			type: "PROGRESS",
			stream: ACTIVITIES_STREAM,
			message: `Strava page ${pageNumber}: ${emitted} activities collected`,
			count: emitted,
			...(parsed.total > 0 ? { total: parsed.total } : {}),
		});
		if (!pageHasNewer || pageNumber * parsed.perPage >= parsed.total) {
			finished = true;
			break;
		}
		pageNumber += 1;
	}

	let reason: CoverageReason;
	if (failure) {
		reason = failure.reason;
	} else if (!finished) {
		reason = "source_limit_reached";
	} else if (unreadable > 0) {
		reason = "records_unreadable";
	} else if (emitted === 0) {
		reason = "nothing_in_range";
	} else {
		reason = "covered_in_full";
	}
	const status =
		reason === "covered_in_full"
			? "complete"
			: emitted > 0
				? "partial"
				: "empty";

	if (reason !== "covered_in_full" && reason !== "nothing_in_range") {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: ACTIVITIES_STREAM,
			reason: SKIP_REASON[reason],
			message:
				failure?.message ??
				(reason === "source_limit_reached"
					? `Stopped after ${pagesRead} pages; page ${pageNumber} is next.`
					: `${unreadable} activities in the Strava list had no usable id or start time.`),
			diagnostics: { pages_read: pagesRead, unreadable },
		});
	}

	if (ctx.requested.has(DIAGNOSTICS_STREAM)) {
		const fieldsUnavailable = [
			...(emitted > 0
				? [
						"distance_m",
						"moving_time_s",
						"elapsed_time_s",
						"total_elevation_gain_m",
					].filter((field) => !seenFields.has(field))
				: []),
			...LIST_LACKS,
		];
		await ctx.emitRecord(DIAGNOSTICS_STREAM, {
			id: `${ACTIVITIES_STREAM}:${runStartedAt}`,
			stream: ACTIVITIES_STREAM,
			status,
			reason,
			record_count: emitted,
			fields_unavailable: fieldsUnavailable,
			window_requested_from: isoOrNull(timeRange?.since) ?? since,
			window_requested_to: isoOrNull(timeRange?.until),
			window_covered_from: earliest,
			window_covered_to: latest,
			freshness: "live",
			exported_at: null,
		});
	}

	// The cursor moves only when a walk finishes. An unfinished walk records
	// where to continue; a failed page is retried next run.
	const floorField = floor ? { requested_since: floor } : {};
	let cursor: ActivitiesState;
	if (finished && !failure) {
		cursor = { last_start_time: later(since, walkNewest), ...floorField };
	} else {
		// After a failure this is the failed page; after the page bound it is
		// the first page not read.
		const resumePage = pageNumber;
		cursor =
			resumePage > 1
				? {
						last_start_time: since,
						resume_page: resumePage,
						walk_newest_start_time: walkNewest,
						...floorField,
					}
				: // Nothing was read: keep the stored cursor, also on a full refresh.
					{ ...stored };
	}
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

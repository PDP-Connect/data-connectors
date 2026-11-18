#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Polar Flow's browser-session profile. The owner signs in to flow.polar.com by hand in the
 * runtime's browser (Polar's sign-in lives on auth.polar.com: e-mail and password, no captcha or
 * second factor on the form as of November 2026). Collection then reads the JSON the web app itself
 * loads, from inside a flow.polar.com page, with the page's cookies: the profile, the training
 * history, each session's analysis summary and its heart rate samples (from the analysis details,
 * cut down to the heart rate series inside the page), the 24/7 activity timeline, the sleep report
 * (served from sleep-api.flow.polar.com, which allows the flow.polar.com origin with credentials)
 * and Nightly Recharge. No credential reaches this code, and the session cookie never leaves the
 * page. Every request is a read; the one POST (`/api/training/history`) is how the web app itself
 * lists sessions.
 *
 * Reachability: exempt from the unauthenticated reachability probe. Every endpoint here answers
 * 401 without the owner's session; there is no public endpoint to probe.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	type EnsureSessionArgs,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	activityDays,
	type Built,
	dailyActivityRecord,
	type HeartRateSeries,
	heartRateSamples,
	isDay,
	localTime,
	nightlyRechargeRecord,
	nightlyRows,
	parseTrainingRow,
	parseTrainingSummary,
	profileRecord,
	recordedHeartRate,
	rowDate,
	sleepRecord,
	sleepRows,
	trainingHistoryRows,
	trainingSessionRecord,
	userId,
	utcOffset,
	type Window,
} from "./parsers.ts";
import {
	STREAMS,
	type Stream,
	type TrainingHistoryRow,
	type TrainingSummaryResponse,
	validateRecord,
} from "./schemas.ts";

export { STREAMS };
export const ORIGIN = "https://flow.polar.com";
export const SLEEP_ORIGIN = "https://sleep-api.flow.polar.com";
export const SIGN_IN_ORIGIN = "https://auth.polar.com";
/** The diary: signed in, the web app; signed out, Flow sends the page to its landing page. */
export const APP_URL = `${ORIGIN}/diary`;
/** Flow's sign-in entry: its button goes on to auth.polar.com and back. */
export const LOGIN_URL = `${ORIGIN}/login`;
/** The owner's profile: cheap, authenticated JSON, 401 signed out; gives the user id and UTC offset. */
export const PROBE_PATH = "/api/account/users/current/user";

type RangeStream = Exclude<Stream, "profile">;

/** Per stream: the days one request covers and the days re-read each run. */
export interface StreamPlan {
	windowDays: number;
	overlapDays: number;
}
export const PLANS: Record<RangeStream, StreamPlan> = {
	// The web app's training list asks for a month at a time.
	training_sessions: {
		windowDays: 31,
		overlapDays: 14,
	},
	// loadFour answers [day-2, day+1]: four days per request. Today is partial, so the last days are re-read.
	daily_activity: {
		windowDays: 4,
		overlapDays: 3,
	},
	// The sleep report answers 30 to 365 days per request.
	sleep: {
		windowDays: 365,
		overlapDays: 7,
	},
	nightly_recharge: {
		windowDays: 28,
		overlapDays: 7,
	},
};
/** Before Polar Flow's launch; days before the account return no rows. */
export const HISTORY_START = "2012-01-01";
/** The sleep report refuses a window shorter than this many days (from to `to`). */
export const SLEEP_MIN_SPAN_DAYS = 30;
/** loadFour's downsampling cap; Flow's own UI sends 200, and very small values answer 500. */
export const MAX_SAMPLE_COUNT = 200;

export interface Pacing {
	requestDelayMs: number;
	maxRetryAfterMs: number;
	sleep: (ms: number) => Promise<void>;
	/** How long one run may spend reading heart rate samples; past it, sessions ship without them. */
	heartRateBudgetMs?: number;
	now?: () => number;
}
export const PACING: Pacing = {
	requestDelayMs: 1000,
	maxRetryAfterMs: 60_000,
	sleep: politeDelay,
};
/**
 * A first import reads up to two years of sessions, oldest first, each with a details answer of
 * about 500 KB an hour. Heart rate samples are read only for sessions of the last
 * HEART_RATE_RECENT_DAYS days: a remote run starts from scratch every time, so a budget spent on
 * the oldest sessions would leave the newest without samples on every run. The whole run must
 * also end inside the runtime's ceiling, so heart rate reads stop after HEART_RATE_BUDGET_MS; the
 * sessions after it are still delivered, without samples, and do not hold the cursor.
 */
export const HEART_RATE_RECENT_DAYS = 90;
export const HEART_RATE_BUDGET_MS = 4 * 60_000;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_FALLBACK_MS = 30_000;
const DAY_MS = 86_400_000;

// ── Requests: GETs and the training-history POST, none carrying a credential ──
export interface PolarRequest {
	/** A flow.polar.com path, or a full sleep-api.flow.polar.com URL. */
	url: string;
	method: "GET" | "POST";
	body?: string;
	/**
	 * "heart_rate": the page keeps only the session id, each exercise's start time and its
	 * HEART_RATE series from a 200 JSON answer, and hands over that. The rest of the analysis
	 * details (GPS fixes, the other series: about 500 KB for an hour) never leaves the page.
	 */
	pick?: "heart_rate";
}

export const addDays = (day: string, n: number): string =>
	new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
		.toISOString()
		.slice(0, 10);

/** The web app's training list: a POST with the owner's id and an inclusive day range. */
export function trainingHistoryRequest(
	user: number,
	window: Window,
): PolarRequest {
	return {
		url: "/api/training/history",
		method: "POST",
		body: JSON.stringify({
			userId: user,
			fromDate: window.from,
			toDate: window.to,
		}),
	};
}

export function trainingSummaryRequest(id: number): PolarRequest {
	return { url: `/api/training/analysis/${id}/summary`, method: "GET" };
}

/** The analysis page's chart data: per-exercise series at 1 Hz; only heart rate is kept. */
export function trainingDetailsRequest(id: number): PolarRequest {
	return {
		url: `/api/training/analysis/${id}/details`,
		method: "GET",
		pick: "heart_rate",
	};
}

/**
 * loadFour answers [day-2, day+1]: asked for the window's third day, it answers the window. The
 * day asked is never past `today`, as the web app never asks for one; [today-2, today+1] still
 * covers a short last window that ends today.
 */
export function activityRequest(window: Window, today?: string): PolarRequest {
	const third = addDays(window.from, 2);
	const day = today !== undefined && third > today ? today : third;
	return {
		url: `/api/activity-timeline/loadFour?day=${day}&maxSampleCount=${MAX_SAMPLE_COUNT}`,
		method: "GET",
	};
}

/** Widened back to the report's 30-day floor when the window is shorter; rows outside it are dropped. */
export function sleepRequest(window: Window): PolarRequest {
	const floor = addDays(window.to, -SLEEP_MIN_SPAN_DAYS);
	const from = window.from < floor ? window.from : floor;
	return {
		url: `${SLEEP_ORIGIN}/api/sleep/report?from=${from}&to=${window.to}`,
		method: "GET",
	};
}

export function nightlyRequest(window: Window): PolarRequest {
	return {
		url: `/api/nightly-recovery/${window.from}/${window.to}`,
		method: "GET",
	};
}

// ── In-page fetch: self-contained, origin-checked, bounded, never throws ──
export type PageFetch =
	| { kind: "wrong_origin"; origin: string }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			contentType: string;
			retryAfter: string | null;
			body: string;
	  };

/** Reads one request from a flow.polar.com page with the page's cookies. */
export async function pageFetch(
	page: Pick<Page, "evaluate">,
	request: PolarRequest,
): Promise<PageFetch> {
	try {
		const result = await page.evaluate(
			async ({ origin, request }) => {
				if (location.origin !== origin) {
					return { kind: "wrong_origin", origin: location.origin };
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 30_000);
				const headers: Record<string, string> = {
					accept: "application/json",
					// Flow's CSRF guard and the sleep API both require it, as the web app sends it.
					"x-requested-with": "XMLHttpRequest",
				};
				if (request.body !== undefined) {
					headers["content-type"] = "application/json";
				}
				try {
					const res = await fetch(request.url, {
						method: request.method,
						credentials: "include",
						headers,
						body: request.body ?? null,
						signal: controller.signal,
					});
					let body = await res.text();
					if (request.pick === "heart_rate" && res.status === 200) {
						// No named helpers here: the function is serialised into the page, where a
						// bundler's name-keeping wrapper would not exist.
						try {
							const details = JSON.parse(body) as Record<
								string,
								unknown
							> | null;
							const picked: Record<string, unknown> = { id: details?.id };
							for (const [part, key] of [
								["exercises", "startTime"],
								["samples", "HEART_RATE"],
							] as const) {
								const value = details?.[part];
								// A map keeps only `key` of each entry; anything else passes as is,
								// for the boundary parse to refuse.
								picked[part] =
									typeof value === "object" &&
									value !== null &&
									!Array.isArray(value)
										? Object.fromEntries(
												Object.entries(value).map(([id, entry]) => [
													id,
													typeof entry === "object" && entry !== null
														? {
																[key]:
																	(entry as Record<string, unknown>)[key] ??
																	null,
															}
														: entry,
												]),
											)
										: value;
							}
							body = JSON.stringify(picked);
						} catch {
							// Not JSON: handed over as is, and classified as unreadable.
						}
					}
					return {
						kind: "response",
						status: res.status,
						contentType: res.headers.get("content-type") ?? "",
						retryAfter: res.headers.get("retry-after"),
						body,
					};
				} catch (error) {
					return {
						kind: "network_error",
						message: error instanceof Error ? error.name : "fetch_failed",
					};
				} finally {
					clearTimeout(timer);
				}
			},
			{ origin: ORIGIN, request },
		);
		// PageShim answers a throw with null.
		return (
			(result as PageFetch | null) ?? {
				kind: "network_error",
				message: "no_result",
			}
		);
	} catch {
		// A navigation raced the evaluate.
		return { kind: "network_error", message: "evaluate_failed" };
	}
}

/** A run's first read: off flow.polar.com (about:blank, auth.polar.com), go to the app once and read again. */
async function readOnOrigin(
	page: Pick<Page, "evaluate" | "goto">,
	request: PolarRequest,
): Promise<PageFetch> {
	const first = await pageFetch(page, request);
	if (first.kind !== "wrong_origin") return first;
	await page
		.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	return pageFetch(page, request);
}

const PROBE: PolarRequest = { url: PROBE_PATH, method: "GET" };

/**
 * A signed-in answer: 200 JSON from the profile API. A 401 or the landing page is not. Whether the
 * profile holds a usable user id is collection's question: a changed profile shape then fails the
 * run as unreadable instead of sending a signed-in owner to a sign-in that can never pass.
 */
function isLive(r: PageFetch): boolean {
	if (r.kind !== "response" || r.status !== 200 || !/json/i.test(r.contentType))
		return false;
	try {
		const json = JSON.parse(r.body) as unknown;
		return typeof json === "object" && json !== null;
	} catch {
		return false;
	}
}

// ── Probes and sign-in ─────────────────────────────────────────────────────
/** Readiness: never navigates, because it polls the page the owner is typing into. */
export async function probeOnPage(
	page: Pick<Page, "evaluate">,
): Promise<boolean> {
	return isLive(await pageFetch(page, PROBE));
}

/**
 * The runtime's first probe: may navigate, because nobody is on the page yet. An API that answers
 * but is unavailable (429, 5xx) is not a signed-out owner: the run goes on to collection, which
 * reports it as an interruption to retry, rather than asking the owner to sign in.
 */
export async function probeSession(
	page: Pick<Page, "evaluate" | "goto">,
): Promise<boolean> {
	const r = await readOnOrigin(page, PROBE);
	return (
		isLive(r) ||
		(r.kind === "response" && (r.status === 429 || r.status >= 500))
	);
}

export interface Settle {
	attempts: number;
	intervalMs: number;
	sleep: (ms: number) => Promise<void>;
}
/** Three reads of at most 30 s each and two pauses: inside the 120 s establish watchdog. */
export const SIGN_IN_SETTLE: Settle = {
	attempts: 3,
	intervalMs: 1500,
	sleep: politeDelay,
};

/**
 * Signed out: open Flow's sign-in page. The page is read a few times without navigating, in case
 * a remembered session comes back, and only then is the owner asked to sign in. The owner signs in
 * on auth.polar.com, which returns to flow.polar.com; readiness polls only from there.
 */
export function makeEnsureSession(
	settle: Settle = SIGN_IN_SETTLE,
): (args: EnsureSessionArgs) => Promise<void> {
	return async (args) => {
		const {
			assist,
			capture,
			checkpoint,
			completeAssistance,
			page,
			sendInteraction,
		} = args;
		await checkpoint("sign-in-page");
		await page.goto(LOGIN_URL, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await checkpoint("sign-in-settle");
		for (let attempt = 1; attempt <= settle.attempts; attempt += 1) {
			if (await probeOnPage(page)) return;
			if (attempt < settle.attempts) await settle.sleep(settle.intervalMs);
		}
		await checkpoint("sign-in-handoff");
		const ready = await manualBrowserLogin({
			assist,
			capture,
			completeAssistance,
			page,
			sendInteraction,
			isProbeSuccessful: (ok) => ok === true,
			message:
				"Sign in to Polar Flow in the secure browser. The import continues on its own once you are signed in.",
			probe: async () => isLive(await readOnOrigin(page, PROBE)),
			readinessProbe: probeOnPage,
			readinessProbeOnHandoffPage: true,
			timeoutSeconds: 30 * 60,
		});
		if (!ready) throw new Error("polar_flow_session_dead");
	};
}

export const ensureSession = makeEnsureSession();

// ── Classification (Node side) ─────────────────────────────────────────────
type Reason =
	| "collection_interrupted"
	| "sign_in_required"
	| "source_limit_reached"
	| "source_unreadable";
/** A bare object literal, so the reason scan resolves SKIP_REASON[x]. */
const SKIP_REASON: Record<Reason, string> = {
	collection_interrupted: "collection_interrupted",
	sign_in_required: "sign_in_required",
	source_limit_reached: "source_limit_reached",
	source_unreadable: "source_unreadable",
};
/** A `function`, so the recovery-hint scan reads its literals. */
function hintFor(reason: Reason): { action: string; retryable: boolean } {
	if (reason === "sign_in_required") {
		return { action: "refresh_credentials", retryable: false };
	}
	if (reason === "source_unreadable") {
		return { action: "retry_on_connector_upgrade", retryable: false };
	}
	return { action: "retry_by_runtime", retryable: true };
}
export type Failure = {
	ok: false;
	reason: Reason;
	message: string;
	retryAfterMs?: number;
};
/** `json` is null for Flow's 404 "nothing in this range" (Nightly Recharge). */
export type Outcome = { ok: true; json: unknown; status: number } | Failure;

const signIn = (message: string): Failure => ({
	ok: false,
	reason: "sign_in_required",
	message,
});

function retryAfterMs(header: string | null, now: number): number {
	const value = header?.trim() ?? "";
	const seconds = /^\d+$/.test(value)
		? Number(value)
		: /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
					value,
				)
			? (Date.parse(value) - now) / 1000
			: Number.NaN;
	return Number.isFinite(seconds)
		? Math.max(0, seconds * 1000)
		: RATE_LIMIT_FALLBACK_MS;
}

/**
 * One answer, classified. `notFoundIsEmpty` is for the reads where Flow answers 404 for a range or
 * a session it holds nothing for; elsewhere a 404 means the endpoint moved. "not_html" takes only
 * a bare 404 as empty: an HTML 404 page is the answer for a path Flow does not know.
 */
export type NotFound = boolean | "not_html";
export function classify(
	r: PageFetch,
	notFoundIsEmpty: NotFound = false,
	now = Date.now(),
): Outcome {
	if (r.kind === "wrong_origin") {
		return r.origin === SIGN_IN_ORIGIN
			? signIn("Polar Flow asked for sign-in.")
			: {
					ok: false,
					reason: "collection_interrupted",
					message: "Not read (wrong_origin).",
				};
	}
	if (r.kind === "network_error") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: "Not read (network_error).",
		};
	}
	if (r.status === 401)
		return signIn("Polar Flow asked for sign-in (HTTP 401).");
	if (r.status === 403)
		return signIn("Polar Flow refused the session (HTTP 403).");
	if (r.status === 429) {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: "Rate limited (HTTP 429).",
			retryAfterMs: retryAfterMs(r.retryAfter, now),
		};
	}
	if (r.status >= 500) {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `HTTP ${r.status}.`,
		};
	}
	if (
		r.status === 404 &&
		(notFoundIsEmpty === true ||
			(notFoundIsEmpty === "not_html" && !/html/i.test(r.contentType)))
	) {
		return { ok: true, json: null, status: 404 };
	}
	if (r.status === 200 && /json/i.test(r.contentType)) {
		try {
			return { ok: true, json: JSON.parse(r.body) as unknown, status: 200 };
		} catch {
			// Falls through to unreadable.
		}
	}
	return {
		ok: false,
		reason: "source_unreadable",
		message: `HTTP ${r.status} (${r.contentType || "no type"}), not the JSON expected.`,
	};
}

type Reader = (
	page: Pick<Page, "evaluate" | "goto">,
	request: PolarRequest,
) => Promise<PageFetch>;

/** One read, classified; a 429 waits Retry-After at most twice, while it is within maxRetryAfterMs. */
async function fetchJson(
	page: Pick<Page, "evaluate" | "goto">,
	request: PolarRequest,
	p: Pacing,
	options: { notFoundIsEmpty?: NotFound; read?: Reader } = {},
): Promise<Outcome> {
	const read = options.read ?? pageFetch;
	for (let waits = 0; ; waits += 1) {
		const outcome = classify(
			await read(page, request),
			options.notFoundIsEmpty ?? false,
		);
		if (outcome.ok) return outcome;
		if (
			outcome.retryAfterMs === undefined ||
			waits >= RATE_LIMIT_RETRIES ||
			outcome.retryAfterMs > p.maxRetryAfterMs
		) {
			return outcome;
		}
		await p.sleep(outcome.retryAfterMs);
	}
}

// ── Days and cursors ───────────────────────────────────────────────────────
/**
 * Owner-local days, YYYY-MM-DD: `next_day` is the first day not yet read in full, `floor` where the
 * contiguous read began. Days from `floor` up to `next_day` have been read with every record in
 * them delivered.
 */
export interface DayCursor {
	next_day?: string;
	floor?: string;
	/** The `next_day` a run left in place for an unreadable record; the next run retries it once. */
	held_at?: string;
}
/** A cursor a run reads from: both days set. */
export interface Cursor {
	next_day: string;
	floor: string;
	held_at?: string;
}

export function readCursor(value: unknown): DayCursor {
	if (typeof value !== "object" || value === null) return {};
	const { next_day, floor, held_at } = value as Record<string, unknown>;
	if (!isDay(next_day) || !isDay(floor) || floor > next_day) return {};
	return isDay(held_at) ? { next_day, floor, held_at } : { next_day, floor };
}

/** A grant in days: `since` inclusive, `until` exclusive. */
export interface DayRange {
	since?: string | undefined;
	until?: string | undefined;
}

const dayPrefix = (value: unknown): string | undefined => {
	const day = typeof value === "string" ? value.slice(0, 10) : undefined;
	return isDay(day) ? day : undefined;
};

export function grantDays(
	range: { since?: string; until?: string } | undefined,
): DayRange {
	return { since: dayPrefix(range?.since), until: dayPrefix(range?.until) };
}

/** The owner's calendar day at `now`, at their UTC offset as Flow holds it; without one, UTC. */
export function localDay(now: Date, offset: string | null): string {
	const match = offset ? /^([+-])(\d{2}):(\d{2})$/.exec(offset) : null;
	const minutes = match
		? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
		: 0;
	return new Date(now.getTime() + minutes * 60_000).toISOString().slice(0, 10);
}

/**
 * Pure: the cursor this run starts from and the days it reads. A first run, a full refresh, a
 * grant that starts before the floor or past the cursor, or a cursor ahead of the owner's today
 * reads afresh from the grant's start or 2012-01-01. Otherwise the run re-reads
 * `overlapDays` before `next_day` (Polar scores days late and devices sync late) and reads on.
 */
export function planDays(
	prev: DayCursor,
	today: string,
	grant: DayRange,
	fullRefresh: boolean,
	plan: StreamPlan,
): { cursor: Cursor; from: string; to: string } {
	const { since, until } = grant;
	const last = until && addDays(until, -1) < today ? addDays(until, -1) : today;
	const start = since ?? HISTORY_START;
	const tomorrow = addDays(today, 1);
	const { next_day: next, floor } = prev;
	if (
		fullRefresh ||
		next === undefined ||
		floor === undefined ||
		floor > tomorrow ||
		(since !== undefined && (since < floor || since > next))
	) {
		return { cursor: { next_day: start, floor: start }, from: start, to: last };
	}
	const cursor: Cursor = { next_day: next > tomorrow ? tomorrow : next, floor };
	let from = addDays(cursor.next_day, -plan.overlapDays);
	if (from < floor) from = floor;
	if (since !== undefined && from < since) from = since;
	return { cursor, from, to: last };
}

/** The windows from `from` to `to`, oldest first, each at most `size` days. */
export function windows(from: string, to: string, size: number): Window[] {
	const out: Window[] = [];
	for (let start = from; start <= to; ) {
		const end = addDays(start, size - 1);
		out.push({ from: start, to: end < to ? end : to });
		start = addDays(end, 1);
	}
	return out;
}

// ── Collect ────────────────────────────────────────────────────────────────
/** Structural, so the desktop runtime and test fakes both satisfy it. */
export type PolarCollectContext = Pick<
	BrowserCollectContext,
	"collectionMode" | "emit" | "emitRecord" | "requested" | "state"
> & { page: Pick<Page, "evaluate" | "goto"> };

/**
 * Emits only a record that validates (vocabulary drift included, which the runtime keeps and
 * reports): the runtime answers a failing one with a skip of the whole stream. A failing record's
 * field paths, never its values, go to `issues` for the stream's skip diagnostics.
 */
async function emitClean(
	ctx: PolarCollectContext,
	stream: Stream,
	record: RecordData,
	issues: Set<string>,
): Promise<boolean> {
	const check = validateRecord(stream, record);
	if (!check.ok) {
		for (const issue of check.issues ?? [])
			issues.add(issue.path || "(record)");
		return false;
	}
	await ctx.emitRecord(stream, record);
	return true;
}

/** Emits what a row built. Answers whether it counts as unreadable; an empty row does not. */
async function deliver(
	ctx: PolarCollectContext,
	stream: Stream,
	built: Built,
	issues: Set<string>,
): Promise<boolean> {
	if (built.kind === "empty") return false;
	if (built.kind === "unreadable") {
		issues.add("(source row)");
		return true;
	}
	return !(await emitClean(ctx, stream, built.record, issues));
}

interface WindowRead {
	failure: Failure | null;
	unreadable: number;
}

const unreadableAnswer = (): Failure => ({
	ok: false,
	reason: "source_unreadable",
	message: "An answer was not in the shape expected.",
});

const within = (day: string | null, w: Window): day is string =>
	day !== null && day >= w.from && day <= w.to;

interface Run {
	ctx: PolarCollectContext;
	p: Pacing;
	user: number;
	today: string;
	/** Per stream: the field paths of records that did not validate, for the skip diagnostics. */
	issues: Record<Stream, Set<string>>;
	/** Heart rate reads stop at this time (HEART_RATE_BUDGET_MS from the run's start). */
	heartRateDeadline: number;
	/** Sessions shipped without samples because the heart rate budget ran out. */
	heartRateSkipped: number;
	/** Sessions older than HEART_RATE_RECENT_DAYS, shipped without samples by design. */
	heartRateOlder: number;
}

/** Issue keys: samples in a shape the connector cannot read, and samples Polar did not serve. */
const SAMPLES_SHAPE = "(heart rate samples)";
const SAMPLES_UNANSWERED = "(heart rate samples unanswered)";

interface SamplesRead {
	samples: HeartRateSeries[] | null;
	/** A lost sign-in or a rate limit, which stop the window as any other read's would. */
	failure: Failure | null;
	unreadable: boolean;
}

/**
 * A session's heart rate samples, read right after its summary, as the web app's analysis page
 * loads the two together (so without a pause of its own). Not asked for a session that recorded
 * no heart rate. A 404 is a session without details. Any other answer that does not give the
 * samples (an unexpected shape, a 5xx, a timeout on a very long session) ships the session without
 * them and counts it unreadable: the window is read once more on the next run, and after that the
 * hold is released (walkStream), so one session's samples can never pin the stream.
 */
async function readHeartRate(
	run: Run,
	row: TrainingHistoryRow,
	summary: TrainingSummaryResponse | null,
	day: string,
): Promise<SamplesRead> {
	if (!recordedHeartRate(row, summary)) {
		return { samples: null, failure: null, unreadable: false };
	}
	if (day < addDays(run.today, 1 - HEART_RATE_RECENT_DAYS)) {
		run.heartRateOlder += 1;
		return { samples: null, failure: null, unreadable: false };
	}
	if ((run.p.now ?? Date.now)() >= run.heartRateDeadline) {
		run.heartRateSkipped += 1;
		return { samples: null, failure: null, unreadable: false };
	}
	const detail = await fetchJson(
		run.ctx.page,
		trainingDetailsRequest(row.id),
		run.p,
		{ notFoundIsEmpty: true },
	);
	if (!detail.ok) {
		const stops =
			detail.reason === "sign_in_required" || detail.retryAfterMs !== undefined;
		return stops
			? { samples: null, failure: detail, unreadable: false }
			: { samples: null, failure: null, unreadable: true };
	}
	// An empty answer (a JSON null, which the in-page read turns into {}) is a session without
	// details, as a 404 is.
	if (
		detail.json === null ||
		(typeof detail.json === "object" &&
			!Array.isArray(detail.json) &&
			Object.keys(detail.json).length === 0)
	) {
		return { samples: null, failure: null, unreadable: false };
	}
	const samples = heartRateSamples(detail.json, row.id);
	if (samples === "unreadable") {
		// A shape the connector cannot read is the connector's to fix: a re-read repeats it, so it
		// is reported but does not hold the cursor.
		run.issues.training_sessions.add(SAMPLES_SHAPE);
		return { samples: null, failure: null, unreadable: false };
	}
	return { samples, failure: null, unreadable: false };
}

/** Says which sessions shipped without heart rate samples although they recorded some. */
async function reportHeartRate(run: Run): Promise<void> {
	if (run.issues.training_sessions.has(SAMPLES_SHAPE)) {
		await run.ctx.emit({
			type: "PROGRESS",
			stream: "training_sessions",
			message:
				"Some heart rate samples were not in the shape expected; those sessions were saved without them.",
			count: 0,
		});
	}
	if (run.issues.training_sessions.has(SAMPLES_UNANSWERED)) {
		await run.ctx.emit({
			type: "PROGRESS",
			stream: "training_sessions",
			message:
				"Polar did not answer for some heart rate samples; those sessions were saved without them and are read again on the next run.",
			count: 0,
		});
	}
	if (run.heartRateSkipped > 0) {
		await run.ctx.emit({
			type: "PROGRESS",
			stream: "training_sessions",
			count: run.heartRateSkipped,
			message: `${run.heartRateSkipped} session(s) of the last ${HEART_RATE_RECENT_DAYS} days saved without heart rate samples: the run's time for heart rate ran out.`,
		});
	}
	if (run.heartRateOlder > 0) {
		await run.ctx.emit({
			type: "PROGRESS",
			stream: "training_sessions",
			count: run.heartRateOlder,
			message: `${run.heartRateOlder} session(s) older than ${HEART_RATE_RECENT_DAYS} days saved without heart rate samples: they are read only for recent sessions.`,
		});
	}
}

/** One window of training history, each session's analysis summary and heart rate read after it. */
async function readTraining(run: Run, w: Window): Promise<WindowRead> {
	const { ctx, p } = run;
	await p.sleep(p.requestDelayMs);
	const list = await fetchJson(
		ctx.page,
		trainingHistoryRequest(run.user, w),
		p,
	);
	if (!list.ok) return { failure: list, unreadable: 0 };
	const rows = trainingHistoryRows(list.json);
	if (rows === null) return { failure: unreadableAnswer(), unreadable: 0 };
	let unreadable = 0;
	for (const raw of rows) {
		const row = parseTrainingRow(raw);
		const start = row === null ? null : localTime(row.startDate);
		if (row === null || start === null) {
			run.issues.training_sessions.add("(source row)");
			unreadable += 1;
			continue;
		}
		// Held to the window asked for: a row dated outside it is left to its own window.
		if (!within(start.slice(0, 10), w)) continue;
		await p.sleep(p.requestDelayMs);
		const detail = await fetchJson(
			ctx.page,
			trainingSummaryRequest(row.id),
			p,
			{
				notFoundIsEmpty: true,
			},
		);
		// A 404 (Flow serves no analysis for the session) keeps the list fields. A summary that is
		// not the JSON expected also ships the list fields, but counts as unreadable, so the window
		// is read again and the stream reports it. Anything else stops the window.
		if (!detail.ok && detail.reason !== "source_unreadable") {
			return { failure: detail, unreadable };
		}
		const summary = detail.ok ? parseTrainingSummary(detail.json) : null;
		const summaryUnreadable =
			!detail.ok || (detail.json !== null && summary === null);
		if (summaryUnreadable)
			run.issues.training_sessions.add("(analysis summary)");
		const hr = await readHeartRate(
			run,
			row,
			summary && summary.id === row.id ? summary : null,
			start.slice(0, 10),
		);
		if (hr.failure) return { failure: hr.failure, unreadable };
		if (hr.unreadable) run.issues.training_sessions.add(SAMPLES_UNANSWERED);
		const undelivered = await deliver(
			ctx,
			"training_sessions",
			trainingSessionRecord(row, summary, hr.samples),
			run.issues.training_sessions,
		);
		if (undelivered || summaryUnreadable || hr.unreadable) unreadable += 1;
	}
	return { failure: null, unreadable };
}

async function readActivity(run: Run, w: Window): Promise<WindowRead> {
	const { ctx, p } = run;
	await p.sleep(p.requestDelayMs);
	const outcome = await fetchJson(ctx.page, activityRequest(w, run.today), p);
	if (!outcome.ok) return { failure: outcome, unreadable: 0 };
	const days = activityDays(outcome.json);
	if (days === null) return { failure: unreadableAnswer(), unreadable: 0 };
	let unreadable = 0;
	for (const [day, value] of Object.entries(days).sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		if (!isDay(day)) {
			run.issues.daily_activity.add("(day key)");
			unreadable += 1;
			continue;
		}
		if (!within(day, w)) continue;
		if (
			await deliver(
				ctx,
				"daily_activity",
				dailyActivityRecord(day, value),
				run.issues.daily_activity,
			)
		) {
			unreadable += 1;
		}
	}
	return { failure: null, unreadable };
}

async function readRows(
	run: Run,
	w: Window,
	stream: "sleep" | "nightly_recharge",
): Promise<WindowRead> {
	const { ctx, p } = run;
	await p.sleep(p.requestDelayMs);
	const sleep = stream === "sleep";
	const outcome = await fetchJson(
		ctx.page,
		sleep ? sleepRequest(w) : nightlyRequest(w),
		p,
		{ notFoundIsEmpty: sleep ? false : "not_html" },
	);
	if (!outcome.ok) return { failure: outcome, unreadable: 0 };
	if (outcome.json === null) return { failure: null, unreadable: 0 };
	const rows = sleep ? sleepRows(outcome.json) : nightlyRows(outcome.json);
	if (rows === null) return { failure: unreadableAnswer(), unreadable: 0 };
	let unreadable = 0;
	for (const row of rows) {
		const date = rowDate(row);
		if (date === null) {
			run.issues[stream].add("(row date)");
			unreadable += 1;
			continue;
		}
		if (!within(date, w)) continue;
		const built = sleep ? sleepRecord(row) : nightlyRechargeRecord(row);
		if (await deliver(ctx, stream, built, run.issues[stream])) unreadable += 1;
	}
	return { failure: null, unreadable };
}

function readWindow(
	run: Run,
	stream: RangeStream,
	w: Window,
): Promise<WindowRead> {
	if (stream === "training_sessions") return readTraining(run, w);
	if (stream === "daily_activity") return readActivity(run, w);
	return readRows(run, w, stream);
}

interface Walk {
	failure: Failure | null;
	deferred: boolean;
	progressed: number;
	unreadable: number;
}

/**
 * Reads a stream's windows oldest first, without an artificial history cap. A window read in full moves
 * `next_day` past it, until the first window holding an unreadable record: from there the cursor
 * stays, so the next run reads that window again, while this run still delivers what reads. The
 * hold is retried once: with `release` (the previous run held at this same `next_day`), an
 * unreadable record no longer holds the cursor, so one record Polar keeps serving in a shape the
 * connector cannot read does not pin the stream for good. `held_at` records a hold for that.
 */
async function walkStream(
	run: Run,
	stream: RangeStream,
	cursor: Cursor,
	from: string,
	to: string,
	release: boolean,
): Promise<Walk> {
	const plan = PLANS[stream];
	const walk: Walk = {
		failure: null,
		deferred: false,
		progressed: 0,
		unreadable: 0,
	};
	let held = false;
	for (const w of windows(from, to, plan.windowDays)) {
		const read = await readWindow(run, stream, w);
		walk.unreadable += read.unreadable;
		if (read.failure) {
			walk.failure = read.failure;
			return walk;
		}
		walk.progressed += 1;
		if (read.unreadable > 0 && !release) held = true;
		if (!held && w.to >= cursor.next_day) {
			cursor.next_day = addDays(w.to, 1);
		}
	}
	return walk;
}

/** After a walk: a hold remembers its day, anything else clears it. */
function markHold(cursor: Cursor, walk: Walk, release: boolean): void {
	if (walk.unreadable > 0 && !release) cursor.held_at = cursor.next_day;
	else delete cursor.held_at;
}

/**
 * Reports a stream: one SKIP_RESULT when it is not whole (a failure first, then unreadable
 * records, then the per-run cap), so a run that dropped records never reads as a clean success.
 * Diagnostics name the fields that did not validate, never their values.
 */
async function finish(
	ctx: PolarCollectContext,
	stream: Stream,
	walk: Walk,
	cursor: Cursor | null,
	issues: Set<string>,
): Promise<void> {
	if (walk.unreadable > 0) {
		await ctx.emit({
			type: "PROGRESS",
			stream,
			count: walk.unreadable,
			message: `${walk.unreadable} record(s) unreadable.`,
		});
	}
	const reason: Reason | null = walk.failure
		? walk.failure.reason
		: walk.unreadable > 0
			? "source_unreadable"
			: walk.deferred
				? "source_limit_reached"
				: null;
	if (reason) {
		const unreadableMessage = `${walk.unreadable} record(s) were not in the shape expected and were not saved in full; their days are read once more on the next run.`;
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: SKIP_REASON[reason],
			recovery_hint: hintFor(reason),
			message:
				walk.failure?.message ??
				(walk.unreadable > 0
					? unreadableMessage
					: "Read as much as one run allows; the next run continues from the saved day."),
			...(issues.size > 0
				? {
						diagnostics: {
							unreadable: walk.unreadable,
							fields: [...issues].sort().slice(0, 20),
						},
					}
				: {}),
		});
	}
	if (cursor && (walk.progressed > 0 || !walk.failure)) {
		await ctx.emit({ type: "STATE", stream, cursor: { ...cursor } });
	}
}

/**
 * Reads each requested stream in turn, from one flow.polar.com page. The profile read comes
 * first, the only read that may navigate: it gives the user id the training history needs and
 * the owner's UTC offset, hence their today. A lost sign-in skips every stream after it.
 */
export async function collectPolarFlow(
	ctx: PolarCollectContext,
	pacing: Partial<Pacing> = {},
	now = new Date(),
): Promise<void> {
	const p = { ...PACING, ...pacing };
	const streams = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) return;
	const me = await fetchJson(ctx.page, PROBE, p, { read: readOnOrigin });
	const user = me.ok ? userId(me.json) : null;
	let stop: Failure | null = me.ok
		? user === null
			? unreadableAnswer()
			: null
		: me;
	const today = localDay(now, me.ok ? utcOffset(me.json) : null);
	const issues = Object.fromEntries(
		STREAMS.map((stream) => [stream, new Set<string>()]),
	) as Record<Stream, Set<string>>;
	const run: Run = {
		ctx,
		p,
		user: user ?? 0,
		today,
		issues,
		heartRateDeadline:
			(p.now ?? Date.now)() + (p.heartRateBudgetMs ?? HEART_RATE_BUDGET_MS),
		heartRateSkipped: 0,
		heartRateOlder: 0,
	};
	for (const stream of streams) {
		const empty: Walk = {
			failure: stop,
			deferred: false,
			progressed: 0,
			unreadable: 0,
		};
		if (stream === "profile") {
			if (!stop && me.ok) {
				empty.unreadable = (await deliver(
					ctx,
					"profile",
					profileRecord(me.json),
					issues.profile,
				))
					? 1
					: 0;
				if (empty.unreadable > 0) empty.failure = unreadableAnswer();
			}
			await finish(ctx, stream, empty, null, issues.profile);
			continue;
		}
		const prev = readCursor(ctx.state[stream]);
		const planned = planDays(
			prev,
			today,
			grantDays(ctx.requested.get(stream)?.time_range),
			ctx.collectionMode === "full_refresh",
			PLANS[stream],
		);
		const release =
			prev.held_at !== undefined && prev.held_at === planned.cursor.next_day;
		const walk = stop
			? empty
			: await walkStream(
					run,
					stream,
					planned.cursor,
					planned.from,
					planned.to,
					release,
				);
		if (!stop) markHold(planned.cursor, walk, release);
		if (stream === "training_sessions") await reportHeartRate(run);
		await finish(ctx, stream, walk, planned.cursor, issues[stream]);
		if (walk.failure?.reason === "sign_in_required") stop = walk.failure;
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "polar_flow",
		validateRecord,
		// = connector_key: the runtime keys the host-browser variable by it.
		browser: { profileName: "polar-flow" },
		probeSession: ({ page }) => probeSession(page),
		probeSessionIsAuthoritative: true,
		ensureSession,
		collect: (ctx: BrowserCollectContext) => collectPolarFlow(ctx),
	});
}

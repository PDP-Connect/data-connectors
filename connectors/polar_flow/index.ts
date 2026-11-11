#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Polar Flow's browser-session profile. The owner signs in to flow.polar.com by hand in the
 * runtime's browser (Polar's sign-in lives on auth.polar.com: e-mail and password, no captcha or
 * second factor on the form as of November 2026). Collection then reads the JSON the web app itself
 * loads, from inside a flow.polar.com page, with the page's cookies: the profile, the training
 * history and each session's analysis summary, the 24/7 activity timeline, the sleep report
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
	isDay,
	localTime,
	nightlyRechargeRecord,
	nightlyRows,
	parseTrainingRow,
	parseTrainingSummary,
	profileRecord,
	rowDate,
	sleepRecord,
	sleepRows,
	trainingHistoryRows,
	trainingSessionRecord,
	userId,
	utcOffset,
	type Window,
} from "./parsers.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

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

/** Per stream: the days one request covers, the history a first run reads, the days re-read each run. */
export interface StreamPlan {
	windowDays: number;
	initialDays: number;
	overlapDays: number;
	maxWindowsPerRun: number;
}
export const PLANS: Record<RangeStream, StreamPlan> = {
	// The web app's training list asks for a month at a time; history is read two years back.
	training_sessions: {
		windowDays: 31,
		initialDays: 730,
		overlapDays: 14,
		maxWindowsPerRun: 40,
	},
	// loadFour answers [day-2, day+1]: four days per request. Today is partial, so the last days are re-read.
	daily_activity: {
		windowDays: 4,
		initialDays: 90,
		overlapDays: 3,
		maxWindowsPerRun: 100,
	},
	// The sleep report answers 30 to 365 days per request.
	sleep: {
		windowDays: 365,
		initialDays: 365,
		overlapDays: 7,
		maxWindowsPerRun: 5,
	},
	nightly_recharge: {
		windowDays: 28,
		initialDays: 365,
		overlapDays: 7,
		maxWindowsPerRun: 20,
	},
};
/** The sleep report refuses a window shorter than this many days (from to `to`). */
export const SLEEP_MIN_SPAN_DAYS = 30;
/** loadFour's downsampling cap; Flow's own UI sends 200, and very small values answer 500. */
export const MAX_SAMPLE_COUNT = 200;

export interface Pacing {
	requestDelayMs: number;
	maxRetryAfterMs: number;
	sleep: (ms: number) => Promise<void>;
}
export const PACING: Pacing = {
	requestDelayMs: 1000,
	maxRetryAfterMs: 60_000,
	sleep: politeDelay,
};
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_FALLBACK_MS = 30_000;
const DAY_MS = 86_400_000;

// ── Requests: GETs and the training-history POST, none carrying a credential ──
export interface PolarRequest {
	/** A flow.polar.com path, or a full sleep-api.flow.polar.com URL. */
	url: string;
	method: "GET" | "POST";
	body?: string;
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

/** loadFour answers [day-2, day+1]: asked for the window's third day, it answers the window. */
export function activityRequest(window: Window): PolarRequest {
	return {
		url: `/api/activity-timeline/loadFour?day=${addDays(window.from, 2)}&maxSampleCount=${MAX_SAMPLE_COUNT}`,
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
					return {
						kind: "response",
						status: res.status,
						contentType: res.headers.get("content-type") ?? "",
						retryAfter: res.headers.get("retry-after"),
						body: await res.text(),
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

/** A signed-in answer: 200 JSON holding a user id. A 401 or the landing page is not. */
function isLive(r: PageFetch): boolean {
	if (r.kind !== "response" || r.status !== 200 || !/json/i.test(r.contentType))
		return false;
	try {
		return userId(JSON.parse(r.body) as unknown) !== null;
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
 * a session it holds nothing for; elsewhere a 404 means the endpoint moved.
 */
export function classify(
	r: PageFetch,
	notFoundIsEmpty = false,
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
	if (r.status === 404 && notFoundIsEmpty) {
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
	options: { notFoundIsEmpty?: boolean; read?: Reader } = {},
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
}
/** A cursor a run reads from: both days set. */
export interface Cursor {
	next_day: string;
	floor: string;
}

export function readCursor(value: unknown): DayCursor {
	if (typeof value !== "object" || value === null) return {};
	const { next_day, floor } = value as Record<string, unknown>;
	if (!isDay(next_day) || !isDay(floor) || floor > next_day) return {};
	return { next_day, floor };
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
 * reads afresh from the grant's start or `initialDays` back. Otherwise the run re-reads
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
	const start = since ?? addDays(today, 1 - plan.initialDays);
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

/** Emits only a clean record: the runtime answers a failing one with a skip of the whole stream. */
async function emitClean(
	ctx: PolarCollectContext,
	stream: Stream,
	record: RecordData,
): Promise<boolean> {
	const check = validateRecord(stream, record);
	if (!check.ok || check.anomalies?.length) return false;
	await ctx.emitRecord(stream, record);
	return true;
}

/** Emits what a row built. Answers whether it counts as unreadable; an empty row does not. */
async function deliver(
	ctx: PolarCollectContext,
	stream: Stream,
	built: Built,
): Promise<boolean> {
	if (built.kind === "empty") return false;
	if (built.kind === "unreadable") return true;
	return !(await emitClean(ctx, stream, built.record));
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
}

/** One window of training history, each session's analysis summary read after it. */
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
		if (row === null) {
			unreadable += 1;
			continue;
		}
		const start = localTime(row.startDate);
		if (start === null) {
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
		// A session Flow no longer serves an analysis for keeps its list fields; anything else stops.
		if (!detail.ok && detail.reason !== "source_unreadable") {
			return { failure: detail, unreadable };
		}
		const summary = detail.ok ? parseTrainingSummary(detail.json) : null;
		if (
			await deliver(
				ctx,
				"training_sessions",
				trainingSessionRecord(row, summary),
			)
		) {
			unreadable += 1;
		}
	}
	return { failure: null, unreadable };
}

async function readActivity(run: Run, w: Window): Promise<WindowRead> {
	const { ctx, p } = run;
	await p.sleep(p.requestDelayMs);
	const outcome = await fetchJson(ctx.page, activityRequest(w), p);
	if (!outcome.ok) return { failure: outcome, unreadable: 0 };
	const days = activityDays(outcome.json);
	if (days === null) return { failure: unreadableAnswer(), unreadable: 0 };
	let unreadable = 0;
	for (const [day, value] of Object.entries(days).sort(([a], [b]) =>
		a < b ? -1 : 1,
	)) {
		if (!isDay(day)) {
			unreadable += 1;
			continue;
		}
		if (!within(day, w)) continue;
		if (await deliver(ctx, "daily_activity", dailyActivityRecord(day, value))) {
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
		{ notFoundIsEmpty: !sleep },
	);
	if (!outcome.ok) return { failure: outcome, unreadable: 0 };
	if (outcome.json === null) return { failure: null, unreadable: 0 };
	const rows = sleep ? sleepRows(outcome.json) : nightlyRows(outcome.json);
	if (rows === null) return { failure: unreadableAnswer(), unreadable: 0 };
	let unreadable = 0;
	for (const row of rows) {
		const date = rowDate(row);
		if (date === null) {
			unreadable += 1;
			continue;
		}
		if (!within(date, w)) continue;
		const built = sleep ? sleepRecord(row) : nightlyRechargeRecord(row);
		if (await deliver(ctx, stream, built)) unreadable += 1;
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
 * Reads a stream's windows oldest first, at most maxWindowsPerRun. A window read in full moves
 * `next_day` past it, until the first window holding an unreadable record: from there the cursor
 * stays, so the next run reads that window again, while this run still delivers what reads.
 */
async function walkStream(
	run: Run,
	stream: RangeStream,
	cursor: Cursor,
	from: string,
	to: string,
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
		if (walk.progressed >= plan.maxWindowsPerRun) {
			walk.deferred = true;
			return walk;
		}
		const read = await readWindow(run, stream, w);
		walk.unreadable += read.unreadable;
		if (read.failure) {
			walk.failure = read.failure;
			return walk;
		}
		walk.progressed += 1;
		if (read.unreadable > 0) held = true;
		if (!held && w.to >= cursor.next_day) {
			cursor.next_day = addDays(w.to, 1);
		}
	}
	return walk;
}

async function finish(
	ctx: PolarCollectContext,
	stream: Stream,
	walk: Walk,
	cursor: Cursor | null,
): Promise<void> {
	if (walk.unreadable > 0) {
		await ctx.emit({
			type: "PROGRESS",
			stream,
			count: walk.unreadable,
			message: `${walk.unreadable} record(s) unreadable; their days are read again next run.`,
		});
	}
	const reason: Reason | null = walk.failure
		? walk.failure.reason
		: walk.deferred
			? "source_limit_reached"
			: null;
	if (reason) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: SKIP_REASON[reason],
			recovery_hint: hintFor(reason),
			message:
				walk.failure?.message ??
				"Read as much as one run allows; the next run continues from the saved day.",
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
	const run: Run = { ctx, p, user: user ?? 0 };
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
				))
					? 1
					: 0;
				if (empty.unreadable > 0) empty.failure = unreadableAnswer();
			}
			await finish(ctx, stream, empty, null);
			continue;
		}
		const planned = planDays(
			readCursor(ctx.state[stream]),
			today,
			grantDays(ctx.requested.get(stream)?.time_range),
			ctx.collectionMode === "full_refresh",
			PLANS[stream],
		);
		const walk = stop
			? empty
			: await walkStream(run, stream, planned.cursor, planned.from, planned.to);
		await finish(ctx, stream, walk, planned.cursor);
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

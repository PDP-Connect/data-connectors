#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Garmin Connect's browser-session profile. The owner signs in to connect.garmin.com by hand in
 * the runtime's browser; collection then reads the JSON the web app itself loads, from inside that
 * page, with the page's cookies and the request token the page carries. No credential reaches this
 * code, and the token never leaves the page. Every request is a read: nothing is ever written.
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
	type Built,
	type DayStream,
	dayRecord,
	isDay,
	type RangeStream,
	rowRecord,
	siteTimeZone,
	type Window,
	windowRows,
} from "./parsers.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

export { STREAMS };
export const ORIGIN = "https://connect.garmin.com";
/** The web app. Signed out, Garmin sends the page from here to its sign-in host. */
export const APP_URL = `${ORIGIN}/app/`;
export const LOGIN_URL = APP_URL;
export const SIGN_IN_ORIGIN = "https://sso.garmin.com";
/** The owner's settings: cheap, authenticated JSON, and where their time zone comes from. */
export const PROBE_PATH = "/gc-api/userprofile-service/userprofile/settings";
/** A first run, or a run whose grant has no start, reads this many days up to the owner's today. */
export const INITIAL_DAYS = 90;
/** A daily stream re-reads the last week each run: Garmin scores training status after the day, and watches sync late. */
export const OVERLAP_DAYS = 7;
/** The widest window Garmin's sleep range accepts (29 days answers 400); HRV and activities read the same. */
export const WINDOW_DAYS = 28;
/**
 * A range stream re-reads from four weeks before the last run's day, so a night or an activity
 * that reaches Garmin up to four weeks after its day, even just after a run, is still read. The
 * cursor is the day after that run's: hence a window and a day.
 */
export const RANGE_OVERLAP_DAYS = WINDOW_DAYS + 1;
/** The days before its cursor each stream reads again every run. */
export const OVERLAP: Record<Stream, number> = {
	daily_summaries: OVERLAP_DAYS,
	sleep: RANGE_OVERLAP_DAYS,
	hrv: RANGE_OVERLAP_DAYS,
	training_status: OVERLAP_DAYS,
	activities: RANGE_OVERLAP_DAYS,
};
/** The activities one request asks for, a size Garmin honours. An answer this full may have left some out. */
export const PAGE_SIZE = 100;
const RATE_LIMIT_RETRIES = 2;
/** Without a Retry-After that reads as seconds or an HTTP date, wait this long. */
const RATE_LIMIT_FALLBACK_MS = 30_000;
const DAY_MS = 86_400_000;

/** Each stream's consent and range field: the start instant where the record has one, else its day. */
export const TIME_RANGE_FIELD: Record<Stream, "date" | "start_at"> = {
	daily_summaries: "date",
	sleep: "start_at",
	hrv: "date",
	training_status: "date",
	activities: "start_at",
};

/** The runtime's per-stream time filter field. */
export function timeRangeFieldFor(stream: string): string {
	return TIME_RANGE_FIELD[stream as Stream] ?? "date";
}

export interface Pacing {
	maxDaysPerRun: number;
	/**
	 * How many requests one window may take while its activities are read in halves; past it the
	 * stream fails as unreadable. A WINDOW_DAYS window halved all the way to single days takes
	 * 2 × 28 − 1 = 55.
	 */
	maxRequestsPerWindow: number;
	maxRetryAfterMs: number;
	/**
	 * How many kept days (DayCursor.retry) a day stream may read again in one run and find still
	 * unreadable before it stops reading them; kept days that now read cost only maxDaysPerRun.
	 */
	maxRetryDaysPerRun: number;
	/** The same for a range stream's kept windows, within maxWindowsPerRun. */
	maxRetryWindowsPerRun: number;
	maxWindowsPerRun: number;
	requestDelayMs: number;
	sleep: (ms: number) => Promise<void>;
}
export const PACING: Pacing = {
	maxDaysPerRun: 90,
	maxRequestsPerWindow: 64,
	maxRetryAfterMs: 60_000,
	// A week of days, or one window, still unreadable: drift that lasts costs each run little, a
	// backlog that now reads clears at the run's full pace, and successive runs still go round a
	// full list of kept days.
	maxRetryDaysPerRun: 7,
	maxRetryWindowsPerRun: 1,
	maxWindowsPerRun: 40,
	requestDelayMs: 1000,
	sleep: politeDelay,
};

// ── Paths: every one a GET, none carrying the owner's handle ──────────────
export function dayPath(stream: DayStream, day: string): string {
	return stream === "daily_summaries"
		? `/gc-api/usersummary-service/usersummary/daily?calendarDate=${day}`
		: `/gc-api/metrics-service/metrics/trainingstatus/daily/${day}`;
}

/** One request per window or piece of one: activities always from the first row, never an offset. */
export function windowPath(stream: RangeStream, window: Window): string {
	const { from, to } = window;
	if (stream === "sleep") {
		return `/gc-api/sleep-service/stats/sleep/daily/${from}/${to}`;
	}
	if (stream === "hrv") return `/gc-api/hrv-service/hrv/daily/${from}/${to}`;
	return `/gc-api/activitylist-service/activities/search/activities?startDate=${from}&endDate=${to}&start=0&limit=${PAGE_SIZE}`;
}

// ── In-page fetch: self-contained, origin-checked, bounded, never throws ──
export type PageFetch =
	| { kind: "wrong_origin"; origin: string }
	| { kind: "no_token" }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			contentType: string;
			retryAfter: string | null;
			body: string;
	  };

/** Reads a same-origin API path with the page's cookies and its CSRF token, read and sent here and never returned. */
export async function pageFetch(
	page: Pick<Page, "evaluate">,
	path: string,
): Promise<PageFetch> {
	try {
		const result = await page.evaluate(
			async ({ origin, path }) => {
				if (location.origin !== origin) {
					return { kind: "wrong_origin", origin: location.origin };
				}
				// The web app's own request token: on /app/ pages, and only while signed in.
				const token = document
					.querySelector('meta[name="csrf-token"]')
					?.getAttribute("content");
				if (!token) return { kind: "no_token" };
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 30_000);
				try {
					const res = await fetch(path, {
						credentials: "include",
						headers: {
							accept: "application/json",
							"connect-csrf-token": token,
						},
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
			{ origin: ORIGIN, path },
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

/** A run's first read: off the app (about:blank, the sign-in host, a page without the token), go to it once and read again. Never page.url(): PageShim's facade lacks it. */
async function readOnOrigin(
	page: Pick<Page, "evaluate" | "goto">,
	path: string,
): Promise<PageFetch> {
	const first = await pageFetch(page, path);
	if (first.kind !== "wrong_origin" && first.kind !== "no_token") return first;
	await page
		.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	return pageFetch(page, path);
}

const isLive = (r: PageFetch): boolean =>
	r.kind === "response" && r.status === 200 && /json/i.test(r.contentType);

// ── Probes and sign-in ─────────────────────────────────────────────────────
/** Readiness: never navigates, because it polls the page the owner is typing into. */
export async function probeOnPage(
	page: Pick<Page, "evaluate">,
): Promise<boolean> {
	return isLive(await pageFetch(page, PROBE_PATH));
}

/**
 * The runtime's first probe: may navigate, because nobody is on the page yet. An API that answers
 * but is unavailable (429, 5xx) is not a signed-out owner: the run goes on to collection, which
 * reports it as an interruption to retry, rather than asking the owner to sign in.
 */
export async function probeSession(
	page: Pick<Page, "evaluate" | "goto">,
): Promise<boolean> {
	const r = await readOnOrigin(page, PROBE_PATH);
	return (
		isLive(r) ||
		(r.kind === "response" && (r.status === 429 || r.status >= 500))
	);
}

/** How long to let a stale session come back on the freshly loaded app before asking the owner to sign in. */
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
 * Signed out, or holding a session the app must renew: open the app, which sends a signed-out
 * owner on to Garmin's sign-in host. The page is read a few times without navigating, in case
 * loading the app renewed the session, and only then is the owner asked to sign in.
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
		// The establish watchdog fails a run after 120 s without a checkpoint.
		await checkpoint("sign-in-page");
		await page.goto(LOGIN_URL, {
			waitUntil: "domcontentloaded",
			timeout: 60_000,
		});
		await checkpoint("sign-in-settle");
		for (let attempt = 1; attempt <= settle.attempts; attempt += 1) {
			if (await probeOnPage(page)) return;
			// Between reads, never after the last: the owner is waiting to be asked.
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
				"Sign in to Garmin Connect in the secure browser. PDPP continues on its own once you are signed in.",
			probe: async () => isLive(await readOnOrigin(page, PROBE_PATH)),
			readinessProbe: probeOnPage,
			// The fifth of five streamed options; without all five the owner gets a Continue button.
			readinessProbeOnHandoffPage: true,
			// Without it the watchdog ends the sign-in after about six minutes.
			timeoutSeconds: 30 * 60,
		});
		if (!ready) throw new Error("garmin_browser_session_dead");
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
type Failure = {
	ok: false;
	reason: Reason;
	message: string;
	/** A 429: how long to wait before reading again. */
	retryAfterMs?: number;
	/** A 403: a fresh load of the app, which renews the page's token, may cure it. */
	refresh?: true;
};
/** `json` is null for a 204, Garmin's answer for no data. */
type Outcome = { ok: true; json: unknown } | Failure;

const signIn = (message: string): Failure => ({
	ok: false,
	reason: "sign_in_required",
	message,
});

/** Delta seconds, or an IMF-fixdate HTTP date. */
function retryAfterMs(header: string | null, now: number): number {
	const value = header?.trim() ?? "";
	// Date.parse alone would read "1.5" as a day in 2001.
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

export function classify(r: PageFetch, now = Date.now()): Outcome {
	if (r.kind === "wrong_origin") {
		return r.origin === SIGN_IN_ORIGIN
			? signIn("Garmin asked for sign-in.")
			: {
					ok: false,
					reason: "collection_interrupted",
					message: "Not read (wrong_origin).",
				};
	}
	if (r.kind === "no_token") {
		return signIn("The Garmin Connect page held no session token.");
	}
	if (r.kind === "network_error") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: "Not read (network_error).",
		};
	}
	if (r.status === 401) return signIn("Garmin asked for sign-in (HTTP 401).");
	if (r.status === 403) {
		return {
			...signIn("Garmin refused the session (HTTP 403)."),
			refresh: true,
		};
	}
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
	if (r.status === 204) return { ok: true, json: null };
	if (r.status === 200 && /json/i.test(r.contentType)) {
		try {
			return { ok: true, json: JSON.parse(r.body) as unknown };
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

/** What one run remembers across its reads. */
interface Run {
	/** The one reload of the app a 403 may cost per run has been spent. */
	refreshed: boolean;
}

/**
 * One read, classified. A 403 reloads the app once per run and repeats the read: the page's token
 * may have gone stale. A 429 waits Retry-After at most twice, while it is within maxRetryAfterMs.
 */
async function fetchJson(
	page: Pick<Page, "evaluate" | "goto">,
	path: string,
	p: Pacing,
	run: Run,
	read: typeof readOnOrigin = pageFetch,
): Promise<Outcome> {
	for (let waits = 0; ; ) {
		const outcome = classify(await read(page, path));
		if (outcome.ok) return outcome;
		if (outcome.refresh && !run.refreshed) {
			run.refreshed = true;
			await page
				.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
				.catch((): undefined => undefined);
			continue;
		}
		if (
			outcome.retryAfterMs === undefined ||
			waits >= RATE_LIMIT_RETRIES ||
			outcome.retryAfterMs > p.maxRetryAfterMs
		) {
			return outcome;
		}
		waits += 1;
		await p.sleep(outcome.retryAfterMs);
	}
}

// ── Days and cursors ───────────────────────────────────────────────────────
/**
 * Owner-local days, YYYY-MM-DD: `next_day` is the first not yet read, `floor` where the contiguous
 * read began. `retry` holds the days, as spans with both ends included, whose records did not all
 * read cleanly: later runs read them again until they do, as long as the list holds them
 * (MAX_RETRY_DAYS); with none, the key is absent. `retry_next` is the kept day the next run starts
 * reading again from, round to the oldest: present only when a run stopped before reading every
 * kept day again.
 */
export interface DayCursor {
	next_day?: string;
	floor?: string;
	backfill?: { since: string; next_day: string };
	retry?: Window[];
	retry_next?: string;
}
/**
 * The most days `retry` holds, and so the bound on reading kept days again until they read: past
 * it, the oldest are let go, and PROGRESS counts them.
 */
export const MAX_RETRY_DAYS = 366;
/** Days a run reads: on from the cursor, back before its floor, or again from `retry`. */
type Segment =
	| { kind: "forward" | "backfill"; from: string; to: string; since: string }
	| { kind: "retry"; from: string; to: string };
/** A grant in days: `since` inclusive, `until` exclusive. */
export interface DayRange {
	since?: string | undefined;
	until?: string | undefined;
}
type Range = { since?: string; until?: string };

export const addDays = (day: string, n: number): string =>
	new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
		.toISOString()
		.slice(0, 10);

/** The owner's calendar day at `now` in their time zone; an unknown zone falls back to UTC, which the overlap covers. */
export function localDay(now: Date, timeZone: string | undefined): string {
	const options = {
		timeZone: timeZone ?? "UTC",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	} as const;
	try {
		return new Intl.DateTimeFormat("en-CA", options).format(now);
	} catch {
		return now.toISOString().slice(0, 10);
	}
}

/** How many days a span covers, both ends included. */
const spanDays = ({ from, to }: Window): number =>
	(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS +
	1;

/** `spans` without the days of `cut`. */
function subtract(spans: readonly Window[], cut: Window): Window[] {
	return spans.flatMap((span) => {
		if (span.to < cut.from || span.from > cut.to) return [span];
		const left = span.from < cut.from;
		const right = span.to > cut.to;
		return [
			...(left ? [{ from: span.from, to: addDays(cut.from, -1) }] : []),
			...(right ? [{ from: addDays(cut.to, 1), to: span.to }] : []),
		];
	});
}

/**
 * The retry list in its one form: sorted, spans that overlap or touch merged, and at most
 * MAX_RETRY_DAYS days, the oldest let go first. `dropped` counts the days let go.
 */
export function normaliseRetry(spans: readonly Window[]): {
	retry: Window[];
	dropped: number;
} {
	const retry: Window[] = [];
	const sorted = spans.toSorted((a, b) =>
		a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
	);
	for (const { from, to } of sorted) {
		const last = retry.at(-1);
		if (last && from <= addDays(last.to, 1)) {
			if (to > last.to) last.to = to;
		} else {
			retry.push({ from, to });
		}
	}
	const total = retry.reduce((days, span) => days + spanDays(span), 0);
	const dropped = Math.max(0, total - MAX_RETRY_DAYS);
	for (let excess = dropped; excess > 0; ) {
		const oldest = retry[0] as Window;
		const days = spanDays(oldest);
		if (days <= excess) {
			retry.shift();
			excess -= days;
		} else {
			oldest.from = addDays(oldest.from, excess);
			excess = 0;
		}
	}
	return { retry, dropped };
}

/** `spans` from the first day at or after `day` on, then round from the oldest to the day before it. */
function rotate(spans: readonly Window[], day: string | undefined): Window[] {
	if (day === undefined) return [...spans];
	const before = addDays(day, -1);
	return [
		...spans.flatMap(({ from, to }) =>
			to >= day ? [{ from: from > day ? from : day, to }] : [],
		),
		...spans.flatMap(({ from, to }) =>
			from <= before ? [{ from, to: to < before ? to : before }] : [],
		),
	];
}

/** A saved retry span, kept only when both its days parse and it runs forward. */
function readSpan(value: unknown): Window[] {
	if (typeof value !== "object" || value === null) return [];
	const { from, to } = value as Record<string, unknown>;
	return isDay(from) && isDay(to) && from <= to ? [{ from, to }] : [];
}

/**
 * A saved cursor, kept only where its days parse and agree: anything else starts afresh, but a bad
 * retry span is dropped alone, and `retry_next` is kept only beside a retry list.
 */
export function readCursor(value: unknown): DayCursor {
	if (typeof value !== "object" || value === null) return {};
	const { next_day, floor, backfill, retry, retry_next } = value as Record<
		string,
		unknown
	>;
	if (!isDay(next_day) || !isDay(floor) || floor > next_day) return {};
	const cursor: DayCursor = { next_day, floor };
	if (typeof backfill === "object" && backfill !== null) {
		const { since, next_day: resume } = backfill as Record<string, unknown>;
		if (isDay(since) && isDay(resume) && since <= resume && resume <= floor) {
			cursor.backfill = { since, next_day: resume };
		}
	}
	const spans = Array.isArray(retry) ? retry.flatMap(readSpan) : [];
	const kept = normaliseRetry(spans).retry;
	if (kept.length > 0) {
		cursor.retry = kept;
		if (isDay(retry_next)) cursor.retry_next = retry_next;
	}
	return cursor;
}

const instant = (value: unknown): number | null => {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayPrefix = (value: string | undefined): string | undefined => {
	const day = value?.slice(0, 10);
	return isDay(day) ? day : undefined;
};

/**
 * The days a stream's grant lets it read. A stream consented by day reads the grant's days, as the
 * runtime filters them. One consented by instant files each record under an owner-local day that
 * can lie a day either side of its UTC start, so it reads a day past each edge of the grant's UTC
 * days and keeps only what starts inside the grant (inRange).
 */
export function grantDays(stream: Stream, range: Range | undefined): DayRange {
	if (TIME_RANGE_FIELD[stream] === "date") {
		return { since: dayPrefix(range?.since), until: dayPrefix(range?.until) };
	}
	const since = instant(range?.since);
	const until = instant(range?.until);
	return {
		since: since === null ? undefined : addDays(utcDay(since), -1),
		// The UTC day of the grant's last instant, plus one, as an exclusive end.
		until: until === null ? undefined : addDays(utcDay(until - 1), 2),
	};
}

/** Whether a record's start lies in its stream's grant, to the instant: the runtime's own filter compares days. */
export function inRange(startAt: unknown, range: Range | undefined): boolean {
	const start = instant(startAt);
	if (start === null) return false;
	const since = instant(range?.since);
	const until = instant(range?.until);
	return (
		(since === null || start >= since) && (until === null || start < until)
	);
}

/** Pure: the days this run reads, the `overlap` days before the cursor among them, and the cursor it starts from. */
export function planDays(
	prev: DayCursor,
	today: string,
	grant: DayRange,
	fullRefresh: boolean,
	overlap: number,
): { cursor: DayCursor; segments: Segment[] } {
	const { since, until } = grant;
	const last = until && addDays(until, -1) < today ? addDays(until, -1) : today;
	// Restart on full_refresh, on a first run, and when the grant starts past the cursor.
	const fresh =
		fullRefresh ||
		!prev.next_day ||
		!prev.floor ||
		(since !== undefined && since > prev.next_day);
	const start = since ?? addDays(today, 1 - INITIAL_DAYS);
	const cursor: DayCursor = fresh
		? { next_day: start, floor: start }
		: structuredClone(prev);
	// A restart forgets where reading stood, never which days still read badly, nor where reading
	// them again stopped.
	if (fresh && prev.retry) {
		cursor.retry = structuredClone(prev.retry);
		if (prev.retry_next) cursor.retry_next = prev.retry_next;
	}
	const floor = cursor.floor as string;
	const segments: Segment[] = [];
	let from = fresh ? floor : addDays(cursor.next_day as string, -overlap);
	if (from < floor) from = floor;
	// Never read outside the grant.
	if (since && since > from) from = since;
	if (from <= last)
		segments.push({ kind: "forward", from, to: last, since: floor });
	if (!fresh && since && since < floor) {
		// History before the floor: its own cursor, so the forward read keeps its place.
		const resume =
			prev.backfill?.since === since ? prev.backfill.next_day : since;
		const to = addDays(floor, -1) < last ? addDays(floor, -1) : last;
		if (resume <= to) {
			segments.push({ kind: "backfill", from: resume, to, since });
		}
	}
	// Last, the days to read again: inside the grant, not read above, and from where the last run
	// stopped reading them, round to the oldest, so that none waits behind days that never read. A
	// span outside the grant stays saved.
	let again = (cursor.retry ?? []).flatMap(({ from, to }) => {
		const first = since && since > from ? since : from;
		const end = to < last ? to : last;
		return first <= end ? [{ from: first, to: end }] : [];
	});
	for (const segment of segments) again = subtract(again, segment);
	for (const span of rotate(again, cursor.retry_next)) {
		segments.push({ kind: "retry", ...span });
	}
	return { cursor, segments };
}

/**
 * Records how a day or window read in full went: one with an unreadable record joins the retry
 * list, a clean one leaves it. The list stays raw while the run reads: `settle` puts it in its one
 * form, cap included, once at the end, so a day read again is never let go twice.
 */
function mark(cursor: DayCursor, span: Window, keep: boolean): void {
	const spans = cursor.retry ?? [];
	cursor.retry = keep ? [...spans, span] : subtract(spans, span);
}

/** Normalises and caps the retry list once a stream's reading is done. Answers how many days the cap let go. */
function settle(cursor: DayCursor): number {
	const { retry, dropped } = normaliseRetry(cursor.retry ?? []);
	if (retry.length > 0) {
		cursor.retry = retry;
	} else {
		delete cursor.retry;
		delete cursor.retry_next;
	}
	return dropped;
}

/** Moves the cursor past a day read in full; past a day read again, it moves only `retry_next`. */
function advance(cursor: DayCursor, segment: Segment, day: string): void {
	if (segment.kind === "retry") {
		cursor.retry_next = addDays(day, 1);
		return;
	}
	if (segment.kind === "forward") {
		// Only a contiguous read moves it.
		if (day === cursor.next_day) cursor.next_day = addDays(day, 1);
	} else if (day === addDays(cursor.floor as string, -1)) {
		cursor.floor = segment.since;
		delete cursor.backfill;
	} else {
		cursor.backfill = { since: segment.since, next_day: addDays(day, 1) };
	}
}

// ── Collect ────────────────────────────────────────────────────────────────
/** Structural, so the desktop runtime and test fakes both satisfy it. */
export type GarminCollectContext = Pick<
	BrowserCollectContext,
	"collectionMode" | "emit" | "emitRecord" | "requested" | "state"
> & { page: Pick<Page, "evaluate" | "goto"> };

/** Emits only a clean record: the runtime answers a failing one, or one with an unmodelled enum value, with a hint-less skip of the whole stream. */
async function emitClean(
	ctx: GarminCollectContext,
	stream: Stream,
	record: RecordData,
): Promise<boolean> {
	const check = validateRecord(stream, record);
	if (!check.ok || check.anomalies?.length) return false;
	await ctx.emitRecord(stream, record);
	return true;
}

/**
 * Emits what a day or row built, when it is clean and, for a stream consented by instant, starts
 * inside the grant. Answers whether it counts as unreadable: outside the grant is neither emitted
 * nor counted, and neither is a day Garmin holds nothing for.
 */
async function deliver(
	ctx: GarminCollectContext,
	stream: Stream,
	built: Built,
	range: Range | undefined,
): Promise<boolean> {
	if (built.kind === "empty") return false;
	const startAt =
		built.kind === "record" ? built.record.start_at : built.startAt;
	if (
		TIME_RANGE_FIELD[stream] === "start_at" &&
		startAt !== undefined &&
		!inRange(startAt, range)
	) {
		return false;
	}
	if (built.kind === "unreadable") return true;
	return !(await emitClean(ctx, stream, built.record));
}

/**
 * What a stream's reading came to. `progressed` counts days (or windows) read in full; `retried`,
 * those of them read again that still did not read cleanly.
 */
interface Walk {
	failure: Failure | null;
	deferred: boolean;
	progressed: number;
	retried: number;
	unreadable: number;
}
const walkFrom = (failure: Failure | null = null): Walk => ({
	failure,
	deferred: false,
	progressed: 0,
	retried: 0,
	unreadable: 0,
});

/**
 * Whether the run has no read left for the next day or window of `segment`. Days the cursor has
 * yet to pass defer the stream to the next run. Kept days never do, so drift that lasts is never a
 * skip (#245): they stay saved, and the next run reads them again from where this one stopped.
 */
function spent(
	walk: Walk,
	segment: Segment,
	max: number,
	maxRetry: number,
): boolean {
	const again = segment.kind === "retry";
	if (walk.progressed < max && !(again && walk.retried >= maxRetry)) {
		return false;
	}
	walk.deferred = !again;
	return true;
}

/** Counts a day or window read in full: one read again counts toward the retry cap only when it still does not read cleanly. */
function tally(walk: Walk, segment: Segment, keep: boolean): void {
	walk.progressed += 1;
	if (segment.kind === "retry" && keep) walk.retried += 1;
}

interface StreamRun {
	ctx: GarminCollectContext;
	p: Pacing;
	run: Run;
	range: Range | undefined;
	plan: ReturnType<typeof planDays>;
}

/** One request per day, each segment oldest first, at most maxDaysPerRun; kept days until maxRetryDaysPerRun of them still do not read. */
async function walkDays(s: StreamRun, stream: DayStream): Promise<Walk> {
	const { ctx, p, run, plan } = s;
	const walk = walkFrom();
	for (const segment of plan.segments) {
		for (let day = segment.from; day <= segment.to; day = addDays(day, 1)) {
			if (spent(walk, segment, p.maxDaysPerRun, p.maxRetryDaysPerRun)) {
				return walk;
			}
			// Before each request, never after a stream's last.
			await p.sleep(p.requestDelayMs);
			const outcome = await fetchJson(ctx.page, dayPath(stream, day), p, run);
			if (!outcome.ok) {
				walk.failure = outcome;
				return walk;
			}
			const built: Built =
				outcome.json === null
					? { kind: "empty" }
					: dayRecord(stream, day, outcome.json);
			const unreadable = await deliver(ctx, stream, built, s.range);
			if (unreadable) walk.unreadable += 1;
			tally(walk, segment, unreadable);
			// An unreadable day advances too: PROGRESS counts it, and the retry list keeps it.
			mark(plan.cursor, { from: day, to: day }, unreadable);
			advance(plan.cursor, segment, day);
		}
	}
	// Every kept day was read again: the next run starts from the oldest.
	delete plan.cursor.retry_next;
	return walk;
}

/** A span cut by day into its older and newer halves; of an odd number of days, the newer holds one more. */
function halves(span: Window): [Window, Window] {
	const end = addDays(span.from, Math.floor(spanDays(span) / 2) - 1);
	return [
		{ from: span.from, to: end },
		{ from: addDays(end, 1), to: span.to },
	];
}

const unreadableWindow = (message: string): Failure => ({
	ok: false,
	reason: "source_unreadable",
	message,
});

/**
 * One window's rows, delivered piece by piece as each answer arrives. Sleep and HRV answer a window
 * in one request. Activities come newest first, at most PAGE_SIZE to a request: an answer that full
 * may have left some out, so none of it is delivered, and its piece is read again as two halves by
 * day, the older first, each halved again until every piece answers fewer. Each answer delivered is
 * then the whole of its piece in one snapshot; an activity synced into a piece after its read is
 * read by the next run, which re-reads from four weeks before this run's day (RANGE_OVERLAP_DAYS).
 */
async function readWindow(
	s: StreamRun,
	stream: RangeStream,
	window: Window,
): Promise<{ failure: Failure | null; unreadable: number }> {
	const { ctx, p, run } = s;
	let unreadable = 0;
	/** The pieces still to read, the next one first. */
	const pieces: Window[] = [window];
	for (let requests = 0; pieces.length > 0; requests += 1) {
		if (requests === p.maxRequestsPerWindow) {
			return {
				failure: unreadableWindow(
					"Reading a window of activities took more requests than one window is allowed.",
				),
				unreadable,
			};
		}
		const piece = pieces.shift() as Window;
		await p.sleep(p.requestDelayMs);
		const outcome = await fetchJson(
			ctx.page,
			windowPath(stream, piece),
			p,
			run,
		);
		if (!outcome.ok) return { failure: outcome, unreadable };
		const rows = windowRows(stream, outcome.json);
		if (rows === null) {
			return {
				failure: unreadableWindow(
					"A window's answer was not in the shape expected.",
				),
				unreadable,
			};
		}
		if (stream === "activities" && rows.length >= PAGE_SIZE) {
			if (piece.from === piece.to) {
				return {
					failure: unreadableWindow(
						"One day held more activities than one request returns.",
					),
					unreadable,
				};
			}
			pieces.unshift(...halves(piece));
			continue;
		}
		for (const row of rows) {
			// Held to the piece asked for: a row dated outside it is unreadable.
			const built = rowRecord(stream, row, piece);
			if (await deliver(ctx, stream, built, s.range)) unreadable += 1;
		}
	}
	return { failure: null, unreadable };
}

/**
 * Windows of up to WINDOW_DAYS, each segment oldest first, at most maxWindowsPerRun; kept windows
 * until maxRetryWindowsPerRun of them still do not read cleanly. A window read in full, every piece
 * of it, moves the cursor over each of its days, and with any row unreadable joins the retry list
 * whole.
 */
async function walkWindows(s: StreamRun, stream: RangeStream): Promise<Walk> {
	const { p, plan } = s;
	const walk = walkFrom();
	for (const segment of plan.segments) {
		for (let from = segment.from; from <= segment.to; ) {
			if (spent(walk, segment, p.maxWindowsPerRun, p.maxRetryWindowsPerRun)) {
				return walk;
			}
			const end = addDays(from, WINDOW_DAYS - 1);
			const window = { from, to: end < segment.to ? end : segment.to };
			const read = await readWindow(s, stream, window);
			walk.unreadable += read.unreadable;
			if (read.failure) {
				walk.failure = read.failure;
				return walk;
			}
			const keep = read.unreadable > 0;
			tally(walk, segment, keep);
			mark(plan.cursor, window, keep);
			for (let day = window.from; day <= window.to; day = addDays(day, 1)) {
				advance(plan.cursor, segment, day);
			}
			from = addDays(window.to, 1);
		}
	}
	// Every kept window was read again: the next run starts from the oldest.
	delete plan.cursor.retry_next;
	return walk;
}

const isDayStream = (stream: Stream): stream is DayStream =>
	stream === "daily_summaries" || stream === "training_status";

/**
 * Reads each requested stream in turn, from one page that stays on the app. The settings read
 * comes first, the only read that may navigate, and gives the owner's today. Each stream ends with
 * its counts (records unreadable, days let go), any skip and its cursor; a lost sign-in skips every
 * stream after it.
 */
export async function collectGarminBrowser(
	ctx: GarminCollectContext,
	pacing: Partial<Pacing> = {},
	now = new Date(),
): Promise<void> {
	const p = { ...PACING, ...pacing };
	const streams = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) return;
	const run: Run = { refreshed: false };
	const settings = await fetchJson(ctx.page, PROBE_PATH, p, run, readOnOrigin);
	const today = localDay(
		now,
		settings.ok ? siteTimeZone(settings.json) : undefined,
	);
	// A failure every later stream shares.
	let stop: Failure | null = settings.ok ? null : settings;
	for (const stream of streams) {
		const range = ctx.requested.get(stream)?.time_range;
		const plan = planDays(
			readCursor(ctx.state[stream]),
			today,
			grantDays(stream, range),
			ctx.collectionMode === "full_refresh",
			OVERLAP[stream],
		);
		const s: StreamRun = { ctx, p, run, range, plan };
		const walk: Walk = stop
			? walkFrom(stop)
			: isDayStream(stream)
				? await walkDays(s, stream)
				: await walkWindows(s, stream);
		const dropped = settle(plan.cursor);
		// Counts, never an id, a date or a value.
		if (walk.unreadable > 0) {
			await ctx.emit({
				type: "PROGRESS",
				stream,
				count: walk.unreadable,
				message: `${walk.unreadable} record(s) unreadable.`,
			});
		}
		if (dropped > 0) {
			await ctx.emit({
				type: "PROGRESS",
				stream,
				count: dropped,
				message: `${dropped} day(s) of unreadable records could not be kept for another try.`,
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
		if (walk.progressed > 0 || !walk.failure) {
			await ctx.emit({ type: "STATE", stream, cursor: { ...plan.cursor } });
		}
		if (walk.failure?.reason === "sign_in_required") stop = walk.failure;
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "garmin_browser",
		validateRecord,
		// sleep and activities filter on their start instant; the daily streams on their day.
		timeRangeField: timeRangeFieldFor,
		// = connector_key (authoring.md, Naming): the runtime keys the host-browser variable by it.
		browser: { profileName: "garmin-browser" },
		probeSession: ({ page }) => probeSession(page),
		probeSessionIsAuthoritative: true,
		ensureSession,
		collect: (ctx: BrowserCollectContext) => collectGarminBrowser(ctx),
	});
}

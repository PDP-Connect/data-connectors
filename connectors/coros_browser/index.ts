#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * COROS Training Hub's browser-session profile. The owner signs in to t.coros.com by hand in the
 * runtime's browser; collection then reads the JSON the web app itself loads, from inside that
 * page, with the access token the app keeps in its own cookie. No credential reaches this code,
 * and the token never leaves the page. Every request is a read: nothing is ever written.
 *
 * Training Hub talks to one of four regional API hosts (teamapi, teameuapi, teamcnapi,
 * teamsgapi.coros.com); the page's region cookie picks it, as it does for the app.
 *
 * Reachability probe: permanently exempt. Every endpoint needs the owner's signed-in session.
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
	activityPage,
	activityRecord,
	dailyRecord,
	dayList,
	LOGIN_EXPIRED,
	plannedRecords,
	profileRecord,
	queryDay,
	REGIONS,
	readEnvelope,
	regionKey,
	schedule,
	TOKEN_INVALID,
} from "./parsers.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

export { STREAMS };
export const ORIGIN = "https://t.coros.com";
/** The web app. Signed out, it sends the page on to /login on the same origin. */
export const APP_URL = `${ORIGIN}/`;
export const LOGIN_URL = `${ORIGIN}/login`;
/** The cookies Training Hub keeps its access token and region id in (REGIONCONFIG, production). */
export const TOKEN_COOKIE = "CPL-coros-token";
export const REGION_COOKIE = "CPL-coros-region";
/** The owner's account: cheap, authenticated, and the run's first read. */
export const PROBE_PATH = "/account/query";
export const DASHBOARD_PATH = "/dashboard/query";
/** The activity list's largest page size in the web app. */
export const PAGE_SIZE = 50;
/** Before COROS sold its first watch: the floor of a first activities read without a grant start. */
export const HISTORY_FLOOR = "2016-01-01";
/** A first run without a grant start reads daily metrics this many days back. */
export const INITIAL_METRIC_DAYS = 180;
/** Planned workouts: a first run reads this far back and, every run, this far ahead of today. */
export const PLAN_PAST_DAYS = 28;
export const PLAN_AHEAD_DAYS = 28;
/** Days per request, per stream. Activities are also paged inside a window. */
export const WINDOW_DAYS: Record<DayStream, number> = {
	activities: 180,
	daily_metrics: 28,
	planned_workouts: 28,
};
/**
 * Days before its cursor a stream reads again every run: watches sync late, COROS scores days
 * after the fact, and a plan's future days are always re-read because they change.
 */
export const OVERLAP_DAYS: Record<DayStream, number> = {
	activities: 14,
	daily_metrics: 7,
	planned_workouts: PLAN_AHEAD_DAYS + 7,
};
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_FALLBACK_MS = 30_000;
const DAY_MS = 86_400_000;

export type DayStream = Exclude<Stream, "profile">;

/** Each stream's consent and range field, as the manifest declares it. */
export const TIME_RANGE_FIELD: Record<DayStream, "date" | "start_at"> = {
	activities: "start_at",
	daily_metrics: "date",
	planned_workouts: "date",
};

export interface Pacing {
	/** Requests one run may make across every stream; past it, the run stops and the next resumes. */
	maxRequestsPerRun: number;
	maxRetryAfterMs: number;
	requestDelayMs: number;
	/** How long to wait after reloading the app for it to renew an expired token. */
	refreshSettleMs: number;
	sleep: (ms: number) => Promise<void>;
}
export const PACING: Pacing = {
	maxRequestsPerRun: 400,
	maxRetryAfterMs: 60_000,
	requestDelayMs: 1000,
	refreshSettleMs: 3000,
	sleep: politeDelay,
};

// ── In-page fetch: self-contained, origin-checked, bounded, never throws ──
export type PageFetch =
	| { kind: "wrong_origin"; origin: string }
	| { kind: "no_token" }
	| { kind: "no_region" }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			contentType: string;
			retryAfter: string | null;
			body: string;
			region: number;
	  };

/**
 * Reads an API path on the account's regional host, with the token from the app's cookie, read
 * and sent here and never returned. The region comes from the app's region cookie, else from the
 * app's own initial state, as Training Hub's getRegionConfig picks it.
 */
export async function pageFetch(
	page: Pick<Page, "evaluate">,
	path: string,
): Promise<PageFetch> {
	try {
		const result = await page.evaluate(
			async ({ origin, path, tokenCookie, regionCookie, hosts }) => {
				if (location.origin !== origin) {
					return { kind: "wrong_origin", origin: location.origin };
				}
				const cookie = (name: string): string | null => {
					const prefix = `${name}=`;
					const part = document.cookie
						.split(";")
						.map((p) => p.trim())
						.find((p) => p.startsWith(prefix));
					if (!part) return null;
					try {
						return decodeURIComponent(part.slice(prefix.length));
					} catch {
						return null;
					}
				};
				const token = cookie(tokenCookie);
				if (!token) return { kind: "no_token" };
				let region = Number(cookie(regionCookie));
				if (!hosts[String(region)]) {
					try {
						const state = (window as unknown as { __INITIAL_STATE__?: unknown })
							.__INITIAL_STATE__;
						const parsed =
							typeof state === "string" ? JSON.parse(state) : state;
						region = Number(
							(parsed as { regionId?: unknown } | null)?.regionId,
						);
					} catch {
						region = Number.NaN;
					}
				}
				const host = hosts[String(region)];
				if (!host) return { kind: "no_region" };
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 30_000);
				try {
					const res = await fetch(`${host}${path}`, {
						credentials: "include",
						headers: {
							accept: "application/json",
							accessToken: token,
							YFHeader: JSON.stringify({ language: "en-US" }),
						},
						signal: controller.signal,
					});
					return {
						kind: "response",
						status: res.status,
						contentType: res.headers.get("content-type") ?? "",
						retryAfter: res.headers.get("retry-after"),
						body: await res.text(),
						region,
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
			{
				origin: ORIGIN,
				path,
				tokenCookie: TOKEN_COOKIE,
				regionCookie: REGION_COOKIE,
				hosts: Object.fromEntries(
					Object.entries(REGIONS).map(([id, { api }]) => [id, api]),
				) as Record<string, string>,
			},
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

/** A run's first read: off the app (about:blank, another origin), go to it once and read again. Never page.url(): PageShim's facade lacks it. */
async function readOnOrigin(
	page: Pick<Page, "evaluate" | "goto">,
	path: string,
): Promise<PageFetch> {
	const first = await pageFetch(page, path);
	if (first.kind !== "wrong_origin") return first;
	await page
		.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	return pageFetch(page, path);
}

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
	/** COROS's "login expired": a fresh load of the app, which renews the token, may cure it. */
	refresh?: true;
};
export type Outcome = { ok: true; data: unknown; region: number } | Failure;

const signIn = (message: string): Failure => ({
	ok: false,
	reason: "sign_in_required",
	message,
});

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
	if (r.kind === "wrong_origin" || r.kind === "network_error") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `Not read (${r.kind}).`,
		};
	}
	if (r.kind === "no_token") {
		return signIn("The Training Hub page held no session token.");
	}
	if (r.kind === "no_region") {
		return {
			ok: false,
			reason: "source_unreadable",
			message: "The Training Hub page named no region this connector knows.",
		};
	}
	if (r.status === 401 || r.status === 403) {
		return signIn(`COROS asked for sign-in (HTTP ${r.status}).`);
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
	let json: unknown;
	try {
		json = r.status === 200 ? (JSON.parse(r.body) as unknown) : undefined;
	} catch {
		json = undefined;
	}
	const envelope = readEnvelope(json);
	if (envelope.kind === "ok") {
		return { ok: true, data: envelope.data, region: r.region };
	}
	if (envelope.kind === "error") {
		if (envelope.result === LOGIN_EXPIRED) {
			return { ...signIn("COROS said the sign-in expired."), refresh: true };
		}
		if (envelope.result === TOKEN_INVALID) {
			return signIn("COROS refused the session token.");
		}
		// A code, never a message: COROS's messages are localised and may echo input.
		return {
			ok: false,
			reason: "source_unreadable",
			message: `COROS answered result code ${envelope.result.slice(0, 40)}.`,
		};
	}
	return {
		ok: false,
		reason: "source_unreadable",
		message: `HTTP ${r.status} (${r.contentType || "no type"}), not the COROS JSON expected.`,
	};
}

const isLive = (r: PageFetch): boolean => classify(r).ok;

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

/** How long to let the freshly loaded app renew an expired token before asking the owner to sign in. */
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
 * Signed out, or holding a token the app must renew: open the app, which renews a token it can
 * and sends a signed-out owner on to /login. The page is read a few times without navigating,
 * and only then is the owner asked to sign in, on COROS's own page.
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
		await page.goto(APP_URL, {
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
				"Sign in to COROS Training Hub in the secure browser. The import continues on its own once you are signed in.",
			probe: async () => isLive(await readOnOrigin(page, PROBE_PATH)),
			readinessProbe: probeOnPage,
			// The fifth of five streamed options; without all five the owner gets a Continue button.
			readinessProbeOnHandoffPage: true,
			// Without it the watchdog ends the sign-in after about six minutes.
			timeoutSeconds: 30 * 60,
		});
		if (!ready) throw new Error("coros_browser_session_dead");
	};
}

export const ensureSession = makeEnsureSession();

// ── Reads ──────────────────────────────────────────────────────────────────
/** What one run remembers across its reads. */
interface Run {
	/** The one reload of the app a "login expired" may cost per run has been spent. */
	refreshed: boolean;
	requests: number;
}

const LIMIT: Failure = {
	ok: false,
	reason: "source_limit_reached",
	message: "This run made as many requests as one run allows.",
};

/**
 * One read, classified and paced. "Login expired" reloads the app once per run, so the app renews
 * its token, and repeats the read. A 429 waits Retry-After at most twice, while it is within
 * maxRetryAfterMs.
 */
async function fetchData(
	page: Pick<Page, "evaluate" | "goto">,
	path: string,
	p: Pacing,
	run: Run,
	read: typeof readOnOrigin = pageFetch,
): Promise<Outcome> {
	for (let waits = 0; ; ) {
		if (run.requests >= p.maxRequestsPerRun) return LIMIT;
		// Before each request, never after the last.
		if (run.requests > 0) await p.sleep(p.requestDelayMs);
		run.requests += 1;
		const outcome = classify(await read(page, path));
		if (outcome.ok) return outcome;
		if (outcome.refresh && !run.refreshed) {
			run.refreshed = true;
			await page
				.goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
				.catch((): undefined => undefined);
			await p.sleep(p.refreshSettleMs);
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
const CURSOR_VERSION = 1;
/**
 * One cursor per day stream: every record whose day lies in [floor, next_day) has been
 * delivered under the stream's grant. Days are YYYY-MM-DD; `v` is the cursor's shape.
 */
export interface DayCursor {
	v: typeof CURSOR_VERSION;
	floor: string;
	next_day: string;
}
type Range = { since?: string; until?: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string =>
	typeof value === "string" &&
	DAY_RE.test(value) &&
	new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export const addDays = (day: string, n: number): string =>
	new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
		.toISOString()
		.slice(0, 10);

const utcDay = (value: string | undefined): string | undefined => {
	if (value === undefined) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms)
		? new Date(ms).toISOString().slice(0, 10)
		: undefined;
};

/** A saved cursor, kept only when its shape and days parse and agree: anything else starts afresh. */
export function readCursor(value: unknown): DayCursor | null {
	if (typeof value !== "object" || value === null) return null;
	const { v, floor, next_day } = value as Record<string, unknown>;
	if (v !== CURSOR_VERSION || !isDay(floor) || !isDay(next_day)) return null;
	if (floor > next_day) return null;
	return { v: CURSOR_VERSION, floor, next_day };
}

/** The days one stream reads this run, both ends included, and the floor its cursor will carry. */
export interface DayPlan {
	from: string;
	to: string;
	floor: string;
	/** The cursor's next_day before this run, when this run builds on it. */
	kept?: string;
}

/**
 * Pure: one stream's plan. A grant's instants become days with a day of slack each side, for the
 * owner's time zone; the runtime still holds every record to the grant itself. Without a cursor,
 * on full_refresh, or when the grant's start lies outside what the cursor covers, the stream reads
 * from its start. Otherwise it reads again from OVERLAP_DAYS before its cursor.
 */
export function planDays(
	stream: DayStream,
	previous: DayCursor | null,
	range: Range | undefined,
	fullRefresh: boolean,
	today: string,
): DayPlan {
	const since = utcDay(range?.since);
	const until = utcDay(range?.until);
	const horizon =
		stream === "planned_workouts"
			? addDays(today, PLAN_AHEAD_DAYS)
			: // Today in UTC+14.
				addDays(today, 1);
	// A date stream's grant end is an exclusive day, so its last day is the one before; an
	// activity's end is an instant, and the owner's local day can run a day past its UTC day.
	const last =
		until === undefined
			? undefined
			: stream === "activities"
				? addDays(until, 1)
				: addDays(until, -1);
	const to = last !== undefined && last < horizon ? last : horizon;
	const initial =
		stream === "activities"
			? HISTORY_FLOOR
			: stream === "daily_metrics"
				? addDays(today, -INITIAL_METRIC_DAYS)
				: addDays(today, -PLAN_PAST_DAYS);
	// Without a grant start the stream starts at its initial day, or at an older floor a cursor
	// already reached; a cursor whose floor was raised by an earlier grant start does not narrow it.
	const start =
		since !== undefined
			? addDays(since, -1)
			: previous && previous.floor <= initial
				? previous.floor
				: initial;
	if (
		previous &&
		!fullRefresh &&
		start >= previous.floor &&
		start <= previous.next_day
	) {
		const resume = addDays(previous.next_day, -OVERLAP_DAYS[stream]);
		return {
			from: resume > start ? resume : start,
			to,
			floor: start,
			kept: previous.next_day,
		};
	}
	return { from: start, to, floor: start };
}

/** Consecutive windows of at most `size` days covering [from, to], oldest first. */
export function windowsOf(
	from: string,
	to: string,
	size: number,
): Array<{ from: string; to: string }> {
	const windows: Array<{ from: string; to: string }> = [];
	for (let at = from; at <= to; at = addDays(at, size)) {
		const end = addDays(at, size - 1);
		windows.push({ from: at, to: end < to ? end : to });
	}
	return windows;
}

export const activitiesPath = (
	window: { from: string; to: string },
	pageNumber: number,
): string =>
	`/activity/query?size=${PAGE_SIZE}&pageNumber=${pageNumber}&startDay=${queryDay(window.from)}&endDay=${queryDay(window.to)}`;
export const dayDetailPath = (window: { from: string; to: string }): string =>
	`/analyse/dayDetail/query?startDay=${queryDay(window.from)}&endDay=${queryDay(window.to)}`;
export const schedulePath = (window: { from: string; to: string }): string =>
	`/training/schedule/query?startDate=${queryDay(window.from)}&endDate=${queryDay(window.to)}`;

// ── Collect ────────────────────────────────────────────────────────────────
/** Structural, so the desktop runtime and test fakes both satisfy it. */
export type CorosCollectContext = Pick<
	BrowserCollectContext,
	"collectionMode" | "emit" | "emitRecord" | "requested" | "state"
> & { page: Pick<Page, "evaluate" | "goto"> };

const SHAPELESS = (what: string): Failure => ({
	ok: false,
	reason: "source_unreadable",
	message: `${what} was not in the shape expected.`,
});

/** Built records of one window, or why the window could not be read. */
type WindowRead = { ok: true; built: Array<RecordData | null> } | Failure;

/** Every record of one window: activities page by page, the others in one request. */
async function readWindow(
	ctx: CorosCollectContext,
	stream: DayStream,
	window: { from: string; to: string },
	p: Pacing,
	run: Run,
): Promise<WindowRead> {
	if (stream === "daily_metrics") {
		const outcome = await fetchData(ctx.page, dayDetailPath(window), p, run);
		if (!outcome.ok) return outcome;
		const rows = dayList(outcome.data);
		if (rows === null) return SHAPELESS("A day-detail answer");
		// COROS may answer a few days either side; each day is the window's that holds it.
		const built = rows
			.map(dailyRecord)
			.filter(
				(record) =>
					record === null ||
					(String(record.date) >= window.from &&
						String(record.date) <= window.to),
			);
		return { ok: true, built };
	}
	if (stream === "planned_workouts") {
		const outcome = await fetchData(ctx.page, schedulePath(window), p, run);
		if (!outcome.ok) return outcome;
		const value = schedule(outcome.data);
		if (value === null) return SHAPELESS("A training-schedule answer");
		const built = plannedRecords(value)
			.map((r) => (r.ok ? r.record : null))
			.filter(
				(record) =>
					record === null ||
					(String(record.date) >= window.from &&
						String(record.date) <= window.to),
			);
		return { ok: true, built };
	}
	const built: Array<RecordData | null> = [];
	for (let pageNumber = 1; ; pageNumber += 1) {
		const outcome = await fetchData(
			ctx.page,
			activitiesPath(window, pageNumber),
			p,
			run,
		);
		if (!outcome.ok) return outcome;
		const listed = activityPage(outcome.data);
		if (listed === null) return SHAPELESS("An activity-list answer");
		built.push(...listed.rows.map(activityRecord));
		// An empty page always ends the window. When COROS says how many pages there are, that
		// count decides, so a server that caps the page below PAGE_SIZE still reads every page;
		// only when it does not say does a short page end the window.
		if (listed.rows.length === 0) return { ok: true, built };
		if (listed.totalPage !== null) {
			if (pageNumber >= listed.totalPage) return { ok: true, built };
		} else if (listed.rows.length < PAGE_SIZE) {
			return { ok: true, built };
		}
	}
}

/** Emits only a clean record: one that fails its schema is counted unreadable instead. */
async function emitClean(
	ctx: CorosCollectContext,
	stream: Stream,
	record: RecordData,
): Promise<boolean> {
	const check = validateRecord(stream, record);
	if (!check.ok || check.anomalies?.length) return false;
	await ctx.emitRecord(stream, record);
	return true;
}

async function finishStream(
	ctx: CorosCollectContext,
	stream: Stream,
	unreadable: number,
	failure: Failure | null,
): Promise<void> {
	if (unreadable > 0) {
		// A count, never an id or a value.
		await ctx.emit({
			type: "PROGRESS",
			stream,
			count: unreadable,
			message: `${unreadable} record(s) unreadable.`,
		});
	}
	if (failure) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: SKIP_REASON[failure.reason],
			recovery_hint: hintFor(failure.reason),
			message: failure.message,
		});
	}
}

/** One day stream: its windows oldest first, then its cursor over what it read contiguously. */
async function collectDays(
	ctx: CorosCollectContext,
	stream: DayStream,
	p: Pacing,
	run: Run,
	today: string,
): Promise<Failure | null> {
	const range = ctx.requested.get(stream)?.time_range;
	const plan = planDays(
		stream,
		readCursor(ctx.state[stream]),
		range,
		ctx.collectionMode === "full_refresh",
		today,
	);
	// Activities read a day past the grant's end for the owner's time zone. Those that start at or
	// after it are left out here rather than handed to the runtime to withhold, which would keep
	// every cursor of the run from saving; the cursor stops at the first such day instead.
	const untilMs =
		stream === "activities" && range?.until !== undefined
			? Date.parse(range.until)
			: Number.NaN;
	let beyond: string | null = null;
	let unreadable = 0;
	let failure: Failure | null = null;
	let readTo: string | null = null;
	const seen = new Set<string>();
	for (const window of windowsOf(plan.from, plan.to, WINDOW_DAYS[stream])) {
		const read = await readWindow(ctx, stream, window, p, run);
		if (!read.ok) {
			failure = read;
			break;
		}
		const records = read.built.filter((r): r is RecordData => r !== null);
		// Rows, and not one of them readable: COROS changed their shape.
		if (records.length === 0 && read.built.length > 0) {
			failure = SHAPELESS(`Every ${stream} row of a window`);
			break;
		}
		unreadable += read.built.length - records.length;
		for (const record of records) {
			if (Number.isFinite(untilMs)) {
				const startMs = Date.parse(String(record.start_at));
				if (Number.isFinite(startMs) && startMs >= untilMs) {
					const day =
						typeof record.start_date === "string"
							? record.start_date
							: String(record.start_at).slice(0, 10);
					if (beyond === null || day < beyond) beyond = day;
					continue;
				}
			}
			const id = String(record.id);
			if (seen.has(id)) continue;
			seen.add(id);
			if (!(await emitClean(ctx, stream, record))) unreadable += 1;
		}
		readTo = window.to;
	}
	await finishStream(ctx, stream, unreadable, failure);
	// The cursor moves only over days read through; a run that read none keeps the old one.
	const readThrough = readTo === null ? undefined : addDays(readTo, 1);
	const reached =
		readThrough !== undefined && beyond !== null && beyond < readThrough
			? beyond
			: readThrough;
	const next =
		plan.kept !== undefined && (reached === undefined || plan.kept > reached)
			? plan.kept
			: reached;
	if (next !== undefined) {
		const cursor: DayCursor = {
			v: CURSOR_VERSION,
			floor: plan.floor,
			next_day: next,
		};
		await ctx.emit({ type: "STATE", stream, cursor });
	}
	return failure;
}

/**
 * Reads the account first (the only read that may navigate), then each requested stream in turn.
 * A stream that fails reports why and leaves the others to run, except a lost session, which
 * stops every stream after it.
 */
export async function collectCorosBrowser(
	ctx: CorosCollectContext,
	pacing: Partial<Pacing> = {},
	now = new Date(),
): Promise<void> {
	const p = { ...PACING, ...pacing };
	const streams = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) return;
	const run: Run = { refreshed: false, requests: 0 };
	// COROS's days are the owner's; UTC's today, with a day's slack in planDays, covers every zone.
	const today = now.toISOString().slice(0, 10);

	const account = await fetchData(ctx.page, PROBE_PATH, p, run, readOnOrigin);
	let stop: Failure | null = account.ok ? null : account;
	for (const stream of streams) {
		if (stop) {
			await finishStream(ctx, stream, 0, stop);
			continue;
		}
		let failure: Failure | null;
		if (stream === "profile") {
			failure = await collectProfile(ctx, account, p, run);
		} else {
			failure = await collectDays(ctx, stream, p, run, today);
		}
		if (
			failure &&
			(failure.reason === "sign_in_required" ||
				failure.reason === "source_limit_reached")
		) {
			stop = failure;
		}
	}
}

async function collectProfile(
	ctx: CorosCollectContext,
	account: Outcome,
	p: Pacing,
	run: Run,
): Promise<Failure | null> {
	if (!account.ok) return account;
	const region = regionKey(account.region);
	if (region === null) return SHAPELESS("The account's region");
	const dashboard = await fetchData(ctx.page, DASHBOARD_PATH, p, run);
	// A dashboard COROS answered in a shape or with a code this connector does not read only
	// leaves the heart-rate fields null, since the account itself was read. Anything that may pass
	// (an outage, a rate limit) or that stops the run skips the stream, so a retry can fill them
	// rather than a record with them emptied.
	if (!dashboard.ok && dashboard.reason !== "source_unreadable") {
		await finishStream(ctx, "profile", 0, dashboard);
		return dashboard;
	}
	let failure: Failure | null = null;
	let unreadable = 0;
	const record = profileRecord(
		account.data,
		dashboard.ok ? dashboard.data : null,
		region,
	);
	if (record === null) failure = SHAPELESS("The account answer");
	else if (!(await emitClean(ctx, "profile", record))) unreadable = 1;
	if (!dashboard.ok && failure === null) {
		await ctx.emit({
			type: "PROGRESS",
			stream: "profile",
			message:
				"The dashboard could not be read; heart-rate fields are left empty.",
		});
	}
	await finishStream(ctx, "profile", unreadable, failure);
	return failure;
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "coros_browser",
		validateRecord,
		// = connector_key (authoring.md, Naming): the runtime keys the host-browser variable by it.
		browser: { profileName: "coros-browser" },
		probeSession: ({ page }) => probeSession(page),
		probeSessionIsAuthoritative: true,
		ensureSession,
		collect: (ctx: BrowserCollectContext) => collectCorosBrowser(ctx),
	});
}

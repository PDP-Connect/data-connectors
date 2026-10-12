#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * WHOOP's browser-session profile. The owner signs in to app.whoop.com by hand in the runtime's
 * browser; collection then reads the cycles the web app itself loads, from inside that page, with
 * the page's own token. No credential reaches this code, and the token never leaves the page.
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
	bootstrapFacts,
	type Cycle,
	cycleElements,
	readElement,
	recordsFor,
	type Start,
} from "./parsers.ts";
import { STREAMS, type Stream, validateRecord } from "./schemas.ts";

export { STREAMS };
export const ORIGIN = "https://app.whoop.com";
export const API_BASE = "https://api.prod.whoop.com";
const APP_URL = `${ORIGIN}/`;
/** Signed out, the app sends the owner to id.whoop.com and back; with a live refresh cookie it does so without a prompt. */
export const LOGIN_URL = APP_URL;
/** The account summary, as the web app requests it. */
export const PROBE_PATH =
	"/users-service/v2/bootstrap/?accountType=users&apiVersion=7";
/** Before WHOOP's first members: the start of a first read when the account gives none. */
export const HISTORY_FALLBACK = "2015-01-01T00:00:00.000Z";
/** The web app reads cycles a month at a time. */
export const WINDOW_DAYS = 30;
/** Each request reaches a day past both edges, so a cycle near one, if shorter than the pad, is returned whatever WHOOP's edge rule; it is kept only by the window its start falls in. */
const PAD_DAYS = 1;
/** Re-read the last week each run: WHOOP scores sleep and recovery after the fact. */
export const OVERLAP_DAYS = 7;
/**
 * A cycle runs from one sleep to the next, so the one under way where a run starts delivering
 * usually began within a day of it: the walk starts this long before, and its first window holds
 * that cycle. One that began earlier (a strap left off) is found by stepping back.
 */
const CYCLE_REACH_DAYS = 2;
const SIGN_IN_ORIGIN = "https://id.whoop.com";
/** No settle read starts after this long, so with one stalled 30 s read it ends inside the 120 s establish watchdog. */
const SETTLE_BUDGET_MS = 60_000;
const DAY_MS = 86_400_000;
const RATE_LIMIT_RETRIES = 2;
/** Without a readable Retry-After (the API is on another origin and exposes none), wait this long. */
const RATE_LIMIT_FALLBACK_MS = 60_000;

export interface Pacing {
	maxRetryAfterMs: number;
	maxWindowsPerRun: number;
	requestDelayMs: number;
	sleep: (ms: number) => Promise<void>;
}
export const PACING: Pacing = {
	maxRetryAfterMs: 60_000,
	// About twelve years of thirty-day windows: more than any WHOOP account holds.
	maxWindowsPerRun: 150,
	requestDelayMs: 1000,
	sleep: politeDelay,
};

// ── In-page fetch: self-contained, origin-checked, bounded, never throws ──
export type PageFetch =
	| { kind: "wrong_origin"; origin: string }
	| { kind: "network_error"; message: string }
	| {
			kind: "response";
			status: number;
			url: string;
			contentType: string;
			retryAfter: string | null;
			body: string;
	  };

/** Reads an API path with the page's token. Signed out (no token in the page) answers a 401-shaped response. */
export async function pageFetch(
	page: Pick<Page, "evaluate">,
	path: string,
): Promise<PageFetch> {
	try {
		const result = await page.evaluate(
			async ({ origin, apiBase, path }) => {
				if (location.origin !== origin) {
					return { kind: "wrong_origin", origin: location.origin };
				}
				// The web app's own token, read and used here and never returned. Its
				// cookie first: WHOOP deletes it when the token expires, while the
				// localStorage copy older sign-ins wrote can outlive it.
				let token: string | null = null;
				try {
					const prefix = "whoop-auth-token=";
					const cookie = document.cookie
						.split(";")
						.map((part) => part.trim())
						.find((part) => part.startsWith(prefix));
					if (cookie) {
						token = decodeURIComponent(cookie.slice(prefix.length));
					} else {
						const stored = localStorage.getItem("whoop.security.accessToken");
						token = stored?.startsWith('"')
							? (JSON.parse(stored) as string)
							: stored;
					}
				} catch {
					token = null;
				}
				if (!token) {
					return {
						kind: "response",
						status: 401,
						url: "",
						contentType: "",
						retryAfter: null,
						body: "",
					};
				}
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 30_000);
				try {
					const res = await fetch(`${apiBase}${path}`, {
						credentials: "include",
						headers: {
							accept: "application/json",
							authorization: `bearer ${token}`,
						},
						signal: controller.signal,
					});
					return {
						kind: "response",
						status: res.status,
						url: res.url,
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
			{ origin: ORIGIN, apiBase: API_BASE, path },
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

/** A run's first read: off the app (about:blank, a sign-in page), go to it once and read again. Never page.url(): PageShim's facade lacks it. */
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

/** How long to let WHOOP renew an expired token on its own before asking the owner to sign in. */
export interface Settle {
	attempts: number;
	intervalMs: number;
	sleep: (ms: number) => Promise<void>;
	now?: () => number;
}
export const SIGN_IN_SETTLE: Settle = {
	attempts: 10,
	intervalMs: 1500,
	sleep: politeDelay,
};

/**
 * Signed out, or holding only WHOOP's refresh cookie: open the app, which sends the owner through
 * id.whoop.com and back. With a live refresh cookie that bounce renews the session without a
 * prompt, so the owner is asked only once it has had a few seconds to do so.
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
		// Bounded in time as well as in reads: a read can stall for 30 s, and the establish
		// watchdog allows 120 s from the checkpoint above.
		const clock = settle.now ?? Date.now;
		const deadline = clock() + SETTLE_BUDGET_MS;
		for (let attempt = 1; attempt <= settle.attempts; attempt += 1) {
			if (await probeOnPage(page)) return;
			// Between reads, never after the last: the owner is waiting to be asked.
			if (attempt === settle.attempts || clock() >= deadline) break;
			await settle.sleep(settle.intervalMs);
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
				"Sign in to WHOOP in the secure browser. PDPP continues on its own once you are signed in.",
			probe: async () => isLive(await readOnOrigin(page, PROBE_PATH)),
			readinessProbe: probeOnPage,
			// The fifth of five streamed options; without all five the owner gets a Continue button.
			readinessProbeOnHandoffPage: true,
			// Without it the watchdog ends the sign-in after about six minutes.
			timeoutSeconds: 30 * 60,
		});
		if (!ready) throw new Error("whoop_browser_session_dead");
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
	retryAfterMs?: number;
};
type Outcome = { ok: true; json: unknown } | Failure;

/** The API is on another origin, so only 401 and 403, or a page that has gone to WHOOP's sign-in host, mean signed out. */
export function classify(r: PageFetch, now = Date.now()): Outcome {
	if (r.kind === "wrong_origin" && r.origin === SIGN_IN_ORIGIN) {
		return {
			ok: false,
			reason: "sign_in_required",
			message: "WHOOP asked for sign-in.",
		};
	}
	if (r.kind !== "response") {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `Not read (${r.kind}).`,
		};
	}
	if (r.status === 401 || r.status === 403) {
		return {
			ok: false,
			reason: "sign_in_required",
			message: "WHOOP asked for sign-in.",
		};
	}
	if (r.status === 429) {
		// Cross-origin, Retry-After reads null unless WHOOP exposes it.
		const header = r.retryAfter?.trim() ?? "";
		// Delta seconds, or an HTTP date; Date.parse alone would read "1.5" as a day in 2001.
		const seconds = /^\d+$/.test(header)
			? Number(header)
			: /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
						header,
					)
				? (Date.parse(header) - now) / 1000
				: Number.NaN;
		const retryAfterMs = Number.isFinite(seconds)
			? Math.max(0, seconds * 1000)
			: RATE_LIMIT_FALLBACK_MS;
		return {
			ok: false,
			reason: "collection_interrupted",
			message: "Rate limited (HTTP 429).",
			retryAfterMs,
		};
	}
	if (r.status >= 500) {
		return {
			ok: false,
			reason: "collection_interrupted",
			message: `HTTP ${r.status}.`,
		};
	}
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

async function fetchJson(
	page: Pick<Page, "evaluate" | "goto">,
	path: string,
	p: Pacing,
	read: typeof readOnOrigin = pageFetch,
): Promise<Outcome> {
	for (let attempt = 0; ; attempt += 1) {
		const outcome = classify(await read(page, path));
		if (outcome.ok || outcome.retryAfterMs === undefined) return outcome;
		if (
			attempt >= RATE_LIMIT_RETRIES ||
			outcome.retryAfterMs > p.maxRetryAfterMs
		) {
			return outcome;
		}
		await p.sleep(outcome.retryAfterMs);
	}
}

// ── Windows and cursors ────────────────────────────────────────────────────
/** The cursor's shape: one of any other shape, or of none, is read afresh. */
const CURSOR_VERSION = 2;
/**
 * One cursor per stream, all four written from one walk: every record of the stream that starts in
 * [floor, through) has been delivered under the stream's grant. `under_way`, when present, is what
 * the walk that wrote it found where the stream next delivers from, and spares the next run a
 * step back. RFC 3339 instants; `v` is the cursor's shape.
 */
export interface WindowCursor {
	v: typeof CURSOR_VERSION;
	floor: string;
	through: string;
	under_way?: UnderWay;
}
/** The cycle under way at `at` began at `began`, or none had begun (null). */
export interface UnderWay {
	at: string;
	began: string | null;
}
type Range = { since?: string; until?: string };

const instant = (value: unknown): number | null => {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};

export function readCursor(value: unknown): WindowCursor | null {
	if (typeof value !== "object" || value === null) return null;
	const { v, floor, through, under_way } = value as Record<string, unknown>;
	const floorMs = instant(floor);
	const throughMs = instant(through);
	if (
		v !== CURSOR_VERSION ||
		floorMs === null ||
		throughMs === null ||
		throughMs < floorMs
	) {
		return null;
	}
	const hint = readUnderWay(under_way);
	return {
		v: CURSOR_VERSION,
		floor: new Date(floorMs).toISOString(),
		through: new Date(throughMs).toISOString(),
		...(hint ? { under_way: hint } : {}),
	};
}

/** A hint that does not parse is no hint: the run steps back instead. */
function readUnderWay(value: unknown): UnderWay | null {
	if (typeof value !== "object" || value === null) return null;
	const { at, began } = value as Record<string, unknown>;
	const atMs = instant(at);
	const beganMs = instant(began);
	if (
		atMs === null ||
		(began !== null && (beganMs === null || beganMs > atMs))
	) {
		return null;
	}
	return {
		at: new Date(atMs).toISOString(),
		began: beganMs === null ? null : new Date(beganMs).toISOString(),
	};
}

/** When the cycle under way at `at` began, as a hint gives it: null when none had begun, undefined when the hint does not say. */
function beganBy(
	hint: UnderWay | undefined,
	at: number,
): number | null | undefined {
	if (!hint) return undefined;
	const began = instant(hint.began);
	if (at > Date.parse(hint.at) || (began !== null && began > at)) {
		return undefined;
	}
	return began;
}

/** Whether a record's start lies in its stream's grant, to the instant, as the runtime also checks: outside it, a record is neither emitted nor counted. */
function inRange(startAt: unknown, range: Range | undefined): boolean {
	const start = instant(startAt);
	if (start === null) return false;
	const since = instant(range?.since);
	const until = instant(range?.until);
	return (
		(since === null || start >= since) && (until === null || start < until)
	);
}

/** One stream's part in a run: where its delivery starts, the cursor it carries, and its grant's end. */
export interface StreamPlan {
	from: number;
	cursor: WindowCursor;
	until: number | null;
}

/** Where a run resumed from a cursor delivers again from: the week before its end, which WHOOP may still be scoring, and not before its floor. */
const resumeAt = (floor: number, through: number): number =>
	Math.max(through - OVERLAP_DAYS * DAY_MS, floor);

/**
 * Pure: one stream's plan. Its grant starts at its own start, or the account's (a day early, for
 * the time zone). It delivers afresh from there when it has no cursor, on full_refresh, or when
 * that start lies outside what its cursor delivered (a grant widened back, or moved past).
 * Otherwise it delivers again from the week before its cursor, which WHOOP may still be scoring,
 * and the cursor keeps only what the grant still covers.
 */
export function planStream(
	previous: WindowCursor | null,
	historyStart: string,
	range: Range | undefined,
	fullRefresh: boolean,
): StreamPlan {
	const since = instant(range?.since);
	const until = instant(range?.until);
	const history = instant(historyStart) ?? Date.parse(HISTORY_FALLBACK);
	const start = since === null ? history : Math.max(since, history);
	const floor = previous ? Date.parse(previous.floor) : Number.NaN;
	const through = previous ? Date.parse(previous.through) : Number.NaN;
	if (!previous || fullRefresh || start < floor || start > through) {
		const at = new Date(start).toISOString();
		return {
			from: start,
			cursor: { v: CURSOR_VERSION, floor: at, through: at },
			until,
		};
	}
	// A grant whose end moved back holds less than the cursor delivered.
	const held = Math.max(start, Math.min(through, until ?? through));
	return {
		from: resumeAt(start, held),
		cursor: {
			v: CURSOR_VERSION,
			floor: new Date(start).toISOString(),
			through: new Date(held).toISOString(),
			...(previous.under_way ? { under_way: previous.under_way } : {}),
		},
		until,
	};
}

/** A stretch of the walk: the cycles from `start` to `end`, delivered from `delivery` on to its streams. */
export interface Stretch {
	delivery: number;
	start: number;
	end: number;
	plans: StreamPlan[];
}

/**
 * Pure: what one run walks. Each stream reads from two days before where it delivers, for the
 * cycle under way there, to its grant's end or `now`. Reads that overlap are one stretch, read
 * once, oldest first, and the gap between two stretches is not read: a grant that ended long ago
 * re-reads only its last week, which WHOOP may still have been scoring when last read.
 */
export function stretchesOf(
	plans: readonly StreamPlan[],
	history: number,
	now: number,
): Stretch[] {
	const spans = plans
		.map((plan) => ({
			plan,
			start: Math.max(plan.from - CYCLE_REACH_DAYS * DAY_MS, history),
			end: Math.min(now, plan.until ?? Number.POSITIVE_INFINITY),
		}))
		.filter(({ start, end }) => start < end)
		.sort((a, b) => a.start - b.start);
	const stretches: Stretch[] = [];
	for (const { plan, start, end } of spans) {
		const last = stretches.at(-1);
		if (last && start <= last.end) {
			last.delivery = Math.min(last.delivery, plan.from);
			last.end = Math.max(last.end, end);
			last.plans.push(plan);
		} else {
			stretches.push({ delivery: plan.from, start, end, plans: [plan] });
		}
	}
	return stretches;
}

const iso = (ms: number): string =>
	encodeURIComponent(new Date(ms).toISOString());

export const cyclesPath = (
	userId: string,
	start: number,
	end: number,
	limit: number,
): string =>
	`/core-details-bff/v0/cycles/details?apiVersion=7&id=${encodeURIComponent(userId)}&startTime=${iso(start)}&endTime=${iso(end)}&limit=${limit}`;

/** An element that did not parse, keyed so one returned by two padded windows is counted once. */
/** An element that did not parse: its cycle's start, where that does, and what it cost each stream. */
type Lost = { key: string; at: Start; lost: Record<Stream, Start[]> };
/** `unreadable`: the answer held cycles, and not one whose id and start parse. */
type Window =
	| {
			ok: true;
			end: number;
			cycles: Cycle[];
			lost: Lost[];
			unreadable: boolean;
	  }
	| Failure;
/** Every cycle in a window unreadable, and something granted among them: WHOOP changed their shape. */
const SHAPELESS: Failure = {
	ok: false,
	reason: "source_unreadable",
	message: "WHOOP's cycles were not in the shape expected.",
};

/**
 * The cycles that start in [start, end), each once, oldest first. The request reaches a day past
 * both edges and asks for twice the cycles the span can hold; an answer that fills that limit
 * with cycles from the span may be cut short, so the span halves and the read repeats. An answer
 * of cycles from outside the span (WHOOP's reply to a window it holds nothing for) is not. It
 * relies on WHOOP returning a cycle to any request whose range holds the cycle's start, as it does
 * if it answers by start or by overlap; no live account has confirmed which.
 */
async function readWindow(
	page: Pick<Page, "evaluate" | "goto">,
	userId: string,
	start: number,
	end: number,
	p: Pacing,
): Promise<Window> {
	for (let stop = end; ; stop = start + Math.ceil((stop - start) / 2)) {
		const days = Math.ceil((stop - start) / DAY_MS) + 2 * PAD_DAYS;
		const limit = Math.min(200, 2 * days);
		const outcome = await fetchJson(
			page,
			cyclesPath(
				userId,
				start - PAD_DAYS * DAY_MS,
				stop + PAD_DAYS * DAY_MS,
				limit,
			),
			p,
		);
		if (!outcome.ok) return outcome;
		const elements = cycleElements(outcome.json);
		if (elements === null) {
			return {
				ok: false,
				reason: "source_unreadable",
				message: "A window's answer was not the list of cycles expected.",
			};
		}
		const lost: Lost[] = [];
		const kept = new Map<string, Cycle>();
		for (const element of elements) {
			const read = readElement(element);
			if (read.kind === "unreadable") {
				lost.push({
					key: JSON.stringify(element) ?? "",
					at: read.at,
					lost: read.lost,
				});
				continue;
			}
			const { cycle } = read;
			if (cycle.startMs < start || cycle.startMs >= stop) continue;
			const seen = kept.get(cycle.id);
			if (!seen || cycle.updatedMs >= seen.updatedMs) kept.set(cycle.id, cycle);
		}
		if (elements.length < limit || kept.size === 0) {
			const cycles = [...kept.values()].sort((a, b) => a.startMs - b.startMs);
			const unreadable = elements.length > 0 && lost.length === elements.length;
			return { ok: true, end: stop, cycles, lost, unreadable };
		}
		if (stop - start <= DAY_MS) {
			return {
				ok: false,
				reason: "source_unreadable",
				message:
					"WHOOP answered a one-day window with as many cycles as were asked for.",
			};
		}
		await p.sleep(p.requestDelayMs);
	}
}

// ── Collect ────────────────────────────────────────────────────────────────
/** Structural, so the desktop runtime and test fakes both satisfy it. */
export type WhoopCollectContext = Pick<
	BrowserCollectContext,
	"collectionMode" | "emit" | "emitRecord" | "requested" | "state"
> & { page: Pick<Page, "evaluate" | "goto"> };

/** Emits only a clean record: the runtime answers a failing one, or one with an unmodelled enum value, with a hint-less skip of the whole stream. */
async function emitClean(
	ctx: WhoopCollectContext,
	stream: Stream,
	record: RecordData,
): Promise<boolean> {
	const check = validateRecord(stream, record);
	if (!check.ok || check.anomalies?.length) return false;
	await ctx.emitRecord(stream, record);
	return true;
}

/**
 * One walk of the cycles, oldest first, feeds all four streams, in stretches (stretchesOf). Each
 * stretch starts two days before the earliest instant its streams deliver from and reads the
 * cycle under way there wherever it began; each window's cycles yield the requested streams'
 * records, each held to its own stream's grant, and each stream's cursor moves only over what its
 * grant let it deliver. Every stream ends with its unreadable count, any skip and its cursor.
 */
export async function collectWhoopBrowser(
	ctx: WhoopCollectContext,
	pacing: Partial<Pacing> = {},
	now = new Date(),
): Promise<void> {
	const p = { ...PACING, ...pacing };
	const streams = STREAMS.filter((stream) => ctx.requested.has(stream));
	if (streams.length === 0) return;
	const ranges = new Map(
		streams.map((stream) => [stream, ctx.requested.get(stream)?.time_range]),
	);

	// The user id the cycles call takes and the account's start; the only read that may navigate.
	const bootstrap = await fetchJson(ctx.page, PROBE_PATH, p, readOnOrigin);
	const facts = bootstrap.ok ? bootstrapFacts(bootstrap.json) : null;
	let failure: Failure | null = bootstrap.ok
		? facts
			? null
			: {
					ok: false,
					reason: "source_unreadable",
					message: "The account summary did not have the shape expected.",
				}
		: bootstrap;

	const unreadable: Record<Stream, number> = {
		cycles: 0,
		recoveries: 0,
		sleeps: 0,
		workouts: 0,
	};
	const plans = new Map<Stream, StreamPlan>();
	let windows = 0;
	let deferred = false;
	if (facts) {
		const created = instant(facts.createdAt);
		const history =
			created === null
				? HISTORY_FALLBACK
				: new Date(created - DAY_MS).toISOString();
		for (const stream of streams) {
			plans.set(
				stream,
				planStream(
					readCursor(ctx.state[stream]),
					history,
					ranges.get(stream),
					ctx.collectionMode === "full_refresh",
				),
			);
		}
		const historyMs = Date.parse(history);
		const lostSeen = new Set<string>();
		/** No element went unread: one that did may be the cycle a hint would name. */
		let clean = true;
		/** One paced window read. */
		const read = async (from: number, to: number): Promise<Window> => {
			// Before each request, never after the last.
			await p.sleep(p.requestDelayMs);
			return readWindow(ctx.page, facts.userId, from, to, p);
		};
		/**
		 * Whether passing a window of nothing but unreadable cycles passes nothing granted: each is
		 * placed in time, and every record it holds lies outside its stream's grant.
		 */
		const passable = (window: Window & { ok: true }): boolean =>
			window.lost.every(
				({ at, lost }) =>
					at !== undefined &&
					streams.every((stream) =>
						lost[stream].every(
							(startAt) =>
								startAt !== undefined && !inRange(startAt, ranges.get(stream)),
						),
					),
			);
		/** A window read and kept, counted toward the run's windows, with what it could not read. */
		const tally = (window: Window & { ok: true }): void => {
			windows += 1;
			if (window.lost.length > 0) clean = false;
			for (const { key, lost } of window.lost) {
				if (lostSeen.has(key)) continue;
				lostSeen.add(key);
				for (const stream of streams) {
					const range = ranges.get(stream);
					// As for a record that does not build: outside its stream's grant, not counted.
					unreadable[stream] += lost[stream].filter(
						(startAt) => startAt === undefined || inRange(startAt, range),
					).length;
				}
			}
		};
		/**
		 * The latest cycle that starts before `before`, and the instant from which every cycle start
		 * up to `before` is known. With the strap off, a cycle stays under way for as long as it is
		 * off, so the walk steps back a window at a time, at most to the account's start. Past the
		 * first window back, which a cycle synced late may have joined, an earlier walk's finding
		 * (`began`) speaks for the rest: none had begun, or the next window read is the one where it
		 * began. That trusts WHOOP not to add a cycle older than the first window back. A window
		 * whose cycles are all unreadable ends it when passable: with cycles that do not overlap,
		 * the latest of them is the one under way, and nothing granted is lost; otherwise the run
		 * stops there, as the walk does. Not held to maxWindowsPerRun, since the account's start
		 * bounds it and a run cut short in it would begin it again next time.
		 */
		const latestBefore = async (
			before: number,
			began: number | null | undefined,
		): Promise<{ ok: true; cycle: Cycle | null; known: number } | Failure> => {
			let hint = began;
			for (let to = before; to > historyMs; ) {
				const back = Math.max(to - WINDOW_DAYS * DAY_MS, historyMs);
				let latest: Cycle | null = null;
				let lostLast = false;
				for (let from = back; from < to; ) {
					const window = await read(from, to);
					if (!window.ok) return window;
					if (window.unreadable && !passable(window)) return SHAPELESS;
					tally(window);
					if (window.unreadable) lostLast = true;
					else if (window.cycles.length > 0) {
						latest = window.cycles.at(-1) ?? latest;
						lostLast = false;
					}
					from = window.end;
				}
				if (lostLast) return { ok: true, cycle: null, known: before };
				if (latest) return { ok: true, cycle: latest, known: latest.startMs };
				if (hint === null) break;
				to =
					hint === undefined
						? back
						: Math.min(hint + WINDOW_DAYS * DAY_MS, back);
				hint = undefined;
			}
			return { ok: true, cycle: null, known: Number.NEGATIVE_INFINITY };
		};
		/**
		 * One stretch, oldest first: null once it reaches its end, else why it stopped. Its streams'
		 * cursors move only over the windows it reads.
		 */
		const walk = async ({
			delivery,
			start,
			end,
			plans: own,
		}: Stretch): Promise<Failure | "deferred" | null> => {
			// What an earlier walk found about the cycle under way where this one starts delivering.
			const began = own
				.map((plan) => beganBy(plan.cursor.under_way, delivery))
				.find((ms) => ms !== undefined);
			// Delivery needs the cycle under way where it starts. Once the walk reads a cycle starting
			// by then, every earlier one ended before it; before the account's start, none began.
			let covered = start <= historyMs;
			// Every cycle that starts in [known, from) has been read, its start in `starts`.
			let known = covered ? Number.NEGATIVE_INFINITY : start;
			const starts: number[] = [];
			let from = start;
			let stop: Failure | "deferred" | null = null;
			while (from < end) {
				if (windows >= p.maxWindowsPerRun) {
					stop = "deferred";
					break;
				}
				const window = await read(
					from,
					Math.min(from + WINDOW_DAYS * DAY_MS, end),
				);
				if (!window.ok) {
					stop = window;
					break;
				}
				// Not one cycle whose id and start parse, and something granted among them: the walk
				// stops here rather than move the cursor past history it could not read.
				if (window.unreadable && !passable(window)) {
					stop = SHAPELESS;
					break;
				}
				tally(window);
				const cycles = window.cycles;
				covered ||= cycles.some((cycle) => cycle.startMs <= delivery);
				if (!covered && window.end > delivery) {
					const before = await latestBefore(start, began);
					if (!before.ok) {
						stop = before;
						break;
					}
					if (before.cycle) cycles.unshift(before.cycle);
					known = before.known;
					covered = true;
				}
				for (const cycle of cycles) {
					starts.push(cycle.startMs);
					for (const stream of streams) {
						const range = ranges.get(stream);
						for (const built of recordsFor(stream, cycle)) {
							const startAt =
								built.kind === "record"
									? built.record.start_at
									: (built.startAt ?? cycle.startAt);
							// Outside the stream's grant: neither emitted nor counted.
							if (!inRange(startAt, range)) continue;
							const clean =
								built.kind === "record" &&
								(await emitClean(ctx, stream, built.record));
							if (!clean) unreadable[stream] += 1;
						}
					}
				}
				from = window.end;
				for (const plan of own) {
					const reach = Math.min(
						window.end,
						plan.until ?? Number.POSITIVE_INFINITY,
					);
					if (reach > Date.parse(plan.cursor.through)) {
						plan.cursor.through = new Date(reach).toISOString();
					}
				}
			}
			// For each stream, the cycle under way where it next delivers from, when this stretch
			// read every cycle that starts between that cycle's start and there.
			for (const plan of clean ? own : []) {
				const at = resumeAt(
					Date.parse(plan.cursor.floor),
					Date.parse(plan.cursor.through),
				);
				if (at >= from) continue;
				const latest = starts.findLast((ms) => ms >= known && ms <= at);
				if (latest === undefined && known !== Number.NEGATIVE_INFINITY)
					continue;
				plan.cursor.under_way = {
					at: new Date(at).toISOString(),
					began: latest === undefined ? null : new Date(latest).toISOString(),
				};
			}
			return stop;
		};
		for (const stretch of stretchesOf(
			[...plans.values()],
			historyMs,
			now.getTime(),
		)) {
			const stop = await walk(stretch);
			if (stop === "deferred") deferred = true;
			else if (stop) failure = stop;
			if (stop) break;
		}
	}

	for (const stream of streams) {
		const count = unreadable[stream];
		if (count > 0) {
			// A count, never an id or a value.
			await ctx.emit({
				type: "PROGRESS",
				stream,
				count,
				message: `${count} record(s) unreadable.`,
			});
		}
		const reason: Reason | null = failure
			? failure.reason
			: deferred
				? "source_limit_reached"
				: null;
		if (reason) {
			await ctx.emit({
				type: "SKIP_RESULT",
				stream,
				reason: SKIP_REASON[reason],
				recovery_hint: hintFor(reason),
				message:
					failure?.message ??
					`Read ${windows} windows; the next run continues from the saved point.`,
			});
		}
		const plan = plans.get(stream);
		if (plan && (windows > 0 || !failure)) {
			await ctx.emit({ type: "STATE", stream, cursor: { ...plan.cursor } });
		}
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "whoop_browser",
		validateRecord,
		// = connector_key (authoring.md, Naming): the runtime keys the host-browser variable by it.
		browser: { profileName: "whoop-browser" },
		probeSession: ({ page }) => probeSession(page),
		probeSessionIsAuthoritative: true,
		ensureSession,
		collect: (ctx: BrowserCollectContext) => collectWhoopBrowser(ctx),
	});
}

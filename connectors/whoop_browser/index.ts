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
/** Each request reaches a day past both edges, so a cycle near one is returned whatever WHOOP's edge rule; it is kept only by the window its start falls in. */
const PAD_DAYS = 1;
/** Re-read the last week each run: WHOOP scores sleep and recovery after the fact. */
export const OVERLAP_DAYS = 7;
/** A cycle still open after this long was abandoned (a strap left off), not one to keep re-reading. */
const OPEN_CYCLE_REACH_DAYS = 30;
/**
 * A cycle runs from one sleep to the next, so one that began before a grant's start can hold
 * sleeps and workouts inside it. With the strap off it stays open for days, so the walk reaches
 * back as far as a resumed run re-reads an open cycle.
 */
const CYCLE_REACH_DAYS = OPEN_CYCLE_REACH_DAYS;
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
/**
 * One cursor per stream, all four written from one walk. `floor` is where the contiguous read
 * began and `through` the end of the last completed window; `open_since`, when present, is the
 * start of the earliest cycle the walk found still under way, which the next run re-reads even
 * when it lies more than a week back. All RFC 3339 instants.
 */
export interface WindowCursor {
	floor: string;
	through: string;
	open_since?: string;
}
type Range = { since?: string; until?: string };

const instant = (value: unknown): number | null => {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
};

export function readCursor(value: unknown): WindowCursor | null {
	if (typeof value !== "object" || value === null) return null;
	const { floor, through, open_since } = value as Record<string, unknown>;
	const floorMs = instant(floor);
	const throughMs = instant(through);
	if (floorMs === null || throughMs === null || throughMs < floorMs) {
		return null;
	}
	const openMs = instant(open_since);
	return {
		floor: new Date(floorMs).toISOString(),
		through: new Date(throughMs).toISOString(),
		...(openMs === null ? {} : { open_since: new Date(openMs).toISOString() }),
	};
}

/** Whether a record's start lies in its stream's grant, to the instant: the runtime's own filter compares days. */
function inRange(startAt: unknown, range: Range | undefined): boolean {
	const start = instant(startAt);
	if (start === null) return false;
	const since = instant(range?.since);
	const until = instant(range?.until);
	return (
		(since === null || start >= since) && (until === null || start < until)
	);
}

/** One stream's part in a run: where its reading starts, the cursor it carries, and its grant's end. */
export interface StreamPlan {
	from: number;
	cursor: WindowCursor;
	until: number | null;
}

/**
 * Pure: one stream's plan. It reads afresh from its own grant's start, reached back far enough
 * for a cycle that began before it, or else the account's (a day early, for the time zone), when
 * it has no cursor, on full_refresh, or when that start lies outside what its cursor covers (a
 * grant widened back, or moved past). Otherwise it re-reads the week before its cursor, or back
 * to a cycle the last run found still open, if that is earlier and within a month.
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
	const target =
		since === null
			? history
			: Math.max(since - CYCLE_REACH_DAYS * DAY_MS, history);
	const floor = previous ? Date.parse(previous.floor) : Number.NaN;
	const through = previous ? Date.parse(previous.through) : Number.NaN;
	if (!previous || fullRefresh || target < floor || target > through) {
		const start = new Date(target).toISOString();
		return { from: target, cursor: { floor: start, through: start }, until };
	}
	const open = instant(previous.open_since) ?? Number.POSITIVE_INFINITY;
	const replay = Math.min(
		through - OVERLAP_DAYS * DAY_MS,
		Math.max(open, through - OPEN_CYCLE_REACH_DAYS * DAY_MS),
	);
	return {
		from: Math.max(replay, floor, target),
		cursor: { ...previous },
		until,
	};
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
type Lost = { key: string; lost: Record<Stream, number> };
type Window =
	| { ok: true; end: number; cycles: Cycle[]; lost: Lost[] }
	| Failure;

/**
 * The cycles that start in [start, end), each once, oldest first. The request reaches a day past
 * both edges and asks for twice the cycles the span can hold; an answer that fills that limit
 * with cycles from the span may be cut short, so the span halves and the read repeats. An answer
 * of cycles from outside the span (WHOOP's reply to a window it holds nothing for) is not.
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
				lost.push({ key: JSON.stringify(element) ?? "", lost: read.lost });
				continue;
			}
			const { cycle } = read;
			if (cycle.startMs < start || cycle.startMs >= stop) continue;
			const seen = kept.get(cycle.id);
			if (!seen || cycle.updatedMs >= seen.updatedMs) kept.set(cycle.id, cycle);
		}
		// Not one cycle whose id and start parse: WHOOP changed their shape, so the walk stops here
		// rather than move the cursor past history it could not read.
		if (elements.length > 0 && lost.length === elements.length) {
			return {
				ok: false,
				reason: "source_unreadable",
				message: "WHOOP's cycles were not in the shape expected.",
			};
		}
		if (elements.length < limit || kept.size === 0) {
			const cycles = [...kept.values()].sort((a, b) => a.startMs - b.startMs);
			return { ok: true, end: stop, cycles, lost };
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
 * One walk of the cycles, oldest first, feeds all four streams. It starts where the least
 * advanced stream needs it to and ends at the widest grant's end; each window's cycles yield the
 * requested streams' records, each held to its own stream's grant, and each stream's cursor moves
 * only over what its grant let it read. Every stream ends with its unreadable count, any skip and
 * its cursor.
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
		const all = [...plans.values()];
		const start = Math.min(...all.map((plan) => plan.from));
		const end = Math.min(
			now.getTime(),
			Math.max(...all.map((plan) => plan.until ?? Number.POSITIVE_INFINITY)),
		);
		const lostSeen = new Set<string>();
		let openSince = Number.POSITIVE_INFINITY;
		let from = start;
		while (from < end) {
			if (windows === p.maxWindowsPerRun) {
				deferred = true;
				break;
			}
			// Before each request, never after the last.
			await p.sleep(p.requestDelayMs);
			const window = await readWindow(
				ctx.page,
				facts.userId,
				from,
				Math.min(from + WINDOW_DAYS * DAY_MS, end),
				p,
			);
			if (!window.ok) {
				failure = window;
				break;
			}
			for (const { key, lost } of window.lost) {
				if (lostSeen.has(key)) continue;
				lostSeen.add(key);
				for (const stream of streams) unreadable[stream] += lost[stream];
			}
			for (const cycle of window.cycles) {
				if (cycle.open) openSince = Math.min(openSince, cycle.startMs);
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
			windows += 1;
			from = window.end;
			for (const plan of all) {
				const reach = Math.min(
					window.end,
					plan.until ?? Number.POSITIVE_INFINITY,
				);
				if (reach > Date.parse(plan.cursor.through)) {
					plan.cursor.through = new Date(reach).toISOString();
				}
			}
		}
		// A cycle still open: the earliest this run saw, or one an earlier run saw that this run's
		// windows did not reach, while it is less than a month behind the cursor.
		for (const plan of all) {
			const earlier = instant(plan.cursor.open_since);
			const unreached =
				earlier !== null && (earlier < start || earlier >= from)
					? earlier
					: Number.POSITIVE_INFINITY;
			const stale =
				Date.parse(plan.cursor.through) - OPEN_CYCLE_REACH_DAYS * DAY_MS;
			const open = Math.min(
				...[openSince, unreached].filter((ms) => ms >= stale),
			);
			if (Number.isFinite(open)) {
				plan.cursor.open_since = new Date(open).toISOString();
			} else {
				delete plan.cursor.open_since;
			}
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
		// Every stream's consent field: an RFC 3339 instant, the start of the cycle, sleep or workout.
		timeRangeField: "start_at",
		// = connector_key (authoring.md, Naming): the runtime keys the host-browser variable by it.
		browser: { profileName: "whoop-browser" },
		probeSession: ({ page }) => probeSession(page),
		probeSessionIsAuthoritative: true,
		ensureSession,
		collect: (ctx: BrowserCollectContext) => collectWhoopBrowser(ctx),
	});
}

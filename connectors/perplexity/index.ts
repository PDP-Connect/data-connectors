#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Perplexity connector (v0.1.2).
 *
 * Collects the owner's own Perplexity library through the signed-in
 * www.perplexity.ai page the host provides (past login and any human check):
 * every network call is the page's own same-origin `fetch` with
 * `credentials: "include"`, so cookies carry the session and no token ever
 * appears here. The two REST surfaces are the ones the web app itself uses:
 *
 *   - `POST /rest/thread/list_ask_threads` — the library list. Paged by
 *     `offset`, 20 per page; the page's LAST item carries `has_next_page`.
 *   - `GET /rest/thread/:slug` — one thread's entries (oldest first), paged
 *     by `offset` the same way.
 *
 * Streams: `conversations` (one record per thread, mutable_state, a full
 * inventory of the requested window on every run, so it keeps no STATE) and
 * `messages` (the question and the answer of every entry, mutable_state,
 * child of `conversations`; its STATE remembers each thread it delivered).
 * A thread's messages are re-read only when the list shows it changed, or
 * when the run selects messages outside the window they were delivered
 * under. Time ranges are pushed down: a run whose every stream has a
 * `since` stops walking the newest-first list once it is past it, and a
 * thread whose messages cannot fall inside the range is not read in depth.
 * A full refresh re-reads every thread it reads, but keeps what earlier runs
 * remembered about threads outside its time range (or past the walk's
 * stop), since it delivered nothing that could change them.
 * The list walk must prove it ended
 * (the last item's `has_next_page: false`, or an empty page read from a
 * session that is still signed in; a short page that claims more is
 * followed) and, when it took more than one page, two consecutive walks must
 * see the same threads, before `messages` is checkpointed. A list that
 * never holds still keeps its conversation records and fails both streams
 * retryably with no checkpoint; a thread whose entries cannot be proven
 * complete is a DETAIL_GAP. `total_threads` on list items is NOT the
 * library size (a live 4-thread account reported 99 on every item), so
 * nothing is cross-checked against it.
 *
 * Session: a signed-in page is never moved. A Cloudflare human check is
 * handed to the owner in place; a signed-out page goes to the sign-in page
 * (`/auth/signin`) and is handed over with `manualBrowserLogin`. Readiness is
 * read without navigation. Session errors are bare codes
 * (`perplexity_auth_failed`, `perplexity_interrupted`).
 *
 * Tested surfaces (as of 2026-10-12, from the live recon notes):
 *   - a small Pro-tier library; threads with one entry each
 *   - zoneless microsecond list timestamps (read as UTC; the entries of the
 *     same threads carry `+00:00`, so the server clock is UTC)
 *   - answers built from `blocks[]` (`ask_text`, `web_results`)
 *
 * Known untested:
 *   - threads with more than one page of entries (the recon threads had one
 *     entry each; the offset paging is written to the recon's description)
 *   - spaces/collections, files, bookmarks (out of scope for v1)
 */

import { isMainModule, resourceSet } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	createConnectorFailure,
	emitDetailCoverage,
	emitDetailGap,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { isOutsideTimeRange } from "../../packages/polyfill-connectors/src/time-range.ts";
import {
	conversationRecord,
	entryMessages,
	type ListedThread,
	listItemTime,
	normalizeInstant,
	parseListedThread,
	parseThreadDetailPage,
	parseThreadListPage,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { MessageRecord } from "./types.ts";

const ORIGIN = "https://www.perplexity.ai";
const HOME = `${ORIGIN}/`;
/**
 * Perplexity's own sign-in page (Google, Apple, email, SSO), the address its
 * web app builds for a signed-out visitor; the callback lands back on home.
 * The manifest's login_url says the same.
 */
const SIGN_IN_URL = `${ORIGIN}/auth/signin?callbackUrl=%2F`;
const LIST_PATH = "/rest/thread/list_ask_threads";
const THREAD_PATH = "/rest/thread/";
/** The web app's own list page size; 20 was observed working. */
export const PAGE_SIZE = 20;
/** Entries per thread page, the value the recon exercised. */
const ENTRY_PAGE_SIZE = 10;
/** Politeness pause between thread-detail reads, so the run looks human. */
const THREAD_DELAY_MS = 250;
/** Hard stops: a walk that never ends is a source bug, not a big library. */
const MAX_LIST_PAGES = 500;
const MAX_THREAD_PAGES = 200;
/** Extra list walks allowed to see the library hold still. */
const MAX_LIST_WALKS = 3;
/**
 * How long an answer may finish after its thread's last query time. The
 * list carries only the last query time, while an answer's record time is
 * its entry's last update (when the answer finished), so a thread whose last
 * query is just before a window's start can still hold an answer inside it.
 * A thread is only treated as wholly older than `since` when the list marks
 * it complete and its last query is more than this margin before it.
 *
 * Why a day: an answer is generated right after its question and finishes
 * within minutes (the recon threads finished in seconds); a new question
 * moves the thread's last query time. A day is two orders of magnitude of
 * headroom. An entry updated later than that without a new question (a
 * shape the connector has not observed) would be missed by a time-bounded
 * run that skips its thread; such trailing times are reported as the
 * `answer_trails_last_query` diagnostic whenever a thread is read, so the
 * assumption is checked against real libraries.
 */
export const ANSWER_TIME_MARGIN_MS = 24 * 3_600_000;
/**
 * Consecutive list pages, wholly older than a time-bounded run's cutoff and
 * in newest-first order, after which the walk stops. One would do if the
 * order were guaranteed; the second is margin for an order the connector
 * only observes.
 */
const OLD_PAGES_TO_STOP = 2;
/**
 * Revision of the entry parser. A thread remembered with entries this parser
 * could not read is read again once the revision changes, so a connector
 * upgrade that learns the shape recovers them (`retry_on_connector_upgrade`).
 */
const ENTRY_PARSER_REVISION = 1;

/** Headers the web app sends on these calls (observed, not invented). */
interface PageRequest {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly body?: string;
}

/**
 * The selection a thread's messages were delivered under, when the runtime
 * withheld some of them. `since`/`until` are the messages time range of that
 * run; `resources` is a digest of its messages resource list. Absent means
 * every message read was delivered.
 */
interface SyncWindow {
	since?: string;
	until?: string;
	resources?: string;
}

/**
 * One thread's remembered detail state. A thread is remembered only after
 * every entry was complete and read (or, for an entry this parser cannot
 * read, reported as unreadable); it is skipped next run only while its
 * update time (to the microsecond) and entry count are unchanged, the run's
 * messages selection lies inside the one it was delivered under (`window`),
 * and, when it has unreadable entries, the parser revision is the same.
 */
interface ThreadSync {
	update_time: string | null;
	create_time: string | null;
	entry_count: number;
	complete: true;
	window?: SyncWindow;
	unreadable_entries?: number;
	parser?: number;
}

/**
 * Version of the `messages` STATE. Version 2 is the first that records the
 * window a thread was delivered under. Earlier cursors remembered a thread
 * even when the runtime withheld some of its messages, so an entry from them
 * is never skipped on: it only supplies the thread's creation time, and the
 * thread is read once more.
 */
const SYNC_STATE_VERSION = 2;

/** The `messages` STATE cursor: one entry per remembered thread. */
interface MessagesCursor {
	v: typeof SYNC_STATE_VERSION;
	synced: Record<string, ThreadSync>;
}

// ─── session ─────────────────────────────────────────────────────────────

/**
 * What the current page says about the session, read without moving it:
 *   - `signed_in`: `GET /api/auth/session` answered `{ user: {...} }`;
 *   - `signed_out`: it answered `{}` (NextAuth's signed-out body);
 *   - `challenge`: a Cloudflare human check holds the page or answered the
 *     session request (`cf-mitigated: challenge`, or an HTML 403/503);
 *   - `off_origin`: the page is not on www.perplexity.ai;
 *   - `unknown`: anything else (a network error, a 5xx, an odd body).
 */
export type PerplexitySessionState =
	| "signed_in"
	| "signed_out"
	| "challenge"
	| "off_origin"
	| "unknown";

export async function checkPerplexitySession(
	page: BrowserCollectContext["page"],
): Promise<PerplexitySessionState> {
	try {
		return await page.evaluate(async (): Promise<PerplexitySessionState> => {
			try {
				if (location.origin !== "https://www.perplexity.ai") {
					return "off_origin";
				}
				const doc = (globalThis as { document?: { title?: unknown } }).document;
				const cf = (globalThis as { _cf_chl_opt?: unknown })._cf_chl_opt;
				if (cf !== undefined || doc?.title === "Just a moment...") {
					return "challenge";
				}
				// Bounded, body included: a stalled session check must not hold
				// a handoff watcher or an end-of-list proof forever, so the timer
				// stays armed until the body has been read.
				const controller = new AbortController();
				const timer = setTimeout(() => controller.abort(), 15_000);
				let payload: unknown;
				try {
					const response = await fetch("/api/auth/session", {
						credentials: "include",
						signal: controller.signal,
					});
					const type = response.headers.get("content-type") ?? "";
					if (
						response.headers.get("cf-mitigated") === "challenge" ||
						(type.includes("text/html") &&
							(response.status === 403 || response.status === 503))
					) {
						return "challenge";
					}
					if (!response.ok) {
						return "unknown";
					}
					payload = await response.json();
				} finally {
					clearTimeout(timer);
				}
				if (
					typeof payload !== "object" ||
					payload === null ||
					Array.isArray(payload)
				) {
					return "unknown";
				}
				const user = (payload as Record<string, unknown>).user;
				if (typeof user === "object" && user !== null && !Array.isArray(user)) {
					return "signed_in";
				}
				return Object.keys(payload).length === 0 ? "signed_out" : "unknown";
			} catch {
				return "unknown";
			}
		});
	} catch {
		return "unknown";
	}
}

/**
 * Whether the page's own session is signed in. Reads the current page only
 * and never navigates, so it is the readiness check while the owner signs in
 * (possibly on a Google or Apple page) and the PageShim probe.
 */
export async function probePerplexitySession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	return (await checkPerplexitySession(page)) === "signed_in";
}

/** Same probe, but first lands the run page on perplexity.ai if it is elsewhere. */
export async function hasPerplexitySession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	try {
		if (new URL(page.url()).origin !== ORIGIN) {
			await page.goto(HOME, { waitUntil: "domcontentloaded" });
		}
	} catch {
		return false;
	}
	return probePerplexitySession(page);
}

/** Session reads that may repeat in place when the answer was not usable. */
const SESSION_CHECK_RETRIES = 2;
const SESSION_RETRY_DELAY_MS = 1500;
const SIGN_IN_TIMEOUT_SECONDS = 30 * 60;
const SIGN_IN_MESSAGE =
	"Sign in to Perplexity in the secure browser, then continue. PDPP will verify the session before collecting.";
const CHALLENGE_MESSAGE =
	"Perplexity is showing a human check. Complete it in the secure browser, then continue. PDPP will verify the session before collecting.";

const realDelay = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Make sure the page is signed in to Perplexity before collection.
 *
 * One non-navigating check (after at most one navigation to the home page
 * when the run page is elsewhere). A signed-in page is never moved. A human
 * check is handed to the owner in place, on the page as it is. A signed-out
 * page is moved to Perplexity's sign-in page (`/auth/signin`, the form
 * itself rather than the home page's sign-in button) and handed over. Readiness during either handoff is read
 * without navigation, so a sign-in that passes through Google or Apple is
 * never pulled away. Errors thrown here are bare codes: the runtime keeps a
 * session error's code only when the whole message is the code.
 */
export async function ensurePerplexitySession(
	args: EnsureSessionArgs,
	/** Test seam: production uses the real clock. */
	delay: (ms: number) => Promise<void> = realDelay,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	let state = await checkPerplexitySession(page);
	if (state === "off_origin") {
		try {
			await page.goto(HOME, { waitUntil: "domcontentloaded" });
		} catch {
			connectorDiagnostic("perplexity", "session_home_unreachable", {});
			throw new Error("perplexity_interrupted");
		}
		state = await checkPerplexitySession(page);
	}
	for (
		let retry = 0;
		state === "unknown" && retry < SESSION_CHECK_RETRIES;
		retry += 1
	) {
		await delay(SESSION_RETRY_DELAY_MS);
		state = await checkPerplexitySession(page);
	}
	if (state === "signed_in") {
		return;
	}
	if (state === "unknown" || state === "off_origin") {
		connectorDiagnostic("perplexity", "session_check_no_answer", { state });
		throw new Error("perplexity_interrupted");
	}
	if (state === "signed_out" && page.url() !== SIGN_IN_URL) {
		try {
			await page.goto(SIGN_IN_URL, { waitUntil: "domcontentloaded" });
		} catch {
			connectorDiagnostic("perplexity", "sign_in_page_unreachable", {});
			throw new Error("perplexity_interrupted");
		}
	}
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message: state === "challenge" ? CHALLENGE_MESSAGE : SIGN_IN_MESSAGE,
		page,
		// Never navigates, also after the owner says they are done on a host
		// without the streamed handoff: a sign-in still finishing on a Google
		// or Apple page must not be pulled away.
		probe: () => probePerplexitySession(page),
		readinessProbe: probePerplexitySession,
		readinessProbeOnHandoffPage: true,
		reason: state === "challenge" ? "captcha" : "login",
		sendInteraction,
		timeoutSeconds: SIGN_IN_TIMEOUT_SECONDS,
	});
	if (!ready) {
		connectorDiagnostic("perplexity", "sign_in_not_completed", { state });
		throw new Error("perplexity_auth_failed");
	}
}

// ─── same-origin fetch through the page ──────────────────────────────────

/**
 * One same-origin request from the signed-in page. The error message names
 * the class so the run fails the right way, and never carries a body:
 *   - `perplexity_auth_failed`: 401, or the page left perplexity.ai;
 *   - `perplexity_challenge`: 403, a Cloudflare challenge page (HTML 403 or
 *     503, or `cf-mitigated: challenge`), or any other non-JSON answer. The
 *     session can still be valid while the browser is challenged;
 *   - `perplexity_internal_api_<status>`: 429 and 5xx, which the runtime
 *     retries;
 *   - `perplexity_http_<status>`: any other refusal (404 for a gone thread).
 */
async function pageJson(
	page: BrowserCollectContext["page"],
	request: PageRequest,
): Promise<string> {
	return page.evaluate(async (arg) => {
		if (location.origin !== "https://www.perplexity.ai") {
			throw new Error("perplexity_auth_failed: wrong browser origin");
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 30_000);
		try {
			const headers: Record<string, string> = {
				Accept: "application/json",
				"x-app-apiclient": "default",
				"x-app-apiversion": "2.18",
			};
			if (arg.body !== undefined) {
				headers["content-type"] = "application/json";
			}
			const response = await fetch(arg.url, {
				method: arg.method,
				credentials: "include",
				headers,
				...(arg.body === undefined ? {} : { body: arg.body }),
				signal: controller.signal,
			});
			const status = response.status;
			const type = response.headers.get("content-type") ?? "";
			// Cloudflare answers a challenge with 403 or 503 and an HTML page
			// (and marks it with cf-mitigated); that is not an outage to retry.
			if (
				response.headers.get("cf-mitigated") === "challenge" ||
				(type.includes("text/html") && (status === 403 || status === 503))
			) {
				throw new Error(
					`perplexity_challenge: HTTP ${String(status)} challenge page`,
				);
			}
			if (status === 401) {
				throw new Error("perplexity_auth_failed: HTTP 401");
			}
			if (status === 403) {
				throw new Error("perplexity_challenge: HTTP 403");
			}
			if (status === 429 || status >= 500) {
				throw new Error(`perplexity_internal_api_${String(status)}`);
			}
			if (!response.ok) {
				throw new Error(`perplexity_http_${String(status)}`);
			}
			if (!type.includes("json")) {
				throw new Error("perplexity_challenge: the answer was not JSON");
			}
			return await response.text();
		} finally {
			clearTimeout(timeout);
		}
	}, request);
}

/** Errors that stop the whole run rather than one thread. */
function stopsTheRun(message: string): boolean {
	// A closed page or a destroyed execution context is the browser going
	// away, not one thread failing: every later read would fail the same way.
	return /perplexity_(?:auth_failed|challenge|internal_api_)|has been closed|Execution context was destroyed/.test(
		message,
	);
}

async function fetchListPage(
	page: BrowserCollectContext["page"],
	offset: number,
): Promise<string> {
	return pageJson(page, {
		method: "POST",
		url: LIST_PATH,
		body: JSON.stringify({
			limit: PAGE_SIZE,
			offset,
			ascending: false,
			search_term: "",
		}),
	});
}

async function fetchThreadPage(
	page: BrowserCollectContext["page"],
	slug: string,
	offset: number,
): Promise<string> {
	const query = new URLSearchParams({
		with_parent_info: "true",
		with_schematized_response: "true",
		version: "2.18",
		source: "default",
		limit: String(ENTRY_PAGE_SIZE),
		offset: String(offset),
		from_first: "true",
	});
	return pageJson(page, {
		method: "GET",
		url: `${THREAD_PATH}${encodeURIComponent(slug)}?${query.toString()}`,
	});
}

function entryUuid(entry: unknown): string | null {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
		return null;
	}
	const uuid = (entry as Record<string, unknown>).uuid;
	return typeof uuid === "string" && uuid.length > 0 ? uuid : null;
}

/**
 * Every entry of one thread, all pages, oldest first. Only `has_next_page`
 * ends the walk: a short page that still says there is more is followed. A
 * page that claims more but adds no new entry is a failure, not an end, and
 * a thread that yields fewer entries than the list said it has is
 * incomplete. Entries are de-duplicated by uuid.
 */
async function fetchThreadEntries(
	page: BrowserCollectContext["page"],
	slug: string,
	expected: number | null,
): Promise<unknown[]> {
	const entries: unknown[] = [];
	const seen = new Set<string>();
	let offset = 0;
	for (let pageIndex = 0; ; pageIndex += 1) {
		if (pageIndex >= MAX_THREAD_PAGES) {
			throw new Error(
				"perplexity_thread_unreadable: entries kept claiming another page",
			);
		}
		const parsed = parseThreadDetailPage(
			await fetchThreadPage(page, slug, offset),
		);
		if (!parsed.ok) {
			throw new Error(`perplexity_thread_unreadable: ${parsed.message}`);
		}
		let added = 0;
		for (const entry of parsed.page.entries) {
			const uuid = entryUuid(entry);
			if (uuid !== null && seen.has(uuid)) {
				continue;
			}
			if (uuid !== null) {
				seen.add(uuid);
			}
			entries.push(entry);
			added += 1;
		}
		if (!parsed.page.hasNextPage) {
			break;
		}
		if (added === 0) {
			throw new Error(
				"perplexity_thread_unreadable: an entries page claimed more but added none",
			);
		}
		offset += parsed.page.entries.length;
	}
	if (expected !== null && entries.length < expected) {
		throw new Error(
			`perplexity_thread_incomplete: the list reports ${String(expected)} entries, the thread returned ${String(entries.length)}`,
		);
	}
	return entries;
}

// ─── collection ──────────────────────────────────────────────────────────

/** The earlier of two normalized instants (fixed-width ISO sorts by time). */
function earlier(
	current: string | null,
	candidate: string | null,
): string | null {
	if (candidate === null) {
		return current;
	}
	if (current === null) {
		return candidate;
	}
	return candidate < current ? candidate : current;
}

function bounded(message: string): string {
	return message.slice(0, 240);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface ListWalk {
	readonly threads: ListedThread[];
	/** The list time of each row that could not be keyed (null: none). */
	readonly unreadable: readonly (string | null)[];
	/** List pages this walk requested; one page is a single atomic answer. */
	readonly pages: number;
	/**
	 * The walk stopped at the time-bounded run's cutoff instead of at the end
	 * of the list: every thread past it is older than the cutoff.
	 */
	readonly truncated: boolean;
}

/**
 * The instant (epoch ms) below which no requested stream can select
 * anything from a thread, or null when the run must walk the whole list.
 * Every requested stream must carry a `since`: `conversations` selects by the
 * list's own last activity time, `messages` by entry times that can trail it
 * by up to ANSWER_TIME_MARGIN_MS.
 */
function listCutoff(ctx: BrowserCollectContext): number | null {
	let cutoff = Number.POSITIVE_INFINITY;
	for (const stream of ["conversations", "messages"] as const) {
		const scope = ctx.requested.get(stream);
		if (scope === undefined) {
			continue;
		}
		const since = scope.time_range?.since;
		const at = since === undefined ? Number.NaN : Date.parse(since);
		if (!Number.isFinite(at)) {
			return null;
		}
		cutoff = Math.min(
			cutoff,
			stream === "messages" ? at - ANSWER_TIME_MARGIN_MS : at,
		);
	}
	return Number.isFinite(cutoff) ? cutoff : null;
}

/**
 * One pass over the library list. The walk ends on an empty page or on a
 * last item that says `has_next_page: false`; a short page that says there is
 * more is followed. A thread seen twice (the list moved under the walk) is
 * kept once.
 *
 * With a cutoff (a run whose every stream is bounded by `since`), the walk
 * also ends after OLD_PAGES_TO_STOP consecutive pages wholly older than the
 * cutoff, but only while every row seen so far, keyed or not, had a readable
 * time no newer than the row before it: the list is requested newest first
 * (`ascending: false`), and a row out of that order, or one without a time,
 * turns the early stop off for the rest of the walk.
 */
async function walkList(
	ctx: BrowserCollectContext,
	delay: (ms: number) => Promise<void>,
	cutoff: number | null,
): Promise<ListWalk> {
	const threads: ListedThread[] = [];
	const seen = new Set<string>();
	const unreadable: (string | null)[] = [];
	let offset = 0;
	let ordered = cutoff !== null;
	let previous: string | null = null;
	let oldPages = 0;
	for (let pageIndex = 0; ; pageIndex += 1) {
		if (pageIndex >= MAX_LIST_PAGES) {
			throw new Error(
				"perplexity_source_unreadable: the thread list kept claiming another page",
			);
		}
		await ctx.progress(
			`Reading your Perplexity library (threads ${String(offset + 1)} onward)`,
			{ stream: "conversations" },
		);
		const parsed = parseThreadListPage(await fetchListPage(ctx.page, offset));
		if (!parsed.ok) {
			throw new Error(`perplexity_source_unreadable: ${parsed.message}`);
		}
		let pageOld = true;
		for (const item of parsed.page.items) {
			const thread = parseListedThread(item);
			if (thread === null) {
				unreadable.push(listItemTime(item));
			} else if (!seen.has(thread.id)) {
				seen.add(thread.id);
				threads.push(thread);
			}
			if (ordered) {
				const time = listItemTime(item);
				// A time this engine cannot parse (NaN) must not read as old:
				// it turns the early stop off like a missing time does.
				const at = time === null ? Number.NaN : Date.parse(time);
				if (
					time === null ||
					!Number.isFinite(at) ||
					(previous !== null && time > previous)
				) {
					ordered = false;
				} else {
					previous = time;
					if (cutoff === null || at >= cutoff) {
						pageOld = false;
					}
				}
			}
		}
		if (parsed.page.items.length === 0) {
			// An empty page proves the end only from a signed-in session: a
			// session that lapsed mid-walk may answer an empty list rather than
			// a 401, and that must not read as "nothing more" (or as an empty
			// library, checkpointed).
			await confirmSignedIn(ctx.page, delay);
			return { threads, unreadable, pages: pageIndex + 1, truncated: false };
		}
		if (!parsed.page.hasNextPage) {
			return { threads, unreadable, pages: pageIndex + 1, truncated: false };
		}
		oldPages = ordered && pageOld ? oldPages + 1 : 0;
		if (oldPages >= OLD_PAGES_TO_STOP) {
			connectorDiagnostic("perplexity", "list_walk_stopped_at_window", {
				pages: pageIndex + 1,
			});
			return { threads, unreadable, pages: pageIndex + 1, truncated: true };
		}
		offset += parsed.page.items.length;
	}
}

/**
 * The end-of-list session confirmation. Signed in proves the empty page;
 * signed out fails the run (`perplexity_auth_failed`); a human check stops
 * it as a challenge; an answer that says nothing is re-read in place, then
 * stops the run retryably (`perplexity_interrupted`).
 */
async function confirmSignedIn(
	page: BrowserCollectContext["page"],
	delay: (ms: number) => Promise<void>,
): Promise<void> {
	let state = await checkPerplexitySession(page);
	for (
		let retry = 0;
		(state === "unknown" || state === "off_origin") &&
		retry < SESSION_CHECK_RETRIES;
		retry += 1
	) {
		await delay(SESSION_RETRY_DELAY_MS);
		state = await checkPerplexitySession(page);
	}
	if (state === "signed_in") {
		return;
	}
	if (state === "signed_out") {
		throw new Error(
			"perplexity_auth_failed: the list came back empty from a session that is not signed in",
		);
	}
	if (state === "challenge") {
		throw new Error(
			"perplexity_challenge: a human check answered the session check at the end of the list",
		);
	}
	throw new Error(
		"perplexity_interrupted: the session check at the end of the list had no answer",
	);
}

/**
 * The set of thread ids a walk saw, order-insensitive. Update times are left
 * out on purpose: a thread answered between walks changes its time but not
 * the membership the walk has to prove.
 */
/**
 * Whether a list time can still select anything under the cutoff. A row
 * without a time, or with one this engine cannot parse, always can.
 */
function insideCutoff(time: string | null, cutoff: number | null): boolean {
	return cutoff === null || time === null || !(Date.parse(time) < cutoff);
}

/** The unkeyed rows of a walk that can still select anything. */
function unreadableInWindow(walk: ListWalk, cutoff: number | null): number {
	return walk.unreadable.filter((time) => insideCutoff(time, cutoff)).length;
}

function walkSignature(walk: ListWalk, cutoff: number | null): string {
	// Unkeyed rows count too: a walk that saw one and a walk that missed it
	// (shifted past it) must not agree, or the second could prove a list
	// that lacks a thread. Under a cutoff, rows older than it, keyed or not,
	// select nothing, so a walk that read more of them past its stop still
	// agrees with one that did not.
	return `${walk.threads
		.filter((thread) => insideCutoff(thread.updateTime, cutoff))
		.map((thread) => thread.id)
		.sort()
		.join("|")}#unreadable=${String(unreadableInWindow(walk, cutoff))}`;
}

/**
 * The library list, and whether it is proven complete. The list is ordered
 * by recent activity and paged by offset, so a thread answered while the
 * walk runs moves to the top and can shift another past the walk unseen. One
 * page is atomic; a walk that needed more than one page is repeated until
 * two consecutive walks see the same threads. A list that never holds still
 * is returned unproven: its threads are real, but the run cannot claim it saw
 * all of them, so neither stream is checkpointed.
 */
async function stableList(
	ctx: BrowserCollectContext,
	delay: (ms: number) => Promise<void>,
	cutoff: number | null,
): Promise<ListWalk & { readonly proven: boolean }> {
	let walk = await walkList(ctx, delay, cutoff);
	if (walk.pages <= 1) {
		return { ...walk, proven: true };
	}
	for (let attempt = 0; attempt < MAX_LIST_WALKS; attempt += 1) {
		const again = await walkList(ctx, delay, cutoff);
		if (walkSignature(again, cutoff) === walkSignature(walk, cutoff)) {
			return { ...again, proven: true };
		}
		walk = again;
	}
	connectorDiagnostic("perplexity", "list_unstable", {
		walks: MAX_LIST_WALKS + 1,
	});
	return { ...walk, proven: false };
}

/** A portable recovery hint (Collection Profile 5.5) for a stream failure. */
interface RecoveryHint {
	readonly action: "retry_by_runtime" | "retry_on_connector_upgrade";
	readonly retryable: boolean;
}

/** A list that did not hold still: the next run can read it whole. */
const RETRY_BY_RUNTIME: RecoveryHint = {
	action: "retry_by_runtime",
	retryable: true,
};
/** A row or entry this parser cannot place: only a newer connector can. */
const RETRY_ON_CONNECTOR_UPGRADE: RecoveryHint = {
	action: "retry_on_connector_upgrade",
	retryable: false,
};

/**
 * Report one stream as failed. A context without the runtime's reporter (a
 * hand-built caller) cannot carry a stream failure, so the run fails instead
 * of finishing as if the stream were complete.
 */
async function failStream(
	ctx: BrowserCollectContext,
	stream: string,
	message: string,
	hint: RecoveryHint,
): Promise<void> {
	const { retryable } = hint;
	connectorDiagnostic("perplexity", "stream_failed", { stream, retryable });
	if (!ctx.reportStreamFailure) {
		throw createConnectorFailure("perplexity_stream_incomplete", message, {
			retryable,
			recoveryHint: { ...hint },
		});
	}
	await ctx.reportStreamFailure(stream, message, {
		retryable,
		recoveryHint: { ...hint },
	});
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A remembered delivery window. `undefined` when the field is absent (every
 * message was delivered, which is also how a thread remembered before the
 * field existed is read); null when it is present but malformed, so the
 * thread is not trusted at all.
 */
function readSyncWindow(value: unknown): SyncWindow | null | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isPlainObject(value)) {
		return null;
	}
	const window: SyncWindow = {};
	for (const key of ["since", "until", "resources"] as const) {
		const field = value[key];
		if (field === undefined) {
			continue;
		}
		if (typeof field !== "string") {
			return null;
		}
		window[key] = field;
	}
	return window;
}

/** A remembered thread, read defensively from a prior STATE. */
function readThreadSync(value: unknown): ThreadSync | null {
	if (!isPlainObject(value)) {
		return null;
	}
	const record = value;
	const text = (field: unknown): string | null =>
		typeof field === "string" ? field : null;
	if (
		record.complete !== true ||
		typeof record.update_time !== "string" ||
		typeof record.entry_count !== "number"
	) {
		return null;
	}
	const window = readSyncWindow(record.window);
	if (window === null) {
		return null;
	}
	const unreadable = record.unreadable_entries;
	if (
		unreadable !== undefined &&
		!(
			typeof unreadable === "number" &&
			Number.isSafeInteger(unreadable) &&
			unreadable > 0 &&
			typeof record.parser === "number"
		)
	) {
		return null;
	}
	return {
		update_time: record.update_time,
		create_time: text(record.create_time),
		entry_count: record.entry_count,
		complete: true,
		...(window === undefined ? {} : { window }),
		...(typeof unreadable === "number" && typeof record.parser === "number"
			? { unreadable_entries: unreadable, parser: record.parser }
			: {}),
	};
}

/** What the last `messages` STATE says, read defensively. */
interface StoredState {
	/**
	 * Every thread a current-version STATE remembered, whatever the run's
	 * collection mode. A full refresh must not skip on it (see
	 * `previousSyncedThreads`) but keeps it for threads it does not read.
	 */
	readonly synced: Map<string, ThreadSync>;
	/**
	 * Each remembered thread's creation time, from a STATE of any version: a
	 * fact about the source, kept so a run that does not read the thread
	 * does not blank it.
	 */
	readonly createTimes: Map<string, string>;
}

function storedState(ctx: BrowserCollectContext): StoredState {
	const synced = new Map<string, ThreadSync>();
	const createTimes = new Map<string, string>();
	const cursor = ctx.state.messages;
	if (!isPlainObject(cursor) || !isPlainObject(cursor.synced)) {
		return { synced, createTimes };
	}
	const current = cursor.v === SYNC_STATE_VERSION;
	for (const [id, value] of Object.entries(cursor.synced)) {
		const sync = readThreadSync(value);
		if (sync === null) {
			continue;
		}
		if (sync.create_time !== null) {
			createTimes.set(id, sync.create_time);
		}
		if (current) {
			synced.set(id, sync);
		}
	}
	return { synced, createTimes };
}

/** The remembered threads a run may skip on: none on a full refresh. */
function previousSyncedThreads(
	ctx: BrowserCollectContext,
	stored: Map<string, ThreadSync>,
): Map<string, ThreadSync> {
	return ctx.collectionMode === "full_refresh" ? new Map() : stored;
}

// ─── the run's messages selection ────────────────────────────────────────

/** What the runtime will deliver of `messages` in this run. */
interface MessagesSelection {
	readonly range: { readonly since?: string; readonly until?: string } | null;
	readonly resources: ReadonlySet<string> | null;
	/** Digest of the resource list, stored instead of the list itself. */
	readonly resourcesKey: string | null;
}

/**
 * A short digest (cyrb53, two 32-bit lanes) of the sorted resource list. A
 * thread remembered under a resource list is reused only by a run with the
 * same list; the digest keeps STATE small. Pure JS, so it also runs on the
 * mobile PageShim host.
 */
function resourcesDigest(resources: ReadonlySet<string>): string {
	const text = [...resources].sort().join("\n");
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2_654_435_761);
		h2 = Math.imul(h2 ^ code, 1_597_334_677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909);
	const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
	return `${String(resources.size)}:${hex(h2)}${hex(h1)}`;
}

function messagesSelection(ctx: BrowserCollectContext): MessagesSelection {
	const scope = ctx.requested.get("messages");
	const range = scope?.time_range;
	const resources = scope === undefined ? null : resourceSet(scope);
	return {
		range:
			range !== undefined &&
			(range.since !== undefined || range.until !== undefined)
				? range
				: null,
		resources,
		resourcesKey: resources === null ? null : resourcesDigest(resources),
	};
}

/**
 * Whether everything this run's messages selection can deliver was already
 * delivered under a remembered window: the run's range lies inside the
 * window's and its resource list is the same one.
 */
function windowCovers(
	window: SyncWindow | undefined,
	selection: MessagesSelection,
): boolean {
	if (window === undefined) {
		return true;
	}
	if (window.since !== undefined) {
		const since = normalizeInstant(selection.range?.since);
		const stored = normalizeInstant(window.since);
		if (since === null || stored === null || since < stored) {
			return false;
		}
	}
	if (window.until !== undefined) {
		const until = normalizeInstant(selection.range?.until);
		const stored = normalizeInstant(window.until);
		if (until === null || stored === null || until > stored) {
			return false;
		}
	}
	if (
		window.resources !== undefined &&
		window.resources !== selection.resourcesKey
	) {
		return false;
	}
	return true;
}

/**
 * The window a thread's messages were delivered under in this run, or
 * `remember: false` when the runtime withheld one for a reason the connector
 * cannot name (it is then read again next run rather than remembered). A
 * thread whose every message was delivered gets no window: any later
 * selection is covered.
 */
function deliveryWindow(
	ctx: BrowserCollectContext,
	selection: MessagesSelection,
	messages: readonly MessageRecord[],
): { readonly remember: boolean; readonly window?: SyncWindow } {
	let byTime = false;
	let byResource = false;
	for (const message of messages) {
		const timeOut =
			selection.range !== null &&
			isOutsideTimeRange(selection.range, message.create_time);
		const resourceOut =
			selection.resources !== null && !selection.resources.has(message.id);
		const selected =
			typeof ctx.isRecordSelected === "function"
				? ctx.isRecordSelected("messages", { ...message })
				: !(timeOut || resourceOut);
		if (selected) {
			// The runtime's selection does not run the shape check, which
			// drops a record the schema refuses. Such a message was not
			// delivered, for a reason no window can name. (The parsers bound
			// every field the schema checks; this guards against the two
			// drifting apart.)
			if (!validateRecord("messages", { ...message }).ok) {
				return { remember: false };
			}
			continue;
		}
		if (!(timeOut || resourceOut)) {
			return { remember: false };
		}
		byTime ||= timeOut;
		byResource ||= resourceOut;
	}
	if (!(byTime || byResource)) {
		return { remember: true };
	}
	const window: SyncWindow = {};
	if (byTime && selection.range?.since !== undefined) {
		window.since = selection.range.since;
	}
	if (byTime && selection.range?.until !== undefined) {
		window.until = selection.range.until;
	}
	if (byResource && selection.resourcesKey !== null) {
		window.resources = selection.resourcesKey;
	}
	return { remember: true, window };
}

/** A remembered thread the list still shows exactly as it was remembered. */
function isUnchanged(thread: ListedThread, known: ThreadSync): boolean {
	return (
		thread.complete &&
		thread.updateTime !== null &&
		known.update_time === thread.updateTime &&
		known.entry_count === thread.entryCount &&
		(known.unreadable_entries === undefined ||
			known.parser === ENTRY_PARSER_REVISION)
	);
}

/**
 * Whether no message of the thread can fall inside the run's messages time
 * range, so its detail need not be read:
 *   - since: its last query is more than ANSWER_TIME_MARGIN_MS before it
 *     (every entry was created no later than the last query, and an answer
 *     finishes within the margin);
 *   - until: its remembered first entry was created at or after it (no
 *     entry is created before the first, and an answer finishes after its
 *     question). Only a fully read thread's creation time is trusted here.
 */
function outsideMessagesRange(
	thread: ListedThread,
	known: ThreadSync | undefined,
	selection: MessagesSelection,
): boolean {
	const range = selection.range;
	if (range === null) {
		return false;
	}
	// Only a thread the list marks complete: one still being answered can
	// finish at any time.
	if (
		range.since !== undefined &&
		thread.complete &&
		thread.updateTime !== null
	) {
		const since = Date.parse(range.since);
		if (Date.parse(thread.updateTime) < since - ANSWER_TIME_MARGIN_MS) {
			return true;
		}
	}
	if (
		range.until !== undefined &&
		known?.create_time != null &&
		known.unreadable_entries === undefined
	) {
		// Compared to the microsecond: both sides are fixed-width UTC
		// instants, which sort by time. A bound finer than a microsecond is
		// rounded up, so an entry just before it is never taken as after it.
		const until = ceilInstant(range.until);
		const created = normalizeInstant(known.create_time);
		if (until !== null && created !== null && created >= until) {
			return true;
		}
	}
	return false;
}

/**
 * `normalizeInstant`, rounded up to the next microsecond when the value
 * carries a nonzero digit finer than that (normalizing truncates them).
 */
function ceilInstant(value: string): string | null {
	const normalized = normalizeInstant(value);
	if (normalized === null) {
		return null;
	}
	const finer = /T[^.]*\.\d{6}(\d+)/.exec(value)?.[1];
	if (finer === undefined || /^0+$/.test(finer)) {
		return normalized;
	}
	const micros =
		Date.parse(`${normalized.slice(0, 19)}Z`) * 1000 +
		Number(normalized.slice(20, 26)) +
		1;
	const seconds = Math.floor(micros / 1_000_000);
	const fraction = String(micros - seconds * 1_000_000).padStart(6, "0");
	return `${new Date(seconds * 1000).toISOString().slice(0, 19)}.${fraction}Z`;
}

/** An answer this much later than its thread's last query is reported. */
const TRAILING_ANSWER_REPORT_MS = 3_600_000;

/**
 * Report a thread whose latest answer finished well after the list's last
 * query time: the evidence for (or against) ANSWER_TIME_MARGIN_MS.
 */
function reportTrailingAnswer(
	thread: ListedThread,
	messages: readonly MessageRecord[],
): void {
	if (thread.updateTime === null) {
		return;
	}
	const lastQuery = Date.parse(thread.updateTime);
	let latest = Number.NEGATIVE_INFINITY;
	for (const message of messages) {
		if (message.role === "assistant" && message.create_time !== null) {
			latest = Math.max(latest, Date.parse(message.create_time));
		}
	}
	const trail = latest - lastQuery;
	if (Number.isFinite(trail) && trail > TRAILING_ANSWER_REPORT_MS) {
		connectorDiagnostic("perplexity", "answer_trails_last_query", {
			thread: thread.id,
			hours: Math.round(trail / 3_600_000),
			beyond_margin: trail > ANSWER_TIME_MARGIN_MS,
		});
	}
}

/** One thread's detail, read before anything about it is emitted. */
type ThreadRead =
	| {
			readonly kind: "read";
			readonly messages: MessageRecord[];
			readonly createTime: string | null;
			/** Every entry was complete and readable, so the thread can be remembered. */
			readonly complete: boolean;
			readonly incomplete: number;
			readonly unreadable: number;
	  }
	| { readonly kind: "failed"; readonly message: string };

async function readThread(
	page: BrowserCollectContext["page"],
	slug: string,
	conversationId: string,
	expected: number | null,
): Promise<ThreadRead> {
	let entries: unknown[];
	try {
		entries = await fetchThreadEntries(page, slug, expected);
	} catch (error) {
		const message = errorMessage(error);
		if (stopsTheRun(message)) {
			throw error;
		}
		return { kind: "failed", message };
	}
	const messages: MessageRecord[] = [];
	let createTime: string | null = null;
	let incomplete = 0;
	let unreadable = 0;
	for (const entry of entries) {
		const read = entryMessages(entry, conversationId);
		if (read.kind === "incomplete") {
			incomplete += 1;
			continue;
		}
		if (read.kind === "unreadable") {
			unreadable += 1;
			connectorDiagnostic("perplexity", "entry_unreadable", {
				thread: conversationId,
				entry: read.id,
				reason: read.reason,
			});
			continue;
		}
		messages.push(read.user, read.assistant);
		createTime = earlier(createTime, read.firstCreateTime);
	}
	return {
		kind: "read",
		messages,
		createTime,
		complete: incomplete === 0 && unreadable === 0,
		incomplete,
		unreadable,
	};
}

/**
 * What a gap's locator says about its thread: the slug to read it by, and
 * the entry count the list reported when the gap was written. `expected` is
 * `undefined` when the locator does not say (a gap written before the count
 * was recorded): such a gap could be a short read, so recovery-only leaves
 * it to the forward walk, which reads the thread against the live list.
 */
function threadLocator(
	locator: unknown,
): { slug: string; expected: number | null | undefined } | null {
	if (
		typeof locator !== "object" ||
		locator === null ||
		Array.isArray(locator)
	) {
		return null;
	}
	const record = locator as Record<string, unknown>;
	if (
		record.kind !== "perplexity.thread" ||
		typeof record.slug !== "string" ||
		record.slug.length === 0
	) {
		return null;
	}
	const count = record.entry_count;
	const expected =
		count === null
			? null
			: typeof count === "number" && Number.isSafeInteger(count) && count >= 0
				? count
				: undefined;
	return { slug: record.slug, expected };
}

type GapEntry = BrowserCollectContext["detailGaps"][number];

/**
 * Hand every pending `messages` gap to `handle` once: the first page, then
 * further pages from the runtime until a page holds no gap not already
 * handled (the runtime answers with the gaps still pending, so recovered
 * ones drop out and one still pending comes back, already handled).
 */
async function forEachPendingGapPage(
	ctx: BrowserCollectContext,
	first: readonly GapEntry[],
	handle: (fresh: readonly GapEntry[]) => Promise<void>,
	seen: Set<string> = new Set(),
): Promise<void> {
	let page = first;
	for (;;) {
		const fresh = page.filter(
			(gap) =>
				gap.stream === "messages" &&
				typeof gap.record_key === "string" &&
				!seen.has(gap.gap_id),
		);
		for (const gap of fresh) {
			seen.add(gap.gap_id);
		}
		if (fresh.length > 0) {
			await handle(fresh);
		} else if (page !== first) {
			return;
		}
		if (typeof ctx.requestDetailGapPage !== "function") {
			return;
		}
		page = await ctx.requestDetailGapPage({ streams: ["messages"] });
	}
}

/**
 * A recovery-only run: every pending `messages` gap this connector wrote is
 * re-read from its locator, page by page, without walking the list. A
 * thread that now reads completely, and to at least the entry count its
 * locator recorded, gets its messages and a DETAIL_GAP_RECOVERED for each of
 * its pending gaps (an entry it still cannot read is reported unreadable
 * rather than kept pending); one that still fails, is still short or is
 * still being answered stays pending, and one whose locator has no count is
 * left to the forward walk. Nothing is
 * checkpointed here. Its conversation record was emitted by the run that
 * wrote the gap.
 */
async function recoverDetailGapsOnly(
	ctx: BrowserCollectContext,
	threadDelayMs: number,
): Promise<void> {
	let unreadableEntries = 0;
	await forEachPendingGapPage(ctx, startGaps(ctx), async (fresh) => {
		const gapsByThread = new Map<
			string,
			{ locator: ReturnType<typeof threadLocator>; gaps: PendingGap[] }
		>();
		for (const gap of fresh) {
			const key = gap.record_key as string;
			const entry = gapsByThread.get(key) ?? { locator: null, gaps: [] };
			entry.locator ??= threadLocator(gap.detail_locator);
			entry.gaps.push(pendingGap(gap));
			gapsByThread.set(key, entry);
		}
		for (const [conversationId, { locator, gaps }] of gapsByThread) {
			if (locator === null || locator.expected === undefined) {
				continue;
			}
			const read = await readThread(
				ctx.page,
				locator.slug,
				conversationId,
				locator.expected,
			);
			await politeDelay(threadDelayMs);
			// An answer still being written keeps the gap pending. An entry this
			// parser cannot read does not: only a connector upgrade can read it,
			// so it is reported as unreadable and the gap is closed.
			if (read.kind !== "read" || read.incomplete > 0) {
				continue;
			}
			for (const message of read.messages) {
				await ctx.emitRecord("messages", { ...message });
			}
			unreadableEntries += read.unreadable;
			for (const gap of gaps) {
				await ctx.emit(gapRecovered(gap, conversationId));
			}
		}
	});
	await reportUnreadable(ctx, unreadableEntries, 0);
}

/**
 * One SKIP_RESULT for everything in `messages` this connector version cannot
 * read: entries whose shape it does not know, and threads the list gave no
 * slug to read them by. Retrying cannot help, so the hint is a connector
 * upgrade, and the threads are not gapped (a gap would be retried forever).
 */
async function reportUnreadable(
	ctx: BrowserCollectContext,
	entries: number,
	threads: number,
): Promise<void> {
	if (entries === 0 && threads === 0) {
		return;
	}
	const parts = [
		...(entries > 0
			? [`${String(entries)} Perplexity answer(s) could not be read`]
			: []),
		...(threads > 0
			? [
					`${String(threads)} Perplexity thread(s) had no address to read them by`,
				]
			: []),
	];
	await ctx.emit({
		type: "SKIP_RESULT",
		stream: "messages",
		reason: "records_unreadable",
		message: `${parts.join(" and ")}, so they were skipped. Everything else was collected normally. A newer version of this connector may read them.`,
		recovery_hint: { ...RETRY_ON_CONNECTOR_UPGRADE },
	});
}

/**
 * The pending gaps START carried. Hosts that do not track gaps (the mobile
 * PageShim host) leave the field out, which means none.
 */
function startGaps(
	ctx: BrowserCollectContext,
): readonly BrowserCollectContext["detailGaps"][number][] {
	const gaps: unknown = (ctx as { detailGaps?: unknown }).detailGaps;
	return Array.isArray(gaps)
		? (gaps as BrowserCollectContext["detailGaps"][number][])
		: [];
}

/** A pending gap as START carried it: its id and, on a leased gap, the lease. */
interface PendingGap {
	readonly gapId: string;
	readonly leaseId?: string;
}

function pendingGap(
	gap: BrowserCollectContext["detailGaps"][number],
): PendingGap {
	const leaseId: unknown = (gap as { lease_id?: unknown }).lease_id;
	return typeof leaseId === "string" && leaseId.length > 0
		? { gapId: gap.gap_id, leaseId }
		: { gapId: gap.gap_id };
}

/** The receipt for a recovered gap; a leased gap's lease is echoed back. */
function gapRecovered(
	gap: PendingGap,
	conversationId: string,
): Parameters<BrowserCollectContext["emit"]>[0] {
	return {
		type: "DETAIL_GAP_RECOVERED",
		reference_only: true,
		gap_id: gap.gapId,
		...(gap.leaseId === undefined ? {} : { lease_id: gap.leaseId }),
		stream: "messages",
		record_key: conversationId,
	};
}

/** Pending `messages` gaps by thread, for the forward walk to resolve. */
function pendingGapsByThread(
	ctx: BrowserCollectContext,
): Map<string, PendingGap[]> {
	const pending = new Map<string, PendingGap[]>();
	for (const gap of startGaps(ctx)) {
		if (gap.stream === "messages" && typeof gap.record_key === "string") {
			pending.set(gap.record_key, [
				...(pending.get(gap.record_key) ?? []),
				pendingGap(gap),
			]);
		}
	}
	return pending;
}

export async function collectPerplexity(
	ctx: BrowserCollectContext,
	options: {
		threadDelayMs?: number;
		/** Test seam for the session re-reads; production uses the real clock. */
		delay?: (ms: number) => Promise<void>;
	} = {},
): Promise<void> {
	const threadDelayMs = options.threadDelayMs ?? THREAD_DELAY_MS;
	const delay = options.delay ?? realDelay;
	const wantsConversations = ctx.requested.has("conversations");
	const wantsMessages = ctx.requested.has("messages");
	if (!(wantsConversations || wantsMessages)) {
		await ctx.progress("No Perplexity streams were requested", {
			stream: "conversations",
		});
		return;
	}

	// 0. A recovery-only run re-reads pending gaps from their locators and
	// stops before any list fetch. An ordinary run resolves them in the
	// forward walk, where each thread is read against the list's entry count.
	if (ctx.recoveryOnly === true) {
		if (wantsMessages) {
			await recoverDetailGapsOnly(ctx, threadDelayMs);
		}
		return;
	}
	const pending = wantsMessages
		? pendingGapsByThread(ctx)
		: new Map<string, PendingGap[]>();

	// 1. The library list, proven complete and stable. `total_threads` is not
	// used: live list items carry a number unrelated to the library size. A
	// run whose every stream starts at a `since` may stop the walk once the
	// list is past it (`listCutoff`).
	const cutoff = listCutoff(ctx);
	const walk = await stableList(ctx, delay, cutoff);
	const { threads: listed, proven, truncated } = walk;
	// A row older than the cutoff selects nothing, readable or not.
	const unreadableThreads = unreadableInWindow(walk, cutoff);
	// What the last messages STATE remembered: creation times are reused
	// from it on any run, while skipping on it is for incremental runs.
	const { synced: stored, createTimes } = storedState(ctx);
	if (!proven) {
		// The threads seen are real and are kept, but nothing is checkpointed
		// and no thread is read in depth: both requested streams fail, and a
		// later run (with a library that holds still) can finish them.
		if (wantsConversations) {
			for (const thread of listed) {
				await ctx.emitRecord("conversations", {
					...conversationRecord(thread, createTimes.get(thread.id) ?? null),
				});
			}
		}
		const why =
			"Your Perplexity library kept changing while it was read, so this run could not confirm it saw every thread. Nothing was checkpointed; the next run reads it again.";
		for (const stream of ["conversations", "messages"] as const) {
			if (ctx.requested.has(stream)) {
				await failStream(ctx, stream, why, RETRY_BY_RUNTIME);
			}
		}
		return;
	}
	// A list row that cannot be keyed is a thread neither stream can account
	// for: both requested streams fail, and neither claims coverage or saves
	// a checkpoint, while every readable thread is still collected. Only a
	// connector that can read the row can account for it.
	const inventoryWhole = unreadableThreads === 0;
	if (!inventoryWhole) {
		for (const stream of ["conversations", "messages"] as const) {
			if (ctx.requested.has(stream)) {
				await failStream(
					ctx,
					stream,
					`${String(unreadableThreads)} Perplexity thread(s) could not be read from the library list and were skipped. Everything else was collected normally.`,
					RETRY_ON_CONNECTOR_UPGRADE,
				);
			}
		}
	}

	// 2. Per thread: read its detail first, then emit the conversation, then
	// its messages (or a gap), so a child never arrives before its parent.
	const previousSynced = previousSyncedThreads(ctx, stored);
	const selection = messagesSelection(ctx);
	const synced: Record<string, ThreadSync> = {};
	const hydrated: string[] = [];
	const skippedUnchanged: string[] = [];
	const outsideRange: string[] = [];
	const unreadableKeys: string[] = [];
	const slugless: string[] = [];
	const gapKeys: string[] = [];
	let incompleteEntries = 0;
	let unreadableEntries = 0;
	let threadsWithoutSlug = 0;
	let messagesRead = 0;

	for (const thread of listed) {
		const known = previousSynced.get(thread.id);
		const createTimeKnown = createTimes.get(thread.id) ?? null;
		if (!wantsMessages) {
			await ctx.emitRecord("conversations", {
				...conversationRecord(thread, createTimeKnown),
			});
			continue;
		}
		// Nothing of this thread can fall inside the messages time range, so
		// its detail is not read. A remembered state is kept as it was, also
		// on a full refresh: this run delivered nothing that could change it.
		if (outsideMessagesRange(thread, known, selection)) {
			outsideRange.push(thread.id);
			const kept = stored.get(thread.id);
			if (kept !== undefined) {
				synced[thread.id] = kept;
			}
			if (wantsConversations) {
				await ctx.emitRecord("conversations", {
					...conversationRecord(thread, createTimeKnown),
				});
			}
			continue;
		}
		if (
			known !== undefined &&
			isUnchanged(thread, known) &&
			windowCovers(known.window, selection) &&
			!pending.has(thread.id)
		) {
			synced[thread.id] = known;
			skippedUnchanged.push(thread.id);
			if (wantsConversations) {
				await ctx.emitRecord("conversations", {
					...conversationRecord(thread, known.create_time),
				});
			}
			continue;
		}

		let read: ThreadRead | null = null;
		if (thread.slug !== null) {
			read = await readThread(
				ctx.page,
				thread.slug,
				thread.id,
				thread.entryCount,
			);
			await politeDelay(threadDelayMs);
		}
		const createTime =
			(read?.kind === "read" ? read.createTime : null) ?? createTimeKnown;
		if (wantsConversations) {
			await ctx.emitRecord("conversations", {
				...conversationRecord(thread, createTime),
			});
		}
		// A thread the list gives no slug cannot be read by this connector:
		// reported once as unreadable, not gapped (a gap would never recover).
		// A gap already pending for it stays pending: closing it would claim
		// messages that were never read. (The profile has no terminal gap
		// outcome yet; that is a runtime ask.)
		if (read === null) {
			threadsWithoutSlug += 1;
			slugless.push(thread.id);
			connectorDiagnostic("perplexity", "thread_has_no_slug", {
				thread: thread.id,
			});
			continue;
		}
		if (read.kind === "read") {
			reportTrailingAnswer(thread, read.messages);
		}
		if (read.kind === "read" && read.incomplete === 0) {
			// Decided before the records go out, from the same gates the
			// runtime applies to them.
			const delivery = deliveryWindow(ctx, selection, read.messages);
			for (const message of read.messages) {
				await ctx.emitRecord("messages", { ...message });
			}
			messagesRead += read.messages.length;
			unreadableEntries += read.unreadable;
			if (read.unreadable > 0) {
				unreadableKeys.push(thread.id);
			} else {
				hydrated.push(thread.id);
			}
			if (
				delivery.remember &&
				thread.complete &&
				thread.updateTime !== null &&
				thread.entryCount !== null
			) {
				synced[thread.id] = {
					update_time: thread.updateTime,
					create_time: read.createTime,
					entry_count: thread.entryCount,
					complete: true,
					...(delivery.window === undefined ? {} : { window: delivery.window }),
					...(read.unreadable > 0
						? {
								unreadable_entries: read.unreadable,
								parser: ENTRY_PARSER_REVISION,
							}
						: {}),
				};
			}
			for (const gap of pending.get(thread.id) ?? []) {
				await ctx.emit(gapRecovered(gap, thread.id));
			}
			continue;
		}
		if (read.kind === "read") {
			// Its readable answers are kept; the thread is read again next run.
			for (const message of read.messages) {
				await ctx.emitRecord("messages", { ...message });
			}
			messagesRead += read.messages.length;
			incompleteEntries += read.incomplete;
			unreadableEntries += read.unreadable;
		}
		gapKeys.push(thread.id);
		const why =
			read.kind === "failed"
				? { class: "thread_detail_failed", message: bounded(read.message) }
				: { class: "answer_still_generating" };
		// Every key in gap_keys gets a DETAIL_GAP in this run, including one
		// whose gap is already pending from an earlier run: the commit gate
		// credits a gap key only against a gap emitted alongside it, and the
		// runtime folds a repeat into the existing pending gap.
		await emitDetailGap(ctx, {
			stream: "messages",
			parentStream: "conversations",
			recordKey: thread.id,
			reason: "temporary_unavailable",
			// The list's entry count travels with the gap, so a recovery-only
			// run can hold the thread to it instead of accepting a short read.
			locator: {
				kind: "perplexity.thread",
				slug: thread.slug,
				entry_count: thread.entryCount,
			},
			error: why,
		});
		connectorDiagnostic("perplexity", why.class, { thread: thread.id });
	}

	await reportUnreadable(ctx, unreadableEntries, threadsWithoutSlug);
	if (incompleteEntries > 0) {
		await ctx.progress(
			`${String(incompleteEntries)} Perplexity answer(s) were still being written and will be read next time`,
			{ stream: "messages" },
		);
	}
	if (messagesRead > 0) {
		await ctx.progress(`Read ${String(messagesRead)} Perplexity message(s)`, {
			stream: "messages",
		});
	}

	// Pending gaps beyond START's first page. A thread settled this run (read
	// completely, skipped as unchanged, or read with entries reported
	// unreadable) has its gaps acknowledged: an unchanged thread is
	// remembered only after a complete read, which can postdate a gap the
	// first page did not carry. A thread gapped again this run already
	// re-emitted its gap; one with no slug, not listed, or outside the time
	// range is left pending.
	const firstPage = startGaps(ctx);
	if (wantsMessages && pending.size > 0) {
		const settled = new Set([
			...hydrated,
			...skippedUnchanged,
			...unreadableKeys,
		]);
		await forEachPendingGapPage(
			ctx,
			[],
			async (fresh) => {
				for (const gap of fresh) {
					const key = gap.record_key as string;
					if (settled.has(key)) {
						await ctx.emit(gapRecovered(pendingGap(gap), key));
					}
				}
			},
			new Set(firstPage.map((gap) => gap.gap_id)),
		);
	}

	// 3. Prove the boundaries, then checkpoint. Reaching here means the list
	// walk ended on its own proof (its end, or the time range's cutoff) and
	// stayed stable; a list with a row that could not be keyed was reported
	// above and is not checkpointed.
	if (!inventoryWhole) {
		return;
	}
	if (wantsConversations) {
		await emitDetailCoverage(ctx, {
			stream: "conversations",
			stateStream: "conversations",
			requiredKeys: [],
			hydratedKeys: [],
			considered: listed.length,
			covered: listed.length,
		});
	}
	if (wantsMessages) {
		await emitDetailCoverage(ctx, {
			stream: "messages",
			stateStream: "conversations",
			requiredKeys: listed.map((thread) => thread.id),
			hydratedKeys: hydrated,
			optionalSkipKeys: [
				...skippedUnchanged,
				...outsideRange,
				...unreadableKeys,
				...slugless,
			],
			gapKeys,
			considered: listed.length,
			covered: hydrated.length + skippedUnchanged.length + outsideRange.length,
		});
		// A walk stopped at the cutoff never saw the older threads. What was
		// remembered about them still holds (a full refresh skips nothing on
		// it, but does not forget it), so it is carried forward; a walk that
		// reached the end drops threads no longer listed. A thread listed
		// this run is never carried: it was remembered above, or on purpose
		// not.
		if (truncated) {
			const listedIds = new Set(listed.map((thread) => thread.id));
			for (const [id, kept] of stored) {
				if (!listedIds.has(id)) {
					synced[id] = kept;
				}
			}
		}
		await ctx.emit({
			type: "STATE",
			stream: "messages",
			cursor: { v: SYNC_STATE_VERSION, synced } satisfies MessagesCursor,
		});
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "perplexity",
		validateRecord,
		retryablePattern:
			/perplexity_internal_api_(?:429|5\d\d)|perplexity_interrupted|fetch failed|network|timeout|aborted/i,
		browser: { profileName: "perplexity" },
		ensureSession: ensurePerplexitySession,
		probeSession: ({ page }) => hasPerplexitySession(page),
		probeSessionIsAuthoritative: true,
		collect: collectPerplexity,
	});
}

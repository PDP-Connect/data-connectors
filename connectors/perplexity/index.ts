#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Perplexity connector (v0.1.0).
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
 * Streams: `conversations` (one record per thread, mutable_state, cursor
 * `update_time`) and `messages` (the question and the answer of every entry,
 * append_only, child of `conversations`). The list walk must prove it ended
 * (an empty page, a short page, or the last item's `has_next_page: false`)
 * before either stream is reported complete. `total_threads` on list items
 * is NOT the library size (a live 4-thread account reported 99 on every
 * item), so nothing is cross-checked against it.
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

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	BrowserCollectContext,
	EnsureSessionArgs,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	emitDetailCoverage,
	emitDetailGap,
	politeDelay,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	conversationRecord,
	entryMessages,
	type ListedThread,
	parseListedThread,
	parseThreadDetailPage,
	parseThreadListPage,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { MessageRecord } from "./types.ts";

const ORIGIN = "https://www.perplexity.ai";
const HOME = `${ORIGIN}/`;
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

/** Headers the web app sends on these calls (observed, not invented). */
interface PageRequest {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly body?: string;
}

/** The `conversations` STATE cursor. */
interface ConversationsCursor {
	last_update_time: string | null;
}

/**
 * One thread's remembered detail state. A thread is remembered only after
 * every entry was complete and read; it is skipped next run only while its
 * update time (to the microsecond) and entry count are unchanged.
 */
interface ThreadSync {
	update_time: string | null;
	create_time: string | null;
	entry_count: number;
	complete: true;
}

/** The `messages` STATE cursor: one entry per listed thread. */
interface MessagesCursor {
	synced: Record<string, ThreadSync>;
}

// ─── session ─────────────────────────────────────────────────────────────

/**
 * Whether the page's own session is signed in: `GET /api/auth/session`
 * answers `{ user: {...} }` when it is and `{}` when it is not. Origin-strict,
 * so it is safe to run while the owner is part way through signing in.
 */
export async function probePerplexitySession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	try {
		return await page.evaluate(async () => {
			try {
				if (location.origin !== "https://www.perplexity.ai") {
					return false;
				}
				const response = await fetch("/api/auth/session", {
					credentials: "include",
				});
				if (!response.ok) {
					return false;
				}
				const payload: unknown = await response.json();
				if (
					typeof payload !== "object" ||
					payload === null ||
					Array.isArray(payload)
				) {
					return false;
				}
				const data = payload as Record<string, unknown>;
				return (
					typeof data.user === "object" &&
					data.user !== null &&
					!Array.isArray(data.user)
				);
			} catch {
				return false;
			}
		});
	} catch {
		return false;
	}
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

export async function ensurePerplexitySession(
	args: EnsureSessionArgs,
): Promise<void> {
	const { assist, capture, completeAssistance, page, sendInteraction } = args;
	if (await hasPerplexitySession(page)) {
		return;
	}
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to Perplexity in the secure browser (and complete its human check if one is shown), then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => hasPerplexitySession(page),
		readinessProbe: probePerplexitySession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) {
		throw new Error("perplexity_session_dead");
	}
}

// ─── same-origin fetch through the page ──────────────────────────────────

/**
 * One same-origin request from the signed-in page. The error message names
 * the class so the run fails the right way, and never carries a body:
 *   - `perplexity_auth_failed`: 401, or the page left perplexity.ai;
 *   - `perplexity_challenge`: 403, or a non-JSON answer (Cloudflare's check
 *     page). The session can still be valid while the browser is challenged;
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
			const type = response.headers.get("content-type") ?? "";
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
	return /perplexity_(?:auth_failed|challenge|internal_api_)/.test(message);
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

/** The later of two normalized instants. */
function later(
	current: string | null,
	candidate: string | null,
): string | null {
	if (candidate === null) {
		return current;
	}
	if (current === null) {
		return candidate;
	}
	return candidate > current ? candidate : current;
}

function bounded(message: string): string {
	return message.slice(0, 240);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface ListWalk {
	readonly threads: ListedThread[];
	readonly unreadable: number;
	/** List pages this walk requested; one page is a single atomic answer. */
	readonly pages: number;
}

/**
 * One pass over the library list. The walk ends only on an empty page or on
 * a last item that says `has_next_page: false`; a short page that says there
 * is more is followed. A thread seen twice (the list moved under the walk)
 * is kept once.
 */
async function walkList(ctx: BrowserCollectContext): Promise<ListWalk> {
	const threads: ListedThread[] = [];
	const seen = new Set<string>();
	let unreadable = 0;
	let offset = 0;
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
		for (const item of parsed.page.items) {
			const thread = parseListedThread(item);
			if (thread === null) {
				unreadable += 1;
			} else if (!seen.has(thread.id)) {
				seen.add(thread.id);
				threads.push(thread);
			}
		}
		if (parsed.page.items.length === 0 || !parsed.page.hasNextPage) {
			return { threads, unreadable, pages: pageIndex + 1 };
		}
		offset += parsed.page.items.length;
	}
}

/**
 * The set of thread ids a walk saw, order-insensitive. Update times are left
 * out on purpose: a thread answered between walks changes its time but not
 * the membership the walk has to prove.
 */
function walkSignature(walk: ListWalk): string {
	return walk.threads
		.map((thread) => thread.id)
		.sort()
		.join("|");
}

/**
 * The library list, proven stable. The list is ordered by recent activity
 * and paged by offset, so a thread answered while the walk runs moves to the
 * top and can shift another past the walk unseen. One page is atomic; a
 * walk that needed more than one page is repeated until two consecutive
 * walks see the same threads, or the run fails without a checkpoint.
 */
async function stableList(ctx: BrowserCollectContext): Promise<ListWalk> {
	let walk = await walkList(ctx);
	if (walk.pages <= 1) {
		return walk;
	}
	for (let attempt = 0; attempt < MAX_LIST_WALKS; attempt += 1) {
		const again = await walkList(ctx);
		if (walkSignature(again) === walkSignature(walk)) {
			return again;
		}
		walk = again;
	}
	throw new Error(
		"perplexity_list_unstable: the library kept changing while it was read",
	);
}

/** A remembered thread, read defensively from a prior STATE. */
function readThreadSync(value: unknown): ThreadSync | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	const text = (field: unknown): string | null =>
		typeof field === "string" ? field : null;
	if (
		record.complete !== true ||
		typeof record.update_time !== "string" ||
		typeof record.entry_count !== "number"
	) {
		return null;
	}
	return {
		update_time: record.update_time,
		create_time: text(record.create_time),
		entry_count: record.entry_count,
		complete: true,
	};
}

function previousSyncedThreads(
	ctx: BrowserCollectContext,
): Map<string, ThreadSync> {
	const synced = new Map<string, ThreadSync>();
	if (ctx.collectionMode === "full_refresh") {
		return synced;
	}
	const cursor = ctx.state.messages;
	const raw =
		typeof cursor === "object" && cursor !== null && !Array.isArray(cursor)
			? (cursor as Record<string, unknown>).synced
			: undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return synced;
	}
	for (const [id, value] of Object.entries(raw)) {
		const sync = readThreadSync(value);
		if (sync !== null) {
			synced.set(id, sync);
		}
	}
	return synced;
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

function threadLocatorSlug(locator: unknown): string | null {
	if (
		typeof locator !== "object" ||
		locator === null ||
		Array.isArray(locator)
	) {
		return null;
	}
	const record = locator as Record<string, unknown>;
	return record.kind === "perplexity.thread" &&
		typeof record.slug === "string" &&
		record.slug.length > 0
		? record.slug
		: null;
}

/**
 * A recovery-only run: every pending `messages` gap this connector wrote is
 * re-read from its locator, without walking the list. A thread that now reads
 * completely gets its messages and a DETAIL_GAP_RECOVERED for each of its
 * pending gaps; one that still fails stays pending. Nothing is checkpointed
 * here, so the next ordinary run still reads the thread in full against the
 * list's entry count before remembering it. Its conversation record was
 * emitted by the run that wrote the gap.
 */
async function recoverDetailGapsOnly(
	ctx: BrowserCollectContext,
	threadDelayMs: number,
): Promise<void> {
	const gapsByThread = new Map<
		string,
		{ slug: string | null; gapIds: string[] }
	>();
	for (const gap of ctx.detailGaps) {
		if (gap.stream !== "messages" || typeof gap.record_key !== "string") {
			continue;
		}
		const entry = gapsByThread.get(gap.record_key) ?? {
			slug: null,
			gapIds: [],
		};
		entry.slug ??= threadLocatorSlug(gap.detail_locator);
		entry.gapIds.push(gap.gap_id);
		gapsByThread.set(gap.record_key, entry);
	}
	for (const [conversationId, { slug, gapIds }] of gapsByThread) {
		if (slug === null) {
			continue;
		}
		const read = await readThread(ctx.page, slug, conversationId, null);
		await politeDelay(threadDelayMs);
		if (read.kind !== "read" || !read.complete) {
			continue;
		}
		for (const message of read.messages) {
			await ctx.emitRecord("messages", { ...message });
		}
		for (const gapId of gapIds) {
			await ctx.emit({
				type: "DETAIL_GAP_RECOVERED",
				reference_only: true,
				gap_id: gapId,
				stream: "messages",
				record_key: conversationId,
			});
		}
	}
}

/** Pending `messages` gap ids by thread, for the forward walk to resolve. */
function pendingGapsByThread(
	ctx: BrowserCollectContext,
): Map<string, string[]> {
	const pending = new Map<string, string[]>();
	for (const gap of ctx.detailGaps) {
		if (gap.stream === "messages" && typeof gap.record_key === "string") {
			pending.set(gap.record_key, [
				...(pending.get(gap.record_key) ?? []),
				gap.gap_id,
			]);
		}
	}
	return pending;
}

export async function collectPerplexity(
	ctx: BrowserCollectContext,
	options: { threadDelayMs?: number } = {},
): Promise<void> {
	const threadDelayMs = options.threadDelayMs ?? THREAD_DELAY_MS;
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
		: new Map<string, string[]>();

	// 1. The library list, proven complete and stable. `total_threads` is not
	// used: live list items carry a number unrelated to the library size.
	const { threads: listed, unreadable: unreadableThreads } =
		await stableList(ctx);
	if (unreadableThreads > 0) {
		await ctx.reportStreamFailure?.(
			"conversations",
			`${String(unreadableThreads)} Perplexity thread(s) could not be read from the library list and were skipped. Everything else was collected normally.`,
			{ retryable: false },
		);
	}

	// 2. Per thread: read its detail first, then emit the conversation, then
	// its messages (or a gap), so a child never arrives before its parent.
	const previousSynced = previousSyncedThreads(ctx);
	const synced: Record<string, ThreadSync> = {};
	const hydrated: string[] = [];
	const skippedUnchanged: string[] = [];
	const gapKeys: string[] = [];
	let incompleteEntries = 0;
	let unreadableEntries = 0;
	let messagesRead = 0;

	for (const thread of listed) {
		const known = previousSynced.get(thread.id);
		const unchanged =
			wantsMessages &&
			known !== undefined &&
			thread.complete &&
			thread.updateTime !== null &&
			known.update_time === thread.updateTime &&
			known.entry_count === thread.entryCount &&
			!pending.has(thread.id);
		if (unchanged) {
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
		if (wantsMessages && thread.slug !== null) {
			read = await readThread(
				ctx.page,
				thread.slug,
				thread.id,
				thread.entryCount,
			);
			await politeDelay(threadDelayMs);
		}
		const createTime =
			(read?.kind === "read" ? read.createTime : null) ??
			known?.create_time ??
			null;
		if (wantsConversations) {
			await ctx.emitRecord("conversations", {
				...conversationRecord(thread, createTime),
			});
		}
		if (!wantsMessages) {
			continue;
		}
		if (read?.kind === "read") {
			for (const message of read.messages) {
				await ctx.emitRecord("messages", { ...message });
			}
			messagesRead += read.messages.length;
			incompleteEntries += read.incomplete;
			unreadableEntries += read.unreadable;
		}
		if (read?.kind === "read" && read.complete) {
			hydrated.push(thread.id);
			if (
				thread.complete &&
				thread.updateTime !== null &&
				thread.entryCount !== null
			) {
				synced[thread.id] = {
					update_time: thread.updateTime,
					create_time: read.createTime,
					entry_count: thread.entryCount,
					complete: true,
				};
			}
			for (const gapId of pending.get(thread.id) ?? []) {
				await ctx.emit({
					type: "DETAIL_GAP_RECOVERED",
					reference_only: true,
					gap_id: gapId,
					stream: "messages",
					record_key: thread.id,
				});
			}
			continue;
		}
		gapKeys.push(thread.id);
		const why =
			read === null
				? { class: "thread_has_no_slug" }
				: read.kind === "failed"
					? { class: "thread_detail_failed", message: bounded(read.message) }
					: read.incomplete > 0
						? { class: "answer_still_generating" }
						: { class: "entry_unreadable" };
		if (!pending.has(thread.id)) {
			await emitDetailGap(ctx, {
				stream: "messages",
				parentStream: "conversations",
				recordKey: thread.id,
				reason: "temporary_unavailable",
				locator: { kind: "perplexity.thread", slug: thread.slug },
				error: why,
			});
		}
		connectorDiagnostic("perplexity", why.class, { thread: thread.id });
	}

	if (unreadableEntries > 0) {
		await ctx.reportStreamFailure?.(
			"messages",
			`${String(unreadableEntries)} Perplexity answer(s) could not be read safely and were not stored. Everything else was collected normally.`,
			{ retryable: false },
		);
	}
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

	// 3. Prove the boundaries, then checkpoint. Reaching here means the list
	// walk ended on its own proof and stayed stable.
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
			optionalSkipKeys: skippedUnchanged,
			gapKeys,
			considered: listed.length,
			covered: hydrated.length + skippedUnchanged.length,
		});
		await ctx.emit({
			type: "STATE",
			stream: "messages",
			cursor: { synced } satisfies MessagesCursor,
		});
	}
	if (wantsConversations) {
		let lastUpdateTime: string | null = null;
		for (const thread of listed) {
			lastUpdateTime = later(lastUpdateTime, thread.updateTime);
		}
		await ctx.emit({
			type: "STATE",
			stream: "conversations",
			cursor: {
				last_update_time: lastUpdateTime,
			} satisfies ConversationsCursor,
		});
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "perplexity",
		validateRecord,
		retryablePattern:
			/perplexity_internal_api_(?:429|5\d\d)|fetch failed|network|timeout|aborted/i,
		browser: { profileName: "perplexity" },
		ensureSession: ensurePerplexitySession,
		probeSession: ({ page }) => hasPerplexitySession(page),
		probeSessionIsAuthoritative: true,
		collect: collectPerplexity,
	});
}

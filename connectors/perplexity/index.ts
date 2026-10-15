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
 * (an empty page, a short page, or `has_next_page: false`) before either
 * stream is reported complete, and the walk is cross-checked against the
 * `total_threads` the list itself reports.
 *
 * Tested surfaces (as of 2026-10-12, from the live recon notes):
 *   - a small Pro-tier library; threads with one entry each
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

/** Headers the web app sends on these calls (observed, not invented). */
interface PageRequest {
	readonly method: "GET" | "POST";
	readonly url: string;
	readonly body?: string;
}

/** The `conversations` STATE cursor. */
interface ConversationsCursor {
	last_update_time: string | null;
	total_threads: number | null;
}

/** One thread's remembered detail state, so unchanged threads can be skipped. */
interface ThreadSync {
	update_time: string | null;
	create_time: string | null;
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
 * One same-origin request from the signed-in page. Fails loudly on the two
 * boundaries that matter: a dead session (401/403 or the wrong origin) and
 * an upstream error, which the runtime classifies by message.
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
			if (response.status === 401 || response.status === 403) {
				throw new Error("perplexity_auth_failed");
			}
			if (!response.ok) {
				throw new Error(`perplexity_internal_api_${response.status}`);
			}
			return await response.text();
		} finally {
			clearTimeout(timeout);
		}
	}, request);
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

/** Every entry of one thread, all pages, oldest first. */
async function fetchThreadEntries(
	page: BrowserCollectContext["page"],
	slug: string,
): Promise<unknown[]> {
	const entries: unknown[] = [];
	let offset = 0;
	for (let pageIndex = 0; ; pageIndex += 1) {
		if (pageIndex >= MAX_THREAD_PAGES) {
			throw new Error(
				"perplexity_thread_unreadable: entries kept claiming another page",
			);
		}
		const body = await fetchThreadPage(page, slug, offset);
		const parsed = parseThreadDetailPage(body);
		if (!parsed.ok) {
			throw new Error(`perplexity_thread_unreadable: ${parsed.message}`);
		}
		entries.push(...parsed.page.entries);
		if (
			parsed.page.entries.length < ENTRY_PAGE_SIZE ||
			!parsed.page.hasNextPage
		) {
			return entries;
		}
		const next = offset + parsed.page.entries.length;
		if (next <= offset) {
			throw new Error(
				"perplexity_thread_unreadable: an entries page made no progress",
			);
		}
		offset = next;
	}
}

// ─── collection ──────────────────────────────────────────────────────────

/** The earlier of two normalized instants (`YYYY-MM-DDTHH:MM:SSZ` sorts by time). */
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

	// 1. The library list, paged by offset until it proves it ended.
	const listed: ListedThread[] = [];
	let unreadableThreads = 0;
	let totalThreads: number | null = null;
	let offset = 0;
	for (let pageIndex = 0; ; pageIndex += 1) {
		if (pageIndex >= MAX_LIST_PAGES) {
			throw new Error(
				"perplexity_source_unreadable: the thread list kept claiming another page",
			);
		}
		await ctx.progress(
			`Reading your Perplexity library (threads ${offset + 1} onward)`,
			{ stream: "conversations" },
		);
		const parsed = parseThreadListPage(await fetchListPage(ctx.page, offset));
		if (!parsed.ok) {
			throw new Error(`perplexity_source_unreadable: ${parsed.message}`);
		}
		for (const item of parsed.page.items) {
			const thread = parseListedThread(item);
			if (thread === null) {
				unreadableThreads += 1;
				continue;
			}
			listed.push(thread);
		}
		totalThreads = parsed.page.totalThreads ?? totalThreads;
		if (parsed.page.items.length < PAGE_SIZE || !parsed.page.hasNextPage) {
			break;
		}
		offset += parsed.page.items.length;
	}

	// 2. Cross-check the walk against the count the list itself reports, and
	// never report success with zero threads when the list said there were.
	const counted = listed.length + unreadableThreads;
	if (totalThreads !== null && counted !== totalThreads) {
		throw new Error(
			`perplexity_list_incomplete: the walk accounted for ${counted} thread(s) but the library reports ${totalThreads}`,
		);
	}
	if (totalThreads !== null && totalThreads > 0 && listed.length === 0) {
		throw new Error(
			"perplexity_list_unreadable: the library reports threads but none could be read",
		);
	}
	if (unreadableThreads > 0) {
		await ctx.reportStreamFailure?.(
			"conversations",
			`${unreadableThreads} Perplexity thread(s) could not be read from the library list and were skipped. Everything else was collected normally.`,
			{ retryable: false },
		);
	}

	// 3. Per thread: the detail read that fills create_time and the messages.
	const fullRefresh = ctx.collectionMode === "full_refresh";
	const previousState = ctx.state.messages as MessagesCursor | undefined;
	const previousSynced = fullRefresh ? {} : (previousState?.synced ?? {});
	const synced: Record<string, ThreadSync> = {};
	const hydrated: string[] = [];
	const skippedUnchanged: string[] = [];
	const gapKeys: string[] = [];
	let unreadableEntries = 0;
	let messagesRead = 0;

	for (const thread of listed) {
		// An unchanged thread whose entries are already complete is skipped;
		// its remembered create_time keeps the conversation record whole.
		const known = previousSynced[thread.id];
		if (
			wantsMessages &&
			known !== undefined &&
			thread.updateTime !== null &&
			(known.update_time ?? "") >= thread.updateTime
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

		let createTime: string | null = null;
		if (wantsMessages && thread.slug !== null) {
			try {
				const entries = await fetchThreadEntries(ctx.page, thread.slug);
				for (const entryValue of entries) {
					const parsed = entryMessages(entryValue, thread.id);
					if (parsed === null) {
						unreadableEntries += 1;
						continue;
					}
					await ctx.emitRecord("messages", { ...parsed.user });
					await ctx.emitRecord("messages", { ...parsed.assistant });
					messagesRead += 2;
					createTime = earlier(createTime, parsed.firstCreateTime);
				}
				hydrated.push(thread.id);
				synced[thread.id] = {
					update_time: thread.updateTime,
					create_time: createTime,
				};
				await politeDelay(threadDelayMs);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("perplexity_auth_failed")) {
					throw error;
				}
				gapKeys.push(thread.id);
				if (wantsMessages) {
					await emitDetailGap(ctx, {
						stream: "messages",
						parentStream: "conversations",
						recordKey: thread.id,
						reason: "temporary_unavailable",
						locator: { kind: "perplexity.thread", slug: thread.slug },
						error: { class: "thread_detail_failed", message: bounded(message) },
					});
				}
				connectorDiagnostic("perplexity", "thread_detail_failed", {
					thread: thread.id,
					detail: bounded(message),
				});
			}
		} else if (wantsMessages) {
			gapKeys.push(thread.id);
			await emitDetailGap(ctx, {
				stream: "messages",
				parentStream: "conversations",
				recordKey: thread.id,
				reason: "temporary_unavailable",
				locator: { kind: "perplexity.thread", slug: null },
				error: { class: "thread_has_no_slug" },
			});
		}

		if (wantsConversations) {
			await ctx.emitRecord("conversations", {
				...conversationRecord(thread, createTime ?? known?.create_time ?? null),
			});
		}
	}

	if (unreadableEntries > 0) {
		await ctx.reportStreamFailure?.(
			"messages",
			`${unreadableEntries} Perplexity answer group(s) could not be read and were skipped. Everything else was collected normally.`,
			{ retryable: false },
		);
	}
	if (messagesRead > 0) {
		await ctx.progress(`Read ${messagesRead} Perplexity message(s)`, {
			stream: "messages",
		});
	}

	// 4. Prove the boundaries, then checkpoint. The list walk ended above or
	// the run is already failing, so reaching here means the walk completed.
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
				total_threads: totalThreads,
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

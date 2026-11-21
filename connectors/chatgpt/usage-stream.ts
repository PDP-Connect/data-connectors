// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collection for the text-free usage streams: `account_profile` and
 * `usage_summary` (one record each). Nothing per conversation is emitted.
 * See usage.ts for the privacy contract: every read below goes through
 * `chatGptUsageFetchInBrowser`, which reduces the body inside the page, so no
 * text reaches the connector process.
 *
 * Request plan for a default run (both streams):
 *
 *   In parallel from the start:
 *   - /gizmos/snorlax/sidebar (cursor pages): one walk shared by the
 *     profile's project counts and the project conversation listing.
 *   - account_profile: /me, /accounts/check, /settings/beta_features,
 *     /user_system_messages, /memories, /tasks (cursor pages to source end),
 *     /cdn-cgi/trace. Each source is optional: a failure leaves its fields
 *     null and is named in `source_status`.
 *   - Conversation list: `/conversations?offset=N&limit=100&order=updated`,
 *     then the same with `&is_archived=true`, plus `/shared_conversations`
 *     for the shared count. The list response's `total` is not reliable,
 *     so a pass stops at the first page with fewer than 100 items.
 *   - Project conversations, which `/conversations` omits (verified live):
 *     `/gizmos/{id}/conversations?cursor=0`, then `?cursor=<cursor>` until
 *     none, per sidebar project (~10 items per page). Unioned with the main
 *     list by id. A failing project is counted in
 *     `usage_summary.coverage.project_listing`, not fatal. Cursor walks continue
 *     to source end, subject to the run wall-clock budget.
 *   List, project and detail requests share one limiter: at most 4 in flight.
 *
 *   Then detail, `/conversations/batch` (10 ids per request, up to 3 in
 *   flight) with a `/conversation/{id}` fallback, for this run's SAMPLE: the
 *   30 most recently updated conversations. Everything in usage_summary
 *   except `detail_sample` comes from list fields of every conversation and
 *   is exact; `detail_sample` (message counts, model mix, feature use) is
 *   labelled as sample-based with its window. `PDPP_CHATGPT_USAGE_DETAIL`
 *   (an integer, or 0/`none`) changes the sample size for development; the
 *   Vana CLI strips PDPP_* variables.
 *
 *   Owner account (live): ~13 main-list pages (+ up to 3 empty pages in
 *   flight when the short page lands), 1 archived page, 1 shares page, ~51
 *   project pages over 11 projects, 1-2 sidebar pages, 3 batch reads and 7
 *   other profile reads: ~80 requests, ~40 s end to end in the CLI.
 *
 * STATE is one fingerprint per stream record, so an unchanged record is not
 * re-emitted on a host that persists STATE.
 */

import type {
	CollectContext,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildFullScanCoverageMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import type { StreamDeps } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptFetchResult } from "./types.ts";
import {
	type AccountProfileSource,
	buildAccountProfileRecord,
	buildUsageSummaryRecord,
	type ChatGptUsageProjection,
	type ConversationListPage,
	type ConversationUsageProjection,
	type DetailStatus,
	lastActivityOf,
	mergeListItems,
	type ProfileSourceStatus,
	readClientContext,
	readConversationListPage,
	readConversationUsageProjection,
	type UsageListItem,
	type UsageSummaryConversation,
} from "./usage.ts";

export const USAGE_STREAMS = ["account_profile", "usage_summary"] as const;

/** Dev override for the detail sample size: an integer; 0 or `none` reads no detail. */
export const CHATGPT_USAGE_DETAIL_ENV = "PDPP_CHATGPT_USAGE_DETAIL";
/** Set by hosts that never persist STATE (PageShim): emit without fingerprints. */
export const CHATGPT_USAGE_STATELESS_ENV = "PDPP_CHATGPT_USAGE_STATELESS";

// Progress guard against endless fresh cursors, not a listing-size limit.
const NO_PROGRESS_PAGE_GUARD = 16;

export const DEFAULT_DETAIL_SAMPLE = 30;
export const LIST_PAGE_LIMIT = 100;
const LIST_WORKERS = 4;
const REQUESTS_IN_FLIGHT = 4;
const DETAIL_BATCH_SIZE = 10;
const DETAIL_WORKERS = 3;
const SHARED_PAGE_LIMIT = 100;

export type UsageFetchErrorClass = "auth" | "forbidden" | "deferred" | "other";

export interface UsageStreamHooks {
	classifyError: (err: unknown) => UsageFetchErrorClass;
	/** The accounts/check path the account_plan stream reads. */
	accountsCheckPath: string;
	/** Clock seam (epoch ms) for tenure; defaults to Date.now. */
	now?: () => number;
}

export interface UsageDetailPlan {
	/** How many of the most recently updated conversations to read in detail. */
	size: number;
}

export function resolveUsageDetailPlan(
	env: NodeJS.ProcessEnv = process.env,
): UsageDetailPlan {
	const raw = env[CHATGPT_USAGE_DETAIL_ENV]?.trim().toLowerCase();
	if (raw === "none" || raw === "0") return { size: 0 };
	const n = raw ? Number(raw) : Number.NaN;
	return {
		size: Number.isInteger(n) && n > 0 && n <= 500 ? n : DEFAULT_DETAIL_SAMPLE,
	};
}

// ─── Request plumbing ──────────────────────────────────────────────────

type Projected =
	| { kind: "ok"; json: unknown }
	| { kind: "status"; status: number }
	| { kind: "error"; cls: UsageFetchErrorClass; err: unknown };

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** At most `n` calls in flight; a finished call hands its slot to the next waiter. */
export function createLimiter(n: number): Limiter {
	let active = 0;
	const waiting: Array<() => void> = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (active < n) active += 1;
		else await new Promise<void>((resolve) => waiting.push(resolve));
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else active -= 1;
		}
	};
}

async function fetchProjected(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	path: string,
	projection: ChatGptUsageProjection,
	opts: { method?: string; body?: unknown } = {},
): Promise<Projected> {
	let res: ChatGptFetchResult;
	try {
		res = await deps.api.fetch(path, { ...opts, projection });
	} catch (err) {
		const cls = hooks.classifyError(err);
		if (cls === "auth") throw err;
		return { kind: "error", cls, err };
	}
	if (res.status !== 200) return { kind: "status", status: res.status };
	return { kind: "ok", json: res.json };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function sourceStatusOf(r: Projected): ProfileSourceStatus {
	if (r.kind === "ok") return isRecord(r.json) ? "ok" : "failed";
	if (r.kind === "status")
		return r.status === 403 || r.status === 404 ? "not_available" : "failed";
	return r.cls === "forbidden" ? "not_available" : "failed";
}

function isUnavailable(r: Projected): boolean {
	return (
		(r.kind === "status" &&
			(r.status === 403 || r.status === 404 || r.status === 422)) ||
		(r.kind === "error" && r.cls === "forbidden")
	);
}

// ─── Conversation list ────────────────────────────────────────────────

type ListOutcome =
	| "complete"
	| "not_available"
	| "capped"
	| "deferred"
	| "parse_error"
	| "failed";

interface ListPass {
	items: UsageListItem[];
	pages: number;
	outcome: ListOutcome;
}

/**
 * Walk one `/conversations` listing with up to LIST_WORKERS pages in flight.
 * The provider's `total` is not trusted: the walk ends at the first page that
 * returns fewer than LIST_PAGE_LIMIT items. A failed page before that point
 * makes the pass incomplete; failures on pages past the end are ignored.
 */
export async function walkConversationList(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	limit: Limiter,
	opts: { archived: boolean; workers?: number },
): Promise<ListPass> {
	const pages = new Map<number, ConversationListPage>();
	const failures = new Map<number, ListOutcome>();
	const seenIds = new Set<string>();
	let checkedThrough = 0;
	let next = 0;
	let endAt = Number.POSITIVE_INFINITY;
	let wallClockStop = false;
	const firstFailure = (): number =>
		failures.size > 0 ? Math.min(...failures.keys()) : Number.POSITIVE_INFINITY;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next;
			if (i > endAt || i >= firstFailure()) return;
			if (deps.runBudget?.reason() === "max_wall_clock") {
				wallClockStop = true;
				return;
			}
			next += 1;
			const path = `/conversations?offset=${i * LIST_PAGE_LIMIT}&limit=${LIST_PAGE_LIMIT}&order=updated${opts.archived ? "&is_archived=true" : ""}`;
			const r = await limit(() =>
				fetchProjected(deps, hooks, path, "conversation_list"),
			);
			const page = r.kind === "ok" ? readConversationListPage(r.json) : null;
			if (!page) {
				failures.set(
					i,
					i === 0 && isUnavailable(r)
						? "not_available"
						: r.kind === "error" && r.cls === "deferred"
							? "deferred"
							: r.kind === "ok"
								? "parse_error"
								: "failed",
				);
				continue;
			}
			pages.set(i, page);
			if (page.raw_count < LIST_PAGE_LIMIT) endAt = Math.min(endAt, i);
			// Replies may arrive out of order. Only earlier page indexes can
			// establish that a full page contains no new conversation ids.
			while (checkedThrough <= endAt && checkedThrough < firstFailure()) {
				const ready = pages.get(checkedThrough);
				if (!ready) break;
				const before = seenIds.size;
				for (const item of ready.items) seenIds.add(item.id);
				if (ready.raw_count === LIST_PAGE_LIMIT && seenIds.size === before) {
					failures.set(checkedThrough, "failed");
					break;
				}
				checkedThrough += 1;
			}
		}
	};
	await Promise.all(
		Array.from({ length: opts.workers ?? LIST_WORKERS }, () => worker()),
	);
	const failedAt = firstFailure();
	const ordered: ConversationListPage[] = [];
	for (let i = 0; i <= Math.min(endAt, failedAt - 1); i++) {
		const page = pages.get(i);
		if (!page) break;
		ordered.push(page);
	}
	// Pages overlap when conversations move during the walk; merge copies.
	const byId = new Map<string, UsageListItem>();
	for (const page of ordered) {
		for (const item of page.items) {
			const seen = byId.get(item.id);
			byId.set(item.id, seen ? mergeListItems(seen, item) : item);
		}
	}
	const items = [...byId.values()];
	const outcome: ListOutcome =
		failedAt <= endAt
			? (failures.get(failedAt) ?? "failed")
			: endAt !== Number.POSITIVE_INFINITY
				? "complete"
				: wallClockStop
					? "deferred"
					: "capped";
	return { items, pages: pages.size, outcome };
}

interface ProjectPass {
	items: UsageListItem[];
	sidebar: ProfileSourceStatus;
	projects: number;
	pages: number;
	failed: number;
	/** True when an explicit caller budget left projects or pages unread. */
	truncated: boolean;
}

/**
 * A page ends when it says so: has_more false, or no has_more and no cursor.
 * A fresh cursor is followed even for an empty page or one without has_more;
 * has_more true with no cursor is partial. A cursor already used is partial
 * whatever the page added: an echo or a loop does not prove the end. Callers
 * separately guard consecutive fresh-cursor pages that add no items.
 */
export function nextCursorStep(
	j: Record<string, unknown>,
	seen: ReadonlySet<string>,
	_current: string | null,
	_pageItems: number,
	_newItems: number,
): { next: string } | { done: "ok" | "partial" } {
	const next =
		typeof j.cursor === "string"
			? j.cursor
			: typeof j.cursor === "number"
				? String(j.cursor)
				: null;
	if (j.has_more === false) return { done: "ok" };
	if (next === null) return { done: j.has_more === true ? "partial" : "ok" };
	if (seen.has(next)) return { done: "partial" };
	return { next };
}

/**
 * List the conversations of every project named by the sidebar. Verified
 * live: `/conversations` omits project conversations (111 of 1,335 on one
 * account), while `/gizmos/{id}/conversations?cursor=0`, followed by
 * `?cursor=<cursor>` until none is returned, lists them (~10 per page).
 * Items are reduced in the page like the main list. A project whose walk
 * fails counts in `failed`; its pages read so far are kept. By default all
 * projects and cursor pages are read. Explicit caller budgets are optional;
 * reaching one sets `truncated`. Cursor guards and the run clock still apply.
 */
export async function walkProjectConversations(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	limit: Limiter,
	sidebar: PagedRead,
	budget: { maxProjects: number; maxPages: number } = {
		maxProjects: Number.POSITIVE_INFINITY,
		maxPages: Number.POSITIVE_INFINITY,
	},
): Promise<ProjectPass> {
	const all = sidebar.value?.project_ids ?? [];
	const ids = all.slice(0, budget.maxProjects);
	let truncated = all.length > ids.length;
	let pages = 0;
	let claimed = 0;
	let failed = 0;
	// Copies of one conversation across projects or pages merge field by field.
	const byId = new Map<string, UsageListItem>();
	const walkOne = async (projectId: string): Promise<void> => {
		const seenCursors = new Set<string>();
		let cursor = "0";
		let noProgressPages = 0;
		for (;;) {
			if (deps.runBudget?.reason() === "max_wall_clock") {
				failed += 1;
				return;
			}
			if (claimed >= budget.maxPages) {
				truncated = true;
				return;
			}
			claimed += 1;
			seenCursors.add(cursor);
			const path = `/gizmos/${encodeURIComponent(projectId)}/conversations?cursor=${encodeURIComponent(cursor)}`;
			const r = await limit(() =>
				fetchProjected(deps, hooks, path, "conversation_list"),
			);
			const parsed = r.kind === "ok" ? readConversationListPage(r.json) : null;
			if (!parsed) {
				failed += 1;
				return;
			}
			pages += 1;
			let added = 0;
			for (const raw of parsed.items) {
				// The project itself is the gizmo when the item does not say so.
				const c =
					raw.gizmo_id || raw.template_id
						? raw
						: { ...raw, gizmo_id: projectId };
				const seen = byId.get(c.id);
				if (!seen) added += 1;
				byId.set(c.id, seen ? mergeListItems(seen, c) : c);
			}
			const step = nextCursorStep(
				r.kind === "ok" && isRecord(r.json) ? r.json : {},
				seenCursors,
				cursor,
				parsed.raw_count,
				added,
			);
			if ("done" in step) {
				if (step.done === "partial") failed += 1;
				return;
			}
			noProgressPages = added === 0 ? noProgressPages + 1 : 0;
			if (noProgressPages > NO_PROGRESS_PAGE_GUARD) {
				failed += 1;
				return;
			}
			cursor = step.next;
		}
	};
	await Promise.all(ids.map((id) => walkOne(id)));
	return {
		items: [...byId.values()],
		sidebar: sidebar.status,
		projects: ids.length,
		pages,
		failed,
		truncated,
	};
}

async function readSharedIds(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	limit: Limiter,
): Promise<{ ids: Set<string> | null; partial: boolean }> {
	const ids = new Set<string>();
	let initialTotal: number | null = null;
	for (let page = 0; ; page += 1) {
		const r = await limit(() =>
			fetchProjected(
				deps,
				hooks,
				`/shared_conversations?offset=${page * SHARED_PAGE_LIMIT}&limit=${SHARED_PAGE_LIMIT}&order=created`,
				"shared_conversation_ids",
			),
		);
		if (r.kind === "status" && r.status === 404 && page === 0)
			return { ids, partial: false };
		if (r.kind !== "ok") return { ids: null, partial: page > 0 };
		const j = r.json as { items?: unknown; total?: unknown } | null;
		const items = Array.isArray(j?.items) ? j.items : null;
		if (!items) return { ids: null, partial: page > 0 };
		const rawTotal = j?.total;
		const total =
			typeof rawTotal === "number" &&
			Number.isSafeInteger(rawTotal) &&
			rawTotal >= 0
				? rawTotal
				: null;
		if (page === 0) initialTotal = total;
		else if (total !== initialTotal) return { ids: null, partial: true };
		if (items.length === 0) {
			return initialTotal === null || ids.size === initialTotal
				? { ids, partial: false }
				: { ids: null, partial: true };
		}
		const before = ids.size;
		for (const item of items) {
			const id = (item as { conversation_id?: unknown } | null)
				?.conversation_id;
			if (typeof id === "string") ids.add(id);
		}
		if (ids.size === before) return { ids: null, partial: true };
		if (initialTotal !== null && ids.size === initialTotal)
			return { ids, partial: false };
	}
}

// ─── Detail ───────────────────────────────────────────────────────────

/**
 * The projection of `raw` when it is the detail of conversation `id`: the
 * same id and a message tree. Any other 200 body (an error object, another
 * conversation, no mapping) is not a read; counting it would add an empty
 * conversation to the sample.
 */
function readDetailOf(
	raw: unknown,
	id: string,
): ConversationUsageProjection | null {
	const p = readConversationUsageProjection(raw);
	return p?.has_mapping && p.conversation_id === id ? p : null;
}

interface DetailOutcome {
	projection: ConversationUsageProjection | null;
	status: DetailStatus;
}

/**
 * Read detail projections for `ids` in batches of DETAIL_BATCH_SIZE, up to
 * DETAIL_WORKERS batches in flight. A batch that is not served falls back to
 * single reads for that chunk and later chunks. A provider deferral stops
 * further requests; ids not reached are absent from the result.
 */
async function readDetails(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	limit: Limiter,
	ids: readonly string[],
): Promise<{ outcomes: Map<string, DetailOutcome>; deferred: boolean }> {
	const outcomes = new Map<string, DetailOutcome>();
	const chunks: string[][] = [];
	for (let i = 0; i < ids.length; i += DETAIL_BATCH_SIZE) {
		chunks.push(ids.slice(i, i + DETAIL_BATCH_SIZE));
	}
	let batchUsable = true;
	let deferred = false;
	let nextChunk = 0;
	let done = 0;
	const stop = (): boolean => {
		if (deps.runBudget?.reason() === "max_wall_clock") deferred = true;
		return deferred;
	};
	const readOne = async (id: string): Promise<void> => {
		const r = await limit(() =>
			fetchProjected(
				deps,
				hooks,
				`/conversation/${encodeURIComponent(id)}`,
				"conversation_detail",
			),
		);
		if (r.kind === "error" && r.cls === "deferred") {
			deferred = true;
			return;
		}
		const p = r.kind === "ok" ? readDetailOf(r.json, id) : null;
		outcomes.set(id, {
			projection: p,
			status: p ? "fetched" : isUnavailable(r) ? "unavailable" : "failed",
		});
	};
	const worker = async (): Promise<void> => {
		for (;;) {
			const chunk = chunks[nextChunk];
			if (!chunk || stop()) return;
			nextChunk += 1;
			if (batchUsable) {
				const r = await limit(() =>
					fetchProjected(
						deps,
						hooks,
						"/conversations/batch",
						"conversation_detail",
						{ method: "POST", body: { conversation_ids: chunk } },
					),
				);
				if (r.kind === "error" && r.cls === "deferred") {
					deferred = true;
					return;
				}
				if (r.kind === "ok" && Array.isArray(r.json)) {
					for (const raw of r.json) {
						const p = readConversationUsageProjection(raw);
						if (
							p?.has_mapping &&
							p.conversation_id &&
							chunk.includes(p.conversation_id)
						) {
							outcomes.set(p.conversation_id, {
								projection: p,
								status: "fetched",
							});
						}
					}
				} else {
					// The batch endpoint is not served for this account; read singly.
					batchUsable = false;
				}
			}
			for (const id of chunk) {
				if (outcomes.has(id) || stop()) continue;
				await readOne(id);
			}
			done += chunk.length;
			await deps.emit({
				type: "PROGRESS",
				stream: "usage_summary",
				message: `Reading usage details: ${Math.min(done, ids.length)} of ${ids.length}`,
			});
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(DETAIL_WORKERS, chunks.length) }, () =>
			worker(),
		),
	);
	return { outcomes, deferred };
}

// ─── account_profile ──────────────────────────────────────────────────

interface SourceRead {
	json: Record<string, unknown> | null;
	status: ProfileSourceStatus;
}

async function readSource(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	path: string,
	projection: ChatGptUsageProjection,
): Promise<SourceRead> {
	const r = await fetchProjected(deps, hooks, path, projection);
	const status = sourceStatusOf(r);
	return {
		json:
			status === "ok" && r.kind === "ok"
				? (r.json as SourceRead["json"])
				: null,
		status,
	};
}

interface PagedCounts {
	count: number;
	files: number;
	by_status: Record<string, number>;
	/** Project gizmo ids (sidebar only). Raw ids; hashed or dropped before output. */
	project_ids: string[];
}

export type PagedRead = {
	value: PagedCounts | null;
	status: ProfileSourceStatus;
};

/**
 * Follow a `{..., cursor}` listing to source end, summing in-page counts.
 * Failed pages, non-progressing cursor cycles and the run wall-clock stop
 * retain the existing partial-read outcome.
 */
async function readPagedCounts(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	path: string,
	projection: "project_sidebar" | "task_stats",
): Promise<PagedRead> {
	const acc: PagedCounts = {
		count: 0,
		files: 0,
		by_status: {},
		project_ids: [],
	};
	let cursor: string | null = null;
	const seen = new Set<string>();
	let noProgressPages = 0;
	for (let page = 0; ; page += 1) {
		if (deps.runBudget?.reason() === "max_wall_clock")
			return { value: acc, status: "partial" };
		const url: string =
			cursor === null
				? path
				: `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}`;
		if (cursor !== null) seen.add(cursor);
		const r = await fetchProjected(deps, hooks, url, projection);
		const j = r.kind === "ok" && isRecord(r.json) ? r.json : null;
		const n =
			j === null
				? null
				: projection === "project_sidebar"
					? j.item_count
					: j.task_count;
		if (j === null || typeof n !== "number") {
			return page === 0
				? {
						value: null,
						status: r.kind === "ok" ? "failed" : sourceStatusOf(r),
					}
				: { value: acc, status: "partial" };
		}
		acc.count += n;
		if (typeof j.file_count === "number") acc.files += j.file_count;
		const projectsBefore = acc.project_ids.length;
		if (Array.isArray(j.project_ids)) {
			for (const id of j.project_ids) {
				if (
					typeof id === "string" &&
					/^[A-Za-z0-9_-]{1,128}$/.test(id) &&
					!acc.project_ids.includes(id)
				)
					acc.project_ids.push(id);
			}
		}
		if (isRecord(j.by_status)) {
			for (const [k, v] of Object.entries(j.by_status)) {
				if (typeof v === "number")
					acc.by_status[k] = (acc.by_status[k] ?? 0) + v;
			}
		}
		// Tasks carry no ids to compare, so every counted task is treated as
		// new: a page that echoes its own cursor ends the walk, but one that
		// points back to an earlier page is a loop and stays partial.
		const fresh =
			projection === "project_sidebar"
				? acc.project_ids.length - projectsBefore
				: n;
		const step = nextCursorStep(j, seen, cursor, n, fresh);
		if ("done" in step) return { value: acc, status: step.done };
		noProgressPages = fresh === 0 ? noProgressPages + 1 : 0;
		if (noProgressPages > NO_PROGRESS_PAGE_GUARD)
			return { value: acc, status: "partial" };
		cursor = step.next;
	}
}

async function runAccountProfile(
	deps: StreamDeps,
	state: CollectContext["state"],
	hooks: UsageStreamHooks,
	client: Promise<Record<string, unknown> | null>,
	sidebar: Promise<PagedRead>,
	stateless: boolean,
): Promise<void> {
	await deps.emit({
		type: "PROGRESS",
		stream: "account_profile",
		message: "Reading account profile",
	});
	const [me, account, beta, instructions, memory, projects, tasks, ctx] =
		await Promise.all([
			readSource(deps, hooks, "/me", "me_profile"),
			readSource(deps, hooks, hooks.accountsCheckPath, "account_check_facts"),
			readSource(deps, hooks, "/settings/beta_features", "beta_features"),
			readSource(
				deps,
				hooks,
				"/user_system_messages",
				"custom_instructions_flags",
			),
			readSource(
				deps,
				hooks,
				"/memories?include_memory_entries=true",
				"memory_stats",
			),
			sidebar,
			readPagedCounts(deps, hooks, "/tasks", "task_stats"),
			client,
		]);
	const clientContext = readClientContext(ctx);
	const accountStatus: ProfileSourceStatus =
		account.status === "ok" && account.json?.found !== true
			? "failed"
			: account.status;
	const sources: Record<AccountProfileSource, ProfileSourceStatus> = {
		me: me.status,
		accounts_check: accountStatus,
		beta_features: beta.status,
		custom_instructions: instructions.status,
		memories: memory.status,
		projects: projects.status,
		tasks: tasks.status,
		network:
			ctx === null
				? "failed"
				: clientContext.network_country
					? "ok"
					: "not_available",
	};
	const backendSources = Object.entries(sources).filter(
		([k]) => k !== "network",
	);
	if (!backendSources.some(([, s]) => s === "ok" || s === "partial")) {
		await deps.emit({
			type: "SKIP_RESULT",
			stream: "account_profile",
			reason: "http_error",
			message: "No account profile source answered this run",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			diagnostics: { ...sources },
		});
		return;
	}
	const record = buildAccountProfileRecord({
		me: me.json,
		account: accountStatus === "ok" ? account.json : null,
		betaFeatures: beta.json,
		instructions: instructions.json,
		memory: memory.json,
		projects: projects.value
			? { count: projects.value.count, files: projects.value.files }
			: null,
		tasks: tasks.value
			? { count: tasks.value.count, by_status: tasks.value.by_status }
			: null,
		client: clientContext,
		sources,
		nowMs: (hooks.now ?? Date.now)(),
	});
	const validation = validateRecord("account_profile", record);
	if (!validation.ok) {
		await deps.emit({
			type: "SKIP_RESULT",
			stream: "account_profile",
			reason: "shape_check_failed",
			message: "The account profile did not match its schema",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		});
		return;
	}
	if (projects.status === "partial" || tasks.status === "partial") {
		// Keep the observed profile, but partial inventories cannot checkpoint it.
		await deps.emitRecord("account_profile", record);
		return;
	}
	await emitGated(deps, state, "account_profile", stateless, [record]);
	await deps.emit(buildFullScanCoverageMessage("account_profile", 1));
}

// ─── usage_summary ────────────────────────────────────────────────────

function listSkipReason(
	outcome: ListOutcome,
):
	| "pagination_cap_truncated"
	| "parse_error"
	| "upstream_pressure"
	| "conversation_list_unstable" {
	switch (outcome) {
		case "capped":
			return "pagination_cap_truncated";
		case "parse_error":
			return "parse_error";
		case "deferred":
			return "upstream_pressure";
		default:
			return "conversation_list_unstable";
	}
}

async function runUsageSummary(
	deps: StreamDeps,
	state: CollectContext["state"],
	hooks: UsageStreamHooks,
	client: Promise<Record<string, unknown> | null> | null,
	sidebar: Promise<PagedRead>,
	stateless: boolean,
): Promise<void> {
	await deps.emit({
		type: "PROGRESS",
		stream: "usage_summary",
		message: "Listing conversations for usage metadata",
	});

	// 1. Lists, project lists and shares, sharing one in-flight limit.
	const limit = createLimiter(REQUESTS_IN_FLIGHT);
	const [main, archived, shares, projectPass] = await Promise.all([
		walkConversationList(deps, hooks, limit, { archived: false }),
		walkConversationList(deps, hooks, limit, { archived: true, workers: 1 }),
		readSharedIds(deps, hooks, limit),
		sidebar.then((s) => walkProjectConversations(deps, hooks, limit, s)),
	]);
	const archivedRead = archived.outcome === "complete";
	// A truncated list proves nothing about the account as a whole, so the
	// summary is withheld rather than built from part of it.
	if (
		main.outcome !== "complete" ||
		!(archivedRead || archived.outcome === "not_available")
	) {
		await deps.emit({
			type: "SKIP_RESULT",
			stream: "usage_summary",
			reason: listSkipReason(
				main.outcome !== "complete" ? main.outcome : archived.outcome,
			),
			message:
				"The conversation list was not read completely, so no summary was built this run",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		});
		return;
	}
	// Listings overlap; merge copies of one conversation field by field.
	const byId = new Map<string, UsageListItem>();
	for (const c of [...main.items, ...archived.items]) {
		const seen = byId.get(c.id);
		byId.set(c.id, seen ? mergeListItems(seen, c) : c);
	}
	let projectAdded = 0;
	for (const c of projectPass.items) {
		const seen = byId.get(c.id);
		if (!seen) projectAdded += 1;
		byId.set(c.id, seen ? mergeListItems(seen, c) : c);
	}
	const items = [...byId.values()].sort(
		(a, b) => (lastActivityOf(b) ?? 0) - (lastActivityOf(a) ?? 0),
	);
	await deps.emit({
		type: "PROGRESS",
		stream: "usage_summary",
		message: `Listed ${items.length} conversations`,
	});

	// 2. Detail for this run's sample only: the N most recently updated.
	const plan = resolveUsageDetailPlan();
	const sample = items.slice(0, plan.size).map((c) => c.id);
	const { outcomes } =
		sample.length > 0
			? await readDetails(deps, hooks, limit, sample)
			: { outcomes: new Map<string, DetailOutcome>() };
	const inSample = new Set(sample);
	const conversations: UsageSummaryConversation[] = items.map((c) => {
		const o = outcomes.get(c.id);
		return {
			list: c,
			projection: o?.projection ?? null,
			detailStatus: o?.status ?? "not_fetched",
			inSample: inSample.has(c.id),
		};
	});

	const listingComplete =
		!shares.partial &&
		projectPass.failed === 0 &&
		!projectPass.truncated &&
		(projectPass.sidebar === "ok" || projectPass.sidebar === "not_available");
	const summary = buildUsageSummaryRecord({
		conversations,
		sharedIds: shares.ids,
		client: readClientContext(client ? await client : null),
		coverage: {
			archived_listing: archivedRead ? "read" : "not_available",
			list_pages: main.pages + archived.pages,
			detail_mode: plan.size > 0 ? "sample" : "none",
			listing_complete: listingComplete,
			project_listing: {
				sidebar: projectPass.sidebar,
				projects: projectPass.projects,
				pages: projectPass.pages,
				failed: projectPass.failed,
				truncated: projectPass.truncated,
				conversations_added: projectAdded,
			},
		},
		// Complete only when every sampled conversation was read; a deferral
		// or a failed read labels the sample `complete: false`.
		sampleComplete: sample.every(
			(id) => outcomes.get(id)?.status === "fetched",
		),
	});
	if (!listingComplete) {
		// Keep the partial observation, but do not checkpoint or certify a full scan.
		await deps.emitRecord("usage_summary", summary);
		return;
	}
	await emitGated(deps, state, "usage_summary", stateless, [summary]);
	await deps.emit(buildFullScanCoverageMessage("usage_summary", 1));
}

// ─── Entry ────────────────────────────────────────────────────────────

export async function runUsageStreams(
	deps: StreamDeps,
	state: CollectContext["state"],
	hooks: UsageStreamHooks,
): Promise<void> {
	const wantProfile = deps.requested.has("account_profile");
	const wantUsage = deps.requested.has("usage_summary");
	if (!wantProfile && !wantUsage) return;
	// One sidebar walk serves the profile's project counts and the project
	// conversation listing.
	const sidebar = readPagedCounts(
		deps,
		hooks,
		"/gizmos/snorlax/sidebar",
		"project_sidebar",
	);
	// Both consumers await it; this keeps an early rejection from going unhandled.
	sidebar.catch(() => undefined);
	const stateless = process.env[CHATGPT_USAGE_STATELESS_ENV] === "1";
	// One trace/timezone read serves both the profile and the summary.
	const client =
		wantProfile || wantUsage
			? fetchProjected(deps, hooks, "/cdn-cgi/trace", "client_context").then(
					(r) => (r.kind === "ok" && isRecord(r.json) ? r.json : null),
					// Optional context: an auth failure here surfaces on the next
					// backend read instead of as an unhandled rejection.
					() => null,
				)
			: null;
	await Promise.all([
		wantProfile
			? runAccountProfile(
					deps,
					state,
					hooks,
					client ?? Promise.resolve(null),
					sidebar,
					stateless,
				)
			: Promise.resolve(),
		wantUsage
			? runUsageSummary(deps, state, hooks, client, sidebar, stateless)
			: Promise.resolve(),
	]);
}

async function emitGated(
	deps: StreamDeps,
	state: CollectContext["state"],
	stream: string,
	stateless: boolean,
	records: readonly RecordData[],
): Promise<void> {
	if (stateless) {
		for (const r of records) await deps.emitRecord(stream, r);
		return;
	}
	const cursor = openFingerprintCursor(state[stream]);
	for (const r of records) {
		if (cursor.shouldEmit(r)) await deps.emitRecord(stream, r);
	}
	cursor.dropUnseenIds();
	await deps.emit({
		type: "STATE",
		stream,
		cursor: {
			fetched_at: new Date().toISOString(),
			fingerprints: cursor.toState(),
		},
	});
}

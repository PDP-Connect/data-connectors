// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collection for the text-free usage streams: `account_profile` (one record),
 * `conversation_usage` (one record per conversation) and `usage_summary`
 * (one aggregate record). See usage.ts for the privacy contract: every read
 * below goes through `chatGptUsageFetchInBrowser`, which reduces the body
 * inside the page, so no text reaches the connector process.
 *
 * Request plan for a default run (all three streams):
 *
 *   In parallel from the start:
 *   - /gizmos/snorlax/sidebar (cursor pages): one walk shared by the
 *     profile's project counts and the project conversation listing.
 *   - account_profile: /me, /accounts/check, /settings/beta_features,
 *     /user_system_messages, /memories, /tasks (cursor pages, at most 5),
 *     /cdn-cgi/trace. Each source is optional: a failure leaves its fields
 *     null and is named in `source_status`.
 *   - Conversation list: `/conversations?offset=N&limit=100&order=updated`,
 *     then the same with `&is_archived=true`, plus `/shared_conversations`
 *     for the `is_shared` flag. The list response's `total` is not reliable,
 *     so a pass stops at the first page with fewer than 100 items.
 *   - Project conversations, which `/conversations` omits (verified live:
 *     111 of 1,335 on one account): `/gizmos/{id}/conversations?cursor=0`,
 *     then `?cursor=<cursor>` until none, per sidebar project (~10 items per
 *     page). Unioned with the main list by id. A failing project is counted
 *     in `usage_summary.coverage.project_listing`, not fatal. Run-wide
 *     budget: 100 projects and 400 project pages (`truncated` beyond).
 *   List, project and detail requests share one limiter: at most 4 in flight.
 *
 *   Then detail, `/conversations/batch` (10 ids per request, up to 3 in
 *   flight) with a `/conversation/{id}` fallback, for a SAMPLE: the 30 most
 *   recently updated conversations. Everything in usage_summary except
 *   `detail_sample` comes from list fields of every conversation and is
 *   exact; `detail_sample` (message counts, model mix, feature use) is
 *   labelled as sample-based with its window.
 *
 *   Owner account (live, 2026-10-15): ~13 main-list pages (+ up to 3 empty
 *   pages in flight when the short page lands), 1 archived page, 1 shares
 *   page, ~51 project pages over 11 projects, 1-2 sidebar pages, 3 batch
 *   reads and 7 other profile reads: ~80 requests, 39 s end to end in the
 *   CLI (1,363 conversations, 117 of them only in project listings).
 *
 * Full detail (opt-in):
 *   - Protocol scope on `conversation_usage`: `resources` (record ids) reads
 *     detail for exactly those conversations; `time_range` reads detail for
 *     every conversation created inside the window. Both are defined START
 *     scope fields; no new protocol field is used.
 *   - Dev override `PDPP_CHATGPT_USAGE_DETAIL`: `all`, `none`, or an integer
 *     sample size. The Vana CLI strips PDPP_* variables from the connector
 *     process, so this does not reach CLI runs.
 *
 * Records not read in detail this run carry `detail: "not_read"` and null
 * detail fields. A conversation whose detail was read on an earlier run and
 * whose list fields have not changed since is NOT re-emitted with nulls: its
 * earlier record stays current (STATE keeps a per-conversation list
 * fingerprint for this).
 */

import type {
	CollectContext,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildFullScanCoverageMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	openCarryForwardCursor,
	openFingerprintCursor,
	recordFingerprint,
} from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { isOutsideTimeRange } from "../../packages/polyfill-connectors/src/time-range.ts";
import type { StreamDeps } from "./index.ts";
import { tsToIso } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatGptFetchResult } from "./types.ts";
import {
	type AccountProfileSource,
	buildAccountProfileRecord,
	buildConversationUsageRecord,
	buildUsageSummaryRecord,
	type ChatGptUsageProjection,
	type ConversationListPage,
	type ConversationUsageProjection,
	type DetailBasis,
	type DetailMode,
	type DetailStatus,
	lastActivityOf,
	type ProfileSourceStatus,
	readClientContext,
	readConversationListPage,
	readConversationUsageProjection,
	type UsageListItem,
	type UsageSummaryConversation,
	usageRef,
} from "./usage.ts";

export const USAGE_STREAMS = [
	"account_profile",
	"conversation_usage",
	"usage_summary",
] as const;

/** Dev override for the detail plan: `all`, `none` or a sample size. */
export const CHATGPT_USAGE_DETAIL_ENV = "PDPP_CHATGPT_USAGE_DETAIL";
/** Set by hosts that never persist STATE (PageShim): emit without fingerprints. */
export const CHATGPT_USAGE_STATELESS_ENV = "PDPP_CHATGPT_USAGE_STATELESS";

export const DEFAULT_DETAIL_SAMPLE = 30;
export const LIST_PAGE_LIMIT = 100;
const LIST_MAX_PAGES = 300;
const LIST_WORKERS = 4;
const REQUESTS_IN_FLIGHT = 4;
const DETAIL_BATCH_SIZE = 10;
const DETAIL_WORKERS = 3;
const SHARED_PAGE_LIMIT = 100;
const SHARED_MAX_PAGES = 50;
const PROFILE_MAX_PAGES = 5;
const SIDEBAR_MAX_PAGES = 20;
const PROJECT_MAX_PAGES = 200;

export type UsageFetchErrorClass = "auth" | "forbidden" | "deferred" | "other";

export interface UsageStreamHooks {
	classifyError: (err: unknown) => UsageFetchErrorClass;
	/** The accounts/check path the account_plan stream reads. */
	accountsCheckPath: string;
	/** Clock seam (epoch ms) for tenure; defaults to Date.now. */
	now?: () => number;
}

export type UsageDetailPlan =
	| { kind: "sample"; size: number }
	| { kind: "all" }
	| { kind: "none" };

export function resolveUsageDetailPlan(
	env: NodeJS.ProcessEnv = process.env,
): UsageDetailPlan {
	const raw = env[CHATGPT_USAGE_DETAIL_ENV]?.trim().toLowerCase();
	if (raw === "all") return { kind: "all" };
	if (raw === "none" || raw === "0") return { kind: "none" };
	const n = raw ? Number(raw) : Number.NaN;
	return {
		kind: "sample",
		size: Number.isInteger(n) && n > 0 ? n : DEFAULT_DETAIL_SAMPLE,
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
	let next = 0;
	let endAt = Number.POSITIVE_INFINITY;
	let wallClockStop = false;
	const firstFailure = (): number =>
		failures.size > 0 ? Math.min(...failures.keys()) : Number.POSITIVE_INFINITY;
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next;
			if (i > endAt || i >= firstFailure() || i >= LIST_MAX_PAGES) return;
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
		}
	};
	await Promise.all(
		Array.from({ length: opts.workers ?? LIST_WORKERS }, () => worker()),
	);
	const failedAt = firstFailure();
	const ordered: ConversationListPage[] = [];
	for (let i = 0; i <= Math.min(endAt, failedAt - 1, LIST_MAX_PAGES - 1); i++) {
		const page = pages.get(i);
		if (!page) break;
		ordered.push(page);
	}
	const seen = new Set<string>();
	const items: UsageListItem[] = [];
	for (const page of ordered) {
		for (const item of page.items) {
			if (seen.has(item.id)) continue;
			seen.add(item.id);
			items.push(item);
		}
	}
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
	/** True when the run-wide project or page budget left projects or pages unread. */
	truncated: boolean;
}

/** Run-wide budget for project listings (the per-project cap is PROJECT_MAX_PAGES). */
export const PROJECT_LISTING_MAX_PROJECTS = 100;
export const PROJECT_LISTING_MAX_PAGES = 400;

/**
 * Decide what a cursor page means. Terminal when the page says so (explicit
 * `has_more: false`, no cursor) or is empty. A cursor already used is also
 * terminal, so nothing is fetched twice: done when it echoes the cursor just
 * used (a last page that repeats its own cursor) or the page brought nothing
 * new; partial when it points back to an earlier page after new items (a
 * loop that may hide more).
 */
export function nextCursorStep(
	j: Record<string, unknown>,
	seen: ReadonlySet<string>,
	current: string | null,
	pageItems: number,
	newItems: number,
): { next: string } | { done: "ok" | "partial" } {
	if (pageItems === 0 || j.has_more !== true) return { done: "ok" };
	const next =
		typeof j.cursor === "string"
			? j.cursor
			: typeof j.cursor === "number"
				? String(j.cursor)
				: null;
	if (next === null) return { done: "partial" };
	if (seen.has(next))
		return { done: next === current || newItems === 0 ? "ok" : "partial" };
	return { next };
}

/**
 * List the conversations of every project named by the sidebar. Verified
 * live: `/conversations` omits project conversations (111 of 1,335 on one
 * account), while `/gizmos/{id}/conversations?cursor=0`, followed by
 * `?cursor=<cursor>` until none is returned, lists them (~10 per page).
 * Items are reduced in the page like the main list. A project whose walk
 * fails counts in `failed`; its pages read so far are kept. At most
 * PROJECT_LISTING_MAX_PROJECTS projects and PROJECT_LISTING_MAX_PAGES pages
 * are read per run; anything beyond sets `truncated`.
 */
export async function walkProjectConversations(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	limit: Limiter,
	sidebar: PagedRead,
	budget: { maxProjects: number; maxPages: number } = {
		maxProjects: PROJECT_LISTING_MAX_PROJECTS,
		maxPages: PROJECT_LISTING_MAX_PAGES,
	},
): Promise<ProjectPass> {
	const all = sidebar.value?.project_ids ?? [];
	const ids = all.slice(0, budget.maxProjects);
	let truncated = all.length > ids.length;
	let pages = 0;
	let claimed = 0;
	let failed = 0;
	const items: UsageListItem[] = [];
	const seenIds = new Set<string>();
	const walkOne = async (projectId: string): Promise<void> => {
		const seenCursors = new Set<string>();
		let cursor = "0";
		for (let page = 0; page < PROJECT_MAX_PAGES; page += 1) {
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
			for (const c of parsed.items) {
				if (seenIds.has(c.id)) continue;
				seenIds.add(c.id);
				added += 1;
				// The project itself is the gizmo when the item does not say so.
				items.push(
					c.gizmo_id || c.template_id ? c : { ...c, gizmo_id: projectId },
				);
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
			cursor = step.next;
		}
		failed += 1;
	};
	await Promise.all(ids.map((id) => walkOne(id)));
	return {
		items,
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
): Promise<Set<string> | null> {
	const ids = new Set<string>();
	for (let page = 0; page < SHARED_MAX_PAGES; page += 1) {
		const r = await limit(() =>
			fetchProjected(
				deps,
				hooks,
				`/shared_conversations?offset=${page * SHARED_PAGE_LIMIT}&limit=${SHARED_PAGE_LIMIT}&order=created`,
				"shared_conversation_ids",
			),
		);
		if (r.kind === "status" && r.status === 404) return ids;
		if (r.kind !== "ok") return null;
		const j = r.json as { items?: unknown; total?: unknown } | null;
		const items = Array.isArray(j?.items) ? j.items : null;
		if (!items) return null;
		for (const item of items) {
			const id = (item as { conversation_id?: unknown } | null)
				?.conversation_id;
			if (typeof id === "string") ids.add(id);
		}
		const total = typeof j?.total === "number" ? j.total : null;
		if (
			items.length < SHARED_PAGE_LIMIT ||
			(total !== null && (page + 1) * SHARED_PAGE_LIMIT >= total)
		)
			return ids;
	}
	// More shares than the page cap: the flag would under-report.
	return null;
}

// ─── Detail ───────────────────────────────────────────────────────────

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
				"conversation_usage",
			),
		);
		if (r.kind === "error" && r.cls === "deferred") {
			deferred = true;
			return;
		}
		const p = r.kind === "ok" ? readConversationUsageProjection(r.json) : null;
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
						"conversation_usage",
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
						if (p?.conversation_id && chunk.includes(p.conversation_id)) {
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
				stream: deps.requested.has("conversation_usage")
					? "conversation_usage"
					: "usage_summary",
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
 * Follow a `{..., cursor}` listing for at most PROFILE_MAX_PAGES pages,
 * summing the in-page counts. A later page that fails, a cursor that is not
 * a plain token, or the page cap returns what was counted as "partial".
 */
async function readPagedCounts(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	path: string,
	projection: "project_sidebar" | "task_stats",
	maxPages = PROFILE_MAX_PAGES,
): Promise<PagedRead> {
	const acc: PagedCounts = {
		count: 0,
		files: 0,
		by_status: {},
		project_ids: [],
	};
	let cursor: string | null = null;
	const seen = new Set<string>();
	for (let page = 0; page < maxPages; page += 1) {
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
		// Tasks carry no ids to compare, so an echoed cursor counts as done.
		const fresh =
			projection === "project_sidebar"
				? acc.project_ids.length - projectsBefore
				: 0;
		const step = nextCursorStep(j, seen, cursor, n, fresh);
		if ("done" in step) return { value: acc, status: step.done };
		cursor = step.next;
	}
	return { value: acc, status: "partial" };
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
	await emitGated(deps, state, "account_profile", stateless, [record]);
	await deps.emit(buildFullScanCoverageMessage("account_profile", 1));
}

// ─── conversation_usage + usage_summary ───────────────────────────────

/**
 * Fields a detail read fills. They are carried from the run that read them
 * while the conversation's content has not changed (same update_time),
 * whatever happens to its flags (pinned, archived, shared) meanwhile.
 */
const DETAIL_FIELDS = [
	"detail",
	"detail_status",
	"message_counts",
	"turn_count",
	"branch_count",
	"nodes_total",
	"models",
	"features",
	"user_attachments",
	"user_images",
	"user_chars_total",
	"user_chars_max",
	"assistant_chars_total",
	"first_message_at",
	"last_message_at",
] as const;

/** Upper bound on carried detail entries kept in STATE. */
const MAX_CARRIED_DETAIL = 5000;

interface CarriedDetail {
	/** update_time of the conversation when its detail was read. */
	u: string | null;
	/** The detail fields as emitted then. */
	d: Record<string, unknown>;
}

function readCarried(v: unknown): Map<string, CarriedDetail> {
	const out = new Map<string, CarriedDetail>();
	if (!isRecord(v)) return out;
	for (const [k, e] of Object.entries(v)) {
		if (
			isRecord(e) &&
			(typeof e.u === "string" || e.u === null) &&
			isRecord(e.d) &&
			e.d.detail_status === "fetched"
		)
			out.set(k, { u: e.u, d: e.d });
	}
	return out;
}

function stringMap(v: unknown): Map<string, string> {
	const out = new Map<string, string>();
	if (!isRecord(v)) return out;
	for (const [k, s] of Object.entries(v))
		if (typeof s === "string") out.set(k, s);
	return out;
}

/**
 * Emit conversation_usage records behind a fingerprint gate.
 *
 * Detail carry-forward: a conversation not read in detail this run, whose
 * detail an earlier run read at the same update_time, is emitted with that
 * earlier detail and today's list fields, so a flag change (pin, archive,
 * shares unreadable) never wipes valid detail.
 *
 * `complete` is false when the conversation list was not read completely.
 * Then nothing is pruned: prior fingerprints and carried detail of
 * conversations not seen this run stay in STATE for the next run.
 */
async function emitConversationUsage(
	deps: StreamDeps,
	state: CollectContext["state"],
	stateless: boolean,
	records: readonly RecordData[],
	complete: boolean,
): Promise<void> {
	if (stateless) {
		for (const r of records) await deps.emitRecord("conversation_usage", r);
		return;
	}
	const prior = isRecord(state.conversation_usage)
		? state.conversation_usage
		: {};
	const cursor = openCarryForwardCursor(stringMap(prior.fingerprints));
	const priorCarried = readCarried(prior.detailed);
	const carried = new Map<string, CarriedDetail>();
	for (const base of records) {
		const id = String(base.id);
		const update =
			typeof base.update_time === "string" ? base.update_time : null;
		const was = priorCarried.get(id);
		const r: RecordData =
			base.detail_status !== "fetched" && was && was.u === update
				? { ...base, ...was.d }
				: base;
		if (r.detail_status === "fetched") {
			carried.set(id, {
				u: update,
				d: Object.fromEntries(DETAIL_FIELDS.map((k) => [k, r[k] ?? null])),
			});
		}
		const fp = recordFingerprint(r);
		if (fp !== cursor.prior(id)) await deps.emitRecord("conversation_usage", r);
		cursor.note(id, fp);
	}
	if (complete) {
		cursor.dropUnseenIds();
	} else {
		const seen = new Set(records.map((r) => String(r.id)));
		for (const [id, c] of priorCarried) if (!seen.has(id)) carried.set(id, c);
	}
	const detailed: Record<string, CarriedDetail> = {};
	for (const [id, c] of [...carried].slice(0, MAX_CARRIED_DETAIL))
		detailed[id] = c;
	await deps.emit({
		type: "STATE",
		stream: "conversation_usage",
		cursor: {
			fetched_at: new Date().toISOString(),
			fingerprints: cursor.toState(),
			detailed,
		},
	});
}

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

async function runConversationUsage(
	deps: StreamDeps,
	state: CollectContext["state"],
	hooks: UsageStreamHooks,
	client: Promise<Record<string, unknown> | null> | null,
	sidebar: Promise<PagedRead>,
	stateless: boolean,
): Promise<void> {
	const wantRecords = deps.requested.has("conversation_usage");
	const wantSummary = deps.requested.has("usage_summary");
	const streams = (["conversation_usage", "usage_summary"] as const).filter(
		(s) => deps.requested.has(s),
	);
	const primary = streams[0] ?? "usage_summary";
	await deps.emit({
		type: "PROGRESS",
		stream: primary,
		message: "Listing conversations for usage metadata",
	});

	// 1. Lists and shares, sharing one in-flight limit.
	const limit = createLimiter(REQUESTS_IN_FLIGHT);
	const [main, archived, sharedIds, projectPass] = await Promise.all([
		walkConversationList(deps, hooks, limit, { archived: false }),
		walkConversationList(deps, hooks, limit, { archived: true, workers: 1 }),
		readSharedIds(deps, hooks, limit),
		sidebar.then((s) => walkProjectConversations(deps, hooks, limit, s)),
	]);
	const archivedRead = archived.outcome === "complete";
	const truncated =
		main.outcome !== "complete" ||
		!(archivedRead || archived.outcome === "not_available");
	const listOutcome =
		main.outcome !== "complete" ? main.outcome : archived.outcome;
	const byId = new Map<string, UsageListItem>();
	for (const c of [...main.items, ...(archivedRead ? archived.items : [])]) {
		if (!byId.has(c.id)) byId.set(c.id, c);
	}
	let projectAdded = 0;
	for (const c of projectPass.items) {
		if (byId.has(c.id)) continue;
		byId.set(c.id, c);
		projectAdded += 1;
	}
	const items = [...byId.values()].sort(
		(a, b) => (lastActivityOf(b) ?? 0) - (lastActivityOf(a) ?? 0),
	);
	await deps.emit({
		type: "PROGRESS",
		stream: primary,
		message: `Listed ${items.length} conversations`,
	});

	// 2. Which conversations to read in detail.
	const plan = resolveUsageDetailPlan();
	const scope = deps.requested.get("conversation_usage");
	const resources =
		scope?.resources && scope.resources.length > 0
			? new Set(scope.resources)
			: null;
	const window = scope?.time_range;
	const selected = new Set<string>();
	if (wantRecords && (resources || window)) {
		for (const c of items) {
			if (resources && !resources.has(usageRef("c", c.id))) continue;
			if (window) {
				const created = tsToIso(c.create_time);
				if (created === null || isOutsideTimeRange(window, created)) continue;
			}
			selected.add(c.id);
		}
	}
	const scoped = resources !== null || window !== undefined;
	const sample = new Set<string>(
		plan.kind === "sample" && (wantSummary || !scoped)
			? items.slice(0, plan.size).map((c) => c.id)
			: [],
	);
	if (plan.kind === "all") for (const c of items) selected.add(c.id);
	const detailMode: DetailMode =
		plan.kind === "all"
			? "all"
			: scoped && wantRecords
				? "selected"
				: plan.kind === "none"
					? "none"
					: "sample";
	const targets = items
		.map((c) => c.id)
		.filter((id) => sample.has(id) || selected.has(id));

	// 3. Detail.
	const { outcomes, deferred } =
		targets.length > 0
			? await readDetails(deps, hooks, limit, targets)
			: { outcomes: new Map<string, DetailOutcome>(), deferred: false };

	const built: UsageSummaryConversation[] = items.map((c) => {
		const o = outcomes.get(c.id);
		const detail: DetailBasis = selected.has(c.id)
			? "selected"
			: sample.has(c.id)
				? "sampled"
				: "not_read";
		const projection = o?.projection ?? null;
		return {
			list: c,
			projection,
			inSample: sample.has(c.id),
			record: buildConversationUsageRecord({
				listItem: c,
				projection,
				detail,
				detailStatus: o?.status ?? "not_fetched",
				sharedIds,
			}),
		};
	});

	if (wantRecords) {
		await emitConversationUsage(
			deps,
			state,
			stateless,
			built.map((b) => b.record),
			!truncated,
		);
	}

	if (wantSummary && !truncated) {
		const summary = buildUsageSummaryRecord({
			conversations: built,
			client: readClientContext(client ? await client : null),
			coverage: {
				archived_listing: archivedRead ? "read" : "not_available",
				list_pages: main.pages + archived.pages,
				detail_mode: detailMode,
				project_listing: {
					sidebar: projectPass.sidebar,
					projects: projectPass.projects,
					pages: projectPass.pages,
					failed: projectPass.failed,
					truncated: projectPass.truncated,
					conversations_added: projectAdded,
				},
			},
			sampleComplete: [...sample].every((id) => outcomes.has(id)),
		});
		await emitGated(deps, state, "usage_summary", stateless, [summary]);
	}

	// Completeness. A truncated list proves nothing about the account as a
	// whole, so the summary is withheld rather than built from part of it.
	if (truncated) {
		const reason = listSkipReason(listOutcome);
		await Promise.all(
			streams.map((stream) =>
				deps.emit({
					type: "SKIP_RESULT",
					stream,
					reason,
					message:
						stream === "usage_summary"
							? "The conversation list was not read completely, so no summary was built this run"
							: "The conversation list was not read completely; retry this stream",
					recovery_hint: { action: "retry_by_runtime", retryable: true },
				}),
			),
		);
		return;
	}
	// A sample that stopped early is labelled in the summary (`complete:
	// false`); an explicit selection that stopped early is a partial stream.
	const unreadSelected = [...selected].filter((id) => !outcomes.has(id)).length;
	if (wantRecords && unreadSelected > 0) {
		await deps.emit({
			type: "SKIP_RESULT",
			stream: "conversation_usage",
			reason: deferred ? "upstream_pressure" : "detail_fetch_capped",
			message: `Usage details were read for ${selected.size - unreadSelected} of ${selected.size} selected conversations`,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			diagnostics: { unread: unreadSelected },
		});
	} else if (wantRecords) {
		await deps.emit(
			buildFullScanCoverageMessage("conversation_usage", items.length),
		);
	}
	if (wantSummary) {
		await deps.emit(buildFullScanCoverageMessage("usage_summary", 1));
	}
}

// ─── Entry ────────────────────────────────────────────────────────────

export async function runUsageStreams(
	deps: StreamDeps,
	state: CollectContext["state"],
	hooks: UsageStreamHooks,
): Promise<void> {
	const wantProfile = deps.requested.has("account_profile");
	const wantUsage =
		deps.requested.has("conversation_usage") ||
		deps.requested.has("usage_summary");
	if (!wantProfile && !wantUsage) return;
	// One sidebar walk serves the profile's project counts and the project
	// conversation listing.
	const sidebar = readPagedCounts(
		deps,
		hooks,
		"/gizmos/snorlax/sidebar",
		"project_sidebar",
		SIDEBAR_MAX_PAGES,
	);
	// Both consumers await it; this keeps an early rejection from going unhandled.
	sidebar.catch(() => undefined);
	const stateless = process.env[CHATGPT_USAGE_STATELESS_ENV] === "1";
	// One trace/timezone read serves both the profile and the summary.
	const client =
		wantProfile || deps.requested.has("usage_summary")
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
			? runConversationUsage(deps, state, hooks, client, sidebar, stateless)
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

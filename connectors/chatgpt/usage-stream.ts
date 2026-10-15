// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Collection for `conversation_usage` (one record per conversation) and
 * `usage_summary` (one aggregate record). See usage.ts for the privacy
 * contract.
 *
 * Request plan, in order:
 *   1. Conversation list (`/conversations/search`), the same walk the
 *      conversations stream uses. Metadata only.
 *   2. `/shared_conversations` pages, projected in the page to conversation
 *      ids, for the `is_shared` flag.
 *   3. Conversation detail, `/conversations/batch` (10 ids per request) with
 *      a `/conversation/{id}` fallback. This is the only content-bearing read:
 *      the page reduces each body to counts before it returns.
 *      `PDPP_CHATGPT_USAGE_MAX_DETAIL_FETCHES=0` skips it (list-only mode).
 *   4. Summary only: `/accounts/check`, `/memories`, `/user_system_messages`,
 *      `/settings/user` (all projected in the page) and the page's
 *      timezone, language and network country.
 *
 * Every record is rebuilt each run (no incremental cursor). A fingerprint
 * gate suppresses byte-identical re-emits on hosts that persist STATE.
 */

import type {
	CollectContext,
	EmittedMessage,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { buildFullScanCoverageMessage } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { isOutsideTimeRange } from "../../packages/polyfill-connectors/src/time-range.ts";
import type { StreamDeps } from "./index.ts";
import { tsToIso } from "./parsers.ts";
import type { ChatGptFetchResult, ConversationListItem } from "./types.ts";
import {
	buildConversationUsageRecord,
	buildUsageSummaryRecord,
	type ChatGptUsageProjection,
	type ConversationUsageProjection,
	type DetailStatus,
	readAccountUsageFacts,
	readClientContext,
	readConversationUsageProjection,
	readSettingsFlags,
	type UsageAccountInput,
	type UsageClientContext,
	type UsageSettingsInput,
} from "./usage.ts";

export const USAGE_STREAMS = ["conversation_usage", "usage_summary"] as const;

export const CHATGPT_USAGE_MAX_DETAIL_FETCHES_ENV =
	"PDPP_CHATGPT_USAGE_MAX_DETAIL_FETCHES";
/** Set by hosts that never persist STATE (PageShim): emit without fingerprints. */
export const CHATGPT_USAGE_STATELESS_ENV = "PDPP_CHATGPT_USAGE_STATELESS";

const DETAIL_BATCH_SIZE = 10;
const SHARED_PAGE_LIMIT = 100;
const SHARED_MAX_PAGES = 50;

export type UsageFetchErrorClass = "auth" | "forbidden" | "deferred" | "other";

export interface UsageStreamHooks {
	/** Full conversation list walk; `truncated` means the list is not proven complete. */
	listConversations: (
		deps: StreamDeps,
	) => Promise<{ items: ConversationListItem[]; truncated: boolean }>;
	classifyError: (err: unknown) => UsageFetchErrorClass;
	/** The accounts/check path the account_plan stream reads. */
	accountsCheckPath: string;
}

export function resolveUsageMaxDetailFetches(
	env: NodeJS.ProcessEnv = process.env,
): number {
	const raw = env[CHATGPT_USAGE_MAX_DETAIL_FETCHES_ENV]?.trim();
	if (raw === undefined || raw === "") return Number.POSITIVE_INFINITY;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : Number.POSITIVE_INFINITY;
}

type Projected =
	| { kind: "ok"; json: unknown }
	| { kind: "status"; status: number }
	| { kind: "error"; cls: UsageFetchErrorClass; err: unknown };

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

/** Optional side read: any failure other than auth yields null. */
async function optionalProjected(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	path: string,
	projection: ChatGptUsageProjection,
): Promise<Record<string, unknown> | null> {
	const r = await fetchProjected(deps, hooks, path, projection);
	return r.kind === "ok" &&
		typeof r.json === "object" &&
		r.json !== null &&
		!Array.isArray(r.json)
		? (r.json as Record<string, unknown>)
		: null;
}

async function readSharedIds(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
): Promise<Set<string> | null> {
	const ids = new Set<string>();
	for (let page = 0; page < SHARED_MAX_PAGES; page += 1) {
		const r = await fetchProjected(
			deps,
			hooks,
			`/shared_conversations?offset=${page * SHARED_PAGE_LIMIT}&limit=${SHARED_PAGE_LIMIT}&order=created`,
			"shared_conversation_ids",
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

interface DetailOutcome {
	projection: ConversationUsageProjection | null;
	status: DetailStatus;
}

/**
 * Read detail projections for `ids`, newest first, until the cap or a
 * provider deferral. Returns per-id outcomes; ids not reached are absent.
 */
async function readDetails(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	ids: readonly string[],
	cap: number,
): Promise<{ outcomes: Map<string, DetailOutcome>; deferred: boolean }> {
	const outcomes = new Map<string, DetailOutcome>();
	const target = ids.slice(0, Math.min(ids.length, cap));
	let batchUsable = true;
	let deferred = false;
	for (let i = 0; i < target.length && !deferred; i += DETAIL_BATCH_SIZE) {
		if (deps.runBudget?.reason() === "max_wall_clock") {
			deferred = true;
			break;
		}
		const chunk = target.slice(i, i + DETAIL_BATCH_SIZE);
		if (batchUsable) {
			const r = await fetchProjected(
				deps,
				hooks,
				"/conversations/batch",
				"conversation_usage",
				{ method: "POST", body: { conversation_ids: chunk } },
			);
			if (r.kind === "error" && r.cls === "deferred") {
				deferred = true;
				break;
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
			if (outcomes.has(id) || deferred) continue;
			const r = await fetchProjected(
				deps,
				hooks,
				`/conversation/${encodeURIComponent(id)}`,
				"conversation_usage",
			);
			if (r.kind === "error" && r.cls === "deferred") {
				deferred = true;
				break;
			}
			const p =
				r.kind === "ok" ? readConversationUsageProjection(r.json) : null;
			outcomes.set(id, {
				projection: p,
				status: p
					? "fetched"
					: (r.kind === "status" && (r.status === 404 || r.status === 403)) ||
							(r.kind === "error" && r.cls === "forbidden")
						? "unavailable"
						: "failed",
			});
		}
		await deps.emit({
			type: "PROGRESS",
			stream: deps.requested.has("conversation_usage")
				? "conversation_usage"
				: "usage_summary",
			message: `Reading usage details: ${Math.min(i + DETAIL_BATCH_SIZE, target.length)} of ${target.length}`,
		});
	}
	return { outcomes, deferred };
}

async function readSummaryInputs(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
): Promise<{
	settings: UsageSettingsInput;
	client: UsageClientContext;
	account: UsageAccountInput;
}> {
	// Sequential on purpose: each is one paced request through the shared budget.
	const account = await fetchProjectedRaw(deps, hooks, hooks.accountsCheckPath);
	const memory = await optionalProjected(
		deps,
		hooks,
		"/memories?include_memory_entries=true",
		"memory_stats",
	);
	const instructions = await optionalProjected(
		deps,
		hooks,
		"/user_system_messages",
		"custom_instructions_flags",
	);
	const settings = await optionalProjected(
		deps,
		hooks,
		"/settings/user",
		"settings_flags",
	);
	const client = await optionalProjected(
		deps,
		hooks,
		"/cdn-cgi/trace",
		"client_context",
	);
	const num = (v: unknown): number | null =>
		typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
	const bool = (v: unknown): boolean | null =>
		typeof v === "boolean" ? v : null;
	return {
		account: readAccountUsageFacts(account),
		client: readClientContext(client),
		settings: {
			memory_count: num(memory?.memory_count),
			memory_num_tokens: num(memory?.memory_num_tokens),
			memory_max_tokens: num(memory?.memory_max_tokens),
			custom_instructions_enabled: bool(instructions?.enabled),
			custom_instructions_about_user_set: bool(instructions?.about_user_set),
			custom_instructions_response_style_set: bool(
				instructions?.response_style_set,
			),
			setting_flags: readSettingsFlags(settings),
		},
	};
}

/**
 * accounts/check carries no free text the summary needs projecting away
 * beyond what readAccountUsageFacts already drops, and the account_plan
 * stream already reads it unprojected; reuse that path as-is.
 */
async function fetchProjectedRaw(
	deps: StreamDeps,
	hooks: UsageStreamHooks,
	path: string,
): Promise<unknown> {
	try {
		const res = await deps.api.fetch(path);
		return res.status === 200 ? res.json : null;
	} catch (err) {
		if (hooks.classifyError(err) === "auth") throw err;
		return null;
	}
}

function emitForStreams(
	deps: StreamDeps,
	streams: readonly string[],
	build: (stream: string) => EmittedMessage,
): Promise<void> {
	return Promise.all(streams.map((s) => deps.emit(build(s)))).then(
		() => undefined,
	);
}

export async function runUsageStreams(
	deps: StreamDeps,
	state: CollectContext["state"],
	hooks: UsageStreamHooks,
): Promise<void> {
	const streams = USAGE_STREAMS.filter((s) => deps.requested.has(s));
	if (streams.length === 0) return;
	const wantRecords = deps.requested.has("conversation_usage");
	const wantSummary = deps.requested.has("usage_summary");
	const primary = streams[0] ?? "usage_summary";
	await deps.emit({
		type: "PROGRESS",
		stream: primary,
		message: "Listing conversations for usage metadata",
	});

	// 1. List. The shared walk reports on "conversations"/"messages"; this run
	// may not have requested those, so its reports are re-labelled or held.
	const heldReasons: string[] = [];
	const listed = await hooks.listConversations({
		...deps,
		requested: new Map(),
		emit: (message: EmittedMessage) => {
			const stream = (message as { stream?: unknown }).stream;
			if (stream !== "conversations" && stream !== "messages") {
				return deps.emit(message);
			}
			if (message.type === "SKIP_RESULT") {
				heldReasons.push(String((message as { reason?: unknown }).reason));
				return Promise.resolve();
			}
			if (message.type === "PROGRESS") {
				return deps.emit({ ...message, stream: primary } as EmittedMessage);
			}
			return Promise.resolve();
		},
	});
	const items = [...listed.items].sort((a, b) =>
		(tsToIso(b.update_time) ?? "").localeCompare(tsToIso(a.update_time) ?? ""),
	);

	// conversation_usage alone under a time window: details outside it would be
	// dropped by the runtime, so do not fetch them.
	const window = wantSummary
		? undefined
		: deps.requested.get("conversation_usage")?.time_range;
	const inWindow = (c: ConversationListItem): boolean => {
		if (!window) return true;
		const created = tsToIso(c.create_time);
		return created !== null && !isOutsideTimeRange(window, created);
	};

	// 2. Shares (flag only).
	const sharedIds = await readSharedIds(deps, hooks);

	// 3. Details.
	const cap = resolveUsageMaxDetailFetches();
	const wanted = items.filter(inWindow).map((c) => c.id);
	const { outcomes, deferred } =
		cap > 0
			? await readDetails(deps, hooks, wanted, cap)
			: { outcomes: new Map<string, DetailOutcome>(), deferred: false };

	const built = items.map((c) => {
		const o = outcomes.get(c.id);
		const projection = o?.projection ?? null;
		return {
			projection,
			record: buildConversationUsageRecord({
				listItem: c,
				projection,
				detailStatus: o?.status ?? "not_fetched",
				sharedIds,
			}),
		};
	});

	const stateless = process.env[CHATGPT_USAGE_STATELESS_ENV] === "1";
	if (wantRecords) {
		await emitGated(
			deps,
			state,
			"conversation_usage",
			stateless,
			built.map((b) => b.record),
		);
	}

	if (wantSummary && !listed.truncated) {
		const inputs = await readSummaryInputs(deps, hooks);
		const summary = buildUsageSummaryRecord({
			conversations: built,
			...inputs,
		});
		await emitGated(deps, state, "usage_summary", stateless, [summary]);
	}

	// Completeness. A truncated list proves nothing about the account as a
	// whole, so the summary is withheld rather than built from part of it.
	if (listed.truncated) {
		// Literal set so every emitted reason has a manifest display message.
		const held = heldReasons[0];
		const reason =
			held === "pagination_cap_truncated"
				? "pagination_cap_truncated"
				: held === "parse_error"
					? "parse_error"
					: held === "upstream_pressure"
						? "upstream_pressure"
						: "conversation_list_unstable";
		await emitForStreams(deps, streams, (stream) => ({
			type: "SKIP_RESULT",
			stream,
			reason,
			message:
				stream === "usage_summary"
					? "The conversation list was not read completely, so no summary was built this run"
					: "The conversation list was not read completely; retry this stream",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		}));
		return;
	}
	const unread = wanted.filter((id) => !outcomes.has(id)).length;
	const failed = [...outcomes.values()].filter(
		(o) => o.status === "failed",
	).length;
	if ((deferred || unread > 0) && cap > 0) {
		await emitForStreams(deps, streams, (stream) => ({
			type: "SKIP_RESULT",
			stream,
			reason: deferred ? "upstream_pressure" : "detail_fetch_capped",
			message: `Usage details were read for ${outcomes.size} of ${wanted.length} conversations`,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			diagnostics: { unread, failed },
		}));
		return;
	}
	if (wantRecords) {
		await deps.emit(
			buildFullScanCoverageMessage("conversation_usage", items.length),
		);
	}
	if (wantSummary) {
		await deps.emit(buildFullScanCoverageMessage("usage_summary", 1));
	}
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

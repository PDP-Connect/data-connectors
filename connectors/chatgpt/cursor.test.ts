// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proof at the orchestration boundary that chatgpt's parent-first emit
 * reorder (Tranche C 2026-04-23) did NOT introduce a cursor/state race.
 *
 * The concern raised in the A++ critique: `processConversationDetail`
 * now emits the `conversations` record before messages. If the caller
 * (`runMessagesAndConversationsWithDetail` →
 * `runConversationsAndMessagesStreams`) emitted the `conversations`
 * STATE cursor too early — between a conversation's parent emit and
 * its last child emit — a downstream consumer reading records +
 * advancing cursor would strand messages behind the cursor and lose
 * them on a crash-then-resume.
 *
 * This test drives the real `runConversationsAndMessagesStreams` with
 * a fake `api` that serves a deterministic list + detail payloads,
 * and records the full emit sequence through `makeRecordingEmit`.
 * Asserts:
 *   1. For every conversation in the list, its `conversations` record
 *      emits before ALL of its `messages` records.
 *   2. The `conversations` STATE cursor is emitted exactly once, AFTER
 *      every per-conversation record (no per-conversation cursor
 *      advance, no pre-emit cursor advance).
 *   3. The STATE cursor value is the max `update_time` across the
 *      synced batch — matches pre-reorder semantics.
 *
 * This is the proof the instruction called for: at the orchestration
 * boundary, not just `processConversationDetail`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
	CollectContext,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	NO_DETAIL_WAITS,
	withEmptyConversationDetails,
} from "./__fixtures__/empty-conversation-details.ts";
import {
	ChatGptRecoverableRetryExhaustedError,
	ChatGptRunBudget,
	runConversationsAndMessagesStreams as runStreams,
	type StreamDeps,
} from "./index.ts";
import { makePagingApi } from "./__fixtures__/paging-conversation-api.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptApi,
	ChatGptFetchResult,
	ChatGptNode,
	ConversationListItem,
} from "./types.ts";

/** These tests exercise listing and serve no conversation detail; see the helper. */
const runConversationsAndMessagesStreams: typeof runStreams = (
	deps,
	state,
	options,
) =>
	runStreams({ ...deps, api: withEmptyConversationDetails(deps.api) }, state, {
		...options,
		detailPacing: { ...NO_DETAIL_WAITS, ...options?.detailPacing },
	});

// ─── Synthetic fixtures ────────────────────────────────────────────────────

/** Build a conversation-detail mapping with N messages on the current
 *  branch. Shape matches ChatGptFetchResult for /conversation/<id>. */
function makeDetail(convoId: string, messageCount: number): ChatGptFetchResult {
	const mapping: Record<string, ChatGptNode> = {};
	const rootId = `${convoId}-root`;
	const ids: string[] = [];
	for (let i = 0; i < messageCount; i += 1) {
		ids.push(`${convoId}-m${i}`);
	}

	// Root has no `message` (synthetic; extractMessage returns null → skipped).
	mapping[rootId] = {
		id: rootId,
		parent: null,
		children: ids.slice(0, 1),
	};
	for (let i = 0; i < ids.length; i += 1) {
		const id = ids[i];
		if (!id) {
			continue;
		}
		const next = ids[i + 1];
		mapping[id] = {
			id,
			parent: i === 0 ? rootId : (ids[i - 1] ?? rootId),
			children: next ? [next] : [],
			message: {
				id,
				author: { role: i % 2 === 0 ? "user" : "assistant" },
				content: { content_type: "text", parts: [`msg ${i}`] },
				create_time: 1_700_000_000 + i,
				metadata: {},
			},
		};
	}

	return {
		status: 200,
		json: {
			conversation_id: convoId,
			title: `Conversation ${convoId}`,
			current_node: ids.at(-1) ?? rootId,
			create_time: 1_700_000_000,
			update_time: 1_700_001_000,
			mapping,
		},
	};
}

function makeListItem(
	convoId: string,
	updateTimeIso: string,
): ConversationListItem {
	const updateTime = Date.parse(updateTimeIso) / 1000;
	return {
		id: convoId,
		title: `Conversation ${convoId}`,
		create_time: updateTime - 1000,
		update_time: updateTime,
		is_archived: false,
		is_starred: false,
		workspace_id: null,
		current_node: `${convoId}-m1`,
		gizmo_id: null,
	};
}

/** Build a fake `api` that serves a canned first page, then a genuine empty
 *  page at the next offset, plus per-conversation details. */
function makeFakeApi(
	list: ConversationListItem[],
	details: Map<string, ChatGptFetchResult>,
): ChatGptApi {
	return {
		auth: (): Promise<never> =>
			Promise.reject(new Error("auth not used in fake")),
		fetch: (path: string): Promise<ChatGptFetchResult> => {
			if (path.startsWith("/conversations/search?")) {
				const cursor = Number(
					new URLSearchParams(path.split("?")[1]).get("cursor"),
				);
				return Promise.resolve({
					status: 200,
					json: {
						items: cursor === 0 ? list : [],
						total: cursor === 0 ? list.length + 1 : list.length,
					},
				});
			}
			// /conversation/<id>
			const id = decodeURIComponent(path.replace(/^\/conversation\//, ""));
			const detail = details.get(id);
			if (!detail) {
				return Promise.resolve({ status: 404, json: null });
			}
			return Promise.resolve(detail);
		},
	};
}

function silentProgress(): CollectContext["progress"] {
	return (): Promise<void> => Promise.resolve();
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
} {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function makeDeps(
	api: ChatGptApi,
	requested: readonly string[],
): {
	deps: StreamDeps;
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	events: ReturnType<typeof makeRecordingEmit>["events"];
	protocolMessages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
} {
	const harness = makeRecordingEmit(validateRecord);
	const deps: StreamDeps = {
		api,
		sleep: (): Promise<void> => Promise.resolve(),
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: silentProgress(),
		requested: new Map(requested.map((name) => [name, { name }])),
	};
	return {
		deps,
		emitted: harness.emitted,
		events: harness.events,
		protocolMessages: harness.protocolMessages,
	};
}

// ─── Orchestration invariants ──────────────────────────────────────────────

test("runConversationsAndMessagesStreams: every conversation record emits before ALL of its messages", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
		makeListItem("conv-C", "2026-04-22T11:00:00Z"),
	];
	const details = new Map<string, ChatGptFetchResult>([
		["conv-A", makeDetail("conv-A", 2)],
		["conv-B", makeDetail("conv-B", 3)],
		["conv-C", makeDetail("conv-C", 1)],
	]);
	const { deps, emitted } = makeDeps(makeFakeApi(list, details), [
		"conversations",
		"messages",
	]);

	await runConversationsAndMessagesStreams(deps, {});

	// For each convo, find the index of its conversation record and the
	// FIRST message record whose message-id starts with <conv>-m. Assert
	// ordering across every conversation in the batch.
	for (const convoId of ["conv-A", "conv-B", "conv-C"]) {
		const convoIdx = emitted.findIndex(
			(r) => r.stream === "conversations" && r.data.id === convoId,
		);
		const firstMsgIdx = emitted.findIndex(
			(r) =>
				r.stream === "messages" &&
				typeof r.data.id === "string" &&
				r.data.id.startsWith(`${convoId}:${convoId}-m`),
		);
		assert.notEqual(
			convoIdx,
			-1,
			`expected a conversations record for ${convoId}`,
		);
		assert.notEqual(
			firstMsgIdx,
			-1,
			`expected a messages record for ${convoId}`,
		);
		assert.ok(
			convoIdx < firstMsgIdx,
			`${convoId}: conversations record must precede any of its messages`,
		);
	}
});

test("runConversationsAndMessagesStreams: STATE cursor emits once, AFTER every record (unified event trace)", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	];
	const details = new Map<string, ChatGptFetchResult>([
		["conv-A", makeDetail("conv-A", 2)],
		["conv-B", makeDetail("conv-B", 2)],
	]);
	const { deps, emitted, events, protocolMessages } = makeDeps(
		makeFakeApi(list, details),
		["conversations", "messages"],
	);

	await runConversationsAndMessagesStreams(deps, {});

	// Exactly ONE STATE for the conversations stream.
	const states = protocolMessages.filter(
		(m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations",
	);
	assert.equal(
		states.length,
		1,
		"expected a single STATE cursor for conversations",
	);

	// CROSS-KIND ORDERING PROOF via the unified events trace. The previous
	// version of this test used split arrays (.emitted vs .protocolMessages)
	// with no shared sequence — it could not actually prove STATE landed
	// after the last record. The `.events` trace solves that: emit() and
	// emitRecord() both push into it in call order.
	const lastRecordIdx = events.findLastIndex((e) => e.kind === "record");
	const conversationsStateIdx = events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "STATE" &&
			e.message.stream === "conversations",
	);
	assert.notEqual(lastRecordIdx, -1, "expected at least one record event");
	assert.notEqual(
		conversationsStateIdx,
		-1,
		"expected a conversations STATE event",
	);
	assert.ok(
		conversationsStateIdx > lastRecordIdx,
		`STATE must land strictly after the last record in the unified trace (lastRecord=${lastRecordIdx}, state=${conversationsStateIdx})`,
	);

	// Belt-and-braces: no STATE for the conversations stream appears
	// BEFORE any record. Catches a hypothetical per-batch cursor advance
	// slipped into the middle of the loop.
	const firstConversationsStateIdx = events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "STATE" &&
			e.message.stream === "conversations",
	);
	const firstRecordIdx = events.findIndex((e) => e.kind === "record");
	assert.ok(
		firstConversationsStateIdx > firstRecordIdx,
		"no STATE for conversations may precede the first record",
	);

	// Sanity on counts.
	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 2);
	assert.equal(emitted.filter((r) => r.stream === "messages").length, 4);
});

test("runConversationsAndMessagesStreams: STATE cursor reflects max update_time across the batch", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-C", "2026-04-22T11:00:00Z"), // <-- max
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	];
	const details = new Map<string, ChatGptFetchResult>([
		["conv-A", makeDetail("conv-A", 1)],
		["conv-B", makeDetail("conv-B", 1)],
		["conv-C", makeDetail("conv-C", 1)],
	]);
	const { deps, protocolMessages } = makeDeps(makeFakeApi(list, details), [
		"conversations",
		"messages",
	]);

	await runConversationsAndMessagesStreams(deps, {});

	const state = protocolMessages.find(
		(m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations",
	);
	assert.ok(state && state.type === "STATE");
	const cursor = state.cursor as { last_update_time: string | null };
	assert.equal(
		cursor.last_update_time,
		"2026-04-22T11:00:00.000Z",
		"cursor is the max update_time, not the first or last seen",
	);
});

test("runConversationsAndMessagesStreams: STATE waits for slow required detail lane work", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	];
	const convBGate = deferred<ChatGptFetchResult>();
	const fetches: string[] = [];
	const api: ChatGptApi = {
		auth: (): Promise<never> =>
			Promise.reject(new Error("auth not used in fake")),
		fetch: (path: string): Promise<ChatGptFetchResult> => {
			fetches.push(path);
			if (path.startsWith("/conversations/search?")) {
				const cursor = Number(
					new URLSearchParams(path.split("?")[1]).get("cursor"),
				);
				return Promise.resolve({
					status: 200,
					json: {
						items: cursor === 0 ? list : [],
						has_missing_conversations: false,
						total: cursor === 0 ? list.length + 1 : list.length,
					},
				});
			}
			const id = decodeURIComponent(path.replace(/^\/conversation\//, ""));
			if (id === "conv-B") {
				return convBGate.promise;
			}
			return Promise.resolve(makeDetail("conv-A", 1));
		},
	};
	const { deps, events, protocolMessages } = makeDeps(api, [
		"conversations",
		"messages",
	]);

	const run = runConversationsAndMessagesStreams(
		deps,
		{},
		{ detailPacing: { random: () => 0, sleep: () => undefined } },
	);
	await flush();
	assert.equal(
		protocolMessages.some(
			(m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations",
		),
		false,
		"STATE must not emit while required detail work is unsettled",
	);

	convBGate.resolve(makeDetail("conv-B", 1));
	await run;

	assert.deepEqual(fetches, [
		...Array.from({ length: 3 }, () => "/conversations/search?query=&cursor=0"),
		...Array.from(
			{ length: 2 },
			() => "/conversations/search?query=&cursor=30",
		),
		"/conversation/conv-A",
		"/conversation/conv-B",
	]);
	const lastRecordIdx = events.findLastIndex((e) => e.kind === "record");
	const stateIdx = events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "STATE" &&
			e.message.stream === "conversations",
	);
	assert.ok(
		stateIdx > lastRecordIdx,
		"STATE must land after all detail lane records settle",
	);
});

const modelSwitch = JSON.parse(
	readFileSync(
		new URL("./__fixtures__/conversation-model-switch.json", import.meta.url),
		"utf8",
	),
) as { mapping: Record<string, ChatGptNode>; current_node: string };

/** A conversation detail whose branch switches models (gpt-4o, then o3). */
function makeModelSwitchDetail(convoId: string): ChatGptFetchResult {
	return {
		status: 200,
		json: {
			conversation_id: convoId,
			title: `Conversation ${convoId}`,
			create_time: 1_700_000_000,
			update_time: 1_700_001_000,
			...modelSwitch,
		},
	};
}

const MODEL_SWITCH_COUNTS = { "gpt-4o": 2, o3: 2 };
const MODEL_SWITCH_BRANCH_MESSAGES = 11;

/** An api that serves the list, a model-switch detail per id, and logs detail reads. */
function makeDetailLoggingApi(
	list: ConversationListItem[],
	detailFor: (id: string) => ChatGptFetchResult,
): { api: ChatGptApi; detailReads: string[] } {
	const detailReads: string[] = [];
	const inner = makeFakeApi(
		list,
		new Map(list.map((item) => [item.id, detailFor(item.id)])),
	);
	return {
		detailReads,
		api: {
			auth: inner.auth,
			fetch: (path: string): Promise<ChatGptFetchResult> => {
				if (path.startsWith("/conversation/")) {
					detailReads.push(
						decodeURIComponent(path.slice("/conversation/".length)),
					);
				}
				return inner.fetch(path);
			},
		},
	};
}

// `runStreams`, not the listing wrapper above: these tests serve their details.
test("runConversationsAndMessagesStreams: conversations alone reads each detail once, fills the counts, and emits no message, gap or messages progress", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	];
	const { api, detailReads } = makeDetailLoggingApi(
		list,
		makeModelSwitchDetail,
	);
	const { deps, emitted, events, protocolMessages } = makeDeps(api, [
		"conversations",
	]);

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	assert.deepEqual(detailReads.sort(), ["conv-A", "conv-B"]);
	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		0,
		"messages is not requested: no message record",
	);
	const conversations = emitted.filter((r) => r.stream === "conversations");
	assert.deepEqual(
		conversations.map((r) => [
			r.data.id,
			r.data.model_counts,
			r.data.message_count_on_current_branch,
		]),
		[
			["conv-B", MODEL_SWITCH_COUNTS, MODEL_SWITCH_BRANCH_MESSAGES],
			["conv-A", MODEL_SWITCH_COUNTS, MODEL_SWITCH_BRANCH_MESSAGES],
		],
	);
	// Nothing names the unrequested stream: no gap, no progress, no coverage.
	assert.equal(
		protocolMessages.filter(
			(m: EmittedMessage) =>
				m.type === "DETAIL_GAP" ||
				("stream" in m &&
					m.stream === "messages" &&
					(m.type === "PROGRESS" ||
						m.type === "STATE" ||
						m.type === "DETAIL_COVERAGE")),
		).length,
		0,
	);
	const lastRecord = events.findLastIndex((e) => e.kind === "record");
	const stateIndex = events.findIndex(
		(e) =>
			e.kind === "message" &&
			e.message.type === "STATE" &&
			e.message.stream === "conversations",
	);
	assert.ok(stateIndex > lastRecord, "STATE lands after the last record");
});

test("runConversationsAndMessagesStreams: conversations alone does not read message text into any message record or blob", async () => {
	const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
	const { api } = makeDetailLoggingApi(list, makeModelSwitchDetail);
	const { deps, protocolMessages } = makeDeps(api, ["conversations"]);
	let selectionChecks = 0;
	deps.isRecordSelected = (): boolean => {
		selectionChecks += 1;
		return true;
	};

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	assert.equal(selectionChecks, 0, "no message is offered for selection");
	assert.equal(
		protocolMessages.some((m: EmittedMessage) => m.type === "BLOB"),
		false,
	);
});

test("runConversationsAndMessagesStreams: both streams read each detail once", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	];
	const { api, detailReads } = makeDetailLoggingApi(
		list,
		makeModelSwitchDetail,
	);
	const { deps, emitted } = makeDeps(api, ["conversations", "messages"]);

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	assert.deepEqual(detailReads.sort(), ["conv-A", "conv-B"]);
	assert.deepEqual(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => r.data.model_counts),
		[MODEL_SWITCH_COUNTS, MODEL_SWITCH_COUNTS],
	);
	assert.equal(emitted.filter((r) => r.stream === "messages").length > 0, true);
});

test("runConversationsAndMessagesStreams: a conversation only the conversations cursor still owes gets its detail once and no messages", async () => {
	// The messages cursor is ahead of the conversations cursor, so conv-mid is
	// owed to `conversations` only.
	const list = [
		makeListItem("conv-new", "2026-04-22T11:00:00Z"),
		makeListItem("conv-mid", "2026-04-22T09:30:00Z"),
	];
	const { api, detailReads } = makeDetailLoggingApi(
		list,
		makeModelSwitchDetail,
	);
	const { deps, emitted } = makeDeps(api, ["conversations", "messages"]);

	await runStreams(
		deps,
		{
			conversations: {
				last_update_time: "2026-04-22T09:00:00.000Z",
				detail_version: 2,
				detail_frontier: null,
			},
			messages: { last_update_time: "2026-04-22T10:00:00.000Z" },
		},
		{ detailPacing: NO_DETAIL_WAITS },
	);

	assert.deepEqual(detailReads.sort(), ["conv-mid", "conv-new"]);
	const byId = new Map(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => [r.data.id, r.data]),
	);
	assert.deepEqual(byId.get("conv-mid")?.model_counts, MODEL_SWITCH_COUNTS);
	assert.deepEqual(byId.get("conv-new")?.model_counts, MODEL_SWITCH_COUNTS);
	const messageParents = new Set(
		emitted
			.filter((r) => r.stream === "messages")
			.map((r) => r.data.conversation_id),
	);
	assert.deepEqual([...messageParents], ["conv-new"]);
});

/** Detail for every id, except `failing`, which answers with `status`. */
function detailFailingFor(
	failing: string,
	status: number,
): (id: string) => ChatGptFetchResult {
	return (id) =>
		id === failing ? { status, json: null } : makeModelSwitchDetail(id);
}

test("runConversationsAndMessagesStreams: conversations alone keeps every record, with null fields, and succeeds when one detail is a 404", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
		makeListItem("conv-C", "2026-04-22T11:00:00Z"),
	];
	const { api, detailReads } = makeDetailLoggingApi(
		list,
		detailFailingFor("conv-B", 404),
	);
	const { deps, emitted, protocolMessages } = makeDeps(api, ["conversations"]);

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	// The failed conversation does not stop the others from being read.
	assert.deepEqual(detailReads.sort(), ["conv-A", "conv-B", "conv-C"]);
	const byId = new Map(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => [r.data.id, r.data]),
	);
	assert.deepEqual([...byId.keys()].sort(), ["conv-A", "conv-B", "conv-C"]);
	for (const id of ["conv-A", "conv-C"]) {
		assert.deepEqual(byId.get(id)?.model_counts, MODEL_SWITCH_COUNTS);
		assert.equal(
			byId.get(id)?.message_count_on_current_branch,
			MODEL_SWITCH_BRANCH_MESSAGES,
		);
	}
	assert.equal(byId.get("conv-B")?.model_counts, null);
	assert.equal(byId.get("conv-B")?.message_count_on_current_branch, null);
	assert.equal(emitted.filter((r) => r.stream === "messages").length, 0);
	// Nothing names the unrequested stream, and the stream still completes.
	assert.equal(
		protocolMessages.some(
			(m: EmittedMessage) =>
				m.type === "DETAIL_GAP" || ("stream" in m && m.stream === "messages"),
		),
		false,
	);
	assert.equal(
		protocolMessages.some(
			(m: EmittedMessage) => m.type === "STATE" && m.stream === "conversations",
		),
		true,
	);
});

test("runConversationsAndMessagesStreams: conversations alone does not retry a 404 detail", async () => {
	const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
	const { api, detailReads } = makeDetailLoggingApi(
		list,
		detailFailingFor("conv-A", 404),
	);
	const { deps } = makeDeps(api, ["conversations"]);

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	assert.deepEqual(detailReads, ["conv-A"]);
});

test("runConversationsAndMessagesStreams: both streams still fail the run on a 404 detail", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T09:00:00Z"),
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	];
	const { api } = makeDetailLoggingApi(list, detailFailingFor("conv-B", 404));
	const { deps } = makeDeps(api, ["conversations", "messages"]);

	await assert.rejects(
		runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS }),
		/required conversation detail conv-B failed with http 404/,
	);
});

test("runConversationsAndMessagesStreams: messages alone still fails the run on a 404 detail", async () => {
	const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
	const { api } = makeDetailLoggingApi(list, detailFailingFor("conv-A", 404));
	const { deps } = makeDeps(api, ["messages"]);

	await assert.rejects(
		runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS }),
		/required conversation detail conv-A failed with http 404/,
	);
});

test("runConversationsAndMessagesStreams: conversations alone still fails the run when a detail answers with an auth status", async () => {
	await Promise.all(
		[401, 403, 429].map(async (status) => {
			const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
			const { api } = makeDetailLoggingApi(
				list,
				detailFailingFor("conv-A", status),
			);
			const { deps } = makeDeps(api, ["conversations"]);

			await assert.rejects(
				runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS }),
				new RegExp(
					`required conversation detail conv-A failed with http ${status}`,
				),
			);
		}),
	);
});

test("runConversationsAndMessagesStreams: conversations alone still fails the run when the client throws an auth error on a detail", async () => {
	const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
	const { api: inner } = makeDetailLoggingApi(list, makeModelSwitchDetail);
	const api: ChatGptApi = {
		auth: inner.auth,
		fetch: (path: string): Promise<ChatGptFetchResult> =>
			path.startsWith("/conversation/")
				? Promise.reject(
						new Error(`apiFetch got 401 on GET ${path} (auth - not retryable)`),
					)
				: inner.fetch(path),
	};
	const { deps } = makeDeps(api, ["conversations"]);

	await assert.rejects(
		runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS }),
		/apiFetch got 401/,
	);
});

test("runConversationsAndMessagesStreams: a conversation only the conversations cursor owes keeps a null-field record on a 404 while messages still run", async () => {
	// conv-mid is owed to `conversations` only; conv-new is owed to both.
	const list = [
		makeListItem("conv-new", "2026-04-22T11:00:00Z"),
		makeListItem("conv-mid", "2026-04-22T09:30:00Z"),
	];
	const { api } = makeDetailLoggingApi(list, detailFailingFor("conv-mid", 404));
	const { deps, emitted } = makeDeps(api, ["conversations", "messages"]);

	await runStreams(
		deps,
		{
			conversations: {
				last_update_time: "2026-04-22T09:00:00.000Z",
				detail_version: 2,
				detail_frontier: null,
			},
			messages: { last_update_time: "2026-04-22T10:00:00.000Z" },
		},
		{ detailPacing: NO_DETAIL_WAITS },
	);

	const byId = new Map(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => [r.data.id, r.data]),
	);
	assert.equal(byId.get("conv-mid")?.model_counts, null);
	assert.deepEqual(byId.get("conv-new")?.model_counts, MODEL_SWITCH_COUNTS);
});

/** The cursor of the last `conversations` STATE a run emitted. */
function lastConversationsCursor(
	protocolMessages: readonly EmittedMessage[],
): Record<string, unknown> {
	const state = protocolMessages.findLast(
		(m): m is Extract<EmittedMessage, { type: "STATE" }> =>
			m.type === "STATE" && m.stream === "conversations",
	);
	assert.ok(state, "a conversations STATE was emitted");
	return state.cursor as Record<string, unknown>;
}

/**
 * Run `conversations` alone over `list`, from `state`, and report which details
 * it read, the records it emitted and the cursor it left for the next run.
 */
async function runConversationsOnly(
	list: ConversationListItem[],
	detailFor: (id: string) => ChatGptFetchResult,
	state: Record<string, unknown>,
	configure: (deps: StreamDeps) => void = () => undefined,
): Promise<{
	detailReads: string[];
	cursor: Record<string, unknown>;
	byId: Map<unknown, Record<string, unknown>>;
	protocolMessages: readonly EmittedMessage[];
}> {
	const { api, detailReads } = makeDetailLoggingApi(list, detailFor);
	const { deps, emitted, protocolMessages } = makeDeps(api, ["conversations"]);
	configure(deps);
	await runStreams(deps, state, { detailPacing: NO_DETAIL_WAITS });
	return {
		detailReads,
		cursor: lastConversationsCursor(protocolMessages),
		byId: new Map(
			emitted
				.filter((r) => r.stream === "conversations")
				.map((r) => [r.data.id, r.data as Record<string, unknown>]),
		),
		protocolMessages,
	};
}

const THREE = [
	makeListItem("conv-C", "2026-04-22T11:00:00Z"),
	makeListItem("conv-B", "2026-04-22T10:00:00Z"),
	makeListItem("conv-A", "2026-04-22T09:00:00Z"),
];
/** The cursor of a run that read THREE to the bottom: only the newest key is kept. */
const ALL_READ_CURSOR = {
	last_update_time: "2026-04-22T11:00:00.000Z",
	detail_version: 2,
	detail_frontier: null,
	detail_ids: { "2026-04-22T11:00:00.000Z": ["conv-C"] },
};

/** ALL_READ_CURSOR, except conv-B answered a retryable failure once. */
const WITH_B_FAILED = {
	...ALL_READ_CURSOR,
	detail_failures: { "conv-B": { n: 1, t: "2026-04-22T10:00:00.000Z" } },
};

test("runConversationsAndMessagesStreams: conversations alone reads the newest conversation first and the next run reads only the ones the run budget deferred", async () => {
	const first = await runConversationsOnly(
		THREE,
		makeModelSwitchDetail,
		{},
		(deps) => {
			deps.runBudget = new ChatGptRunBudget({ maxFetches: 1 });
		},
	);

	assert.deepEqual(first.detailReads, ["conv-C"]);
	assert.deepEqual(first.byId.get("conv-C")?.model_counts, MODEL_SWITCH_COUNTS);
	// The deferred rows keep a record, with unknown counts, and no gap names a stream.
	assert.equal(first.byId.get("conv-B")?.model_counts, null);
	assert.equal(first.byId.get("conv-A")?.model_counts, null);
	assert.equal(
		first.protocolMessages.some((m) => m.type === "DETAIL_GAP"),
		false,
	);
	// The watermark and the history frontier both stand at the one row read, and
	// the exact key says which row it was.
	assert.deepEqual(first.cursor, {
		last_update_time: "2026-04-22T11:00:00.000Z",
		detail_version: 2,
		detail_frontier: "2026-04-22T11:00:00.000Z",
		detail_ids: { "2026-04-22T11:00:00.000Z": ["conv-C"] },
	});

	// The next run reads only the two that were deferred, and then the cursor is clear.
	const second = await runConversationsOnly(THREE, makeModelSwitchDetail, {
		conversations: first.cursor,
	});
	assert.deepEqual(second.detailReads, ["conv-B", "conv-A"]);
	assert.deepEqual(
		second.byId.get("conv-B")?.model_counts,
		MODEL_SWITCH_COUNTS,
	);
	assert.deepEqual(
		second.byId.get("conv-A")?.model_counts,
		MODEL_SWITCH_COUNTS,
	);
	assert.equal(
		second.byId.has("conv-C"),
		false,
		"a row already read is not emitted again",
	);
	assert.deepEqual(second.cursor, ALL_READ_CURSOR);

	const third = await runConversationsOnly(THREE, makeModelSwitchDetail, {
		conversations: second.cursor,
	});
	assert.deepEqual(third.detailReads, []);
});

test("runConversationsAndMessagesStreams: conversations alone retries, on the next run, the details a rate-limit exhaustion deferred", async () => {
	const { api: inner, detailReads } = makeDetailLoggingApi(
		THREE,
		makeModelSwitchDetail,
	);
	const pressured: ChatGptApi = {
		auth: inner.auth,
		fetch: (path, options) =>
			path === "/conversation/conv-B"
				? Promise.reject(
						new ChatGptRecoverableRetryExhaustedError("429 after retries", {
							class: "rate_limited",
							httpStatus: 429,
						}),
					)
				: inner.fetch(path, options),
	};
	const { deps, emitted, protocolMessages } = makeDeps(pressured, [
		"conversations",
	]);

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	// conv-C was read; conv-B exhausted the lane; conv-A was never reached.
	assert.deepEqual(detailReads, ["conv-C"]);
	assert.deepEqual(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => [r.data.id, r.data.model_counts === null]),
		[
			["conv-C", false],
			["conv-B", true],
			["conv-A", true],
		],
	);
	const cursor = lastConversationsCursor(protocolMessages);
	// A deferral is pressure, not a failure of the row: nothing is counted.
	assert.equal(cursor.detail_failures, undefined);

	// The source recovers: the next run reads exactly the rows still owed.
	const next = await runConversationsOnly(THREE, makeModelSwitchDetail, {
		conversations: cursor,
	});
	assert.deepEqual(next.detailReads, ["conv-B", "conv-A"]);
	assert.deepEqual(next.cursor, ALL_READ_CURSOR);
});

test("runConversationsAndMessagesStreams: conversations alone keeps asking for a conversation that stays rate-limited without reading or emitting the rows it already settled", async () => {
	const rateLimited = (inner: ChatGptApi): ChatGptApi => ({
		auth: inner.auth,
		fetch: (path, options) =>
			path === "/conversation/conv-B"
				? Promise.reject(
						new ChatGptRecoverableRetryExhaustedError("429 after retries", {
							class: "rate_limited",
							httpStatus: 429,
						}),
					)
				: inner.fetch(path, options),
	});
	let state: Record<string, unknown> = {};
	for (let run = 1; run <= 4; run += 1) {
		const { api: inner, detailReads } = makeDetailLoggingApi(
			THREE,
			makeModelSwitchDetail,
		);
		const { deps, emitted, protocolMessages } = makeDeps(rateLimited(inner), [
			"conversations",
		]);
		await runStreams(deps, state, { detailPacing: NO_DETAIL_WAITS });
		const cursor = lastConversationsCursor(protocolMessages);
		// Run 1 reads conv-C; the later runs have nothing the source will serve.
		assert.deepEqual(detailReads, run === 1 ? ["conv-C"] : [], `run ${run}`);
		// Rows already emitted are never emitted again, so counts are never
		// overwritten, and a history row that was not read has no new record.
		assert.deepEqual(
			emitted.filter((r) => r.stream === "conversations").map((r) => r.data.id),
			run === 1 ? ["conv-C", "conv-B", "conv-A"] : [],
			`run ${run}`,
		);
		// Pressure never counts against a row, so the cursor does not change and
		// no row is given up on: the rows wait until the source serves them.
		assert.equal(cursor.detail_failures, undefined, `run ${run}`);
		state = { conversations: cursor };
	}
	const recovered = await runConversationsOnly(
		THREE,
		makeModelSwitchDetail,
		state,
	);
	assert.deepEqual(recovered.detailReads, ["conv-B", "conv-A"]);
	assert.deepEqual(recovered.cursor, ALL_READ_CURSOR);
});

test("runConversationsAndMessagesStreams: conversations alone retries a conversation whose detail failed with a transient 4xx without reading the others again, and lets it go after three runs", async () => {
	const failing = (id: string): ChatGptFetchResult =>
		id === "conv-B" ? { status: 422, json: null } : makeModelSwitchDetail(id);

	const run1 = await runConversationsOnly(THREE, failing, {});
	assert.deepEqual(run1.detailReads, ["conv-C", "conv-B", "conv-A"]);
	assert.equal(run1.byId.get("conv-B")?.model_counts, null);
	assert.deepEqual(run1.byId.get("conv-C")?.model_counts, MODEL_SWITCH_COUNTS);
	assert.deepEqual(run1.cursor, WITH_B_FAILED);

	// The run after it, the source answers: only conv-B is read, and the others
	// keep the counts they have.
	const recovered = await runConversationsOnly(THREE, makeModelSwitchDetail, {
		conversations: run1.cursor,
	});
	assert.deepEqual(recovered.detailReads, ["conv-B"]);
	assert.deepEqual(
		[...recovered.byId.keys()],
		["conv-B"],
		"settled rows are not emitted again with null counts",
	);
	assert.deepEqual(
		recovered.byId.get("conv-B")?.model_counts,
		MODEL_SWITCH_COUNTS,
	);
	assert.deepEqual(recovered.cursor, ALL_READ_CURSOR);

	// If it keeps failing, it is retried twice more and then left list-only.
	const run2 = await runConversationsOnly(THREE, failing, {
		conversations: run1.cursor,
	});
	assert.deepEqual(run2.detailReads, ["conv-B"]);
	assert.deepEqual(run2.cursor.detail_failures, {
		"conv-B": { n: 2, t: "2026-04-22T10:00:00.000Z" },
	});
	const run3 = await runConversationsOnly(THREE, failing, {
		conversations: run2.cursor,
	});
	assert.deepEqual(run3.detailReads, ["conv-B"]);
	assert.deepEqual(run3.cursor, ALL_READ_CURSOR);
	const run4 = await runConversationsOnly(THREE, failing, {
		conversations: run3.cursor,
	});
	assert.deepEqual(run4.detailReads, []);
});

test("runConversationsAndMessagesStreams: conversations alone does not overwrite a settled row's counts when an older row is retried", async () => {
	const failing = (id: string): ChatGptFetchResult =>
		id === "conv-B" ? { status: 422, json: null } : makeModelSwitchDetail(id);
	// Run 1: conv-B answers 422 and conv-C is read.
	const run1 = await runConversationsOnly(THREE, failing, {});
	assert.deepEqual(run1.byId.get("conv-C")?.model_counts, MODEL_SWITCH_COUNTS);

	// Run 2: conv-B stays unreadable. conv-C is listed again but is not emitted,
	// so the valid record from run 1 stands.
	const run2 = await runConversationsOnly(THREE, failing, {
		conversations: run1.cursor,
	});
	assert.deepEqual(run2.detailReads, ["conv-B"]);
	assert.equal(run2.byId.has("conv-C"), false);
	assert.equal(run2.byId.has("conv-A"), false);
});

test("runConversationsAndMessagesStreams: conversations alone retries a 200 whose detail has no mapping", async () => {
	const noMapping = (id: string): ChatGptFetchResult =>
		id === "conv-B"
			? { status: 200, json: { id, current_node: null } }
			: makeModelSwitchDetail(id);

	const run = await runConversationsOnly(THREE, noMapping, {});

	assert.equal(run.byId.get("conv-B")?.model_counts, null);
	assert.deepEqual(run.cursor, WITH_B_FAILED);
});

test("runConversationsAndMessagesStreams: conversations alone treats a 404 or a 410 as a deleted conversation and does not retry it", async () => {
	for (const status of [404, 410]) {
		const run = await runConversationsOnly(
			THREE,
			(id) =>
				id === "conv-B" ? { status, json: null } : makeModelSwitchDetail(id),
			{},
		);
		assert.equal(run.byId.get("conv-B")?.model_counts, null);
		assert.deepEqual(run.cursor, ALL_READ_CURSOR, `http ${status}`);
		const next = await runConversationsOnly(THREE, makeModelSwitchDetail, {
			conversations: run.cursor,
		});
		assert.deepEqual(next.detailReads, [], `http ${status} is not read again`);
	}
});

test("runConversationsAndMessagesStreams: a conversations cursor from before model counts reads every conversation once, newest first, and survives a stop partway", async () => {
	const legacy = {
		conversations: { last_update_time: "2026-04-22T11:00:00.000Z" },
	};

	// A cursor in the published shape keeps its watermark but says no detail is
	// read: the run reads the row at the watermark, then history newest first.
	const capped = await runConversationsOnly(
		THREE,
		makeModelSwitchDetail,
		legacy,
		(deps) => {
			deps.runBudget = new ChatGptRunBudget({ maxFetches: 2 });
		},
	);
	assert.deepEqual(capped.detailReads, ["conv-C", "conv-B"]);
	assert.deepEqual(capped.cursor, {
		last_update_time: "2026-04-22T11:00:00.000Z",
		detail_version: 2,
		detail_frontier: "2026-04-22T10:00:00.000Z",
		detail_ids: {
			"2026-04-22T10:00:00.000Z": ["conv-B"],
			"2026-04-22T11:00:00.000Z": ["conv-C"],
		},
	});
	assert.equal(
		capped.byId.has("conv-A"),
		false,
		"a history row that was not read keeps the record it has",
	);

	// The stopped run resumes at the row it did not reach, not from the start.
	const resumed = await runConversationsOnly(THREE, makeModelSwitchDetail, {
		conversations: capped.cursor,
	});
	assert.deepEqual(resumed.detailReads, ["conv-A"]);
	assert.deepEqual(resumed.cursor, ALL_READ_CURSOR);

	// Once versioned, a cursor at the newest row owes nothing.
	const done = await runConversationsOnly(THREE, makeModelSwitchDetail, {
		conversations: resumed.cursor,
	});
	assert.deepEqual(done.detailReads, []);
});

test("runConversationsAndMessagesStreams: conversations alone reads fresh conversations before the history behind them, once each, while a capped backfill runs", async () => {
	const at = (hour: number): string =>
		`2026-04-22T${String(hour).padStart(2, "0")}:00:00Z`;
	const history = [6, 5, 4, 3, 2, 1].map((h) =>
		makeListItem(`old-${h}`, at(h)),
	);
	const capped = (deps: StreamDeps): void => {
		deps.runBudget = new ChatGptRunBudget({ maxFetches: 2 });
	};
	const allReads: string[] = [];

	const run1 = await runConversationsOnly(
		history,
		makeModelSwitchDetail,
		{},
		capped,
	);
	assert.deepEqual(run1.detailReads, ["old-6", "old-5"]);
	allReads.push(...run1.detailReads);

	// Two conversations arrive while the backfill is part way through.
	const withArrivals = [
		makeListItem("new-2", at(13)),
		makeListItem("new-1", at(12)),
		...history,
	];
	const run2 = await runConversationsOnly(
		withArrivals,
		makeModelSwitchDetail,
		{ conversations: run1.cursor },
		capped,
	);
	assert.deepEqual(
		run2.detailReads,
		["new-1", "new-2"],
		"fresh rows go first, oldest first, so the watermark advances without a gap",
	);
	for (const id of ["new-2", "new-1"]) {
		assert.deepEqual(run2.byId.get(id)?.model_counts, MODEL_SWITCH_COUNTS);
	}
	allReads.push(...run2.detailReads);

	// The backfill carries on where it was, without reading anything twice.
	let cursor = run2.cursor;
	for (const expected of [
		["old-4", "old-3"],
		["old-2", "old-1"],
	]) {
		const run = await runConversationsOnly(
			withArrivals,
			makeModelSwitchDetail,
			{ conversations: cursor },
			capped,
		);
		assert.deepEqual(run.detailReads, expected);
		allReads.push(...run.detailReads);
		cursor = run.cursor;
	}
	assert.equal(new Set(allReads).size, allReads.length, "no detail read twice");
	assert.equal(allReads.length, withArrivals.length);
	assert.deepEqual(cursor, {
		last_update_time: "2026-04-22T13:00:00.000Z",
		detail_version: 2,
		detail_frontier: null,
		detail_ids: { "2026-04-22T13:00:00.000Z": ["new-2"] },
	});
});

test("runConversationsAndMessagesStreams: conversations alone reaches every conversation that shares an update time when the run budget allows one detail", async () => {
	const sameTime = [
		makeListItem("conv-B", "2026-04-22T10:00:00Z"),
		makeListItem("conv-A", "2026-04-22T10:00:00Z"),
	];
	const one = (deps: StreamDeps): void => {
		deps.runBudget = new ChatGptRunBudget({ maxFetches: 1 });
	};
	const reads: string[] = [];
	let state: Record<string, unknown> = {};
	for (let run = 1; run <= 3; run += 1) {
		const result = await runConversationsOnly(
			sameTime,
			makeModelSwitchDetail,
			state,
			one,
		);
		reads.push(...result.detailReads);
		state = { conversations: result.cursor };
	}
	// Each run takes one of the two, then nothing is left.
	assert.deepEqual(reads, ["conv-A", "conv-B"]);
	assert.deepEqual(state, {
		conversations: {
			last_update_time: "2026-04-22T10:00:00.000Z",
			detail_version: 2,
			detail_frontier: null,
			detail_ids: { "2026-04-22T10:00:00.000Z": ["conv-A", "conv-B"] },
		},
	});
});

test("runConversationsAndMessagesStreams: conversations alone checkpoints the cursor during the pass, so a run that dies keeps its progress", async () => {
	const many = Array.from({ length: 30 }, (_, i) =>
		makeListItem(
			`conv-${String(i).padStart(2, "0")}`,
			new Date(Date.parse("2026-04-22T00:00:00Z") + i * 60_000).toISOString(),
		),
	).reverse();
	const { api: inner, detailReads } = makeDetailLoggingApi(
		many,
		makeModelSwitchDetail,
	);
	// The client throws on the 28th detail (conv-02, newest first): an account-level failure.
	const dying: ChatGptApi = {
		auth: inner.auth,
		fetch: (path, options) =>
			path === "/conversation/conv-02"
				? Promise.reject(new Error("apiFetch got 401 (auth - not retryable)"))
				: inner.fetch(path, options),
	};
	const { deps, protocolMessages } = makeDeps(dying, ["conversations"]);

	await assert.rejects(
		runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS }),
		/apiFetch got 401/,
	);

	// 25 conversations settled before the run died, and that was checkpointed: the
	// frontier reaches down to conv-05, the oldest of them, just above conv-04.
	const checkpoint = lastConversationsCursor(protocolMessages);
	assert.deepEqual(checkpoint, {
		last_update_time: "2026-04-22T00:29:00.000Z",
		detail_version: 2,
		detail_frontier: "2026-04-22T00:05:00.000Z",
		detail_ids: {
			"2026-04-22T00:05:00.000Z": ["conv-05"],
			"2026-04-22T00:29:00.000Z": ["conv-29"],
		},
	});
	assert.equal(detailReads.length, 27, "conv-02 died before it was served");

	// The next run picks up after the checkpoint instead of redoing the 25.
	const resumed = await runConversationsOnly(many, makeModelSwitchDetail, {
		conversations: checkpoint,
	});
	assert.deepEqual(resumed.detailReads, [
		"conv-04",
		"conv-03",
		"conv-02",
		"conv-01",
		"conv-00",
	]);
});

test("runConversationsAndMessagesStreams: both streams do not start a second detail pass into an account the messages pass deferred", async () => {
	// conv-n1 and conv-n2 are owed to messages; conv-mid only to conversations.
	const list = [
		makeListItem("conv-n1", "2026-04-22T12:00:00Z"),
		makeListItem("conv-n2", "2026-04-22T11:00:00Z"),
		makeListItem("conv-mid", "2026-04-22T09:30:00Z"),
	];
	const { api: inner, detailReads } = makeDetailLoggingApi(
		list,
		makeModelSwitchDetail,
	);
	const pressured: ChatGptApi = {
		auth: inner.auth,
		fetch: (path, options) =>
			path === "/conversation/conv-n2"
				? Promise.reject(
						new ChatGptRecoverableRetryExhaustedError("429 after retries", {
							class: "rate_limited",
							httpStatus: 429,
						}),
					)
				: inner.fetch(path, options),
	};
	const { deps, emitted, protocolMessages } = makeDeps(pressured, [
		"conversations",
		"messages",
	]);

	await runStreams(
		deps,
		{
			conversations: {
				last_update_time: "2026-04-22T09:00:00.000Z",
				detail_version: 2,
				detail_frontier: null,
			},
			messages: { last_update_time: "2026-04-22T10:00:00.000Z" },
		},
		{ detailPacing: NO_DETAIL_WAITS },
	);

	assert.equal(
		detailReads.includes("conv-mid"),
		false,
		"the pressured account is not read again by the conversations pass",
	);
	const mid = emitted.find(
		(r) => r.stream === "conversations" && r.data.id === "conv-mid",
	);
	assert.equal(mid?.data.model_counts, null, "listed, counts unknown");
	// conv-mid is the only row still owed, so the watermark stays below it. The
	// two rows the messages pass took are kept as exact keys above it.
	assert.deepEqual(lastConversationsCursor(protocolMessages), {
		last_update_time: "2026-04-22T09:00:00.000Z",
		detail_version: 2,
		detail_frontier: null,
		detail_ids: {
			"2026-04-22T11:00:00.000Z": ["conv-n2"],
			"2026-04-22T12:00:00.000Z": ["conv-n1"],
		},
	});
});

test("runConversationsAndMessagesStreams: messages backfill is independent from conversations cursor", async () => {
	const list = [
		makeListItem("conv-new", "2026-04-22T10:00:00Z"),
		makeListItem("conv-old", "2026-04-22T09:00:00Z"),
	];
	const details = new Map<string, ChatGptFetchResult>([
		["conv-new", makeDetail("conv-new", 1)],
		["conv-old", makeDetail("conv-old", 1)],
	]);
	const fetches: string[] = [];
	const api = makeFakeApi(list, details);
	const recordingApi: ChatGptApi = {
		auth: api.auth,
		fetch: (path: string): Promise<ChatGptFetchResult> => {
			fetches.push(path);
			return api.fetch(path);
		},
	};
	const { deps, emitted, protocolMessages } = makeDeps(recordingApi, [
		"messages",
	]);

	await runConversationsAndMessagesStreams(deps, {
		conversations: { last_update_time: "2026-04-22T10:00:00.000Z" },
	});

	assert.deepEqual(fetches, [
		...Array.from({ length: 3 }, () => "/conversations/search?query=&cursor=0"),
		...Array.from(
			{ length: 2 },
			() => "/conversations/search?query=&cursor=30",
		),
		"/conversation/conv-new",
		"/conversation/conv-old",
	]);
	assert.equal(emitted.filter((r) => r.stream === "conversations").length, 0);
	assert.equal(emitted.filter((r) => r.stream === "messages").length, 2);
	assert.equal(
		protocolMessages.some(
			(m) => m.type === "STATE" && m.stream === "conversations",
		),
		false,
		"messages-only backfill must not advance the parent conversations cursor",
	);
	const messagesState = protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "messages",
	);
	assert.ok(messagesState && messagesState.type === "STATE");
	assert.deepEqual(messagesState.cursor, {
		last_update_time: "2026-04-22T10:00:00.000Z",
	});
});

test("runConversationsAndMessagesStreams: coalesces divergent parent/message cursors into one list request", async () => {
	const list = [
		makeListItem("conv-new", "2026-04-22T11:00:00Z"),
		makeListItem("conv-mid", "2026-04-22T10:00:00Z"),
		makeListItem("conv-old", "2026-04-22T09:00:00Z"),
	];
	const details = new Map<string, ChatGptFetchResult>([
		["conv-new", makeDetail("conv-new", 1)],
		["conv-mid", makeDetail("conv-mid", 1)],
		["conv-old", makeDetail("conv-old", 1)],
	]);
	const fetches: string[] = [];
	const api = makeFakeApi(list, details);
	const recordingApi: ChatGptApi = {
		auth: api.auth,
		fetch: (path: string): Promise<ChatGptFetchResult> => {
			fetches.push(path);
			return api.fetch(path);
		},
	};
	const { deps, emitted, protocolMessages } = makeDeps(recordingApi, [
		"conversations",
		"messages",
	]);

	await runConversationsAndMessagesStreams(deps, {
		conversations: {
			last_update_time: "2026-04-22T10:00:00.000Z",
			detail_version: 2,
			detail_frontier: null,
			detail_ids: { "2026-04-22T10:00:00.000Z": ["conv-mid"] },
		},
		messages: { last_update_time: "2026-04-22T09:00:00.000Z" },
	});

	assert.deepEqual(fetches, [
		...Array.from({ length: 3 }, () => "/conversations/search?query=&cursor=0"),
		...Array.from(
			{ length: 2 },
			() => "/conversations/search?query=&cursor=30",
		),
		"/conversation/conv-new",
		"/conversation/conv-mid",
	]);
	assert.deepEqual(
		emitted.filter((r) => r.stream === "conversations").map((r) => r.data.id),
		["conv-new", "conv-mid"],
		"parents emit once per conversation already hydrated by the required message detail lane",
	);
	assert.deepEqual(
		emitted
			.filter((r) => r.stream === "messages")
			.map((r) => r.data.conversation_id),
		["conv-new", "conv-mid"],
	);

	const conversationsState = protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "conversations",
	);
	assert.ok(conversationsState && conversationsState.type === "STATE");
	assert.deepEqual(conversationsState.cursor, {
		last_update_time: "2026-04-22T11:00:00.000Z",
		detail_version: 2,
		detail_frontier: null,
		detail_ids: { "2026-04-22T11:00:00.000Z": ["conv-new"] },
	});

	const messagesState = protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "messages",
	);
	assert.ok(messagesState && messagesState.type === "STATE");
	assert.deepEqual(messagesState.cursor, {
		last_update_time: "2026-04-22T11:00:00.000Z",
	});
});

// ─── Cursor invariant: a conversation is done only for the (id, time) it was read at ───

const iso = (hour: number, minute = 0): string =>
	`2026-04-22T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`;

test("runConversationsAndMessagesStreams: conversations alone reads a conversation that arrives at the newest timestamp after the run listed it", async () => {
	const first = await runConversationsOnly(
		[makeListItem("conv-P", iso(11))],
		makeModelSwitchDetail,
		{},
	);
	assert.deepEqual(first.detailReads, ["conv-P"]);

	// conv-Z took the same update time after the first run read its list page.
	const second = await runConversationsOnly(
		[makeListItem("conv-Z", iso(11)), makeListItem("conv-P", iso(11))],
		makeModelSwitchDetail,
		{ conversations: first.cursor },
	);
	assert.deepEqual(second.detailReads, ["conv-Z"], "the unseen tie is read");
	assert.deepEqual(
		second.byId.get("conv-Z")?.model_counts,
		MODEL_SWITCH_COUNTS,
	);
	assert.equal(
		second.byId.has("conv-P"),
		false,
		"the seen tie is not read again",
	);
	assert.deepEqual(second.cursor.detail_ids, {
		"2026-04-22T11:00:00.000Z": ["conv-P", "conv-Z"],
	});
});

test("runConversationsAndMessagesStreams: conversations alone does not mark an arrival done when it joins the newest timestamp between two list pages", async () => {
	const rows = Array.from({ length: 40 }, (_, i) =>
		makeListItem(`conv-${String(i).padStart(2, "0")}`, iso(10, 59 - i)),
	);
	let upstream = [...rows];
	const reads: string[] = [];
	let injected = false;
	const api = makePagingApi({
		list: () => upstream,
		detail: (id) => {
			reads.push(id);
			return makeModelSwitchDetail(id);
		},
		onListPage: (cursor) => {
			// The second page is requested after the first was read.
			if (cursor === 30 && !injected) {
				injected = true;
				upstream = [makeListItem("conv-late", iso(10, 59)), ...upstream];
			}
			return undefined;
		},
	});
	const run1 = makeDeps(api, ["conversations"]);
	await runStreams(run1.deps, {}, { detailPacing: NO_DETAIL_WAITS });
	assert.equal(injected, true);
	let cursor = lastConversationsCursor(run1.protocolMessages);

	// Later runs, with nothing else going wrong, reach it.
	for (let run = 0; run < 3 && !reads.includes("conv-late"); run += 1) {
		const next = makeDeps(api, ["conversations"]);
		await runStreams(
			next.deps,
			{ conversations: cursor },
			{ detailPacing: NO_DETAIL_WAITS },
		);
		cursor = lastConversationsCursor(next.protocolMessages);
	}
	assert.equal(reads.includes("conv-late"), true, "the late arrival is read");
	assert.equal(
		new Set(reads).size,
		reads.length,
		"and no conversation is read twice",
	);
	assert.equal(reads.length, 41);
});

test("runConversationsAndMessagesStreams: conversations alone starts from the published watermark, reads a bounded slice of history per run, and emits only the rows it read", async () => {
	const base = Date.parse(iso(8)) / 1000;
	const history = Array.from({ length: 70 }, (_, i) => ({
		...makeListItem(`old-${String(i).padStart(2, "0")}`, iso(8)),
		update_time: base + 70 - i,
	}));
	// The published cursor: a watermark and nothing else.
	const legacy = {
		conversations: {
			last_update_time: new Date((base + 70) * 1000).toISOString(),
		},
	};
	const api = (): ReturnType<typeof makePagingApi> & { reads: string[] } => {
		const reads: string[] = [];
		return Object.assign(
			makePagingApi({
				list: () => history,
				detail: (id) => {
					reads.push(id);
					return makeModelSwitchDetail(id);
				},
			}),
			{ reads },
		);
	};
	const runOnce = async (
		state: Record<string, unknown>,
	): Promise<{
		reads: string[];
		emitted: string[];
		cursor: Record<string, unknown>;
	}> => {
		const fake = api();
		const { deps, emitted, protocolMessages } = makeDeps(fake, [
			"conversations",
		]);
		await runStreams(deps, state, {
			detailPacing: NO_DETAIL_WAITS,
			detailBackfillLimit: 20,
		});
		return {
			reads: fake.reads,
			emitted: emitted
				.filter((r) => r.stream === "conversations")
				.map((r) => String(r.data.id)),
			cursor: lastConversationsCursor(protocolMessages),
		};
	};

	const first = await runOnce(legacy);
	// The row at the watermark has no recorded read, so it goes first; then 20 of history.
	assert.equal(first.reads.length, 21);
	assert.deepEqual(
		[...first.emitted].sort(),
		[...first.reads].sort(),
		"only rows that were read are emitted: the first run does not re-emit the history",
	);
	assert.equal(
		first.cursor.last_update_time,
		legacy.conversations.last_update_time,
		"the published watermark is kept for listing",
	);

	// The backfill carries on from where it stopped, without reading a row twice.
	const reads = [...first.reads];
	let cursor = first.cursor;
	for (let run = 0; run < 3; run += 1) {
		const next = await runOnce({ conversations: cursor });
		assert.ok(next.reads.length <= 20);
		assert.deepEqual([...next.emitted].sort(), [...next.reads].sort());
		reads.push(...next.reads);
		cursor = next.cursor;
	}
	assert.equal(new Set(reads).size, 70);
	assert.equal(reads.length, 70);
	assert.equal(cursor.detail_frontier, null);
});

test("runConversationsAndMessagesStreams: conversations alone reads a conversation updated to exactly the watermark time", async () => {
	const first = await runConversationsOnly(
		[makeListItem("conv-A", iso(10)), makeListItem("conv-B", iso(9))],
		makeModelSwitchDetail,
		{},
	);
	assert.deepEqual(first.detailReads, ["conv-A", "conv-B"]);

	// conv-B is updated to the time of the watermark, not past it.
	const second = await runConversationsOnly(
		[makeListItem("conv-A", iso(10)), makeListItem("conv-B", iso(10))],
		makeModelSwitchDetail,
		{ conversations: first.cursor },
	);
	assert.deepEqual(second.detailReads, ["conv-B"]);
	assert.deepEqual(
		second.byId.get("conv-B")?.model_counts,
		MODEL_SWITCH_COUNTS,
	);
	assert.equal(second.byId.has("conv-A"), false);
});

test("runConversationsAndMessagesStreams: conversations alone does not read a released conversation again after an incomplete list walk", async () => {
	const rows = Array.from({ length: 100 }, (_, i) =>
		makeListItem(`conv-${String(i).padStart(3, "0")}`, iso(9, 0)),
	).map((c, i) => ({
		...c,
		update_time: Date.parse(iso(9, 0)) / 1000 - i * 60,
	}));
	const reads: string[] = [];
	const makeApi = () =>
		makePagingApi({
			list: () => rows,
			// Every detail answers a retryable failure.
			detail: (id) => {
				reads.push(id);
				return { status: 422, json: null };
			},
			// The third page of the list never loads.
			onListPage: (cursor) =>
				cursor === 60 ? { status: 503, json: null } : undefined,
		});

	const run1 = makeDeps(makeApi(), ["conversations"]);
	await runStreams(run1.deps, {}, { detailPacing: NO_DETAIL_WAITS });
	const cursor1 = lastConversationsCursor(run1.protocolMessages);
	const failing = Object.keys(
		(cursor1.detail_failures ?? {}) as Record<string, unknown>,
	);
	const read1 = new Set(reads);
	assert.equal(read1.size, 60, "the walk reached two pages");
	assert.equal(failing.length, 50, "the retry table is capped");
	const released = [...read1].filter((id) => !failing.includes(id));
	assert.equal(released.length, 10);

	reads.length = 0;
	const run2 = makeDeps(makeApi(), ["conversations"]);
	await runStreams(
		run2.deps,
		{ conversations: cursor1 },
		{ detailPacing: NO_DETAIL_WAITS },
	);
	assert.deepEqual(
		[...new Set(reads)].sort(),
		[...failing].sort(),
		"only the rows on the retry table are asked for again",
	);
	for (const id of released) {
		assert.equal(
			reads.includes(id),
			false,
			`${id} was released and is not read`,
		);
	}
});

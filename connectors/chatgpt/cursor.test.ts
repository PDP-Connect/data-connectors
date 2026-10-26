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
	ChatGptRunBudget,
	runConversationsAndMessagesStreams as runStreams,
	type StreamDeps,
} from "./index.ts";
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
			["conv-A", MODEL_SWITCH_COUNTS, MODEL_SWITCH_BRANCH_MESSAGES],
			["conv-B", MODEL_SWITCH_COUNTS, MODEL_SWITCH_BRANCH_MESSAGES],
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
			conversations: { last_update_time: "2026-04-22T09:00:00.000Z" },
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

test("runConversationsAndMessagesStreams: conversations alone fails the run on a hard detail failure, as the messages path does", async () => {
	const list = [makeListItem("conv-A", "2026-04-22T09:00:00Z")];
	const { deps } = makeDeps(makeFakeApi(list, new Map()), ["conversations"]);

	await assert.rejects(
		runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS }),
		/required conversation detail conv-A failed with http 404/,
	);
});

test("runConversationsAndMessagesStreams: conversations alone emits a list-only record, and no gap, for a detail the run budget defers", async () => {
	const list = [
		makeListItem("conv-A", "2026-04-22T10:00:00Z"),
		makeListItem("conv-B", "2026-04-22T09:00:00Z"),
	];
	const { api, detailReads } = makeDetailLoggingApi(
		list,
		makeModelSwitchDetail,
	);
	const { deps, emitted, protocolMessages } = makeDeps(api, ["conversations"]);
	deps.runBudget = new ChatGptRunBudget({ maxFetches: 1 });

	await runStreams(deps, {}, { detailPacing: NO_DETAIL_WAITS });

	assert.deepEqual(detailReads, ["conv-A"]);
	assert.deepEqual(
		emitted
			.filter((r) => r.stream === "conversations")
			.map((r) => [r.data.id, r.data.model_counts]),
		[
			["conv-A", MODEL_SWITCH_COUNTS],
			["conv-B", null],
		],
	);
	assert.equal(
		protocolMessages.some((m: EmittedMessage) => m.type === "DETAIL_GAP"),
		false,
	);
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
		conversations: { last_update_time: "2026-04-22T10:00:00.000Z" },
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
	});

	const messagesState = protocolMessages.find(
		(m) => m.type === "STATE" && m.stream === "messages",
	);
	assert.ok(messagesState && messagesState.type === "STATE");
	assert.deepEqual(messagesState.cursor, {
		last_update_time: "2026-04-22T11:00:00.000Z",
	});
});

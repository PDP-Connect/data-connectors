// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A listed conversation whose detail answers 404 across runs. A 404 does not
// fail the run, but it is not proof the conversation is gone: the messages
// stream keeps a retry obligation in its cursor and fetches the conversation
// again on every later run, whatever the watermark, until a run reads its
// detail cleanly. Nothing else ends the obligation.

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	CollectContext,
	EmittedMessage,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	NO_DETAIL_WAITS,
	readConversationDetail,
} from "./__fixtures__/empty-conversation-details.ts";
import {
	NOT_FOUND_ID_MAX_LENGTH,
	NOT_FOUND_TRACKED_MAX,
	runConversationsAndMessagesStreams,
	type StreamDeps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptApi,
	ChatGptFetchResult,
	ConversationListItem,
} from "./types.ts";

function listItem(id: string, updateTimeIso: string): ConversationListItem {
	const updateTime = Date.parse(updateTimeIso) / 1000;
	return {
		id,
		title: `Conversation ${id}`,
		create_time: updateTime - 1000,
		update_time: updateTime,
		is_archived: false,
		is_starred: false,
		workspace_id: null,
		current_node: `${id}-m0`,
		gizmo_id: null,
	};
}

/** ChatGPT's search page size (CONVERSATION_PAGE_SIZE in index.ts). */
const SEARCH_PAGE_SIZE = 30;

interface RunSetup {
	/** What the search listing returns. */
	search: ConversationListItem[];
	/** What the primary offset listing returns; empty by default. */
	primary?: ConversationListItem[];
	/**
	 * The detail status for an id; 200 serves a one-message detail and
	 * "incomplete" a 200 with no mapping.
	 */
	status: (id: string) => number | "incomplete";
}

interface RunResult {
	detailReads: string[];
	messageConversations: string[];
	protocolMessages: EmittedMessage[];
	state: CollectContext["state"];
}

function makeApi(setup: RunSetup, detailReads: string[]): ChatGptApi {
	return {
		auth: (): Promise<never> =>
			Promise.reject(new Error("auth not used in fake")),
		fetch: (path: string): Promise<ChatGptFetchResult> => {
			if (path.startsWith("/conversations/search?")) {
				const cursor = Number(
					new URLSearchParams(path.split("?")[1]).get("cursor"),
				);
				// The connector asks for SEARCH_PAGE_SIZE rows per cursor page.
				return Promise.resolve({
					status: 200,
					json: {
						items: setup.search.slice(cursor, cursor + SEARCH_PAGE_SIZE),
						total: cursor === 0 ? setup.search.length + 1 : setup.search.length,
					},
				});
			}
			if (path.startsWith("/conversations?")) {
				const offset = Number(
					new URLSearchParams(path.split("?")[1]).get("offset"),
				);
				const primary = setup.primary ?? [];
				return Promise.resolve({
					status: 200,
					json: {
						items: offset === 0 ? primary : [],
						total: primary.length,
					},
				});
			}
			const id = decodeURIComponent(path.slice("/conversation/".length));
			detailReads.push(id);
			const status = setup.status(id);
			if (status === "incomplete") {
				return Promise.resolve({ status: 200, json: { id } });
			}
			return Promise.resolve(
				status === 200 ? readConversationDetail(path) : { status, json: null },
			);
		},
	};
}

/** One run with both streams; the state it would hand the next run. */
async function run(
	setup: RunSetup,
	state: CollectContext["state"],
	extra: Partial<StreamDeps> = {},
): Promise<RunResult> {
	const harness = makeRecordingEmit(validateRecord);
	const detailReads: string[] = [];
	const deps: StreamDeps = {
		api: makeApi(setup, detailReads),
		sleep: (): Promise<void> => Promise.resolve(),
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map(
			["conversations", "messages"].map((name) => [name, { name }]),
		),
		...extra,
	};
	await runConversationsAndMessagesStreams(deps, state, {
		detailPacing: NO_DETAIL_WAITS,
	});
	const next: CollectContext["state"] = { ...state };
	for (const message of harness.protocolMessages) {
		if (message.type === "STATE") {
			next[message.stream] = message.cursor;
		}
	}
	return {
		detailReads,
		messageConversations: [
			...new Set(
				harness.emitted
					.filter((r) => r.stream === "messages")
					.map((r) => String(r.data.conversation_id)),
			),
		].sort(),
		protocolMessages: harness.protocolMessages,
		state: next,
	};
}

function messagesCoverage(
	result: RunResult,
): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
	return result.protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			m.type === "DETAIL_COVERAGE" && m.stream === "messages",
	);
}

/** Ids the messages cursor still owes a detail read after a 404. */
function owedIds(state: CollectContext["state"]): string[] {
	const cursor = state.messages as { detail_not_found?: unknown } | undefined;
	const owed = cursor?.detail_not_found;
	if (Array.isArray(owed)) return owed.map(String).sort();
	return owed && typeof owed === "object" ? Object.keys(owed).sort() : [];
}

/** A run with both streams that must fail; the protocol messages it emitted. */
async function failingRun(
	setup: RunSetup,
	state: CollectContext["state"],
	error: RegExp,
): Promise<{ detailReads: string[]; protocolMessages: EmittedMessage[] }> {
	const harness = makeRecordingEmit(validateRecord);
	const detailReads: string[] = [];
	const deps: StreamDeps = {
		api: makeApi(setup, detailReads),
		sleep: (): Promise<void> => Promise.resolve(),
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map(
			["conversations", "messages"].map((name) => [name, { name }]),
		),
	};
	await assert.rejects(
		runConversationsAndMessagesStreams(deps, state, {
			detailPacing: NO_DETAIL_WAITS,
		}),
		error,
	);
	return { detailReads, protocolMessages: harness.protocolMessages };
}

function wroteMessagesState(protocolMessages: EmittedMessage[]): boolean {
	return protocolMessages.some(
		(m) => m.type === "STATE" && m.stream === "messages",
	);
}

function listOf(count: number): ConversationListItem[] {
	return Array.from({ length: count }, (_, index) =>
		listItem(
			`conv-${String(index).padStart(3, "0")}`,
			new Date(Date.UTC(2026, 3, 22, 0, index)).toISOString(),
		),
	);
}

const LIST = [
	listItem("conv-A", "2026-04-22T09:00:00Z"),
	listItem("conv-B", "2026-04-22T10:00:00Z"),
	listItem("conv-C", "2026-04-22T11:00:00Z"),
];

test("detail 404: a conversation that answers 404 and then a healthy detail on the next run gets its messages", async () => {
	// Two conversations answer 404 on the first run; the watermark passes both.
	const first = await run(
		{
			search: LIST,
			status: (id) => (id === "conv-A" ? 200 : 404),
		},
		{},
	);
	assert.deepEqual(first.messageConversations, ["conv-A"]);
	assert.deepEqual(owedIds(first.state), ["conv-B", "conv-C"]);
	assert.deepEqual(
		[...(messagesCoverage(first)?.optional_skip_keys ?? [])].sort(),
		["conv-B", "conv-C"],
	);

	// The next run lists nothing new; the source answers every detail again.
	const second = await run({ search: LIST, status: () => 200 }, first.state);
	assert.deepEqual(second.detailReads.sort(), ["conv-B", "conv-C"]);
	assert.deepEqual(second.messageConversations, ["conv-B", "conv-C"]);
	assert.deepEqual(owedIds(second.state), []);
	const coverage = messagesCoverage(second);
	assert.deepEqual([...(coverage?.hydrated_keys ?? [])].sort(), [
		"conv-B",
		"conv-C",
	]);
	assert.equal(coverage?.covered, coverage?.considered);
});

test("detail 404: a conversation that answers 404 on any number of runs stays owed and a later healthy run gets its messages", async () => {
	const notFound: RunSetup = {
		search: LIST,
		status: (id) => (id === "conv-B" ? 404 : 200),
	};
	let state: CollectContext["state"] = {};
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const result = await run(notFound, state);
		assert.deepEqual(
			result.detailReads.includes("conv-B"),
			true,
			`run ${attempt + 1} fetches the owed conversation again`,
		);
		assert.deepEqual(owedIds(result.state), ["conv-B"]);
		assert.deepEqual(messagesCoverage(result)?.optional_skip_keys, ["conv-B"]);
		state = result.state;
	}

	const healthy = await run({ search: LIST, status: () => 200 }, state);
	assert.deepEqual(healthy.detailReads, ["conv-B"]);
	assert.deepEqual(healthy.messageConversations, ["conv-B"]);
	assert.deepEqual(owedIds(healthy.state), []);
});

test("detail 404: a run that only retries owed conversations and gets 404 twice keeps them owed for a healthy run", async () => {
	const setup: RunSetup = {
		search: LIST,
		status: (id) => (id === "conv-A" ? 200 : 404),
	};
	const first = await run(setup, {});
	assert.deepEqual(owedIds(first.state), ["conv-B", "conv-C"]);
	// Nothing new is listed; the only details are the two owed retries, both 404.
	const second = await run(setup, first.state);
	const third = await run(setup, second.state);
	assert.deepEqual(third.detailReads.sort(), ["conv-B", "conv-C"]);
	assert.deepEqual(owedIds(third.state), ["conv-B", "conv-C"]);

	const healthy = await run({ search: LIST, status: () => 200 }, third.state);
	assert.deepEqual(healthy.detailReads.sort(), ["conv-B", "conv-C"]);
	assert.deepEqual(healthy.messageConversations, ["conv-B", "conv-C"]);
	assert.deepEqual(owedIds(healthy.state), []);
});

test("detail 404: a 410 is owed like a 404, not given up", async () => {
	const first = await run(
		{ search: LIST, status: (id) => (id === "conv-B" ? 410 : 200) },
		{},
	);
	assert.deepEqual(owedIds(first.state), ["conv-B"]);
	assert.deepEqual(messagesCoverage(first)?.optional_skip_keys, ["conv-B"]);

	const second = await run({ search: LIST, status: () => 200 }, first.state);
	assert.deepEqual(second.messageConversations, ["conv-B"]);
	assert.deepEqual(owedIds(second.state), []);
});

test("detail 404: an owed conversation a complete listing no longer lists is still fetched and recovered", async () => {
	const first = await run(
		{
			search: LIST,
			primary: LIST,
			status: (id) => (id === "conv-B" ? 404 : 200),
		},
		{},
	);
	assert.deepEqual(owedIds(first.state), ["conv-B"]);

	// The listing is not an inventory: project, archived or other-workspace
	// conversations can be missing from it and still read.
	const remaining = LIST.filter((c) => c.id !== "conv-B");
	const second = await run(
		{ search: remaining, primary: remaining, status: () => 200 },
		first.state,
	);
	assert.deepEqual(second.detailReads, ["conv-B"]);
	assert.deepEqual(second.messageConversations, ["conv-B"]);
	assert.deepEqual(owedIds(second.state), []);
	const coverage = messagesCoverage(second);
	assert.deepEqual(coverage?.hydrated_keys, ["conv-B"]);
	assert.deepEqual(coverage?.optional_skip_keys ?? [], []);
	assert.equal(coverage?.covered, coverage?.considered);
});

test("detail 404: 404, 404, a 200 with no mapping, then 404 keeps the conversation owed", async () => {
	const statuses: Array<number | "incomplete"> = [404, 404, "incomplete", 404];
	let state: CollectContext["state"] = {};
	for (const status of statuses) {
		const result = await run(
			{ search: LIST, status: (id) => (id === "conv-B" ? status : 200) },
			state,
		);
		assert.deepEqual(
			owedIds(result.state),
			["conv-B"],
			`after a ${status} the conversation is still owed`,
		);
		state = result.state;
	}
	const healthy = await run({ search: LIST, status: () => 200 }, state);
	assert.deepEqual(healthy.messageConversations, ["conv-B"]);
	assert.deepEqual(owedIds(healthy.state), []);
});

test("detail 404: a run that would owe more than NOT_FOUND_TRACKED_MAX fails before messages STATE and loses nothing", async () => {
	assert.equal(NOT_FOUND_TRACKED_MAX, 50);
	const list = listOf(65);
	const notFound = new Set(list.slice(0, 60).map((c) => c.id));
	const failed = await failingRun(
		{ search: list, status: (id) => (notFound.has(id) ? 404 : 200) },
		{},
		/60 listed conversations are owed .* more than the 50/,
	);
	assert.equal(failed.detailReads.length, 65);
	assert.equal(wroteMessagesState(failed.protocolMessages), false);

	// The cursor did not move, so a healthy run reads every conversation.
	const healthy = await run({ search: list, status: () => 200 }, {});
	assert.equal(healthy.messageConversations.length, 65);
	assert.deepEqual(owedIds(healthy.state), []);
});

test("detail 404: a new 404 on top of a full table fails instead of dropping an obligation", async () => {
	const list = listOf(NOT_FOUND_TRACKED_MAX + 2);
	const owed = new Set(list.slice(0, NOT_FOUND_TRACKED_MAX).map((c) => c.id));
	const extra = list[NOT_FOUND_TRACKED_MAX]?.id;
	const first = await run(
		{ search: list, status: (id) => (owed.has(id) ? 404 : 200) },
		{},
	);
	assert.equal(owedIds(first.state).length, NOT_FOUND_TRACKED_MAX);

	const failed = await failingRun(
		{
			search: list,
			status: (id) => (owed.has(id) || id === extra ? 404 : 200),
		},
		// Clear the watermark so the forward pass reads the extra conversation.
		{
			...first.state,
			messages: {
				...(first.state.messages as Record<string, unknown>),
				last_update_time: null,
			},
		},
		/51 listed conversations are owed/,
	);
	assert.equal(wroteMessagesState(failed.protocolMessages), false);
});

test("detail 404: a run whose every detail answers 404 fails instead of reporting no messages", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const deps: StreamDeps = {
		api: makeApi({ search: LIST, status: () => 404 }, []),
		sleep: (): Promise<void> => Promise.resolve(),
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map(
			["conversations", "messages"].map((name) => [name, { name }]),
		),
	};
	await assert.rejects(
		runConversationsAndMessagesStreams(
			deps,
			{},
			{
				detailPacing: NO_DETAIL_WAITS,
			},
		),
		/every conversation detail .* answered http 404/,
	);
	assert.equal(
		harness.protocolMessages.some(
			(m) => m.type === "STATE" && m.stream === "messages",
		),
		false,
		"the watermark does not advance past conversations it could not read",
	);
});

test("detail 404: three owed retries that all answer 404 do not trip the account guard", async () => {
	const list = [...LIST, listItem("conv-D", "2026-04-22T12:00:00Z")];
	const first = await run(
		{ search: list, status: (id) => (id === "conv-A" ? 200 : 404) },
		{},
	);
	assert.deepEqual(owedIds(first.state), ["conv-B", "conv-C", "conv-D"]);
	const second = await run({ search: list, status: () => 404 }, first.state);
	assert.deepEqual(second.detailReads.sort(), ["conv-B", "conv-C", "conv-D"]);
	assert.deepEqual(owedIds(second.state), ["conv-B", "conv-C", "conv-D"]);
});

test("detail 404: the cursor keeps only the owed ids, never a title or other list-item text", async () => {
	const hugeTitle = "t".repeat(800_000);
	const list = LIST.map((c) =>
		c.id === "conv-B"
			? {
					...c,
					title: hugeTitle,
					gizmo_id: "g-list-item-gizmo",
					workspace_id: "ws-list-item-workspace",
				}
			: c,
	);
	const first = await run(
		{ search: list, status: (id) => (id === "conv-B" ? 404 : 200) },
		{},
	);
	const cursor = first.state.messages as { detail_not_found?: unknown };
	assert.deepEqual(cursor.detail_not_found, ["conv-B"]);
	const serialized = JSON.stringify(first.state.messages);
	for (const text of [
		"Conversation conv-B",
		"g-list-item-gizmo",
		"ws-list-item-workspace",
		"conv-B-m0",
		"ttttt",
	]) {
		assert.equal(serialized.includes(text), false, `STATE holds ${text}`);
	}
	assert.ok(
		serialized.length < 1_000,
		`an 800,000-character title left a ${serialized.length}-byte cursor`,
	);
});

test("detail 404: an owed id longer than NOT_FOUND_ID_MAX_LENGTH fails the run instead of being kept or dropped", async () => {
	assert.equal(NOT_FOUND_ID_MAX_LENGTH, 64);
	const longId = `conv-${"x".repeat(NOT_FOUND_ID_MAX_LENGTH)}`;
	const list = [...LIST, listItem(longId, "2026-04-22T12:00:00Z")];
	const failed = await failingRun(
		{ search: list, status: (id) => (id === longId ? 404 : 200) },
		{},
		/1 listed conversation\(s\) answered http 404 or 410 with an id the messages cursor cannot keep/,
	);
	assert.equal(wroteMessagesState(failed.protocolMessages), false);
});

/** The state a healthy run over LIST leaves, with `messages` fields added. */
async function stateAfterHealthyRun(
	messages: Record<string, unknown>,
): Promise<CollectContext["state"]> {
	const healthy = await run({ search: LIST, status: () => 200 }, {});
	return {
		...healthy.state,
		messages: {
			...(healthy.state.messages as Record<string, unknown>),
			...messages,
		},
	};
}

test("detail 404: a cursor written with n, first_seen and item keeps its ids owed and drops the rest", async () => {
	const written = await stateAfterHealthyRun({
		detail_not_found: {
			"conv-B": {
				n: 2,
				first_seen: "2026-04-20T00:00:00.000Z",
				item: { id: "conv-B", title: "Conversation conv-B", update_time: 1 },
			},
		},
	});
	const stillGone = await run(
		{ search: LIST, status: (id) => (id === "conv-B" ? 404 : 200) },
		written,
	);
	assert.deepEqual(stillGone.detailReads, ["conv-B"]);
	assert.deepEqual(
		(stillGone.state.messages as { detail_not_found?: unknown })
			.detail_not_found,
		["conv-B"],
	);
	assert.equal(
		JSON.stringify(stillGone.state.messages).includes("Conversation conv-B"),
		false,
	);

	const healthy = await run({ search: LIST, status: () => 200 }, written);
	assert.deepEqual(healthy.detailReads, ["conv-B"]);
	assert.deepEqual(healthy.messageConversations, ["conv-B"]);
	assert.deepEqual(owedIds(healthy.state), []);
});

test("detail 404: a cursor with no detail_not_found field owes nothing", async () => {
	const state = await stateAfterHealthyRun({});
	assert.equal(
		"detail_not_found" in (state.messages as Record<string, unknown>),
		false,
	);
	const result = await run({ search: LIST, status: () => 200 }, state);
	assert.deepEqual(result.detailReads, []);
	assert.deepEqual(owedIds(result.state), []);
});

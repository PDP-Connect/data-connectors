// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A listed conversation whose detail answers 404 across runs. A 404 does not
// fail the run, but it is not proof the conversation is gone: the messages
// stream keeps a retry obligation in its cursor, fetches the conversation again
// on later runs whatever the watermark, and settles it only on stronger
// evidence (a 410, absence from a complete listing, or a 404 on
// NOT_FOUND_SETTLE_RUNS runs in a row).

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
	NOT_FOUND_SETTLE_RUNS,
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

interface RunSetup {
	/** What the search listing returns. */
	search: ConversationListItem[];
	/** What the primary offset listing returns; empty by default. */
	primary?: ConversationListItem[];
	/** The detail status for an id; 200 serves a one-message detail. */
	status: (id: string) => number;
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
				return Promise.resolve({
					status: 200,
					json: {
						items: cursor === 0 ? setup.search : [],
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
	return owed && typeof owed === "object" ? Object.keys(owed).sort() : [];
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

test("detail 404: a conversation that answers 404 on NOT_FOUND_SETTLE_RUNS runs in a row is settled and not fetched again", async () => {
	const setup: RunSetup = {
		search: LIST,
		status: (id) => (id === "conv-B" ? 404 : 200),
	};
	const first = await run(setup, {});
	const second = await run(setup, first.state);
	const third = await run(setup, second.state);
	assert.equal(NOT_FOUND_SETTLE_RUNS, 3);
	assert.deepEqual(owedIds(first.state), ["conv-B"]);
	assert.deepEqual(second.detailReads, ["conv-B"]);
	assert.deepEqual(owedIds(second.state), ["conv-B"]);
	assert.deepEqual(third.detailReads, ["conv-B"]);
	assert.deepEqual(owedIds(third.state), []);
	// The run that settles it still reports the messages missing.
	assert.deepEqual(messagesCoverage(third)?.optional_skip_keys, ["conv-B"]);

	const fourth = await run(setup, third.state);
	assert.deepEqual(fourth.detailReads, []);
	assert.deepEqual(owedIds(fourth.state), []);
});

test("detail 404: a 410 is settled on first sight", async () => {
	const first = await run(
		{ search: LIST, status: (id) => (id === "conv-B" ? 410 : 200) },
		{},
	);
	assert.deepEqual(owedIds(first.state), []);
	assert.deepEqual(messagesCoverage(first)?.optional_skip_keys, ["conv-B"]);
});

test("detail 404: an owed conversation absent from a complete listing is settled without a fetch", async () => {
	const first = await run(
		{
			search: LIST,
			primary: LIST,
			status: (id) => (id === "conv-B" ? 404 : 200),
		},
		{},
	);
	assert.deepEqual(owedIds(first.state), ["conv-B"]);

	const remaining = LIST.filter((c) => c.id !== "conv-B");
	const second = await run(
		{ search: remaining, primary: remaining, status: () => 200 },
		first.state,
	);
	assert.deepEqual(second.detailReads, []);
	assert.deepEqual(owedIds(second.state), []);
});

test("detail 404: an owed conversation still in a complete listing is fetched again", async () => {
	const first = await run(
		{
			search: LIST,
			primary: LIST,
			status: (id) => (id === "conv-B" ? 404 : 200),
		},
		{},
	);
	const second = await run(
		{ search: LIST, primary: LIST, status: () => 200 },
		first.state,
	);
	assert.deepEqual(second.detailReads, ["conv-B"]);
	assert.deepEqual(second.messageConversations, ["conv-B"]);
	assert.deepEqual(owedIds(second.state), []);
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

test("detail 404: a run that only retries owed conversations and gets 404 again succeeds and counts the attempt", async () => {
	const setup: RunSetup = {
		search: LIST,
		status: (id) => (id === "conv-A" ? 200 : 404),
	};
	const first = await run(setup, {});
	assert.deepEqual(owedIds(first.state), ["conv-B", "conv-C"]);
	// Nothing new is listed; the only details are the two owed retries, both 404.
	const second = await run(setup, first.state);
	assert.deepEqual(second.detailReads.sort(), ["conv-B", "conv-C"]);
	const owed = (
		second.state.messages as {
			detail_not_found: Record<string, { n: number }>;
		}
	).detail_not_found;
	assert.equal(owed["conv-B"]?.n, 2);
	assert.equal(owed["conv-C"]?.n, 2);
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

test("detail 404: owed conversations past the cap are not fetched", async () => {
	const owed = Object.fromEntries(
		Array.from({ length: NOT_FOUND_TRACKED_MAX + 10 }, (_, index) => {
			const id = `conv-owed-${String(index).padStart(3, "0")}`;
			return [
				id,
				{
					n: 1,
					first_seen: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
					item: { id, update_time: 1_700_000_000 + index },
				},
			];
		}),
	);
	const result = await run(
		{ search: [], status: () => 200 },
		{ messages: { last_update_time: null, detail_not_found: owed } },
	);
	assert.equal(result.detailReads.length, NOT_FOUND_TRACKED_MAX);
	assert.equal(result.detailReads.sort()[0], "conv-owed-000");
	assert.equal(result.messageConversations.length, NOT_FOUND_TRACKED_MAX);
});

test("detail 404: the obligation carries first-seen time and attempts", async () => {
	const first = await run(
		{ search: LIST, status: (id) => (id === "conv-B" ? 404 : 200) },
		{},
	);
	const entry = (
		first.state.messages as {
			detail_not_found: Record<string, { n: number; first_seen: string }>;
		}
	).detail_not_found["conv-B"];
	assert.equal(entry?.n, 1);
	assert.ok(entry && !Number.isNaN(Date.parse(entry.first_seen)));
});

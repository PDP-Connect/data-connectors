// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * ChatGPT conversations declare `message_count_on_current_branch`, and the
 * obvious reconciliation — compare it against the messages we emitted — proves
 * nothing. That field is computed by OUR OWN `countBranchMessages` from the
 * same `mapping` object, inside the same call that emits those messages. Both
 * sides of that comparison read one in-memory graph, so it is a tautology.
 *
 * Worse, it is a tautology that HIDES the real defect. `flattenTreeCurrentBranch`
 * walks parent pointers and stops silently when a parent is missing from the
 * mapping. A truncated payload therefore produces a short branch AND a
 * correspondingly short declared count — the denominator shrinks to match the
 * loss and the conversation reads complete.
 *
 * The provider assertion worth reconciling against is structural: `current_node`
 * and the `parent` chain declare a branch that must be present and must
 * terminate at a real root. These tests pin that contract.
 *
 * Grounding: reconciled against 5,821 live conversations. On-branch message
 * counts matched the declared count exactly for 5,815 and never exceeded it,
 * so equality is the right contract. Three conversations in the historical
 * archive were short by exactly one message, each with a dangling non-system
 * parent — the shape `truncatedBranch` reproduces below.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { processConversationDetail, type StreamDeps } from "./index.ts";
import { buildConversationRecord, type ConversationDetail } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptFetchResult,
	ChatGptNode,
	ConversationListItem,
} from "./types.ts";

function makeHarness(
	requested: readonly string[] = ["conversations", "messages"],
) {
	const harness = makeRecordingEmit(validateRecord);
	const deps: StreamDeps = {
		api: {
			auth: (): Promise<never> => Promise.reject(new Error("unused")),
			fetch: (): Promise<ChatGptFetchResult> =>
				Promise.resolve({ status: 200, json: null }),
		},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map(requested.map((name) => [name, { name }])),
	};
	// A branch gap is a fact about one conversation, so it is a record-level
	// PROGRESS diagnostic ("<reason>: ..."), never a stream-level SKIP_RESULT.
	// A stream skip would make Desktop drop every message of the run.
	const streamSkips = (): Record<string, unknown>[] =>
		harness.protocolMessages.filter(
			(m) => (m as { type?: string }).type === "SKIP_RESULT",
		) as unknown as Record<string, unknown>[];
	const skips = (): { reason: string; message: string }[] =>
		harness.protocolMessages.flatMap((m) => {
			const msg = m as { type?: string; message?: string };
			const match =
				msg.type === "PROGRESS"
					? /^(branch_truncated|branch_tip_missing): /.exec(msg.message ?? "")
					: null;
			return match?.[1]
				? [{ reason: match[1], message: msg.message ?? "" }]
				: [];
		});
	return {
		deps,
		emitted: harness.emitted,
		messages: harness.protocolMessages,
		skips,
		streamSkips,
	};
}

function makeConvo(currentNode: string): ConversationListItem {
	return {
		id: "convo-abc",
		title: "Hello world",
		create_time: 1_700_000_000,
		update_time: 1_700_000_100,
		current_node: currentNode,
	};
}

function emitConversation(deps: StreamDeps) {
	return async (
		c: ConversationListItem,
		detail: ConversationDetail | null,
	): Promise<void> => {
		await deps.emitRecord("conversations", buildConversationRecord(c, detail));
	};
}

function userNode(parent: string | null, children: string[] = []): ChatGptNode {
	return {
		parent,
		children,
		message: {
			author: { role: "user" },
			create_time: 1_700_000_000,
			content: { content_type: "text", parts: ["hello"] },
		},
	};
}

function assistantNode(parent: string, children: string[] = []): ChatGptNode {
	return {
		parent,
		children,
		message: {
			author: { role: "assistant" },
			create_time: 1_700_000_001,
			end_turn: true,
			content: { content_type: "text", parts: ["hi there"] },
		},
	};
}

/** A whole conversation: root → u1 → a1, every parent present. */
function wholeBranch(): Record<string, ChatGptNode> {
	return {
		root: { parent: null, children: ["u1"] },
		u1: userNode("root", ["a1"]),
		a1: assistantNode("u1"),
	};
}

/**
 * The real defect shape found in the live archive: the branch tip is present
 * and walkable, but the opening user turn it descends from was never
 * delivered. `flattenTreeCurrentBranch` stops at `a1` and reports a 1-message
 * branch, so the declared count agrees with the truncated data and nothing
 * looks wrong.
 */
function truncatedBranch(): Record<string, ChatGptNode> {
	return {
		a1: assistantNode("aaa2c1fa-missing-user-turn"),
	};
}

async function run(mapping: Record<string, ChatGptNode>, currentNode: string) {
	const harness = makeHarness();
	const detail: ChatGptFetchResult = {
		status: 200,
		json: {
			title: "Hello world",
			create_time: 1_700_000_000,
			update_time: 1_700_000_100,
			mapping,
			current_node: currentNode,
		},
	};
	await processConversationDetail(
		harness.deps,
		makeConvo(currentNode),
		detail,
		emitConversation(harness.deps),
	);
	return harness;
}

function filteredShape(ids: string[], excluded: string[], currentNode: string) {
	const mapping: Record<string, ChatGptNode> = {
		root: { parent: null, children: [] },
	};
	for (let index = 0; index < ids.length; index += 1) {
		const id = ids[index];
		if (id === undefined) continue;
		const parent = index === 0 ? "root" : (ids[index - 1] ?? "root");
		const next = ids[index + 1];
		mapping[id] = {
			parent,
			children: next ? [next] : [],
			message: {
				author: {
					role:
						ids.length <= 3
							? "system"
							: index < 2
								? "system"
								: index % 2
									? "user"
									: "assistant",
				},
				content: { content_type: "text", parts: [] },
			},
		};
	}
	return { mapping, excluded: new Set(excluded), currentNode };
}

async function runWithFilteredRecords(
	mapping: Record<string, ChatGptNode>,
	currentNode: string,
	excluded: ReadonlySet<string>,
) {
	const harness = makeRecordingEmit(validateRecord);
	const deps: StreamDeps = {
		api: {
			auth: (): Promise<never> => Promise.reject(new Error("unused")),
			fetch: (): Promise<ChatGptFetchResult> =>
				Promise.resolve({ status: 200, json: null }),
		},
		emit: harness.emit,
		emitRecord: async (stream, data) => {
			if (excluded.has(String(data.id))) return;
			await harness.emitRecord(stream, data);
		},
		isRecordSelected: (_stream, data) => !excluded.has(String(data.id)),
		progress: (): Promise<void> => Promise.resolve(),
		requested: new Map([
			["conversations", { name: "conversations" }],
			["messages", { name: "messages" }],
		]),
	};
	await processConversationDetail(
		deps,
		makeConvo(currentNode),
		{ status: 200, json: { mapping, current_node: currentNode } },
		emitConversation(deps),
	);
	return {
		emitted: harness.emitted,
		protocolMessages: harness.protocolMessages,
	};
}

test("filtered current branch fixtures reconcile count, tip, and parent chain", async () => {
	const cases = [
		// Replay row 1: 6 declared, 5 emitted, current tip present, only 3 of 5 reachable.
		filteredShape(["m0", "m1", "m2", "m3", "m4", "m5"], ["m2"], "m5"),
		// Replay rows 2 and 3: 3 declared, 2 emitted, current leaf omitted.
		filteredShape(["m0", "m1", "m2"], ["m2"], "m2"),
		filteredShape(["m0", "m1", "m2"], ["m2"], "m2"),
		// Replay row 4: 2 declared, 1 emitted, current leaf omitted.
		filteredShape(["m0", "m1"], ["m1"], "m1"),
	];

	const runs = await Promise.all(
		cases.map((fixture) =>
			runWithFilteredRecords(
				fixture.mapping,
				fixture.currentNode,
				fixture.excluded,
			),
		),
	);
	for (let index = 0; index < cases.length; index += 1) {
		const fixture = cases[index];
		const run = runs[index];
		if (!fixture || !run) continue;
		const { emitted, protocolMessages } = run;
		const conversation = emitted.find(
			(record) => record.stream === "conversations",
		);
		const messages = emitted.filter((record) => record.stream === "messages");
		const branch = messages.filter(
			(record) => record.data.on_current_branch === true,
		);
		assert.equal(
			conversation?.data.message_count_on_current_branch,
			branch.length,
		);
		assert.equal(
			branch.some(
				(record) => record.data.id === conversation?.data.current_node,
			),
			true,
		);

		const byId = new Map(
			branch.map((record) => [String(record.data.id), record]),
		);
		let node = String(conversation?.data.current_node);
		const visited = new Set<string>();
		while (byId.has(node) && !visited.has(node)) {
			visited.add(node);
			const parent = byId.get(node)?.data.parent_id;
			node = typeof parent === "string" ? parent : "";
		}
		assert.equal(
			visited.size,
			branch.length,
			"every emitted branch message must be reachable from current_node",
		);
		const filterNote = protocolMessages.find(
			(record) =>
				(record as { type?: string; message?: string }).type === "PROGRESS" &&
				(record as { message?: string }).message?.startsWith(
					"branch_message_filtered: ",
				),
		) as { message?: string } | undefined;
		assert.ok(filterNote, "filtered branch nodes must produce a bounded reason note");
		assert.match(
			filterNote.message ?? "",
			fixture.excluded.has(fixture.currentNode)
				? /current_node_filtered=selection/u
				: /current_node_filtered=no/u,
		);
	}
});

test("a roleless current tip is reported as a filtered non-message node", async () => {
	const mapping: Record<string, ChatGptNode> = {
		root: { parent: null, children: ["m1"] },
		m1: {
			parent: "root",
			children: ["leaf"],
			message: {
				author: { role: "user" },
				content: { content_type: "text", parts: ["kept"] },
			},
		},
		leaf: { parent: "m1", children: [], message: {} },
	};
	const { emitted, protocolMessages } = await runWithFilteredRecords(
		mapping,
		"leaf",
		new Set(),
	);
	const conversation = emitted.find((record) => record.stream === "conversations");
	assert.equal(conversation?.data.current_node, "m1");
	assert.equal(conversation?.data.message_count_on_current_branch, 1);
	assert.ok(
		protocolMessages.some(
			(record) =>
				(record as { type?: string; message?: string }).type === "PROGRESS" &&
				(record as { message?: string }).message?.includes(
					"current_node_filtered=non_message",
				),
		),
	);
});

test("chatgpt branch: a whole conversation reconciles clean and reports no gap", async () => {
	const { skips, emitted } = await run(wholeBranch(), "a1");

	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		2,
		"u1 + a1 emit; root is synthetic",
	);
	assert.equal(
		skips().length,
		0,
		"an intact parent chain must not manufacture a gap",
	);
});

test("chatgpt branch: a truncated branch is surfaced as a gap, not a silent pass", async () => {
	// This is the defect the declared-count comparison cannot see: the count and
	// the data agree with each other, and both are short.
	const { skips, streamSkips } = await run(truncatedBranch(), "a1");

	const gap = skips().find((s) => s.reason === "branch_truncated");
	assert.ok(gap, "a branch whose parent chain dangles must report a gap");
	assert.ok(
		!gap.message.includes("aaa2c1fa-missing-user-turn") &&
			!gap.message.includes("convo-abc"),
		"PROGRESS is the owner's status line: no node or conversation id",
	);
	assert.equal(
		streamSkips().length,
		0,
		"one truncated conversation must not skip the whole messages stream",
	);
});

test("chatgpt branch: the tautological count check would have passed this truncated payload", async () => {
	// Proves the point of the whole contract. The conversation record's declared
	// count is derived from the same truncated mapping, so declared == emitted
	// and a count-based reconciliation reads complete. The gap is the only signal.
	const { emitted, skips } = await run(truncatedBranch(), "a1");

	const convo = emitted.find((r) => r.stream === "conversations");
	const declared = convo?.data.message_count_on_current_branch;
	const emittedOnBranch = emitted.filter(
		(r) => r.stream === "messages" && r.data.on_current_branch === true,
	).length;

	assert.equal(
		declared,
		1,
		"the declared count shrank to match the truncation",
	);
	assert.equal(
		emittedOnBranch,
		1,
		"so declared == emitted and the counts agree",
	);
	assert.equal(
		skips().some((s) => s.reason === "branch_truncated"),
		true,
		"only the structural check catches it",
	);
});

test("chatgpt branch: a current_node absent from the mapping is surfaced", async () => {
	// The conversation says it is on a tip the payload does not contain, so the
	// branch we walked is not the branch it claims to be on.
	const { skips, streamSkips } = await run(
		wholeBranch(),
		"tip-we-never-received",
	);

	const gap = skips().find((s) => s.reason === "branch_tip_missing");
	assert.ok(gap, "an unreachable declared tip must report a gap");
	assert.ok(
		!gap.message.includes("convo-abc"),
		"PROGRESS is the owner's status line: no conversation id",
	);
	assert.equal(
		streamSkips().length,
		0,
		"one conversation's missing tip must not skip the whole messages stream",
	);
});

test("chatgpt branch: an off-branch alternative does not trigger a false gap", async () => {
	// Branching is normal: holding MORE than the current branch is legitimate and
	// must stay silent. Live data showed 28% of conversations hold off-branch
	// messages, so a check that fired on these would be useless.
	const mapping: Record<string, ChatGptNode> = {
		root: { parent: null, children: ["u1"] },
		u1: userNode("root", ["a1", "a2"]),
		a1: assistantNode("u1"),
		a2: assistantNode("u1"),
	};
	const { skips, emitted } = await run(mapping, "a1");

	assert.equal(
		emitted.filter((r) => r.stream === "messages").length,
		3,
		"both branches are held",
	);
	assert.equal(
		skips().length,
		0,
		"an extra branch is data we have, not data we lost",
	);
});

test("chatgpt branch: a cyclic parent chain terminates instead of hanging", async () => {
	// Defensive: a malformed graph must not spin the walk forever.
	const mapping: Record<string, ChatGptNode> = {
		a1: assistantNode("a2"),
		a2: assistantNode("a1"),
	};
	const { skips } = await run(mapping, "a1");

	assert.equal(
		skips().some((s) => s.reason === "branch_truncated"),
		false,
		"a cycle is fully present in the mapping; it is not a truncation",
	);
});

test("chatgpt branch: a conversation with no current_node is not reconciled", async () => {
	// Nothing was declared, so there is nothing to hold the payload to. Inventing
	// a gap here would be a false positive on a legitimate shape.
	const harness = makeHarness();
	const mapping = wholeBranch();
	const detail: ChatGptFetchResult = {
		status: 200,
		json: {
			title: "t",
			create_time: 1,
			update_time: 2,
			mapping,
			current_node: null,
		},
	};
	const convo: ConversationListItem = {
		...makeConvo("a1"),
		current_node: null,
	};
	await processConversationDetail(
		harness.deps,
		convo,
		detail,
		emitConversation(harness.deps),
	);

	assert.equal(
		harness.skips().length,
		0,
		"no declared tip means no claim to reconcile against",
	);
});

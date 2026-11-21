// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The per-run budget: a run reads as many changed conversations as fit under a
// wall-clock and an output-size limit, stops between conversations, and the
// next run resumes from the checkpoint. The provider is synthetic.

import assert from "node:assert/strict";
import test from "node:test";
import { collectAnthropicLive } from "./index.ts";
import {
	BYTES_ENV,
	CAP_ENV,
	type Conv,
	conv,
	harness,
	stampMessage,
	uuid,
	WALL_ENV,
	withEnv,
} from "./test-support.ts";

const CHAT = ["conversations", "messages"];

function backlog(n: number): Conv[] {
	return Array.from({ length: n }, (_, i) => {
		const c = conv(i + 1, 0);
		c.updated_at = new Date(Date.UTC(2026, 0, 15, 9, 0, i)).toISOString();
		stampMessage(c, 1, c.updated_at);
		return c;
	});
}

const jsonBytes = (value: unknown) =>
	Buffer.byteLength(JSON.stringify(value), "utf8");

/** Every conversation record has both of its messages, and ids are unique. */
function assertWhole(
	runs: Array<ReturnType<typeof harness>>,
	convs: Conv[],
): void {
	const conversationIds = runs.flatMap((h) => h.ids("conversations"));
	const messageIds = runs.flatMap((h) => h.ids("messages"));
	assert.equal(new Set(conversationIds).size, conversationIds.length);
	assert.equal(new Set(messageIds).size, messageIds.length);
	assert.deepEqual(
		[...conversationIds].sort(),
		convs.map((c) => c.uuid).sort(),
	);
	assert.deepEqual(
		[...messageIds].sort(),
		convs.flatMap((c) => c.chat_messages.map((m) => String(m.uuid))).sort(),
	);
	for (const h of runs) {
		for (const id of h.ids("conversations")) {
			const own = h.of("messages").filter((m) => m.conversation_id === id);
			assert.equal(own.length, 2, `conversation ${id} emitted whole`);
		}
	}
}

async function runUntilSettled(
	convs: Conv[],
	env: Record<string, string>,
	route?: Parameters<typeof harness>[1] extends infer O
		? O extends { route?: infer R }
			? R
			: never
		: never,
) {
	const runs: Array<ReturnType<typeof harness>> = [];
	let state: Record<string, unknown> = {};
	for (let i = 0; i < 40; i++) {
		const h = harness(convs, {
			streams: CHAT,
			state,
			...(route ? { route } : {}),
		});
		await withEnv(env, () => collectAnthropicLive(h.ctx));
		runs.push(h);
		state = h.nextState();
		if (h.skips().length === 0) return runs;
	}
	assert.fail("backlog did not settle");
}

test("a backlog of 260 changed conversations is read whole in one run", async () => {
	const convs = backlog(260);
	const h = harness(convs, { streams: CHAT });
	await collectAnthropicLive(h.ctx);
	assert.equal(h.ids("conversations").length, 260);
	assert.deepEqual(h.skips(), []);
});

test("the byte budget stops a run between conversations and the next run resumes", async () => {
	const convs = backlog(12);
	const probe = harness(convs, { streams: CHAT });
	await collectAnthropicLive(probe.ctx);
	// Budget equal to the first three conversations' records: the run reaches
	// it after three and starts no fourth.
	const firstThree = new Set(convs.slice(0, 3).map((c) => c.uuid));
	const budget = probe.records
		.filter((r) =>
			r.stream === "conversations"
				? firstThree.has(String(r.data.id))
				: firstThree.has(String(r.data.conversation_id)),
		)
		.reduce((sum, r) => sum + jsonBytes(r.data), 0);

	const first = harness(convs, { streams: CHAT });
	await withEnv({ [BYTES_ENV]: String(budget) }, () =>
		collectAnthropicLive(first.ctx),
	);
	assert.equal(first.ids("conversations").length, 3);
	assert.equal(first.ids("messages").length, 6);
	assert.equal(first.skips()[0]?.reason, "anthropic_live_backlog_deferred");

	const runs = await runUntilSettled(convs, { [BYTES_ENV]: String(budget) });
	assert.ok(runs.length >= 4);
	assertWhole(runs, convs);
});

test("the exact byte size of one conversation defers the next whole conversation", async () => {
	const convs = backlog(4);
	const firstConversation = convs[0]!;
	const probe = harness(convs, { streams: CHAT });
	await collectAnthropicLive(probe.ctx);
	const budget = probe.records
		.filter((r) =>
			r.stream === "conversations"
				? r.data.id === firstConversation.uuid
				: r.stream === "messages" &&
					r.data.conversation_id === firstConversation.uuid,
		)
		.reduce((sum, r) => sum + jsonBytes(r.data), 0);
	assert.ok(budget > 0, "the exact-fit threshold comes from emitted bytes");

	const runs = await runUntilSettled(convs, { [BYTES_ENV]: String(budget) });
	const first = runs[0]!;
	assert.deepEqual(first.detailReads(), [firstConversation.uuid]);
	assertWhole([first], [firstConversation]);
	assert.equal(first.skips()[0]?.reason, "anthropic_live_backlog_deferred");
	assert.ok(runs.length > 1);
	assert.deepEqual(runs.at(-1)?.skips(), []);
	assertWhole(runs, convs);
});

test("the wall-clock budget stops a run between conversations and the next run resumes", async () => {
	const convs = backlog(12);
	// Each detail read takes ~20 ms; the budget admits only a few per run.
	const slow = (url: URL) => {
		if (url.searchParams.get("tree") === "True") {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
		return undefined;
	};
	const first = harness(convs, { streams: CHAT, route: slow });
	await withEnv({ [WALL_ENV]: "50" }, () => collectAnthropicLive(first.ctx));
	const read = first.ids("conversations").length;
	assert.ok(read >= 1 && read < 12, `read ${read}`);
	assert.equal(first.skips()[0]?.reason, "anthropic_live_backlog_deferred");

	const runs = await runUntilSettled(convs, { [WALL_ENV]: "50" }, slow);
	assert.ok(runs.length >= 2);
	assertWhole(runs, convs);
});

test("the opt-in count env still caps a run", async () => {
	const convs = backlog(10);
	const h = harness(convs, { streams: CHAT });
	await withEnv({ [CAP_ENV]: "4" }, () => collectAnthropicLive(h.ctx));
	assert.equal(h.ids("conversations").length, 4);
	assert.equal(h.skips()[0]?.reason, "anthropic_live_backlog_deferred");
	assert.deepEqual(
		h.ids("conversations"),
		convs.slice(0, 4).map((c) => c.uuid),
	);
	assert.deepEqual(
		h.detailReads(),
		convs.slice(0, 4).map((c) => c.uuid),
	);
	assert.ok(uuid(1));
});

test("a full refresh ignores the budgets", async () => {
	const convs = backlog(10);
	const h = harness(convs, { streams: CHAT, collectionMode: "full_refresh" });
	await withEnv({ [BYTES_ENV]: "1", [CAP_ENV]: "2" }, () =>
		collectAnthropicLive(h.ctx),
	);
	assert.equal(h.ids("conversations").length, 10);
	assert.deepEqual(h.skips(), []);
});

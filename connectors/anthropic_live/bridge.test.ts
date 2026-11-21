// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A host that bridges page.evaluate (PageShim) fails a call that takes longer
// than its own per-call limit by throwing from evaluate. One slow conversation
// read must not end the run and lose what was already read. The provider is
// synthetic.

import assert from "node:assert/strict";
import test from "node:test";
import { collectAnthropicLive } from "./index.ts";
import {
	type Conv,
	conv,
	harness,
	stampMessage,
	uuid,
} from "./test-support.ts";

const CHAT = ["conversations", "messages"];
const BRIDGE_TIMEOUT = "PageShim bridge call evaluate timed out after 30000ms";

function three(): Conv[] {
	return [1, 2, 3].map((n) => {
		const c = conv(n, 0);
		c.updated_at = new Date(Date.UTC(2026, 0, 15, 9, 0, n)).toISOString();
		stampMessage(c, 1, c.updated_at);
		return c;
	});
}

/** Makes evaluate throw a bridge timeout for the first `times` reads of `id`. */
function stallDetail(h: ReturnType<typeof harness>, id: string, times: number) {
	const page = h.ctx.page as unknown as {
		evaluate: (fn: unknown, arg: unknown) => Promise<unknown>;
	};
	const evaluate = page.evaluate;
	let thrown = 0;
	page.evaluate = async (fn, arg) => {
		const path = JSON.stringify(arg ?? "");
		if (path.includes(`/chat_conversations/${id}?`) && thrown < times) {
			thrown += 1;
			throw new Error(BRIDGE_TIMEOUT);
		}
		return evaluate(fn, arg);
	};
	return () => thrown;
}

test("a conversation read that times out at the bridge once is retried and the run reads everything", async () => {
	const h = harness(three(), { streams: CHAT });
	const thrown = stallDetail(h, uuid(2), 1);
	await collectAnthropicLive(h.ctx);
	assert.equal(thrown(), 1);
	assert.deepEqual(h.ids("conversations"), [uuid(1), uuid(2), uuid(3)]);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(h.skips(), []);
});

test("a conversation read that never answers ends the streams retryable and keeps what was read", async () => {
	const h = harness(three(), { streams: CHAT });
	stallDetail(h, uuid(2), Number.POSITIVE_INFINITY);
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.ids("conversations"), [uuid(1)]);
	assert.deepEqual(h.failures, [
		{ stream: "conversations", retryable: true },
		{ stream: "messages", retryable: true },
	]);
});

test("a conversation detail leaves the page with text blocks only, so a huge tool result does not cross the bridge", async () => {
	const convs = three();
	const big = "x".repeat(2_000_000);
	const answer = convs[1].chat_messages[1] as { content: unknown[] };
	answer.content.push({
		type: "tool_result",
		name: "query",
		content: [{ type: "text", text: "summary" }],
		structured_content: { rows: big },
	});
	const h = harness(convs, { streams: CHAT });
	const page = h.ctx.page as unknown as {
		evaluate: (fn: unknown, arg: unknown) => Promise<unknown>;
	};
	const evaluate = page.evaluate;
	let largest = 0;
	page.evaluate = async (fn, arg) => {
		const result = await evaluate(fn, arg);
		largest = Math.max(largest, JSON.stringify(result).length);
		return result;
	};
	await collectAnthropicLive(h.ctx);
	assert.ok(largest < 20_000, `largest bridge result ${largest} bytes`);
	assert.deepEqual(h.ids("conversations"), [uuid(1), uuid(2), uuid(3)]);
	const contents = h
		.of("messages")
		.filter((m) => m.conversation_id === uuid(2))
		.map((m) => m.content);
	assert.deepEqual(contents, ["question", "answer"]);
	assert.deepEqual(h.failures, []);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A host that bridges page.evaluate (PageShim) fails a call that takes longer
// than its own per-call limit by throwing from evaluate. One slow conversation
// read must not end the run and lose what was already read. The provider is
// synthetic.

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
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
	const answer = (convs[1] as Conv).chat_messages[1] as unknown as {
		content: unknown[];
	};
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

afterEach(() => {
	delete process.env.PDPP_ANTHROPIC_LIVE_POLL_SLICE_MS;
});

/** Records progress messages, which the harness otherwise drops. */
function captureProgress(h: ReturnType<typeof harness>): string[] {
	const seen: string[] = [];
	const ctx = h.ctx as unknown as {
		progress: (message: string, extra?: unknown) => Promise<void>;
	};
	ctx.progress = async (message) => {
		seen.push(message);
	};
	return seen;
}

const isLightNotice = (m: string) => m.includes("without tool details");

test("a full read slower than one bridge call is awaited across calls and read in full", async () => {
	process.env.PDPP_ANTHROPIC_LIVE_POLL_SLICE_MS = "5";
	const convs = three();
	const { org: _org, ...slow } = convs[1] as Conv;
	const h = harness(convs, {
		streams: CHAT,
		route: (url) =>
			url.pathname.endsWith(`/chat_conversations/${uuid(2)}`) &&
			url.searchParams.get("render_all_tools") === "true"
				? { status: 200, body: slow, delayMs: 60 }
				: undefined,
	});
	const progress = captureProgress(h);
	const page = h.ctx.page as unknown as {
		evaluate: (fn: unknown, arg: unknown) => Promise<unknown>;
	};
	const evaluate = page.evaluate;
	let polls = 0;
	page.evaluate = async (fn, arg) => {
		if (JSON.stringify(arg ?? "").includes("readKey")) polls += 1;
		return evaluate(fn, arg);
	};
	await collectAnthropicLive(h.ctx);
	assert.ok(polls >= 2, `polls ${polls}`);
	assert.deepEqual(h.ids("conversations"), [uuid(1), uuid(2), uuid(3)]);
	assert.deepEqual(progress.filter(isLightNotice), []);
	assert.deepEqual(h.failures, []);
});

test("a conversation whose full read fails at the bridge is read in the light rendering and reported", async () => {
	const h = harness(three(), { streams: CHAT });
	const progress = captureProgress(h);
	const page = h.ctx.page as unknown as {
		evaluate: (fn: unknown, arg: unknown) => Promise<unknown>;
	};
	const evaluate = page.evaluate;
	page.evaluate = async (fn, arg) => {
		const path = JSON.stringify(arg ?? "");
		if (
			path.includes(`/chat_conversations/${uuid(2)}?`) &&
			path.includes("render_all_tools=true")
		) {
			throw new Error(BRIDGE_TIMEOUT);
		}
		return evaluate(fn, arg);
	};
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.ids("conversations"), [uuid(1), uuid(2), uuid(3)]);
	assert.deepEqual(progress.filter(isLightNotice), [
		"Conversation 2 of 3 was read without tool details: the full read did not finish",
	]);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(h.skips(), []);
});

test("a started full read the host stops polling is dropped from the page after it settles", async () => {
	process.env.PDPP_ANTHROPIC_LIVE_POLL_SLICE_MS = "5";
	const convs = three();
	const { org: _org, ...slow } = convs[1] as Conv;
	const h = harness(convs, {
		streams: CHAT,
		route: (url) =>
			url.pathname.endsWith(`/chat_conversations/${uuid(2)}`) &&
			url.searchParams.get("render_all_tools") === "true"
				? { status: 200, body: slow, delayMs: 30 }
				: undefined,
	});
	const progress = captureProgress(h);
	const page = h.ctx.page as unknown as {
		evaluate: (fn: unknown, arg: unknown) => Promise<unknown>;
	};
	const evaluate = page.evaluate;
	let abandoned: string | undefined;
	page.evaluate = async (fn, arg) => {
		const text = JSON.stringify(arg ?? "");
		if (abandoned && text.includes(abandoned)) throw new Error(BRIDGE_TIMEOUT);
		const result = await evaluate(fn, arg);
		if (
			text.includes(`/chat_conversations/${uuid(2)}?`) &&
			text.includes("render_all_tools=true")
		) {
			abandoned = result as string;
		}
		return result;
	};
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.ids("conversations"), [uuid(1), uuid(2), uuid(3)]);
	assert.deepEqual(progress.filter(isLightNotice), [
		"Conversation 2 of 3 was read without tool details: the full read did not finish",
	]);
	assert.ok(abandoned);
	const reads = (globalThis as Record<string, unknown>)
		.__pdppAnthropicLiveReads as Map<string, unknown>;
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(reads.has(abandoned), false);
});

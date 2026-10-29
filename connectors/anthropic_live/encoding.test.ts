// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The live connector shares the `conversations` and `messages` contracts with
// connectors/anthropic, so it carries the same pdpp-safe-escape-v1 text
// encoding and the same no-truncation rule.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { setConnectorDiagnosticSink } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { collectAnthropicLive } from "./index.ts";
import {
	buildConversationRecord,
	buildMessageRecord,
	omissionsOf,
} from "./parsers.ts";
import { decodeEscapedText, encodePdppSafeText } from "./safe-escape.ts";
import { validateRecord } from "./schemas.ts";
import { conv, harness } from "./test-support.ts";

const here = (path: string) => new URL(path, import.meta.url);
const CTRL = "a\u0000b\u0007c\u001fd\u007fe\u0085f\ud800g\\u0001h";

test("the codec is byte-identical to the export connector's copy and matches the ChatGPT reference vectors", () => {
	assert.equal(
		readFileSync(here("./safe-escape.ts"), "utf8"),
		readFileSync(here("../anthropic/safe-escape.ts"), "utf8"),
	);
	const fixture = JSON.parse(
		readFileSync(here("../anthropic/safe-escape-vectors.json"), "utf8"),
	) as { vectors: Array<{ raw: string; encoded: string }> };
	for (const { raw, encoded } of fixture.vectors) {
		assert.equal(encodePdppSafeText(raw), encoded, JSON.stringify(raw));
		assert.equal(decodeEscapedText(encoded), raw);
	}
});

test("a control character in a title, message text or attachment is represented, not dropped", () => {
	const conversation = buildConversationRecord(
		{ uuid: "c1", name: CTRL, updated_at: "2026-01-01T00:00:00Z" } as never,
		null,
	);
	assert.ok(conversation);
	assert.equal(decodeEscapedText(String(conversation.title)), CTRL);
	const message = buildMessageRecord(
		{
			uuid: "m1",
			text: CTRL,
			sender: "human",
			attachments: [{ file_name: CTRL, [CTRL]: [CTRL], n: 1 }],
		} as never,
		"c1",
		null,
	);
	assert.ok(message);
	assert.equal(decodeEscapedText(String(message.content)), CTRL);
	const [attachment] = message.attachments as Array<Record<string, unknown>>;
	assert.equal(decodeEscapedText(String(attachment?.file_name)), CTRL);
	assert.equal(attachment?.n, 1);
	assert.equal(
		Object.keys(attachment ?? {})
			.map(decodeEscapedText)
			.includes(CTRL),
		true,
	);
	for (const [stream, record] of [
		["conversations", conversation],
		["messages", message],
	] as const)
		assert.equal(validateRecord(stream, record).ok, true, stream);
});

test("a title longer than the former 4000-character cap is not cut", () => {
	const title = "t".repeat(5000);
	const record = buildConversationRecord(
		{ uuid: "c1", name: title } as never,
		null,
	);
	assert.equal(record?.title, title);
	assert.equal(validateRecord("conversations", record ?? {}).ok, true);
});

test("a field over the inline cap is absent and counted, never a prefix", () => {
	const nuls = "\u0000".repeat(3_000_000); // 18M escaped units
	const conversation = buildConversationRecord(
		{ uuid: "c1", name: nuls } as never,
		null,
	);
	assert.ok(conversation);
	assert.equal("title" in conversation, false);
	assert.deepEqual(omissionsOf(conversation), {
		exceedsInlineCap: 1,
		noBlobStore: 0,
	});
	assert.equal(validateRecord("conversations", conversation).ok, true);
	const message = buildMessageRecord(
		{ uuid: "m1", text: nuls } as never,
		"c1",
		null,
	);
	assert.ok(message);
	assert.equal("content" in message, false);
	assert.deepEqual(omissionsOf(message), {
		exceedsInlineCap: 0,
		noBlobStore: 1,
	});
	assert.equal(validateRecord("messages", message).ok, true);
});

test("a collection delivers control-character text and discloses one aggregate count for over-cap text", async () => {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	try {
		const big = conv(1, 10);
		big.name = CTRL;
		big.chat_messages[0] = {
			...big.chat_messages[0],
			text: CTRL,
			content: [],
		};
		big.chat_messages[1] = {
			...big.chat_messages[1],
			text: "\u0000".repeat(2_000_000),
			content: [],
		};
		const h = harness([big], { streams: ["conversations", "messages"] });
		const progress: Array<{ message: string; extra?: unknown }> = [];
		h.ctx.progress = async (message: string, extra?: object) => {
			progress.push({ message, extra });
		};
		await collectAnthropicLive(h.ctx);
		const [conversation] = h.of("conversations");
		assert.equal(decodeEscapedText(String(conversation?.title)), CTRL);
		const messages = h.of("messages");
		assert.equal(messages.length, 2, "both messages are delivered");
		const [first, second] = messages;
		assert.equal(decodeEscapedText(String(first?.content)), CTRL);
		assert.equal("content" in (second ?? {}), false);
		assert.ok(
			lines.some(
				(line) =>
					line.startsWith("[anthropic_live-diagnostic] items_too_large ") &&
					line.includes('"stream":"messages"') &&
					line.includes('"reason":"host_blob_store_unavailable"') &&
					line.includes('"count":1'),
			),
			lines.join("\n"),
		);
		assert.ok(
			progress.some((entry) => /1 item of messages/.test(entry.message)),
		);
		assert.deepEqual(h.skips(), []);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
});

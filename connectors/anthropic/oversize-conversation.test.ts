// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const spoolDir = mkdtempSync(join(tmpdir(), "anthropic-oversize-unit-"));
process.env.PDPP_BLOB_SPOOL_DIR = spoolDir;
after(() => {
	rmSync(spoolDir, { recursive: true, force: true });
	delete process.env.PDPP_BLOB_SPOOL_DIR;
});

const { BufferMeter, scanConversation } = await import(
	"./oversize-conversation.ts"
);
const { spoolEnvelopeFromChunks, spoolJsonText } = await import(
	"./source-blob.ts"
);

async function* chunked(text: string, size: number): AsyncGenerator<string> {
	for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size);
}

const FIELDS = new Set([
	"uuid",
	"id",
	"name",
	"summary",
	"created_at",
	"updated_at",
	"project_uuid",
	"is_starred",
]);

const scan = (text: string, size = 7, meter = new BufferMeter()) =>
	scanConversation(chunked(text, size), 0, FIELDS, meter);

test("scanConversation finds identity and selection fields wherever they sit in the object", async () => {
	const messages = [
		{ uuid: "m2", created_at: "2026-01-02T00:00:00Z", text: 'a "}" ] \\' },
		{ uuid: "m1", created_at: "2026-01-01T00:00:00Z", text: "b" },
	];
	const text = JSON.stringify({
		chat_messages: messages,
		updated_at: "2026-03-01T00:00:00Z",
		account: { uuid: "not-the-conversation", name: "nested" },
		name: "Late title",
		uuid: "conv-late",
		is_starred: true,
	});
	for (const size of [1, 2, 5, 64, 100_000]) {
		const result = await scan(text, size);
		assert.equal(result.fields.get("uuid"), "conv-late", `chunk ${size}`);
		assert.equal(result.fields.get("name"), "Late title");
		assert.equal(result.fields.get("updated_at"), "2026-03-01T00:00:00Z");
		assert.equal(result.fields.get("is_starred"), true);
		assert.equal(result.chatMessages, "array");
		assert.equal(result.messageCount, 2);
		assert.deepEqual(
			result.messageKeys.map((key) => [
				key.index,
				JSON.parse(text.slice(key.start, key.end)).uuid,
			]),
			[
				[0, "m2"],
				[1, "m1"],
			],
		);
	}
});

test("scanConversation follows JSON semantics: last duplicate wins, non-strings are absent, non-objects are counted", async () => {
	const text =
		'{"uuid":"first","uuid":7,"id":"fallback","name":{"x":1},"summary":"S",' +
		'"docs":[],"chat_messages":[1,"two",null,{"uuid":"m"},[3],true,{"uuid":"n"}],' +
		'"updated_at":null,"updated_at":"2026-01-01T00:00:00Z"}';
	const result = await scan(text, 3);
	assert.equal(result.fields.has("uuid"), false);
	assert.equal(result.fields.get("id"), "fallback");
	assert.equal(result.fields.has("name"), false);
	assert.equal(result.fields.get("summary"), "S");
	assert.equal(result.fields.get("updated_at"), "2026-01-01T00:00:00Z");
	assert.equal(result.hasDocs, true);
	assert.equal(result.messageCount, 7);
	assert.equal(result.nonObjectMessages, 5);
	assert.deepEqual(
		result.messageKeys.map((key) => JSON.parse(text.slice(key.start, key.end))),
		[{ uuid: "m" }, { uuid: "n" }],
	);
});

test("scanConversation reports a non-array chat_messages and an absent one", async () => {
	assert.equal(
		(await scan('{"uuid":"a","chat_messages":{"x":[1]}}')).chatMessages,
		"other",
	);
	assert.equal((await scan('{"uuid":"a"}')).chatMessages, "absent");
	await assert.rejects(scan('{"uuid":"a"'), /invalid conversation object/);
});

test("scanConversation never keeps a prefix: a value over the capture limit is reported, not cut", async () => {
	const name = "é".repeat(5000);
	const text = JSON.stringify({
		name,
		summary: "short",
		uuid: "u",
		chat_messages: [],
	});
	const small = await scanConversation(
		chunked(text, 999),
		0,
		FIELDS,
		new BufferMeter(),
		1000,
	);
	assert.equal(small.fields.has("name"), false);
	assert.deepEqual([...small.overCap], ["name"]);
	assert.equal(small.fields.get("summary"), "short");
	assert.equal(small.fields.get("uuid"), "u");
	// Within the limit the whole value is kept.
	const whole = await scanConversation(
		chunked(text, 999),
		0,
		FIELDS,
		new BufferMeter(),
		6000,
	);
	assert.equal(whole.fields.get("name"), name);
	assert.equal(whole.overCap.size, 0);
	// A later in-limit value of the same key replaces the over-limit one.
	const replaced = await scanConversation(
		chunked(`{"name":"${"x".repeat(2000)}","name":"ok"}`, 100),
		0,
		FIELDS,
		new BufferMeter(),
		1000,
	);
	assert.equal(replaced.fields.get("name"), "ok");
	assert.equal(replaced.overCap.size, 0);
});

test("scanConversation holds one message at a time: the peak buffer does not grow with the parent", async () => {
	const body = "y".repeat(100_000);
	const parent = (count: number) =>
		(async function* () {
			yield '{"chat_messages":[';
			for (let i = 0; i < count; i += 1) {
				yield `${i === 0 ? "" : ","}{"uuid":"m${i}","created_at":"2026-01-01T00:00:00Z","text":"`;
				for (let at = 0; at < body.length; at += 40_000)
					yield body.slice(at, at + 40_000);
				yield '"}';
			}
			yield '],"updated_at":"2026-01-01T00:00:00Z","uuid":"late"}';
		})();
	const run = async (count: number) => {
		const meter = new BufferMeter();
		const result = await scanConversation(parent(count), 0, FIELDS, meter);
		assert.equal(result.messageKeys.length, count);
		assert.equal(result.fields.get("uuid"), "late");
		return meter.peakUnits;
	};
	const small = await run(50); // about 5 MB
	const large = await run(700); // about 70 MB
	// Message ids differ by a few digits; the parent is 14x larger.
	assert.ok(
		Math.abs(large - small) <= 16,
		`peak ${small} vs ${large} must not depend on the parent size`,
	);
	assert.ok(small < 200_000, `peak ${small} is about one message`);
});

test("spoolEnvelopeFromChunks writes the envelope verbatim, hashed and sized while streaming", async () => {
	const payload = JSON.stringify({
		uuid: "c",
		text: "😀 ok",
		pad: "z".repeat(1000),
	});
	// A chunk size of 1 splits every surrogate pair across a chunk boundary.
	const blob = await spoolEnvelopeFromChunks(
		"conversations",
		"c",
		chunked(payload, 1),
	);
	assert.ok(blob);
	const bytes = readFileSync(join(spoolDir, blob.event.file));
	assert.equal(
		bytes.toString("utf8"),
		`{"format":"anthropic-source-record-v1","stream":"conversations","record_key":"c","payload":${payload}}`,
	);
	assert.equal(blob.blob_ref.size_bytes, bytes.length);
	assert.equal(
		blob.blob_ref.sha256,
		createHash("sha256").update(bytes).digest("hex"),
	);
	assert.equal(blob.event.key, "c");
});

test("a blob past the host cap is abandoned: null, and no file is left", async () => {
	const before = readdirSync(spoolDir).length;
	const big = "x".repeat(8 * 1024 * 1024);
	const over = await spoolEnvelopeFromChunks(
		"projects",
		"p",
		(async function* () {
			for (let i = 0; i < 5; i += 1) yield big;
		})(),
	);
	assert.equal(over, null);
	assert.equal(
		await spoolJsonText("messages", "m", "y".repeat(33_554_431)),
		null,
	);
	assert.equal(readdirSync(spoolDir).length, before);
	// Exactly at the cap is stored whole.
	const atCap = await spoolJsonText("messages", "m", "y".repeat(33_554_430));
	assert.equal(atCap?.blob_ref.size_bytes, 33_554_432);
});

test("spoolJsonText round-trips exact text, NUL and lone surrogates included", async () => {
	const text = `a\u0000b\ud800c😀${"é".repeat(70_000)}`;
	const blob = await spoolJsonText("messages", "m1", text);
	assert.ok(blob);
	const bytes = readFileSync(join(spoolDir, blob.event.file), "utf8");
	assert.equal(JSON.parse(bytes), text);
	assert.equal(bytes, JSON.stringify(text));
});

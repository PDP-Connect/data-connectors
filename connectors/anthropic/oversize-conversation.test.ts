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
	assert.ok(
		small < 300_000,
		`peak ${small} is about one message, twice (joined)`,
	);
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

// ─── header memory, duplicate chat_messages, the inline boundary ────────────

const { INLINE_TEXT_MAX_UNITS } = await import("./safe-escape.ts");
const { parseConversationHeader } = await import("./parsers.ts");

/** `count` copies of `piece`, as chunks of at most `size` units, never
 * building the whole string. */
async function* repeated(
	piece: string,
	count: number,
	size = 100_000,
): AsyncGenerator<string> {
	const per = Math.max(1, Math.floor(size / piece.length));
	for (let left = count; left > 0; left -= per)
		yield piece.repeat(Math.min(per, left));
}

async function* concat(
	...parts: Array<string | AsyncIterable<string>>
): AsyncGenerator<string> {
	for (const part of parts) {
		if (typeof part === "string") yield part;
		else yield* part;
	}
}

const scanParts = (parts: AsyncIterable<string>, meter = new BufferMeter()) =>
	scanConversation(parts, 0, FIELDS, meter);

test("a field known to be over the inline cap stops being retained: near-60M headers hold at most the cap", async () => {
	// A valid short uuid, a 59M name and a 59M summary, and tiny messages.
	const meter = new BufferMeter();
	const result = await scanParts(
		concat(
			'{"uuid":"u","name":"',
			repeated("A", 59_000_000),
			'","summary":"',
			repeated("A", 59_000_000),
			'","chat_messages":[{"uuid":"m"}]}',
		),
		meter,
	);
	assert.deepEqual([...result.overCap].sort(), ["name", "summary"]);
	assert.equal(result.fields.has("name"), false);
	assert.equal(result.fields.has("summary"), false);
	assert.equal(result.fields.get("uuid"), "u");
	assert.equal(result.retainedUnits, 1);
	assert.equal(result.messageCount, 1);
	// 118M units went by; no more than the inline cap (plus one chunk) was
	// ever held, and none of it after the decision.
	assert.ok(
		meter.peakUnits <= INLINE_TEXT_MAX_UNITS + 300_000,
		`peak ${meter.peakUnits}`,
	);
});

test("the over-cap decision is incremental: escaped text stops being retained long before the field ends", async () => {
	// 5M NULs are 30M raw units; each is 6 escaped units, so the 10M cap is
	// passed after about 1.7M of them.
	const meter = new BufferMeter();
	const result = await scanParts(
		concat(
			'{"name":"',
			repeated("\\u0000", 5_000_000, 60_000),
			'","uuid":"u"}',
		),
		meter,
	);
	assert.deepEqual([...result.overCap], ["name"]);
	assert.ok(meter.peakUnits < 2_500_000, `peak ${meter.peakUnits}`);
});

test("kept header fields count in the meter and in retainedUnits", async () => {
	const meter = new BufferMeter();
	const result = await scanParts(
		concat(
			'{"name":"',
			repeated("A", 9_000_000),
			'","summary":"',
			repeated("B", 8_000_000),
			'","uuid":"u"}',
		),
		meter,
	);
	assert.equal(result.fields.get("name")?.toString().length, 9_000_000);
	assert.equal(result.retainedUnits, 9_000_000 + 8_000_000 + 1);
	assert.ok(
		meter.peakUnits >= 17_000_000,
		`the meter counts what is retained (${meter.peakUnits})`,
	);
});

test("the inline boundary is exact: cap-1, cap and cap+1, raw and escaped", async () => {
	const cap = INLINE_TEXT_MAX_UNITS;
	const kept = async (name: AsyncIterable<string>) => {
		const result = await scanParts(concat('{"name":"', name, '","uuid":"u"}'));
		return result.fields.has("name") && !result.overCap.has("name");
	};
	// Raw ASCII: escaped length equals the length.
	assert.equal(await kept(repeated("A", cap - 1)), true);
	assert.equal(await kept(repeated("A", cap)), true);
	assert.equal(await kept(repeated("A", cap + 1)), false);
	// One NUL (six escaped units) plus ASCII: escaped length cap-1, cap, cap+1.
	assert.equal(await kept(concat(repeated("A", cap - 7), "\\u0000")), true);
	assert.equal(await kept(concat(repeated("A", cap - 6), "\\u0000")), true);
	assert.equal(await kept(concat(repeated("A", cap - 5), "\\u0000")), false);
	// The same decisions as the buffered path.
	for (const length of [cap - 1, cap, cap + 1]) {
		const buffered = parseConversationHeader(
			{ uuid: "u", name: "A".repeat(length) },
			0,
		);
		assert.equal(buffered?.title !== undefined, length <= cap);
	}
});

test("a name written as 10,000,000 JSON \\u0041 escapes (60,000,002 raw units) is kept; one more is not", async () => {
	const cap = INLINE_TEXT_MAX_UNITS;
	const atCap = await scanParts(
		concat('{"name":"', repeated("\\u0041", cap, 600_000), '","uuid":"u"}'),
	);
	assert.equal(atCap.overCap.size, 0);
	assert.equal(atCap.fields.get("name")?.toString().length, cap);
	const over = await scanParts(
		concat('{"name":"', repeated("\\u0041", cap + 1, 600_000), '","uuid":"u"}'),
	);
	assert.deepEqual([...over.overCap], ["name"]);
	assert.equal(over.fields.has("name"), false);
});

test("a repeated chat_messages key: the last occurrence wins, whatever its type", async () => {
	const first =
		'[{"uuid":"old","created_at":"2026-01-01T00:00:00Z"},{"uuid":"old2"}]';
	for (const second of [
		"null",
		'"text"',
		"7",
		"true",
		'{"uuid":"x","chat_messages":[{"uuid":"nested"}]}',
		"[]",
		'[{"uuid":"new"}]',
		first,
	]) {
		const text = `{"uuid":"c","chat_messages":${first},"name":"n","chat_messages":${second}}`;
		const buffered = (JSON.parse(text) as { chat_messages: unknown })
			.chat_messages;
		const result = await scan(text, 5);
		const expected = Array.isArray(buffered) ? buffered : null;
		assert.equal(
			result.chatMessages,
			expected ? "array" : "other",
			`second = ${second}`,
		);
		assert.equal(
			result.messageCount,
			expected?.length ?? 0,
			`second = ${second}`,
		);
		assert.deepEqual(
			result.messageKeys.map((key) =>
				JSON.parse(text.slice(key.start, key.end)),
			),
			(expected ?? []).filter(
				(item) => typeof item === "object" && item !== null,
			),
			`second = ${second}`,
		);
		assert.equal(result.nonObjectMessages, 0);
	}
	// A scalar replacement also forgets a non-object count from the first array.
	const mixed = await scan('{"chat_messages":[1,"a"],"chat_messages":null}');
	assert.equal(mixed.nonObjectMessages, 0);
	assert.equal(mixed.messageCount, 0);
});

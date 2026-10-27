// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	assertSynthesizedCall,
	buildAccountPlanRecord,
	buildConversationRecord,
	buildCustomInstructionsRecord,
	buildGizmoRecord,
	buildMemoryRecord,
	buildSharedConversationRecord,
	countBranchMessages,
	countBranchModels,
	decodeEscapedText,
	encodePdppSafeText,
	encodeToolCallStrings,
	escapedLengthExceeds,
	extractContent,
	extractContentParts,
	extractMessage,
	extractMessageWithBlob,
	extractNonStringParts,
	extractRawMessageText,
	extractToolCalls,
	flattenTreeCurrentBranch,
	isEscapedUnit,
	maxUpdateTimeIso,
	messageRecordId,
	reconcileEmittedBranchMessages,
	resolveGizmoIsPublic,
	toMessageRecord,
	tsToIso,
	unwrapGizmo,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptMessage,
	ChatGptNode,
	ConversationListItem,
	RawAccountsCheckBody,
	RawGizmo,
} from "./types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");

interface ConversationFixture {
	current_node: string;
	mapping: Record<string, ChatGptNode>;
}

function readFixtureJson<T>(rel: string): T {
	return JSON.parse(readFileSync(join(FIXTURE_DIR, rel), "utf8")) as T;
}

// ─── tsToIso ────────────────────────────────────────────────────────────

test("tsToIso: unix seconds number → ISO", () => {
	assert.equal(
		tsToIso(1_700_000_000),
		new Date(1_700_000_000 * 1000).toISOString(),
	);
});

test("tsToIso: ISO string passes through", () => {
	assert.equal(tsToIso("2024-01-02T03:04:05Z"), "2024-01-02T03:04:05.000Z");
});

test("tsToIso: null / nonsense / NaN → null", () => {
	assert.equal(tsToIso(null), null);
	assert.equal(tsToIso(undefined), null);
	assert.equal(tsToIso("not a date"), null);
	assert.equal(tsToIso(Number.NaN), null);
	// Non-string, non-number falls through to null.
	assert.equal(tsToIso({} as unknown), null);
});

test("tsToIso: non-positive epoch is a sentinel → null, not 1970-01-01", () => {
	// 0 means "no time", not the Unix epoch. Converting it would sort a
	// timeless record to the beginning of time while looking like real data.
	assert.equal(tsToIso(0), null);
	assert.equal(tsToIso(-1), null);
});

// ─── flattenTreeCurrentBranch + countBranchMessages ────────────────────

test("flattenTreeCurrentBranch: walks root → tip for current branch only", () => {
	const { mapping, current_node: currentNode } =
		readFixtureJson<ConversationFixture>("conversation-mapping.json");
	const branch = flattenTreeCurrentBranch(mapping, currentNode).map(
		(x) => x.nodeId,
	);
	assert.deepEqual(branch, ["root", "u1", "a1"]);
});

test("flattenTreeCurrentBranch: missing current → empty list", () => {
	assert.deepEqual(flattenTreeCurrentBranch({}, null), []);
	assert.deepEqual(flattenTreeCurrentBranch({}, "does-not-exist"), []);
});

test("countBranchMessages: only counts nodes with a message + role; null for missing mapping", () => {
	const { mapping, current_node: currentNode } =
		readFixtureJson<ConversationFixture>("conversation-mapping.json");
	// root has no message → 2 (u1 + a1).
	assert.equal(countBranchMessages(mapping, currentNode), 2);
	assert.equal(countBranchMessages(null, currentNode), null);
	assert.equal(countBranchMessages(mapping, null), null);
});

test("reconcileEmittedBranchMessages: chooses retained tip and bridges filtered nodes", () => {
	const result = reconcileEmittedBranchMessages([
		{ id: "m1", on_current_branch: true, parent_id: "root" },
		{ id: "m3", on_current_branch: true, parent_id: "m2" },
	]);
	assert.equal(result.count, 2);
	assert.equal(result.currentNode, "m3");
	assert.deepEqual(
		result.messages.map((message) => message.parent_id),
		["root", "m1"],
	);
});

// ─── extractContent per-content_type dispatch ─────────────────────────

test("extractContent: undefined / empty object → null", () => {
	assert.equal(extractContent(undefined), null);
	assert.equal(extractContent({}), null);
});

// The legacy collector (apps/desktop/connectors/openai/chatgpt-playwright.js,
// walkMessages) builds text and multimodal_text content as
// `parts.filter(p => typeof p === "string").join("\n")` and omits the message
// when that is empty. Each case below pins one shape of that join.
const LEGACY_JOIN_CASES: Array<[string, unknown[], string | null]> = [
	["single string", ["hello"], "hello"],
	["strings join with a newline", ["a", "b"], "a\nb"],
	["edge whitespace is kept", [" a "], " a "],
	["a trailing empty string adds a newline", [" a ", ""], " a \n"],
	["a leading empty string adds a newline", ["", " a "], "\n a "],
	["empty strings between strings", ["a", "", "b"], "a\n\nb"],
	["two empty strings give a lone newline", ["", ""], "\n"],
	["one empty string is empty", [""], null],
	["no parts", [], null],
	["whitespace-only strings are kept", ["", "   "], "\n   "],
	["only object parts are empty", [{}, {}], null],
	[
		"object parts are dropped before the join",
		["hello", { asset_pointer: "file-1" }, { text: "world" }, "end"],
		"hello\nend",
	],
	["objects around one string", [{}, " a ", {}], " a "],
	["an asset-only body is empty", [{ asset_pointer: "img-1" }], null],
	["non-object, non-string parts are dropped", [1, null, true, "a"], "a"],
];

for (const contentType of ["text", "multimodal_text"] as const) {
	for (const [name, parts, expected] of LEGACY_JOIN_CASES) {
		test(`extractContent: ${contentType} matches the legacy join: ${name}`, () => {
			assert.equal(
				extractContent({ content_type: contentType, parts }),
				expected,
			);
			assert.equal(
				extractContentParts({ content_type: contentType, parts }).raw,
				expected,
			);
		});
	}
}

// The `parts` stringifier of 0.2.56, which wrote every object part into
// `content`. The text it produced for an object part must stay recoverable.
function capturedBy0_2_56(part: unknown): string {
	if (typeof part === "string") return part;
	if (part && typeof part === "object") {
		const po = part as {
			asset_pointer?: unknown;
			content_type?: unknown;
			text?: unknown;
		};
		if (typeof po.text === "string") return po.text;
		if (typeof po.asset_pointer === "string")
			return `[asset:${po.asset_pointer}]`;
		if (typeof po.content_type === "string") return `[${po.content_type}]`;
	}
	return "";
}

const MIXED_PARTS: unknown[] = [
	"hello",
	{
		content_type: "image_asset_pointer",
		asset_pointer: "file-service://file-1",
		size_bytes: 120,
		width: 10,
		metadata: { dalle: { gen_id: "g1", prompt: "a prompt" } },
	},
	{
		content_type: "audio_transcription",
		text: "spoken words",
		direction: "in",
	},
	{ content_type: "audio_asset_pointer", asset_pointer: "sediment://audio-1" },
	{ content_type: "real_time_user_audio_video_asset_pointer" },
	{},
	1,
	null,
	["nested", { asset_pointer: "p" }],
	"end",
];

for (const contentType of ["text", "multimodal_text"] as const) {
	test(`non_string_parts: ${contentType} keeps every non-string part, and what 0.2.56 wrote into content is recoverable`, () => {
		const rec = extractMessage(
			"n1",
			{
				parent: null,
				children: [],
				message: {
					author: { role: "user" },
					content: { content_type: contentType, parts: MIXED_PARTS },
				},
			} as ChatGptNode,
			"c1",
			true,
		);
		assert.equal(rec?.content, "hello\nend", "content is the legacy join");
		const kept = rec?.non_string_parts as { index: number; part: unknown }[];
		const expectedIndexes = MIXED_PARTS.flatMap((part, index) =>
			typeof part === "string" ? [] : [index],
		);
		assert.deepEqual(
			kept.map((entry) => entry.index),
			expectedIndexes,
			"one entry per non-string part, in order, with its position in parts",
		);
		for (const entry of kept) {
			assert.deepEqual(
				entry.part,
				MIXED_PARTS[entry.index] ?? null,
				`part ${entry.index} is kept whole`,
			);
			assert.equal(
				capturedBy0_2_56(entry.part),
				capturedBy0_2_56(MIXED_PARTS[entry.index]),
				`part ${entry.index}: the 0.2.56 text is reproducible from the kept part`,
			);
		}
		assert.equal(
			validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
			true,
		);
	});
}

test("non_string_parts: empty for string-only bodies and for content types that have no parts", () => {
	for (const content of [
		{ content_type: "text", parts: ["a", "b"] },
		{ content_type: "text", parts: [] },
		{ content_type: "text" },
		{ content_type: "code", language: "python", text: "print(1)" },
		{ content_type: "thoughts", thoughts: [{ summary: "s" }] },
	]) {
		assert.deepEqual(
			extractNonStringParts(content),
			[],
			JSON.stringify(content),
		);
	}
	assert.deepEqual(extractNonStringParts(undefined), []);
});

test("non_string_parts: strings at any depth, and keys, are pdpp-safe-escape-v1 encoded and decode back", () => {
	const part = { text: "a\x00b", nested: { "k\x01": ["c\x7fd"] }, n: 3 };
	const [entry] = extractNonStringParts({
		content_type: "multimodal_text",
		parts: ["x", part],
	}) as { index: number; part: Record<string, unknown> }[];
	assert.equal(entry?.index, 1);
	assert.equal(entry?.part.text, "a\\u0000b");
	assert.deepEqual(entry?.part.nested, { "k\\u0001": ["c\\u007Fd"] });
	assert.equal(entry?.part.n, 3);
	assert.equal(decodeEscapedText(String(entry?.part.text)), part.text);
});

test("messageRecordId / toMessageRecord: ids, parent and child links name records in the conversation, node_id keeps the source id", () => {
	assert.equal(messageRecordId("c1", "n1"), "c1:n1");
	const node: ChatGptNode = {
		parent: "p1",
		children: ["k1", "k2"],
		message: {
			author: { role: "user" },
			content: { content_type: "text", parts: ["hi"] },
		},
	} as ChatGptNode;
	const rec = extractMessage("n1", node, "c1", true) ?? {};
	assert.equal(rec.id, "n1", "extraction names a node by the source's node id");
	const wire = toMessageRecord(rec, "c1");
	assert.equal(wire.id, "c1:n1");
	assert.equal(wire.node_id, "n1");
	assert.equal(wire.conversation_id, "c1");
	assert.equal(wire.parent_id, "c1:p1");
	assert.deepEqual(wire.children_ids, ["c1:k1", "c1:k2"]);
	assert.equal(
		toMessageRecord({ ...rec, parent_id: null }, "c1").parent_id,
		null,
	);
	// The same node in another conversation is another record.
	assert.notEqual(toMessageRecord(rec, "c2").id, wire.id);
	assert.equal(toMessageRecord(rec, "c2").node_id, wire.node_id);
});

test("messages manifest: primary key is [id], and every field a wire record carries is declared", () => {
	const manifest = JSON.parse(
		readFileSync(join(__dirname, "manifest.json"), "utf8"),
	) as {
		streams: Array<{
			name: string;
			primary_key: string[];
			schema: { properties: Record<string, unknown>; required: string[] };
		}>;
	};
	const stream = manifest.streams.find((s) => s.name === "messages");
	assert.deepEqual(stream?.primary_key, ["id"]);
	const wire = toMessageRecord(
		extractMessage("n1", textNode("hello"), "c1", true) ?? {},
		"c1",
	);
	for (const key of Object.keys(wire)) {
		assert.ok(key in (stream?.schema.properties ?? {}), `${key} is declared`);
	}
	for (const key of ["node_id", "non_string_parts"]) {
		assert.ok(key in (stream?.schema.properties ?? {}), `${key} is declared`);
		assert.equal(
			stream?.schema.required.includes(key),
			false,
			`${key} is additive`,
		);
	}
});

test("extractContent: a body without a parts array is empty", () => {
	assert.equal(extractContent({ content_type: "text" }), null);
	assert.equal(extractContent({ content_type: "multimodal_text" }), null);
});

test("extractContent: no text parts → null; whitespace-only text is kept as written", () => {
	assert.equal(extractContent({ content_type: "text", parts: [] }), null);
	assert.equal(extractContent({ content_type: "text", parts: [""] }), null);
	assert.equal(
		extractContent({ content_type: "text", parts: ["", "   "] }),
		"\n   ",
	);
});

test("extractContent: code with language → fenced block", () => {
	const out = extractContent({
		content_type: "code",
		language: "python",
		text: "print(1)",
	});
	assert.equal(out, "```python\nprint(1)\n```");
});

test("extractContent: code without language → raw body", () => {
	const out = extractContent({ content_type: "code", text: "echo hi" });
	assert.equal(out, "echo hi");
});

test("extractContent: code empty body + empty language → null", () => {
	assert.equal(extractContent({ content_type: "code" }), null);
});

test("extractContent: thoughts combines summary + content per entry, separates entries with blank line", () => {
	const out = extractContent({
		content_type: "thoughts",
		thoughts: [
			{ summary: "s1", content: "c1" },
			{ summary: "s2" },
			{ content: "c3" },
		],
	});
	assert.equal(out, "s1\nc1\n\ns2\n\nc3");
});

test("extractContent: reasoning_recap prefers `content` then falls back to `text`", () => {
	assert.equal(
		extractContent({ content_type: "reasoning_recap", content: "A" }),
		"A",
	);
	assert.equal(
		extractContent({ content_type: "reasoning_recap", text: "B" }),
		"B",
	);
	assert.equal(extractContent({ content_type: "reasoning_recap" }), null);
});

test("extractContent: tether_browsing_display joins summary + result with blank line", () => {
	const out = extractContent({
		content_type: "tether_browsing_display",
		summary: "quick summary",
		result: "full text",
	});
	assert.equal(out, "quick summary\n\nfull text");
});

test("extractContent: tether_quote stacks title + url + text newline-joined", () => {
	const out = extractContent({
		content_type: "tether_quote",
		title: "T",
		url: "https://example/q",
		text: "quoted",
	});
	assert.equal(out, "T\nhttps://example/q\nquoted");
});

test("extractContent: execution_output returns text or null", () => {
	assert.equal(
		extractContent({ content_type: "execution_output", text: "stdout" }),
		"stdout",
	);
	assert.equal(extractContent({ content_type: "execution_output" }), null);
});

test("extractContent: model_editable_context includes repository line when set", () => {
	const out = extractContent({
		content_type: "model_editable_context",
		model_set_context: "bio",
		repository: "org/repo",
		repo_summary: "it's a repo",
	});
	assert.equal(out, "bio\n\nrepository: org/repo\n\nit's a repo");
});

test("extractContent: unrecognized shape falls back to JSON-stringified payload", () => {
	const out = extractContent({
		content_type: "unknown_future_shape",
		mystery: true,
	});
	assert.ok(typeof out === "string" && out.includes("unknown_future_shape"));
});

test("extractContent: empty / null-shaped content falls back to null", () => {
	assert.equal(extractContent({}), null);
});

test("extractContent: content with U+0000 (NUL) keeps its text with the control char escaped, never null", () => {
	// A raw NUL would fail the messages schema (shape_check_failed, non-backfillable)
	// and nulling the body silently loses the whole message text. Escape the
	// forbidden char visibly instead; the loss marker is asserted on the record.
	assert.equal(
		extractContent({ content_type: "text", parts: ["hello\x00world"] }),
		"hello\\u0000world",
	);
});

test("extractContent: content with other forbidden control char (VT U+000B) keeps its text, escaped", () => {
	assert.equal(
		extractContent({ content_type: "text", parts: ["line1\x0Bline2"] }),
		"line1\\u000Bline2",
	);
});

test("extractContentParts: forbidden controls at the edges are escaped, not trimmed away, and carry no loss signal", () => {
	assert.deepEqual(
		extractContentParts({
			content_type: "text",
			parts: ["\u000Bhello\u000C"],
		}),
		{
			raw: "\u000Bhello\u000C",
			sourceUnrepresentable: false,
		},
	);
	assert.equal(
		extractContent({ content_type: "text", parts: ["\u000B\u000C"] }),
		"\\u000B\\u000C",
	);
});

test("extractContent: leading and trailing whitespace is preserved exactly, in every text-bearing shape", () => {
	const edged = (body: string) => `  \t\n${body}\n\t \u00A0`;
	const cases: Array<[string, Parameters<typeof extractContent>[0]]> = [
		["text", { content_type: "text", parts: [edged("a")] }],
		[
			"multimodal_text",
			{ content_type: "multimodal_text", parts: [edged("a")] },
		],
		[
			"thoughts",
			{ content_type: "thoughts", thoughts: [{ summary: edged("a") }] },
		],
		[
			"tether_browsing_display",
			{ content_type: "tether_browsing_display", result: edged("a") },
		],
		["tether_quote", { content_type: "tether_quote", text: edged("a") }],
		[
			"model_editable_context",
			{ content_type: "model_editable_context", model_set_context: edged("a") },
		],
		[
			"user_editable_context",
			{ content_type: "user_editable_context", user_instructions: edged("a") },
		],
	];
	for (const [name, content] of cases) {
		const got = extractContent(content);
		assert.ok(got?.includes(edged("a")), `${name}: ${JSON.stringify(got)}`);
	}
	assert.equal(
		extractContentParts({ content_type: "text", parts: ["  hello \n"] }).raw,
		"  hello \n",
	);
	assert.equal(
		extractContent({ content_type: "text", parts: ["\n\t "] }),
		"\n\t ",
	);
});

test("extractMessage: the stored record keeps edge whitespace next to escaped controls", () => {
	const source = "\n  lead\ttab \x00 mid\x0B \n trail  \t\n";
	const rec = extractMessage("n1", textNode(source), "c1", true);
	assert.equal(
		rec?.content,
		source.replace("\x00", "\\u0000").replace("\x0B", "\\u000B"),
	);
	assert.equal(decodeEscapedText(rec?.content as string), source);
});

function textNode(text: string): ChatGptNode {
	return {
		parent: null,
		children: [],
		message: {
			author: { role: "user" },
			content: { content_type: "text", parts: [text] },
		},
	} as ChatGptNode;
}

test("extractMessage: control-rich text is emitted escaped with no loss marker, no gap signal and no undeclared key", () => {
	const rec = extractMessage("n1", textNode("a\x00b"), "c1", true);
	assert.equal(rec?.content, "a\\u0000b");
	assert.equal("content_loss" in (rec ?? {}), false);
	assert.equal("blob_ref" in (rec ?? {}), false);
	assert.equal(
		validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
		true,
	);
});

test("decodeEscapedText: NUL and other controls round-trip losslessly", () => {
	for (const source of [
		"a\x00b",
		"\x00",
		"\x01\x0B\x0C\x1F\x7F\x80\x9F",
		"tail NUL\x00",
		"lone \ud800 surrogate",
		"valid pair \u{1F600} next to \x00",
	]) {
		const rec = extractMessage("n1", textNode(source), "c1", true);
		assert.equal(
			validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
			true,
		);
		assert.equal(
			decodeEscapedText(rec?.content as string),
			source,
			JSON.stringify(source),
		);
	}
});

test("decodeEscapedText: text that already spells an escape stays distinguishable from a real control char", () => {
	// A literal backslash-u0000 in the source must not decode to NUL.
	for (const source of [
		"literal \\u0000 text",
		"literal \\u005C text",
		"two slashes \\\\u0001",
		"mix \\u0000 and real \x00",
		"harmless \\u00e9 stays as typed",
	]) {
		const rec = extractMessage("n1", textNode(source), "c1", true);
		assert.equal(
			decodeEscapedText(rec?.content as string),
			source,
			JSON.stringify(source),
		);
	}
	// Text that needs no escaping is untouched.
	const plain = extractMessage("n1", textNode("harmless \\u00e9"), "c1", true);
	assert.equal(plain?.content, "harmless \\u00e9");
});

test("decodeEscapedText: round-trips arbitrary strings over a hostile alphabet", () => {
	const alphabet = [
		"\\",
		"u",
		"0",
		"5",
		"C",
		"c",
		"a",
		"\x00",
		"\x01",
		"x",
		"\n",
		"\ud800",
		"\u{1F600}",
	];
	let seed = 12_345;
	const next = (): number => {
		seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
		return seed;
	};
	for (let i = 0; i < 2000; i += 1) {
		const length = 1 + (next() % 14);
		let source = "x";
		for (let j = 0; j < length; j += 1) {
			source += alphabet[next() % alphabet.length];
		}
		source += "x";
		const rec = extractMessage("n1", textNode(source), "c1", true);
		assert.equal(
			validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
			true,
		);
		assert.equal(
			decodeEscapedText(rec?.content as string),
			source,
			JSON.stringify(source),
		);
	}
});

test("extractMessage: oversize text is not truncated; its full text is handed to a blob", () => {
	const source = "y".repeat(CONTENT_CAP * 2);
	const node = textNode(source);
	const { record, oversize } = extractMessageWithBlob("n1", node, "c1", true);
	assert.equal(oversize, true);
	assert.equal(extractRawMessageText(node), source);
	assert.equal(record?.content, null);
	assert.equal("content_loss" in (record ?? {}), false);
});

test("extractMessage: clean text has no content_loss key and no blob", () => {
	const { record, oversize } = extractMessageWithBlob(
		"n1",
		textNode("hello"),
		"c1",
		true,
	);
	assert.equal("content_loss" in (record ?? {}), false);
	assert.equal(record?.content, "hello");
	assert.equal(oversize, false);
});

test("extractContent: content with only allowed whitespace (\\t \\n \\r) is preserved", () => {
	assert.equal(
		extractContent({ content_type: "text", parts: ["a\tb\nc\rd"] }),
		"a\tb\nc\rd",
	);
});

test("extractContent: safe full message content is not preview-truncated", () => {
	const content = "x".repeat(5001);
	assert.equal(
		extractContent({ content_type: "text", parts: [content] }),
		content,
	);
});

// ─── oversized content (>1 MB) safe-landing ───────────────────────────────
//
// The messages schema caps `content` at 1_048_576 chars. A safe-but-oversized
// body (control-clean) passes sanitization yet would fail that cap, producing
// a terminal shape_check_failed SKIP that makes the whole message
// non-backfillable. extractContent truncates the head in-band so the record
// still lands, with a self-describing recovery marker.

const CONTENT_CAP = 1_048_576;

test("extractContent: body exactly at the 1 MB cap is preserved verbatim", () => {
	const atCap = "x".repeat(CONTENT_CAP);
	const out = extractContent({ content_type: "text", parts: [atCap] });
	assert.equal(out, atCap);
	assert.equal(out?.length, CONTENT_CAP);
});

test("extractContent: an oversized (>1 MB) safe body is returned whole, never truncated", () => {
	const oversized = "y".repeat(CONTENT_CAP * 3);
	const out = extractContent({ content_type: "text", parts: [oversized] });
	assert.equal(out, oversized);
});

test("extractContentParts: oversize astral text keeps every surrogate pair", () => {
	const oversized = "😀".repeat(CONTENT_CAP);
	assert.equal(
		extractContentParts({ content_type: "text", parts: [oversized] }).raw,
		oversized,
	);
});

test("extractContentParts: only the unknown-shape fallback truncation is source-unrepresentable", () => {
	const unknown = (size: number) => ({
		content_type: "unknown_future_shape",
		text: "x".repeat(size),
	});
	assert.equal(extractContentParts(unknown(6000)).sourceUnrepresentable, true);
	assert.equal(extractContentParts(unknown(100)).sourceUnrepresentable, false);
	for (const content of [
		{ content_type: "text", parts: ["a\x00b"] },
		{ content_type: "text", parts: ["z".repeat(CONTENT_CAP * 2)] },
		{ content_type: "text", parts: ["plain"] },
	]) {
		assert.equal(extractContentParts(content).sourceUnrepresentable, false);
	}
});

test("messages schema: a message with a blob_ref and null content validates", () => {
	const sha256 = "a".repeat(64);
	const base = toMessageRecord(
		extractMessage("n1", textNode("hello"), "c1", true) ?? {},
		"c1",
	);
	const ok = validateRecord("messages", {
		...base,
		content: null,
		blob_ref: {
			blob_id: `sha256:${sha256}`,
			mime_type: "application/json",
			size_bytes: 5,
			sha256,
		},
	});
	assert.equal(ok.ok, true);
	const bad = validateRecord("messages", {
		...base,
		content: null,
		blob_ref: { blob_id: "nope" },
	});
	assert.equal(bad.ok, false);
});

test("messages manifest: no content_loss, a declared blob_ref, and the content encoding is documented", () => {
	const manifest = JSON.parse(
		readFileSync(join(__dirname, "manifest.json"), "utf8"),
	) as {
		capabilities: { host_blob_write?: { streams: string[] } };
		protocol_capabilities?: string[];
		streams: Array<{
			name: string;
			schema: {
				properties: Record<string, { description?: string }>;
			};
		}>;
	};
	const messages = manifest.streams.find((s) => s.name === "messages");
	assert.ok(messages);
	assert.equal("content_loss" in messages.schema.properties, false);
	assert.ok("blob_ref" in messages.schema.properties);
	assert.deepEqual(manifest.capabilities.host_blob_write?.streams, [
		"messages",
	]);
	assert.deepEqual(manifest.protocol_capabilities, ["BLOB"]);
	const description = messages.schema.properties.content?.description ?? "";
	assert.match(description, /U\+0000|NUL/);
	assert.match(description, /\\uXXXX/);
	assert.match(description, /\\u005C/);
	assert.match(description, /blob_ref/);
});

// ─── extractToolCalls ──────────────────────────────────────────────────

test("extractToolCalls: explicit metadata.tool_calls passes through when non-empty", () => {
	const calls = [{ name: "python", args: {} }];
	const out = extractToolCalls({
		author: { role: "assistant" },
		metadata: { tool_calls: calls },
	});
	assert.deepEqual(out, calls);
});

test("extractToolCalls: assistant addressed to a tool synthesizes a call", () => {
	const out = extractToolCalls({
		author: { role: "assistant" },
		recipient: "python",
		content: { content_type: "code", language: "python", text: "1+1" },
		metadata: { invoked_plugin: { plugin_id: "p1" } },
	});
	assert.equal(out.length, 1);
	const c = out[0] as {
		content_type?: string;
		invoked_plugin?: unknown;
		language?: string;
		recipient?: string;
		text?: string;
	};
	assert.equal(c.recipient, "python");
	assert.equal(c.content_type, "code");
	assert.equal(c.language, "python");
	assert.equal(c.text, "1+1");
	assert.deepEqual(c.invoked_plugin, { plugin_id: "p1" });
});

test("extractToolCalls: assistant with recipient='all' does NOT synthesize a call", () => {
	const out = extractToolCalls({
		author: { role: "assistant" },
		recipient: "all",
	});
	assert.deepEqual(out, []);
});

test("extractToolCalls: plugin invocation without explicit tool_calls → single element", () => {
	const out = extractToolCalls({
		author: { role: "assistant" },
		metadata: { invoked_plugin: { plugin_id: "wolfram" } },
	});
	assert.deepEqual(out, [{ invoked_plugin: { plugin_id: "wolfram" } }]);
});

test("extractToolCalls: user message → empty list", () => {
	assert.deepEqual(extractToolCalls({ author: { role: "user" } }), []);
});

// ─── extractMessage ────────────────────────────────────────────────────

test("extractMessage: returns null for synthetic root (no message)", () => {
	assert.equal(
		extractMessage("root", { parent: null, children: ["x"] }, "conv1", false),
		null,
	);
});

test("extractMessage: builds a RECORD with content + children + current-branch flag", () => {
	const { mapping } = readFixtureJson<ConversationFixture>(
		"conversation-mapping.json",
	);
	const { a1 } = mapping;
	assert.ok(a1, "fixture must expose a1");
	const rec = extractMessage("a1", a1, "conv1", true);
	assert.ok(rec);
	assert.equal(rec?.id, "a1");
	assert.equal(rec?.conversation_id, "conv1");
	assert.equal(rec?.role, "assistant");
	assert.equal(rec?.content, "hi there");
	assert.equal(rec?.content_type, "text");
	assert.equal(rec?.model_slug, "gpt-4o");
	assert.equal(rec?.finish_reason, "stop");
	assert.equal(rec?.on_current_branch, true);
});

// ─── Memory + gizmo + custom instructions + shared + conversation ─────

test("buildMemoryRecord: returns null when id is missing", () => {
	assert.equal(buildMemoryRecord({}), null);
});

test("buildMemoryRecord: falls back from content to name", () => {
	const rec = buildMemoryRecord({
		id: "m1",
		name: "remember this",
		updated_at: "2024-01-01T00:00:00Z",
	});
	assert.equal(rec?.content, "remember this");
	assert.equal(rec?.updated_at, "2024-01-01T00:00:00Z");
});

test("buildMemoryRecord: carries type through when present", () => {
	const rec = buildMemoryRecord({
		id: "m1",
		content: "remember this",
		type: "user_provided",
	});
	assert.equal(rec?.type, "user_provided");
});

test("buildMemoryRecord: created_at comes from created_timestamp (epoch seconds)", () => {
	const dated = buildMemoryRecord({
		id: "m-dated",
		content: "synthetic dated memory",
		created_timestamp: 1759406400,
		updated_at: "2025-10-02T12:00:00Z",
	});
	assert.equal(dated?.created_at, "2025-10-02T12:00:00.000Z");
	assert.equal(dated?.updated_at, "2025-10-02T12:00:00Z");
});

test("buildMemoryRecord: reads the legacy created_at / createdAt / updatedAt aliases", () => {
	const snake = buildMemoryRecord({
		id: "m-snake",
		content: "synthetic",
		created_at: "2025-03-01T00:00:00Z",
		updatedAt: "2025-03-02T00:00:00Z",
	});
	assert.equal(snake?.created_at, "2025-03-01T00:00:00.000Z");
	assert.equal(snake?.updated_at, "2025-03-02T00:00:00Z");
	const camel = buildMemoryRecord({
		id: "m-camel",
		content: "synthetic",
		createdAt: "2025-04-01T00:00:00Z",
		updated_at: "2025-04-02T00:00:00Z",
		updatedAt: "2099-01-01T00:00:00Z",
	});
	assert.equal(camel?.created_at, "2025-04-01T00:00:00.000Z");
	// legacy precedence: updated_at wins over updatedAt
	assert.equal(camel?.updated_at, "2025-04-02T00:00:00Z");
	// legacy precedence: created_at wins over createdAt; created_timestamp is the fallback
	const both = buildMemoryRecord({
		id: "m-both",
		content: "synthetic",
		created_at: "2025-05-01T00:00:00Z",
		createdAt: "2025-06-01T00:00:00Z",
		created_timestamp: 1759406400,
	});
	assert.equal(both?.created_at, "2025-05-01T00:00:00.000Z");
	const fallback = buildMemoryRecord({
		id: "m-fb",
		content: "synthetic",
		created_at: "not a date",
		created_timestamp: 1759406400,
	});
	assert.equal(fallback?.created_at, "2025-10-02T12:00:00.000Z");
});

test("buildMemoryRecord: created_at is null for an undated memory", () => {
	const nullTs = buildMemoryRecord({
		id: "m-undated",
		content: "synthetic undated memory",
		created_timestamp: null,
		updated_at: "2024-01-01T00:00:00Z",
	});
	assert.equal(nullTs?.created_at, null);
	assert.equal(nullTs?.updated_at, "2024-01-01T00:00:00Z");
	const absent = buildMemoryRecord({ id: "m-absent", content: "synthetic" });
	assert.equal(absent?.created_at, null);
});

test("buildMemoryRecord: type is null when absent", () => {
	const rec = buildMemoryRecord({ id: "m1", content: "x" });
	assert.equal(rec?.type, null);
});

test("unwrapGizmo: handles {resource:{gizmo:{}}}, {resource:{}}, {gizmo:{}} and flat", () => {
	assert.equal(unwrapGizmo(null), null);
	assert.equal(unwrapGizmo("not obj"), null);
	assert.deepEqual(
		(unwrapGizmo({ resource: { gizmo: { id: "a" } } }) as RawGizmo).id,
		"a",
	);
	assert.deepEqual(
		(unwrapGizmo({ resource: { id: "b" } }) as RawGizmo).id,
		"b",
	);
	assert.deepEqual((unwrapGizmo({ gizmo: { id: "c" } }) as RawGizmo).id, "c");
	assert.deepEqual((unwrapGizmo({ id: "d" }) as RawGizmo).id, "d");
});

// `{ info: {...}, list: {...} }` is a fifth `/gizmos/mine` item wrapper —
// live in UAT run run_1786417045973 (considered:1/covered:0 shape_check_failed,
// rejected item's keys exactly `["info", "list"]`). `list` is listing-only
// metadata (e.g. is_starred), not gizmo fields, and stays unread.
test("unwrapGizmo: handles {info:{}, list:{}} (live shape drift, run_1786417045973)", () => {
	assert.deepEqual(
		(unwrapGizmo({ info: { id: "e" }, list: { is_starred: true } }) as RawGizmo)
			.id,
		"e",
	);
});

// `picked` selects the first *object-valued* candidate, not the first non-nullish
// one — a malformed/scalar higher-priority field must not mask a valid lower one.
test("unwrapGizmo: precedence — object-valued candidates win, arrays and scalars are skipped", () => {
	// documented priority: resource.gizmo > gizmo > info > resource > flat
	assert.equal(
		(unwrapGizmo({ gizmo: { id: "g" }, info: { id: "i" } }) as RawGizmo).id,
		"g",
	);
	assert.equal(
		(
			unwrapGizmo({
				resource: { gizmo: { id: "rg" } },
				info: { id: "i" },
			}) as RawGizmo
		).id,
		"rg",
	);
	// competing info/resource: info wins per documented priority
	assert.equal(
		(unwrapGizmo({ info: { id: "i" }, resource: { id: "r" } }) as RawGizmo).id,
		"i",
	);
	// malformed info (scalar/array) falls through to a valid lower-priority candidate
	assert.equal(
		(unwrapGizmo({ info: "junk", resource: { id: "r" } }) as RawGizmo).id,
		"r",
	);
	assert.equal(
		(unwrapGizmo({ info: 0, resource: { id: "r" } }) as RawGizmo).id,
		"r",
	);
	assert.equal(
		(unwrapGizmo({ info: [1, 2], resource: { id: "r" } }) as RawGizmo).id,
		"r",
	);
	// malformed info with no valid wrapper field anywhere falls through to the flat item itself
	assert.deepEqual(unwrapGizmo({ info: "junk", gizmo: 5, id: "flat" }), {
		info: "junk",
		gizmo: 5,
		id: "flat",
	});
});

test("resolveGizmoIsPublic: boolean wins over sharing string, else sharing==='public'", () => {
	assert.equal(resolveGizmoIsPublic({ is_public: true }), true);
	assert.equal(
		resolveGizmoIsPublic({ is_public: false, sharing: "public" }),
		false,
	);
	assert.equal(resolveGizmoIsPublic({ sharing: "public" }), true);
	assert.equal(resolveGizmoIsPublic({ sharing: "private" }), false);
	assert.equal(resolveGizmoIsPublic({}), null);
});

test("buildGizmoRecord: normalizes wrapped fixture (+ tool tag extraction)", () => {
	const raw = readFixtureJson<unknown>("gizmo-wrapped.json");
	const rec = buildGizmoRecord(raw);
	assert.ok(rec);
	assert.equal(rec?.id, "g-abc");
	assert.equal(rec?.display_name, "Rubber Duck");
	assert.equal(rec?.display_description, "Talks back");
	assert.equal(rec?.author_id, "U42");
	assert.equal(rec?.author_name, "Alice");
	assert.equal(rec?.is_public, true);
	assert.deepEqual(rec?.tools, ["code_interpreter", "browser", "dalle"]);
	assert.deepEqual(rec?.tags, ["debug"]);
});

test("buildGizmoRecord: missing id → null", () => {
	assert.equal(buildGizmoRecord({ resource: { gizmo: {} } }), null);
});

test("buildCustomInstructionsRecord: prefers _message fields; preserves enabled boolean", () => {
	const rec = buildCustomInstructionsRecord({
		about_user_message: "I'm a dev",
		about_model_message: "Be concise",
		enabled: true,
		updated_at: 1_700_000_000,
	});
	assert.equal(rec.id, "user_custom_instructions");
	assert.equal(rec.about_user, "I'm a dev");
	assert.equal(rec.response_style, "Be concise");
	assert.equal(rec.enabled, true);
	assert.equal(rec.updated_at, new Date(1_700_000_000 * 1000).toISOString());
});

test("buildCustomInstructionsRecord: falls back to fallback keys + null enabled when absent", () => {
	const rec = buildCustomInstructionsRecord({
		about_user: "legacy-a",
		response_style: "legacy-b",
	});
	assert.equal(rec.about_user, "legacy-a");
	assert.equal(rec.response_style, "legacy-b");
	assert.equal(rec.enabled, null);
});

// accounts-check.json follows a real accounts/check response from a free
// account with a lapsed Pro subscription. Ids, dates and the feature list are
// replaced with placeholders; the eligibility flags and offers are trimmed.
test("buildAccountPlanRecord: normalizes the default account from the fixture", () => {
	const raw = readFixtureJson<RawAccountsCheckBody>("accounts-check.json");
	const rec = buildAccountPlanRecord(raw);
	assert.deepEqual(rec, {
		id: "account_plan",
		account_id: "00000000-0000-4000-8000-000000000001",
		account_structure: "personal",
		account_created_at: "2023-01-15T10:00:00.000Z",
		plan_type: "free",
		plan_display_name: "Free",
		subscription_plan: "chatgptpro",
		has_active_subscription: false,
		billing_period: "monthly",
		will_renew: false,
		renews_at: null,
		expires_at: "2026-03-15T10:00:00.000Z",
		cancels_at: null,
		scheduled_plan_change: null,
	});
	assert.ok(rec);
	assert.equal(validateRecord("account_plan", rec).ok, true);
});

test("buildAccountPlanRecord: carries no billing identifier or profile field", () => {
	const raw = readFixtureJson<RawAccountsCheckBody>("accounts-check.json");
	const serialized = JSON.stringify(buildAccountPlanRecord(raw));
	for (const leaked of [
		"subscription_id",
		"0000000000aa",
		"processor",
		"account_user_id",
		"account_owner_id",
		"REDACTED",
		"profile_picture",
		"pthdnu",
	]) {
		assert.equal(serialized.includes(leaked), false, `${leaked} must not leak`);
	}
});

// accounts-check-pro.json keeps the key layout of a live accounts/check
// response for an active, renewing personal Pro subscription. Ids, dates,
// residency, feature flags and offers are placeholders.
test("buildAccountPlanRecord: normalizes an active Pro account without leaking billing fields", () => {
	const raw = readFixtureJson<RawAccountsCheckBody>("accounts-check-pro.json");
	const rec = buildAccountPlanRecord(raw);
	assert.ok(rec);
	assert.equal(rec.plan_type, "pro");
	assert.equal(rec.account_structure, "personal");
	assert.equal(rec.subscription_plan, "chatgptpro");
	assert.equal(rec.has_active_subscription, true);
	assert.equal(rec.will_renew, true);
	assert.equal(rec.billing_period, "monthly");
	assert.equal(typeof rec.renews_at, "string");
	assert.equal(typeof rec.expires_at, "string");
	assert.equal(rec.cancels_at, null);
	assert.equal(rec.scheduled_plan_change, null);
	assert.equal(validateRecord("account_plan", rec).ok, true);
	const serialized = JSON.stringify(rec);
	for (const leaked of [
		"subscription_id",
		"processor",
		"REDACTED",
		"account_user_id",
	]) {
		assert.equal(serialized.includes(leaked), false, `${leaked} must not leak`);
	}
});

test("buildAccountPlanRecord: whitespace-only identifiers do not make an account", () => {
	for (const blank of [" ", "\t\n", "   "]) {
		assert.equal(
			buildAccountPlanRecord({
				accounts: { default: { account: { plan_type: blank } } },
			}),
			null,
		);
		assert.equal(
			buildAccountPlanRecord({
				accounts: {
					default: {
						account: { account_id: blank, plan_type: blank, structure: blank },
					},
				},
			}),
			null,
		);
	}
});

test("buildAccountPlanRecord: a present but invalid default is a parse failure, never a switch to another account", () => {
	const team = { account: { account_id: "team", plan_type: "team" } };
	for (const bad of [{ account: {} }, {}, null, "x", [], { account: [] }]) {
		assert.equal(
			buildAccountPlanRecord({
				accounts: { default: bad as never, team },
				account_ordering: ["team"],
			}),
			null,
		);
	}
});

test("buildAccountPlanRecord: an undefined default still falls back to the first valid entry", () => {
	const rec = buildAccountPlanRecord({
		accounts: {
			default: undefined as never,
			team: { account: { account_id: "team", plan_type: "team" } },
		},
	});
	assert.equal(rec?.account_id, "team");
});

test("buildAccountPlanRecord: without a default alias, account_ordering picks the entry and its key is the account id", () => {
	const rec = buildAccountPlanRecord({
		accounts: {
			"acct-b": { account: { plan_type: "team", structure: "workspace" } },
			"acct-a": { account: { plan_type: "free" } },
		},
		account_ordering: ["acct-a", "acct-b"],
	});
	assert.equal(rec?.account_id, "acct-a");
	assert.equal(rec?.plan_type, "free");
});

test("buildAccountPlanRecord: free account with no entitlement → nulls, still schema-valid", () => {
	const rec = buildAccountPlanRecord({
		accounts: { default: { account: { plan_type: "free" } } },
	});
	assert.ok(rec);
	assert.equal(rec.account_id, null);
	assert.equal(rec.subscription_plan, null);
	assert.equal(rec.has_active_subscription, null);
	assert.equal(rec.will_renew, null);
	assert.equal(rec.renews_at, null);
	assert.equal(rec.scheduled_plan_change, null);
	assert.equal(validateRecord("account_plan", rec).ok, true);
});

test("buildAccountPlanRecord: epoch-second dates and wrongly typed fields are normalized, not passed through", () => {
	const rec = buildAccountPlanRecord({
		accounts: {
			default: {
				account: { plan_type: "pro" },
				entitlement: {
					expires_at: 1_700_000_000,
					cancels_at: "not a date",
					has_active_subscription: null,
					scheduled_plan_change: ["not", "an", "object"],
				},
			},
		},
	});
	assert.equal(rec?.expires_at, new Date(1_700_000_000 * 1000).toISOString());
	assert.equal(rec?.cancels_at, null);
	assert.equal(rec?.has_active_subscription, null);
	assert.equal(rec?.scheduled_plan_change, null);
});

const planWithChange = (change: unknown) =>
	buildAccountPlanRecord({
		accounts: {
			default: {
				account: { plan_type: "pro" },
				entitlement: { scheduled_plan_change: change as never },
			},
		},
	});

// A non-null scheduled_plan_change has not been observed. These objects are
// invented around the keys one public reader uses (plan_type, changes_at).
test("buildAccountPlanRecord: scheduled_plan_change keeps plan_type and changes_at and drops every other key", () => {
	const rec = planWithChange({
		plan_type: "plus",
		changes_at: 1_700_000_000,
		subscription_id: "sub_123",
		customer_id: "cus_456",
		email: "someone@example.com",
		payment: { processor_id: "pm_999", card: { last4: "4242" } },
	});
	assert.ok(rec);
	assert.deepEqual(rec.scheduled_plan_change, {
		plan_type: "plus",
		changes_at: new Date(1_700_000_000 * 1000).toISOString(),
	});
	assert.equal(validateRecord("account_plan", rec).ok, true);
	const serialized = JSON.stringify(rec);
	for (const leaked of ["sub_123", "cus_456", "someone@", "pm_999", "4242"]) {
		assert.equal(serialized.includes(leaked), false, `${leaked} must not leak`);
	}
});

test("buildAccountPlanRecord: a scheduled_plan_change with unrecognised keys still reads as a scheduled change", () => {
	for (const change of [
		{},
		{ subscription_plan: "chatgptplusplan", effective_at: 1_700_000_000 },
		{ plan_type: "someone@example.com", changes_at: "not a date" },
		{ plan_type: "sub_1NxAbC23", changes_at: null },
		{ plan_type: "cus_456" },
		{ plan_type: "00000000-0000-4000-8000-000000000001" },
		{ plan_type: { id: "sub_nested" }, changes_at: { at: "2026-01-01" } },
		{ plan_type: 42, changes_at: true },
	]) {
		const rec = planWithChange(change);
		assert.ok(rec);
		assert.deepEqual(
			rec.scheduled_plan_change,
			{ plan_type: null, changes_at: null },
			JSON.stringify(change),
		);
		assert.equal(validateRecord("account_plan", rec).ok, true);
	}
});

test("buildAccountPlanRecord: a scheduled_plan_change that is not an object → null", () => {
	for (const change of [null, undefined, [{ plan_type: "plus" }], "plus", 42]) {
		assert.equal(planWithChange(change)?.scheduled_plan_change, null);
	}
});

test("account_plan schema rejects extra keys or a non-slug plan_type inside scheduled_plan_change", () => {
	const rec = planWithChange(null);
	assert.ok(rec);
	for (const change of [
		{ plan_type: "plus", changes_at: null, subscription_id: "sub_1" },
		{ plan_type: "someone@example.com", changes_at: null },
		{ plan_type: "sub_123", changes_at: null },
	]) {
		assert.equal(
			validateRecord("account_plan", { ...rec, scheduled_plan_change: change })
				.ok,
			false,
			JSON.stringify(change),
		);
	}
});

test("buildAccountPlanRecord: an account without a usable discriminator → null", () => {
	for (const body of [
		{ accounts: { default: { account: [] } } },
		{ accounts: { default: { account: {} } } },
		{ accounts: { default: { account: { account_id: "" } } } },
		{ accounts: { default: { account: { plan_type: 5, structure: true } } } },
		{ accounts: { default: { account: "free" } } },
		{ accounts: { default: { account: 1 } } },
	]) {
		assert.equal(
			buildAccountPlanRecord(body as unknown as RawAccountsCheckBody),
			null,
			JSON.stringify(body),
		);
	}
});

test("buildAccountPlanRecord: a free account with only an account_id still builds", () => {
	const rec = buildAccountPlanRecord({
		accounts: { default: { account: { account_id: "acct-free" } } },
	});
	assert.equal(rec?.account_id, "acct-free");
});

test("buildAccountPlanRecord: a body that names no account → null", () => {
	assert.equal(buildAccountPlanRecord(null), null);
	assert.equal(buildAccountPlanRecord({}), null);
	assert.equal(buildAccountPlanRecord({ accounts: {} }), null);
	assert.equal(
		buildAccountPlanRecord({ accounts: { default: { account: null } } }),
		null,
	);
});

test("buildSharedConversationRecord: null when no id / share_id", () => {
	assert.equal(buildSharedConversationRecord({}), null);
});

test("buildSharedConversationRecord: synthesizes share_url and resolves anonymous fallback", () => {
	const rec = buildSharedConversationRecord({
		share_id: "s-1",
		conversation_id: "c-1",
		title: "t",
		create_time: 1_700_000_000,
		anonymous: true,
	});
	assert.equal(rec?.id, "s-1");
	assert.equal(rec?.share_url, "https://chatgpt.com/share/s-1");
	assert.equal(rec?.anonymous, true);
});

test("buildConversationRecord: detail fields overlay list; branchCount uses mapping", () => {
	const { mapping, current_node: currentNode } =
		readFixtureJson<ConversationFixture>("conversation-mapping.json");
	const list: ConversationListItem = {
		id: "conv1",
		title: "list-title",
		update_time: 1_700_000_000,
		current_node: null,
	};
	const rec = buildConversationRecord(list, {
		title: "detail-title",
		update_time: 1_710_000_000,
		is_archived: true,
		workspace_id: "w-1",
		gizmo_id: "g-1",
		current_node: currentNode,
		mapping,
	});
	assert.equal(rec.title, "detail-title");
	assert.equal(rec.is_archived, true);
	assert.equal(rec.workspace_id, "w-1");
	assert.equal(rec.gizmo_id, "g-1");
	assert.equal(rec.current_node, currentNode);
	assert.equal(rec.message_count_on_current_branch, 2);
});

test("countBranchModels: a conversation that switches models counts assistant replies per model on the current branch only", () => {
	const { mapping, current_node: currentNode } =
		readFixtureJson<ConversationFixture>("conversation-model-switch.json");
	// gpt-4o twice, then o3 twice. Not counted: the tool message that names
	// gpt-4o, the abandoned-branch reply that names gpt-5, and the last
	// assistant reply, which reports no model.
	assert.deepEqual(countBranchModels(mapping, currentNode), {
		"gpt-4o": 2,
		o3: 2,
	});
	// The same tree read from the abandoned branch sees only its own replies.
	assert.deepEqual(countBranchModels(mapping, "a3-alt"), {
		"gpt-4o": 2,
		"gpt-5": 1,
	});
});

test("countBranchModels: null without a mapping or tip, empty when no assistant names a model", () => {
	const { mapping, current_node: currentNode } =
		readFixtureJson<ConversationFixture>("conversation-model-switch.json");
	assert.equal(countBranchModels(null, currentNode), null);
	assert.equal(countBranchModels(mapping, null), null);
	assert.deepEqual(countBranchModels(mapping, "u2"), { "gpt-4o": 1 });
	assert.deepEqual(countBranchModels(mapping, "u1"), {});
});

test("countBranchModels: drops slugs that are not safe model names", () => {
	const reply = (
		id: string,
		parent: string,
		slug: unknown,
	): [string, ChatGptNode] => [
		id,
		{
			parent,
			children: [],
			message: {
				author: { role: "assistant" },
				metadata: { model_slug: slug as string },
			},
		},
	];
	const mapping: Record<string, ChatGptNode> = Object.fromEntries([
		["root", { parent: null, children: ["r1"] }],
		reply("r1", "root", "x".repeat(80)),
		reply("r2", "r1", "x".repeat(81)),
		reply("r3", "r2", ""),
		reply("r4", "r3", "bad\u0000slug"),
		reply("r5", "r4", 4),
		reply("r6", "r5", null),
		reply("r7", "r6", "__proto__"),
		reply("r8", "r7", "__proto__"),
	]);
	const counts = countBranchModels(mapping, "r8");
	assert.deepEqual(Object.entries(counts ?? {}), [
		["x".repeat(80), 1],
		["__proto__", 2],
	]);
	assert.equal(
		validateRecord("conversations", conversationWith(counts)).ok,
		true,
	);
});

test("countBranchModels: counts only replies, not the tool calls and intermediate steps the messages stream reports as such", () => {
	const assistant = (
		id: string,
		parent: string,
		message: Partial<ChatGptMessage>,
	): [string, ChatGptNode] => [
		id,
		{
			parent,
			children: [],
			message: {
				author: { role: "assistant" },
				metadata: { model_slug: "gpt-4o" },
				...message,
			},
		},
	];
	const mapping: Record<string, ChatGptNode> = Object.fromEntries([
		["root", { parent: null, children: ["a1"] }],
		// A reply to the user, with and without an explicit "all" recipient.
		assistant("a1", "root", {}),
		assistant("a2", "a1", { recipient: "all", end_turn: true }),
		// Not replies: a call to a tool, a call listed in metadata, a plugin call,
		// and a step that does not end the turn.
		assistant("t1", "a2", { recipient: "python" }),
		assistant("t2", "t1", {
			metadata: { model_slug: "gpt-4o", tool_calls: [{ name: "search" }] },
		}),
		assistant("t3", "t2", {
			metadata: { model_slug: "gpt-4o", invoked_plugin: { name: "x" } },
		}),
		assistant("t4", "t3", { end_turn: false }),
		assistant("a3", "t4", { metadata: { model_slug: "o3" } }),
	]);

	assert.deepEqual(countBranchModels(mapping, "a3"), { "gpt-4o": 2, o3: 1 });
});

function conversationWith(modelCounts: unknown): Record<string, unknown> {
	return {
		id: "c1",
		title: null,
		create_time: null,
		update_time: null,
		is_archived: null,
		is_starred: null,
		workspace_id: null,
		current_node: null,
		message_count_on_current_branch: null,
		model_counts: modelCounts,
		gizmo_id: null,
	};
}

test("conversations schema: model_counts accepts null and name-to-count objects, refuses unsafe keys and counts", () => {
	for (const ok of [null, {}, { "gpt-4o": 3 }]) {
		assert.equal(
			validateRecord("conversations", conversationWith(ok)).ok,
			true,
		);
	}
	for (const bad of [
		{ ["x".repeat(81)]: 1 },
		{ "": 1 },
		{ "a\u0000b": 1 },
		{ "gpt-4o": 0 },
		{ "gpt-4o": 1.5 },
		{ "gpt-4o": "3" },
		["gpt-4o"],
		"gpt-4o",
	]) {
		assert.equal(
			validateRecord("conversations", conversationWith(bad)).ok,
			false,
			JSON.stringify(bad),
		);
	}
	// A record without the field is not a valid conversation record any more.
	const { model_counts: _omitted, ...without } = conversationWith(null);
	assert.equal(validateRecord("conversations", without).ok, false);
});

test("buildConversationRecord: model_counts follows the detail mapping, like the branch count", () => {
	const { mapping, current_node: currentNode } =
		readFixtureJson<ConversationFixture>("conversation-model-switch.json");
	const list: ConversationListItem = {
		id: "conv1",
		update_time: 1_700_000_000,
	};
	const withDetail = buildConversationRecord(list, {
		current_node: currentNode,
		mapping,
	});
	assert.deepEqual(withDetail.model_counts, { "gpt-4o": 2, o3: 2 });
	assert.equal(validateRecord("conversations", withDetail).ok, true);
	// A detail with a mapping but no tip: nothing is on the branch.
	const noTip = buildConversationRecord(list, { current_node: null, mapping });
	assert.equal(noTip.message_count_on_current_branch, 0);
	assert.deepEqual(noTip.model_counts, {});
	// No detail: unknown, not empty.
	const listOnly = buildConversationRecord(list, null);
	assert.equal(listOnly.message_count_on_current_branch, null);
	assert.equal(listOnly.model_counts, null);
	assert.equal(validateRecord("conversations", listOnly).ok, true);
	// Nothing but model names and counts reaches the record: no message text.
	assert.equal(JSON.stringify(withDetail).includes("question"), false);
	assert.equal(JSON.stringify(withDetail).includes("answer"), false);
});

test("buildConversationRecord: null detail falls back to list fields", () => {
	const rec = buildConversationRecord(
		{ id: "conv1", title: "t", update_time: 1_700_000_000 },
		null,
	);
	assert.equal(rec.title, "t");
	assert.equal(rec.is_archived, null);
	assert.equal(rec.workspace_id, null);
	assert.equal(rec.message_count_on_current_branch, null);
});

test("maxUpdateTimeIso: picks largest ISO across the list", () => {
	const convos: ConversationListItem[] = [
		{ id: "a", update_time: 1_700_000_000 },
		{ id: "b", update_time: 1_710_000_000 },
		{ id: "c" },
	];
	const out = maxUpdateTimeIso(convos);
	assert.equal(out, new Date(1_710_000_000 * 1000).toISOString());
});

test("maxUpdateTimeIso: empty list → null", () => {
	assert.equal(maxUpdateTimeIso([]), null);
});

// ─── pdpp-safe-escape-v1: the contract a reader mirrors ────────────────────

// A reader implements the decoder from the manifest text alone. This one uses
// no connector code: the escaped set is written out from the declaration.
function referenceDecode(encoded: string): string {
	const escaped = (u: number): boolean =>
		u === 0x5c ||
		(u >= 0x00 && u <= 0x08) ||
		u === 0x0b ||
		u === 0x0c ||
		(u >= 0x0e && u <= 0x1f) ||
		(u >= 0x7f && u <= 0x9f) ||
		(u >= 0xd800 && u <= 0xdfff);
	return encoded.replace(/\\u([0-9A-Fa-f]{4})/g, (whole, hex: string) =>
		escaped(Number.parseInt(hex, 16))
			? String.fromCharCode(Number.parseInt(hex, 16))
			: whole,
	);
}

test("manifest declares the pdpp-safe-escape-v1 text encoding and the blob projection", () => {
	const manifest = JSON.parse(
		readFileSync(join(__dirname, "manifest.json"), "utf8"),
	) as {
		streams: Array<{
			name: string;
			schema: { properties: Record<string, Record<string, unknown>> };
		}>;
	};
	const props = manifest.streams.find((s) => s.name === "messages")?.schema
		.properties;
	assert.equal(props?.content?.x_pdpp_text_encoding, "pdpp-safe-escape-v1");
	assert.equal(props?.blob_ref?.x_pdpp_blob_projects_field, "content");
	assert.equal(props?.blob_ref?.x_pdpp_blob_codec, "json-string-v1");
});

test("pdpp-safe-escape-v1: every UTF-16 code unit round-trips, through the connector and an independent reader", () => {
	for (let unit = 0; unit <= 0xffff; unit += 1) {
		const source = `a${String.fromCharCode(unit)}b`;
		const encoded = encodePdppSafeText(source);
		assert.equal(decodeEscapedText(encoded), source, `unit ${unit}`);
		assert.equal(referenceDecode(encoded), source, `unit ${unit}`);
		// A bare backslash is rewritten only when it starts a \uXXXX token.
		if (unit !== 0x5c) {
			assert.equal(
				encoded === source,
				!isEscapedUnit(unit),
				`unit ${unit}: only escaped-set members are rewritten`,
			);
		}
	}
});

test("pdpp-safe-escape-v1: the escaped set covers everything pdppSafeText rejects, and the output is always PDPP-safe", async () => {
	const { pdppSafeText } = await import(
		"@pdpp/connector-protocol/pdpp-safe-text"
	);
	for (let unit = 0; unit <= 0xffff; unit += 1) {
		const ch = String.fromCharCode(unit);
		if (!pdppSafeText.safeParse(ch).success) {
			assert.equal(isEscapedUnit(unit), true, `validator rejects ${unit}`);
		}
		assert.equal(
			pdppSafeText.safeParse(encodePdppSafeText(ch)).success,
			true,
			`encoded unit ${unit}`,
		);
	}
});

test("pdpp-safe-escape-v1: noncharacters on every plane are valid text and pass through unchanged", async () => {
	const { pdppSafeText } = await import(
		"@pdpp/connector-protocol/pdpp-safe-text"
	);
	const nonchars: string[] = [];
	for (let cp = 0xfdd0; cp <= 0xfdef; cp += 1)
		nonchars.push(String.fromCodePoint(cp));
	for (let plane = 0; plane <= 0x10; plane += 1) {
		nonchars.push(String.fromCodePoint(plane * 0x1_0000 + 0xfffe));
		nonchars.push(String.fromCodePoint(plane * 0x1_0000 + 0xffff));
	}
	for (const ch of nonchars) {
		const source = `x${ch}y`;
		assert.equal(
			pdppSafeText.safeParse(source).success,
			true,
			"validator accepts it",
		);
		assert.equal(encodePdppSafeText(source), source, "so it is not escaped");
		const rec = extractMessage("n1", textNode(source), "c1", true);
		assert.equal(rec?.content, source);
		assert.equal(
			validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
			true,
		);
	}
});

test("pdpp-safe-escape-v1: a valid surrogate pair is kept, a lone half is escaped", () => {
	assert.equal(encodePdppSafeText("\u{1F600}"), "\u{1F600}");
	assert.equal(encodePdppSafeText("\ud83d"), "\\uD83D");
	assert.equal(encodePdppSafeText("\ude00"), "\\uDE00");
	assert.equal(encodePdppSafeText("\ude00\ud83d"), "\\uDE00\\uD83D");
	assert.equal(decodeEscapedText("\\uD83D\\uDE00"), "😀");
});

test("escapedLengthExceeds agrees with the escaped length at the cap boundary", () => {
	const cap = 100;
	for (const filler of ["x", "\x00", "\\u0000", "\ud800", "\u{1F600}"]) {
		for (let n = 0; n < 40; n += 1) {
			const raw = filler.repeat(n);
			assert.equal(
				escapedLengthExceeds(raw, cap).exceeds,
				encodePdppSafeText(raw).length > cap,
				`${JSON.stringify(filler)} x ${n}`,
			);
		}
	}
});

test("escapedLengthExceeds stops scanning once the cap is passed", () => {
	const cap = CONTENT_CAP;
	// Escapes dominate: the scan must stop near cap/5 sites, not read all 1M.
	const dense = "\x00".repeat(cap);
	const result = escapedLengthExceeds(dense, cap);
	assert.equal(result.exceeds, true);
	assert.ok(
		result.sitesVisited <= Math.ceil(cap / 5) + 1,
		`visited ${result.sitesVisited} sites`,
	);
	// Longer than the cap before escaping: decided with no scan at all.
	assert.deepEqual(escapedLengthExceeds("y".repeat(cap + 1), cap), {
		exceeds: true,
		sitesVisited: 0,
	});
});

test("messages schema: blob_ref requires null content; content may be absent but not alongside a blob_ref", () => {
	const sha256 = "b".repeat(64);
	const blob_ref = {
		blob_id: `sha256:${sha256}`,
		mime_type: "application/json",
		size_bytes: 9,
		sha256,
	};
	const base = toMessageRecord(
		extractMessage("n1", textNode("hello"), "c1", true) ?? {},
		"c1",
	);
	assert.equal(
		validateRecord("messages", { ...base, content: null, blob_ref }).ok,
		true,
	);
	assert.equal(
		validateRecord("messages", { ...base, content: "text", blob_ref }).ok,
		false,
		"a blob-backed message cannot also carry inline content",
	);
	const { content: _content, ...withoutContent } = base;
	assert.equal(
		validateRecord("messages", withoutContent).ok,
		true,
		"content absent",
	);
	assert.equal(
		validateRecord("messages", { ...withoutContent, blob_ref }).ok,
		false,
		"absent content is the unstorable case, never blob-backed",
	);
	assert.equal(validateRecord("messages", { ...base, content: null }).ok, true);
});

test("extractMessage: a tool-recipient body stays inline in tool_calls when content is inline", () => {
	const node = {
		parent: null,
		children: [],
		message: {
			author: { role: "assistant" },
			recipient: "python",
			content: { content_type: "code", language: "python", text: "print(1)" },
		},
	} as ChatGptNode;
	const rec = extractMessage("n1", node, "c1", true);
	assert.deepEqual(rec?.tool_calls, [
		{
			recipient: "python",
			content_type: "code",
			language: "python",
			text: "print(1)",
		},
	]);
	assert.equal(
		validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
		true,
	);
});

test("extractMessage: an oversize tool-recipient body is referenced, not duplicated into tool_calls", () => {
	const text = "p".repeat(CONTENT_CAP + 1);
	const node = {
		parent: null,
		children: [],
		message: {
			author: { role: "assistant" },
			recipient: "python",
			content: { content_type: "code", language: "python", text },
		},
	} as ChatGptNode;
	const { record, oversize } = extractMessageWithBlob("n1", node, "c1", true);
	assert.equal(oversize, true);
	assert.deepEqual(record?.tool_calls, [
		{
			recipient: "python",
			content_type: "code",
			language: "python",
			text_ref: "content",
		},
	]);
});

test('synthesized tool call: text_ref must be "content" and exclude text', () => {
	assertSynthesizedCall({ recipient: "python", text_ref: "content" });
	assertSynthesizedCall({ recipient: "python", text: "inline" });
	assert.throws(() =>
		assertSynthesizedCall({ text_ref: "content", text: "dup" }),
	);
	assert.throws(() =>
		assertSynthesizedCall({ text_ref: "elsewhere" as "content" }),
	);
});

test("messages schema: an arbitrary source tool call with text_ref and text is kept, encoded, and not rejected", () => {
	const node = {
		parent: null,
		children: [],
		message: {
			author: { role: "assistant" },
			content: { content_type: "text", parts: ["hi"] },
			metadata: {
				tool_calls: [{ text_ref: "source-id", text: "bo\x00dy" }],
			},
		},
	} as ChatGptNode;
	const rec = extractMessage("n1", node, "c1", true);
	assert.deepEqual(rec?.tool_calls, [
		{ text_ref: "source-id", text: "bo\\u0000dy" },
	]);
	assert.equal(
		validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
		true,
	);
});

function decodeToolCallStrings(value: unknown): unknown {
	if (typeof value === "string") return referenceDecode(value);
	if (Array.isArray(value)) return value.map(decodeToolCallStrings);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				referenceDecode(k),
				decodeToolCallStrings(v),
			]),
		);
	}
	return value;
}

test("tool_calls: every nested string and key from a source call is encoded and round-trips through the declared decoder", async () => {
	const source = [
		{
			name: "fn\x00",
			"k\ud800ey": "v",
			arguments: {
				code: "a\x00b \ud800 \\u0000 literal",
				list: ["\x01", { deep: "x\x7fy", n: 3, ok: true, none: null }],
			},
		},
		"bare\x00string",
	];
	const node = {
		parent: null,
		children: [],
		message: {
			author: { role: "assistant" },
			content: { content_type: "text", parts: ["hi"] },
			metadata: { tool_calls: source },
		},
	} as ChatGptNode;
	const rec = extractMessage("n1", node, "c1", true);
	const { pdppSafeText } = await import(
		"@pdpp/connector-protocol/pdpp-safe-text"
	);
	const strings: string[] = [];
	const collect = (v: unknown): void => {
		if (typeof v === "string") strings.push(v);
		else if (Array.isArray(v)) v.forEach(collect);
		else if (typeof v === "object" && v !== null) {
			for (const [k, inner] of Object.entries(v)) {
				strings.push(k);
				collect(inner);
			}
		}
	};
	collect(rec?.tool_calls);
	assert.ok(strings.length >= 8);
	for (const str of strings) {
		assert.equal(
			pdppSafeText.safeParse(str).success,
			true,
			JSON.stringify(str),
		);
		assert.equal(/[\ud800-\udfff]/u.test(str), false, "no lone surrogate");
	}
	assert.deepEqual(decodeToolCallStrings(rec?.tool_calls), source);
	assert.equal(
		validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
		true,
	);
});

test("extractMessage: an inline tool-recipient body with controls is escaped in tool_calls and round-trips", () => {
	const text = "print('a\x00b')\x01 \\u0000 literal \ud800 lone";
	const node = {
		parent: null,
		children: [],
		message: {
			author: { role: "assistant" },
			recipient: "python",
			content: { content_type: "code", language: "python", text },
		},
	} as ChatGptNode;
	const rec = extractMessage("n1", node, "c1", true);
	const call = (rec?.tool_calls as Array<{ text?: string }> | undefined)?.[0];
	assert.ok(call?.text);
	assert.equal(call.text.includes("\x00"), false);
	assert.equal(call.text, encodePdppSafeText(text));
	assert.equal(decodeEscapedText(call.text), text);
	assert.equal(
		validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
		true,
	);
	const manifest = JSON.parse(
		readFileSync(join(__dirname, "manifest.json"), "utf8"),
	) as {
		streams: Array<{
			name: string;
			schema: { properties: Record<string, Record<string, unknown>> };
		}>;
	};
	assert.equal(
		manifest.streams.find((s) => s.name === "messages")?.schema.properties
			.tool_calls?.x_pdpp_text_encoding,
		"pdpp-safe-escape-v1",
	);
});

test('encodeToolCallStrings: an own "__proto__" key from JSON.parse is kept as data, at the root and nested', () => {
	const sourceJson =
		'[{"__proto__":{"text":"x\\u0000y"},"k":"v"},{"a":{"__proto__":1,"b":"q\\u0001"}},{"__proto__":"s\\u007f"}]';
	const source = JSON.parse(sourceJson) as unknown[];
	assert.ok(
		Object.hasOwn(source[0] as object, "__proto__"),
		"fixture is JSON-parsed",
	);
	const encoded = encodeToolCallStrings(source) as Array<
		Record<string, unknown>
	>;
	assert.equal(
		JSON.stringify(encoded),
		'[{"__proto__":{"text":"x\\\\u0000y"},"k":"v"},{"a":{"__proto__":1,"b":"q\\\\u0001"}},{"__proto__":"s\\\\u007F"}]',
	);
	assert.ok(Object.hasOwn(encoded[0] as object, "__proto__"));
	assert.equal(
		Object.getPrototypeOf(encoded[0]),
		Object.prototype,
		"prototype is untouched",
	);
	assert.equal(
		JSON.stringify(decodeToolCallStrings(encoded)),
		JSON.stringify(source),
		"the independent decoder restores the source",
	);
	// And through the record path.
	const node = {
		parent: null,
		children: [],
		message: {
			author: { role: "assistant" },
			content: { content_type: "text", parts: ["hi"] },
			metadata: { tool_calls: source },
		},
	} as ChatGptNode;
	const rec = extractMessage("n1", node, "c1", true);
	assert.equal(JSON.stringify(rec?.tool_calls), JSON.stringify(encoded));
	assert.equal(
		validateRecord("messages", toMessageRecord(rec ?? {}, "c1")).ok,
		true,
	);
});

test("encodeToolCallStrings: nesting far deeper than the call stack is encoded without loss", () => {
	const depth = 20_000;
	let source: unknown = "a\x00b";
	for (let i = 0; i < depth; i += 1) {
		source = i % 2 === 0 ? [source] : { n: source, "k\x00": 1 };
	}
	const encoded = encodeToolCallStrings([source]);
	// Walk both trees down iteratively and check shape and the leaf.
	let from: unknown = [source];
	let to: unknown = encoded;
	let levels = 0;
	while (typeof from === "object" && from !== null) {
		assert.equal(Array.isArray(to), Array.isArray(from));
		if (Array.isArray(from)) {
			from = from[0];
			to = (to as unknown[])[0];
		} else {
			assert.deepEqual(Object.keys(to as object), ["n", "k\\u0000"]);
			from = (from as { n: unknown }).n;
			to = (to as { n: unknown }).n;
		}
		levels += 1;
	}
	assert.equal(levels, depth + 1);
	assert.equal(to, "a\\u0000b");
	assert.equal(referenceDecode(to as string), "a\x00b");
});

test("encodeToolCallStrings: array holes stay holes and an explicit undefined stays an own element", () => {
	const holes = (
		length: number,
		present: Record<number, unknown>,
	): unknown[] => {
		const a = new Array<unknown>(length);
		for (const [i, v] of Object.entries(present)) a[Number(i)] = v;
		return a;
	};
	const cases: Array<{ name: string; source: unknown[]; own: number[] }> = [
		{ name: "leading", source: holes(3, { 1: "a\x00", 2: "b" }), own: [1, 2] },
		{ name: "interior", source: holes(4, { 0: "a", 3: "b" }), own: [0, 3] },
		{ name: "trailing", source: holes(3, { 0: "a" }), own: [0] },
		{ name: "all holes", source: new Array<unknown>(5), own: [] },
		{
			name: "undefined beside a hole",
			source: holes(3, { 0: undefined, 2: "c" }),
			own: [0, 2],
		},
		{
			name: "nested",
			source: [holes(2, { 1: "x\x01" })],
			own: [0],
		},
	];
	for (const { name, source, own } of cases) {
		const encoded = encodeToolCallStrings(source) as unknown[];
		assert.equal(encoded.length, source.length, name);
		for (let i = 0; i < source.length; i += 1) {
			assert.equal(Object.hasOwn(encoded, i), own.includes(i), `${name}[${i}]`);
			assert.equal(
				Object.hasOwn(source, i),
				own.includes(i),
				`${name} fixture`,
			);
		}
	}
	const nested = (
		encodeToolCallStrings([holes(2, { 1: "x\x01" })]) as unknown[][]
	)[0];
	assert.equal(nested?.length, 2);
	assert.equal(Object.hasOwn(nested ?? [], 0), false);
	assert.equal(nested?.[1], "x\\u0001");
	const encodedUndefined = encodeToolCallStrings(
		holes(3, { 0: undefined, 2: "c" }),
	) as unknown[];
	assert.equal(Object.hasOwn(encodedUndefined, 0), true);
	assert.equal(encodedUndefined[0], undefined);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure iCloud Notes parsers. All fixture byte blobs in
 * this file are synthetically constructed (labelled below), not derived
 * from a real capture; live-account evidence stays outside source fixtures.
 */

import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { test } from "node:test";
import {
	deflateRawSync,
	deflateSync,
	gunzipSync,
	gzipSync,
	inflateRawSync,
	inflateSync,
} from "node:zlib";
import {
	buildFolderRecord,
	buildNoteRecord,
	decodeBase64Text,
	decodeNoteBody,
	decodeNoteBodyBytes,
	decompressBytes,
	epochMsToIso,
	readCloudKitRecordType,
	readDeletedNote,
	readFolderRecord,
	readNoteRecord,
} from "./parsers.ts";
import type { CloudKitRecord } from "./types.ts";

test("readCloudKitRecordType: only known discriminators route and unknown shapes stay unavailable", async () => {
	assert.deepEqual(readCloudKitRecordType({ recordType: "Note" }), {
		kind: "READ",
		value: "Note",
	});
	assert.deepEqual(readCloudKitRecordType({ recordType: "Folder" }), {
		kind: "READ",
		value: "Folder",
	});
	assert.deepEqual(readCloudKitRecordType({ recordType: "UnexpectedType" }), {
		kind: "UNAVAILABLE",
		reason: "unrecognized_record_type",
		source_shape: { type: "string", length: 14 },
	});
	assert.deepEqual(readCloudKitRecordType({ recordType: "" }), {
		kind: "UNAVAILABLE",
		reason: "malformed_record_type",
		source_shape: { type: "string", length: 0 },
	});
	assert.deepEqual(readCloudKitRecordType({ recordType: 17 }), {
		kind: "UNAVAILABLE",
		reason: "malformed_record_type",
		source_shape: { type: "number" },
	});
	assert.deepEqual(readCloudKitRecordType({}), {
		kind: "UNAVAILABLE",
		reason: "missing_record_type",
		source_shape: { type: "missing" },
	});
});

// ─── decodeBase64Text ────────────────────────────────────────────────────

test("decodeBase64Text: decodes a base64 UTF-8 string", async () => {
	const encoded = Buffer.from("Grocery list", "utf-8").toString("base64");
	assert.equal(decodeBase64Text(encoded), "Grocery list");
});

test("decodeBase64Text: null for absent or non-string input and preserves an empty source value", async () => {
	assert.equal(decodeBase64Text(undefined), null);
	assert.equal(decodeBase64Text(null), null);
	assert.equal(decodeBase64Text(""), "");
	assert.equal(decodeBase64Text("!!!"), null);
	assert.equal(decodeBase64Text(42), null);
});

test("decodeBase64Text: invalid UTF-8 is not text, and an encoded U+FFFD is", async () => {
	// "/w==" is valid base64 for the one byte 0xFF, which is not UTF-8.
	assert.equal(decodeBase64Text("/w=="), null);
	assert.equal(
		decodeBase64Text(Buffer.from([0x41, 0xc3, 0x28]).toString("base64")),
		null,
	);
	// A replacement character the source really encoded is source text.
	assert.equal(
		decodeBase64Text(Buffer.from("a\uFFFDb", "utf-8").toString("base64")),
		"a\uFFFDb",
	);
});

test("readNoteRecord and readFolderRecord: invalid UTF-8 in a title, snippet or folder name withholds that field", async () => {
	const INVALID_UTF8 = "/w==";
	const note = await readNoteRecord({
		recordName: "note-invalid-text",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: INVALID_UTF8 },
			SnippetEncrypted: { value: INVALID_UTF8 },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: "" },
		},
	});
	assert.equal(note.record?.title, null);
	assert.equal(note.record?.snippet, null);
	assert.deepEqual(
		note.unavailableFields
			.filter(({ field }) => field === "title" || field === "snippet")
			.map(({ field, reason }) => `${field}:${reason}`)
			.sort(),
		["snippet:invalid_utf8_text", "title:invalid_utf8_text"],
	);
	const folder = readFolderRecord({
		recordName: "folder-invalid-title",
		recordType: "Folder",
		fields: { TitleEncrypted: { value: INVALID_UTF8 } },
	});
	assert.deepEqual(
		folder.unavailableFields.map(({ field, reason }) => ({ field, reason })),
		[{ field: "name", reason: "invalid_utf8_text" }],
	);
});

// ─── epochMsToIso ────────────────────────────────────────────────────────

test("epochMsToIso: converts a positive epoch-ms number to ISO-8601", async () => {
	assert.equal(epochMsToIso(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
});

test("epochMsToIso: accepts zero and rejects negative, non-finite, or non-number input", async () => {
	assert.equal(epochMsToIso(0), "1970-01-01T00:00:00.000Z");
	assert.equal(epochMsToIso(-5), null);
	assert.equal(epochMsToIso(Number.NaN), null);
	assert.equal(epochMsToIso(Number.MAX_VALUE), null);
	assert.equal(epochMsToIso("2023-01-01"), null);
	assert.equal(epochMsToIso(undefined), null);
});

// ─── decodeNoteBodyBytes / decodeNoteBody (protobuf decode) ────────────

test("decodeNoteBodyBytes: reads UTF-8 strings from length-delimited protobuf fields", async () => {
	const text = "Grocery list: milk, eggs, bread.";
	const decompressed = encodeBodyText(text);
	assert.deepEqual(decodeNoteBodyBytes(decompressed), decoded(text));
});

test("decodeNoteBodyBytes: preserves text that resembles a nested protobuf", async () => {
	const body = Buffer.from([
		0x0a, 0x0c, 0x52, 0x0a, 0x43, 0x61, 0x6c, 0x6c,
		0x20, 0x41, 0x6c, 0x69, 0x63, 0x65,
	]);
	assert.deepEqual(decodeNoteBodyBytes(body), decoded("R\nCall Alice"));
});

test("decodeNoteBodyBytes: recurses into the known structural field", async () => {
	const body = encodeStructuredBodyText("Nested note");
	assert.deepEqual(decodeNoteBodyBytes(body), decoded("Nested note"));
});

test("readNoteRecord: preserves text that resembles a nested protobuf", async () => {
	const body = Buffer.from([
		0x0a, 0x0c, 0x52, 0x0a, 0x43, 0x61, 0x6c, 0x6c,
		0x20, 0x41, 0x6c, 0x69, 0x63, 0x65,
	]);
	const result = await readNoteRecord({
		recordName: "note-ambiguous-text",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: gzipSync(body).toString("base64") },
		},
	});
	assert.equal(result.record?.text_content, "R\nCall Alice");
});

test("decodeNoteBodyBytes: short and Unicode body text is preserved", async () => {
	await Promise.all(
		["a", "hi", "yes", "猫", "你好世界", "📝", "مرحبا мир 🌍", "café 世界"].map(
			async (text) =>
				assert.deepEqual(decodeNoteBodyBytes(encodeBodyText(text)), decoded(text)),
		),
	);
});

test("decodeNoteBodyBytes: mixed-script and emoji text is exact", async () => {
	const text = "English words are long enough 📝 世界";
	assert.deepEqual(decodeNoteBodyBytes(encodeStructuredBodyText(text)), {
		kind: "DECODED",
		text,
	});
});

test("decodeNoteBody: decodes a synthetic gzip-compressed note body (labelled synthetic)", async () => {
	const text =
		"Meeting notes: discuss Q3 roadmap and follow up with the design team.";
	const compressed = gzipSync(encodeBodyText(text));
	const base64 = compressed.toString("base64");
	assert.deepEqual(await decodeNoteBody(base64), decoded(text));
});

function decoded(text: string) {
	return { kind: "DECODED", text } as const;
}

function encodeBodyText(text: string): Buffer {
	const value = Buffer.from(text, "utf-8");
	return encodeLengthDelimitedField(1, value);
}

function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	let rest = value;
	while (rest >= 0x80) {
		bytes.push((rest & 0x7f) | 0x80);
		rest = Math.floor(rest / 0x80);
	}
	bytes.push(rest);
	return Buffer.from(bytes);
}

function encodeLengthDelimitedField(fieldNumber: number, value: Buffer): Buffer {
	return Buffer.concat([
		encodeVarint((fieldNumber << 3) | 2),
		encodeVarint(value.length),
		value,
	]);
}

function encodeStructuredBodyText(text: string | readonly string[]): Buffer {
	const runs = typeof text === "string" ? [text] : text;
	const richText = Buffer.concat(
		runs.map((run) => encodeLengthDelimitedField(2, Buffer.from(run, "utf-8"))),
	);
	const document = encodeLengthDelimitedField(3, richText);
	return encodeLengthDelimitedField(2, document);
}

test("decodeNoteBody: preserves short and Unicode text from the protobuf body structure", async () => {
	await Promise.all(
		["a", "hi", "yes", "猫", "你好世界", "📝", "مرحبا мир 🌍", "café 世界"].map(
			async (text) => {
				const compressed = gzipSync(encodeBodyText(text));
				assert.deepEqual(
					await decodeNoteBody(compressed.toString("base64")),
					decoded(text),
				);
			},
		),
	);
});

test("readNoteRecord: nonempty undecodable protobuf body is unavailable", async () => {
	const compressed = gzipSync(Buffer.from([0x00, 0xff, 0xfe, 0x80]));
	const result = await readNoteRecord({
		recordName: "note-undecodable-body",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: compressed.toString("base64") },
		},
	});
	assert.equal(result.record?.text_content, null);
	assert.ok(
		result.unavailableFields.some(
			({ field, reason }) =>
				field === "text_content" && reason === "body_protobuf_malformed",
		),
	);
});

test("readNoteRecord: unreadable UTF-8 in a valid body withholds the field", async () => {
	await Promise.all(
		[
			Buffer.from([0x0a, 0x01, 0xff]),
			Buffer.from([0x0a, 0x02, 0x48, 0x69, 0x0a, 0x01, 0xff]),
		].map(async (body) => {
			const compressed = gzipSync(body);
			const result = await readNoteRecord({
				recordName: "note-invalid-text-field",
				recordType: "Note",
				fields: {
					TitleEncrypted: { value: null },
					SnippetEncrypted: { value: null },
					Folder: { value: null },
					IsPinned: { value: null },
					CreationDate: { value: null },
					ModificationDate: { value: null },
					Attachments: { value: [] },
					TextDataEncrypted: { value: compressed.toString("base64") },
				},
			});
			assert.equal(result.record?.text_content, null);
			assert.ok(
				result.unavailableFields.some(
					({ field, reason }) =>
						field === "text_content" && reason === "body_text_invalid_utf8",
				),
			);
		}),
	);
});

test("decodeNoteBody: decodes a synthetic zlib-deflate-compressed note body", async () => {
	const text = "Second synthetic fixture using zlib deflate, not gzip.";
	const compressed = deflateSync(encodeBodyText(text));
	const base64 = compressed.toString("base64");
	assert.deepEqual(await decodeNoteBody(base64), decoded(text));
});

test("decodeNoteBody: decodes a synthetic raw-deflate-compressed note body", async () => {
	const text = "Third synthetic fixture using raw deflate.";
	const compressed = deflateRawSync(encodeBodyText(text));
	const base64 = compressed.toString("base64");
	assert.deepEqual(await decodeNoteBody(base64), decoded(text));
});

test("decodeNoteBody: an empty string is not a compressed body", async () => {
	assert.deepEqual(await decodeNoteBody(""), {
		kind: "UNDECODABLE",
		cause: "body_not_compressed",
	});
});

test("decodeNoteBody: base64 that decompresses under no tried format is undecodable", async () => {
	const garbage = Buffer.from("not compressed data at all", "utf-8").toString(
		"base64",
	);
	assert.deepEqual(await decodeNoteBody(garbage), {
		kind: "UNDECODABLE",
		cause: "body_not_compressed",
	});
});

test("decodeNoteBody: input that is not base64 at all is undecodable", async () => {
	assert.deepEqual(await decodeNoteBody("!!!not-base64!!!"), {
		kind: "UNDECODABLE",
		cause: "body_base64_invalid",
	});
});

test("decodeNoteBodyBytes: empty and attachment-only bodies are absent, not text", async () => {
	assert.deepEqual(decodeNoteBodyBytes(new Uint8Array()), { kind: "ABSENT" });
	const attachmentOnly = structuredBody(
		encodeLengthDelimitedField(3, encodeLengthDelimitedField(3, Buffer.alloc(0))),
	);
	assert.deepEqual(decodeNoteBodyBytes(attachmentOnly), { kind: "ABSENT" });
});

// ─── isDeletedNote ───────────────────────────────────────────────────────

test("readDeletedNote: sparse absence is false, malformed present values stay unavailable", async () => {
	assert.deepEqual(
		readDeletedNote({ fields: { Deleted: { value: 1 } } } as CloudKitRecord),
		{ kind: "READ", value: true },
	);
	assert.deepEqual(
		readDeletedNote({ fields: { Deleted: { value: 0 } } } as CloudKitRecord),
		{ kind: "READ", value: false },
	);
	assert.deepEqual(readDeletedNote({ fields: {} } as CloudKitRecord), {
		kind: "EXPLICIT_EMPTY",
		value: false,
	});
	assert.deepEqual(readDeletedNote({} as CloudKitRecord), {
		kind: "EXPLICIT_EMPTY",
		value: false,
	});
	assert.deepEqual(
		readDeletedNote({ fields: { Deleted: {} } } as CloudKitRecord),
		{
			kind: "UNAVAILABLE",
			reason: "malformed_field_wrapper",
			source_shape: { type: "object", keys: [] },
		},
	);
	assert.deepEqual(
		readDeletedNote({
			fields: { Deleted: { value: "bad" } },
		} as CloudKitRecord),
		{
			kind: "UNAVAILABLE",
			reason: "expected_deleted_flag",
			source_shape: { type: "string", length: 3 },
		},
	);
	assert.deepEqual(
		readDeletedNote({ fields: { Deleted: { value: null } } } as CloudKitRecord),
		{
			kind: "UNAVAILABLE",
			reason: "expected_deleted_flag",
			source_shape: { type: "null" },
		},
	);
});

// ─── buildNoteRecord ─────────────────────────────────────────────────────

function b64(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64");
}

test("buildNoteRecord: maps a well-formed CloudKit Note record to the notes schema shape", async () => {
	const bodyText = "A synthetic note body used only for this unit test.";
	const compressedBody = gzipSync(encodeBodyText(bodyText)).toString("base64");
	const record: CloudKitRecord = {
		recordName: "note-abc-123",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: b64("Grocery list") },
			SnippetEncrypted: { value: b64("milk, eggs, bread") },
			Folder: { value: { recordName: "folder-xyz-789" } },
			IsPinned: { value: 1 },
			CreationDate: { value: 1_700_000_000_000 },
			ModificationDate: { value: 1_700_100_000_000 },
			Attachments: { value: [{ recordName: "att-1" }] },
			TextDataEncrypted: { value: compressedBody },
		},
	};

	const built = await buildNoteRecord(
		record,
		new Map([["folder-xyz-789", "Work"]]),
	);
	assert.ok(built);
	assert.deepEqual(built, {
		id: "note-abc-123",
		title: "Grocery list",
		snippet: "milk, eggs, bread",
		folder_id: "folder-xyz-789",
		folder_name: "Work",
		is_pinned: true,
		created_at: "2023-11-14T22:13:20.000Z",
		modified_at: "2023-11-16T02:00:00.000Z",
		has_attachments: true,
		text_content: bodyText,
	});
});

test("buildNoteRecord: explicit empty CloudKit values map to empty output values", async () => {
	const record: CloudKitRecord = {
		recordName: "note-minimal",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: "" },
		},
	};
	const built = await buildNoteRecord(record);
	assert.ok(built);
	assert.equal(built.title, null);
	assert.equal(built.snippet, null);
	assert.equal(built.folder_id, null);
	assert.equal(built.folder_name, null);
	assert.equal(built.is_pinned, false);
	assert.equal(built.has_attachments, false);
	assert.equal(built.text_content, null);
});

test("readNoteRecord: absent mapped fields remain unavailable", async () => {
	const result = await readNoteRecord({
		recordName: "note-missing-fields",
		recordType: "Note",
		fields: {},
	});
	assert.equal(result.record?.title, null);
	assert.ok(
		result.unavailableFields.some(
			({ field, reason }) => field === "title" && reason === "missing_field",
		),
	);
	assert.ok(
		result.unavailableFields.some(
			({ field, reason }) =>
				field === "text_content" && reason === "missing_field",
		),
	);
});

test("readNoteRecord: CloudKit sparse optional fields use legacy empty defaults", async () => {
	const result = await readNoteRecord({
		recordName: "note-sparse-defaults",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: b64("Sparse note") },
			TextDataEncrypted: { value: "" },
		},
	});
	assert.deepEqual(result.unavailableFields, []);
	assert.equal(result.record?.title, "Sparse note");
	assert.equal(result.record?.snippet, null);
	assert.equal(result.record?.folder_id, null);
	assert.equal(result.record?.folder_name, null);
	assert.equal(result.record?.is_pinned, false);
	assert.equal(result.record?.created_at, null);
	assert.equal(result.record?.modified_at, null);
	assert.equal(result.record?.has_attachments, false);
	assert.equal(result.record?.text_content, null);
});

test("readNoteRecord: an unresolved folder reference leaves folder_name unavailable", async () => {
	const result = await readNoteRecord(
		{
			recordName: "note-unresolved-folder",
			recordType: "Note",
			fields: {
				TitleEncrypted: { value: null },
				SnippetEncrypted: { value: null },
				Folder: { value: { recordName: "folder-not-in-snapshot" } },
				IsPinned: { value: null },
				CreationDate: { value: null },
				ModificationDate: { value: null },
				Attachments: { value: [] },
				TextDataEncrypted: { value: "" },
			},
		},
		new Map(),
		{ folderScanComplete: true },
	);
	assert.equal(result.record?.folder_name, null);
	assert.ok(
		result.unavailableFields.some(
			({ field, reason }) =>
				field === "folder_name" && reason === "folder_name_unresolved",
		),
	);
});

test("readNoteRecord: a valid base64 body that cannot be decoded is unavailable", async () => {
	const result = await readNoteRecord({
		recordName: "note-undecodable-body",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: b64("synthetic undecodable body") },
		},
	});
	assert.equal(result.record?.text_content, null);
	assert.ok(
		result.unavailableFields.some(
			({ field, reason }) =>
				field === "text_content" && reason === "body_not_compressed",
		),
	);
});

test("readNoteRecord: compressed attachment-only body is explicitly empty text", async () => {
	const attachmentMetadata = encodeLengthDelimitedField(3, Buffer.alloc(0));
	const richText = encodeLengthDelimitedField(3, attachmentMetadata);
	const document = encodeLengthDelimitedField(3, richText);
	const attachmentOnlyBody = gzipSync(encodeLengthDelimitedField(2, document));
	const result = await readNoteRecord({
		recordName: "note-attachment-only",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: b64("Image") },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [{ recordName: "attachment-1" }] },
			TextDataEncrypted: { value: attachmentOnlyBody.toString("base64") },
		},
	});
	assert.equal(result.record?.has_attachments, true);
	assert.equal(result.record?.text_content, null);
	assert.ok(
		!result.unavailableFields.some(({ field }) => field === "text_content"),
		"valid compressed data with no prose is an explicit empty text field",
	);
});

test("buildNoteRecord: falls back to Folders[0] when Folder is absent", async () => {
	const record: CloudKitRecord = {
		recordName: "note-folders-array",
		recordType: "Note",
		fields: {
			Folders: { value: [{ recordName: "folder-from-array" }] },
		},
	};
	const built = await buildNoteRecord(record);
	assert.equal(built?.folder_id, "folder-from-array");
});

test("buildNoteRecord: falls back to created/modified.timestamp when field-level dates are absent", async () => {
	const record: CloudKitRecord = {
		recordName: "note-timestamp-fallback",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: "" },
		},
		created: { timestamp: 1_700_000_000_000 },
		modified: { timestamp: 1_700_100_000_000 },
	};
	const built = await buildNoteRecord(record);
	assert.equal(built?.created_at, "2023-11-14T22:13:20.000Z");
	assert.equal(built?.modified_at, "2023-11-16T02:00:00.000Z");
});

test("buildNoteRecord: null when recordName is absent (unusable record)", async () => {
	assert.equal(await buildNoteRecord({ fields: {} } as CloudKitRecord), null);
});

// ─── buildFolderRecord ───────────────────────────────────────────────────

test("buildFolderRecord: maps a well-formed CloudKit Folder record", async () => {
	const record: CloudKitRecord = {
		recordName: "folder-abc",
		recordType: "Folder",
		fields: { TitleEncrypted: { value: b64("Work") } },
	};
	assert.deepEqual(buildFolderRecord(record), {
		id: "folder-abc",
		name: "Work",
	});
});

test("buildFolderRecord: null when recordName is absent", async () => {
	assert.equal(
		buildFolderRecord({
			fields: { TitleEncrypted: { value: b64("Work") } },
		} as CloudKitRecord),
		null,
	);
});

test("readFolderRecord: absent and explicit empty titles fall back to recordName", async () => {
	const absent = readFolderRecord({
		recordName: "folder-no-title",
		recordType: "Folder",
		fields: {},
	});
	assert.deepEqual(absent, {
		record: { id: "folder-no-title", name: "folder-no-title" },
		unavailableFields: [],
	});
	assert.deepEqual(
		buildFolderRecord({ recordName: "folder-no-title", fields: {} }),
		{ id: "folder-no-title", name: "folder-no-title" },
	);
	assert.deepEqual(
		buildFolderRecord({
			recordName: "folder-empty-title",
			fields: { TitleEncrypted: { value: b64("") } },
		}),
		{ id: "folder-empty-title", name: "folder-empty-title" },
	);
});

test("browser decoder byte parity with Node across gzip, deflate and raw-deflate", async () => {
	const vectors = [
		Buffer.from("Synthetic note: café, emoji 📝 and ASCII text."),
		Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0x42, 0x43, 0x44, 0xff, 0xc3, 0x28]),
		Buffer.from([0, 1, 2, 3]),
		Buffer.alloc(0),
	];
	for (const [format, compress, decompress] of [
		["gzip", gzipSync, gunzipSync],
		["deflate", deflateSync, inflateSync],
		["deflate-raw", deflateRawSync, inflateRawSync],
	] as const) {
		for (const vector of vectors) {
			const compressed = compress(vector);
			const decoded = await decompressBytes(compressed, format);
			assert.deepEqual(decoded, new Uint8Array(decompress(compressed)));
			// Strict: invalid UTF-8 is not text, never replacement characters.
			assert.equal(
				decodeBase64Text(vector.toString("base64")),
				isUtf8(vector) ? vector.toString("utf-8") : null,
			);
			assert.deepEqual(
				await decodeNoteBody(compressed.toString("base64")),
				decodeNoteBodyBytes(vector),
			);
		}
		assert.equal(
			await decompressBytes(new Uint8Array([1, 2, 3]), format),
			null,
		);
	}
});

// ─── one body decoder: decoded / absent / undecodable ───────────────────

/** Run decompressed protobuf bytes through the real note-record path. */
async function readBody(decompressed: Uint8Array) {
	return readNoteRecord({
		recordName: "note-body-under-test",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: {
				value: gzipSync(decompressed).toString("base64"),
			},
		},
	});
}

/** note_body field 2 -> note_document field 3 -> rich_text made of `fields`. */
function structuredBody(...richTextFields: Buffer[]): Buffer {
	return encodeLengthDelimitedField(
		2,
		encodeLengthDelimitedField(3, Buffer.concat(richTextFields)),
	);
}

function textRun(text: string): Buffer {
	return encodeLengthDelimitedField(2, Buffer.from(text, "utf-8"));
}

test("structured body: a short run after a long run is kept", async () => {
	const result = await readBody(
		encodeStructuredBodyText(["First paragraph", "hi"]),
	);
	assert.equal(result.record?.text_content, "First paragraph\nhi");
	assert.deepEqual(result.unavailableFields, []);
});

test("structured body: attachment and style metadata never become body text", async () => {
	const result = await readBody(
		structuredBody(
			textRun("hi"),
			encodeLengthDelimitedField(3, Buffer.from("SECRET")),
		),
	);
	assert.equal(result.record?.text_content, "hi");
});

test("structured body: printable length-prefix bytes do not leak into the text", async () => {
	// Lengths 0x28 '(' and 0x3a ':' are printable ASCII, so a raw byte scan
	// would glue them to the front of the text.
	await Promise.all(
		[0x28, 0x3a, 0x41].map(async (length) => {
			const text = "a".repeat(length);
			assert.equal(Buffer.byteLength(text), length);
			const result = await readBody(encodeStructuredBodyText(text));
			assert.equal(result.record?.text_content, text, `length ${length}`);
		}),
	);
});

test("structured body: rich-text paragraphs, marker and trailing line feed", async () => {
	await Promise.all(
		(
			[
				[
					["First paragraph", "Second paragraph"],
					"First paragraph\nSecond paragraph",
				],
				["￼Photo description", "￼Photo description"],
				["Final line\n", "Final line"],
				[["ok", "猫", "📝"], "ok\n猫\n📝"],
			] as const
		).map(async ([text, expected]) => {
			const result = await readBody(encodeStructuredBodyText(text));
			assert.equal(result.record?.text_content, expected);
		}),
	);
});

test("structured body: texts longer than one length byte are exact", async () => {
	await Promise.all(
		[127, 128, 300, 20_000].map(async (length) => {
			const text = "é".repeat(length >> 1) + (length % 2 ? "a" : "");
			assert.equal(Buffer.byteLength(text), length);
			const result = await readBody(encodeStructuredBodyText(text));
			assert.equal(result.record?.text_content, text, `${length} bytes`);
		}),
	);
});

test("structured body: control characters are paragraph breaks, not decode failures", async () => {
	await Promise.all(
		[
			["line1\u000Bline2", "line1\nline2"],
			["line1\u000Cline2", "line1\nline2"],
			["line1\u001Bline2", "line1\nline2"],
			["line1\u007Fline2", "line1\nline2"],
			["line1\u0085line2", "line1\nline2"],
			["tab\tseparated", "tab\nseparated"],
			["blank\n\n\nlines", "blank\nlines"],
		].map(async ([text, expected]) => {
			const result = await readBody(encodeStructuredBodyText(text as string));
			assert.equal(result.record?.text_content, expected, JSON.stringify(text));
			assert.deepEqual(result.unavailableFields, []);
		}),
	);
});

test("structured body: attachment placeholders carry no text but inline markers stay", async () => {
	assert.deepEqual(
		decodeNoteBodyBytes(encodeStructuredBodyText("￼")),
		{ kind: "ABSENT" },
	);
	assert.deepEqual(
		decodeNoteBodyBytes(encodeStructuredBodyText("Before\n￼\nAfter")),
		decoded("Before\nAfter"),
	);
	assert.deepEqual(
		decodeNoteBodyBytes(encodeStructuredBodyText("￼Photo description")),
		decoded("￼Photo description"),
	);
});

test("structured body: a note shaped like a real Apple Notes document decodes", async () => {
	// Document { 2: version varint, 3: Note { 2: text with line feeds,
	// 3: substring metadata, 5: attribute runs, 6: ten-byte int64 varint } }
	const note = Buffer.concat([
		textRun("Title\n\nPara one\nhi"),
		encodeLengthDelimitedField(3, Buffer.from([0x08, 0x01])),
		encodeLengthDelimitedField(5, Buffer.from([0x08, 0x05, 0x10, 0x01])),
		Buffer.from([0x30, ...Array(9).fill(0xff), 0x01]),
	]);
	const document = Buffer.concat([
		Buffer.from([0x10, 0x03]),
		encodeLengthDelimitedField(3, note),
	]);
	const result = await readBody(encodeLengthDelimitedField(2, document));
	assert.equal(result.record?.text_content, "Title\nPara one\nhi");
	assert.deepEqual(result.unavailableFields, []);
});

test("structured body: a recognized parent over an unrecognized child is undecodable, not empty", async () => {
	const cases: [string, Buffer][] = [
		[
			"document with only an unknown field",
			encodeLengthDelimitedField(
				2,
				encodeLengthDelimitedField(9, Buffer.from("whatever")),
			),
		],
		[
			"note moved to another field number",
			encodeLengthDelimitedField(
				2,
				Buffer.concat([
					Buffer.from([0x10, 0x00]),
					encodeLengthDelimitedField(4, textRun("hidden text")),
				]),
			),
		],
	];
	await Promise.all(
		cases.map(async ([name, body]) => {
			const result = await readBody(body);
			assert.equal(result.record?.text_content, null, name);
			assert.deepEqual(
				result.unavailableFields.map(({ reason }) => reason),
				["body_structure_unrecognized"],
				name,
			);
		}),
	);
});

test("structured body: a length that overflows 32 bits is malformed, not truncated", async () => {
	const result = await readBody(
		Buffer.from([0x0a, 0x83, 0x80, 0x80, 0x80, 0x10, 0x41, 0x42, 0x43]),
	);
	assert.equal(result.record?.text_content, null);
	assert.deepEqual(
		result.unavailableFields.map(({ reason }) => reason),
		["body_protobuf_malformed"],
	);
});

test("structured body: a known text field with the wrong wire type is undecodable, not empty", async () => {
	// note_body 2 -> note_document 3 -> rich_text { field 2 as varint 1, empty field 3 }
	const result = await readBody(
		Buffer.from([0x12, 0x06, 0x1a, 0x04, 0x10, 0x01, 0x1a, 0x00]),
	);
	assert.equal(result.record?.text_content, null);
	assert.deepEqual(
		result.unavailableFields.map(({ field, reason }) => ({ field, reason })),
		[{ field: "text_content", reason: "body_text_wrong_wire_type" }],
	);
});

test("structured body: wrong wire type is undecodable at every level", async () => {
	const cases: [string, Buffer][] = [
		["note_body text as varint", Buffer.from([0x08, 0x01])],
		["note_body document as varint", Buffer.from([0x10, 0x01])],
		[
			"note_document rich text as varint",
			encodeLengthDelimitedField(2, Buffer.from([0x18, 0x01])),
		],
		[
			"rich_text value as fixed32",
			structuredBody(Buffer.from([0x15, 0, 0, 0, 0])),
		],
	];
	await Promise.all(
		cases.map(async ([name, body]) => {
			const result = await readBody(body);
			assert.equal(result.record?.text_content, null, name);
			assert.deepEqual(
				result.unavailableFields.map(({ reason }) => reason),
				["body_text_wrong_wire_type"],
				name,
			);
		}),
	);
});

test("structured body: each undecodable cause is recorded and none becomes empty or metadata", async () => {
	const cases: [string, Buffer, string][] = [
		[
			"malformed protobuf",
			Buffer.from([0x00, 0xff, 0xfe, 0x80]),
			"body_protobuf_malformed",
		],
		[
			"invalid UTF-8 text",
			Buffer.from([0x0a, 0x01, 0xff]),
			"body_text_invalid_utf8",
		],
		[
			"unrecognized structure",
			Buffer.from([0x32, 0x04, 0x74, 0x65, 0x78, 0x74]),
			"body_structure_unrecognized",
		],
	];
	await Promise.all(
		cases.map(async ([name, body, reason]) => {
			const result = await readBody(body);
			assert.equal(result.record?.text_content, null, name);
			assert.deepEqual(
				result.unavailableFields.map((omission) => omission.reason),
				[reason],
				name,
			);
		}),
	);
});

test("structured body: text beside an undecodable sibling field is withheld whole", async () => {
	const result = await readBody(
		structuredBody(textRun("kept?"), Buffer.from([0x10, 0x01])),
	);
	assert.equal(result.record?.text_content, null);
	assert.deepEqual(
		result.unavailableFields.map(({ reason }) => reason),
		["body_text_wrong_wire_type"],
	);
});

test("body text that decompresses under no format is undecodable with a recorded cause", async () => {
	const result = await readNoteRecord({
		recordName: "note-not-compressed",
		recordType: "Note",
		fields: {
			TitleEncrypted: { value: null },
			SnippetEncrypted: { value: null },
			Folder: { value: null },
			IsPinned: { value: null },
			CreationDate: { value: null },
			ModificationDate: { value: null },
			Attachments: { value: [] },
			TextDataEncrypted: { value: b64("synthetic undecodable body") },
		},
	});
	assert.deepEqual(
		result.unavailableFields.map(({ reason }) => reason),
		["body_not_compressed"],
	);
});

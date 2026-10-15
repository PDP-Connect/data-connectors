// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure iCloud Notes parsers. All fixture byte blobs in
 * this file are synthetically constructed (labelled below), not derived
 * from a real capture — no live-account run has occurred for this
 * connector yet.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync, deflateSync, gzipSync } from "node:zlib";
import {
	buildFolderRecord,
	buildNoteRecord,
	decodeBase64Text,
	epochMsToIso,
	extractCleanText,
	extractNoteText,
	isDeletedNote,
	readNoteRecord,
} from "./parsers.ts";
import type { CloudKitRecord } from "./types.ts";

// ─── decodeBase64Text ────────────────────────────────────────────────────

test("decodeBase64Text: decodes a base64 UTF-8 string", () => {
	const encoded = Buffer.from("Grocery list", "utf-8").toString("base64");
	assert.equal(decodeBase64Text(encoded), "Grocery list");
});

test("decodeBase64Text: null for absent or non-string input and preserves an empty source value", () => {
	assert.equal(decodeBase64Text(undefined), null);
	assert.equal(decodeBase64Text(null), null);
	assert.equal(decodeBase64Text(""), "");
	assert.equal(decodeBase64Text("!!!"), null);
	assert.equal(decodeBase64Text(42), null);
});

// ─── epochMsToIso ────────────────────────────────────────────────────────

test("epochMsToIso: converts a positive epoch-ms number to ISO-8601", () => {
	assert.equal(epochMsToIso(1_700_000_000_000), "2023-11-14T22:13:20.000Z");
});

test("epochMsToIso: accepts zero and rejects negative, non-finite, or non-number input", () => {
	assert.equal(epochMsToIso(0), "1970-01-01T00:00:00.000Z");
	assert.equal(epochMsToIso(-5), null);
	assert.equal(epochMsToIso(Number.NaN), null);
	assert.equal(epochMsToIso(Number.MAX_VALUE), null);
	assert.equal(epochMsToIso("2023-01-01"), null);
	assert.equal(epochMsToIso(undefined), null);
});

// ─── extractCleanText / extractNoteText (heuristic decode) ─────────────

test("extractCleanText: extracts a run of printable prose from decompressed bytes", () => {
	const text = "Grocery list: milk, eggs, bread.";
	const decompressed = Buffer.from(text, "utf-8");
	assert.equal(extractCleanText(decompressed), text);
});

test("extractCleanText: drops short runs (<4 chars) and low-signal binary noise", () => {
	// Two short "AB" tokens surrounded by control bytes that don't form a
	// ≥4-char printable run, plus one real prose run.
	const bytes = Buffer.concat([
		Buffer.from([0x00, 0x01, 0x02]),
		Buffer.from("AB", "utf-8"),
		Buffer.from([0x03, 0x04]),
		Buffer.from("A genuine sentence of prose text.", "utf-8"),
	]);
	const result = extractCleanText(bytes);
	assert.ok(result?.includes("A genuine sentence of prose text."));
	assert.ok(!result?.includes("AB"));
});

test("extractCleanText: returns null when no run clears the clean-character ratio", () => {
	// A run of printable-but-not-prose-like characters (repeated symbols)
	// with a clean ratio at or below the 0.6 threshold.
	const noisy = "@#$%^&*<>{}[]~`|\\@#$%^&*<>{}[]~`|\\";
	assert.equal(extractCleanText(Buffer.from(noisy, "utf-8")), null);
});

test("extractNoteText: decodes a synthetic gzip-compressed note body (labelled synthetic)", () => {
	const text =
		"Meeting notes: discuss Q3 roadmap and follow up with the design team.";
	const compressed = gzipSync(Buffer.from(text, "utf-8"));
	const base64 = compressed.toString("base64");
	assert.equal(extractNoteText(base64), text);
});

test("extractNoteText: decodes a synthetic zlib-deflate-compressed note body", () => {
	const text = "Second synthetic fixture using zlib deflate, not gzip.";
	const compressed = deflateSync(Buffer.from(text, "utf-8"));
	const base64 = compressed.toString("base64");
	assert.equal(extractNoteText(base64), text);
});

test("extractNoteText: decodes a synthetic raw-deflate-compressed note body", () => {
	const text = "Third synthetic fixture using raw deflate.";
	const compressed = deflateRawSync(Buffer.from(text, "utf-8"));
	const base64 = compressed.toString("base64");
	assert.equal(extractNoteText(base64), text);
});

test("extractNoteText: null for absent/empty/non-string input", () => {
	assert.equal(extractNoteText(undefined), null);
	assert.equal(extractNoteText(null), null);
	assert.equal(extractNoteText(""), null);
});

test("extractNoteText: null for base64 input that decompresses under no tried format", () => {
	const garbage = Buffer.from("not compressed data at all", "utf-8").toString(
		"base64",
	);
	assert.equal(extractNoteText(garbage), null);
});

test("extractNoteText: null for input that isn't valid base64-decodable bytes at all", () => {
	// Buffer.from(..., 'base64') never throws in Node (it tolerates invalid
	// chars), so this exercises the decompress-failure path, not a base64
	// parse failure — kept as a documented behavior check.
	assert.equal(extractNoteText("!!!not-base64!!!"), null);
});

// ─── isDeletedNote ───────────────────────────────────────────────────────

test("isDeletedNote: true only when Deleted.value === 1", () => {
	assert.equal(
		isDeletedNote({ fields: { Deleted: { value: 1 } } } as CloudKitRecord),
		true,
	);
	assert.equal(
		isDeletedNote({ fields: { Deleted: { value: 0 } } } as CloudKitRecord),
		false,
	);
	assert.equal(isDeletedNote({ fields: {} } as CloudKitRecord), false);
	assert.equal(isDeletedNote({} as CloudKitRecord), false);
});

// ─── buildNoteRecord ─────────────────────────────────────────────────────

function b64(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64");
}

test("buildNoteRecord: maps a well-formed CloudKit Note record to the notes schema shape", () => {
	const bodyText = "A synthetic note body used only for this unit test.";
	const compressedBody = gzipSync(Buffer.from(bodyText, "utf-8")).toString(
		"base64",
	);
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

	const built = buildNoteRecord(record, new Map([["folder-xyz-789", "Work"]]));
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

test("buildNoteRecord: explicit empty CloudKit values map to empty output values", () => {
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
	const built = buildNoteRecord(record);
	assert.ok(built);
	assert.equal(built.title, null);
	assert.equal(built.snippet, null);
	assert.equal(built.folder_id, null);
	assert.equal(built.folder_name, null);
	assert.equal(built.is_pinned, false);
	assert.equal(built.has_attachments, false);
	assert.equal(built.text_content, null);
});

test("readNoteRecord: absent mapped fields remain unavailable", () => {
	const result = readNoteRecord({
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

test("readNoteRecord: an unresolved folder reference leaves folder_name unavailable", () => {
	const result = readNoteRecord(
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

test("readNoteRecord: a valid base64 body that cannot be decoded is unavailable", () => {
	const result = readNoteRecord({
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
				field === "text_content" && reason === "body_text_unreadable",
		),
	);
});

test("buildNoteRecord: falls back to Folders[0] when Folder is absent", () => {
	const record: CloudKitRecord = {
		recordName: "note-folders-array",
		recordType: "Note",
		fields: {
			Folders: { value: [{ recordName: "folder-from-array" }] },
		},
	};
	const built = buildNoteRecord(record);
	assert.equal(built?.folder_id, "folder-from-array");
});

test("buildNoteRecord: falls back to created/modified.timestamp when field-level dates are absent", () => {
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
	const built = buildNoteRecord(record);
	assert.equal(built?.created_at, "2023-11-14T22:13:20.000Z");
	assert.equal(built?.modified_at, "2023-11-16T02:00:00.000Z");
});

test("buildNoteRecord: null when recordName is absent (unusable record)", () => {
	assert.equal(buildNoteRecord({ fields: {} } as CloudKitRecord), null);
});

// ─── buildFolderRecord ───────────────────────────────────────────────────

test("buildFolderRecord: maps a well-formed CloudKit Folder record", () => {
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

test("buildFolderRecord: null when recordName is absent", () => {
	assert.equal(
		buildFolderRecord({
			fields: { TitleEncrypted: { value: b64("Work") } },
		} as CloudKitRecord),
		null,
	);
});

test("buildFolderRecord: absent title is unavailable, explicit empty title falls back", () => {
	assert.deepEqual(
		buildFolderRecord({ recordName: "folder-no-title", fields: {} }),
		{ id: "folder-no-title", name: null },
	);
	assert.deepEqual(
		buildFolderRecord({
			recordName: "folder-empty-title",
			fields: { TitleEncrypted: { value: b64("") } },
		}),
		{ id: "folder-empty-title", name: "folder-empty-title" },
	);
});

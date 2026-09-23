// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the iCloud Notes connector. No Playwright / Node I/O so
 * they unit-test in isolation — the CloudKit fetch loop and browser
 * lifecycle live in index.ts.
 *
 * KNOWN LIMITATION — heuristic note-body decode: `extractNoteText` is a
 * byte-heuristic port of the legacy `connectors/apple/icloud-notes-playwright.js`
 * `extractTextFromProtobuf`/`extractCleanText`, faithfully preserved, NOT a
 * real Apple Notes protobuf parse. `TextDataEncrypted` holds a
 * compressed protobuf-encoded rich-text document (the same on-disk format
 * Apple Notes uses locally). This function decompresses the bytes and then
 * regex-scans for runs of printable text, joining them with newlines. It
 * will drop structural information (checklists, tables, formatting,
 * attachment placeholders) and can occasionally include protobuf field
 * names or other non-prose bytes that happen to look like a printable run.
 * It is a best-effort legacy behavior being carried forward, not a design
 * choice made fresh for this connector. A real protobuf schema for Apple
 * Notes' format is not publicly documented by Apple; reverse-engineered
 * community schemas exist but adopting one is out of scope for this cut.
 */

import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import type { CloudKitFieldValue, CloudKitRecord } from "./types.ts";

// ─── Base64 / timestamp helpers ─────────────────────────────────────────

/** Decode a CloudKit base64 field value (titles, snippets) to UTF-8 text.
 *  Returns null for absent/unparseable input — never throws. */
export function decodeBase64Text(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	try {
		return Buffer.from(value, "base64").toString("utf-8");
	} catch {
		return null;
	}
}

/** CloudKit timestamps are epoch milliseconds. Returns null for anything
 *  that isn't a positive finite number. */
export function epochMsToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return null;
	}
	return new Date(value).toISOString();
}

// ─── Heuristic note-body text extraction (ported from legacy) ──────────

const DECOMPRESS_FORMATS = ["gzip", "deflate", "deflate-raw"] as const;
type DecompressFormat = (typeof DECOMPRESS_FORMATS)[number];

function decompressBytes(
	bytes: Uint8Array,
	format: DecompressFormat,
): Buffer | null {
	const input = Buffer.from(bytes);
	try {
		if (format === "gzip") {
			return gunzipSync(input);
		}
		if (format === "deflate") {
			return inflateSync(input);
		}
		return inflateRawSync(input);
	} catch {
		return null;
	}
}

/** Printable run length ≥4, ASCII or extended Unicode. Mirrors the legacy
 *  `/[\x20-\x7E -￿]{4,}/g` extraction pattern exactly. */
const PRINTABLE_RUN_RE = /[\x20-\x7E -￿]{4,}/g;
/** "Looks like prose" character class used to score each printable run,
 *  mirroring the legacy connector's clean-text heuristic. */
const CLEAN_CHAR_RE = /[a-zA-Z0-9 .,;:!?'"()\-\n\r\t‘’“”…–—]/g;
const CLEAN_RATIO_THRESHOLD = 0.6;

/** Scan decompressed bytes for runs of human-readable text. Same heuristic
 *  as legacy `extractCleanText`: a run of ≥4 printable characters counts as
 *  prose only if >60% of its characters are common prose/punctuation. */
export function extractCleanText(decompressed: Uint8Array): string | null {
	const fullText = Buffer.from(decompressed).toString("utf-8");
	const runs: string[] = [];
	for (const match of fullText.matchAll(PRINTABLE_RUN_RE)) {
		const run = match[0];
		const cleanCount = (run.match(CLEAN_CHAR_RE) ?? []).length;
		if (cleanCount / run.length > CLEAN_RATIO_THRESHOLD) {
			runs.push(run);
		}
	}
	return runs.length > 0 ? runs.join("\n") : null;
}

/** Decode a note's `TextDataEncrypted` field (base64 of a compressed
 *  protobuf blob) to a best-effort text preview. Tries gzip, then raw
 *  deflate, then zlib deflate — the legacy connector tried the same three
 *  formats in the same order because the compression Apple's client uses
 *  is not documented and has been observed to vary. Returns null if the
 *  input can't be decoded under any tried format or contains no
 *  extractable prose. */
export function extractNoteText(base64Data: unknown): string | null {
	if (typeof base64Data !== "string" || base64Data.length === 0) {
		return null;
	}
	let bytes: Buffer;
	try {
		bytes = Buffer.from(base64Data, "base64");
	} catch {
		return null;
	}
	for (const format of DECOMPRESS_FORMATS) {
		const decompressed = decompressBytes(bytes, format);
		if (!decompressed) {
			continue;
		}
		const text = extractCleanText(decompressed);
		if (text) {
			return text;
		}
	}
	return null;
}

// ─── CloudKit field access ───────────────────────────────────────────────

function fieldValue(
	fields: Record<string, CloudKitFieldValue> | undefined,
	name: string,
): unknown {
	return fields?.[name]?.value;
}

/** CloudKit `Folder` reference field: `{ value: { recordName } }`. Also
 *  covers the legacy connector's `Folders[0]` fallback for notes whose
 *  parent is expressed as an array reference field instead of a single one. */
function folderRecordName(
	fields: Record<string, CloudKitFieldValue> | undefined,
): string | null {
	const direct = fieldValue(fields, "Folder");
	if (
		direct &&
		typeof direct === "object" &&
		"recordName" in direct &&
		typeof (direct as { recordName?: unknown }).recordName === "string"
	) {
		return (direct as { recordName: string }).recordName;
	}
	const list = fieldValue(fields, "Folders");
	if (Array.isArray(list) && list.length > 0) {
		const first = list[0] as { recordName?: unknown } | undefined;
		if (first && typeof first.recordName === "string") {
			return first.recordName;
		}
	}
	return null;
}

// ─── Record builders ────────────────────────────────────────────────────

export interface NoteRecord {
	[field: string]: unknown;
	id: string;
	title: string | null;
	snippet: string | null;
	folder_id: string | null;
	is_pinned: boolean;
	created_at: string | null;
	modified_at: string | null;
	has_attachments: boolean;
	text_content: string | null;
}

export interface FolderRecord {
	[field: string]: unknown;
	id: string;
	name: string;
}

/** True when CloudKit marked this record row deleted (`Deleted.value === 1`).
 *  Callers must skip deleted note rows before building a record. */
export function isDeletedNote(record: CloudKitRecord): boolean {
	return fieldValue(record.fields, "Deleted") === 1;
}

/** Build a `notes` stream record from a raw CloudKit `Note` record. Per the
 *  capability map's field mapping, `folder_id` is the CloudKit `recordName`
 *  of the parent folder (a foreign key into the `folders` stream), not a
 *  resolved display name — unlike the legacy connector, which resolved to a
 *  title string. */
export function buildNoteRecord(record: CloudKitRecord): NoteRecord | null {
	const recordName = record.recordName;
	if (!recordName) {
		return null;
	}
	const fields = record.fields;
	const attachments = fieldValue(fields, "Attachments");
	return {
		id: recordName,
		title: decodeBase64Text(fieldValue(fields, "TitleEncrypted")),
		snippet: decodeBase64Text(fieldValue(fields, "SnippetEncrypted")),
		folder_id: folderRecordName(fields),
		is_pinned:
			fieldValue(fields, "IsPinned") === 1 ||
			fieldValue(fields, "IsPinned") === true,
		created_at:
			epochMsToIso(fieldValue(fields, "CreationDate")) ??
			epochMsToIso(record.created?.timestamp),
		modified_at:
			epochMsToIso(fieldValue(fields, "ModificationDate")) ??
			epochMsToIso(record.modified?.timestamp),
		has_attachments: Array.isArray(attachments) && attachments.length > 0,
		text_content: extractNoteText(fieldValue(fields, "TextDataEncrypted")),
	};
}

/** Build a `folders` stream record from a raw CloudKit `Folder` record.
 *  Per the capability map, `name` comes from `TitleEncrypted` (legacy
 *  `title`); CloudKit's folder record carries no other stable, documented
 *  field beyond `recordName`/title, matching the field list the legacy
 *  schema (`connectors/apple/schemas/icloud_notes.folders.json`) declares. */
export function buildFolderRecord(record: CloudKitRecord): FolderRecord | null {
	const recordName = record.recordName;
	if (!recordName) {
		return null;
	}
	const name = decodeBase64Text(fieldValue(record.fields, "TitleEncrypted"));
	if (name === null) {
		return null;
	}
	return { id: recordName, name };
}

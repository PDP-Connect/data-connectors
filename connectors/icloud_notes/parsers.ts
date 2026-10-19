// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the iCloud Notes connector. No Playwright / Node I/O so
 * they unit-test in isolation — the CloudKit fetch loop and browser
 * lifecycle live in index.ts.
 *
 * Note bodies are compressed protobuf rich-text documents. We decode the
 * protobuf wire structure and strict UTF-8 strings without script-based text
 * scoring. Apple does not publish the rich-text schema, so this preserves
 * text while omitting formatting and attachment metadata.
 */

import type { CloudKitFieldValue, CloudKitRecord } from "./types.ts";

// ─── Base64 / timestamp helpers ─────────────────────────────────────────

/** Decode a CloudKit base64 field value (titles, snippets) to UTF-8 text.
 *  Returns null for absent/non-string input — never throws. Empty strings
 *  decode to empty strings and remain source data. */
export function decodeBase64Text(value: unknown): string | null {
	if (typeof value !== "string" || !isBase64(value)) {
		return null;
	}
	try {
		return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
			base64Bytes(value),
		);
	} catch {
		return null;
	}
}

function base64Bytes(value: string): Uint8Array {
	return Uint8Array.from(atob(value.replace(/=+$/, "")), (char) =>
		char.charCodeAt(0),
	);
}

function isBase64(value: string): boolean {
	if (value.length === 0) return true;
	if (value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		return false;
	}
	try {
		return (
			btoa(atob(value.replace(/=+$/, ""))).replace(/=+$/, "") ===
			value.replace(/=+$/, "")
		);
	} catch {
		return false;
	}
}

/** CloudKit timestamps are epoch milliseconds. Returns null for anything
 *  that isn't a non-negative finite number representable by Date. */
export function epochMsToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// ─── Note-body rich-text decoding ──────────────────────────────────────

const DECOMPRESS_FORMATS = ["gzip", "deflate", "deflate-raw"] as const;
type DecompressFormat = (typeof DECOMPRESS_FORMATS)[number];

export async function decompressBytes(
	bytes: Uint8Array,
	format: DecompressFormat,
): Promise<Uint8Array | null> {
	try {
		const input = new Uint8Array(bytes);
		const stream = new Blob([input])
			.stream()
			.pipeThrough(new DecompressionStream(format));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	} catch {
		return null;
	}
}

type ProtobufField = {
	fieldNumber: number;
	wireType: number;
	value?: Uint8Array;
};

const NOTE_BODY_TEXT_FIELD = 1;
const NOTE_BODY_DOCUMENT_FIELD = 2;
const NOTE_DOCUMENT_RICH_TEXT_FIELD = 3;
const RICH_TEXT_VALUE_FIELD = 2;

type ProtobufMessage = "note_body" | "note_document" | "rich_text";

type NoteTextExtraction =
	| { kind: "READ"; value: string }
	| { kind: "EXPLICIT_EMPTY" }
	| { kind: "UNAVAILABLE"; reason: "body_text_unreadable" };

function readVarint(
	bytes: Uint8Array,
	offset: number,
): [number, number] | null {
	let value = 0;
	for (let shift = 0; shift < 35; shift += 7) {
		if (offset >= bytes.length) return null;
		const byte = bytes[offset++];
		if (byte === undefined) return null;
		value |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [value >>> 0, offset];
	}
	return null;
}

function parseProtobuf(bytes: Uint8Array): ProtobufField[] | null {
	const fields: ProtobufField[] = [];
	let offset = 0;
	while (offset < bytes.length) {
		const tag = readVarint(bytes, offset);
		if (!tag || tag[0] === 0) return null;
		offset = tag[1];
		const fieldNumber = tag[0] >>> 3;
		const wireType = tag[0] & 7;
		if (fieldNumber === 0) return null;
		if (wireType === 0) {
			const value = readVarint(bytes, offset);
			if (!value) return null;
			offset = value[1];
		} else if (wireType === 1 || wireType === 5) {
			offset += wireType === 1 ? 8 : 4;
			if (offset > bytes.length) return null;
		} else if (wireType === 2) {
			const length = readVarint(bytes, offset);
			if (!length) return null;
			offset = length[1];
			const end = offset + length[0];
			if (end > bytes.length) return null;
			fields.push({
				fieldNumber,
				wireType,
				value: bytes.subarray(offset, end),
			});
			offset = end;
			continue;
		} else {
			return null;
		}
		fields.push({ fieldNumber, wireType });
	}
	return fields;
}

function decodeUtf8(bytes: Uint8Array): string | null {
	try {
		const value = new TextDecoder("utf-8", {
			fatal: true,
			ignoreBOM: true,
		}).decode(bytes);
		for (const character of value) {
			const codePoint = character.codePointAt(0);
			if (
				codePoint !== undefined &&
				((codePoint < 0x20 &&
					codePoint !== 0x09 &&
					codePoint !== 0x0a &&
					codePoint !== 0x0d) ||
					(codePoint >= 0x7f && codePoint <= 0x9f))
			) {
				return null;
			}
		}
		return value;
	} catch {
		return null;
	}
}

function splitTextRuns(value: string): string[] {
	return value
		.split(/[\u0000-\u001F\u007F-\u009F]/)
		.filter((run) => run.length > 0);
}

function extractLegacyTextRuns(bytes: Uint8Array): string | null {
	const fullText = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const textRuns: string[] = [];
	const runRe = /[\x20-\x7E\u00A0-\uFFFF]{4,}/g;
	for (const match of fullText.matchAll(runRe)) {
		const run = match[0];
		const cleanCount = (
			run.match(
				/[a-zA-Z0-9 .,;:!?\x27"()\-\n\r\t\u2018\u2019\u201C\u201D\u2026\u2013\u2014]/g,
			) ?? []
		).length;
		if (cleanCount / run.length > 0.6) textRuns.push(run);
	}
	return textRuns.length > 0 ? textRuns.join("\n") : null;
}

function legacyRenderingPreservesUnicode(
	legacyText: string,
	structuredText: string,
): boolean {
	const unicodeCharacters = (value: string) =>
		[...value.replace(/[\u0000-\u001F\u007F-\u009F\uFFFC]/g, "")]
			.filter((character) => (character.codePointAt(0) ?? 0) > 0x7f)
			.join("");
	return unicodeCharacters(legacyText) === unicodeCharacters(structuredText);
}

function extractProtobufText(
	bytes: Uint8Array,
	message: ProtobufMessage = "note_body",
	depth = 0,
): NoteTextExtraction {
	if (depth > 32) {
		return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
	}
	if (bytes.length === 0) return { kind: "EXPLICIT_EMPTY" };
	const fields = parseProtobuf(bytes);
	if (!fields) {
		return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
	}
	let sawRecognizedField = false;
	let sawDocumentField = false;
	const textParts: string[] = [];
	for (const field of fields) {
		if (
			message === "note_body" &&
			field.fieldNumber === NOTE_BODY_TEXT_FIELD &&
			field.wireType === 2
		) {
			sawRecognizedField = true;
			const value = field.value ? decodeUtf8(field.value) : null;
			if (value === null) {
				return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
			}
			textParts.push(...splitTextRuns(value));
			continue;
		}
		if (
			message === "note_body" &&
			field.fieldNumber === NOTE_BODY_DOCUMENT_FIELD
		) {
			sawRecognizedField = true;
			sawDocumentField = true;
			if (field.wireType !== 2 || !field.value) {
				return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
			}
			const document = extractProtobufText(
				field.value,
				"note_document",
				depth + 1,
			);
			if (document.kind === "UNAVAILABLE") return document;
			if (document.kind === "READ") textParts.push(document.value);
			continue;
		}
		if (
			message === "note_document" &&
			field.fieldNumber === NOTE_DOCUMENT_RICH_TEXT_FIELD &&
			field.wireType === 2 &&
			field.value
		) {
			sawRecognizedField = true;
			const richText = extractProtobufText(
				field.value,
				"rich_text",
				depth + 1,
			);
			if (richText.kind === "UNAVAILABLE") return richText;
			if (richText.kind === "READ") textParts.push(richText.value);
			continue;
		}
		if (
			message === "rich_text" &&
			field.fieldNumber === RICH_TEXT_VALUE_FIELD &&
			field.wireType === 2
		) {
			sawRecognizedField = true;
			const value = field.value ? decodeUtf8(field.value) : null;
			if (value === null) {
				return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
			}
			textParts.push(...splitTextRuns(value));
			continue;
		}
		if (message === "rich_text" && field.fieldNumber === 3) {
			// Rich-text formatting and attachment metadata do not contain body text.
			sawRecognizedField = true;
		}
	}
	if (!sawRecognizedField) {
		return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
	}
	if (textParts.length === 0) return { kind: "EXPLICIT_EMPTY" };
	const structuredText = textParts.join("\n");
	if (message === "note_body" && depth === 0 && sawDocumentField) {
		const legacyText = extractLegacyTextRuns(bytes);
		if (
			legacyText !== null &&
			legacyRenderingPreservesUnicode(legacyText, structuredText)
		) {
			return { kind: "READ", value: legacyText };
		}
	}
	return { kind: "READ", value: structuredText };
}

/** Decode UTF-8 strings from length-delimited rich-text protobuf fields. */
export function extractCleanText(decompressed: Uint8Array): string | null {
	const extraction = extractProtobufText(decompressed);
	return extraction.kind === "READ" ? extraction.value : null;
}

/** Decode a note's `TextDataEncrypted` field (base64 of a compressed
 *  protobuf blob) to its text content. Tries gzip, then raw deflate, then
 *  zlib deflate. A nonempty body with unknown structure or invalid UTF-8 is
 *  unavailable; only recognized empty or attachment-only structures are
 *  explicitly empty. */
async function readCompressedNoteText(
	base64Data: string,
): Promise<NoteTextExtraction> {
	let bytes: Uint8Array;
	try {
		bytes = base64Bytes(base64Data);
	} catch {
		return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
	}
	for (const format of DECOMPRESS_FORMATS) {
		const decompressed = await decompressBytes(bytes, format);
		if (!decompressed) {
			continue;
		}
		return extractProtobufText(decompressed);
	}
	return { kind: "UNAVAILABLE", reason: "body_text_unreadable" };
}

export async function extractNoteText(
	base64Data: unknown,
): Promise<string | null> {
	if (typeof base64Data !== "string" || base64Data.length === 0) return null;
	const result = await readCompressedNoteText(base64Data);
	return result.kind === "READ" ? result.value : null;
}

// ─── CloudKit field access ───────────────────────────────────────────────

export type FieldRead<T> =
	| { kind: "READ"; value: T }
	| { kind: "EXPLICIT_EMPTY"; value: T }
	| {
			kind: "UNAVAILABLE";
			reason: string;
			source_shape: SourceValueShape;
	  };

export interface SourceValueShape {
	type: string;
	keys?: string[];
	length?: number;
}

export interface FieldOmission {
	field: string;
	reason: string;
	source_shape: SourceValueShape;
}

export interface RecordRead<T> {
	record: T | null;
	unavailableFields: FieldOmission[];
}

export type CloudKitRecordType = "Note" | "Folder";

function read<T>(value: T): FieldRead<T> {
	return { kind: "READ", value };
}

function explicitEmpty<T>(value: T): FieldRead<T> {
	return { kind: "EXPLICIT_EMPTY", value };
}

function sourceValueShape(value: unknown): SourceValueShape {
	if (value === null) return { type: "null" };
	if (Array.isArray(value)) return { type: "array", length: value.length };
	if (value === undefined) return { type: "undefined" };
	if (typeof value === "string")
		return { type: "string", length: value.length };
	if (typeof value === "object") {
		return { type: "object", keys: Object.keys(value).sort().slice(0, 32) };
	}
	return { type: typeof value };
}

const NO_SOURCE_VALUE = Symbol("no-source-value");

function unavailable<T>(
	reason: string,
	sourceValue: unknown | typeof NO_SOURCE_VALUE = NO_SOURCE_VALUE,
	shapeOverride?: SourceValueShape,
): FieldRead<T> {
	return {
		kind: "UNAVAILABLE",
		reason,
		...(shapeOverride
			? { source_shape: shapeOverride }
			: {
					source_shape:
						sourceValue === NO_SOURCE_VALUE
							? { type: "unknown" }
							: sourceValueShape(sourceValue),
				}),
	};
}

/** Record type controls whether a CloudKit result is routed, excluded, or
 *  withheld. Only the two record types observed in these query results are
 *  recognized; an unknown or malformed discriminator cannot prove that a
 *  row is irrelevant. */
export function readCloudKitRecordType(
	record: CloudKitRecord,
): FieldRead<CloudKitRecordType> {
	if (!Object.hasOwn(record, "recordType") || record.recordType === undefined) {
		return unavailable("missing_record_type", undefined, { type: "missing" });
	}
	if (record.recordType === "Note" || record.recordType === "Folder") {
		return read(record.recordType);
	}
	const shape = sourceValueShape(record.recordType);
	return unavailable(
		typeof record.recordType === "string" && record.recordType.length > 0
			? "unrecognized_record_type"
			: "malformed_record_type",
		record.recordType,
		shape,
	);
}

function fieldValue(
	fields: Record<string, CloudKitFieldValue> | undefined,
	name: string,
	missing: FieldRead<unknown> = unavailable("missing_field", undefined, {
		type: "missing",
	}),
): FieldRead<unknown> {
	// CloudKit Notes records are sparse: optional keys at their default are
	// omitted. Callers supply that documented empty/default state per field;
	// required fields keep the unavailable default below.
	if (!fields || !Object.hasOwn(fields, name)) {
		return missing;
	}
	const field: unknown = fields[name];
	if (
		typeof field !== "object" ||
		field === null ||
		Array.isArray(field) ||
		(Object.hasOwn(field, "type") &&
			typeof (field as { type?: unknown }).type !== "string") ||
		!Object.hasOwn(field, "value")
	) {
		return unavailable("malformed_field_wrapper", field);
	}
	const value = (field as { value: unknown }).value;
	return value === null ? explicitEmpty(null) : read(value);
}

function readableValue<T>(field: FieldRead<T>, empty: T): T {
	return field.kind === "UNAVAILABLE" ? empty : field.value;
}

function textField(
	fields: Record<string, CloudKitFieldValue> | undefined,
	name: string,
	missing: FieldRead<string | null> = unavailable("missing_field", undefined, {
		type: "missing",
	}),
): FieldRead<string | null> {
	const raw = fieldValue(fields, name, missing);
	if (raw.kind === "UNAVAILABLE") return raw;
	if (raw.value === null) return explicitEmpty(null);
	if (typeof raw.value !== "string")
		return unavailable("expected_base64_text", raw.value);
	const value = decodeBase64Text(raw.value);
	if (value === null) return unavailable("invalid_base64_text", raw.value);
	return value.length === 0 ? explicitEmpty("") : read(value);
}

function referenceField(
	fields: Record<string, CloudKitFieldValue> | undefined,
): FieldRead<string | null> {
	const direct =
		fields && Object.hasOwn(fields, "Folder")
			? fieldValue(fields, "Folder")
			: null;
	if (direct === null) {
		// The legacy reader checked Folder then Folders[0] and returned null
		// when neither was present. Both absent is therefore the sparse default.
		const list = fieldValue(fields, "Folders", explicitEmpty(null));
		if (list.kind === "UNAVAILABLE") return list;
		if (list.value === null) return explicitEmpty(null);
		if (!Array.isArray(list.value))
			return unavailable("expected_folder_reference_list", list.value);
		if (list.value.length === 0) return explicitEmpty(null);
		const first: unknown = list.value[0];
		if (
			typeof first !== "object" ||
			first === null ||
			Array.isArray(first) ||
			typeof (first as { recordName?: unknown }).recordName !== "string" ||
			(first as { recordName: string }).recordName.length === 0
		) {
			return unavailable("malformed_folder_reference", first);
		}
		return read((first as { recordName: string }).recordName);
	}
	const directValue = direct;
	if (directValue.kind === "UNAVAILABLE") return directValue;
	if (directValue.value !== null) {
		if (
			typeof directValue.value !== "object" ||
			Array.isArray(directValue.value) ||
			typeof (directValue.value as { recordName?: unknown }).recordName !==
				"string" ||
			(directValue.value as { recordName: string }).recordName.length === 0
		) {
			return unavailable("malformed_folder_reference", directValue.value);
		}
		return read((directValue.value as { recordName: string }).recordName);
	}
	return explicitEmpty(null);
}

function booleanField(
	fields: Record<string, CloudKitFieldValue> | undefined,
	name: string,
): FieldRead<boolean | null> {
	// The legacy collector interpreted an omitted Notes boolean as false; the
	// live CloudKit rows show sparse `IsPinned` fields, not malformed values.
	const raw = fieldValue(fields, name, explicitEmpty(false));
	if (raw.kind === "UNAVAILABLE") return raw;
	if (raw.value === null) return explicitEmpty(false);
	if (raw.value === true || raw.value === 1) return read(true);
	if (raw.value === false || raw.value === 0) return read(false);
	return unavailable("expected_boolean_flag", raw.value);
}

function deletedField(
	fields: Record<string, CloudKitFieldValue> | undefined,
): FieldRead<boolean> {
	// CloudKit represents fields as entries in a record's fields dictionary;
	// the Web Services Reference gives that dictionary an empty default and
	// CKRecord.objectForKey returns nil for an absent key. The legacy Notes
	// collector treated only Deleted.value === 1 as deleted, so a sparse
	// absent Deleted field maps to false. Present null/malformed values stay
	// unavailable instead of selecting the permissive live-note branch.
	// Sources: https://developer.apple.com/library/archive/documentation/DataManagement/Conceptual/CloudKitWebServicesReference/Types.html
	// https://developer.apple.com/documentation/cloudkit/ckrecord/objectforkey%3A
	const raw = fieldValue(fields, "Deleted", explicitEmpty(false));
	if (raw.kind === "UNAVAILABLE") return raw;
	if (raw.kind === "EXPLICIT_EMPTY" && raw.value === false) {
		return explicitEmpty(false);
	}
	if (raw.value === true || raw.value === 1) return read(true);
	if (raw.value === false || raw.value === 0) return read(false);
	return unavailable("expected_deleted_flag", raw.value);
}

function recordTimestamp(
	record: CloudKitRecord,
	key: "created" | "modified",
): { present: boolean; value: unknown } {
	if (!Object.hasOwn(record, key) || record[key] === undefined) {
		return { present: false, value: undefined };
	}
	const metadata: unknown = record[key];
	if (
		typeof metadata !== "object" ||
		metadata === null ||
		Array.isArray(metadata)
	) {
		return { present: true, value: undefined };
	}
	if (!Object.hasOwn(metadata, "timestamp")) {
		return { present: false, value: undefined };
	}
	return {
		present: true,
		value: (metadata as { timestamp: unknown }).timestamp,
	};
}

function attachmentsField(
	fields: Record<string, CloudKitFieldValue> | undefined,
): FieldRead<boolean | null> {
	// Legacy Notes mapping used `Array.isArray(value) && value.length > 0`,
	// so an omitted sparse attachment list has the default false value.
	if (!fields || !Object.hasOwn(fields, "Attachments")) {
		return explicitEmpty(false);
	}
	const raw = fieldValue(fields, "Attachments");
	if (raw.kind === "UNAVAILABLE") return raw;
	if (raw.value === null) return explicitEmpty(false);
	if (!Array.isArray(raw.value))
		return unavailable("expected_attachment_list", raw.value);
	if (
		raw.value.some(
			(item) =>
				typeof item !== "object" || item === null || Array.isArray(item),
		)
	) {
		return unavailable(
			"malformed_attachment_reference",
			raw.value.find(
				(item) =>
					typeof item !== "object" || item === null || Array.isArray(item),
			),
		);
	}
	return raw.value.length === 0 ? explicitEmpty(false) : read(true);
}

function timestampField(
	fields: Record<string, CloudKitFieldValue> | undefined,
	name: string,
	fallback: unknown,
	fallbackPresent: boolean,
): FieldRead<string | null> {
	// CreationDate/ModificationDate are optional; legacy used record metadata
	// when present and otherwise returned null when the CloudKit key was absent.
	const raw = fieldValue(fields, name, explicitEmpty(null));
	if (raw.kind === "UNAVAILABLE") {
		return raw;
	}
	if (raw.value === null) {
		if (!fallbackPresent) return explicitEmpty(null);
		const iso = epochMsToIso(fallback);
		return iso === null
			? unavailable("invalid_fallback_timestamp", fallback)
			: read(iso);
	}
	const iso = epochMsToIso(raw.value);
	return iso === null ? unavailable("invalid_timestamp", raw.value) : read(iso);
}

async function bodyTextField(
	fields: Record<string, CloudKitFieldValue> | undefined,
): Promise<FieldRead<string | null>> {
	// TextDataEncrypted is required content: missing is a gap, while a present
	// null/empty body is explicit empty and a malformed body remains unavailable.
	const raw = fieldValue(fields, "TextDataEncrypted");
	if (raw.kind === "UNAVAILABLE") return raw;
	if (raw.value === null || raw.value === "") return explicitEmpty(null);
	if (typeof raw.value !== "string")
		return unavailable("expected_base64_body", raw.value);
	if (!isBase64(raw.value))
		return unavailable("invalid_base64_body", raw.value);
	const extraction = await readCompressedNoteText(raw.value);
	if (extraction.kind === "UNAVAILABLE")
		return unavailable(extraction.reason, raw.value);
	return extraction.kind === "EXPLICIT_EMPTY"
		? explicitEmpty(null)
		: read(extraction.value);
}

function collectUnavailableFields(
	fields: Record<string, FieldRead<unknown>>,
): FieldOmission[] {
	return Object.entries(fields)
		.flatMap(([field, result]) =>
			result.kind === "UNAVAILABLE"
				? [{ field, reason: result.reason, source_shape: result.source_shape }]
				: [],
		)
		.sort((left, right) =>
			left.field === right.field
				? left.reason.localeCompare(right.reason)
				: left.field.localeCompare(right.field),
		);
}

/** The one CloudKit identity rule shared by validation, pagination progress,
 *  and emission. Empty strings remain source values, but cannot identify a
 *  stored record and therefore become an explicit omission at collection. */
export function resolveCloudKitRecordId(record: CloudKitRecord): string | null {
	return typeof record.recordName === "string" && record.recordName.length > 0
		? record.recordName
		: null;
}

// ─── Record builders ────────────────────────────────────────────────────

export interface NoteRecord {
	[field: string]: unknown;
	id: string;
	title: string | null;
	snippet: string | null;
	folder_id: string | null;
	folder_name: string | null;
	is_pinned: boolean | null;
	created_at: string | null;
	modified_at: string | null;
	has_attachments: boolean | null;
	text_content: string | null;
}

export interface FolderRecord {
	[field: string]: unknown;
	id: string;
	name: string | null;
}

/** Read deletion state without collapsing an unavailable control flag to live. */
export function readDeletedNote(record: CloudKitRecord): FieldRead<boolean> {
	return deletedField(record.fields);
}

/** Build a `notes` stream record from a raw CloudKit `Note` record. Per the
 *  capability map's field mapping, `folder_id` is the CloudKit `recordName`
 *  of the parent folder (a foreign key into the `folders` stream). The
 *  adjacent `folder_name` projection preserves the legacy resolved title. */
export async function readNoteRecord(
	record: CloudKitRecord,
	folderNames: ReadonlyMap<string, string> = new Map(),
	options: {
		unavailableFolderIds?: ReadonlySet<string>;
		folderScanComplete?: boolean;
	} = {},
): Promise<RecordRead<NoteRecord>> {
	const recordName = resolveCloudKitRecordId(record);
	if (recordName === null) {
		return {
			record: null,
			unavailableFields: [
				{
					field: "id",
					reason: "missing_record_id",
					source_shape: { type: "missing" },
				},
			],
		};
	}
	const fields = record.fields;
	// `0bb607c:connectors/icloud_notes/parsers.ts` records the legacy mapping:
	// sparse snippet -> null, missing folder -> null, and sparse timestamps ->
	// null (or CloudKit record metadata). Keep title and body required so an
	// absent content field is not confused with an explicit null/empty value.
	const title = textField(fields, "TitleEncrypted");
	const snippet = textField(fields, "SnippetEncrypted", explicitEmpty(null));
	const folderId = referenceField(fields);
	const isPinned = booleanField(fields, "IsPinned");
	const createdMetadata = recordTimestamp(record, "created");
	const modifiedMetadata = recordTimestamp(record, "modified");
	const created = timestampField(
		fields,
		"CreationDate",
		createdMetadata.value,
		createdMetadata.present,
	);
	const modified = timestampField(
		fields,
		"ModificationDate",
		modifiedMetadata.value,
		modifiedMetadata.present,
	);
	const hasAttachments = attachmentsField(fields);
	const textContent = await bodyTextField(fields);
	let folderName: FieldRead<string | null>;
	if (folderId.kind === "UNAVAILABLE") {
		folderName = unavailable(
			"folder_reference_unavailable",
			undefined,
			folderId.source_shape,
		);
	} else if (folderId.value === null) {
		folderName = explicitEmpty(null);
	} else {
		const resolved = folderNames.get(folderId.value);
		if (resolved !== undefined) {
			folderName = read(resolved);
		} else if (options.unavailableFolderIds?.has(folderId.value)) {
			folderName = unavailable("folder_name_unavailable", folderId.value);
		} else {
			folderName = unavailable(
				options.folderScanComplete === true
					? "folder_name_unresolved"
					: "folder_projection_incomplete",
				folderId.value,
			);
		}
	}

	const reads: Record<string, FieldRead<unknown>> = {
		title,
		snippet,
		folder_id: folderId,
		folder_name: folderName,
		is_pinned: isPinned,
		created_at: created,
		modified_at: modified,
		has_attachments: hasAttachments,
		text_content: textContent,
	};
	const unavailableFields = collectUnavailableFields(reads);
	return {
		record: {
			id: recordName,
			title: readableValue(title, null),
			snippet: readableValue(snippet, null),
			folder_id: readableValue(folderId, null),
			folder_name: readableValue(folderName, null),
			is_pinned: readableValue(isPinned, null),
			created_at: readableValue(created, null),
			modified_at: readableValue(modified, null),
			has_attachments: readableValue(hasAttachments, null),
			text_content: readableValue(textContent, null),
		},
		unavailableFields,
	};
}

export async function buildNoteRecord(
	record: CloudKitRecord,
	folderNames: ReadonlyMap<string, string> = new Map(),
): Promise<NoteRecord | null> {
	return (
		await readNoteRecord(record, folderNames, { folderScanComplete: true })
	).record;
}

/** Build a `folders` stream record from a raw CloudKit `Folder` record.
 *  Per the capability map, `name` comes from `TitleEncrypted` (legacy
 *  `title`); an explicitly empty title follows legacy `title || recordName`.
 *  CloudKit's folder record carries no other stable, documented field beyond
 *  `recordName`/title. */
export function readFolderRecord(
	record: CloudKitRecord,
): RecordRead<FolderRecord> {
	const recordName = resolveCloudKitRecordId(record);
	if (recordName === null) {
		return {
			record: null,
			unavailableFields: [
				{
					field: "id",
					reason: "missing_record_id",
					source_shape: { type: "missing" },
				},
			],
		};
	}
	// Legacy folders fall back to recordName when the sparse title is absent or
	// empty; only a present malformed title makes the row unavailable.
	const title = textField(record.fields, "TitleEncrypted", explicitEmpty(null));
	const name =
		title.kind === "UNAVAILABLE"
			? unavailable<string | null>(title.reason, undefined, title.source_shape)
			: title.value === null || title.value.length === 0
				? explicitEmpty(recordName)
				: title;
	return {
		record: {
			id: recordName,
			name: readableValue(name, null),
		},
		unavailableFields:
			name.kind === "UNAVAILABLE"
				? [
						{
							field: "name",
							reason: name.reason,
							source_shape: name.source_shape,
						},
					]
				: [],
	};
}

export function buildFolderRecord(record: CloudKitRecord): FolderRecord | null {
	return readFolderRecord(record).record;
}

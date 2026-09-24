// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Anthropic/Claude connector. No browser/network I/O —
 * takes the JSON payloads already extracted from the official Claude data
 * export ZIP and returns typed records for each stream. Unit-testable
 * offline (see parsers.test.ts).
 *
 * Acquisition (binding, from capability-map.json's `anthropic` source
 * entry): browser session -> official Claude data export (request, poll,
 * download ZIP) -> pure ZIP parser. This module is the "pure ZIP parser"
 * half; index.ts owns the browser-driven request/poll/download half.
 *
 * Export shape, per legacy prior art (READ ONLY):
 *   - connectors/anthropic/claude-export-ingest.cjs (normalizeConversation,
 *     normalizeProject, flattenMessageText)
 *   - connectors/anthropic/claude-export-playwright.js (same normalization,
 *     mirrored)
 *   - connectors/anthropic/__tests__/claude-export-ingest.test.cjs (fixture
 *     shapes: exportConversation, exportProject)
 *
 * `conversations.json` is a bare array of raw conversation objects, each
 * carrying `chat_messages[]`. `projects/*.json` is one file per project,
 * each a raw project object. Both are read directly from the export archive
 * by index.ts via bounded-zip-archive.ts and passed here as parsed JSON.
 *
 * VERIFIED against a real account's export (this lane, offline, against the
 * local part ZIPs already on disk at $PRIV/exports/anthropic/ — never
 * against an export_url; see report for the driver used and the "Multi-part
 * manifest export" section below for the full per-category layout):
 * `docs[]` elements carry exactly `uuid`, `filename`, `content`,
 * `created_at` — this parser's first-priority candidates for each field.
 * The other defensive candidates (`file_name`, `name`, `title`, `text`,
 * `body`, `filedata`) were never observed in this account's export; kept as
 * fallbacks in case a differently-shaped account surfaces them, but no
 * longer the primary evidence for this field mapping.
 */

import {
	nullablePdppSafeText,
	type PdppSafeText,
	pdppSafeText,
} from "@pdpp/connector-protocol/pdpp-safe-text";

// ─── Raw export shapes (unknown-in, narrowed defensively) ──────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Sanitize an extracted nullable text field. A control-rich payload (a real
 * conversation was observed, this lane, with a message body zod's
 * pdppSafeText rejects) becomes null rather than throwing and aborting the
 * whole export — matching connectors/chatgpt/parsers.ts's established
 * `toSafeFullContent` convention (D4: unparseable -> null, never guessed,
 * never a crash).
 */
function safeText(v: unknown, max: number): PdppSafeText | null {
	const s = str(v);
	if (s === null) {
		return null;
	}
	const truncated = s.length > max ? s.slice(0, max) : s;
	const result = nullablePdppSafeText.safeParse(truncated);
	return result.success ? result.data : null;
}

function bool(v: unknown): boolean | null {
	return typeof v === "boolean" ? v : null;
}

const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/** Claude export timestamps are already ISO-8601; pass through verbatim if
 * they parse as such, else null (D4: unparseable value is null, never
 * guessed — never re-derive/reformat a timestamp the source already got
 * right). */
function isoOrNull(v: unknown): string | null {
	const s = str(v);
	if (s === null) {
		return null;
	}
	return ISO_DT_RE.test(s) ? s : null;
}

// ─── conversations + messages (claude.conversations split) ─────────────────

// Index signatures are open so these types satisfy RecordData (the
// connector runtime's emitRecord parameter type) at the emit site, matching
// the amazon connector's established convention (connectors/amazon/types.ts).
export interface ConversationRecord {
	id: string;
	title: PdppSafeText | null;
	create_time: string | null;
	update_time: string | null;
	project_id: string | null;
	model: string | null;
	message_count: number | null;
	is_starred: boolean | null;
	[field: string]: unknown;
}

export interface MessageRecord {
	id: string;
	conversation_id: string;
	role: string | null;
	parent_id: string | null;
	content: PdppSafeText | null;
	model: string | null;
	create_time: string | null;
	update_time: string | null;
	attachments: Record<string, unknown>[] | null;
	[field: string]: unknown;
}

/**
 * Flatten a raw export message's content into plain text. Mirrors
 * `flattenMessageText` in claude-export-ingest.cjs exactly (same
 * precedence: `text` field first, then content-block join, then a bare
 * `content.text`), so the two normalizations stay interchangeable per the
 * legacy connector's own design note.
 */
export function flattenMessageText(raw: unknown): string {
	if (!isRecord(raw)) {
		return "";
	}
	const text = raw.text;
	if (typeof text === "string" && text.length > 0) {
		return text;
	}
	const content = raw.content;
	if (!content) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (!part) {
					return "";
				}
				if (typeof part === "string") {
					return part;
				}
				if (isRecord(part) && typeof part.text === "string") {
					return part.text;
				}
				if (isRecord(part) && typeof part.content === "string") {
					return part.content;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	if (isRecord(content) && typeof content.text === "string") {
		return content.text;
	}
	return "";
}

function parseAttachments(raw: unknown): Record<string, unknown>[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}
	return raw.filter(isRecord);
}

/**
 * Parse one raw export message (`conversation.chat_messages[]` element) into
 * a `messages` record. Field map (capability-map.json, claude.conversations
 * -> anthropic.messages): id<-uuid, role<-sender, parent_id<-
 * parent_message_uuid, create_time<-created_at, update_time<-updated_at,
 * content<-flattened content, attachments<-attachments.
 */
export function parseMessage(
	raw: unknown,
	conversationId: string,
): MessageRecord | null {
	if (!isRecord(raw)) {
		return null;
	}
	const id = str(raw.uuid);
	if (id === null) {
		return null;
	}
	return {
		id,
		conversation_id: conversationId,
		role: str(raw.sender),
		parent_id: str(raw.parent_message_uuid),
		content: safeText(flattenMessageText(raw), 10_000_000),
		// The export's per-message payload carries no model field (confirmed
		// by claude-export-ingest.cjs's normalizeMessage, which does not read
		// one); left null rather than guessed.
		model: null,
		create_time: isoOrNull(raw.created_at),
		update_time: isoOrNull(raw.updated_at),
		attachments: parseAttachments(raw.attachments),
	};
}

/**
 * Parse one raw export conversation object into a `conversations` record
 * plus its `messages` records. Field map (capability-map.json,
 * claude.conversations -> anthropic.conversations + anthropic.messages):
 * id<-uuid, title<-name (falling back to summary, matching legacy
 * normalizeConversation), create_time<-created_at, update_time<-updated_at,
 * project_id<-project_uuid, message_count<-derived count, is_starred<-
 * is_starred. `href` and `fetchError` are D3 envelope/derived fields and are
 * dropped (not carried into either record), matching the capability map's
 * dropped-fields list.
 */
export function parseConversation(raw: unknown): {
	conversation: ConversationRecord;
	messages: MessageRecord[];
} | null {
	if (!isRecord(raw)) {
		return null;
	}
	const id = str(raw.uuid) ?? str(raw.id);
	if (id === null) {
		return null;
	}
	const rawMessages = Array.isArray(raw.chat_messages) ? raw.chat_messages : [];
	// Export messages carry no ordering index; sort by created_at, stable on
	// ties (matches legacy normalizeConversation exactly).
	const sorted = rawMessages
		.filter(isRecord)
		.slice()
		.sort((a, b) => {
			const ta = Date.parse(str(a.created_at) ?? "") || 0;
			const tb = Date.parse(str(b.created_at) ?? "") || 0;
			return ta - tb;
		});
	const messages = sorted
		.map((m) => parseMessage(m, id))
		.filter((m): m is MessageRecord => m !== null);

	const title = str(raw.name) ?? str(raw.summary);
	return {
		conversation: {
			id,
			title: safeText(title, 4000),
			create_time: isoOrNull(raw.created_at),
			update_time: isoOrNull(raw.updated_at),
			project_id: str(raw.project_uuid),
			// The export carries no per-conversation model field (confirmed by
			// claude-export-ingest.cjs's normalizeConversation); left null.
			model: null,
			message_count: messages.length,
			is_starred: bool(raw.is_starred),
		},
		messages,
	};
}

// ─── projects + project_documents (claude.projects split) ──────────────────

export interface ProjectRecord {
	id: string;
	name: PdppSafeText;
	description: PdppSafeText | null;
	create_time: string | null;
	update_time: string | null;
	is_archived: boolean | null;
	prompt_template: PdppSafeText | null;
	[field: string]: unknown;
}

export interface ProjectDocumentRecord {
	id: string;
	project_id: string;
	filename: PdppSafeText | null;
	content: PdppSafeText | null;
	create_time: string | null;
	update_time: string | null;
	[field: string]: unknown;
}

/**
 * Parse one raw export project-document object (`project.docs[]` element)
 * into a `project_documents` record. Field names are UNCONFIRMED against a
 * real export (see module header) — reads a defensive candidate list per
 * field and leaves a field null when no candidate is present, rather than
 * guessing (D4). `id` requires a `uuid` (matches the one confirmed key from
 * the legacy test fixture); a doc with no `uuid` is dropped, not fabricated
 * an id for.
 */
export function parseProjectDocument(
	raw: unknown,
	projectId: string,
): ProjectDocumentRecord | null {
	if (!isRecord(raw)) {
		return null;
	}
	const id = str(raw.uuid) ?? str(raw.id);
	if (id === null) {
		return null;
	}
	const filename =
		str(raw.filename) ?? str(raw.file_name) ?? str(raw.name) ?? str(raw.title);
	const content =
		str(raw.content) ?? str(raw.text) ?? str(raw.body) ?? str(raw.filedata);
	return {
		id,
		project_id: projectId,
		filename: safeText(filename, 1024),
		content: safeText(content, 10_000_000),
		create_time: isoOrNull(raw.created_at),
		update_time: isoOrNull(raw.updated_at),
	};
}

/**
 * Parse one raw export project object (one `projects/*.json` file's
 * contents) into a `projects` record plus its `project_documents` records.
 * Field map (capability-map.json, claude.projects -> anthropic.projects +
 * anthropic.project_documents): id<-uuid, name<-title (mapped from `name`
 * per legacy normalizeProject), create_time<-created_at, update_time<-
 * updated_at, is_archived<-derived from archived_at, prompt_template<-
 * detail.prompt_template, project_documents<-detail.docs[]. `label`, `href`,
 * and the raw `detail` blob are D3/capability-map-dropped fields and are not
 * carried into either record.
 *
 * The legacy export's raw project object IS `detail` (claude-export-
 * ingest.cjs's normalizeProject sets `detail: proj || null` — the whole raw
 * object). `prompt_template` and `docs` are read directly off it.
 */
export function parseProject(raw: unknown): {
	project: ProjectRecord;
	documents: ProjectDocumentRecord[];
} | null {
	if (!isRecord(raw)) {
		return null;
	}
	const id = str(raw.uuid) ?? str(raw.id);
	if (id === null) {
		return null;
	}
	const name = str(raw.name) ?? "Untitled project";
	const docsRaw = Array.isArray(raw.docs) ? raw.docs : [];
	const documents = docsRaw
		.map((d) => parseProjectDocument(d, id))
		.filter((d): d is ProjectDocumentRecord => d !== null);

	// `name` is required (non-nullable in schemas.ts) — a control-rich name
	// cannot become null like an optional field. Fall back to the same
	// "Untitled project" sentinel already used for a missing name, rather
	// than crash the whole export over one project's unsafe title (D4-
	// adjacent: a required field that fails sanitization degrades to a safe
	// placeholder, never a thrown error).
	const safeName = pdppSafeText.safeParse(
		name.length > 2000 ? name.slice(0, 2000) : name,
	);

	return {
		project: {
			id,
			name: safeName.success
				? safeName.data
				: pdppSafeText.parse("Untitled project"),
			description: safeText(str(raw.description), 65_000),
			create_time: isoOrNull(raw.created_at),
			update_time: isoOrNull(raw.updated_at),
			// archived_at's presence/absence IS the archived signal in the export
			// (matches legacy normalizeProject's `Boolean(p?.archived_at)` exactly)
			// — a definite false, not an unknown, when the key is absent or null.
			is_archived: raw.archived_at != null,
			prompt_template: safeText(str(raw.prompt_template), 65_000),
		},
		documents,
	};
}

// ─── Multi-part manifest export (2026 format) ──────────────────────────────
//
// Anthropic's UI-driven export (observed 2026-09-22 against Tim's own
// account manifest, private copy — never committed, contains one-shot
// signed URLs) returns a JSON manifest instead of a single `{nonce}`:
//   { version: "1.0", total_files: N,
//     data_files: [{ batch_index, category, part, filename, export_url }] }
// with `category` values `light_metadata`, `projects`, `memories`,
// `design_chats`, `conversations`, each `export_url` usable exactly once,
// downloading one ZIP per category (e.g. `conversations-000.zip`).
//
// VERIFIED inner layout (this lane, offline, against the real part ZIPs at
// $PRIV/exports/anthropic/{category}-000.zip — never against export_url,
// only the already-downloaded local files; see report for the driver used):
//
//   conversations-000.zip -> ONE entry `conversations.json`, a bare array of
//     raw conversation objects. Top-level keys observed on every element:
//     `uuid`, `name`, `summary`, `created_at`, `updated_at`, `account` (an
//     `{uuid}` object, NOT `project_uuid` — no account ever had a
//     `project_uuid` key in this export), `chat_messages[]`. `is_starred`
//     was NOT observed as a key on any element in this export (the field
//     the capability map's `starred` maps from does not appear at all here;
//     see CONTRACT-CHANGE-REQUEST candidate below — kept nullable, never
//     guessed). Each `chat_messages[]` element: `uuid`, `text`, `content[]`,
//     `sender` (`"human"`/`"assistant"`), `created_at`, `updated_at`,
//     `attachments`, `files` (unmapped, D3 dropped — not in the capability
//     map's field_map), `parent_message_uuid`. Exactly matches this parser's
//     pre-existing `chat_messages`/`sender`/`parent_message_uuid` field
//     names — no parser change required for this category.
//   projects-000.zip -> one JSON entry per project at
//     `projects/<uuid>.json`, each a bare top-level object (NOT wrapped in a
//     `detail` sub-object): `uuid`, `name`, `description`, `created_at`,
//     `updated_at`, `creator` ({uuid, full_name} — not in the capability
//     map's field_map, D3 dropped), `is_private`, `is_starter_project`,
//     `prompt_template`, `docs[]`. No project in this export ever carried an
//     `archived_at` key. `docs[]` elements: `uuid`, `filename`, `content`,
//     `created_at` — these are the exact first-priority candidates
//     `parseProjectDocument` already reads; the other defensive candidates
//     (`file_name`, `name`, `title`, `text`, `body`, `filedata`) were never
//     observed and can be treated as dead fallbacks pending a differently-
//     shaped account.
//   memories-000.zip -> ONE entry per account at `memories/<uuid>.json`, a
//     bare object `{ account_uuid, conversations_memory, memory_files[] }`.
//     `conversations_memory` is a single free-text markdown string (not an
//     array of discrete memory items); `memory_files[]` elements are
//     `{ path, content, updated_at }` (a virtual file tree of memory notes).
//     This shape has NO capability-map stream — see CONTRACT-CHANGE-REQUEST.
//   design_chats-000.zip -> one JSON entry per design chat at
//     `design_chats/<uuid>.json`: `uuid`, `title`, `created_at`,
//     `updated_at`, `project` ({uuid, name}), `messages[]` (NOT
//     `chat_messages` — a different key name from the conversations
//     category). `messages[]` elements: `uuid`, `role` (NOT `sender`),
//     `content`, `created_at`. This is conversation-SHAPED but uses
//     different field names than `conversations`/`chat_messages`, so
//     `looksLikeConversation`'s `chat_messages` check correctly does NOT
//     match it — these are a distinct sub-product (Claude's Artifacts/
//     "design" chat surface) with no capability-map stream. See
//     CONTRACT-CHANGE-REQUEST.
//   light_metadata-000.zip -> `users.json`, `login_history.json`. Only the
//     display name from `users.json` may reach account_profile when its
//     ownership is unambiguous. Login history is never emitted.
//
// Because `memories` and `design_chats` have no capability-map stream,
// `classifyManifestPartEntries` below classifies by MANIFEST CATEGORY
// first (an out-of-scope category never enters the conversation/project
// content-shape classifier at all, so its real per-item field names can
// never accidentally satisfy `looksLikeConversation`/`looksLikeProject` by
// coincidence), then applies content-shape classification only to
// `conversations` and `projects` category parts. `light_metadata` contributes
// only users.json to account_profile. Every other out-of-scope entry is reported back
// via `outOfScopeEntryNames` (grouped by category) so index.ts can log an
// honest "N entries in category X are out of this connector's declared
// scope" PROGRESS line — never silently dropped without a trace, but also
// never miscategorized as an unexplained parse failure.

export interface ManifestPartFile {
	/** Entry name inside the part ZIP (e.g. "conversations.json" or
	 * "projects/<uuid>.json" — verified, see module note above). */
	name: string;
	json: unknown;
}

export interface ClassifiedManifestPart {
	category: string;
	conversations: unknown[];
	projects: unknown[];
	userProfiles: unknown[];
	/** Entries not used by declared streams, including login_history.json —
	 * expected, not an anomaly. */
	outOfScopeEntryNames: string[];
	/** Entries from an in-scope category (`conversations`, `projects`) whose
	 * content matched neither known shape — a real anomaly, surfaced via
	 * PROGRESS, never silently dropped. */
	unclassifiedEntryNames: string[];
}

/** Resolve a display name only when the browser profile belongs to this export. */
export function resolveExportedProfile(
	userFiles: readonly unknown[],
	browserName: string | null,
	browserProfileAppliesToExport: boolean,
): {
	fullName: string | null;
	nameSource: "browser_menu" | "users_json" | "none";
	metadataStatus: "valid" | "absent" | "malformed" | "ambiguous" | "mismatch";
} {
	const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
		typeof candidate === "object" &&
		candidate !== null &&
		!Array.isArray(candidate);
	const browserFallback = (
		metadataStatus: "absent" | "malformed" | "ambiguous" | "mismatch",
	) => ({
		fullName:
			browserProfileAppliesToExport &&
			(metadataStatus === "absent" || metadataStatus === "malformed")
				? browserName
				: null,
		nameSource:
			browserProfileAppliesToExport &&
			browserName &&
			(metadataStatus === "absent" || metadataStatus === "malformed")
				? ("browser_menu" as const)
				: ("none" as const),
		metadataStatus,
	});
	if (userFiles.length === 0) return browserFallback("absent");
	if (userFiles.length !== 1) return browserFallback("ambiguous");
	const value = userFiles[0];
	const users = Array.isArray(value)
		? value
		: isObject(value) && Array.isArray(value.users)
			? value.users
			: isObject(value)
				? [value]
				: null;
	if (!users || users.length === 0) return browserFallback("malformed");
	if (users.length !== 1) return browserFallback("ambiguous");
	const user = users[0];
	if (
		!isObject(user) ||
		typeof user.full_name !== "string" ||
		!user.full_name.trim()
	) {
		return browserFallback("malformed");
	}
	const exportedName = user.full_name.trim();
	if (browserName && browserName !== exportedName)
		return browserFallback("mismatch");
	// A single roster entry or a matching display name cannot link a resumed
	// export to the current browser account.
	const attributableBrowserName =
		browserProfileAppliesToExport && browserName === exportedName
			? browserName
			: null;
	return {
		fullName: attributableBrowserName,
		nameSource: attributableBrowserName ? "browser_menu" : "none",
		metadataStatus: "valid",
	};
}

/** Manifest `category` values this connector has a stream for. Any other
 * category (including ones not yet observed) is out-of-scope by default —
 * an allowlist, not a denylist, so a new unrecognized category never
 * silently flows into content-shape classification. */
const IN_SCOPE_CATEGORIES = new Set(["conversations", "projects"]);

function looksLikeConversation(v: unknown): boolean {
	return isRecord(v) && Array.isArray(v.chat_messages);
}

function looksLikeProject(v: unknown): boolean {
	return (
		isRecord(v) && ("docs" in v || "prompt_template" in v || "archived_at" in v)
	);
}

/**
 * Classify one manifest part's extracted JSON entries. Category first
 * (`memories`/`design_chats`/anything else undeclared -> out-of-scope;
 * `light_metadata` contributes only users.json), then content shape for
 * `conversations`/`projects` categories (see module note above for why
 * content shape, not filename, is still the dispatch within an in-scope
 * category — an in-scope category ZIP can, in principle, mix shapes).
 */
export function classifyManifestPartEntries(
	category: string,
	entries: readonly ManifestPartFile[],
): ClassifiedManifestPart {
	const conversations: unknown[] = [];
	const projects: unknown[] = [];
	const userProfiles: unknown[] = [];
	const outOfScopeEntryNames: string[] = [];
	const unclassifiedEntryNames: string[] = [];

	if (category === "light_metadata") {
		for (const entry of entries) {
			if (entry.name === "users.json") userProfiles.push(entry.json);
			else outOfScopeEntryNames.push(entry.name);
		}
		return {
			category,
			conversations,
			projects,
			userProfiles,
			outOfScopeEntryNames,
			unclassifiedEntryNames,
		};
	}

	if (!IN_SCOPE_CATEGORIES.has(category)) {
		for (const entry of entries) {
			outOfScopeEntryNames.push(entry.name);
		}
		return {
			category,
			conversations,
			projects,
			userProfiles,
			outOfScopeEntryNames,
			unclassifiedEntryNames,
		};
	}

	for (const entry of entries) {
		const items = Array.isArray(entry.json) ? entry.json : [entry.json];
		let matchedAny = false;
		for (const item of items) {
			if (looksLikeConversation(item)) {
				conversations.push(item);
				matchedAny = true;
			} else if (looksLikeProject(item)) {
				projects.push(item);
				matchedAny = true;
			}
		}
		if (!matchedAny) {
			unclassifiedEntryNames.push(entry.name);
		}
	}

	return {
		category,
		conversations,
		projects,
		userProfiles,
		outOfScopeEntryNames,
		unclassifiedEntryNames,
	};
}

// ─── Whole-archive parse ─────────────────────────────────────────────────

export interface ParsedExport {
	conversations: ConversationRecord[];
	messages: MessageRecord[];
	projects: ProjectRecord[];
	projectDocuments: ProjectDocumentRecord[];
}

/**
 * Parse the export archive's two JSON inputs into every stream's records.
 * `conversationsJson` is the parsed contents of `conversations.json` (a bare
 * array); `projectFiles` is one parsed JSON value per `projects/*.json`
 * entry found in the archive. Pure — no I/O; index.ts reads the archive
 * bytes via bounded-zip-archive.ts and passes the parsed JSON here.
 */
export function parseExport(
	conversationsJson: unknown,
	projectFiles: readonly unknown[],
): ParsedExport {
	const conversations: ConversationRecord[] = [];
	const messages: MessageRecord[] = [];
	const rawConversations = Array.isArray(conversationsJson)
		? conversationsJson
		: [];
	for (const rawConv of rawConversations) {
		const parsed = parseConversation(rawConv);
		if (!parsed) {
			continue;
		}
		conversations.push(parsed.conversation);
		messages.push(...parsed.messages);
	}

	const projects: ProjectRecord[] = [];
	const projectDocuments: ProjectDocumentRecord[] = [];
	for (const rawProject of projectFiles) {
		const parsed = parseProject(rawProject);
		if (!parsed) {
			continue;
		}
		projects.push(parsed.project);
		projectDocuments.push(...parsed.documents);
	}

	return { conversations, messages, projectDocuments, projects };
}

/**
 * Same as `parseExport`, but for the multi-part manifest format: takes
 * already-classified raw conversation/project objects (pooled across
 * however many category parts contributed them — see
 * `classifyManifestPartEntries`) instead of the old format's
 * `conversationsJson` bare-array + `projectFiles` per-file split. The
 * underlying per-item field mapping is identical; only how the raw items
 * were extracted from the archive differs.
 */
export function parseClassifiedExport(
	rawConversations: readonly unknown[],
	rawProjects: readonly unknown[],
): ParsedExport {
	return parseExport(rawConversations, rawProjects);
}

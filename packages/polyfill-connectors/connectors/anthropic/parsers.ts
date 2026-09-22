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
 * UNCONFIRMED (real-fixture proof pending — see cut-anthropic report):
 * the exact field names inside a project's `docs[]` array. The legacy test
 * fixture (`exportProject.docs: [{ uuid: 'd1' }]`) only proves a `uuid` key
 * exists; `CLAUDE_CONNECTOR_PLAN.md` names a `project_files_list` API
 * endpoint (suggesting docs carry a filename) but no captured payload names
 * the exact keys. This parser reads a defensive superset of candidate key
 * names (documented per-field below) and leaves a field `null` when none of
 * its candidates are present, rather than guessing a value (D4: unparseable
 * -> null, never guessed).
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

function safeText(v: unknown, max: number): PdppSafeText | null {
	const s = str(v);
	if (s === null) {
		return null;
	}
	return nullablePdppSafeText.parse(s.length > max ? s.slice(0, max) : s);
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

	return {
		project: {
			id,
			name: pdppSafeText.parse(name.length > 2000 ? name.slice(0, 2000) : name),
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

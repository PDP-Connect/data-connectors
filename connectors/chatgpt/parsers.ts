// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the ChatGPT connector. Kept free of Playwright / network
// I/O so they can be unit-tested in isolation (see parsers.test.ts). The
// browser-context auth, API client, and the collect() orchestrator live in
// index.ts.

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type {
	ChatGptContent,
	ChatGptMessage,
	ChatGptNode,
	ConversationListItem,
	RawAccountEntry,
	RawAccountsCheckBody,
	RawCustomInstructionsBody,
	RawGizmo,
	RawGizmoWrapper,
	RawMemoryEntry,
	RawSharedConversation,
	ToolCallSynthetic,
} from "./types.ts";

// ─── Time normalisation ────────────────────────────────────────────────

/**
 * ChatGPT times are unix seconds (number). Some responses use ISO strings.
 * Normalize both to ISO-8601; swallow malformed inputs.
 *
 * A non-positive epoch is a sentinel for "no time", not the instant
 * 1970-01-01 — returning null keeps "unknown" falsifiable downstream instead
 * of sorting a timeless record to the beginning of time.
 */
export function tsToIso(v: unknown): string | null {
	if (v === null || v === undefined) {
		return null;
	}
	try {
		if (typeof v === "number" && Number.isFinite(v)) {
			if (v <= 0) {
				return null;
			}
			const d = new Date(v * 1000);
			return Number.isNaN(d.getTime()) ? null : d.toISOString();
		}
		if (typeof v === "string") {
			const d = new Date(v);
			return Number.isNaN(d.getTime()) ? null : d.toISOString();
		}
	} catch {
		/* swallow */
	}
	return null;
}

// ─── Conversation tree walk ────────────────────────────────────────────

export interface FlattenedNode {
	node: ChatGptNode;
	nodeId: string;
}

/**
 * Walk the conversation tree from `currentNodeId` up to the root, then
 * reverse so the returned list is ordered root→tip along the current branch.
 */
export function flattenTreeCurrentBranch(
	mapping: Record<string, ChatGptNode>,
	currentNodeId: string | null | undefined,
): FlattenedNode[] {
	const orderedRootToTip: string[] = [];
	let id: string | null | undefined = currentNodeId;
	const visited = new Set<string>();
	while (id && !visited.has(id) && mapping[id]) {
		visited.add(id);
		orderedRootToTip.push(id);
		id = mapping[id]?.parent ?? null;
	}
	orderedRootToTip.reverse();
	return orderedRootToTip.map((nodeId) => {
		const node = mapping[nodeId];
		if (!node) {
			// visited.has + mapping[id] guard above guarantees presence.
			throw new Error(`flattenTreeCurrentBranch: missing node ${nodeId}`);
		}
		return { nodeId, node };
	});
}

// ─── extractContent per-content_type helpers ──────────────────────────
//
// Memory bound of extraction. The extractors below build the whole body: an
// array with one entry per part, and a joined string. Transient memory is
// O(source payload size + part count); the constants depend on the part format
// and the JS engine's string representation (references, ropes, flattening),
// so no tighter factor is claimed. Extraction is NOT cut short at the inline cap: a blob needs the
// full text, and the cap decision uses `escapedLengthExceeds` on the result.
// Oversize text is not retained per candidate (a blob-backed message re-extracts
// it once to measure and once to spool, see message-blob.ts); inline content is
// retained by design, at most the inline cap per message.

/**
 * Join the string entries of a `parts[]` array with "\n". Non-string entries
 * (asset pointers, nested objects) are left out of the join, and are kept
 * whole in `non_string_parts` (`extractNonStringParts`); empty strings are
 * kept, so the result equals the legacy collector's
 * `parts.filter(p => typeof p === "string").join("\n")`. A body whose joined
 * text is empty yields null, so the message is omitted as the legacy one is.
 */
function joinStringParts(content: ChatGptContent): string | null {
	const parts = Array.isArray(content.parts) ? content.parts : [];
	const s = parts.filter((p): p is string => typeof p === "string").join("\n");
	return s || null;
}

/** Canonical user/assistant text: `{ parts: ["...", ...] }`. */
function extractTextContent(content: ChatGptContent): string | null {
	return joinStringParts(content);
}

/** Multimodal variant: same string-parts join as `text`. */
function extractMultimodalContent(content: ChatGptContent): string | null {
	return joinStringParts(content);
}

/** Assistant-authored tool call bodies: `{ content_type: "code", language, text }`. */
function extractCodeContent(content: ChatGptContent): string | null {
	const body = typeof content.text === "string" ? content.text : "";
	const lang = content.language ? String(content.language) : "";
	if (!(body || lang)) {
		return null;
	}
	return lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : body;
}

/**
 * Reasoning summaries (GPT-5 thinking traces):
 * `{ content_type: "thoughts", thoughts: [{summary, content}], source_analysis_msg_id? }`.
 */
function extractThoughtsContent(content: ChatGptContent): string | null {
	const thoughts = Array.isArray(content.thoughts) ? content.thoughts : [];
	const s = thoughts.map(stringifyThought).filter(Boolean).join("\n\n");
	return s || null;
}

function stringifyThought(t: unknown): string {
	if (!t || typeof t !== "object") {
		return "";
	}
	const to = t as { content?: unknown; summary?: unknown };
	const summary = typeof to.summary === "string" ? to.summary : "";
	const body = typeof to.content === "string" ? to.content : "";
	if (summary && body) {
		return `${summary}\n${body}`;
	}
	return summary || body || "";
}

/** `{ content_type: "reasoning_recap", content: "..." }` (some variants use `text`). */
function extractReasoningRecap(content: ChatGptContent): string | null {
	if (typeof content.content === "string") {
		return content.content || null;
	}
	if (typeof content.text === "string") {
		return content.text || null;
	}
	return null;
}

/** `{ content_type: "tether_browsing_display", result, summary, ... }`. */
function extractTetherBrowsingDisplay(content: ChatGptContent): string | null {
	const pieces: string[] = [];
	if (typeof content.summary === "string" && content.summary) {
		pieces.push(content.summary);
	}
	if (typeof content.result === "string" && content.result) {
		pieces.push(content.result);
	}
	const s = pieces.join("\n\n");
	return s || null;
}

/** `{ content_type: "tether_quote", url, domain?, text, title }`. */
function extractTetherQuote(content: ChatGptContent): string | null {
	const pieces: string[] = [];
	if (content.title) {
		pieces.push(String(content.title));
	}
	if (content.url) {
		pieces.push(String(content.url));
	}
	if (typeof content.text === "string" && content.text) {
		pieces.push(content.text);
	}
	const s = pieces.join("\n");
	return s || null;
}

/** Python / code-interpreter stdout: `{ content_type: "execution_output", text }`. */
function extractExecutionOutput(content: ChatGptContent): string | null {
	if (typeof content.text === "string") {
		return content.text || null;
	}
	return null;
}

/**
 * "Bio"/memory + custom instructions + connected-repo context:
 * `{ content_type: "model_editable_context", model_set_context, repository?, repo_summary? }`.
 */
function extractModelEditableContext(content: ChatGptContent): string | null {
	const pieces: string[] = [];
	if (
		typeof content.model_set_context === "string" &&
		content.model_set_context
	) {
		pieces.push(content.model_set_context);
	}
	if (typeof content.repository === "string" && content.repository) {
		pieces.push(`repository: ${content.repository}`);
	}
	if (typeof content.repo_summary === "string" && content.repo_summary) {
		pieces.push(content.repo_summary);
	}
	const s = pieces.join("\n\n");
	return s || null;
}

/** Observed but undocumented: system-level error shape. */
function extractSystemError(content: ChatGptContent): string | null {
	const pieces: string[] = [];
	if (content.name) {
		pieces.push(String(content.name));
	}
	if (typeof content.text === "string" && content.text) {
		pieces.push(content.text);
	}
	return pieces.join(": ") || null;
}

/** User custom-instructions shape (observed on imported conversations). */
function extractUserEditableContext(content: ChatGptContent): string | null {
	const pieces: string[] = [];
	if (typeof content.user_profile === "string" && content.user_profile) {
		pieces.push(content.user_profile);
	}
	if (
		typeof content.user_instructions === "string" &&
		content.user_instructions
	) {
		pieces.push(content.user_instructions);
	}
	return pieces.join("\n\n") || null;
}

// Fallback for unrecognized shape — prefer an explicit handler. Stringify so
// *something* lands rather than null; extractContentParts truncates it to
// keep rows sane and flags it `sourceUnrepresentable`.
const FALLBACK_MAX_CHARS = 5000;

function extractFallback(content: ChatGptContent): string | null {
	try {
		const s = JSON.stringify(content);
		if (!s || s === "{}" || s === "null") {
			return null;
		}
		return s;
	} catch {
		return null;
	}
}

// Dispatch table keeps extractContent a tiny switch-by-lookup: the many
// per-content_type branches live as named helpers above.
const CONTENT_EXTRACTORS: Readonly<
	Record<string, (c: ChatGptContent) => string | null>
> = {
	code: extractCodeContent,
	execution_output: extractExecutionOutput,
	model_editable_context: extractModelEditableContext,
	multimodal_text: extractMultimodalContent,
	reasoning_recap: extractReasoningRecap,
	system_error: extractSystemError,
	tether_browsing_display: extractTetherBrowsingDisplay,
	tether_quote: extractTetherQuote,
	text: extractTextContent,
	thoughts: extractThoughtsContent,
	user_editable_context: extractUserEditableContext,
};

// The `pdpp-safe-escape-v1` text encoding (declared on `messages.content` in the
// manifest). The escaped set is FIXED so a reader can mirror it without the
// validator: U+0000-0008, U+000B, U+000C, U+000E-001F, U+007F-009F (the C0/C1
// controls PDPP text forbids; tab, LF and CR are allowed) and lone surrogates
// (not UTF-8 encodable). Noncharacters (U+FDD0.., U+xFFFE/xFFFF on every plane)
// and valid surrogate pairs are ordinary scalar values and pass through. The
// `u` flag keeps valid surrogate pairs whole so only lone ones match. The first
// alternative finds a source backslash that starts something the decoder would
// read as an escape.
const ESCAPE_SCAN =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escaped set is exactly these control code units.
	/\\u([0-9a-fA-F]{4})|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ud800-\udfff]/gu;
const ESCAPE_TOKEN = /\\u([0-9a-fA-F]{4})/g;
const BACKSLASH_UNIT = 0x5c;

/** Code units the encoding writes as `\uXXXX`: forbidden controls, lone surrogates and backslash. */
export function isEscapedUnit(unit: number): boolean {
	return (
		unit === BACKSLASH_UNIT ||
		unit <= 0x08 ||
		unit === 0x0b ||
		unit === 0x0c ||
		(unit >= 0x0e && unit <= 0x1f) ||
		(unit >= 0x7f && unit <= 0x9f) ||
		(unit >= 0xd8_00 && unit <= 0xdf_ff)
	);
}

function escapeSequence(unit: number): string {
	return `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Each position of `s` that the encoding rewrites, and the code unit it writes. */
function* escapeSites(s: string): Generator<{ index: number; unit: number }> {
	for (const match of s.matchAll(ESCAPE_SCAN)) {
		const hex = match[1];
		const index = match.index ?? 0;
		if (hex === undefined) {
			yield { index, unit: match[0].charCodeAt(0) };
		} else if (isEscapedUnit(Number.parseInt(hex, 16))) {
			yield { index, unit: BACKSLASH_UNIT };
		}
	}
}

/**
 * Lossless, deterministic PDPP-safe encoding of message text (documented on the
 * `messages.content` field in the manifest). Each escaped unit becomes `\uXXXX`
 * (uppercase hex). A source backslash that begins a `\uXXXX` the decoder would
 * read as an escape is itself written `\u005C`, so decoding is unambiguous. All
 * other text, including ordinary backslashes, is unchanged.
 */
export function encodePdppSafeText(s: string): string {
	const parts: string[] = [];
	let last = 0;
	for (const { index, unit } of escapeSites(s)) {
		parts.push(s.slice(last, index), escapeSequence(unit));
		last = index + 1;
	}
	if (parts.length === 0) return s;
	parts.push(s.slice(last));
	return parts.join("");
}

/** Inverse of the content encoding: restores the exact source text. */
export function decodeEscapedText(s: string): string {
	return s.replace(ESCAPE_TOKEN, (match, hex: string) => {
		const unit = Number.parseInt(hex, 16);
		return isEscapedUnit(unit) ? String.fromCharCode(unit) : match;
	});
}

// The messages schema caps inline `content` at `largeText.max(1_048_576)`
// chars (schemas.ts). A longer body is not truncated: the caller moves the full
// text into a Core blob and the record carries `blob_ref` with null `content`.
const CONTENT_MAX_CHARS = 1_048_576;

/**
 * Whether the escaped form of `raw` is longer than `cap`, decided without
 * building it. Each escape adds five characters, so the length is
 * `raw.length + 5 * sites`; the scan stops once that passes `cap`, and a `raw`
 * already longer than `cap` is not scanned at all.
 */
export function escapedLengthExceeds(
	raw: string,
	cap: number = CONTENT_MAX_CHARS,
): { exceeds: boolean; sitesVisited: number } {
	if (raw.length > cap) return { exceeds: true, sitesVisited: 0 };
	let length = raw.length;
	let sitesVisited = 0;
	for (const _site of escapeSites(raw)) {
		sitesVisited += 1;
		length += 5;
		if (length > cap) return { exceeds: true, sitesVisited };
	}
	return { exceeds: false, sitesVisited };
}

export interface ExtractedContent {
	/** Source text before escaping; what a blob stores for an oversize body. */
	raw: string | null;
	/**
	 * True only when the unknown-shape fallback cut the body: those bytes are
	 * gone for good and the record cannot carry them (see
	 * source-unrepresentable.ts).
	 */
	sourceUnrepresentable: boolean;
}

/**
 * Extract the source text of a ChatGPT message content object. ChatGPT has many
 * content_type shapes; the previous implementation only handled `text` and
 * silently returned null for everything else (67% of records). Each branch
 * returns a string; we return null only if the payload is truly empty.
 *
 * The only lossy path is the unknown-shape fallback, reported through
 * `sourceUnrepresentable`. Escaping is a separate, lazy step so an oversize
 * body never gets an escaped copy.
 */
export function extractContentParts(
	content: ChatGptContent | undefined,
): ExtractedContent {
	if (!content || typeof content !== "object") {
		return { raw: null, sourceUnrepresentable: false };
	}
	const type = content.content_type;
	const handler = type ? CONTENT_EXTRACTORS[type] : undefined;
	let raw = handler ? handler(content) : extractFallback(content);
	const sourceUnrepresentable =
		!handler && raw !== null && raw.length > FALLBACK_MAX_CHARS;
	if (sourceUnrepresentable && raw !== null) {
		raw = `${raw.slice(0, FALLBACK_MAX_CHARS)}…`;
	}
	return { raw, sourceUnrepresentable };
}

/** PDPP-safe full text (see the encoding above); never truncated. */
export function extractContent(
	content: ChatGptContent | undefined,
): string | null {
	const { raw } = extractContentParts(content);
	return raw === null ? null : encodePdppSafeText(raw);
}

// ─── Tool calls ─────────────────────────────────────────────────────────

/**
 * Encode every string inside a tool_calls value with pdpp-safe-escape-v1, at any
 * depth: array items, object values, and object keys (a key holding a forbidden
 * code unit is escaped like any other string). Numbers, booleans and null are
 * unchanged. The walk is iterative and builds own data properties. One rule for
 * every entry, whether synthesized here or copied from the source's
 * `metadata.tool_calls`.
 */
export function encodeToolCallStrings(value: unknown): unknown {
	if (typeof value === "string") return encodePdppSafeText(value);
	if (typeof value !== "object" || value === null) return value;
	// Iterative, so nesting depth is not limited by the engine's call stack.
	// Each container is created before its children are filled in.
	const root = Array.isArray(value) ? new Array(value.length) : {};
	const work: Array<{ from: object; to: object }> = [{ from: value, to: root }];
	for (let item = work.pop(); item; item = work.pop()) {
		const { from, to } = item;
		const place = (key: string | number, inner: unknown): void => {
			let placed: unknown = inner;
			if (typeof inner === "string") {
				placed = encodePdppSafeText(inner);
			} else if (typeof inner === "object" && inner !== null) {
				placed = Array.isArray(inner) ? new Array(inner.length) : {};
				work.push({ from: inner, to: placed as object });
			}
			if (Array.isArray(to)) {
				to[key as number] = placed;
			} else {
				// An own data property, so a "__proto__" key is kept as data and
				// never reaches the prototype setter.
				Object.defineProperty(to, encodePdppSafeText(String(key)), {
					configurable: true,
					enumerable: true,
					value: placed,
					writable: true,
				});
			}
		};
		if (Array.isArray(from)) {
			// forEach skips holes and keeps an explicit undefined, so the
			// destination (created with the source length) has the same holes.
			from.forEach((inner, index) => {
				place(index, inner);
			});
		} else {
			for (const [key, inner] of Object.entries(from)) place(key, inner);
		}
	}
	return root;
}

/**
 * Derive tool_calls for a message. ChatGPT does not emit an OpenAI-API-style
 * `tool_calls` array on assistant messages; instead, the model "addresses" a
 * tool via `message.recipient` (e.g. "python", "browser.search", "bio") and
 * the content body carries the call. Synthesize a normalized array.
 *
 * `contentExternal` is true when the message's `content` is blob-backed or
 * omitted. The synthesized call then carries `text_ref: "content"` instead of
 * `text`, so a multi-megabyte body is stored once at most. A synthesized call
 * has exactly one of `text` and `text_ref`.
 *
 * Every string in the result is pdpp-safe-escape-v1 encoded (see
 * `encodeToolCallStrings`).
 */
export function extractToolCalls(
	m: ChatGptMessage | undefined,
	contentExternal = false,
): unknown[] {
	return encodeToolCallStrings(
		synthesizeToolCalls(m, contentExternal),
	) as unknown[];
}

function synthesizeToolCalls(
	m: ChatGptMessage | undefined,
	contentExternal: boolean,
): unknown[] {
	// Some API shapes do include an explicit list.
	if (Array.isArray(m?.metadata?.tool_calls) && m.metadata.tool_calls.length) {
		return m.metadata.tool_calls;
	}
	const recipient = typeof m?.recipient === "string" ? m.recipient : null;
	const role = m?.author?.role;
	// Assistant messages addressed to a specific tool = a tool call.
	if (role === "assistant" && recipient && recipient !== "all") {
		const call: ToolCallSynthetic = { recipient };
		if (m?.content?.content_type) {
			call.content_type = m.content.content_type;
		}
		if (typeof m?.content?.language === "string") {
			call.language = m.content.language;
		}
		if (typeof m?.content?.text === "string") {
			if (contentExternal) {
				call.text_ref = "content";
			} else {
				call.text = m.content.text;
			}
		}
		if (m?.metadata?.invoked_plugin) {
			call.invoked_plugin = m.metadata.invoked_plugin;
		}
		assertSynthesizedCall(call);
		return [call];
	}
	// Plugin invocation metadata without an explicit tool_calls array.
	if (m?.metadata?.invoked_plugin) {
		return [{ invoked_plugin: m.metadata.invoked_plugin }];
	}
	return [];
}

/** The synthesized-call invariant: `text_ref` is "content" and excludes `text`. */
export function assertSynthesizedCall(call: ToolCallSynthetic): void {
	if (
		call.text_ref !== undefined &&
		(call.text_ref !== "content" || call.text !== undefined)
	) {
		throw new Error(
			'synthesized tool call: text_ref must be "content" and exclude text',
		);
	}
}

// ─── Message record ─────────────────────────────────────────────────────

export interface ExtractedMessage {
	/**
	 * True when the escaped text is over the inline cap: `record.content` is then
	 * null and the caller decides blob, or omission of the field. The text is
	 * re-derived on demand with `extractRawMessageText`, not carried here.
	 */
	oversize: boolean;
	record: RecordData | null;
	/** See `ExtractedContent.sourceUnrepresentable`. */
	sourceUnrepresentable: boolean;
}

/**
 * The entries of a `text` or `multimodal_text` body's `parts` that are not
 * strings (asset pointers with their size and generation metadata, audio
 * transcripts, any other object), each as `{ index, part }` with its position in
 * `parts`. `content` joins only the string parts, as the legacy collector does,
 * so this field is where the rest of the body lives; an earlier collector wrote
 * their `text` and `[asset:<pointer>]` markers into `content`, and the
 * pointer and text are still here. Strings at any depth are
 * pdpp-safe-escape-v1 encoded.
 */
export function extractNonStringParts(
	content: ChatGptContent | undefined,
): unknown[] {
	if (
		content?.content_type !== "text" &&
		content?.content_type !== "multimodal_text"
	) {
		return [];
	}
	const kept: { index: number; part: unknown }[] = [];
	for (const [index, part] of (Array.isArray(content.parts)
		? content.parts
		: []
	).entries()) {
		if (typeof part !== "string") kept.push({ index, part: part ?? null });
	}
	return encodeToolCallStrings(kept) as unknown[];
}

/** The source text of a message node, before escaping. */
export function extractRawMessageText(node: ChatGptNode): string | null {
	return extractContentParts(node.message?.content).raw;
}

export function extractMessageWithBlob(
	nodeId: string,
	node: ChatGptNode,
	conversationId: string,
	onCurrentBranch: boolean,
): ExtractedMessage {
	const m = node.message;
	if (!m) {
		return { oversize: false, record: null, sourceUnrepresentable: false };
	}
	const { raw, sourceUnrepresentable } = extractContentParts(m.content);
	const oversize = raw !== null && escapedLengthExceeds(raw).exceeds;
	return {
		oversize,
		sourceUnrepresentable,
		record: {
			id: nodeId,
			conversation_id: conversationId,
			parent_id: node.parent ?? null,
			children_ids: node.children ?? [],
			role: m.author?.role ?? null,
			content:
				oversize || raw === null ? null : encodePdppSafeText(raw) || null,
			non_string_parts: extractNonStringParts(m.content),
			content_type: m.content?.content_type ?? null,
			model_slug: m.metadata?.model_slug ?? null,
			create_time: tsToIso(m.create_time),
			finish_reason:
				m.end_turn === false
					? "tool_calls"
					: (m.metadata?.finish_details?.type ?? null),
			citations: m.metadata?.citations ?? [],
			tool_calls: extractToolCalls(m, oversize),
			attachment_ids: (m.metadata?.attachments ?? [])
				.map((a) => a.id)
				.filter(Boolean),
			on_current_branch: onCurrentBranch,
		},
	};
}

/**
 * The `id` of a `messages` record: the conversation id and the source node id
 * joined by ":". ChatGPT reuses a node id in several conversations (forks and
 * branches copy nodes), so a node id names a message only within its
 * conversation, and the record id has to carry both. ChatGPT conversation ids
 * are UUIDs and never contain ":", so the pair is recoverable.
 */
export function messageRecordId(
	conversationId: string,
	nodeId: string,
): string {
	return `${conversationId}:${nodeId}`;
}

/**
 * The wire form of a message extracted by `extractMessageWithBlob`: that record
 * names messages by the source's node ids, which is how the rest of the
 * collector walks the tree. On the wire `id`, `parent_id` and `children_ids`
 * are record ids (`messageRecordId`), so each of them names a `messages`
 * record, and `node_id` keeps the source node id.
 */
export function toMessageRecord(
	record: RecordData,
	conversationId: string,
): RecordData {
	const scope = (nodeId: unknown) =>
		typeof nodeId === "string" ? messageRecordId(conversationId, nodeId) : null;
	const ownId = scope(record.id);
	return {
		...record,
		...(ownId === null ? {} : { id: ownId, node_id: record.id as string }),
		parent_id: scope(record.parent_id),
		children_ids: Array.isArray(record.children_ids)
			? record.children_ids.map((child) => scope(child) ?? child)
			: [],
	};
}

export function extractMessage(
	nodeId: string,
	node: ChatGptNode,
	conversationId: string,
	onCurrentBranch: boolean,
): RecordData | null {
	return extractMessageWithBlob(nodeId, node, conversationId, onCurrentBranch)
		.record;
}

// ─── Memories ───────────────────────────────────────────────────────────

export function buildMemoryRecord(m: RawMemoryEntry): RecordData | null {
	if (m.id === undefined) {
		return null;
	}
	return {
		id: m.id,
		content: m.content || m.name || "",
		created_at:
			tsToIso(m.created_at) ??
			tsToIso(m.createdAt) ??
			tsToIso(m.created_timestamp),
		updated_at: m.updated_at || m.updatedAt || null,
		type: m.type || null,
	};
}

// ─── Custom GPTs (gizmos) ───────────────────────────────────────────────

/** A candidate counts only if it's a plain object — arrays don't carry gizmo fields under any observed wrapper shape. */
function isWrapperCandidate(value: unknown): value is RawGizmo {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * /gizmos/mine returns one of several wrapper shapes per item, in priority order:
 *   { resource: { gizmo: {...} } }   (newer)
 *   { gizmo: {...} }                 (rarer)
 *   { info: {...}, list: {...} }     (live shape drift, run_1786417045973 —
 *                                      `list` is listing-only metadata, e.g.
 *                                      is_starred; intentionally not read)
 *   { resource: {...} }              (some tenants)
 *   {...} flat                        (oldest)
 * Picks the first *object-valued* candidate so a malformed/scalar higher-priority
 * field can't mask a valid lower-priority one.
 */
export function unwrapGizmo(raw: unknown): RawGizmo | null {
	const rawObj = raw as RawGizmoWrapper | null | undefined;
	if (!rawObj || typeof rawObj !== "object") {
		return null;
	}
	const resourceGizmo = (
		rawObj.resource as { gizmo?: unknown } | null | undefined
	)?.gizmo;
	const resourceFlat = rawObj.resource as unknown;
	const { gizmo: direct, info } = rawObj;
	const candidates = [resourceGizmo, direct, info, resourceFlat, raw];
	return candidates.find(isWrapperCandidate) ?? null;
}

/** Pick `is_public` from the boolean flag or from the string `sharing` enum. */
export function resolveGizmoIsPublic(g: RawGizmo): boolean | null {
	if (typeof g.is_public === "boolean") {
		return g.is_public;
	}
	if (typeof g.sharing === "string") {
		return g.sharing === "public";
	}
	return null;
}

/** Normalize an entry in gizmo.config.tools to a string tag (or null to drop). */
function toolTagOf(t: unknown): string | null {
	if (typeof t === "string") {
		return t;
	}
	const to = t as { name?: unknown; type?: unknown };
	return (to?.type || to?.name || null) as string | null;
}

export function buildGizmoRecord(raw: unknown): RecordData | null {
	const g = unwrapGizmo(raw);
	if (!g?.id) {
		return null;
	}
	const display = g.display || {};
	const config = g.config || {};
	const author = g.author || g.owner || {};
	const toolsRaw = Array.isArray(config.tools) ? config.tools : [];
	const tools = toolsRaw.map(toolTagOf).filter(Boolean);
	const tagsRaw = g.tags || display.tags || [];
	return {
		id: g.id,
		short_url: g.short_url || g.shortcode || null,
		display_name: display.name || g.name || null,
		display_description: display.description || null,
		display_welcome_message: display.welcome_message || null,
		instructions: config.instructions || g.instructions || null,
		tools,
		created_at: tsToIso(g.created_at ?? g.create_time),
		updated_at: tsToIso(g.updated_at ?? g.update_time),
		author_id: author.user_id || author.id || null,
		author_name: author.display_name || author.name || null,
		is_public: resolveGizmoIsPublic(g),
		category: g.category || display.category || null,
		tags: Array.isArray(tagsRaw) ? tagsRaw : [],
	};
}

// ─── Custom instructions ────────────────────────────────────────────────

export function buildCustomInstructionsRecord(
	j: RawCustomInstructionsBody | null | undefined,
): RecordData {
	const body = j || {};
	return {
		id: "user_custom_instructions",
		about_user: body.about_user_message ?? body.about_user ?? null,
		response_style: body.about_model_message ?? body.response_style ?? null,
		enabled: typeof body.enabled === "boolean" ? body.enabled : null,
		updated_at: tsToIso(body.updated_at ?? body.update_time_detail),
	};
}

// ─── Account plan ───────────────────────────────────────────────────────

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	Boolean(v) && typeof v === "object" && !Array.isArray(v);

// An account object with nothing to identify it (`{}`, wrong primitives) is a
// changed or broken response, not a free account: free accounts still carry
// plan_type, and an entitlement may be absent.
function isAccountEntry(v: unknown): v is RawAccountEntry {
	if (!isPlainObject(v)) {
		return false;
	}
	const { account } = v as RawAccountEntry;
	if (!isPlainObject(account)) {
		return false;
	}
	// Whitespace-only strings do not identify an account. Trimmed only here:
	// emitted field values keep their existing semantics.
	return [account.account_id, account.plan_type, account.structure].some(
		(f) => typeof f === "string" && f.trim().length > 0,
	);
}

/**
 * Pick the account the signed-in session resolves to: the "default" alias
 * (null if present but invalid), else the first `account_ordering` id that
 * is present, else the first entry that carries an `account` object.
 */
function pickAccountEntry(
	body: RawAccountsCheckBody,
): { entry: RawAccountEntry; key: string } | null {
	const { accounts } = body;
	if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) {
		return null;
	}
	const ordering = Array.isArray(body.account_ordering)
		? body.account_ordering.filter((k): k is string => typeof k === "string")
		: [];
	// A present `default` is the session's account. If it is malformed the
	// response is broken; falling through would silently switch identity.
	if (accounts.default !== undefined) {
		return isAccountEntry(accounts.default)
			? { entry: accounts.default, key: "default" }
			: null;
	}
	for (const key of [...ordering, ...Object.keys(accounts)]) {
		const entry = accounts[key];
		if (isAccountEntry(entry)) {
			return { entry, key };
		}
	}
	return null;
}

const stringOrNull = (v: unknown): string | null =>
	typeof v === "string" && v.length > 0 ? v : null;

const booleanOrNull = (v: unknown): boolean | null =>
	typeof v === "boolean" ? v : null;

// A plan id such as "chatgptplusplan" or "plus": lowercase letters, "_" and
// "-" only. No digits, so a processor id ("sub_1Nx…"), a UUID or an email
// cannot pass as a plan name.
const PLAN_SLUG = /^[a-z][a-z_-]{0,39}$/;

/**
 * A non-null scheduled_plan_change has not been observed. The only public
 * reader found (gpt2agent usage.py) reads `plan_type` and `changes_at`, so
 * those two are carried and every other key, at any depth, is dropped.
 * Any object means a change is scheduled, so it maps to an object even when
 * neither key is recognised: unknown keys must not read as "no change".
 */
function scheduledPlanChangeOrNull(
	v: unknown,
): { plan_type: string | null; changes_at: string | null } | null {
	if (!isPlainObject(v)) {
		return null;
	}
	const plan = stringOrNull(v.plan_type);
	return {
		plan_type: plan && PLAN_SLUG.test(plan) ? plan : null,
		changes_at: tsToIso(v.changes_at),
	};
}

/**
 * Normalize the accounts/check body into the single account_plan record.
 * Returns null when the body names no account at all — unlike a cleared
 * custom-instructions body, an account-less response is not a state a
 * signed-in session can be in, so the caller reports it instead of emitting
 * an all-null record. Billing identifiers (subscription id, payment
 * processor ids) and profile fields are deliberately not carried.
 */
export function buildAccountPlanRecord(
	j: RawAccountsCheckBody | null | undefined,
): RecordData | null {
	const picked = pickAccountEntry(j || {});
	if (!picked) {
		return null;
	}
	const { entry, key } = picked;
	const account = entry.account || {};
	const entitlement = entry.entitlement || {};
	return {
		id: "account_plan",
		is_default: true,
		account_id:
			stringOrNull(account.account_id) ?? (key === "default" ? null : key),
		account_structure: stringOrNull(account.structure),
		account_created_at: tsToIso(account.created_time),
		plan_type: stringOrNull(account.plan_type),
		plan_display_name: stringOrNull(account.plan_display_name),
		subscription_plan: stringOrNull(entitlement.subscription_plan),
		has_active_subscription: booleanOrNull(entitlement.has_active_subscription),
		billing_period: stringOrNull(entitlement.billing_period),
		will_renew: booleanOrNull(entry.last_active_subscription?.will_renew),
		renews_at: tsToIso(entitlement.renews_at),
		expires_at: tsToIso(entitlement.expires_at),
		cancels_at: tsToIso(entitlement.cancels_at),
		scheduled_plan_change: scheduledPlanChangeOrNull(
			entitlement.scheduled_plan_change,
		),
	};
}

/** Enumerate usable account entries without changing the session-default rule. */
export function buildAccountPlanRecords(
	body: RawAccountsCheckBody | null | undefined,
): RecordData[] {
	const primary = buildAccountPlanRecord(body);
	if (!primary) return [];
	const records = [primary];
	const seen = new Set<string>();
	if (typeof primary.account_id === "string") seen.add(primary.account_id);
	const entries = Object.entries(body?.accounts ?? {}).sort(([a], [b]) =>
		a.localeCompare(b),
	);
	for (const [key, entry] of entries) {
		if (key === "default" || !isAccountEntry(entry)) continue;
		const record = buildAccountPlanRecord({
			accounts: { [key]: entry },
			account_ordering: [key],
		});
		if (
			!record ||
			typeof record.account_id !== "string" ||
			seen.has(record.account_id)
		)
			continue;
		seen.add(record.account_id);
		records.push({
			...record,
			id: `account_plan:${record.account_id}`,
			is_default: false,
		});
	}
	return records;
}

// ─── Shared conversations ──────────────────────────────────────────────

function resolveSharedAnonymous(s: RawSharedConversation): boolean | null {
	if (typeof s.is_anonymous === "boolean") {
		return s.is_anonymous;
	}
	if (typeof s.anonymous === "boolean") {
		return s.anonymous;
	}
	return null;
}

export function buildSharedConversationRecord(
	s: RawSharedConversation,
): RecordData | null {
	const shareId = s.id || s.share_id;
	if (!shareId) {
		return null;
	}
	return {
		id: shareId,
		conversation_id: s.conversation_id || null,
		share_url: s.share_url || `https://chatgpt.com/share/${shareId}`,
		title: s.title || null,
		created_at: tsToIso(s.create_time ?? s.created_at),
		anonymous: resolveSharedAnonymous(s),
		is_public: typeof s.is_public === "boolean" ? s.is_public : null,
		highlighted_text: s.highlighted_text || null,
	};
}

// ─── Conversations ──────────────────────────────────────────────────────

export interface ConversationDetail {
	create_time?: number | string | null;
	current_node?: string | null;
	gizmo_id?: string | null;
	is_archived?: boolean | null;
	is_starred?: boolean | null;
	mapping?: Record<string, ChatGptNode> | null;
	title?: string | null;
	update_time?: number | string | null;
	workspace_id?: string | null;
}

/**
 * Count the messages on the conversation's current branch (i.e. excluding
 * off-branch alternatives). Returns null when we have no detail mapping.
 */
export function countBranchMessages(
	mapping: Record<string, ChatGptNode> | null | undefined,
	currentNode: string | null | undefined,
): number | null {
	if (!(mapping && currentNode)) {
		return null;
	}
	return flattenTreeCurrentBranch(mapping, currentNode).filter(
		(x) => x.node?.message?.author?.role,
	).length;
}

/** The longest model slug a record may carry; the same bound as `messages.model_slug`. */
export const MODEL_SLUG_MAX_LENGTH = 80;

function isModelSlug(slug: unknown): slug is string {
	return (
		typeof slug === "string" &&
		slug.length > 0 &&
		slug.length <= MODEL_SLUG_MAX_LENGTH &&
		pdppSafeText.safeParse(slug).success
	);
}

/**
 * An assistant reply is an assistant message that speaks to the user. It
 * follows the `messages` stream's own classification of a node: an assistant
 * node that `extractToolCalls` reads as a tool call, or that ends no turn
 * (`end_turn: false`, which `messages` reports as finish_reason "tool_calls"),
 * is an intermediate step, not a reply. `messages` has no further notion of
 * visibility, so none is invented here.
 */
function isAssistantReply(message: ChatGptMessage | undefined): boolean {
	return (
		message?.author?.role === "assistant" &&
		message.end_turn !== false &&
		synthesizeToolCalls(message, false).length === 0
	);
}

/**
 * Count the assistant replies (see `isAssistantReply`) on the conversation's
 * current branch per model slug, with the same branch walk as
 * `countBranchMessages`. Only model names and counts leave this function: no
 * message text, id or time. A reply without a usable slug (absent, over the
 * length bound, or not safe text) adds no entry, so the counts can sum to less
 * than the reply count. Returns null when we have no detail mapping.
 */
export function countBranchModels(
	mapping: Record<string, ChatGptNode> | null | undefined,
	currentNode: string | null | undefined,
): Record<string, number> | null {
	if (!(mapping && currentNode)) {
		return null;
	}
	const counts = new Map<string, number>();
	for (const { node } of flattenTreeCurrentBranch(mapping, currentNode)) {
		const message = node?.message;
		if (!isAssistantReply(message)) {
			continue;
		}
		const slug = message?.metadata?.model_slug;
		if (isModelSlug(slug)) {
			counts.set(slug, (counts.get(slug) ?? 0) + 1);
		}
	}
	// fromEntries defines own properties, so a slug named "__proto__" stays a key.
	return Object.fromEntries(counts);
}

/**
 * Derive legacy projection metadata from the records retained for the current
 * branch. `messages` must be in provider root-to-tip order. Re-linking retained
 * records across omitted nodes lets downstream consumers walk exactly the
 * branch we emitted; the first record keeps its provider parent (usually the
 * synthetic root, which is not itself a message record).
 */
export function reconcileEmittedBranchMessages(
	messages: readonly RecordData[],
): { currentNode: string | null; count: number; messages: RecordData[] } {
	const branch = messages.filter(
		(message) =>
			message.on_current_branch === true && typeof message.id === "string",
	);
	const reconciled = branch.map((message, index) => {
		const parentId = index > 0 ? branch[index - 1]?.id : undefined;
		return {
			...message,
			...(typeof parentId === "string" ? { parent_id: parentId } : {}),
		};
	});
	const tip = reconciled.at(-1)?.id;
	return {
		currentNode: typeof tip === "string" ? tip : null,
		count: reconciled.length,
		messages: reconciled,
	};
}

/**
 * Merge the list-endpoint and detail-endpoint views into a single conversation
 * record. Fields that only appear on detail (gizmo_id, workspace_id,
 * current_node, message_count_on_current_branch, model_counts) fall back to list when
 * `detail` is null (the detail has not been read: a deferral, a failed read a later
 * run retries, or a deleted conversation).
 */
export function buildConversationRecord(
	c: ConversationListItem,
	detail: ConversationDetail | null,
): RecordData {
	const mapping = detail?.mapping || null;
	const currentNode = detail ? detail.current_node : (c.current_node ?? null);
	return {
		id: c.id,
		title: (detail?.title ?? c.title) || null,
		create_time: tsToIso(detail?.create_time ?? c.create_time),
		update_time: tsToIso(detail?.update_time ?? c.update_time),
		is_archived: detail?.is_archived ?? c.is_archived ?? null,
		is_starred: detail?.is_starred ?? c.is_starred ?? null,
		workspace_id: (detail?.workspace_id ?? c.workspace_id) || null,
		current_node: currentNode || null,
		message_count_on_current_branch: mapping
			? currentNode
				? countBranchMessages(mapping, currentNode)
				: 0
			: null,
		// null exactly when message_count_on_current_branch is null: no detail
		// mapping was fetched, so the models are unknown (not "none").
		model_counts: mapping
			? currentNode
				? countBranchModels(mapping, currentNode)
				: {}
			: null,
		gizmo_id: (detail?.gizmo_id ?? c.gizmo_id) || null,
	};
}

/**
 * Pick the largest ISO update_time across conversations. Used when committing
 * the conversations cursor at the end of a run.
 */
export function maxUpdateTimeIso(
	items: readonly ConversationListItem[],
): string | null {
	return (
		items
			.map((c) => (c.update_time ? tsToIso(c.update_time) : null))
			.filter((x): x is string => Boolean(x))
			.sort()
			.pop() ?? null
	);
}

export function minUpdateTimeIso(
	items: readonly ConversationListItem[],
): string | null {
	return (
		items
			.map((c) => (c.update_time ? tsToIso(c.update_time) : null))
			.filter((x): x is string => Boolean(x))
			.sort()
			.shift() ?? null
	);
}

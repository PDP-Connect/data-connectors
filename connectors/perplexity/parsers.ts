// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the JSON www.perplexity.ai serves its own signed-in pages
 * (observed shapes in the connector's evidence notes; every value there is a
 * type, never a real capture).
 *
 * Two surfaces are read:
 *  - the library list, `POST /rest/thread/list_ask_threads`, whose body is a
 *    JSON ARRAY of thread items (not an object), and
 *  - one thread, `GET /rest/thread/:slug`, whose body is an object with an
 *    `entries` array; each entry holds the user's question in `query_str` and
 *    the assistant's answer inside `blocks[]`.
 *
 * Everything unrecognised fails closed. A body of the wrong shape is a page
 * failure, never an empty page; a thread item or entry that cannot be placed
 * (no id, no slug, no readable timestamp) is counted as unreadable by the
 * caller instead of being emitted with guesses. Free text goes through
 * `pdppSafeText` before it can reach a record. Timestamps must be ISO-8601
 * date-times; the list's arrive with no zone at all, and since the entries of
 * the same threads carry `+00:00` the server clock is UTC, so a missing zone
 * is read as UTC. Any other shape is refused rather than guessed at.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import type {
	Citation,
	ConversationRecord,
	MessageRecord,
	ThreadDetailPage,
	ThreadListPage,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Cap for question and answer text, kept under the schema's own bound. */
const CONTENT_MAX_CHARS = 1_000_000;

// ─── shared value readers ───────────────────────────────────────────────

/**
 * An ISO-8601 date-time, returned as a UTC instant `YYYY-MM-DDTHH:MM:SS.ffffffZ`.
 * The zone may be `Z` or an explicit offset (`+00:00`, `+0000`). The list's
 * timestamps arrive with NO zone at all (`2026-10-02T09:15:00.999999`,
 * microseconds), while the entries of the very same threads carry `+00:00`:
 * the server clock is UTC, so a zoneless value is read as UTC rather than
 * refused. Anything that is not an ISO date-time — a date without a time, a
 * space-separated stamp, a number — is null. A cursor must never rest on a
 * wilder guess than that.
 */
const ZONED_TIME_RE =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

export function normalizeInstant(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = ZONED_TIME_RE.exec(value.trim());
	if (!match) {
		return null;
	}
	const [, date, time, fraction, zone] = match;
	if (date === undefined || time === undefined) {
		return null;
	}
	// A missing zone is the list's zoneless clock, which is UTC.
	const offset =
		zone === undefined || zone === "Z"
			? "Z"
			: `${zone.slice(0, 3)}:${zone.slice(-2)}`;
	const instant = new Date(`${date}T${time}${offset}`);
	if (Number.isNaN(instant.getTime())) {
		return null;
	}
	// Keep the source's microseconds, fixed width, so two updates inside the
	// same second still compare as different and the strings sort by time.
	// An offset shifts whole minutes only, so the fraction carries over as is.
	const micros = (fraction ?? "").slice(0, 6).padEnd(6, "0");
	return `${instant.toISOString().slice(0, 19)}.${micros}Z`;
}

/**
 * Short free text (titles, model names) through the protocol's own
 * `safeTextPreview`: unsafe text is null, over-long text is cut on a code
 * point boundary. Bodies use `readContent`, which reports unsafe text instead
 * of hiding it.
 */
function safeText(value: unknown, max: number): string | null {
	// safeTextPreview appends one ellipsis character when it cuts, so cut one
	// short to stay inside the schema's bound.
	return typeof value === "string"
		? safeTextPreview(value, max - 1).preview
		: null;
}

/** A question or answer body: present, absent, or unreadable (with a reason). */
export type ContentRead =
	| { readonly ok: true; readonly text: string | null }
	| { readonly ok: false; readonly reason: string };

/**
 * A question or answer body. Absent or empty is `text: null`; a body that is
 * not a string or fails the PDPP safe-text invariant is `ok: false`, so the
 * caller can account for it rather than emit a record with its content
 * silently dropped.
 */
export function readContent(value: unknown): ContentRead {
	if (value === undefined || value === null || value === "") {
		return { ok: true, text: null };
	}
	if (typeof value !== "string") {
		return { ok: false, reason: "body is not a string" };
	}
	const preview = safeTextPreview(value, CONTENT_MAX_CHARS);
	if (preview.preview === null) {
		return { ok: false, reason: preview.reason ?? "body is not safe text" };
	}
	return { ok: true, text: preview.preview };
}

/** A non-empty bounded string with no whitespace or control characters. */
function identifier(value: unknown, max = 128): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		return null;
	}
	return /^\S+$/.test(value) ? value : null;
}

function nonNegativeInt(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

function wholeInt(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value)
		? value
		: null;
}

// ─── the library list ───────────────────────────────────────────────────

/**
 * One readable thread from a list item, or null when the item cannot be
 * placed: no thread id, or no usable slug to address the thread with.
 */
export interface ListedThread {
	readonly id: string;
	readonly slug: string | null;
	readonly title: string | null;
	readonly mode: string | null;
	readonly model: string | null;
	readonly updateTime: string | null;
	readonly entryCount: number | null;
	readonly access: number | null;
	/** The list item says the thread's last answer finished (`status: "COMPLETED"`). */
	readonly complete: boolean;
}

export function parseListedThread(item: unknown): ListedThread | null {
	if (!isRecord(item)) {
		return null;
	}
	const id = identifier(item.context_uuid, 64);
	if (!id) {
		return null;
	}
	return {
		id,
		slug: identifier(item.slug, 128),
		title: safeText(item.title, 500),
		mode: safeText(item.mode, 64),
		model: safeText(item.display_model, 120),
		updateTime: normalizeInstant(item.last_query_datetime),
		entryCount: nonNegativeInt(item.query_count),
		access: wholeInt(item.thread_access),
		complete: item.status === "COMPLETED",
	};
}

/** The conversations record for a listed thread, with its create time if known. */
export function conversationRecord(
	listed: ListedThread,
	createTime: string | null,
): ConversationRecord {
	return {
		id: listed.id,
		title: listed.title,
		slug: listed.slug,
		mode: listed.mode,
		model: listed.model,
		create_time: createTime,
		update_time: listed.updateTime,
		entry_count: listed.entryCount,
		access: listed.access,
	};
}

/**
 * Parse one list response body. The body must be a JSON array; the list ends
 * when the page is empty or its LAST item says `has_next_page: false`.
 * Anything else is a shape failure, not an empty page. `total_threads` is
 * deliberately unread: live list items carry a number unrelated to the
 * library size (a 4-thread account reported 99 on every item), so only the
 * walk's own end proof counts.
 */
export function parseThreadListPage(
	body: string,
): { ok: true; page: ThreadListPage } | { ok: false; message: string } {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return { ok: false, message: "The thread list was not JSON." };
	}
	if (!Array.isArray(payload)) {
		return {
			ok: false,
			message: "The thread list was not a JSON array.",
		};
	}
	if (payload.length === 0) {
		return {
			ok: true,
			page: { items: [], hasNextPage: false },
		};
	}
	const last = payload[payload.length - 1];
	if (!isRecord(last) || typeof last.has_next_page !== "boolean") {
		return {
			ok: false,
			message: "The thread list page carried no usable has_next_page.",
		};
	}
	return {
		ok: true,
		page: { items: payload, hasNextPage: last.has_next_page },
	};
}

// ─── one thread's entries ───────────────────────────────────────────────

/**
 * Parse one thread response body. `entries` must be an array and
 * `has_next_page` a boolean; anything else is a shape failure.
 */
export function parseThreadDetailPage(
	body: string,
): { ok: true; page: ThreadDetailPage } | { ok: false; message: string } {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return { ok: false, message: "The thread response was not JSON." };
	}
	if (!isRecord(payload) || !Array.isArray(payload.entries)) {
		return {
			ok: false,
			message: "The thread response had no entries array.",
		};
	}
	if (typeof payload.has_next_page !== "boolean") {
		return {
			ok: false,
			message: "The thread response had no usable has_next_page.",
		};
	}
	return {
		ok: true,
		page: { entries: payload.entries, hasNextPage: payload.has_next_page },
	};
}

/**
 * The assistant's answer. The `ask_text` block carries the whole answer; the
 * `ask_text_<n>_markdown` blocks are consecutive pieces of the same text, so
 * they are only joined, in n order, when there is no `ask_text` block, and
 * only when they run from 0 with no hole (otherwise unreadable). An
 * unsafe `ask_text` is unreadable: it is never replaced by a partial join of
 * the section blocks.
 */
export function readAnswer(entry: Record<string, unknown>): ContentRead {
	const blocks = Array.isArray(entry.blocks) ? entry.blocks : [];
	const sections = new Map<number, unknown>();
	for (const block of blocks) {
		if (!isRecord(block) || typeof block.intended_usage !== "string") {
			continue;
		}
		const payload = block.markdown_block;
		if (!isRecord(payload)) {
			continue;
		}
		if (block.intended_usage === "ask_text") {
			return readContent(payload.answer);
		}
		const section = /^ask_text_(\d+)_markdown$/.exec(block.intended_usage);
		if (section?.[1] !== undefined && !sections.has(Number(section[1]))) {
			sections.set(Number(section[1]), payload.answer);
		}
	}
	// The pieces are numbered from 0 with no hole. A missing piece would
	// make the join a partial answer stored as if whole, so it is unreadable.
	const order = [...sections.keys()].sort((left, right) => left - right);
	if (order.some((index, position) => index !== position)) {
		return { ok: false, reason: "answer_sections_not_contiguous" };
	}
	const parts: string[] = [];
	for (const index of order) {
		const part = readContent(sections.get(index));
		if (!part.ok) {
			return part;
		}
		if (part.text !== null) {
			parts.push(part.text);
		}
	}
	return parts.length > 0
		? readContent(parts.join("\n\n"))
		: { ok: true, text: null };
}

/** The answer text, or null when there is none or it is unreadable. */
export function answerText(entry: Record<string, unknown>): string | null {
	const answer = readAnswer(entry);
	return answer.ok ? answer.text : null;
}

/** The web results an entry's answer cited, as { title, url } pairs. */
export function entryCitations(entry: Record<string, unknown>): Citation[] {
	const blocks = entry.blocks;
	if (!Array.isArray(blocks)) {
		return [];
	}
	const citations: Citation[] = [];
	for (const block of blocks) {
		if (!isRecord(block) || block.intended_usage !== "web_results") {
			continue;
		}
		const payload = block.web_result_block;
		if (!isRecord(payload) || !Array.isArray(payload.web_results)) {
			continue;
		}
		for (const result of payload.web_results) {
			if (!isRecord(result)) {
				continue;
			}
			// A citation without a usable http(s) URL is not a citation; a title
			// may be missing, but the URL is what the citation IS.
			const url = typeof result.url === "string" ? httpUrl(result.url) : null;
			if (url === null) {
				continue;
			}
			citations.push({ title: safeText(result.name, 500), url });
		}
	}
	return citations;
}

/** An absolute http(s) URL, or null: anything else cannot be a citation. */
function httpUrl(value: string): string | null {
	if (value.length > 2048) {
		return null;
	}
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? value
			: null;
	} catch {
		return null;
	}
}

/** One entry read from a thread response. */
export type EntryRead =
	| {
			readonly kind: "ok";
			readonly id: string;
			readonly user: MessageRecord;
			readonly assistant: MessageRecord;
			/** The entry's creation time, the best proxy for the thread's create time. */
			readonly firstCreateTime: string | null;
	  }
	/** The answer is still being written (`status` is not `COMPLETED`). */
	| { readonly kind: "incomplete"; readonly id: string }
	| {
			readonly kind: "unreadable";
			readonly id: string | null;
			readonly reason: string;
	  };

/**
 * Split one entry into the user's question and the assistant's answer. The
 * question's time is the entry's creation time; the answer's is the entry's
 * last update time, which is when the answer finished. An entry is only `ok`
 * when it is complete and both bodies are present and safe; anything else is
 * `incomplete` or `unreadable`, and the caller accounts for it.
 */
export function entryMessages(
	entryValue: unknown,
	conversationId: string,
): EntryRead {
	if (!isRecord(entryValue)) {
		return { kind: "unreadable", id: null, reason: "entry is not an object" };
	}
	const uuid = identifier(entryValue.uuid, 64);
	if (!uuid) {
		return { kind: "unreadable", id: null, reason: "entry has no uuid" };
	}
	if (entryValue.status !== "COMPLETED") {
		return { kind: "incomplete", id: uuid };
	}
	const question = readContent(entryValue.query_str);
	if (!question.ok || question.text === null) {
		return {
			kind: "unreadable",
			id: uuid,
			reason: question.ok
				? "entry has no question"
				: `question: ${question.reason}`,
		};
	}
	const answer = readAnswer(entryValue);
	if (!answer.ok || answer.text === null) {
		return {
			kind: "unreadable",
			id: uuid,
			reason: answer.ok ? "entry has no answer" : `answer: ${answer.reason}`,
		};
	}
	const createTime = normalizeInstant(entryValue.entry_created_datetime);
	const updateTime =
		normalizeInstant(entryValue.entry_updated_datetime) ?? createTime;
	const model =
		safeText(entryValue.display_model, 120) ??
		safeText(entryValue.user_selected_model, 120);
	return {
		kind: "ok",
		id: uuid,
		user: {
			id: `${uuid}:user`,
			conversation_id: conversationId,
			role: "user",
			content: question.text,
			create_time: createTime,
			model: null,
			citations: [],
		},
		assistant: {
			id: `${uuid}:assistant`,
			conversation_id: conversationId,
			role: "assistant",
			content: answer.text,
			create_time: updateTime,
			model,
			citations: entryCitations(entryValue),
		},
		firstCreateTime: createTime,
	};
}

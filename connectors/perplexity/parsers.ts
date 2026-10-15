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

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import type {
	Citation,
	ConversationRecord,
	EntryMessages,
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
 * An ISO-8601 date-time, returned as a UTC instant `YYYY-MM-DDTHH:MM:SSZ`.
 * The zone may be `Z` or an explicit offset (`+00:00`, `+0000`). The list's
 * timestamps arrive with NO zone at all (`2026-10-02T09:15:00.999999`,
 * microseconds), while the entries of the very same threads carry `+00:00`:
 * the server clock is UTC, so a zoneless value is read as UTC rather than
 * refused. Anything that is not an ISO date-time — a date without a time, a
 * space-separated stamp, a number — is null. A cursor must never rest on a
 * wilder guess than that.
 */
const ZONED_TIME_RE =
	/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function normalizeInstant(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = ZONED_TIME_RE.exec(value.trim());
	if (!match) {
		return null;
	}
	const [, date, time, zone] = match;
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
	return `${instant.toISOString().slice(0, 19)}Z`;
}

/** Free text that must pass the PDPP printable-text invariant, or null. */ function safeText(
	value: unknown,
	max: number,
): string | null {
	if (typeof value !== "string") {
		return null;
	}
	if (!pdppSafeText.safeParse(value).success) {
		return null;
	}
	return value.length <= max ? value : truncateHead(value, max);
}

const TRUNCATION_MARKER =
	"\n\n[…truncated by PDPP: the original Perplexity text exceeded the stored length cap]";

/** Keep the head of an over-long but otherwise safe body, and say so. */
function truncateHead(value: string, max: number): string {
	const keep = max - TRUNCATION_MARKER.length - 1;
	return `${value.slice(0, keep)}${TRUNCATION_MARKER}`;
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
 * The assistant's answer text. The `ask_text` block carries the whole answer;
 * the `ask_text_<n>_markdown` blocks are per-section duplicates of it, so
 * they are only joined, in n order, when there is no `ask_text` block.
 */
export function answerText(entry: Record<string, unknown>): string | null {
	const blocks = entry.blocks;
	if (!Array.isArray(blocks)) {
		return null;
	}
	let whole: string | null = null;
	const sections = new Map<number, string>();
	for (const block of blocks) {
		if (!isRecord(block)) {
			continue;
		}
		const usage = block.intended_usage;
		if (typeof usage !== "string") {
			continue;
		}
		const payload = block.markdown_block;
		if (!isRecord(payload) || typeof payload.answer !== "string") {
			continue;
		}
		if (usage === "ask_text") {
			whole = safeText(payload.answer, CONTENT_MAX_CHARS);
			continue;
		}
		const section = /^ask_text_(\d+)_markdown$/.exec(usage);
		if (section) {
			const text = safeText(payload.answer, CONTENT_MAX_CHARS);
			const index = Number(section[1]);
			if (text !== null && !sections.has(index)) {
				sections.set(index, text);
			}
		}
	}
	if (whole !== null) {
		return whole;
	}
	if (sections.size === 0) {
		return null;
	}
	const joined = [...sections.keys()]
		.sort((left, right) => left - right)
		.map((index) => sections.get(index))
		.filter((part): part is string => part !== undefined && part.length > 0)
		.join("\n\n");
	return joined.length > 0 ? safeText(joined, CONTENT_MAX_CHARS) : null;
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

/**
 * The two messages one entry splits into: the user's question and the
 * assistant's answer. Null when the entry has no usable uuid to key them.
 *
 * The question carries the entry's creation time; the answer carries the
 * entry's last update time, which is when the answer finished. `firstCreateTime`
 * is the entry's creation time, the thread's best available create time.
 */
export function entryMessages(
	entryValue: unknown,
	conversationId: string,
): EntryMessages | null {
	if (!isRecord(entryValue)) {
		return null;
	}
	const uuid = identifier(entryValue.uuid, 64);
	if (!uuid) {
		return null;
	}
	const createTime = normalizeInstant(entryValue.entry_created_datetime);
	const updateTime =
		normalizeInstant(entryValue.entry_updated_datetime) ?? createTime;
	const model =
		safeText(entryValue.display_model, 120) ??
		safeText(entryValue.user_selected_model, 120);
	const citations = entryCitations(entryValue);
	const question = safeText(entryValue.query_str, CONTENT_MAX_CHARS);
	const answer = answerText(entryValue);
	const user: MessageRecord = {
		id: `${uuid}:user`,
		conversation_id: conversationId,
		role: "user",
		content: question,
		create_time: createTime,
		model: null,
		citations: [],
	};
	const assistant: MessageRecord = {
		id: `${uuid}:assistant`,
		conversation_id: conversationId,
		role: "assistant",
		content: answer,
		create_time: updateTime,
		model,
		citations,
	};
	return { user, assistant, firstCreateTime: createTime };
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsing and record building for Character.AI. Nothing here touches the
 * network or the page; index.ts owns fetching.
 */

import {
	type PdppSafeText,
	pdppSafeText,
} from "@pdpp/connector-protocol/pdpp-safe-text";
import {
	safeTextPreview,
	stripForbiddenControlChars,
} from "@pdpp/connector-protocol/safe-text-preview";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type ApiChat,
	type ApiTurn,
	apiChatDetailSchema,
	apiChatSchema,
	apiChatsPageSchema,
	apiTurnsPageSchema,
	uuidSchema,
} from "./schemas.ts";

/** Upper bound for one message body; far above anything the chat UI accepts. */
const MESSAGE_TEXT_MAX_CHARS = 1_000_000;
const ENUM_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;

export class CharacterAiPayloadError extends Error {
	constructor(endpoint: string, detail: string) {
		super(`character_ai_invalid_payload: ${endpoint}: ${detail}`);
		this.name = "CharacterAiPayloadError";
	}
}

export interface Page<T> {
	items: T[];
	nextToken: string | null;
	/** Rows on this page that carry no usable key: nothing can account for them. */
	unkeyed?: number;
}

/** The end of a list is an explicit empty (or null) `meta.next_token`; the schema requires the field. */
function nextTokenOf(meta: { next_token: string | null }): string | null {
	const token = meta.next_token;
	return token !== null && token.length > 0 ? token : null;
}

function issuesOf(error: {
	issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
	return error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`)
		.join("; ");
}

/**
 * One row of the chat list. A row whose chat id is usable but whose other
 * fields are not is kept as `chat: null` with the reason, so only that chat
 * goes unread (a gap) instead of the whole list.
 */
export type ChatRow =
	| { chatId: string; chat: ApiChat }
	| { chatId: string; chat: null; detail: string };

/** Display text arrives with stray control characters at times; they are dropped, never the row. */
function withCleanName(row: unknown): unknown {
	if (typeof row !== "object" || row === null || Array.isArray(row)) {
		return row;
	}
	const name = (row as Record<string, unknown>).character_name;
	return typeof name === "string"
		? { ...row, character_name: stripForbiddenControlChars(name) }
		: row;
}

export function parseChatsPage(json: unknown): Page<ChatRow> {
	const parsed = apiChatsPageSchema.safeParse(json);
	if (!parsed.success) {
		throw new CharacterAiPayloadError("chats/recent", issuesOf(parsed.error));
	}
	const items: ChatRow[] = [];
	let unkeyed = 0;
	for (const row of parsed.data.chats) {
		const chat = apiChatSchema.safeParse(withCleanName(row));
		if (chat.success) {
			items.push({ chatId: chat.data.chat_id, chat: chat.data });
			continue;
		}
		const id = uuidSchema.safeParse(
			typeof row === "object" && row !== null
				? (row as Record<string, unknown>).chat_id
				: undefined,
		);
		if (id.success) {
			items.push({ chatId: id.data, chat: null, detail: issuesOf(chat.error) });
		} else {
			unkeyed += 1;
		}
	}
	return {
		items,
		nextToken: nextTokenOf(parsed.data.meta),
		...(unkeyed > 0 ? { unkeyed } : {}),
	};
}

export function parseTurnsPage(json: unknown, chatId: string): Page<ApiTurn> {
	const parsed = apiTurnsPageSchema.safeParse(json);
	if (!parsed.success) {
		throw new CharacterAiPayloadError("turns", issuesOf(parsed.error));
	}
	const foreign = parsed.data.turns.find(
		(turn) => turn.turn_key.chat_id !== chatId,
	);
	if (foreign) {
		throw new CharacterAiPayloadError(
			"turns",
			"a turn belongs to a different chat than the one requested",
		);
	}
	return { items: parsed.data.turns, nextToken: nextTokenOf(parsed.data.meta) };
}

/**
 * GET /chat/:chat_id/ — the chat's own fields. The detail carries no
 * character name; when the chat's turns name the character (an author whose
 * id is the chat's character id), that name is used, otherwise it stays null.
 */
export function parseChatDetail(json: unknown, chatId: string): ApiChat {
	const parsed = apiChatDetailSchema.safeParse(json);
	if (!parsed.success) {
		throw new CharacterAiPayloadError("chat", issuesOf(parsed.error));
	}
	if (parsed.data.chat.chat_id !== chatId) {
		throw new CharacterAiPayloadError(
			"chat",
			"the answer is about a different chat than the one requested",
		);
	}
	return { ...parsed.data.chat, character_name: null };
}

/** The character's name from its own turns; null when no turn names it safely. */
export function characterNameFromTurns(
	chat: ApiChat,
	turns: readonly ApiTurn[],
): PdppSafeText | null {
	const turn = turns.find(
		(candidate) =>
			candidate.author.is_human !== true &&
			candidate.author.author_id === chat.character_id &&
			typeof candidate.author.name === "string",
	);
	const name = turn?.author.name;
	if (typeof name !== "string") {
		return null;
	}
	const safe = pdppSafeText.safeParse(stripForbiddenControlChars(name));
	return safe.success ? safe.data : null;
}

function isSafeText(value: string): boolean {
	const kind = safeTextPreview(value, value.length).kind;
	return kind === "text" || kind === "empty";
}

/** A present source string that is not PDPP-safe; absent values are fine. */
function unsafeField(
	fields: Record<string, string | null | undefined>,
): string | null {
	for (const [name, value] of Object.entries(fields)) {
		if (typeof value === "string" && !isSafeText(value)) {
			return name;
		}
	}
	return null;
}

/** A present enum-like source value that is not an UPPER_SNAKE token. */
function badEnumField(
	fields: Record<string, string | null | undefined>,
): string | null {
	for (const [name, value] of Object.entries(fields)) {
		if (typeof value === "string" && !ENUM_TOKEN_RE.test(value)) {
			return name;
		}
	}
	return null;
}

/**
 * Validated source times are RFC 3339 with a zone (the boundary schema refuses
 * anything else), so this only maps an absent optional time to null.
 */
export function sourceTime(value: string | null | undefined): string | null {
	return value ?? null;
}

const RFC3339_PARTS_RE =
	/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/i;
/**
 * Sort key for a validated RFC 3339 time at full precision: whole UTC seconds
 * (offset applied by Date.parse on the fraction-free string) plus the
 * fractional digits exactly as written (compared at full length in
 * compareTimes). Date.parse alone keeps only milliseconds.
 */
function timeKey(value: string): { seconds: number; fraction: string } | null {
	const match = RFC3339_PARTS_RE.exec(value);
	const seconds = match ? Date.parse(`${match[1]}${match[3]}`) : Number.NaN;
	if (!(match && Number.isFinite(seconds))) {
		return null;
	}
	return {
		seconds,
		fraction: match[2] ?? "",
	};
}

export function compareTimes(a: string, b: string): number {
	const left = timeKey(a);
	const right = timeKey(b);
	if (!(left && right)) {
		throw new CharacterAiPayloadError(
			"time",
			"a timestamp is not RFC 3339 with a zone",
		);
	}
	if (left.seconds !== right.seconds) {
		return left.seconds < right.seconds ? -1 : 1;
	}
	// Pad the shorter fraction with zeros to the longer one's length (no cap),
	// so equal-length digit strings compare in numeric order.
	const digits = Math.max(left.fraction.length, right.fraction.length);
	const leftFraction = left.fraction.padEnd(digits, "0");
	const rightFraction = right.fraction.padEnd(digits, "0");
	if (leftFraction === rightFraction) {
		return 0;
	}
	return leftFraction < rightFraction ? -1 : 1;
}

export function latestTime(times: Array<string | null>): string | null {
	let latest: string | null = null;
	for (const time of times) {
		if (time !== null && (latest === null || compareTimes(time, latest) > 0)) {
			latest = time;
		}
	}
	return latest;
}

export interface ChatHydration {
	lastInteractionTime: string | null;
	turnCount: number;
}

export function buildChatRecord(
	chat: ApiChat,
	hydration: ChatHydration | null,
): RecordData {
	return {
		id: chat.chat_id,
		character_id: chat.character_id,
		character_name: chat.character_name ?? null,
		creator_id: chat.creator_id ?? null,
		type: chat.type ?? null,
		state: chat.state ?? null,
		visibility: chat.visibility ?? null,
		create_time: chat.create_time,
		last_interaction_time: hydration?.lastInteractionTime ?? null,
		turn_count: hydration?.turnCount ?? null,
	};
}

/**
 * Whether a turn can be stored as a message. `generating`: the
 * selected candidate is not final yet (retry later). `unreadable`: the turn
 * names no usable selected candidate, or its text is not PDPP-safe; storing
 * it would commit a missing or altered body.
 */
export type TurnCheck =
	| {
			ok: true;
			text: string;
			authorName: string | null;
			candidate: ApiTurn["candidates"][number];
	  }
	| { ok: false; kind: "generating" | "unreadable"; detail: string };

export function checkTurn(turn: ApiTurn): TurnCheck {
	const primaryId = turn.primary_candidate_id;
	const candidate = primaryId
		? turn.candidates.find((item) => item.candidate_id === primaryId)
		: undefined;
	if (!candidate) {
		return {
			ok: false,
			kind: "unreadable",
			detail: "the selected candidate is missing",
		};
	}
	// Display text loses stray control characters; ids must be clean as sent.
	const authorName =
		typeof turn.author.name === "string"
			? stripForbiddenControlChars(turn.author.name)
			: null;
	const unsafe = unsafeField({
		author_id: turn.author.author_id,
		author_name: authorName,
		candidate_id: candidate.candidate_id,
	});
	const badEnum = badEnumField({
		state: turn.state,
		model_type: candidate.model_type,
	});
	if (unsafe || badEnum) {
		return {
			ok: false,
			kind: "unreadable",
			detail: unsafe
				? `${unsafe} is not PDPP-safe text`
				: `${badEnum} is not an enum token`,
		};
	}
	if (candidate.is_final !== true) {
		return {
			ok: false,
			kind: "generating",
			detail: "the selected candidate is not final",
		};
	}
	if (typeof candidate.raw_content !== "string") {
		return {
			ok: false,
			kind: "unreadable",
			detail: "the selected candidate has no text",
		};
	}
	const safe = safeTextPreview(
		stripForbiddenControlChars(candidate.raw_content),
		MESSAGE_TEXT_MAX_CHARS,
	);
	if (safe.kind === "binary" || safe.truncated) {
		return {
			ok: false,
			kind: "unreadable",
			detail: `the selected candidate's text is not storable (${safe.reason ?? "too long"})`,
		};
	}
	return { ok: true, text: safe.preview ?? "", authorName, candidate };
}

/** Build a message record from a turn that passed checkTurn. */
export function buildMessageRecord(
	turn: ApiTurn,
	checked: Extract<TurnCheck, { ok: true }>,
): RecordData {
	return {
		id: turn.turn_key.turn_id,
		chat_id: turn.turn_key.chat_id,
		author_kind: turn.author.is_human === true ? "user" : "character",
		author_id: turn.author.author_id ?? null,
		author_name: checked.authorName,
		text: checked.text,
		primary_candidate_id: checked.candidate.candidate_id,
		candidate_count: turn.candidates.length,
		is_final: true,
		model_type: checked.candidate.model_type ?? null,
		state: turn.state ?? null,
		create_time: turn.create_time,
		last_update_time: sourceTime(turn.last_update_time),
	};
}

// ─── Pagination ──────────────────────────────────────────────────────────

export type WalkResult<T> =
	| { complete: true; items: T[]; unkeyed: number }
	| { complete: false; items: T[]; unkeyed: number; reason: string };

/**
 * Walk a next-token list until the source itself says it ended: a page with
 * no next token. An empty page ends the list only when it carries no next
 * token either. A repeated token, an empty page that still claims a
 * continuation, a non-empty page that adds nothing new, or the page cap stop
 * the walk as INCOMPLETE, never as a finished list.
 */
export async function walkTokenPages<T>(args: {
	fetchPage: (token: string | null) => Promise<Page<T>>;
	keyOf: (item: T) => string;
	maxPages: number;
}): Promise<WalkResult<T>> {
	const items: T[] = [];
	const seenKeys = new Set<string>();
	const seenTokens = new Set<string>();
	let token: string | null = null;
	let unkeyed = 0;
	for (let pageIndex = 0; pageIndex < args.maxPages; pageIndex += 1) {
		const page = await args.fetchPage(token);
		unkeyed += page.unkeyed ?? 0;
		let added = 0;
		for (const item of page.items) {
			const key = args.keyOf(item);
			if (!seenKeys.has(key)) {
				seenKeys.add(key);
				items.push(item);
				added += 1;
			}
		}
		if (page.nextToken === null) {
			return { complete: true, items, unkeyed };
		}
		if (page.items.length === 0 && (page.unkeyed ?? 0) === 0) {
			return {
				complete: false,
				items,
				unkeyed,
				reason: "an empty page still carried a next-page token",
			};
		}
		if (added === 0) {
			return {
				complete: false,
				items,
				unkeyed,
				reason: "a page repeated items already read",
			};
		}
		if (seenTokens.has(page.nextToken)) {
			return {
				complete: false,
				items,
				unkeyed,
				reason: "the next-page token repeated",
			};
		}
		seenTokens.add(page.nextToken);
		token = page.nextToken;
	}
	return {
		complete: false,
		items,
		unkeyed,
		reason: `stopped at the ${args.maxPages}-page cap before the list ended`,
	};
}

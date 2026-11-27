// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the WhatsApp (web) in-page store answers. Each `parse*`
 * validates the raw answer at the boundary with zod and returns null when its
 * shape is not the one the app uses (the shapes of `fixtures-live/`), so the
 * caller fails the stream instead of emitting records built from guesses.
 * Each `build*` turns one validated source item into the record its stream
 * declares.
 *
 * Text: every free-text value goes through `cleanText`, which keeps the
 * source text unchanged when it is PDPP-safe and otherwise replaces it with
 * null and counts the replacement (`TextTally`), so the collector can report
 * it instead of dropping it silently.
 *
 * Secret fields the source may carry on a message (mediaKey, encIv, encFilehash,
 * filehash, directPath, deprecatedMms3Url, messageSecret, botMessageSecret,
 * tcToken, token, thumbnail bytes) are never read and never emitted: only the
 * metadata fields the streams declare are touched.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import { z } from "zod";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { TEXT_MAX_UNITS } from "./schemas.ts";

// ─── Text ───────────────────────────────────────────────────────────────

/** Count of free-text values replaced with null because they were not PDPP-safe. */
export class TextTally {
	readonly byStream = new Map<string, number>();
	add(stream: string, count: number): void {
		if (count > 0)
			this.byStream.set(stream, (this.byStream.get(stream) ?? 0) + count);
	}
}

export interface CleanText {
	value: string | null;
	/** The safety check's reason when a non-empty string was replaced with null. */
	reason: string | null;
}

/** The source string unchanged when it is PDPP-safe text; null otherwise. */
export function cleanText(value: unknown, max = TEXT_MAX_UNITS): CleanText {
	if (typeof value !== "string") return { value: null, reason: null };
	if (value === "") return { value: "", reason: null };
	const result = safeTextPreview(value, max);
	if (result.kind === "text" && !result.truncated) {
		return { value, reason: null };
	}
	return {
		value: null,
		reason: result.reason ?? (result.truncated ? "exceeds_inline_cap" : null),
	};
}

/** Collects replaced-text counts while one record is built. */
class TextScope {
	replaced = 0;
	text(value: unknown, max = TEXT_MAX_UNITS): string | null {
		const r = cleanText(value, max);
		if (r.value === null && r.reason !== null) this.replaced += 1;
		return r.value;
	}
}

// ─── Times ──────────────────────────────────────────────────────────────

// Epoch milliseconds between 2000-01-01 and 2200-01-01: anything else is not a
// time this source would report.
const MIN_MS = 946_684_800_000;
const MAX_MS = 7_258_118_400_000;

/** Epoch seconds (UTC) as RFC 3339 with `Z`; null when not a plausible time. */
export function secondsToIso(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const ms = value * 1000;
	if (ms < MIN_MS || ms > MAX_MS) return null;
	return new Date(ms).toISOString();
}

// ─── id / server / kind ─────────────────────────────────────────────────

/**
 * `user` when the id's server is a person server (`c.us`, `lid` or the legacy
 * `s.whatsapp.net`), `group` for `g.us`, else `other` (broadcast lists,
 * newsletters, status). The live chat list carries the server on each chat;
 * when it is absent it falls back to the part after the id's `@`.
 */
export function chatKind(
	id: string,
	server?: string | null,
): "user" | "group" | "other" {
	const raw =
		typeof server === "string" && server !== ""
			? server
			: (id.split("@").at(1) ?? "");
	if (raw === "g.us") return "group";
	if (raw === "c.us" || raw === "lid" || raw === "s.whatsapp.net")
		return "user";
	return "other";
}

// ─── WAWebCollections.Chat → chats ──────────────────────────────────────

const rawChatSchema = z.object({
	id: z.string().min(1).max(1024),
	server: z.string().max(100).nullable().optional(),
	title: z.string().max(10_000).nullable().optional(),
	t: z.number().nullable().optional(),
	archive: z.boolean().nullable().optional(),
	pin: z.union([z.boolean(), z.number()]).nullable().optional(),
	mute_expiration: z.number().nullable().optional(),
	unread_count: z.number().nullable().optional(),
	read_only: z.boolean().nullable().optional(),
	history_state: z.string().max(200).nullable().optional(),
	msgs_in_memory: z.number().nullable().optional(),
});
export type WaChat = z.infer<typeof rawChatSchema>;

/**
 * Names of endOfHistoryTransferType as the app's own module names them (the
 * `history-sync` observation). The number-to-name table is what the stream's
 * `history_state` field holds, so a run of the connector reads like the app's
 * own state names; the page script uses it as its fallback table too.
 */
export const END_OF_HISTORY_TRANSFER_NAMES: Record<number, string> = {
	0: "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY",
	1: "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY",
	2: "INCOMPLETE",
	3: "NOT_INCLUDED_IN_HIST_SYNC",
	4: "COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY",
	5: "COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS",
};

export function historyStateName(value: unknown): string | null {
	if (typeof value !== "number" || !Number.isInteger(value)) return null;
	return END_OF_HISTORY_TRANSFER_NAMES[value] ?? null;
}

/**
 * True when the chat's history state is one the on-demand history request is
 * for (0 COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY or 2 INCOMPLETE): the
 * chat says more of its history is still on the phone and the client has not
 * yet asked for it.
 */
export function needsHistoryRequest(historyState: string | null): boolean {
	return (
		historyState === "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY" ||
		historyState === "INCOMPLETE"
	);
}

/**
 * True when the chat's older history is out of this client's reach and the
 * run must gap it visibly — never walk it and call its coverage complete:
 *
 * - 0 COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY after the chat's one
 *   on-demand request: the phone never answered it within the run's bounded
 *   wait.
 * - 4 COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY: the on-demand
 *   sync answered, but the state still says more messages remain on the
 *   phone — messages beyond what the client's local store holds. Walking the
 *   local store to its short page would report those messages as covered
 *   when they are not, so the chat gaps visibly and is retried next run.
 * - 5 COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS: the
 *   device has no access to what remains on the phone at all.
 */
export function historyOutOfReach(historyState: string | null): boolean {
	return (
		historyState === "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY" ||
		historyState === "COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY" ||
		historyState ===
			"COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS"
	);
}

/**
 * The chat's mute, from the model's `muteExpiration` (epoch seconds, default
 * 0), exactly as the source holds it: 0 or absent is no mute; the app's
 * mute-always value (-1, any negative) is a mute with no end; a positive
 * value is a mute that ends at that time. `muted` says a mute is set; it is
 * not compared with the run's clock, so the record changes only when the
 * source does, and whether a timed mute is still in force is `muted_until`
 * against the reader's own clock.
 */
export function chatMute(muteExpiration: number | null | undefined): {
	muted: boolean;
	muted_until: string | null;
} {
	if (typeof muteExpiration !== "number" || muteExpiration === 0)
		return { muted: false, muted_until: null };
	if (muteExpiration < 0) return { muted: true, muted_until: null };
	return { muted: true, muted_until: secondsToIso(muteExpiration) };
}

/**
 * True when, after the run's one on-demand request (or without it, when it
 * could not be sent), the chat still says part of its history is on the
 * phone and not on this device: the local walk is emitted, and the remainder
 * gets a visible gap.
 */
export function historyRemainsOnPhone(historyState: string | null): boolean {
	return historyOutOfReach(historyState) || needsHistoryRequest(historyState);
}

/** One chat record. */
export function buildChat(
	chat: WaChat,
	tally: TextTally,
): { record: RecordData; replaced: number } {
	const scope = new TextScope();
	const mute = chatMute(chat.mute_expiration);
	const record: RecordData = {
		id: chat.id,
		kind: chatKind(chat.id, chat.server),
		title: scope.text(chat.title),
		last_activity_at: secondsToIso(chat.t),
		archived: chat.archive === true,
		pinned: typeof chat.pin === "number" ? chat.pin > 0 : chat.pin === true,
		muted: mute.muted,
		muted_until: mute.muted_until,
		unread_count: typeof chat.unread_count === "number" ? chat.unread_count : 0,
		read_only: chat.read_only === true,
		history_state: chat.history_state ?? null,
	};
	tally.add("chats", scope.replaced);
	return { record, replaced: scope.replaced };
}

const rawChatsPageSchema = z.array(z.unknown());

/** The chat list page (or the full in-memory collection). */
export function parseChatsPage(raw: unknown): WaChat[] | null {
	const parsed = rawChatsPageSchema.safeParse(raw);
	if (!parsed.success) return null;
	const chats: WaChat[] = [];
	for (const chat of parsed.data) {
		const c = rawChatSchema.safeParse(chat);
		if (!c.success) return null;
		chats.push(c.data);
	}
	return chats;
}

// ─── Messages ───────────────────────────────────────────────────────────

/**
 * One message row as the page's own message models map to plain data: the
 * fields `fixtures-live/messages-in-memory.json` and
 * `fixtures-live/messages-local.json` hold. Media keys, encrypted hashes and
 * paths are not named here, so zod strips them at the boundary.
 */
/**
 * A wid as the page hands it back: the serialized string, or (when a mapper
 * passes the client's wid object through) an object whose `_serialized` is
 * that string. Either way the record holds the string.
 */
const widSchema = z.union([
	z.string().max(1024),
	z
		.object({ _serialized: z.string().min(1).max(1024) })
		.passthrough()
		.transform((wid) => wid._serialized),
]);

const rawMessageSchema = z.object({
	id: z.string().min(1).max(1024),
	remote: z.string().min(1).max(1024),
	from_me: z.boolean().nullable().optional(),
	author: widSchema.nullable().optional(),
	type: z.string().max(200).nullable().optional(),
	subtype: z.string().max(200).nullable().optional(),
	body: z.string().max(TEXT_MAX_UNITS).nullable().optional(),
	caption: z.string().max(TEXT_MAX_UNITS).nullable().optional(),
	t: z.number().nullable().optional(),
	quoted_id: z.string().max(1024).nullable().optional(),
	quoted_participant: z.string().max(1024).nullable().optional(),
	is_forwarded: z.boolean().nullable().optional(),
	star: z.boolean().nullable().optional(),
	mimetype: z.string().max(200).nullable().optional(),
	size: z.number().nullable().optional(),
	filename: z.string().max(1024).nullable().optional(),
	duration: z.union([z.number(), z.string()]).nullable().optional(),
	call_duration: z.number().nullable().optional(),
	call_outcome: z.string().max(200).nullable().optional(),
	is_video_call: z.boolean().nullable().optional(),
	poll_name: z.string().max(10_000).nullable().optional(),
	lat: z.number().nullable().optional(),
	lng: z.number().nullable().optional(),
	loc: z.string().max(10_000).nullable().optional(),
	vcard_name: z.string().max(10_000).nullable().optional(),
	title: z.string().max(10_000).nullable().optional(),
	description: z.string().max(10_000).nullable().optional(),
	url: z.string().max(10_000).nullable().optional(),
});
export type WaMessage = z.infer<typeof rawMessageSchema>;

/** A flat list of message rows, e.g. the messages a chat holds in memory. */
export function parseMessagesList(raw: unknown): WaMessage[] | null {
	const parsed = z.array(z.unknown()).safeParse(raw);
	if (!parsed.success) return null;
	const messages: WaMessage[] = [];
	for (const row of parsed.data) {
		const m = rawMessageSchema.safeParse(row);
		if (!m.success) return null;
		messages.push(m.data);
	}
	return messages;
}

const chatWalkSchema = z.object({
	chat_id: z.string().min(1).max(1024),
	status: z.number(),
	memory: z.array(z.unknown()).nullable().optional(),
	messages: z.array(z.unknown()).nullable().optional(),
	complete: z.boolean().nullable().optional(),
	anchored: z.boolean().nullable().optional(),
	stop: z.string().max(100).nullable().optional(),
	me_id: z.string().max(1024).nullable().optional(),
	more: z.boolean().nullable().optional(),
	token: z.string().min(1).max(200).nullable().optional(),
});

/**
 * One chat's full message walk: the messages the client holds in memory
 * (`memory`, the newest) plus the older ones the local store returned, with
 * `complete` saying the walk ended on the store's own short page and
 * `anchored` saying there was an in-memory message to page back from.
 */
export interface ChatMessageWalk {
	chat_id: string;
	status: number;
	memory: WaMessage[];
	messages: WaMessage[];
	complete: boolean;
	anchored: boolean;
	/**
	 * Why the walk stopped: `short_page` (the store's own end), `empty` (the
	 * chat has no activity), `status` (a non-200 page), `page_cap` (the
	 * walk's page budget ran out), `no_progress` (a page repeated its anchor),
	 * `no_anchor` (nothing in memory to page back from), or null when absent.
	 */
	stop: string | null;
	/** The signed-in account's own id, when the page has it. */
	me_id: string | null;
	/**
	 * True when this chunk stopped only on its page budget: the walk goes on
	 * with the next chunk, asked for with `token`.
	 */
	more: boolean;
	token: string | null;
}

export function parseChatWalk(raw: unknown): ChatMessageWalk | null {
	const walk = chatWalkSchema.safeParse(raw);
	if (!walk.success) return null;
	const memory: WaMessage[] = [];
	for (const row of walk.data.memory ?? []) {
		const m = rawMessageSchema.safeParse(row);
		if (!m.success) return null;
		memory.push(m.data);
	}
	const messages: WaMessage[] = [];
	for (const row of walk.data.messages ?? []) {
		const m = rawMessageSchema.safeParse(row);
		if (!m.success) return null;
		messages.push(m.data);
	}
	return {
		chat_id: walk.data.chat_id,
		status: walk.data.status,
		memory,
		messages,
		complete: walk.data.complete ?? false,
		anchored: walk.data.anchored ?? false,
		stop: walk.data.stop ?? null,
		me_id: walk.data.me_id ?? null,
		more: walk.data.more === true && typeof walk.data.token === "string",
		token: walk.data.token ?? null,
	};
}

/**
 * Message types whose `duration` the app formats as seconds (its clock's
 * duration string and its voice-note telemetry both read it as seconds).
 * Any other type's `duration` has no known unit (the interactive sample's
 * digit string is one) and is not emitted.
 */
const SECONDS_DURATION_TYPES = new Set(["audio", "ptt", "video", "gif", "ptv"]);

/** A whole non-negative count from a number or a digit string; else null. */
function wholeCount(value: unknown): number | null {
	const n =
		typeof value === "number"
			? value
			: typeof value === "string" && /^\d+$/u.test(value)
				? Number(value)
				: null;
	return n !== null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** What a message's author depends on beyond the row itself. */
export interface MessageContext {
	/** The parent chat's kind. */
	kind?: "user" | "group" | "other";
	/** The signed-in account's own id, when the page has it. */
	meId?: string | null;
}

/**
 * The message's sender. In a group, the participant the model names
 * (`author`, or the key's participant), or the owner for the owner's own
 * message. In a one-to-one chat, the owner (from_me) or the chat peer. Null
 * only when the page does not say.
 */
function messageAuthor(
	row: WaMessage,
	chatId: string,
	context: MessageContext,
): string | null {
	const me = context.meId ?? null;
	const fromMe = row.from_me === true;
	if (context.kind === "user") return fromMe ? me : chatId;
	const named = row.author ?? null;
	if (named !== null && named !== "") return named;
	return fromMe ? me : null;
}

/**
 * One message record. `chatId` is the id the walk itself collected — the
 * parent chat's id, the same string the chats stream emitted — so the child
 * record's `chat_id` links to the parent even where the message model's
 * `id.remote` serializes differently (the app's lid/c.us dual ids). The
 * remote is only the fallback when no parent id was handed in.
 */
export function buildMessage(
	row: WaMessage,
	tally: TextTally,
	chatId?: string | null,
	context: MessageContext = {},
): { record: RecordData; replaced: number } {
	const scope = new TextScope();
	const isChatText = row.type === "chat";
	const text = isChatText ? scope.text(row.body) : scope.text(row.caption);
	const parentId =
		typeof chatId === "string" && chatId !== "" ? chatId : row.remote;
	const mediaDuration = SECONDS_DURATION_TYPES.has(row.type ?? "")
		? wholeCount(row.duration)
		: null;
	const callDuration =
		row.type === "call_log" ? wholeCount(row.call_duration) : null;
	const record: RecordData = {
		id: row.id,
		chat_id: parentId,
		from_me: row.from_me === true,
		author: messageAuthor(row, parentId, context),
		type: row.type ?? null,
		subtype: row.subtype ?? null,
		text,
		sent_at: secondsToIso(row.t),
		quoted_id: row.quoted_id ?? null,
		is_forwarded: row.is_forwarded === true,
		starred: row.star === true,
		media_mimetype: typeof row.mimetype === "string" ? row.mimetype : null,
		media_size: typeof row.size === "number" ? row.size : null,
		media_filename: typeof row.filename === "string" ? row.filename : null,
		media_duration: mediaDuration,
		call_log: typeof row.call_outcome === "string" ? row.call_outcome : null,
		call_duration: callDuration,
		poll_name: scope.text(row.poll_name),
		location_lat: typeof row.lat === "number" ? row.lat : null,
		location_lng: typeof row.lng === "number" ? row.lng : null,
	};
	tally.add("messages", scope.replaced);
	return { record, replaced: scope.replaced };
}

// ─── Contact store → contacts ────────────────────────────────────────────

const rawContactSchema = z.object({
	id: z.string().min(1).max(1024),
	name: z.string().max(10_000).nullable().optional(),
	short_name: z.string().max(10_000).nullable().optional(),
	push_name: z.string().max(10_000).nullable().optional(),
	is_business: z.boolean().nullable().optional(),
	verified_name: z.string().max(10_000).nullable().optional(),
});
export type WaContact = z.infer<typeof rawContactSchema>;

/** One contact record. */
export function buildContact(
	contact: WaContact,
	tally: TextTally,
): { record: RecordData; replaced: number } {
	const scope = new TextScope();
	const record: RecordData = {
		id: contact.id,
		name: scope.text(contact.name),
		short_name: scope.text(contact.short_name),
		push_name: scope.text(contact.push_name),
		is_business: contact.is_business ?? null,
		verified_name: scope.text(contact.verified_name),
	};
	tally.add("contacts", scope.replaced);
	return { record, replaced: scope.replaced };
}

const rawContactsPageSchema = z.array(z.unknown());

/** The contact collection filtered to the ids the run's chats and groups hold. */
export function parseContactsPage(raw: unknown): WaContact[] | null {
	const parsed = rawContactsPageSchema.safeParse(raw);
	if (!parsed.success) return null;
	const contacts: WaContact[] = [];
	for (const contact of parsed.data) {
		const c = rawContactSchema.safeParse(contact);
		if (!c.success) return null;
		contacts.push(c.data);
	}
	return contacts;
}

// ─── WAWebGroupMetadataCollection → groups ──────────────────────────────

const rawParticipantSchema = z.object({
	id: z.string().min(1).max(1024),
	is_admin: z.boolean().nullable().optional(),
	is_super_admin: z.boolean().nullable().optional(),
});

const rawGroupSchema = z.object({
	id: z.string().min(1).max(1024),
	subject: z.string().max(10_000).nullable().optional(),
	creation: z.number().nullable().optional(),
	owner: z.string().max(1024).nullable().optional(),
	announce: z.boolean().nullable().optional(),
	restrict: z.boolean().nullable().optional(),
	// Each participant is validated here, at the boundary: a group whose
	// participant list is not the app's own shape fails the parse instead of
	// silently dropping participants.
	participants: z.array(rawParticipantSchema).nullable().optional(),
});
export type WaGroup = z.infer<typeof rawGroupSchema>;

/** One group record. */
export function buildGroup(
	group: WaGroup,
	tally: TextTally,
): { record: RecordData; replaced: number } {
	const scope = new TextScope();
	const participants = (group.participants ?? []).map((p) => ({
		id: p.id,
		is_admin: p.is_admin === true,
		is_super_admin: p.is_super_admin === true,
	}));
	const record: RecordData = {
		id: group.id,
		subject: scope.text(group.subject),
		created_at: secondsToIso(group.creation),
		owner: group.owner ?? null,
		participants,
	};
	tally.add("groups", scope.replaced);
	return { record, replaced: scope.replaced };
}

const rawGroupsPageSchema = z.array(z.unknown());

/** The group metadata collection (or one of its pages). */
export function parseGroupsPage(raw: unknown): WaGroup[] | null {
	const parsed = rawGroupsPageSchema.safeParse(raw);
	if (!parsed.success) return null;
	const groups: WaGroup[] = [];
	for (const group of parsed.data) {
		const g = rawGroupSchema.safeParse(group);
		if (!g.success) return null;
		groups.push(g.data);
	}
	return groups;
}

// ─── Page-readiness and history-request answers ─────────────────────────

/**
 * What the page's module stores look like to the connector, as plain flags
 * (the module objects themselves cannot cross the evaluate boundary).
 * `chats`, `contacts` and `groups` come from one collection module;
 * `find_messages` is the local message store; `send_request` is the
 * on-demand history request, which only some chats need.
 */
export interface StoresReadiness {
	require_function: boolean;
	chats: boolean;
	contacts: boolean;
	groups: boolean;
	find_messages: boolean;
	send_request: boolean;
}

/**
 * The readiness the collector waits for: the module loader, the chat
 * collection every stream reads (messages for their parents, contacts and
 * groups for the ids they cover), and the stores of the requested streams
 * only. `send_request` is deliberately not required: a chat that needs the
 * on-demand request gaps visibly when it is missing.
 */
export function storesReady(
	readiness: StoresReadiness,
	streams: ReadonlySet<string> = new Set([
		"chats",
		"messages",
		"contacts",
		"groups",
	]),
): boolean {
	const needsGroups = streams.has("groups") || streams.has("contacts");
	return (
		readiness.require_function &&
		readiness.chats &&
		(!streams.has("contacts") || readiness.contacts) &&
		(!needsGroups || readiness.groups) &&
		(!streams.has("messages") || readiness.find_messages)
	);
}

export function parseStoresReadiness(raw: unknown): StoresReadiness | null {
	const parsed = z
		.object({
			require_function: z.boolean(),
			chats: z.boolean(),
			contacts: z.boolean(),
			groups: z.boolean(),
			find_messages: z.boolean(),
			send_request: z.boolean(),
		})
		.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** The on-demand history request's own answer: whether it was sent. */
export function parseHistoryAck(raw: unknown): { sent: boolean } | null {
	const parsed = z.object({ sent: z.boolean() }).safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/**
 * The client's own sync state: the socket stream's mode (`MAIN` once the
 * client runs normally, `QR` when signed out) and whether the offline resume
 * (the catch-up of what arrived while the client was away) has completed.
 */
export interface SyncState {
	mode: string | null;
	resume_complete: boolean | null;
}

export function parseSyncState(raw: unknown): SyncState | null {
	const parsed = z
		.object({
			mode: z.string().max(100).nullable(),
			resume_complete: z.boolean().nullable(),
		})
		.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

/** True when the client says it is running normally and has caught up. */
export function syncSettled(state: SyncState): boolean {
	return state.mode === "MAIN" && state.resume_complete === true;
}

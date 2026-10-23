#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP WhatsApp (web) connector: chats, messages, contacts and groups, read
 * from the signed-in web.whatsapp.com page's own in-page stores.
 *
 * The connector runs inside a tab the host provides, already past login. It
 * talks to the page's own modules (WAWebCollections.Chat,
 * WAWebDBMessageFindLocal, WAWebGroupMetadataCollection and the contact
 * store) through the page's module loader, the way the app itself calls them.
 * Every script runs in the page's MAIN world: an isolated world (the browser
 * runtime's default for evaluate) does not see the app's `window.require`, so
 * the stores are unreachable from it. Nothing is reverse-engineered on the
 * wire and no credential leaves the page.
 *
 * Read-only by construction: every call except the single on-demand history
 * request per chat is a read of the page's local stores. The history request
 * (HISTORY_SYNC_ON_DEMAND) is what the UI's "get older messages from your
 * phone" button does, once per chat that needs it and only to read that chat's
 * own history.
 *
 * Streams and their end signals:
 *   - chats: one record per chat in the page's chat collection; the list ends
 *     when the collection's own id set stops growing between reads.
 *   - messages: child of chats with parent_detail_accounting; per chat, the
 *     newest messages the client holds in memory plus older ones paged back
 *     with msgFindBefore until its own short page, always anchored on the
 *     client's own message keys. Every message the local store holds is
 *     emitted. A chat whose walk cannot complete, or whose history state
 *     still says messages remain on the phone after its one on-demand
 *     history request (0, 2 or 4) or can never be answered (state 5, no
 *     access), then gets a visible DETAIL_GAP for that remainder, never a
 *     silent omission.
 *   - contacts: only contacts that appear in the owner's chats or groups.
 *   - groups: one record per group in the page's group metadata collection.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import {
	type BrowserCollectContext,
	createConnectorFailure,
	type EnsureSessionArgs,
	emitDetailCoverage,
	emitDetailGap,
	type ProbeSessionArgs,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildChat,
	buildContact,
	buildGroup,
	buildMessage,
	chatKind,
	END_OF_HISTORY_TRANSFER_NAMES,
	historyRemainsOnPhone,
	needsHistoryRequest,
	parseChatsPage,
	parseChatWalk,
	parseContactsPage,
	parseGroupsPage,
	parseHistoryAck,
	parseStoresReadiness,
	storesReady,
	TextTally,
	type WaChat,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const WHATSAPP_HOME_URL = `${WHATSAPP_ORIGIN}/`;
export const WHATSAPP_LOGIN_MESSAGE =
	"Sign in to WhatsApp in the secure browser. The import continues automatically once the WhatsApp Web app has loaded.";

const CHATS = "chats";
const MESSAGES = "messages";
const CONTACTS = "contacts";
const GROUPS = "groups";

/** The app's own page size for msgFindBefore. */
export const MESSAGE_PAGE_SIZE = 50;
/** A chat's walk reads at most this many local pages before it reports short. */
const MAX_MESSAGE_PAGES = 40;
/** How long to wait for the page's own module stores to be ready. */
const STORE_WAIT_ATTEMPTS = 40;
const STORE_WAIT_MS = 1_500;
/** Version of the streams' cursors. */
const CURSOR_VERSION = 2;

/** The collection's pacing, overridable so tests do not sleep. */
export interface CollectionTimings {
	/** Reads of the chat list until its id set stops growing. */
	settleAttempts: number;
	settleMs: number;
	/** Reads of the chat list while a chat's on-demand history settles. */
	historyAttempts: number;
	historyMs: number;
}

export const DEFAULT_TIMINGS: CollectionTimings = {
	settleAttempts: 12,
	settleMs: 1_500,
	historyAttempts: 20,
	historyMs: 1_500,
};

/** What the store helpers need from a page: run a script string in it. */
export interface ScriptRunner {
	evaluate(script: string): Promise<unknown>;
}

type Page = BrowserCollectContext["page"];

/** The evaluate the main-world wrapper needs, structurally. */
export type MainWorldPage = { evaluate: Page["evaluate"] };

/**
 * Runs scripts in the page's MAIN world. The app's module loader
 * (`window.require`) is an expando property of the page's own window, which
 * an isolated world (the browser runtime's default for evaluate) does not
 * have, so the WhatsApp Web stores are only reachable from the main world.
 */
export function mainWorld(page: MainWorldPage): ScriptRunner {
	const target = page as unknown as {
		evaluate(
			expression: string,
			arg: undefined,
			options: undefined,
			isolatedContext: false,
		): Promise<unknown>;
	};
	return {
		evaluate: (script) => target.evaluate(script, undefined, undefined, false),
	};
}

// ─── The page's own WhatsApp Web stores ──────────────────────────────────

/**
 * Refuse anything but the page's own read methods, and the one history request
 * the source permits. This is the whole write surface, and it only writes what
 * the UI's "get older messages from your phone" button writes.
 */
export function assertReadOnlyCall(
	method:
		| "listChats"
		| "readChatMessages"
		| "listContacts"
		| "listGroups"
		| "sendHistorySyncOnDemand",
	params: Record<string, unknown>,
): void {
	if (method !== "sendHistorySyncOnDemand") return;
	if (typeof params.chatId !== "string" || params.chatId === "") {
		throw createConnectorFailure(
			"whatsapp_web_refused_call",
			"chatId required for the on-demand history request",
			{ retryable: false },
		);
	}
}

/** The page's wid-to-string helper, shared by every store script. */
const WID_FN = `const w = (x) => x == null ? null : typeof x === "string" ? x : String(x._serialized ?? x.toString());`;

/**
 * The page's message-model-to-row mapping, shared by the in-memory read and
 * the local walk. It reads only the metadata fields the streams declare: the
 * media key, encrypted hashes and paths, and other secret fields the models
 * also carry are never named here, so they are never read and never emitted.
 */
const MESSAGE_ROW_MAPPER = `const mapRow = (m) => ({
	id: w(m.id),
	from_me: !!(m.id && m.id.fromMe),
	remote: w(m.id && m.id.remote),
	author: w(m.author ?? (m.id && m.id.participant)),
	type: m.type,
	subtype: m.subtype ?? null,
	body: ["chat"].includes(m.type) ? m.body ?? null : null,
	caption: m.caption ?? null,
	t: m.t,
	quoted_id: w(m.quotedStanzaID),
	quoted_participant: w(m.quotedParticipant),
	mimetype: m.mimetype ?? null,
	size: m.size ?? null,
	filename: m.filename ?? null,
	duration: m.duration ?? null,
	is_forwarded: !!m.isForwarded,
	star: !!m.star,
	ack: m.ack ?? null,
	is_view_once: !!m.isViewOnce,
	call_duration: m.callDuration ?? null,
	call_outcome: m.callOutcome ?? null,
	is_video_call: m.isVideoCall ?? null,
	poll_name: m.pollName ?? null,
	lat: m.lat ?? null,
	lng: m.lng ?? null,
	loc: m.loc ?? null,
	vcard_name: m.vcardFormattedName ?? null,
	title: m.title ?? null,
	description: m.description ?? null,
	url: null,
});`;

/**
 * The readiness probe: plain flags about the page's own module stores. The
 * module objects themselves cannot cross the evaluate boundary (they are live,
 * circular structures), so the probe reports what is callable instead.
 */
export const STORES_SCRIPT = `
(() => {
	const mod = (name) => { try { return window.require(name); } catch { return null; } };
	const collections = mod("WAWebCollections");
	const find = mod("WAWebDBMessageFindLocal");
	const send = mod("WAWebSendNonMessageDataRequest");
	const has = (c, name) => !!(c && c[name] && typeof c[name].getModelsArray === "function");
	return {
		require_function: typeof window.require === "function",
		chats: has(collections, "Chat"),
		contacts: has(collections, "Contact"),
		groups: has(collections, "WAWebGroupMetadataCollection"),
		find_messages: !!(find && typeof find.msgFindBefore === "function"),
		send_request: !!(send && typeof send.sendPeerDataOperationRequest === "function"),
	};
})()
`;

/** A read of the page's chat collection, mapped to the observed plain shape. */
export async function listChats(page: ScriptRunner): Promise<unknown> {
	assertReadOnlyCall("listChats", {});
	return page.evaluate(`
	(() => {
		${WID_FN}
		const { Chat } = window.require("WAWebCollections");
		const K = (() => { try { return window.require("WAWebChatConstants").ConversationEndOfHistoryTransferModelPropType; } catch { return null; } })();
		const names = K ? Object.getOwnPropertyNames(K) : null;
		const FALLBACK = ${JSON.stringify(END_OF_HISTORY_TRANSFER_NAMES)};
		const st = (v) => {
			if (v == null) return null;
			const name = names ? names.find((k) => K[k] === v) : null;
			if (name != null) return name;
			return FALLBACK[String(v)] ?? String(v);
		};
		return Chat.getModelsArray().map((c) => ({
			id: w(c.id),
			server: w(c.server ?? (c.id && c.id.server)),
			title: c.formattedTitle ?? null,
			t: c.t ?? null,
			archive: !!c.archive,
			pin: c.pin ?? null,
			mute_expiration: c.muteExpiration ?? null,
			unread_count: c.unreadCount ?? 0,
			read_only: !!c.isReadOnly,
			history_state: st(c.endOfHistoryTransferType),
			msgs_in_memory: c.msgs ? c.msgs.getModelsArray().length : 0,
		}));
	})()
	`);
}

/**
 * One chat's full message walk, in a single in-page script. The local store's
 * `msgFindBefore` takes its anchor as the message model's own key object,
 * which cannot cross the evaluate boundary, so the page-after-page walk
 * lives in the page and the connector walks chat by chat.
 *
 * Anchors are only ever the client's own keys: the first is the newest
 * message the chat holds in memory, and each next one is the oldest message
 * of the page before (the store answers each page oldest first, strictly
 * before its anchor). A chat with activity but nothing in memory has no key
 * to page back from; the walk says so (`stop: "no_anchor"`) and never makes
 * an anchor up.
 *
 * The walk returns the in-memory messages and the older ones the local store
 * returned, deduplicated by id, with `complete` true only when it ended on
 * the store's own short page, and `stop` naming why it ended.
 */
export async function readChatMessages(
	page: ScriptRunner,
	chatId: string,
): Promise<unknown> {
	assertReadOnlyCall("readChatMessages", { chatId });
	return page.evaluate(`
	(async () => {
		${WID_FN}
		${MESSAGE_ROW_MAPPER}
		const chatId = ${JSON.stringify(chatId)};
		const PAGE_SIZE = ${MESSAGE_PAGE_SIZE};
		const MAX_PAGES = ${MAX_MESSAGE_PAGES};
		const { Chat } = window.require("WAWebCollections");
		const { msgFindBefore } = window.require("WAWebDBMessageFindLocal");
		const chat = Chat.get(chatId);
		// The owner's own id, in the same addressing (phone number or lid) as
		// the chat, so a one-to-one chat's two authors read alike.
		const me = (() => { try { const M = window.require("WAWebUserPrefsMeUser"); const pn = M.getMaybeMePnUser(); const lid = M.getMaybeMeLidUser(); return w(chat && chat.id && chat.id.server === "c.us" ? (pn ?? lid) : (lid ?? pn)); } catch { return null; } })();
		if (!chat) return { chat_id: chatId, status: 404, memory: [], messages: [], complete: false, anchored: false, stop: "status", me_id: me };
		const memoryModels = chat.msgs ? chat.msgs.getModelsArray() : [];
		const memory = memoryModels.map(mapRow);
		const seen = new Set(memory.map((m) => m.id));
		const out = [];
		let anchorModel = null;
		for (const m of memoryModels) {
			if (m && m.id && (anchorModel == null || (m.t ?? 0) >= (anchorModel.t ?? 0))) anchorModel = m;
		}
		if (anchorModel == null) {
			const empty = !chat.t;
			return { chat_id: chatId, status: 200, memory, messages: [], complete: empty, anchored: false, stop: empty ? "empty" : "no_anchor", me_id: me };
		}
		let anchor = anchorModel.id;
		for (let page = 0; page < MAX_PAGES; page++) {
			const r = await msgFindBefore({ anchor: anchor, count: PAGE_SIZE });
			const status = r && typeof r.status === "number" ? r.status : 0;
			if (status !== 200) {
				return { chat_id: chatId, status, memory, messages: out, complete: false, anchored: true, stop: "status", me_id: me };
			}
			const rows = r && Array.isArray(r.messages) ? r.messages : [];
			for (const m of rows) {
				const id = w(m.id);
				if (!seen.has(id)) { seen.add(id); out.push(mapRow(m)); }
			}
			if (rows.length < PAGE_SIZE) {
				return { chat_id: chatId, status: 200, memory, messages: out, complete: true, anchored: true, stop: "short_page", me_id: me };
			}
			const oldest = rows[0];
			if (!oldest || !oldest.id || w(oldest.id) === w(anchor)) {
				return { chat_id: chatId, status: 200, memory, messages: out, complete: false, anchored: true, stop: "no_progress", me_id: me };
			}
			anchor = oldest.id;
		}
		return { chat_id: chatId, status: 200, memory, messages: out, complete: false, anchored: true, stop: "page_cap", me_id: me };
	})()
	`);
}

/**
 * A read of the page's contact collection, filtered to the ids this run's
 * chats and group participants hold — only contacts that appear in the
 * owner's chats or groups.
 */
export async function listContacts(
	page: ScriptRunner,
	ids: readonly string[],
): Promise<unknown> {
	assertReadOnlyCall("listContacts", { ids });
	if (ids.length === 0) return [];
	return page.evaluate(`
	(() => {
		${WID_FN}
		const { Contact } = window.require("WAWebCollections");
		const wanted = new Set(${JSON.stringify(ids)});
		return Contact.getModelsArray().filter((c) => wanted.has(w(c.id))).map((c) => ({
			id: w(c.id),
			name: c.name ?? null,
			short_name: c.shortName ?? c.short_name ?? null,
			push_name: c.pushname ?? c.pushName ?? null,
			is_business: !!c.isBusiness,
			verified_name: c.verifiedName ?? null,
		}));
	})()
	`);
}

/** A read of the page's group metadata collection. */
export async function listGroups(page: ScriptRunner): Promise<unknown> {
	assertReadOnlyCall("listGroups", {});
	return page.evaluate(`
	(() => {
		${WID_FN}
		const { WAWebGroupMetadataCollection } = window.require("WAWebCollections");
		return WAWebGroupMetadataCollection.getModelsArray().map((g) => ({
			id: w(g.id),
			subject: g.subject ?? null,
			creation: g.creation ?? null,
			owner: w(g.owner),
			announce: !!g.announce,
			restrict: !!g.restrict,
			participants: g.participants ? g.participants.getModelsArray().map((p) => ({ id: w(p.id), is_admin: !!p.isAdmin, is_super_admin: !!p.isSuperAdmin })) : [],
		}));
	})()
	`);
}

/**
 * The single on-demand history request a chat may get, the same one the UI's
 * "get older messages from your phone" button sends. Gated by the app's own
 * history-sync-on-demand switch, sent only when that switch verifiably reads
 * true; a gate that cannot be read, or a failure to send, is reported as
 * `{sent: false}` so the caller can gap the chat visibly instead of guessing.
 */
export async function sendHistorySyncOnDemand(
	page: ScriptRunner,
	chatId: string,
): Promise<unknown> {
	assertReadOnlyCall("sendHistorySyncOnDemand", { chatId });
	return page.evaluate(`
	(async () => {
		// Only a verified true sends: a gate that throws or answers anything
		// else means the request is not sent and the chat is gapped.
		let gate;
		try { gate = window.require("WAWebSyncGatingUtils").isHistorySyncOnDemandEnabled(); } catch { return { sent: false, reason: "history_sync_on_demand_gate_unverified" }; }
		if (gate !== true) return { sent: false, reason: gate === false ? "history_sync_on_demand_disabled" : "history_sync_on_demand_gate_unverified" };
		const sendPeerDataOperationRequest = window.require("WAWebSendNonMessageDataRequest").sendPeerDataOperationRequest;
		const HISTORY_SYNC_ON_DEMAND = window.require("WAWebProtobufsE2E.pb").Message$PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND;
		try {
			await sendPeerDataOperationRequest(HISTORY_SYNC_ON_DEMAND, { chatId: ${JSON.stringify(chatId)} });
			return { sent: true };
		} catch (error) {
			return { sent: false, reason: String((error && error.message) ?? error).slice(0, 300) };
		}
	})()
	`);
}

/** Read-only access to the page's own WhatsApp Web stores. */
export interface WhatsAppWebStores {
	listChats(): Promise<unknown>;
	readChatMessages(chatId: string): Promise<unknown>;
	listContacts(ids: readonly string[]): Promise<unknown>;
	listGroups(): Promise<unknown>;
	sendHistorySyncOnDemand(chatId: string): Promise<unknown>;
}

export class WhatsAppWebStore implements WhatsAppWebStores {
	private readonly page: ScriptRunner;
	constructor(page: ScriptRunner) {
		this.page = page;
	}
	listChats(): Promise<unknown> {
		return listChats(this.page);
	}
	readChatMessages(chatId: string): Promise<unknown> {
		return readChatMessages(this.page, chatId);
	}
	listContacts(ids: readonly string[]): Promise<unknown> {
		return listContacts(this.page, ids);
	}
	listGroups(): Promise<unknown> {
		return listGroups(this.page);
	}
	sendHistorySyncOnDemand(chatId: string): Promise<unknown> {
		return sendHistorySyncOnDemand(this.page, chatId);
	}
}

// ─── Wait helpers ────────────────────────────────────────────────────────

async function wait(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until the page's own module stores are ready for every stream. */
export async function waitForStores(
	page: ScriptRunner,
	attempts = STORE_WAIT_ATTEMPTS,
	waitMs = STORE_WAIT_MS,
): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		const handles = parseStoresReadiness(await page.evaluate(STORES_SCRIPT));
		if (handles !== null && storesReady(handles)) return;
		await wait(waitMs);
	}
	throw createConnectorFailure(
		"whatsapp_web_stores_not_ready",
		"the WhatsApp Web page's own module stores did not become available in time",
		{ retryable: true },
	);
}

// ─── Errors ─────────────────────────────────────────────────────────────

/** A schema check's issues, as one readable line. */
function issuesText(
	issues: ReadonlyArray<{ path: string; message: string }>,
): string {
	return issues.map((i) => `${i.path}: ${i.message}`).join("; ");
}

export class StreamFailure extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

// ─── Collection ─────────────────────────────────────────────────────────

interface ChatMark {
	t: number;
	history_state: string | null;
}

/**
 * chats cursor: for each chat, its last activity time and its history state
 * at the read. Chat ids, one number and one string; no credential. A chat is
 * read again when either value changed or is unknown.
 */

interface ChatItem {
	id: string;
	kind: "user" | "group" | "other";
	record: RecordData;
	needsHistory: boolean;
	t: number;
	history_state: string | null;
}

/** What the collection walk needs from the run's context, and nothing more. */
export type WhatsAppCollectContext = Pick<
	BrowserCollectContext,
	"emit" | "emitRecord"
>;

/**
 * The chat list is the page's own collection, still filling while the app
 * boots: read it again until its id set stops growing between reads, so the
 * run's chat inventory is the collection's own end, not a half-loaded list.
 */
async function settleChatList(
	stores: WhatsAppWebStores,
	timings: CollectionTimings,
): Promise<WaChat[]> {
	const first = parseChatsPage(await stores.listChats());
	if (first === null) {
		throw new StreamFailure(
			"whatsapp_web_unexpected_shape",
			"WhatsApp Web's chat collection came back in a shape the connector cannot read; nothing was checkpointed.",
		);
	}
	let current = first;
	for (let i = 0; i < timings.settleAttempts; i++) {
		await wait(timings.settleMs);
		const next = parseChatsPage(await stores.listChats());
		if (next === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's chat collection changed shape while the run read it; nothing was checkpointed.",
			);
		}
		const previousIds = new Set(current.map((c) => c.id));
		if (
			next.length === current.length &&
			next.every((c) => previousIds.has(c.id))
		) {
			return next;
		}
		current = next;
	}
	throw createConnectorFailure(
		"whatsapp_web_chat_list_never_settled",
		"WhatsApp Web's chat collection kept growing while the run read it; the inventory is not known to be complete, so nothing was checkpointed.",
		{ retryable: true },
	);
}

/**
 * One full pass: chats first, then their messages, then groups and contacts.
 */
export async function collectWith(
	ctx: WhatsAppCollectContext,
	stores: WhatsAppWebStores,
	tally: TextTally,
	timings: CollectionTimings = DEFAULT_TIMINGS,
): Promise<void> {
	const chats = await settleChatList(stores, timings);
	if (chats.length === 0) {
		throw createConnectorFailure(
			"whatsapp_web_empty_chat_list",
			"WhatsApp Web's chat collection is empty: the page may not be signed in, so the run cannot tell an empty account from a signed-out one and checkpoints nothing.",
			{ retryable: true },
		);
	}

	/** One read of the chat list, as each chat's history state now. */
	const readStates = async (): Promise<Map<string, string | null>> => {
		const fresh = parseChatsPage(await stores.listChats());
		if (fresh === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's chat collection came back in a shape the connector cannot read mid-run; nothing was checkpointed.",
			);
		}
		const states = new Map<string, string | null>();
		for (const c of fresh) states.set(c.id, c.history_state ?? null);
		return states;
	};

	// Restore the prior state: which chats were already read, so we don't re-read them.
	const chatItems: ChatItem[] = [];
	for (const chat of chats) {
		const built = buildChat(chat, tally);
		const checked = validateRecord(CHATS, built.record);
		if (!checked.ok) {
			throw new StreamFailure(
				"whatsapp_web_invalid_record",
				`chats record failed schema validation: ${issuesText(checked.issues)}`,
			);
		}
		// chats is mutable_state and messages is append_only keyed by id:
		// messages are re-walked for every chat in the run, even when the
		// chat's last-activity time is unchanged, because two messages may
		// share the same second (t unchanged) and an append-only stream must
		// not lose them silently.
		chatItems.push({
			id: chat.id,
			kind: chatKind(chat.id, chat.server),
			record: built.record,
			needsHistory: needsHistoryRequest(chat.history_state ?? null),
			t: typeof chat.t === "number" ? chat.t : 0,
			history_state: chat.history_state ?? null,
		});
	}

	// Contacts and groups: read for every chat id seen.
	const contactIds = new Set<string>();
	for (const item of chatItems) {
		if (item.kind === "user") contactIds.add(item.id);
	}

	// Emit the parents first.
	for (const item of chatItems) {
		await ctx.emitRecord(CHATS, item.record);
	}

	// Then walk the messages of every chat, with detail coverage.
	const requiredKeys = chatItems.map((c) => c.id);
	const hydratedKeys: string[] = [];
	const gapKeys: string[] = [];
	for (const item of chatItems) {
		let state = item.history_state;
		let requested = false;
		if (item.needsHistory) {
			// The chat says it has not yet asked for the history that remains
			// on the phone: one on-demand history request, what the UI's "get
			// older messages from your phone" button does, then a bounded wait
			// for it to settle.
			const ack = parseHistoryAck(
				await stores.sendHistorySyncOnDemand(item.id),
			);
			if (ack === null) {
				console.error(
					`whatsapp_web: the on-demand history request for chat ${item.id} answered in an unexpected shape; treating it as not sent`,
				);
			}
			if (ack?.sent === true) {
				requested = true;
				for (let i = 0; i < timings.historyAttempts; i++) {
					await wait(timings.historyMs);
					const states = await readStates();
					const freshState = states.get(item.id);
					if (freshState === undefined) {
						state = null;
						break;
					}
					state = freshState;
					if (!needsHistoryRequest(state)) break;
				}
			}
		}
		// Every chat's local store is walked and every message it holds is
		// emitted, whatever its history state: the store's messages are the
		// owner's whether or not more remain on the phone. Only then does a
		// chat get its one visible gap: for a walk that did not reach the
		// store's own end, or for the history that, after the chat's one
		// on-demand request (or without it, when it could not be sent), still
		// remains on the phone and not on this device.
		const walk = await walkMessagesForChat(ctx, stores, tally, item);
		const gap =
			walk.gap ??
			(historyRemainsOnPhone(state)
				? {
						reason: "retry_exhausted" as const,
						class: "history_remains_on_phone",
						message: `history state ${String(state)}; ${requested ? "after this run's on-demand history request" : "no on-demand history request was sent this run"}`,
					}
				: null);
		if (gap !== null) {
			await emitDetailGap(ctx, {
				stream: MESSAGES,
				parentStream: CHATS,
				recordKey: item.id,
				reason: gap.reason,
				locator: {
					kind: "whatsapp_web.chat_messages",
					chat_id: item.id,
				},
				error: { class: gap.class, message: gap.message },
			});
			gapKeys.push(item.id);
			continue;
		}
		hydratedKeys.push(item.id);
	}
	await emitDetailCoverage(ctx, {
		stream: MESSAGES,
		stateStream: CHATS,
		requiredKeys,
		hydratedKeys,
		gapKeys,
	});

	// groups: the page's own group metadata collection, whose participant ids
	// widen the contact set.
	const rawGroups = await stores.listGroups();
	const groups = parseGroupsPage(rawGroups);
	if (groups === null) {
		throw new StreamFailure(
			"whatsapp_web_unexpected_shape",
			"WhatsApp Web's group metadata collection came back in a shape the connector cannot read; nothing was checkpointed.",
		);
	}
	const groupBuilt: Array<{ record: RecordData }> = [];
	for (const group of groups) {
		const built = buildGroup(group, tally);
		const checked = validateRecord(GROUPS, built.record);
		if (!checked.ok) {
			throw new StreamFailure(
				"whatsapp_web_invalid_record",
				`groups record failed schema validation: ${issuesText(checked.issues)}`,
			);
		}
		groupBuilt.push(built);
		for (const p of group.participants ?? []) contactIds.add(p.id);
	}
	for (const built of groupBuilt) {
		await ctx.emitRecord(GROUPS, built.record);
	}
	await ctx.emit({
		type: "STATE",
		stream: GROUPS,
		cursor: {
			version: CURSOR_VERSION,
			ids: groupBuilt.map((b) => String(b.record.id)),
		},
	});

	// contacts: the page's contact collection filtered to the chat and group
	// participant ids seen above. An id the collection does not hold is not
	// silently dropped: it is counted, and the count is reported on stderr.
	const rawContacts = await stores.listContacts([...contactIds]);
	const contacts = parseContactsPage(rawContacts);
	if (contacts === null) {
		throw new StreamFailure(
			"whatsapp_web_unexpected_shape",
			"WhatsApp Web's contact collection came back in a shape the connector cannot read; nothing was checkpointed.",
		);
	}
	const contactBuilt: Array<{ record: RecordData }> = [];
	for (const contact of contacts) {
		const built = buildContact(contact, tally);
		const checked = validateRecord(CONTACTS, built.record);
		if (!checked.ok) {
			throw new StreamFailure(
				"whatsapp_web_invalid_record",
				`contacts record failed schema validation: ${issuesText(checked.issues)}`,
			);
		}
		contactBuilt.push(built);
	}
	for (const built of contactBuilt) {
		await ctx.emitRecord(CONTACTS, built.record);
	}
	const foundContactIds = new Set(contacts.map((c) => c.id));
	const missingContacts = [...contactIds].filter(
		(id) => !foundContactIds.has(id),
	);
	if (missingContacts.length > 0) {
		console.error(
			`whatsapp_web: ${missingContacts.length} of ${contactIds.size} chat or group-participant ids are not in the page's contact collection and were not imported: ${missingContacts.join(", ")}`,
		);
	}
	await ctx.emit({
		type: "STATE",
		stream: CONTACTS,
		cursor: {
			version: CURSOR_VERSION,
			ids: contactBuilt.map((b) => String(b.record.id)),
		},
	});

	// chats' STATE after all its records and its child's coverage.
	const marks: Record<string, ChatMark> = {};
	for (const item of chatItems) {
		marks[item.id] = { t: item.t, history_state: item.history_state };
	}
	await ctx.emit({
		type: "STATE",
		stream: CHATS,
		cursor: { version: CURSOR_VERSION, chats: marks },
	});
}

/** Why a chat's walk did not cover its local store, for its DETAIL_GAP. */
interface WalkGap {
	reason: "temporary_unavailable" | "retry_exhausted";
	class: string;
	message: string;
}

/**
 * The per-chat walk's outcome: every message it read is emitted either way;
 * `gap` is set when the walk did not reach the local store's own end.
 */
interface WalkOutcome {
	emitted: number;
	gap: WalkGap | null;
}

/** The gap a walk's stop reason means, or null for a walk that covered the store. */
export function walkGap(walk: {
	status: number;
	complete: boolean;
	stop: string | null;
}): WalkGap | null {
	if (walk.status !== 200) {
		return {
			reason: "temporary_unavailable",
			class: `local_store_status_${String(walk.status)}`,
			message:
				"the local message store answered a page with a non-200 status mid-walk",
		};
	}
	if (walk.complete) return null;
	if (walk.stop === "page_cap" || walk.stop === "no_progress") {
		return {
			reason: "retry_exhausted",
			class: "local_walk_page_cap",
			message: `the local walk stopped after its page budget (${walk.stop})`,
		};
	}
	if (walk.stop === "no_anchor") {
		return {
			reason: "temporary_unavailable",
			class: "no_in_memory_anchor",
			message:
				"the chat has activity but no message in memory, so there is no key of the client's own to page its local store from",
		};
	}
	return {
		reason: "temporary_unavailable",
		class: "local_walk_incomplete",
		message: `the local walk ended without the store's own short page (${String(walk.stop)})`,
	};
}

async function walkMessagesForChat(
	ctx: WhatsAppCollectContext,
	stores: WhatsAppWebStores,
	tally: TextTally,
	item: Pick<ChatItem, "id" | "kind">,
): Promise<WalkOutcome> {
	const chatId = item.id;
	let raw: unknown;
	try {
		raw = await stores.readChatMessages(chatId);
	} catch (error) {
		console.error(
			`whatsapp_web: failed to read messages of chat ${chatId}:`,
			error,
		);
		return {
			emitted: 0,
			gap: {
				reason: "temporary_unavailable",
				class: "local_walk_failed",
				message: "the in-page message walk threw",
			},
		};
	}
	// Fail loudly on shape/schema problems: they are not source
	// unavailability, so they must not become a DETAIL_GAP.
	const parsed = parseChatWalk(raw);
	if (parsed === null || parsed.chat_id !== chatId) {
		throw new StreamFailure(
			"whatsapp_web_unexpected_shape",
			"WhatsApp Web's message walk came back in a shape the connector cannot read.",
		);
	}
	const seen = new Set<string>();
	for (const row of [...parsed.memory, ...parsed.messages]) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		// chat_id is the walk's own chat id — the same string the chats
		// stream emitted — not the message model's id.remote, which can
		// serialize differently (lid/c.us dual ids) and break the parent
		// link the coverage accounting depends on.
		const built = buildMessage(row, tally, parsed.chat_id, {
			kind: item.kind,
			meId: parsed.me_id,
		});
		const checked = validateRecord(MESSAGES, built.record);
		if (!checked.ok) {
			throw new StreamFailure(
				"whatsapp_web_invalid_record",
				`messages record failed schema validation: ${issuesText(checked.issues)}`,
			);
		}
		await ctx.emitRecord(MESSAGES, built.record);
	}
	return { emitted: seen.size, gap: walkGap(parsed) };
}

/** Structural collect context: what collect() reads, and nothing more. */
export type WhatsAppRunContext = Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "requested"
> & { page: Pick<Page, "evaluate"> };

export async function collect(
	ctx: WhatsAppRunContext,
	timings: CollectionTimings = DEFAULT_TIMINGS,
): Promise<void> {
	if (ctx.requested.size === 0) return;
	// Every script runs in the page's MAIN world: the app's module loader is
	// not visible to an isolated world.
	const main = mainWorld(ctx.page);
	await waitForStores(main);
	const stores = new WhatsAppWebStore(main);
	const tally = new TextTally();
	try {
		await collectWith(
			{ emit: ctx.emit, emitRecord: ctx.emitRecord },
			stores,
			tally,
			timings,
		);
	} finally {
		// Diagnostics about replaced text live on stderr, never on stdout.
		for (const [stream, count] of tally.byStream) {
			if (count > 0) {
				console.error(
					`whatsapp_web: ${count} text values in ${stream} held characters that cannot be stored and were imported as empty`,
				);
			}
		}
	}
}

// ─── Session plumbing ────────────────────────────────────────────────────

export async function probeSession({
	page,
}: ProbeSessionArgs): Promise<boolean> {
	return page.url().startsWith(WHATSAPP_ORIGIN);
}

/**
 * Signed-in check for a page the host already holds: the tab is on
 * web.whatsapp.com, the app's module loader is up, and the client knows its
 * own user (a QR or signed-out screen has none). It returns plain booleans
 * only and reads no chat, contact or message.
 */
export const SIGNED_IN_SCRIPT = `
(() => {
	if (location.origin !== ${JSON.stringify(WHATSAPP_ORIGIN)}) return false;
	if (typeof window.require !== "function") return false;
	try {
		const M = window.require("WAWebUserPrefsMeUser");
		return !!(M.getMaybeMePnUser() || M.getMaybeMeLidUser());
	} catch {
		return false;
	}
})()
`;

const PROBE_ATTEMPTS = 3;
const PROBE_WAIT_MS = 1_000;

/**
 * Session probe for hosts that pass a page (the mobile PageShim host). It
 * never navigates, so repeating it while the owner signs in is safe, and it
 * waits only a few seconds for the app to know its own user.
 */
export async function probeWhatsAppSessionOnPage(
	page: MainWorldPage,
	waitMs: number = PROBE_WAIT_MS,
): Promise<boolean> {
	const main = mainWorld(page);
	for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
		try {
			if ((await main.evaluate(SIGNED_IN_SCRIPT)) === true) return true;
		} catch {
			// A page mid-navigation cannot be read yet: not signed in, for now.
		}
		if (attempt < PROBE_ATTEMPTS - 1) await wait(waitMs);
	}
	return false;
}

export async function ensureSession({
	page,
}: EnsureSessionArgs): Promise<void> {
	if (!page.url().startsWith(WHATSAPP_ORIGIN)) {
		await page.goto(WHATSAPP_HOME_URL, { waitUntil: "domcontentloaded" });
	}
}

// ─── Entry point ────────────────────────────────────────────────────────

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "whatsapp_web",
		browser: { profileName: "whatsapp_web" },
		validateRecord,
		retryablePattern:
			/whatsapp_web_stores_not_ready|whatsapp_web_chat_list_never_settled|whatsapp_web_empty_chat_list|net::ERR|ECONN|fetch failed/i,
		ensureSession,
		probeSession,
		probeSessionIsAuthoritative: true,
		collect: (ctx: BrowserCollectContext) => collect(ctx),
	});
}

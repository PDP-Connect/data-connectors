#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP WhatsApp (web) connector: chats, messages, contacts and groups, read
 * from the signed-in web.whatsapp.com page's own in-page stores.
 *
 * The connector runs inside a tab the host provides. When that tab is not
 * signed in, ensureSession hands it to the person to scan the QR code from
 * their phone (Linked devices) and waits for the client to know its own user
 * before collecting. It
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
	BrowserHandoffReadinessTimedOutError,
	manualBrowserLogin,
} from "../../packages/polyfill-connectors/src/browser-handoff.ts";
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
	parseSyncState,
	storesReady,
	syncSettled,
	TextTally,
	type WaChat,
	type WaContact,
	type WaGroup,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const WHATSAPP_ORIGIN = "https://web.whatsapp.com";
const WHATSAPP_HOME_URL = `${WHATSAPP_ORIGIN}/`;
export const WHATSAPP_LOGIN_MESSAGE =
	"Scan the QR code with WhatsApp on your phone (Settings, Linked devices, Link a device), then continue. The import starts once WhatsApp Web has loaded.";

const CHATS = "chats";
const MESSAGES = "messages";
const CONTACTS = "contacts";
const GROUPS = "groups";

/** The app's own page size for msgFindBefore. */
export const MESSAGE_PAGE_SIZE = 50;
/** One in-page walk chunk reads at most this many local pages. */
const MAX_CHUNK_PAGES = 40;
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
 * One chunk of a chat's message walk, in one in-page script. The local
 * store's `msgFindBefore` takes its anchor as the message model's own key
 * object, which cannot cross the evaluate boundary, so the paging lives in
 * the page, a chunk of at most MAX_CHUNK_PAGES pages per call.
 *
 * Anchors are only ever the client's own keys: the first is the newest
 * message the chat holds in memory, and each next one is the oldest message
 * of the page before (the store answers each page oldest first, strictly
 * before its anchor). Between chunks the next anchor (the key object the
 * store itself returned) waits in a page-side map keyed by chat id and the
 * walk's token, and is dropped when the walk ends; it is never rebuilt from
 * a string. A chat with activity but nothing in memory has no key to page
 * back from; the walk says so (`stop: "no_anchor"`) and never makes one up.
 *
 * The first chunk (`token` null) also returns the in-memory messages. Each
 * chunk returns the older rows it read, `more: true` when it stopped only
 * because its page budget ran out (the caller asks for the next chunk with
 * the returned token), or `complete` true when it ended on the store's own
 * short page, with `stop` naming why it ended.
 */
export async function readChatMessages(
	page: ScriptRunner,
	chatId: string,
	token: string | null = null,
): Promise<unknown> {
	assertReadOnlyCall("readChatMessages", { chatId });
	return page.evaluate(`
	(async () => {
		${WID_FN}
		${MESSAGE_ROW_MAPPER}
		const chatId = ${JSON.stringify(chatId)};
		const resumeToken = ${JSON.stringify(token)};
		const PAGE_SIZE = ${MESSAGE_PAGE_SIZE};
		const MAX_PAGES = ${MAX_CHUNK_PAGES};
		const walks = (globalThis.__pdppWhatsAppWebWalks = globalThis.__pdppWhatsAppWebWalks || new Map());
		const { Chat } = window.require("WAWebCollections");
		const { msgFindBefore } = window.require("WAWebDBMessageFindLocal");
		const chat = Chat.get(chatId);
		// The owner's own id, in the same addressing (phone number or lid) as
		// the chat, so a one-to-one chat's two authors read alike.
		const me = (() => { try { const M = window.require("WAWebUserPrefsMeUser"); const pn = M.getMaybeMePnUser(); const lid = M.getMaybeMeLidUser(); return w(chat && chat.id && chat.id.server === "c.us" ? (pn ?? lid) : (lid ?? pn)); } catch { return null; } })();
		const done = (fields) => { if (resumeToken !== null) walks.delete(chatId + "|" + resumeToken); return { chat_id: chatId, me_id: me, more: false, token: null, ...fields }; };
		if (!chat) return done({ status: 404, memory: [], messages: [], complete: false, anchored: false, stop: "status" });
		let memory = [];
		let anchor = null;
		if (resumeToken === null) {
			const memoryModels = chat.msgs ? chat.msgs.getModelsArray() : [];
			memory = memoryModels.map(mapRow);
			let anchorModel = null;
			for (const m of memoryModels) {
				if (m && m.id && (anchorModel == null || (m.t ?? 0) >= (anchorModel.t ?? 0))) anchorModel = m;
			}
			if (anchorModel == null) {
				const empty = !chat.t;
				return done({ status: 200, memory, messages: [], complete: empty, anchored: false, stop: empty ? "empty" : "no_anchor" });
			}
			anchor = anchorModel.id;
		} else {
			anchor = walks.get(chatId + "|" + resumeToken) ?? null;
			if (anchor == null) return done({ status: 200, memory, messages: [], complete: false, anchored: false, stop: "lost_anchor" });
		}
		const out = [];
		for (let page = 0; page < MAX_PAGES; page++) {
			const r = await msgFindBefore({ anchor: anchor, count: PAGE_SIZE });
			const status = r && typeof r.status === "number" ? r.status : 0;
			if (status !== 200) {
				return done({ status, memory, messages: out, complete: false, anchored: true, stop: "status" });
			}
			const rows = r && Array.isArray(r.messages) ? r.messages : [];
			for (const m of rows) out.push(mapRow(m));
			if (rows.length < PAGE_SIZE) {
				return done({ status: 200, memory, messages: out, complete: true, anchored: true, stop: "short_page" });
			}
			const oldest = rows[0];
			if (!oldest || !oldest.id || w(oldest.id) === w(anchor)) {
				return done({ status: 200, memory, messages: out, complete: false, anchored: true, stop: "no_progress" });
			}
			anchor = oldest.id;
		}
		const next = resumeToken ?? String(Date.now()) + "-" + String(Math.random()).slice(2);
		walks.set(chatId + "|" + next, anchor);
		return { chat_id: chatId, status: 200, memory, messages: out, complete: false, anchored: true, stop: "chunk", me_id: me, more: true, token: next };
	})()
	`);
}

/**
 * Drop a walk's page-side anchor when the connector stops walking a chat
 * before the walk ended on its own (its chunk budget ran out).
 */
export async function releaseChatWalk(
	page: ScriptRunner,
	chatId: string,
	token: string,
): Promise<unknown> {
	assertReadOnlyCall("readChatMessages", { chatId });
	return page.evaluate(`
	(() => {
		const walks = globalThis.__pdppWhatsAppWebWalks;
		if (walks) walks.delete(${JSON.stringify(`${chatId}|${token}`)});
		return true;
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

/**
 * The client's own sync state, as plain values: the socket stream's mode
 * (WAWebStreamModel: `MAIN` once the client runs normally, `QR` when it is
 * signed out) and whether the offline resume, the catch-up of what arrived
 * while the client was away, has completed (WAWebOfflineHandler). The chat
 * inventory is only taken as complete once both say the client has caught up.
 */
export const SYNC_SCRIPT = `
(() => {
	const mod = (name) => { try { return window.require(name); } catch { return null; } };
	const streamModel = mod("WAWebStreamModel");
	const offline = mod("WAWebOfflineHandler");
	let mode = null;
	try { mode = streamModel && streamModel.Stream && typeof streamModel.Stream.mode === "string" ? streamModel.Stream.mode : null; } catch { mode = null; }
	let resume = null;
	try { const h = offline && offline.OfflineMessageHandler; resume = h && typeof h.isResumeComplete === "function" ? h.isResumeComplete() === true : null; } catch { resume = null; }
	return { mode: mode, resume_complete: resume };
})()
`;

/** A read of the client's own sync state. */
export async function readSyncState(page: ScriptRunner): Promise<unknown> {
	return page.evaluate(SYNC_SCRIPT);
}

/** Read-only access to the page's own WhatsApp Web stores. */
export interface WhatsAppWebStores {
	listChats(): Promise<unknown>;
	syncState(): Promise<unknown>;
	readChatMessages(chatId: string, token?: string | null): Promise<unknown>;
	releaseChatWalk(chatId: string, token: string): Promise<unknown>;
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
	syncState(): Promise<unknown> {
		return readSyncState(this.page);
	}
	readChatMessages(
		chatId: string,
		token: string | null = null,
	): Promise<unknown> {
		return readChatMessages(this.page, chatId, token);
	}
	releaseChatWalk(chatId: string, token: string): Promise<unknown> {
		return releaseChatWalk(this.page, chatId, token);
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

/** Wait until the page's own module stores are ready for the requested streams. */
export async function waitForStores(
	page: ScriptRunner,
	attempts = STORE_WAIT_ATTEMPTS,
	waitMs = STORE_WAIT_MS,
	streams: ReadonlySet<string> = new Set(ALL_STREAMS),
): Promise<void> {
	for (let i = 0; i < attempts; i++) {
		const handles = parseStoresReadiness(await page.evaluate(STORES_SCRIPT));
		if (handles !== null && storesReady(handles, streams)) return;
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

/** The signed-in session is gone: the owner has to sign in again. */
export function authFailure(message: string): Error {
	return createConnectorFailure("whatsapp_web_auth_failed", message, {
		retryable: false,
		recoveryHint: { action: "refresh_credentials", retryable: false },
	});
}

/**
 * A local-store status that is about the whole run, not one chat: 401/403
 * mean the session is no longer signed in, 429 and 5xx mean the store is
 * under pressure or failing, so the run stops for the runtime to retry
 * instead of turning every chat into a gap. Any other non-200 status (a 404
 * for a chat the store does not hold) stays a per-chat gap.
 */
export function assertWalkStatusIsPerChat(status: number): void {
	if (status === 401 || status === 403) {
		throw authFailure(
			`the WhatsApp Web local message store answered ${String(status)}: the session is no longer signed in`,
		);
	}
	if (status === 429 || (status >= 500 && status <= 599)) {
		throw createConnectorFailure(
			"whatsapp_web_local_store_unavailable",
			`the WhatsApp Web local message store answered ${String(status)}; the run stops for a retry`,
			{ retryable: true },
		);
	}
}

// ─── Collection ─────────────────────────────────────────────────────────

const ALL_STREAMS: readonly string[] = [CHATS, MESSAGES, CONTACTS, GROUPS];

interface ChatMark {
	t: number;
	history_state: string | null;
}

/**
 * chats cursor: for each chat, its last activity time and its history state
 * at the read. Chat ids, one number and one string; no credential.
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
> & {
	/** The requested streams; absent means every stream (direct callers). */
	requested?: ReadonlyMap<string, unknown>;
	/** Gaps earlier runs left pending; absent (the PageShim host) means none. */
	detailGaps?: BrowserCollectContext["detailGaps"];
	recoveryOnly?: boolean;
	reportStreamFailure?: BrowserCollectContext["reportStreamFailure"];
	/** Further pages of pending gaps; absent means the START page is all. */
	requestDetailGapPage?: BrowserCollectContext["requestDetailGapPage"];
};

/** The requested streams this connector serves. */
function wantedStreams(ctx: WhatsAppCollectContext): Set<string> {
	if (ctx.requested === undefined) return new Set(ALL_STREAMS);
	return new Set(
		[...ctx.requested.keys()].filter((s) => ALL_STREAMS.includes(s)),
	);
}

/** A message gap an earlier run left pending. */
interface PendingGap {
	gapId: string;
	leaseId?: string;
}

/** Message gaps the host carried over from earlier runs, by chat id. */
function pendingMessageGaps(
	detailGaps: WhatsAppCollectContext["detailGaps"],
): Map<string, PendingGap[]> {
	const byChat = new Map<string, PendingGap[]>();
	for (const gap of detailGaps ?? []) {
		if (gap.stream !== MESSAGES) continue;
		const raw = gap.record_key;
		const key =
			typeof raw === "string"
				? raw
				: typeof raw === "number"
					? String(raw)
					: "";
		if (key === "") continue;
		const list = byChat.get(key) ?? [];
		list.push({
			gapId: gap.gap_id,
			...(gap.lease_id ? { leaseId: gap.lease_id } : {}),
		});
		byChat.set(key, list);
	}
	return byChat;
}

/** DETAIL_GAP_RECOVERED for pending gaps of a chat this run read completely. */
async function emitRecovered(
	ctx: WhatsAppCollectContext,
	chatId: string,
	gaps: readonly PendingGap[],
): Promise<void> {
	for (const gap of gaps) {
		await ctx.emit({
			type: "DETAIL_GAP_RECOVERED",
			reference_only: true,
			gap_id: gap.gapId,
			...(gap.leaseId ? { lease_id: gap.leaseId } : {}),
			stream: MESSAGES,
			record_key: chatId,
		});
	}
}

/**
 * Hand every pending message gap to `handle` once: the START page first,
 * then further pages from the runtime until a page holds no gap not already
 * handled (the runtime answers with the gaps still pending, so recovered
 * ones drop out and a re-emitted one comes back once, already handled).
 */
async function forEachPendingGapPage(
	ctx: WhatsAppCollectContext,
	first: WhatsAppCollectContext["detailGaps"],
	handle: (fresh: Map<string, PendingGap[]>) => Promise<void>,
): Promise<void> {
	const seen = new Set<string>();
	let page = first ?? [];
	for (;;) {
		const fresh = new Map<string, PendingGap[]>();
		for (const [key, gaps] of pendingMessageGaps(page)) {
			const unseen = gaps.filter((g) => !seen.has(g.gapId));
			for (const gap of unseen) seen.add(gap.gapId);
			if (unseen.length > 0) fresh.set(key, unseen);
		}
		if (fresh.size === 0) return;
		await handle(fresh);
		if (!ctx.requestDetailGapPage) return;
		page = await ctx.requestDetailGapPage({ streams: [MESSAGES] });
	}
}

/**
 * A stream that cannot be proven complete this run: it gets no STATE, and
 * the runtime records the failure (the run ends failed or partial).
 */
async function failStream(
	ctx: WhatsAppCollectContext,
	stream: string,
	message: string,
	retryable: boolean,
): Promise<void> {
	if (!ctx.reportStreamFailure) {
		throw createConnectorFailure("whatsapp_web_stream_incomplete", message, {
			retryable,
		});
	}
	await ctx.reportStreamFailure(stream, message, { retryable });
}

/** The chats of one read, each id once (the first occurrence wins). */
function uniqueById(chats: readonly WaChat[]): WaChat[] {
	const seen = new Set<string>();
	const out: WaChat[] = [];
	for (const chat of chats) {
		if (seen.has(chat.id)) continue;
		seen.add(chat.id);
		out.push(chat);
	}
	return out;
}

function sameIds(a: readonly WaChat[], b: readonly WaChat[]): boolean {
	if (a.length !== b.length) return false;
	const ids = new Set(a.map((c) => c.id));
	return b.every((c) => ids.has(c.id));
}

/**
 * The chat list is the page's own collection, still filling while the app
 * boots and catches up. It is taken as the inventory's end only when the
 * client itself says it has caught up (stream mode MAIN and its offline
 * resume complete) and two reads under that signal hold the same set of
 * unique ids. A client that never says so within the budget fails the run
 * without a checkpoint; a client in QR mode is signed out.
 */
async function settleChatList(
	stores: WhatsAppWebStores,
	timings: CollectionTimings,
): Promise<WaChat[]> {
	let previous: WaChat[] | null = null;
	for (let i = 0; i <= timings.settleAttempts; i++) {
		if (i > 0) await wait(timings.settleMs);
		const sync = parseSyncState(await stores.syncState());
		if (sync === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's sync state came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		if (sync.mode === "QR") {
			throw authFailure(
				"WhatsApp Web is showing its sign-in QR code: the session is no longer signed in",
			);
		}
		const page = parseChatsPage(await stores.listChats());
		if (page === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's chat collection came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		const current = uniqueById(page);
		if (!syncSettled(sync)) {
			previous = null;
			continue;
		}
		if (previous !== null && sameIds(previous, current)) return current;
		previous = current;
	}
	throw createConnectorFailure(
		"whatsapp_web_chat_list_never_settled",
		"WhatsApp Web did not finish catching up, or its chat collection kept changing, while the run read it; the inventory is not known to be complete, so nothing was checkpointed.",
		{ retryable: true },
	);
}

/**
 * The group metadata collection, read until it holds a record for every
 * group chat in the settled chat list (the group-chat ids are the
 * inventory's proof). Returns the groups and the group-chat ids that still
 * have no metadata when the bounded budget ran out.
 */
async function settleGroups(
	stores: WhatsAppWebStores,
	groupChatIds: readonly string[],
	timings: CollectionTimings,
): Promise<{ groups: WaGroup[]; missing: string[] }> {
	let groups: WaGroup[] = [];
	let missing: string[] = [];
	for (let i = 0; i <= timings.settleAttempts; i++) {
		if (i > 0) await wait(timings.settleMs);
		const parsed = parseGroupsPage(await stores.listGroups());
		if (parsed === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's group metadata collection came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		const seen = new Set<string>();
		groups = [];
		for (const group of parsed) {
			if (seen.has(group.id)) continue;
			seen.add(group.id);
			groups.push(group);
		}
		missing = groupChatIds.filter((id) => !seen.has(id));
		if (missing.length === 0) break;
	}
	return { groups, missing };
}

/** The one history request a chat may get, and the state it leaves the chat in. */
async function requestHistory(
	stores: WhatsAppWebStores,
	item: ChatItem,
	timings: CollectionTimings,
): Promise<{ state: string | null; requested: boolean }> {
	let state = item.history_state;
	if (!item.needsHistory) return { state, requested: false };
	// The chat says it has not yet asked for the history that remains on
	// the phone: one on-demand history request, what the UI's "get older
	// messages from your phone" button does, then a bounded wait for it to
	// settle.
	const ack = parseHistoryAck(await stores.sendHistorySyncOnDemand(item.id));
	if (ack === null) {
		console.error(
			`whatsapp_web: the on-demand history request for chat ${item.id} answered in an unexpected shape; treating it as not sent`,
		);
	}
	if (ack?.sent !== true) return { state, requested: false };
	for (let i = 0; i < timings.historyAttempts; i++) {
		await wait(timings.historyMs);
		const fresh = parseChatsPage(await stores.listChats());
		if (fresh === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's chat collection came back in a shape the connector cannot read mid-run; nothing was checkpointed.",
			);
		}
		const row = fresh.find((c) => c.id === item.id);
		// A read that does not hold the chat, or holds it without a history
		// state, says nothing about its history: the chat keeps the state it
		// was last seen in (which said history remained on the phone), so it
		// gaps instead of passing as complete.
		if (row === undefined || row.history_state == null) continue;
		state = row.history_state;
		if (!needsHistoryRequest(state)) break;
	}
	return { state, requested: true };
}

/**
 * One full pass over the requested streams. Chats are read first (every
 * stream depends on the chat inventory), then the messages of each chat,
 * then groups and contacts. Only requested streams emit records, STATE or
 * coverage, and the history request is sent only when messages are
 * requested. A recovery-only run re-reads the chats with pending message
 * gaps and nothing else.
 */
export async function collectWith(
	ctx: WhatsAppCollectContext,
	stores: WhatsAppWebStores,
	tally: TextTally,
	timings: CollectionTimings = DEFAULT_TIMINGS,
): Promise<void> {
	const want = wantedStreams(ctx);
	if (want.has(MESSAGES) && !want.has(CHATS)) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: MESSAGES,
			reason: "scope_not_supported",
			message:
				"WhatsApp messages are collected together with their chats; request both streams.",
			recovery_hint: { action: "not_retriable", retryable: false },
		});
		want.delete(MESSAGES);
	}
	if (want.size === 0) return;
	let firstGapPage = ctx.detailGaps ?? [];
	if (ctx.recoveryOnly) {
		if (!want.has(MESSAGES)) return;
		if (
			pendingMessageGaps(firstGapPage).size === 0 &&
			ctx.requestDetailGapPage
		) {
			firstGapPage = await ctx.requestDetailGapPage({ streams: [MESSAGES] });
		}
		if (pendingMessageGaps(firstGapPage).size === 0) return;
	}

	const chats = await settleChatList(stores, timings);
	if (chats.length === 0) {
		throw createConnectorFailure(
			"whatsapp_web_empty_chat_list",
			"WhatsApp Web's chat collection is empty: the page may not be signed in, so the run cannot tell an empty account from a signed-out one and checkpoints nothing.",
			{ retryable: true },
		);
	}

	// Every chat's record, built once. A chat whose text cannot be stored is
	// not emitted with that text silently emptied: it is withheld, and the
	// chats stream (and the messages under it) are not checkpointed.
	const items = new Map<string, ChatItem>();
	const unsafeChatIds = new Set<string>();
	for (const chat of chats) {
		const built = buildChat(chat, tally);
		if (built.replaced > 0) {
			unsafeChatIds.add(chat.id);
			continue;
		}
		const checked = validateRecord(CHATS, built.record);
		if (!checked.ok) {
			throw new StreamFailure(
				"whatsapp_web_invalid_record",
				`chats record failed schema validation: ${issuesText(checked.issues)}`,
			);
		}
		items.set(chat.id, {
			id: chat.id,
			kind: chatKind(chat.id, chat.server),
			record: built.record,
			needsHistory: needsHistoryRequest(chat.history_state ?? null),
			t: typeof chat.t === "number" ? chat.t : 0,
			history_state: chat.history_state ?? null,
		});
	}
	const unsafeChats = ctx.recoveryOnly ? 0 : unsafeChatIds.size;

	// One chat's messages: its one history request when it needs one, the
	// walk of its local store, then its gap when the walk or the history
	// state says something remains. Every message the store holds is
	// emitted either way.
	const requiredKeys: string[] = [];
	const hydratedKeys: string[] = [];
	const gapKeys: string[] = [];
	const outcomes = new Map<string, "hydrated" | "gapped">();
	const hydrateChat = async (item: ChatItem): Promise<void> => {
		requiredKeys.push(item.id);
		const history = await requestHistory(stores, item, timings);
		const walk = await walkMessagesForChat(ctx, stores, tally, item);
		const gap =
			walk.gap ??
			(historyRemainsOnPhone(history.state)
				? {
						reason: "retry_exhausted" as const,
						class: "history_remains_on_phone",
						message: `history state ${String(history.state)}; ${history.requested ? "after this run's on-demand history request" : "no on-demand history request was sent this run"}`,
					}
				: null);
		if (gap !== null) {
			await emitDetailGap(ctx, {
				stream: MESSAGES,
				parentStream: CHATS,
				recordKey: item.id,
				reason: gap.reason,
				locator: { kind: "whatsapp_web.chat_messages", chat_id: item.id },
				error: { class: gap.class, message: gap.message },
			});
			gapKeys.push(item.id);
			outcomes.set(item.id, "gapped");
			return;
		}
		hydratedKeys.push(item.id);
		outcomes.set(item.id, "hydrated");
	};

	if (!ctx.recoveryOnly) {
		// Parents first, then each chat's messages.
		if (want.has(CHATS)) {
			for (const item of items.values())
				await ctx.emitRecord(CHATS, item.record);
		}
		if (want.has(MESSAGES)) {
			for (const item of items.values()) await hydrateChat(item);
		}
	}

	if (want.has(MESSAGES)) {
		// Pending gaps from earlier runs, every page of them. A chat read
		// completely this run acknowledges its gaps; a chat gapped again this
		// run already re-emitted its gap. A recovery-only run reads the
		// pending chats here, and only those. A pending chat that is not in
		// this run's inventory (or cannot be imported) has no parent record
		// this run, so no child gap is emitted for it: its gap stays pending
		// untouched, and messages fail for a retry instead of checkpointing.
		// Deletion is never inferred from absence.
		const blockedPending = new Set<string>();
		await forEachPendingGapPage(ctx, firstGapPage, async (fresh) => {
			for (const [chatId, gaps] of fresh) {
				const item = items.get(chatId);
				if (!outcomes.has(chatId) && ctx.recoveryOnly && item !== undefined) {
					if (want.has(CHATS)) await ctx.emitRecord(CHATS, item.record);
					await hydrateChat(item);
				}
				const outcome = outcomes.get(chatId);
				if (outcome === "hydrated") {
					await emitRecovered(ctx, chatId, gaps);
					continue;
				}
				if (outcome === undefined) blockedPending.add(chatId);
			}
		});
		if (unsafeChats > 0) {
			await failStream(
				ctx,
				MESSAGES,
				`${unsafeChats} chats could not be imported (their text holds characters that cannot be stored), so their messages were not read and messages are not checkpointed as complete.`,
				false,
			);
		} else if (blockedPending.size > 0) {
			const unstorable = [...blockedPending].filter((id) =>
				unsafeChatIds.has(id),
			).length;
			await failStream(
				ctx,
				MESSAGES,
				`${blockedPending.size} chats with pending message gaps are not readable this run (${blockedPending.size - unstorable} not in the chat inventory, ${unstorable} with text that cannot be stored); their gaps stay pending and messages are not checkpointed as complete.`,
				unstorable < blockedPending.size,
			);
		} else if (!ctx.recoveryOnly || requiredKeys.length > 0) {
			await emitDetailCoverage(ctx, {
				stream: MESSAGES,
				stateStream: CHATS,
				requiredKeys,
				hydratedKeys,
				gapKeys,
			});
		}
	}

	if (ctx.recoveryOnly) return;

	// groups: the page's own group metadata collection, proven against the
	// group chats of the settled chat list. Its participant ids widen the
	// contact set.
	let groupsMissing: string[] = [];
	const contactIds = new Set<string>();
	for (const chat of chats) {
		if (chatKind(chat.id, chat.server) === "user") contactIds.add(chat.id);
	}
	if (want.has(GROUPS) || want.has(CONTACTS)) {
		const groupChatIds = chats
			.filter((c) => chatKind(c.id, c.server) === "group")
			.map((c) => c.id);
		const settled = await settleGroups(stores, groupChatIds, timings);
		groupsMissing = settled.missing;
		const groupRecords: RecordData[] = [];
		let unsafeGroups = 0;
		for (const group of settled.groups) {
			for (const p of group.participants ?? []) contactIds.add(p.id);
			const built = buildGroup(group, tally);
			if (built.replaced > 0) {
				unsafeGroups += 1;
				continue;
			}
			const checked = validateRecord(GROUPS, built.record);
			if (!checked.ok) {
				throw new StreamFailure(
					"whatsapp_web_invalid_record",
					`groups record failed schema validation: ${issuesText(checked.issues)}`,
				);
			}
			groupRecords.push(built.record);
		}
		if (want.has(GROUPS)) {
			for (const record of groupRecords) await ctx.emitRecord(GROUPS, record);
			if (groupsMissing.length > 0) {
				await failStream(
					ctx,
					GROUPS,
					`${groupsMissing.length} group chats have no group metadata in the page yet; groups are not checkpointed as complete.`,
					true,
				);
			} else if (unsafeGroups > 0) {
				await failStream(
					ctx,
					GROUPS,
					`${unsafeGroups} groups hold text that cannot be stored and were not imported; groups are not checkpointed as complete.`,
					false,
				);
			} else {
				await ctx.emit({
					type: "STATE",
					stream: GROUPS,
					cursor: {
						version: CURSOR_VERSION,
						ids: groupRecords.map((r) => String(r.id)),
					},
				});
			}
		}
	}

	// contacts: the page's contact collection filtered to the chat and group
	// participant ids seen above. An id the collection holds no contact for
	// is still a contact that appears in the owner's chats: it gets a record
	// with its id and no names, never a silent omission.
	if (want.has(CONTACTS)) {
		const contacts = parseContactsPage(
			await stores.listContacts([...contactIds]),
		);
		if (contacts === null) {
			throw new StreamFailure(
				"whatsapp_web_unexpected_shape",
				"WhatsApp Web's contact collection came back in a shape the connector cannot read; nothing was checkpointed.",
			);
		}
		const byId = new Map<string, WaContact>();
		for (const contact of contacts) {
			if (contactIds.has(contact.id) && !byId.has(contact.id))
				byId.set(contact.id, contact);
		}
		const contactRecords: RecordData[] = [];
		let unsafeContacts = 0;
		for (const id of contactIds) {
			const built = buildContact(byId.get(id) ?? { id }, tally);
			if (built.replaced > 0) {
				unsafeContacts += 1;
				continue;
			}
			const checked = validateRecord(CONTACTS, built.record);
			if (!checked.ok) {
				throw new StreamFailure(
					"whatsapp_web_invalid_record",
					`contacts record failed schema validation: ${issuesText(checked.issues)}`,
				);
			}
			contactRecords.push(built.record);
		}
		for (const record of contactRecords) await ctx.emitRecord(CONTACTS, record);
		if (groupsMissing.length > 0) {
			await failStream(
				ctx,
				CONTACTS,
				`${groupsMissing.length} group chats have no group metadata in the page yet, so their participants are unknown; contacts are not checkpointed as complete.`,
				true,
			);
		} else if (unsafeContacts > 0) {
			await failStream(
				ctx,
				CONTACTS,
				`${unsafeContacts} contacts hold text that cannot be stored and were not imported; contacts are not checkpointed as complete.`,
				false,
			);
		} else {
			await ctx.emit({
				type: "STATE",
				stream: CONTACTS,
				cursor: {
					version: CURSOR_VERSION,
					ids: contactRecords.map((r) => String(r.id)),
				},
			});
		}
	}

	// chats' STATE after all its records and its child's coverage.
	if (want.has(CHATS)) {
		if (unsafeChats > 0) {
			await failStream(ctx, CHATS, unsafeChatsMessage(unsafeChats), false);
			return;
		}
		const marks: Record<string, ChatMark> = {};
		for (const item of items.values()) {
			marks[item.id] = { t: item.t, history_state: item.history_state };
		}
		await ctx.emit({
			type: "STATE",
			stream: CHATS,
			cursor: { version: CURSOR_VERSION, chats: marks },
		});
	}
}

function unsafeChatsMessage(count: number): string {
	return `${count} chats hold text that cannot be stored and were not imported; chats are not checkpointed as complete.`;
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

/**
 * Walk one chat's local store chunk by chunk until the store's own short
 * page (or a stop that is not the end, which becomes the chat's gap).
 */
async function walkMessagesForChat(
	ctx: WhatsAppCollectContext,
	stores: WhatsAppWebStores,
	tally: TextTally,
	item: Pick<ChatItem, "id" | "kind">,
): Promise<WalkOutcome> {
	const chatId = item.id;
	const seen = new Set<string>();
	let unsafe = 0;
	let token: string | null = null;
	for (;;) {
		let raw: unknown;
		try {
			raw = await stores.readChatMessages(chatId, token);
		} catch (error) {
			console.error(
				`whatsapp_web: failed to read messages of chat ${chatId}:`,
				error,
			);
			if (token !== null)
				await stores.releaseChatWalk(chatId, token).catch(() => undefined);
			return {
				emitted: seen.size,
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
		assertWalkStatusIsPerChat(parsed.status);
		let fresh = 0;
		for (const row of [...parsed.memory, ...parsed.messages]) {
			if (seen.has(row.id)) continue;
			seen.add(row.id);
			fresh += 1;
			// chat_id is the walk's own chat id — the same string the chats
			// stream emitted — not the message model's id.remote, which can
			// serialize differently (lid/c.us dual ids) and break the parent
			// link the coverage accounting depends on.
			const built = buildMessage(row, tally, parsed.chat_id, {
				kind: item.kind,
				meId: parsed.me_id,
			});
			if (built.replaced > 0) {
				// Text that cannot be stored is not emitted as an empty value:
				// the message is withheld and the chat gaps visibly below.
				unsafe += 1;
				continue;
			}
			const checked = validateRecord(MESSAGES, built.record);
			if (!checked.ok) {
				throw new StreamFailure(
					"whatsapp_web_invalid_record",
					`messages record failed schema validation: ${issuesText(checked.issues)}`,
				);
			}
			await ctx.emitRecord(MESSAGES, built.record);
		}
		const unsafeGap: WalkGap | null =
			unsafe > 0
				? {
						reason: "retry_exhausted",
						class: "unsafe_text",
						message: `${unsafe} messages hold text that cannot be stored and were not imported`,
					}
				: null;
		if (!parsed.more || parsed.token === null) {
			return { emitted: seen.size, gap: walkGap(parsed) ?? unsafeGap };
		}
		token = parsed.token;
		// A chunk that brought no message the walk had not seen is not
		// progress toward the store's end: stop and gap instead of spinning.
		// Otherwise the walk goes on, chunk after chunk, until the store's own
		// short page; there is no per-run cap that would leave older
		// messages unreachable.
		if (fresh === 0) {
			await stores.releaseChatWalk(chatId, token).catch(() => undefined);
			return {
				emitted: seen.size,
				gap: walkGap({ status: 200, complete: false, stop: "no_progress" }),
			};
		}
	}
}

/** Structural collect context: what collect() reads, and nothing more. */
export type WhatsAppRunContext = Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "requested"
> &
	Partial<
		Pick<
			BrowserCollectContext,
			| "detailGaps"
			| "recoveryOnly"
			| "reportStreamFailure"
			| "requestDetailGapPage"
		>
	> & { page: Pick<Page, "evaluate"> };

export async function collect(
	ctx: WhatsAppRunContext,
	timings: CollectionTimings = DEFAULT_TIMINGS,
): Promise<void> {
	const want = new Set(
		[...ctx.requested.keys()].filter((s) => ALL_STREAMS.includes(s)),
	);
	if (want.size === 0) return;
	// Every script runs in the page's MAIN world: the app's module loader is
	// not visible to an isolated world.
	const main = mainWorld(ctx.page);
	await waitForStores(main, STORE_WAIT_ATTEMPTS, STORE_WAIT_MS, want);
	const stores = new WhatsAppWebStore(main);
	const tally = new TextTally();
	try {
		await collectWith(
			{
				emit: ctx.emit,
				emitRecord: ctx.emitRecord,
				requested: ctx.requested,
				detailGaps: ctx.detailGaps ?? [],
				recoveryOnly: ctx.recoveryOnly === true,
				...(ctx.reportStreamFailure
					? { reportStreamFailure: ctx.reportStreamFailure }
					: {}),
				...(ctx.requestDetailGapPage
					? { requestDetailGapPage: ctx.requestDetailGapPage }
					: {}),
			},
			stores,
			tally,
			timings,
		);
	} finally {
		// Diagnostics about replaced text live on stderr, never on stdout.
		for (const [stream, count] of tally.byStream) {
			if (count > 0) {
				console.error(
					`whatsapp_web: ${count} text values in ${stream} held characters that cannot be stored and were not imported`,
				);
			}
		}
	}
}

// ─── Session plumbing ────────────────────────────────────────────────────

/**
 * The desktop session probe: the same signed-in check as the PageShim probe
 * (exact web.whatsapp.com origin and a client that knows its own user), so a
 * QR sign-in page or a look-alike host never passes as a live session.
 */
export async function probeSession({
	page,
}: ProbeSessionArgs): Promise<boolean> {
	if (!isWhatsAppOrigin(page.url())) return false;
	return probeWhatsAppSessionOnPage(page);
}

/** True only for a URL whose origin is exactly https://web.whatsapp.com. */
export function isWhatsAppOrigin(url: string): boolean {
	try {
		return new URL(url).origin === WHATSAPP_ORIGIN;
	} catch {
		return false;
	}
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

/**
 * Where the app on the page stands, as one plain string: "signed_in" when the
 * client knows its own user (the probe's check), "signed_out" when it shows
 * its sign-in QR code (the socket stream in QR mode, or the QR canvas on the
 * landing screen), otherwise "loading". It reads no chat, contact or message.
 */
export const SESSION_STATE_SCRIPT = `
(() => {
	if (location.origin !== ${JSON.stringify(WHATSAPP_ORIGIN)}) return "loading";
	const mod = (name) => { try { return typeof window.require === "function" ? window.require(name) : null; } catch { return null; } };
	const me = mod("WAWebUserPrefsMeUser");
	try { if (me && (me.getMaybeMePnUser() || me.getMaybeMeLidUser())) return "signed_in"; } catch {}
	const stream = mod("WAWebStreamModel");
	let mode = null;
	try { mode = stream && stream.Stream ? stream.Stream.mode : null; } catch { mode = null; }
	if (mode === "QR") return "signed_out";
	if (document.querySelector("div[data-ref] canvas, canvas[aria-label*='QR' i], canvas[aria-label*='scan' i]")) return "signed_out";
	return "loading";
})()
`;

export type SessionState = "signed_in" | "signed_out" | "loading";

/** One non-navigating read of the app's session state. */
export async function readSessionState(
	page: MainWorldPage,
): Promise<SessionState> {
	try {
		const state = await mainWorld(page).evaluate(SESSION_STATE_SCRIPT);
		return state === "signed_in" || state === "signed_out" ? state : "loading";
	} catch {
		// A page mid-navigation cannot be read yet.
		return "loading";
	}
}

export interface SessionTimings {
	/** Reads while the freshly opened app boots, before handing it over. */
	bootAttempts: number;
	bootMs: number;
	/** Readiness poll interval while the person scans the QR code. */
	handoffProbeMs: number;
	handoffTimeoutSeconds: number;
}

export const DEFAULT_SESSION_TIMINGS: SessionTimings = {
	bootAttempts: 30,
	bootMs: 1_000,
	handoffProbeMs: 3_000,
	handoffTimeoutSeconds: 30 * 60,
};

/**
 * Read the app until it says signed in or shows its QR code, never
 * navigating. A page still loading when the budget ends reads as "loading".
 */
async function waitForBootedState(
	page: MainWorldPage,
	timings: SessionTimings,
	attempt = 0,
): Promise<SessionState> {
	const state = await readSessionState(page);
	if (state !== "loading" || attempt + 1 >= timings.bootAttempts) return state;
	await wait(timings.bootMs);
	return waitForBootedState(page, timings, attempt + 1);
}

/**
 * Opens web.whatsapp.com in the connector's own page when it is elsewhere
 * (never a second tab). A signed-in client goes straight to collection. One
 * showing its sign-in QR code (or not done loading) is handed to the person
 * to link this browser from their phone; collection starts only once the
 * client knows its own user. When no one links it before the handoff ends,
 * the run fails as whatsapp_web_auth_failed.
 */
export async function ensureSession(
	{
		assist,
		capture,
		completeAssistance,
		page,
		sendInteraction,
	}: Pick<
		EnsureSessionArgs,
		"assist" | "capture" | "completeAssistance" | "page" | "sendInteraction"
	>,
	timings: SessionTimings = DEFAULT_SESSION_TIMINGS,
): Promise<void> {
	if (!isWhatsAppOrigin(page.url())) {
		await page.goto(WHATSAPP_HOME_URL, { waitUntil: "domcontentloaded" });
	}
	if ((await waitForBootedState(page, timings)) === "signed_in") return;
	let ready: boolean;
	try {
		ready = await manualBrowserLogin({
			assist,
			autoProbeIntervalMs: timings.handoffProbeMs,
			...(capture ? { capture } : {}),
			completeAssistance,
			isProbeSuccessful: (live: boolean) => live,
			message: WHATSAPP_LOGIN_MESSAGE,
			page,
			probe: async () => (await readSessionState(page)) === "signed_in",
			readinessProbe: async (p) => (await readSessionState(p)) === "signed_in",
			readinessProbeOnHandoffPage: true,
			reason: "login",
			sendInteraction,
			timeoutSeconds: timings.handoffTimeoutSeconds,
		});
	} catch (error) {
		if (error instanceof BrowserHandoffReadinessTimedOutError) {
			throw authFailure(
				"WhatsApp Web stayed on its sign-in QR code: no phone linked this browser before the sign-in window closed",
			);
		}
		throw error;
	}
	if (!ready) {
		throw authFailure(
			"WhatsApp Web is showing its sign-in QR code: the session is not signed in",
		);
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

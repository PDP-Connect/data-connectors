// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the WhatsApp (web) connector: the parsers against the live
 * sample shapes (`__fixtures__/`, copies of the factory's `fixtures-live/`)
 * and the collection walk against a fake page that answers with those
 * shapes.
 *
 * Each finding from the first live run has a test that would have caught it:
 *   - the run failed DONE with `whatsapp_web_stores_not_ready` because the
 *     page scripts ran in an isolated world, where the app's module loader is
 *     not visible → the collect test asserts every script ran with
 *     `isolatedContext: false` (through `mainWorld`), and the waitForStores
 *     test pins both sides of its contract;
 *   - every stream emitted 0 records → the collect test runs the whole walk
 *     over the live shapes and asserts per-stream record counts, coverage
 *     accounting and stream states, while the parser tests pin each live
 *     format: the chat's `kind` comes from its `server` field (the masked
 *     live ids alone say nothing), an interactive message's digit-string
 *     duration (unit unknown) is not emitted as seconds, and the contacts and groups streams read
 *     whole collections, not per-id lookups.
 *
 * Each finding from the second live run has its test too:
 *   - a chat whose history state still says messages remain on the phone
 *     after its one on-demand history request (state 4,
 *     COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY) must not be
 *     reported as fully covered: the local store's short page is not the
 *     chat's whole history while the phone holds more. The state-split test
 *     pins that state 4 is out of reach, and the 0 -> 4 collect test runs
 *     the whole flow and asserts the answered chat's visible DETAIL_GAP and
 *     its place in the coverage accounting's gapKeys.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	makeRecordingEmit,
	type RecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	assertReadOnlyCall,
	collect,
	listChats,
	listContacts,
	listGroups,
	mainWorld,
	readChatMessages,
	type ScriptRunner,
	STORES_SCRIPT,
	sendHistorySyncOnDemand,
	waitForStores,
} from "./index.ts";
import {
	buildChat,
	buildContact,
	buildGroup,
	buildMessage,
	chatKind,
	END_OF_HISTORY_TRANSFER_NAMES,
	historyOutOfReach,
	historyStateName,
	needsHistoryRequest,
	parseChatsPage,
	parseChatWalk,
	parseContactsPage,
	parseGroupsPage,
	parseHistoryAck,
	parseMessagesList,
	parseStoresReadiness,
	storesReady,
	TextTally,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(
			new URL(`./__fixtures__/${name}.json`, import.meta.url),
			"utf8",
		),
	);

const asObject = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};

const chatsFixture = fixture("chats") as Array<Record<string, unknown>>;
const messagesInMemoryFixture = fixture("messages-in-memory") as Array<
	Record<string, unknown>
>;
const messagesLocalFixture = fixture("messages-local") as Array<{
	chat_id: string;
	status: number;
	messages: Array<Record<string, unknown>>;
}>;
const walkFixture = fixture("messages") as Record<string, unknown>;
const contactsFixture = fixture("contacts") as Array<Record<string, unknown>>;
const groupsFixture = fixture("groups") as Array<Record<string, unknown>>;
const historySyncFixture = fixture("history-sync") as {
	states: Record<string, number>;
	on_demand_enabled: boolean;
	request_type: number;
};

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// ─── chats ───────────────────────────────────────────────────────────────

test("the chats fixture parses and kind comes from the chat's server field", () => {
	const parsed = parseChatsPage(chatsFixture);
	assert.ok(parsed !== null, "the live chats shape must parse");
	assert.equal(parsed.length, chatsFixture.length);

	const first = parsed[0];
	assert.ok(first !== undefined);
	const built = buildChat(first, new TextTally());
	const record = built.record;
	// The live sample's id is masked text that carries no server; the server
	// field does. kind must be `user`, not `other`.
	assert.equal(record.id, "Synthetic id 1 lorem lorem");
	assert.equal(record.kind, "user");
	assert.equal(record.title, "Synthetic title 2 lorem lorem");
	assert.equal(record.last_activity_at, iso(1791953029));
	assert.equal(record.archived, false);
	assert.equal(record.pinned, false, "a null pin is not pinned");
	assert.equal(record.muted_until, null, "mute_expiration 0 is not muted");
	assert.equal(record.unread_count, 0);
	assert.equal(record.read_only, false);
	assert.equal(
		record.history_state,
		"Synthetic history_state 3 lorem lorem lorem lorem lorem lorem",
	);

	const second = parsed[1];
	assert.ok(second !== undefined);
	assert.equal(buildChat(second, new TextTally()).record.kind, "user");

	const third = parsed[2];
	assert.ok(third !== undefined);
	assert.equal(buildChat(third, new TextTally()).record.kind, "user");
});

test("chatKind maps the live servers, falling back to the id's own", () => {
	assert.equal(chatKind("any@lid", "lid"), "user");
	assert.equal(chatKind("any@c.us", "c.us"), "user");
	assert.equal(chatKind("any@s.whatsapp.net", "s.whatsapp.net"), "user");
	assert.equal(chatKind("any@g.us", "g.us"), "group");
	assert.equal(chatKind("status@broadcast", "broadcast"), "other");
	assert.equal(chatKind("any@newsletter", "newsletter"), "other");
	// No server field: the id's own part after `@`.
	assert.equal(chatKind("4915212345678@s.whatsapp.net"), "user");
	assert.equal(chatKind("120363021044321002@g.us"), "group");
	assert.equal(chatKind("status@broadcast"), "other");
	assert.equal(chatKind("no-server-at-all"), "other");
});

// ─── messages ────────────────────────────────────────────────────────────

test("the in-memory message list parses and maps its rows", () => {
	const rows = parseMessagesList(messagesInMemoryFixture);
	assert.ok(rows !== null, "the live in-memory shape must parse");
	assert.equal(rows.length, messagesInMemoryFixture.length);

	const chat = rows[0];
	assert.ok(chat !== undefined);
	const chatRecord = buildMessage(chat, new TextTally()).record;
	assert.equal(chatRecord.type, "chat");
	assert.equal(chatRecord.text, chat.body as string);
	assert.equal(chatRecord.chat_id, chat.remote as string);
	assert.equal(chatRecord.sent_at, iso(1791953029));
	assert.equal(chatRecord.author, null, "a one-to-one chat has no author");

	const interactive = rows[1];
	assert.ok(interactive !== undefined);
	const interactiveRecord = buildMessage(interactive, new TextTally()).record;
	assert.equal(interactiveRecord.type, "interactive");
	// A non-chat message's text is its caption.
	assert.equal(interactiveRecord.text, interactive.caption as string);
	assert.equal(interactiveRecord.media_mimetype, interactive.mimetype);
	assert.equal(interactiveRecord.media_size, 2418187);
	// The live sample's duration is a digit string on an interactive
	// message, a type whose duration has no known unit: it is not emitted.
	assert.equal(interactiveRecord.media_duration, null);
	assert.equal(interactiveRecord.media_filename, null);
	assert.equal(interactiveRecord.call_log, null);

	const link = rows[2];
	assert.ok(link !== undefined);
	const linkRecord = buildMessage(link, new TextTally()).record;
	assert.equal(linkRecord.subtype, "url");
	assert.equal(linkRecord.text, "https://example.com/item/11");

	// The walk's own chat id wins over the row's remote: the app's lid/c.us
	// dual ids can serialize the two differently, and the child record must
	// link to the parent the chats stream emitted. Without a parent id the
	// remote stays the fallback.
	const linked = buildMessage(chat, new TextTally(), "parent@c.us").record;
	assert.equal(linked.chat_id, "parent@c.us");
	const linkedLid = buildMessage(chat, new TextTally(), "parent@lid").record;
	assert.equal(linkedLid.chat_id, "parent@lid");
	assert.equal(buildMessage(chat, new TextTally()).record.chat_id, chat.remote);
	assert.equal(
		buildMessage(chat, new TextTally(), null).record.chat_id,
		chat.remote,
	);
	assert.equal(
		buildMessage(chat, new TextTally(), "").record.chat_id,
		chat.remote,
	);
});

test("a local store page parses and maps its rows", () => {
	const first = messagesLocalFixture[0];
	assert.ok(first !== undefined);
	const walk = parseChatWalk(first);
	assert.ok(walk !== null, "the live local page must parse");
	assert.equal(walk.chat_id, "Synthetic chat_id 1 lorem lorem");
	assert.equal(walk.status, 200);
	assert.equal(walk.messages.length, first.messages.length);

	const notification = walk.messages[0];
	assert.ok(notification !== undefined);
	const notificationRecord = buildMessage(notification, new TextTally()).record;
	assert.equal(notificationRecord.type, "e2e_notification");
	assert.equal(notificationRecord.text, null, "a system note has no text");
	assert.equal(notificationRecord.from_me, false);

	const sent = walk.messages[1];
	assert.ok(sent !== undefined);
	assert.equal(buildMessage(sent, new TextTally()).record.from_me, true);

	// The sample's empty pages parse too: a short page of zero messages.
	const empty = messagesLocalFixture[1];
	assert.ok(empty !== undefined);
	assert.deepEqual(parseMessagesList(empty.messages), []);
});

test("the walk answer carries memory, completion and anchoring through", () => {
	const walk = parseChatWalk(walkFixture);
	assert.ok(walk !== null, "the walk shape must parse");
	assert.equal(walk.chat_id, "Synthetic chat_id 1 lorem lorem");
	assert.equal(walk.status, 200);
	assert.equal(walk.memory.length, 0);
	assert.equal(walk.messages.length, 3);
	assert.equal(walk.complete, true, "the walk ended on a short page");
	assert.equal(walk.anchored, true, "the walk had an in-memory anchor");

	assert.equal(
		parseChatWalk({ chat_id: "x", status: "200" }),
		null,
		"a non-numeric status is not the app's shape",
	);
});

// ─── contacts ────────────────────────────────────────────────────────────

test("the contacts fixture parses and maps every declared field", () => {
	const parsed = parseContactsPage(contactsFixture);
	assert.ok(parsed !== null, "the live contacts shape must parse");
	assert.equal(parsed.length, contactsFixture.length);

	const first = parsed[0];
	assert.ok(first !== undefined);
	const record = buildContact(first, new TextTally()).record;
	assert.equal(record.id, "Synthetic id 1 lorem lorem");
	assert.equal(record.name, null);
	assert.equal(record.short_name, null);
	assert.equal(record.push_name, null);
	assert.equal(record.is_business, false);
	assert.equal(record.verified_name, null);

	const business = parsed[2];
	assert.ok(business !== undefined);
	const businessRecord = buildContact(business, new TextTally()).record;
	assert.equal(businessRecord.is_business, true);
	assert.equal(
		businessRecord.verified_name,
		"Synthetic verified_name 4 lorem lorem",
	);
});

// ─── groups ──────────────────────────────────────────────────────────────

test("the groups fixture parses and maps every declared field", () => {
	const parsed = parseGroupsPage(groupsFixture);
	assert.ok(parsed !== null, "the live groups shape must parse");
	assert.equal(parsed.length, groupsFixture.length);

	const first = parsed[0];
	assert.ok(first !== undefined);
	const record = buildGroup(first, new TextTally()).record;
	assert.equal(record.id, "user1@example.com");
	assert.equal(record.subject, "Synthetic subject 2 lorem");
	assert.equal(record.created_at, iso(1691779976));
	assert.equal(record.owner, "Synthetic owner 3 lorem lorem");
	assert.deepEqual(record.participants, [
		{
			id: "Synthetic id 4 lorem lorem",
			is_admin: false,
			is_super_admin: false,
		},
		{
			id: "Synthetic id 5 lorem lorem",
			is_admin: false,
			is_super_admin: false,
		},
		{ id: "Synthetic id 6 lorem lorem", is_admin: true, is_super_admin: true },
	]);
});

// ─── history states ──────────────────────────────────────────────────────

test("historyStateName matches the history-sync observation's own table", () => {
	for (const [name, value] of Object.entries(historySyncFixture.states)) {
		assert.equal(historyStateName(value), name);
		assert.equal(END_OF_HISTORY_TRANSFER_NAMES[value], name);
	}
	assert.equal(historyStateName(99), null);
	assert.equal(historyStateName(null), null);
	assert.equal(historySyncFixture.on_demand_enabled, true);
	assert.equal(historySyncFixture.request_type, 3);
});

test("needsHistoryRequest and historyOutOfReach split the states as observed", () => {
	const state = (value: number): string =>
		historyStateName(value) ?? "unexpected";
	// The on-demand request is for chats that have not yet asked (0, 2).
	assert.equal(needsHistoryRequest(state(0)), true);
	assert.equal(needsHistoryRequest(state(2)), true);
	assert.equal(needsHistoryRequest(state(1)), false);
	assert.equal(needsHistoryRequest(state(3)), false);
	assert.equal(needsHistoryRequest(state(4)), false);
	assert.equal(needsHistoryRequest(state(5)), false);
	assert.equal(needsHistoryRequest(null), false);
	// Out of reach after the request: an unanswered request (0), an answered
	// sync that still says messages remain on the phone (4 — the local store
	// cannot be the chat's complete coverage while the phone holds more), or
	// no access at all (5). Each of those gaps the chat visibly.
	assert.equal(historyOutOfReach(state(0)), true);
	assert.equal(
		historyOutOfReach(state(4)),
		true,
		"state 4 still says messages remain on the phone: the chat gaps",
	);
	assert.equal(historyOutOfReach(state(5)), true);
	assert.equal(historyOutOfReach(state(1)), false);
	assert.equal(historyOutOfReach(state(2)), false);
	assert.equal(historyOutOfReach(state(3)), false);
	assert.equal(historyOutOfReach(null), false);
});

// ─── page readiness ──────────────────────────────────────────────────────

const READY = {
	require_function: true,
	chats: true,
	contacts: true,
	groups: true,
	find_messages: true,
	send_request: true,
};

test("the readiness flags gate every stream's store", () => {
	const parsed = parseStoresReadiness(READY);
	assert.ok(parsed !== null);
	assert.equal(storesReady(parsed), true);
	const noChats = parseStoresReadiness({ ...READY, chats: false });
	assert.ok(noChats !== null);
	assert.equal(
		storesReady(noChats),
		false,
		"a stream's store missing is not ready",
	);
	const missing = parseStoresReadiness({ chats: true });
	assert.equal(missing, null, "a partial readiness answer is not the shape");
});

test("waitForStores resolves when the stores are ready and fails loudly when they never are", async () => {
	await waitForStores({ evaluate: async () => READY }, 2, 0);
	await assert.rejects(
		() =>
			waitForStores(
				{
					evaluate: async () => ({
						require_function: false,
						chats: false,
						contacts: false,
						groups: false,
						find_messages: false,
						send_request: false,
					}),
				},
				1,
				0,
			),
		(error: unknown) =>
			asObject(error).code === "whatsapp_web_stores_not_ready",
	);
});

// ─── the page scripts ────────────────────────────────────────────────────

test("every store script runs in the page's main world", () => {
	const calls: Array<{ isolatedContext: unknown; script: string }> = [];
	const runner = mainWorld({
		evaluate: (
			script: unknown,
			_arg?: unknown,
			_options?: unknown,
			isolatedContext?: unknown,
		): Promise<unknown> => {
			calls.push({ script: String(script), isolatedContext });
			return Promise.resolve("https://web.whatsapp.com/");
		},
	});
	return runner.evaluate("location.origin").then(() => {
		const call = calls[0];
		assert.ok(call !== undefined);
		// The bug the first live run died of: the scripts must not run in an
		// isolated world, where `window.require` does not exist.
		assert.equal(call.isolatedContext, false);
		assert.equal(call.script, "location.origin");
	});
});

test("the store scripts hit the real module names and methods", async () => {
	const scripts: string[] = [];
	const recorder: ScriptRunner = {
		evaluate: async (script: string) => {
			scripts.push(script);
			return null;
		},
	};

	await listChats(recorder);
	const chatsScript = scripts[0] ?? "";
	assert.ok(chatsScript.includes('window.require("WAWebCollections")'));
	assert.ok(chatsScript.includes("WAWebChatConstants"));
	assert.ok(chatsScript.includes("formattedTitle"));
	assert.ok(chatsScript.includes("server:"));
	assert.ok(
		chatsScript.includes(
			"COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY",
		),
		"the state-name fallback table is in the script",
	);

	await readChatMessages(recorder, "chat-one@example.com");
	const walkScript = scripts[1] ?? "";
	assert.ok(walkScript.includes('window.require("WAWebCollections")'));
	assert.ok(walkScript.includes('window.require("WAWebDBMessageFindLocal")'));
	assert.ok(
		walkScript.includes("msgFindBefore({ anchor: anchor, count: PAGE_SIZE })"),
	);
	// Each next anchor is the oldest real key of the page before.
	assert.ok(walkScript.includes("anchor = oldest.id;"));
	assert.ok(walkScript.includes("const PAGE_SIZE = 50;"));
	assert.ok(walkScript.includes('const chatId = "chat-one@example.com";'));
	assert.ok(walkScript.includes("Chat.get(chatId)"));
	// The row mapper reads the fields the app's own read reads (the observed
	// API evidence names quotedStanzaID and vcardFormattedName; neither
	// quotedMsgId nor vcardName appears in the observation).
	assert.ok(
		walkScript.includes("quotedStanzaID"),
		"quoted_id comes from the model's quotedStanzaID",
	);
	assert.ok(
		walkScript.includes("vcardFormattedName"),
		"vcard_name comes from the model's vcardFormattedName",
	);

	await listContacts(recorder, ["contact-one@example.com"]);
	const contactsScript = scripts[2] ?? "";
	assert.ok(contactsScript.includes("Contact.getModelsArray().filter"));
	assert.ok(contactsScript.includes('"contact-one@example.com"'));

	await listGroups(recorder);
	const groupsScript = scripts[3] ?? "";
	assert.ok(
		groupsScript.includes("WAWebGroupMetadataCollection.getModelsArray().map"),
	);

	await sendHistorySyncOnDemand(recorder, "chat-two@example.com");
	const sendScript = scripts[4] ?? "";
	assert.ok(sendScript.includes("WAWebSyncGatingUtils"));
	assert.ok(sendScript.includes("isHistorySyncOnDemandEnabled"));
	assert.ok(
		sendScript.includes('window.require("WAWebSendNonMessageDataRequest")'),
	);
	assert.ok(
		sendScript.includes("sendPeerDataOperationRequest(HISTORY_SYNC_ON_DEMAND"),
	);
	assert.ok(sendScript.includes('window.require("WAWebProtobufsE2E.pb")'));
	assert.ok(sendScript.includes('chatId: "chat-two@example.com"'));

	assert.ok(STORES_SCRIPT.includes('mod("WAWebCollections")'));
	assert.ok(STORES_SCRIPT.includes('mod("WAWebDBMessageFindLocal")'));
	assert.ok(STORES_SCRIPT.includes('mod("WAWebSendNonMessageDataRequest")'));

	assert.deepEqual(parseHistoryAck({ sent: true }), { sent: true });
	assert.equal(parseHistoryAck({ sent: "yes" }), null);
});

test("assertReadOnlyCall refuses a history request without a chat id", () => {
	assert.throws(
		() => assertReadOnlyCall("sendHistorySyncOnDemand", { chatId: "" }),
		(error: unknown) => asObject(error).code === "whatsapp_web_refused_call",
	);
	assert.throws(
		() => assertReadOnlyCall("sendHistorySyncOnDemand", {}),
		(error: unknown) => asObject(error).code === "whatsapp_web_refused_call",
	);
	assertReadOnlyCall("listChats", {});
});

// ─── the collection walk ─────────────────────────────────────────────────

const ZERO_TIMINGS = {
	settleAttempts: 1,
	settleMs: 0,
	historyAttempts: 1,
	historyMs: 0,
};

const STREAM_NAMES = ["chats", "messages", "contacts", "groups"];
const requested = new Map<string, StreamScope>(
	STREAM_NAMES.map((name) => [name, { name }]),
);

interface FakeAnswers {
	chats: unknown;
	walk: (chatId: string) => unknown;
	contacts: unknown;
	groups: unknown;
	send: (chatId: string) => unknown;
}

/** A page that answers each store script with the live fixture shapes. */
function fakePage(answers: FakeAnswers) {
	const calls: Array<{ isolatedContext: unknown; script: string }> = [];
	const page = {
		evaluate: (
			script: unknown,
			_arg?: unknown,
			_options?: unknown,
			isolatedContext?: unknown,
		): Promise<unknown> => {
			const s = String(script);
			calls.push({ script: s, isolatedContext });
			if (s.includes("typeof window.require")) return Promise.resolve(READY);
			if (s.includes("sendPeerDataOperationRequest")) {
				const id = /chatId: "(.+?)"/u.exec(s)?.[1] ?? "";
				return Promise.resolve(answers.send(id));
			}
			if (s.includes("getModelsArray().map((c) =>"))
				return Promise.resolve(answers.chats);
			if (s.includes("msgFindBefore")) {
				const id = /const chatId = "(.+?)";/u.exec(s)?.[1] ?? "";
				return Promise.resolve(answers.walk(id));
			}
			if (s.includes("Contact.getModelsArray().filter"))
				return Promise.resolve(answers.contacts);
			if (s.includes("WAWebGroupMetadataCollection.getModelsArray().map"))
				return Promise.resolve(answers.groups);
			return Promise.reject(
				new Error(`fake page: unexpected script ${s.slice(0, 60)}`),
			);
		},
	};
	return { calls, page };
}

const chatId = (chats: Array<Record<string, unknown>>, index: number): string =>
	String(chats[index]?.id ?? "");

/**
 * The e2e world: the live fixtures' chats, with real history-state names and
 * one chat turned into a group so the groups stream has a chat to match.
 * `settleTo` is the history state the on-demand request leaves chatB in: the
 * live phone answers by moving 0 -> 4 (the on-demand sync completed) — and
 * state 4 still says messages remain on the phone, so the chat gaps visibly.
 */
function e2eWorld(options: { settleOnSend: boolean; settleTo?: string }) {
	const chats = structuredClone(chatsFixture);
	const chatA = chats[0];
	const chatB = chats[1];
	const chatC = chats[2];
	assert.ok(chatA !== undefined && chatB !== undefined && chatC !== undefined);
	chatA.history_state = "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY";
	// chatB starts as a group chat that still has to ask for its history.
	chatB.id = "group-one@example.com";
	chatB.server = "g.us";
	chatB.history_state = "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY";
	// chatC already synced (this or a previous run): state 1 says nothing
	// remains on the phone, so its walk reads like any other chat's.
	chatC.history_state = "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY";

	const memoryA = {
		...messagesInMemoryFixture[0],
		remote: chatA.id,
	} as Record<string, unknown>;
	const memoryB = {
		...messagesInMemoryFixture[1],
		remote: chatB.id,
		author: "Synthetic author 14 lorem lorem",
	} as Record<string, unknown>;
	const memoryRowC = messagesInMemoryFixture[2];
	assert.ok(memoryRowC !== undefined);
	const memoryC = {
		...memoryRowC,
		remote: chatC.id,
	} as Record<string, unknown>;
	const localA = (messagesLocalFixture[0]?.messages ?? []).map((row) => ({
		...row,
		remote: chatA.id,
	}));

	const sentTo: string[] = [];
	const answers: FakeAnswers = {
		chats,
		walk: (id) => {
			if (id === chatA.id)
				return {
					chat_id: id,
					status: 200,
					memory: [memoryA],
					messages: localA,
					complete: true,
					anchored: true,
				};
			if (id === chatB.id)
				return {
					chat_id: id,
					status: 200,
					memory: [memoryB],
					messages: [],
					complete: true,
					anchored: true,
				};
			if (id === chatC.id)
				return {
					chat_id: id,
					status: 200,
					memory: [memoryC],
					messages: [],
					complete: true,
					anchored: true,
				};
			return {
				chat_id: id,
				status: 404,
				memory: [],
				messages: [],
				complete: false,
				anchored: false,
			};
		},
		contacts: contactsFixture,
		groups: groupsFixture,
		send: (id) => {
			sentTo.push(id);
			if (options.settleOnSend)
				chatB.history_state =
					options.settleTo ?? "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY";
			return { sent: true };
		},
	};
	return { chatA, chatB, chatC, chats, sentTo, ...fakePage(answers) };
}

async function runCollect(page: unknown): Promise<RecordingEmit> {
	const harness = makeRecordingEmit(validateRecord);
	await collect(
		{
			requested,
			page: page as Parameters<typeof collect>[0]["page"],
			emit: harness.emit,
			emitRecord: harness.emitRecord,
		},
		ZERO_TIMINGS,
	);
	return harness;
}

const recordsFor = (harness: RecordingEmit, stream: string) =>
	harness.emitted.filter((e) => e.stream === stream);

const protocolOf = (harness: RecordingEmit, type: string) =>
	harness.protocolMessages.filter((m) => asObject(m).type === type);

test("collect walks the live shapes: every stream emits its records", async () => {
	const world = e2eWorld({ settleOnSend: true });
	const harness = await runCollect(world.page);

	// Finding 1: every script ran in the page's main world.
	assert.ok(world.calls.length > 0);
	for (const call of world.calls) {
		assert.equal(
			call.isolatedContext,
			false,
			"the page's module loader is only visible from the main world",
		);
	}

	// Finding 3: chats from the live shape, kind from the server field.
	const chats = recordsFor(harness, "chats");
	assert.equal(chats.length, 3);
	assert.deepEqual(
		chats.map((c) => c.data.kind),
		["user", "group", "user"],
	);
	assert.ok(chats.every((c) => typeof c.data.history_state === "string"));

	// Finding 4: messages from the in-memory set and the local pages. All
	// three chats are walked, including the state-4 one.
	const messages = recordsFor(harness, "messages");
	assert.equal(messages.length, 6);
	const byChatId = new Map<string, number>();
	for (const m of messages)
		byChatId.set(
			String(m.data.chat_id),
			(byChatId.get(String(m.data.chat_id)) ?? 0) + 1,
		);
	assert.deepEqual(
		byChatId,
		new Map([
			[chatId(world.chats, 0), 4],
			[chatId(world.chats, 1), 1],
			[chatId(world.chats, 2), 1],
		]),
		"every chat's messages were read, including the state-4 chat's",
	);
	const interactive = messages.find((m) => m.data.type === "interactive");
	assert.ok(interactive !== undefined);
	assert.equal(interactive.data.media_duration, null);
	assert.equal(typeof interactive.data.media_size, "number");

	// Finding 5: contacts from the collection read.
	assert.equal(recordsFor(harness, "contacts").length, contactsFixture.length);
	// Finding 6: groups from the collection read.
	const groups = recordsFor(harness, "groups");
	assert.equal(groups.length, groupsFixture.length);
	assert.ok(groups.every((g) => Array.isArray(g.data.participants)));
	assert.equal(harness.skipped.length, 0, "every record passed shape-check");

	// Exactly one on-demand history request, for the chat that needed it.
	assert.deepEqual(world.sentTo, [chatId(world.chats, 1)]);
});

test("collect accounts for every chat: full coverage, states after records", async () => {
	const world = e2eWorld({ settleOnSend: true });
	const harness = await runCollect(world.page);

	const idA = chatId(world.chats, 0);
	const idB = chatId(world.chats, 1);
	const idC = chatId(world.chats, 2);

	const gaps = protocolOf(harness, "DETAIL_GAP");
	assert.equal(
		gaps.length,
		0,
		"no chat is gapped: every walk completed on its own short page",
	);

	const coverages = protocolOf(harness, "DETAIL_COVERAGE");
	assert.equal(coverages.length, 1);
	const coverage = asObject(coverages[0]);
	assert.equal(coverage.stream, "messages");
	assert.equal(coverage.state_stream, "chats");
	assert.deepEqual(coverage.required_keys, [idA, idB, idC]);
	assert.deepEqual(coverage.hydrated_keys, [idA, idB, idC]);
	// An empty gap list omits the field; the chat was answered either way.
	assert.deepEqual(coverage.gap_keys ?? [], []);

	// Parents before children; each stream's STATE after its last record.
	const events = harness.events;
	const lastRecordOf = (stream: string): number => {
		let last = -1;
		events.forEach((e, i) => {
			if (e.kind === "record" && e.stream === stream) last = i;
		});
		return last;
	};
	const stateIndex = (stream: string): number => {
		const index = events.findIndex(
			(e) =>
				e.kind === "message" &&
				asObject(e.message).type === "STATE" &&
				asObject(e.message).stream === stream,
		);
		assert.ok(index >= 0, `a STATE for ${stream} was emitted`);
		return index;
	};
	assert.ok(
		lastRecordOf("chats") <
			events.findIndex((e) => e.kind === "record" && e.stream === "messages"),
	);
	assert.ok(lastRecordOf("messages") < stateIndex("groups"));
	assert.ok(lastRecordOf("groups") < stateIndex("groups"));
	assert.ok(lastRecordOf("contacts") < stateIndex("contacts"));
	assert.ok(lastRecordOf("chats") < stateIndex("chats"));

	const chatsState = asObject(
		harness.protocolMessages.find(
			(m) => asObject(m).type === "STATE" && asObject(m).stream === "chats",
		),
	);
	const cursor = asObject(chatsState.cursor);
	assert.deepEqual(
		Object.keys(asObject(cursor.chats)).sort(),
		[idA, idB, idC].sort(),
	);
});

test("a chat whose history request does not settle gaps visibly", async () => {
	const world = e2eWorld({ settleOnSend: false });
	const harness = await runCollect(world.page);

	const idA = chatId(world.chats, 0);
	const idB = chatId(world.chats, 1);
	const idC = chatId(world.chats, 2);
	assert.deepEqual(world.sentTo, [idB], "the request was sent once");

	const gaps = protocolOf(harness, "DETAIL_GAP");
	assert.equal(gaps.length, 1, "chatB is the only visible gap");
	assert.deepEqual(
		gaps.map((g) => asObject(g).record_key),
		[idB],
	);
	const coverage = asObject(protocolOf(harness, "DETAIL_COVERAGE")[0]);
	assert.deepEqual(coverage.hydrated_keys, [idA, idC]);
	assert.deepEqual(coverage.gap_keys, [idB]);
	// The gapped chat's local messages are still emitted; only the
	// remainder on the phone is the gap.
	assert.equal(messagesOfChat(harness, idB).length, 1);
	assert.equal(messagesOfChat(harness, idC).length, 1);
});

test("a chat the on-demand request answers (0 -> 4) gaps visibly", async () => {
	// The second live run's finding: the phone answers the on-demand request
	// by moving the chat 0 -> 4 (COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY)
	// within seconds. State 4 still says messages remain on the phone —
	// messages beyond what the client's local store holds — so reporting the
	// local walk as the chat's complete coverage is a silent omission. The
	// chat gets a visible DETAIL_GAP and a gap key, and is retried next run.
	const world = e2eWorld({
		settleOnSend: true,
		settleTo: "COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY",
	});
	const harness = await runCollect(world.page);

	const idA = chatId(world.chats, 0);
	const idB = chatId(world.chats, 1);
	const idC = chatId(world.chats, 2);
	assert.deepEqual(world.sentTo, [idB], "the request was sent once");

	assert.deepEqual(
		protocolOf(harness, "DETAIL_GAP").map((g) => asObject(g).record_key),
		[idB],
		"the answered-but-not-complete chat is a visible gap",
	);
	const coverage = asObject(protocolOf(harness, "DETAIL_COVERAGE")[0]);
	assert.deepEqual(coverage.required_keys, [idA, idB, idC]);
	assert.deepEqual(coverage.hydrated_keys, [idA, idC]);
	assert.deepEqual(coverage.gap_keys, [idB]);
	assert.equal(
		messagesOfChat(harness, idB).length,
		1,
		"the gapped chat's local messages are emitted; the gap covers only the phone's remainder",
	);
	assert.equal(
		messagesOfChat(harness, idC).length,
		1,
		"the fully synced chat's walk read as usual",
	);
});

const messagesOfChat = (harness: RecordingEmit, chatIdValue: string) =>
	harness.emitted.filter(
		(e) => e.stream === "messages" && e.data.chat_id === chatIdValue,
	);

test("an empty chat collection fails loudly instead of succeeding silently", async () => {
	const world = e2eWorld({ settleOnSend: true });
	world.chats.length = 0;
	await assert.rejects(
		() => runCollect(world.page),
		(error: unknown) => asObject(error).code === "whatsapp_web_empty_chat_list",
	);
});

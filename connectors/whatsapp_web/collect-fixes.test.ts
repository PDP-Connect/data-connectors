// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the third live run's findings and the last review's findings.
 * Every value here is synthetic, in the shapes `__fixtures__/` (copies of the
 * factory's `fixtures-live/`) hold; the page scripts run offline in a node
 * `vm` against stub modules, never against a live page.
 *
 *   1. A chat whose history partly remains on the phone after its one
 *      on-demand request (state 0, 4 or 5) still has every locally stored
 *      message read and emitted; only then is the remainder gapped.
 *   2. That gap's reason is `retry_exhausted` (the one request was made and
 *      the device holds no more), not `temporary_unavailable`.
 *   3. `author` names the sender: a group sender's wid is unwrapped
 *      (`_serialized`, falling back to the key's participant), and a
 *      one-to-one message's author is the owner (from_me) or the chat peer.
 *   4. `muted_until` / `muted` follow muteExpiration: 0 or absent = not
 *      muted, -1 = muted with no end, a positive value = the end time.
 *   5. `call_duration` is emitted; `media_duration` only where its unit is
 *      known (seconds, for audio and video types); the history request is not
 *      sent when its gate cannot be verified; `contacts` has no nullable-text
 *      cursor; a non-200 page mid-walk and the walk's page cap gap the chat.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import type { StreamScope } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	makeRecordingEmit,
	type RecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collect,
	listChats,
	listContacts,
	listGroups,
	MESSAGE_PAGE_SIZE,
	probeWhatsAppSessionOnPage,
	readChatMessages,
	type ScriptRunner,
	SIGNED_IN_SCRIPT,
	STORES_SCRIPT,
	sendHistorySyncOnDemand,
} from "./index.ts";
import {
	buildChat,
	buildMessage,
	parseChatWalk,
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
const memoryFixture = fixture("messages-in-memory") as Array<
	Record<string, unknown>
>;
const localFixture = fixture("messages-local") as Array<{
	messages: Array<Record<string, unknown>>;
}>;
const contactsFixture = fixture("contacts");
const groupsFixture = fixture("groups");

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();

// ─── the collection walk over a fake page ────────────────────────────────

const READY = {
	require_function: true,
	chats: true,
	contacts: true,
	groups: true,
	find_messages: true,
	send_request: true,
};

const ZERO_TIMINGS = {
	settleAttempts: 1,
	settleMs: 0,
	historyAttempts: 1,
	historyMs: 0,
};

const requested = new Map<string, StreamScope>(
	["chats", "messages", "contacts", "groups"].map((name) => [name, { name }]),
);

interface World {
	chats: Array<Record<string, unknown>>;
	walk: (chatId: string) => unknown;
	send: (chatId: string) => unknown;
}

function fakePage(world: World) {
	return {
		evaluate: (script: unknown): Promise<unknown> => {
			const s = String(script);
			if (s.includes("typeof window.require")) return Promise.resolve(READY);
			if (s.includes("WAWebStreamModel"))
				return Promise.resolve({ mode: "MAIN", resume_complete: true });
			if (s.includes("sendPeerDataOperationRequest")) {
				const id = /chatId: "(.+?)"/u.exec(s)?.[1] ?? "";
				return Promise.resolve(world.send(id));
			}
			if (s.includes("getModelsArray().map((c) =>"))
				return Promise.resolve(world.chats);
			if (s.includes("msgFindBefore")) {
				const id = /const chatId = "(.+?)";/u.exec(s)?.[1] ?? "";
				return Promise.resolve(world.walk(id));
			}
			if (s.includes("Contact.getModelsArray().filter"))
				return Promise.resolve(contactsFixture);
			if (s.includes("WAWebGroupMetadataCollection.getModelsArray().map"))
				return Promise.resolve(groupsFixture);
			return Promise.reject(new Error("fake page: unexpected script"));
		},
	};
}

async function runCollect(world: World): Promise<RecordingEmit> {
	const harness = makeRecordingEmit(validateRecord);
	await collect(
		{
			requested,
			page: fakePage(world) as unknown as Parameters<typeof collect>[0]["page"],
			emit: harness.emit,
			emitRecord: harness.emitRecord,
		},
		ZERO_TIMINGS,
	);
	return harness;
}

const gapsOf = (harness: RecordingEmit) =>
	harness.protocolMessages
		.filter((m) => asObject(m).type === "DETAIL_GAP")
		.map(asObject);

const coverageOf = (harness: RecordingEmit) =>
	asObject(
		harness.protocolMessages.find(
			(m) => asObject(m).type === "DETAIL_COVERAGE",
		),
	);

const messagesOfChat = (harness: RecordingEmit, chatIdValue: string) =>
	harness.emitted.filter(
		(e) => e.stream === "messages" && e.data.chat_id === chatIdValue,
	);

/** A one-chat world whose chat holds one message in memory and `local` older ones. */
function oneChatWorld(options: {
	initialState: string;
	settleTo: string;
	walk?: Partial<Record<string, unknown>>;
	sendAnswer?: unknown;
}) {
	const chats = structuredClone(chatsFixture.slice(0, 1));
	const chat = chats[0];
	assert.ok(chat !== undefined);
	chat.history_state = options.initialState;
	const id = String(chat.id);
	const memory = [{ ...memoryFixture[0], remote: id }];
	const local = (localFixture[0]?.messages ?? []).map((row) => ({
		...row,
		remote: id,
	}));
	const sentTo: string[] = [];
	const world: World = {
		chats,
		walk: (chatIdValue) => ({
			chat_id: chatIdValue,
			status: 200,
			memory,
			messages: local,
			complete: true,
			anchored: true,
			stop: "short_page",
			...options.walk,
		}),
		send: (chatIdValue) => {
			sentTo.push(chatIdValue);
			chat.history_state = options.settleTo;
			return options.sendAnswer ?? { sent: true };
		},
	};
	return { world, id, sentTo, localCount: local.length };
}

const STATE_0 = "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY";
const STATE_1 = "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY";
const STATE_2 = "INCOMPLETE";
const STATE_4 = "COMPLETE_ON_DEMAND_SYNC_BUT_MORE_MSG_REMAIN_ON_PRIMARY";
const STATE_5 =
	"COMPLETE_ON_DEMAND_SYNC_WITH_MORE_MSG_ON_PRIMARY_BUT_NO_ACCESS";

for (const settleTo of [STATE_0, STATE_4, STATE_5]) {
	test(`fix 1+2: a chat left in ${settleTo} emits every local message, then gaps the rest as retry_exhausted`, async () => {
		const { world, id, sentTo, localCount } = oneChatWorld({
			initialState: STATE_0,
			settleTo,
		});
		const harness = await runCollect(world);
		assert.deepEqual(sentTo, [id], "exactly one on-demand request");

		// Every locally stored message of the chat is emitted: the in-memory
		// one plus every older one the local walk returned.
		assert.equal(messagesOfChat(harness, id).length, 1 + localCount);

		const gaps = gapsOf(harness);
		assert.equal(gaps.length, 1, "the remainder on the phone is one gap");
		const gap = gaps[0];
		assert.ok(gap !== undefined);
		assert.equal(gap.record_key, id);
		assert.equal(gap.stream, "messages");
		assert.equal(gap.parent_stream, "chats");
		assert.equal(gap.reason, "retry_exhausted");
		assert.notEqual(gap.reason, "temporary_unavailable");
		assert.equal(asObject(gap.last_error).class, "history_remains_on_phone");

		// The gap comes after the chat's messages.
		const events = harness.events;
		const lastMessage = events.findLastIndex(
			(e) => e.kind === "record" && e.stream === "messages",
		);
		const gapIndex = events.findIndex(
			(e) => e.kind === "message" && asObject(e.message).type === "DETAIL_GAP",
		);
		assert.ok(lastMessage >= 0 && gapIndex > lastMessage);

		const coverage = coverageOf(harness);
		assert.deepEqual(coverage.gap_keys, [id]);
		assert.deepEqual(coverage.hydrated_keys, []);
	});
}

test("fix 1: a chat whose history is all on this device (state 1) is hydrated with no gap", async () => {
	const { world, id, sentTo, localCount } = oneChatWorld({
		initialState: STATE_1,
		settleTo: STATE_1,
	});
	const harness = await runCollect(world);
	assert.deepEqual(sentTo, [], "no request for a chat that needs none");
	assert.equal(messagesOfChat(harness, id).length, 1 + localCount);
	assert.equal(gapsOf(harness).length, 0);
	assert.deepEqual(coverageOf(harness).hydrated_keys, [id]);
});

test("fix 5: a request the gate refused (state 2 left as is) still gaps the chat after its local messages", async () => {
	const { world, id, localCount } = oneChatWorld({
		initialState: STATE_2,
		settleTo: STATE_2,
		sendAnswer: {
			sent: false,
			reason: "history_sync_on_demand_gate_unverified",
		},
	});
	const harness = await runCollect(world);
	assert.equal(messagesOfChat(harness, id).length, 1 + localCount);
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1, "state 2 with no request sent is not covered");
	assert.equal(gaps[0]?.reason, "retry_exhausted");
	assert.deepEqual(coverageOf(harness).gap_keys, [id]);
});

test("fix 5: a non-200 page mid-walk emits what was read and gaps the chat", async () => {
	const { world, id } = oneChatWorld({
		initialState: STATE_1,
		settleTo: STATE_1,
		walk: { status: 404, complete: false, stop: "status" },
	});
	const harness = await runCollect(world);
	assert.ok(messagesOfChat(harness, id).length > 0, "what was read is kept");
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0]?.reason, "temporary_unavailable");
	assert.equal(asObject(gaps[0]?.last_error).class, "local_store_status_404");
	assert.deepEqual(coverageOf(harness).gap_keys, [id]);
	assert.deepEqual(coverageOf(harness).hydrated_keys, []);
});

test("fix 5: a walk that hits its page cap gaps the chat", async () => {
	const { world, id } = oneChatWorld({
		initialState: STATE_1,
		settleTo: STATE_1,
		walk: { complete: false, stop: "page_cap" },
	});
	const harness = await runCollect(world);
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1);
	assert.equal(gaps[0]?.reason, "retry_exhausted");
	assert.equal(asObject(gaps[0]?.last_error).class, "local_walk_page_cap");
	assert.deepEqual(coverageOf(harness).gap_keys, [id]);
});

test("fix 5: a chat with activity but no in-memory message to anchor on gaps instead of passing as empty", async () => {
	const { world, id } = oneChatWorld({
		initialState: STATE_1,
		settleTo: STATE_1,
		walk: {
			memory: [],
			messages: [],
			complete: false,
			anchored: false,
			stop: "no_anchor",
		},
	});
	const harness = await runCollect(world);
	assert.equal(messagesOfChat(harness, id).length, 0);
	const gaps = gapsOf(harness);
	assert.equal(gaps.length, 1);
	assert.equal(asObject(gaps[0]?.last_error).class, "no_in_memory_anchor");
	assert.deepEqual(coverageOf(harness).gap_keys, [id]);
});

// ─── authors ─────────────────────────────────────────────────────────────

const ME = "owner-self@lid";

test("fix 3: a group sender's wid is unwrapped, and a one-to-one author is the owner or the peer", () => {
	const base = memoryFixture[0];
	assert.ok(base !== undefined);
	const tally = new TextTally();

	// Group: the sender wid arrives as an object with `_serialized`.
	const groupRow = parseChatWalk({
		chat_id: "group-one@g.us",
		status: 200,
		me_id: ME,
		memory: [
			{
				...base,
				remote: "group-one@g.us",
				author: { _serialized: "member-two@lid", server: "lid" },
			},
		],
		messages: [],
		complete: true,
	});
	assert.ok(groupRow !== null, "a wid-object author parses");
	const groupMessage = groupRow.memory[0];
	assert.ok(groupMessage !== undefined);
	assert.equal(
		buildMessage(groupMessage, tally, "group-one@g.us", {
			kind: "group",
			meId: ME,
		}).record.author,
		"member-two@lid",
	);
	// The owner's own group message names the owner.
	const ownGroup = buildMessage(
		{ ...groupMessage, author: null, from_me: true },
		tally,
		"group-one@g.us",
		{ kind: "group", meId: ME },
	).record;
	assert.equal(ownGroup.author, ME);

	// One-to-one: the peer wrote it, or the owner did.
	const peerRow = { ...groupMessage, author: null, from_me: false };
	assert.equal(
		buildMessage(peerRow, tally, "peer-one@lid", { kind: "user", meId: ME })
			.record.author,
		"peer-one@lid",
	);
	assert.equal(
		buildMessage({ ...peerRow, from_me: true }, tally, "peer-one@lid", {
			kind: "user",
			meId: ME,
		}).record.author,
		ME,
	);
	for (const record of [ownGroup]) {
		assert.equal(validateRecord("messages", record).ok, true);
	}
});

test("fix 3: collect passes the owner id and chat kind through, so every message has an author", async () => {
	const { world, id } = oneChatWorld({
		initialState: STATE_1,
		settleTo: STATE_1,
		walk: { me_id: ME },
	});
	const harness = await runCollect(world);
	const messages = messagesOfChat(harness, id);
	assert.ok(messages.length > 0);
	for (const m of messages) {
		assert.equal(
			m.data.author,
			m.data.from_me === true ? ME : id,
			"one-to-one author is the owner or the peer",
		);
	}
});

// ─── mute ────────────────────────────────────────────────────────────────

test("fix 4: muteExpiration 0/absent is not muted, -1 is muted with no end, a time is the mute's end, with no clock read", () => {
	const chat = chatsFixture[0];
	assert.ok(chat !== undefined);
	const build = (mute: unknown) =>
		buildChat({ ...chat, mute_expiration: mute } as never, new TextTally())
			.record;

	for (const notMuted of [0, null, undefined]) {
		const r = build(notMuted);
		assert.equal(r.muted, false);
		assert.equal(r.muted_until, null);
	}
	const forever = build(-1);
	assert.equal(forever.muted, true, "-1 is the app's mute-always value");
	assert.equal(forever.muted_until, null);
	const until = build(1_792_000_000);
	assert.equal(until.muted, true);
	assert.equal(until.muted_until, iso(1_792_000_000));
	// A mute whose end has passed is still the mute the source holds: the
	// record does not change with the run's clock, only with the source.
	const expired = build(1_000_000_000);
	assert.equal(expired.muted, true, "a mute set in the source, end passed");
	assert.equal(expired.muted_until, iso(1_000_000_000));
	for (const r of [build(0), forever, until, expired]) {
		assert.equal(validateRecord("chats", r).ok, true);
	}
});

// ─── call and media durations ────────────────────────────────────────────

test("fix 5: call_duration is emitted for calls; media_duration only where its unit is known", () => {
	const base = memoryFixture[0];
	assert.ok(base !== undefined);
	const parsed = parseChatWalk({
		chat_id: "peer-one@lid",
		status: 200,
		memory: [
			{
				...base,
				type: "call_log",
				body: null,
				call_duration: 95,
				call_outcome: "Connected",
			},
			{ ...base, type: "ptt", body: null, duration: "12" },
			{ ...base, type: "video", body: null, duration: 31 },
			// The interactive sample's digit string is not a known duration.
			{ ...base, type: "interactive", body: null, duration: "100008" },
		],
		messages: [],
		complete: true,
	});
	assert.ok(parsed !== null);
	const [call, ptt, video, interactive] = parsed.memory.map(
		(row) => buildMessage(row, new TextTally(), "peer-one@lid").record,
	);
	assert.equal(call?.call_duration, 95);
	assert.equal(call?.media_duration, null);
	assert.equal(ptt?.media_duration, 12);
	assert.equal(ptt?.call_duration, null);
	assert.equal(video?.media_duration, 31);
	assert.equal(interactive?.media_duration, null);
	for (const r of [call, ptt, video, interactive]) {
		assert.equal(validateRecord("messages", r as never).ok, true);
	}
});

// ─── manifest ────────────────────────────────────────────────────────────

test("fix 5: the contacts stream has no nullable-text cursor or consent time", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { streams: Array<Record<string, unknown>> };
	const contacts = manifest.streams.find((s) => s.name === "contacts");
	assert.ok(contacts !== undefined);
	assert.notEqual(contacts.cursor_field, "name");
	assert.notEqual(contacts.consent_time_field, "name");
	assert.equal(contacts.incremental, false, "contacts is a full refresh");
	const messages = manifest.streams.find((s) => s.name === "messages");
	const props = asObject(asObject(messages?.schema).properties);
	assert.ok("call_duration" in props, "the manifest declares call_duration");
	const chats = manifest.streams.find((s) => s.name === "chats");
	assert.ok("muted" in asObject(asObject(chats?.schema).properties));
});

// ─── the page scripts, offline against stub modules ──────────────────────

/** A synthetic message key: what the client's own keys expose to the scripts. */
class StubKey {
	readonly remote: string;
	readonly id: string;
	readonly fromMe: boolean;
	readonly participant: { _serialized: string } | undefined;
	constructor(remote: string, n: number, fromMe = false, participant?: string) {
		this.remote = remote;
		this.id = `K${String(n)}`;
		this.fromMe = fromMe;
		this.participant =
			participant === undefined ? undefined : { _serialized: participant };
	}
	get _serialized(): string {
		return `${String(this.fromMe)}_${this.remote}_${this.id}`;
	}
	toString(): string {
		return this._serialized;
	}
}

const stubMsg = (
	key: StubKey,
	t: number,
	extra: Record<string, unknown> = {},
) => ({
	id: key,
	t,
	type: "chat",
	body: "synthetic",
	...extra,
});

/**
 * Runs store scripts offline in a vm whose `window.require` serves `modules`.
 * One runner is one page: every script it runs shares one global object.
 */
function vmRunner(modules: Record<string, unknown>): ScriptRunner {
	const sandbox = vm.createContext({
		window: {
			require: (name: string) => {
				if (!(name in modules)) throw new Error(`no module ${name}`);
				return modules[name];
			},
		},
	});
	return {
		evaluate: async (script: string) => await vm.runInContext(script, sandbox),
	};
}

/**
 * A synthetic chat of `total` messages, oldest first, and a local store that
 * answers msgFindBefore the way the client's does: up to `count` messages
 * strictly before the anchor, oldest first.
 */
function stubChat(options: {
	chatId: string;
	total: number;
	inMemory: number;
	failAtCall?: number;
	groupAuthor?: string;
	endless?: boolean;
}) {
	const all = Array.from({ length: options.total }, (_, i) =>
		stubMsg(
			new StubKey(options.chatId, i, false, options.groupAuthor),
			1_700_000_000 + i,
			{
				author:
					options.groupAuthor === undefined
						? undefined
						: { _serialized: options.groupAuthor },
			},
		),
	);
	const memory = all.slice(all.length - options.inMemory);
	const anchors: string[] = [];
	let calls = 0;
	let endlessNext = -1;
	const msgFindBefore = async ({
		anchor,
		count,
	}: {
		anchor: StubKey;
		count: number;
	}) => {
		calls += 1;
		anchors.push(anchor.toString());
		if (!(anchor instanceof StubKey)) throw new Error("not a real key");
		if (options.failAtCall === calls) return { status: 500, messages: [] };
		if (options.endless) {
			// Always a full page of older messages: the walk must stop on its cap.
			const page = Array.from({ length: count }, () =>
				stubMsg(new StubKey(options.chatId, endlessNext--), 1_600_000_000),
			).reverse();
			return { status: 200, messages: page };
		}
		const index = all.findIndex((m) => m.id.toString() === anchor.toString());
		const before = all.slice(Math.max(0, index - count), index);
		return { status: 200, messages: before };
	};
	const chat = {
		id: { _serialized: options.chatId, server: options.chatId.split("@")[1] },
		t: 1_700_000_000 + options.total,
		msgs: { getModelsArray: () => memory },
	};
	const modules = {
		WAWebCollections: {
			Chat: { get: (id: string) => (id === options.chatId ? chat : undefined) },
		},
		WAWebDBMessageFindLocal: { msgFindBefore },
		WAWebUserPrefsMeUser: {
			getMaybeMeLidUser: () => ({ _serialized: ME }),
			getMaybeMePnUser: () => ({ _serialized: "owner-self@c.us" }),
		},
	};
	return { modules, anchors, all, calls: () => calls };
}

test("fix 1: the in-page walk pages back from each page's oldest real key and reads every local message", async () => {
	const total = MESSAGE_PAGE_SIZE * 2 + 17;
	const stub = stubChat({ chatId: "peer-one@lid", total, inMemory: 1 });
	const walk = parseChatWalk(
		await readChatMessages(vmRunner(stub.modules), "peer-one@lid"),
	);
	assert.ok(walk !== null);
	assert.equal(walk.status, 200);
	assert.equal(walk.complete, true);
	assert.equal(walk.stop, "short_page");
	assert.equal(walk.me_id, ME);
	const ids = new Set([...walk.memory, ...walk.messages].map((m) => m.id));
	assert.equal(ids.size, total, "every message the local store holds");
	// Each anchor after the first is the oldest key of the page before it.
	assert.equal(stub.anchors[0], stub.all.at(-1)?.id.toString());
	assert.equal(
		stub.anchors[1],
		stub.all.at(-1 - MESSAGE_PAGE_SIZE)?.id.toString(),
	);
});

test("fix 5: the in-page walk reports a non-200 page mid-walk as incomplete", async () => {
	const stub = stubChat({
		chatId: "peer-one@lid",
		total: MESSAGE_PAGE_SIZE * 3,
		inMemory: 1,
		failAtCall: 2,
	});
	const walk = parseChatWalk(
		await readChatMessages(vmRunner(stub.modules), "peer-one@lid"),
	);
	assert.ok(walk !== null);
	assert.equal(walk.status, 500);
	assert.equal(walk.complete, false);
	assert.equal(walk.stop, "status");
	assert.equal(
		walk.messages.length,
		MESSAGE_PAGE_SIZE,
		"the first page is kept",
	);
});

test("fix 5: the in-page walk ends a chunk on its page budget and says more remains", async () => {
	const stub = stubChat({
		chatId: "peer-one@lid",
		total: 3,
		inMemory: 1,
		endless: true,
	});
	const walk = parseChatWalk(
		await readChatMessages(vmRunner(stub.modules), "peer-one@lid"),
	);
	assert.ok(walk !== null);
	assert.equal(walk.complete, false);
	assert.equal(walk.stop, "chunk");
	assert.equal(walk.more, true);
	assert.ok(walk.token !== null);
	assert.ok(stub.calls() > 1);
});

test("fix 3: the in-page mapper unwraps a group sender's wid", async () => {
	const stub = stubChat({
		chatId: "group-one@g.us",
		total: 4,
		inMemory: 1,
		groupAuthor: "member-two@lid",
	});
	const walk = parseChatWalk(
		await readChatMessages(vmRunner(stub.modules), "group-one@g.us"),
	);
	assert.ok(walk !== null);
	for (const row of [...walk.memory, ...walk.messages]) {
		assert.equal(row.author, "member-two@lid");
	}
});

test("fix 5: a chat with activity and nothing in memory reports no anchor instead of an empty complete walk", async () => {
	const stub = stubChat({ chatId: "group-one@g.us", total: 4, inMemory: 0 });
	const walk = parseChatWalk(
		await readChatMessages(vmRunner(stub.modules), "group-one@g.us"),
	);
	assert.ok(walk !== null);
	assert.equal(walk.complete, false);
	assert.equal(walk.stop, "no_anchor");
	assert.equal(stub.calls(), 0, "no anchor is ever made up");
});

test("fix 5: the history request is not sent when its gate cannot be verified or is off", async () => {
	for (const gate of [
		() => {
			throw new Error("gate module missing");
		},
		() => undefined,
		() => false,
	]) {
		const sent: unknown[] = [];
		const runner = vmRunner({
			WAWebSyncGatingUtils: { isHistorySyncOnDemandEnabled: gate },
			WAWebSendNonMessageDataRequest: {
				sendPeerDataOperationRequest: async (...args: unknown[]) => {
					sent.push(args);
				},
			},
			"WAWebProtobufsE2E.pb": {
				Message$PeerDataOperationRequestType: { HISTORY_SYNC_ON_DEMAND: 3 },
			},
		});
		const answer = asObject(
			await sendHistorySyncOnDemand(runner, "peer-one@lid"),
		);
		assert.equal(answer.sent, false);
		assert.equal(sent.length, 0, "nothing goes out without a verified gate");
	}
	// With the gate verified on, the one request goes out.
	const sent: unknown[] = [];
	const runner = vmRunner({
		WAWebSyncGatingUtils: { isHistorySyncOnDemandEnabled: () => true },
		WAWebSendNonMessageDataRequest: {
			sendPeerDataOperationRequest: async (...args: unknown[]) => {
				sent.push(args);
			},
		},
		"WAWebProtobufsE2E.pb": {
			Message$PeerDataOperationRequestType: { HISTORY_SYNC_ON_DEMAND: 3 },
		},
	});
	assert.equal(
		asObject(await sendHistorySyncOnDemand(runner, "peer-one@lid")).sent,
		true,
	);
	assert.equal(sent.length, 1);
});

test("pageshim probe: signed in only when the app knows its own user, and it never navigates", async () => {
	const pageAt = (origin: string, modules: Record<string, unknown> | null) => {
		const calls: string[] = [];
		return {
			calls,
			evaluate: async (script: unknown) => {
				calls.push("evaluate");
				const sandbox = {
					location: { origin },
					window:
						modules === null
							? {}
							: {
									require: (name: string) => {
										if (!(name in modules))
											throw new Error(`no module ${name}`);
										return modules[name];
									},
								},
				};
				return await vm.runInNewContext(String(script), sandbox);
			},
			goto: async () => {
				calls.push("goto");
			},
		};
	};
	const me = (pn: unknown, lid: unknown) => ({
		WAWebUserPrefsMeUser: {
			getMaybeMePnUser: () => pn,
			getMaybeMeLidUser: () => lid,
		},
	});
	const signedIn = pageAt(
		"https://web.whatsapp.com",
		me({ _serialized: "owner@c.us" }, null),
	);
	assert.equal(await probeWhatsAppSessionOnPage(signedIn as never, 0), true);
	const lidOnly = pageAt(
		"https://web.whatsapp.com",
		me(null, { _serialized: "owner@lid" }),
	);
	assert.equal(await probeWhatsAppSessionOnPage(lidOnly as never, 0), true);
	for (const page of [
		pageAt("https://web.whatsapp.com", me(null, null)),
		pageAt("https://web.whatsapp.com", null),
		pageAt("https://web.whatsapp.com", {}),
		pageAt("https://example.invalid", me({ _serialized: "owner@c.us" }, null)),
	]) {
		assert.equal(await probeWhatsAppSessionOnPage(page as never, 0), false);
		assert.equal(
			page.calls.includes("goto"),
			false,
			"the probe never navigates",
		);
	}
});

test("every page script is one expression, as the PageShim host wraps it in await (...)", async () => {
	const scripts: string[] = [STORES_SCRIPT, SIGNED_IN_SCRIPT];
	const capture: ScriptRunner = {
		evaluate: async (script: string) => {
			scripts.push(script);
			return null;
		},
	};
	await listChats(capture);
	await readChatMessages(capture, "peer-one@lid");
	await listContacts(capture, ["peer-one@lid"]);
	await listGroups(capture);
	await sendHistorySyncOnDemand(capture, "peer-one@lid");
	assert.equal(scripts.length, 7);
	for (const script of scripts) {
		assert.doesNotThrow(
			() =>
				new Function(
					`return (async () => { const value = await (${script}); return value; })`,
				),
			script.slice(0, 80),
		);
	}
});

test("review 1 #2: a chat longer than one chunk is walked to its store's own end, chunk after chunk, from the store's own keys", async () => {
	const total = MESSAGE_PAGE_SIZE * 40 * 2 + 7;
	const stub = stubChat({ chatId: "peer-one@lid", total, inMemory: 1 });
	const runner = vmRunner(stub.modules);
	const ids = new Set<string>();
	let token: string | null = null;
	let chunks = 0;
	let last = null as ReturnType<typeof parseChatWalk>;
	do {
		last = parseChatWalk(await readChatMessages(runner, "peer-one@lid", token));
		assert.ok(last !== null);
		for (const row of [...last.memory, ...last.messages]) ids.add(row.id);
		token = last.more ? last.token : null;
		chunks += 1;
	} while (token !== null && chunks < 10);
	assert.equal(chunks, 3, "two full chunks, then the store's own short page");
	assert.equal(last?.complete, true);
	assert.equal(last?.stop, "short_page");
	assert.equal(ids.size, total, "every locally stored message was read");
	// msgFindBefore refuses anything but the store's own key objects, so a
	// resumed chunk anchored on a rebuilt key would have thrown above.
	assert.ok(stub.anchors.length >= 80);
});

test("since: the in-page walk stops after a full page wholly older than the window's start", async () => {
	const total = MESSAGE_PAGE_SIZE * 3;
	const stub = stubChat({ chatId: "peer-one@lid", total, inMemory: 1 });
	// The window starts at message 2P: the first page back (2P-1 .. 3P-2)
	// straddles it, the second (P-1 .. 2P-2) is wholly older.
	const sinceMs = (1_700_000_000 + MESSAGE_PAGE_SIZE * 2) * 1000;
	const walk = parseChatWalk(
		await readChatMessages(
			vmRunner(stub.modules),
			"peer-one@lid",
			null,
			sinceMs,
		),
	);
	assert.ok(walk !== null);
	assert.equal(walk.complete, true);
	assert.equal(walk.stop, "before_since");
	assert.equal(stub.calls(), 2, "no page older than the wholly-old one");
	const ids = new Set([...walk.memory, ...walk.messages].map((m) => m.id));
	for (const m of stub.all.slice(MESSAGE_PAGE_SIZE * 2)) {
		assert.ok(ids.has(m.id.toString()), "every message inside the window");
	}
	// Without a window the same store is read to its own short page.
	const full = stubChat({ chatId: "peer-one@lid", total, inMemory: 1 });
	const all = parseChatWalk(
		await readChatMessages(vmRunner(full.modules), "peer-one@lid"),
	);
	assert.equal(all?.stop, "short_page");
	assert.equal(full.calls(), 3);
});

test("manifest: no stream claims incremental reads, messages are mutable, groups have no consent time", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { streams: Array<Record<string, unknown>> };
	const byName = new Map(manifest.streams.map((s) => [s.name, s]));
	for (const s of manifest.streams)
		assert.equal(s.incremental, false, String(s.name));
	assert.equal(byName.get("messages")?.semantics, "mutable_state");
	assert.equal(byName.get("groups")?.consent_time_field, undefined);
});

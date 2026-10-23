// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Review round 1 findings, one test each, over a synthetic page that answers
 * the connector's store scripts with the live shapes (all values invented).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import type {
	DetailGapStartEntry,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	makeRecordingEmit,
	type RecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { collect, probeSession } from "./index.ts";
import { SCHEMAS } from "./schemas.ts";
import { validateRecord } from "./schemas.ts";

const asObject = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: {};

const READY = {
	require_function: true,
	chats: true,
	contacts: true,
	groups: true,
	find_messages: true,
	send_request: true,
};

const TIMINGS = {
	settleAttempts: 1,
	settleMs: 0,
	historyAttempts: 1,
	historyMs: 0,
};

const STATE_0 = "COMPLETE_BUT_MORE_MESSAGES_REMAIN_ON_PRIMARY";
const STATE_1 = "COMPLETE_AND_NO_MORE_MESSAGE_REMAIN_ON_PRIMARY";

const PEER = "15550000001@c.us";
const OTHER = "15550000003@c.us";
const MEMBER = "15550000002@c.us";
const GROUP = "120363000000000001@g.us";

function chatRow(
	id: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id,
		server: id.split("@")[1],
		title: "Synthetic chat",
		t: 1792608300,
		archive: false,
		pin: null,
		mute_expiration: 0,
		unread_count: 0,
		read_only: false,
		history_state: STATE_1,
		msgs_in_memory: 1,
		...extra,
	};
}

function messageRow(
	chatId: string,
	n: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: `false_${chatId}_SYNTH${String(n)}`,
		from_me: false,
		remote: chatId,
		author: null,
		type: "chat",
		subtype: null,
		body: `Synthetic body ${String(n)}`,
		caption: null,
		t: 1792608000 + n,
		quoted_id: null,
		quoted_participant: null,
		mimetype: null,
		size: null,
		filename: null,
		duration: null,
		is_forwarded: false,
		star: false,
		ack: 0,
		is_view_once: false,
		call_duration: null,
		call_outcome: null,
		is_video_call: false,
		poll_name: null,
		lat: null,
		lng: null,
		loc: null,
		vcard_name: null,
		title: null,
		description: null,
		url: null,
		...extra,
	};
}

/** A one-chunk walk that ends on the store's own short page. */
const completeWalk = (
	chatId: string,
	rows: unknown[] = [messageRow(chatId, 1)],
) => ({
	chat_id: chatId,
	status: 200,
	memory: rows,
	messages: [],
	complete: true,
	anchored: true,
	stop: "short_page",
	me_id: "15550000000@c.us",
});

interface World {
	sync?: () => unknown;
	chats: (call: number) => unknown;
	walk?: (chatId: string, token: string | null) => unknown;
	send?: (chatId: string) => unknown;
	contacts?: (ids: string[]) => unknown;
	groups?: (call: number) => unknown;
}

interface Calls {
	scripts: string[];
	walks: Array<{ chatId: string; token: string | null }>;
	sends: string[];
	contactIds: string[][];
}

function fakePage(world: World): { page: unknown; calls: Calls } {
	const calls: Calls = { scripts: [], walks: [], sends: [], contactIds: [] };
	let chatReads = 0;
	let groupReads = 0;
	const page = {
		evaluate: async (script: unknown): Promise<unknown> => {
			const s = String(script);
			calls.scripts.push(s);
			if (s.includes("typeof window.require")) return READY;
			if (s.includes("WAWebStreamModel"))
				return world.sync
					? world.sync()
					: { mode: "MAIN", resume_complete: true };
			if (s.includes("sendPeerDataOperationRequest")) {
				const id = /chatId: "(.+?)"/u.exec(s)?.[1] ?? "";
				calls.sends.push(id);
				return world.send ? world.send(id) : { sent: true };
			}
			if (s.includes("getModelsArray().map((c) =>"))
				return world.chats(chatReads++);
			if (s.includes("msgFindBefore")) {
				const id = /const chatId = "(.+?)";/u.exec(s)?.[1] ?? "";
				const tokenMatch = /const resumeToken = (null|"(.*?)");/u.exec(s);
				const token = tokenMatch?.[2] ?? null;
				calls.walks.push({ chatId: id, token });
				return world.walk ? world.walk(id, token) : completeWalk(id);
			}
			if (s.includes("__pdppWhatsAppWebWalks")) return true;
			if (s.includes("Contact.getModelsArray().filter")) {
				const ids = JSON.parse(
					/new Set\((\[.*?\])\)/u.exec(s)?.[1] ?? "[]",
				) as string[];
				calls.contactIds.push(ids);
				return world.contacts
					? world.contacts(ids)
					: ids.map((id) => ({
							id,
							name: "Synthetic name",
							short_name: null,
							push_name: null,
							is_business: false,
							verified_name: null,
						}));
			}
			if (s.includes("WAWebGroupMetadataCollection.getModelsArray().map"))
				return world.groups ? world.groups(groupReads++) : [];
			throw new Error(`fake page: unexpected script ${s.slice(0, 60)}`);
		},
	};
	return { page, calls };
}

interface Run {
	harness: RecordingEmit;
	calls: Calls;
	failures: Array<{ stream: string; message: string; retryable: boolean }>;
}

async function run(
	world: World,
	options: {
		streams?: string[];
		detailGaps?: DetailGapStartEntry[];
		recoveryOnly?: boolean;
		gapPages?: DetailGapStartEntry[][];
	} = {},
): Promise<Run> {
	const harness = makeRecordingEmit(validateRecord);
	const { page, calls } = fakePage(world);
	const failures: Run["failures"] = [];
	const streams = options.streams ?? [
		"chats",
		"messages",
		"contacts",
		"groups",
	];
	await collect(
		{
			requested: new Map<string, StreamScope>(
				streams.map((name) => [name, { name }]),
			),
			page: page as Parameters<typeof collect>[0]["page"],
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			detailGaps: options.detailGaps ?? [],
			recoveryOnly: options.recoveryOnly === true,
			reportStreamFailure: async (stream, message, opts = {}) => {
				failures.push({ stream, message, retryable: opts.retryable === true });
			},
			...(options.gapPages
				? {
						requestDetailGapPage: async () => options.gapPages?.shift() ?? [],
					}
				: {}),
		} as Parameters<typeof collect>[0],
		TIMINGS,
	);
	return { harness, calls, failures };
}

const recordsOf = (r: Run, stream: string) =>
	r.harness.emitted.filter((e) => e.stream === stream);
const messagesOf = (r: Run, type: string) =>
	r.harness.protocolMessages.map(asObject).filter((m) => m.type === type);
const stateOf = (r: Run, stream: string) =>
	messagesOf(r, "STATE").find((m) => m.stream === stream);

// ─── #1 requested scope ──────────────────────────────────────────────────

test("review 1 #1: a contacts-only run emits only contacts and sends no history request", async () => {
	const r = await run(
		{
			chats: () => [chatRow(PEER, { history_state: STATE_0 })],
			groups: () => [],
		},
		{ streams: ["contacts"] },
	);
	assert.equal(recordsOf(r, "chats").length, 0);
	assert.equal(recordsOf(r, "messages").length, 0);
	assert.equal(recordsOf(r, "groups").length, 0);
	assert.deepEqual(r.calls.sends, [], "no outbound history request");
	assert.deepEqual(r.calls.walks, [], "no message is read");
	assert.deepEqual(
		recordsOf(r, "contacts").map((c) => c.data.id),
		[PEER],
	);
	assert.ok(stateOf(r, "contacts"));
	assert.equal(stateOf(r, "chats"), undefined);
	assert.equal(stateOf(r, "groups"), undefined);
	assert.equal(messagesOf(r, "DETAIL_COVERAGE").length, 0);
});

test("review 1 #1: messages without chats is refused, not collected", async () => {
	const r = await run(
		{ chats: () => [chatRow(PEER)] },
		{ streams: ["messages"] },
	);
	assert.equal(r.harness.emitted.length, 0);
	assert.deepEqual(r.calls.walks, []);
	const skip = messagesOf(r, "SKIP_RESULT");
	assert.equal(skip.length, 1);
	assert.equal(skip[0]?.reason, "scope_not_supported");
});

// ─── #3 pending gaps ─────────────────────────────────────────────────────

const pendingGap = (chatId: string): DetailGapStartEntry =>
	({
		gap_id: `gap-${chatId}`,
		lease_id: `lease-${chatId}`,
		stream: "messages",
		record_key: chatId,
	}) as unknown as DetailGapStartEntry;

test("review 1 #3: a chat with a pending gap that now reads completely acknowledges the gap", async () => {
	const r = await run(
		{ chats: () => [chatRow(PEER), chatRow(OTHER)] },
		{ detailGaps: [pendingGap(PEER)] },
	);
	const recovered = messagesOf(r, "DETAIL_GAP_RECOVERED");
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.gap_id, `gap-${PEER}`);
	assert.equal(recovered[0]?.lease_id, `lease-${PEER}`);
	assert.equal(recovered[0]?.record_key, PEER);
});

test("review 1 #3: a recovery-only run re-reads only the pending chats and checkpoints nothing", async () => {
	const r = await run(
		{
			chats: () => [chatRow(PEER), chatRow(OTHER), chatRow(GROUP)],
			groups: () => [],
		},
		{ detailGaps: [pendingGap(PEER)], recoveryOnly: true },
	);
	assert.deepEqual(
		r.calls.walks.map((w) => w.chatId),
		[PEER],
	);
	assert.equal(recordsOf(r, "groups").length, 0);
	assert.equal(recordsOf(r, "contacts").length, 0);
	assert.equal(messagesOf(r, "STATE").length, 0);
	assert.equal(messagesOf(r, "DETAIL_GAP_RECOVERED").length, 1);
});

// ─── #4 unsafe text ──────────────────────────────────────────────────────

test("review 1 #4: a message whose text cannot be stored is withheld and its chat gaps", async () => {
	const r = await run({
		chats: () => [chatRow(PEER)],
		walk: (id) =>
			completeWalk(id, [
				messageRow(id, 1),
				messageRow(id, 2, { body: "bad\u0000text" }),
			]),
	});
	const messages = recordsOf(r, "messages");
	assert.equal(messages.length, 1, "only the safe message is emitted");
	assert.ok(messages.every((m) => m.data.text !== null));
	const gaps = messagesOf(r, "DETAIL_GAP");
	assert.equal(gaps.length, 1);
	assert.equal(asObject(gaps[0]?.last_error).class, "unsafe_text");
	const coverage = messagesOf(r, "DETAIL_COVERAGE")[0];
	assert.deepEqual(coverage?.hydrated_keys ?? [], []);
});

test("review 1 #4: a chat title that cannot be stored fails chats without STATE", async () => {
	const r = await run({
		chats: () => [chatRow(PEER, { title: "bad\u0000title" }), chatRow(OTHER)],
	});
	assert.deepEqual(
		recordsOf(r, "chats").map((c) => c.data.id),
		[OTHER],
	);
	assert.equal(stateOf(r, "chats"), undefined);
	assert.ok(r.failures.some((f) => f.stream === "chats"));
});

// ─── #5 missing history-state row ────────────────────────────────────────

test("review 1 #5: a chat that drops out of the poll after its history request still gaps", async () => {
	const r = await run({
		// The two settle reads hold the chat; the history poll does not.
		chats: (call) =>
			call < 2 ? [chatRow(PEER, { history_state: STATE_0 })] : [],
		send: () => ({ sent: true }),
	});
	assert.deepEqual(r.calls.sends, [PEER]);
	const coverage = messagesOf(r, "DETAIL_COVERAGE")[0];
	assert.deepEqual(coverage?.hydrated_keys ?? [], []);
	assert.deepEqual(coverage?.gap_keys, [PEER]);
});

// ─── #6 missing contacts ─────────────────────────────────────────────────

test("review 1 #6: an id the contact collection does not hold still gets its record before the STATE", async () => {
	const r = await run({
		chats: () => [chatRow(PEER), chatRow(OTHER)],
		contacts: (ids) =>
			ids
				.filter((id) => id === PEER)
				.map((id) => ({
					id,
					name: "Synthetic name",
					short_name: null,
					push_name: null,
					is_business: false,
					verified_name: null,
				})),
	});
	const ids = recordsOf(r, "contacts").map((c) => c.data.id);
	assert.deepEqual(new Set(ids), new Set([PEER, OTHER]));
	const other = recordsOf(r, "contacts").find((c) => c.data.id === OTHER);
	assert.equal(other?.data.name, null);
	assert.deepEqual(
		new Set(asObject(stateOf(r, "contacts")?.cursor).ids as string[]),
		new Set([PEER, OTHER]),
	);
});

// ─── #7 inventory end ────────────────────────────────────────────────────

test("review 1 #7: a client that has not caught up is not an inventory end", async () => {
	await assert.rejects(
		() =>
			run({
				sync: () => ({ mode: "SYNCING", resume_complete: false }),
				chats: () => [chatRow(PEER)],
			}),
		(error: unknown) =>
			asObject(error).code === "whatsapp_web_chat_list_never_settled",
	);
});

test("review 1 #7: duplicate ids never pass as the same inventory", async () => {
	const r = await run({ chats: () => [chatRow(PEER), chatRow(PEER)] });
	assert.deepEqual(
		recordsOf(r, "chats").map((c) => c.data.id),
		[PEER],
		"each chat once",
	);
	// [A, A] after [A, B] is not the same id set: within the budget the
	// inventory is not proven, so nothing is checkpointed.
	await assert.rejects(
		() =>
			run({
				chats: (call) =>
					call === 0
						? [chatRow(PEER), chatRow(OTHER)]
						: [chatRow(PEER), chatRow(PEER)],
			}),
		(error: unknown) =>
			asObject(error).code === "whatsapp_web_chat_list_never_settled",
	);
});

test("review 1 #7: a signed-out client (QR mode) is an authentication failure", async () => {
	await assert.rejects(
		() =>
			run({
				sync: () => ({ mode: "QR", resume_complete: null }),
				chats: () => [],
			}),
		(error: unknown) => asObject(error).code === "whatsapp_web_auth_failed",
	);
});

// ─── #8 group inventory ──────────────────────────────────────────────────

test("review 1 #8: a group chat with no metadata yet fails groups (and contacts) without STATE", async () => {
	const r = await run({
		chats: () => [chatRow(PEER), chatRow(GROUP)],
		groups: () => [],
	});
	assert.equal(stateOf(r, "groups"), undefined);
	assert.equal(stateOf(r, "contacts"), undefined);
	assert.ok(r.failures.some((f) => f.stream === "groups" && f.retryable));
	assert.ok(r.failures.some((f) => f.stream === "contacts"));
});

test("review 1 #8: metadata that arrives within the budget proves the group inventory", async () => {
	const group = {
		id: GROUP,
		subject: "Synthetic group",
		creation: 1792000000,
		owner: MEMBER,
		announce: false,
		restrict: false,
		participants: [{ id: MEMBER, is_admin: true, is_super_admin: true }],
	};
	const r = await run({
		chats: () => [chatRow(PEER), chatRow(GROUP)],
		groups: (call) => (call === 0 ? [] : [group]),
	});
	assert.deepEqual(
		recordsOf(r, "groups").map((g) => g.data.id),
		[GROUP],
	);
	assert.ok(stateOf(r, "groups"));
	assert.deepEqual(r.failures, []);
});

// ─── #9 run-level statuses ───────────────────────────────────────────────

const statusWalk = (status: number) => (id: string) => ({
	...completeWalk(id),
	status,
	complete: false,
	stop: "status",
});

test("review 1 #9: a 401 from the local store is an authentication failure, not a gap", async () => {
	await assert.rejects(
		() => run({ chats: () => [chatRow(PEER)], walk: statusWalk(401) }),
		(error: unknown) => asObject(error).code === "whatsapp_web_auth_failed",
	);
});

test("review 1 #9: a 500 or 429 stops the run for a retry instead of gapping every chat", async () => {
	for (const status of [500, 429]) {
		await assert.rejects(
			() => run({ chats: () => [chatRow(PEER)], walk: statusWalk(status) }),
			(error: unknown) =>
				asObject(error).code === "whatsapp_web_local_store_unavailable" &&
				asObject(error).retryable === true,
		);
	}
});

test("review 1 #9: a 404 for one chat stays that chat's gap", async () => {
	const r = await run({
		chats: () => [chatRow(PEER), chatRow(OTHER)],
		walk: (id) => (id === PEER ? statusWalk(404)(id) : completeWalk(id)),
	});
	const coverage = messagesOf(r, "DETAIL_COVERAGE")[0];
	assert.deepEqual(coverage?.gap_keys, [PEER]);
	assert.deepEqual(coverage?.hydrated_keys, [OTHER]);
});

// ─── #10 manifest and zod agree ──────────────────────────────────────────

test("review 1 #10: each stream's manifest required list is exactly zod's required keys", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		streams: Array<{
			name: string;
			schema: { required: string[]; properties: Record<string, unknown> };
		}>;
	};
	for (const stream of manifest.streams) {
		const zod = SCHEMAS[stream.name] as unknown as {
			shape: Record<string, { isOptional(): boolean }>;
		};
		const zodRequired = Object.entries(zod.shape)
			.filter(([, field]) => !field.isOptional())
			.map(([key]) => key)
			.sort();
		assert.deepEqual(
			[...stream.schema.required].sort(),
			zodRequired,
			stream.name,
		);
		assert.deepEqual(
			Object.keys(stream.schema.properties).sort(),
			Object.keys(zod.shape).sort(),
			stream.name,
		);
	}
});

// ─── #11 desktop probe ───────────────────────────────────────────────────

function probePage(url: string, signedIn: boolean) {
	const origin = new URL(url).origin;
	const sandbox = vm.createContext({
		location: { origin },
		window: {
			require: (name: string) => {
				if (name !== "WAWebUserPrefsMeUser")
					throw new Error(`no module ${name}`);
				return {
					getMaybeMePnUser: () =>
						signedIn ? { _serialized: "15550000000@c.us" } : null,
					getMaybeMeLidUser: () => null,
				};
			},
		},
	});
	return {
		url: () => url,
		evaluate: async (script: unknown) =>
			await vm.runInContext(String(script), sandbox),
	};
}

test("review 1 #11: the desktop probe refuses look-alike hosts and the QR page", async () => {
	const probe = (url: string, signedIn: boolean) =>
		probeSession({ page: probePage(url, signedIn) } as unknown as Parameters<
			typeof probeSession
		>[0]);
	assert.equal(await probe("https://web.whatsapp.com/", true), true);
	assert.equal(
		await probe("https://web.whatsapp.com.evil.example/", true),
		false,
	);
	assert.equal(await probe("https://web.whatsapp.com/", false), false);
});

// ─── review round 2 ──────────────────────────────────────────────────────

test("review 2 #1: a walk is not capped per run: it goes on chunk after chunk until the store's own end", async () => {
	const CHUNKS = 600;
	const r = await run({
		chats: () => [chatRow(PEER)],
		walk: (id, token) => {
			const n = token === null ? 0 : Number(token);
			if (n + 1 < CHUNKS)
				return {
					...completeWalk(id, [messageRow(id, n + 1)]),
					complete: false,
					stop: "chunk",
					more: true,
					token: String(n + 1),
				};
			return completeWalk(id, [messageRow(id, n + 1)]);
		},
	});
	assert.equal(recordsOf(r, "messages").length, CHUNKS);
	assert.equal(messagesOf(r, "DETAIL_GAP").length, 0);
	assert.deepEqual(messagesOf(r, "DETAIL_COVERAGE")[0]?.hydrated_keys, [PEER]);
});

test("review 2 #2: a pending chat missing from the inventory keeps its gap, and later gap pages are drained", async () => {
	const GONE = "15550000009@c.us";
	const r = await run(
		{ chats: () => [chatRow(PEER), chatRow(OTHER)] },
		{
			detailGaps: [pendingGap(GONE)],
			// The runtime's next page holds a gap the START page did not.
			gapPages: [[pendingGap(GONE), pendingGap(PEER)]],
		},
	);
	const regap = messagesOf(r, "DETAIL_GAP").filter(
		(g) => g.record_key === GONE,
	);
	assert.equal(regap.length, 1, "the absent chat's gap is re-emitted once");
	assert.equal(asObject(regap[0]?.last_error).class, "chat_not_in_inventory");
	const recovered = messagesOf(r, "DETAIL_GAP_RECOVERED");
	assert.deepEqual(
		recovered.map((g) => g.gap_id),
		[`gap-${PEER}`],
		"the second page's gap of a chat read completely is acknowledged",
	);
	// The re-emitted gap comes before the coverage report.
	const types = r.harness.protocolMessages.map((m) => asObject(m).type);
	assert.ok(types.lastIndexOf("DETAIL_GAP") < types.indexOf("DETAIL_COVERAGE"));
});

test("review 2 #2: a recovery-only run walks pending chats from every gap page", async () => {
	const r = await run(
		{ chats: () => [chatRow(PEER), chatRow(OTHER)] },
		{
			detailGaps: [pendingGap(PEER)],
			recoveryOnly: true,
			gapPages: [[pendingGap(OTHER)]],
		},
	);
	assert.deepEqual(
		r.calls.walks.map((w) => w.chatId),
		[PEER, OTHER],
	);
	assert.equal(messagesOf(r, "DETAIL_GAP_RECOVERED").length, 2);
	assert.equal(messagesOf(r, "STATE").length, 0);
});

test("review 2 #3: a poll row without a history state keeps the chat's last known state and gaps it", async () => {
	const r = await run({
		chats: (call) =>
			call < 2
				? [chatRow(PEER, { history_state: STATE_0 })]
				: [chatRow(PEER, { history_state: null })],
		send: () => ({ sent: true }),
	});
	assert.deepEqual(r.calls.sends, [PEER]);
	const coverage = messagesOf(r, "DETAIL_COVERAGE")[0];
	assert.deepEqual(coverage?.hydrated_keys ?? [], []);
	assert.deepEqual(coverage?.gap_keys, [PEER]);
});

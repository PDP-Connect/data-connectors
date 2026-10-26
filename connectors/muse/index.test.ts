// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Collection tests against a fake gateway that answers from __fixtures__
// (copies of the factory's live-shape fixtures). The fake stands in for the
// page's own gateway client; the page scripts themselves are exercised in a
// node:vm sandbox with a synthetic React fiber tree.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	consentTimeFieldResolver,
	makeEmitRecord,
	withholdsBoundedProgress,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	ACTIVITY_LIMIT,
	assertReadOnlyCall,
	collectMuseWith,
	gatewayCallScript,
	LIBRARY_LIMIT,
	LOCATE_GATEWAY_SCRIPT,
	type MuseCtx,
	type MuseGateway,
	MuseRpcError,
	museReadiness,
	pageGateway,
	READ_METHODS,
} from "./index.ts";
import { buildFileRecord, MEMORY_FILE_NAMES } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

process.env.PDPP_CONNECTOR_DIAGNOSTICS = "0";

type Json = Record<string, unknown>;

function fixture(name: string): Json {
	return JSON.parse(
		readFileSync(
			new URL(`./__fixtures__/${name}.json`, import.meta.url),
			"utf8",
		),
	) as Json;
}

const ALL_STREAMS = [
	"conversations",
	"messages",
	"activities",
	"goals",
	"scheduled_tasks",
	"memory_files",
	"files",
	"connected_apps",
];

const SESSIONS = fixture("sessions");
const SESSION_IDS = (SESSIONS.sessions as Json[]).map((s) =>
	String(s.session_id),
);
const [MAIN_CHAT = "", SIDE_CHAT = ""] = SESSION_IDS;

/** The history fixture for one chat, with ids made unique to that chat. */
function historyFor(sessionId: string, hasMore = false): Json {
	const h = fixture("history");
	for (const e of h.chat_events as Json[]) {
		e.message_id = `${sessionId}:${String(e.message_id)}`;
	}
	h.has_more = hasMore;
	return h;
}

/** The fs.list root fixture plus two memory files and one file never to be read. */
function rootWithMemoryFiles(): Json {
	const root = fixture("files-root");
	const entries = root.entries as Json[];
	const base = entries[0] ?? {};
	entries.push(
		{ ...base, name: "MEMORY.md", type: "file", size: 20 },
		{ ...base, name: "USER.md", type: "file", size: 12 },
		{ ...base, name: "config", type: "file", size: 5 },
	);
	return root;
}

type Handler = (params: Json) => unknown;

interface Call {
	method: string;
	params: Json;
}

function fakeGateway(overrides: Record<string, Handler> = {}) {
	const calls: Call[] = [];
	const handlers: Record<string, Handler> = {
		"sessions.list": (p) =>
			p.view === "archived" ? fixture("sessions-archived") : SESSIONS,
		"chat.history": (p) => historyFor(String(p.session_id)),
		"sessions.get": (p) => {
			const session = (SESSIONS.sessions as Json[]).find(
				(s) => s.session_id === p.id,
			);
			if (!session)
				throw new MuseRpcError(
					"not_found",
					"muse_rpc_failed: sessions.get not_found",
				);
			return { session };
		},
		"activity.list": (p) =>
			p.before == null ? fixture("activity") : { days: [] },
		"goals.list": (p) =>
			p.source === "assistant_tracking"
				? fixture("goals-tracking")
				: fixture("goals"),
		"tasks.list": () => fixture("tasks"),
		"fs.list": () => rootWithMemoryFiles(),
		"fs.raw": (p) => ({ __blob_text: `# ${String(p.path)}\nremembered` }),
		"fs.library": () => {
			const lib = fixture("library-recents");
			lib.total = (lib.entries as Json[]).length;
			return lib;
		},
		"connectors.list": () => fixture("connectors"),
		...overrides,
	};
	const gateway: MuseGateway = {
		async call(method, params) {
			calls.push({ method, params });
			const handler = handlers[method];
			if (!handler) throw new Error(`unexpected ${method}`);
			return structuredClone(handler(params));
		},
	};
	return { gateway, calls };
}

interface HarnessOptions {
	streams?: string[];
	state?: Record<string, unknown>;
	detailGaps?: MuseCtx["detailGaps"];
	recoveryOnly?: boolean;
}

function harness(options: HarnessOptions = {}) {
	const emitted: EmittedMessage[] = [];
	const failures: Array<{ stream: string; message: string }> = [];
	const retryables = new Map<string, boolean | undefined>();
	const streams = options.streams ?? ALL_STREAMS;
	const requested = new Map<string, StreamScope>(
		streams.map((name) => [name, { name }]),
	);
	const ctx: MuseCtx = {
		collectionMode: "incremental",
		detailGaps: options.detailGaps ?? [],
		emit: async (message) => {
			emitted.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const result = validateRecord(stream, data);
			assert.equal(result.ok, true, `${stream} ${JSON.stringify(result)}`);
			emitted.push({
				type: "RECORD",
				stream,
				key: String(data.id),
				data,
				emitted_at: "2026-10-21T00:00:00.000Z",
			});
		},
		progress: async () => undefined,
		recoveryOnly: options.recoveryOnly ?? false,
		reportStreamFailure: async (stream, message, opts) => {
			failures.push({ stream, message });
			retryables.set(stream, opts?.retryable);
		},
		requested,
		state: options.state ?? {},
	};
	const of = (type: string, stream?: string) =>
		emitted
			.map((m, index) => ({ m: JSON.parse(JSON.stringify(m)) as Json, index }))
			.filter(({ m }) => m.type === type && (!stream || m.stream === stream));
	const records = (stream: string) =>
		of("RECORD", stream).map(({ m }) => m.data as Json);
	const states = (stream: string) =>
		of("STATE", stream).map(({ m }) => m.cursor as Json);
	const retryable = (stream: string) => retryables.get(stream);
	return { ctx, emitted, failures, of, records, retryable, states };
}

/** A chat list that never settles keeps its records but certifies nothing. */
function assertIncompleteChats(h: ReturnType<typeof harness>) {
	const streams = ["conversations", "messages"].filter((s) =>
		h.ctx.requested.has(s),
	);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		streams,
	);
	for (const failure of h.failures) {
		assert.match(failure.message, /chat inventory is incomplete/);
		// A moving list may settle on a later run.
		assert.equal(h.retryable(failure.stream), true);
	}
	assert.equal(h.states("conversations").length, 0);
	assert.equal(h.states("messages").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE", "conversations").length, 0);
}

/**
 * A bracketed chat list that held still: full conversations coverage over
 * `considered` chats, then the one conversations STATE after every chat
 * record, message and messages coverage. No chat stream fails.
 */
function assertCompleteChats(
	h: ReturnType<typeof harness>,
	considered: number,
): Json {
	assert.deepEqual(
		h.failures.filter((f) => ["conversations", "messages"].includes(f.stream)),
		[],
	);
	const inventory = h.of("DETAIL_COVERAGE", "conversations");
	assert.equal(inventory.length, 1);
	assert.equal(inventory[0]?.m.considered, considered);
	assert.equal(inventory[0]?.m.covered, considered);
	const state = h.of("STATE", "conversations");
	assert.equal(state.length, 1);
	const stateIndex = state[0]?.index ?? -1;
	const before = [
		...h.of("RECORD", "conversations"),
		...h.of("RECORD", "messages"),
		...h.of("DETAIL_COVERAGE", "messages"),
		...inventory,
	];
	assert.ok(before.every((x) => x.index < stateIndex));
	assert.equal(h.states("messages").length, 0);
	const cursor = state[0]?.m.cursor as Json;
	assert.equal(cursor.version, 3);
	return cursor.chats as Json;
}

/**
 * sessions.list for a list that never settles: every active read lists a
 * chat the previous one did not (a new chat each time), so no two
 * consecutive (active, archived) pairs agree.
 */
function movingSessions(): (p: Json) => unknown {
	const [main, side] = SESSIONS.sessions as Json[];
	let reads = 0;
	return (p) => {
		if (p.view === "archived") return { sessions: [] };
		reads += 1;
		const fresh = {
			...side,
			session_id: `33333333-3333-4333-8333-${String(reads).padStart(12, "0")}`,
		};
		return { sessions: [main, side, fresh] };
	};
}

test("a stable chat inventory completes with records, parent ordering and healthy activity/goal progress", async () => {
	const { gateway } = fakeGateway();
	const h = harness({
		streams: ["conversations", "messages", "activities", "goals"],
	});
	const progress: string[] = [];
	h.ctx.progress = async (message) => {
		progress.push(message);
	};
	await collectMuseWith(h.ctx, gateway);
	assertCompleteChats(h, SESSION_IDS.length);
	assert.deepEqual(
		h.records("conversations").map((r) => r.id),
		SESSION_IDS,
	);
	for (const id of SESSION_IDS) {
		const parent = h
			.of("RECORD", "conversations")
			.find((x) => (x.m.data as Json).id === id);
		assert.ok(parent);
		const children = h
			.of("RECORD", "messages")
			.filter((x) => (x.m.data as Json).session_id === id);
		assert.equal(children.length, 3);
		assert.ok(children.every((x) => x.index > parent.index));
		assert.deepEqual(
			new Set(children.map((x) => (x.m.data as Json).id)),
			new Set((historyFor(id).chat_events as Json[]).map((e) => e.message_id)),
		);
	}
	assert.equal(h.records("activities").length, 3);
	assert.deepEqual(
		h.records("goals").map((r) => r.id),
		["goal_516bb0ad139a"],
	);
	assert.equal(h.states("activities").length, 1);
	assert.equal(h.states("goals").length, 1);
	assert.ok(progress.includes("Reading activity"));
	assert.ok(progress.includes("Reading goals"));
});

test("empty chat views, read stably, complete and drop chats no longer listed", async () => {
	const { gateway } = fakeGateway({
		"sessions.list": () => ({ sessions: [], has_more: false }),
	});
	const state = {
		conversations: {
			version: 3,
			chats: {
				[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
			},
		},
	};
	const h = harness({ streams: ["conversations", "messages"], state });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(assertCompleteChats(h, 0), {});
	assert.equal(h.of("RECORD").length, 0);
});

test("empty chat views that keep changing never advance existing chat state", async () => {
	const { gateway } = fakeGateway({ "sessions.list": movingSessions() });
	const state = {
		conversations: {
			version: 3,
			chats: {
				[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
			},
		},
	};
	const h = harness({ streams: ["conversations"], state });
	const before = structuredClone(state);
	await collectMuseWith(h.ctx, gateway);
	assertIncompleteChats(h);
	assert.deepEqual(h.ctx.state, before);
});

test("standalone collection rejects incomplete inventory after importing healthy siblings", async () => {
	const { gateway } = fakeGateway({ "sessions.list": movingSessions() });
	const h = harness({
		streams: ["conversations", "messages", "activities", "goals"],
	});
	delete h.ctx.reportStreamFailure;
	await assert.rejects(
		collectMuseWith(h.ctx, gateway),
		/chat inventory is incomplete/,
	);
	assert.equal(h.records("conversations").length, 3);
	assert.equal(h.records("messages").length, 9);
	assert.equal(h.records("activities").length, 3);
	assert.equal(h.records("goals").length, 1);
	assert.equal(h.states("conversations").length, 0);
	assert.equal(h.states("messages").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE", "conversations").length, 0);
	assert.equal(h.states("activities").length, 1);
	assert.equal(h.states("goals").length, 1);
	assert.equal(h.ctx.reportStreamFailure, undefined);
});

test("standalone healthy non-chat collection still completes", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness({ streams: ["activities", "goals"] });
	delete h.ctx.reportStreamFailure;
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.states("activities").length, 1);
	assert.equal(h.states("goals").length, 1);
	assert.ok(
		calls.every(
			(c) => c.method === "activity.list" || c.method === "goals.list",
		),
	);
});

test("standalone failed recovery rejects instead of silently clearing a gap", async () => {
	const { gateway } = fakeGateway({
		"sessions.get": () => {
			throw new MuseRpcError("not_found", "missing parent");
		},
	});
	const h = recoveryFor(SIDE_CHAT);
	delete h.ctx.reportStreamFailure;
	await assert.rejects(
		collectMuseWith(h.ctx, gateway),
		/could not be found or read/,
	);
	assert.equal(h.of("DETAIL_GAP_RECOVERED").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE").length, 0);
	assert.equal(h.of("STATE").length, 0);
});

test("a full run reads every stream through read methods only and follows the protocol", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness();
	await collectMuseWith(h.ctx, gateway);

	const marks = assertCompleteChats(h, SESSION_IDS.length);
	for (const c of calls) {
		assert.ok(READ_METHODS.has(c.method), c.method);
		if (c.method === "fs.raw")
			assert.ok(
				(MEMORY_FILE_NAMES as readonly string[]).includes(
					String(c.params.path),
				),
			);
	}
	assert.deepEqual(
		calls.filter((c) => c.method === "fs.raw").map((c) => c.params.path),
		["MEMORY.md", "USER.md"],
	);

	assert.deepEqual(
		h.records("conversations").map((r) => r.id),
		SESSION_IDS,
	);
	assert.equal(h.records("messages").length, 6);
	assert.equal(h.records("activities").length, 3);
	assert.deepEqual(
		h.records("goals").map((r) => r.id),
		["goal_516bb0ad139a"],
	);
	assert.equal(h.records("scheduled_tasks").length, 3);
	assert.deepEqual(
		h.records("memory_files").map((r) => [r.id, r.text]),
		[
			["MEMORY.md", "# MEMORY.md\nremembered"],
			["USER.md", "# USER.md\nremembered"],
		],
	);
	assert.equal(h.records("files").length, 3);
	assert.deepEqual(
		h.records("connected_apps").map((r) => r.id),
		["browser"],
	);

	// Parent records come before any child record.
	const lastConversation = Math.max(
		...h.of("RECORD", "conversations").map((x) => x.index),
	);
	const firstMessage = Math.min(
		...h.of("RECORD", "messages").map((x) => x.index),
	);
	assert.ok(lastConversation < firstMessage);

	// Exactly one coverage for messages, after its records, every chat hydrated.
	const coverage = h.of("DETAIL_COVERAGE", "messages");
	assert.equal(coverage.length, 1);
	const cov = coverage[0];
	assert.ok(cov);
	assert.equal(cov.m.state_stream, "conversations");
	assert.deepEqual(cov.m.required_keys, [SIDE_CHAT, MAIN_CHAT]);
	assert.deepEqual(cov.m.hydrated_keys, [SIDE_CHAT, MAIN_CHAT]);
	assert.deepEqual(cov.m.gap_keys ?? [], []);
	const lastMessage = Math.max(
		...h.of("RECORD", "messages").map((x) => x.index),
	);
	assert.ok(cov.index > lastMessage);

	// Healthy sibling streams still checkpoint after their records.
	for (const stream of ALL_STREAMS.filter(
		(s) => s !== "messages" && s !== "conversations",
	)) {
		const state = h.of("STATE", stream);
		assert.equal(state.length, 1, stream);
		const lastRecord = Math.max(
			-1,
			...h.of("RECORD", stream).map((x) => x.index),
		);
		assert.ok((state[0]?.index ?? -1) > lastRecord, stream);
	}
	// Every chat read completely gets a mark for the next run.
	assert.deepEqual(Object.keys(marks).sort(), [...SESSION_IDS].sort());
	assert.deepEqual(h.states("activities")[0], {
		version: 2,
		newest_timestamp: "2026-01-15T10:14:38.000Z",
	});
	// No secret-looking key in any cursor.
	for (const m of h.of("STATE")) {
		assert.doesNotMatch(
			JSON.stringify(m.m.cursor),
			/token|cookie|session_?id/i,
		);
	}
});

/** A chat of `count` events (seq 1..count) served newest first, paged by before_seq like the app. */
function pagedHistory(count: number) {
	const template = (fixture("history").chat_events as Json[])[0] ?? {};
	const all = Array.from({ length: count }, (_, i) => ({
		...template,
		message_id: `m-${i + 1}`,
		seq: i + 1,
		occurred_at_ms: 1792608185077 + i * 1000,
	}));
	return (p: Json) => {
		const before = typeof p.before_seq === "number" ? p.before_seq : Infinity;
		const older = all.filter((e) => e.seq < before);
		const page = older.slice(-Number(p.limit));
		return {
			channel: "all",
			chat_events: page,
			has_more: older.length > page.length,
			transcript_revision: 31,
		};
	};
}

test("chat.history pages back with before_seq until has_more is false", async () => {
	const params: Json[] = [];
	const side = pagedHistory(120);
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			params.push(p);
			return p.session_id === SIDE_CHAT
				? side(p)
				: historyFor(String(p.session_id));
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		params.filter((p) => p.session_id === SIDE_CHAT),
		[
			{ limit: 50, session_id: SIDE_CHAT },
			{ limit: 50, session_id: SIDE_CHAT, before_seq: 71 },
			{ limit: 50, session_id: SIDE_CHAT, before_seq: 21 },
		],
	);
	assert.equal(
		h.records("messages").filter((r) => r.session_id === SIDE_CHAT).length,
		120,
	);
	const cov = h.of("DETAIL_COVERAGE", "messages")[0]?.m;
	assert.deepEqual(cov?.hydrated_keys, [SIDE_CHAT, MAIN_CHAT]);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assertCompleteChats(h, SESSION_IDS.length);
});

test("a chat.history page that repeats is a DETAIL_GAP, not a complete chat", async () => {
	const { gateway, calls } = fakeGateway({
		"chat.history": (p) =>
			historyFor(String(p.session_id), p.session_id === SIDE_CHAT),
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);

	// The second page added nothing new: the walk stops after two calls.
	assert.equal(
		calls.filter((c) => c.params.session_id === SIDE_CHAT).length,
		2,
	);
	// What was read is still emitted.
	assert.equal(h.records("messages").length, 6);
	const gaps = h.of("DETAIL_GAP", "messages");
	assert.equal(gaps.length, 1);
	const gap = gaps[0]?.m;
	assert.ok(gap);
	assert.equal(gap.record_key, SIDE_CHAT);
	assert.equal(gap.parent_stream, "conversations");
	assert.deepEqual(gap.detail_locator, {
		kind: "muse.chat_history",
		chat_id: SIDE_CHAT,
	});
	const cov = h.of("DETAIL_COVERAGE", "messages")[0];
	assert.ok(cov && cov.index > (gaps[0]?.index ?? Infinity));
	assert.deepEqual(cov.m.gap_keys, [SIDE_CHAT]);
	assert.deepEqual(cov.m.hydrated_keys, [MAIN_CHAT]);
	// The gapped chat gets no mark, so the next run reads it again.
	assert.deepEqual(Object.keys(assertCompleteChats(h, SESSION_IDS.length)), [
		MAIN_CHAT,
	]);
});

test("a chat.history cursor that does not move back is a DETAIL_GAP", async () => {
	let n = 0;
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			if (p.session_id !== SIDE_CHAT) return historyFor(String(p.session_id));
			n += 1;
			// New ids every page, but the same seqs: the cursor never moves.
			const h = historyFor(`${SIDE_CHAT}-${n}`, true);
			return h;
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.equal(n, 2);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
		SIDE_CHAT,
	]);
});

test("the next run reads only chats that changed, plus pending gaps", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness({
		streams: ["conversations", "messages"],
		state: {
			conversations: {
				version: 3,
				chats: {
					// Unchanged: same update time, same revision.
					[SIDE_CHAT]: {
						updated_at_ms: 1792610689000,
						transcript_revision: 31,
					},
					// Changed: an older update time.
					[MAIN_CHAT]: {
						updated_at_ms: 1792600000000,
						transcript_revision: 31,
					},
				},
			},
		},
		detailGaps: [
			{
				gap_id: "g1",
				status: "pending",
				stream: "messages",
				record_key: "11111111-1111-4111-8111-111111111111",
				detail_locator: {
					kind: "muse.chat_history",
					chat_id: "11111111-1111-4111-8111-111111111111",
				},
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		calls
			.filter((c) => c.method === "chat.history")
			.map((c) => [c.params.session_id, c.params.limit]),
		[
			[SIDE_CHAT, 1], // revision check only
			[MAIN_CHAT, 50],
		],
	);
	// Round 11: the gapped chat is absent from both fully read views and
	// sessions.get does not find it. Its parent cannot be emitted, so nothing
	// about it is emitted (no gap, no recovery, no coverage entry) and
	// messages fails for the run, retryable, with no coverage: no checkpoint
	// moves and the gap stays pending with the host.
	assert.ok(calls.some((c) => c.method === "sessions.get"));
	assert.equal(h.of("DETAIL_GAP_RECOVERED").length, 0);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE", "messages").length, 0);
	assert.equal(
		calls.some(
			(c) =>
				c.method === "chat.history" &&
				c.params.session_id === "11111111-1111-4111-8111-111111111111",
		),
		false,
	);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["conversations", "messages"],
	);
	assert.equal(h.retryable("messages"), true);
	assert.match(
		h.failures[0]?.message ?? "",
		/^muse_rpc_failed: .*could not be found/,
	);
	// Inventory is unproven too: neither chat stream can checkpoint.
	assert.equal(h.states("conversations").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE", "conversations").length, 0);
});

test("a recovery-only run retries pending gaps and nothing else", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness({
		recoveryOnly: true,
		detailGaps: [
			{
				gap_id: "g1",
				status: "pending",
				stream: "messages",
				record_key: SIDE_CHAT,
				detail_locator: { kind: "muse.chat_history", chat_id: SIDE_CHAT },
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	// No list walk: the gapped chat's own parent, then its messages.
	assert.deepEqual(
		calls.map((c) => c.method),
		["sessions.get", "chat.history"],
	);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.hydrated_keys, [
		SIDE_CHAT,
	]);
	assert.equal(h.of("STATE").length, 0);
});

test("round 6 #3: a recovery-only run emits each gapped chat's parent before its messages", async () => {
	const { gateway } = fakeGateway({
		// MAIN_CHAT is gone: no parent to emit, and its read gaps it.
		"sessions.get": (p) => {
			if (p.id === MAIN_CHAT)
				throw new MuseRpcError(
					"not_found",
					"muse_rpc_failed: sessions.get not_found",
				);
			return {
				session: (SESSIONS.sessions as Json[]).find(
					(s) => s.session_id === p.id,
				),
			};
		},
		"chat.history": (p) => {
			if (p.session_id === MAIN_CHAT)
				throw new MuseRpcError(
					"not_found",
					"muse_rpc_failed: chat.history not_found",
				);
			return historyFor(String(p.session_id));
		},
	});
	const gap = (id: string) => ({
		gap_id: `g-${id}`,
		status: "pending" as const,
		stream: "messages",
		record_key: id,
		detail_locator: { kind: "muse.chat_history", chat_id: id },
	});
	const h = harness({
		recoveryOnly: true,
		detailGaps: [gap(SIDE_CHAT), gap(MAIN_CHAT)],
	});
	await collectMuseWith(h.ctx, gateway);
	const parent = h.of("RECORD", "conversations");
	assert.deepEqual(
		parent.map((x) => (x.m.data as Json).id),
		[SIDE_CHAT],
	);
	const firstChild = Math.min(
		...h
			.of("RECORD", "messages")
			.filter((x) => (x.m.data as Json).session_id === SIDE_CHAT)
			.map((x) => x.index),
	);
	assert.ok((parent[0]?.index ?? Infinity) < firstChild);
	// Round 8: MAIN_CHAT's parent cannot be emitted (sessions.get does not
	// find it, and a not-found alone never proves it gone): nothing about it
	// is emitted, its gap is not resolved, and messages fails with no
	// coverage so the host keeps the gap pending.
	assert.equal(h.of("DETAIL_COVERAGE").length, 0);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assert.deepEqual(
		h.of("DETAIL_GAP_RECOVERED").map((x) => x.m.gap_id),
		[`g-${SIDE_CHAT}`],
	);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["messages"],
	);
	// Without conversations in scope, messages is skipped (Collection Profile 5.1).
	const only = fakeGateway();
	const m = harness({
		recoveryOnly: true,
		streams: ["messages"],
		detailGaps: [gap(SIDE_CHAT)],
	});
	await collectMuseWith(m.ctx, only.gateway);
	assert.deepEqual(only.calls, []);
	assert.equal(m.of("RECORD").length, 0);
	assert.deepEqual(
		m.of("SKIP_RESULT").map((x) => [x.m.stream, x.m.reason]),
		[["messages", "scope_not_supported"]],
	);
});

test("round 7 #3: a messages-only request is skipped as scope_not_supported, never emitting parentless children", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness({ streams: ["messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(calls, []);
	assert.equal(h.of("RECORD").length, 0);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assert.deepEqual(
		h.of("SKIP_RESULT").map((x) => [x.m.stream, x.m.reason]),
		[["messages", "scope_not_supported"]],
	);
});

/** A recovery-only harness for one gapped chat. */
function recoveryFor(id: string) {
	return harness({
		recoveryOnly: true,
		detailGaps: [
			{
				gap_id: "g1",
				status: "pending",
				stream: "messages",
				record_key: id,
				detail_locator: { kind: "muse.chat_history", chat_id: id },
			},
		],
	});
}

/** sessions.get answering one chat, edited by `edit`. */
function sessionGet(edit: (s: Json) => void) {
	return (p: Json) => {
		const found = (SESSIONS.sessions as Json[]).find(
			(s) => s.session_id === p.id,
		);
		const session = { ...(found ?? {}) };
		edit(session);
		return { session };
	};
}

test("round 7: recovery keeps the real archived flag, and never guesses it", async () => {
	{
		const { gateway } = fakeGateway({
			"sessions.get": sessionGet((s) => {
				s.archived = true;
			}),
		});
		const h = recoveryFor(SIDE_CHAT);
		await collectMuseWith(h.ctx, gateway);
		assert.deepEqual(
			h.records("conversations").map((r) => r.archived),
			[true],
		);
	}
	{
		const { gateway, calls } = fakeGateway({
			"sessions.get": sessionGet((s) => {
				delete s.archived;
			}),
		});
		const h = recoveryFor(SIDE_CHAT);
		await collectMuseWith(h.ctx, gateway);
		// No parent with a guessed flag, and so nothing about the chat: no
		// record, gap or coverage; messages fails and the gap stays pending.
		assert.equal(h.of("RECORD").length, 0);
		assert.equal(
			calls.some((c) => c.method === "chat.history"),
			false,
		);
		assert.equal(h.of("DETAIL_GAP").length, 0);
		assert.equal(h.of("DETAIL_COVERAGE").length, 0);
		assert.equal(h.of("DETAIL_GAP_RECOVERED").length, 0);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["messages"],
		);
	}
});

test("round 7: recovery never emits an unsafe parent record silently", async () => {
	const { gateway } = fakeGateway({
		"sessions.get": sessionGet((s) => {
			s.title = "bad\u0001title";
		}),
	});
	const h = recoveryFor(SIDE_CHAT);
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.of("RECORD").length, 0);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE").length, 0);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["conversations", "messages"],
	);
});

test("a failed chat list fails conversations and messages without a checkpoint", async () => {
	const { gateway } = fakeGateway({ "sessions.list": () => ({ nope: true }) });
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["conversations", "messages"],
	);
	assert.equal(h.of("STATE").length, 0);
	assert.equal(h.of("RECORD").length, 0);
});

/** activity.list pages built from the fixture's first activity, newest first. */
function activityPages(count: number) {
	const day = (fixture("activity").days as Json[])[0] ?? {};
	const template = ((day.activities as Json[]) ?? [])[0] ?? {};
	const all = Array.from({ length: count }, (_, i) => ({
		...template,
		message_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		timestamp: new Date(Date.UTC(2026, 0, 31, 12, 0, 0) - i * 60_000)
			.toISOString()
			.replace(".000Z", "Z"),
	}));
	return (p: Json) => {
		const before =
			typeof p.before === "string" ? Date.parse(p.before) : Infinity;
		const page = all
			.filter((a) => Date.parse(String(a.timestamp)) < before)
			.slice(0, Number(p.limit));
		return { days: [{ ...day, count: page.length, activities: page }] };
	};
}

test("activities page back with before until a page with no days", async () => {
	const params: Json[] = [];
	const pages = activityPages(ACTIVITY_LIMIT + 5);
	const { gateway } = fakeGateway({
		"activity.list": (p) => {
			params.push(p);
			return pages(p);
		},
	});
	const h = harness({ streams: ["activities"] });
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.records("activities").length, ACTIVITY_LIMIT + 5);
	assert.equal(params.length, 4);
	assert.deepEqual(params[0], {
		limit: 30,
		before: null,
		capabilities: ["ACTIVITY_FEED_GOALS", "ACTIVITY_FEED_PEER_CONVERSATIONS"],
	});
	// One second past the oldest time, so tied activities come back; then,
	// when a page brings nothing new, the oldest timestamp string unchanged.
	assert.equal(params[1]?.before, "2026-01-31T11:31:01Z");
	assert.equal(params[2]?.before, "2026-01-31T11:26:01Z");
	assert.equal(params[3]?.before, "2026-01-31T11:26:00Z");
	assert.deepEqual(h.states("activities")[0], {
		version: 2,
		newest_timestamp: "2026-01-31T12:00:00.000Z",
	});
});

test("activities stop at the saved watermark", async () => {
	const params: Json[] = [];
	const pages = activityPages(ACTIVITY_LIMIT * 3);
	const { gateway } = fakeGateway({
		"activity.list": (p) => {
			params.push(p);
			return pages(p);
		},
	});
	const h = harness({
		streams: ["activities"],
		state: {
			activities: { version: 2, newest_timestamp: "2026-01-31T11:50:00.000Z" },
		},
	});
	await collectMuseWith(h.ctx, gateway);
	assert.equal(params.length, 1);
	assert.equal(
		h.states("activities")[0]?.newest_timestamp,
		"2026-01-31T12:00:00.000Z",
	);
});

/** Fixed newest-first source with two distinct activities at the saved boundary. */
function watermarkActivities() {
	const day = (fixture("activity").days as Json[])[0] ?? {};
	const template: Json = ((day.activities as Json[]) ?? [])[0] ?? {};
	const boundary = "2026-01-31T11:31:00.000Z";
	const activity = (i: number) => ({
		...template,
		message_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		timestamp: new Date(
			Date.UTC(2026, 0, 31, 12) - Math.min(i, 29) * 60_000,
		).toISOString(),
	});
	const all = Array.from({ length: ACTIVITY_LIMIT + 1 }, (_, i) => activity(i));
	const page = (items: typeof all) => ({
		days: items.length === 0 ? [] : [{ ...day, activities: items }],
	});
	const read = (p: Json) => {
		const before =
			typeof p.before === "string" ? Date.parse(p.before) : Infinity;
		return page(
			all
				.filter((a) => Date.parse(a.timestamp) < before)
				.slice(0, Number(p.limit)),
		);
	};
	const state = { activities: { version: 2, newest_timestamp: boundary } };
	return { activity, all, boundary, page, read, state };
}

test("activity watermark: drain later-page ties once and resume with stable record identities", async () => {
	const source = watermarkActivities();
	const first = fakeGateway({ "activity.list": source.read });
	const h = harness({ streams: ["activities"], state: source.state });
	await collectMuseWith(h.ctx, first.gateway);
	assert.deepEqual(h.failures, []);
	const records = h.records("activities");
	assert.deepEqual(
		records.map((r) => r.message_id),
		source.all.map((a) => a.message_id),
	);
	assert.equal(new Set(records.map((r) => r.id)).size, ACTIVITY_LIMIT + 1);
	assert.deepEqual(
		first.calls.map((c) => c.params.before),
		[null, "2026-01-31T11:31:01.000Z", source.boundary],
	);
	assert.deepEqual(h.states("activities"), [
		{
			version: 2,
			newest_timestamp: "2026-01-31T12:00:00.000Z",
		},
	]);
	// Simulate the host upserting emitted records, then resuming the real collector.
	const retained = new Map(records.map((r) => [String(r.id), r]));
	const next = fakeGateway({ "activity.list": source.read });
	const resumed = harness({
		streams: ["activities"],
		state: { activities: h.states("activities")[0] },
	});
	await collectMuseWith(resumed.ctx, next.gateway);
	assert.deepEqual(resumed.failures, []);
	for (const r of resumed.records("activities")) retained.set(String(r.id), r);
	assert.deepEqual([...retained.values()], records);
	assert.deepEqual(resumed.states("activities"), h.states("activities"));
	assert.equal(next.calls.length, 1);
});

for (const failure of ["unreadable", "rpc", "stuck"] as const) {
	test(`activity watermark: ${failure} boundary drain never checkpoints`, async () => {
		const source = watermarkActivities();
		const { gateway, calls } = fakeGateway({
			"activity.list": (p) => {
				if (p.before === null) return source.read(p);
				if (failure === "unreadable") return { days: [{ activities: [{}] }] };
				if (failure === "rpc")
					throw new MuseRpcError(
						"unavailable",
						"muse_rpc_failed: activity.list unavailable",
					);
				return source.page(source.all.slice(0, ACTIVITY_LIMIT));
			},
		});
		const h = harness({ streams: ["activities"], state: source.state });
		await collectMuseWith(h.ctx, gateway);
		assert.ok(calls.length > 1);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["activities"],
		);
		assert.equal(h.states("activities").length, 0);
		assert.equal(
			new Set(h.records("activities").map((r) => r.id)).size,
			h.records("activities").length,
		);
	});
}

test("activity watermark: a full tied boundary page is not completion proof", async () => {
	const source = watermarkActivities();
	const tied = source.all.map((a) => ({ ...a, timestamp: source.boundary }));
	const { gateway } = fakeGateway({
		"activity.list": () => source.page(tied.slice(0, ACTIVITY_LIMIT)),
	});
	const h = harness({ streams: ["activities"], state: source.state });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["activities"],
	);
	assert.equal(h.states("activities").length, 0);
});

test("activity watermark: genuinely older activity remains a legitimate stop", async () => {
	const source = watermarkActivities();
	const older = {
		...source.activity(0),
		timestamp: "2026-01-31T11:30:00.000Z",
	};
	const { gateway, calls } = fakeGateway({
		"activity.list": () => source.page([...source.all.slice(0, 2), older]),
	});
	const h = harness({ streams: ["activities"], state: source.state });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.equal(calls.length, 1);
	assert.equal(h.states("activities").length, 1);
});

test("activity watermark: public collector accepts nonzero fractional timestamps", async () => {
	const source = watermarkActivities();
	const timestamp = "2026-01-31T11:31:00.500Z";
	const item = { ...source.activity(0), timestamp };
	const { gateway } = fakeGateway({
		"activity.list": (p) =>
			p.before === null ? source.page([item]) : source.page([]),
	});
	const h = harness({ streams: ["activities"], state: source.state });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.equal(h.records("activities").length, 1);
	assert.equal(h.records("activities")[0]?.message_id, item.message_id);
	assert.deepEqual(h.states("activities"), [
		{
			version: 2,
			newest_timestamp: timestamp,
		},
	]);
});

test("activity watermark: full mixed fractional bucket is complete or fails without a checkpoint", async () => {
	const source = watermarkActivities();
	const newer = "2026-01-31T11:31:00.500Z";
	const all = source.all.map((a, i) => ({
		...a,
		timestamp: i < ACTIVITY_LIMIT - 1 ? newer : source.boundary,
	}));
	const { gateway, calls } = fakeGateway({
		"activity.list": (p) => {
			const before =
				typeof p.before === "string" ? Date.parse(p.before) : Infinity;
			return source.page(
				all
					.filter((a) => Date.parse(a.timestamp) < before)
					.slice(0, Number(p.limit)),
			);
		},
	});
	const oldState = structuredClone(source.state);
	const h = harness({ streams: ["activities"], state: source.state });
	await collectMuseWith(h.ctx, gateway);
	const records = h.records("activities");
	assert.equal(new Set(records.map((r) => r.id)).size, records.length);
	assert.deepEqual(source.state, oldState);
	assert.equal(
		records.filter((r) =>
			all.slice(0, 29).some((a) => a.message_id === r.message_id),
		).length,
		29,
	);
	assert.deepEqual(
		calls.slice(0, 2).map((c) => c.params.before),
		[null, "2026-01-31T11:31:01.000Z"],
	);
	if (h.failures.length === 0) {
		assert.equal(
			records.length,
			all.length,
			"successful collection must not lose the second boundary activity",
		);
		assert.deepEqual(
			new Set(records.map((r) => r.message_id)),
			new Set(all.map((a) => a.message_id)),
		);
	} else {
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["activities"],
		);
		assert.equal(h.states("activities").length, 0);
	}
});

test("an activity page that repeats fails the stream without a checkpoint", async () => {
	const pages = activityPages(ACTIVITY_LIMIT);
	const { gateway } = fakeGateway({
		"activity.list": () => pages({ limit: ACTIVITY_LIMIT }),
	});
	const h = harness({ streams: ["activities"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["activities"],
	);
	assert.equal(h.states("activities").length, 0);
});

test("goals with a next page fail instead of claiming the list complete", async () => {
	const { gateway } = fakeGateway({
		"goals.list": () => {
			const g = fixture("goals-tracking");
			g.pagination = { has_next_page: true };
			return g;
		},
	});
	const h = harness({ streams: ["goals"] });
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.records("goals").length, 1);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["goals"],
	);
	assert.equal(h.states("goals").length, 0);
});

test("the file library pages by offset until has_more is false", async () => {
	const lib = fixture("library-recents");
	const template = (lib.entries as Json[])[0] ?? {};
	const all = Array.from({ length: LIBRARY_LIMIT + 2 }, (_, i) => ({
		...template,
		name: `file-${i}.md`,
		path: `notes/file-${i}.md`,
	}));
	const offsets: unknown[] = [];
	const { gateway } = fakeGateway({
		"fs.library": (p) => {
			offsets.push(p.offset);
			const start = Number(p.offset);
			const entries = all.slice(start, start + Number(p.limit));
			return {
				entries,
				total: all.length,
				has_more: start + entries.length < all.length,
			};
		},
	});
	const h = harness({ streams: ["files"] });
	await collectMuseWith(h.ctx, gateway);
	// Two pages, so a second complete walk confirms the same files.
	assert.deepEqual(offsets, [0, LIBRARY_LIMIT, 0, LIBRARY_LIMIT]);
	assert.equal(h.records("files").length, LIBRARY_LIMIT + 2);
	assert.equal(h.states("files").length, 1);
});

test("a file library whose total disagrees with what was listed is not checkpointed", async () => {
	const { gateway } = fakeGateway({
		"fs.library": () => {
			const lib = fixture("library-recents");
			lib.total = 6;
			return lib;
		},
	});
	const h = harness({ streams: ["files"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["files"],
	);
	assert.equal(h.states("files").length, 0);
});

test("an unreadable memory file fails memory_files without a checkpoint", async () => {
	const { gateway } = fakeGateway({
		"fs.raw": (p) =>
			p.path === "USER.md" ? { not: "a blob" } : { __blob_text: "ok" },
	});
	const h = harness({ streams: ["memory_files"] });
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.records("memory_files").length, 1);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["memory_files"],
	);
	assert.equal(h.states("memory_files").length, 0);
});

test("only read methods and the five memory files may be called", () => {
	for (const method of [
		"credentials.list",
		"chat.stream",
		"sessions.delete",
		"goals.update",
		"wallet.balance",
		"browser_task.start",
		"sharing.create",
		"oauth.callback",
	]) {
		assert.throws(() => assertReadOnlyCall(method, {}), /muse_refused_call/);
	}
	for (const path of [
		".ssh/id_rsa",
		"config",
		"runtime.lock",
		"../MEMORY.md",
	]) {
		assert.throws(
			() => assertReadOnlyCall("fs.raw", { path }),
			/muse_refused_call/,
		);
	}
	assert.throws(
		() => assertReadOnlyCall("fs.list", { path: ".ssh" }),
		/muse_refused_call/,
	);
	assert.doesNotThrow(() => assertReadOnlyCall("fs.raw", { path: "SOUL.md" }));
});

// ─── Page scripts in a sandbox ──────────────────────────────────────────

class FakeBlob {
	private readonly content: string;
	constructor(content: string) {
		this.content = content;
	}
	async text(): Promise<string> {
		return this.content;
	}
}

/** A page whose React tree holds the gateway provider a few levels down. */
function sandboxPage(
	sendRequest: (method: string, params: unknown) => unknown,
) {
	const value = {
		gatewayUrl: "wss://example.invalid/v1/noise",
		isReady: true,
		sendRequest,
	};
	const provider = { memoizedProps: { value }, child: null, sibling: null };
	const other = {
		memoizedProps: { value: { theme: "dark" } },
		child: null,
		sibling: provider,
	};
	const root = { memoizedProps: {}, child: other, sibling: null, return: null };
	const leaf = { memoizedProps: {}, child: null, sibling: null, return: root };
	const element = { __reactFiber$abc: leaf };
	const sandbox: Record<string, unknown> = {
		Blob: FakeBlob,
		clearTimeout,
		document: { body: element, querySelectorAll: () => [] },
		location: { origin: "https://muse.ai" },
		setTimeout,
	};
	sandbox.window = sandbox;
	const context = vm.createContext(sandbox);
	return {
		evaluate: async (script: string): Promise<unknown> =>
			await vm.runInContext(script, context),
		forget: () => {
			(
				sandbox.document as { body: Record<string, unknown> }
			).body.__reactFiber$abc = leaf;
		},
	};
}

test("the page scripts find the gateway client and turn a Blob answer into text", async () => {
	const seen: Array<[string, unknown]> = [];
	const page = sandboxPage((method, params) => {
		seen.push([method, params]);
		if (method === "fs.raw") return Promise.resolve(new FakeBlob("# Memory"));
		return Promise.resolve({ sessions: [] });
	});
	assert.equal(await page.evaluate(LOCATE_GATEWAY_SCRIPT), true);
	const gateway = pageGateway(page);
	assert.deepEqual(await gateway.call("sessions.list", { view: "archived" }), {
		sessions: [],
	});
	assert.deepEqual(await gateway.call("fs.raw", { path: "MEMORY.md" }), {
		__blob_text: "# Memory",
	});
	assert.deepEqual(JSON.parse(JSON.stringify(seen)), [
		["sessions.list", { view: "archived" }],
		["fs.raw", { path: "MEMORY.md" }],
	]);
	// A dropped client is located again before the call is retried.
	page.forget();
	assert.deepEqual(await gateway.call("sessions.list", {}), { sessions: [] });
	// Refused calls never reach the page.
	await assert.rejects(
		gateway.call("credentials.list", {}),
		/muse_refused_call/,
	);
	assert.equal(seen.length, 3);
});

test("a gateway error becomes a retryable muse_rpc_failed error", async () => {
	const page = sandboxPage(() => Promise.reject(new Error("boom")));
	await page.evaluate(LOCATE_GATEWAY_SCRIPT);
	const answer = JSON.parse(
		String(await page.evaluate(gatewayCallScript("tasks.list", {}))),
	) as Json;
	assert.deepEqual(answer, { ok: false, code: "rpc_error", message: "boom" });
	await assert.rejects(
		pageGateway(page).call("tasks.list", {}),
		/muse_rpc_failed: tasks\.list error: boom/,
	);
});

// ─── Review round 4 ─────────────────────────────────────────────────────

/** sessions.list paged like the live API: `limit`, then `cursor`. */
function pagedSessions(
	pages: Record<string, unknown>,
	archived: Json = { sessions: [] },
): (p: Json) => unknown {
	return (p) => {
		if (p.view === "archived") return archived;
		const key = typeof p.cursor === "string" ? p.cursor : "first";
		const page = pages[key];
		if (!page) throw new Error(`unexpected cursor ${String(p.cursor)}`);
		return page;
	};
}

test("round 6 #1: sessions.list is read page by page until an answer has no next_cursor", async () => {
	const [main, side] = SESSIONS.sessions as Json[];
	const params: Json[] = [];
	const pages = pagedSessions({
		first: { sessions: [main], next_cursor: "c1" },
		// Explicit terminal values end the list too.
		c1: { sessions: [main, side], next_cursor: null, has_more: false },
	});
	const { gateway } = fakeGateway({
		"sessions.list": (p) => {
			params.push(p);
			return pages(p);
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	// Each view walked to its end, twice: the bracket that proves the list.
	const pair = [
		{ limit: 100 },
		{ limit: 100, cursor: "c1" },
		{ limit: 100, view: "archived" },
	];
	assert.deepEqual(params, [...pair, ...pair]);
	assertCompleteChats(h, SESSION_IDS.length);
	// Deduplicated by session_id.
	assert.deepEqual(
		h.records("conversations").map((r) => r.id),
		SESSION_IDS,
	);
});

test("first sync: an unknown chat moving from archived to active cannot disappear into full success", async () => {
	const [main, side] = SESSIONS.sessions as Json[];
	assert.ok(main && side);
	assert.equal(main.session_id, MAIN_CHAT);
	assert.equal(side.session_id, SIDE_CHAT);
	let sideArchived = true;
	const snapshots: Array<{ view: string; ids: unknown[] }> = [];
	const { gateway, calls } = fakeGateway({
		"sessions.list": (p) => {
			const archived = p.view === "archived";
			const sessions = archived
				? sideArchived
					? [side]
					: []
				: sideArchived
					? [main]
					: [main, side];
			snapshots.push({
				view: archived ? "archived" : "active",
				ids: sessions.map((s) => s.session_id),
			});
			// SIDE exists throughout, but moves after the active snapshot.
			if (snapshots.length === 1 && !archived) sideArchived = false;
			return { sessions, has_more: false, next_cursor: null };
		},
		"sessions.get": (p) => {
			const session = [main, side].find((s) => s.session_id === p.id);
			assert.ok(session);
			return {
				session: { ...session, archived: p.id === SIDE_CHAT && sideArchived },
			};
		},
	});
	const h = harness({
		streams: ["conversations", "messages"],
		state: {},
		detailGaps: [],
	});
	// Never turn this first-sync case into known-ID recovery.
	assert.deepEqual(h.ctx.state, {});
	assert.deepEqual(h.ctx.detailGaps, []);
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(snapshots.slice(0, 2), [
		{ view: "active", ids: [MAIN_CHAT] },
		{ view: "archived", ids: [] },
	]);
	assert.equal(sideArchived, false);

	const partial =
		h.failures.length > 0 || h.of("DETAIL_GAP", "messages").length > 0;
	if (partial) {
		assert.ok(
			h.failures.some((f) =>
				["conversations", "messages"].includes(f.stream),
			) || h.of("DETAIL_GAP", "messages").length > 0,
		);
		assert.equal(h.states("conversations").length, 0);
		assert.equal(h.states("messages").length, 0);
		assert.equal(
			h.of("DETAIL_COVERAGE", "conversations").length,
			0,
			"an incomplete moving inventory must not advertise full conversations coverage",
		);
		return;
	}

	const parents = h.of("RECORD", "conversations");
	const sideParentIndex =
		parents.find((x) => (x.m.data as Json).id === SIDE_CHAT)?.index ?? -1;
	assert.ok(
		sideParentIndex >= 0,
		"first-sync full success must include unknown SIDE; MAIN-only inventory is incomplete",
	);
	assert.deepEqual(
		new Set(h.records("conversations").map((r) => r.id)),
		new Set(SESSION_IDS),
	);
	for (const id of SESSION_IDS) {
		const parentIndex =
			parents.find((x) => (x.m.data as Json).id === id)?.index ?? -1;
		assert.ok(parentIndex >= 0);
		const children = h
			.of("RECORD", "messages")
			.filter((x) => (x.m.data as Json).session_id === id);
		assert.equal(children.length, 3);
		assert.ok(children.every((x) => parentIndex < x.index));
		assert.deepEqual(
			new Set(children.map((x) => (x.m.data as Json).id)),
			new Set((historyFor(id).chat_events as Json[]).map((e) => e.message_id)),
		);
		assert.ok(
			calls.some(
				(c) => c.method === "chat.history" && c.params.session_id === id,
			),
		);
	}
	const coverage = h.of("DETAIL_COVERAGE", "messages");
	assert.equal(coverage.length, 1);
	assert.equal(coverage[0]?.m.state_stream, "conversations");
	assert.deepEqual(
		new Set(coverage[0]?.m.required_keys as string[]),
		new Set(SESSION_IDS),
	);
	assert.deepEqual(
		new Set(coverage[0]?.m.hydrated_keys as string[]),
		new Set(SESSION_IDS),
	);
	assert.deepEqual(coverage[0]?.m.gap_keys ?? [], []);
	assert.ok(
		(coverage[0]?.index ?? -1) >
			Math.max(...h.of("RECORD", "messages").map((x) => x.index)),
	);
	const inventory = h.of("DETAIL_COVERAGE", "conversations");
	assert.equal(inventory.length, 1);
	assert.equal(inventory[0]?.m.considered, SESSION_IDS.length);
	assert.equal(inventory[0]?.m.covered, SESSION_IDS.length);
	assert.equal(h.states("conversations").length, 1);
	assert.deepEqual(
		Object.keys(h.states("conversations")[0]?.chats as Json).sort(),
		[...SESSION_IDS].sort(),
	);
	assert.ok(
		(h.of("STATE", "conversations")[0]?.index ?? -1) >
			(coverage[0]?.index ?? Infinity),
	);
});

/** A synthetic archived chat (no real data), shaped like the side chat. */
function archivedChat(n: number): Json {
	const [, side] = SESSIONS.sessions as Json[];
	return {
		...side,
		session_id: `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`,
		title: `Archived ${n}`,
		archived: true,
	};
}

test("chat inventory bracket: single-page views are read active, archived, active, archived and checkpoint", async () => {
	const archived = archivedChat(1);
	const { gateway, calls } = fakeGateway({
		"sessions.list": (p) =>
			p.view === "archived" ? { sessions: [archived] } : SESSIONS,
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		calls.filter((c) => c.method === "sessions.list").map((c) => c.params),
		[
			{ limit: 100 },
			{ limit: 100, view: "archived" },
			{ limit: 100 },
			{ limit: 100, view: "archived" },
		],
	);
	const ids = [...SESSION_IDS, String(archived.session_id)];
	const marks = assertCompleteChats(h, ids.length);
	assert.deepEqual(Object.keys(marks).sort(), [...ids].sort());
	assert.deepEqual(
		h.records("conversations").map((r) => [r.id, r.archived]),
		[
			[MAIN_CHAT, false],
			[SIDE_CHAT, false],
			[archived.session_id, true],
		],
	);
	assert.equal(h.records("messages").length, 9);
});

test("chat inventory bracket: a stable multi-page bracket completes and its checkpoint drives the next run", async () => {
	const [main, side] = SESSIONS.sessions as Json[];
	const a1 = archivedChat(1);
	const a2 = archivedChat(2);
	const listing = (p: Json) => {
		if (p.view === "archived")
			return p.cursor === undefined
				? { sessions: [a1], next_cursor: "r1" }
				: { sessions: [a2], next_cursor: null };
		return p.cursor === undefined
			? { sessions: [main], next_cursor: "c1" }
			: { sessions: [side], has_more: false };
	};
	const first = fakeGateway({ "sessions.list": listing });
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, first.gateway);
	assert.equal(
		first.calls.filter((c) => c.method === "sessions.list").length,
		8,
	);
	const ids = [MAIN_CHAT, SIDE_CHAT, a1.session_id, a2.session_id].map(String);
	const marks = assertCompleteChats(h, ids.length);
	assert.deepEqual(Object.keys(marks).sort(), [...ids].sort());

	// The checkpoint is usable: nothing changed, so the next run only checks
	// revisions and reads no transcript in full.
	const next = fakeGateway({ "sessions.list": listing });
	const h2 = harness({
		streams: ["conversations", "messages"],
		state: { conversations: h.states("conversations")[0] },
	});
	await collectMuseWith(h2.ctx, next.gateway);
	assert.deepEqual(
		next.calls
			.filter((c) => c.method === "chat.history")
			.map((c) => c.params.limit),
		[1, 1, 1, 1],
	);
	assert.deepEqual(assertCompleteChats(h2, ids.length), marks);
});

test("chat inventory bracket: a chat moving between views during the window triggers a retry, then completes", async () => {
	const [main, side] = SESSIONS.sessions as Json[];
	assert.ok(main && side);
	let sideArchived = true;
	const views: string[] = [];
	const { gateway } = fakeGateway({
		"sessions.list": (p) => {
			const archived = p.view === "archived";
			views.push(archived ? "R" : "A");
			const sessions = archived
				? sideArchived
					? [{ ...side, archived: true }]
					: []
				: sideArchived
					? [main]
					: [main, side];
			// SIDE is unarchived right after the first archived read.
			if (views.length === 2) sideArchived = false;
			return { sessions };
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	// A1 R1 A2 R2 disagree (SIDE moved); A3 R3 agree with A2 R2.
	assert.deepEqual(views, ["A", "R", "A", "R", "A", "R"]);
	assertCompleteChats(h, SESSION_IDS.length);
	assert.deepEqual(
		h.records("conversations").map((r) => [r.id, r.archived]),
		[
			[MAIN_CHAT, false],
			[SIDE_CHAT, false],
		],
	);
});

test("chat inventory bracket: a list that never settles keeps records but fails both chat streams without a checkpoint", async () => {
	const { gateway, calls } = fakeGateway({
		"sessions.list": movingSessions(),
	});
	const h = harness({ streams: ["conversations", "messages", "goals"] });
	await collectMuseWith(h.ctx, gateway);
	// One bracket plus three retries: five (active, archived) pairs.
	assert.equal(calls.filter((c) => c.method === "sessions.list").length, 10);
	assertIncompleteChats(h);
	assert.equal(h.records("conversations").length, 3);
	assert.equal(h.records("messages").length, 9);
	// Healthy siblings still checkpoint.
	assert.equal(h.states("goals").length, 1);
});

test("round 6 #1: a chat list walk that cannot reach its end is not checkpointed", async () => {
	const [main, side] = SESSIONS.sessions as Json[];
	for (const pages of [
		// The cursor repeats (the page still adds a chat).
		{
			first: { sessions: [main], next_cursor: "c1" },
			c1: { sessions: [side], next_cursor: "c1" },
		},
		// More, with nothing to follow.
		{ first: { sessions: [main], has_more: true } },
		// Round 7: a continuation that adds no new chat, even with a new cursor.
		{
			first: { sessions: [main], next_cursor: "c1" },
			c1: { sessions: [main], next_cursor: "c2" },
			c2: { sessions: [] },
		},
	]) {
		const { gateway } = fakeGateway({ "sessions.list": pagedSessions(pages) });
		const h = harness({ streams: ["conversations", "messages"] });
		await collectMuseWith(h.ctx, gateway);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["conversations", "messages"],
			JSON.stringify(pages),
		);
		assert.equal(h.states("conversations").length, 0);
		assert.equal(h.of("DETAIL_COVERAGE").length, 0);
	}
	// The archived view pages the same way.
	const archived = {
		...side,
		session_id: "22222222-2222-4222-8222-222222222222",
	};
	const { gateway, calls } = fakeGateway({
		"sessions.list": (p) => {
			if (p.view !== "archived") return { sessions: [main] };
			return p.cursor === undefined
				? { sessions: [archived], next_cursor: "a1" }
				: { sessions: [archived], next_cursor: "a2" };
		},
	});
	const h = harness({ streams: ["conversations"] });
	await collectMuseWith(h.ctx, gateway);
	assert.ok(calls.some((c) => c.params.cursor === "a1"));
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["conversations"],
	);
});

test("round 7: a numeric page cursor is passed back as a number", async () => {
	const [main, side] = SESSIONS.sessions as Json[];
	const params: Json[] = [];
	const { gateway } = fakeGateway({
		"sessions.list": (p) => {
			params.push(p);
			if (p.view === "archived") return { sessions: [] };
			return p.cursor === undefined
				? { sessions: [main], next_cursor: 100 }
				: { sessions: [side] };
		},
		"goals.list": (p) => {
			params.push(p);
			if (p.source !== "assistant_tracking") return fixture("goals");
			const g = fixture("goals-tracking");
			if (p.cursor === undefined)
				g.pagination = { has_next_page: true, next_cursor: 7 };
			else
				(g.goals as Json[]).splice(0, 1, {
					...((g.goals as Json[])[0] ?? {}),
					goal_id: "goal_second",
				});
			return g;
		},
	});
	const h = harness({ streams: ["conversations", "goals"] });
	await collectMuseWith(h.ctx, gateway);
	assertCompleteChats(h, SESSION_IDS.length);
	assert.ok(params.some((p) => p.cursor === 100));
	assert.ok(params.some((p) => p.cursor === 7));
	assert.equal(
		params.some((p) => p.cursor === "100" || p.cursor === "7"),
		false,
	);
});

test("round 7: a goals page that says more follow but adds no new goal fails", async () => {
	let n = 0;
	const { gateway } = fakeGateway({
		"goals.list": () => {
			n += 1;
			const g = fixture("goals-tracking");
			g.pagination = { has_next_page: true, next_cursor: `g${n}` };
			return g;
		},
	});
	const h = harness({ streams: ["goals"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["goals"],
	);
	assert.equal(h.states("goals").length, 0);
	assert.ok(n < 5);
});

/** The history of `chat` with its first event changed by `edit`. */
function historyWith(chat: string, edit: (e: Json) => void): Json {
	const h = historyFor(chat);
	const first = (h.chat_events as Json[])[0];
	assert.ok(first);
	edit(first);
	return h;
}

test("finding 2: a message still being generated is not stored and its chat is a gap", async () => {
	for (const edit of [
		(e: Json) => {
			(e.payload as Json).status = "running";
		},
		(e: Json) => {
			e.display_text_ready = false;
		},
	]) {
		let partialId = "";
		const { gateway } = fakeGateway({
			"chat.history": (p) => {
				if (p.session_id !== SIDE_CHAT) return historyFor(String(p.session_id));
				const h = historyWith(SIDE_CHAT, edit);
				partialId = String((h.chat_events as Json[])[0]?.message_id);
				return h;
			},
		});
		const h = harness({ streams: ["conversations", "messages"] });
		await collectMuseWith(h.ctx, gateway);
		assert.ok(partialId);
		assert.equal(
			h.records("messages").some((r) => r.id === partialId),
			false,
		);
		assert.equal(h.records("messages").length, 5);
		assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
			SIDE_CHAT,
		]);
		assert.equal(
			((h.states("conversations")[0]?.chats ?? {}) as Json)[SIDE_CHAT],
			undefined,
		);
	}
});

test("round 5 #2: a chat whose transcript revision changed under the same update time is read again", async () => {
	const marks = {
		[SIDE_CHAT]: { updated_at_ms: 1792610689000, transcript_revision: 31 },
		[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
	};
	const { gateway, calls } = fakeGateway({
		"chat.history": (p) => {
			const h = historyFor(String(p.session_id));
			// MAIN_CHAT got a new message within the same second: revision 32.
			if (p.session_id === MAIN_CHAT) h.transcript_revision = 32;
			return h;
		},
	});
	const h = harness({
		streams: ["conversations", "messages"],
		state: { conversations: { version: 3, chats: marks } },
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		calls
			.filter((c) => c.method === "chat.history")
			.map((c) => [c.params.session_id, c.params.limit]),
		[
			[SIDE_CHAT, 1],
			[MAIN_CHAT, 1],
			[MAIN_CHAT, 50],
		],
	);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.required_keys, [
		MAIN_CHAT,
	]);
	// SIDE keeps its mark; MAIN gets the new revision.
	assert.deepEqual(assertCompleteChats(h, SESSION_IDS.length), {
		[SIDE_CHAT]: marks[SIDE_CHAT],
		[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 32 },
	});
});

test("round 5 #2: a chat with no known revision is always read again", async () => {
	const { gateway, calls } = fakeGateway({
		"chat.history": (p) => {
			const h = historyFor(String(p.session_id));
			delete h.transcript_revision;
			return h;
		},
	});
	const h = harness({
		streams: ["conversations", "messages"],
		state: {
			conversations: {
				version: 3,
				chats: {
					[SIDE_CHAT]: {
						updated_at_ms: 1792610689000,
						transcript_revision: 31,
					},
					[MAIN_CHAT]: {
						updated_at_ms: 1792612428000,
						transcript_revision: 31,
					},
				},
			},
		},
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.required_keys, [
		SIDE_CHAT,
		MAIN_CHAT,
	]);
	assert.equal(calls.filter((c) => c.params.limit === 50).length, 2);
	// Nothing to compare next time: no mark is kept.
	assert.deepEqual(assertCompleteChats(h, SESSION_IDS.length), {});
});

test("round 5 #2: a version 1 watermark cursor is not trusted", async () => {
	const { gateway } = fakeGateway();
	const h = harness({
		streams: ["conversations", "messages"],
		state: {
			conversations: { version: 1, messages_read_through_ms: 1792612428000 },
		},
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.required_keys, [
		SIDE_CHAT,
		MAIN_CHAT,
	]);
});

test("finding 4: unsafe text never reaches a checkpoint", async () => {
	// A message body: the message is not stored, its chat is a gap.
	{
		const { gateway } = fakeGateway({
			"chat.history": (p) =>
				p.session_id === SIDE_CHAT
					? historyWith(SIDE_CHAT, (e) => {
							e.display_text = "bad\u0000body";
						})
					: historyFor(String(p.session_id)),
		});
		const h = harness({ streams: ["conversations", "messages"] });
		await collectMuseWith(h.ctx, gateway);
		assert.equal(h.records("messages").length, 5);
		assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
			SIDE_CHAT,
		]);
		assert.equal(
			((h.states("conversations")[0]?.chats ?? {}) as Json)[SIDE_CHAT],
			undefined,
		);
	}
	// A memory file body: not stored, the stream fails.
	{
		const { gateway } = fakeGateway({
			"fs.raw": (p) => ({
				__blob_text: p.path === "USER.md" ? "bad\u0000" : "fine",
			}),
		});
		const h = harness({ streams: ["memory_files"] });
		await collectMuseWith(h.ctx, gateway);
		assert.deepEqual(
			h.records("memory_files").map((r) => r.id),
			["MEMORY.md"],
		);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["memory_files"],
		);
		assert.equal(h.states("memory_files").length, 0);
	}
	// Any other free-text field: the stream is not checkpointed.
	{
		const { gateway } = fakeGateway({
			"sessions.list": (p) => {
				if (p.view === "archived") return fixture("sessions-archived");
				const s = fixture("sessions");
				const first = (s.sessions as Json[])[0];
				assert.ok(first);
				first.title = "bad\u0001title";
				return s;
			},
		});
		const h = harness({ streams: ["conversations"] });
		await collectMuseWith(h.ctx, gateway);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["conversations"],
		);
		assert.equal(h.states("conversations").length, 0);
	}
});

test("finding 5: activities that share the page boundary time are all read", async () => {
	const day = (fixture("activity").days as Json[])[0] ?? {};
	const template = ((day.activities as Json[]) ?? [])[0] ?? {};
	const at = (i: number) =>
		new Date(Date.UTC(2026, 0, 31, 12, 0, 0) - Math.min(i, 29) * 60_000)
			.toISOString()
			.replace(".000Z", "Z");
	// 35 activities: the 30th through the 35th share one timestamp.
	const all = Array.from({ length: ACTIVITY_LIMIT + 5 }, (_, i) => ({
		...template,
		message_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		timestamp: at(i),
	}));
	const { gateway } = fakeGateway({
		// Strictly before, newest first, `limit` at a time.
		"activity.list": (p) => {
			const before =
				typeof p.before === "string" ? Date.parse(p.before) : Infinity;
			const page = all
				.filter((a) => Date.parse(a.timestamp) < before)
				.slice(0, Number(p.limit));
			return page.length === 0
				? { days: [] }
				: { days: [{ ...day, count: page.length, activities: page }] };
		},
	});
	const h = harness({ streams: ["activities"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.equal(h.records("activities").length, ACTIVITY_LIMIT + 5);
	assert.equal(h.states("activities").length, 1);
});

test("finding 5: more tied activities than one page holds fail instead of skipping", async () => {
	const day = (fixture("activity").days as Json[])[0] ?? {};
	const template = ((day.activities as Json[]) ?? [])[0] ?? {};
	const all = Array.from({ length: ACTIVITY_LIMIT * 2 }, (_, i) => ({
		...template,
		message_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
		timestamp: "2026-01-31T12:00:00Z",
	}));
	const { gateway } = fakeGateway({
		"activity.list": (p) => {
			const before =
				typeof p.before === "string" ? Date.parse(p.before) : Infinity;
			const page = all
				.filter((a) => Date.parse(a.timestamp) < before)
				.slice(0, Number(p.limit));
			return page.length === 0
				? { days: [] }
				: { days: [{ ...day, count: page.length, activities: page }] };
		},
	});
	const h = harness({ streams: ["activities"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["activities"],
	);
	assert.equal(h.states("activities").length, 0);
});

test("finding 6: a library that changes between pages is walked again until it is stable", async () => {
	const template = (fixture("library-recents").entries as Json[])[0] ?? {};
	const file = (name: string) => ({ ...template, name, path: `notes/${name}` });
	let list = Array.from({ length: LIBRARY_LIMIT + 1 }, (_, i) =>
		file(`f${i}.md`),
	);
	let calls = 0;
	const { gateway } = fakeGateway({
		"fs.library": (p) => {
			calls += 1;
			const start = Number(p.offset);
			const entries = list.slice(start, start + Number(p.limit));
			const answer = {
				entries,
				total: list.length,
				has_more: start + entries.length < list.length,
			};
			// After the first page: f0 is deleted and c.md moves to the top.
			if (calls === 1) list = [file("c.md"), ...list.slice(1)];
			return answer;
		},
	});
	const h = harness({ streams: ["files"] });
	await collectMuseWith(h.ctx, gateway);
	const paths = h.records("files").map((r) => r.path);
	assert.ok(paths.includes("notes/c.md"));
	assert.equal(paths.includes("notes/f0.md"), false);
	assert.equal(new Set(paths).size, paths.length);
	assert.equal(h.states("files").length, 1);
});

test("finding 7: a pending gap that is read completely is reported recovered", async () => {
	const { gateway } = fakeGateway();
	const h = harness({
		streams: ["conversations", "messages"],
		detailGaps: [
			{
				gap_id: "g1",
				lease_id: "l1",
				status: "pending",
				stream: "messages",
				record_key: SIDE_CHAT,
				detail_locator: { kind: "muse.chat_history", chat_id: SIDE_CHAT },
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	const recovered = h.of("DETAIL_GAP_RECOVERED");
	assert.equal(recovered.length, 1);
	assert.deepEqual(recovered[0]?.m, {
		type: "DETAIL_GAP_RECOVERED",
		reference_only: true,
		gap_id: "g1",
		lease_id: "l1",
		stream: "messages",
		record_key: SIDE_CHAT,
	});
	const lastSideMessage = Math.max(
		...h
			.of("RECORD", "messages")
			.filter((x) => (x.m.data as Json).session_id === SIDE_CHAT)
			.map((x) => x.index),
	);
	assert.ok((recovered[0]?.index ?? -1) > lastSideMessage);
});

test("finding 9: a rate limit or outage stops the chat walk instead of gapping every chat", async () => {
	for (const code of ["rate_limited", "server_error", "timeout", "rpc_error"]) {
		const { gateway, calls } = fakeGateway({
			"chat.history": () => {
				throw new MuseRpcError(code, `muse_rpc_failed: chat.history ${code}`);
			},
		});
		const h = harness({ streams: ["conversations", "messages"] });
		await collectMuseWith(h.ctx, gateway);
		assert.equal(
			calls.filter((c) => c.method === "chat.history").length,
			1,
			code,
		);
		assert.equal(h.of("DETAIL_GAP").length, 0, code);
		assert.deepEqual(
			h.failures.map((f) => f.stream),
			["conversations", "messages"],
			code,
		);
	}
	// A chat the gateway cannot find is a per-chat gap; the walk goes on.
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			if (p.session_id === SIDE_CHAT)
				throw new MuseRpcError(
					"not_found",
					"muse_rpc_failed: chat.history not_found",
				);
			return historyFor(String(p.session_id));
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
		SIDE_CHAT,
	]);
	assert.deepEqual(Object.keys(assertCompleteChats(h, SESSION_IDS.length)), [
		MAIN_CHAT,
	]);
});

test("finding 9: the page script keeps the gateway's status class", async () => {
	for (const [error, code] of [
		[
			Object.assign(new Error("Too Many Requests"), { status: 429 }),
			"rate_limited",
		],
		[new Error("HTTP 503 Service Unavailable"), "server_error"],
		[new Error("session not found"), "not_found"],
		[new Error("HTTP 500"), "server_error"],
		[new Error("HTTP 429"), "rate_limited"],
		[new Error("Internal error"), "server_error"],
		[new Error("boom"), "rpc_error"],
	] as const) {
		const page = sandboxPage(() => Promise.reject(error));
		const answer = JSON.parse(
			String(await page.evaluate(gatewayCallScript("tasks.list", {}))),
		) as Json;
		assert.equal(answer.code, code, error.message);
	}
});

test("finding 11: a challenge page is reported as a bot challenge, not a sign-in", async () => {
	const page = {
		evaluate: async (script: string): Promise<unknown> => {
			const sandbox: Record<string, unknown> = {
				document: {
					body: {},
					title: "Just a moment...",
					querySelector: (sel: string) =>
						sel.includes("challenge-platform") ? {} : null,
					querySelectorAll: () => [],
				},
				location: { origin: "https://muse.ai" },
			};
			sandbox.window = sandbox;
			return await vm.runInContext(script, vm.createContext(sandbox));
		},
	};
	await assert.rejects(museReadiness(page, 1), (error: Error) => {
		assert.match(error.message, /muse_bot_challenge/);
		assert.doesNotMatch(error.message, /muse_auth_failed/);
		return true;
	});
	const plain = {
		evaluate: async (script: string): Promise<unknown> => {
			const sandbox: Record<string, unknown> = {
				document: {
					body: {},
					title: "Muse",
					querySelector: () => null,
					querySelectorAll: () => [],
				},
				location: { origin: "https://muse.ai" },
			};
			sandbox.window = sandbox;
			return await vm.runInContext(script, vm.createContext(sandbox));
		},
	};
	await assert.rejects(museReadiness(plain, 1), /muse_auth_failed/);
});

test("round 5 #2: a chat whose revision moves between pages is a gap, not a mark", async () => {
	const side = pagedHistory(120);
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			if (p.session_id !== SIDE_CHAT) return historyFor(String(p.session_id));
			const page = side(p);
			if (typeof p.before_seq === "number") page.transcript_revision = 32;
			return page;
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
		SIDE_CHAT,
	]);
	assert.equal(
		((h.states("conversations")[0]?.chats ?? {}) as Json)[SIDE_CHAT],
		undefined,
	);
});

test("round 6 #2: a continuation page without a revision is unknown, not a change", async () => {
	const side = pagedHistory(120);
	const calls: Json[] = [];
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			if (p.session_id !== SIDE_CHAT) return historyFor(String(p.session_id));
			calls.push(p);
			const page = side(p) as Json;
			if (typeof p.before_seq === "number") delete page.transcript_revision;
			return page;
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys ?? [],
		[],
	);
	assertCompleteChats(h, SESSION_IDS.length);
	// One first-page read at the end confirms the revision.
	assert.equal(calls.at(-1)?.limit, 1);
});

test("round 6 #2: a chat that changed during the walk is caught by the final revision read", async () => {
	const side = pagedHistory(120);
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			if (p.session_id !== SIDE_CHAT) return historyFor(String(p.session_id));
			const page = side(p) as Json;
			if (typeof p.before_seq === "number") delete page.transcript_revision;
			if (p.limit === 1) page.transcript_revision = 32;
			return page;
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
		SIDE_CHAT,
	]);
});

test("round 6 #5: goals are read for all three app variants and follow the page cursor", async () => {
	const params: Json[] = [];
	const goal = (id: string) => ({
		...((fixture("goals-tracking").goals as Json[])[0] ?? {}),
		goal_id: id,
	});
	const { gateway } = fakeGateway({
		"goals.list": (p) => {
			params.push(p);
			if (p.status === "completed")
				return {
					goals: [goal("goal_done")],
					warnings: [],
					pagination: { has_next_page: false },
				};
			if (p.source === "assistant_tracking" && p.cursor === undefined)
				return {
					goals: [goal("goal_a")],
					warnings: [],
					pagination: { has_next_page: true, next_cursor: "g2" },
				};
			if (p.source === "assistant_tracking")
				return {
					goals: [goal("goal_a"), goal("goal_b")],
					warnings: [],
					pagination: { has_next_page: false },
				};
			return fixture("goals");
		},
	});
	const h = harness({ streams: ["goals"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(params, [
		{ source: "user_goal" },
		{ source: "assistant_tracking" },
		{ source: "assistant_tracking", cursor: "g2" },
		{ status: "completed" },
	]);
	assert.deepEqual(
		h.records("goals").map((r) => r.id),
		["goal_a", "goal_b", "goal_done"],
	);
	assert.deepEqual(h.failures, []);
	assert.equal(h.states("goals").length, 1);
});

test("goals continue a completed variant whose first page overlaps an earlier variant", async () => {
	const goal = (id: string) => ({
		...((fixture("goals-tracking").goals as Json[])[0] ?? {}),
		goal_id: id,
	});
	const { gateway, calls } = fakeGateway({
		"goals.list": (p) => {
			if (p.source === "user_goal")
				return { goals: [goal("G")], pagination: { has_next_page: false } };
			if (p.source === "assistant_tracking")
				return { goals: [], pagination: { has_next_page: false } };
			assert.equal(p.status, "completed");
			if (p.cursor === undefined)
				return {
					goals: [goal("G")],
					pagination: { has_next_page: true, next_cursor: "c2" },
				};
			assert.equal(p.cursor, "c2");
			return { goals: [goal("H")], pagination: { has_next_page: false } };
		},
	});
	const h = harness({ streams: ["goals"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(calls, [
		{ method: "goals.list", params: { source: "user_goal" } },
		{ method: "goals.list", params: { source: "assistant_tracking" } },
		{ method: "goals.list", params: { status: "completed" } },
		{ method: "goals.list", params: { status: "completed", cursor: "c2" } },
	]);
	assert.deepEqual(
		h.records("goals").map((r) => r.id),
		["G", "H"],
	);
	assert.deepEqual(h.failures, []);
	assert.equal(h.states("goals").length, 1);
	assert.equal(h.of("STATE").length, 1);
	assert.ok(
		(h.of("STATE", "goals")[0]?.index ?? -1) >
			(h.of("RECORD", "goals").at(-1)?.index ?? -1),
	);
});

test("goals reject a stalled variant cursor even when each page has a fresh goal", async () => {
	let page = 0;
	const { gateway, calls } = fakeGateway({
		"goals.list": () => ({
			goals: [
				{
					...((fixture("goals-tracking").goals as Json[])[0] ?? {}),
					goal_id: `fresh-${++page}`,
				},
			],
			pagination: { has_next_page: true, next_cursor: "stalled" },
		}),
	});
	const h = harness({ streams: ["goals"] });
	await collectMuseWith(h.ctx, gateway);
	assert.equal(calls.length, 2);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["goals"],
	);
	assert.match(h.failures[0]?.message ?? "", /repeated a page cursor/);
	assert.equal(h.states("goals").length, 0);
});

test("goals are not read or checkpointed when unselected", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness({ streams: [] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(calls, []);
	assert.deepEqual(h.emitted, []);
	assert.deepEqual(h.failures, []);
});

test("round 6 #5: a goals cursor that repeats fails the stream", async () => {
	const { gateway } = fakeGateway({
		"goals.list": () => ({
			goals: [],
			warnings: [],
			pagination: { has_next_page: true, end_cursor: "same" },
		}),
	});
	const h = harness({ streams: ["goals"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["goals"],
	);
	assert.equal(h.states("goals").length, 0);
});

test("round 7: an unknown final revision is not proof the chat did not change", async () => {
	const side = pagedHistory(120);
	const { gateway } = fakeGateway({
		"chat.history": (p) => {
			if (p.session_id !== SIDE_CHAT) return historyFor(String(p.session_id));
			const page = side(p) as Json;
			// Continuation pages and the final one-message read omit it.
			if (typeof p.before_seq === "number" || p.limit === 1)
				delete page.transcript_revision;
			return page;
		},
	});
	const h = harness({ streams: ["conversations", "messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
		SIDE_CHAT,
	]);
	assert.equal(
		((h.states("conversations")[0]?.chats ?? {}) as Json)[SIDE_CHAT],
		undefined,
	);
});

test("round 8 #2: two not-founds in recovery never clear a pending gap", async () => {
	const nf = (m: string) => () => {
		throw new MuseRpcError("not_found", `muse_rpc_failed: ${m} not_found`);
	};
	const { gateway } = fakeGateway({
		"sessions.get": nf("sessions.get"),
		"chat.history": nf("chat.history"),
	});
	const h = recoveryFor(SIDE_CHAT);
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.of("DETAIL_GAP_RECOVERED").length, 0);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE").length, 0);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["messages"],
	);
});

test("round 8 #3: a pending chat absent from the inventory is read through sessions.get, not recovered", async () => {
	// The chat moved between views during the walk: neither view lists it,
	// but sessions.get still finds it.
	const moved = "33333333-3333-4333-8333-333333333333";
	const base = (SESSIONS.sessions as Json[])[1] ?? {};
	const { gateway, calls } = fakeGateway({
		"sessions.get": (p) => {
			if (p.id !== moved)
				throw new MuseRpcError(
					"not_found",
					"muse_rpc_failed: sessions.get not_found",
				);
			return { session: { ...base, session_id: moved, archived: true } };
		},
	});
	const h = harness({
		streams: ["conversations", "messages"],
		detailGaps: [
			{
				gap_id: "g-moved",
				status: "pending",
				stream: "messages",
				record_key: moved,
				detail_locator: { kind: "muse.chat_history", chat_id: moved },
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.ok(
		calls.some(
			(c) => c.method === "chat.history" && c.params.session_id === moved,
		),
	);
	const parent = h
		.of("RECORD", "conversations")
		.find((x) => (x.m.data as Json).id === moved);
	assert.ok(parent);
	assert.equal((parent.m.data as Json).archived, true);
	const recovered = h.of("DETAIL_GAP_RECOVERED");
	assert.deepEqual(
		recovered.map((x) => x.m.gap_id),
		["g-moved"],
	);
	const lastMovedMessage = Math.max(
		...h
			.of("RECORD", "messages")
			.filter((x) => (x.m.data as Json).session_id === moved)
			.map((x) => x.index),
	);
	assert.ok(parent.index < lastMovedMessage);
	assert.ok((recovered[0]?.index ?? -1) > lastMovedMessage);
});

test("round 8 #3: an incomplete inventory recovers nothing", async () => {
	const { gateway } = fakeGateway({
		"sessions.list": (p) =>
			p.view === "archived" ? { sessions: [], has_more: true } : SESSIONS,
	});
	const h = harness({
		streams: ["conversations", "messages"],
		detailGaps: [
			{
				gap_id: "g-x",
				status: "pending",
				stream: "messages",
				record_key: "44444444-4444-4444-8444-444444444444",
				detail_locator: {
					kind: "muse.chat_history",
					chat_id: "44444444-4444-4444-8444-444444444444",
				},
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.equal(h.of("DETAIL_GAP_RECOVERED").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE").length, 0);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["conversations", "messages"],
	);
});

test("round 9: DETAIL_GAP_RECOVERED is emitted only after a full history read", async () => {
	// Every chat sessions.get cannot find, after a complete inventory walk.
	const absent = "55555555-5555-4555-8555-555555555555";
	const { gateway } = fakeGateway();
	const h = harness({
		streams: ["conversations", "messages"],
		detailGaps: [
			{
				gap_id: "g-absent",
				status: "pending",
				stream: "messages",
				record_key: absent,
				detail_locator: { kind: "muse.chat_history", chat_id: absent },
			},
			{
				gap_id: "g-side",
				status: "pending",
				stream: "messages",
				record_key: SIDE_CHAT,
				detail_locator: { kind: "muse.chat_history", chat_id: SIDE_CHAT },
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	// Only the chat read in full is recovered. The absent one's parent cannot
	// be emitted (round 11): no gap or coverage entry for it, no coverage at
	// all, and messages fails for the run, retryable.
	assert.deepEqual(
		h.of("DETAIL_GAP_RECOVERED").map((x) => x.m.gap_id),
		["g-side"],
	);
	assert.equal(h.of("DETAIL_GAP").length, 0);
	assert.equal(h.of("DETAIL_COVERAGE", "messages").length, 0);
	assert.deepEqual(
		h.failures.map((f) => f.stream),
		["conversations", "messages"],
	);
	assert.equal(h.retryable("messages"), true);
});

// ─── Scope: time_range and resources through the runtime's own gate ────────

const DAY_MS = 86_400_000;
const OLD_CHAT = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_CHAT = "aaaaaaaa-0000-4000-8000-000000000002";
const T0 = Date.UTC(2026, 0, 1);
/** OLD_CHAT: 150 daily messages from 2026-01-01; NEW_CHAT: 5 from 2026-05-20. */
const SCOPE_CHATS: Record<string, { first: number; count: number }> = {
	[OLD_CHAT]: { first: T0, count: 150 },
	[NEW_CHAT]: { first: Date.UTC(2026, 4, 20), count: 5 },
};
const SINCE = "2026-05-01T00:00:00Z";

function scopeEvents(chat: string): Json[] {
	const template = (fixture("history").chat_events as Json[])[0] ?? {};
	const { first, count } = SCOPE_CHATS[chat] ?? { first: 0, count: 0 };
	return Array.from({ length: count }, (_, i) => ({
		...template,
		message_id: `${chat}:m-${i + 1}`,
		seq: i + 1,
		occurred_at_ms: first + i * DAY_MS,
	}));
}

/** Two chats; the old one was created long before SINCE but last updated after it. */
function scopeGateway(overrides: Record<string, Handler> = {}) {
	const template = (SESSIONS.sessions as Json[])[0] ?? {};
	const session = (chat: string): Json => {
		const events = scopeEvents(chat);
		return {
			...template,
			session_id: chat,
			archived: false,
			created_at_ms: SCOPE_CHATS[chat]?.first,
			updated_at_ms: events.at(-1)?.occurred_at_ms,
		};
	};
	return fakeGateway({
		"sessions.list": (p) =>
			p.view === "archived"
				? { sessions: [] }
				: { sessions: [session(OLD_CHAT), session(NEW_CHAT)] },
		"sessions.get": (p) => {
			if (!(String(p.id) in SCOPE_CHATS))
				throw new MuseRpcError("not_found", "muse_rpc_failed: not_found");
			return { session: session(String(p.id)) };
		},
		"chat.history": (p) => {
			const all = scopeEvents(String(p.session_id));
			const before = typeof p.before_seq === "number" ? p.before_seq : Infinity;
			const older = all.filter((e) => Number(e.seq) < before);
			const page = older.slice(-Number(p.limit));
			return {
				chat_events: page,
				has_more: older.length > page.length,
				transcript_revision: 7,
			};
		},
		...overrides,
	});
}

/**
 * A context whose record gate is the runtime's own (makeEmitRecord with the
 * manifest's consent fields) and whose STATE passes the runtime's bounded-
 * progress hold, so a test sees what the host would commit.
 */
function scopedHarness(options: {
	scopes: StreamScope[];
	state?: Record<string, unknown>;
	detailGaps?: MuseCtx["detailGaps"];
	recoveryOnly?: boolean;
}) {
	const emitted: EmittedMessage[] = [];
	const failures: Array<{
		stream: string;
		message: string;
		hint?: { action: string; retryable?: boolean };
	}> = [];
	const requested = new Map<string, StreamScope>(
		options.scopes.map((s) => [s.name, s]),
	);
	const sink = async (message: EmittedMessage) => {
		emitted.push(message);
	};
	const gate = makeEmitRecord({
		requested,
		emit: sink,
		emittedAt: "2026-10-26T00:00:00.000Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: consentTimeFieldResolver("muse"),
	});
	const ctx: MuseCtx = {
		collectionMode: "incremental",
		detailGaps: options.detailGaps ?? [],
		emit: (message) =>
			withholdsBoundedProgress(message, gate.withheldAtOrAfterUntil)
				? sink({ type: "PROGRESS", stream: message.stream, message: "held" })
				: sink(message),
		emitRecord: gate.emit,
		isRecordSelected: gate.isSelected,
		progress: async () => undefined,
		recoveryOnly: options.recoveryOnly ?? false,
		reportStreamFailure: async (stream, message, opts) => {
			failures.push({
				stream,
				message,
				...(opts?.recoveryHint ? { hint: opts.recoveryHint } : {}),
			});
		},
		requested,
		state: options.state ?? {},
	};
	const records = (stream: string) =>
		emitted
			.filter((m) => m.type === "RECORD" && m.stream === stream)
			.map((m) => (m as { data: Json }).data);
	/** The state the host carries into the next run: prior state plus this run's STATE. */
	const nextState = () => {
		const out: Record<string, unknown> = { ...(options.state ?? {}) };
		for (const m of emitted)
			if (m.type === "STATE") out[m.stream] = m.cursor as unknown;
		return out;
	};
	const states = (stream: string) =>
		emitted
			.filter((m) => m.type === "STATE" && m.stream === stream)
			.map((m) => (m as { cursor: Json }).cursor);
	return { ctx, emitted, failures, records, nextState, states };
}

const chatScopes = (
	conversations: Partial<StreamScope> = {},
	messages: Partial<StreamScope> = {},
): StreamScope[] => [
	{ name: "conversations", ...conversations },
	{ name: "messages", ...messages },
];

test("scope since: conversations select chats by last update, so an old chat active in the window is kept", async () => {
	const { gateway } = scopeGateway();
	const h = scopedHarness({
		scopes: chatScopes({ time_range: { since: SINCE } }),
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		h.records("conversations").map((r) => r.id),
		[OLD_CHAT, NEW_CHAT],
	);
});

test("scope since: chat.history stops paging once a whole page is older than since", async () => {
	const { gateway, calls } = scopeGateway();
	const h = scopedHarness({
		scopes: chatScopes({}, { time_range: { since: SINCE } }),
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	const oldPages = calls.filter(
		(c) =>
			c.method === "chat.history" &&
			c.params.session_id === OLD_CHAT &&
			c.params.limit === 50,
	);
	// 150 messages, 50 a page, newest first: page 2 (seq 51-100) is all
	// before May; page 3 is never asked for.
	assert.deepEqual(
		oldPages.map((c) => c.params.before_seq ?? null),
		[null, 101],
	);
	const old = h.records("messages").filter((r) => r.session_id === OLD_CHAT);
	assert.equal(old.length, 30);
	assert.ok(old.every((r) => String(r.occurred_at) >= "2026-05-01"));
	const marks = (h.states("conversations")[0]?.chats ?? {}) as Json;
	assert.equal((marks[OLD_CHAT] as Json).since, SINCE);
	assert.equal((marks[OLD_CHAT] as Json).until, undefined);
});

test("scope since then unbounded: a narrow run never hides older messages from a wider one", async () => {
	const first = scopedHarness({
		scopes: chatScopes({}, { time_range: { since: SINCE } }),
	});
	await collectMuseWith(first.ctx, scopeGateway().gateway);
	assert.equal(first.states("conversations").length, 1);

	const second = scopedHarness({
		scopes: chatScopes(),
		state: first.nextState(),
	});
	await collectMuseWith(second.ctx, scopeGateway().gateway);
	assert.deepEqual(second.failures, []);
	assert.equal(
		second.records("messages").filter((r) => r.session_id === OLD_CHAT).length,
		150,
	);
	// The wide read leaves unbounded marks: a third unbounded run reads nothing again.
	const marks = (second.states("conversations")[0]?.chats ?? {}) as Json;
	assert.equal((marks[OLD_CHAT] as Json).since, undefined);
	const third = scopedHarness({
		scopes: chatScopes(),
		state: second.nextState(),
	});
	await collectMuseWith(third.ctx, scopeGateway().gateway);
	assert.equal(third.records("messages").length, 0);
});

test("scope since and until: the mark records both bounds and an unbounded run reads the chat again", async () => {
	const window = { since: SINCE, until: "2027-01-01T00:00:00Z" };
	const first = scopedHarness({
		scopes: chatScopes({}, { time_range: window }),
	});
	await collectMuseWith(first.ctx, scopeGateway().gateway);
	const marks = (first.states("conversations")[0]?.chats ?? {}) as Json;
	assert.deepEqual(
		{
			since: (marks[OLD_CHAT] as Json).since,
			until: (marks[OLD_CHAT] as Json).until,
		},
		window,
	);
	const second = scopedHarness({
		scopes: chatScopes({}, { time_range: { since: "2026-01-01T00:00:00Z" } }),
		state: first.nextState(),
	});
	await collectMuseWith(second.ctx, scopeGateway().gateway);
	assert.equal(
		second.records("messages").filter((r) => r.session_id === OLD_CHAT).length,
		150,
	);
});

test("scope since: a later since inside the marked window reads no chat again", async () => {
	const first = scopedHarness({
		scopes: chatScopes({}, { time_range: { since: SINCE } }),
	});
	await collectMuseWith(first.ctx, scopeGateway().gateway);
	const { gateway, calls } = scopeGateway();
	const second = scopedHarness({
		scopes: chatScopes({}, { time_range: { since: "2026-05-10T00:00:00Z" } }),
		state: first.nextState(),
	});
	await collectMuseWith(second.ctx, gateway);
	assert.equal(second.records("messages").length, 0);
	assert.ok(
		calls
			.filter((c) => c.method === "chat.history")
			.every((c) => c.params.limit === 1),
	);
});

test("scope until: messages at or after until hold the chat checkpoint", async () => {
	const { gateway } = scopeGateway();
	const h = scopedHarness({
		scopes: chatScopes({}, { time_range: { until: "2026-03-01T00:00:00Z" } }),
	});
	await collectMuseWith(h.ctx, gateway);
	const old = h.records("messages").filter((r) => r.session_id === OLD_CHAT);
	assert.equal(old.length, 59);
	assert.ok(old.every((r) => String(r.occurred_at) < "2026-03-01"));
	assert.equal(h.states("conversations").length, 0);
});

test("scope resources: a messages resource filter writes no chat mark, so a later unbounded run reads every chat", async () => {
	const first = scopedHarness({
		scopes: chatScopes({}, { resources: [`${OLD_CHAT}:m-150`] }),
	});
	await collectMuseWith(first.ctx, scopeGateway().gateway);
	assert.deepEqual(
		first.records("messages").map((r) => r.id),
		[`${OLD_CHAT}:m-150`],
	);
	assert.deepEqual(first.states("conversations")[0]?.chats, {});
	const second = scopedHarness({
		scopes: chatScopes(),
		state: first.nextState(),
	});
	await collectMuseWith(second.ctx, scopeGateway().gateway);
	assert.equal(second.records("messages").length, 155);
});

test("scope resources: conversations alone are read with sessions.get, never by listing every chat", async () => {
	const { gateway, calls } = scopeGateway();
	const h = scopedHarness({
		scopes: [{ name: "conversations", resources: [NEW_CHAT, "missing"] }],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls.map((c) => c.method),
		["sessions.get", "sessions.get"],
	);
	assert.deepEqual(
		h.records("conversations").map((r) => r.id),
		[NEW_CHAT],
	);
	// A filtered read is no full scan: no inventory coverage, marks untouched.
	assert.equal(h.states("conversations").length, 0);
	assert.equal(h.emitted.filter((m) => m.type === "DETAIL_COVERAGE").length, 0);
});

test("scope resources: a conversations answer without the archived flag falls back to the list", async () => {
	const { gateway, calls } = scopeGateway({
		"sessions.get": (p) => ({
			session: { session_id: p.id, title: "t", updated_at_ms: T0 },
		}),
	});
	const h = scopedHarness({
		scopes: [{ name: "conversations", resources: [OLD_CHAT] }],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.ok(calls.some((c) => c.method === "sessions.list"));
	assert.deepEqual(
		h.records("conversations").map((r) => [r.id, r.archived]),
		[[OLD_CHAT, false]],
	);
});

/** activityPages with a fixed minute grid, newest 2026-01-31T12:00Z. */
function scopeActivities(count: number) {
	const pages = activityPages(count);
	const calls: Json[] = [];
	const { gateway } = fakeGateway({
		"activity.list": (p) => {
			calls.push(p);
			return pages(p);
		},
	});
	return { gateway, calls };
}

test("scope resources: an activities resource run keeps the watermark, so the next unbounded run misses nothing", async () => {
	const first = scopedHarness({
		scopes: [
			{
				name: "activities",
				resources: [
					"00000000-0000-4000-8000-000000000000:2026-01-31T12:00:00.000Z:task_running",
				],
			},
		],
	});
	await collectMuseWith(first.ctx, scopeActivities(40).gateway);
	assert.equal(first.records("activities").length, 1);
	assert.deepEqual(first.states("activities"), [
		{ version: 2, newest_timestamp: null },
	]);
	const second = scopedHarness({
		scopes: [{ name: "activities" }],
		state: first.nextState(),
	});
	await collectMuseWith(second.ctx, scopeActivities(40).gateway);
	assert.equal(second.records("activities").length, 40);
});

test("scope since: the activity walk stops at since and keeps the watermark", async () => {
	const { gateway, calls } = scopeActivities(ACTIVITY_LIMIT * 4);
	const h = scopedHarness({
		scopes: [
			{ name: "activities", time_range: { since: "2026-01-31T11:45:00Z" } },
		],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.equal(calls.length, 1);
	assert.equal(h.records("activities").length, 16);
	assert.deepEqual(h.states("activities"), [
		{ version: 2, newest_timestamp: null },
	]);
	const wide = scopedHarness({
		scopes: [{ name: "activities" }],
		state: h.nextState(),
	});
	await collectMuseWith(wide.ctx, scopeActivities(ACTIVITY_LIMIT * 4).gateway);
	assert.equal(wide.records("activities").length, ACTIVITY_LIMIT * 4);
});

test("scope until: the activity walk starts at until, so nothing is withheld and the checkpoint commits", async () => {
	const { gateway, calls } = scopeActivities(40);
	const h = scopedHarness({
		scopes: [
			{ name: "activities", time_range: { until: "2026-01-31T11:50:00Z" } },
		],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.equal(calls[0]?.before, "2026-01-31T11:50:00Z");
	// 11:49 back to 11:21, one a minute.
	assert.equal(h.records("activities").length, 29);
	assert.ok(
		h
			.records("activities")
			.every((r) => String(r.timestamp) < "2026-01-31T11:50:00"),
	);
	// Nothing at or after until reached the gate: the STATE is not held.
	assert.deepEqual(h.states("activities"), [
		{ version: 2, newest_timestamp: null },
	]);
});

test("scope since and until: the activity walk is bounded on both sides", async () => {
	const { gateway, calls } = scopeActivities(ACTIVITY_LIMIT * 4);
	const h = scopedHarness({
		scopes: [
			{
				name: "activities",
				time_range: {
					since: "2026-01-31T11:30:00Z",
					until: "2026-01-31T11:50:00Z",
				},
			},
		],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.equal(calls[0]?.before, "2026-01-31T11:50:00Z");
	assert.equal(calls.length, 1);
	assert.equal(h.records("activities").length, 20);
	assert.equal(h.states("activities").length, 1);
});

test("scope resources: only the selected memory files are read", async () => {
	const { gateway, calls } = fakeGateway();
	const h = scopedHarness({
		scopes: [{ name: "memory_files", resources: ["USER.md"] }],
	});
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(
		calls.filter((c) => c.method === "fs.raw").map((c) => c.params.path),
		["USER.md"],
	);
	assert.deepEqual(
		h.records("memory_files").map((r) => r.id),
		["USER.md"],
	);
});

test("a failure no retry can fix carries a portable retry_on_connector_upgrade hint", async () => {
	const { gateway } = fakeGateway({
		"goals.list": () => {
			const g = fixture("goals-tracking");
			g.pagination = { has_next_page: true };
			return g;
		},
	});
	const h = scopedHarness({ scopes: [{ name: "goals" }] });
	await collectMuseWith(h.ctx, gateway);
	assert.deepEqual(
		h.failures.map((f) => [f.stream, f.hint]),
		[["goals", { action: "retry_on_connector_upgrade", retryable: false }]],
	);
});

test("a bot challenge asks for manual action", async () => {
	const page = {
		evaluate: async (script: string): Promise<unknown> => {
			const sandbox: Record<string, unknown> = {
				document: {
					body: {},
					title: "Just a moment...",
					querySelector: () => null,
					querySelectorAll: () => [],
				},
				location: { origin: "https://muse.ai" },
			};
			sandbox.window = sandbox;
			return await vm.runInContext(script, vm.createContext(sandbox));
		},
	};
	await assert.rejects(museReadiness(page, 1), (error: Error) => {
		const hint = (error as { recoveryHint?: unknown }).recoveryHint;
		assert.deepEqual(hint, {
			action: "manual_action_required",
			retryable: false,
		});
		return true;
	});
});

test("a file path longer than 1024 characters is a valid file record", () => {
	const path = `notes/${"a".repeat(2000)}.md`;
	const built = buildFileRecord({
		name: "a.md",
		path,
		size: 1,
		modified_ms: T0,
	});
	assert.ok(built);
	assert.equal(validateRecord("files", built.record).ok, true);
});

test("manifest: changing streams are mutable_state and no host network is claimed", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as {
		runtime_requirements: { bindings: Json };
		streams: Array<{
			name: string;
			semantics: string;
			consent_time_field?: string;
		}>;
	};
	const by = new Map(manifest.streams.map((s) => [s.name, s]));
	assert.equal(by.get("messages")?.semantics, "mutable_state");
	assert.equal(by.get("activities")?.semantics, "mutable_state");
	assert.equal(by.get("conversations")?.consent_time_field, "updated_at");
	// Every request goes through the page's own client (browser binding).
	assert.deepEqual(Object.keys(manifest.runtime_requirements.bindings), [
		"browser",
	]);
});

const OLD_CHAT_GAP: MuseCtx["detailGaps"] = [
	{
		gap_id: "g-old",
		status: "pending",
		stream: "messages",
		record_key: OLD_CHAT,
		detail_locator: { kind: "muse.chat_history", chat_id: OLD_CHAT },
	},
];

for (const [label, messages] of [
	["since", { time_range: { since: SINCE } }],
	["resources", { resources: [`${OLD_CHAT}:m-150`] }],
] as const) {
	for (const recoveryOnly of [true, false]) {
		test(`scope ${label}: a pending gap read under a partial scope stays open (${recoveryOnly ? "recovery-only" : "normal"} run)`, async () => {
			const h = scopedHarness({
				scopes: chatScopes({}, messages),
				detailGaps: OLD_CHAT_GAP,
				recoveryOnly,
			});
			await collectMuseWith(h.ctx, scopeGateway().gateway);
			assert.deepEqual(h.failures, []);
			assert.equal(
				h.emitted.filter((m) => m.type === "DETAIL_GAP_RECOVERED").length,
				0,
			);
			const gaps = h.emitted.filter((m) => m.type === "DETAIL_GAP") as Array<{
				record_key: unknown;
			}>;
			assert.deepEqual(
				gaps.map((g) => g.record_key),
				[OLD_CHAT],
			);
			const cov = h.emitted.find((m) => m.type === "DETAIL_COVERAGE") as {
				gap_keys?: unknown;
				hydrated_keys?: unknown[];
			};
			assert.deepEqual(cov.gap_keys, [OLD_CHAT]);
			assert.ok(!cov.hydrated_keys?.includes(OLD_CHAT));
		});
	}
}

test("scope: an unbounded recovery-only read still clears the pending gap", async () => {
	const h = scopedHarness({
		scopes: chatScopes(),
		detailGaps: OLD_CHAT_GAP,
		recoveryOnly: true,
	});
	await collectMuseWith(h.ctx, scopeGateway().gateway);
	assert.equal(
		h.emitted.filter((m) => m.type === "DETAIL_GAP_RECOVERED").length,
		1,
	);
	assert.equal(h.records("messages").length, 150);
});

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
import { MEMORY_FILE_NAMES } from "./parsers.ts";
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
		reportStreamFailure: async (stream, message) => {
			failures.push({ stream, message });
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
	return { ctx, emitted, failures, of, records, states };
}

test("a full run reads every stream through read methods only and follows the protocol", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness();
	await collectMuseWith(h.ctx, gateway);

	assert.deepEqual(h.failures, []);
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

	// Every stream with records ends with a STATE after its last record.
	for (const stream of ALL_STREAMS.filter((s) => s !== "messages")) {
		const state = h.of("STATE", stream);
		assert.equal(state.length, 1, stream);
		const lastRecord = Math.max(
			-1,
			...h.of("RECORD", stream).map((x) => x.index),
		);
		assert.ok((state[0]?.index ?? -1) > lastRecord, stream);
	}
	assert.ok((h.of("STATE", "conversations")[0]?.index ?? -1) > cov.index);
	assert.deepEqual(h.states("conversations")[0], {
		version: 2,
		chats: {
			[SIDE_CHAT]: { updated_at_ms: 1792610689000, transcript_revision: 31 },
			[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
		},
	});
	assert.deepEqual(h.states("activities")[0], {
		version: 1,
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
	assert.deepEqual(h.states("conversations")[0], {
		version: 2,
		chats: {
			[SIDE_CHAT]: { updated_at_ms: 1792610689000, transcript_revision: 31 },
			[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
		},
	});
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
	assert.deepEqual(h.states("conversations")[0], {
		version: 2,
		chats: {
			[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
		},
	});
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
				version: 2,
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
	const cov = h.of("DETAIL_COVERAGE", "messages")[0]?.m;
	assert.deepEqual(cov?.required_keys, [
		"11111111-1111-4111-8111-111111111111",
		MAIN_CHAT,
	]);
	assert.deepEqual(cov?.gap_keys, ["11111111-1111-4111-8111-111111111111"]);
	// Round 9: the gapped chat is absent from both fully read views and
	// sessions.get does not find it. Deletion is never inferred: its gap is
	// not resolved (no DETAIL_GAP_RECOVERED without a full history read), and
	// with no parent record nothing about it is emitted, so it stays pending.
	assert.ok(calls.some((c) => c.method === "sessions.get"));
	assert.equal(h.of("DETAIL_GAP_RECOVERED").length, 0);
	// Round 10: its still-failing gap is re-emitted and accounted for.
	assert.deepEqual(
		h.of("DETAIL_GAP").map((x) => [x.m.record_key, x.m.reason]),
		[["11111111-1111-4111-8111-111111111111", "temporary_unavailable"]],
	);
	assert.equal(
		calls.some(
			(c) =>
				c.method === "chat.history" &&
				c.params.session_id === "11111111-1111-4111-8111-111111111111",
		),
		false,
	);
	assert.deepEqual(h.failures, []);
	assert.deepEqual(h.states("conversations")[0], {
		version: 2,
		chats: {
			[SIDE_CHAT]: { updated_at_ms: 1792610689000, transcript_revision: 31 },
			[MAIN_CHAT]: { updated_at_ms: 1792612428000, transcript_revision: 31 },
		},
	});
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
		version: 1,
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
			activities: { version: 1, newest_timestamp: "2026-01-31T11:50:00.000Z" },
		},
	});
	await collectMuseWith(h.ctx, gateway);
	assert.equal(params.length, 1);
	assert.equal(
		h.states("activities")[0]?.newest_timestamp,
		"2026-01-31T12:00:00.000Z",
	);
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
	assert.deepEqual(params, [
		{ limit: 100 },
		{ limit: 100, cursor: "c1" },
		{ limit: 100, view: "archived" },
	]);
	assert.deepEqual(h.failures, []);
	// Deduplicated by session_id.
	assert.deepEqual(
		h.records("conversations").map((r) => r.id),
		SESSION_IDS,
	);
	assert.equal(h.states("conversations").length, 1);
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
	assert.deepEqual(h.failures, []);
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
		state: { conversations: { version: 2, chats: marks } },
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
	assert.deepEqual(
		((h.states("conversations")[0]?.chats ?? {}) as Json)[MAIN_CHAT],
		{
			updated_at_ms: 1792612428000,
			transcript_revision: 32,
		},
	);
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
				version: 2,
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
	assert.deepEqual(h.states("conversations")[0], { version: 2, chats: {} });
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
	assert.deepEqual(h.failures, []);
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
	assert.deepEqual(
		((h.states("conversations")[0]?.chats ?? {}) as Json)[SIDE_CHAT],
		{ updated_at_ms: 1792610689000, transcript_revision: 31 },
	);
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
	// Only the chat read in full is recovered; the absent one gets its gap
	// re-emitted (round 10) and is a required and gap key of the coverage.
	assert.deepEqual(
		h.of("DETAIL_GAP_RECOVERED").map((x) => x.m.gap_id),
		["g-side"],
	);
	const gaps = h.of("DETAIL_GAP", "messages");
	assert.deepEqual(
		gaps.map((x) => [x.m.record_key, (x.m.detail_locator as Json).kind]),
		[[absent, "muse.chat_history"]],
	);
	const covMsg = h.of("DETAIL_COVERAGE", "messages")[0];
	const cov = covMsg?.m;
	assert.ok((covMsg?.index ?? -1) > (gaps[0]?.index ?? Infinity));
	assert.ok((cov?.required_keys as string[]).includes(absent));
	assert.deepEqual(cov?.gap_keys, [absent]);
	assert.equal(h.states("conversations").length, 1);
});

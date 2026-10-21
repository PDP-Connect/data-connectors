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
	nextMessagesWatermark,
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
		version: 1,
		messages_read_through_ms: 1792612428000,
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
		version: 1,
		messages_read_through_ms: 1792612428000,
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
	// The watermark stays below the gapped chat (updated 1792610689000).
	assert.deepEqual(h.states("conversations")[0], {
		version: 1,
		messages_read_through_ms: null,
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
	const h = harness({ streams: ["messages"] });
	await collectMuseWith(h.ctx, gateway);
	assert.equal(n, 2);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.gap_keys, [
		SIDE_CHAT,
	]);
});

test("the next run reads only chats updated after the watermark, plus pending gaps", async () => {
	const { gateway, calls } = fakeGateway();
	const h = harness({
		streams: ["conversations", "messages"],
		state: {
			conversations: { version: 1, messages_read_through_ms: 1792610689000 },
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
			.map((c) => c.params.session_id),
		["11111111-1111-4111-8111-111111111111", MAIN_CHAT],
	);
	const cov = h.of("DETAIL_COVERAGE", "messages")[0]?.m;
	assert.deepEqual(cov?.required_keys, [
		"11111111-1111-4111-8111-111111111111",
		MAIN_CHAT,
	]);
	assert.deepEqual(
		h.states("conversations")[0]?.messages_read_through_ms,
		1792612428000,
	);
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
	assert.deepEqual(
		calls.map((c) => c.method),
		["chat.history"],
	);
	assert.deepEqual(h.of("DETAIL_COVERAGE", "messages")[0]?.m.hydrated_keys, [
		SIDE_CHAT,
	]);
	assert.equal(h.of("STATE").length, 0);
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
	assert.equal(params.length, 3);
	assert.deepEqual(params[0], {
		limit: 30,
		before: null,
		capabilities: ["ACTIVITY_FEED_GOALS", "ACTIVITY_FEED_PEER_CONVERSATIONS"],
	});
	// The oldest timestamp string, unchanged.
	assert.equal(params[1]?.before, "2026-01-31T11:31:00Z");
	assert.equal(params[2]?.before, "2026-01-31T11:26:00Z");
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
	assert.deepEqual(offsets, [0, LIBRARY_LIMIT]);
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

test("the watermark never passes a chat this run could not finish", () => {
	const chats = [
		{ id: "a", updatedMs: 10 },
		{ id: "b", updatedMs: 20 },
		{ id: "c", updatedMs: 30 },
	];
	assert.equal(
		nextMessagesWatermark(null, chats, new Set(["a", "b", "c"])),
		30,
	);
	assert.equal(nextMessagesWatermark(null, chats, new Set(["a", "c"])), 10);
	assert.equal(nextMessagesWatermark(5, chats, new Set(["b", "c"])), 5);
	assert.equal(nextMessagesWatermark(5, [], new Set()), 5);
	assert.equal(
		nextMessagesWatermark(5, [{ id: "x", updatedMs: null }], new Set()),
		5,
	);
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// START scope semantics for the Instinct collector: time_range (since, until,
// both), resources, the per-chat checkpoint under a bounded run, and the
// manifest claims that go with them. Records go through the runtime's own
// emitter (makeEmitRecord + withholdsBoundedProgress), so a test sees what
// the runtime would deliver and commit, not only what the collector emitted.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixturesDir } from "../../packages/polyfill-connectors/src/connector-paths.ts";
import {
	consentTimeFieldResolver,
	type EmittedMessage,
	makeEmitRecord,
	withholdsBoundedProgress,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type CollectInstinctArgs,
	collectInstinct,
	readChatCheckpoints,
	UNTIMED_STREAMS,
} from "./index.ts";
import {
	ceilEpochSeconds,
	chatReadPlan,
	nextCheckpoint,
	stopBelowSecond,
	vaultEntryRecords,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ChatEvent, InstinctGraphql } from "./types.ts";

const RUN_CLOCK = "2026-10-26T12:00:00.000Z";
const CHAT_A = "chat-01TESTMAINTESTTESTTESTTEST";
const CHAT_B = "chat-01TESTWHATSAPPTESTTESTTEST";
const T0 = 1_789_000_000;

function iso(seconds: number): string {
	return new Date(seconds * 1000).toISOString();
}

function event(id: string, createdAt: number): ChatEvent {
	return {
		createdAt,
		id,
		message: {
			attachments: [],
			content: `message ${id}`,
			id: `msg-${id}`,
			origin: null,
			readAt: null,
			role: "user",
		},
		type: "message",
	} as ChatEvent;
}

/** Chat A: 30 events 100 s apart (three windows of 10). Chat B: three. */
function defaultHistories(): Record<string, ChatEvent[]> {
	return {
		[CHAT_A]: Array.from({ length: 30 }, (_, index) =>
			event(`a-${String(index).padStart(2, "0")}`, T0 + index * 100),
		),
		[CHAT_B]: [
			event("b-0", T0 + 5),
			event("b-1", T0 + 1505),
			event("b-2", T0 + 2905),
		],
	};
}

const WINDOW = 10;

interface HistoryCall {
	readonly chatId: string;
	readonly cursor: string | null;
	readonly limit: number;
}

/**
 * Instinct's `chatHistory` as observed: the newest window first, each window
 * ascending, a cursor to the next older window, null at the start.
 */
function historyServer(
	histories: Readonly<Record<string, readonly ChatEvent[]>>,
	calls: HistoryCall[],
): (vars: Readonly<Record<string, unknown>>) => unknown {
	return (vars) => {
		const chatId = String(vars.chatId);
		const cursor = (vars.cursor as string | null | undefined) ?? null;
		const limit = Math.min(Number(vars.limit ?? WINDOW), WINDOW);
		calls.push({ chatId, cursor, limit });
		const events = histories[chatId];
		assert.ok(events, `unexpected chat ${chatId}`);
		const skip = cursor === null ? 0 : Number(cursor.replace("skip:", ""));
		const end = events.length - skip;
		const start = Math.max(0, end - limit);
		return {
			data: {
				chatHistory: {
					cursor: start === 0 ? null : `skip:${String(skip + (end - start))}`,
					events: events.slice(start, end),
				},
			},
		};
	};
}

async function fixture(name: string): Promise<unknown> {
	return JSON.parse(
		await readFile(join(fixturesDir("instinct"), `${name}.json`), "utf8"),
	) as unknown;
}

async function accountResponses(): Promise<Record<string, unknown>> {
	const names = {
		InstinctAgentContact: "agent-contact",
		InstinctChats: "chats",
		InstinctConnections: "connections",
		InstinctDevices: "devices",
		InstinctImessageDevice: "imessage-device",
		InstinctMessaging: "messaging",
		InstinctProfile: "profile",
		InstinctTrustedNetwork: "trusted-network",
		InstinctVault: "vault",
	};
	const entries = await Promise.all(
		Object.entries(names).map(
			async ([operation, file]) => [operation, await fixture(file)] as const,
		),
	);
	return Object.fromEntries(entries);
}

interface Scope {
	readonly resources?: string[];
	readonly time_range?: { since?: string; until?: string };
}

interface RecordMessage {
	readonly data: Record<string, unknown>;
	readonly stream: string;
	readonly type: "RECORD";
}

interface Run {
	readonly calls: string[];
	readonly failures: Array<{
		hint: { action: string; retryable?: boolean } | undefined;
		retryable: boolean | undefined;
		stream: string;
	}>;
	readonly history: HistoryCall[];
	/** Every protocol message after the runtime's bounded-progress hold. */
	readonly messages: Array<EmittedMessage & Record<string, unknown>>;
	/** RECORDs the runtime let through. */
	readonly records: RecordMessage[];
	/** START.state the runtime would hand the next run. */
	readonly nextState: Record<string, unknown>;
}

interface RunOptions {
	readonly detailGaps?: CollectInstinctArgs["detailGaps"];
	/** A chat whose every history read answers with a GraphQL error. */
	readonly failHistoryFor?: string;
	/** A chat whose newest window is empty but has a cursor to older ones. */
	readonly emptyFirstWindowFor?: string;
	readonly histories?: Readonly<Record<string, readonly ChatEvent[]>>;
	readonly overrides?: Readonly<Record<string, unknown>>;
	/** Skip the runtime: the collector's own messages, unfiltered. */
	readonly raw?: boolean;
	readonly scopes: Readonly<Record<string, Scope>>;
	readonly state?: Record<string, unknown>;
}

/**
 * One run through the runtime's emitter, as the PageShim host wires it: every
 * requested stream stays in `requested`, and the emitter drops what the scope
 * excludes and holds STATE after a record at or after `until`.
 */
async function run(options: RunOptions): Promise<Run> {
	const responses = {
		...(await accountResponses()),
		...options.overrides,
	};
	const history: HistoryCall[] = [];
	const serveHistory = historyServer(
		options.histories ?? defaultHistories(),
		history,
	);
	const calls: string[] = [];
	const graphql: InstinctGraphql = (query, vars = {}) => {
		const operation = /query Pdpp(\w+)/.exec(query)?.[1] ?? "";
		calls.push(operation);
		if (
			operation === "InstinctChatHistory" &&
			vars.chatId === options.failHistoryFor
		) {
			return Promise.resolve({
				json: { data: null, errors: [{ message: "internal server error" }] },
				status: 200,
			});
		}
		if (
			operation === "InstinctChatHistory" &&
			vars.chatId === options.emptyFirstWindowFor &&
			(vars.cursor ?? null) === null
		) {
			return Promise.resolve({
				json: { data: { chatHistory: { cursor: "skip:0", events: [] } } },
				status: 200,
			});
		}
		const json =
			operation === "InstinctChatHistory"
				? serveHistory(vars)
				: responses[operation];
		assert.ok(json !== undefined, `no answer wired for ${operation}`);
		return Promise.resolve({ json, status: 200 });
	};
	const requested = new Map(
		Object.entries(options.scopes).map(([name, scope]) => [
			name,
			{ name, ...scope },
		]),
	);
	const harness = makeRecordingEmit();
	const emitter = makeEmitRecord({
		emit: harness.emit,
		emittedAt: RUN_CLOCK,
		isTombstone: undefined,
		requested: requested as never,
		timeRangeFieldFor: consentTimeFieldResolver("instinct"),
		validateRecord,
	});
	const emit = (message: EmittedMessage): Promise<void> =>
		options.raw !== true &&
		withholdsBoundedProgress(message, emitter.withheldAtOrAfterUntil)
			? harness.emit({
					message: `${message.type} held`,
					stream: message.stream,
					type: "PROGRESS",
				})
			: harness.emit(message);
	const failures: Run["failures"] = [];
	await collectInstinct({
		detailGaps: options.detailGaps ?? [],
		emit,
		emitRecord:
			options.raw === true
				? async (stream, data) => {
						await harness.emit({
							data,
							emitted_at: RUN_CLOCK,
							key: String(data.id),
							stream,
							type: "RECORD",
						});
					}
				: emitter.emit,
		graphql,
		observedAt: RUN_CLOCK,
		progress: async () => {
			/* unused */
		},
		reportStreamFailure: (stream, message, failure = {}) => {
			failures.push({
				hint: failure.recoveryHint,
				retryable: failure.retryable,
				stream,
			});
			return harness.emit({
				message,
				reason: "stream_collection_failed",
				stream,
				type: "SKIP_RESULT",
			});
		},
		requested: new Set(requested.keys()),
		scopes: requested,
		state: options.state ?? {},
	});
	const messages = harness.protocolMessages as Run["messages"];
	const nextState = { ...(options.state ?? {}) };
	for (const message of messages) {
		if (message.type === "STATE") {
			nextState[message.stream] = message.cursor;
		}
	}
	return {
		calls,
		failures,
		history,
		messages,
		nextState,
		records: messages.filter(
			(message): message is RecordMessage & typeof message =>
				message.type === "RECORD",
		) as unknown as RecordMessage[],
	};
}

function ids(result: Run, stream: string): string[] {
	return result.records
		.filter((record) => record.stream === stream)
		.map((record) => String(record.data.id))
		.sort();
}

function historyCursors(result: Run, chatId: string): Array<string | null> {
	return result.history
		.filter((call) => call.chatId === chatId)
		.map((call) => call.cursor);
}

function chatMarks(state: Record<string, unknown>) {
	return readChatCheckpoints(state);
}

const CHATS_AND_EVENTS = (scope: Scope = {}, chats: Scope = {}) => ({
	chat_events: scope,
	chats,
});

/** Chat A events at or after `from` and before `to` (seconds). */
function chatAIds(from: number, to = Number.POSITIVE_INFINITY): string[] {
	return (defaultHistories()[CHAT_A] ?? [])
		.filter(
			(item) => Number(item.createdAt) >= from && Number(item.createdAt) < to,
		)
		.map((item) => item.id);
}

// ─── since ──────────────────────────────────────────────────────────────────

test("since is pushed down: paging stops at the first window older than it", async () => {
	// a-15 is at T0+1500, in the middle window (a-10..a-19).
	const since = iso(T0 + 1500);
	const result = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { since } }),
	});
	assert.deepEqual(historyCursors(result, CHAT_A), [null, "skip:10"]);
	assert.deepEqual(
		ids(result, "chat_events"),
		[...chatAIds(T0 + 1500), "b-1", "b-2"].sort(),
	);
	assert.deepEqual(chatMarks(result.nextState)[CHAT_A], {
		covered_since: T0 + 1500,
		newest_created_at: T0 + 2900,
		newest_ids: ["a-29"],
	});
});

test("an event in the since second on the next window is still read", async () => {
	const histories = defaultHistories();
	// a-19 (T0+1900) opens the middle window; put a twin of it, same second,
	// at the top of the oldest window.
	const chatA = histories[CHAT_A] ?? [];
	chatA.splice(9, 1, event("a-19-twin", T0 + 1900));
	chatA.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
	const result = await run({
		histories,
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 1900) } }),
	});
	assert.ok(ids(result, "chat_events").includes("a-19-twin"));
});

test("a fractional since rounds the checkpoint floor up to the next second", () => {
	assert.equal(ceilEpochSeconds("2026-09-10T00:00:00.000Z"), 1_788_998_400);
	assert.equal(ceilEpochSeconds("2026-09-10T00:00:00.0001Z"), 1_788_998_401);
	assert.equal(ceilEpochSeconds("2026-09-10T00:00:00+00:00"), 1_788_998_400);
	assert.equal(ceilEpochSeconds("not a time"), null);
	assert.equal(ceilEpochSeconds(undefined), null);
});

// ─── until ──────────────────────────────────────────────────────────────────

test("until: events at or after it are withheld and no checkpoint moves", async () => {
	const until = iso(T0 + 1000);
	const first = await run({ scopes: CHATS_AND_EVENTS() });
	const result = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { until } }),
		state: {},
	});
	assert.deepEqual(
		ids(result, "chat_events"),
		[...chatAIds(0, T0 + 1000), "b-0"].sort(),
	);
	// The runtime holds every STATE once a record at or after until was
	// withheld, so the next run starts from the prior state.
	assert.equal(
		result.messages.filter((message) => message.type === "STATE").length,
		0,
	);
	assert.deepEqual(result.nextState, {});
	assert.ok(chatMarks(first.nextState)[CHAT_A]);
});

test("until: the collector itself keeps the prior checkpoint, without the runtime's hold", async () => {
	const prior = (await run({ scopes: CHATS_AND_EVENTS() })).nextState;
	const histories = defaultHistories();
	histories[CHAT_A]?.push(event("a-new", T0 + 5000));
	const result = await run({
		histories,
		raw: true,
		scopes: CHATS_AND_EVENTS({ time_range: { until: iso(T0 + 4000) } }),
		state: prior,
	});
	assert.deepEqual(
		chatMarks(result.nextState)[CHAT_A],
		chatMarks(prior)[CHAT_A],
	);
});

test("since and until together: only the window is delivered, and STATE is held", async () => {
	const since = iso(T0 + 1050);
	const until = iso(T0 + 2000);
	const result = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { since, until } }),
	});
	assert.deepEqual(
		ids(result, "chat_events"),
		[...chatAIds(T0 + 1050, T0 + 2000), "b-1"].sort(),
	);
	// Paging still stops at since: the middle window holds a-10, older than
	// it, so the oldest window is never asked for.
	assert.deepEqual(historyCursors(result, CHAT_A), [null, "skip:10"]);
	assert.deepEqual(result.nextState, {});
});

test("since and until together with nothing at or after until: the checkpoint covers the window", async () => {
	const result = await run({
		scopes: CHATS_AND_EVENTS({
			time_range: { since: iso(T0 + 1000), until: iso(T0 + 9000) },
		}),
	});
	assert.deepEqual(chatMarks(result.nextState)[CHAT_A], {
		covered_since: T0 + 1000,
		newest_created_at: T0 + 2900,
		newest_ids: ["a-29"],
	});
});

// ─── narrow window, then wider ─────────────────────────────────────────────

test("a narrow window then a wider one, then none: every event is delivered exactly once", async () => {
	const narrow = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 2000) } }),
	});
	const wider = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 800) } }),
		state: narrow.nextState,
	});
	const all = await run({
		scopes: CHATS_AND_EVENTS(),
		state: wider.nextState,
	});
	const delivered = [
		...ids(narrow, "chat_events"),
		...ids(wider, "chat_events"),
		...ids(all, "chat_events"),
	];
	const everything = Object.values(defaultHistories())
		.flat()
		.map((item) => item.id);
	assert.deepEqual([...delivered].sort(), [...everything].sort());
	assert.equal(new Set(delivered).size, delivered.length, "no event twice");
	// The wider run read what the narrow one had left below its bound.
	assert.deepEqual(
		ids(wider, "chat_events"),
		[...chatAIds(T0 + 800, T0 + 2000), "b-1"].sort(),
	);
	assert.deepEqual(chatMarks(all.nextState)[CHAT_A], {
		covered_since: null,
		newest_created_at: T0 + 2900,
		newest_ids: ["a-29"],
	});
	// And a fourth, unbounded run has nothing left and stops on the first page.
	const again = await run({ scopes: CHATS_AND_EVENTS(), state: all.nextState });
	assert.deepEqual(ids(again, "chat_events"), []);
	assert.deepEqual(historyCursors(again, CHAT_A), [null]);
});

test("a narrow window then a wider one with new events above: both ends are read", async () => {
	const narrow = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 2500) } }),
	});
	const histories = defaultHistories();
	histories[CHAT_A]?.push(event("a-30", T0 + 3000), event("a-31", T0 + 3100));
	const wider = await run({
		histories,
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 2000) } }),
		state: narrow.nextState,
	});
	assert.deepEqual(
		ids(wider, "chat_events"),
		[...chatAIds(T0 + 2000, T0 + 2500), "a-30", "a-31"].sort(),
	);
});

test("a since later than the checkpoint's newest event does not lose the gap between them", async () => {
	const early = await run({
		scopes: CHATS_AND_EVENTS({ time_range: { until: iso(T0 + 9000) } }),
	});
	const histories = defaultHistories();
	histories[CHAT_A]?.push(
		event("a-mid", T0 + 3500),
		event("a-late", T0 + 4500),
	);
	const late = await run({
		histories,
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 4000) } }),
		state: early.nextState,
	});
	assert.deepEqual(ids(late, "chat_events"), ["a-late"]);
	const all = await run({
		histories,
		scopes: CHATS_AND_EVENTS(),
		state: late.nextState,
	});
	// The band below `since` could not stay joined to the new one (the
	// events between them were out of scope), so the unbounded run delivers
	// everything below it again: re-delivered by key, never lost.
	assert.ok(ids(all, "chat_events").includes("a-mid"));
	const delivered = new Set([
		...ids(early, "chat_events"),
		...ids(late, "chat_events"),
		...ids(all, "chat_events"),
	]);
	for (const item of Object.values(histories).flat()) {
		assert.ok(delivered.has(item.id), item.id);
	}
	assert.ok(!ids(all, "chat_events").includes("a-late"));
});

// ─── resources ─────────────────────────────────────────────────────────────

test("resources on chat_events: only the named events, and no checkpoint moves", async () => {
	const result = await run({
		scopes: CHATS_AND_EVENTS({ resources: ["a-03", "b-2"] }),
	});
	assert.deepEqual(ids(result, "chat_events"), ["a-03", "b-2"]);
	assert.deepEqual(chatMarks(result.nextState), {});
	// The next unfiltered run therefore still delivers everything.
	const all = await run({
		scopes: CHATS_AND_EVENTS(),
		state: result.nextState,
	});
	assert.equal(ids(all, "chat_events").length, 33);
});

test("resources on chat_events: a pending gap stays pending", async () => {
	const result = await run({
		detailGaps: [
			{
				detail_locator: { chat_id: CHAT_A, kind: "instinct.chat_history" },
				gap_id: "gap-1",
				parent_stream: "chats",
				record_key: CHAT_A,
				status: "pending",
				stream: "chat_events",
			},
		],
		scopes: CHATS_AND_EVENTS({ resources: ["a-03"] }),
	});
	assert.ok(
		!result.messages.some((message) => message.type === "DETAIL_GAP_RECOVERED"),
	);
});

test("a since-bounded walk leaves a pending gap pending; an unbounded one resolves it", async () => {
	const gaps = [
		{
			detail_locator: { chat_id: CHAT_A, kind: "instinct.chat_history" },
			gap_id: "gap-1",
			parent_stream: "chats",
			record_key: CHAT_A,
			status: "pending" as const,
			stream: "chat_events",
		},
	];
	const recovered = (result: Run): boolean =>
		result.messages.some(
			(message) =>
				message.type === "DETAIL_GAP_RECOVERED" && message.gap_id === "gap-1",
		);
	const bounded = await run({
		detailGaps: gaps,
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 + 1050) } }),
	});
	assert.equal(recovered(bounded), false);
	// A since below the whole history reads it to its start: resolved.
	const below = await run({
		detailGaps: gaps,
		scopes: CHATS_AND_EVENTS({ time_range: { since: iso(T0 - 10) } }),
	});
	assert.equal(recovered(below), true);
	const unbounded = await run({ detailGaps: gaps, scopes: CHATS_AND_EVENTS() });
	assert.equal(recovered(unbounded), true);
});

test("a newest window with an unreadable event time does not prove a chat's latest activity", async () => {
	const histories = defaultHistories();
	histories[CHAT_B]?.push({ ...event("b-x", 0), createdAt: null } as never);
	const bounded = await run({
		histories,
		scopes: { chats: { time_range: { since: iso(T0) } } },
	});
	assert.deepEqual(
		bounded.failures.map((failure) => failure.stream),
		["chats"],
	);
	assert.deepEqual(ids(bounded, "chats"), []);
});

test("an empty newest window with a cursor behind it does not prove an empty chat", async () => {
	const result = await run({
		overrides: {},
		scopes: { chats: { time_range: { since: iso(T0) } } },
		emptyFirstWindowFor: CHAT_B,
	});
	assert.deepEqual(
		result.failures.map((failure) => failure.stream),
		["chats"],
	);
});

test("resources on chats in a chats-only run: only the named chat's history is asked for", async () => {
	const result = await run({ scopes: { chats: { resources: [CHAT_B] } } });
	assert.deepEqual(ids(result, "chats"), [CHAT_B]);
	assert.deepEqual(
		result.history.map((call) => [call.chatId, call.limit]),
		[[CHAT_B, 1]],
	);
});

test("resources on agent_contact that leave it out: Instinct is not asked", async () => {
	const result = await run({ scopes: { agent_contact: { resources: ["x"] } } });
	assert.ok(!result.calls.includes("InstinctAgentContact"));
	const named = await run({
		scopes: { agent_contact: { resources: ["agent_contact"] } },
	});
	assert.deepEqual(ids(named, "agent_contact"), ["agent_contact"]);
});

// ─── account streams under a time range ────────────────────────────────────

test("streams with no source time are not read under a time range", async () => {
	const range = { time_range: { since: iso(T0) } };
	const result = await run({
		scopes: {
			agent_contact: range,
			connections: range,
			devices: range,
			profile: range,
			trusted_people: range,
			vault_entries: range,
		},
	});
	for (const operation of [
		"InstinctProfile",
		"InstinctAgentContact",
		"InstinctConnections",
		"InstinctVault",
	]) {
		assert.ok(!result.calls.includes(operation), operation);
	}
	const stated = result.messages
		.filter((message) => message.type === "STATE")
		.map((message) => message.stream)
		.sort();
	assert.deepEqual(stated, ["devices", "trusted_people"]);
	assert.deepEqual(result.failures, []);
});

test("devices and trusted people filter on their source created_at", async () => {
	const all = await run({ scopes: { devices: {}, trusted_people: {} } });
	const created = all.records
		.filter((record) => record.stream === "devices")
		.map((record) => String(record.data.created_at))
		.sort();
	assert.ok(created.length >= 2);
	const since = created.at(-1) ?? "";
	const bounded = await run({
		scopes: { devices: { time_range: { since } } },
	});
	assert.deepEqual(
		bounded.records.map((record) => record.data.created_at),
		[since],
	);
});

test("a profile read is not made when neither profile nor connections is requested", async () => {
	const result = await run({ scopes: { devices: {} } });
	assert.deepEqual(result.calls, ["InstinctDevices"]);
});

// ─── chats ─────────────────────────────────────────────────────────────────

test("chats carry their newest event time, and a time range selects chats by it", async () => {
	const all = await run({ scopes: { chats: {} } });
	const lastEvent = Object.fromEntries(
		all.records.map((record) => [record.data.id, record.data.last_event_at]),
	);
	assert.deepEqual(lastEvent, {
		[CHAT_A]: iso(T0 + 2900),
		[CHAT_B]: iso(T0 + 2905),
	});
	// A chats-only run asks each chat for its newest event only.
	assert.deepEqual(
		all.history.map((call) => call.limit),
		[1, 1],
	);
	const bounded = await run({
		scopes: { chats: { time_range: { since: iso(T0 + 2901) } } },
	});
	assert.deepEqual(ids(bounded, "chats"), [CHAT_B]);
});

test("under a time range, a chat whose latest activity is unknown fails chats instead of vanishing", async () => {
	const bounded = await run({
		failHistoryFor: CHAT_B,
		scopes: { chats: { time_range: { since: iso(T0) } } },
	});
	assert.deepEqual(
		bounded.failures.map((failure) => [failure.stream, failure.retryable]),
		[["chats", true]],
	);
	assert.deepEqual(ids(bounded, "chats"), []);
	const unbounded = await run({
		failHistoryFor: CHAT_B,
		scopes: { chats: {} },
	});
	assert.deepEqual(unbounded.failures, []);
	assert.deepEqual(ids(unbounded, "chats"), [CHAT_A, CHAT_B].sort());
	const chatB = unbounded.records.find((record) => record.data.id === CHAT_B);
	assert.equal(chatB?.data.last_event_at, null);
});

test("a checkpoint from 0.1.1 (no covered_since) is not trusted: the history is read again", async () => {
	const legacy = {
		chats: {
			chats: {
				[CHAT_A]: { newest_created_at: T0 + 2900, newest_ids: ["a-29"] },
			},
		},
	};
	assert.deepEqual(readChatCheckpoints(legacy), {});
	const result = await run({ scopes: CHATS_AND_EVENTS(), state: legacy });
	assert.equal(ids(result, "chat_events").length, 33);
});

// ─── checkpoint arithmetic ─────────────────────────────────────────────────

test("nextCheckpoint keeps the band only when it reaches down to the floor", () => {
	const plan = chatReadPlan({ time_range: { since: iso(T0 + 100) } });
	const band = {
		covered_since: T0 + 500,
		newest_created_at: T0 + 900,
		newest_ids: ["x"],
	};
	// Floor below the band: paging must go under the band, down to the floor.
	assert.equal(stopBelowSecond(band, plan), T0 + 100);
	const events = [
		event("p", T0 + 50),
		event("q", T0 + 100),
		event("r", T0 + 950),
	];
	assert.deepEqual(nextCheckpoint(band, events, plan, false), {
		covered_since: T0 + 100,
		newest_created_at: T0 + 950,
		newest_ids: ["r"],
	});
	// Floor inside the band: stop at the band's newest second.
	const inside = chatReadPlan({ time_range: { since: iso(T0 + 600) } });
	assert.equal(stopBelowSecond(band, inside), T0 + 900);
	assert.deepEqual(
		nextCheckpoint(band, [event("s", T0 + 990)], inside, false),
		{
			covered_since: T0 + 500,
			newest_created_at: T0 + 990,
			newest_ids: ["s"],
		},
	);
	// resources: never moves.
	const filtered = chatReadPlan({ resources: ["s"] });
	assert.equal(
		nextCheckpoint(band, [event("s", T0 + 990)], filtered, true),
		band,
	);
});

// ─── recovery hints, vault keys, manifest ──────────────────────────────────

test("an answer this connector cannot read asks for a connector upgrade", async () => {
	const result = await run({
		overrides: { InstinctDevices: { data: { devices: [{ id: 7 }] } } },
		scopes: { devices: {} },
	});
	assert.deepEqual(result.failures, [
		{
			hint: { action: "retry_on_connector_upgrade", retryable: false },
			retryable: false,
			stream: "devices",
		},
	]);
});

test("a full page of sent trust requests is not retriable", async () => {
	const trusted = (await fixture("trusted-network")) as {
		data: { trustedNetworkSentRequests: unknown[] };
	};
	trusted.data.trustedNetworkSentRequests = Array.from(
		{ length: 20 },
		(_, index) => ({
			createdAt: T0,
			expiresAt: null,
			id: `sent-${String(index)}`,
			phoneNumber: "+15555550100",
		}),
	);
	const result = await run({
		overrides: { InstinctTrustedNetwork: trusted },
		scopes: { trusted_people: {} },
	});
	assert.deepEqual(result.failures[0]?.hint, {
		action: "not_retriable",
		retryable: false,
	});
});

test("a retryable failure keeps the runtime's default hint", async () => {
	const result = await run({
		overrides: { InstinctDevices: { data: { devices: null } } },
		scopes: { devices: {} },
	});
	assert.deepEqual(result.failures, [
		{ hint: undefined, retryable: true, stream: "devices" },
	]);
});

test("two vault entries of one kind with the same label (or none) keep distinct keys", async () => {
	const records = vaultEntryRecords({
		data: {
			vaultEntries: [
				{ fields: [], isAgentEntry: false, kind: "login", name: null },
				{ fields: [], isAgentEntry: false, kind: "login", name: "  " },
				{ fields: [], isAgentEntry: true, kind: "login", name: "Work" },
				{ fields: [], isAgentEntry: true, kind: "login", name: "Work" },
			],
			vaultKinds: [],
		},
	} as never);
	assert.deepEqual(
		records.map((record) => record.id),
		["login:unnamed", "login:unnamed#2", "login:Work", "login:Work#2"],
	);
	const vault = (await fixture("vault")) as {
		data: { vaultEntries: Array<Record<string, unknown>> };
	};
	const first = vault.data.vaultEntries[0];
	assert.ok(first);
	vault.data.vaultEntries.push({ ...first });
	const result = await run({
		overrides: { InstinctVault: vault },
		scopes: { vault_entries: {} },
	});
	assert.deepEqual(result.failures, []);
	assert.equal(ids(result, "vault_entries").length, 3);
});

interface ManifestStream {
	readonly consent_time_field?: string;
	readonly cursor_field?: string;
	readonly incremental?: boolean;
	readonly name: string;
	readonly query?: { range_filters?: Record<string, unknown> };
	readonly schema: { properties: Record<string, { description?: string }> };
	readonly semantics: string;
}

async function manifest(): Promise<{
	reason_display_messages: Record<string, string>;
	streams: ManifestStream[];
}> {
	return JSON.parse(
		await readFile(new URL("./manifest.json", import.meta.url), "utf8"),
	) as never;
}

test("manifest: no stream filters, orders or checkpoints on the run clock", async () => {
	const { streams } = await manifest();
	for (const stream of streams) {
		assert.notEqual(stream.consent_time_field, "observed_at", stream.name);
		assert.notEqual(stream.cursor_field, "observed_at", stream.name);
		assert.equal(
			stream.query?.range_filters?.observed_at,
			undefined,
			stream.name,
		);
	}
	const untimed = streams
		.filter((stream) => stream.consent_time_field === undefined)
		.map((stream) => stream.name)
		.sort();
	assert.deepEqual(untimed, [...UNTIMED_STREAMS].sort());
});

test("manifest: only streams whose STATE is read claim incremental", async () => {
	const { streams } = await manifest();
	const incremental = streams
		.filter((stream) => stream.incremental === true)
		.map((stream) => stream.name)
		.sort();
	assert.deepEqual(incremental, ["chat_events", "chats"]);
});

test("manifest: chat events can change after collection, so they are mutable state", async () => {
	const { streams } = await manifest();
	const events = streams.find((stream) => stream.name === "chat_events");
	assert.equal(events?.semantics, "mutable_state");
	assert.ok(
		!streams.some((stream) => stream.semantics === "append_only"),
		"no Instinct stream is immutable",
	);
});

test("manifest: owner copy for every reason this connector or its runtime emits", async () => {
	const { reason_display_messages: reasons } = await manifest();
	assert.ok(reasons.stream_collection_failed);
	assert.ok(reasons.scope_not_supported);
	assert.equal(reasons.not_available, undefined, "never emitted");
});

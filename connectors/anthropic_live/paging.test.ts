// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The conversation list is paged by offset while the owner can delete,
// update and create conversations. These tests change the list between page
// reads, carry each run's STATE into the next run, and assert which records
// were collected once the list stops changing. They do not assert request
// patterns: a correct connector may read the list in any order it likes.

import assert from "node:assert/strict";
import test from "node:test";
import {
	collectAnthropicLive,
	ensureAnthropicLiveSession,
	MAX_CONVERSATIONS_PER_RUN,
	probeAnthropicLiveSession,
} from "./index.ts";
import {
	type Conv,
	conv,
	type HarnessOptions,
	harness,
	O,
	ORG,
	type Route,
	stampMessage,
	uuid,
} from "./test-support.ts";

const CHAT = ["conversations", "messages"];

/** n conversations updated one second apart; each answer at its update. */
function backlog(n: number, first = 1): Conv[] {
	return Array.from({ length: n }, (_, i) => {
		const c = conv(first + i, 0);
		c.updated_at = new Date(Date.UTC(2026, 0, 15, 9, 0, i)).toISOString();
		stampMessage(c, 1, c.updated_at);
		return c;
	});
}

/** Newest change first, as claude.ai lists them. */
function newest(convs: Conv[]): Conv[] {
	return [...convs].sort(
		(a, b) =>
			b.updated_at.localeCompare(a.updated_at) || b.uuid.localeCompare(a.uuid),
	);
}

function remove(convs: Conv[], c: Conv | undefined): void {
	assert.ok(c);
	convs.splice(convs.indexOf(c), 1);
}

/** The owner adds a message at `time`, which moves `c` to the front. */
function reply(c: Conv | undefined, time: string): void {
	assert.ok(c);
	const n = Number(c.uuid.slice(-12));
	c.chat_messages.push({
		uuid: uuid(n * 1000 + 3),
		text: "",
		content: [{ type: "text", text: "follow-up" }],
		sender: "human",
		created_at: time,
		updated_at: time,
		attachments: [],
		parent_message_uuid: uuid(n * 1000 + 2),
	});
	c.updated_at = time;
}

/** Calls `onList(offset, listCall)` before each list page is served. */
function onListPage(onList: (offset: number, call: number) => void): Route {
	let call = 0;
	return (url) => {
		if (url.pathname === `${O}/chat_conversations`) {
			onList(Number(url.searchParams.get("offset")), call++);
		}
		return undefined;
	};
}

interface Sync {
	state: Record<string, unknown>;
	ids: Record<string, Set<string>>;
	records: Record<string, Map<string, Record<string, unknown>>>;
	runs: Array<ReturnType<typeof harness>>;
}

/**
 * Run the connector again and again, carrying STATE, until a run during which
 * the list did not change neither fails nor defers a backlog. `routeFor(run)`
 * changes the list during runs.
 */
async function syncUntilSettled(
	convs: Conv[],
	options: {
		streams?: string[];
		scopes?: HarnessOptions["scopes"];
		state?: Record<string, unknown>;
		routeFor?: (run: number) => Route | undefined;
		maxRuns?: number;
	} = {},
): Promise<Sync> {
	const streams = options.streams ?? CHAT;
	const sync: Sync = {
		state: options.state ?? {},
		ids: Object.fromEntries(streams.map((s) => [s, new Set<string>()])),
		records: Object.fromEntries(streams.map((s) => [s, new Map()])),
		runs: [],
	};
	for (let run = 0; run < (options.maxRuns ?? 8); run++) {
		const route = options.routeFor?.(run);
		const h = harness(convs, {
			streams,
			runtime: true,
			state: sync.state,
			...(options.scopes ? { scopes: options.scopes } : {}),
			...(route ? { route } : {}),
		});
		const before = JSON.stringify(convs);
		await collectAnthropicLive(h.ctx);
		const mutated = JSON.stringify(convs) !== before;
		sync.runs.push(h);
		for (const stream of streams) {
			for (const data of h.of(stream)) {
				sync.ids[stream]?.add(String(data.id));
				sync.records[stream]?.set(String(data.id), data);
			}
			for (const cursor of h.states(stream)) assertSmallCursor(cursor);
		}
		sync.state = h.nextState();
		const deferred = h
			.skips()
			.some((s) => s.reason === "anthropic_live_backlog_deferred");
		if (h.failures.length === 0 && !deferred && !mutated) return sync;
	}
	assert.fail("the connector did not settle");
}

/** STATE stays a fixed-size frontier: no per-conversation ledger. */
function assertSmallCursor(cursor: Record<string, unknown>): void {
	const text = JSON.stringify(cursor);
	assert.ok(text.length < 1000, text);
	assert.doesNotMatch(
		text,
		/question|answer|follow-up|private|content|cookie|token/,
	);
	assert.ok(
		Object.keys(cursor).every((k) =>
			[
				"version",
				"organization_id",
				"scope",
				"read_through",
				"emitted_through",
			].includes(k),
		),
	);
}

function messageIds(convs: Conv[]): string[] {
	return convs.flatMap((c) => c.chat_messages.map((m) => String(m.uuid)));
}

function assertCollected(sync: Sync, convs: Conv[], streams = CHAT): void {
	if (streams.includes("conversations")) {
		const missing = convs
			.map((c) => c.uuid)
			.filter((id) => !sync.ids.conversations?.has(id));
		assert.deepEqual(missing, [], "conversations never collected");
	}
	if (streams.includes("messages")) {
		const missing = messageIds(convs).filter(
			(id) => !sync.ids.messages?.has(id),
		);
		assert.deepEqual(missing, [], "messages never collected");
	}
}

test("a conversation deleted between list pages does not hide an older conversation", async () => {
	// Not the front entry: only the overlap between pages shows the shift.
	const convs = backlog(60);
	let deleted = false;
	const sync = await syncUntilSettled(convs, {
		routeFor: () =>
			onListPage((offset) => {
				if (offset > 0 && !deleted) {
					deleted = true;
					remove(convs, newest(convs)[10]);
				}
			}),
	});
	assert.ok(deleted);
	assertCollected(sync, convs);
	// The list stopped changing: a further run collects nothing new.
	const settled = await syncUntilSettled(convs, { state: sync.state });
	assert.equal(settled.ids.messages?.size, 0);
});

test("an unread conversation moved to the front mid-listing keeps its older messages", async () => {
	// One deletion ahead of the page boundary and one update from behind it
	// leave the boundary entry at the same offset; only the list's new front
	// shows the change.
	const convs = backlog(120);
	const moved = convs[5];
	let changed = false;
	const sync = await syncUntilSettled(convs, {
		routeFor: () =>
			onListPage((offset) => {
				if (offset > 0 && !changed) {
					changed = true;
					remove(convs, newest(convs)[0]);
					reply(moved, "2026-01-15T10:00:00.000000Z");
				}
			}),
	});
	assert.ok(changed);
	assertCollected(sync, convs);
	assert.ok(
		sync.ids.messages?.has(uuid(6 * 1000 + 1)),
		"old question of moved",
	);
});

test("a list that keeps changing fails without a checkpoint, then recovers once it settles", async () => {
	const convs = backlog(150);
	let changing = true;
	let deletions = 0;
	const route = onListPage((offset) => {
		if (changing && offset > 0) {
			deletions += 1;
			remove(convs, newest(convs)[10]);
		}
	});
	const h = harness(convs, { streams: CHAT, runtime: true, route });
	await collectAnthropicLive(h.ctx);
	assert.ok(deletions > 0);
	assert.deepEqual(h.of("conversations"), []);
	assert.deepEqual(h.of("messages"), []);
	assert.deepEqual(h.states("conversations"), []);
	assert.deepEqual(h.states("messages"), []);
	assert.deepEqual(h.failures, [
		{ stream: "conversations", retryable: true },
		{ stream: "messages", retryable: true },
	]);
	// Bounded: a few listing attempts, not a loop.
	const listCalls = h.calls.filter((c) => c.includes("/chat_conversations?"));
	assert.ok(listCalls.length <= 3 * 5, `${listCalls.length} list reads`);

	changing = false;
	const sync = await syncUntilSettled(convs, { state: h.nextState() });
	assertCollected(sync, convs);
});

test("a backlog over the cap, changed during every run, is collected across runs", async () => {
	const total = MAX_CONVERSATIONS_PER_RUN + 60;
	const convs = backlog(total);
	const edited = convs[3];
	const created = conv(9000, 0);
	created.updated_at = "2026-01-15T11:00:00.000000Z";
	stampMessage(created, 1, created.updated_at);
	const sync = await syncUntilSettled(convs, {
		routeFor: (run) =>
			onListPage((offset, call) => {
				if (offset === 0 || call > 2) return;
				if (run === 0 && call === 1) {
					// A newer conversation is deleted; an unread old one is
					// answered, then its first answer is edited.
					remove(convs, newest(convs)[10]);
					reply(convs[total - 100], "2026-01-15T10:00:00.000000Z");
				}
				if (run === 1 && call === 1) {
					remove(convs, newest(convs)[3]);
					convs.push(created);
					const answer = edited?.chat_messages[1];
					assert.ok(edited && answer);
					answer.content = [{ type: "text", text: "edited answer" }];
					answer.updated_at = "2026-01-15T10:30:00.000000Z";
					edited.updated_at = "2026-01-15T10:30:00.000000Z";
				}
			}),
	});
	assert.ok(sync.runs.length >= 2, "the cap spreads the backlog over runs");
	assertCollected(sync, convs);
	assert.ok(sync.ids.messages?.has(created.chat_messages[0]?.uuid as string));
	const answer = sync.records.messages?.get(uuid(4 * 1000 + 2));
	assert.match(JSON.stringify(answer), /edited answer/);
});

test("conversations that share an update time across a page boundary survive a deletion", async () => {
	const convs = backlog(120);
	for (const c of convs) {
		c.updated_at = "2026-01-15T09:30:00.123456Z";
		stampMessage(c, 1, c.updated_at);
	}
	let deleted = false;
	const sync = await syncUntilSettled(convs, {
		routeFor: () =>
			onListPage((offset) => {
				if (offset > 0 && !deleted) {
					deleted = true;
					remove(convs, newest(convs)[10]);
				}
			}),
	});
	assert.ok(deleted);
	assertCollected(sync, convs);
});

test("an interrupted detail read and a list deletion still finish every message", async () => {
	const convs = backlog(110);
	let deleted = false;
	let failed = false;
	const sync = await syncUntilSettled(convs, {
		routeFor: (run) => (url) => {
			if (url.pathname === `${O}/chat_conversations`) {
				if (Number(url.searchParams.get("offset")) > 0 && !deleted) {
					deleted = true;
					remove(convs, newest(convs)[10]);
				}
				return undefined;
			}
			if (run === 0 && !failed && url.pathname.endsWith(uuid(40))) {
				failed = true;
				return { status: 500 };
			}
			return undefined;
		},
	});
	assert.ok(deleted && failed);
	assertCollected(sync, convs);
});

test("a multi-page incremental run after a completed sync survives a deletion", async () => {
	const convs = backlog(150);
	const first = await syncUntilSettled(convs);
	assertCollected(first, convs);
	// The owner answers 70 old conversations, so the next run lists two pages.
	const answered = convs.slice(0, 70);
	for (const [i, c] of answered.entries()) {
		reply(c, new Date(Date.UTC(2026, 0, 15, 12, 0, i)).toISOString());
	}
	let deleted = false;
	const sync = await syncUntilSettled(convs, {
		state: first.state,
		routeFor: () =>
			onListPage((offset) => {
				if (offset > 0 && !deleted) {
					deleted = true;
					remove(convs, newest(convs)[10]);
				}
			}),
	});
	assert.ok(deleted);
	const replies = answered
		.filter((c) => convs.includes(c))
		.map((c) => String(c.chat_messages[2]?.uuid));
	assert.equal(replies.length, 69);
	assert.deepEqual(
		replies.filter((id) => !sync.ids.messages?.has(id)),
		[],
	);
});

test("messages alone, in a window, survive a deletion; conversations alone too", async () => {
	const windows = {
		messages: "2026-01-15T09:00:30.000000Z",
		conversations: "2026-01-15T08:00:00.000000Z",
	};
	for (const [stream, since] of Object.entries(windows)) {
		const convs = backlog(100);
		let deleted = false;
		const sync = await syncUntilSettled(convs, {
			streams: [stream],
			scopes: { [stream]: { time_range: { since } } },
			routeFor: () =>
				onListPage((offset) => {
					if (offset > 0 && !deleted) {
						deleted = true;
						remove(convs, newest(convs)[10]);
					}
				}),
		});
		assert.ok(deleted);
		const expected =
			stream === "messages"
				? // Answers created at or after `since`; the 09:00 questions are out.
					convs
						.map(
							(c) => c.chat_messages[1] as { uuid: string; created_at: string },
						)
						.filter((m) => m.created_at >= since)
						.map((m) => m.uuid)
				: convs.map((c) => c.uuid);
		assert.ok(expected.length > 50);
		assert.deepEqual([...(sync.ids[stream] ?? [])].sort(), expected.sort());
	}
});

test("a 0.1 checkpoint migrates while the list changes", async () => {
	const convs = backlog(80);
	let deleted = false;
	const sync = await syncUntilSettled(convs, {
		state: {
			conversations: { update_time: "2026-01-15T09:00:50.000Z", since: null },
			messages: { update_time: "2026-01-15T09:00:50.000Z", since: null },
		},
		routeFor: () =>
			onListPage((offset) => {
				if (offset > 0 && !deleted) {
					deleted = true;
					remove(convs, newest(convs)[10]);
				}
			}),
	});
	assert.ok(deleted);
	assertCollected(sync, convs);
});

test("a deletion plus a reorder within equal update times hides no conversation", async () => {
	// Equal update times may come back in any order. Between pages, 90 (read)
	// is deleted and 20 (unread) moves to position 1: the page boundary and
	// the front entry are unchanged, and the first read misses 20.
	const convs = Array.from({ length: 100 }, (_, i) => conv(i + 1, 1));
	let order = [...convs].reverse();
	let changed = false;
	const sync = await syncUntilSettled(convs, {
		routeFor: () => (url) => {
			if (url.pathname !== `${O}/chat_conversations`) return undefined;
			const offset = Number(url.searchParams.get("offset"));
			const limit = Number(url.searchParams.get("limit"));
			if (offset > 0 && !changed) {
				changed = true;
				const deleted = convs.find((c) => c.uuid === uuid(90));
				remove(convs, deleted);
				order = order.filter((c) => c !== deleted);
				const moved = order.find((c) => c.uuid === uuid(20));
				assert.ok(moved);
				order = order.filter((c) => c !== moved);
				order.splice(1, 0, moved);
			}
			return {
				status: 200,
				body: order
					.slice(offset, offset + limit)
					.map(({ chat_messages: _m, org: _o, ...c }) => c),
			};
		},
	});
	assert.ok(changed);
	assertCollected(sync, convs);
	assert.equal(sync.ids.messages?.size, 198);
});

test("a list whose equal update times come back in a different order per page fails instead of skipping", async () => {
	// A provider that orders ties differently for each offset: every read
	// gives the same pages, which list 7 twice and never list 70.
	const convs = Array.from({ length: 100 }, (_, i) => conv(i + 1, 1));
	const byOffset = (offset: number) => {
		const order = [...convs];
		if (offset > 0) {
			const seventy = order.splice(69, 1)[0];
			assert.ok(seventy);
			order.splice(0, 0, seventy);
			const seven = order.find((c) => c.uuid === uuid(7));
			assert.ok(seven);
			order.splice(order.indexOf(seven), 1);
			order.splice(60, 0, seven);
		}
		return order;
	};
	const route: Route = (url) => {
		if (url.pathname !== `${O}/chat_conversations`) return undefined;
		const offset = Number(url.searchParams.get("offset"));
		const limit = Number(url.searchParams.get("limit"));
		return {
			status: 200,
			body: byOffset(offset)
				.slice(offset, offset + limit)
				.map(({ chat_messages: _m, org: _o, ...c }) => c),
		};
	};
	let state: Record<string, unknown> = {};
	for (let run = 0; run < 3; run++) {
		const h = harness(convs, { streams: CHAT, runtime: true, state, route });
		await collectAnthropicLive(h.ctx);
		assert.deepEqual(h.of("messages"), []);
		assert.deepEqual(h.states("conversations"), []);
		assert.deepEqual(h.states("messages"), []);
		assert.deepEqual(h.failures, [
			{ stream: "conversations", retryable: true },
			{ stream: "messages", retryable: true },
		]);
		state = h.nextState();
	}
});

test("a later page that lists a conversation newer than the first page is not trusted", async () => {
	// Every read returns the same pages: 99..50, then 100 (the newest) with
	// 49..2, the end. Read as one list, 1 would be skipped.
	const convs = backlog(100);
	const byId = (n: number) => convs.find((c) => c.uuid === uuid(n));
	const pages: Record<number, (Conv | undefined)[]> = {
		0: Array.from({ length: 50 }, (_, i) => byId(99 - i)),
		50: [byId(100), ...Array.from({ length: 48 }, (_, i) => byId(49 - i))],
		100: [],
	};
	const route: Route = (url) => {
		if (url.pathname !== `${O}/chat_conversations`) return undefined;
		const page = pages[Number(url.searchParams.get("offset"))] ?? [];
		return {
			status: 200,
			body: page.map((c) => {
				assert.ok(c);
				const { chat_messages: _m, org: _o, ...item } = c;
				return item;
			}),
		};
	};
	const h = harness(convs, { streams: CHAT, runtime: true, route });
	await collectAnthropicLive(h.ctx);
	assert.equal(pages[50]?.includes(byId(1)), false);
	assert.deepEqual(h.of("messages"), []);
	assert.deepEqual(h.states("messages"), []);
	assert.deepEqual(h.failures, [
		{ stream: "conversations", retryable: true },
		{ stream: "messages", retryable: true },
	]);
});

test("a version 2 checkpoint, which can sit past a missed conversation, is read again", async () => {
	const convs = backlog(60);
	// A 0.2.0 run that missed 20 checkpointed past it.
	const v2 = (stream: string) => ({
		version: 2,
		organization_id: ORG,
		scope: { since: null, until: null, resources: null, fields: null },
		read_through: { update_time: convs[59]?.updated_at, id: uuid(60) },
		...(stream === "messages"
			? { emitted_through: convs[59]?.updated_at }
			: {}),
	});
	const sync = await syncUntilSettled(convs, {
		state: { conversations: v2("conversations"), messages: v2("messages") },
	});
	assert.ok(sync.ids.messages?.has(uuid(20_001)));
	assertCollected(sync, convs);
	const runs = sync.runs;
	assert.equal(runs.at(-1)?.states("messages").at(-1)?.version, 3);
});

test("an organizations outage during the session check is a retryable failure, not a sign-in", async () => {
	const visits: string[] = [];
	let assists = 0;
	const page = {
		goto: async (url: string) => {
			visits.push(url);
		},
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const savedFetch = globalThis.fetch;
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: "https://claude.ai" },
			});
			globalThis.fetch = (async () => ({
				status: 503,
				json: async () => ({ error: "unavailable" }),
			})) as unknown as typeof fetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = savedFetch;
				Reflect.deleteProperty(globalThis, "location");
			}
		},
	};
	assert.equal(await probeAnthropicLiveSession({ page } as never), false);
	await assert.rejects(
		ensureAnthropicLiveSession({
			assist: () => {
				assists += 1;
				throw new Error("sign-in assistance must not be requested");
			},
			completeAssistance: async () => undefined,
			page: page as never,
			sendInteraction: async () => ({}) as never,
		} as never),
		(error: Error) => {
			assert.match(
				error.message,
				/ECONN|fetch failed|anthropic_live_(?:list|organizations)_failed: http (?:0|429|5\d\d)/i,
			);
			return true;
		},
	);
	assert.equal(assists, 0);
	assert.deepEqual(visits, []);
});

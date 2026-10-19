// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Resume, checkpoint, scope and session regressions. Each run carries only the
// STATE the previous run emitted. The provider is synthetic (test-support.ts).

import assert from "node:assert/strict";
import test from "node:test";
import type {
	AssistanceRequest,
	InteractionRequest,
} from "@pdpp/connector-protocol";
import { establishSession } from "../../packages/polyfill-connectors/src/session-establish.ts";
import {
	collectAnthropicLive,
	ensureAnthropicLiveSession,
	MAX_CONVERSATIONS_PER_RUN,
	probeAnthropicLiveSession,
} from "./index.ts";
import {
	at,
	type Conv,
	conv,
	harness,
	O,
	ORG,
	ORGS,
	stampMessage,
	uuid,
} from "./test-support.ts";

const CHAT = ["conversations", "messages"];

/** n conversations with distinct update times, each with an old question. */
function backlog(n: number): Conv[] {
	return Array.from({ length: n }, (_, i) => {
		const c = conv(i + 1, 0);
		c.updated_at = new Date(Date.UTC(2026, 0, 15, 9, 0, i)).toISOString();
		stampMessage(c, 1, c.updated_at);
		return c;
	});
}

test("a resumed run keeps the unread history of a conversation that failed after the cursor moved", async () => {
	const a = conv(1, 10);
	const b = conv(2, 20);
	stampMessage(b, 0, at(5));
	const first = harness([a, b], {
		streams: CHAT,
		route: (url) =>
			url.pathname.endsWith(uuid(2)) ? { status: 503 } : undefined,
	});
	await collectAnthropicLive(first.ctx);
	assert.deepEqual(first.ids("conversations"), [uuid(1)]);
	assert.deepEqual(first.failures, [
		{ stream: "conversations", retryable: true },
		{ stream: "messages", retryable: true },
	]);

	const resumed = harness([a, b], { streams: CHAT, state: first.nextState() });
	await collectAnthropicLive(resumed.ctx);
	assert.deepEqual(resumed.detailReads(), [uuid(2)]);
	// B's 09:05 question is older than A's 09:10 update and was never read.
	assert.deepEqual(resumed.ids("messages"), [uuid(2001), uuid(2002)]);
});

test("a backlog over the per-run cap is finished on the next run with every message", async () => {
	const convs = backlog(MAX_CONVERSATIONS_PER_RUN + 1);
	const first = harness(convs, { streams: CHAT });
	await collectAnthropicLive(first.ctx);
	assert.equal(first.ids("conversations").length, MAX_CONVERSATIONS_PER_RUN);
	assert.equal(first.skips()[0]?.reason, "anthropic_live_backlog_deferred");

	const next = harness(convs, { streams: CHAT, state: first.nextState() });
	await collectAnthropicLive(next.ctx);
	const last = MAX_CONVERSATIONS_PER_RUN + 1;
	assert.deepEqual(next.detailReads(), [uuid(last)]);
	assert.deepEqual(next.ids("messages"), [
		uuid(last * 1000 + 1),
		uuid(last * 1000 + 2),
	]);
	assert.deepEqual(next.skips(), []);
});

test("conversations that share an update time are all read across capped runs", async () => {
	const convs = Array.from({ length: MAX_CONVERSATIONS_PER_RUN + 1 }, (_, i) =>
		conv(i + 1, 10),
	);
	const seen = new Set<string>();
	let state: Record<string, unknown> = {};
	for (let run = 0; run < 3; run++) {
		const h = harness(convs, { streams: CHAT, state });
		await collectAnthropicLive(h.ctx);
		for (const id of h.ids("conversations")) seen.add(id);
		state = h.nextState();
	}
	assert.equal(seen.size, convs.length);

	const settled = harness(convs, { streams: CHAT, state });
	await collectAnthropicLive(settled.ctx);
	assert.deepEqual(settled.detailReads(), []);
});

test("update times that differ below a millisecond stay distinct", async () => {
	const early = conv(1, 10);
	early.updated_at = "2026-01-15T09:10:00.000100Z";
	const other = conv(2, 5);
	const first = harness([early, other], { streams: CHAT });
	await collectAnthropicLive(first.ctx);
	assert.deepEqual(first.ids("conversations"), [uuid(2), uuid(1)]);

	// The other conversation gets a message 800 microseconds after the
	// checkpoint, in the same millisecond.
	const changed = conv(2, 5);
	changed.updated_at = "2026-01-15T09:10:00.000900Z";
	changed.chat_messages.push({
		uuid: uuid(2003),
		text: "same millisecond",
		sender: "human",
		created_at: changed.updated_at,
		updated_at: changed.updated_at,
		parent_message_uuid: uuid(2002),
	});
	const next = harness([early, changed], {
		streams: CHAT,
		state: first.nextState(),
	});
	await collectAnthropicLive(next.ctx);
	assert.deepEqual(next.ids("conversations"), [uuid(2)]);
	assert.deepEqual(next.ids("messages"), [uuid(2003)]);
});

test("an HTTP 200 detail without a message array fails instead of reading as empty", async () => {
	const x = conv(1, 10);
	const y = conv(2, 20);
	y.chat_messages = [];
	const broken = harness([x, y], {
		streams: CHAT,
		route: (url) =>
			url.pathname.endsWith(uuid(1))
				? { status: 200, body: { uuid: uuid(1), updated_at: at(10) } }
				: undefined,
	});
	await collectAnthropicLive(broken.ctx);
	assert.deepEqual(broken.of("conversations"), []);
	assert.deepEqual(broken.states("conversations"), []);
	assert.deepEqual(broken.states("messages"), []);
	assert.deepEqual(broken.failures, [
		{ stream: "conversations", retryable: true },
		{ stream: "messages", retryable: true },
	]);

	const fixed = harness([x, y], { streams: CHAT, state: broken.nextState() });
	await collectAnthropicLive(fixed.ctx);
	assert.deepEqual(
		fixed.of("conversations").map((r) => [r.id, r.message_count]),
		[
			[uuid(1), 2],
			[uuid(2), 0],
		],
	);
	assert.deepEqual(fixed.ids("messages"), [uuid(1001), uuid(1002)]);
});

test("an unreadable message entry fails the conversation instead of dropping it", async () => {
	const x = conv(1, 10);
	x.chat_messages.push({ text: "no id", sender: "human", created_at: at(9) });
	const h = harness([x], { streams: CHAT });
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.ids("messages"), []);
	assert.deepEqual(h.states("messages"), []);
	assert.equal(h.failures.length, 2);
});

test("an unreadable list entry fails the streams without a checkpoint", async () => {
	const h = harness([conv(1, 10)], {
		streams: CHAT,
		route: (url) =>
			url.pathname === `${O}/chat_conversations`
				? { status: 200, body: [{ uuid: uuid(2), updated_at: "yesterday" }] }
				: undefined,
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.states("conversations"), []);
	assert.deepEqual(h.states("messages"), []);
	assert.equal(h.failures.length, 2);
});

test("a list longer than the page ceiling fails rather than checkpointing past unseen history", async () => {
	const convs = Array.from({ length: 20_001 }, (_, i) => {
		const c = conv(i + 1, 0);
		c.updated_at = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
		return c;
	});
	const h = harness(convs, { streams: ["conversations"] });
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("conversations"), []);
	assert.deepEqual(h.states("conversations"), []);
	assert.deepEqual(h.failures, [{ stream: "conversations", retryable: false }]);
});

test("each stream applies its own window: a conversation window never narrows messages", async () => {
	const h = harness([conv(1, 10)], {
		streams: CHAT,
		runtime: true,
		scopes: {
			conversations: { time_range: { since: "2027-01-01T00:00:00Z" } },
		},
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.ids("conversations"), []);
	assert.deepEqual(h.ids("messages"), [uuid(1001), uuid(1002)]);
});

test("a messages window widened to an earlier since reads the older messages", async () => {
	const a = conv(1, 10);
	stampMessage(a, 0, "2026-01-15T08:30:00.000000Z");
	const b = conv(2, 20);
	stampMessage(b, 0, "2026-01-15T08:45:00.000000Z");
	const conversationWindow = {
		time_range: {
			since: "2026-01-15T09:00:00Z",
			until: "2026-01-15T10:00:00Z",
		},
	};
	const narrow = harness([a, b], {
		streams: CHAT,
		runtime: true,
		scopes: {
			conversations: conversationWindow,
			messages: { time_range: { since: "2026-01-15T09:00:00Z" } },
		},
	});
	await collectAnthropicLive(narrow.ctx);
	assert.deepEqual(narrow.ids("messages"), [uuid(1002), uuid(2002)]);
	assert.deepEqual(narrow.ids("conversations"), [uuid(1), uuid(2)]);

	const wide = harness([a, b], {
		streams: CHAT,
		runtime: true,
		state: narrow.nextState(),
		scopes: {
			conversations: conversationWindow,
			messages: { time_range: { since: "2026-01-15T08:00:00Z" } },
		},
	});
	await collectAnthropicLive(wide.ctx);
	assert.deepEqual(
		new Set(wide.ids("messages")),
		new Set([uuid(1001), uuid(1002), uuid(2001), uuid(2002)]),
	);
	// The unchanged conversation window keeps its checkpoint.
	assert.deepEqual(wide.ids("conversations"), []);
	for (const cursor of [
		...wide.states("conversations"),
		...wide.states("messages"),
	]) {
		assert.doesNotMatch(JSON.stringify(cursor), /question|answer/);
	}
});

test("messages added after a conversations-only history are backfilled", async () => {
	const convs = [conv(1, 10), conv(2, 20)];
	const first = harness(convs, { streams: ["conversations"] });
	await collectAnthropicLive(first.ctx);
	const next = harness(convs, { streams: CHAT, state: first.nextState() });
	await collectAnthropicLive(next.ctx);
	assert.deepEqual(next.ids("messages").sort(), [
		uuid(1001),
		uuid(1002),
		uuid(2001),
		uuid(2002),
	]);
});

test("a wider resource or field selection is read again, not skipped by the checkpoint", async () => {
	const convs = [conv(1, 10), conv(2, 20)];
	const one = harness(convs, {
		streams: ["conversations"],
		runtime: true,
		scopes: { conversations: { resources: [uuid(1)] } },
	});
	await collectAnthropicLive(one.ctx);
	assert.deepEqual(one.ids("conversations"), [uuid(1)]);
	const all = harness(convs, {
		streams: ["conversations"],
		runtime: true,
		state: one.nextState(),
	});
	await collectAnthropicLive(all.ctx);
	assert.ok(all.ids("conversations").includes(uuid(2)));

	const titles = harness(convs, {
		streams: ["conversations"],
		scopes: { conversations: { fields: ["id", "title"] } },
	});
	await collectAnthropicLive(titles.ctx);
	const more = harness(convs, {
		streams: ["conversations"],
		state: titles.nextState(),
		scopes: { conversations: { fields: ["id", "title", "model"] } },
	});
	await collectAnthropicLive(more.ctx);
	assert.deepEqual(more.ids("conversations"), [uuid(1), uuid(2)]);

	const fewer = harness(convs, {
		streams: ["conversations"],
		state: more.nextState(),
		scopes: { conversations: { fields: ["id"] } },
	});
	await collectAnthropicLive(fewer.ctx);
	assert.deepEqual(fewer.ids("conversations"), []);
});

test("full_refresh ignores the saved checkpoint", async () => {
	const convs = [conv(1, 10), conv(2, 20)];
	const first = harness(convs, { streams: CHAT });
	await collectAnthropicLive(first.ctx);
	const full = harness(convs, {
		streams: CHAT,
		state: first.nextState(),
		collectionMode: "full_refresh",
	});
	await collectAnthropicLive(full.ctx);
	assert.equal(full.ids("messages").length, 4);
	assert.equal(full.ids("conversations").length, 2);
});

test("a different chat organization does not reuse the previous organization's checkpoint", async () => {
	const orgB = "00000000-0000-4000-8000-0000000000f2";
	const a = conv(1, 30);
	const b = conv(2, 10);
	b.org = orgB;
	const orgsA = [...ORGS, { uuid: orgB, capabilities: ["api"] }];
	const first = harness([a, b], { streams: CHAT, orgs: orgsA });
	await collectAnthropicLive(first.ctx);
	assert.deepEqual(first.ids("conversations"), [uuid(1)]);

	const orgsB = [
		{ uuid: orgB, capabilities: ["chat"] },
		{ uuid: ORG, capabilities: ["api"] },
	];
	const next = harness([a, b], {
		streams: CHAT,
		orgs: orgsB,
		state: first.nextState(),
	});
	await collectAnthropicLive(next.ctx);
	assert.deepEqual(next.ids("conversations"), [uuid(2)]);
	assert.deepEqual(next.ids("messages"), [uuid(2001), uuid(2002)]);
	assert.equal(next.states("conversations").at(-1)?.organization_id, orgB);
});

test("a changed conversation emits only its new messages, keeping the model already collected", async () => {
	const original = conv(1, 10);
	const first = harness([original], { streams: CHAT });
	await collectAnthropicLive(first.ctx);

	const changed = conv(1, 30, "claude-opus-5");
	stampMessage(changed, 1, at(10));
	changed.chat_messages.push({
		uuid: uuid(1003),
		text: "later",
		sender: "assistant",
		created_at: at(30),
		updated_at: at(30),
		parent_message_uuid: uuid(1002),
	});
	const next = harness([changed], { streams: CHAT, state: first.nextState() });
	await collectAnthropicLive(next.ctx);
	assert.deepEqual(
		next.of("messages").map((r) => [r.id, r.model]),
		[[uuid(1003), "claude-opus-5"]],
	);
	assert.equal(next.of("conversations")[0]?.message_count, 3);
});

test("a checkpoint from the 0.1 cursor format is read again from the start", async () => {
	const h = harness([conv(1, 10), conv(2, 20)], {
		streams: CHAT,
		state: { conversations: { update_time: at(20), since: null } },
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.ids("conversations"), [uuid(1), uuid(2)]);
	assert.equal(h.ids("messages").length, 4);
});

/**
 * 300 conversations created in 2024 and updated in 2025: a 2024 question
 * inside [since, until) and a 2025 answer at or after until.
 */
function boundedHistory(): Conv[] {
	return Array.from({ length: 300 }, (_, index) => {
		const i = index + 1;
		const c = conv(i, 0);
		c.created_at = "2024-06-01T00:00:00.000000Z";
		c.updated_at = new Date(Date.UTC(2025, 2, 1, 0, 0, i)).toISOString();
		stampMessage(c, 0, "2024-06-01T00:00:00.000000Z");
		stampMessage(c, 1, c.updated_at);
		return c;
	});
}

test("records withheld at until do not trap later runs on the same conversations", async () => {
	const convs = boundedHistory();
	const window = {
		time_range: {
			since: "2024-01-01T00:00:00Z",
			until: "2025-01-01T00:00:00Z",
		},
	};
	const scopes = { conversations: window, messages: window };
	const questions = new Set<string>();
	let state: Record<string, unknown> = {};
	for (let run = 0; run < 3; run++) {
		const h = harness(convs, { streams: CHAT, runtime: true, scopes, state });
		await collectAnthropicLive(h.ctx);
		for (const id of h.ids("messages")) questions.add(id);
		assert.equal(h.heldStates(), 0, `run ${run} lost its checkpoint`);
		state = h.nextState();
	}
	assert.equal(questions.size, 300);
	assert.ok([...questions].every((id) => id.endsWith("1")));

	// Widening until recovers the withheld answers.
	const open = { time_range: { since: "2024-01-01T00:00:00Z" } };
	const answers = new Set<string>();
	for (let run = 0; run < 2; run++) {
		const h = harness(convs, {
			streams: CHAT,
			runtime: true,
			scopes: { conversations: open, messages: open },
			state,
		});
		await collectAnthropicLive(h.ctx);
		for (const id of h.ids("messages")) {
			if (id.endsWith("2")) answers.add(id);
		}
		state = h.nextState();
	}
	assert.equal(answers.size, 300);
});

test("a stale session cookie is not a live session: sign-in is handed to the owner on the same page", async () => {
	const COOKIE_VALUE = "synthetic-revoked-session-value";
	let signedIn = false;
	let origin = "https://claude.ai";
	const visits: string[] = [];
	const logged: string[] = [];
	let readinessChecks = 0;
	const page = {
		goto: async (url: string) => {
			visits.push(url);
			origin = new URL(url).origin;
		},
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const savedFetch = globalThis.fetch;
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin },
			});
			globalThis.fetch = (async (input: string) => {
				if (input === "/api/organizations" && visits.length > 0) {
					readinessChecks += 1;
					// The owner finishes signing in after the first check.
					const ready = signedIn;
					signedIn = true;
					return {
						status: ready ? 200 : 401,
						json: async () => (ready ? ORGS : { error: "unauthorized" }),
					};
				}
				return {
					status: 401,
					json: async () => ({ error: "unauthorized" }),
				};
			}) as unknown as typeof fetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = savedFetch;
				Reflect.deleteProperty(globalThis, "location");
			}
		},
		on: () => undefined,
		off: () => undefined,
		isClosed: () => false,
	};
	const context = {
		cookies: async () => [{ name: "sessionKey", value: COOKIE_VALUE }],
	};
	const assists: AssistanceRequest[] = [];
	const completions: string[] = [];
	await establishSession(
		{
			ensureSession: ensureAnthropicLiveSession,
			probeSession: probeAnthropicLiveSession,
			probeSessionIsAuthoritative: true,
		},
		{
			assist: async (request) => {
				assists.push(request);
				logged.push(JSON.stringify(request));
				return "assist-1";
			},
			capture: null,
			checkpoint: async () => undefined,
			completeAssistance: async (_id, status) => {
				completions.push(status);
			},
			context: context as never,
			name: "anthropic_live",
			page: page as never,
			progress: async (message) => {
				logged.push(message);
			},
			retryablePattern: /ECONN/,
			sendInteraction: async (request: InteractionRequest) => {
				logged.push(JSON.stringify(request));
				return { request_id: request.request_id, status: "success" } as never;
			},
		},
	);
	assert.equal(
		assists.length,
		1,
		"a stale cookie must reach the sign-in handoff",
	);
	assert.deepEqual(completions, ["resolved"]);
	// Only the pre-handoff navigation to sign-in; readiness never navigates.
	assert.deepEqual(visits, ["https://claude.ai/login"]);
	assert.ok(readinessChecks >= 2);
	assert.doesNotMatch(logged.join("\n"), new RegExp(COOKIE_VALUE));
});

test("the session probe opens claude.ai only when the page is elsewhere", async () => {
	const visits: string[] = [];
	let origin = "about:blank";
	const page = {
		goto: async (url: string) => {
			visits.push(url);
			origin = new URL(url).origin;
		},
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const savedFetch = globalThis.fetch;
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin },
			});
			globalThis.fetch = (async () => ({
				status: 200,
				json: async () => ORGS,
			})) as unknown as typeof fetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = savedFetch;
				Reflect.deleteProperty(globalThis, "location");
			}
		},
	};
	const context = {
		cookies: async () => {
			throw new Error("the probe must not read cookies");
		},
	};
	assert.equal(
		await probeAnthropicLiveSession({
			context: context as never,
			page: page as never,
		}),
		true,
	);
	assert.deepEqual(visits, ["https://claude.ai/new"]);
	assert.equal(
		await probeAnthropicLiveSession({
			context: context as never,
			page: page as never,
		}),
		true,
	);
	assert.deepEqual(visits, ["https://claude.ai/new"]);
});

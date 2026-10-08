// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type {
	BrowserCollectContext,
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	collectAnthropicLive,
	MAX_CONVERSATIONS_PER_RUN,
	probeAnthropicLiveSession,
	selectChatOrganization,
} from "./index.ts";
import {
	buildAccountPlanRecord,
	buildMessageRecord,
	buildUsageLimitRecords,
	planTypeOf,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

process.env.PDPP_ANTHROPIC_LIVE_DETAIL_DELAY_MS = "1";

const ORG = "00000000-0000-4000-8000-0000000000f1";
const O = `/api/organizations/${ORG}`;
const uuid = (n: number) =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = (minute: number) =>
	`2026-01-15T09:${String(minute).padStart(2, "0")}:00.000000Z`;

const ORGS = [
	{ uuid: uuid(900), capabilities: ["api"], billing_type: "prepaid" },
	{
		uuid: ORG,
		capabilities: ["claude_max", "chat"],
		rate_limit_tier: "default_claude_max_20x",
		billing_type: "stripe_subscription",
		raven_type: null,
		plan_display_name: null,
		created_at: "2025-03-01T12:00:00.000000Z",
	},
];
const SUBSCRIPTION = {
	status: "active",
	billing_interval: "monthly",
	next_charge_at: "2026-02-01T12:00:00Z",
	plan_ending_at: null,
	payment_method: { type: "card", last4: "4242" },
};
const USAGE = {
	five_hour: { utilization: 2, resets_at: at(50) },
	limits: [
		{
			kind: "session",
			group: "session",
			percent: 2,
			severity: "normal",
			resets_at: at(50),
			scope: null,
			is_active: false,
		},
		{
			kind: "weekly_scoped",
			group: "weekly",
			percent: 58,
			severity: "critical",
			resets_at: at(55),
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
			is_active: true,
		},
	],
	extra_usage: { used_credits: 12 },
};

interface Conv {
	uuid: string;
	name: string;
	model: string | null;
	created_at: string;
	updated_at: string;
	is_starred: boolean;
	project_uuid: string | null;
	chat_messages: Record<string, unknown>[];
}

function conv(n: number, minute: number, model = "claude-sonnet-4-6"): Conv {
	return {
		uuid: uuid(n),
		name: `Conversation ${n}`,
		model,
		created_at: at(0),
		updated_at: at(minute),
		is_starred: false,
		project_uuid: null,
		chat_messages: [
			{
				uuid: uuid(n * 1000 + 1),
				text: "",
				content: [{ type: "text", text: "question" }],
				sender: "human",
				created_at: at(0),
				updated_at: at(0),
				attachments: [],
				parent_message_uuid: uuid(0),
			},
			{
				uuid: uuid(n * 1000 + 2),
				text: "",
				content: [
					{ type: "thinking", thinking: "private" },
					{ type: "text", text: "answer" },
				],
				sender: "assistant",
				created_at: at(minute),
				updated_at: at(minute),
				attachments: [],
				parent_message_uuid: uuid(n * 1000 + 1),
			},
		],
	};
}

type Route = (url: URL) => { status: number; body?: unknown } | undefined;

function harness(
	convs: Conv[],
	options: {
		streams?: string[];
		state?: Record<string, unknown>;
		since?: string;
		route?: Route;
		collectionMode?: "full_refresh" | "incremental";
	} = {},
) {
	const calls: string[] = [];
	const emitted: EmittedMessage[] = [];
	const records: Array<{ stream: string; data: RecordData }> = [];
	const failures: Array<{ stream: string; retryable: boolean | undefined }> =
		[];
	const respond = (path: string): { status: number; body?: unknown } => {
		const url = new URL(path, "https://claude.ai");
		const routed = options.route?.(url);
		if (routed) return routed;
		if (url.pathname === "/api/organizations") {
			return { status: 200, body: ORGS };
		}
		if (url.pathname === `${O}/subscription_details`) {
			return { status: 200, body: SUBSCRIPTION };
		}
		if (url.pathname === `${O}/usage`) return { status: 200, body: USAGE };
		if (url.pathname === `${O}/chat_conversations`) {
			const limit = Number(url.searchParams.get("limit"));
			const offset = Number(url.searchParams.get("offset"));
			const sorted = [...convs].sort((a, b) =>
				b.updated_at.localeCompare(a.updated_at),
			);
			return {
				status: 200,
				body: sorted
					.slice(offset, offset + limit)
					.map(({ chat_messages: _messages, ...item }) => item),
			};
		}
		const detail = convs.find(
			(c) => url.pathname === `${O}/chat_conversations/${c.uuid}`,
		);
		if (detail && url.searchParams.get("tree") === "True") {
			return { status: 200, body: detail };
		}
		return { status: 404 };
	};
	const fakeFetch = (async (input: string) => {
		calls.push(input);
		const { status, body } = respond(input);
		return {
			status,
			ok: status >= 200 && status < 300,
			json: async () => {
				if (body === undefined) throw new Error("no body");
				return structuredClone(body);
			},
		};
	}) as unknown as typeof fetch;
	const page = {
		url: () => "https://claude.ai/new",
		goto: async () => null,
		evaluate: async (fn: (arg: unknown) => unknown, arg: unknown) => {
			const savedFetch = globalThis.fetch;
			const savedLocation = Object.getOwnPropertyDescriptor(
				globalThis,
				"location",
			);
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: "https://claude.ai" },
			});
			globalThis.fetch = fakeFetch;
			try {
				return await fn(arg);
			} finally {
				globalThis.fetch = savedFetch;
				if (savedLocation) {
					Object.defineProperty(globalThis, "location", savedLocation);
				} else {
					Reflect.deleteProperty(globalThis, "location");
				}
			}
		},
	};
	const streams = options.streams ?? [
		"conversations",
		"messages",
		"account_plan",
		"usage_limits",
	];
	const ctx = {
		collectionMode: options.collectionMode ?? "incremental",
		emit: async (message: EmittedMessage) => {
			emitted.push(message);
		},
		emitRecord: async (stream: string, data: RecordData) => {
			const result = validateRecord(stream, data);
			assert.equal(result.ok, true, `${stream} ${JSON.stringify(result)}`);
			records.push({ stream, data });
		},
		page,
		progress: async () => undefined,
		reportStreamFailure: async (
			stream: string,
			_message: string,
			opts?: { retryable?: boolean },
		) => {
			failures.push({ stream, retryable: opts?.retryable });
		},
		requested: new Map<string, StreamScope>(
			streams.map((name) => [
				name,
				(options.since
					? { time_range: { since: options.since } }
					: {}) as StreamScope,
			]),
		),
		state: options.state ?? {},
	} as unknown as BrowserCollectContext;
	const of = (stream: string) =>
		records.filter((r) => r.stream === stream).map((r) => r.data);
	const states = (stream: string) =>
		emitted
			.filter((m) => m.type === "STATE" && m.stream === stream)
			.map((m) => (m as { cursor: Record<string, unknown> }).cursor);
	const skips = () =>
		emitted
			.filter((m) => m.type === "SKIP_RESULT")
			.map((m) => m as unknown as { stream: string; reason: string });
	return { calls, ctx, emitted, failures, of, skips, states };
}

test("first run reads every conversation oldest change first and stamps the conversation model", async () => {
	const h = harness([conv(1, 10), conv(2, 30, "claude-opus-4-7"), conv(3, 20)]);
	await collectAnthropicLive(h.ctx);

	assert.deepEqual(
		h.of("conversations").map((r) => r.id),
		[uuid(1), uuid(3), uuid(2)],
	);
	assert.equal(h.of("conversations")[0]?.message_count, 2);
	assert.equal(h.of("conversations")[2]?.model, "claude-opus-4-7");
	const messages = h.of("messages");
	assert.equal(messages.length, 6);
	const human = messages.find((m) => m.id === uuid(2001));
	const assistant = messages.find((m) => m.id === uuid(2002));
	assert.deepEqual(
		[human?.model, human?.model_source, human?.content],
		[null, null, "question"],
	);
	assert.deepEqual(
		[assistant?.model, assistant?.model_source, assistant?.content],
		["claude-opus-4-7", "conversation", "answer"],
	);
	assert.equal(assistant?.parent_id, uuid(2001));
	assert.deepEqual(
		h.states("conversations").map((c) => c.update_time),
		[at(10), at(20), at(30)],
	);
	assert.deepEqual(h.skips(), []);
	// The API-only organization is never read.
	assert.equal(
		h.calls.some((c) => c.includes(uuid(900))),
		false,
	);
});

test("incremental run reads only conversations changed after the cursor and only their new messages", async () => {
	const changed = conv(2, 30, "claude-opus-5");
	changed.chat_messages[0] = { ...changed.chat_messages[0], updated_at: at(5) };
	changed.chat_messages[0].created_at = at(5);
	const h = harness([conv(1, 10), changed, conv(3, 20)], {
		streams: ["conversations", "messages"],
		state: { conversations: { update_time: at(20) } },
	});
	await collectAnthropicLive(h.ctx);

	assert.deepEqual(
		h.of("conversations").map((r) => r.id),
		[uuid(2)],
	);
	// The message from before the cursor keeps the model it was collected with.
	assert.deepEqual(
		h.of("messages").map((r) => [r.id, r.model]),
		[[uuid(2002), "claude-opus-5"]],
	);
	assert.equal(h.of("conversations")[0]?.message_count, 2);
	assert.equal(
		h.calls.filter((c) => c.includes("/chat_conversations/")).length,
		1,
	);
	assert.deepEqual(h.states("conversations"), [
		{ update_time: at(30), since: null },
	]);
});

test("a run with no changes makes no detail request and keeps the cursor", async () => {
	const h = harness([conv(1, 10)], {
		streams: ["conversations", "messages"],
		state: { conversations: { update_time: at(10) } },
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("conversations"), []);
	assert.equal(
		h.calls.some((c) => c.includes("/chat_conversations/")),
		false,
	);
	assert.deepEqual(h.states("conversations"), [
		{ update_time: at(10), since: null },
	]);
});

test("a window that starts earlier than the cursor's is read again from its start", async () => {
	const convs = [conv(1, 10), conv(2, 20), conv(3, 30)];
	const windowed = harness(convs, {
		streams: ["conversations"],
		since: at(15),
	});
	await collectAnthropicLive(windowed.ctx);
	assert.deepEqual(
		windowed.of("conversations").map((r) => r.id),
		[uuid(2), uuid(3)],
	);
	const state = { conversations: windowed.states("conversations").at(-1) };
	assert.deepEqual(state.conversations, { update_time: at(30), since: at(15) });

	const same = harness(convs, {
		streams: ["conversations"],
		since: at(15),
		state,
	});
	await collectAnthropicLive(same.ctx);
	assert.deepEqual(same.of("conversations"), []);

	const widened = harness(convs, { streams: ["conversations"], state });
	await collectAnthropicLive(widened.ctx);
	assert.deepEqual(
		widened.of("conversations").map((r) => r.id),
		[uuid(1), uuid(2), uuid(3)],
	);
	assert.equal(widened.states("conversations").at(-1)?.since, null);
});

test("conversations alone are read from the list without detail requests", async () => {
	const h = harness([conv(1, 10)], { streams: ["conversations"] });
	await collectAnthropicLive(h.ctx);
	assert.equal(h.of("conversations")[0]?.message_count, null);
	assert.deepEqual(h.of("messages"), []);
	assert.equal(
		h.calls.some((c) => c.includes("/chat_conversations/")),
		false,
	);
});

test("the list is paged and a backlog over the per-run cap is deferred", async () => {
	const total = MAX_CONVERSATIONS_PER_RUN + 5;
	const convs = Array.from({ length: total }, (_, i) => {
		const c = conv(i + 1, 0);
		c.updated_at = new Date(Date.UTC(2026, 0, 15, 9, 0, i)).toISOString();
		return c;
	});
	const h = harness(convs, { streams: ["conversations"] });
	await collectAnthropicLive(h.ctx);
	assert.equal(h.of("conversations").length, MAX_CONVERSATIONS_PER_RUN);
	assert.equal(
		h.calls.filter((c) => c.includes("/chat_conversations?limit=50")).length,
		Math.ceil(total / 50),
	);
	assert.deepEqual(h.skips(), [
		{
			type: "SKIP_RESULT",
			stream: "conversations",
			reason: "anthropic_live_backlog_deferred",
			message: `Read ${MAX_CONVERSATIONS_PER_RUN} of ${total} changed conversations; the rest remain for the next run.`,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
		},
	]);
	// The cursor sits at the newest conversation read, so the next run resumes.
	assert.equal(
		h.states("conversations").at(-1)?.update_time,
		convs[MAX_CONVERSATIONS_PER_RUN - 1]?.updated_at,
	);

	const full = harness(convs, {
		streams: ["conversations"],
		collectionMode: "full_refresh",
		state: { conversations: { update_time: convs.at(-1)?.updated_at } },
	});
	await collectAnthropicLive(full.ctx);
	assert.equal(full.of("conversations").length, total);
});

test("a rate-limited detail read stops the run with the cursor before it", async () => {
	const h = harness([conv(1, 10), conv(2, 20), conv(3, 30)], {
		streams: ["conversations", "messages"],
		route: (url) =>
			url.pathname.endsWith(uuid(2)) ? { status: 429 } : undefined,
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(
		h.of("conversations").map((r) => r.id),
		[uuid(1)],
	);
	assert.deepEqual(h.states("conversations"), [
		{ update_time: at(10), since: null },
	]);
	assert.deepEqual(h.failures, [
		{ stream: "conversations", retryable: true },
		{ stream: "messages", retryable: true },
	]);
});

test("a signed-out session fails the run instead of reporting empty streams", async () => {
	const h = harness([conv(1, 10)], {
		route: (url) =>
			url.pathname === "/api/organizations" ? { status: 401 } : undefined,
	});
	await assert.rejects(
		collectAnthropicLive(h.ctx),
		/anthropic_live_auth_failed/,
	);
	assert.deepEqual(h.emitted, []);
});

test("account_plan matches the chatgpt account_plan fields and omits payment data", async () => {
	const h = harness([], { streams: ["account_plan"] });
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("account_plan"), [
		{
			id: "account_plan",
			account_id: ORG,
			account_structure: "personal",
			account_created_at: "2025-03-01T12:00:00.000000Z",
			plan_type: "max",
			plan_display_name: null,
			subscription_plan: "default_claude_max_20x",
			has_active_subscription: true,
			billing_period: "monthly",
			will_renew: true,
			renews_at: "2026-02-01T12:00:00Z",
			expires_at: null,
			cancels_at: null,
			scheduled_plan_change: null,
		},
	]);

	// An unchanged plan is not re-emitted on the next run.
	const again = harness([], {
		streams: ["account_plan"],
		state: { account_plan: h.states("account_plan")[0] },
	});
	await collectAnthropicLive(again.ctx);
	assert.deepEqual(again.of("account_plan"), []);
});

test("account_plan is skipped, not nulled, when subscription_details fails transiently", async () => {
	const h = harness([], {
		streams: ["account_plan"],
		route: (url) =>
			url.pathname.endsWith("/subscription_details")
				? { status: 503 }
				: undefined,
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("account_plan"), []);
	assert.equal(h.skips()[0]?.reason, "http_error");
	assert.deepEqual(h.states("account_plan"), []);

	const free = harness([], {
		streams: ["account_plan"],
		route: (url) =>
			url.pathname.endsWith("/subscription_details")
				? { status: 404 }
				: undefined,
	});
	await collectAnthropicLive(free.ctx);
	assert.equal(free.of("account_plan")[0]?.has_active_subscription, null);
	assert.equal(free.of("account_plan")[0]?.renews_at, null);
});

test("usage_limits emits one record per reported limit", async () => {
	const h = harness([], { streams: ["usage_limits"] });
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("usage_limits"), [
		{
			id: "session",
			kind: "session",
			group: "session",
			scope_model: null,
			scope_surface: null,
			percent_used: 2,
			severity: "normal",
			is_active: false,
			resets_at: at(50),
		},
		{
			id: "weekly_scoped:fable",
			kind: "weekly_scoped",
			group: "weekly",
			scope_model: "Fable",
			scope_surface: null,
			percent_used: 58,
			severity: "critical",
			is_active: true,
			resets_at: at(55),
		},
	]);

	const drifted = harness([], {
		streams: ["usage_limits"],
		route: (url) =>
			url.pathname.endsWith("/usage")
				? { status: 200, body: { unrelated: true } }
				: undefined,
	});
	await collectAnthropicLive(drifted.ctx);
	assert.deepEqual(drifted.of("usage_limits"), []);
	assert.equal(drifted.skips()[0]?.reason, "parse_error");
});

test("parsers: plan family, usage fallback and message edge cases", () => {
	assert.equal(planTypeOf({ capabilities: ["chat", "claude_pro"] }), "pro");
	assert.equal(planTypeOf({ capabilities: ["raven", "chat"] }), "team");
	assert.equal(
		planTypeOf({ capabilities: ["raven"], raven_type: "enterprise" }),
		"enterprise",
	);
	assert.equal(planTypeOf({ capabilities: ["chat"] }), "free");
	assert.equal(
		planTypeOf({ capabilities: ["chat"], billing_type: "none" }),
		"free",
	);
	assert.equal(
		planTypeOf({ capabilities: ["chat"], billing_type: "stripe" }),
		null,
	);
	assert.equal(
		buildAccountPlanRecord({ uuid: ORG, capabilities: ["raven"] }, null)
			?.account_structure,
		"workspace",
	);
	assert.equal(buildAccountPlanRecord({}, null), null);
	const cancelled = buildAccountPlanRecord(ORGS[1] ?? {}, {
		status: "active",
		next_charge_at: null,
		plan_ending_at: "2026-03-01T00:00:00Z",
	});
	assert.deepEqual(
		[cancelled?.will_renew, cancelled?.expires_at],
		[false, "2026-03-01T00:00:00Z"],
	);

	const pastDue = buildAccountPlanRecord(ORGS[1] ?? {}, {
		status: "past_due",
		next_charge_at: "2026-03-01T00:00:00Z",
		plan_ending_at: null,
	});
	assert.deepEqual(
		[pastDue?.has_active_subscription, pastDue?.will_renew],
		[false, null],
	);

	assert.deepEqual(
		buildUsageLimitRecords({
			five_hour: { utilization: 4, resets_at: at(1) },
			seven_day: null,
		})?.map((r) => [r.id, r.percent_used]),
		[["session", 4]],
	);
	assert.equal(buildUsageLimitRecords([]), null);

	assert.equal(buildMessageRecord({ sender: "human" }, uuid(1), null), null);
	const plain = buildMessageRecord(
		{ uuid: uuid(5), text: "flat", sender: "assistant" },
		uuid(1),
		null,
	);
	assert.deepEqual(
		[plain?.content, plain?.model, plain?.model_source, plain?.attachments],
		["flat", null, null, null],
	);
});

test("organization selection follows the export connector's rule", () => {
	assert.equal(selectChatOrganization(ORGS)?.uuid, ORG);
	assert.equal(
		selectChatOrganization([{ uuid: "a" }, { uuid: "b" }])?.uuid,
		"a",
	);
	assert.equal(selectChatOrganization([{ name: "no uuid" }]), null);
	assert.equal(selectChatOrganization({}), null);
});

test("session probe opens the sign-in origin only when no session cookie exists", async () => {
	const visits: string[] = [];
	const args = (cookies: Array<{ name: string; value: string }>) =>
		({
			context: { cookies: async () => cookies },
			page: {
				goto: async (url: string) => {
					visits.push(url);
				},
			},
		}) as never;
	assert.equal(
		await probeAnthropicLiveSession(args([{ name: "sessionKey", value: "x" }])),
		true,
	);
	assert.deepEqual(visits, []);
	assert.equal(await probeAnthropicLiveSession(args([])), false);
	assert.deepEqual(visits, ["https://claude.ai/new"]);
});

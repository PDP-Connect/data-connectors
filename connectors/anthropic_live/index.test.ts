// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	collectAnthropicLive,
	MAX_CONVERSATIONS_PER_RUN,
	selectChatOrganization,
} from "./index.ts";
import {
	buildAccountPlanRecord,
	buildMessageRecord,
	buildUsageLimitRecords,
	planTypeOf,
} from "./parsers.ts";
import { at, conv, harness, ORG, ORGS, uuid } from "./test-support.ts";

/** The update time a STATE cursor has read through. */
const through = (cursor: Record<string, unknown> | undefined) =>
	(cursor?.read_through as { update_time?: string } | null | undefined)
		?.update_time;

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
	assert.deepEqual(h.states("conversations").map(through), [
		at(10),
		at(20),
		at(30),
		at(30),
	]);
	assert.deepEqual(h.skips(), []);
	// The API-only organization is never read.
	assert.equal(
		h.calls.some((c) => c.includes(uuid(900))),
		false,
	);
});

test("incremental run reads only conversations changed after the cursor and only their new messages", async () => {
	const first = harness([conv(1, 10), conv(2, 15), conv(3, 20)], {
		streams: ["conversations", "messages"],
	});
	await collectAnthropicLive(first.ctx);

	const changed = conv(2, 30, "claude-opus-5");
	changed.chat_messages[0] = { ...changed.chat_messages[0], updated_at: at(5) };
	changed.chat_messages[0].created_at = at(5);
	const h = harness([conv(1, 10), changed, conv(3, 20)], {
		streams: ["conversations", "messages"],
		state: first.nextState(),
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
	assert.deepEqual(h.states("messages").at(-1), {
		version: 3,
		organization_id: ORG,
		scope: { since: null, until: null, resources: null, fields: null },
		read_through: { update_time: at(30), id: uuid(2) },
		emitted_through: at(30),
	});
});

test("a run with no changes makes no detail request and keeps the cursor", async () => {
	const first = harness([conv(1, 10)], {
		streams: ["conversations", "messages"],
	});
	await collectAnthropicLive(first.ctx);
	const h = harness([conv(1, 10)], {
		streams: ["conversations", "messages"],
		state: first.nextState(),
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("conversations"), []);
	assert.equal(
		h.calls.some((c) => c.includes("/chat_conversations/")),
		false,
	);
	assert.deepEqual(h.nextState(), first.nextState());
});

test("a window that starts earlier than the cursor's is read again from its start", async () => {
	// The window applies to create_time, the stream's consent field.
	const convs = [conv(1, 10), conv(2, 20), conv(3, 30)].map((c) => ({
		...c,
		created_at: c.updated_at,
	}));
	const windowed = harness(convs, {
		streams: ["conversations"],
		since: at(15),
	});
	await collectAnthropicLive(windowed.ctx);
	assert.deepEqual(
		windowed.of("conversations").map((r) => r.id),
		[uuid(2), uuid(3)],
	);
	const state = windowed.nextState();
	assert.equal(through(windowed.states("conversations").at(-1)), at(30));

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
	assert.deepEqual(widened.states("conversations").at(-1)?.scope, {
		since: null,
		until: null,
		resources: null,
		fields: null,
	});
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
		// Read twice: a list of several pages is used only when two reads agree.
		2 * Math.ceil(total / 50),
	);
	assert.deepEqual(h.skips(), [
		{
			type: "SKIP_RESULT",
			stream: "conversations",
			reason: "anthropic_live_backlog_deferred",
			message: `Read ${MAX_CONVERSATIONS_PER_RUN} of ${total} changed conversations; the rest remain for the next run.`,
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			// The cursor stops before the deferred conversations, so the
			// runtime lets this stream's STATE pass (stream-integrity.ts).
			diagnostics: { resume_safe: "cursor_at_or_before_loss" },
		},
	]);
	// The cursor sits at the newest conversation read, so the next run resumes.
	assert.equal(
		through(h.states("conversations").at(-1)),
		convs[MAX_CONVERSATIONS_PER_RUN - 1]?.updated_at,
	);

	const full = harness(convs, {
		streams: ["conversations"],
		collectionMode: "full_refresh",
		state: h.nextState(),
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
	assert.deepEqual(
		[...h.states("conversations"), ...h.states("messages")].map(through),
		[at(10), at(10)],
	);
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { collectAnthropicLive } from "../anthropic_live/index.ts";
import { harness, ORG, ORGS } from "../anthropic_live/test-support.ts";
import {
	type EmittedMessage,
	makeEmitRecord,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

test("account_plan includes Team and personal without changing the conversation organization", async () => {
	const orgs = [
		{
			uuid: "team",
			capabilities: ["raven"],
			raven_type: "team",
			billing_type: "stripe",
		},
		{ uuid: ORG, capabilities: ["chat"], billing_type: null },
	];
	const h = harness([], {
		streams: ["account_plan"],
		orgs,
		route: (url) =>
			url.pathname.endsWith("/subscription_details")
				? { status: url.pathname.includes("/team/") ? 403 : 404 }
				: undefined,
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(
		h
			.of("account_plan")
			.map((r) => [r.id, r.account_id, r.is_default, r.plan_type]),
		[
			["account_plan", ORG, true, "free"],
			["account_plan:team", "team", false, "team"],
		],
	);
	assert.ok(h.of("account_plan").every((r) => r.renews_at === null));
	assert.ok(
		h.calls.every(
			(url) =>
				!url.includes("export_data") && !url.includes("chat_conversations"),
		),
	);
	const again = harness([], {
		streams: ["account_plan"],
		orgs: [...orgs].reverse(),
		state: { account_plan: h.states("account_plan")[0] },
		route: (url) =>
			url.pathname.endsWith("/subscription_details")
				? { status: 404 }
				: undefined,
	});
	await collectAnthropicLive(again.ctx);
	assert.deepEqual(again.of("account_plan"), []);
});
test("Max ignores non-chat organizations; a single free org stays at the legacy id", async () => {
	for (const orgs of [
		ORGS,
		[{ uuid: ORG, capabilities: ["chat"], billing_type: "none" }],
	]) {
		const h = harness([], { streams: ["account_plan"], orgs });
		await collectAnthropicLive(h.ctx);
		assert.equal(h.of("account_plan").length, 1);
		assert.equal(h.of("account_plan")[0]?.id, "account_plan");
		assert.equal(h.of("account_plan")[0]?.is_default, true);
	}
});
test("failure reading any usable organization does not checkpoint a partial plan inventory", async () => {
	const h = harness([], {
		streams: ["account_plan"],
		orgs: [...ORGS, { uuid: "team", capabilities: ["raven"] }],
		route: (url) =>
			url.pathname.includes("/team/") ? { status: 503 } : undefined,
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("account_plan"), []);
	assert.deepEqual(h.states("account_plan"), []);
	assert.equal(h.skips()[0]?.reason, "http_error");
});

test("a selected organization outside the usable inventory skips the stream instead of a partial inventory", async () => {
	const h = harness([], {
		streams: ["account_plan"],
		orgs: [
			{ uuid: "api", capabilities: [] },
			{ uuid: "team", capabilities: ["raven"] },
		],
	});
	await collectAnthropicLive(h.ctx);
	assert.deepEqual(h.of("account_plan"), []);
	assert.deepEqual(h.states("account_plan"), []);
	assert.equal(h.skips()[0]?.reason, "organization_unavailable");
	assert.ok(h.emitted.every((m) => m.type !== "DETAIL_COVERAGE"));
	assert.ok(h.calls.every((url) => !url.includes("/subscription_details")));
});

import { collectAnthropic } from "./index.ts";
async function exportPlans(orgs: unknown[]) {
	const records: Record<string, unknown>[] = [],
		requests: string[] = [],
		events: EmittedMessage[] = [];
	const requested = new Map([["account_plan", { name: "account_plan" }]]);
	// The runtime's own emitRecord: it validates, and drops a rejected record.
	const runtime = makeEmitRecord({
		requested,
		emit: async (message) => {
			if (message.type === "RECORD") records.push(message.data);
			events.push(message);
		},
		emittedAt: "2026-10-29T00:00:00.000Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => null,
	});
	const page = {
		goto: async () => null,
		evaluate: async (fn: () => unknown) => {
			const oldFetch = globalThis.fetch;
			globalThis.fetch = (async (url: unknown) => {
				requests.push(String(url));
				return { ok: true, json: async () => orgs };
			}) as typeof fetch;
			try {
				return await fn();
			} finally {
				globalThis.fetch = oldFetch;
			}
		},
	};
	await collectAnthropic({
		page,
		requested,
		state: {},
		emit: async (message: EmittedMessage) => {
			events.push(message);
		},
		emitRecord: runtime.emit,
		testOverrides: { initialDelayMs: 0 },
	} as unknown as Parameters<typeof collectAnthropic>[0]);
	return { records, requests, events };
}
test("export connector enumerates Team plus personal without requesting an export", async () => {
	const { records, requests } = await exportPlans([
		{ uuid: "team", capabilities: ["raven"], raven_type: "team" },
		{ uuid: "personal", capabilities: ["chat"], billing_type: null },
	]);
	assert.deepEqual(
		records.map((r) => [r.id, r.account_id, r.is_default, r.plan_type]),
		[
			["account_plan:team", "team", false, "team"],
			["account_plan", "personal", true, "free"],
		],
	);
	assert.deepEqual(requests, ["https://claude.ai/api/organizations"]);
});
test("export connector omits non-chat orgs and preserves single free legacy identity", async () => {
	for (const orgs of [
		[
			{ uuid: "api", capabilities: [] },
			{ uuid: "max", capabilities: ["chat", "claude_max"] },
		],
		[{ uuid: "free", capabilities: ["chat"], billing_type: "none" }],
	]) {
		const { records } = await exportPlans(orgs);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.id, "account_plan");
		assert.equal(records[0]?.is_default, true);
	}
});
test("export connector skips the whole inventory when any plan record fails validation", async () => {
	const { records, events } = await exportPlans([
		{ uuid: "personal", capabilities: ["chat"], billing_type: null },
		{ uuid: "team", capabilities: ["raven"], raven_type: "t".repeat(81) },
	]);
	assert.deepEqual(records, []);
	const skip = events.find((m) => m.type === "SKIP_RESULT") as
		| { reason?: string; recovery_hint?: { retryable?: boolean } }
		| undefined;
	assert.equal(skip?.reason, "parse_error");
	assert.equal(skip?.recovery_hint?.retryable, true);
	assert.ok(events.every((m) => m.type !== "DETAIL_COVERAGE"));
});

test("export connector rejects malformed raw secondary organizations before certifying inventory", async () => {
	for (const malformed of [{ uuid: "team" }, { uuid: "team", capabilities: "raven" }, { capabilities: ["raven"] }, null]) {
		const { records, events } = await exportPlans([{ uuid: "personal", capabilities: ["chat"] }, malformed]);
		assert.deepEqual(records, []);
		assert.ok(events.every((event) => event.type !== "DETAIL_COVERAGE"));
		const skip = events.find((event) => event.type === "SKIP_RESULT") as { reason?: string; recovery_hint?: { retryable?: boolean } } | undefined;
		assert.equal(skip?.reason, "parse_error");
		assert.equal(skip?.recovery_hint?.retryable, true);
	}
});

test("export connector treats a valid empty-capabilities secondary as a clean snapshot", async () => {
	const { records, events } = await exportPlans([{ uuid: "personal", capabilities: ["chat"] }, { uuid: "api", capabilities: [] }]);
	assert.equal(records.length, 1);
	assert.ok(events.some((event) => event.type === "DETAIL_COVERAGE"));
	assert.ok(events.every((event) => event.type !== "SKIP_RESULT"));
});

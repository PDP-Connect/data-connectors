// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import type { StreamDeps } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptApi,
	ChatGptFetchResult,
	ChatGptUsageProjection,
	ConversationListItem,
} from "./types.ts";
import {
	buildConversationUsageRecord,
	buildUsageSummaryRecord,
	type ChatGptUsageFetchArgs,
	type ConversationUsageProjection,
	chatGptUsageFetchInBrowser,
	gizmoKind,
	readConversationUsageProjection,
	sha256Hex,
	usageRef,
} from "./usage.ts";
import {
	CHATGPT_USAGE_MAX_DETAIL_FETCHES_ENV,
	CHATGPT_USAGE_STATELESS_ENV,
	runUsageStreams,
	type UsageStreamHooks,
} from "./usage-stream.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const readFixture = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const CANARY_CONVERSATION = readFixture("usage-conversation-canary.json");
const CANARY_ID = "c0ffee00-0000-4000-8000-00000000ca1a";
const ACCOUNTS_CHECK = readFixture("accounts-check.json");
const AUTH = { accessToken: "tok-CANARY-bearer", deviceId: "dev-CANARY" };

/** Fails if any planted canary, raw id, IP or secret reaches `value`. */
function assertNoLeak(value: unknown, label: string): void {
	const text = JSON.stringify(value).toLowerCase();
	for (const needle of [
		"canary",
		CANARY_ID,
		"00000000-0000-4000-8000-000000000001", // accounts-check account id
		"user-redacted",
		"203.0.113.7",
		"tok-",
		"g-p-",
	]) {
		assert.ok(
			!text.includes(needle.toLowerCase()),
			`${label} leaked "${needle}": ${text.slice(0, 400)}`,
		);
	}
}

// ─── A fake chatgpt.com for the in-page function ──────────────────────────

type Route = (init: RequestInit | undefined) => Response;
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env[CHATGPT_USAGE_MAX_DETAIL_FETCHES_ENV];
	delete process.env[CHATGPT_USAGE_STATELESS_ENV];
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function installFakeSite(routes: Record<string, Route>): string[] {
	const seen: string[] = [];
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		seen.push(url);
		const path = url
			.replace("https://chatgpt.com/backend-api", "")
			.replace("https://chatgpt.com", "");
		const exact = routes[path];
		const prefix = Object.keys(routes).find(
			(k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)),
		);
		const route = exact ?? (prefix ? routes[prefix] : undefined);
		return Promise.resolve(route ? route(init) : json({ detail: "nf" }, 404));
	}) as typeof fetch;
	return seen;
}

const DEFAULT_ROUTES: Record<string, Route> = {
	[`/conversation/${CANARY_ID}`]: () => json(CANARY_CONVERSATION),
	"/conversations/batch": (init) => {
		const ids = (
			JSON.parse(String(init?.body)) as { conversation_ids: string[] }
		).conversation_ids;
		return json(
			ids.filter((id) => id === CANARY_ID).map(() => CANARY_CONVERSATION),
		);
	},
	"/shared_conversations*": () =>
		json({
			items: [
				{
					id: "share-CANARY",
					conversation_id: CANARY_ID,
					title: "CANARY share title",
					share_url: "https://chatgpt.com/share/CANARY",
				},
			],
			total: 1,
		}),
	"/memories*": () =>
		json({
			memories: [{ id: "m1", content: "CANARY memory text" }],
			memory_num_tokens: 50,
			memory_max_tokens: 10_000,
		}),
	"/user_system_messages": () =>
		json({
			enabled: true,
			about_user_message: "CANARY about me",
			about_model_message: "",
		}),
	"/settings/user": () =>
		json({
			settings: {
				sunshine: true,
				training_allowed: false,
				voice_name: "CANARY voice",
				"Weird Key CANARY": true,
			},
		}),
	"/cdn-cgi/trace": () =>
		new Response("fl=1\nh=chatgpt.com\nip=203.0.113.7\nloc=PL\ntls=TLSv1.3\n"),
};

function inPage(
	path: string,
	projection: ChatGptUsageProjection,
	extra: Partial<ChatGptUsageFetchArgs> = {},
): Promise<ChatGptFetchResult> {
	return chatGptUsageFetchInBrowser({
		auth: AUTH,
		method: "GET",
		path,
		projection,
		timeoutMs: 5000,
		...extra,
	});
}

// ─── In-page projection ───────────────────────────────────────────────────

test("conversation projection keeps counts, models and features and drops every text", async () => {
	installFakeSite(DEFAULT_ROUTES);
	const res = await inPage(`/conversation/${CANARY_ID}`, "conversation_usage");
	assert.equal(res.status, 200);
	// The raw id is still inside the page result (it is hashed node-side);
	// strip it before the leak check of the page boundary itself.
	const p = readConversationUsageProjection(res.json);
	assert.ok(p);
	assert.equal(p.conversation_id, CANARY_ID);
	assert.deepEqual(p.counts, {
		user: 2,
		assistant: 6,
		tool: 3,
		system: 0,
		other: 0,
		hidden: 1,
	});
	assert.equal(p.nodes_total, 13);
	assert.equal(p.branch_count, 2);
	assert.deepEqual(p.models, [
		{ slug: "gpt-4o", assistant_messages: 3 },
		{ slug: "o3", assistant_messages: 2 },
		{ slug: "other", assistant_messages: 1 },
	]);
	assert.equal(p.features.web_search, 1);
	assert.equal(p.features.code_interpreter, 1);
	assert.equal(p.features.reasoning, 1);
	assert.equal(p.features.other_tool, 1);
	assert.equal(p.features.image_generation, 0);
	assert.equal(p.user_attachments, 1);
	assert.equal(p.user_images, 1);
	assert.equal(
		p.user_chars_total,
		"CANARY_USER_TEXT hello".length + "CANARY_SECOND_PROMPT".length,
	);
	assert.equal(p.user_chars_max, "CANARY_USER_TEXT hello".length);
	assert.equal(p.gizmo_type, "snorlax");
	assert.equal(p.default_model_slug, "auto");
	assert.equal(p.events.filter((e) => e[1] === 0).length, 2);
	const { conversation_id: _id, gizmo_id: _gizmo, ...rest } = p;
	assertNoLeak(rest, "conversation projection");
	assertNoLeak(
		{
			...(res.json as Record<string, unknown>),
			conversation_id: null,
			gizmo_id: null,
		},
		"raw page result",
	);
});

test("batch projection maps every element and a non-200 returns no body", async () => {
	installFakeSite({
		...DEFAULT_ROUTES,
		"/conversation/missing": () => json({ detail: "CANARY not found" }, 404),
	});
	const batch = await inPage("/conversations/batch", "conversation_usage", {
		method: "POST",
		body: { conversation_ids: [CANARY_ID, "other-id"] },
	});
	assert.ok(Array.isArray(batch.json));
	assert.equal((batch.json as unknown[]).length, 1);
	const missing = await inPage("/conversation/missing", "conversation_usage");
	assert.equal(missing.status, 404);
	assert.equal(missing.json, null);
});

test("side projections return flags and counts only", async () => {
	installFakeSite(DEFAULT_ROUTES);
	const memories = await inPage(
		"/memories?include_memory_entries=true",
		"memory_stats",
	);
	assert.deepEqual(memories.json, {
		memory_count: 1,
		memory_num_tokens: 50,
		memory_max_tokens: 10_000,
	});
	const ci = await inPage("/user_system_messages", "custom_instructions_flags");
	assert.deepEqual(ci.json, {
		enabled: true,
		about_user_set: true,
		response_style_set: false,
	});
	const settings = await inPage("/settings/user", "settings_flags");
	assert.deepEqual(settings.json, {
		flags: { sunshine: true, training_allowed: false },
	});
	const shares = await inPage(
		"/shared_conversations?offset=0",
		"shared_conversation_ids",
	);
	assert.deepEqual(shares.json, {
		items: [{ conversation_id: CANARY_ID }],
		total: 1,
	});
	const client = await inPage("/cdn-cgi/trace", "client_context");
	const ctx = client.json as Record<string, unknown>;
	assert.equal(ctx.network_country, "PL");
	assertNoLeak([memories, ci, settings, client], "side projections");
});

test("client context reports no country when the trace is unreachable or unknown", async () => {
	installFakeSite({
		"/cdn-cgi/trace": () => new Response("ip=203.0.113.7\nloc=XX\n"),
	});
	const unknown = await inPage("/cdn-cgi/trace", "client_context");
	assert.equal((unknown.json as Record<string, unknown>).network_country, null);
	installFakeSite({});
	const missing = await inPage("/cdn-cgi/trace", "client_context");
	assert.equal((missing.json as Record<string, unknown>).network_country, null);
});

test("the in-page function is self-contained (survives toString re-evaluation)", async () => {
	installFakeSite(DEFAULT_ROUTES);
	// PageShim evaluates `(${fn.toString()})(args)`; this proves no closure
	// over module scope is needed.
	assert.doesNotMatch(String(chatGptUsageFetchInBrowser), /__name/);
	const rebuilt = runInThisContext(
		`(${chatGptUsageFetchInBrowser.toString()})`,
	) as typeof chatGptUsageFetchInBrowser;
	const res = await rebuilt({
		auth: AUTH,
		method: "GET",
		path: `/conversation/${CANARY_ID}`,
		projection: "conversation_usage",
		timeoutMs: 5000,
	});
	assert.equal(readConversationUsageProjection(res.json)?.counts.user, 2);
});

// ─── Records ──────────────────────────────────────────────────────────────

test("sha256Hex matches the standard digest and refs are stable and typed", () => {
	assert.equal(
		sha256Hex("abc"),
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
	assert.equal(usageRef("c", CANARY_ID), usageRef("c", CANARY_ID));
	assert.notEqual(usageRef("c", CANARY_ID), usageRef("g", CANARY_ID));
	assert.match(usageRef("g", "g-abc"), /^g_[0-9a-f]{32}$/);
});

test("gizmo kind distinguishes projects and custom GPTs", () => {
	assert.equal(gizmoKind(null, null), "none");
	assert.equal(gizmoKind("g-p-123", null), "project");
	assert.equal(gizmoKind("g-123", "snorlax"), "project");
	assert.equal(gizmoKind("g-123", null), "custom_gpt");
	assert.equal(gizmoKind("x-123", null), "other");
});

const listItem = (
	id: string,
	extra: Partial<ConversationListItem> = {},
): ConversationListItem => ({
	id,
	title: "CANARY list title",
	create_time: 1_760_000_000,
	update_time: 1_760_000_720,
	is_archived: false,
	is_starred: null,
	workspace_id: null,
	gizmo_id: null,
	...extra,
});

async function projectionOf(
	raw: unknown,
): Promise<ConversationUsageProjection> {
	installFakeSite({ "/conversation/x": () => json(raw) });
	const res = await inPage("/conversation/x", "conversation_usage");
	const p = readConversationUsageProjection(res.json);
	assert.ok(p);
	return p;
}

test("conversation_usage record validates and carries no title, id or text", async () => {
	const projection = await projectionOf(CANARY_CONVERSATION);
	const record = buildConversationUsageRecord({
		listItem: listItem(CANARY_ID),
		projection,
		detailStatus: "fetched",
		sharedIds: new Set([CANARY_ID]),
	});
	assert.equal(validateRecord("conversation_usage", record).ok, true);
	assert.equal(record.gizmo_kind, "project");
	assert.equal(record.is_shared, true);
	assert.equal(record.is_starred, true);
	assert.equal(record.turn_count, 2);
	assert.equal(record.id, usageRef("c", CANARY_ID));
	assertNoLeak(record, "conversation_usage record");
});

test("a list-only record has null detail fields and still validates", () => {
	const record = buildConversationUsageRecord({
		listItem: listItem(CANARY_ID, { gizmo_id: "g-CANARYGPT" }),
		projection: null,
		detailStatus: "not_fetched",
		sharedIds: null,
	});
	assert.equal(validateRecord("conversation_usage", record).ok, true);
	assert.equal(record.gizmo_kind, "custom_gpt");
	assert.equal(record.message_counts, null);
	assert.equal(record.is_shared, null);
	assert.equal(record.create_time, "2025-10-09T08:53:20.000Z");
	assertNoLeak(record, "list-only record");
});

test("the schema rejects a record that smuggles a title or free-text slug", () => {
	const record = buildConversationUsageRecord({
		listItem: listItem(CANARY_ID),
		projection: null,
		detailStatus: "not_fetched",
		sharedIds: null,
	});
	assert.equal(
		validateRecord("conversation_usage", { ...record, title: "x" }).ok,
		false,
	);
	assert.equal(
		validateRecord("conversation_usage", {
			...record,
			default_model_slug: "My Secret Model",
		}).ok,
		false,
	);
});

// ─── Summary ──────────────────────────────────────────────────────────────

const SETTINGS = {
	memory_count: 1,
	memory_num_tokens: 50,
	memory_max_tokens: 10_000,
	custom_instructions_enabled: true,
	custom_instructions_about_user_set: true,
	custom_instructions_response_style_set: false,
	setting_flags: { sunshine: true },
};
const ACCOUNT = {
	created_at: "2023-01-15T10:00:00.000Z",
	data_residency_region: "no_constraint",
	compute_residency_region: "no_constraint",
};

function syntheticProjection(
	userTimes: number[],
	model: string,
): ConversationUsageProjection {
	return {
		conversation_id: "x",
		create_time: userTimes[0] ?? null,
		update_time: userTimes.at(-1) ?? null,
		is_archived: false,
		is_starred: false,
		gizmo_id: null,
		gizmo_type: null,
		in_workspace: false,
		default_model_slug: null,
		has_mapping: true,
		nodes_total: userTimes.length * 2,
		branch_count: 1,
		counts: {
			user: userTimes.length,
			assistant: userTimes.length,
			tool: 0,
			system: 0,
			other: 0,
			hidden: 0,
		},
		models: [{ slug: model, assistant_messages: userTimes.length }],
		features: {
			web_search: 1,
			code_interpreter: 0,
			image_generation: 0,
			canvas: 0,
			deep_research: 0,
			memory_update: 0,
			file_search: 0,
			reasoning: 0,
			voice: 0,
			other_tool: 0,
		},
		user_attachments: 0,
		user_images: 0,
		user_chars_total: 10 * userTimes.length,
		user_chars_max: 10,
		assistant_chars_total: 100,
		first_message_at: userTimes[0] ?? null,
		last_message_at: userTimes.at(-1) ?? null,
		events: userTimes.flatMap(
			(t): Array<[number, 0 | 1, string | null]> => [
				[t, 0, null],
				[t + 1, 1, model],
			],
		),
	};
}

function summaryFor(timezone: string | null) {
	// 2026-01-31 23:30 UTC (= 2026-02-01 00:30 in Warsaw), then 2026-02-01 and
	// 2026-02-02 at 12:00 UTC: a three-day streak in UTC across two months.
	const times = [
		Date.UTC(2026, 0, 31, 23, 30) / 1000,
		Date.UTC(2026, 1, 1, 12) / 1000,
		Date.UTC(2026, 1, 2, 12) / 1000,
	];
	const a = syntheticProjection(times, "gpt-4o");
	const b = syntheticProjection([Date.UTC(2026, 1, 10, 8) / 1000], "o3");
	const rec = (
		id: string,
		p: ConversationUsageProjection,
		gizmo: string | null,
	) =>
		buildConversationUsageRecord({
			listItem: listItem(id, { create_time: p.create_time, gizmo_id: gizmo }),
			projection: p,
			detailStatus: "fetched",
			sharedIds: new Set(),
		});
	return buildUsageSummaryRecord({
		conversations: [
			{ record: rec("conv-a", a, "g-p-1"), projection: a },
			{ record: rec("conv-b", b, "g-2"), projection: b },
			{
				record: buildConversationUsageRecord({
					listItem: listItem("conv-c", {
						create_time: Date.UTC(2025, 11, 5) / 1000,
					}),
					projection: null,
					detailStatus: "not_fetched",
					sharedIds: new Set(),
				}),
				projection: null,
			},
		],
		settings: SETTINGS,
		client: { timezone, browser_language: "pl-PL", network_country: "PL" },
		account: ACCOUNT,
	});
}

test("usage_summary aggregates months, streaks, models and histograms in UTC", () => {
	const s = summaryFor("UTC");
	assert.equal(validateRecord("usage_summary", s).ok, true);
	assert.equal(s.timezone, "UTC");
	const totals = s.totals as Record<string, number>;
	assert.equal(totals.conversations, 3);
	assert.equal(totals.user_messages, 4);
	assert.equal(totals.custom_gpts_used, 1);
	assert.equal(totals.projects_used, 1);
	assert.equal(totals.shared, 0);
	// Detail days: Jan 31, Feb 1, Feb 2, Feb 10; list-only conv-c: Dec 5.
	assert.equal(s.active_days, 5);
	assert.equal(s.longest_streak_days, 3);
	const months = s.months as Array<Record<string, unknown>>;
	assert.deepEqual(
		months.map((m) => [m.month, m.user_messages, m.active_days]),
		[
			["2025-12", 0, 1],
			["2026-01", 1, 1],
			["2026-02", 3, 3],
		],
	);
	assert.deepEqual(s.models, [
		{ slug: "gpt-4o", assistant_messages: 3 },
		{ slug: "o3", assistant_messages: 1 },
	]);
	const hours = s.hour_of_day as number[];
	assert.equal(hours[12], 2);
	assert.equal(hours[23], 1);
	assert.equal(hours[8], 1);
	assert.deepEqual(s.coverage, {
		conversations_listed: 3,
		detail_fetched: 2,
		detail_unavailable: 0,
		detail_failed: 0,
		detail_not_fetched: 1,
		detail_complete: false,
	});
	assert.deepEqual(s.account, {
		created_month: "2023-01",
		data_residency_region: "no_constraint",
		compute_residency_region: "no_constraint",
	});
});

test("usage_summary buckets in the page's timezone", () => {
	const s = summaryFor("Europe/Warsaw");
	assert.equal(s.timezone_source, "browser");
	const months = s.months as Array<Record<string, unknown>>;
	// 23:30 UTC on Jan 31 is 00:30 on Feb 1 in Warsaw: January has no messages.
	assert.deepEqual(
		months.map((m) => [m.month, m.user_messages]),
		[
			["2025-12", 0],
			["2026-02", 4],
		],
	);
	assert.equal((s.hour_of_day as number[])[0], 1);
	assert.equal(s.longest_streak_days, 2);
});

test("an unknown timezone falls back to UTC and says so", () => {
	const s = summaryFor("Not/AZone");
	assert.equal(s.timezone, "UTC");
	assert.equal(s.timezone_source, "default_utc");
	assert.equal(validateRecord("usage_summary", s).ok, true);
});

// ─── The run ──────────────────────────────────────────────────────────────

interface FakeApiCall {
	path: string;
	projection: ChatGptUsageProjection | undefined;
}

function fakeApi(routes: Record<string, Route>): {
	api: ChatGptApi;
	calls: FakeApiCall[];
} {
	const calls: FakeApiCall[] = [];
	const api: ChatGptApi = {
		auth: () => Promise.resolve(AUTH),
		async fetch(path, opts = {}) {
			calls.push({ path, projection: opts.projection });
			if (opts.projection) {
				installFakeSite(routes);
				try {
					return await chatGptUsageFetchInBrowser({
						auth: AUTH,
						method: opts.method ?? "GET",
						body: opts.body,
						path,
						projection: opts.projection,
						timeoutMs: 5000,
					});
				} finally {
					globalThis.fetch = realFetch;
				}
			}
			if (path.startsWith("/accounts/check")) {
				return { status: 200, json: ACCOUNTS_CHECK };
			}
			return { status: 404, json: null };
		},
	};
	return { api, calls };
}

function runHarness(
	streams: string[],
	opts: {
		items?: ConversationListItem[];
		truncated?: boolean;
		routes?: Record<string, Route>;
		timeRange?: { since?: string };
	} = {},
) {
	const harness = makeRecordingEmit(validateRecord);
	const { api, calls } = fakeApi(opts.routes ?? DEFAULT_ROUTES);
	const items = opts.items ?? [
		listItem(CANARY_ID),
		listItem("conv-missing", { gizmo_id: "g-CANARYGPT" }),
	];
	const hooks: UsageStreamHooks = {
		listConversations: async (deps) => {
			await deps.emit({
				type: "PROGRESS",
				stream: "conversations",
				message: "Listing your conversations",
			});
			if (opts.truncated) {
				await deps.emit({
					type: "SKIP_RESULT",
					stream: "conversations",
					reason: "conversation_list_unstable",
					message: "unstable",
				});
			}
			return { items, truncated: opts.truncated === true };
		},
		classifyError: () => "other",
		accountsCheckPath: "/accounts/check/v4-2023-04-27",
	};
	const deps: StreamDeps = {
		api,
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: () => Promise.resolve(),
		requested: new Map(
			streams.map((name) => [
				name,
				opts.timeRange ? { name, time_range: opts.timeRange } : { name },
			]),
		),
	};
	return {
		run: () => runUsageStreams(deps, {}, hooks),
		harness,
		calls,
	};
}

const CONTENT_PATH =
	/^\/(conversation\/|conversations\/batch|memories|user_system_messages|shared_conversations|settings)/;

test("a full run emits valid records and a summary with no canary anywhere", async () => {
	const { run, harness, calls } = runHarness([
		"conversation_usage",
		"usage_summary",
	]);
	await run();
	assert.deepEqual(harness.skipped, []);
	const records = harness.emitted.filter(
		(e) => e.stream === "conversation_usage",
	);
	assert.equal(records.length, 2);
	const byStatus = Object.fromEntries(
		records.map((r) => [r.data.detail_status, r.data]),
	);
	assert.equal(byStatus.fetched?.gizmo_kind, "project");
	assert.equal(byStatus.fetched?.is_shared, true);
	assert.equal(byStatus.unavailable?.gizmo_kind, "custom_gpt");
	const [summary] = harness.emitted.filter((e) => e.stream === "usage_summary");
	assert.ok(summary);
	assert.deepEqual(summary.data.locale, {
		browser_language: (summary.data.locale as Record<string, unknown>)
			.browser_language,
		network_country: "PL",
	});
	assert.deepEqual(summary.data.settings, {
		memory_count: 1,
		memory_num_tokens: 50,
		memory_max_tokens: 10_000,
		custom_instructions_enabled: true,
		custom_instructions_about_user_set: true,
		custom_instructions_response_style_set: false,
		setting_flags: { sunshine: true, training_allowed: false },
	});
	assert.equal(
		(summary.data.account as Record<string, unknown>).created_month,
		"2023-01",
	);
	// Every text-bearing endpoint went through an in-page projection.
	for (const call of calls.filter((c) => CONTENT_PATH.test(c.path))) {
		assert.ok(call.projection, `${call.path} was read without a projection`);
	}
	// Records, protocol messages (PROGRESS, SKIP, STATE, coverage): nothing leaks.
	assertNoLeak(harness.emitted, "emitted records");
	assertNoLeak(harness.protocolMessages, "protocol messages");
	const coverage = harness.protocolMessages.filter(
		(m) => m.type === "DETAIL_COVERAGE",
	);
	assert.equal(coverage.length, 2);
	// The shared walk's "conversations" reports were re-labelled, not leaked
	// onto an unrequested stream.
	assert.ok(
		harness.protocolMessages.every(
			(m) => (m as { stream?: string }).stream !== "conversations",
		),
	);
});

test("conversation_usage alone reads no memories, settings or instructions", async () => {
	const { run, calls } = runHarness(["conversation_usage"]);
	await run();
	assert.ok(
		!calls.some((c) =>
			/^\/(memories|user_system_messages|settings|accounts|cdn-cgi)/.test(
				c.path,
			),
		),
		JSON.stringify(calls.map((c) => c.path)),
	);
});

test("list-only mode reads no conversation content at all", async () => {
	process.env[CHATGPT_USAGE_MAX_DETAIL_FETCHES_ENV] = "0";
	const { run, harness, calls } = runHarness([
		"conversation_usage",
		"usage_summary",
	]);
	await run();
	assert.ok(!calls.some((c) => /^\/conversations?\//.test(c.path)));
	const records = harness.emitted.filter(
		(e) => e.stream === "conversation_usage",
	);
	assert.ok(records.every((r) => r.data.detail_status === "not_fetched"));
	const [summary] = harness.emitted.filter((e) => e.stream === "usage_summary");
	assert.ok(summary);
	assert.equal(
		(summary.data.coverage as Record<string, unknown>).detail_complete,
		false,
	);
	assertNoLeak(harness.emitted, "list-only records");
});

test("a detail cap reads the newest conversations first and reports the rest", async () => {
	process.env[CHATGPT_USAGE_MAX_DETAIL_FETCHES_ENV] = "1";
	const { run, harness } = runHarness(["conversation_usage"], {
		items: [
			listItem("older", { update_time: 1_700_000_000 }),
			listItem(CANARY_ID, { update_time: 1_760_000_720 }),
		],
	});
	await run();
	const statuses = harness.emitted.map((e) => e.data.detail_status).sort();
	assert.deepEqual(statuses, ["fetched", "not_fetched"]);
	const skip = harness.protocolMessages.find((m) => m.type === "SKIP_RESULT");
	assert.equal(
		(skip as { reason?: string } | undefined)?.reason,
		"detail_fetch_capped",
	);
});

test("an unserved batch endpoint falls back to single reads", async () => {
	const { run, harness, calls } = runHarness(["conversation_usage"], {
		routes: {
			...DEFAULT_ROUTES,
			"/conversations/batch": () => json({ detail: "nope" }, 404),
		},
	});
	await run();
	assert.ok(calls.some((c) => c.path === `/conversation/${CANARY_ID}`));
	assert.ok(harness.emitted.some((e) => e.data.detail_status === "fetched"));
});

test("a truncated list withholds the summary and marks both streams partial", async () => {
	const { run, harness } = runHarness(["conversation_usage", "usage_summary"], {
		truncated: true,
	});
	await run();
	assert.equal(
		harness.emitted.filter((e) => e.stream === "usage_summary").length,
		0,
	);
	const skips = harness.protocolMessages.filter(
		(m) => m.type === "SKIP_RESULT",
	);
	assert.deepEqual(
		skips
			.map((m) => [
				(m as { stream?: string }).stream,
				(m as { reason?: string }).reason,
			])
			.sort(),
		[
			["conversation_usage", "conversation_list_unstable"],
			["usage_summary", "conversation_list_unstable"],
		],
	);
});

test("a time window on conversation_usage alone skips details outside it", async () => {
	const { run, calls } = runHarness(["conversation_usage"], {
		timeRange: { since: "2026-01-01T00:00:00Z" },
	});
	await run();
	assert.ok(!calls.some((c) => c.path.startsWith("/conversation")));
});

test("the stateless host mode emits without fingerprint STATE", async () => {
	process.env[CHATGPT_USAGE_STATELESS_ENV] = "1";
	const { run, harness } = runHarness(["usage_summary"]);
	await run();
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "STATE").length,
		0,
	);
	assert.equal(harness.emitted.length, 1);
});

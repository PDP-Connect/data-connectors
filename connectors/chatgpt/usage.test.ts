// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInThisContext } from "node:vm";
import type { CollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import type { StreamDeps } from "./index.ts";
import { createChatGptApi } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
	ChatGptApi,
	ChatGptFetchResult,
	ChatGptUsageProjection,
} from "./types.ts";
import {
	type AccountProfileInput,
	buildAccountProfileRecord,
	buildUsageSummaryRecord,
	type ChatGptUsageFetchArgs,
	type ConversationUsageProjection,
	chatGptUsageFetchInBrowser,
	gizmoKind,
	readConversationListPage,
	readConversationUsageProjection,
	type UsageListItem,
	type UsageSummaryConversation,
	usageCaptureRoute,
} from "./usage.ts";
import {
	CHATGPT_USAGE_DETAIL_ENV,
	CHATGPT_USAGE_STATELESS_ENV,
	createLimiter,
	DEFAULT_DETAIL_SAMPLE,
	nextCursorStep,
	type PagedRead,
	resolveUsageDetailPlan,
	runUsageStreams,
	type UsageFetchErrorClass,
	type UsageStreamHooks,
	walkProjectConversations,
} from "./usage-stream.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const readFixture = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const CANARY_CONVERSATION = readFixture("usage-conversation-canary.json");
const CANARY_ID = "c0ffee00-0000-4000-8000-00000000ca1a";
const ACCOUNTS_CHECK = readFixture("accounts-check.json");
const ENDPOINTS = readFixture("usage-account-endpoints-canary.json");
const AUTH = { accessToken: "tok-CANARY-bearer", deviceId: "dev-CANARY" };
const NOW_MS = Date.UTC(2026, 9, 15, 12);

/** Fails if any planted canary, raw id, IP or secret reaches `value`. */
function assertNoLeak(value: unknown, label: string): void {
	const text = JSON.stringify(value).toLowerCase();
	for (const needle of [
		"canary",
		CANARY_ID,
		"00000000-0000-4000-8000-000000000001", // accounts-check account id
		"00000000-0000-4000-8000-0000000000aa", // accounts-check subscription id
		"user-redacted",
		"example.com",
		"203.0.113.7",
		"tok-",
		"g-p-",
		"conv-",
		"+48",
	]) {
		assert.ok(
			!text.includes(needle.toLowerCase()),
			`${label} leaked "${needle}": ${text.slice(0, 400)}`,
		);
	}
}

// ─── A fake chatgpt.com for the in-page function ──────────────────────────

type Route = (init: RequestInit | undefined, url: URL) => Response;
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	delete process.env[CHATGPT_USAGE_DETAIL_ENV];
	delete process.env[CHATGPT_USAGE_STATELESS_ENV];
});

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Routes match on the path (no query) first, then on a `prefix*` key. The
 * handler gets the full URL so it can read offset/cursor parameters.
 */
function installFakeSite(routes: Record<string, Route>): string[] {
	const seen: string[] = [];
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		seen.push(url.pathname + url.search);
		const path = url.pathname.replace(/^\/backend-api/, "");
		const exact = routes[path];
		const prefix = Object.keys(routes).find(
			(k) => k.endsWith("*") && path.startsWith(k.slice(0, -1)),
		);
		const route = exact ?? (prefix ? routes[prefix] : undefined);
		try {
			return Promise.resolve(
				route ? route(init, url) : json({ detail: "nf" }, 404),
			);
		} catch (err) {
			return Promise.reject(err);
		}
	}) as typeof fetch;
	return seen;
}

const BASE = Date.UTC(2026, 9, 14, 20) / 1000;
const rawConvId = (i: number): string =>
	`00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;

/** A raw /conversations list item. i = 0 is the most recently updated. */
function rawListItem(
	i: number,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	const updated = BASE - i * 3600;
	return {
		...(ENDPOINTS.conversation_list_item as Record<string, unknown>),
		id: rawConvId(i),
		title: `CANARY title ${i}`,
		create_time: new Date((updated - 600) * 1000).toISOString(),
		update_time: new Date(updated * 1000).toISOString(),
		latest_assistant_turn_created_at: new Date(updated * 1000).toISOString(),
		...extra,
	};
}

/** A detail body for a list conversation: the canary conversation under that id. */
function detailFor(id: string): Record<string, unknown> {
	return { ...CANARY_CONVERSATION, conversation_id: id, id };
}

interface SiteOptions {
	conversations?: Array<Record<string, unknown>>;
	archived?: Array<Record<string, unknown>> | "unavailable";
	/** List page indexes (offset / 100) that answer 500. */
	failListPages?: number[];
	total?: number;
	/** Per-project conversation pages (one array per cursor page) or "fail". */
	projects?: Record<string, Array<Array<Record<string, unknown>>> | "fail">;
	/** The last project page repeats its own cursor instead of ending. */
	projectEcho?: boolean;
	/** /shared_conversations answers 500 (is_shared becomes null). */
	sharesDown?: boolean;
}

function listRoute(opts: SiteOptions): Route {
	return (_init, url) => {
		const offset = Number(url.searchParams.get("offset") ?? 0);
		const limit = Number(url.searchParams.get("limit") ?? 28);
		if (limit > 100) return json({ detail: "le 100" }, 422);
		const archived = url.searchParams.get("is_archived") === "true";
		if (archived && opts.archived === "unavailable")
			return json({ detail: "CANARY no" }, 404);
		if (!archived && opts.failListPages?.includes(offset / 100))
			return json({ detail: "CANARY boom" }, 500);
		const all = archived
			? ((opts.archived as Array<Record<string, unknown>> | undefined) ?? [])
			: (opts.conversations ?? []);
		return json({
			items: all.slice(offset, offset + limit),
			// Deliberately wrong, as observed live: total is not the real total.
			total: opts.total ?? offset + 101,
			limit,
			offset,
			has_missing_conversations: false,
		});
	};
}

function siteRoutes(opts: SiteOptions = {}): Record<string, Route> {
	const conversations = opts.conversations ?? [
		rawListItem(0, { id: CANARY_ID, gizmo_id: "g-p-CANARYPROJECT123" }),
		rawListItem(1, { gizmo_id: "g-CANARYGPT" }),
	];
	const projectItems = Object.values(opts.projects ?? {}).flatMap((p) =>
		p === "fail" ? [] : p.flat(),
	);
	const known = new Set(
		[
			...conversations,
			...(Array.isArray(opts.archived) ? opts.archived : []),
			...projectItems,
		].map((c) => c.id),
	);
	return {
		"/conversations": listRoute({ ...opts, conversations }),
		"/conversations/batch": (init) => {
			const ids = (
				JSON.parse(String(init?.body)) as { conversation_ids: string[] }
			).conversation_ids;
			return json(ids.filter((id) => known.has(id)).map(detailFor));
		},
		"/conversation/*": (_init, url) => {
			const id = url.pathname.split("/").pop() ?? "";
			return known.has(id)
				? json(detailFor(id))
				: json({ detail: "CANARY not found" }, 404);
		},
		"/shared_conversations": () =>
			opts.sharesDown
				? json({ detail: "down" }, 500)
				: json({
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
		"/me": () => json(ENDPOINTS.me),
		"/accounts/check/v4-2023-04-27": () => json(ACCOUNTS_CHECK),
		"/settings/beta_features": () => json(ENDPOINTS.beta_features),
		"/user_system_messages": () => json(ENDPOINTS.user_system_messages),
		"/memories": () => json(ENDPOINTS.memories),
		"/gizmos/snorlax/sidebar": (_init, url) =>
			json(
				url.searchParams.get("cursor") === "cursor-CANARY_page2"
					? ENDPOINTS.snorlax_sidebar_page2
					: ENDPOINTS.snorlax_sidebar_page1,
			),
		// Project conversations: /gizmos/{id}/conversations?cursor=N, ~10 per page.
		"/gizmos/*": (_init, url) => {
			const [, , id] = url.pathname.replace(/^\/backend-api/, "").split("/");
			const pages = opts.projects?.[id ?? ""] ?? [[]];
			if (pages === "fail") return json({ detail: "CANARY boom" }, 500);
			const i = Number(url.searchParams.get("cursor") ?? 0);
			return json({
				items: pages[i] ?? [],
				// Numeric cursor, as `?cursor=0` suggests; null on the last page.
				cursor: i + 1 < pages.length ? i + 1 : opts.projectEcho ? i : null,
			});
		},
		"/tasks": () => json(ENDPOINTS.tasks),
		"/cdn-cgi/trace": () =>
			new Response(
				"fl=1\nh=chatgpt.com\nip=203.0.113.7\nloc=DE\ntls=TLSv1.3\n",
			),
	};
}

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

// ─── In-page projections ──────────────────────────────────────────────────

test("conversation projection keeps counts, models and features and drops every text", async () => {
	installFakeSite(siteRoutes());
	const res = await inPage(`/conversation/${CANARY_ID}`, "conversation_detail");
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
	installFakeSite(siteRoutes());
	const batch = await inPage("/conversations/batch", "conversation_detail", {
		method: "POST",
		body: { conversation_ids: [CANARY_ID, "other-id"] },
	});
	assert.ok(Array.isArray(batch.json));
	assert.equal((batch.json as unknown[]).length, 1);
	const missing = await inPage("/conversation/missing", "conversation_detail");
	assert.equal(missing.status, 404);
	assert.equal(missing.json, null);
});

test("list projection keeps timestamps and flags and drops title, snippet and urls", async () => {
	installFakeSite(
		siteRoutes({
			conversations: [
				rawListItem(0, {
					pinned_time: "2026-10-02T00:00:00Z",
					gizmo_id: "g-p-CANARYPROJECT123",
					conversation_template_id: "g-p-CANARYPROJECT123",
					is_temporary_chat: true,
					is_automation_conversation: true,
					workspace_id: "ws-CANARY",
				}),
				rawListItem(1),
			],
		}),
	);
	const res = await inPage(
		"/conversations?offset=0&limit=100&order=updated",
		"conversation_list",
	);
	const raw = res.json as { items: Array<Record<string, unknown>> };
	assert.equal(raw.items.length, 2);
	assert.deepEqual(Object.keys(raw.items[0] ?? {}).sort(), [
		"create_time",
		"gizmo_id",
		"id",
		"in_workspace",
		"is_archived",
		"is_automation",
		"is_do_not_remember",
		"is_pinned",
		"is_temporary_chat",
		"latest_assistant_turn_at",
		"template_id",
		"update_time",
	]);
	const page = readConversationListPage(res.json);
	assert.ok(page);
	assert.equal(page.raw_count, 2);
	const [first, second] = page.items;
	assert.equal(first?.is_pinned, true);
	assert.equal(second?.is_pinned, false);
	assert.equal(first?.in_workspace, true);
	assert.equal(first?.is_temporary_chat, true);
	assert.equal(first?.is_automation, true);
	assert.equal(first?.update_time, BASE);
	assertNoLeak(
		raw.items.map(({ id: _i, gizmo_id: _g, template_id: _t, ...r }) => r),
		"list page",
	);
});

test("/me is reduced to creation time, MFA, domain type, country codes and org counts", async () => {
	installFakeSite(siteRoutes());
	const res = await inPage("/me", "me_profile");
	assert.deepEqual(res.json, {
		created: 1673776800,
		mfa_enabled: true,
		email_domain_type: "social",
		country: "PL",
		region_code: "14",
		org_count: 2,
		has_non_personal_org: true,
	});
	assertNoLeak(res.json, "me projection");
});

test("/me drops a country or region code that is not a plain code", async () => {
	installFakeSite({
		"/me": () =>
			json({
				...(ENDPOINTS.me as Record<string, unknown>),
				country: "Poland",
				region_code: "CANARY Region",
				email_domain_type: "Some Domain CANARY",
			}),
	});
	const res = await inPage("/me", "me_profile");
	const j = res.json as Record<string, unknown>;
	assert.equal(j.country, null);
	assert.equal(j.region_code, null);
	assert.equal(j.email_domain_type, "other");
});

test("accounts/check is reduced to plan facts the account_plan stream does not carry", async () => {
	installFakeSite(siteRoutes());
	const res = await inPage(
		"/accounts/check/v4-2023-04-27",
		"account_check_facts",
	);
	assert.deepEqual(res.json, {
		found: true,
		created_time: Date.parse("2023-01-15T10:00:00.000Z") / 1000,
		workspace_type: null,
		is_deactivated: false,
		is_trial: false,
		trial_state: null,
		has_previously_paid_subscription: true,
		last_expired_subscription_was_gratis: false,
		data_residency_region: "no_constraint",
		compute_residency_region: "no_constraint",
		feature_flag_count: 2,
		is_gratis: false,
		billing_currency: "USD",
		is_delinquent: false,
		in_grace_period: false,
		purchase_origin_platform: "chatgpt_web",
	});
	assertNoLeak(res.json, "accounts/check projection");
});

test("beta features keep only enabled slug keys; side endpoints keep counts and flags", async () => {
	installFakeSite(siteRoutes());
	const beta = await inPage("/settings/beta_features", "beta_features");
	assert.deepEqual(beta.json, {
		flag_count: 7,
		enabled: ["browsing", "canvas", "codex_cloud", "deep_research"],
	});
	const memories = await inPage(
		"/memories?include_memory_entries=true",
		"memory_stats",
	);
	assert.deepEqual(memories.json, {
		memory_count: 2,
		memory_num_tokens: 321,
		memory_max_tokens: 10_000,
	});
	const ci = await inPage("/user_system_messages", "custom_instructions_flags");
	assert.deepEqual(ci.json, {
		enabled: true,
		about_user_set: true,
		response_style_set: false,
		name_set: true,
		role_set: false,
		traits_set: true,
		other_set: false,
		personality_set: true,
		traits_enabled: false,
		disabled_tools_count: 1,
	});
	const sidebar = await inPage("/gizmos/snorlax/sidebar", "project_sidebar");
	assert.deepEqual(sidebar.json, {
		item_count: 1,
		file_count: 2,
		project_ids: ["g-p-CANARYPROJECTA"],
		cursor: "cursor-CANARY_page2",
		has_more: true,
	});
	const tasks = await inPage("/tasks", "task_stats");
	assert.deepEqual(tasks.json, {
		task_count: 3,
		by_status: { active: 2, other: 1 },
		cursor: null,
		has_more: false,
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
	assert.equal((client.json as Record<string, unknown>).network_country, "DE");
	assertNoLeak([beta, memories, ci, tasks, client], "side projections");
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
	installFakeSite(siteRoutes());
	// PageShim evaluates `(${fn.toString()})(args)`; this proves no closure
	// over module scope is needed.
	assert.doesNotMatch(String(chatGptUsageFetchInBrowser), /__name/);
	const rebuilt = runInThisContext(
		`(${chatGptUsageFetchInBrowser.toString()})`,
	) as typeof chatGptUsageFetchInBrowser;
	const call = (path: string, projection: ChatGptUsageProjection) =>
		rebuilt({ auth: AUTH, method: "GET", path, projection, timeoutMs: 5000 });
	const res = await call(`/conversation/${CANARY_ID}`, "conversation_detail");
	assert.equal(readConversationUsageProjection(res.json)?.counts.user, 2);
	const facts = await call(
		"/accounts/check/v4-2023-04-27",
		"account_check_facts",
	);
	assert.equal((facts.json as Record<string, unknown>).billing_currency, "USD");
	const list = await call(
		"/conversations?offset=0&limit=100",
		"conversation_list",
	);
	assert.equal(readConversationListPage(list.json)?.items.length, 2);
});

// ─── Records ──────────────────────────────────────────────────────────────

test("gizmo kind distinguishes projects and custom GPTs", () => {
	assert.equal(gizmoKind(null, null), "none");
	assert.equal(gizmoKind("g-p-123", null), "project");
	assert.equal(gizmoKind("g-123", "snorlax"), "project");
	assert.equal(gizmoKind("g-123", null), "custom_gpt");
	assert.equal(gizmoKind("x-123", null), "other");
});

const listItem = (
	id: string,
	extra: Partial<UsageListItem> = {},
): UsageListItem => ({
	id,
	create_time: 1_760_000_000,
	update_time: 1_760_000_720,
	latest_assistant_turn_at: 1_760_000_720,
	is_pinned: false,
	gizmo_id: null,
	template_id: null,
	is_archived: false,
	is_temporary_chat: false,
	is_do_not_remember: false,
	is_automation: false,
	in_workspace: false,
	...extra,
});

// ─── Summary ──────────────────────────────────────────────────────────────

function syntheticProjection(
	userMessages: number,
	model: string,
): ConversationUsageProjection {
	return {
		conversation_id: "x",
		create_time: null,
		update_time: null,
		is_archived: false,
		is_starred: false,
		gizmo_id: null,
		gizmo_type: null,
		in_workspace: false,
		default_model_slug: null,
		has_mapping: true,
		nodes_total: userMessages * 2,
		branch_count: 1,
		counts: {
			user: userMessages,
			assistant: userMessages,
			tool: 0,
			system: 0,
			other: 0,
			hidden: 0,
		},
		models: [{ slug: model, assistant_messages: userMessages }],
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
		user_chars_total: 10 * userMessages,
		user_chars_max: 10,
		assistant_chars_total: 100,
		first_message_at: null,
		last_message_at: null,
		events: [],
	};
}

function summaryFor(timezone: string | null) {
	// conv-a starts 2026-01-31 23:30 UTC (= 2026-02-01 00:30 in Warsaw) and
	// is last touched 2026-02-02 12:00; conv-b lives on 2026-02-01 12:00;
	// conv-c (not read) on 2025-12-05.
	const at = (y: number, m: number, d: number, h: number, min = 0) =>
		Date.UTC(y, m, d, h, min) / 1000;
	const conv = (
		id: string,
		item: Partial<UsageListItem>,
		projection: ConversationUsageProjection | null,
		inSample: boolean,
	): UsageSummaryConversation => {
		return {
			list: listItem(id, item),
			projection,
			detailStatus: projection ? "fetched" : "not_fetched",
			inSample,
		};
	};
	return buildUsageSummaryRecord({
		conversations: [
			conv(
				"conv-a",
				{
					create_time: at(2026, 0, 31, 23, 30),
					update_time: at(2026, 1, 2, 12),
					latest_assistant_turn_at: at(2026, 1, 2, 12),
					gizmo_id: "g-p-1",
				},
				syntheticProjection(3, "gpt-4o"),
				true,
			),
			conv(
				"conv-b",
				{
					create_time: at(2026, 1, 1, 12),
					update_time: at(2026, 1, 1, 12, 5),
					latest_assistant_turn_at: null,
					gizmo_id: "g-2",
					is_temporary_chat: true,
				},
				syntheticProjection(1, "o3"),
				true,
			),
			conv(
				"conv-c",
				{
					create_time: at(2025, 11, 5, 8),
					update_time: at(2025, 11, 5, 8),
					latest_assistant_turn_at: null,
					is_archived: true,
				},
				null,
				false,
			),
		],
		sharedIds: new Set(),
		client: { timezone, browser_language: "pl-PL", network_country: "PL" },
		coverage: {
			archived_listing: "read",
			list_pages: 2,
			detail_mode: "sample",
			project_listing: {
				sidebar: "ok",
				projects: 1,
				pages: 1,
				failed: 0,
				truncated: false,
				conversations_added: 0,
			},
		},
		sampleComplete: true,
	});
}

test("usage_summary aggregates list fields exactly and labels the detail sample", () => {
	const s = summaryFor("UTC");
	assert.equal(validateRecord("usage_summary", s).ok, true);
	assert.equal(s.timezone, "UTC");
	assert.equal(s.activity_basis, "conversation_timestamps");
	const totals = s.totals as Record<string, number>;
	assert.equal(totals.conversations, 3);
	assert.equal(totals.archived, 1);
	assert.equal(totals.temporary_conversations, 1);
	assert.equal(totals.custom_gpts_used, 1);
	assert.equal(totals.projects_used, 1);
	assert.equal(totals.shared, 0);
	assert.equal(s.custom_gpt_share, 0.333);
	// Days: Jan 31, Feb 2 (conv-a), Feb 1 (conv-b), Dec 5 (conv-c).
	assert.equal(s.active_days, 4);
	assert.equal(s.longest_streak_days, 3);
	assert.equal(s.first_activity_at, "2025-12-05T08:00:00.000Z");
	assert.equal(s.last_activity_at, "2026-02-02T12:00:00.000Z");
	assert.deepEqual(
		(s.months as Array<Record<string, unknown>>).map((m) => [
			m.month,
			m.conversations_created,
			m.conversations_last_active,
			m.active_days,
		]),
		[
			["2025-12", 1, 1, 1],
			["2026-01", 1, 0, 1],
			["2026-02", 1, 2, 2],
		],
	);
	const hours = s.hour_of_day as number[];
	assert.equal(hours[23], 1);
	assert.equal(hours[12], 1);
	assert.equal(hours[8], 1);
	const sample = s.detail_sample as Record<string, unknown>;
	assert.equal(sample.basis, "most_recently_updated");
	assert.equal(sample.n_conversations, 2);
	assert.equal(sample.n_read, 2);
	assert.equal(sample.user_messages, 4);
	assert.equal(sample.window_start, "2026-02-01T12:05:00.000Z");
	assert.equal(sample.window_end, "2026-02-02T12:00:00.000Z");
	assert.deepEqual(sample.models, [
		{ slug: "gpt-4o", assistant_messages: 3 },
		{ slug: "o3", assistant_messages: 1 },
	]);
	assert.deepEqual(sample.messages_per_conversation, { mean: 4, median: 4 });
	assert.deepEqual(s.coverage, {
		conversations_listed: 3,
		archived_listing: "read",
		list_pages: 2,
		detail_mode: "sample",
		project_listing: {
			sidebar: "ok",
			projects: 1,
			pages: 1,
			failed: 0,
			truncated: false,
			conversations_added: 0,
		},
		detail_fetched: 2,
		detail_unavailable: 0,
		detail_failed: 0,
		detail_not_read: 1,
	});
});

test("usage_summary buckets in the page's timezone", () => {
	const s = summaryFor("Europe/Warsaw");
	assert.equal(s.timezone_source, "browser");
	// 23:30 UTC on Jan 31 is 00:30 on Feb 1 in Warsaw: January has nothing.
	assert.deepEqual(
		(s.months as Array<Record<string, unknown>>).map((m) => [
			m.month,
			m.conversations_created,
		]),
		[
			["2025-12", 1],
			["2026-02", 2],
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

// ─── account_profile record ───────────────────────────────────────────────

const ALL_OK = {
	me: "ok",
	accounts_check: "ok",
	beta_features: "ok",
	custom_instructions: "ok",
	memories: "ok",
	projects: "ok",
	tasks: "ok",
	network: "ok",
} as const;

function profileInput(
	over: Partial<AccountProfileInput> = {},
): AccountProfileInput {
	return {
		me: {
			created: Date.UTC(2023, 1, 20) / 1000,
			mfa_enabled: true,
			email_domain_type: "social",
			country: "PL",
			region_code: "14",
			org_count: 1,
			has_non_personal_org: false,
		},
		account: {
			found: true,
			created_time: Date.UTC(2023, 0, 15, 10) / 1000,
			billing_currency: "PLN",
			is_gratis: false,
		},
		betaFeatures: { flag_count: 3, enabled: ["canvas", "Bad Key", "browsing"] },
		instructions: { enabled: true, about_user_set: true },
		memory: { memory_count: 4, memory_num_tokens: 50, memory_max_tokens: 100 },
		projects: { count: 2, files: 3 },
		tasks: { count: 2, by_status: { active: 2, "Bad Status": 1 } },
		client: { timezone: "UTC", browser_language: "en", network_country: "DE" },
		sources: { ...ALL_OK },
		nowMs: NOW_MS,
		...over,
	};
}

test("account_profile keeps the user and account creation times apart and prefers the account country", () => {
	const r = buildAccountProfileRecord(profileInput());
	assert.equal(validateRecord("account_profile", r).ok, true);
	assert.equal(r.user_created_at, "2023-02-20T00:00:00.000Z");
	assert.equal(r.chatgpt_account_created_at, "2023-01-15T10:00:00.000Z");
	assert.equal("account_created_at" in r, false);
	// Tenure from the user creation time: 2023-02-20 → 2026-10-15 = 43 months.
	assert.equal(r.tenure_months, 43);
	assert.equal(r.country, "PL");
	assert.equal(r.geography_source, "account_profile");
	assert.equal(r.network_country, "DE");
	assert.equal(r.billing_currency, "PLN");
	assert.deepEqual(r.enabled_beta_features, ["browsing", "canvas"]);
	assert.deepEqual(r.scheduled_tasks_by_status, { active: 2 });
	assert.equal(r.project_file_count, 3);
});

test("account_profile falls back to the network country and labels it", () => {
	const r = buildAccountProfileRecord(
		profileInput({ me: null, sources: { ...ALL_OK, me: "failed" } }),
	);
	assert.equal(validateRecord("account_profile", r).ok, true);
	assert.equal(r.country, "DE");
	assert.equal(r.geography_source, "network");
	assert.equal(r.region_code, null);
	assert.equal(r.mfa_enabled, null);
	assert.equal((r.source_status as Record<string, string>).me, "failed");
});

// ─── The run ──────────────────────────────────────────────────────────────

interface FakeApiCall {
	path: string;
	projection: ChatGptUsageProjection | undefined;
	body: unknown;
}

/** Paths whose fetch throws, by class, to exercise error classification. */
type Throwing = Record<string, UsageFetchErrorClass>;

function fakeApi(
	routes: Record<string, Route>,
	throwing: Throwing = {},
): { api: ChatGptApi; calls: FakeApiCall[]; inFlightMax: () => number } {
	const calls: FakeApiCall[] = [];
	let inFlight = 0;
	let max = 0;
	installFakeSite(routes);
	const api: ChatGptApi = {
		auth: () => Promise.resolve(AUTH),
		async fetch(path, opts = {}) {
			calls.push({ path, projection: opts.projection, body: opts.body });
			const bare = path.split("?")[0] ?? path;
			const cls = throwing[bare];
			if (cls) throw new Error(`fake ${cls}`);
			if (!opts.projection) return { status: 404, json: null };
			inFlight += 1;
			max = Math.max(max, inFlight);
			try {
				// Yield so concurrent callers overlap the way page.evaluate does.
				await new Promise((r) => setTimeout(r, 1));
				return await chatGptUsageFetchInBrowser({
					auth: AUTH,
					method: opts.method ?? "GET",
					body: opts.body,
					path,
					projection: opts.projection,
					timeoutMs: 5000,
				});
			} finally {
				inFlight -= 1;
			}
		},
	};
	return { api, calls, inFlightMax: () => max };
}

function runHarness(
	streams: string[],
	opts: {
		site?: SiteOptions;
		routes?: Record<string, Route>;
		throwing?: Throwing;
		state?: CollectContext["state"];
	} = {},
) {
	const harness = makeRecordingEmit(validateRecord);
	const { api, calls, inFlightMax } = fakeApi(
		opts.routes ?? siteRoutes(opts.site),
		opts.throwing,
	);
	const hooks: UsageStreamHooks = {
		classifyError: (err) => {
			const m = err instanceof Error ? err.message : "";
			return m === "fake deferred"
				? "deferred"
				: m === "fake forbidden"
					? "forbidden"
					: m === "fake auth"
						? "auth"
						: "other";
		},
		accountsCheckPath: "/accounts/check/v4-2023-04-27",
		now: () => NOW_MS,
	};
	const deps: StreamDeps = {
		api,
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		progress: () => Promise.resolve(),
		requested: new Map(streams.map((name) => [name, { name }])),
	};
	return {
		run: () => runUsageStreams(deps, opts.state ?? {}, hooks),
		harness,
		calls,
		inFlightMax,
	};
}

const PROJECTED_PATH =
	/^\/(conversation|conversations|me|accounts|settings|user_system_messages|memories|gizmos|tasks|shared_conversations|cdn-cgi)(?:[/?]|$)/;

const records = (h: ReturnType<typeof makeRecordingEmit>, stream: string) =>
	h.emitted.filter((e) => e.stream === stream).map((e) => e.data);

/** A nested object field of a record; fails the test when it is missing. */
function sub(
	r: Record<string, unknown> | undefined,
	key: string,
): Record<string, unknown> {
	const v = r?.[key];
	assert.ok(typeof v === "object" && v !== null, `missing ${key}`);
	return v as Record<string, unknown>;
}

const many = (n: number) => Array.from({ length: n }, (_, i) => rawListItem(i));

test("a full run of both streams emits valid records and leaks no canary anywhere", async () => {
	const { run, harness, calls } = runHarness([
		"account_profile",
		"usage_summary",
	]);
	await run();
	assert.deepEqual(harness.skipped, []);
	// Account-level records only: nothing per conversation.
	assert.deepEqual([...new Set(harness.emitted.map((e) => e.stream))].sort(), [
		"account_profile",
		"usage_summary",
	]);
	assert.equal(harness.emitted.length, 2);
	const [summary] = records(harness, "usage_summary");
	assert.ok(summary);
	const totals = sub(summary, "totals");
	assert.equal(totals.conversations, 2);
	assert.equal(totals.shared, 1);
	assert.equal(totals.project_conversations, 1);
	assert.equal(totals.custom_gpt_conversations, 1);
	assert.equal(sub(summary, "detail_sample").n_read, 2);
	const [profile] = records(harness, "account_profile");
	assert.ok(profile);
	assert.equal(profile.country, "PL");
	assert.equal(profile.region_code, "14");
	assert.equal(profile.geography_source, "account_profile");
	assert.equal(profile.network_country, "DE");
	assert.equal(profile.billing_currency, "USD");
	assert.equal(profile.memory_count, 2);
	assert.equal(profile.project_count, 2);
	assert.equal(profile.project_file_count, 2);
	assert.equal(profile.scheduled_task_count, 3);
	assert.equal(profile.custom_instructions_name_set, true);
	assert.equal(profile.user_created_at, "2023-01-15T10:00:00.000Z");
	assert.equal(profile.chatgpt_account_created_at, "2023-01-15T10:00:00.000Z");
	assert.deepEqual(profile.source_status, ALL_OK);
	// Every endpoint went through an in-page projection; search is never used.
	for (const call of calls) {
		assert.ok(PROJECTED_PATH.test(call.path), call.path);
		assert.ok(call.projection, `${call.path} was read without a projection`);
		assert.ok(!call.path.startsWith("/conversations/search"), call.path);
	}
	// Records, protocol messages (PROGRESS, SKIP, STATE, coverage): nothing leaks.
	assertNoLeak(harness.emitted, "emitted records");
	assertNoLeak(harness.protocolMessages, "protocol messages");
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "DETAIL_COVERAGE").length,
		2,
	);
});

test("the list walk pages until a short page, ignoring the provider total", async () => {
	const { run, harness, calls, inFlightMax } = runHarness(["usage_summary"], {
		site: { conversations: many(250), total: 101 },
	});
	await run();
	const [summary] = records(harness, "usage_summary");
	assert.ok(summary);
	assert.equal(
		(summary.coverage as Record<string, unknown>).conversations_listed,
		250,
	);
	const listOffsets = calls
		.filter(
			(c) => /^\/conversations\?/.test(c.path) && !c.path.includes("archived"),
		)
		.map((c) =>
			Number(new URL(`https://x${c.path}`).searchParams.get("offset")),
		);
	// Pages 0..2 hold the data (page 2 is short); at most the in-flight width
	// of extra pages past it is requested.
	assert.ok(listOffsets.includes(200));
	assert.ok(Math.max(...listOffsets) <= 200 + 3 * 100, String(listOffsets));
	// Four list/detail requests share one limiter; the trace and sidebar reads
	// (one each at a time) are outside it.
	assert.ok(inFlightMax() <= 6, `in flight ${inFlightMax()}`);
});

test("an exact multiple of the page size ends on the empty page", async () => {
	const { run, harness } = runHarness(["usage_summary"], {
		site: { conversations: many(200) },
	});
	await run();
	const [summary] = records(harness, "usage_summary");
	assert.equal(sub(summary, "coverage").conversations_listed, 200);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("the default run reads detail only for this run's 30 most recently updated conversations", async () => {
	// The newest 30 by update time are 0..29: exactly those are read, and the
	// sample's sums cover exactly those 30.
	const { run, harness, calls } = runHarness(["usage_summary"], {
		site: { conversations: many(120) },
	});
	await run();
	assert.equal(resolveUsageDetailPlan({}).size, DEFAULT_DETAIL_SAMPLE);
	const batches = calls.filter((c) => c.path === "/conversations/batch");
	assert.equal(batches.length, DEFAULT_DETAIL_SAMPLE / 10);
	const asked = batches.flatMap(
		(c) => (c.body as { conversation_ids: string[] }).conversation_ids,
	);
	assert.deepEqual(
		[...asked].sort(),
		Array.from({ length: 30 }, (_, i) => rawConvId(i)).sort(),
	);
	assert.ok(!calls.some((c) => c.path.startsWith("/conversation/")));
	const [summary] = records(harness, "usage_summary");
	const sample = sub(summary, "detail_sample");
	assert.equal(sample.n_conversations, 30);
	assert.equal(sample.n_read, 30);
	assert.equal(sample.complete, true);
	// The canary detail has 2 user messages: sums are exactly 30 conversations.
	assert.equal(sample.user_messages, 60);
	assert.equal(sample.window_end, new Date(BASE * 1000).toISOString());
	assert.equal(
		sample.window_start,
		new Date((BASE - 29 * 3600) * 1000).toISOString(),
	);
	assert.equal(sub(summary, "coverage").detail_mode, "sample");
	assert.equal(sub(summary, "coverage").detail_fetched, 30);
	assert.equal(sub(summary, "coverage").detail_not_read, 90);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("the dev override changes the sample size or turns detail off", async () => {
	process.env[CHATGPT_USAGE_DETAIL_ENV] = "10";
	const ten = runHarness(["usage_summary"], {
		site: { conversations: many(45) },
	});
	await ten.run();
	const [s] = records(ten.harness, "usage_summary");
	assert.equal(sub(s, "detail_sample").n_conversations, 10);

	process.env[CHATGPT_USAGE_DETAIL_ENV] = "none";
	const none = runHarness(["usage_summary"]);
	await none.run();
	assert.ok(
		!none.calls.some((c) => /^\/conversations?\/[a-z0-9]/.test(c.path)),
	);
	const [n] = records(none.harness, "usage_summary");
	assert.equal(n?.detail_sample, null);
	assert.equal(sub(n, "coverage").detail_mode, "none");
});

test("archived conversations are listed in a second pass; an unserved archive listing is labelled", async () => {
	const archived = [rawListItem(500, { is_archived: true })];
	const a = runHarness(["usage_summary"], {
		site: { conversations: many(3), archived },
	});
	await a.run();
	const [s] = records(a.harness, "usage_summary");
	assert.equal(sub(s, "totals").archived, 1);
	assert.equal(sub(s, "totals").conversations, 4);
	assert.equal(sub(s, "coverage").archived_listing, "read");

	const b = runHarness(["usage_summary"], {
		site: { conversations: many(3), archived: "unavailable" },
	});
	await b.run();
	const [t] = records(b.harness, "usage_summary");
	assert.equal(sub(t, "coverage").archived_listing, "not_available");
});

test("a failed list page withholds the summary and marks it partial", async () => {
	const { run, harness } = runHarness(["usage_summary"], {
		site: { conversations: many(250), failListPages: [1] },
	});
	await run();
	assert.equal(records(harness, "usage_summary").length, 0);
	const skips = harness.protocolMessages.filter(
		(m) => m.type === "SKIP_RESULT",
	);
	assert.deepEqual(
		skips.map((m) => [
			(m as { stream?: string }).stream,
			(m as { reason?: string }).reason,
		]),
		[["usage_summary", "conversation_list_unstable"]],
	);
	// No STATE is written for a withheld summary.
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "STATE").length,
		0,
	);
});

test("an unserved batch endpoint falls back to single reads", async () => {
	const { run, harness, calls } = runHarness(["usage_summary"], {
		routes: {
			...siteRoutes(),
			"/conversations/batch": () => json({ detail: "nope" }, 404),
		},
	});
	await run();
	assert.ok(calls.some((c) => c.path === `/conversation/${CANARY_ID}`));
	const [summary] = records(harness, "usage_summary");
	assert.equal(sub(summary, "detail_sample").n_read, 2);
});

test("a deferred sample is labelled incomplete without failing the summary", async () => {
	const { run, harness } = runHarness(["usage_summary"], {
		site: { conversations: many(40) },
		throwing: { "/conversations/batch": "deferred" },
	});
	await run();
	const [s] = records(harness, "usage_summary");
	const sample = s?.detail_sample as Record<string, unknown>;
	assert.equal(sample.complete, false);
	assert.equal(sample.n_read, 0);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("one failing profile endpoint leaves its fields null and names it, the rest still arrive", async () => {
	const { run, harness } = runHarness(["account_profile"], {
		routes: {
			...siteRoutes(),
			"/me": () => json({ detail: "CANARY down" }, 500),
			"/tasks": () => json({ detail: "nf" }, 404),
			"/settings/beta_features": () => new Response("not json CANARY"),
		},
		throwing: { "/memories": "other" },
	});
	await run();
	assert.deepEqual(harness.skipped, []);
	const [p] = records(harness, "account_profile");
	assert.ok(p);
	assert.deepEqual(p.source_status, {
		...ALL_OK,
		me: "failed",
		tasks: "not_available",
		beta_features: "failed",
		memories: "failed",
	});
	assert.equal(p.mfa_enabled, null);
	assert.equal(p.memory_count, null);
	assert.equal(p.scheduled_task_count, null);
	assert.equal(p.enabled_beta_features, null);
	// /me failed: the country comes from the network and says so.
	assert.equal(p.country, "DE");
	assert.equal(p.geography_source, "network");
	assert.equal(p.billing_currency, "USD");
	assert.equal(p.project_count, 2);
	assertNoLeak(harness.protocolMessages, "protocol messages");
});

test("a profile with no answering source is skipped, not emitted empty", async () => {
	const down: Route = () => json({ detail: "down" }, 503);
	const { run, harness } = runHarness(["account_profile"], {
		routes: Object.fromEntries(Object.keys(siteRoutes()).map((k) => [k, down])),
	});
	await run();
	assert.equal(records(harness, "account_profile").length, 0);
	const skip = harness.protocolMessages.find((m) => m.type === "SKIP_RESULT");
	assert.equal((skip as { reason?: string } | undefined)?.reason, "http_error");
});

test("account_profile alone reads no conversation list or detail", async () => {
	const { run, calls } = runHarness(["account_profile"]);
	await run();
	assert.ok(
		!calls.some((c) => /^\/(conversations?|shared_conversations)/.test(c.path)),
		JSON.stringify(calls.map((c) => c.path)),
	);
	// All profile sources were read, sidebar across its two cursor pages.
	assert.equal(
		calls.filter((c) => c.path.startsWith("/gizmos/snorlax/sidebar")).length,
		2,
	);
});

test("the stateless host mode emits without fingerprint STATE", async () => {
	process.env[CHATGPT_USAGE_STATELESS_ENV] = "1";
	const { run, harness } = runHarness(["usage_summary", "account_profile"]);
	await run();
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "STATE").length,
		0,
	);
	assert.equal(harness.emitted.length, 2);
});

test("the limiter never runs more than its width and hands slots on in order", async () => {
	const limit = createLimiter(2);
	let active = 0;
	let peak = 0;
	const order: number[] = [];
	await Promise.all(
		[0, 1, 2, 3, 4].map((i) =>
			limit(async () => {
				active += 1;
				peak = Math.max(peak, active);
				await new Promise((r) => setTimeout(r, 2));
				order.push(i);
				active -= 1;
			}),
		),
	);
	assert.equal(peak, 2);
	assert.deepEqual(order.sort(), [0, 1, 2, 3, 4]);
});

// ─── Project conversations (missing from /conversations) ──────────────────

/** A project conversation item in a defensive shape: epoch numbers, no gizmo fields. */
function projectItem(i: number): Record<string, unknown> {
	const updated = BASE - i * 3600;
	return {
		id: rawConvId(i),
		title: `CANARY project title ${i}`,
		create_time: updated - 600,
		update_time: updated,
		snippet: "CANARY project snippet",
	};
}

test("project conversations missing from the main list are added from per-project listings", async () => {
	// Main list: conversations 0..4. Project A: 5..24 over two cursor pages,
	// plus a duplicate of 0. Project B: one empty page.
	const main = many(5);
	const pageOne = [
		projectItem(0),
		...Array.from({ length: 9 }, (_, k) => projectItem(5 + k)),
	];
	const pageTwo = Array.from({ length: 11 }, (_, k) => projectItem(14 + k));
	const { run, harness, calls } = runHarness(
		["account_profile", "usage_summary"],
		{
			site: {
				conversations: main,
				projects: { "g-p-CANARYPROJECTA": [pageOne, pageTwo] },
			},
		},
	);
	await run();
	const [summary] = records(harness, "usage_summary");
	assert.deepEqual(sub(summary, "coverage").project_listing, {
		sidebar: "ok",
		projects: 2,
		pages: 3,
		failed: 0,
		truncated: false,
		conversations_added: 20,
	});
	const totals = sub(summary, "totals");
	assert.equal(totals.conversations, 25);
	// Project items carry no gizmo id; the project is assigned. The duplicate
	// of conversation 0 keeps its main-list entry (no gizmo).
	assert.equal(totals.project_conversations, 20);
	assert.equal(totals.projects_used, 1);
	// Numeric epochs are read: the newest project item sets last activity.
	assert.equal(summary?.last_activity_at, new Date(BASE * 1000).toISOString());
	// Cursor paging: cursor=0, then the returned cursor.
	assert.deepEqual(
		calls
			.filter((c) => c.path.startsWith("/gizmos/g-p-CANARYPROJECTA/"))
			.map((c) => c.path),
		[
			"/gizmos/g-p-CANARYPROJECTA/conversations?cursor=0",
			"/gizmos/g-p-CANARYPROJECTA/conversations?cursor=1",
		],
	);
	// One sidebar walk (two cursor pages) serves both the profile and the list.
	assert.equal(
		calls.filter((c) => c.path.startsWith("/gizmos/snorlax/sidebar")).length,
		2,
	);
	assertNoLeak(harness.emitted, "records with project conversations");
	assertNoLeak(harness.protocolMessages, "protocol messages");
});

test("a failing project listing is counted, not fatal", async () => {
	const { run, harness } = runHarness(["usage_summary"], {
		site: {
			conversations: many(3),
			projects: {
				"g-p-CANARYPROJECTA": "fail",
				"g-p-CANARYPROJECTB": [[projectItem(50)]],
			},
		},
	});
	await run();
	const [summary] = records(harness, "usage_summary");
	assert.ok(summary);
	assert.deepEqual(sub(summary, "coverage").project_listing, {
		sidebar: "ok",
		projects: 2,
		pages: 1,
		failed: 1,
		truncated: false,
		conversations_added: 1,
	});
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("an unreadable sidebar lists no projects and still builds the summary", async () => {
	const { run, harness } = runHarness(["usage_summary"], {
		routes: {
			...siteRoutes({ conversations: many(3) }),
			"/gizmos/snorlax/sidebar": () => json({ detail: "down" }, 503),
		},
	});
	await run();
	const [summary] = records(harness, "usage_summary");
	assert.equal(sub(summary, "coverage").conversations_listed, 3);
	assert.deepEqual(sub(summary, "coverage").project_listing, {
		sidebar: "failed",
		projects: 0,
		pages: 0,
		failed: 0,
		truncated: false,
		conversations_added: 0,
	});
});

// ─── Review regressions ───────────────────────────────────────────────────

test("usage capture routes carry no provider id or cursor", () => {
	assert.equal(
		usageCaptureRoute(`/conversation/${CANARY_ID}`),
		"/conversation/{conversation_id}",
	);
	assert.equal(
		usageCaptureRoute(
			"/gizmos/g-p-CANARYPROJECTA/conversations?cursor=CANARY9",
		),
		"/gizmos/{gizmo_id}/conversations?cursor={redacted}",
	);
	assert.equal(
		usageCaptureRoute("/gizmos/snorlax/sidebar?cursor=cursor-CANARY_page2"),
		"/gizmos/snorlax/sidebar?cursor={redacted}",
	);
	assert.equal(
		usageCaptureRoute("/conversations?offset=100&limit=100&order=updated"),
		"/conversations?offset=100&limit=100&order=updated",
	);
});

test("fixture capture of projected usage reads never names a raw id (index.ts capture path)", async () => {
	installFakeSite(
		siteRoutes({ projects: { "g-p-CANARYPROJECTA": [[projectItem(1)]] } }),
	);
	const captured: unknown[] = [];
	const capture = {
		captureHttp: (label: string, _body: unknown, meta: unknown) => {
			captured.push({ label, meta });
		},
	} as unknown as Parameters<typeof createChatGptApi>[0]["capture"];
	const fakePage = {
		evaluate: ((fn: unknown, arg?: unknown): Promise<unknown> => {
			if (isProjectedArg(arg))
				return (fn as typeof chatGptUsageFetchInBrowser)(arg);
			if (typeof fn === "function" && arg === undefined)
				return Promise.resolve("https://chatgpt.com/");
			return Promise.resolve({ accessToken: "fake", deviceId: "fake" });
		}) as never,
		goto: () => Promise.resolve(null),
		waitForFunction: () => Promise.reject(new Error("no bootstrap")),
	};
	const api = createChatGptApi({
		capture,
		page: fakePage as never,
	});
	await api.fetch(`/conversation/${CANARY_ID}`, {
		projection: "conversation_detail",
	});
	await api.fetch("/gizmos/g-p-CANARYPROJECTA/conversations?cursor=0", {
		projection: "conversation_list",
	});
	assert.equal(captured.length, 2);
	const text = JSON.stringify(captured);
	assert.ok(!text.includes(CANARY_ID), text);
	assert.ok(!text.includes("g-p-"), text);
	assert.match(text, /\{conversation_id\}/);
	assert.match(text, /\{gizmo_id\}/);
});

function isProjectedArg(arg: unknown): arg is ChatGptUsageFetchArgs {
	return typeof arg === "object" && arg !== null && "projection" in arg;
}

test("cursor steps honour explicit ends, empty pages and repeated cursors", () => {
	const seen = new Set(["a", "b"]);
	assert.deepEqual(
		nextCursorStep({ has_more: true, cursor: "c" }, seen, "b", 5, 5),
		{
			next: "c",
		},
	);
	assert.deepEqual(
		nextCursorStep({ has_more: false, cursor: "c" }, seen, "b", 5, 5),
		{
			done: "ok",
		},
	);
	assert.deepEqual(
		nextCursorStep({ has_more: true, cursor: "c" }, seen, "b", 0, 0),
		{
			done: "ok",
		},
	);
	// The last page echoes its own cursor: done, nothing refetched.
	assert.deepEqual(
		nextCursorStep({ has_more: true, cursor: "b" }, seen, "b", 5, 5),
		{
			done: "ok",
		},
	);
	// Back to an earlier page after new items: a loop that may hide more.
	assert.deepEqual(
		nextCursorStep({ has_more: true, cursor: "a" }, seen, "b", 5, 5),
		{
			done: "partial",
		},
	);
	assert.deepEqual(
		nextCursorStep({ has_more: true, cursor: "a" }, seen, "b", 5, 0),
		{
			done: "ok",
		},
	);
	assert.deepEqual(nextCursorStep({ has_more: true }, seen, "b", 5, 5), {
		done: "partial",
	});
});

test("a project whose last page echoes its cursor is complete, not failed", async () => {
	const pageOne = Array.from({ length: 10 }, (_, k) => projectItem(5 + k));
	const { run, harness, calls } = runHarness(["usage_summary"], {
		site: {
			conversations: many(5),
			projects: { "g-p-CANARYPROJECTA": [pageOne, [projectItem(15)]] },
			projectEcho: true,
		},
	});
	await run();
	const [summary] = records(harness, "usage_summary");
	const listing = sub(sub(summary, "coverage"), "project_listing");
	assert.equal(listing.failed, 0);
	assert.equal(listing.conversations_added, 11);
	assert.equal(
		calls.filter((c) => c.path.startsWith("/gizmos/g-p-CANARYPROJECTA/"))
			.length,
		2,
	);
});

test("an explicit has_more:false stops a profile pager without refetching", async () => {
	const { run, harness, calls } = runHarness(["account_profile"], {
		routes: {
			...siteRoutes(),
			"/tasks": () =>
				json({
					...(ENDPOINTS.tasks as Record<string, unknown>),
					cursor: "t2",
					has_more: false,
				}),
		},
	});
	await run();
	const [p] = records(harness, "account_profile");
	assert.equal(p?.scheduled_task_count, 3);
	assert.equal(sub(p, "source_status").tasks, "ok");
	assert.equal(calls.filter((c) => c.path.startsWith("/tasks")).length, 1);
});

test("the project listing stops at the run-wide project and page budget", async () => {
	const projects: Record<string, Array<Array<Record<string, unknown>>>> = {
		"g-p-P1": [[projectItem(1)], [projectItem(2)]],
		"g-p-P2": [[projectItem(3)], [projectItem(4)]],
		"g-p-P3": [[projectItem(5)]],
	};
	const { api } = fakeApi(siteRoutes({ projects }));
	const deps = {
		api,
		emit: () => Promise.resolve(),
		emitRecord: () => Promise.resolve(),
		progress: () => Promise.resolve(),
		requested: new Map(),
	} as unknown as StreamDeps;
	const sidebar: PagedRead = {
		status: "ok",
		value: {
			count: 3,
			files: 0,
			by_status: {},
			project_ids: Object.keys(projects),
		},
	};
	const hooks: UsageStreamHooks = {
		classifyError: () => "other",
		accountsCheckPath: "/accounts/check/v4-2023-04-27",
	};
	const pass = await walkProjectConversations(
		deps,
		hooks,
		createLimiter(1),
		sidebar,
		{ maxProjects: 2, maxPages: 3 },
	);
	assert.equal(pass.projects, 2);
	assert.equal(pass.pages, 3);
	assert.equal(pass.truncated, true);
	assert.equal(pass.failed, 0);
	const unbounded = await walkProjectConversations(
		deps,
		hooks,
		createLimiter(4),
		sidebar,
	);
	assert.equal(unbounded.truncated, false);
	assert.equal(unbounded.items.length, 5);
});

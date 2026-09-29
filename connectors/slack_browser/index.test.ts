// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { collectSlackBrowser } from "./collector.ts";
import {
	CLIENT_URL,
	collect,
	ensureSlackSession,
	LIGHT_URL,
	openSlackClient,
	probeSlackSession,
	readSlackBrowserOptions,
	SIGNIN_URL,
	type SlackClientPage,
	type SlackSessionPage,
	selectTeams,
} from "./index.ts";
import {
	ALL_STREAMS,
	DEFAULT_OPTIONS,
	FIXTURE_NOW,
	FIXTURE_NOW_SECONDS,
	fakeApi,
	type Harness,
	harness,
	TEAM,
} from "./test-support.ts";
import { SlackApiError, SlackSessionLostError } from "./web-api.ts";

const DAY = 86_400;
const FLOOR_7D = FIXTURE_NOW_SECONDS - 7 * DAY;
const FLOOR_30D = FIXTURE_NOW_SECONDS - 30 * DAY;

const manifest = (dir: string) =>
	JSON.parse(
		readFileSync(new URL(`../${dir}/manifest.json`, import.meta.url), "utf8"),
	);

async function run(
	h: Harness,
	api = fakeApi(),
	options: Partial<typeof DEFAULT_OPTIONS> = {},
	now = FIXTURE_NOW,
	concurrency = 1,
) {
	await collectSlackBrowser(
		h.ctx,
		{ api, concurrency, now: () => now },
		[TEAM],
		{ ...DEFAULT_OPTIONS, ...options },
	);
	return api;
}

const ALL_CHANNELS = [
	"C0123456789",
	"C0987654321",
	"D0123456789",
	"C0555555555",
	"C0777777777",
];

const historyCalls = (api: ReturnType<typeof fakeApi>, channel: string) =>
	api.calls.filter(
		(c) => c.method === "conversations.history" && c.params.channel === channel,
	);

test("shares the slack source, and every stream it declares keeps the archive profile's contract", () => {
	const archive = manifest("slack");
	const browser = manifest("slack_browser");
	assert.equal(browser.source.id, archive.source.id);
	assert.equal(browser.connector_key, "slack-browser");
	assert.ok(browser.connector_id.endsWith(`/${browser.connector_key}`));
	assert.equal(browser.setup, undefined);
	assert.equal(browser.runtime_requirements.external_tools, undefined);
	const archiveStreams = new Map<string, Record<string, unknown>>(
		archive.streams.map((s: { name: string }) => [s.name, s]),
	);
	const prose = new Set(["description", "display", "required", "incremental"]);
	for (const stream of browser.streams as Array<Record<string, unknown>>) {
		const counterpart = archiveStreams.get(String(stream.name));
		assert.ok(counterpart, `${String(stream.name)} is not a slack stream`);
		const contract = (s: Record<string, unknown>) =>
			Object.fromEntries(Object.entries(s).filter(([k]) => !prose.has(k)));
		assert.deepEqual(contract(stream), contract(counterpart));
		assert.equal(stream.incremental, true);
	}
	assert.deepEqual(
		(browser.streams as Array<{ name: string }>).map((s) => s.name),
		ALL_STREAMS,
	);
});

test("a first run reads the window, active threads, and the directory, then checkpoints", async () => {
	const h = harness(ALL_STREAMS);
	const api = await run(h);

	assert.deepEqual(
		h.of("messages").map((m) => m.id),
		[
			"C0123456789:1790450000.000200",
			"C0123456789:1790400000.000100",
			"C0123456789:1790410000.000400",
			"C0123456789:1790500000.000500",
			"C0123456789:1790300000.000300",
			"C0123456789:1788000000.000600",
			"C0123456789:1790000000.000700",
			"C0987654321:1790460000.001100",
			"C0987654321:1790000000.001200",
			"D0123456789:1790470000.001300",
		],
	);
	assert.equal(h.of("reactions").length, 3);
	assert.equal(h.of("message_attachments").length, 2);
	assert.deepEqual(
		h.of("files").map((f) => f.id),
		["F0987654321"],
	);
	assert.equal(h.of("workspace").length, 1);
	assert.equal(h.of("users").length, 3);
	assert.deepEqual(
		h.of("channels").map((c) => c.id),
		ALL_CHANNELS,
	);
	assert.equal(h.of("user_groups").length, 1);
	assert.equal(h.of("reminders").length, 1);
	assert.equal(h.of("stars").length, 2);
	assert.deepEqual(h.skips(), []);
	assert.deepEqual(h.gaps(), []);

	// The client's own counts and search decide what is read: the quiet
	// channel is never asked for, and the old thread with a recent reply is
	// read directly instead of scanning below the floor for it.
	assert.equal(api.calls.filter((c) => c.method === "client.counts").length, 1);
	assert.equal(
		api.calls.find((c) => c.method === "search.messages")?.params.query,
		"after:2026-09-20",
	);
	const general = historyCalls(api, "C0123456789");
	assert.deepEqual(
		general.map((c) => [c.params.oldest, c.params.latest, c.params.cursor]),
		[
			[String(FLOOR_7D), undefined, undefined],
			[String(FLOOR_7D), undefined, "bmV4dF90czoxNzkwMzAwMDAw"],
		],
	);
	assert.equal(general[0]?.params.limit, "999");
	assert.deepEqual(historyCalls(api, "C0777777777"), []);
	assert.deepEqual(
		api.calls
			.filter((c) => c.method === "conversations.replies")
			.map((c) => c.params.ts),
		["1790400000.000100", "1788000000.000600"],
	);
	assert.equal(
		api.calls.find((c) => c.method === "users.conversations")?.params.types,
		"public_channel,private_channel,im,mpim",
	);

	assert.deepEqual(h.state("messages"), {
		channel_last_ts: {
			C0123456789: "1790450000.000200",
			C0987654321: "1790460000.001100",
			D0123456789: "1790470000.001300",
		},
		floor_ts: FLOOR_7D,
		format: 1,
	});
	for (const stream of [
		"workspace",
		"channels",
		"users",
		"user_groups",
		"reminders",
		"stars",
	]) {
		const cursor = h.state(stream);
		assert.ok(cursor, `${stream} has no STATE`);
		assert.equal(cursor.synced_at, FIXTURE_NOW.toISOString());
		assert.equal(
			Object.keys(cursor.fingerprints as Record<string, string>).length,
			h.of(stream).length,
		);
	}
	const [coverage] = h.coverage();
	assert.equal(coverage?.considered, 5);
	assert.equal(coverage?.covered, 4);
	assert.deepEqual(coverage?.optional_skip_keys, ["C0555555555"]);
	assert.equal(coverage?.gap_keys, undefined);
	assert.deepEqual(coverage?.required_keys, [
		"C0123456789",
		"C0987654321",
		"D0123456789",
		"C0555555555",
	]);
});

test("reading several conversations at once yields the same records", async () => {
	const h = harness(ALL_STREAMS);
	await run(h, fakeApi(), {}, FIXTURE_NOW, 3);
	const sequential = harness(ALL_STREAMS);
	await run(sequential);
	assert.deepEqual(
		h
			.of("messages")
			.map((m) => m.id)
			.sort(),
		sequential
			.of("messages")
			.map((m) => m.id)
			.sort(),
	);
	assert.deepEqual(h.state("messages"), sequential.state("messages"));
});

test("without search, a first read scans below the floor for active threads", async () => {
	const h = harness(["messages"]);
	const api = await run(
		h,
		fakeApi((call) =>
			call.method === "search.messages"
				? { ok: false, error: "missing_scope" }
				: undefined,
		),
	);
	const general = historyCalls(api, "C0123456789");
	assert.deepEqual(
		general.map((c) => [c.params.oldest, c.params.latest]),
		[
			[String(FLOOR_7D), undefined],
			[String(FLOOR_7D), undefined],
			[String(FLOOR_7D - 30 * DAY), String(FLOOR_7D)],
		],
	);
	assert.ok(
		h.of("messages").some((m) => m.id === "C0123456789:1790000000.000700"),
	);
	assert.ok(
		!h.of("messages").some((m) => m.id === "C0123456789:1788100000.000800"),
	);
	assert.deepEqual(historyCalls(api, "C0777777777"), [], "counts still prune");
});

test("without counts, every conversation is read", async () => {
	const h = harness(["messages"]);
	const api = await run(
		h,
		fakeApi((call) =>
			call.method === "client.counts"
				? { ok: false, error: "missing_scope" }
				: undefined,
		),
	);
	assert.equal(historyCalls(api, "C0777777777").length, 1);
	assert.equal(
		historyCalls(api, "C0123456789").length,
		2,
		"search still names the threads",
	);
});

test("asking for the whole history reads every conversation without asking counts or search", async () => {
	const h = harness(["messages"]);
	const api = await run(h, fakeApi(), { lookbackDays: 0 });
	assert.ok(!api.calls.some((c) => c.method === "client.counts"));
	assert.ok(!api.calls.some((c) => c.method === "search.messages"));
	assert.equal(historyCalls(api, "C0777777777").length, 1);
	assert.equal(historyCalls(api, "C0123456789")[0]?.params.oldest, undefined);
});

test("a closed browser page ends the run at once", async () => {
	const h = harness(["messages", "reactions"]);
	await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.history" &&
			call.params.channel === "C0987654321"
				? new SlackApiError("conversations.history", "page_gone", false, null)
				: undefined,
		),
	);
	assert.deepEqual(
		h.skips().map((s) => [s.stream, s.reason]),
		[
			["messages", "collection_interrupted"],
			["reactions", "collection_interrupted"],
		],
	);
	assert.equal(h.messages.filter((m) => m.type === "STATE").length, 0);
});

test("a later run reads from a week before each conversation's cursor and re-emits nothing unchanged", async () => {
	const first = harness(ALL_STREAMS);
	await run(first, fakeApi(), { lookbackDays: 30 });
	const state = Object.fromEntries(
		ALL_STREAMS.map((stream) => [stream, first.state(stream)]),
	);

	const second = harness(ALL_STREAMS, { state });
	const api = await run(
		second,
		fakeApi(),
		{ lookbackDays: 30 },
		new Date(FIXTURE_NOW.getTime() + DAY * 1000),
	);
	const general = historyCalls(api, "C0123456789");
	assert.deepEqual(
		general.map((c) => [c.params.oldest, c.params.latest]),
		[
			[String(1_790_450_000 - 7 * DAY), undefined],
			[String(1_790_450_000 - 7 * DAY), undefined],
		],
	);
	for (const stream of [
		"workspace",
		"channels",
		"users",
		"user_groups",
		"reminders",
		"stars",
	]) {
		assert.deepEqual(second.of(stream), [], `${stream} re-emitted`);
		assert.deepEqual(second.state(stream), first.state(stream));
	}
	assert.ok(second.of("messages").length > 0);
	assert.equal(second.state("messages")?.floor_ts, FLOOR_30D);
});

test("asking for more history than the cursor covers walks every conversation down again", async () => {
	const first = harness(["messages"]);
	await run(first);
	const second = harness(["messages"], {
		state: { messages: first.state("messages") },
	});
	const api = await run(second, fakeApi(), { lookbackDays: 30 });
	const [head] = historyCalls(api, "C0123456789");
	assert.equal(head?.params.oldest, String(FLOOR_30D));
	assert.equal(
		api.calls.find((c) => c.method === "search.messages")?.params.query,
		`after:${new Date((FLOOR_30D - DAY) * 1000).toISOString().slice(0, 10)}`,
	);
	assert.equal(second.state("messages")?.floor_ts, FLOOR_30D);
});

test("asking for less history than the cursor covers keeps the wider floor", async () => {
	const first = harness(["messages"]);
	await run(first, fakeApi(), { lookbackDays: 30 });
	const second = harness(["messages"], {
		state: { messages: first.state("messages") },
	});
	const api = await run(second);
	const [head] = historyCalls(api, "C0123456789");
	assert.equal(head?.params.oldest, String(FLOOR_7D));
	assert.equal(historyCalls(api, "C0123456789").length, 2, "no threads pass");
	assert.equal(second.state("messages")?.floor_ts, FLOOR_30D);
});

test("a full refresh ignores every cursor", async () => {
	const first = harness(ALL_STREAMS);
	await run(first);
	const state = Object.fromEntries(
		ALL_STREAMS.map((stream) => [stream, first.state(stream)]),
	);
	const second = harness(ALL_STREAMS, { mode: "full_refresh", state });
	const api = await run(second);
	assert.equal(
		historyCalls(api, "C0123456789")[0]?.params.oldest,
		String(FLOOR_7D),
	);
	assert.equal(historyCalls(api, "C0123456789").length, 2);
	assert.equal(second.of("users").length, 3);
	assert.equal(second.of("channels").length, 5);
});

test("a requested start later than the lookback floor wins", async () => {
	const h = harness(["messages"], {
		timeRange: { since: "2026-09-25T00:00:00Z" },
	});
	const api = await run(h);
	assert.equal(
		historyCalls(api, "C0123456789")[0]?.params.oldest,
		"1790294400",
	);
});

test("an optional stream Slack refuses is skipped with a reason; the rest continues", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) =>
			call.method === "usergroups.list"
				? { ok: false, error: "missing_scope" }
				: undefined,
		),
	);
	assert.deepEqual(
		h.skips().map((s) => [s.stream, s.reason]),
		[["user_groups", "optional_stream_failed"]],
	);
	assert.equal(h.state("user_groups"), undefined);
	assert.ok(h.state("reminders"));
	assert.ok(h.state("stars"));
	assert.equal(h.of("reminders").length, 1);
});

test("a lost session ends the run: every stream is skipped and no cursor moves", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.history" &&
			call.params.channel === "C0987654321"
				? new SlackSessionLostError("invalid_auth")
				: undefined,
		),
	);
	assert.deepEqual(
		h.skips().map((s) => s.stream),
		ALL_STREAMS,
	);
	assert.ok(h.skips().every((s) => s.reason === "sign_in_required"));
	assert.equal(h.messages.filter((m) => m.type === "STATE").length, 0);
	assert.equal(h.of("users").length, 3, "what was read stays read");
	assert.ok(h.of("messages").length > 0);
});

test("a conversation Slack stopped answering is a gap; its cursor stays put", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.history" &&
			call.params.channel === "C0987654321"
				? new SlackApiError("conversations.history", "http_503", true, 503)
				: undefined,
		),
	);
	assert.deepEqual(h.skips(), []);
	const [gap] = h.gaps();
	assert.equal(gap?.record_key, "C0987654321");
	assert.equal(gap?.reason, "retry_exhausted");
	assert.equal(gap?.stream, "messages");
	assert.deepEqual(gap?.detail_locator, {
		kind: "slack_conversation",
		channel_id: "C0987654321",
		team_id: "T0123456789",
	});
	const [coverage] = h.coverage();
	assert.deepEqual(coverage?.gap_keys, ["C0987654321"]);
	assert.equal(coverage?.covered, 3);
	const cursor = h.state("messages")?.channel_last_ts as Record<string, string>;
	assert.equal(cursor.C0987654321, undefined);
	assert.equal(cursor.C0123456789, "1790450000.000200");
});

test("the browser leaving app.slack.com interrupts the run", async () => {
	const h = harness(["workspace", "users"]);
	await run(
		h,
		fakeApi((call) =>
			call.method === "users.list"
				? new SlackApiError(
						"users.list",
						"wrong_origin:https://acme.slack.com",
						false,
						null,
					)
				: undefined,
		),
	);
	assert.deepEqual(
		h.skips().map((s) => [s.stream, s.reason]),
		[
			["workspace", "collection_interrupted"],
			["users", "collection_interrupted"],
		],
	);
});

test("an answer this connector does not recognise on a required stream fails closed", async () => {
	const h = harness(["users", "channels"]);
	await run(
		h,
		fakeApi((call) =>
			call.method === "users.list" ? { ok: true, members: "nope" } : undefined,
		),
	);
	assert.deepEqual(
		h.skips().map((s) => [s.stream, s.reason]),
		[
			["users", "source_unreadable"],
			["channels", "source_unreadable"],
		],
	);
	assert.deepEqual(h.of("users"), []);
});

test("conversation kinds and the allowlist narrow what is asked for", async () => {
	const kinds = harness(["messages"]);
	const kindsApi = await run(kinds, fakeApi(), { channelTypes: ["im"] });
	assert.equal(
		kindsApi.calls.find((c) => c.method === "users.conversations")?.params
			.types,
		"im",
	);

	const allow = harness(["messages", "channels"]);
	const allowApi = await run(allow, fakeApi(), {
		channelAllowlist: ["General"],
	});
	assert.deepEqual(
		allow.of("channels").map((c) => c.id),
		["C0123456789"],
	);
	assert.deepEqual(
		[
			...new Set(
				allowApi.calls
					.filter((c) => c.method === "conversations.history")
					.map((c) => c.params.channel),
			),
		],
		["C0123456789"],
	);
});

test("only requested streams are read and emitted", async () => {
	const users = harness(["users"]);
	const usersApi = await run(users);
	assert.deepEqual(
		usersApi.calls.map((c) => c.method),
		["users.list"],
	);

	const messages = harness(["messages"]);
	const messagesApi = await run(messages);
	assert.ok(messagesApi.calls.some((c) => c.method === "users.conversations"));
	assert.ok(!messagesApi.calls.some((c) => c.method === "auth.test"));
	assert.deepEqual(messages.of("channels"), []);
	assert.deepEqual(messages.of("reactions"), []);
	assert.ok(messages.of("messages").length > 0);
	assert.deepEqual(
		messages.messages.filter((m) => m.type === "STATE").map((m) => m.stream),
		["messages"],
	);
});

// ─── Session ────────────────────────────────────────────────────────────

function sessionPage(opts: {
	cookies?: Array<{ name: string; value: string }>;
	status?: number;
	throws?: boolean;
	url?: string;
	visits?: string[];
}): SlackSessionPage & { goto: (url: string) => Promise<null> } {
	return {
		goto: async (url: string) => {
			opts.visits?.push(url);
			return null;
		},
		context: () => ({
			cookies: async () => opts.cookies ?? [],
			request: {
				get: async () => {
					if (opts.throws) {
						throw new Error("boom");
					}
					return {
						status: () => opts.status ?? 200,
						url: () => opts.url ?? CLIENT_URL,
						dispose: async () => {
							// nothing to release
						},
					};
				},
			},
		}),
	} as unknown as SlackSessionPage & { goto: (url: string) => Promise<null> };
}

const SESSION_COOKIE = [{ name: "d", value: "xoxd-session" }];

test("the session probe needs the d cookie and a client that does not bounce to sign-in", async () => {
	assert.equal(await probeSlackSession(sessionPage({})), false);
	assert.equal(
		await probeSlackSession(
			sessionPage({ cookies: [{ name: "b", value: "x" }] }),
		),
		false,
	);
	assert.equal(
		await probeSlackSession(sessionPage({ cookies: SESSION_COOKIE })),
		true,
	);
	assert.equal(
		await probeSlackSession(
			sessionPage({
				cookies: SESSION_COOKIE,
				url: "https://slack.com/signin?redir=%2Fclient",
			}),
		),
		false,
	);
	assert.equal(
		await probeSlackSession(
			sessionPage({ cookies: SESSION_COOKIE, status: 403 }),
		),
		false,
	);
	assert.equal(
		await probeSlackSession(
			sessionPage({ cookies: SESSION_COOKIE, throws: true }),
		),
		false,
	);
});

function sessionArgs(
	page: ReturnType<typeof sessionPage>,
	onAssist: () => void,
	statuses: string[],
): EnsureSessionArgs {
	return Object.assign(Object.create(null) as EnsureSessionArgs, {
		assist: async () => {
			onAssist();
			return "assist-1";
		},
		completeAssistance: async (_id: string, status: string) => {
			statuses.push(status);
		},
		page,
		progress: async () => {
			// host-facing only
		},
	});
}

test("a live session needs no sign-in", async () => {
	const visits: string[] = [];
	const statuses: string[] = [];
	await ensureSlackSession(
		sessionArgs(
			sessionPage({ cookies: SESSION_COOKIE, visits }),
			() => {
				throw new Error("unexpected assistance");
			},
			statuses,
		),
	);
	assert.deepEqual(visits, []);
	assert.deepEqual(statuses, []);
});

test("without a session, the owner signs in on the sign-in page", async () => {
	const visits: string[] = [];
	const statuses: string[] = [];
	const cookies: Array<{ name: string; value: string }> = [];
	await ensureSlackSession(
		sessionArgs(
			sessionPage({ cookies, visits }),
			() => {
				cookies.push(...SESSION_COOKIE);
			},
			statuses,
		),
	);
	assert.deepEqual(visits, [SIGNIN_URL]);
	assert.deepEqual(statuses, ["resolved"]);
});

function clientPage(
	answers: unknown[],
	urls: string[],
): SlackClientPage & {
	visits: string[];
} {
	const visits: string[] = [];
	return {
		visits,
		evaluate: async () => answers.shift() ?? [],
		goto: async (url: string) => {
			visits.push(url);
			return null;
		},
		url: () => urls.shift() ?? CLIENT_URL,
	} as unknown as SlackClientPage & { visits: string[] };
}

test("opening the client waits out Slack's desktop-launch page and ends on the light page", async () => {
	const page = clientPage(
		[[], [{ id: TEAM.id, name: "Acme", domain: "acme", url: TEAM.url }]],
		["https://acme.slack.com/ssb/redirect"],
	);
	const teams = await openSlackClient(page, 0, 10_000);
	assert.deepEqual(teams, [TEAM]);
	assert.deepEqual(page.visits, [CLIENT_URL, CLIENT_URL, LIGHT_URL]);
});

test("a client that never loads a session yields no teams", async () => {
	const page = clientPage([], []);
	assert.deepEqual(await openSlackClient(page, 0, 0), []);
	assert.deepEqual(page.visits, [CLIENT_URL]);
});

test("SLACK_WORKSPACE picks a workspace by subdomain, id, name or URL", () => {
	const other = {
		id: "T0999999999",
		name: "Other",
		domain: "other",
		url: "https://other.slack.com/",
	};
	assert.deepEqual(selectTeams([TEAM, other], ""), [TEAM, other]);
	assert.deepEqual(selectTeams([TEAM, other], "other"), [other]);
	assert.deepEqual(selectTeams([TEAM, other], "T0123456789"), [TEAM]);
	assert.deepEqual(selectTeams([TEAM, other], "ACME"), [TEAM]);
	assert.deepEqual(selectTeams([TEAM, other], "https://acme.slack.com/"), [
		TEAM,
	]);
	assert.deepEqual(selectTeams([TEAM, other], "nobody"), []);
});

test("options come from SLACK_* variables with the archive profile's defaults", () => {
	const saved = { ...process.env };
	try {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("SLACK_")) {
				delete process.env[key];
			}
		}
		assert.deepEqual(readSlackBrowserOptions(), DEFAULT_OPTIONS);
		process.env.SLACK_LOOKBACK_DAYS = "30";
		process.env.SLACK_CHANNEL_TYPES = "public,IM,bogus";
		process.env.SLACK_CHANNEL_ALLOWLIST = "general, eng-alerts";
		process.env.SLACK_WORKSPACE = " acme ";
		assert.deepEqual(readSlackBrowserOptions(), {
			channelAllowlist: ["general", "eng-alerts"],
			channelTypes: ["public", "im"],
			lookbackDays: 30,
			workspace: "acme",
		});
		process.env.SLACK_LOOKBACK_DAYS = "-3";
		assert.equal(readSlackBrowserOptions().lookbackDays, 7);
	} finally {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("SLACK_")) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, saved);
	}
});

test("collect skips every stream when the client has no signed-in workspace", async () => {
	const skips: Array<{ reason: string; stream: string }> = [];
	const page = clientPage([], []);
	const ctx = {
		emit: async (message: { reason?: string; stream?: string }) => {
			skips.push({
				reason: message.reason ?? "",
				stream: message.stream ?? "",
			});
		},
		page: Object.assign(page, {
			context: () => ({
				cookies: async () => [],
				request: {
					get: async () => ({
						status: () => 200,
						url: () => CLIENT_URL,
						dispose: async () => undefined,
					}),
				},
			}),
		}),
		progress: async () => undefined,
		requested: new Map([["users", { name: "users" }]]),
		state: {},
	} as unknown as BrowserCollectContext;
	const savedTimeout = process.env.SLACK_WORKSPACE;
	delete process.env.SLACK_WORKSPACE;
	try {
		await collect(ctx, { pollMs: 0, timeoutMs: 0 });
	} finally {
		if (savedTimeout !== undefined) {
			process.env.SLACK_WORKSPACE = savedTimeout;
		}
	}
	assert.deepEqual(skips, [{ reason: "sign_in_required", stream: "users" }]);
});

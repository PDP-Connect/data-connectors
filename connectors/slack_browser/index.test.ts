// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	consentTimeFieldResolver,
	type StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { EnsureSessionArgs } from "../../packages/polyfill-connectors/src/session-establish.ts";
import { collectSlackBrowser } from "./collector.ts";
import {
	CLIENT_URL,
	CONNECTOR_CONFIG,
	collect,
	ensureSlackSession,
	LIGHT_URL,
	openSlackClient,
	probeSlackPage,
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
	fixture,
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
		// query.aggregations is a per-profile query affordance, not part of
		// the record contract: the archive profile allowlists group_by_time
		// away on its admin streams, while this profile declares what the
		// query honesty gate asks of it. The record contract a reader sees —
		// schema, keys, cursors, selection, search — stays identical.
		const contract = (s: Record<string, unknown>) => {
			const entry = Object.fromEntries(
				Object.entries(s).filter(([k]) => !prose.has(k)),
			);
			if (entry.query !== undefined) {
				const query = {
					...(entry.query as Record<string, unknown>),
				};
				delete query.aggregations;
				entry.query = query;
			}
			return entry;
		};
		assert.deepEqual(contract(stream), contract(counterpart));
		const declaredAggregations = (
			counterpart.query as { aggregations?: unknown } | undefined
		)?.aggregations;
		if (declaredAggregations !== undefined) {
			assert.deepEqual(
				(stream.query as { aggregations?: unknown })?.aggregations,
				declaredAggregations,
				`${String(stream.name)} aggregations drift from the archive profile's`,
			);
		}
		assert.equal(stream.incremental, true);
	}
	assert.deepEqual(
		(browser.streams as Array<{ name: string }>).map((s) => s.name),
		ALL_STREAMS,
	);
});

test("the run starts under the shipped manifest: no timeRangeField override", () => {
	// The manifest's per-stream consent_time_field is the only time-range
	// authority for a shipped connector: runConnector refuses to start when a
	// timeRangeField is passed alongside it, so every run of this connector
	// would die at startup if the config carried one. The resolver — the
	// first thing runConnector builds — must accept the config as-is and
	// answer from the manifest: messages carries consent_time_field sent_at,
	// workspace carries none (never the connector's own run clock).
	assert.equal(
		"timeRangeField" in CONNECTOR_CONFIG,
		false,
		"CONNECTOR_CONFIG must not carry a timeRangeField override",
	);
	const config = CONNECTOR_CONFIG as {
		timeRangeField?: (stream: string) => string;
	};
	const resolver = consentTimeFieldResolver(
		"slack_browser",
		config.timeRangeField,
	);
	assert.equal(resolver("messages")?.field, "sent_at");
	assert.equal(resolver("workspace"), null);
	assert.equal(resolver("channels"), null);
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
	// The live reminders.list answers an empty array; the proven-empty
	// enumeration is asserted in its own test below.
	assert.equal(h.of("reminders").length, 0);
	assert.equal(h.of("stars").length, 2);
	assert.deepEqual(h.skips(), []);
	assert.deepEqual(h.gaps(), []);

	// The walk never consults client.counts: its latest moves only when a
	// message lands, so it cannot vouch for a reaction or an edit landing on
	// the newest message it already reports, and a conversation skipped on
	// counts would stay skipped for exactly those changes. Every conversation
	// is read from its own starting line, and search decides the active
	// threads the run still reads directly.
	assert.equal(api.calls.filter((c) => c.method === "client.counts").length, 0);
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
	// C0777777777 is quiet, but this run has never read it: counts' latest
	// does not move for a reaction or an edit landing on the newest message,
	// so it cannot vouch for a conversation nobody has walked yet. The first
	// read walks it (an empty window); only a later run, from the stored
	// cursor of its own read, may skip it.
	assert.equal(historyCalls(api, "C0777777777").length, 1);
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
	const coverage = h
		.coverage()
		.find((c) => c.stream === "messages" && c.state_stream === "messages");
	// C0555555555 answers not_in_channel: Slack refuses it to this session,
	// so it is reported but not required, and the checkpoint can commit.
	assert.equal(coverage?.considered, 4);
	assert.equal(coverage?.covered, 4);
	assert.deepEqual(coverage?.optional_skip_keys, ["C0555555555"]);
	assert.equal(coverage?.gap_keys, undefined);
	assert.deepEqual(coverage?.required_keys, [
		"C0123456789",
		"C0987654321",
		"D0123456789",
		"C0777777777",
	]);
	for (const key of coverage?.required_keys ?? []) {
		assert.ok(
			[...(coverage?.hydrated_keys ?? [])].includes(key),
			`${key} is required but not hydrated`,
		);
	}
});

test("an empty reminders.list is a proven-empty enumeration, not a partial run", async () => {
	const h = harness(["reminders"]);
	const api = await run(h);
	assert.ok(api.calls.some((c) => c.method === "reminders.list"));
	assert.deepEqual(h.of("reminders"), []);
	assert.deepEqual(h.skips(), []);
	// The live account has no reminders. The run still says so itself: a
	// full-scan coverage message declaring the empty boundary is what keeps
	// the run `ok` instead of a partial that merely lacks evidence.
	const coverage = h.coverage().find((c) => c.stream === "reminders");
	assert.deepEqual(coverage, {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "reminders",
		state_stream: "reminders",
		required_keys: [],
		hydrated_keys: [],
		considered: 0,
		covered: 0,
	});
	assert.ok(h.state("reminders"), "the empty scan still checkpoints");
});

test("message_attachments and reactions report coverage for the messages read; files checkpoints itself", async () => {
	const h = harness(["messages", "message_attachments", "reactions", "files"]);
	await run(h);
	const messageIds = h.of("messages").map((m) => m.id);
	assert.ok(messageIds.length > 0);
	// The two parent_detail_accounting streams hang off the messages read
	// this run; every message's details ride on the message object, so each
	// read message is hydrated for both, and neither may go silent about it.
	for (const stream of ["message_attachments", "reactions"]) {
		const coverage = h.coverage().find((c) => c.stream === stream);
		assert.ok(coverage, `${stream} reports no coverage`);
		assert.equal(coverage.state_stream, "messages");
		assert.deepEqual(coverage.required_keys, messageIds);
		assert.deepEqual(coverage.hydrated_keys, messageIds);
		assert.equal(coverage.gap_keys, undefined);
		assert.equal(coverage.considered, messageIds.length);
		assert.equal(coverage.covered, messageIds.length);
	}
	// files is checkpoint_window and its own checkpoint parent (the archive
	// profile's contract): no DETAIL_COVERAGE under messages, its own STATE.
	assert.equal(
		h.coverage().find((c) => c.stream === "files"),
		undefined,
	);
	assert.ok(h.state("files"), "files has no STATE");
});

test("a file with no id is reported, never gapped or recovered, and the checkpoints commit", async () => {
	const idless = (call: { method: string; params: Record<string, string> }) =>
		call.method === "conversations.history" &&
		call.params.channel === "C0987654321" &&
		call.params.cursor === undefined
			? {
					ok: true,
					messages: [
						{
							type: "message",
							user: "U0987654321",
							text: "the diagram",
							ts: "1790460000.001100",
							files: [{ name: "diagram.png", mimetype: "image/png" }],
						},
					],
					has_more: false,
				}
			: undefined;
	const h = harness(["messages", "files"]);
	await run(h, fakeApi(idless));
	// The message still says it has the file; the file itself has no id to
	// be keyed by, so it can never be a record, and Slack serves it the same
	// way on every run. Nothing retry could close is filed as a gap, nothing
	// still missing is announced as recovered, and the checkpoints commit.
	const message = h
		.of("messages")
		.find((m) => m.id === "C0987654321:1790460000.001100");
	assert.ok(message, "the message was read");
	assert.equal(message.has_files, true);
	assert.equal(message.file_count, 1);
	assert.deepEqual(
		h.gaps().filter((g) => g.stream === "files"),
		[],
	);
	assert.deepEqual(
		h.messages.filter(
			(m) => m.type === "DETAIL_GAP_RECOVERED" && m.stream === "files",
		),
		[],
	);
	assert.ok(h.state("files"), "files checkpoints");
	assert.ok(h.state("messages"), "messages checkpoints");
	assert.ok(
		h.progress.some(
			(p) =>
				p.stream === "files" &&
				/1 messages named a file Slack served with no id/.test(p.message),
		),
		"the id-less file is reported",
	);
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
	// counts cannot vouch for a conversation nobody has walked: its latest
	// does not move for a reaction or an edit, so the first read walks even
	// the quiet conversation — the head window and, with search out, the
	// below-floor thread scan — and only a later run, from the stored cursor
	// of the conversation's own read, may skip it.
	assert.deepEqual(
		historyCalls(api, "C0777777777").map((c) => [
			c.params.oldest,
			c.params.latest,
		]),
		[
			[String(FLOOR_7D), undefined],
			[String(FLOOR_7D - 30 * DAY), String(FLOOR_7D)],
		],
	);
});

test("the walk never consults client.counts; every conversation is read", async () => {
	const h = harness(["messages"]);
	const api = await run(h);
	assert.ok(
		!api.calls.some((c) => c.method === "client.counts"),
		"counts cannot vouch for reactions or edits, so it is not asked",
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
		// The fingerprint payload is unchanged: synced_at is each run's own
		// scan time, so it moves between runs even when nothing else does.
		assert.deepEqual(
			second.state(stream)?.fingerprints,
			first.state(stream)?.fingerprints,
		);
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

test("a later run re-reads every conversation from a week before its cursor", async () => {
	// counts' latest moves only when a new message lands: a reaction or an
	// edit on the newest message does not move it, so no counts answer can
	// stand in for the conversation's own read. A later run therefore walks
	// every conversation again from a week before its stored cursor — the
	// window a late reaction lands in — instead of skipping the quiet ones.
	const first = harness(["messages"]);
	const api = await run(first);
	assert.equal(historyCalls(api, "C0777777777").length, 1);
	assert.ok(
		!api.calls.some((c) => c.method === "client.counts"),
		"counts are never consulted",
	);

	const second = harness(["messages"], {
		state: {
			messages: {
				channel_last_ts: { C0777777777: "1790500000.000900" },
				floor_ts: FIXTURE_NOW_SECONDS - 30 * DAY,
				format: 1,
			},
		},
	});
	const secondApi = await run(second, fakeApi(), { lookbackDays: 30 });
	const quiet = historyCalls(secondApi, "C0777777777");
	assert.deepEqual(
		quiet.map((c) => [c.params.oldest, c.params.latest]),
		[[String(1_790_500_000 - 7 * DAY), undefined]],
		"the re-read starts a week before the cursor",
	);
	const coverage = second
		.coverage()
		.find((c) => c.stream === "messages" && c.state_stream === "messages");
	assert.deepEqual(coverage?.optional_skip_keys, ["C0555555555"]);
	assert.equal(coverage?.covered, 4, "every readable conversation is covered");
	assert.deepEqual(coverage?.gap_keys, undefined);
	assert.ok(
		!secondApi.calls.some((c) => c.method === "client.counts"),
		"counts are never consulted",
	);
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

/** A fake that filters a channel's history the way Slack's `oldest` does. */
function historyFilteredByOldest(channel: string) {
	return fakeApi((call) =>
		call.method === "conversations.history" && call.params.channel === channel
			? {
					ok: true,
					messages: (
						fixture(`conversations.history-${channel}-p1`) as {
							messages: Array<{ ts: string }>;
						}
					).messages.filter(
						(message) => Number(message.ts) >= Number(call.params.oldest ?? 0),
					),
					has_more: false,
					pin_count: 0,
					response_metadata: { next_cursor: "" },
				}
			: undefined,
	);
}

/**
 * A harness whose messages scope carries the `time_range` exactly as the
 * runtime hands it over, so the tests below exercise the consent_time_field
 * window the manifest declares.
 */
function timeRangeHarness(timeRange: { since?: string; until?: string }) {
	const h = harness(["messages"]);
	h.ctx.requested = new Map<string, StreamScope>([
		["messages", { name: "messages", time_range: timeRange } as StreamScope],
	]);
	return h;
}

test("a requested time range leaves the records before it unemitted", async () => {
	// The consent_time_field the manifest declares is push-down-able: the walk
	// starts at the requested start, so a record older than it is neither
	// requested nor emitted.
	const h = timeRangeHarness({ since: "2026-09-25T00:00:00Z" });
	const api = await run(h, historyFilteredByOldest("C0987654321"));
	assert.equal(
		historyCalls(api, "C0987654321")[0]?.params.oldest,
		"1790294400",
	);
	assert.ok(
		h.of("messages").some((m) => m.id === "C0987654321:1790460000.001100"),
		"the record inside the window is emitted",
	);
	assert.ok(
		!h.of("messages").some((m) => m.id === "C0987654321:1790000000.001200"),
		"the record before the window is not emitted",
	);
});

test("a wider time range with the first run's STATE reads the older records", async () => {
	const narrow = timeRangeHarness({ since: "2026-09-25T00:00:00Z" });
	await run(narrow, historyFilteredByOldest("C0987654321"));
	assert.ok(
		!narrow
			.of("messages")
			.some((m) => m.id === "C0987654321:1790000000.001200"),
	);
	assert.equal(narrow.state("messages")?.floor_ts, 1_790_294_400);

	const wider = timeRangeHarness({ since: "2026-09-20T00:00:00Z" });
	wider.ctx.state = { messages: narrow.state("messages") };
	const widerApi = await run(wider, historyFilteredByOldest("C0987654321"));
	// The stored floor no longer covers what the wider window asks for, so
	// every conversation is walked down to the wider floor and the record
	// between the two windows comes out.
	assert.equal(
		historyCalls(widerApi, "C0987654321")[0]?.params.oldest,
		String(FLOOR_7D),
	);
	assert.ok(
		wider.of("messages").some((m) => m.id === "C0987654321:1790000000.001200"),
		"the record between the two windows is read on the wider run",
	);
	assert.equal(wider.state("messages")?.floor_ts, FLOOR_7D);
});

test("an optional stream Slack refuses is skipped with a reason; the rest continues", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) => {
			if (call.method === "usergroups.list") {
				return { ok: false, error: "missing_scope" };
			}
			// The live reminders.list answers empty; a non-empty list is a
			// synthetic reminder so the read path keeps its coverage here.
			if (call.method === "reminders.list") {
				return {
					ok: true,
					reminders: [
						{
							id: "Rm0123456789",
							creator: "U0123456789",
							user: "U0123456789",
							text: "Rotate the API key",
							recurring: false,
							time: 1_790_640_000,
							complete_ts: 0,
						},
					],
				};
			}
			return undefined;
		}),
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
	const coverage = h
		.coverage()
		.find((c) => c.stream === "messages" && c.state_stream === "messages");
	assert.deepEqual(coverage?.gap_keys, ["C0987654321"]);
	assert.equal(coverage?.covered, 3);
	const cursor = h.state("messages")?.channel_last_ts as Record<string, string>;
	assert.equal(cursor.C0987654321, undefined);
	assert.equal(cursor.C0123456789, "1790450000.000200");
});

test("a replies answer this connector cannot parse fails the run closed", async () => {
	const h = harness(ALL_STREAMS);
	const api = await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.replies" &&
			call.params.ts === "1790400000.000100"
				? { ok: true, messages: [{ type: "message", ts: "not-a-slack-ts" }] }
				: undefined,
		),
	);
	// An answer the connector cannot parse is not a per-thread refusal: the
	// conversation's read fails instead of silently truncating the thread, so
	// no later thread of the conversation was read either. And Slack will
	// answer the same unparseable shape on every run, so the fault is
	// permanent: the run ends closed with the source_unreadable skip the
	// runtime surfaces, never as a gap the runtime retried forever.
	assert.deepEqual(
		api.calls
			.filter((c) => c.method === "conversations.replies")
			.map((c) => c.params.ts),
		["1790400000.000100"],
	);
	assert.deepEqual(
		h.skips().map((s) => [s.stream, s.reason]),
		ALL_STREAMS.map((stream) => [stream, "source_unreadable"]),
	);
	assert.equal(h.messages.filter((m) => m.type === "STATE").length, 0);
	assert.deepEqual(
		h.coverage().filter((c) => c.state_stream === "messages"),
		[],
		"no coverage claims a conversation the run could not read",
	);
});

test("a conversation whose history never says it ends is a gap, not a cursor", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.history" &&
			call.params.channel === "C0987654321"
				? {
						ok: true,
						messages: [],
						has_more: true,
						response_metadata: { next_cursor: "never-ends" },
					}
				: undefined,
		),
	);
	const [gap] = h.gaps();
	assert.equal(gap?.record_key, "C0987654321");
	assert.equal(gap?.reason, "temporary_unavailable");
	const coverage = h
		.coverage()
		.find((c) => c.stream === "messages" && c.state_stream === "messages");
	assert.deepEqual(coverage?.gap_keys, ["C0987654321"]);
	const cursor = h.state("messages")?.channel_last_ts as Record<string, string>;
	assert.equal(cursor.C0987654321, undefined, "the cursor stays put");
	assert.equal(cursor.C0123456789, "1790450000.000200");
});

test("a thread whose replies never say they end fails the conversation's read", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.replies" &&
			call.params.ts === "1790400000.000100"
				? {
						ok: true,
						messages: [],
						has_more: true,
						response_metadata: { next_cursor: "never-ends" },
					}
				: undefined,
		),
	);
	const [gap] = h.gaps();
	assert.equal(gap?.record_key, "C0123456789");
	assert.equal(gap?.reason, "temporary_unavailable");
	const cursor = h.state("messages")?.channel_last_ts as Record<string, string>;
	assert.equal(cursor.C0123456789, undefined, "the cursor stays put");
});

test("a search page that does not report its own paging does not claim the thread list is complete", async () => {
	const h = harness(ALL_STREAMS);
	const api = await run(
		h,
		fakeApi((call) =>
			call.method === "search.messages"
				? {
						ok: true,
						messages: {
							total: 1,
							matches: [
								{
									iid: "3f2c9a58-6d38-4a7e-9b1f-2f4a9c8d1e01",
									team: "T0123456789",
									ts: "1790500000.000900",
									user: "U0123456789",
									username: "Synthetic User",
									text: "Synthetic text",
									permalink:
										"https://acme.slack.com/archives/C0123456789/p1790500000000900?thread_ts=1790300000.000300&cid=C0123456789",
									channel: { id: "C0123456789", is_channel: true },
								},
							],
						},
					}
				: undefined,
		),
	);
	// Without the paging block the end of the search list is unproven, so the
	// thread list is not trusted: the first read of every conversation scans
	// below the floor for active threads instead.
	const scan = api.calls.find(
		(c) =>
			c.method === "conversations.history" &&
			c.params.channel === "C0123456789" &&
			c.params.latest !== undefined,
	);
	assert.ok(scan, "the threads-only scan below the floor ran");
	assert.equal(scan?.params.latest, String(FLOOR_7D));
	assert.equal(scan?.params.oldest, String(FLOOR_7D - 30 * DAY));
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
	// channels is the parent every message references: the conversations the
	// message family reads are listed and emitted too, so a message never
	// lands without its channel in the same run.
	assert.deepEqual(
		messages.of("channels").map((c) => c.id),
		ALL_CHANNELS,
	);
	assert.deepEqual(messages.of("reactions"), []);
	assert.ok(messages.of("messages").length > 0);
	assert.deepEqual(
		messages.messages.filter((m) => m.type === "STATE").map((m) => m.stream),
		["messages"],
	);

	// A detail-only run keeps the same promise one level down: the messages
	// its files hang off are emitted as the children's parent, and so are the
	// channels those messages reference — the whole parent chain, whatever
	// the requested set says.
	const filesOnly = harness(["files"]);
	const filesApi = await run(filesOnly);
	assert.ok(filesApi.calls.some((c) => c.method === "users.conversations"));
	assert.ok(filesOnly.of("messages").length > 0);
	assert.ok(filesOnly.of("files").length > 0);
	assert.deepEqual(
		filesOnly.of("channels").map((c) => c.id),
		ALL_CHANNELS,
	);
	assert.deepEqual(filesOnly.of("message_attachments"), []);
	assert.deepEqual(
		filesOnly.messages.filter((m) => m.type === "STATE").map((m) => m.stream),
		["messages", "files"],
	);
});

// ─── Session ────────────────────────────────────────────────────────────

function sessionPage(opts: {
	/** Whether the web client answers as signed in; otherwise it bounces to the sign-in page. */
	live?: boolean;
	status?: number;
	throws?: boolean;
	url?: string;
	visits?: string[];
}): SlackSessionPage & {
	goto: (url: string) => Promise<null>;
	live: { live: boolean };
} {
	const state = { live: opts.live ?? false };
	return Object.assign(
		{
			goto: async (url: string) => {
				opts.visits?.push(url);
				return null;
			},
			context: () => ({
				request: {
					get: async () => {
						if (opts.throws) {
							throw new Error("boom");
						}
						return {
							status: () => opts.status ?? 200,
							url: () =>
								opts.url ??
								(state.live
									? CLIENT_URL
									: "https://slack.com/signin?redir=%2Fclient"),
							dispose: async () => {
								// nothing to release
							},
						};
					},
				},
			}),
		},
		{ live: state },
	) as unknown as SlackSessionPage & {
		goto: (url: string) => Promise<null>;
		live: { live: boolean };
	};
}

test("the session probe needs a client that answers itself, not the sign-in page", async () => {
	assert.equal(await probeSlackSession(sessionPage({})), false);
	assert.equal(await probeSlackSession(sessionPage({ live: true })), true);
	assert.equal(
		await probeSlackSession(
			sessionPage({
				live: true,
				url: "https://slack.com/signin?redir=%2Fclient",
			}),
		),
		false,
	);
	assert.equal(
		await probeSlackSession(sessionPage({ live: true, status: 403 })),
		false,
	);
	assert.equal(
		await probeSlackSession(sessionPage({ live: true, throws: true })),
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
			sessionPage({ live: true, visits }),
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
	const page = sessionPage({ visits });
	await ensureSlackSession(
		sessionArgs(
			page,
			() => {
				page.live.live = true;
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
		// Location reads are the bare `() => location.href` function; team reads pass an origin.
		evaluate: async (_fn: unknown, arg?: unknown) =>
			arg === undefined
				? (urls.shift() ?? CLIENT_URL)
				: (answers.shift() ?? []),
		goto: async (url: string) => {
			visits.push(url);
			return null;
		},
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

/** A PageShim-like page: evaluate only, answering by the in-page function it is given. */
function pageOnly(answers: {
	hasSession: boolean;
	teams?: unknown[];
	authTest?: unknown;
}): Parameters<typeof probeSlackPage>[0] & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		evaluate: async (fn: { name?: string }) => {
			calls.push(fn.name ?? "");
			switch (fn.name) {
				case "pageHasSlackSession":
					return answers.hasSession;
				case "readTeamsFromPage":
					return answers.teams ?? [];
				case "callFromPage":
					return answers.authTest;
				default:
					throw new Error(`unexpected in-page call ${fn.name}`);
			}
		},
	} as unknown as Parameters<typeof probeSlackPage>[0] & { calls: string[] };
}

test("the page-only sign-in check needs a token in the page and Slack accepting it", async () => {
	const team = { id: TEAM.id, name: "Acme", domain: "acme", url: TEAM.url };
	const ok = {
		kind: "http",
		status: 200,
		retryAfterSeconds: null,
		body: '{"ok":true}',
	};
	assert.equal(await probeSlackPage(pageOnly({ hasSession: false })), false);
	const noSession = pageOnly({ hasSession: false });
	await probeSlackPage(noSession);
	assert.deepEqual(
		noSession.calls,
		["pageHasSlackSession"],
		"no API call before a token exists",
	);
	assert.equal(
		await probeSlackPage(
			pageOnly({ hasSession: true, teams: [team], authTest: ok }),
		),
		true,
	);
	assert.equal(
		await probeSlackPage(
			pageOnly({
				hasSession: true,
				teams: [team],
				authTest: { ...ok, body: '{"ok":false,"error":"invalid_auth"}' },
			}),
		),
		false,
	);
	assert.equal(
		await probeSlackPage(
			pageOnly({
				hasSession: true,
				teams: [team],
				authTest: { ...ok, status: 401 },
			}),
		),
		false,
	);
	assert.equal(
		await probeSlackPage(pageOnly({ hasSession: true, teams: [] })),
		false,
	);
});

test("a session-wide Slack refusal on history fails the run closed instead of emptying the inventory", async () => {
	const h = harness(ALL_STREAMS);
	await run(
		h,
		fakeApi((call) =>
			call.method === "conversations.history"
				? { ok: false, error: "missing_scope" }
				: undefined,
		),
	);
	// missing_scope would hit every conversation alike: it is not a refusal of
	// one conversation, so nothing is moved out of the required keys and no
	// cursor claims the window was read.
	assert.equal(h.state("messages"), undefined);
	assert.equal(h.state("files"), undefined);
	assert.ok(h.skips().some((s) => s.stream === "messages"));
	for (const c of h.coverage().filter((c) => c.stream === "messages")) {
		assert.deepEqual(c.optional_skip_keys ?? [], []);
	}
});

test("only thread_not_found ends a thread quietly; another refusal of replies is not read as a whole thread", async () => {
	const gone = harness(["messages"]);
	await run(
		gone,
		fakeApi((call) =>
			call.method === "conversations.replies" &&
			call.params.ts === "1790400000.000100"
				? { ok: false, error: "thread_not_found" }
				: undefined,
		),
	);
	const goneCoverage = gone
		.coverage()
		.find((c) => c.stream === "messages" && c.state_stream === "messages");
	assert.ok(goneCoverage?.hydrated_keys?.includes("C0123456789"));

	const refused = harness(["messages"]);
	await run(
		refused,
		fakeApi((call) =>
			call.method === "conversations.replies" &&
			call.params.ts === "1790400000.000100"
				? { ok: false, error: "missing_scope" }
				: undefined,
		),
	);
	// The thread was not read, so its conversation is never counted hydrated.
	assert.equal(refused.state("messages"), undefined);
	for (const c of refused.coverage().filter((c) => c.stream === "messages")) {
		assert.ok(!c.hydrated_keys?.includes("C0123456789"));
	}
});

test("with no pending gap in START, no gap page is requested (a host that does not page gaps never answers)", async () => {
	const h = harness(ALL_STREAMS);
	let asked = 0;
	h.ctx.requestDetailGapPage = async () => {
		// A host that does not page gaps would never answer; count instead of hanging.
		asked += 1;
		return [];
	};
	await run(h);
	assert.equal(asked, 0);
	assert.ok(h.state("messages"));
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The page-ceiling correction: exhausting the guard and receiving no
 * `next_token` used to produce a byte-identical result, so a capped walk read
 * as a finished one. Oura's cursor is `last_day`, which becomes the next run's
 * `start_date` — advancing it after a cap would skip days this run never read.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorHttpGovernor } from "../../packages/polyfill-connectors/src/connector-http-governor.ts";
import type {
	CollectContext,
	EmittedMessage,
	RecordData,
	StartMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { ouraPacingProfile } from "../../packages/polyfill-connectors/src/provider-profile.ts";
import { collectOura } from "./index.ts";

/** The real governor with pacing switched off — production retry and
 *  classification path intact, only the rate ceiling skipped. */
function unpacedGovernor(): ReturnType<typeof createConnectorHttpGovernor> {
	return createConnectorHttpGovernor({
		name: "oura",
		maxAttempts: 1,
		pacingInitialIntervalMs: 0,
		profile: ouraPacingProfile(),
	});
}

interface OuraPageFixture {
	data: Array<{
		awake_time?: number;
		average_breath?: number;
		contributors?: Record<string, number>;
		day: string;
		id: string;
		restless_periods?: number;
		score?: number;
		time_in_bed?: number;
		timestamp?: string;
		type?: string;
	}>;
	next_token?: string | null;
}

/**
 * Serve queued pages through the REAL production fetch path (`globalThis.fetch`
 * -> `oura()` -> the HTTP governor), so these tests exercise the shipped walk.
 */
function withOuraPages<T>(
	pages: OuraPageFixture[],
	run: (requested: URL[]) => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	const requested: URL[] = [];
	let index = 0;
	globalThis.fetch = ((input: URL | string) => {
		requested.push(new URL(String(input)));
		const page = pages[index] ?? { data: [] };
		index += 1;
		return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
	}) as typeof globalThis.fetch;
	return run(requested).finally(() => {
		globalThis.fetch = original;
	});
}

/**
 * Endpoint-aware variant: `collectSleep` fetches /sleep and /daily_sleep in
 * parallel (Promise.all), so a single shared page queue (indexed by request
 * order) cannot deterministically serve both endpoints alongside another
 * stream's own walk. Each endpoint gets its own independent page queue keyed
 * by the last path segment (`sleep`, `daily_sleep`, `daily_readiness`,
 * `daily_activity`).
 */
function withOuraEndpointPages<T>(
	pagesByEndpoint: Record<string, OuraPageFixture[]>,
	run: (requested: URL[]) => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	const requested: URL[] = [];
	const indexByEndpoint: Record<string, number> = {};
	globalThis.fetch = ((input: URL | string) => {
		const url = new URL(String(input));
		requested.push(url);
		const endpoint = url.pathname.split("/").at(-1) ?? "";
		const queue = pagesByEndpoint[endpoint] ?? [];
		const i = indexByEndpoint[endpoint] ?? 0;
		indexByEndpoint[endpoint] = i + 1;
		const page = queue[i] ?? { data: [] };
		return Promise.resolve(new Response(JSON.stringify(page), { status: 200 }));
	}) as typeof globalThis.fetch;
	return run(requested).finally(() => {
		globalThis.fetch = original;
	});
}

function makeContext({
	state = {},
	streams = [{ name: "activity" }],
	isRecordSelected,
	detailGaps = [],
}: {
	readonly state?: Record<string, unknown>;
	readonly streams?: readonly StreamScope[];
	readonly isRecordSelected?: CollectContext["isRecordSelected"];
	readonly detailGaps?: CollectContext["detailGaps"];
} = {}): {
	readonly ctx: CollectContext;
	readonly messages: EmittedMessage[];
	readonly records: Array<{ data: RecordData; stream: string }>;
	readonly failures: Array<{ stream: string; message: string }>;
} {
	const messages: EmittedMessage[] = [];
	const records: Array<{ data: RecordData; stream: string }> = [];
	const failures: Array<{ stream: string; message: string }> = [];
	const start: StartMessage = { type: "START", scope: { streams }, state };
	return {
		messages,
		records,
		failures,
		ctx: {
			assist: () => Promise.resolve("asst_test"),
			capture: null,
			completeAssistance: () => Promise.resolve(),
			credentials: { OURA_PERSONAL_ACCESS_TOKEN: "token-test" },
			detailGaps,
			emit: (msg) => {
				messages.push(msg);
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				records.push({ data, stream });
				return Promise.resolve();
			},
			emittedAt: "2026-08-07T00:00:00.000Z",
			...(isRecordSelected ? { isRecordSelected } : {}),
			progress: () => Promise.resolve(),
			reportStreamFailure: (stream, message) => {
				failures.push({ stream, message });
				return Promise.resolve();
			},
			requested: new Map(streams.map((stream) => [stream.name, stream])),
			requestDetailGapPage: () => Promise.resolve([]),
			scope: start.scope,
			sendInteraction: () =>
				Promise.resolve({
					request_id: "int_test",
					status: "cancelled" as const,
					type: "INTERACTION_RESPONSE" as const,
				}),
			state,
		},
	};
}

function lastStateCursor(
	messages: readonly EmittedMessage[],
	stream: string,
): unknown {
	const found = [...messages]
		.reverse()
		.find((msg) => msg.type === "STATE" && msg.stream === stream);
	if (!found || found.type !== "STATE") return undefined;
	const cursor = found.cursor as { last_day?: unknown };
	return { last_day: cursor.last_day };
}

function lastStateEvidence(
	messages: readonly EmittedMessage[],
	stream: string,
): unknown {
	const found = [...messages]
		.reverse()
		.find((msg) => msg.type === "STATE" && msg.stream === stream);
	const cursor = found && found.type === "STATE" ? found.cursor : undefined;
	return cursor && typeof cursor === "object" && "coverage" in cursor
		? cursor.coverage
		: undefined;
}

function truncationSkip(
	messages: readonly EmittedMessage[],
	stream: string,
): Extract<EmittedMessage, { type: "SKIP_RESULT" }> | undefined {
	return messages.find(
		(message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			message.type === "SKIP_RESULT" && message.stream === stream,
	);
}

test("a walk that exhausts naturally advances the cursor and discloses no truncation", async () => {
	// No `next_token` on the final page is the provider saying it has nothing
	// more. This is the behavior-preservation case: unchanged from before.
	const { ctx, messages, records } = makeContext();
	await withOuraPages(
		[
			{
				data: [
					{
						id: "00000000-0000-4000-8000-000000000001",
						day: "2026-08-01",
						score: 80,
					},
				],
				next_token: "tok-2",
			},
			{
				data: [
					{
						id: "00000000-0000-4000-8000-000000000002",
						day: "2026-08-02",
						score: 85,
					},
				],
				next_token: null,
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);

	assert.equal(records.length, 2, "every row on every fetched page is emitted");
	assert.equal(
		truncationSkip(messages, "activity"),
		undefined,
		"an exhausted walk must not claim truncation",
	);
	assert.deepEqual(
		lastStateCursor(messages, "activity"),
		{ last_day: "2026-08-02" },
		"an exhausted walk advances to the latest day it saw",
	);
});

test("authentication failure reports stream failure instead of a successful empty walk", async () => {
	const { ctx, failures, messages, records } = makeContext();
	const original = globalThis.fetch;
	globalThis.fetch = (() =>
		Promise.resolve(
			new Response("unauthorized", { status: 401 }),
		)) as typeof globalThis.fetch;
	try {
		await collectOura(ctx, { httpGovernor: unpacedGovernor() });
	} finally {
		globalThis.fetch = original;
	}
	assert.deepEqual(failures, [
		{ stream: "activity", message: "oura_auth_failed" },
	]);
	assert.equal(records.length, 0);
	assert.deepEqual(lastStateCursor(messages, "activity"), { last_day: null });
});

test("coverage emitted count follows runtime record selection", async () => {
	const { ctx, messages, records } = makeContext({
		isRecordSelected: (_stream, data) => data.day === "2026-08-05",
	});
	await withOuraPages(
		[
			{
				data: [
					{ id: "11111111-1111-4111-8111-111111111111", day: "2026-08-02" },
					{ id: "22222222-2222-4222-8222-222222222222", day: "2026-08-05" },
				],
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 1);
	assert.equal(
		(lastStateEvidence(messages, "activity") as { emitted: number }).emitted,
		1,
	);
});

test("invalid daily score does not contaminate a valid same-day session", async () => {
	const { ctx, messages, records } = makeContext({
		streams: [{ name: "sleep" }],
	});
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{ id: "11111111-1111-4111-8111-111111111111", day: "2026-08-05" },
					],
				},
			],
			daily_sleep: [
				{
					data: [
						{
							id: "22222222-2222-4222-8222-222222222222",
							day: "2026-08-05",
							score: 105,
						},
						{
							id: "33333333-3333-4333-8333-333333333333",
							day: "2026-08-05",
							score: 80,
						},
					],
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(
		records.find((record) => record.data.record_type === "sleep_session")?.data
			.sleep_score,
		80,
	);
	assert.equal(
		records.filter((record) => record.data.record_type === "daily_score")
			.length,
		1,
	);
	assert.ok(messages.some((message) => message.type === "DETAIL_GAP"));
});

test("repaired daily join acknowledges its served gap after emitting records", async () => {
	const sessionId = "11111111-1111-4111-8111-111111111111";
	const { ctx, messages, records } = makeContext({
		streams: [{ name: "sleep" }],
		detailGaps: [
			{
				gap_id: "gap-prior-missing-daily",
				stream: "sleep",
				status: "pending",
				reference_only: true,
				record_key: sessionId,
				detail_locator: { kind: "oura.daily_sleep_missing", day: "2026-08-05" },
			},
		],
	});
	await withOuraEndpointPages(
		{
			sleep: [{ data: [{ id: sessionId, day: "2026-08-05" }] }],
			daily_sleep: [
				{
					data: [
						{
							id: "22222222-2222-4222-8222-222222222222",
							day: "2026-08-05",
							score: 80,
						},
					],
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 2);
	assert.ok(
		messages.some(
			(message) =>
				message.type === "DETAIL_GAP_RECOVERED" &&
				message.gap_id === "gap-prior-missing-daily",
		),
	);
});

test("invalid session cannot recover a prior missing-session gap", async () => {
	const dailyId = "22222222-2222-4222-8222-222222222222";
	const { ctx, messages, records } = makeContext({
		streams: [{ name: "sleep" }],
		detailGaps: [
			{
				gap_id: "gap-missing-session",
				stream: "sleep",
				status: "pending",
				reference_only: true,
				record_key: dailyId,
				detail_locator: {
					kind: "oura.sleep_session_missing",
					day: "2026-08-05",
				},
			},
		],
	});
	await withOuraEndpointPages(
		{
			sleep: [{ data: [{ id: "bad", day: "2026-08-05" }] }],
			daily_sleep: [{ data: [{ id: dailyId, day: "2026-08-05", score: 80 }] }],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 1);
	assert.equal(
		messages.some((message) => message.type === "DETAIL_GAP_RECOVERED"),
		false,
	);
});

test("truncated daily pagination cannot recover a duplicate-day gap", async () => {
	const day = "2026-08-05";
	const { ctx, messages } = makeContext({
		streams: [{ name: "sleep" }],
		detailGaps: [
			{
				gap_id: "gap-duplicate-daily",
				stream: "sleep",
				status: "pending",
				reference_only: true,
				record_key: day,
				detail_locator: { kind: "oura.daily_sleep_duplicate", day },
			},
		],
	});
	await withOuraEndpointPages(
		{
			sleep: [{ data: [{ id: "11111111-1111-4111-8111-111111111111", day }] }],
			daily_sleep: [
				{
					data: [{ id: "22222222-2222-4222-8222-222222222222", day }],
					next_token: "more",
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 }),
	);
	assert.equal(
		messages.some((message) => message.type === "DETAIL_GAP_RECOVERED"),
		false,
	);
});

test("malformed sleep identity produces a stream skip without an unstable gap key", async () => {
	const { ctx, messages } = makeContext({ streams: [{ name: "sleep" }] });
	await withOuraEndpointPages(
		{
			sleep: [
				{ data: [{ day: "2026-08-05" } as OuraPageFixture["data"][number]] },
			],
			daily_sleep: [{ data: [] }],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.ok(
		messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "invalid_record_shape",
		),
	);
	assert.equal(
		messages.some((message) => message.type === "DETAIL_GAP"),
		false,
	);
});

test("a capped walk is distinguishable from an exhausted one and holds the cursor at unread history", async () => {
	// Two pages, both advertising a next_token, with a 1-page ceiling: the
	// provider still has more when the budget runs out. Advancing `last_day` to
	// 2026-08-02 would make every unread day after it unreachable.
	const { ctx, messages, records } = makeContext({
		state: { activity: { last_day: "2026-07-31" } },
	});
	await withOuraPages(
		[
			{
				data: [
					{
						id: "00000000-0000-4000-8000-000000000001",
						day: "2026-08-02",
						score: 80,
					},
				],
				next_token: "tok-2",
			},
			{
				data: [
					{
						id: "00000000-0000-4000-8000-000000000002",
						day: "2026-08-03",
						score: 85,
					},
				],
				next_token: "tok-3",
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 }),
	);

	assert.equal(records.length, 1, "the enumerated prefix may still be emitted");

	const skip = truncationSkip(messages, "activity");
	assert.ok(skip, "a truncated walk must disclose itself to the owner");
	assert.equal(skip.reason, "older_pages_deferred_page_budget");
	assert.match(
		skip.message,
		/1-page limit/,
		"the disclosed ceiling must be the one actually enforced",
	);

	assert.deepEqual(
		lastStateCursor(messages, "activity"),
		{ last_day: "2026-07-31" },
		"a capped walk must hold the day it started from, never advance past unread history",
	);
});

test("a capped walk with no prior cursor holds at null rather than claiming a latest day", async () => {
	const { ctx, messages } = makeContext();
	await withOuraPages(
		[
			{
				data: [
					{
						id: "00000000-0000-4000-8000-000000000001",
						day: "2026-08-02",
						score: 80,
					},
				],
				next_token: "tok-2",
			},
			{
				data: [
					{
						id: "00000000-0000-4000-8000-000000000002",
						day: "2026-08-03",
						score: 85,
					},
				],
				next_token: "tok-3",
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 }),
	);

	assert.ok(
		truncationSkip(messages, "activity"),
		"a truncated first-ever walk still discloses truncation",
	);
	assert.deepEqual(
		lastStateCursor(messages, "activity"),
		{ last_day: null },
		"a first run that is capped must not claim it reached a latest day",
	);
});

test("the page ceiling is what stops the walk — it does not fetch past its budget", async () => {
	const { ctx } = makeContext();
	const requested = await withOuraPages(
		[
			{
				data: [
					{ id: "00000000-0000-4000-8000-000000000001", day: "2026-08-01" },
				],
				next_token: "tok-2",
			},
			{
				data: [
					{ id: "00000000-0000-4000-8000-000000000002", day: "2026-08-02" },
				],
				next_token: "tok-3",
			},
			{ data: [{ id: "a3", day: "2026-08-03" }], next_token: "tok-4" },
		],
		async (urls) => {
			await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 });
			return urls;
		},
	);

	assert.equal(requested.length, 2, "a 2-page budget fetches exactly 2 pages");
	assert.equal(
		requested[0]?.searchParams.get("next_token"),
		null,
		"the first page carries no continuation token",
	);
	assert.equal(
		requested[1]?.searchParams.get("next_token"),
		"tok-2",
		"the second page follows the provider's token",
	);
});

test("truncation is disclosed and the cursor withheld per stream, not once per run", async () => {
	// Each Oura stream walks independently, so a cap reached on one stream must
	// report and withhold on that stream alone.
	const { ctx, messages } = makeContext({
		state: {
			sleep: { last_day: "2026-07-01" },
			activity: { last_day: "2026-07-31" },
		},
		streams: [{ name: "sleep" }, { name: "activity" }],
	});
	await withOuraEndpointPages(
		{
			// sleep: one page, exhausted (both the session and daily_sleep walks).
			sleep: [
				{
					data: [
						{ id: "00000000-0000-4000-8000-000000000003", day: "2026-08-05" },
					],
					next_token: null,
				},
			],
			daily_sleep: [
				{
					data: [
						{
							id: "00000000-0000-4000-8000-000000000005",
							day: "2026-08-05",
							score: 80,
						},
					],
					next_token: null,
				},
			],
			// activity: still advertising more when the 1-page budget runs out.
			daily_activity: [
				{
					data: [
						{ id: "00000000-0000-4000-8000-000000000001", day: "2026-08-06" },
					],
					next_token: "tok-2",
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 }),
	);

	assert.equal(
		truncationSkip(messages, "sleep"),
		undefined,
		"the exhausted stream must not claim truncation",
	);
	assert.deepEqual(
		lastStateCursor(messages, "sleep"),
		{ last_day: "2026-08-05" },
		"the exhausted stream advances normally",
	);

	assert.ok(
		truncationSkip(messages, "activity"),
		"the capped stream discloses truncation",
	);
	assert.deepEqual(
		lastStateCursor(messages, "activity"),
		{ last_day: "2026-07-31" },
		"the capped stream holds its own cursor",
	);
});

test("sleep joins its per-session document with the same day's daily_sleep score and contributors", async () => {
	const { ctx, records } = makeContext({ streams: [{ name: "sleep" }] });
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{
							id: "00000000-0000-4000-8000-000000000003",
							day: "2026-08-05",
							average_breath: 14.2,
							restless_periods: 12,
							time_in_bed: 27_600,
							type: "long_sleep",
						},
					],
					next_token: null,
				},
			],
			daily_sleep: [
				{
					data: [
						{
							id: "00000000-0000-4000-8000-000000000005",
							day: "2026-08-05",
							score: 80,
							contributors: { deep_sleep: 75, efficiency: 90 },
						},
					],
					next_token: null,
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);

	assert.equal(records.length, 2);
	const record = records[0]?.data as Record<string, unknown>;
	assert.equal(record.sleep_score, 80);
	assert.deepEqual(record.contributors, { deep_sleep: 75, efficiency: 90 });
	assert.equal(record.average_breath, 14.2);
	assert.equal(record.restless_periods, 12);
	assert.equal(record.time_in_bed, 27_600);
	assert.equal(record.type, "long_sleep");
	assert.equal(records[1]?.data.record_type, "daily_score");
});

test("sleep tolerates a day with a session but no matching daily_sleep document", async () => {
	const { ctx, records } = makeContext({ streams: [{ name: "sleep" }] });
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{ id: "00000000-0000-4000-8000-000000000003", day: "2026-08-05" },
					],
					next_token: null,
				},
			],
			daily_sleep: [{ data: [], next_token: null }],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);

	assert.equal(records.length, 1, "the session record is still emitted");
	const record = records[0]?.data as Record<string, unknown>;
	assert.equal(
		record.sleep_score,
		null,
		"no daily_sleep match means null, not fabricated",
	);
	assert.deepEqual(record.contributors, {});
});

test("sleep emits available records and a gap when daily_sleep is truncated", async () => {
	const { ctx, messages, records } = makeContext({
		state: { sleep: { last_day: "2026-07-01" } },
		streams: [{ name: "sleep" }],
	});
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{ id: "00000000-0000-4000-8000-000000000003", day: "2026-08-05" },
						{ id: "00000000-0000-4000-8000-000000000004", day: "2026-08-06" },
					],
					next_token: null,
				},
			],
			daily_sleep: [
				{
					data: [
						{
							id: "00000000-0000-4000-8000-000000000005",
							day: "2026-08-05",
							score: 80,
							contributors: { deep_sleep: 75 },
						},
					],
					next_token: "daily-sleep-next",
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 }),
	);

	assert.equal(
		records.length,
		3,
		"two sessions and the fetched daily score survive",
	);
	assert.equal(records[0]?.data.sleep_score, 80);
	assert.equal(records[1]?.data.sleep_score, null);
	assert.ok(messages.some((message) => message.type === "DETAIL_GAP"));
	assert.ok(
		truncationSkip(messages, "sleep"),
		"the truncated helper walk is still disclosed",
	);
	assert.deepEqual(
		lastStateCursor(messages, "sleep"),
		{ last_day: "2026-07-01" },
		"the sleep cursor is held until both joined resources are complete",
	);
});

test("daily-only sleep score keeps source identity and timestamp", async () => {
	const { ctx, messages, records } = makeContext({
		streams: [{ name: "sleep" }],
	});
	await withOuraEndpointPages(
		{
			sleep: [{ data: [], next_token: null }],
			daily_sleep: [
				{
					data: [
						{
							id: "00000000-0000-4000-8000-000000000006",
							day: "2026-08-05",
							timestamp: "2026-08-05T12:00:00Z",
							score: 80,
						},
					],
					next_token: null,
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.deepEqual(
		records.map((r) => r.data.record_type),
		["daily_score"],
	);
	assert.equal(
		records[0]?.data.daily_sleep_id,
		"00000000-0000-4000-8000-000000000006",
	);
	assert.equal(records[0]?.data.daily_sleep_timestamp, "2026-08-05T12:00:00Z");
	assert.ok(messages.some((m) => m.type === "DETAIL_GAP"));
});

test("duplicate daily sleep days retain both rows and hold the checkpoint", async () => {
	const { ctx, messages, records } = makeContext({
		streams: [{ name: "sleep" }],
	});
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{
							id: "00000000-0000-4000-8000-000000000008",
							day: "2026-08-05",
							awake_time: 600,
						},
					],
					next_token: null,
				},
			],
			daily_sleep: [
				{
					data: [
						{ id: "00000000-0000-4000-8000-000000000006", day: "2026-08-05" },
						{ id: "00000000-0000-4000-8000-000000000007", day: "2026-08-05" },
					],
					next_token: null,
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 3);
	assert.equal(records[0]?.data.awake_time, 600);
	assert.equal(
		records[0]?.data.daily_sleep_id,
		null,
		"ambiguous daily scores must not be assigned to a session",
	);
	assert.ok(messages.some((m) => m.type === "DETAIL_GAP"));
	assert.deepEqual(lastStateCursor(messages, "sleep"), { last_day: null });
});

test("an earlier scoped since date replays before a newer checkpoint without UTC day shift", async () => {
	const { ctx, messages } = makeContext({
		state: { activity: { last_day: "2026-08-06" } },
		streams: [
			{ name: "activity", time_range: { since: "2026-08-04T23:00:00-07:00" } },
		],
	});
	const requested = await withOuraPages(
		[{ data: [], next_token: null }],
		(urls) =>
			collectOura(ctx, { httpGovernor: unpacedGovernor() }).then(() => urls),
	);
	assert.equal(requested[0]?.searchParams.get("start_date"), "2026-08-04");
	assert.equal(
		(
			lastStateEvidence(messages, "activity") as {
				resources: { daily_activity: { terminal: boolean } };
			}
		).resources.daily_activity.terminal,
		true,
	);
});

test("malformed later page preserves fetched activity records and holds proof", async () => {
	const { ctx, messages, records } = makeContext({
		state: { activity: { last_day: "2026-08-01" } },
	});
	await withOuraPages(
		[
			{
				data: [
					{ id: "33333333-3333-4333-8333-333333333333", day: "2026-08-02" },
				],
				next_token: "second",
			},
			{ data: null, next_token: null } as unknown as OuraPageFixture,
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 1);
	assert.ok(messages.some((m) => m.type === "SKIP_RESULT"));
	assert.deepEqual(lastStateCursor(messages, "activity"), {
		last_day: "2026-08-01",
	});
});

test("malformed row in a page does not discard valid siblings", async () => {
	const { ctx, messages, records } = makeContext({
		state: { activity: { last_day: "2026-08-01" } },
	});
	await withOuraPages(
		[
			{
				data: [
					{ id: "33333333-3333-4333-8333-333333333333", day: "2026-08-02" },
					null as unknown as OuraPageFixture["data"][number],
				],
				next_token: null,
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 1);
	assert.ok(messages.some((m) => m.type === "SKIP_RESULT"));
	assert.deepEqual(lastStateCursor(messages, "activity"), {
		last_day: "2026-08-01",
	});
});

test("sleep emits a valid daily score when the session source has a malformed envelope", async () => {
	const { ctx, messages, records } = makeContext({
		state: { sleep: { last_day: "2026-08-01" } },
		streams: [{ name: "sleep" }],
	});
	await withOuraEndpointPages(
		{
			sleep: [{ data: null, next_token: null } as unknown as OuraPageFixture],
			daily_sleep: [
				{
					data: [
						{
							id: "44444444-4444-4444-8444-444444444444",
							day: "2026-08-02",
							score: 80,
						},
					],
					next_token: null,
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.deepEqual(
		records.map((r) => r.data.record_type),
		["daily_score"],
	);
	assert.ok(
		messages.some(
			(m) => m.type === "SKIP_RESULT" && m.reason === "invalid_envelope",
		),
	);
	assert.deepEqual(lastStateCursor(messages, "sleep"), {
		last_day: "2026-08-01",
	});
});

test("invalid next token is a source gap, not terminal exhaustion", async () => {
	const { ctx, messages, records } = makeContext({
		state: { activity: { last_day: "2026-08-01" } },
	});
	await withOuraPages(
		[
			{
				data: [
					{ id: "55555555-5555-4555-8555-555555555555", day: "2026-08-02" },
				],
				next_token: 42 as unknown as string,
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 0);
	assert.ok(
		messages.some(
			(m) => m.type === "SKIP_RESULT" && m.reason === "invalid_envelope",
		),
	);
	assert.deepEqual(lastStateCursor(messages, "activity"), {
		last_day: "2026-08-01",
	});
});

test("invalid source row creates a gap while valid siblings still upsert", async () => {
	const { ctx, messages, records } = makeContext({
		state: { activity: { last_day: "2026-08-01" } },
	});
	await withOuraPages(
		[
			{
				data: [
					{
						id: "11111111-1111-4111-8111-111111111111",
						day: "2026-08-02",
						score: 80,
					},
					{
						id: "22222222-2222-4222-8222-222222222222",
						day: "2026-08-03",
						score: 105,
					},
				],
				next_token: null,
			},
		],
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.equal(records.length, 1);
	assert.ok(messages.some((m) => m.type === "DETAIL_GAP"));
	assert.deepEqual(lastStateCursor(messages, "activity"), {
		last_day: "2026-08-01",
	});
});

test("sleep checkpoint records bounded terminal evidence for both resources", async () => {
	const { ctx, messages } = makeContext({ streams: [{ name: "sleep" }] });
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{ id: "11111111-1111-4111-8111-111111111111", day: "2026-08-05" },
					],
					next_token: null,
				},
			],
			daily_sleep: [
				{
					data: [
						{ id: "22222222-2222-4222-8222-222222222222", day: "2026-08-05" },
					],
					next_token: null,
				},
			],
		},
		() => collectOura(ctx, { httpGovernor: unpacedGovernor() }),
	);
	assert.deepEqual(lastStateEvidence(messages, "sleep"), {
		start_date: null,
		end_date: "2026-08-07",
		resources: {
			sleep: { pages: 1, fetched: 1, terminal: true },
			daily_sleep: { pages: 1, fetched: 1, terminal: true },
		},
		emitted: 2,
		gaps: 0,
	});
});

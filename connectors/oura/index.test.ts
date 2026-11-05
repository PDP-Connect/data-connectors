// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Date-window frontiers resume a capped forward walk without assuming page
 * order. The inclusive checkpoint advances only after a whole window is read.
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
		average_breath?: number;
		contributors?: Record<string, number>;
		day: string;
		id: string;
		restless_periods?: number;
		score?: number;
		time_in_bed?: number;
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
	collectionMode,
}: {
	readonly state?: Record<string, unknown>;
	readonly streams?: readonly StreamScope[];
	readonly collectionMode?: "full_refresh";
} = {}): {
	readonly ctx: CollectContext;
	readonly messages: EmittedMessage[];
	readonly records: Array<{ data: RecordData; stream: string }>;
} {
	const messages: EmittedMessage[] = [];
	const records: Array<{ data: RecordData; stream: string }> = [];
	streams = streams.map((stream) => ({
		time_range: { since: "2026-08-01", until: "2026-08-07" },
		...stream,
	}));
	const start: StartMessage = {
		type: "START",
		scope: { streams },
		state,
	};
	return {
		messages,
		records,
		ctx: {
			...(collectionMode ? { collectionMode } : {}),
			assist: () => Promise.resolve("asst_test"),
			capture: null,
			completeAssistance: () => Promise.resolve(),
			credentials: { OURA_PERSONAL_ACCESS_TOKEN: "token-test" },
			detailGaps: [],
			emit: (msg) => {
				messages.push(msg);
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				records.push({ data, stream });
				return Promise.resolve();
			},
			emittedAt: "2026-08-07T00:00:00.000Z",
			progress: () => Promise.resolve(),
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
	return found && found.type === "STATE" ? found.cursor : undefined;
}

const defaultScope = {
	since: "2026-08-01",
	until: "2026-08-07",
	resources: null,
};

function cursorFor(messages: readonly EmittedMessage[], stream = "activity") {
	return lastStateCursor(messages, stream) as {
		last_day: string | null;
		scope: typeof defaultScope;
		frontier: { start_date: string; newest_day: string | null } | null;
	};
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
				data: [{ id: "a1", day: "2026-08-01", score: 80 }],
				next_token: "tok-2",
			},
			{ data: [{ id: "a2", day: "2026-08-02", score: 85 }], next_token: null },
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
		{ last_day: "2026-08-02", scope: defaultScope, frontier: null },
		"an exhausted walk advances to the latest day it saw",
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
				data: [{ id: "a1", day: "2026-08-02", score: 80 }],
				next_token: "tok-2",
			},
			{
				data: [{ id: "a2", day: "2026-08-03", score: 85 }],
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
		{
			last_day: "2026-07-31", scope: defaultScope,
			frontier: { start_date: "2026-07-31", newest_day: "2026-08-02" },
		},
		"a capped walk must hold the day it started from, never advance past unread history",
	);
});

test("a capped walk with no prior cursor saves the first window start rather than a latest day", async () => {
	const { ctx, messages } = makeContext();
	await withOuraPages(
		[
			{
				data: [{ id: "a1", day: "2026-08-02", score: 80 }],
				next_token: "tok-2",
			},
			{
				data: [{ id: "a2", day: "2026-08-03", score: 85 }],
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
		{
			last_day: "2026-08-01", scope: defaultScope,
			frontier: { start_date: "2026-08-01", newest_day: "2026-08-02" },
		},
		"a capped first run checkpoints the incomplete window",
	);
});

test("the page ceiling is what stops the walk — it does not fetch past its budget", async () => {
	const { ctx } = makeContext();
	const requested = await withOuraPages(
		[
			{ data: [{ id: "a1", day: "2026-08-01" }], next_token: "tok-2" },
			{ data: [{ id: "a2", day: "2026-08-02" }], next_token: "tok-3" },
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
			sleep: [{ data: [{ id: "s1", day: "2026-08-05" }], next_token: null }],
			daily_sleep: [
				{
					data: [{ id: "ds1", day: "2026-08-05", score: 80 }],
					next_token: null,
				},
			],
			// activity: still advertising more when the 1-page budget runs out.
			daily_activity: [
				{ data: [{ id: "a1", day: "2026-08-06" }], next_token: "tok-2" },
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
		{ last_day: "2026-08-05", scope: defaultScope, frontier: null },
		"the exhausted stream advances normally",
	);

	assert.ok(
		truncationSkip(messages, "activity"),
		"the capped stream discloses truncation",
	);
	assert.deepEqual(
		lastStateCursor(messages, "activity"),
		{
			last_day: "2026-07-31", scope: defaultScope,
			frontier: { start_date: "2026-07-31", newest_day: "2026-08-06" },
		},
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
							id: "s1",
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
							id: "ds1",
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

	assert.equal(records.length, 1);
	const record = records[0]?.data as Record<string, unknown>;
	assert.equal(record.sleep_score, 80);
	assert.deepEqual(record.contributors, { deep_sleep: 75, efficiency: 90 });
	assert.equal(record.average_breath, 14.2);
	assert.equal(record.restless_periods, 12);
	assert.equal(record.time_in_bed, 27_600);
	assert.equal(record.type, "long_sleep");
});

test("sleep tolerates a day with a session but no matching daily_sleep document", async () => {
	const { ctx, records } = makeContext({ streams: [{ name: "sleep" }] });
	await withOuraEndpointPages(
		{
			sleep: [{ data: [{ id: "s1", day: "2026-08-05" }], next_token: null }],
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

test("sleep emits no partial records when its daily_sleep helper walk is truncated", async () => {
	const { ctx, messages, records } = makeContext({
		state: { sleep: { last_day: "2026-07-01" } },
		streams: [{ name: "sleep" }],
	});
	await withOuraEndpointPages(
		{
			sleep: [
				{
					data: [
						{ id: "s1", day: "2026-08-05" },
						{ id: "s2", day: "2026-08-06" },
					],
					next_token: null,
				},
			],
			daily_sleep: [
				{
					data: [
						{
							id: "ds1",
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
		0,
		"a truncated helper join must not emit nullable partial sleep records",
	);
	assert.ok(
		truncationSkip(messages, "sleep"),
		"the truncated helper walk is still disclosed",
	);
	assert.deepEqual(
		lastStateCursor(messages, "sleep"),
		{
			last_day: "2026-07-01", scope: defaultScope,
			frontier: { start_date: "2026-07-01", newest_day: "2026-07-01" },
		},
		"the sleep cursor is held until both joined resources are complete",
	);
});

const historyScope = {
	since: "2026-01-01",
	until: "2026-08-07",
	resources: null,
};
const historyStreams: readonly StreamScope[] = [{
	name: "activity",
	time_range: { since: historyScope.since, until: historyScope.until },
}];

test("a budget stop in window two saves its start, not the latest unordered row", async () => {
	const { ctx, messages, records } = makeContext({ streams: historyStreams });
	await withOuraPages([
		{ data: [
			{ id: "march", day: "2026-03-30" },
			{ id: "january", day: "2026-01-02" },
		] },
		{ data: [
			{ id: "may", day: "2026-05-20" },
			{ id: "april", day: "2026-04-10" },
		], next_token: "unread-in-window-two" },
	], async (requested) => {
		await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 });
		assert.equal(requested.length, 2);
		assert.equal(requested[0]?.searchParams.get("start_date"), "2026-01-01");
		assert.equal(requested[0]?.searchParams.get("end_date"), "2026-04-01");
		assert.equal(requested[1]?.searchParams.get("start_date"), "2026-04-01");
		assert.equal(requested[1]?.searchParams.get("end_date"), "2026-06-30");
		assert.equal(requested[1]?.searchParams.get("next_token"), null);
	});
	assert.equal(records.length, 4);
	assert.deepEqual(cursorFor(messages), {
		last_day: "2026-04-01",
		scope: historyScope,
		frontier: { start_date: "2026-04-01", newest_day: "2026-05-20" },
	});
	assert.deepEqual(truncationSkip(messages, "activity")?.recovery_hint, {
		action: "retry_by_runtime", retryable: true,
	});
});

test("the next run resumes the partial window, reaches new days, and keeps overlap records identical", async () => {
	const first = makeContext({ streams: historyStreams });
	const overlap = { id: "overlap", day: "2026-04-10", score: 80 };
	await withOuraPages([
		{ data: [{ id: "old", day: "2026-01-02" }] },
		{ data: [overlap], next_token: "unread" },
	], () => collectOura(first.ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 }));
	const second = makeContext({
		streams: historyStreams,
		state: { activity: lastStateCursor(first.messages, "activity") },
	});
	const boundary = { id: "boundary", day: "2026-06-30", score: 90 };
	await withOuraPages([
		{ data: [overlap, { id: "previously-unread", day: "2026-05-01" }, boundary] },
		{ data: [boundary, { id: "new", day: "2026-08-06" }] },
	], async (requested) => {
		await collectOura(second.ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 });
		assert.equal(requested[0]?.searchParams.get("start_date"), "2026-04-01");
		assert.equal(requested[0]?.searchParams.get("next_token"), null);
	});
	assert.deepEqual(
		second.records.map((record) => (record.data as Record<string, unknown>).id),
		["overlap", "previously-unread", "boundary", "new"],
	);
	assert.deepEqual(
		second.records.find((record) => (record.data as Record<string, unknown>).id === "overlap")?.data,
		first.records.find((record) => (record.data as Record<string, unknown>).id === "overlap")?.data,
	);
	assert.equal(truncationSkip(second.messages, "activity"), undefined);
	assert.deepEqual(cursorFor(second.messages), {
		last_day: "2026-08-06", scope: historyScope, frontier: null,
	});
});

test("scope changes and full_refresh discard the saved forward frontier", async () => {
	const saved = {
		last_day: "2026-04-01",
		scope: historyScope,
		frontier: { start_date: "2026-04-01", newest_day: "2026-05-20" },
	};
	const cases = [
		{ stream: { name: "activity", time_range: { since: "2026-02-01", until: "2026-08-07" } }, expected: "2026-02-01" },
		{ stream: { name: "activity", time_range: { since: "2026-01-01", until: "2026-07-01" } }, expected: "2026-01-01" },
		{ stream: { name: "activity", time_range: { since: "2026-01-01", until: "2026-08-07" }, resources: [] }, expected: "2026-01-01" },
		{ stream: historyStreams[0]!, collectionMode: "full_refresh" as const, expected: "2026-01-01" },
	];
	for (const scenario of cases) {
		const { ctx, messages } = makeContext({
			state: { activity: saved },
			streams: [scenario.stream],
			...(scenario.collectionMode ? { collectionMode: scenario.collectionMode } : {}),
		});
		await withOuraPages([{ data: [], next_token: "still-open" }], async (requested) => {
			await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 });
			assert.equal(requested[0]?.searchParams.get("start_date"), scenario.expected);
		});
		assert.equal(cursorFor(messages).frontier?.start_date, scenario.expected);
		assert.equal(cursorFor(messages).frontier?.newest_day, null);
	}
});

test("finishing the final window clears the frontier even on the exact page budget", async () => {
	const { ctx, messages } = makeContext({
		streams: historyStreams,
		state: { activity: {
			last_day: "2026-06-30",
			scope: historyScope,
			frontier: { start_date: "2026-06-30", newest_day: "2026-05-20" },
		} },
	});
	await withOuraPages([{ data: [{ id: "last", day: "2026-08-05" }] }], async (requested) => {
		await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 });
		assert.equal(requested[0]?.searchParams.get("end_date"), "2026-08-07");
	});
	assert.equal(truncationSkip(messages, "activity"), undefined);
	assert.equal(cursorFor(messages).frontier, null);
	assert.equal(cursorFor(messages).last_day, "2026-08-05");
});

test("legacy last_day STATE loads inclusively and gains a scoped frontier", async () => {
	const { ctx, messages } = makeContext({
		streams: historyStreams,
		state: { activity: { last_day: "2026-05-01" } },
	});
	await withOuraPages([
		{ data: [{ id: "seen", day: "2026-05-20" }], next_token: "unread" },
	], async (requested) => {
		await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 });
		assert.equal(requested[0]?.searchParams.get("start_date"), "2026-05-01");
	});
	assert.deepEqual(cursorFor(messages), {
		last_day: "2026-05-01", scope: historyScope,
		frontier: { start_date: "2026-05-01", newest_day: "2026-05-20" },
	});
});

test("empty windows consume the budget and an unscoped first run starts in 2015", async () => {
	const { ctx, messages } = makeContext({
		streams: [{ name: "activity", time_range: {} }],
	});
	await withOuraPages([{ data: [] }], async (requested) => {
		await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 });
		assert.equal(requested.length, 1);
		assert.equal(requested[0]?.searchParams.get("start_date"), "2015-01-01");
		assert.equal(requested[0]?.searchParams.get("end_date"), "2015-04-01");
	});
	assert.equal(cursorFor(messages).last_day, "2015-04-01");
	assert.equal(cursorFor(messages).frontier?.newest_day, null);
	assert.ok(truncationSkip(messages, "activity"));
});

test("the final unbounded window ends tomorrow UTC and clears the frontier", async () => {
	const { ctx, messages } = makeContext({
		streams: [{ name: "activity", time_range: { since: "2026-08-01" } }],
	});
	await withOuraPages([{ data: [{ id: "today", day: "2026-08-07" }] }], async (requested) => {
		await collectOura(ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 });
		assert.equal(requested[0]?.searchParams.get("end_date"), "2026-08-08");
	});
	assert.equal(truncationSkip(messages, "activity"), undefined);
	assert.equal(cursorFor(messages).frontier, null);
	assert.equal(cursorFor(messages).last_day, "2026-08-07");
});

test("sleep checkpoints only after both resources finish a window and resumes the complete join", async () => {
	const streams: readonly StreamScope[] = [{
		name: "sleep", time_range: { since: "2026-01-01", until: "2026-06-01" },
	}];
	const first = makeContext({ streams });
	await withOuraEndpointPages({
		sleep: [
			{ data: [{ id: "old-sleep", day: "2026-02-01" }] },
			{ data: [{ id: "new-sleep", day: "2026-05-01" }] },
		],
		daily_sleep: [
			{ data: [{ id: "old-score", day: "2026-02-01", score: 80 }] },
			{ data: [], next_token: "score-not-read-yet" },
		],
	}, () => collectOura(first.ctx, { httpGovernor: unpacedGovernor(), maxPages: 2 }));
	assert.deepEqual(first.records.map((record) => (record.data as Record<string, unknown>).id), ["old-sleep"]);
	assert.equal(cursorFor(first.messages, "sleep").frontier?.start_date, "2026-04-01");
	const second = makeContext({
		streams, state: { sleep: lastStateCursor(first.messages, "sleep") },
	});
	await withOuraEndpointPages({
		sleep: [{ data: [{ id: "new-sleep", day: "2026-05-01" }] }],
		daily_sleep: [{ data: [{ id: "new-score", day: "2026-05-01", score: 90 }] }],
	}, async (requested) => {
		await collectOura(second.ctx, { httpGovernor: unpacedGovernor(), maxPages: 1 });
		assert.equal(requested.length, 2);
		assert.ok(requested.every((url) => url.searchParams.get("start_date") === "2026-04-01"));
	});
	const joined = second.records[0]?.data as Record<string, unknown>;
	assert.equal(joined.sleep_score, 90);
	assert.equal(cursorFor(second.messages, "sleep").frontier, null);
	assert.equal(truncationSkip(second.messages, "sleep"), undefined);
});

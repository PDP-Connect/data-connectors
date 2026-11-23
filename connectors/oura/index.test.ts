// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
}: {
	readonly state?: Record<string, unknown>;
	readonly streams?: readonly StreamScope[];
} = {}): {
	readonly ctx: CollectContext;
	readonly messages: EmittedMessage[];
	readonly records: Array<{ data: RecordData; stream: string }>;
} {
	const messages: EmittedMessage[] = [];
	const records: Array<{ data: RecordData; stream: string }> = [];
	const start: StartMessage = { type: "START", scope: { streams }, state };
	return {
		messages,
		records,
		ctx: {
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
		{ last_day: "2026-08-02" },
		"an exhausted walk advances to the latest day it saw",
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

test("each collection drains 120 pages before committing the latest cursor", async () => {
	const endpoints = ["sleep", "daily_sleep", "daily_readiness", "daily_activity"];
	const streams = ["sleep", "readiness", "activity"];
	const { ctx, records, messages } = makeContext({
		streams: streams.map((name) => ({ name })),
	});
	const day = (i: number) => new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10);
	const pages = Object.fromEntries(endpoints.map((endpoint) => [
		endpoint,
		Array.from({ length: 120 }, (_, i) => ({
			data: [{ id: `${endpoint}-${i}`, day: day(i) }],
			next_token: i < 119 ? `page-${i + 1}` : null,
		})),
	]));
	await withOuraEndpointPages(pages, async (requests) => {
		await collectOura(ctx, { httpGovernor: unpacedGovernor() });
		for (const endpoint of endpoints) {
			assert.equal(requests.filter((url) => url.pathname.endsWith(`/${endpoint}`)).length, 120);
		}
	});
	for (const stream of streams) {
		assert.equal(records.filter((record) => record.stream === stream).length, 120);
		assert.deepEqual(lastStateCursor(messages, stream), { last_day: day(119) });
		assert.equal(truncationSkip(messages, stream), undefined);
	}
});

for (const [stream, endpoint] of [
	["activity", "daily_activity"],
	["sleep", "daily_sleep"],
] as const) {
	test(`a repeated ${endpoint} token fails before refetch and emits no cursor`, async () => {
		const { ctx, records, messages } = makeContext({
			state: { [stream]: { last_day: "2020-01-01" } },
			streams: [{ name: stream }],
		});
		await withOuraEndpointPages({
			sleep: [{ data: [{ id: "synthetic-session", day: "2020-01-02" }] }],
			[endpoint]: [
				{ data: [], next_token: "page-2" },
				{ data: [], next_token: "page-3" },
				{ data: [], next_token: "page-2" },
			],
		}, async (requests) => {
			await assert.rejects(collectOura(ctx, { httpGovernor: unpacedGovernor() }), /oura_pagination_token_repeated/);
			assert.deepEqual(requests.filter((url) => url.pathname.endsWith(`/${endpoint}`))
				.map((url) => url.searchParams.get("next_token")), [null, "page-2", "page-3"]);
		});
		assert.deepEqual(records, []);
		assert.equal(lastStateCursor(messages, stream), undefined);
	});
}

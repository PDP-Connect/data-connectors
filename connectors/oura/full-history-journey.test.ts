// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Mirrors the connector's index.test.ts fake-fetch, START context and one-attempt governor.
// No provider, browser, real account or wall-clock wait is needed.
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
	failAt: number | null,
	run: (requested: URL[]) => Promise<T>,
): Promise<T> {
	const original = globalThis.fetch;
	const requested: URL[] = [];
	let index = 0;
	globalThis.fetch = ((input: URL | string) => {
		requested.push(new URL(String(input)));
		assert.ok(
			index < pages.length + 2,
			"looping source must stop within a few requests",
		);
		if (index === failAt) {
			index += 1;
			return Promise.resolve(
				new Response("{}", { status: 429, headers: { "Retry-After": "1" } }),
			);
		}
		const tail = pages.at(-1);
		const page = pages[index] ?? (tail?.next_token ? tail : { data: [] });
		index += 1;
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

const pages: OuraPageFixture[] = [4, 3, 2, 1].map((day, index) => ({
	data: [{ id: `synthetic-activity-${day}`, day: `2026-08-0${day}` }],
	next_token: index === 3 ? null : `page-${index + 2}`,
}));
const allTokens = [null, "page-2", "page-3", "page-4"];
const tokens = (urls: URL[]) =>
	urls.map((url) => url.searchParams.get("next_token"));
const recordIds = (records: Array<{ data: RecordData; stream: string }>) =>
	records.map((record) => record.data.id);

test("Oura activity full-history walk and retry converge without skipping older pages", async () => {
	const complete = makeContext();
	await withOuraPages(pages, null, async (urls) => {
		await collectOura(complete.ctx, { httpGovernor: unpacedGovernor() });
		assert.deepEqual(tokens(urls), allTokens);
		assert.ok(
			urls.every((url) => !url.searchParams.has("start_date")),
			"no first-run cutoff",
		);
	});
	const expected = pages.map((page) => page.data[0]?.id);
	assert.deepEqual(
		recordIds(complete.records),
		expected,
		"every ID emitted once, in provider order",
	);
	const finalCursor = lastStateCursor(complete.messages, "activity");
	assert.deepEqual(
		finalCursor,
		{ last_day: "2026-08-04" },
		"no continuation after verified exhaustion",
	);

	const stopped = makeContext();
	await withOuraPages(pages, 2, async (urls) => {
		await assert.rejects(
			collectOura(stopped.ctx, { httpGovernor: unpacedGovernor() }),
			/oura_rate_limited/,
		);
		assert.deepEqual(tokens(urls), allTokens.slice(0, 3));
	});
	assert.equal(
		lastStateCursor(stopped.messages, "activity"),
		undefined,
		"no watermark past unread pages",
	);
	assert.deepEqual(
		stopped.records,
		[],
		"the failed walk did not publish buffered rows",
	);
	// The pinned connector publishes STATE only at exhaustion, and emits no separate coverage message.
	assert.deepEqual(
		stopped.messages,
		[],
		"failure cannot claim full coverage or successful completion",
	);

	const checkpoint = lastStateCursor(stopped.messages, "activity");
	const resumed = makeContext({
		state: checkpoint === undefined ? {} : { activity: checkpoint },
	});
	await withOuraPages(pages, null, async (urls) => {
		await collectOura(resumed.ctx, { httpGovernor: unpacedGovernor() });
		// There is no page checkpoint at this pin; restart at the newest page and read through to the end.
		assert.deepEqual(tokens(urls), allTokens);
	});
	assert.deepEqual(
		recordIds([...stopped.records, ...resumed.records]),
		expected,
	);
	assert.deepEqual(lastStateCursor(resumed.messages, "activity"), finalCursor);
});

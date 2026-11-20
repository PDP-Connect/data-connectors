// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	UBER_RETRYABLE_PATTERN,
	type UberPageFetch,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-09-22T00:00:00.000Z";
const NO_DELAY = (): Promise<void> => Promise.resolve();

function activitiesBody(
	activities: Array<Record<string, unknown>>,
	nextPageToken: string | null = null,
): string {
	return JSON.stringify({
		data: { activities: { past: { activities, nextPageToken } } },
	});
}

function getTripBody(
	trip: Record<string, unknown> | null,
	receipt: Record<string, unknown> | null = null,
): string {
	return JSON.stringify({ data: { getTrip: trip ? { trip, receipt } : null } });
}

function makeCtx(
	requestedStreams: string[],
	state: BrowserCollectContext["state"] = {},
): {
	ctx: BrowserCollectContext;
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	messages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
	events: ReturnType<typeof makeRecordingEmit>["events"];
} {
	const harness = makeRecordingEmit(validateRecord);
	const requested = new Map(requestedStreams.map((s) => [s, { name: s }]));
	const ctx = {
		assist: () => Promise.reject(new Error("not used")),
		capture: null,
		completeAssistance: () => Promise.resolve(),
		context: {} as BrowserCollectContext["context"],
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: async (stream, data, options) => {
			const count = harness.emitted.length;
			await harness.emitRecord(stream, data);
			if (harness.emitted.length > count) await options?.beforeEmit?.();
		},
		emittedAt: EMITTED_AT,
		page: {} as BrowserCollectContext["page"],
		progress: () => Promise.resolve(),
		requestDetailGapPage: () => Promise.resolve([]),
		requested,
		scope: { streams: [] },
		sendInteraction: () => Promise.reject(new Error("not used")),
		state,
	} as BrowserCollectContext;
	return {
		ctx,
		emitted: harness.emitted,
		messages: harness.protocolMessages,
		events: harness.events,
	};
}

// The same scripted Activities / GetTrip page-fetch seam as integration.test.ts.
const ids = Array.from({ length: 20 }, (_, index) => `synthetic-trip-${index}`);
const pages = Array.from({ length: 4 }, (_, page) =>
	activitiesBody(
		ids.slice(page * 5, page * 5 + 5).map((uuid) => ({ uuid })),
		`page-${page + 1}`,
	),
).concat(activitiesBody([]));

function scripted(failPage?: number) {
	const cursors: unknown[] = [];
	const fetchPath: UberPageFetch = async (operation, _query, variables) => {
		if (operation === "Activities") {
			const page = cursors.length;
			const expected = page === 0 ? undefined : `page-${page}`;
			assert.equal(variables.nextPageToken, expected);
			cursors.push(variables.nextPageToken);
			if (page + 1 === failPage) return { status: 429, body: "{}" };
			assert.ok(pages[page], "activity requests must stop at the source end");
			return { status: 200, body: pages[page]! };
		}
		assert.equal(operation, "GetTrip");
		assert.ok(ids.includes(String(variables.tripUUID)));
		return { status: 200, body: getTripBody({ status: "COMPLETED" }) };
	};
	return { fetchPath, cursors };
}

const expectedCursors = [undefined, "page-1", "page-2", "page-3", "page-4"];

async function complete(state: BrowserCollectContext["state"] = {}) {
	const run = makeCtx(["trips"], state);
	const source = scripted();
	await collectAllStreams(run.ctx, source.fetchPath, NO_DELAY);
	assert.deepEqual(source.cursors, expectedCursors);
	assert.deepEqual(
		run.emitted.map(({ data }) => data.id),
		ids,
	);
	const stateMessage = run.messages
		.filter((message) => message.type === "STATE")
		.at(-1);
	assert.ok(stateMessage?.type === "STATE");
	assert.deepEqual(stateMessage.cursor, {
		hydrated_trip_ids: ids,
		hydrated_receipt_ids: [],
	});
	const coverage = run.messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, ids.length);
	assert.equal(coverage.covered, ids.length);
	assert.deepEqual(coverage.hydrated_keys, ids);
	return { ...run, cursor: stateMessage.cursor };
}

test("Uber trips drains four Activity pages, emits each ID once, and checkpoints full detail", async () => {
	await complete();
});

test("Uber trips page-three rate limit cannot advance state and a head retry reaches the same end", async () => {
	const baseline = await complete();
	const stopped = makeCtx(["trips"]);
	const source = scripted(3);
	await assert.rejects(
		collectAllStreams(stopped.ctx, source.fetchPath, NO_DELAY),
		UBER_RETRYABLE_PATTERN,
	);
	assert.deepEqual(source.cursors, expectedCursors.slice(0, 3));
	assert.equal(
		stopped.messages.some((message) => message.type === "DETAIL_COVERAGE"),
		false,
	);
	const last = stopped.messages
		.filter((message) => message.type === "STATE")
		.at(-1);
	const retryState =
		last?.type === "STATE" ? { trips: last.cursor } : stopped.ctx.state;
	assert.equal(last, undefined);
	// Feed listing precedes hydration: the rejected walk did not emit any trips or STATE.
	assert.deepEqual(stopped.emitted, []);
	const retry = await complete(retryState);
	assert.deepEqual(
		[
			...new Set(
				[...stopped.emitted, ...retry.emitted].map(({ data }) => data.id),
			),
		],
		baseline.emitted.map(({ data }) => data.id),
	);
	assert.deepEqual(retry.cursor, baseline.cursor);
});

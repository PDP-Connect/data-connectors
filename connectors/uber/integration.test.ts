// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end collect()-layer tests, driven through a scripted `UberPageFetch`
 * (no real browser, no real network — parsers.test.ts / schemas.test.ts
 * cover pure-function coverage).
 *
 * The load-bearing assertion here is D5 as revised by capability-map.json's
 * `lead_decision_live`: a trips-only START must perform zero GetReceipt
 * calls. `receipts` is declared `state_stream: "trips"` /
 * `coverage_strategy: "checkpoint_window"` in manifests/uber.json (it rides
 * trips' checkpoint rather than proving its own) — this file proves the
 * connector honors the zero-GetReceipt-calls dependency at the collect()
 * layer, not just in the manifest declaration.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	fetchAllActivities,
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

function getReceiptBody(receiptDataHtml: string): string {
	return JSON.stringify({
		data: { getReceipt: { receiptData: receiptDataHtml } },
	});
}

/** Script one JSON response per matched operationName. GetTrip/GetReceipt calls are keyed per-tripUUID so each trip can return distinct detail. */
function makeScriptedFetch(script: {
	activitiesPages?: Array<{ status?: number; body: string }>;
	getReceipt?: Record<string, { status?: number; body: string }>;
	getTrip?: Record<string, { status?: number; body: string }>;
}): { calls: string[]; fetchPath: UberPageFetch } {
	const calls: string[] = [];
	let activitiesPageIndex = 0;
	const fetchPath: UberPageFetch = (operationName, _query, variables) => {
		if (operationName === "Activities") {
			calls.push("Activities");
			const pages = script.activitiesPages ?? [{ body: activitiesBody([]) }];
			const r = pages[Math.min(activitiesPageIndex, pages.length - 1)];
			activitiesPageIndex += 1;
			if (!r) {
				throw new Error("no scripted Activities response");
			}
			return Promise.resolve({ status: r.status ?? 200, body: r.body });
		}
		if (operationName === "GetTrip") {
			const tripUUID = variables.tripUUID as string;
			calls.push(`GetTrip:${tripUUID}`);
			const r = script.getTrip?.[tripUUID];
			if (!r) {
				throw new Error(`no scripted GetTrip response for ${tripUUID}`);
			}
			return Promise.resolve({ status: r.status ?? 200, body: r.body });
		}
		if (operationName === "GetReceipt") {
			const tripUUID = variables.tripUUID as string;
			calls.push(`GetReceipt:${tripUUID}`);
			const r = script.getReceipt?.[tripUUID];
			if (!r) {
				throw new Error(`no scripted GetReceipt response for ${tripUUID}`);
			}
			return Promise.resolve({ status: r.status ?? 200, body: r.body });
		}
		throw new Error(`no scripted response for operation ${operationName}`);
	};
	return { calls, fetchPath };
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

const RECEIPT_HTML = (fareTotal: string) =>
	`<span data-testid="fare_line_item_label_trip_fare" class="fare-breakdown-name">Trip fare</span><span data-testid="fare_line_item_amount_trip_fare" class="fare-breakdown-amount">${fareTotal}</span>`;

// ─── D5 (revised): trips-only START performs zero GetReceipt calls ─────────

test("collectAllStreams: a trips-only START never calls GetReceipt", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{
				body: activitiesBody([{ uuid: "trip-1" }, { uuid: "trip-2" }]),
			},
		],
		getTrip: {
			"trip-1": { body: getTripBody({ status: "COMPLETED", fare: "$10.00" }) },
			"trip-2": { body: getTripBody({ status: "COMPLETED", fare: "$20.00" }) },
		},
	});
	const { ctx, emitted } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);

	assert.equal(emitted.length, 2);
	assert.ok(emitted.every((r) => r.stream === "trips"));
	assert.ok(
		calls.every((c) => !c.startsWith("GetReceipt")),
		`expected zero GetReceipt calls, got: ${calls.join(", ")}`,
	);
	// It DOES need GetTrip — trips' own fields are hydrated from GetTrip.
	assert.equal(calls.filter((c) => c.startsWith("GetTrip")).length, 2);
});

test("collectAllStreams: trips RECORD carries the GetTrip receipt's distance/duration display text", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: {
			"trip-1": {
				body: getTripBody(
					{ status: "COMPLETED", fare: "$10.00" },
					{ distance: "12.3", distanceLabel: "miles", duration: "25 minutes" },
				),
			},
		},
	});
	const { ctx, emitted } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	const trip = emitted.find((r) => r.stream === "trips");
	assert.equal(trip?.data.distance_display, "12.3 miles");
	assert.equal(trip?.data.duration_display, "25 minutes");
});

test("collectAllStreams: neither trips nor receipts requested fetches nothing", async () => {
	const { fetchPath, calls } = makeScriptedFetch({});
	const { ctx, emitted } = makeCtx(["some_other_stream"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.length, 0);
	assert.deepEqual(calls, []);
});

// ─── receipts requested: one GetReceipt per trip in addition to GetTrip ────

test("collectAllStreams: receipts requested emits both streams from GetTrip + GetReceipt", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{
				body: activitiesBody([{ uuid: "trip-1" }, { uuid: "trip-2" }]),
			},
		],
		getTrip: {
			"trip-1": { body: getTripBody({ status: "COMPLETED", fare: "$10.00" }) },
			"trip-2": { body: getTripBody({ status: "COMPLETED", fare: "$20.00" }) },
		},
		getReceipt: {
			"trip-1": { body: getReceiptBody(RECEIPT_HTML("$10.00")) },
			"trip-2": { body: getReceiptBody(RECEIPT_HTML("$20.00")) },
		},
	});
	const { ctx, emitted } = makeCtx(["trips", "receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);

	assert.equal(emitted.filter((r) => r.stream === "trips").length, 2);
	assert.equal(emitted.filter((r) => r.stream === "receipts").length, 2);
	assert.equal(calls.filter((c) => c.startsWith("GetTrip")).length, 2);
	assert.equal(calls.filter((c) => c.startsWith("GetReceipt")).length, 2);
});

test("collectAllStreams: receipts-only (trips not requested) fetches GetReceipt but not GetTrip, no trips RECORDs", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getReceipt: { "trip-1": { body: getReceiptBody(RECEIPT_HTML("$10.00")) } },
	});
	const { ctx, emitted } = makeCtx(["receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.filter((r) => r.stream === "trips").length, 0);
	assert.equal(emitted.filter((r) => r.stream === "receipts").length, 1);
	assert.equal(calls.filter((c) => c.startsWith("GetTrip")).length, 0);
	assert.equal(calls.filter((c) => c.startsWith("GetReceipt")).length, 1);
});

test("collectAllStreams: a GetTrip failure leaves the trip unhydrated (trips DETAIL_COVERAGE covered < considered)", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-1" }, { uuid: "trip-2" }]) },
		],
		getTrip: {
			"trip-1": { body: getTripBody({ status: "COMPLETED" }) },
			// trip-2 has no scripted GetTrip response -> fetchGetTrip throws,
			// tripRecord is never called for it, an honest unhydrated key.
		},
	});
	const { ctx, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);

	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "trips",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.state_stream, "trips");
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 1);
	assert.deepEqual([...coverage.required_keys].sort(), ["trip-1", "trip-2"]);
	assert.deepEqual(coverage.hydrated_keys, ["trip-1"]);
});

test("collectAllStreams: receipts never constructs a DETAIL_COVERAGE of its own (state_stream-declared, fleet guard)", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
		getReceipt: { "trip-1": { body: getReceiptBody(RECEIPT_HTML("$10.00")) } },
	});
	const { ctx, messages } = makeCtx(["trips", "receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	const receiptsCoverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "receipts",
	);
	assert.equal(receiptsCoverage, undefined);
});

test("collectAllStreams: a GetReceipt failure is non-fatal — no receipts record is fabricated", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: {
			"trip-1": { body: getTripBody({ status: "COMPLETED", fare: "$10.00" }) },
		},
		// No scripted GetReceipt response for trip-1 -> throws internally,
		// caught as non-fatal; receiptRecord sees an empty fareBreakdown and
		// returns null (no fabricated all-null record).
	});
	const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.filter((r) => r.stream === "receipts").length, 0);
	assert.equal(emitted.filter((r) => r.stream === "trips").length, 1);
	const checkpoint = messages.find((message) => message.type === "STATE");
	assert.ok(checkpoint?.type === "STATE");
	assert.deepEqual(checkpoint.cursor, {
		hydrated_trip_ids: ["trip-1"],
		hydrated_receipt_ids: [],
	});
	const retry = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getReceipt: { "trip-1": { body: getReceiptBody(RECEIPT_HTML("$10.00")) } },
	});
	const followup = makeCtx(["trips", "receipts"], { trips: checkpoint.cursor });
	await collectAllStreams(followup.ctx, retry.fetchPath, NO_DELAY);
	assert.deepEqual(retry.calls, ["Activities", "GetReceipt:trip-1"]);
	const retried = followup.messages.find((message) => message.type === "STATE");
	assert.ok(retried?.type === "STATE");
	assert.deepEqual(retried.cursor, {
		hydrated_trip_ids: ["trip-1"],
		hydrated_receipt_ids: ["trip-1"],
	});
});

test("collectAllStreams: trips DETAIL_COVERAGE is self-mapped (state_stream === trips)", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "trips",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.state_stream, "trips");
	assert.equal(coverage.considered, 1);
	assert.equal(coverage.covered, 1);
});

test("collectAllStreams: an activity with no usable trip id is dropped, not emitted with a fabricated id", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ title: "no id" }, { uuid: "trip-1" }]) },
		],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, emitted, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.length, 1);
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "trips",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 1, "only the valid trip was buffered");
	assert.equal(coverage.covered, 1);
	assert.deepEqual(coverage.required_keys, ["trip-1"]);
	assert.deepEqual(
		emitted.map((record) => record.data.id),
		["trip-1"],
	);
	assert.deepEqual(coverage.hydrated_keys, ["trip-1"]);
});

// ─── Real pagination (nextPageToken) ────────────────────────────────────────

test("collectAllStreams: walks multiple Activities pages via nextPageToken until it stops", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-1" }], "token-1") },
			{ body: activitiesBody([{ uuid: "trip-2" }], "token-2") },
			{ body: activitiesBody([], null) },
		],
		getTrip: {
			"trip-1": { body: getTripBody({ status: "COMPLETED" }) },
			"trip-2": { body: getTripBody({ status: "COMPLETED" }) },
		},
	});
	const { ctx, emitted } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.length, 2);
	assert.equal(calls.filter((c) => c === "Activities").length, 3);
});

test("collectAllStreams: a page with no nextPageToken stops even with a full page of new ids", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }], null) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, emitted } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.length, 1);
	assert.equal(calls.filter((c) => c === "Activities").length, 1);
});

test("fetchAllActivities: duplicate-only pages with fresh continuations retain later trips", async () => {
	const { fetchPath: scripted, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-a" }], "t1") },
			{ body: activitiesBody([{ uuid: "trip-a" }], "t2") },
			{ body: activitiesBody([{ uuid: "trip-b" }], null) },
		],
	});
	const sentTokens: unknown[] = [];
	const fetchPath: UberPageFetch = (name, query, variables) => {
		sentTokens.push(variables.nextPageToken);
		return scripted(name, query, variables);
	};
	const delays: number[] = [];
	const result = await fetchAllActivities(fetchPath, async (ms) => {
		delays.push(ms);
	});
	assert.deepEqual(result, {
		activities: [{ uuid: "trip-a" }, { uuid: "trip-b" }],
		truncated: false,
	});
	assert.deepEqual(calls, ["Activities", "Activities", "Activities"]);
	// Each request carries the cursor the previous page returned.
	assert.deepEqual(sentTokens, [undefined, "t1", "t2"]);
	assert.equal(delays.length, 2);
});

test("fetchAllActivities: duplicate terminal page without continuation is exhausted", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-a" }], "t1") },
			{ body: activitiesBody([{ uuid: "trip-a" }], null) },
		],
	});
	assert.deepEqual(await fetchAllActivities(fetchPath, NO_DELAY), {
		activities: [{ uuid: "trip-a" }],
		truncated: false,
	});
	assert.deepEqual(calls, ["Activities", "Activities"]);
});

for (const continuations of [
	["t1", "t1"],
	["t1", "t2", "t1"],
]) {
	test(`collectAllStreams: refuses continuation loop ${continuations.join("/")}`, async () => {
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: continuations.map((continuation) => ({
				body: activitiesBody([{ uuid: "trip-a" }], continuation),
			})),
		});
		const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
		const delays: number[] = [];
		await assert.rejects(
			collectAllStreams(ctx, fetchPath, async (ms) => {
				delays.push(ms);
			}),
			{
				message:
					"uber_graphql_error [endpoint Activities]: repeated continuation",
			},
		);
		assert.deepEqual(
			calls,
			continuations.map(() => "Activities"),
		);
		assert.equal(delays.length, continuations.length - 1);
		assert.deepEqual(emitted, []);
		assert.deepEqual(messages, []);
	});
}

test("fetchAllActivities: collects 201 fresh pages through the empty end", async () => {
	const expected = Array.from({ length: 201 }, (_, i) => ({
		uuid: `trip-${i}`,
	}));
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			...expected.map((activity, i) => ({
				body: activitiesBody([activity], `fresh-${i}`),
			})),
			{ body: activitiesBody([]) },
		],
	});
	const tokens: unknown[] = [];
	const checkedFetch: UberPageFetch = (operation, query, variables) => {
		tokens.push(variables.nextPageToken);
		return fetchPath(operation, query, variables);
	};
	const delays: number[] = [];
	const result = await fetchAllActivities(checkedFetch, async (ms) => {
		delays.push(ms);
	});
	assert.deepEqual(result, { activities: expected, truncated: false });
	assert.equal(calls.length, 202);
	assert.deepEqual(tokens, [
		undefined,
		...expected.map((_, i) => `fresh-${i}`),
	]);
	assert.equal(delays.length, 201);
});

test("collectAllStreams: long activity history has no page-budget SKIP", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			...Array.from({ length: 201 }, (_, i) => ({
				body: activitiesBody([{ uuid: `trip-${i}` }], `fresh-${i}`),
			})),
			{ body: activitiesBody([]) },
		],
		getTrip: Object.fromEntries(
			Array.from({ length: 200 }, (_, i) => [
				`trip-${i}`,
				{ body: getTripBody({ status: "COMPLETED" }) },
			]),
		),
	});
	const { ctx, messages, emitted } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(calls.filter((call) => call === "Activities").length, 202);
	assert.equal(emitted.length, 200, "the separate detail limit is unchanged");
	assert.equal(messages.some((message) => message.type === "SKIP_RESULT"), false);
	assert.equal(messages.filter((message) => message.type === "DETAIL_GAP").length, 1);
	const coverage = messages.find((message) => message.type === "DETAIL_COVERAGE");
	assert.ok(coverage?.type === "DETAIL_COVERAGE");
	assert.deepEqual(coverage.gap_keys, ["trip-200"]);
});

test("fetchAllActivities: two duplicate-only pages in a row still follow the cursor", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-a" }], "t1") },
			{ body: activitiesBody([{ uuid: "trip-a" }], "t2") },
			{ body: activitiesBody([{ uuid: "trip-a" }], "t3") },
			{ body: activitiesBody([{ uuid: "trip-b" }], null) },
		],
	});
	assert.deepEqual(await fetchAllActivities(fetchPath, NO_DELAY), {
		activities: [{ uuid: "trip-a" }, { uuid: "trip-b" }],
		truncated: false,
	});
	assert.equal(calls.length, 4);
});

test("fetchAllActivities: a new trip resets the duplicate-only page streak", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-a" }], "t1") },
			{ body: activitiesBody([{ uuid: "trip-a" }], "t2") },
			{ body: activitiesBody([{ uuid: "trip-a" }], "t3") },
			{ body: activitiesBody([{ uuid: "trip-b" }], "t4") },
			{ body: activitiesBody([{ uuid: "trip-b" }], "t5") },
			{ body: activitiesBody([{ uuid: "trip-b" }], "t6") },
			{ body: activitiesBody([{ uuid: "trip-c" }], null) },
		],
	});
	const delays: number[] = [];
	const result = await fetchAllActivities(fetchPath, async (ms) => {
		delays.push(ms);
	});
	assert.deepEqual(result, {
		activities: [{ uuid: "trip-a" }, { uuid: "trip-b" }, { uuid: "trip-c" }],
		truncated: false,
	});
	assert.equal(calls.length, 7);
	assert.equal(delays.length, 6);
});

test("fetchAllActivities: three duplicate-only pages in a row stop as truncated", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: Array.from({ length: 200 }, (_, i) => ({
			body: activitiesBody([{ uuid: "trip-a" }], `fresh-${i}`),
		})),
	});
	const delays: number[] = [];
	const result = await fetchAllActivities(fetchPath, async (ms) => {
		delays.push(ms);
	});
	assert.deepEqual(result, {
		activities: [{ uuid: "trip-a" }],
		truncated: true,
		stopReason: "duplicate_only_pages",
	});
	assert.equal(calls.length, 4);
	assert.equal(delays.length, 3);
});

test("collectAllStreams: a duplicate-only page streak reports trips as stopped early", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: Array.from({ length: 4 }, (_, i) => ({
			body: activitiesBody([{ uuid: "trip-a" }], `fresh-${i}`),
		})),
	});
	const { ctx, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	const skips = messages.filter(
		(m) => (m as { type?: string }).type === "SKIP_RESULT",
	) as { reason?: string; message?: string; diagnostics?: unknown }[];
	assert.equal(skips.length, 1);
	assert.equal(skips[0]?.reason, "trips_deferred_page_budget");
	assert.deepEqual(skips[0]?.diagnostics, {
		duplicate_only_page_limit: 3,
		stop_reason: "duplicate_only_pages",
	});
	assert.match(skips[0]?.message ?? "", /3 pages in a row with no new trips/);
});

// ─── Records-before-DETAIL_COVERAGE ordering ────────────────────────────────

test("collectAllStreams: records emit before DETAIL_COVERAGE for trips", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, events } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	const lastRecordIdx = events.reduce(
		(acc, e, i) => (e.kind === "record" ? i : acc),
		-1,
	);
	const coverageIdx = events.findIndex(
		(e) => e.kind === "message" && e.message.type === "DETAIL_COVERAGE",
	);
	assert.ok(lastRecordIdx !== -1);
	assert.ok(coverageIdx !== -1);
	assert.ok(
		coverageIdx > lastRecordIdx,
		"DETAIL_COVERAGE must land after the last RECORD",
	);
});

test("collectAllStreams: trips checkpoints successfully hydrated trip IDs", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	const checkpoint = messages.find((m) => m.type === "STATE");
	assert.ok(checkpoint?.type === "STATE");
	assert.equal(checkpoint.stream, "trips");
	assert.ok(
		(checkpoint.cursor as { hydrated_trip_ids?: string[] }).hydrated_trip_ids?.includes("trip-1"),
	);
});

// ─── No raw fetch anywhere in the collect path ──────────────────────────────

test("collectAllStreams: never calls globalThis.fetch — every read goes through the injected page-fetch seam", async () => {
	const original = globalThis.fetch;
	let called = false;
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
		called = true;
		return original(...args);
	}) as typeof globalThis.fetch;
	try {
		const { fetchPath } = makeScriptedFetch({
			activitiesPages: [{ body: activitiesBody([]) }],
		});
		const { ctx } = makeCtx(["trips", "receipts"]);
		await collectAllStreams(ctx, fetchPath, NO_DELAY);
		assert.equal(
			called,
			false,
			"collectAllStreams must never call globalThis.fetch directly",
		);
	} finally {
		globalThis.fetch = original;
	}
});

test("fetchAllActivities: HTTP 200 GraphQL failures reject instead of certifying empty history", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{
				body: JSON.stringify({
					errors: [{ message: "temporarily unavailable" }],
					data: null,
				}),
			},
		],
	});
	await assert.rejects(fetchAllActivities(fetchPath, NO_DELAY), {
		message:
			"uber_graphql_error [endpoint Activities]: temporarily unavailable",
	});
	assert.deepEqual(calls, ["Activities"]);
	assert.equal(
		UBER_RETRYABLE_PATTERN.test("uber_graphql_error [endpoint Activities]"),
		false,
	);
	assert.equal(
		UBER_RETRYABLE_PATTERN.test("uber_http_503 [endpoint Activities]"),
		false,
	);
});

[{ data: null }, {}, { errors: [{ message: "failed" }], data: {} }].forEach(
	(body) => {
		test(`fetchAllActivities: rejects failed envelope ${JSON.stringify(body)}`, async () => {
			const { fetchPath } = makeScriptedFetch({
				activitiesPages: [{ body: JSON.stringify(body) }],
			});
			await assert.rejects(
				fetchAllActivities(fetchPath, NO_DELAY),
				/uber_graphql_error/,
			);
		});
	},
);

[
	{},
	{ activities: null },
	{ activities: {} },
	{ activities: { past: null } },
	{ activities: { past: {} } },
	{ activities: { past: { activities: {} } } },
	{ activities: [] },
	{ activities: "invalid" },
	{ activities: { past: [] } },
	{ activities: { past: "invalid" } },
	{ activities: { past: { activities: "invalid" } } },
	{ activities: { past: { activities: null } } },
].forEach((data) => {
	test(`fetchAllActivities: rejects malformed Activities data ${JSON.stringify(data)}`, async () => {
		const { fetchPath } = makeScriptedFetch({
			activitiesPages: [{ body: JSON.stringify({ data }) }],
		});
		await assert.rejects(fetchAllActivities(fetchPath, NO_DELAY), {
			message:
				"uber_graphql_error [endpoint Activities]: Malformed Activities data",
		});
	});
});

[{ activities: { past: { activities: [] } } }].forEach((data) => {
	test(`fetchAllActivities: preserves empty history ${JSON.stringify(data)}`, async () => {
		const { fetchPath } = makeScriptedFetch({
			activitiesPages: [{ body: JSON.stringify({ data }) }],
		});
		assert.deepEqual(await fetchAllActivities(fetchPath, NO_DELAY), {
			activities: [],
			truncated: false,
		});
	});
});

test("fetchAllActivities: id-less pages behind fresh cursors refuse rather than truncate", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: Array.from({ length: 5 }, (_, i) => ({
			body: activitiesBody([{ title: "no id" }], `fresh-${i}`),
		})),
	});
	await assert.rejects(fetchAllActivities(fetchPath, NO_DELAY), {
		message:
			"uber_graphql_error [endpoint Activities]: no activity carried a trip id",
	});
	assert.equal(calls.length, 3);
});

test("collectAllStreams: id-less-only activity history refuses without emitting", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ title: "no id" }]) }],
	});
	const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
	await assert.rejects(collectAllStreams(ctx, fetchPath, NO_DELAY), {
		message:
			"uber_graphql_error [endpoint Activities]: no activity carried a trip id",
	});
	assert.deepEqual(calls, ["Activities"]);
	assert.deepEqual(emitted, []);
	assert.deepEqual(messages, []);
});

[
	{ operation: "GetTrip", status: 401, prefix: "uber_session_expired" },
	{ operation: "GetTrip", status: 429, prefix: "uber_rate_limited" },
	{ operation: "GetReceipt", status: 403, prefix: "uber_session_expired" },
	{ operation: "GetReceipt", status: 429, prefix: "uber_rate_limited" },
	{ operation: "GetTrip", status: 200, prefix: "uber_transport_error" },
	{ operation: "GetReceipt", status: 200, prefix: "uber_transport_error" },
].forEach(({ operation, status, prefix }) => {
	test(`collectAllStreams: ${operation} ${prefix} stops before the next trip`, async () => {
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: [
				{ body: activitiesBody([{ uuid: "trip-1" }, { uuid: "trip-2" }]) },
			],
			getTrip: {
				"trip-1": {
					status: operation === "GetTrip" ? status : 200,
					body: getTripBody({ status: "COMPLETED" }),
				},
				"trip-2": { body: getTripBody({ status: "COMPLETED" }) },
			},
			getReceipt: {
				"trip-1": {
					status: operation === "GetReceipt" ? status : 200,
					body: getReceiptBody(RECEIPT_HTML("$10.00")),
				},
				"trip-2": { body: getReceiptBody(RECEIPT_HTML("$20.00")) },
			},
		});
		const scripted: UberPageFetch = async (name, query, variables) => {
			const response = await fetchPath(name, query, variables);
			if (prefix === "uber_transport_error" && name === operation) {
				throw new Error(
					`uber_transport_error [endpoint ${name}]: synthetic offline`,
				);
			}
			return response;
		};
		const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
		await assert.rejects(
			collectAllStreams(ctx, scripted, NO_DELAY),
			(error: unknown) =>
				error instanceof Error && error.message.startsWith(prefix),
		);
		assert.deepEqual(
			calls,
			operation === "GetTrip"
				? ["Activities", "GetTrip:trip-1"]
				: ["Activities", "GetTrip:trip-1", "GetReceipt:trip-1"],
		);
		assert.equal(emitted.length, operation === "GetTrip" ? 0 : 1);
		assert.ok(emitted.every((record) => record.stream === "trips"));
		assert.deepEqual(messages, []);
	});
});

test("collectAllStreams: GetTrip HTTP 404 remains a per-trip coverage gap", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-1" }, { uuid: "trip-2" }]) },
		],
		getTrip: {
			"trip-1": { status: 404, body: "not found" },
			"trip-2": { body: getTripBody({ status: "COMPLETED" }) },
		},
	});
	const { ctx, emitted, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.deepEqual(calls, ["Activities", "GetTrip:trip-1", "GetTrip:trip-2"]);
	assert.equal(emitted.length, 1);
	const coverage = messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 1);
	assert.deepEqual(coverage.hydrated_keys, ["trip-2"]);
});

[
	{
		name: "errors without data",
		bodies: [JSON.stringify({ errors: [{ message: "unavailable" }] })],
	},
	{
		name: "errors with a real trip",
		bodies: [
			JSON.stringify({
				...JSON.parse(activitiesBody([{ uuid: "trip-1" }])),
				errors: [{ message: "partial response" }],
			}),
		],
	},
	{
		name: "errors after a valid first page",
		bodies: [
			activitiesBody([{ uuid: "trip-1" }], "next-page"),
			JSON.stringify({ errors: [{ message: "second page unavailable" }] }),
		],
	},
	{
		name: "missing Activities containers",
		bodies: [JSON.stringify({ data: {} })],
	},
].forEach(({ name, bodies }) => {
	test(`collectAllStreams: ${name} refuses before records, state, coverage or detail reads`, async () => {
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: bodies.map((body) => ({ body })),
		});
		const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
		await assert.rejects(
			collectAllStreams(ctx, fetchPath, NO_DELAY),
			/uber_graphql_error/,
		);
		assert.deepEqual(emitted, []);
		assert.deepEqual(messages, []);
		assert.deepEqual(
			calls,
			bodies.map(() => "Activities"),
		);
	});
});

test("collectAllStreams: a genuinely empty feed emits zero-key coverage", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([]) }],
	});
	const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.deepEqual(emitted, []);
	assert.deepEqual(calls, ["Activities"]);
	const coverage = messages.find((message) => message.type === "DETAIL_COVERAGE");
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.stream, "trips");
	assert.equal(coverage.state_stream, "trips");
	assert.equal(coverage.considered, 0);
	assert.equal(coverage.covered, 0);
	assert.deepEqual(coverage.required_keys, []);
	assert.deepEqual(coverage.hydrated_keys, []);
});

test("trips hydration progresses over three runs without refetching finalized trips", async () => {
	const ids = Array.from({ length: 450 }, (_, index) => `synthetic-trip-${index}`);
	const run = async (state: BrowserCollectContext["state"] = {}) => {
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: [{ body: activitiesBody(ids.map((uuid) => ({ uuid }))) }],
			getTrip: Object.fromEntries(
				ids.map((id) => [id, { body: getTripBody({ status: "COMPLETED" }) }]),
			),
		});
		const { ctx, messages, emitted } = makeCtx(["trips"], state);
		await collectAllStreams(ctx, fetchPath, NO_DELAY);
		const checkpoint = messages.find((message) => message.type === "STATE");
		assert.ok(checkpoint?.type === "STATE");
		return {
			calls: calls.filter((call) => call.startsWith("GetTrip:")),
			state: { trips: checkpoint.cursor },
			messages,
			emitted,
		};
	};
	const first = await run();
	const second = await run(first.state);
	const third = await run(second.state);
	assert.equal(first.calls.length, 200);
	assert.equal(second.calls.length, 200);
	assert.equal(third.calls.length, 50);
	assert.deepEqual(
		[...first.calls, ...second.calls, ...third.calls],
		ids.map((id) => `GetTrip:${id}`),
	);
	assert.deepEqual(
		[...first.emitted, ...second.emitted, ...third.emitted].map((record) => record.data.id),
		ids,
	);
	assert.equal(first.messages.filter((message) => message.type === "DETAIL_GAP").length, 250);
	assert.equal(third.messages.some((message) => message.type === "DETAIL_GAP"), false);
});

test("receipts can hydrate after trips have already checkpointed their details", async () => {
	const activitiesPages = [{ body: activitiesBody([{ uuid: "synthetic-trip" }]) }];
	const tripFetch = makeScriptedFetch({
		activitiesPages,
		getTrip: { "synthetic-trip": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const trips = makeCtx(["trips"]);
	await collectAllStreams(trips.ctx, tripFetch.fetchPath, NO_DELAY);
	assert.equal(tripFetch.calls.some((call) => call.startsWith("GetReceipt:")), false);
	const checkpoint = trips.messages.find((message) => message.type === "STATE");
	assert.ok(checkpoint?.type === "STATE");

	const receiptFetch = makeScriptedFetch({
		activitiesPages,
		getReceipt: { "synthetic-trip": { body: getReceiptBody(RECEIPT_HTML("$12.00")) } },
	});
	const receipts = makeCtx(["receipts"], { trips: checkpoint.cursor });
	await collectAllStreams(receipts.ctx, receiptFetch.fetchPath, NO_DELAY);
	assert.deepEqual(receiptFetch.calls, ["Activities", "GetReceipt:synthetic-trip"]);
	assert.equal(receipts.emitted.filter((record) => record.stream === "receipts").length, 1);
	assert.equal(receipts.messages.some((message) => message.type === "DETAIL_COVERAGE"), false);
});

test("receipt-only run with no parent STATE hydrates the feed tail without writing trips STATE", async () => {
	const ids = Array.from({ length: 201 }, (_, index) => `synthetic-receipt-${index}`);
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody(ids.map((uuid) => ({ uuid }))) }],
		getReceipt: Object.fromEntries(
			ids.map((id) => [id, { body: getReceiptBody(RECEIPT_HTML("$10.00")) }]),
		),
	});
	const { ctx, messages, emitted } = makeCtx(["receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.deepEqual(calls, ["Activities", ...ids.map((id) => `GetReceipt:${id}`)]);
	assert.equal(emitted.length, 201);
	assert.equal(messages.some((message) => message.type === "STATE"), false);
});

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

function makeCtx(requestedStreams: string[]): {
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
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page: {} as BrowserCollectContext["page"],
		progress: () => Promise.resolve(),
		requestDetailGapPage: () => Promise.resolve([]),
		requested,
		scope: { streams: [] },
		sendInteraction: () => Promise.reject(new Error("not used")),
		state: {},
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
	const { ctx, emitted } = makeCtx(["trips", "receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.filter((r) => r.stream === "receipts").length, 0);
	assert.equal(emitted.filter((r) => r.stream === "trips").length, 1);
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
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-a" }], "t1") },
			{ body: activitiesBody([{ uuid: "trip-a" }], "t2") },
			{ body: activitiesBody([{ uuid: "trip-b" }], null) },
		],
	});
	const delays: number[] = [];
	const result = await fetchAllActivities(fetchPath, async (ms) => {
		delays.push(ms);
	});
	assert.deepEqual(result, {
		activities: [{ uuid: "trip-a" }, { uuid: "trip-b" }],
		truncated: false,
		incomplete: false,
	});
	assert.deepEqual(calls, ["Activities", "Activities", "Activities"]);
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
		incomplete: false,
	});
	assert.deepEqual(calls, ["Activities", "Activities"]);
});

for (const continuations of [
	["t1", "t1"],
	["t1", "t2", "t1"],
]) {
	test(`fetchAllActivities: retains the prefix and truncates a cursor loop ${continuations.join("/")}`, async () => {
		const activities = continuations.map((_, i) => ({ uuid: `trip-${i}` }));
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: continuations.map((continuation, i) => ({
				body: activitiesBody([{ uuid: `trip-${i}` }], continuation),
			})),
		});
		const delays: number[] = [];
		const result = await fetchAllActivities(fetchPath, async (ms) => {
			delays.push(ms);
		});
		assert.deepEqual(result, {
			activities,
			truncated: false,
			incomplete: true,
		});
		assert.deepEqual(
			calls,
			continuations.map(() => "Activities"),
		);
		assert.equal(delays.length, continuations.length - 1);
	});
}

test("fetchAllActivities: fresh duplicate-only continuations still honor the page ceiling", async () => {
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
		incomplete: false,
	});
	assert.equal(calls.length, 200);
	assert.equal(delays.length, 199);
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

test("collectAllStreams: trips (full_inventory) emits no STATE", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(
		messages.some((m) => m.type === "STATE"),
		false,
		"trips is incremental: false / full_inventory — it must not claim a cursor via STATE",
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

test("fetchAllActivities: keeps partial GraphQL data and continues to the last page", async () => {
	const good = JSON.parse(activitiesBody([{ uuid: "trip-a" }], "fresh-token"));
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [
			{
				body: JSON.stringify({
					...good,
					errors: [{ message: "a field is temporarily unavailable" }],
				}),
			},
			{ body: activitiesBody([{ uuid: "trip-b" }]) },
		],
	});
	assert.deepEqual(await fetchAllActivities(fetchPath, NO_DELAY), {
		activities: [{ uuid: "trip-a" }, { uuid: "trip-b" }],
		truncated: false,
		incomplete: true,
	});
	assert.deepEqual(calls, ["Activities", "Activities"]);
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

[
	{ activities: { past: { activities: [] } } },
	{ activities: { past: { activities: null } } },
].forEach((data) => {
	test(`fetchAllActivities: preserves empty history ${JSON.stringify(data)}`, async () => {
		const { fetchPath } = makeScriptedFetch({
			activitiesPages: [{ body: JSON.stringify({ data }) }],
		});
		assert.deepEqual(await fetchAllActivities(fetchPath, NO_DELAY), {
			activities: [],
			truncated: false,
			incomplete: false,
		});
	});
});

[
	{
		name: "errors without data",
		bodies: [JSON.stringify({ errors: [{ message: "unavailable" }] })],
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
	assert.equal(messages.length, 1);
	const coverage = messages[0];
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.stream, "trips");
	assert.equal(coverage.state_stream, "trips");
	assert.equal(coverage.considered, 0);
	assert.equal(coverage.covered, 0);
	assert.deepEqual(coverage.required_keys, []);
	assert.deepEqual(coverage.hydrated_keys, []);
});

test("collectAllStreams: a partial GraphQL page keeps its trips and reports a retryable incomplete skip", async () => {
	const good = JSON.parse(activitiesBody([{ uuid: "trip-1" }]));
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [
			{
				body: JSON.stringify({
					...good,
					errors: [{ message: "a field is temporarily unavailable" }],
				}),
			},
		],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, emitted, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.length, 1);
	const skips = messages.filter((message) => message.type === "SKIP_RESULT");
	assert.deepEqual(
		skips.map((skip) => [skip.reason, skip.recovery_hint]),
		[
			[
				"trips_source_incomplete",
				{ action: "retry_by_runtime", retryable: true },
			],
		],
	);
});

[
	{
		name: "errors without data",
		body: JSON.stringify({ errors: [{ message: "temporarily unavailable" }] }),
	},
	{ name: "a missing Activities container", body: JSON.stringify({ data: {} }) },
	{ name: "an empty body", body: "" },
	{ name: "truncated JSON", body: '{"data":' },
].forEach(({ name, body }) => {
	test(`collectAllStreams: a later page with ${name} keeps the good prefix and reports a retryable skip`, async () => {
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: [
				{ body: activitiesBody([{ uuid: "good-trip" }], "page-2") },
				{ body },
			],
			getTrip: { "good-trip": { body: getTripBody({ status: "COMPLETED" }) } },
			getReceipt: {
				"good-trip": { body: getReceiptBody(RECEIPT_HTML("$10.00")) },
			},
		});
		const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
		await collectAllStreams(ctx, fetchPath, NO_DELAY);
		assert.deepEqual(calls, [
			"Activities",
			"Activities",
			"GetTrip:good-trip",
			"GetReceipt:good-trip",
		]);
		assert.deepEqual(
			emitted.map((record) => record.stream),
			["trips", "receipts"],
		);
		assert.deepEqual(
			messages
				.filter((message) => message.type === "SKIP_RESULT")
				.map((skip) => [skip.stream, skip.reason, skip.recovery_hint]),
			["trips", "receipts"].map((stream) => [
				stream,
				"trips_source_incomplete",
				{ action: "retry_by_runtime", retryable: true },
			]),
		);
	});
});

test("collectAllStreams: truncated JSON on the first page refuses before emitting anything", async () => {
	const { fetchPath, calls } = makeScriptedFetch({ activitiesPages: [{ body: '{"data":' }] });
	const { ctx, emitted, messages } = makeCtx(["trips", "receipts"]);
	await assert.rejects(collectAllStreams(ctx, fetchPath, NO_DELAY), /uber_graphql_error .* malformed JSON/i);
	assert.deepEqual(calls, ["Activities"]);
	assert.deepEqual(emitted, []);
	assert.deepEqual(messages, []);
});

[
	{
		name: "a partial page",
		pages: [
			{
				body: JSON.stringify({
					...JSON.parse(activitiesBody([{ uuid: "trip-1" }])),
					errors: [{ message: "a field is temporarily unavailable" }],
				}),
			},
		],
		reason: "trips_source_incomplete",
		tripIds: ["trip-1"],
		fetched: ["trip-1"],
	},
	{
		name: "the page ceiling",
		pages: Array.from({ length: 200 }, (_, i) => ({
			body: activitiesBody([{ uuid: "trip-1" }], `fresh-${i}`),
		})),
		reason: "trips_deferred_page_budget",
		tripIds: ["trip-1"],
		fetched: ["trip-1"],
	},
	{
		name: "the detail-fetch ceiling",
		pages: [
			{
				body: activitiesBody(
					Array.from({ length: 201 }, (_, i) => ({ uuid: `trip-${i}` })),
				),
			},
		],
		reason: "trips_deferred_detail_budget",
		tripIds: Array.from({ length: 201 }, (_, i) => `trip-${i}`),
		fetched: Array.from({ length: 200 }, (_, i) => `trip-${i}`),
	},
].forEach(({ name, pages, reason, tripIds, fetched }) => {
	test(`collectAllStreams: a receipts-only run reports ${name} on receipts`, async () => {
		const { fetchPath, calls } = makeScriptedFetch({
			activitiesPages: pages,
			getReceipt: Object.fromEntries(
				tripIds.map((id) => [id, { body: getReceiptBody("") }]),
			),
		});
		const { ctx, messages } = makeCtx(["receipts"]);
		await collectAllStreams(ctx, fetchPath, NO_DELAY);
		assert.equal(
			calls.some((call) => call.startsWith("GetTrip")),
			false,
		);
		assert.deepEqual(
			calls.filter((call) => call.startsWith("GetReceipt")),
			fetched.map((id) => `GetReceipt:${id}`),
		);
		assert.deepEqual(
			messages
				.filter((message) => message.type === "SKIP_RESULT")
				.map((skip) => [skip.stream, skip.reason]),
			[["receipts", reason]],
		);
		assert.equal(
			messages.some(
				(message) =>
					message.type === "STATE" || message.type === "DETAIL_COVERAGE",
			),
			false,
		);
	});
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
		const failedCalls = Array(prefix === "uber_rate_limited" ? 3 : 1).fill(
			`${operation}:trip-1`,
		);
		assert.deepEqual(
			calls,
			operation === "GetTrip"
				? ["Activities", ...failedCalls]
				: ["Activities", "GetTrip:trip-1", ...failedCalls],
		);
		assert.equal(emitted.length, operation === "GetTrip" ? 0 : 1);
		assert.ok(emitted.every((record) => record.stream === "trips"));
		assert.deepEqual(messages, []);
	});
});

test("collectAllStreams: a rate-limited GetTrip is retried and hydrates the trip", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	let attempts = 0;
	const scripted: UberPageFetch = (name, query, variables) => {
		if (name === "GetTrip" && ++attempts === 1) {
			return Promise.resolve({ status: 429, body: "fixture rate limit" });
		}
		return fetchPath(name, query, variables);
	};
	const delays: number[] = [];
	const { ctx, emitted } = makeCtx(["trips"]);
	await collectAllStreams(ctx, scripted, async (ms) => {
		delays.push(ms);
	});
	assert.equal(attempts, 2);
	assert.equal(delays.length, 1);
	assert.ok((delays[0] ?? 0) > 0);
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0]?.stream, "trips");
});

test("collectAllStreams: GetReceipt recovers on attempt three with growing waits", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getReceipt: { "trip-1": { body: getReceiptBody(RECEIPT_HTML("$10.00")) } },
	});
	let attempts = 0;
	const waits: number[] = [];
	const scripted: UberPageFetch = (name, query, variables) => {
		if (name === "GetReceipt" && ++attempts < 3) {
			return Promise.resolve({ status: 429, body: "fixture rate limit" });
		}
		return fetchPath(name, query, variables);
	};
	const { ctx, emitted } = makeCtx(["receipts"]);
	await collectAllStreams(ctx, scripted, async (ms) => { waits.push(ms); });
	assert.equal(attempts, 3);
	assert.equal(waits.length, 2);
	assert.ok((waits[0] ?? 0) > 0);
	assert.ok((waits[1] ?? 0) > (waits[0] ?? 0));
	assert.deepEqual(emitted.map(record => record.stream), ["receipts"]);
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

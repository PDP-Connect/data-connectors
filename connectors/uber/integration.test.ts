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
import { collectAllStreams, type UberPageFetch } from "./index.ts";
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

test("collectAllStreams: receipts-only hydrates GetTrip for its headline fare without emitting trips", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: {
			"trip-1": { body: getTripBody({ status: "COMPLETED", fare: "$10.00" }) },
		},
		getReceipt: { "trip-1": { body: getReceiptBody(RECEIPT_HTML("$3.00")) } },
	});
	const { ctx, emitted } = makeCtx(["receipts"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.filter((r) => r.stream === "trips").length, 0);
	const receipts = emitted.filter((r) => r.stream === "receipts");
	assert.equal(receipts.length, 1);
	assert.equal(receipts[0]?.data.fare_total, "$10.00");
	assert.equal(receipts[0]?.data.fare_total_cents, 1000);
	assert.equal(receipts[0]?.data.currency, "USD");
	assert.equal(calls.filter((c) => c.startsWith("GetTrip")).length, 1);
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
		activitiesPages: [{ body: activitiesBody([{ title: "no id" }]) }],
	});
	const { ctx, emitted, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(emitted.length, 0);
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "trips",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(
		coverage.considered,
		0,
		"the id-less activity was never buffered",
	);
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

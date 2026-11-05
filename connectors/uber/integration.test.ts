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
}): {
	calls: string[];
	activityTokens: Array<string | undefined>;
	fetchPath: UberPageFetch;
} {
	const calls: string[] = [];
	const activityTokens: Array<string | undefined> = [];
	let activitiesPageIndex = 0;
	const fetchPath: UberPageFetch = (operationName, _query, variables) => {
		if (operationName === "Activities") {
			calls.push("Activities");
			activityTokens.push(variables.nextPageToken as string | undefined);
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
	return { calls, activityTokens, fetchPath };
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

test("collectAllStreams: trips emits resumable STATE", async () => {
	const { fetchPath } = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-1" }]) }],
		getTrip: { "trip-1": { body: getTripBody({ status: "COMPLETED" }) } },
	});
	const { ctx, messages } = makeCtx(["trips"]);
	await collectAllStreams(ctx, fetchPath, NO_DELAY);
	assert.equal(
		messages.some((m) => m.type === "STATE"),
		true,
		"trips must persist its head and backfill checkpoint",
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

function backfillCursor(messages: ReturnType<typeof makeCtx>["messages"]) {
	const state = [...messages]
		.reverse()
		.find((message) => message.type === "STATE" && message.stream === "trips");
	assert.ok(state && state.type === "STATE");
	return state.cursor as {
		version: 1;
		scope: string;
		head_trip_id?: string;
		hydrated_trip_ids: string[];
		hydrated_receipt_ids: string[];
		backfill?: {
			scope: string;
			pages: Array<{ next_page_token: string; stop_at_trip_id?: string }>;
			pending_trip_ids: string[];
		};
	};
}

function tripResponses(ids: string[]) {
	return Object.fromEntries(
		ids.map((id) => [
			id,
			{ body: getTripBody({ status: "COMPLETED", fare: "$10.00" }) },
		]),
	);
}

async function detailBudgetRun() {
	const ids = Array.from({ length: 205 }, (_, i) => `trip-${i}`);
	const script = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody(ids.map((uuid) => ({ uuid }))) }],
		getTrip: tripResponses(ids),
	});
	const run = makeCtx(["trips"]);
	await collectAllStreams(run.ctx, script.fetchPath, NO_DELAY);
	return { ...run, ...script, ids, cursor: backfillCursor(run.messages) };
}

test("collectAllStreams: detail budget saves scoped backfill and remains incomplete", async () => {
	const run = await detailBudgetRun();
	assert.equal(run.emitted.length, 200);
	assert.equal(run.cursor.head_trip_id, "trip-0");
	assert.deepEqual(run.cursor.backfill?.pending_trip_ids, run.ids.slice(200));
	assert.equal(run.cursor.backfill?.scope, run.cursor.scope);
	assert.equal(run.cursor.hydrated_trip_ids.length, 200);
	const skip = run.messages.find(
		(message) =>
			message.type === "SKIP_RESULT" &&
			message.reason === "trips_deferred_detail_budget",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.deepEqual(skip.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});
});

test("collectAllStreams: next run hydrates older pending trips and new head without duplicates", async () => {
	const first = await detailBudgetRun();
	const script = makeScriptedFetch({
		activitiesPages: [
			{
				body: activitiesBody(
					[{ uuid: "new-trip" }, { uuid: "trip-0" }],
					"unused-overlap",
				),
			},
		],
		getTrip: tripResponses(["new-trip", ...first.ids]),
	});
	const second = makeCtx(["trips"]);
	second.ctx.state = { trips: first.cursor };
	await collectAllStreams(second.ctx, script.fetchPath, NO_DELAY);
	assert.deepEqual(
		script.calls.filter((call) => call.startsWith("GetTrip:")),
		["new-trip", ...first.ids.slice(200)].map((id) => `GetTrip:${id}`),
	);
	assert.equal(first.emitted.length + second.emitted.length, 206);
	assert.equal(
		new Set(
			[...first.emitted, ...second.emitted].map((record) =>
				JSON.stringify(record.data),
			),
		).size,
		206,
	);
	assert.equal(backfillCursor(second.messages).head_trip_id, "new-trip");
});

test("collectAllStreams: end of history clears backfill and completes the stream", async () => {
	const first = await detailBudgetRun();
	const second = makeCtx(["trips"]);
	second.ctx.state = { trips: first.cursor };
	const script = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-0" }]) }],
		getTrip: tripResponses(first.ids.slice(200)),
	});
	await collectAllStreams(second.ctx, script.fetchPath, NO_DELAY);
	assert.equal(backfillCursor(second.messages).backfill, undefined);
	assert.equal(
		second.messages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);
	assert.equal(second.emitted.length, 5);
});

test("collectAllStreams: changed since, until, or resources ignores saved backfill", async () => {
	const first = await detailBudgetRun();
	for (const changed of [
		{ time_range: { since: "2026-01-01T00:00:00Z" } },
		{ time_range: { until: "2026-11-01T00:00:00Z" } },
		{ resources: ["personal"] },
	]) {
		const run = makeCtx(["trips"]);
		run.ctx.state = {
			trips: {
				...first.cursor,
				backfill: {
					...first.cursor.backfill,
					scope: first.cursor.scope,
					pages: [{ next_page_token: "must-not-resume" }],
					pending_trip_ids: ["must-not-hydrate"],
				},
			},
		};
		run.ctx.requested.set("trips", { name: "trips", ...changed });
		const script = makeScriptedFetch({
			activitiesPages: [{ body: activitiesBody([{ uuid: "trip-0" }]) }],
			getTrip: tripResponses(["trip-0"]),
		});
		await collectAllStreams(run.ctx, script.fetchPath, NO_DELAY);
		assert.deepEqual(script.activityTokens, [undefined]);
		assert.equal(run.emitted.length, 1);
		assert.notEqual(backfillCursor(run.messages).scope, first.cursor.scope);
		assert.equal(backfillCursor(run.messages).backfill, undefined);
	}
});

test("collectAllStreams: full_refresh ignores and replaces the saved position", async () => {
	const first = await detailBudgetRun();
	const run = makeCtx(["trips"]);
	run.ctx.collectionMode = "full_refresh";
	run.ctx.state = {
		trips: {
			...first.cursor,
			backfill: {
				scope: first.cursor.scope,
				pages: [{ next_page_token: "must-not-resume" }],
				pending_trip_ids: ["must-not-hydrate"],
			},
		},
	};
	const script = makeScriptedFetch({
		activitiesPages: [{ body: activitiesBody([{ uuid: "trip-0" }]) }],
		getTrip: tripResponses(["trip-0"]),
	});
	await collectAllStreams(run.ctx, script.fetchPath, NO_DELAY);
	assert.deepEqual(script.activityTokens, [undefined]);
	assert.equal(run.emitted.length, 1);
	assert.equal(backfillCursor(run.messages).backfill, undefined);
	assert.deepEqual(backfillCursor(run.messages).hydrated_trip_ids, ["trip-0"]);
});

test("collectAllStreams: page budget resumes the source cursor after collecting a new head", async () => {
	const ids = Array.from({ length: 200 }, (_, i) => `page-trip-${i}`);
	const first = makeCtx(["trips"]);
	const initial = makeScriptedFetch({
		activitiesPages: ids.map((uuid, i) => ({
			body: activitiesBody([{ uuid }], `page-${i + 1}`),
		})),
		getTrip: tripResponses(ids),
	});
	await collectAllStreams(first.ctx, initial.fetchPath, NO_DELAY);
	const cursor = backfillCursor(first.messages);
	assert.deepEqual(cursor.backfill?.pages, [{ next_page_token: "page-200" }]);
	assert.equal(initial.activityTokens.length, 200);
	const skip = first.messages.find(
		(message) =>
			message.type === "SKIP_RESULT" &&
			message.reason === "trips_deferred_page_budget",
	);
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.deepEqual(skip.recovery_hint, {
		action: "retry_by_runtime",
		retryable: true,
	});
	const second = makeCtx(["trips"]);
	second.ctx.state = { trips: cursor };
	const resumed = makeScriptedFetch({
		activitiesPages: [
			{
				body: activitiesBody(
					[{ uuid: "new-page-trip" }, { uuid: ids[0] }],
					"head-overlap",
				),
			},
			{ body: activitiesBody([{ uuid: "old-page-trip" }]) },
		],
		getTrip: tripResponses(["new-page-trip", "old-page-trip"]),
	});
	await collectAllStreams(second.ctx, resumed.fetchPath, NO_DELAY);
	assert.deepEqual(resumed.activityTokens, [undefined, "page-200"]);
	assert.deepEqual(
		resumed.calls.filter((call) => call.startsWith("GetTrip:")),
		["GetTrip:new-page-trip", "GetTrip:old-page-trip"],
	);
	assert.equal(backfillCursor(second.messages).backfill, undefined);
	assert.equal(
		second.messages.some((message) => message.type === "SKIP_RESULT"),
		false,
	);
});

test("collectAllStreams: base-format empty STATE starts and completes a backfill", async () => {
	for (const state of [{}, { trips: { head_trip_id: "trip-0" } }]) {
		const run = makeCtx(["trips"]);
		run.ctx.state = state;
		const script = makeScriptedFetch({
			activitiesPages: [
				{ body: activitiesBody([{ uuid: "trip-0" }, { uuid: "older" }]) },
			],
			getTrip: tripResponses(["trip-0", "older"]),
		});
		await collectAllStreams(run.ctx, script.fetchPath, NO_DELAY);
		assert.equal(run.emitted.length, 2);
		assert.equal(backfillCursor(run.messages).version, 1);
		assert.equal(backfillCursor(run.messages).backfill, undefined);
	}
});

test("collectAllStreams: rejected saved page cursor fails without restarting history", async () => {
	const first = await detailBudgetRun();
	const run = makeCtx(["trips"]);
	run.ctx.state = {
		trips: {
			...first.cursor,
			backfill: {
				scope: first.cursor.scope,
				pages: [{ next_page_token: "expired-page" }],
				pending_trip_ids: [],
			},
		},
	};
	const script = makeScriptedFetch({
		activitiesPages: [
			{ body: activitiesBody([{ uuid: "trip-0" }], "overlap") },
			{ body: JSON.stringify({ errors: [{ message: "invalid page token" }] }) },
		],
	});
	await assert.rejects(
		collectAllStreams(run.ctx, script.fetchPath, NO_DELAY),
		/uber_activity_resume_failed/,
	);
	assert.deepEqual(script.activityTokens, [undefined, "expired-page"]);
	assert.equal(
		run.messages.some((message) => message.type === "STATE"),
		false,
	);
});

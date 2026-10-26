// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end cursor/emission tests for the browser-session collect() layer
 * (`collectTransactions`, `collectAllStreams`), driven through a scripted
 * `VenmoPageFetch` (no real browser, no real network — see
 * src/auto-login/venmo.test.ts for the session-establishment tests and
 * parsers.test.ts / schemas.test.ts for pure-function coverage).
 *
 * `VenmoPageFetch` is the seam this redesign introduced: every JSON read
 * goes through `page.evaluate(fetch)` under the live session cookie, never
 * a raw `fetch()` with an Authorization header or device-id. These tests
 * assert the seam is honored (fetchPath is the only I/O boundary
 * collectTransactions/collectAllStreams touch) and that honest coverage
 * (considered/covered) survives a schema-invalid record.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	makeRecordingEmit,
	skipPoliteDelays,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	collectTransactions,
	establishVenmoCollectOrigin,
	fetchAllFriends,
	MAX_FRIENDS_PAGES,
	MAX_TRANSACTION_PAGES,
	VENMO_RETRYABLE_PATTERN,
	type VenmoPageFetch,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Pacing pauses are anti-bot courtesy that these tests do not assert on, so
// they fire on the next tick instead of sleeping.
after(skipPoliteDelays());

const OWNER_ID = "1111111111111111111";
const EMITTED_AT = "2026-08-10T00:00:00.000Z";
/** Skips the real 500ms PAGE_DELAY_MS pacing in tests that need a multi-page result but aren't testing pacing itself. */
const NO_DELAY = (): Promise<void> => Promise.resolve();

/** Story `id` must be numeric; payment ids may be alphanumeric (see schemas.ts). */
function story(id: string, dateCreated: string, amount = 10) {
	return {
		id,
		date_created: dateCreated,
		payment: {
			id: `9${id}`,
			action: "pay",
			actor: { id: OWNER_ID, username: "owner", display_name: "Owner" },
			target: {
				user: {
					id: "2222222222222222222",
					username: "friend",
					display_name: "Friend",
				},
			},
			amount,
			status: "settled",
		},
	};
}

function accountUser() {
	return {
		id: OWNER_ID,
		username: "owner",
		display_name: "Owner",
		date_joined: "2020-01-01T00:00:00Z",
	};
}

/** Script one JSON response (or an HTTP status) per matched endpoint. Each call to the same endpoint advances through its list. */
function makeScriptedFetch(
	script: Record<string, Array<{ body: unknown; status?: number }>>,
): {
	calls: string[];
	fetchPath: VenmoPageFetch;
} {
	const calls: string[] = [];
	const cursors: Record<string, number> = {};
	const fetchPath: VenmoPageFetch = (path, query) => {
		const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
		calls.push(path + qs);
		const responses = script[path];
		if (!responses) {
			throw new Error(`no scripted response for ${path}`);
		}
		const i = cursors[path] ?? 0;
		const r = responses[Math.min(i, responses.length - 1)];
		cursors[path] = i + 1;
		if (!r) {
			throw new Error(`scripted response undefined at ${path}#${i}`);
		}
		return Promise.resolve({
			status: r.status ?? 200,
			body: JSON.stringify(r.body),
		});
	};
	return { calls, fetchPath };
}

/**
 * A fake `/stories/target-or-actor/{id}` backend implementing REAL Venmo
 * `before_id` semantics: `history` is newest-first (as Venmo returns it),
 * and a `before_id` query param returns the slice strictly after (i.e.
 * older than) that id in `history` — never re-serving it or anything newer.
 * Unlike `makeScriptedFetch`'s hand-scripted per-call arrays, this lets a
 * cursor from one call correctly resume mid-history in a later call, which
 * is what a two-run oracle needs to be honest about what `before_id`
 * actually does.
 */
function makeStatefulVenmoFetch(history: ReturnType<typeof story>[]): {
	calls: string[];
	fetchPath: VenmoPageFetch;
} {
	const calls: string[] = [];
	const fetchPath: VenmoPageFetch = (path, query) => {
		const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
		calls.push(path + qs);
		const beforeId = query?.before_id;
		const limit = Number(query?.limit ?? String(history.length));
		const startIndex = beforeId
			? history.findIndex((s) => s.id === beforeId) + 1
			: 0;
		const page =
			beforeId && startIndex === 0
				? []
				: history.slice(startIndex, startIndex + limit);
		return Promise.resolve({
			status: 200,
			body: JSON.stringify({ data: page }),
		});
	};
	return { calls, fetchPath };
}

function nth<T>(items: readonly T[], index: number): T {
	const item = items[index];
	assert.ok(item !== undefined, `expected an item at index ${index}`);
	return item;
}

function makeCtx(
	priorState: Record<string, unknown>,
	requestedStreams: string[],
): {
	ctx: BrowserCollectContext;
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	messages: ReturnType<typeof makeRecordingEmit>["protocolMessages"];
	skipped: ReturnType<typeof makeRecordingEmit>["skipped"];
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
		reportStreamFailure: (stream: string, message: string) => {
			harness.emit({
				type: "SKIP_RESULT",
				stream,
				reason: "stream_collection_failed",
				message,
			});
			return Promise.resolve();
		},
		requested,
		scope: { streams: [] },
		sendInteraction: () => Promise.reject(new Error("not used")),
		state: priorState,
	} as BrowserCollectContext;
	return {
		ctx,
		emitted: harness.emitted,
		messages: harness.protocolMessages,
		skipped: harness.skipped,
	};
}

// ─── collectTransactions: pagination, cursor, coverage ─────────────────────

test("collectTransactions: a partial page emits every modeled record and clears the cursor", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{
				body: {
					data: [
						story("4001", "2026-07-01T00:00:00Z"),
						story("4002", "2026-07-02T00:00:00Z"),
					],
				},
			},
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted } = makeCtx({}, ["transactions"]);
	const result = await collectTransactions(ctx, fetchPath, OWNER_ID);
	assert.equal(emitted.length, 2);
	assert.equal(result.considered, 2);
	assert.equal(result.covered, 2);
	assert.equal(
		result.latestSeenAt,
		"2026-07-02T00:00:00Z",
		"latest date_created across the page wins",
	);
});

test("collectTransactions emits zone-less dates and stores a normalized latest cursor", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [story("4003", "2026-07-02T00:00:00.123456")] } },
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted, messages } = makeCtx({}, ["transactions"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser(), NO_DELAY);
	assert.equal(emitted.length, 1);
	const state = messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.deepEqual(state.cursor, {
		last_seen_date_created: "2026-07-02T00:00:00.123456Z",
	});
});

test("collectTransactions chooses the latest instant across fractional precisions and pages", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{
				body: {
					data: [
						story("4010", "2026-07-02T00:00:00Z"),
						story("4011", "2026-07-02T00:00:00.1Z"),
					],
				},
			},
			{ body: { data: [story("4012", "2026-07-02T00:00:00.12Z")] } },
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted, messages } = makeCtx({}, ["transactions"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser(), NO_DELAY);
	assert.deepEqual(
		emitted.map((entry) => entry.data.date_created),
		[
			"2026-07-02T00:00:00Z",
			"2026-07-02T00:00:00.1Z",
			"2026-07-02T00:00:00.12Z",
		],
	);
	const state = messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.deepEqual(state.cursor, {
		last_seen_date_created: "2026-07-02T00:00:00.12Z",
	});

	const fractionOnly = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{
				body: {
					data: [
						story("4013", "2026-07-02T00:00:00.1Z"),
						story("4014", "2026-07-02T00:00:00.12Z"),
					],
				},
			},
			{ body: { data: [] } },
		],
	});
	const fractionResult = await collectTransactions(
		makeCtx({}, ["transactions"]).ctx,
		fractionOnly.fetchPath,
		OWNER_ID,
		NO_DELAY,
	);
	assert.equal(fractionResult.latestSeenAt, "2026-07-02T00:00:00.12Z");
});

test("collectTransactions: a short non-empty page does not terminate the walk", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [story("4101", "2026-07-01T00:00:00Z")] } },
			{ body: { data: [story("4102", "2026-06-01T00:00:00Z")] } },
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted } = makeCtx({}, ["transactions"]);

	const result = await collectTransactions(ctx, fetchPath, OWNER_ID, NO_DELAY);

	assert.equal(result.considered, 2, "both non-empty pages must be enumerated");
	assert.equal(emitted.length, 2, "both pages must emit their modeled records");
	assert.equal(
		calls.length,
		3,
		"the walk must continue until the provider returns an empty page",
	);
});

test("collectTransactions: an empty first page stops immediately with zero records", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [{ body: { data: [] } }],
	});
	const { ctx, emitted } = makeCtx({}, ["transactions"]);
	const result = await collectTransactions(ctx, fetchPath, OWNER_ID);
	assert.equal(emitted.length, 0);
	assert.equal(result.considered, 0);
	assert.equal(result.covered, 0);
	assert.equal(result.latestSeenAt, null);
});

test("schema-rejected transactions do not increase coverage or set the latest date", async () => {
	const invalid = story("4801", "2026-07-03T00:00:00Z");
	invalid.payment.actor.id = "invalid-user-id";
	const valid = story("4802", "2026-07-02T00:00:00Z");
	const { fetchPath } = makeScriptedFetch({
		[`/stories/target-or-actor/${OWNER_ID}`]: [
			{ body: { data: [invalid, valid] } },
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted, skipped, messages } = makeCtx({}, ["transactions"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser(), NO_DELAY);
	assert.equal(skipped.length, 1);
	assert.deepEqual(
		emitted.map((entry) => entry.data.id),
		[valid.id],
	);
	const coverage = messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "transactions",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 1);
	const state = messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.deepEqual(state.cursor, {
		last_seen_date_created: valid.date_created,
	});
});

test("unselected transactions do not count or block older history", async () => {
	const unselectedInvalid = story("4810", "2026-07-03T00:00:00Z");
	unselectedInvalid.payment.actor.id = "invalid-user-id";
	const unselectedValid = story("4811", "2026-07-04T00:00:00Z");
	const selected = story("4812", "2026-07-02T00:00:00Z");
	const { fetchPath } = makeScriptedFetch({
		[`/stories/target-or-actor/${OWNER_ID}`]: [
			{ body: { data: [unselectedInvalid, unselectedValid, selected] } },
			{ body: { data: [] } },
		],
	});
	const { ctx } = makeCtx({}, ["transactions"]);
	ctx.isRecordSelected = (_stream, record) => record.id === selected.id;
	const result = await collectTransactions(ctx, fetchPath, OWNER_ID, NO_DELAY);
	assert.equal(result.covered, 1);
	assert.equal(result.latestSeenAt, selected.date_created);
	assert.equal(result.blockedByRejected, false);
});

test("schema-rejected friends do not enter the fingerprint checkpoint", async () => {
	const { fetchPath } = makeScriptedFetch({
		[`/users/${OWNER_ID}/friends`]: [
			{
				body: {
					data: [
						{ id: "5101", profile_picture_url: "not-a-url" },
						{ id: "5102", username: "valid", display_name: "Valid" },
					],
				},
			},
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted, skipped, messages } = makeCtx({}, ["friends"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser(), NO_DELAY);
	assert.equal(skipped.length, 1);
	assert.deepEqual(
		emitted.map((entry) => entry.data.id),
		["5102"],
	);
	const coverage = messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "friends",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 1);
	const state = messages.find(
		(message) => message.type === "STATE" && message.stream === "friends",
	);
	assert.ok(state && state.type === "STATE");
	assert.deepEqual(
		Object.keys((state.cursor as { fingerprints: object }).fingerprints),
		["5102"],
	);
});

test("schema-rejected profile does not replace its prior fingerprint checkpoint", async () => {
	const invalidAccount = { ...accountUser(), profile_picture_url: "not-a-url" };
	const fetchPath = makeScriptedFetch({});
	const { ctx, skipped, messages } = makeCtx(
		{ profile: { fingerprints: { prior: "fingerprint" } } },
		["profile"],
	);
	await collectAllStreams(
		ctx,
		fetchPath.fetchPath,
		OWNER_ID,
		invalidAccount,
		NO_DELAY,
	);
	assert.equal(skipped.length, 1);
	assert.equal(
		messages.filter((message) => message.type === "STATE").length,
		0,
	);
	const coverage = messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "profile",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 1);
	assert.equal(coverage.covered, 0);
});

test("malformed 200 inventory envelopes fail before replacing prior state", async () => {
	await Promise.all(
		[{}, { data: null }, { data: {} }, { data: [null] }].map(async (body) => {
			const friendsFetch = makeScriptedFetch({
				[`/users/${OWNER_ID}/friends`]: [{ body }],
			});
			const friends = makeCtx(
				{ friends: { fingerprints: { prior: "fingerprint" } } },
				["friends"],
			);
			await assert.rejects(
				collectAllStreams(
					friends.ctx,
					friendsFetch.fetchPath,
					OWNER_ID,
					accountUser(),
					NO_DELAY,
				),
				/venmo_invalid_response/,
			);
			assert.equal(
				friends.messages.filter((message) => message.type === "STATE").length,
				0,
			);

			const transactionsFetch = makeScriptedFetch({
				[`/stories/target-or-actor/${OWNER_ID}`]: [{ body }],
			});
			const transactions = makeCtx(
				{ transactions: { last_seen_date_created: "2026-01-01T00:00:00Z" } },
				["transactions"],
			);
			await assert.rejects(
				collectAllStreams(
					transactions.ctx,
					transactionsFetch.fetchPath,
					OWNER_ID,
					accountUser(),
					NO_DELAY,
				),
				/venmo_invalid_response/,
			);
			assert.equal(
				transactions.messages.filter((message) => message.type === "STATE")
					.length,
				0,
			);
		}),
	);
});

test("an empty data array remains a genuine exhausted inventory", async () => {
	const fetchPath = makeScriptedFetch({
		[`/users/${OWNER_ID}/friends`]: [{ body: { data: [] } }],
		[`/stories/target-or-actor/${OWNER_ID}`]: [{ body: { data: [] } }],
	});
	const { ctx, messages } = makeCtx({}, ["friends", "transactions"]);
	await collectAllStreams(
		ctx,
		fetchPath.fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.equal(
		messages.filter((message) => message.type === "STATE").length,
		2,
	);
});

test("a malformed account envelope fails without replacing profile state", async () => {
	const fetchPath = makeScriptedFetch({
		"/account": [{ body: { data: null } }],
	});
	const { ctx, messages } = makeCtx(
		{ profile: { fingerprints: { prior: "fingerprint" } } },
		["profile"],
	);
	await assert.rejects(
		collectAllStreams(ctx, fetchPath.fetchPath, OWNER_ID, null, NO_DELAY),
		/venmo_invalid_response/,
	);
	assert.equal(
		messages.filter((message) => message.type === "STATE").length,
		0,
	);
});

test("a non-empty page without a final story id fails instead of claiming exhaustion", async () => {
	const fetchPath = makeScriptedFetch({
		[`/stories/target-or-actor/${OWNER_ID}`]: [
			{
				body: {
					data: [story("4901", "2026-07-02T00:00:00Z"), { payment: null }],
				},
			},
		],
	});
	const { ctx, messages } = makeCtx({}, ["transactions"]);
	await assert.rejects(
		collectAllStreams(
			ctx,
			fetchPath.fetchPath,
			OWNER_ID,
			accountUser(),
			NO_DELAY,
		),
		/venmo_pagination_stalled/,
	);
	assert.equal(
		messages.filter((message) => message.type === "STATE").length,
		0,
	);
});

test("a repeated before_id fails after the second page", async () => {
	const fetchPath = makeScriptedFetch({
		[`/stories/target-or-actor/${OWNER_ID}`]: [
			{ body: { data: [story("4902", "2026-07-02T00:00:00Z")] } },
			{ body: { data: [story("4902", "2026-07-02T00:00:00Z")] } },
		],
	});
	const { ctx, messages } = makeCtx({}, ["transactions"]);
	await assert.rejects(
		collectAllStreams(
			ctx,
			fetchPath.fetchPath,
			OWNER_ID,
			accountUser(),
			NO_DELAY,
		),
		/venmo_pagination_stalled/,
	);
	assert.equal(fetchPath.calls.length, 2);
	assert.equal(
		messages.filter((message) => message.type === "STATE").length,
		0,
	);
});

test("a capped run saves an older-history position while the next run refreshes the head", async () => {
	const pageSize = 50;
	const history = Array.from(
		{ length: MAX_TRANSACTION_PAGES * pageSize + pageSize },
		(_, index) => story(String(100_000 + index), "2026-01-01T00:00:00Z"),
	).reverse();
	const firstFetch = makeStatefulVenmoFetch(history);
	const first = makeCtx({}, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		firstFetch.fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.equal(firstFetch.calls.length, MAX_TRANSACTION_PAGES);
	const firstState = first.messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(firstState && firstState.type === "STATE");
	const firstCursor = firstState.cursor as Record<string, unknown>;
	assert.equal(typeof firstCursor.backfill_before_id, "string");
	assert.equal(typeof firstCursor.head_anchor_id, "string");

	const newHead = story("900000", "2026-02-01T00:00:00Z");
	const secondFetch = makeStatefulVenmoFetch([newHead, ...history]);
	const second = makeCtx({ transactions: firstCursor }, ["transactions"]);
	await collectAllStreams(
		second.ctx,
		secondFetch.fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.ok(!secondFetch.calls[0]?.includes("before_id"));
	assert.ok(
		secondFetch.calls.some((call) =>
			call.includes(`before_id=${firstCursor.backfill_before_id}`),
		),
		"the second run must resume the unread older tail",
	);
	const secondIds = new Set(second.emitted.map((entry) => entry.data.id));
	assert.ok(secondIds.has(newHead.id));
	assert.ok(secondIds.has(history.at(-1)?.id));
	assert.ok(secondFetch.calls.length <= MAX_TRANSACTION_PAGES);
});

test("a capped head refresh saves a gap while advancing the old tail", async () => {
	const burst = Array.from({ length: 500 * 50 }, (_, index) =>
		story(String(90_000 - index), "2026-07-02T00:00:00Z"),
	);
	const { fetchPath, calls } = makeStatefulVenmoFetch([
		...burst,
		story("2000", "2026-07-01T00:00:00Z"),
		story("1000", "2026-06-01T00:00:00Z"),
		story("999", "2026-05-01T00:00:00Z"),
	]);
	const priorCursor = {
		backfill_before_id: "1000",
		head_anchor_id: "2000",
		last_seen_date_created: "2026-07-01T00:00:00Z",
	};
	const { ctx } = makeCtx({ transactions: priorCursor }, ["transactions"]);
	const result = await collectTransactions(ctx, fetchPath, OWNER_ID, NO_DELAY);
	assert.equal(result.truncated, true);
	assert.equal(result.backfillBeforeId, null);
	assert.equal(result.headAnchorId, burst[0]?.id);
	assert.equal(result.headGaps.length, 1);
	assert.equal(result.headGaps[0]?.end_id, priorCursor.head_anchor_id);
	assert.ok(calls.some((call) => call.includes("before_id=1000")));
	assert.ok(calls.length <= MAX_TRANSACTION_PAGES);
});

test("a burst beyond the head budget eventually fills the head gap and old tail", async () => {
	const pageSize = 50;
	const original = Array.from(
		{ length: MAX_TRANSACTION_PAGES * pageSize + pageSize },
		(_, i) => story(String(100_000 + i), "2026-01-01T00:00:00Z"),
	).reverse();
	const burst = Array.from(
		{ length: MAX_TRANSACTION_PAGES * pageSize + pageSize },
		(_, i) => story(String(200_000 + i), "2026-02-01T00:00:00Z"),
	).reverse();
	let cursor: Record<string, unknown> = {};
	const collected = new Set<string>();
	const snapshots = new Map<string, string>();
	const history = [...burst, ...original];
	for (let run = 0; run < 5; run += 1) {
		const backend = makeStatefulVenmoFetch(run === 0 ? original : history);
		const result = makeCtx({ transactions: cursor }, ["transactions"]);
		await collectAllStreams(
			result.ctx,
			backend.fetchPath,
			OWNER_ID,
			accountUser(),
			NO_DELAY,
		);
		assert.ok(backend.calls.length <= MAX_TRANSACTION_PAGES);
		const ids = result.emitted.map((entry) => entry.data.id as string);
		assert.equal(
			new Set(ids).size,
			ids.length,
			`run ${run + 1} emitted duplicates`,
		);
		for (const entry of result.emitted) {
			const id = String(entry.data.id);
			const snapshot = JSON.stringify(entry.data);
			assert.notEqual(
				snapshots.get(id),
				snapshot,
				`run ${run + 1} re-emitted unchanged ${id}`,
			);
			snapshots.set(id, snapshot);
			collected.add(id);
		}
		const state = result.messages.find(
			(message) =>
				message.type === "STATE" && message.stream === "transactions",
		);
		assert.ok(state && state.type === "STATE");
		cursor = state.cursor as Record<string, unknown>;
		if (run >= 2 && !cursor.backfill_before_id && !cursor.head_gaps) break;
	}
	assert.equal(collected.size, history.length, "frozen history must converge");
	assert.equal(cursor.backfill_before_id, undefined);
	assert.equal(cursor.head_gaps, undefined);
	assert.ok(collected.has(original.at(-1)?.id ?? ""), "old tail was collected");
	assert.ok(collected.has(burst.at(-1)?.id ?? ""), "head gap was collected");
});

test("a second burst preserves the first head gap's continuation", async () => {
	const original = Array.from(
		{ length: MAX_TRANSACTION_PAGES * 50 + 50 },
		(_, i) => story(String(100_000 + i), "2026-01-01T00:00:00Z"),
	).reverse();
	const burst = (start: number, pages: number) =>
		Array.from({ length: pages * 50 }, (_, i) =>
			story(String(start + i), "2026-02-01T00:00:00Z"),
		).reverse();
	const firstBurst = burst(200_000, 800);
	const secondBurst = burst(300_000, 600);
	const thirdBurst = burst(400_000, 1);
	let cursor: Record<string, unknown> = {};
	const collected = new Set<string>();
	for (let run = 0; run < 7; run += 1) {
		const history =
			run === 0
				? original
				: run === 1
					? [...firstBurst, ...original]
					: run === 2
						? [...secondBurst, ...firstBurst, ...original]
						: [...thirdBurst, ...secondBurst, ...firstBurst, ...original];
		const backend = makeStatefulVenmoFetch(history);
		const result = makeCtx({ transactions: cursor }, ["transactions"]);
		await collectAllStreams(
			result.ctx,
			backend.fetchPath,
			OWNER_ID,
			accountUser(),
			NO_DELAY,
		);
		assert.ok(backend.calls.length <= MAX_TRANSACTION_PAGES);
		const ids = result.emitted.map((entry) => entry.data.id as string);
		assert.equal(
			new Set(ids).size,
			ids.length,
			`run ${run + 1} emitted duplicates`,
		);
		for (const id of ids) {
			assert.ok(!collected.has(id), `run ${run + 1} re-emitted ${id}`);
			collected.add(id);
		}
		const state = result.messages.find(
			(message) =>
				message.type === "STATE" && message.stream === "transactions",
		);
		assert.ok(state && state.type === "STATE");
		cursor = state.cursor as Record<string, unknown>;
		assert.ok(!Array.isArray(cursor.head_gaps) || cursor.head_gaps.length <= 4);
		if (run === 2) {
			assert.ok(Array.isArray(cursor.head_gaps));
			assert.equal(cursor.head_gaps.length, 2);
			assert.ok(
				result.messages.some(
					(message) =>
						message.type === "SKIP_RESULT" &&
						message.reason === "stream_collection_failed",
				),
			);
		}
		if (run === 3) {
			assert.ok(Array.isArray(cursor.head_gaps));
			assert.equal(cursor.head_gaps[0]?.start_id, thirdBurst[0]?.id);
		}
		if (run >= 3 && !cursor.backfill_before_id && !cursor.head_gaps) break;
	}
	assert.equal(
		collected.size,
		original.length +
			firstBurst.length +
			secondBurst.length +
			thirdBurst.length,
	);
	assert.equal(cursor.backfill_before_id, undefined);
	assert.equal(cursor.head_gaps, undefined);
});

test("a fresh collection retries a malformed supported payment behind the head", async () => {
	const head = Array.from({ length: 50 }, (_, i) =>
		story(String(7000 + i), "2026-07-02T00:00:00Z"),
	).reverse();
	const malformed = story("6000", "2026-07-01T00:00:00Z");
	delete (malformed as { date_created?: string }).date_created;
	const tail = story("5999", "2026-06-30T00:00:00Z");
	const first = makeCtx({}, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		makeStatefulVenmoFetch([...head, malformed, tail]).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	const state = first.messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.equal(
		(state.cursor as Record<string, unknown>).head_anchor_id,
		head[0]?.id,
	);
	assert.equal(
		(state.cursor as Record<string, unknown>).backfill_before_id,
		head.at(-1)?.id,
	);
	const second = makeCtx(
		{ transactions: state.cursor as Record<string, unknown> },
		["transactions"],
	);
	await collectAllStreams(
		second.ctx,
		makeStatefulVenmoFetch([
			...head,
			story("6000", "2026-07-01T00:00:00Z"),
			tail,
		]).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.ok(second.emitted.some((entry) => entry.data.id === "6000"));
});

test("a malformed supported payment is retried after its date is corrected", async () => {
	const head = Array.from({ length: 50 }, (_, i) =>
		story(String(7000 + i), "2026-07-02T00:00:00Z"),
	).reverse();
	const malformed = story("6000", "2026-07-01T00:00:00Z");
	delete (malformed as { date_created?: string }).date_created;
	const tail = story("5999", "2026-06-30T00:00:00Z");
	const priorCursor = {
		backfill_before_id: head.at(-1)?.id,
		head_anchor_id: head[0]?.id,
	};
	const first = makeCtx({ transactions: priorCursor }, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		makeStatefulVenmoFetch([...head, malformed, tail]).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	const firstState = first.messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(firstState && firstState.type === "STATE");
	assert.ok(
		first.messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "stream_collection_failed",
		),
	);
	assert.equal(
		(firstState.cursor as Record<string, unknown>).backfill_before_id,
		priorCursor.backfill_before_id,
	);
	const corrected = story("6000", "2026-07-01T00:00:00Z");
	const second = makeCtx(
		{ transactions: firstState.cursor as Record<string, unknown> },
		["transactions"],
	);
	await collectAllStreams(
		second.ctx,
		makeStatefulVenmoFetch([...head, corrected, tail]).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.ok(second.emitted.some((entry) => entry.data.id === corrected.id));
});

test("a supported payment missing its story id keeps the prior backfill checkpoint", async () => {
	const head = [story("7000", "2026-07-02T00:00:00Z")];
	const malformed = story("6000", "2026-07-01T00:00:00Z");
	delete (malformed as { id?: string }).id;
	const priorCursor = { backfill_before_id: "7000", head_anchor_id: "7000" };
	const first = makeCtx({ transactions: priorCursor }, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		makeStatefulVenmoFetch([...head, malformed]).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	const state = first.messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.equal(
		(state.cursor as Record<string, unknown>).backfill_before_id,
		"7000",
	);
	assert.ok(
		first.messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "stream_collection_failed" &&
				message.message.includes("missing story id"),
		),
	);
	const second = makeCtx(
		{ transactions: state.cursor as Record<string, unknown> },
		["transactions"],
	);
	await collectAllStreams(
		second.ctx,
		makeStatefulVenmoFetch([...head, story("6000", "2026-07-01T00:00:00Z")])
			.fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.ok(second.emitted.some((entry) => entry.data.id === "6000"));
});

test("a rejected backfill record keeps its position for a later retry", async () => {
	const head = Array.from({ length: 50 }, (_, index) =>
		story(String(7000 + index), "2026-07-02T00:00:00Z"),
	).reverse();
	const invalid = story("6000", "2026-07-01T00:00:00Z");
	invalid.payment.actor.id = "invalid-user-id";
	const tail = story("5999", "2026-06-30T00:00:00Z");
	const backfillBeforeId = head.at(-1)?.id;
	const headAnchorId = head[0]?.id;
	assert.ok(backfillBeforeId && headAnchorId);
	const priorCursor = {
		backfill_before_id: backfillBeforeId,
		head_anchor_id: headAnchorId,
		last_seen_date_created: "2026-07-02T00:00:00Z",
	};
	const firstFetch = makeStatefulVenmoFetch([...head, invalid, tail]);
	const first = makeCtx({ transactions: priorCursor }, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		firstFetch.fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	const firstState = first.messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(firstState && firstState.type === "STATE");
	assert.equal(
		(firstState.cursor as Record<string, unknown>).backfill_before_id,
		backfillBeforeId,
	);
	assert.equal(first.skipped.length, 1);
	assert.ok(
		first.messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "stream_collection_failed",
		),
	);

	const corrected = story("6000", "2026-07-01T00:00:00Z");
	const secondFetch = makeStatefulVenmoFetch([...head, corrected, tail]);
	const second = makeCtx(
		{ transactions: firstState.cursor as Record<string, unknown> },
		["transactions"],
	);
	await collectAllStreams(
		second.ctx,
		secondFetch.fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.ok(second.emitted.some((entry) => entry.data.id === corrected.id));
	const secondState = second.messages.find(
		(message) => message.type === "STATE" && message.stream === "transactions",
	);
	assert.ok(secondState && secondState.type === "STATE");
	assert.ok(
		!("backfill_before_id" in (secondState.cursor as Record<string, unknown>)),
	);
});

test("friends page-budget message discloses the recurring capped window", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	) as { reason_display_messages: Record<string, string> };
	const message = manifest.reason_display_messages.friends_deferred_page_budget;
	assert.ok(message);
	assert.match(message, /older friends may remain uncollected/i);
	assert.doesNotMatch(message, /next run picks up where this one stopped/i);
});

// Legacy bare `before_id` state must not bypass the head refresh. The
// resumable `backfill_before_id` is a separate position reached only after
// reading from the head on this run.
test("collectTransactions: legacy STATE.before_id is ignored at the head", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [story("5001", "2026-04-01T00:00:00Z")] } },
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted } = makeCtx(
		{ transactions: { before_id: "stale-cursor-from-a-prior-run" } },
		["transactions"],
	);
	await collectTransactions(ctx, fetchPath, OWNER_ID);
	assert.ok(
		!calls[0]?.includes("before_id"),
		"the first request of a run must never carry a cursor from a previous run",
	);
	assert.equal(emitted.length, 1);
});

test("collectAllStreams: an exhausted walk omits the legacy before_id and backfill position", async () => {
	const TRANSACTIONS_PAGE_SIZE = 50;
	const fullPage = Array.from({ length: TRANSACTIONS_PAGE_SIZE }, (_, i) =>
		story(String(7000 + i), "2026-01-01T00:00:00Z"),
	);
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: fullPage } },
			{ body: { data: [] } },
		],
	});
	const { ctx, messages } = makeCtx({}, ["transactions"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
	const state = messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.ok(
		!("before_id" in (state.cursor as Record<string, unknown>)),
		"STATE must not persist a legacy before_id cursor",
	);
	assert.ok(
		!("backfill_before_id" in (state.cursor as Record<string, unknown>)),
	);
	assert.equal(
		(state.cursor as { last_seen_date_created?: string | null })
			.last_seen_date_created,
		"2026-01-01T00:00:00Z",
	);
});

// The decisive regression case: history that is an exact multiple of the
// page size (50, 100, ...) exhausts via the *empty-page* exit, not the
// partial-page exit. The pre-fix code only reset the cursor on the
// partial-page exit, so it persisted a dead `before_id` here and run 2
// resumed past every new head transaction, forever.
//
// This must be a discriminating oracle, not just a rerun of run1's script:
// run against `makeStatefulVenmoFetch`, which implements real `before_id`
// semantics over one canonical newest-first history, and thread run1's
// *actual emitted* STATE message into run2's ctx.state, exactly as the
// runtime replays STATE across runs. A version that hand-scripts run2's
// responses independently of run1 can't tell the fixed code from the bug —
// it passes either way.
test("collectTransactions: two runs over exact-multiple-of-50 history — run2 sees new head transactions after run1 exhausts", async () => {
	const PAGE_SIZE = 50;
	const run1History = Array.from({ length: PAGE_SIZE }, (_, i) =>
		story(String(1000 + i), "2026-01-01T00:00:00Z"),
	).reverse(); // newest-first, matching real Venmo ordering
	const newHeadItems = Array.from({ length: 5 }, (_, i) =>
		story(String(9000 + i), "2026-02-01T00:00:00Z"),
	).reverse();

	// Run 1: exactly one full page of the exact-multiple-of-50 history, then
	// exhausted via the empty-page exit (not the partial-page exit).
	const run1Fetch = makeStatefulVenmoFetch(run1History);
	const ctx1 = makeCtx({}, ["transactions"]);
	await collectAllStreams(
		ctx1.ctx,
		run1Fetch.fetchPath,
		OWNER_ID,
		accountUser(),
	);
	assert.equal(
		ctx1.emitted.length,
		PAGE_SIZE,
		"run1 collects the full 50-item history",
	);

	const run1State = ctx1.messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(
		run1State && run1State.type === "STATE",
		"run1 must emit a transactions STATE message",
	);

	// Run 2: thread run1's *actual emitted* STATE into ctx.state, exactly as
	// the runtime replays it. 5 new transactions have landed at the head
	// since run1 (newest-first, so they now lead the canonical history).
	const run2History = [...newHeadItems, ...run1History];
	const run2Fetch = makeStatefulVenmoFetch(run2History);
	const ctx2 = makeCtx(
		{ transactions: run1State.cursor as Record<string, unknown> },
		["transactions"],
	);
	await collectAllStreams(
		ctx2.ctx,
		run2Fetch.fetchPath,
		OWNER_ID,
		accountUser(),
	);

	assert.ok(
		!run2Fetch.calls[0]?.includes("before_id"),
		"run2 must start at the head, not resume from run1's stale before_id",
	);
	const seenIds = new Set(ctx2.emitted.map((r) => r.data.id));
	const sawAllNewHeadItems = newHeadItems.every((s) => seenIds.has(s.id));
	assert.ok(
		sawAllNewHeadItems,
		"run2 must retain every new head transaction created after run1",
	);
	assert.equal(
		seenIds.size,
		run2History.length,
		"run2 re-walks and retains the full history, old and new",
	);
});

// A capped walk may save a separate backfill position, but a legacy bare
// before_id still cannot redirect the next run away from the head.
test("collectTransactions: a capped walk still ignores a legacy before_id", async () => {
	const PAGE_SIZE = 50;
	const fullPage = (offset: number) =>
		Array.from({ length: PAGE_SIZE }, (_, i) =>
			story(String(offset + i), "2026-01-01T00:00:00Z"),
		);
	const script: Record<string, Array<{ body: unknown }>> = {
		"/stories/target-or-actor/1111111111111111111": Array.from(
			{ length: MAX_TRANSACTION_PAGES },
			(_, page) => ({
				body: { data: fullPage(page * PAGE_SIZE) },
			}),
		),
	};
	const { fetchPath: fetchPath1, calls } = makeScriptedFetch(script);
	const ctx1 = makeCtx({}, ["transactions"]);
	const result1 = await collectTransactions(
		ctx1.ctx,
		fetchPath1,
		OWNER_ID,
		NO_DELAY,
	);
	assert.equal(
		result1.considered,
		PAGE_SIZE * MAX_TRANSACTION_PAGES + 1,
		"the run marks the unread page at the cap",
	);
	assert.equal(
		calls.length,
		MAX_TRANSACTION_PAGES,
		"the loop stops exactly at the page cap, not beyond",
	);

	const { fetchPath: fetchPath2, calls: calls2 } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [story("head-1", "2026-03-01T00:00:00Z")] } },
		],
	});
	const ctx2 = makeCtx(
		{ transactions: { before_id: "should-never-be-read" } },
		["transactions"],
	);
	await collectTransactions(ctx2.ctx, fetchPath2, OWNER_ID, NO_DELAY);
	assert.ok(
		!calls2[0]?.includes("before_id"),
		"a legacy cursor must not redirect the next run",
	);
});

test("collectTransactions: a page-cap-truncated walk counts its unread remainder as uncovered", async () => {
	const PAGE_SIZE = 50;
	const MAX_PAGES = 400;
	const fullPage = (offset: number) =>
		Array.from({ length: PAGE_SIZE }, (_, i) =>
			story(String(20_000 + offset + i), "2026-01-01T00:00:00Z"),
		);
	const script: Record<string, Array<{ body: unknown }>> = {
		"/stories/target-or-actor/1111111111111111111": Array.from(
			{ length: MAX_PAGES },
			(_, page) => ({
				body: { data: fullPage(page * PAGE_SIZE) },
			}),
		),
	};
	const { fetchPath } = makeScriptedFetch(script);
	const { ctx } = makeCtx({}, ["transactions"]);

	const result = await collectTransactions(ctx, fetchPath, OWNER_ID, NO_DELAY);

	assert.equal(
		result.considered,
		MAX_PAGES * PAGE_SIZE + 1,
		"one unread page marker must be counted",
	);
	assert.equal(
		result.covered,
		MAX_PAGES * PAGE_SIZE,
		"the unread remainder must not be covered",
	);
});

// ─── Page pacing (F10) ──────────────────────────────────────────────────────

test("collectTransactions: paces between pages via the injected delay, not a bare back-to-back loop", async () => {
	const TRANSACTIONS_PAGE_SIZE = 50;
	const page1 = Array.from({ length: TRANSACTIONS_PAGE_SIZE }, (_, i) =>
		story(String(1000 + i), "2026-01-01T00:00:00Z"),
	);
	const page2 = [story("2000", "2026-01-02T00:00:00Z")];
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: page1 } },
			{ body: { data: page2 } },
			{ body: { data: [] } },
		],
	});
	const { ctx } = makeCtx({}, ["transactions"]);
	const delays: number[] = [];
	const recordingDelay = (ms: number): Promise<void> => {
		delays.push(ms);
		return Promise.resolve();
	};
	await collectTransactions(ctx, fetchPath, OWNER_ID, recordingDelay);
	assert.deepEqual(
		delays,
		[500, 500],
		"both non-empty page transitions must be paced",
	);
});

test("collectTransactions: a single (non-continuing) page never paces — nothing to wait between", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [story("3000", "2026-01-01T00:00:00Z")] } },
			{ body: { data: [] } },
		],
	});
	const { ctx } = makeCtx({}, ["transactions"]);
	let delayCalls = 0;
	await collectTransactions(ctx, fetchPath, OWNER_ID, () => {
		delayCalls += 1;
		return Promise.resolve();
	});
	assert.equal(
		delayCalls,
		1,
		"a short non-empty page must pace before the explicit empty terminal page",
	);
});

test("fetchAllFriends: paces between pages via the injected delay", async () => {
	const FRIENDS_PAGE_SIZE = 200;
	const page1 = Array.from({ length: FRIENDS_PAGE_SIZE }, (_, i) => ({
		id: String(4000 + i),
		username: `friend${i}`,
		display_name: `Friend ${i}`,
	}));
	const page2 = [{ id: "5000", username: "last", display_name: "Last Friend" }];
	const { fetchPath } = makeScriptedFetch({
		[`/users/${OWNER_ID}/friends`]: [
			{ body: { data: page1 } },
			{ body: { data: page2 } },
			{ body: { data: [] } },
		],
	});
	const delays: number[] = [];
	const { friends: all } = await fetchAllFriends(
		fetchPath,
		OWNER_ID,
		() => Promise.resolve(),
		(ms) => {
			delays.push(ms);
			return Promise.resolve();
		},
	);
	assert.equal(all.length, FRIENDS_PAGE_SIZE + 1);
	assert.deepEqual(
		delays,
		[500, 500],
		"both non-empty page transitions must be paced",
	);
});

test("fetchAllFriends: a short non-empty page does not terminate the walk", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		[`/users/${OWNER_ID}/friends`]: [
			{
				body: {
					data: [{ id: "6000", username: "first", display_name: "First" }],
				},
			},
			{
				body: {
					data: [{ id: "6001", username: "second", display_name: "Second" }],
				},
			},
			{ body: { data: [] } },
		],
	});

	const result = await fetchAllFriends(
		fetchPath,
		OWNER_ID,
		() => Promise.resolve(),
		NO_DELAY,
	);

	assert.equal(
		result.friends.length,
		2,
		"both non-empty pages must be enumerated",
	);
	assert.equal(
		result.truncated,
		false,
		"the empty page is an honest completion",
	);
	assert.equal(
		calls.length,
		3,
		"the walk must continue until the provider returns an empty page",
	);
});

test("collectAllStreams: a capped Venmo friends walk is partial and holds its fingerprint checkpoint", async () => {
	const page = Array.from({ length: 200 }, (_, i) => ({
		id: String(30_000 + i),
		username: `friend${i}`,
		display_name: `Friend ${i}`,
	}));
	const { fetchPath, calls } = makeScriptedFetch({
		[`/users/${OWNER_ID}/friends`]: Array.from(
			{ length: MAX_FRIENDS_PAGES },
			() => ({ body: { data: page } }),
		),
	});
	const { ctx, messages } = makeCtx(
		{ friends: { fingerprints: { prior: "fingerprint" } } },
		["friends"],
	);

	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser(), NO_DELAY);

	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "friends",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, MAX_FRIENDS_PAGES * page.length + 1);
	assert.equal(coverage.covered, MAX_FRIENDS_PAGES * page.length);
	assert.equal(calls.length, MAX_FRIENDS_PAGES);
	assert.ok(
		messages.some((m) => m.type === "SKIP_RESULT" && m.stream === "friends"),
	);
	const state = messages.find(
		(m) => m.type === "STATE" && m.stream === "friends",
	);
	assert.ok(state && state.type === "STATE");
	assert.deepEqual(state.cursor, { fingerprints: { prior: "fingerprint" } });
});

test("collectAllStreams: a capped Venmo transactions walk advances the head date and saves backfill", async () => {
	const page = Array.from({ length: 50 }, (_, i) =>
		story(String(40_000 + i), "2026-01-01T00:00:00Z"),
	);
	const { fetchPath, calls } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": Array.from(
			{
				length: MAX_TRANSACTION_PAGES,
			},
			(_, pageIndex) => ({
				body: {
					data: page.map((item, itemIndex) => ({
						...item,
						id: String(40_000 + pageIndex * page.length + itemIndex),
						payment: {
							...item.payment,
							id: String(90_000 + pageIndex * page.length + itemIndex),
						},
					})),
				},
			}),
		),
	});
	const { ctx, messages } = makeCtx(
		{ transactions: { last_seen_date_created: "2020-01-01T00:00:00" } },
		["transactions"],
	);

	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser(), NO_DELAY);

	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "transactions",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, MAX_TRANSACTION_PAGES * page.length + 1);
	assert.equal(coverage.covered, MAX_TRANSACTION_PAGES * page.length);
	assert.equal(calls.length, MAX_TRANSACTION_PAGES);
	assert.ok(
		messages.some(
			(m) => m.type === "SKIP_RESULT" && m.stream === "transactions",
		),
	);
	const state = messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	assert.equal(
		Object.keys(
			(state.cursor as Record<string, unknown>).refresh_fingerprints as object,
		).length,
		100,
	);
	const { refresh_fingerprints, ...checkpoint } = state.cursor as Record<
		string,
		unknown
	>;
	assert.deepEqual(checkpoint, {
		last_seen_date_created: "2026-01-01T00:00:00Z",
		version: 2,
		head_anchor_id: "40000",
		backfill_before_id: String(
			40_000 + MAX_TRANSACTION_PAGES * page.length - 1,
		),
	});
});

// ─── Endpoint failure classification ────────────────────────────────────────

test("collectTransactions: a 401 mid-run terminals as venmo_session_expired, never as a raw password-grant retry", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { error: { message: "session gone" } }, status: 401 },
		],
	});
	const { ctx } = makeCtx({}, ["transactions"]);
	await assert.rejects(
		collectTransactions(ctx, fetchPath, OWNER_ID),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /venmo_session_expired/);
			assert.match(
				err.message,
				/\/stories\/target-or-actor\/\{id\}/,
				"endpoint label is templated, not the live user id",
			);
			assert.doesNotMatch(
				err.message,
				/1111111111111111111/,
				"the live owner id must not leak into the message",
			);
			return true;
		},
	);
});

test("collectTransactions: a 5xx terminals as venmo_server_error naming the endpoint", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: "upstream boom", status: 500 },
		],
	});
	const { ctx } = makeCtx({}, ["transactions"]);
	await assert.rejects(
		collectTransactions(ctx, fetchPath, OWNER_ID),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(err.message, /venmo_server_error/);
			assert.match(err.message, /\/stories\/target-or-actor/);
			return true;
		},
	);
});

test("collectTransactions: a 429 terminals as venmo_rate_limited (retryable pattern match)", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [{ body: {}, status: 429 }],
	});
	const { ctx } = makeCtx({}, ["transactions"]);
	await assert.rejects(
		collectTransactions(ctx, fetchPath, OWNER_ID),
		/venmo_rate_limited/,
	);
});

// ─── collectAllStreams: full collect() body, honest coverage, scope ────────

test("collectAllStreams: only requested streams drive a fetch", async () => {
	const { fetchPath, calls } = makeScriptedFetch({
		"/account": [{ body: { data: { user: accountUser() } } }],
	});
	const { ctx, emitted } = makeCtx({}, ["profile"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
	assert.equal(emitted.length, 1);
	assert.equal(emitted[0]?.stream, "profile");
	assert.deepEqual(
		calls,
		[],
		"the pre-fetched account object must be reused, not re-fetched for profile",
	);
});

test("collectAllStreams: friends stream emits DETAIL_COVERAGE with honest considered/covered", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/users/1111111111111111111/friends": [
			{
				body: {
					data: [
						{ id: "3333333333333333333", username: "a", display_name: "A" },
					],
				},
			},
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted, messages } = makeCtx({}, ["friends"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
	assert.equal(emitted.length, 1);
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "friends",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 1);
	assert.equal(coverage.covered, 1);
});

test("collectAllStreams: zero-friend run still emits DETAIL_COVERAGE considered=0 covered=0 (measured zero, not silence)", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/users/1111111111111111111/friends": [{ body: { data: [] } }],
	});
	const { ctx, messages } = makeCtx({}, ["friends"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "friends",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 0);
	assert.equal(coverage.covered, 0);
});

test("collectAllStreams: transactions DETAIL_COVERAGE distinguishes considered from covered on an unmodeled story", async () => {
	const modeled = story("6001", "2026-05-01T00:00:00Z");
	const unmodeled = {
		id: "6002",
		date_created: "2026-05-01T00:00:00Z",
		payment: { id: "6003", action: "top_up" },
	};
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [modeled, unmodeled] } },
			{ body: { data: [] } },
		],
	});
	const { ctx, emitted, messages } = makeCtx({}, ["transactions"]);
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
	assert.equal(emitted.length, 1, "only the modeled story emits a record");
	const coverage = messages.find(
		(m) => m.type === "DETAIL_COVERAGE" && m.stream === "transactions",
	);
	assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
	assert.equal(coverage.considered, 2);
	assert.equal(coverage.covered, 1);
});

test("collectAllStreams: records emit before STATE for each requested stream", async () => {
	const { fetchPath } = makeScriptedFetch({
		"/stories/target-or-actor/1111111111111111111": [
			{ body: { data: [story("7001", "2026-06-01T00:00:00Z")] } },
			{ body: { data: [] } },
		],
	});
	const harness = makeRecordingEmit(validateRecord);
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
		requested: new Map([["transactions", { name: "transactions" }]]),
		scope: { streams: [] },
		sendInteraction: () => Promise.reject(new Error("not used")),
		state: {},
	} as BrowserCollectContext;
	await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
	const lastRecordIdx = harness.events.reduce(
		(acc, e, i) => (e.kind === "record" ? i : acc),
		-1,
	);
	const stateIdx = harness.events.findIndex(
		(e) => e.kind === "message" && e.message.type === "STATE",
	);
	assert.ok(lastRecordIdx !== -1, "expected at least one RECORD event");
	assert.ok(stateIdx !== -1, "expected a STATE event");
	assert.ok(stateIdx > lastRecordIdx, "STATE must land after the last RECORD");
});

// ─── No raw fetch anywhere in the collect path ──────────────────────────────
//
// A source grep only catches a literal spelling — renaming
// `"access" + "_token"` or building the device-id header from a differently
// named constant defeats it while a real password-grant call still runs
// (proven live: /tmp/review-venmo-browser-redesign-0810.md F7). This asserts
// the actual behavior instead: `collectAllStreams` must not touch
// `globalThis.fetch` at all — every read goes through the injected
// `VenmoPageFetch` seam (`page.evaluate(fetch)` under the session cookie),
// never a raw Node-side `fetch()` call that could carry a bearer token,
// device-id, or spoofed User-Agent.

test("collectAllStreams: never calls globalThis.fetch — every read goes through the injected page-fetch seam", async () => {
	const original = globalThis.fetch;
	let called = false;
	globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
		called = true;
		return original(...args);
	}) as typeof globalThis.fetch;
	try {
		const { fetchPath } = makeScriptedFetch({
			"/account": [{ body: { data: { user: accountUser() } } }],
			"/users/1111111111111111111/friends": [{ body: { data: [] } }],
			"/stories/target-or-actor/1111111111111111111": [{ body: { data: [] } }],
		});
		const { ctx } = makeCtx({}, ["profile", "friends", "transactions"]);
		await collectAllStreams(ctx, fetchPath, OWNER_ID, accountUser());
		assert.equal(
			called,
			false,
			"collectAllStreams must never call globalThis.fetch directly",
		);
	} finally {
		globalThis.fetch = original;
	}
});

// ─── establishVenmoCollectOrigin: collect()'s own origin guard ─────────────
//
// `ensureSession` may leave the page wherever sign-in redirected it (e.g.
// `id.venmo.com`), so `collect()` re-establishes the `venmo.com` origin
// itself before its first credentialed fetch. Regression coverage for
// production run_1787101857760 (2026-08-18): a navigation that resolves
// without actually landing on venmo.com must fail fast with a diagnosable,
// retryable name — `venmo_transport_error` — rather than let the next fetch
// throw a bare, unclassified "Failed to fetch" from an opaque origin.

test("establishVenmoCollectOrigin: a stuck-on-about:blank navigation throws venmo_transport_error, not a bare opaque-origin failure", async () => {
	const gotoUrls: string[] = [];
	const page: Pick<Page, "goto" | "url"> = {
		goto(url: string): ReturnType<Page["goto"]> {
			gotoUrls.push(url);
			// Resolves without the page actually leaving about:blank — the exact
			// production defect (ensureVenmoOrigin's old `.catch(() => undefined)`
			// returned regardless of whether the navigation landed).
			return Promise.resolve(null);
		},
		url(): string {
			return "about:blank";
		},
	};
	await assert.rejects(
		establishVenmoCollectOrigin(page as Page),
		(err: unknown) => {
			assert.ok(err instanceof Error);
			assert.match(
				err.message,
				/venmo_transport_error/,
				"must match VENMO_RETRYABLE_PATTERN, not escape unclassified",
			);
			assert.match(
				err.message,
				/venmo_origin_navigation_failed/,
				"the underlying cause stays legible",
			);
			return true;
		},
	);
	assert.deepEqual(gotoUrls, ["https://venmo.com/"]);
});

test("establishVenmoCollectOrigin: a successful navigation to venmo.com resolves without throwing", async () => {
	let currentUrl = "about:blank";
	const page: Pick<Page, "goto" | "url"> = {
		goto(url: string): ReturnType<Page["goto"]> {
			currentUrl = url;
			return Promise.resolve(null);
		},
		url(): string {
			return currentUrl;
		},
	};
	await assert.doesNotReject(establishVenmoCollectOrigin(page as Page));
});

test("semantics: mutable anchor and older collected payment refresh while malformed tail remains", async () => {
	const history = Array.from(
		{ length: MAX_TRANSACTION_PAGES * 50 + 50 },
		(_, i) => story(String(900000 - i), "2026-01-01T00:00:00Z"),
	);
	nth(history, 0).payment.status = "pending";
	nth(history, 75).payment.status = "pending";
	const first = makeCtx({}, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		makeStatefulVenmoFetch(history).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	const state = first.messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	nth(history, 0).payment.status = "settled";
	nth(history, 75).payment.status = "settled";
	nth(history, 75).payment.amount = 22;
	delete (history[MAX_TRANSACTION_PAGES * 50] as { date_created?: string })
		.date_created;
	const second = makeCtx({ transactions: state.cursor }, ["transactions"]);
	await collectAllStreams(
		second.ctx,
		makeStatefulVenmoFetch(history).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.deepEqual(
		second.emitted
			.filter((e) =>
				[nth(history, 0).id, nth(history, 75).id].includes(String(e.data.id)),
			)
			.map((e) => e.data.id)
			.sort(),
		[nth(history, 0).id, nth(history, 75).id].sort(),
	);
	assert.ok(
		!second.emitted.some((e) => e.data.id === nth(history, 1).id),
		"unchanged head must not repeat",
	);
	const next = second.messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(
		next &&
			next.type === "STATE" &&
			(next.cursor as Record<string, unknown>).backfill_before_id,
	);
});

test("semantics: capped enumeration reports portable failure then resumes to observed exhaustion", async () => {
	const history = Array.from(
		{ length: MAX_TRANSACTION_PAGES * 50 + 1 },
		(_, i) => story(String(800000 - i), "2026-01-01T00:00:00Z"),
	);
	const first = makeCtx({}, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		makeStatefulVenmoFetch(history).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.deepEqual(
		first.messages.filter((m) => m.type === "SKIP_RESULT").map((m) => m.reason),
		["stream_collection_failed"],
	);
	const state = first.messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(state && state.type === "STATE");
	const second = makeCtx({ transactions: state.cursor }, ["transactions"]);
	await collectAllStreams(
		second.ctx,
		makeStatefulVenmoFetch(history).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.ok(
		second.emitted.some(
			(e) => e.data.id === nth(history, history.length - 1).id,
		),
	);
	const next = second.messages.find(
		(m) => m.type === "STATE" && m.stream === "transactions",
	);
	assert.ok(next && next.type === "STATE");
	assert.equal(
		(next.cursor as Record<string, unknown>).backfill_before_id,
		undefined,
	);
	assert.equal(
		second.messages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("semantics: empty stale continuation does not close a head gap", async () => {
	const history = Array.from({ length: 150 }, (_, i) =>
		story(String(700000 - i), "2026-01-01T00:00:00Z"),
	);
	const gap = {
		start_id: nth(history, 0).id,
		before_id: "600000",
		end_id: "500000",
	};
	const result = makeCtx(
		{
			transactions: {
				version: 2,
				head_anchor_id: nth(history, 0).id,
				head_gaps: [gap],
			},
		},
		["transactions"],
	);
	const outcome = await collectTransactions(
		result.ctx,
		makeStatefulVenmoFetch(history).fetchPath,
		OWNER_ID,
		NO_DELAY,
	);
	assert.deepEqual(outcome.headGaps, [gap]);
	assert.equal(outcome.truncated, true);
});

for (const status of [401, 403, 429, 500, 502, 503, 504]) {
	test(`semantics: HTTP ${status} has a stable safe retry classification`, async () => {
		const backend = makeScriptedFetch({
			[`/stories/target-or-actor/${OWNER_ID}`]: [{ status, body: {} }],
		});
		await assert.rejects(
			collectTransactions(
				makeCtx({}, ["transactions"]).ctx,
				backend.fetchPath,
				OWNER_ID,
				NO_DELAY,
			),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				const code =
					status === 401 || status === 403
						? "venmo_session_expired"
						: status === 429
							? "venmo_rate_limited"
							: "venmo_server_error";
				assert.ok(error.message.startsWith(code));
				assert.equal(
					VENMO_RETRYABLE_PATTERN.test(error.message),
					status >= 429,
				);
				return true;
			},
		);
		assert.equal(
			backend.calls.length,
			1,
			"collector must not retry or submit credentials",
		);
		assert.equal(
			VENMO_RETRYABLE_PATTERN.test(
				"venmo_post_submit_probe_transport_error: venmo_server_error",
			),
			false,
		);
	});
}

test("semantics: completed-run metadata does not claim date cursor incrementality", () => {
	const manifest = JSON.parse(
		readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
	);
	const transactions = manifest.streams.find(
		(s: { name: string }) => s.name === "transactions",
	);
	assert.equal(transactions.incremental, false);
	assert.equal(transactions.cursor_field, undefined);
	assert.equal(manifest.version, "0.2.27");
});

test("partial mutable payments never replace a complete record and are retried", async () => {
	const complete = {
		...story("8701", "2026-07-01T00:00:00Z"),
		audience: "private",
		date_updated: null,
		app: null,
	};
	Object.assign(complete.payment, { note: "lunch", date_completed: null });
	const first = makeCtx({}, ["transactions"]);
	await collectAllStreams(
		first.ctx,
		makeScriptedFetch({
			[`/stories/target-or-actor/${OWNER_ID}`]: [
				{ body: { data: [complete] } },
				{ body: { data: [] } },
			],
		}).fetchPath,
		OWNER_ID,
		accountUser(),
		NO_DELAY,
	);
	assert.equal(first.emitted.length, 1);
	const firstState = first.messages.find((m) => m.type === "STATE");
	assert.ok(firstState?.type === "STATE");
	for (const field of ["amount", "actor"]) {
		const partial = structuredClone(complete) as unknown as {
			payment: Record<string, unknown>;
		};
		delete partial.payment[field];
		const next = makeCtx({ transactions: firstState.cursor }, ["transactions"]);
		const failures: { retryable?: boolean }[] = [];
		next.ctx.reportStreamFailure = async (_stream, _message, options) => {
			failures.push(options ?? {});
		};
		await collectAllStreams(
			next.ctx,
			makeScriptedFetch({
				[`/stories/target-or-actor/${OWNER_ID}`]: [
					{ body: { data: [partial] } },
					{ body: { data: [] } },
				],
			}).fetchPath,
			OWNER_ID,
			accountUser(),
			NO_DELAY,
		);
		assert.equal(next.emitted.length, 0, field);
		assert.equal(next.skipped.length, 1, field);
		assert.ok(
			failures.some((f) => f.retryable === true),
			field,
		);
		const coverage = next.messages.find((m) => m.type === "DETAIL_COVERAGE");
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : -1,
			0,
		);
		const rejectedState = next.messages.find((m) => m.type === "STATE");
		assert.ok(rejectedState?.type === "STATE");
		const repaired = makeCtx({ transactions: rejectedState.cursor }, [
			"transactions",
		]);
		await collectAllStreams(
			repaired.ctx,
			makeScriptedFetch({
				[`/stories/target-or-actor/${OWNER_ID}`]: [
					{ body: { data: [complete] } },
					{ body: { data: [] } },
				],
			}).fetchPath,
			OWNER_ID,
			accountUser(),
			NO_DELAY,
		);
		assert.equal(repaired.emitted.length, 1);
	}
});

test("profile and friend snapshots missing core identity are skipped without coverage credit", async () => {
	const complete = {
		...accountUser(),
		first_name: null,
		last_name: null,
		phone: null,
		about: null,
		profile_picture_url: null,
		is_business: false,
		is_group: false,
		is_active: true,
	};
	for (const stream of ["profile", "friends"])
		for (const field of ["username", "display_name"] as const) {
			const partial = { ...complete };
			delete (partial as Record<string, unknown>)[field];
			const run = makeCtx({}, [stream]);
			const failures: { retryable?: boolean }[] = [];
			run.ctx.reportStreamFailure = async (_stream, _message, options) => {
				failures.push(options ?? {});
			};
			await collectAllStreams(
				run.ctx,
				makeScriptedFetch({
					[`/users/${OWNER_ID}/friends`]: [
						{ body: { data: [partial] } },
						{ body: { data: [] } },
					],
				}).fetchPath,
				OWNER_ID,
				partial,
				NO_DELAY,
			);
			assert.equal(run.emitted.length, 0);
			assert.equal(run.skipped.length, 1);
			assert.ok(failures.some((f) => f.retryable === true));
			const coverage = run.messages.find((m) => m.type === "DETAIL_COVERAGE");
			assert.equal(
				coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : -1,
				0,
			);
		}
});

test("unselected incomplete user snapshots do not fail requested coverage", async () => {
	for (const stream of ["profile", "friends"]) {
		const run = makeCtx({}, [stream]);
		run.ctx.isRecordSelected = () => false;
		run.ctx.reportStreamFailure = async () => {
			throw new Error("unselected row failed stream");
		};
		await collectAllStreams(
			run.ctx,
			makeScriptedFetch({
				[`/users/${OWNER_ID}/friends`]: [
					{ body: { data: [{ id: OWNER_ID }] } },
					{ body: { data: [] } },
				],
			}).fetchPath,
			OWNER_ID,
			{ id: OWNER_ID },
			NO_DELAY,
		);
		assert.equal(run.emitted.length, 0);
	}
});

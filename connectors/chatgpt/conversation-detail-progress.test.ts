// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	advanceDetailProgress,
	CONVERSATION_DETAIL_FAILURES_MAX,
	CONVERSATION_DETAIL_RETRY_LIMIT,
	countRowsRead,
	type DetailProgress,
	detailListCursor,
	EMPTY_DETAIL_PROGRESS,
	encodeDetailProgress,
	readDetailProgress,
	rowsOwedDetail,
} from "./conversation-detail-progress.ts";
import type { ConversationListItem } from "./types.ts";

const row = (id: string, iso: string): ConversationListItem => ({
	id,
	update_time: Date.parse(iso) / 1000,
});
const at = (minute: number): string =>
	`2026-04-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ids = (rows: readonly ConversationListItem[]): string[] =>
	rows.map((c) => c.id);

/** Fold one run's outcome into `prior` for a complete walk from the start of time. */
function advance(
	prior: DetailProgress,
	rows: ConversationListItem[],
	{
		settled = [],
		failed = [],
		listComplete = true,
	}: { settled?: string[]; failed?: string[]; listComplete?: boolean },
): ReturnType<typeof advanceDetailProgress> {
	return advanceDetailProgress({
		prior,
		rows,
		settled: new Set(settled),
		failed: new Set(failed),
		listComplete,
		listedAboveMs: null,
	});
}

test("readDetailProgress: a cursor without the detail version, or a missing one, says nothing is read", () => {
	assert.deepEqual(readDetailProgress(undefined), EMPTY_DETAIL_PROGRESS);
	assert.deepEqual(
		readDetailProgress({ last_update_time: at(5) }),
		EMPTY_DETAIL_PROGRESS,
	);
	assert.equal(detailListCursor(EMPTY_DETAIL_PROGRESS, null), null);
});

test("readDetailProgress: a versioned cursor with only a watermark reads everything up to it", () => {
	const progress = readDetailProgress({
		last_update_time: at(5),
		detail_version: 1,
	});
	assert.equal(detailListCursor(progress, null), at(5));
	const rows = [row("a", at(4)), row("b", at(5)), row("c", at(6))];
	assert.deepEqual(ids(rowsOwedDetail(rows, progress)), ["c"]);
});

test("rowsOwedDetail: rows come newest first, ties by id, and a row with no time last", () => {
	const rows = [
		row("a", at(1)),
		{ id: "timeless" },
		row("c", at(2)),
		row("b", at(2)),
	];
	assert.deepEqual(ids(rowsOwedDetail(rows, EMPTY_DETAIL_PROGRESS)), [
		"c",
		"b",
		"a",
		"timeless",
	]);
});

test("advanceDetailProgress: a pass that read the newest rows keeps them as an interval and owes the rest", () => {
	const rows = [row("c", at(3)), row("b", at(2)), row("a", at(1))];
	const { progress } = advance(EMPTY_DETAIL_PROGRESS, rows, { settled: ["c"] });

	assert.deepEqual(ids(rowsOwedDetail(rows, progress)), ["b", "a"]);
	// Not anchored at the start of time, so the next walk lists everything.
	assert.equal(detailListCursor(progress, null), null);

	const next = advance(progress, rows, { settled: ["b", "a"] });
	assert.deepEqual(ids(rowsOwedDetail(rows, next.progress)), []);
	assert.equal(detailListCursor(next.progress, null), at(3));
	assert.deepEqual(encodeDetailProgress(next.progress, at(3)), {
		detail_version: 1,
	});
});

test("advanceDetailProgress: rows that share an update time stay separate", () => {
	const rows = [row("b", at(2)), row("a", at(2))];
	const first = advance(EMPTY_DETAIL_PROGRESS, rows, { settled: ["b"] });
	// "b" is read; "a" shares its time and is still owed.
	assert.deepEqual(ids(rowsOwedDetail(rows, first.progress)), ["a"]);

	const second = advance(first.progress, rows, { settled: ["a"] });
	assert.deepEqual(ids(rowsOwedDetail(rows, second.progress)), []);
});

test("advanceDetailProgress: an arrival above the read intervals is owed and the history stays read", () => {
	const history = [row("o2", at(2)), row("o1", at(1))];
	const read = advance(EMPTY_DETAIL_PROGRESS, history, {
		settled: ["o2", "o1"],
	}).progress;
	const withArrival = [row("n", at(9)), ...history];
	assert.deepEqual(ids(rowsOwedDetail(withArrival, read)), ["n"]);
	// A row that changed moves above the interval, too.
	const changed = [row("o1", at(8)), row("o2", at(2))];
	assert.deepEqual(ids(rowsOwedDetail(changed, read)), ["o1"]);
});

test("advanceDetailProgress: a failed row is retried, counted by run, and released at the limit", () => {
	const rows = [row("c", at(3)), row("b", at(2)), row("a", at(1))];
	let progress = advance(EMPTY_DETAIL_PROGRESS, rows, {
		settled: ["c", "a"],
		failed: ["b"],
	}).progress;
	assert.deepEqual(progress.failures, { b: { n: 1, t: Date.parse(at(2)) } });
	// Only the failed row is owed again; the list walk reaches down to it.
	assert.deepEqual(ids(rowsOwedDetail(rows, progress)), ["b"]);
	assert.equal(
		detailListCursor(progress, null),
		new Date(Date.parse(at(2)) - 1).toISOString(),
	);

	let released = new Set<string>();
	for (let run = 2; run <= CONVERSATION_DETAIL_RETRY_LIMIT; run += 1) {
		({ progress, released } = advance(progress, rows, { failed: ["b"] }));
	}
	assert.deepEqual([...released], ["b"]);
	assert.deepEqual(progress.failures, {});
	assert.deepEqual(ids(rowsOwedDetail(rows, progress)), []);
});

test("advanceDetailProgress: a row that was not asked for this run keeps its failure count, and one that changed or is gone loses it", () => {
	const rows = [row("b", at(2))];
	const failed = advance(EMPTY_DETAIL_PROGRESS, rows, { failed: ["b"] });
	const untouched = advance(failed.progress, rows, {});
	assert.deepEqual(untouched.progress.failures, failed.progress.failures);

	const moved = advance(failed.progress, [row("b", at(7))], {});
	assert.deepEqual(moved.progress.failures, {});
	const gone = advance(failed.progress, [], {});
	assert.deepEqual(gone.progress.failures, {});
	// A walk that did not complete cannot say a row is gone.
	const partial = advance(failed.progress, [], { listComplete: false });
	assert.deepEqual(partial.progress.failures, failed.progress.failures);
});

test("advanceDetailProgress: a walk that did not complete adds no interval", () => {
	const rows = [row("b", at(2)), row("a", at(1))];
	const { progress } = advance(EMPTY_DETAIL_PROGRESS, rows, {
		settled: ["b", "a"],
		listComplete: false,
	});
	assert.deepEqual(progress.done, []);
});

test("advanceDetailProgress: failures beyond the cap are released at once, newest kept", () => {
	const total = CONVERSATION_DETAIL_FAILURES_MAX + 10;
	const rows = Array.from({ length: total }, (_, i) =>
		row(`r${String(i).padStart(3, "0")}`, at(i % 60)),
	);
	const { progress, released } = advance(EMPTY_DETAIL_PROGRESS, rows, {
		failed: rows.map((c) => c.id),
	});
	assert.equal(
		Object.keys(progress.failures).length,
		CONVERSATION_DETAIL_FAILURES_MAX,
	);
	assert.equal(released.size, 10);
	// The retry table never grows past the cap, so the cursor stays small.
	const encoded = encodeDetailProgress(progress, at(59));
	assert.equal(
		Object.keys(encoded.detail_failures ?? {}).length,
		CONVERSATION_DETAIL_FAILURES_MAX,
	);
});

test("readDetailProgress: a stored table longer than the cap is cut to it", () => {
	const detail_failures = Object.fromEntries(
		Array.from({ length: CONVERSATION_DETAIL_FAILURES_MAX + 5 }, (_, i) => [
			`r${i}`,
			{ n: 1, t: at(1) },
		]),
	);
	const progress = readDetailProgress({
		last_update_time: at(5),
		detail_version: 1,
		detail_failures,
	});
	assert.equal(
		Object.keys(progress.failures).length,
		CONVERSATION_DETAIL_FAILURES_MAX,
	);
});

test("detailListCursor: a window lower edge anchors history that reaches it", () => {
	const since = Date.parse(at(1));
	const progress = advanceDetailProgress({
		prior: EMPTY_DETAIL_PROGRESS,
		rows: [row("b", at(3)), row("a", at(2))],
		settled: new Set(["b", "a"]),
		failed: new Set(),
		listComplete: true,
		listedAboveMs: since - 1,
	}).progress;
	assert.equal(detailListCursor(progress, since), at(3));
	// Without the window the same history does not reach the start of time.
	assert.equal(detailListCursor(progress, null), null);
});

test("encodeDetailProgress and readDetailProgress round-trip intervals and failures", () => {
	const rows = [row("c", at(3)), row("b", at(2)), row("a", at(1))];
	const { progress } = advance(EMPTY_DETAIL_PROGRESS, rows, {
		settled: ["c"],
		failed: ["a"],
	});
	const encoded = encodeDetailProgress(progress, at(3));
	const decoded = readDetailProgress({
		last_update_time: at(3),
		...encoded,
	});
	assert.deepEqual(decoded, progress);
});

test("countRowsRead: counts rows inside a read interval that wait on no retry", () => {
	const rows = [row("c", at(3)), row("b", at(2)), row("a", at(1))];
	const { progress } = advance(EMPTY_DETAIL_PROGRESS, rows, {
		settled: ["c", "a"],
		failed: ["b"],
	});
	assert.equal(countRowsRead(rows, progress, new Set(["c", "a"])), 2);
});

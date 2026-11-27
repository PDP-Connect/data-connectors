// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	advanceDetailProgress,
	CONVERSATION_DETAIL_FAILURES_MAX,
	CONVERSATION_DETAIL_IDS_MAX,
	CONVERSATION_DETAIL_RETRY_LIMIT,
	countRowsRead,
	type DetailProgress,
	detailListCursor,
	EMPTY_DETAIL_PROGRESS,
	encodeDetailProgress,
	isDetailDone,
	planDetailReads,
	readDetailProgress,
} from "./conversation-detail-progress.ts";
import type { ConversationListItem } from "./types.ts";

const row = (id: string, iso: string): ConversationListItem => ({
	id,
	update_time: Date.parse(iso) / 1000,
});
const at = (minute: number): string =>
	`2026-04-22T10:${String(minute).padStart(2, "0")}:00.000Z`;
const ms = (minute: number): number => Date.parse(at(minute));
const ids = (rows: readonly ConversationListItem[]): string[] =>
	rows.map((c) => c.id);
const NONE = new Set<string>();

function plan(
	rows: ConversationListItem[],
	prior: DetailProgress,
	backfillLimit = 200,
): ReturnType<typeof planDetailReads> {
	return planDetailReads(rows, prior, {
		floorMs: null,
		backfillLimit,
		taken: NONE,
		newToStream: NONE,
	});
}

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
		floorMs: null,
	});
}

test("readDetailProgress: nothing stored, or a malformed cursor, says nothing is read", () => {
	assert.deepEqual(readDetailProgress(undefined), EMPTY_DETAIL_PROGRESS);
	assert.deepEqual(readDetailProgress(null), EMPTY_DETAIL_PROGRESS);
	assert.deepEqual(readDetailProgress("x"), EMPTY_DETAIL_PROGRESS);
	assert.equal(detailListCursor(EMPTY_DETAIL_PROGRESS, null), null);
});

test("readDetailProgress: a published-shape cursor keeps its watermark and says no history is read", () => {
	const progress = readDetailProgress({ last_update_time: at(5) });
	assert.equal(progress.watermark, ms(5));
	assert.equal(progress.frontier, ms(5));
	assert.equal(progress.done.size, 0);
	// History is pending, so the first upgraded run walks the whole list...
	assert.equal(detailListCursor(progress, null), null);
	// ...but a window that ends at the watermark has no history to read.
	assert.equal(
		detailListCursor(progress, ms(5)),
		new Date(ms(5) - 1).toISOString(),
	);
});

test("readDetailProgress: a version-2 cursor round-trips through encodeDetailProgress", () => {
	const progress: DetailProgress = {
		watermark: ms(9),
		frontier: ms(4),
		done: new Set([`${ms(9)}:a`, `${ms(9)}:b`, `${ms(4)}:c`, `none:d`]),
		failures: { e: { n: 2, t: ms(6) } },
	};
	const encoded = encodeDetailProgress(progress);
	assert.deepEqual(encoded, {
		last_update_time: at(9),
		detail_version: 2,
		detail_frontier: at(4),
		detail_ids: { [at(4)]: ["c"], [at(9)]: ["a", "b"], none: ["d"] },
		detail_failures: { e: { n: 2, t: at(6) } },
	});
	assert.deepEqual(readDetailProgress(encoded), progress);
});

test("readDetailProgress: a null frontier is minus infinity, an absent one is the watermark", () => {
	const done = readDetailProgress({
		last_update_time: at(5),
		detail_version: 2,
		detail_frontier: null,
	});
	assert.equal(done.frontier, null);
	assert.equal(isDetailDone(done, "x", ms(1)), true);
	const absent = readDetailProgress({
		last_update_time: at(5),
		detail_version: 2,
	});
	assert.equal(absent.frontier, ms(5));
	assert.equal(isDetailDone(absent, "x", ms(1)), false);
});

test("readDetailProgress: caps the stored failure table and id set, so a hostile cursor cannot grow state", () => {
	const detail_failures = Object.fromEntries(
		Array.from({ length: CONVERSATION_DETAIL_FAILURES_MAX + 20 }, (_, i) => [
			`f${i}`,
			{ n: 1, t: at(3) },
		]),
	);
	const detail_ids = {
		[at(5)]: Array.from(
			{ length: CONVERSATION_DETAIL_IDS_MAX + 50 },
			(_, i) => `d${i}`,
		),
	};
	const progress = readDetailProgress({
		last_update_time: at(5),
		detail_version: 2,
		detail_frontier: at(5),
		detail_ids,
		detail_failures,
	});
	assert.equal(
		Object.keys(progress.failures).length,
		CONVERSATION_DETAIL_FAILURES_MAX,
	);
	assert.equal(progress.done.size, CONVERSATION_DETAIL_IDS_MAX);
});

test("readDetailProgress: drops failure rows with a bad count or time", () => {
	const progress = readDetailProgress({
		last_update_time: at(5),
		detail_version: 2,
		detail_failures: {
			ok: { n: 1, t: at(3) },
			zero: { n: 0, t: at(3) },
			frac: { n: 1.5, t: at(3) },
			time: { n: 1, t: "not a time" },
			bare: null,
		},
	});
	assert.deepEqual(Object.keys(progress.failures), ["ok"]);
});

test("isDetailDone: only exact keys at the boundaries, and the interior, are done", () => {
	const progress: DetailProgress = {
		watermark: ms(9),
		frontier: ms(4),
		done: new Set([`${ms(9)}:seen`, `${ms(4)}:seen`]),
		failures: {},
	};
	assert.equal(isDetailDone(progress, "seen", ms(9)), true);
	assert.equal(
		isDetailDone(progress, "unseen", ms(9)),
		false,
		"a tie not observed is owed",
	);
	assert.equal(isDetailDone(progress, "unseen", ms(4)), false);
	assert.equal(
		isDetailDone(progress, "any", ms(6)),
		true,
		"the interior is done",
	);
	assert.equal(
		isDetailDone(progress, "any", ms(3)),
		false,
		"below the frontier is owed",
	);
	assert.equal(
		isDetailDone(progress, "any", ms(10)),
		false,
		"above the watermark is owed",
	);
	assert.equal(isDetailDone(progress, "any", null), false);
});

test("isDetailDone: a row on the retry table is not done, even in the interior", () => {
	const progress: DetailProgress = {
		watermark: ms(9),
		frontier: null,
		done: new Set(),
		failures: { stuck: { n: 1, t: ms(6) } },
	};
	assert.equal(isDetailDone(progress, "stuck", ms(6)), false);
	assert.equal(
		isDetailDone(progress, "stuck", ms(7)),
		true,
		"it moved: a new version",
	);
});

test("planDetailReads: with no cursor the newest row is read first, then history newest first; every row is emitted", () => {
	const rows = [row("c", at(3)), row("a", at(1)), row("b", at(2))];
	const p = plan(rows, EMPTY_DETAIL_PROGRESS);
	assert.deepEqual(ids(p.toRead), ["c", "b", "a"]);
	assert.deepEqual(ids(p.listOnly).sort(), ["a", "b", "c"]);
});

test("planDetailReads: fresh rows are read oldest first, so the watermark advances contiguously", () => {
	const prior: DetailProgress = {
		watermark: ms(5),
		frontier: null,
		done: new Set([`${ms(5)}:old`]),
		failures: {},
	};
	const rows = [
		row("new-2", at(8)),
		row("new-1", at(7)),
		row("old", at(5)),
		row("mid", at(3)),
	];
	const p = plan(rows, prior);
	assert.deepEqual(ids(p.toRead), ["new-1", "new-2"]);
	assert.deepEqual(ids(p.listOnly), ["new-2", "new-1"], "in list order");
});

test("planDetailReads: an unseen row tied with the watermark is owed; the observed one is not", () => {
	const prior: DetailProgress = {
		watermark: ms(5),
		frontier: null,
		done: new Set([`${ms(5)}:seen`]),
		failures: {},
	};
	const p = plan([row("seen", at(5)), row("late", at(5))], prior);
	assert.deepEqual(ids(p.toRead), ["late"]);
});

test("planDetailReads: history is bounded per run, newest first, and unread history is not emitted", () => {
	const prior = readDetailProgress({ last_update_time: at(50) });
	const rows = Array.from({ length: 10 }, (_, i) => row(`r${i}`, at(i)));
	rows.push(row("top", at(50)));
	const p = plan(rows, prior, 4);
	// The row at the watermark has no exact key, so it is owed too, as fresh.
	assert.deepEqual(ids(p.toRead), ["top", "r9", "r8", "r7", "r6"]);
	assert.deepEqual(ids(p.listOnly), ["top"]);
});

test("planDetailReads: a row a resumed list continuation reached is emitted list-only even when it is not read", () => {
	const prior: DetailProgress = {
		watermark: ms(9),
		frontier: ms(9),
		done: new Set([`${ms(9)}:top`, `${ms(5)}:overlap`]),
		failures: {},
	};
	const rows = [row("top", at(9)), row("overlap", at(5)), row("tail", at(4))];
	const p = planDetailReads(rows, prior, {
		floorMs: null,
		backfillLimit: 0,
		taken: NONE,
		newToStream: new Set(["overlap", "tail"]),
	});
	assert.deepEqual(ids(p.toRead), []);
	assert.deepEqual(
		ids(p.listOnly),
		["tail"],
		"a row already read has its record",
	);
});

test("planDetailReads: retries read before history, and rows another pass took are skipped", () => {
	const prior: DetailProgress = {
		watermark: ms(9),
		frontier: ms(2),
		done: new Set([`${ms(9)}:top`]),
		failures: { sick: { n: 1, t: ms(6) } },
	};
	const rows = [
		row("top", at(9)),
		row("sick", at(6)),
		row("taken", at(5)),
		row("hist", at(1)),
	];
	const p = planDetailReads(rows, prior, {
		floorMs: null,
		backfillLimit: 200,
		taken: new Set(["taken"]),
		newToStream: NONE,
	});
	assert.deepEqual(ids(p.toRead), ["sick", "hist"]);
});

test("advance: the watermark and frontier move past rows that were read, in order", () => {
	const rows = [row("c", at(3)), row("b", at(2)), row("a", at(1))];
	const first = advance(EMPTY_DETAIL_PROGRESS, rows, { settled: ["c"] });
	assert.equal(first.progress.watermark, ms(3));
	assert.equal(first.progress.frontier, ms(3));
	assert.deepEqual([...first.progress.done], [`${ms(3)}:c`]);
	const second = advance(first.progress, rows, { settled: ["b", "a"] });
	assert.equal(second.progress.frontier, null, "history is complete");
	assert.deepEqual([...second.progress.done], [`${ms(3)}:c`]);
});

test("advance: the frontier stops above the first history row that was not read", () => {
	const prior: DetailProgress = {
		watermark: ms(9),
		frontier: ms(9),
		done: new Set([`${ms(9)}:top`]),
		failures: {},
	};
	const rows = [
		row("top", at(9)),
		row("h8", at(8)),
		row("h7", at(7)),
		row("h6", at(6)),
	];
	const { progress } = advance(prior, rows, { settled: ["h8", "h6"] });
	assert.equal(
		progress.frontier,
		ms(8),
		"h7 was not read: nothing below it counts",
	);
	assert.equal(isDetailDone(progress, "h8", ms(8)), true);
	assert.equal(isDetailDone(progress, "h7", ms(7)), false);
	assert.equal(
		isDetailDone(progress, "h6", ms(6)),
		true,
		"read below the frontier: kept as an exact key",
	);
});

test("advance: an arrival tied with the watermark that this run never read stays owed", () => {
	// Run 1 observed and read only `seen` at the newest time. `late` joined the
	// timestamp after the list page was read, so it is not an observation.
	const first = advance(EMPTY_DETAIL_PROGRESS, [row("seen", at(5))], {
		settled: ["seen"],
	});
	assert.equal(isDetailDone(first.progress, "seen", ms(5)), true);
	assert.equal(isDetailDone(first.progress, "late", ms(5)), false);
	const second = plan([row("late", at(5)), row("seen", at(5))], first.progress);
	assert.deepEqual(ids(second.toRead), ["late"]);
});

test("advance: a failed row is parked on the retry table, not marked done, and the walk still reaches it", () => {
	const prior: DetailProgress = {
		watermark: ms(2),
		frontier: null,
		done: new Set([`${ms(2)}:base`]),
		failures: {},
	};
	const rows = [row("n3", at(3)), row("base", at(2))];
	const { progress } = advance(prior, rows, { failed: ["n3"] });
	assert.deepEqual(progress.failures, { n3: { n: 1, t: ms(3) } });
	assert.equal(isDetailDone(progress, "n3", ms(3)), false);
	// The watermark moved past it, so the walk must reach down to the failed row.
	assert.equal(
		detailListCursor(progress, null),
		new Date(ms(3) - 1).toISOString(),
	);
});

test("advance: a row the run never reached stops the watermark", () => {
	const prior: DetailProgress = {
		watermark: ms(2),
		frontier: null,
		done: new Set([`${ms(2)}:base`]),
		failures: {},
	};
	const rows = [row("n4", at(4)), row("n3", at(3)), row("base", at(2))];
	const { progress } = advance(prior, rows, { settled: ["n4"] });
	assert.equal(
		progress.watermark,
		ms(2),
		"n3 was not read, so n4 does not count as the edge",
	);
	assert.equal(
		isDetailDone(progress, "n4", ms(4)),
		true,
		"but its read is kept as an exact key",
	);
	assert.equal(isDetailDone(progress, "n3", ms(3)), false);
});

test("advance: a deferral is not counted; a failure is, and the third releases the row", () => {
	const rows = [row("x", at(3))];
	let progress = advance(EMPTY_DETAIL_PROGRESS, rows, {
		failed: ["x"],
	}).progress;
	assert.equal(progress.failures.x?.n, 1);
	// Nothing reached x this run (429, spent budget): the count stands.
	progress = advance(progress, rows, {}).progress;
	assert.equal(progress.failures.x?.n, 1);
	progress = advance(progress, rows, { failed: ["x"] }).progress;
	assert.equal(progress.failures.x?.n, 2);
	const last = advance(progress, rows, { failed: ["x"] });
	assert.equal(CONVERSATION_DETAIL_RETRY_LIMIT, 3);
	assert.deepEqual([...last.released], ["x"]);
	assert.equal(last.progress.failures.x, undefined);
	assert.equal(
		isDetailDone(last.progress, "x", ms(3)),
		true,
		"released rows are done",
	);
});

test("advance: a failure count restarts when the row changed", () => {
	const old = advance(EMPTY_DETAIL_PROGRESS, [row("x", at(3))], {
		failed: ["x"],
	}).progress;
	const moved = advance(old, [row("x", at(7))], { failed: ["x"] }).progress;
	assert.deepEqual(moved.failures.x, { n: 1, t: ms(7) });
});

test("advance: released rows are saved as exact keys even when the walk was incomplete", () => {
	const rows = Array.from({ length: 60 }, (_, i) => row(`r${i}`, at(i)));
	const first = advance(EMPTY_DETAIL_PROGRESS, rows, {
		failed: rows.map((c) => c.id),
		listComplete: false,
	});
	assert.equal(
		Object.keys(first.progress.failures).length,
		CONVERSATION_DETAIL_FAILURES_MAX,
	);
	assert.equal(
		first.released.size,
		10,
		"the rows over the cap are released at once",
	);
	for (const id of first.released) {
		const t = ms(Number(id.slice(1)));
		assert.equal(
			isDetailDone(first.progress, id, t),
			true,
			`released ${id} is not owed again`,
		);
		assert.equal(first.progress.done.has(`${t}:${id}`), true);
	}
	// Run two: the released rows are not asked for again.
	const next = plan(rows, first.progress);
	for (const id of first.released) {
		assert.equal(ids(next.toRead).includes(id), false, `${id} is not re-read`);
	}
});

test("advance: a walk that was cut short moves no boundary and keeps the exact keys it had", () => {
	const prior: DetailProgress = {
		watermark: ms(5),
		frontier: ms(5),
		done: new Set([`${ms(5)}:a`]),
		failures: {},
	};
	const { progress } = advance(prior, [row("n7", at(7)), row("a", at(5))], {
		settled: ["n7"],
		listComplete: false,
	});
	assert.equal(progress.watermark, ms(5));
	assert.equal(progress.frontier, ms(5));
	assert.equal(isDetailDone(progress, "a", ms(5)), true);
	assert.equal(
		isDetailDone(progress, "n7", ms(7)),
		true,
		"its read is kept as an exact key",
	);
});

test("advance: a first walk cut short sets both boundaries at the newest row seen, with only the keys it read", () => {
	const { progress } = advance(
		EMPTY_DETAIL_PROGRESS,
		[row("b", at(5)), row("a", at(4))],
		{ settled: ["b", "a"], listComplete: false },
	);
	assert.equal(progress.watermark, ms(5));
	assert.equal(progress.frontier, ms(5), "the history behind it is not proven");
	assert.equal(isDetailDone(progress, "b", ms(5)), true);
	assert.equal(
		isDetailDone(progress, "a", ms(4)),
		true,
		"read: kept as an exact key",
	);
	assert.equal(
		isDetailDone(progress, "x", ms(5)),
		false,
		"an unseen tie is owed",
	);
	assert.equal(isDetailDone(progress, "x", ms(4)), false);
});

test("advance: the id set never exceeds its cap, and boundary keys survive it", () => {
	const prior: DetailProgress = {
		watermark: ms(55),
		frontier: ms(55),
		done: new Set([`${ms(55)}:edge`]),
		failures: {},
	};
	const rows = [
		row("edge", at(55)),
		...Array.from({ length: CONVERSATION_DETAIL_IDS_MAX + 40 }, (_, i) =>
			row(`x${i}`, `2026-04-22T11:${String(i % 60).padStart(2, "0")}:00.000Z`),
		),
	];
	const { progress } = advance(prior, rows, {
		settled: rows.map((c) => c.id),
		listComplete: false,
	});
	assert.equal(progress.done.size, CONVERSATION_DETAIL_IDS_MAX);
	assert.equal(progress.done.has(`${ms(55)}:edge`), true);
});

test("countRowsRead: rows waiting on a retry are not counted as read", () => {
	const rows = [row("ok", at(3)), row("sick", at(3)), row("unread", at(2))];
	const { progress } = advance(EMPTY_DETAIL_PROGRESS, rows, {
		settled: ["ok"],
		failed: ["sick"],
	});
	assert.equal(countRowsRead(rows, progress, new Set(["ok"])), 1);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Which conversations have had their detail read, kept in the `conversations`
// cursor. A conversations-only run reads each conversation's detail to fill
// `model_counts`, so the cursor must say what that read has covered. The list
// watermark cannot say it: a run that stops partway, or a row that fails, would
// leave rows above the watermark unread, and holding the watermark below them
// makes the next run list and emit the finished rows again.
//
// The cursor holds two things instead:
//
//   - `done`: key intervals in which every conversation is read, or gone, or
//     (see `failures`) owed a retry. A key is (update time, id), so rows that
//     share an update time stay distinct. A row inside an interval is neither
//     fetched nor emitted again. A row outside one is owed a read: a new or
//     changed conversation (its update time moved above every interval), or one
//     of the history a backfill has not reached.
//   - `failures`: rows that were asked for and could not be read, with the
//     number of runs that failed. They are retried each run until read, until
//     the retry limit, or until the table is full.
//
// The usual cursor, "every row up to the list watermark is read", is the
// single interval that starts at the beginning of time and ends at that
// watermark. It is stored as the watermark alone (see `encodeDetailProgress`).
//
// Rows are read newest first, so fresh conversations never wait for history.
// Pure functions; `index.ts` wires them to the list walk and the detail lane.

import { tsToIso } from "./parsers.ts";
import type { ConversationListItem } from "./types.ts";

/** Bump to make the next run read every conversation's detail once (model counts). */
export const CONVERSATION_DETAIL_VERSION = 1;

/**
 * Consecutive runs a conversation may fail to read before it is left list-only.
 * A failure other than 404/410 that repeats this often is not transient.
 */
export const CONVERSATION_DETAIL_RETRY_LIMIT = 3;

/**
 * Failed rows kept in the cursor. A row beyond it is left list-only at once, so
 * a run that fails for every row cannot grow the cursor.
 */
export const CONVERSATION_DETAIL_FAILURES_MAX = 50;

/**
 * Where a row sits in the order. `id: null` stands for "after every id at this
 * time", so a bound can cover a whole update time.
 */
interface RowKey {
	/** Epoch milliseconds. */
	t: number;
	id: string | null;
}

/** The keys above `lo` (none when `lo` is null) up to and including `hi`. */
interface KeyInterval {
	lo: RowKey | null;
	hi: RowKey;
}

interface DetailFailure {
	/** Runs in a row that asked for this row and could not read it. */
	n: number;
	/** The row's update time when it failed; a later one means the row changed. */
	t: number;
}

export interface DetailProgress {
	done: KeyInterval[];
	failures: Record<string, DetailFailure>;
}

export const EMPTY_DETAIL_PROGRESS: DetailProgress = {
	done: [],
	failures: {},
};

function compareKeys(a: RowKey, b: RowKey): number {
	if (a.t !== b.t) return a.t < b.t ? -1 : 1;
	if (a.id === b.id) return 0;
	if (a.id === null) return 1;
	if (b.id === null) return -1;
	return a.id < b.id ? -1 : 1;
}

/** A row with no usable update time has no place in the order. */
function rowKey(c: ConversationListItem): RowKey | null {
	const iso = c.update_time ? tsToIso(c.update_time) : null;
	return iso === null ? null : { t: Date.parse(iso), id: c.id };
}

function inInterval(key: RowKey, interval: KeyInterval): boolean {
	return (
		(interval.lo === null || compareKeys(key, interval.lo) > 0) &&
		compareKeys(key, interval.hi) <= 0
	);
}

function isDone(done: readonly KeyInterval[], key: RowKey): boolean {
	return done.some((interval) => inInterval(key, interval));
}

/** Union of intervals that overlap or touch. */
function mergeIntervals(intervals: readonly KeyInterval[]): KeyInterval[] {
	const sorted = [...intervals].sort((a, b) =>
		a.lo === null
			? b.lo === null
				? 0
				: -1
			: b.lo === null
				? 1
				: compareKeys(a.lo, b.lo),
	);
	const merged: KeyInterval[] = [];
	for (const next of sorted) {
		const last = merged.at(-1);
		if (last && (next.lo === null || compareKeys(next.lo, last.hi) <= 0)) {
			if (compareKeys(next.hi, last.hi) > 0) last.hi = next.hi;
		} else {
			merged.push({ lo: next.lo, hi: next.hi });
		}
	}
	return merged;
}

function isoOf(ms: number): string {
	return new Date(ms).toISOString();
}

function keyToJson(key: RowKey): { t: string; id: string | null } {
	return { t: isoOf(key.t), id: key.id };
}

function keyFromJson(value: unknown): RowKey | null {
	if (typeof value !== "object" || value === null) return null;
	const { t, id } = value as { t?: unknown; id?: unknown };
	if (typeof t !== "string" || !(typeof id === "string" || id === null)) {
		return null;
	}
	const ms = Date.parse(t);
	return Number.isNaN(ms) ? null : { t: ms, id };
}

function readDone(value: unknown): KeyInterval[] | null {
	if (!Array.isArray(value)) return null;
	const done: KeyInterval[] = [];
	for (const raw of value) {
		const entry = (raw ?? {}) as { lo?: unknown; hi?: unknown };
		const hi = keyFromJson(entry.hi);
		const lo = entry.lo === undefined ? null : keyFromJson(entry.lo);
		if (hi === null || (entry.lo !== undefined && lo === null)) return null;
		done.push({ lo, hi });
	}
	return mergeIntervals(done);
}

function readFailures(value: unknown): Record<string, DetailFailure> {
	const failures: Record<string, DetailFailure> = {};
	if (typeof value !== "object" || value === null) return failures;
	for (const [id, raw] of Object.entries(value)) {
		const entry = (raw ?? {}) as { n?: unknown; t?: unknown };
		if (
			Object.keys(failures).length < CONVERSATION_DETAIL_FAILURES_MAX &&
			typeof entry.n === "number" &&
			Number.isSafeInteger(entry.n) &&
			entry.n > 0 &&
			typeof entry.t === "string" &&
			!Number.isNaN(Date.parse(entry.t))
		) {
			failures[id] = { n: entry.n, t: Date.parse(entry.t) };
		}
	}
	return failures;
}

/**
 * What a stored `conversations` cursor says has been read. A cursor from before
 * conversations carried model counts (no `detail_version`) says nothing, so
 * every conversation is read once.
 */
export function readDetailProgress(cursor: unknown): DetailProgress {
	if (typeof cursor !== "object" || cursor === null) {
		return EMPTY_DETAIL_PROGRESS;
	}
	const stored = cursor as {
		last_update_time?: unknown;
		detail_version?: unknown;
		detail_done?: unknown;
		detail_failures?: unknown;
	};
	if (stored.detail_version !== CONVERSATION_DETAIL_VERSION) {
		return EMPTY_DETAIL_PROGRESS;
	}
	const failures = readFailures(stored.detail_failures);
	const explicit = readDone(stored.detail_done);
	if (explicit !== null) return { done: explicit, failures };
	// No intervals stored: everything up to the watermark is read.
	const watermark =
		typeof stored.last_update_time === "string"
			? Date.parse(stored.last_update_time)
			: Number.NaN;
	return {
		done: Number.isNaN(watermark)
			? []
			: [{ lo: null, hi: { t: watermark, id: null } }],
		failures,
	};
}

/**
 * Where the list walk must reach: rows newer than this are listed. It is the
 * top of the history that is fully read, so a steady-state run lists only what
 * changed, and a backfill or a retry lists down to the rows it still owes.
 * `sinceMs` is the lower edge of a time window: nothing below it is listed, so
 * history that reaches it counts as complete.
 */
export function detailListCursor(
	progress: DetailProgress,
	sinceMs: number | null,
): string | null {
	const anchored = progress.done.find(
		(interval) =>
			interval.lo === null || (sinceMs !== null && interval.lo.t <= sinceMs),
	);
	if (!anchored) return null;
	let cursorMs = anchored.hi.id === null ? anchored.hi.t : anchored.hi.t - 1;
	for (const failure of Object.values(progress.failures)) {
		cursorMs = Math.min(cursorMs, failure.t - 1);
	}
	return isoOf(cursorMs);
}

/** Whether this listed row is owed a read: not inside a read interval, or failed before. */
function isOwed(c: ConversationListItem, progress: DetailProgress): boolean {
	const key = rowKey(c);
	if (key === null) return true;
	const failure = progress.failures[c.id];
	if (failure && failure.t === key.t) return true;
	return !isDone(progress.done, key);
}

/** The listed rows owed a read, newest first. */
export function rowsOwedDetail(
	rows: readonly ConversationListItem[],
	progress: DetailProgress,
): ConversationListItem[] {
	return newestFirst(rows.filter((c) => isOwed(c, progress)));
}

/** Rows newest first; a row with no time last, as it has no place in the order. */
export function newestFirst(
	rows: readonly ConversationListItem[],
): ConversationListItem[] {
	return rows
		.map((c) => ({ c, key: rowKey(c) }))
		.sort((a, b) =>
			a.key === null
				? b.key === null
					? 0
					: 1
				: b.key === null
					? -1
					: compareKeys(b.key, a.key),
		)
		.map(({ c }) => c);
}

export interface AdvanceInput {
	prior: DetailProgress;
	/** Every row the walk listed. */
	rows: readonly ConversationListItem[];
	/** Rows whose detail was read, or is gone, or was taken by another pass. */
	settled: ReadonlySet<string>;
	/** Rows asked for that could not be read this run. */
	failed: ReadonlySet<string>;
	/**
	 * Whether the walk proved it saw every row above `listedAboveMs`. A walk
	 * cut short by a failed page proves nothing about rows between the ones it
	 * saw, so it adds no interval.
	 */
	listComplete: boolean;
	/** The walk listed every row newer than this (epoch ms); null for the start of time. */
	listedAboveMs: number | null;
}

/**
 * Fold a run's outcome into the progress. Rows that were read, or failed after
 * being asked for, join the read intervals; a failure also enters the retry
 * table. Returns the rows left list-only for good: the retry limit was hit, or
 * the table was full.
 */
export function advanceDetailProgress({
	prior,
	rows,
	settled,
	failed,
	listComplete,
	listedAboveMs,
}: AdvanceInput): { progress: DetailProgress; released: Set<string> } {
	const keyById = new Map<string, RowKey | null>();
	for (const c of rows) keyById.set(c.id, rowKey(c));

	// The retry table: carry what this run did not decide, count what it failed.
	const failures: Record<string, DetailFailure> = {};
	const released = new Set<string>();
	for (const [id, failure] of Object.entries(prior.failures)) {
		if (settled.has(id) || failed.has(id)) continue;
		const key = keyById.get(id);
		const unlisted = key === undefined;
		// A row that moved is a new conversation to read; one a complete walk
		// no longer lists is gone or out of the window.
		if (unlisted ? listComplete : key === null || key.t !== failure.t) continue;
		failures[id] = failure;
	}
	for (const id of failed) {
		const key = keyById.get(id);
		if (key === undefined || key === null) continue;
		const before = prior.failures[id];
		failures[id] = {
			n: (before && before.t === key.t ? before.n : 0) + 1,
			t: key.t,
		};
	}
	const byNewest = Object.entries(failures).sort(([a], [b]) => {
		const keyA = keyById.get(a);
		const keyB = keyById.get(b);
		return keyA && keyB ? compareKeys(keyB, keyA) : 0;
	});
	const kept: Record<string, DetailFailure> = {};
	for (const [id, failure] of byNewest) {
		if (
			failure.n >= CONVERSATION_DETAIL_RETRY_LIMIT ||
			Object.keys(kept).length >= CONVERSATION_DETAIL_FAILURES_MAX
		) {
			released.add(id);
		} else {
			kept[id] = failure;
		}
	}

	if (!listComplete) {
		return { progress: { done: prior.done, failures: kept }, released };
	}
	const isRowDone = (c: ConversationListItem, key: RowKey): boolean =>
		isDone(prior.done, key) ||
		settled.has(c.id) ||
		failed.has(c.id) ||
		released.has(c.id);
	const listed = newestFirst(rows)
		.map((c) => ({ c, key: rowKey(c) }))
		.filter((row): row is { c: ConversationListItem; key: RowKey } =>
			Boolean(row.key),
		)
		.map((row) => ({ ...row, done: isRowDone(row.c, row.key) }));
	const bottom: RowKey | null =
		listedAboveMs === null ? null : { t: listedAboveMs, id: null };
	const added: KeyInterval[] = [];
	for (let i = 0; i < listed.length; i += 1) {
		const row = listed[i];
		if (!row?.done || listed[i - 1]?.done) continue;
		// A run of done rows, newest first, ends at the next row not done.
		let end = i;
		while (listed[end + 1]?.done) end += 1;
		const below = listed[end + 1];
		// The newest run covers its whole update time when no row sharing it is
		// still owed; otherwise a row tied with it would be skipped for good.
		const tied = listed.some(
			(other) => !other.done && other.key.t === row.key.t,
		);
		added.push({
			lo: below ? below.key : bottom,
			hi: i === 0 && !tied ? { t: row.key.t, id: null } : row.key,
		});
	}
	return {
		progress: {
			done: mergeIntervals([...prior.done, ...added]),
			failures: kept,
		},
		released,
	};
}

/** The cursor fields for the progress; `lastUpdateTime` is the list watermark. */
export function encodeDetailProgress(
	progress: DetailProgress,
	lastUpdateTime: string | null,
): {
	detail_version: number;
	detail_done?: Array<{
		lo?: { t: string; id: string | null };
		hi: { t: string; id: string | null };
	}>;
	detail_failures?: Record<string, { n: number; t: string }>;
} {
	const only = progress.done.length === 1 ? progress.done[0] : undefined;
	const isWatermark =
		only !== undefined &&
		only.lo === null &&
		only.hi.id === null &&
		isoOf(only.hi.t) === lastUpdateTime;
	// Nothing read and no watermark needs no intervals either way.
	const needsIntervals = !(
		isWatermark ||
		(progress.done.length === 0 && lastUpdateTime === null)
	);
	const failures = Object.entries(progress.failures);
	return {
		detail_version: CONVERSATION_DETAIL_VERSION,
		...(needsIntervals
			? {
					detail_done: progress.done.map((interval) => ({
						...(interval.lo === null ? {} : { lo: keyToJson(interval.lo) }),
						hi: keyToJson(interval.hi),
					})),
				}
			: {}),
		...(failures.length === 0
			? {}
			: {
					detail_failures: Object.fromEntries(
						failures.map(([id, failure]) => [
							id,
							{ n: failure.n, t: isoOf(failure.t) },
						]),
					),
				}),
	};
}

/**
 * How many of `rows` have their detail read: inside a read interval and not
 * waiting on a retry. A row with no update time has no interval; it counts when
 * this run settled it.
 */
export function countRowsRead(
	rows: readonly ConversationListItem[],
	progress: DetailProgress,
	settled: ReadonlySet<string>,
): number {
	return rows.filter((c) => {
		const key = rowKey(c);
		return key === null
			? settled.has(c.id)
			: isDone(progress.done, key) && !progress.failures[c.id];
	}).length;
}

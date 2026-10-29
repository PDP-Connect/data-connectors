// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Which conversations have had their detail read, kept in the `conversations`
// cursor. A conversations-only run reads each conversation's detail to fill
// `model_counts`, so the cursor must say what that read has covered.
//
// One invariant owns the design:
//
//   A conversation counts as read for update time T only if this connector
//   observed exactly (id, T) and its detail read succeeded, or the conversation
//   was released after CONVERSATION_DETAIL_RETRY_LIMIT counted failures.
//   Nothing else marks a conversation done. A range of times never stands in
//   for an observation of an id.
//
// The list API has no stable snapshot, so a run never knows it saw every id at
// a timestamp: another conversation can share the newest timestamp and arrive
// after the page was read. The cursor therefore holds the usual
// "timestamp + tie-set" shape, with two boundaries:
//
//   watermark (L)   The fresh edge. Conversations at L whose id is not in the
//                   exact id set, and every conversation newer than L, are owed.
//   frontier  (Tb)  The history edge, at or below L. Reading history starts at
//                   the watermark and walks down to the oldest conversation, a
//                   bounded number per run. A conversation at Tb is done only
//                   if its id is in the exact id set; one below Tb is owed.
//
// Between Tb and L (exclusive) every conversation is done, because a run only
// moves a boundary past conversations it observed and read, in order, and a
// conversation that already existed keeps its update time until it changes (a
// change moves it above L). The exact id set (`done`) holds the observed keys
// at the two boundary times, plus a bounded number of keys read by a run whose
// walk was incomplete, so that run's work is not read again.
//
// A conversation that failed to read is in the retry table, `failures`, with
// the number of runs that failed and the update time it failed at. It is retried
// each run until read or released. A rate-limit or budget deferral is not a
// failure of the conversation: it stays owed and is not counted.
//
// Bounds on the cursor: `done` holds at most CONVERSATION_DETAIL_IDS_MAX keys
// (the tie-set at L and at Tb plus extras), `failures` at most
// CONVERSATION_DETAIL_FAILURES_MAX rows, and the two boundaries are one
// timestamp each. More conversations than the cap sharing one boundary
// timestamp are read again, never marked done.
//
// Pure functions; `index.ts` wires them to the list walk and the detail lane.

import { tsToIso } from "./parsers.ts";
import type { ConversationListItem } from "./types.ts";

/** Cursor shape marker. A cursor without it is the published shape: a watermark only. */
export const CONVERSATION_DETAIL_VERSION = 2;

/**
 * Consecutive runs a conversation may fail to read before it is left list-only.
 * A failure other than 404/410 that repeats this often is not transient.
 */
export const CONVERSATION_DETAIL_RETRY_LIMIT = 3;

/**
 * Failed rows kept in the cursor. A row beyond it is released at once, so a
 * run that fails for every row cannot grow the cursor.
 */
export const CONVERSATION_DETAIL_FAILURES_MAX = 50;

/** Exact (id, update time) keys kept in the cursor. */
export const CONVERSATION_DETAIL_IDS_MAX = 200;

/** History conversations a run may read after the fresh ones. */
export const CONVERSATION_BACKFILL_PER_RUN = 200;

interface DetailFailure {
	/** Runs in a row that asked for this row and could not read it. */
	n: number;
	/** The row's update time when it failed; a later one means the row changed. */
	t: number;
}

export interface DetailProgress {
	/** The fresh edge, epoch ms; null before any complete walk. */
	watermark: number | null;
	/**
	 * The history edge, epoch ms, at or below the watermark. Null is minus
	 * infinity: every conversation down to the window's lower edge is done.
	 */
	frontier: number | null;
	/** Exact keys done, as `${t}:${id}`; see `doneKey`. */
	done: ReadonlySet<string>;
	failures: Readonly<Record<string, DetailFailure>>;
}

export const EMPTY_DETAIL_PROGRESS: DetailProgress = {
	watermark: null,
	frontier: null,
	done: new Set(),
	failures: {},
};

/** A row with no usable update time has no place in the order. */
type RowTime = number | null;

function rowTime(c: ConversationListItem): RowTime {
	const iso = c.update_time ? tsToIso(c.update_time) : null;
	return iso === null ? null : Date.parse(iso);
}

function doneKey(id: string, t: RowTime): string {
	return `${t ?? "none"}:${id}`;
}

function isoOf(ms: number): string {
	return new Date(ms).toISOString();
}

function parseMs(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : ms;
}

function readDone(value: unknown): Set<string> {
	const done = new Set<string>();
	if (typeof value !== "object" || value === null) return done;
	for (const [time, ids] of Object.entries(value)) {
		const t = time === "none" ? null : parseMs(time);
		if (!Array.isArray(ids) || (t === null && time !== "none")) continue;
		for (const id of ids) {
			if (typeof id === "string" && done.size < CONVERSATION_DETAIL_IDS_MAX) {
				done.add(doneKey(id, t));
			}
		}
	}
	return done;
}

function readFailures(value: unknown): Record<string, DetailFailure> {
	const failures: Record<string, DetailFailure> = {};
	if (typeof value !== "object" || value === null) return failures;
	for (const [id, raw] of Object.entries(value)) {
		const entry = (raw ?? {}) as { n?: unknown; t?: unknown };
		const t = parseMs(entry.t);
		if (
			Object.keys(failures).length < CONVERSATION_DETAIL_FAILURES_MAX &&
			typeof entry.n === "number" &&
			Number.isSafeInteger(entry.n) &&
			entry.n > 0 &&
			t !== null
		) {
			failures[id] = { n: entry.n, t };
		}
	}
	return failures;
}

/**
 * What a stored `conversations` cursor says has been read. A cursor in the
 * published shape (a watermark, no `detail_version`) keeps its watermark for
 * listing and says no history is read: the first upgraded run reads the rows
 * above the watermark, then works down through the history a bounded number of
 * rows per run.
 */
export function readDetailProgress(cursor: unknown): DetailProgress {
	if (typeof cursor !== "object" || cursor === null) {
		return EMPTY_DETAIL_PROGRESS;
	}
	const stored = cursor as {
		last_update_time?: unknown;
		detail_version?: unknown;
		detail_frontier?: unknown;
		detail_ids?: unknown;
		detail_failures?: unknown;
	};
	const watermark = parseMs(stored.last_update_time);
	if (stored.detail_version !== CONVERSATION_DETAIL_VERSION) {
		return { ...EMPTY_DETAIL_PROGRESS, watermark, frontier: watermark };
	}
	// An absent frontier is read as the watermark: nothing below it is done.
	const frontier =
		stored.detail_frontier === null
			? null
			: (parseMs(stored.detail_frontier) ?? watermark);
	return {
		watermark,
		frontier,
		done: readDone(stored.detail_ids),
		failures: readFailures(stored.detail_failures),
	};
}

/** Strictly between the boundaries: done by the walk that moved them there. */
function isInterior(progress: DetailProgress, t: RowTime): boolean {
	return (
		t !== null &&
		progress.watermark !== null &&
		t < progress.watermark &&
		(progress.frontier === null || t > progress.frontier)
	);
}

function waitsOnRetry(
	progress: DetailProgress,
	id: string,
	t: RowTime,
): boolean {
	const failure = progress.failures[id];
	return failure !== undefined && failure.t === t;
}

/** Whether a listed conversation's detail is read, gone, or given up on. */
export function isDetailDone(
	progress: DetailProgress,
	id: string,
	t: RowTime,
): boolean {
	if (waitsOnRetry(progress, id, t)) return false;
	return progress.done.has(doneKey(id, t)) || isInterior(progress, t);
}

/** Whether the history behind the watermark still has rows to read. */
function historyPending(
	progress: DetailProgress,
	floorMs: number | null,
): boolean {
	return (
		progress.frontier !== null &&
		(floorMs === null || progress.frontier > floorMs)
	);
}

/**
 * Where the list walk must reach, as a cursor the walk lists strictly after.
 * One millisecond below the watermark, so the walk lists the watermark's ties.
 * While history is unread the walk goes to the end of the list. Null lists
 * everything. `floorMs` is the window's lower edge: nothing below it is listed.
 */
export function detailListCursor(
	progress: DetailProgress,
	floorMs: number | null,
): string | null {
	if (progress.watermark === null || historyPending(progress, floorMs)) {
		return null;
	}
	let from = progress.watermark;
	for (const failure of Object.values(progress.failures)) {
		from = Math.min(from, failure.t);
	}
	return isoOf(from - 1);
}

/** Order by update time, then id; a row with no time first. */
function compareAscending(
	a: { t: RowTime; id: string },
	b: { t: RowTime; id: string },
): number {
	if (a.t !== b.t) {
		if (a.t === null) return -1;
		if (b.t === null) return 1;
		return a.t < b.t ? -1 : 1;
	}
	return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
}

interface TimedRow {
	c: ConversationListItem;
	id: string;
	t: RowTime;
}

function timed(rows: readonly ConversationListItem[]): TimedRow[] {
	return rows.map((c) => ({ c, id: c.id, t: rowTime(c) }));
}

/**
 * The progress a run starts from. With no watermark yet, the newest listed
 * conversation sets it, and nothing below is read: the first run reads that
 * newest row, then the history from the top down.
 */
function effectiveProgress(
	prior: DetailProgress,
	rows: readonly TimedRow[],
): DetailProgress {
	if (prior.watermark !== null) return prior;
	let newest: number | null = null;
	for (const row of rows) {
		if (row.t !== null && (newest === null || row.t > newest)) newest = row.t;
	}
	return { ...prior, watermark: newest, frontier: newest };
}

export interface DetailPlan {
	/** Rows to read, in order: fresh (oldest first), retries, history (newest first). */
	toRead: ConversationListItem[];
	/**
	 * Rows to emit list-only when not read: the owed rows that have no record yet.
	 * A fresh row has none. On the first run every row is new to the stream.
	 * After that, history already has one, except what a resumed list
	 * continuation reaches for the first time.
	 */
	listOnly: ConversationListItem[];
}

export function planDetailReads(
	rows: readonly ConversationListItem[],
	prior: DetailProgress,
	{
		floorMs,
		backfillLimit,
		taken,
		newToStream,
	}: {
		floorMs: number | null;
		backfillLimit: number;
		/** Rows another pass already took. */
		taken: ReadonlySet<string>;
		/** Rows a resumed list continuation reached, which no run has emitted yet. */
		newToStream: ReadonlySet<string>;
	},
): DetailPlan {
	const all = timed(rows).filter((row) => !taken.has(row.id));
	const progress = effectiveProgress(prior, all);
	const { watermark } = progress;
	const owed = all.filter((row) => !isDetailDone(progress, row.id, row.t));
	const fresh = owed
		.filter(
			(row) => row.t === null || (watermark !== null && row.t >= watermark),
		)
		.sort(compareAscending);
	const freshSet = new Set(fresh);
	const behind = owed.filter((row) => !freshSet.has(row));
	const retries = behind
		.filter((row) => waitsOnRetry(progress, row.id, row.t))
		.sort((a, b) => compareAscending(b, a));
	const history = behind
		.filter((row) => !waitsOnRetry(progress, row.id, row.t))
		.sort((a, b) => compareAscending(b, a))
		.slice(0, historyPending(progress, floorMs) ? backfillLimit : 0);
	const unemitted = owed.filter(
		(row) =>
			prior.watermark === null || freshSet.has(row) || newToStream.has(row.id),
	);
	return {
		toRead: [...fresh, ...retries, ...history].map((row) => row.c),
		listOnly: unemitted.map((row) => row.c),
	};
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
	 * Whether the walk proved it listed every row down to its cursor. A walk cut
	 * short proves nothing about the rows between the ones it saw, so it moves no
	 * boundary.
	 */
	listComplete: boolean;
	/** The window's lower edge (epoch ms), or null for none. */
	floorMs: number | null;
}

/**
 * Fold a run's outcome into the progress. A boundary moves only past rows the
 * run observed and read, taken in order from where it stands; the first row
 * that is not stops it. Rows read beyond a boundary, or by a walk that
 * was incomplete, are kept as exact keys. Returns the rows left list-only for
 * good: the retry limit was hit, or the retry table was full.
 */
export function advanceDetailProgress({
	prior,
	rows,
	settled,
	failed,
	listComplete,
	floorMs,
}: AdvanceInput): { progress: DetailProgress; released: Set<string> } {
	const listed = timed(rows);
	const start = effectiveProgress(prior, listed);
	const byId = new Map(listed.map((row) => [row.id, row]));

	// The retry table: carry what this run did not decide, count what it failed.
	const failures: Record<string, DetailFailure> = {};
	const released = new Set<string>();
	for (const [id, failure] of Object.entries(start.failures)) {
		if (settled.has(id) || failed.has(id)) continue;
		const row = byId.get(id);
		// A row that moved is a new conversation to read; one a complete walk
		// no longer lists is gone.
		if (row === undefined ? listComplete : row.t !== failure.t) continue;
		failures[id] = failure;
	}
	for (const id of failed) {
		const row = byId.get(id);
		if (row === undefined) continue;
		const before = start.failures[id];
		if (row.t === null) {
			// No update time to compare a later attempt with: give up at once.
			released.add(id);
			continue;
		}
		failures[id] = {
			n: (before && before.t === row.t ? before.n : 0) + 1,
			t: row.t,
		};
	}
	const keptFailures: Record<string, DetailFailure> = {};
	const newestFailureFirst = Object.entries(failures).sort(
		([, a], [, b]) => b.t - a.t,
	);
	for (const [id, failure] of newestFailureFirst) {
		if (
			failure.n >= CONVERSATION_DETAIL_RETRY_LIMIT ||
			Object.keys(keptFailures).length >= CONVERSATION_DETAIL_FAILURES_MAX
		) {
			released.add(id);
		} else {
			keptFailures[id] = failure;
		}
	}

	const observed = (row: TimedRow): boolean =>
		start.done.has(doneKey(row.id, row.t)) ||
		settled.has(row.id) ||
		released.has(row.id);
	const passable = (row: TimedRow): boolean =>
		isDetailDone(start, row.id, row.t) ||
		observed(row) ||
		keptFailures[row.id]?.t === row.t;

	let { watermark, frontier } = start;
	if (listComplete && watermark !== null) {
		const fresh = listed
			.filter((row) => row.t !== null && row.t >= (start.watermark ?? 0))
			.sort(compareAscending);
		const stop = fresh.findIndex((row) => !passable(row));
		const readFresh = stop === -1 ? fresh : fresh.slice(0, stop);
		const newest = readFresh.at(-1)?.t;
		if (newest !== undefined && newest !== null) {
			watermark = Math.max(watermark, newest);
		}
		if (historyPending(start, floorMs)) {
			const history = listed
				.filter((row) => row.t !== null && row.t < (start.watermark ?? 0))
				.sort((a, b) => compareAscending(b, a));
			const blocked = history.findIndex((row) => !passable(row));
			const lowest = (blocked === -1 ? history : history.slice(0, blocked)).at(
				-1,
			)?.t;
			frontier =
				blocked === -1
					? floorMs
					: lowest === undefined || lowest === null
						? start.frontier
						: Math.min(start.frontier ?? lowest, lowest);
		}
	}

	// Neither boundary moves on a walk that was cut short. A first walk sets both
	// at the newest row it saw: the list is newest first, so that row is the
	// newest, and what is above or tied with it but unseen is owed.
	const bounds: DetailProgress = {
		watermark,
		frontier,
		done: new Set(),
		failures: keptFailures,
	};
	// Exact keys: the rows observed this run, and, when the walk could not say a
	// row is gone, those already kept. Keys strictly between the boundaries are
	// covered by them and not kept. A row that waits on a retry is not done.
	const candidates = new Map<string, RowTime>();
	const consider = (key: string, t: RowTime): void => {
		if (!isInterior(bounds, t)) candidates.set(key, t);
	};
	for (const row of listed) {
		if (observed(row) && keptFailures[row.id]?.t !== row.t) {
			consider(doneKey(row.id, row.t), row.t);
		}
	}
	if (!listComplete) {
		for (const key of start.done) {
			const split = key.indexOf(":");
			consider(
				key,
				key.startsWith("none:") ? null : Number(key.slice(0, split)),
			);
		}
	}
	const atBoundary = (t: RowTime): boolean =>
		t !== null && (t === bounds.watermark || t === bounds.frontier);
	const ranked = [...candidates].sort(([, a], [, b]) => {
		if (atBoundary(a) !== atBoundary(b)) return atBoundary(a) ? -1 : 1;
		return (b ?? Number.NEGATIVE_INFINITY) - (a ?? Number.NEGATIVE_INFINITY);
	});
	return {
		progress: {
			...bounds,
			done: new Set(
				ranked.slice(0, CONVERSATION_DETAIL_IDS_MAX).map(([key]) => key),
			),
		},
		released,
	};
}

/** The cursor fields for the progress, besides `last_update_time`. */
export function encodeDetailProgress(progress: DetailProgress): {
	last_update_time: string | null;
	detail_version: number;
	detail_frontier?: string | null;
	detail_ids?: Record<string, string[]>;
	detail_failures?: Record<string, { n: number; t: string }>;
} {
	const byTime: Record<string, string[]> = {};
	for (const key of [...progress.done].sort()) {
		const split = key.indexOf(":");
		const time = key.slice(0, split);
		const id = key.slice(split + 1);
		const label = time === "none" ? "none" : isoOf(Number(time));
		(byTime[label] ??= []).push(id);
	}
	const failures = Object.entries(progress.failures);
	return {
		last_update_time:
			progress.watermark === null ? null : isoOf(progress.watermark),
		detail_version: CONVERSATION_DETAIL_VERSION,
		...(progress.watermark === null
			? {}
			: {
					detail_frontier:
						progress.frontier === null ? null : isoOf(progress.frontier),
				}),
		...(Object.keys(byTime).length === 0 ? {} : { detail_ids: byTime }),
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
 * How many of `rows` have their detail read: done, or settled this run, and not
 * waiting on a retry.
 */
export function countRowsRead(
	rows: readonly ConversationListItem[],
	progress: DetailProgress,
	settled: ReadonlySet<string>,
): number {
	return rows.filter((c) => {
		const t = rowTime(c);
		return (
			!waitsOnRetry(progress, c.id, t) &&
			(isDetailDone(progress, c.id, t) || settled.has(c.id))
		);
	}).length;
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Listed conversations whose detail answered 404 or 410 in the messages pass,
// kept in the `messages` cursor as `detail_not_found`.
//
// A 404 does not fail the run, but it does not prove the conversation is gone:
// ChatGPT also answers 404 for a listed conversation transiently, or when the
// session is in another account or workspace context. The messages watermark
// still advances past it, so the cursor keeps a retry obligation for it and
// every later run fetches it again, whatever the watermark, until one of:
//
//   - the detail reads cleanly: its messages are emitted and the entry dropped;
//   - the detail answers 410 (Gone), which is permanent by definition;
//   - a complete listing no longer lists it;
//   - it answered 404/410 on NOT_FOUND_SETTLE_RUNS runs in a row.
//
// The last three settle the conversation: its messages are given up and the
// run reports them in DETAIL_COVERAGE.optional_skip_keys.
//
// Bounds: the table holds at most NOT_FOUND_TRACKED_MAX entries, and a run
// fetches at most that many owed conversations. A run that would keep more
// settles the newest entries beyond the cap and says so.
//
// Pure bookkeeping; `index.ts` wires it to the detail lane and the cursor.

import type { ConversationListItem } from "./types.ts";

/** Runs in a row a conversation may answer 404 before its messages are given up. */
export const NOT_FOUND_SETTLE_RUNS = 3;

/** Owed conversations kept in the cursor, and the most a run fetches again. */
export const NOT_FOUND_TRACKED_MAX = 50;

/**
 * A run that requested at least this many first-sight details (conversations
 * the cursor did not already owe) and got 404/410 for every one is an account
 * or session failure, not an account whose conversations were all deleted.
 * Retries of owed conversations do not count: a run that only retries them
 * and gets 404 again must succeed, or the obligations could never settle.
 */
export const NOT_FOUND_GUARD_MIN_DETAILS = 3;

type ListItemHint = Record<string, string | number | boolean | null>;

export interface NotFoundEntry {
	/** Runs in a row whose detail read answered 404/410. */
	n: number;
	/** When a run first saw the 404, ISO. */
	first_seen: string;
	/** The list item, so a later run can fetch it without listing it. */
	item: ListItemHint;
}

export type NotFoundTable = Record<string, NotFoundEntry>;

function isHint(value: unknown): value is ListItemHint {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every(
			(field) =>
				field === null ||
				typeof field === "string" ||
				typeof field === "number" ||
				typeof field === "boolean",
		)
	);
}

/** The stored table, without malformed rows, at most NOT_FOUND_TRACKED_MAX of them. */
export function readNotFoundTable(value: unknown): Map<string, NotFoundEntry> {
	const table = new Map<string, NotFoundEntry>();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return table;
	}
	for (const [id, raw] of Object.entries(value)) {
		const entry = (raw ?? {}) as Partial<NotFoundEntry>;
		if (
			table.size < NOT_FOUND_TRACKED_MAX &&
			id.length > 0 &&
			typeof entry.n === "number" &&
			Number.isSafeInteger(entry.n) &&
			entry.n > 0 &&
			typeof entry.first_seen === "string" &&
			!Number.isNaN(Date.parse(entry.first_seen)) &&
			isHint(entry.item)
		) {
			table.set(id, {
				n: entry.n,
				first_seen: entry.first_seen,
				item: entry.item,
			});
		}
	}
	return table;
}

export interface NotFoundSettlement {
	/** The table the next run inherits. */
	table: NotFoundTable;
	/** Ids whose messages this run gave up. */
	settled: string[];
	/** Of `settled`, the ones dropped only because the table was full. */
	overflow: string[];
	/** Ids this run looked at and could not read messages for: report them missing. */
	missing: string[];
}

/** One run's view of the obligations: what it inherited and what it saw. */
export class DetailNotFoundTracker {
	readonly prior: ReadonlyMap<string, NotFoundEntry>;
	/** Ids whose detail answered 404/410 this run, with the status and list item. */
	private readonly answered = new Map<
		string,
		{ status: number; item: ListItemHint }
	>();
	/** Ids whose detail this run read and settled (hydrated or unrepresentable). */
	private readonly read = new Set<string>();
	/** Pending gaps whose detail answered 404/410 this run: closed only when settled. */
	private readonly heldGaps = new Map<string, string>();
	/** First-sight details this run requested, and how many answered 404/410. */
	private freshDetails = 0;
	private freshNotFound = 0;

	constructor(stored: unknown) {
		this.prior = readNotFoundTable(stored);
	}

	/** A messages-pass detail answered `status` for a conversation. */
	recordDetail(id: string, status: number, item: ListItemHint): void {
		const notFound = status === 404 || status === 410;
		if (!this.prior.has(id)) {
			this.freshDetails += 1;
			if (notFound) this.freshNotFound += 1;
		}
		if (notFound) {
			this.answered.set(id, { status, item });
		}
	}

	/** The run read this conversation's detail to a settled outcome. */
	recordRead(id: string): void {
		this.read.add(id);
	}

	/** A pending gap for `id` answered 404/410; it stays pending unless the run settles `id`. */
	holdGap(id: string, gapId: string): void {
		this.heldGaps.set(id, gapId);
	}

	/** The held gap to close for a settled id. */
	heldGapFor(id: string): string | undefined {
		return this.heldGaps.get(id);
	}

	/** This run already asked for this id's detail and it answered 404/410. */
	answeredNotFound(id: string): boolean {
		return this.answered.has(id) && !this.read.has(id);
	}

	/** Every first-sight detail this run requested answered 404/410, and there were enough to mean it. */
	everyDetailNotFound(): { details: number } | null {
		return this.freshDetails >= NOT_FOUND_GUARD_MIN_DETAILS &&
			this.freshNotFound === this.freshDetails
			? { details: this.freshDetails }
			: null;
	}

	/**
	 * Owed conversations this run has not asked for yet, oldest obligation
	 * first, at most NOT_FOUND_TRACKED_MAX. `skip` removes ids that need no
	 * fetch (already listed for the forward pass, or proved absent).
	 */
	owed(skip: ReadonlySet<string>): ConversationListItem[] {
		return [...this.prior.entries()]
			.filter(
				([id]) => !skip.has(id) && !this.answered.has(id) && !this.read.has(id),
			)
			.sort(([, a], [, b]) => a.first_seen.localeCompare(b.first_seen))
			.slice(0, NOT_FOUND_TRACKED_MAX)
			.map(([id, entry]) => ({ ...entry.item, id }) as ConversationListItem);
	}

	/**
	 * Decide each obligation. `absent(id)` is true only when a complete listing
	 * this run did not list the id.
	 */
	settle(absent: (id: string) => boolean, now: string): NotFoundSettlement {
		const kept: Array<[string, NotFoundEntry]> = [];
		const settled: string[] = [];
		const missing = new Set<string>();
		for (const id of new Set([...this.prior.keys(), ...this.answered.keys()])) {
			if (this.read.has(id)) {
				continue;
			}
			const prior = this.prior.get(id);
			const answer = this.answered.get(id);
			if (answer) {
				missing.add(id);
			}
			if (answer?.status === 410 || absent(id)) {
				settled.push(id);
				missing.add(id);
				continue;
			}
			if (!answer) {
				// Not asked for this run (deferred or past the per-run bound): unchanged.
				if (prior) kept.push([id, prior]);
				continue;
			}
			const n = (prior?.n ?? 0) + 1;
			if (n >= NOT_FOUND_SETTLE_RUNS) {
				settled.push(id);
				continue;
			}
			kept.push([
				id,
				{ n, first_seen: prior?.first_seen ?? now, item: answer.item },
			]);
		}
		kept.sort(([, a], [, b]) => a.first_seen.localeCompare(b.first_seen));
		const overflow = kept.slice(NOT_FOUND_TRACKED_MAX).map(([id]) => id);
		for (const id of overflow) {
			settled.push(id);
			missing.add(id);
		}
		return {
			table: Object.fromEntries(kept.slice(0, NOT_FOUND_TRACKED_MAX)),
			settled,
			overflow,
			missing: [...missing],
		};
	}
}

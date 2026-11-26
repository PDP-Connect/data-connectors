// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Listed conversations whose detail answered 404 or 410 in the messages pass,
// kept in the `messages` cursor as `detail_not_found`.
//
// A 404 does not fail the run, but it does not prove the conversation is gone:
// ChatGPT also answers 404 for a listed conversation transiently, or when the
// session is in another account or workspace context. Before this table the
// connector treated 404 and 410 alike (isDeletedConversationStatus), and it
// still does. The messages watermark advances past the conversation, so the
// cursor keeps a retry obligation for it and every later run fetches it again,
// whatever the watermark. The obligation ends only when a run reads the detail
// cleanly: its messages are emitted and the entry dropped. Nothing else ends
// it. A conversation that stays deleted but listed costs one detail fetch per
// run and keeps the run partial.
//
// Bound: at most NOT_FOUND_TRACKED_MAX owed conversations. A run that would
// leave more fails before it writes messages STATE, as every 404 did before
// this table; it never drops an obligation.
//
// Pure bookkeeping; `index.ts` wires it to the detail lane and the cursor.

import type { ConversationListItem } from "./types.ts";

/** Owed conversations the cursor may hold; a run that would leave more fails. */
export const NOT_FOUND_TRACKED_MAX = 50;

/**
 * A run that requested at least this many first-sight details (conversations
 * the cursor did not already owe) and got 404/410 for every one is an account
 * or session failure, not an account whose conversations were all deleted.
 * Retries of owed conversations do not count: they stay owed either way.
 */
export const NOT_FOUND_GUARD_MIN_DETAILS = 3;

type ListItemHint = Record<string, string | number | boolean | null>;

export interface NotFoundEntry {
	/** Runs whose detail read answered 404/410. */
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

/** The stored table, without malformed rows. */
export function readNotFoundTable(value: unknown): Map<string, NotFoundEntry> {
	const table = new Map<string, NotFoundEntry>();
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return table;
	}
	for (const [id, raw] of Object.entries(value)) {
		const entry = (raw ?? {}) as Partial<NotFoundEntry>;
		if (
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

/** One run's view of the obligations: what it inherited and what it saw. */
export class DetailNotFoundTracker {
	readonly prior: ReadonlyMap<string, NotFoundEntry>;
	/** Ids whose detail answered 404/410 this run, with the list item. */
	private readonly answered = new Map<string, ListItemHint>();
	/** Ids whose detail this run read to a settled outcome (hydrated or unrepresentable). */
	private readonly read = new Set<string>();
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
			this.answered.set(id, item);
		}
	}

	/** The run read this conversation's detail to a settled outcome. */
	recordRead(id: string): void {
		this.read.add(id);
	}

	/** This run already asked for this id's detail and it answered 404/410. */
	answeredNotFound(id: string): boolean {
		return this.answered.has(id) && !this.read.has(id);
	}

	/**
	 * Owed conversations this run has not asked for yet. `skip` removes ids the
	 * forward pass already lists.
	 */
	owed(skip: ReadonlySet<string>): ConversationListItem[] {
		return [...this.prior.entries()]
			.filter(
				([id]) => !skip.has(id) && !this.answered.has(id) && !this.read.has(id),
			)
			.map(([id, entry]) => ({ ...entry.item, id }) as ConversationListItem);
	}

	/**
	 * The table the next run inherits: every obligation this run did not read
	 * cleanly. Throws, before any messages STATE, when the run looks like a
	 * session failure or would leave more than NOT_FOUND_TRACKED_MAX owed.
	 */
	finish(now: string): NotFoundTable {
		if (
			this.freshDetails >= NOT_FOUND_GUARD_MIN_DETAILS &&
			this.freshNotFound === this.freshDetails
		) {
			throw new Error(
				`every conversation detail this run requested (${this.freshDetails}, not counting retries of earlier 404s) answered http 404 or 410; the session cannot read this account's conversations`,
			);
		}
		const table: NotFoundTable = {};
		for (const id of new Set([...this.prior.keys(), ...this.answered.keys()])) {
			if (this.read.has(id)) continue;
			const prior = this.prior.get(id);
			const item = this.answered.get(id);
			table[id] =
				item === undefined && prior
					? prior
					: {
							n: (prior?.n ?? 0) + 1,
							first_seen: prior?.first_seen ?? now,
							item: item ?? {},
						};
		}
		const owed = Object.keys(table).length;
		if (owed > NOT_FOUND_TRACKED_MAX) {
			throw new Error(
				`${owed} listed conversations are owed a detail read after http 404 or 410, more than the ${NOT_FOUND_TRACKED_MAX} the messages cursor keeps; the run fails rather than drop any`,
			);
		}
		return table;
	}
}

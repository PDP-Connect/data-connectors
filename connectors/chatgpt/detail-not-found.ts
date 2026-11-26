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
 * A run that requested the detail of at least this many first-sight
 * conversations (ones the cursor did not already owe), each counted once, and
 * got 404/410 for every one is an account or session failure, not an account
 * whose conversations were all deleted. Retries of owed conversations do not
 * count: they stay owed either way.
 */
export const NOT_FOUND_GUARD_MIN_DETAILS = 3;

/**
 * The longest conversation id the cursor keeps. ChatGPT ids are 36-character
 * UUIDs; the bound keeps one entry small whatever the source sends.
 */
export const NOT_FOUND_ID_MAX_LENGTH = 64;

const OWED_ID = new RegExp(`^[A-Za-z0-9_:.-]{1,${NOT_FOUND_ID_MAX_LENGTH}}$`);

/**
 * What the cursor keeps: the owed conversation ids, oldest first. A detail is
 * fetched by id alone and every emitted record key derives from the id and the
 * detail, so nothing else is stored: no title or other conversation content.
 */
export type NotFoundTable = string[];

/**
 * The stored obligations, as ids. Reads this shape and the earlier
 * `{ <id>: { n, first_seen, item } }` object, whose ids stay owed and whose
 * counters and list item (title included) are dropped. Anything else is empty.
 * `unkept` counts stored entries the id bound rejects (a cursor written before
 * the bound); they are never fetched or dropped, and the run fails on them.
 */
export function readNotFoundTable(value: unknown): {
	ids: Set<string>;
	unkept: number;
} {
	const stored = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? Object.keys(value)
			: [];
	const ids = stored.filter(
		(id): id is string => typeof id === "string" && OWED_ID.test(id),
	);
	return { ids: new Set(ids), unkept: stored.length - ids.length };
}

/** One run's view of the obligations: what it inherited and what it saw. */
export class DetailNotFoundTracker {
	readonly prior: ReadonlySet<string>;
	/** Stored entries the id bound rejects; the run fails rather than drop them. */
	private readonly unkeptPrior: number;
	/** Ids whose detail answered 404/410 this run. */
	private readonly answered = new Set<string>();
	/** Ids whose detail this run read to a settled outcome (hydrated or unrepresentable). */
	private readonly read = new Set<string>();
	/** First-sight conversations (not owed before this run) whose detail this run requested. */
	private readonly fresh = new Set<string>();

	constructor(stored: unknown) {
		const { ids, unkept } = readNotFoundTable(stored);
		this.prior = ids;
		this.unkeptPrior = unkept;
	}

	/** A messages-pass detail answered `status` for a conversation. */
	recordDetail(id: string, status: number): void {
		const notFound = status === 404 || status === 410;
		if (!this.prior.has(id)) {
			this.fresh.add(id);
		}
		if (notFound) {
			this.answered.add(id);
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
		return [...this.prior]
			.filter(
				(id) => !skip.has(id) && !this.answered.has(id) && !this.read.has(id),
			)
			.map((id) => ({ id }));
	}

	/**
	 * The table the next run inherits: every obligation this run did not read
	 * cleanly. Throws, before any messages STATE, when the run looks like a
	 * session failure or would leave more than NOT_FOUND_TRACKED_MAX owed.
	 */
	finish(): NotFoundTable {
		// Each conversation counts once, however many times this run asked for it.
		if (
			this.fresh.size >= NOT_FOUND_GUARD_MIN_DETAILS &&
			[...this.fresh].every((id) => this.answeredNotFound(id))
		) {
			throw new Error(
				`every conversation detail this run requested (${this.fresh.size}, not counting retries of earlier 404s) answered http 404 or 410; the session cannot read this account's conversations`,
			);
		}
		const table = [...new Set([...this.prior, ...this.answered])].filter(
			(id) => !this.read.has(id),
		);
		const unkept =
			table.filter((id) => !OWED_ID.test(id)).length + this.unkeptPrior;
		if (unkept > 0) {
			throw new Error(
				`${unkept} listed conversation(s) answered http 404 or 410 with an id the messages cursor cannot keep (over ${NOT_FOUND_ID_MAX_LENGTH} characters or not [A-Za-z0-9_:.-]); the run fails rather than drop it`,
			);
		}
		const owed = table.length;
		if (owed > NOT_FOUND_TRACKED_MAX) {
			throw new Error(
				`${owed} listed conversations are owed a detail read after http 404 or 410, more than the ${NOT_FOUND_TRACKED_MAX} the messages cursor keeps; the run fails rather than drop any`,
			);
		}
		return table;
	}
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record contracts for the Perplexity connector's two streams, plus the
 * raw-API shapes `parsers.ts` reads. Everything raw stays `unknown` at the
 * boundary; only the parsers turn raw values into the typed records here,
 * and `schemas.ts` is the last gate before emit.
 */

/** One web citation behind an assistant answer. */
export interface Citation {
	readonly title: string | null;
	readonly url: string | null;
}

/** A `conversations` record: one thread from the owner's library list. */
export interface ConversationRecord {
	readonly id: string;
	readonly title: string | null;
	readonly slug: string | null;
	readonly mode: string | null;
	readonly model: string | null;
	readonly create_time: string | null;
	readonly update_time: string | null;
	readonly entry_count: number | null;
	readonly access: number | null;
}

/** A `messages` record: one side (question or answer) of one entry. */
export interface MessageRecord {
	readonly id: string;
	readonly conversation_id: string;
	readonly role: "user" | "assistant";
	readonly content: string | null;
	readonly create_time: string | null;
	readonly model: string | null;
	readonly citations: readonly Citation[];
}

/**
 * One library-list page as the parsers hand it to the collector. `items` are
 * the raw thread objects, untouched: every field is read later by
 * `buildConversationRecord`, which fails closed per item.
 */
export interface ThreadListPage {
	readonly items: readonly unknown[];
	/** `has_next_page` of the page's LAST item; an empty page is a complete list. */
	readonly hasNextPage: boolean;
}

/** One thread-detail response, already proven to carry an entries array. */
export interface ThreadDetailPage {
	readonly entries: readonly unknown[];
	readonly hasNextPage: boolean;
}

/** The two records one entry splits into, with its first creation time. */
export interface EntryMessages {
	readonly user: MessageRecord | null;
	readonly assistant: MessageRecord | null;
	/** The entry's creation time, the best proxy for the thread's create time. */
	readonly firstCreateTime: string | null;
}

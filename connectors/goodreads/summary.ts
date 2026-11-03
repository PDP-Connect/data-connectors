// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The `usage_summary` record: exact aggregates over the whole library
 * listing. Pure; it holds no titles, authors or text, only counts and dates.
 */

import type { BookRecord } from "./types.ts";

export type Tally = Record<string, number>;

export interface UsageSummary {
	average_rating_given: number | null;
	books_added_by_year: Tally;
	books_finished_by_year: Tally;
	books_total: number;
	by_exclusive_shelf: Tally;
	coverage: {
		books_listed: number;
		books_with_finish_date: number;
		list_pages: number;
		listing_complete: boolean;
	};
	first_added_on: string | null;
	first_finished_on: string | null;
	formats: Tally;
	id: "usage_summary";
	last_added_on: string | null;
	last_finished_on: string | null;
	owned_count: number;
	pages_finished_by_year: Tally;
	rated_count: number;
	rating_histogram: {
		"1": number;
		"2": number;
		"3": number;
		"4": number;
		"5": number;
	};
	reread_books: number;
	reviewed_count: number;
}

/** The shelf key for a book with no exclusive shelf. */
export const NO_SHELF_KEY = "none";

/** A tally with no prototype, so a shelf or format named `constructor` or `__proto__` counts like any other. */
function emptyTally(): Tally {
	return Object.create(null) as Tally;
}

function bump(tally: Tally, key: string, by = 1): void {
	tally[key] = (Object.hasOwn(tally, key) ? (tally[key] ?? 0) : 0) + by;
}

function sorted(tally: Tally): Tally {
	return Object.fromEntries(
		Object.entries(tally).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
	);
}

function extremes(values: string[]): [string | null, string | null] {
	if (values.length === 0) return [null, null];
	let low = "";
	let high = "";
	for (const [index, value] of values.entries()) {
		if (index === 0 || value < low) low = value;
		if (index === 0 || value > high) high = value;
	}
	return [low, high];
}

export function summarizeLibrary(
	books: readonly BookRecord[],
	listing: { listPages: number; listingComplete: boolean },
): UsageSummary {
	const byShelf = emptyTally();
	const formats = emptyTally();
	const addedByYear = emptyTally();
	const finishedByYear = emptyTally();
	const pagesByYear = emptyTally();
	const histogram = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
	const addedDates: string[] = [];
	const finishDates: string[] = [];
	let ratingSum = 0;
	let rated = 0;
	let reviewed = 0;
	let rereads = 0;
	let owned = 0;
	let withFinish = 0;

	for (const book of books) {
		bump(byShelf, book.exclusive_shelf ?? NO_SHELF_KEY);
		if (book.format) bump(formats, book.format);
		if (book.owned === true) owned += 1;
		if (book.has_review) reviewed += 1;
		if ((book.read_count ?? 0) > 1) rereads += 1;
		if (book.rating !== null && book.rating >= 1 && book.rating <= 5) {
			rated += 1;
			ratingSum += book.rating;
			histogram[String(book.rating) as keyof typeof histogram] += 1;
		}
		if (book.added_on) {
			addedDates.push(book.added_on);
			bump(addedByYear, book.added_on.slice(0, 4));
		}
		for (const session of book.reading_sessions) {
			if (session.finished_on) finishDates.push(session.finished_on);
		}
		if (book.finished_on) {
			withFinish += 1;
			const year = book.finished_on.slice(0, 4);
			bump(finishedByYear, year);
			if (book.num_pages) bump(pagesByYear, year, book.num_pages);
		}
	}
	const [firstAdded, lastAdded] = extremes(addedDates);
	const [firstFinished, lastFinished] = extremes(finishDates);
	return {
		average_rating_given:
			rated === 0 ? null : Math.round((ratingSum / rated) * 100) / 100,
		books_added_by_year: sorted(addedByYear),
		books_finished_by_year: sorted(finishedByYear),
		books_total: books.length,
		by_exclusive_shelf: sorted(byShelf),
		coverage: {
			books_listed: books.length,
			books_with_finish_date: withFinish,
			list_pages: listing.listPages,
			listing_complete: listing.listingComplete,
		},
		first_added_on: firstAdded,
		first_finished_on: firstFinished,
		formats: sorted(formats),
		id: "usage_summary",
		last_added_on: lastAdded,
		last_finished_on: lastFinished,
		owned_count: owned,
		pages_finished_by_year: sorted(pagesByYear),
		rated_count: rated,
		rating_histogram: histogram,
		reread_books: rereads,
		reviewed_count: reviewed,
	};
}

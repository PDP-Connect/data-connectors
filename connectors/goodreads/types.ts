// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared types for the Goodreads browser connector. Kept out of index.ts so the
// pure parsers and the usage summary can import them without pulling in the
// Playwright-facing runtime entry point.

export interface BookAuthor {
	author_id: string | null;
	is_goodreads_author: boolean;
	name: string;
}

export interface ReadingSession {
	finished_on: string | null;
	session_id: string | null;
	started_on: string | null;
}

/** One library row, in the shape of the `books` stream. */
export interface BookRecord {
	added_on: string | null;
	asin: string | null;
	author: string | null;
	authors: BookAuthor[];
	average_rating: number | null;
	book_id: string;
	book_url: string | null;
	comments_count: number | null;
	cover_url: string | null;
	edition_publication_date: string | null;
	exclusive_shelf: string | null;
	/** finished_on when it is a whole day (YYYY-MM-DD), else null. */
	finished_date: string | null;
	finished_on: string | null;
	format: string | null;
	has_review: boolean;
	id: string;
	isbn: string | null;
	isbn13: string | null;
	likes_count: number | null;
	num_pages: number | null;
	original_publication_date: string | null;
	owned: boolean | null;
	position: number | null;
	private_notes: string | null;
	rating: number | null;
	ratings_count: number | null;
	read_count: number | null;
	reading_sessions: ReadingSession[];
	review_text: string | null;
	shelves: string[];
	/** started_on when it is a whole day (YYYY-MM-DD), else null. */
	started_date: string | null;
	started_on: string | null;
	title: string | null;
}

export interface ShelfRecord {
	book_count: number | null;
	exclusive: boolean;
	id: string;
	name: string;
	url: string;
}

/** What one page of the print library list says. */
export interface ListingPage {
	/** `#reviewPagination` offers a next page. */
	hasNextPage: boolean;
	/** "N of TOTAL loaded": N, when the page carries the status line. */
	loaded: number | null;
	/** The list printed its "No matching items!" notice. */
	noMatchingItems: boolean;
	/** The page has the library table at all. False means a page this parser does not know. */
	recognised: boolean;
	rows: BookRecord[];
	/** "N of TOTAL loaded": TOTAL, when the page carries the status line. */
	total: number | null;
	/** Rows that could not be turned into a record (no review id or book id). */
	unreadableRows: number;
}

export interface SidebarInfo {
	/** The sidebar's "All (N)" count. */
	allCount: number | null;
	/** The sidebar shows a next-page or "more" link: the shelves are only part of the list. */
	continues: boolean;
	shelves: ShelfRecord[];
}

export interface ProfileFacts {
	average_rating: number | null;
	books_count: number | null;
	friends_count: number | null;
	joined_on: string | null;
	last_active: string | null;
	ratings_count: number | null;
	reviews_count: number | null;
	shelves_count: number | null;
}

export type VisibilityChoice = "everyone" | "members" | "friends";

export interface SettingsFacts {
	allow_followers: boolean | null;
	allow_nonfriend_review_comments: boolean | null;
	country: string | null;
	favorite_genres: string[];
	linked_sign_in: {
		amazon: boolean | null;
		apple: boolean | null;
		google: boolean | null;
	};
	locale: string | null;
	profile_visibility: VisibilityChoice | null;
	searchable_by_email: boolean | null;
}

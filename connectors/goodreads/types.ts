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

export interface BookSeries {
	placement: string | null;
	title: string;
}

/**
 * The fields of a `books` record that come from Goodreads' book API rather
 * than the print list. The two are joined on `book_id`.
 */
export interface BookApiFields {
	/** When the book was put on the shelves, an instant (ISO 8601, UTC). */
	added_at: string | null;
	genres: string[];
	language: string | null;
	publisher: string | null;
	review_created_at: string | null;
	review_has_spoilers: boolean | null;
	review_updated_at: string | null;
	series: BookSeries[];
	/** When the shelving last changed: shelf, tags, rating or dates. */
	updated_at: string | null;
}

/** One library row of the print list, before the book API fields are joined in. */
export interface PrintBookRecord {
	/** The day the book was added, as the print list shows it (the owner's time zone). */
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

/** One record of the `books` stream. */
export type BookRecord = PrintBookRecord & BookApiFields;

export interface ShelfRecord {
	book_count: number | null;
	exclusive: boolean;
	id: string;
	name: string;
	url: string | null;
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
	rows: PrintBookRecord[];
	/** "N of TOTAL loaded": TOTAL, when the page carries the status line. */
	total: number | null;
	/** Rows that could not be turned into a record (no review id or book id). */
	unreadableRows: number;
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

/** One book in the owner's Kindle notes list (`/notes/<id>/load_more`). */
export interface AnnotatedBook {
	asin: string | null;
	author: string | null;
	/** Path of the book's notes page, `/notes/<book id>-<slug>/<owner id>-<slug>`. */
	notesPath: string;
	title: string | null;
}

/** One page of the Kindle notes list. */
export interface AnnotatedBooksPage {
	books: AnnotatedBook[];
	/** The token for the next page; null on the last one. */
	nextToken: string | null;
}

/** One highlight, note, or highlight with a note, as a book's notes page shows it. */
export interface ReadingNote {
	highlight_id: string | null;
	highlight_text: string | null;
	/** Where the item sits in the book, as the page prints it ("37%"). */
	location: string | null;
	location_percent: number | null;
	note_id: string | null;
	note_text: string | null;
	shared: boolean | null;
	spoiler: boolean | null;
}

/** What one book's notes page says. */
export interface ReadingNotesPage {
	author: string | null;
	bookId: string | null;
	bookTitle: string | null;
	notes: ReadingNote[];
	/** The page has the notes column and its count banner. False means a page this parser does not know. */
	recognised: boolean;
	/** The banner's count of every highlight and note of the book. */
	total: number | null;
	/** Items that could not be read: no id, another book's id, or neither highlight nor note text. */
	unreadable: number;
}

/** One record of the `highlights` stream. */
export interface HighlightRecord {
	asin: string | null;
	author: string | null;
	book_id: string;
	book_title: string | null;
	highlight_id: string | null;
	highlight_text: string | null;
	id: string;
	location: string | null;
	location_percent: number | null;
	note_id: string | null;
	note_text: string | null;
	notes_url: string;
	position: number;
	shared: boolean | null;
	spoiler: boolean | null;
}

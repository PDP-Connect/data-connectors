// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	normalizePartialDate,
	parseListingPage,
	parseProfile,
	parseSettings,
	parseSidebar,
	tenureMonths,
	userIdFromHtml,
	userIdFromUrl,
} from "./parsers.ts";
import { summarizeLibrary } from "./summary.ts";
import type { BookRecord } from "./types.ts";

// Every page under fixtures/html is synthetic: the markup shape of the real
// pages with invented books, people and ids. See fixtures/README.md.
const fixture = (name: string): string =>
	readFileSync(new URL(`./fixtures/html/${name}`, import.meta.url), "utf8");

const page1 = parseListingPage(fixture("library-page-1.html"));
const page2 = parseListingPage(fixture("library-page-2.html"));
const books: BookRecord[] = [...page1.rows, ...page2.rows];

function book(id: string): BookRecord {
	const found = books.find((candidate) => candidate.id === id);
	assert.ok(found, `fixture book ${id} is present`);
	return found;
}

test("partial dates keep the precision Goodreads printed", () => {
	assert.equal(normalizePartialDate("Aug 27, 2023"), "2023-08-27");
	assert.equal(normalizePartialDate("August 7, 2023"), "2023-08-07");
	assert.equal(normalizePartialDate("Dec 01, 1963"), "1963-12-01");
	assert.equal(normalizePartialDate("Feb 2022"), "2022-02");
	assert.equal(normalizePartialDate("September 2019"), "2019-09");
	assert.equal(normalizePartialDate("1892"), "1892");
	assert.equal(normalizePartialDate("2023-08-27"), "2023-08-27");
	assert.equal(normalizePartialDate("unknown"), null);
	assert.equal(normalizePartialDate("not set"), null);
	assert.equal(normalizePartialDate("  "), null);
	assert.equal(normalizePartialDate("Smarch 3, 2020"), null);
	assert.equal(normalizePartialDate(null), null);
});

test("a first page reads every row and says a next page exists", () => {
	assert.equal(page1.recognised, true);
	assert.equal(page1.rows.length, 3);
	assert.equal(page1.unreadableRows, 0);
	assert.equal(page1.hasNextPage, true);
	assert.equal(page1.loaded, 3);
	assert.equal(page1.total, 5);
});

test("the last page has no next link and the same total", () => {
	assert.equal(page2.rows.length, 2);
	assert.equal(page2.hasNextPage, false);
	assert.equal(page2.loaded, 2);
	assert.equal(page2.total, 5);
});

test("a page past the end has no rows and the no-matching-items notice", () => {
	const past = parseListingPage(fixture("library-no-rows.html"));
	assert.equal(past.recognised, true);
	assert.equal(past.rows.length, 0);
	assert.equal(past.noMatchingItems, true);
	assert.equal(past.hasNextPage, false);
	assert.equal(past.total, null);
});

test("a page without the library table is not recognised, never empty", () => {
	for (const html of [
		fixture("signin.html"),
		"",
		"<html><body>x</body></html>",
	]) {
		const parsed = parseListingPage(html);
		assert.equal(parsed.recognised, false);
		assert.equal(parsed.rows.length, 0);
	}
});

test("a rated book keeps its stars; an unrated book is null, not zero", () => {
	assert.equal(book("90100001").rating, 5);
	assert.equal(book("90100002").rating, null);
	assert.equal(book("90100003").rating, 3);
});

test("a book with several authors keeps them in order, with the Goodreads Author marker", () => {
	const one = book("90100001");
	assert.deepEqual(one.authors, [
		{
			author_id: "7000001",
			is_goodreads_author: true,
			name: "Marlowe, Ines",
		},
	]);
	const two = book("90100002");
	assert.deepEqual(
		two.authors.map((author) => [author.name, author.is_goodreads_author]),
		[
			["Okafor, Dayo", false],
			["Brandt, Lena", false],
		],
	);
	assert.equal(two.author, "Okafor, Dayo");
});

test("a review keeps its full text with line breaks; no review is null", () => {
	const reviewed = book("90100001");
	assert.equal(reviewed.has_review, true);
	assert.equal(
		reviewed.review_text,
		"A patient, salty novel about maps. First paragraph of the synthetic review.\n\nSecond paragraph, after a blank line.\nThird line, single break.",
	);
	const unreviewed = book("90100002");
	assert.equal(unreviewed.has_review, false);
	assert.equal(unreviewed.review_text, null);
});

test("private notes: text is kept, None is null", () => {
	assert.equal(
		book("90100001").private_notes,
		"Lend to the book club.\nReturn by spring.",
	);
	assert.equal(book("90100002").private_notes, null);
});

test("several reading sessions pair their start and finish by session id", () => {
	const one = book("90100001");
	assert.deepEqual(one.reading_sessions, [
		{
			finished_on: "2021-03-19",
			session_id: "0a1b2c3d-1111-4222-8333-444455556661",
			started_on: "2021-03-03",
		},
		{
			finished_on: "2022",
			session_id: "0a1b2c3d-1111-4222-8333-444455556662",
			started_on: "2022-02",
		},
	]);
	assert.equal(one.started_on, "2022-02");
	assert.equal(one.finished_on, "2022");
	assert.equal(one.read_count, 2);
});

test("sessions with no dates, and unsaved empty sessions, are dropped", () => {
	assert.deepEqual(book("90100002").reading_sessions, []);
	const reading = book("90100003");
	assert.deepEqual(reading.reading_sessions, [
		{
			finished_on: null,
			session_id: "0a1b2c3d-1111-4222-8333-444455556664",
			started_on: "2026-10-09",
		},
	]);
	assert.equal(reading.started_on, "2026-10-09");
	assert.equal(reading.finished_on, null);
});

test("a session with only a finish year or only a month keeps that precision", () => {
	assert.deepEqual(book("90100004").reading_sessions, [
		{
			finished_on: "2019",
			session_id: "0a1b2c3d-1111-4222-8333-444455556665",
			started_on: null,
		},
	]);
	assert.equal(book("90100005").started_on, "2025-12");
	assert.equal(book("90100005").finished_on, "2025-12");
});

test("publication dates: partial, full and unknown", () => {
	const one = book("90100001");
	assert.equal(one.original_publication_date, "1992-06");
	assert.equal(one.edition_publication_date, "2023-08-06");
	const two = book("90100002");
	assert.equal(two.original_publication_date, null);
	assert.equal(two.edition_publication_date, "1892");
	assert.equal(book("90100003").original_publication_date, "2019");
});

test("date added comes from the title attribute as a calendar day", () => {
	assert.equal(book("90100001").added_on, "2021-03-05");
	assert.equal(book("90100005").added_on, "2025-12-31");
});

test("the exclusive shelf comes from the shelf= link, tags from tag=", () => {
	const one = book("90100001");
	assert.equal(one.exclusive_shelf, "read");
	assert.deepEqual(one.shelves, ["read", "favorites-synthetic"]);
	assert.equal(book("90100004").exclusive_shelf, "abandoned");
	assert.deepEqual(book("90100004").shelves, ["abandoned", "winter-list"]);
});

test("identifiers, counts and edition facts", () => {
	const two = book("90100002");
	assert.equal(two.book_id, "80000002");
	assert.equal(
		two.book_url,
		"https://www.goodreads.com/book/show/80000002-salt-roads-and-small-rivers",
	);
	assert.equal(two.isbn, null);
	assert.equal(two.isbn13, "9780000000002");
	assert.equal(two.asin, "B000000002");
	assert.equal(two.num_pages, 1234);
	assert.equal(two.ratings_count, 12_345);
	assert.equal(two.average_rating, 3.87);
	assert.equal(two.position, 4);
	assert.equal(book("90100003").isbn, "080442957X");
	assert.equal(book("90100004").num_pages, null);
	const zeroPages = parseListingPage(
		fixture("library-page-1.html").replace(/\n\s*1,234\n/, "\n        0\n"),
	).rows.find((candidate) => candidate.id === "90100002");
	assert.equal(zeroPages?.num_pages, null, 'a printed "0 pp" is no page count');
	assert.match(two.cover_url ?? "", /^https:\/\/i\.gr-assets\.com\//);
});

test("owned, format, comments and likes", () => {
	const one = book("90100001");
	assert.equal(one.owned, true);
	assert.equal(one.format, "Hardcover");
	assert.equal(one.comments_count, 2);
	assert.equal(one.likes_count, 3);
	assert.equal(book("90100002").owned, false);
	assert.equal(book("90100002").format, null);
	assert.equal(book("90100003").format, "Kindle Edition");
});

test("a row with no review id or no book id is counted unreadable, not guessed", () => {
	const html = fixture("library-page-2.html")
		.replace('id="review_90100004"', 'id="row_4"')
		.replace(
			/\/book\/show\/80000005-notes-toward-an-unfinished-map/g,
			"/elsewhere",
		)
		.replace('data-resource-id="80000005"', 'data-resource-id=""');
	const parsed = parseListingPage(html);
	assert.equal(parsed.rows.length, 0);
	assert.equal(parsed.unreadableRows, 2);
});

test("the sidebar gives the total, exclusive shelves and tags with counts", () => {
	const sidebar = parseSidebar(fixture("library-sidebar.html"), "90000001");
	assert.equal(sidebar.allCount, 5);
	assert.deepEqual(
		sidebar.shelves.map((shelf) => [
			shelf.id,
			shelf.name,
			shelf.exclusive,
			shelf.book_count,
		]),
		[
			["to-read", "Want to Read", true, 1],
			["currently-reading", "Currently Reading", true, 1],
			["read", "Read", true, 2],
			["abandoned", "Abandoned", true, 1],
			["winter-list", "winter-list", false, 2],
			["favorites-synthetic", "favorites-synthetic", false, 1],
		],
	);
	assert.equal(
		sidebar.shelves[0]?.url,
		"https://www.goodreads.com/review/list/90000001?shelf=to-read",
	);
	assert.equal(
		sidebar.shelves[4]?.url,
		"https://www.goodreads.com/review/list/90000001?tag=winter-list",
	);
	// The shelf counts in the sidebar add up to the "All" count.
	const exclusiveTotal = sidebar.shelves
		.filter((shelf) => shelf.exclusive)
		.reduce((sum, shelf) => sum + (shelf.book_count ?? 0), 0);
	assert.equal(exclusiveTotal, sidebar.allCount);
});

test("the sidebar says when its shelf list goes on past what it shows", () => {
	const html = fixture("library-sidebar.html");
	assert.equal(parseSidebar(html, "90000001").continues, false);
	for (const more of [
		'<a href="/review/list/90000001?shelves_page=2&amp;page=2">next</a>',
		'<a class="next_page" href="#">Next</a>',
		'<a href="#" onclick="return false">more shelves...</a>',
	]) {
		const paged = html.replace(
			'<div class="horizontalGreyDivider"></div>',
			`<div class="horizontalGreyDivider"></div>${more}`,
		);
		assert.equal(parseSidebar(paged, "90000001").continues, true, more);
	}
});

test("the All count is found when the selected shelf is not All", () => {
	const html = fixture("library-sidebar.html").replace(
		'<a class="selectedShelf" href="/review/list/90000001?shelf=%23ALL%23">All (5)</a>',
		'<a class="selectedShelf" href="/review/list/90000001?shelf=read">Read (2)</a><a href="/review/list/90000001?shelf=%23ALL%23">All (5)</a>',
	);
	assert.equal(parseSidebar(html, "90000001").allCount, 5);
});

test("an empty library's sidebar says All (0)", () => {
	const sidebar = parseSidebar(
		fixture("library-sidebar-empty.html"),
		"90000001",
	);
	assert.equal(sidebar.allCount, 0);
	assert.equal(sidebar.shelves.length, 3);
});

test("the owner id comes from the redirect URL, else from the signed-in header", () => {
	assert.equal(
		userIdFromUrl(
			"https://www.goodreads.com/review/list/90000001-synthetic-reader",
		),
		"90000001",
	);
	assert.equal(userIdFromUrl("https://www.goodreads.com/user/sign_in"), null);
	assert.equal(userIdFromHtml(fixture("library-sidebar.html")), "90000001");
	// A signed-out page has no sign-out link, so it names nobody.
	assert.equal(userIdFromHtml(fixture("signin.html")), null);
});

test("profile stats, activity line, friends count and shelf counts", () => {
	const profile = parseProfile(fixture("profile.html"));
	assert.deepEqual(profile, {
		average_rating: 3.8,
		books_count: 5,
		friends_count: 4,
		joined_on: "2019-03",
		last_active: "this month",
		ratings_count: 42,
		reviews_count: 7,
		shelves_count: 6,
	});
	// Identity text on the page never reaches the facts.
	assert.doesNotMatch(JSON.stringify(profile), /Synthetic Reader|Testland/);
});

test("a page that is not a profile parses to null", () => {
	assert.equal(parseProfile(fixture("signin.html")), null);
});

test("tenure is whole months from the join month", () => {
	assert.equal(tenureMonths("2019-03", new Date("2026-11-03T00:00:00Z")), 92);
	assert.equal(tenureMonths("2026-11", new Date("2026-11-03T00:00:00Z")), 0);
	assert.equal(tenureMonths(null, new Date()), null);
	assert.equal(tenureMonths("2030-01", new Date("2026-11-03T00:00:00Z")), null);
});

test("settings: country, language, visibility, toggles, providers, genres", () => {
	const settings = parseSettings(fixture("settings.html"));
	assert.deepEqual(settings, {
		allow_followers: true,
		allow_nonfriend_review_comments: false,
		country: "NZ",
		favorite_genres: ["Mystery", "Poetry"],
		linked_sign_in: { amazon: true, apple: false, google: false },
		locale: "fr",
		profile_visibility: "everyone",
		searchable_by_email: true,
	});
	assert.doesNotMatch(JSON.stringify(settings), /example\.invalid/);
});

test("settings: inline scripts that say checked do not count, attributes do", () => {
	// The fixture's inline script and its onclick handlers mention
	// checked on every radio; only the attribute decides.
	const members = fixture("settings.html")
		.replace(
			' checked="checked" name="user_preference[visibility]"',
			' name="user_preference[visibility]"',
		)
		.replace(
			'type="radio" value="M" name',
			'type="radio" value="M" checked="checked" name',
		);
	assert.equal(parseSettings(members)?.profile_visibility, "members");
});

test("settings: followers is null when the visibility choice disables it", () => {
	const friendsOnly = fixture("settings.html")
		.replace(
			' checked="checked" name="user_preference[visibility]"',
			' name="user_preference[visibility]"',
		)
		.replace(
			'type="radio" value="P" name',
			'type="radio" value="P" checked="checked" name',
		)
		.replace(
			'id="user_preference_allow_followers"',
			'id="user_preference_allow_followers" disabled="disabled"',
		);
	const settings = parseSettings(friendsOnly);
	assert.equal(settings?.profile_visibility, "friends");
	assert.equal(settings?.allow_followers, null);
});

test("settings: a provider the page does not mention is null, a linked one is true", () => {
	const noApple = fixture("settings.html").replace(
		/<div id="apple".*?<\/div>\n/s,
		"",
	);
	assert.equal(parseSettings(noApple)?.linked_sign_in.apple, null);
	assert.equal(parseSettings(noApple)?.linked_sign_in.amazon, true);
});

test("a page that is not settings parses to null", () => {
	assert.equal(parseSettings(fixture("signin.html")), null);
});

test("the usage summary counts the whole listing and holds no titles", () => {
	const summary = summarizeLibrary(books, {
		listPages: 3,
		listingComplete: true,
	});
	assert.deepEqual(summary, {
		average_rating_given: 3.5,
		books_added_by_year: { "2019": 1, "2021": 1, "2025": 1, "2026": 2 },
		books_finished_by_year: { "2019": 1, "2022": 1, "2025": 1 },
		books_total: 5,
		by_exclusive_shelf: {
			abandoned: 1,
			"currently-reading": 1,
			read: 2,
			"to-read": 1,
		},
		coverage: {
			books_listed: 5,
			books_with_finish_date: 3,
			list_pages: 3,
			listing_complete: true,
		},
		first_added_on: "2019-01-02",
		first_finished_on: "2019",
		formats: { Audiobook: 1, Hardcover: 2, "Kindle Edition": 1 },
		id: "usage_summary",
		last_added_on: "2026-10-09",
		last_finished_on: "2025-12",
		owned_count: 2,
		pages_finished_by_year: { "2022": 312, "2025": 96 },
		rated_count: 4,
		rating_histogram: { "1": 0, "2": 1, "3": 1, "4": 1, "5": 1 },
		reread_books: 1,
		reviewed_count: 1,
	});
	assert.doesNotMatch(JSON.stringify(summary), /Lighthouse|Marlowe/);
});

test("the usage summary of an empty library is all zeros and nulls", () => {
	const summary = summarizeLibrary([], { listPages: 1, listingComplete: true });
	assert.equal(summary.books_total, 0);
	assert.equal(summary.average_rating_given, null);
	assert.equal(summary.first_added_on, null);
	assert.equal(summary.last_finished_on, null);
	assert.deepEqual(summary.by_exclusive_shelf, {});
});

test("a shelf or format named like an Object property counts like any other", () => {
	const named = (shelf: string, format: string): BookRecord => ({
		...(books[0] as BookRecord),
		exclusive_shelf: shelf,
		format,
	});
	const summary = summarizeLibrary(
		[
			named("constructor", "__proto__"),
			named("constructor", "toString"),
			named("__proto__", "__proto__"),
		],
		{ listPages: 1, listingComplete: true },
	);
	// Compared as JSON text: an object literal cannot hold an own `__proto__` key.
	assert.equal(
		JSON.stringify(summary.by_exclusive_shelf),
		'{"__proto__":1,"constructor":2}',
	);
	assert.equal(JSON.stringify(summary.formats), '{"__proto__":2,"toString":1}');
});

test("finished_date and started_date hold a whole day only, so they can be filtered", () => {
	const fullDay = /^\d{4}-\d{2}-\d{2}$/;
	let partial = 0;
	for (const book of books) {
		for (const [day, on] of [
			[book.finished_date, book.finished_on],
			[book.started_date, book.started_on],
		] as const) {
			assert.equal(day, on !== null && fullDay.test(on) ? on : null);
			if (on !== null && !fullDay.test(on)) partial += 1;
		}
	}
	// The fixtures hold both kinds, so both branches ran.
	assert.ok(partial > 0);
	assert.ok(books.some((book) => book.started_date !== null));
});

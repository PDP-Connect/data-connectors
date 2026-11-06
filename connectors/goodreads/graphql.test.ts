// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { parseShelfNode, parseShelvingNode, readNextData } from "./graphql.ts";

const node = (overrides: Record<string, unknown> = {}) => ({
	book: { legacyId: 80000001 },
	createdAt: 1614967200000,
	...overrides,
});

test("a shelving needs a numeric book id and a date added; the rest may be missing", () => {
	assert.deepEqual(parseShelvingNode(node()), {
		addedAtMs: 1614967200000,
		bookId: "80000001",
		genres: [],
		language: null,
		publisher: null,
		review: null,
		series: [],
		shelf: null,
		tags: [],
		updatedAtMs: null,
	});
	// Epoch milliseconds may come as a string of digits.
	assert.equal(
		parseShelvingNode(node({ createdAt: "1614967200000" }))?.addedAtMs,
		1614967200000,
	);
	for (const broken of [
		node({ createdAt: null }),
		node({ createdAt: "2021-03-05" }),
		node({ book: { legacyId: "abc" } }),
		node({ book: null }),
		null,
		"x",
	]) {
		assert.equal(parseShelvingNode(broken), null, JSON.stringify(broken));
	}
});

test("a review's rating outside 1 to 5 is no rating; a review without a spoiler flag says null", () => {
	const review = (value: Record<string, unknown>) =>
		parseShelvingNode(node({ review: value }))?.review;
	assert.equal(review({ rating: 0 })?.rating, null);
	assert.equal(review({ rating: 4 })?.rating, 4);
	assert.equal(review({ rating: 4.5 })?.rating, null);
	assert.equal(review({ rating: 3 })?.hasSpoilers, null);
	assert.equal(review({ spoilerStatus: false })?.hasSpoilers, false);
});

test("names, genres and series skip entries without text", () => {
	const parsed = parseShelvingNode(
		node({
			book: {
				bookGenres: [{ genre: { name: "Fantasy" } }, { genre: {} }, null],
				bookSeries: [
					{ seriesPlacement: " 2 ", series: { title: "Atlas" } },
					{ seriesPlacement: "3", series: { title: "  " } },
				],
				legacyId: 80000001,
			},
			shelf: { name: "read" },
			taggings: [{ tag: { name: "winter-list" } }, { tag: null }],
		}),
	);
	assert.deepEqual(parsed?.genres, ["Fantasy"]);
	assert.deepEqual(parsed?.series, [{ placement: "2", title: "Atlas" }]);
	assert.deepEqual(parsed?.tags, ["winter-list"]);
	assert.equal(parsed?.shelf, "read");
});

test("a shelf needs a name", () => {
	assert.deepEqual(
		parseShelfNode({ name: "to-read", displayName: "Want to Read" }),
		{
			displayName: "Want to Read",
			name: "to-read",
			url: null,
		},
	);
	assert.equal(parseShelfNode({ displayName: "x" }), null);
});

test("the book page's __NEXT_DATA__: a session, signed out, or nothing usable", () => {
	const text = (pageProps: unknown) => JSON.stringify({ props: { pageProps } });
	const claims = JSON.stringify({ exp: 4102444800, user_id: 90000001 });
	const signedIn = {
		authContextParams: { customerId: "amzn1.account.X", signedIn: true },
		jwtToken: "a.b.c",
	};
	assert.deepEqual(readNextData({ claims, text: text(signedIn) }), {
		kind: "session",
		session: {
			customerUri: "kca://profile:goodreads/amzn1.account.X",
			expiresAtMs: 4102444800000,
			memberId: "90000001",
			token: "a.b.c",
		},
	});
	assert.equal(
		readNextData({
			claims: null,
			text: text({ authContextParams: { signedIn: false } }),
		}).kind,
		"signed_out",
	);
	for (const [label, reading] of [
		["no script", { claims, text: null }],
		["not JSON", { claims, text: "{" }],
		[
			"no token",
			{ claims, text: text({ authContextParams: { customerId: "X" } }) },
		],
		["no customer id", { claims, text: text({ jwtToken: "a.b.c" }) }],
		["claims without exp", { claims: "{}", text: text(signedIn) }],
	] as const) {
		assert.equal(readNextData(reading).kind, "missing", label);
	}
});

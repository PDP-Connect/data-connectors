// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	type EmittedMessage,
	makeEmitRecord,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	bookRecord,
	createExportReader,
	highlightRecord,
	type ReadwiseBook,
} from "./api.ts";
import { booksSchema, highlightsSchema, validateRecord } from "./schemas.ts";
import { decodeEscapedText, encodeText } from "./text.ts";

// Independent decoder for the declared transport format, not a punctuation guess.
const decodeText = (value: unknown): string => {
	assert.equal(typeof value, "string");
	return String(value).replace(/\\u([0-9a-f]{4})/gi, (token, hex: string) => {
		const unit = Number.parseInt(hex, 16);
		return unit === 0x5c ||
			unit <= 8 ||
			unit === 11 ||
			unit === 12 ||
			(unit >= 14 && unit <= 31) ||
			(unit >= 127 && unit <= 159) ||
			(unit >= 0xd800 && unit <= 0xdfff)
			? String.fromCharCode(unit)
			: token;
	});
};

const BOOK: ReadwiseBook = {
	user_book_id: 123,
	is_deleted: false,
	title: "Some title",
	author: "Some author",
	readable_title: "Some Title",
	source: "kindle",
	cover_image_url: "https://example.com/cover.png",
	unique_url: "",
	book_tags: [{ id: 1, name: "philosophy" }],
	category: "books",
	document_note: "",
	summary: "",
	readwise_url: "https://readwise.io/bookreview/123",
	source_url: "",
	asin: null,
	highlights: [
		{
			id: 456,
			is_deleted: false,
			text: "A synthetic highlight.",
			location: 1,
			location_type: "order",
			note: null,
			color: "yellow",
			highlighted_at: "2022-09-13T16:41:53.186Z",
			created_at: "2022-09-13T16:41:53.186Z",
			updated_at: "2022-09-14T18:50:30.564Z",
			end_location: null,
			url: null,
			book_id: 123,
			tags: [{ id: 2, name: "favorite" }],
			is_favorite: true,
			is_discard: false,
			readwise_url: "https://readwise.io/open/456",
		},
	],
};

test("bookRecord normalizes empties and validates", () => {
	const record = bookRecord(BOOK);
	assert.equal(record.id, "123");
	assert.equal(record.title, "Some Title");
	assert.equal(record.source_url, null);
	assert.deepEqual(record.tags, ["philosophy"]);
	const parsed = booksSchema.safeParse(record);
	assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("highlightRecord denormalizes the book and validates", () => {
	const highlight = BOOK.highlights?.[0];
	assert.ok(highlight);
	const record = highlightRecord(highlight, BOOK);
	assert.equal(record.id, "456");
	assert.equal(record.book_id, "123");
	assert.equal(record.book_title, "Some Title");
	assert.equal(record.book_author, "Some author");
	assert.deepEqual(record.tags, ["favorite"]);
	const parsed = highlightsSchema.safeParse(record);
	assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

test("Readwise matches the canonical pdpp-safe-escape-v1 bytes", () => {
	const { vectors } = JSON.parse(
		readFileSync(
			new URL("../anthropic/safe-escape-vectors.json", import.meta.url),
			"utf8",
		),
	) as { vectors: Array<{ raw: string; encoded: string }> };
	assert.ok(vectors.length > 100);
	for (const { raw, encoded } of vectors) {
		assert.equal(encodeText(raw), encoded, JSON.stringify(raw));
		assert.equal(decodeEscapedText(encoded), raw, JSON.stringify(raw));
	}
});

test("C1 controls in a Readwise highlight survive a RECORD frame", async () => {
	const original =
		"Words \u0092\u0093\u0094 remain; literal \\u0092; curly ’“”; emoji 🚀";
	const record = highlightRecord({ id: 456, text: original }, BOOK);
	const messages: EmittedMessage[] = [];
	const runtime = makeEmitRecord({
		requested: new Map([["highlights", { name: "highlights" }]]),
		emit: async (message) => {
			messages.push(message);
		},
		emittedAt: "2026-11-05T00:00:00Z",
		validateRecord,
		isTombstone: (_, data) => data.is_deleted === true,
		timeRangeFieldFor: () => null,
	});
	await runtime.emit("highlights", record);
	assert.deepEqual(
		messages.map((message) => message.type),
		["RECORD"],
	);
	assert.equal(runtime.counters.totalSkipped, 0);
	assert.equal(record.text_encoding, "pdpp-safe-escape-v1");
	assert.equal(decodeText(record.text), original);
});

test("all Readwise descriptive fields and tags retain their exact text", () => {
	const original =
		"Literal \\u0092 and \\u005C; \u0092\u0093\u0094; emoji 🚀;\tline\nnext";
	const book = {
		...BOOK,
		readable_title: original,
		author: original,
		document_note: original,
		summary: original,
		book_tags: [{ name: original }],
	};
	const bookRow = bookRecord(book);
	const highlightRow = highlightRecord(
		{ id: 456, text: original, note: original, tags: [{ name: original }] },
		book,
	);
	assert.ok(booksSchema.safeParse(bookRow).success);
	assert.ok(highlightsSchema.safeParse(highlightRow).success);
	for (const [row, fields] of [
		[bookRow, ["title", "author", "document_note", "summary"]],
		[highlightRow, ["book_title", "book_author", "text", "note"]],
	] as const) {
		for (const field of fields) assert.equal(decodeText(row[field]), original);
		assert.ok(Array.isArray(row.tags));
		assert.equal(decodeText(row.tags[0]), original);
	}
});

test("safe Unicode is unchanged and control escaping never truncates text at the source limit", () => {
	const plain = "Already ’“” valid — café 漢字 🚀\t\n";
	assert.equal(highlightRecord({ id: 456, text: plain }, BOOK).text, plain);
	const original = `${"x".repeat(99_999)}\u0092`;
	const record = highlightRecord({ id: 456, text: original }, BOOK);
	assert.ok(highlightsSchema.safeParse(record).success);
	assert.equal(decodeText(record.text), original);
	assert.equal(
		highlightsSchema.safeParse(
			highlightRecord({ id: 456, text: `${original}x` }, BOOK),
		).success,
		false,
	);
});

for (const { status, retryAfter } of [
	{ status: 429, retryAfter: 2 },
	{ status: 503, retryAfter: 0 },
]) {
	test(
		"Readwise export retries HTTP " +
			status +
			" on the documented request path",
		async () => {
			const calls: { path: string; auth: string | null }[] = [];
			const sleeps: number[] = [];
			const read = createExportReader(
				async (input, init) => {
					const url = new URL(String(input));
					calls.push({
						path: url.pathname,
						auth: new Headers(init?.headers).get("Authorization"),
					});
					assert.equal(url.origin, "https://readwise.io");
					assert.ok(url.pathname === "/api/v2/export/");
					assert.equal(url.searchParams.get("includeDeleted"), "true");
					if (calls.length === 1) {
						return new Response(null, {
							status,
							headers: { "Retry-After": String(retryAfter) },
						});
					}
					return Response.json({
						count: 1,
						nextPageCursor: null,
						results: [BOOK],
					});
				},
				async (ms) => {
					sleeps.push(ms);
				},
			);
			const page = await read("fixture-token", null, null);
			assert.deepEqual(
				page.results.map(bookRecord).map(({ id }) => id),
				["123"],
			);
			assert.deepEqual(calls, [
				{ path: "/api/v2/export/", auth: "Token fixture-token" },
				{ path: "/api/v2/export/", auth: "Token fixture-token" },
			]);
			assert.deepEqual(sleeps, [retryAfter * 1000]);
		},
	);
}

test("persistent Readwise 5xx failures exhaust retries with a retryable error", async () => {
	let attempts = 0;
	const read = createExportReader(
		async () => {
			attempts += 1;
			return new Response(null, {
				status: 503,
				headers: { "Retry-After": "0" },
			});
		},
		async () => {},
	);
	await assert.rejects(read("fixture-token", null, null), {
		message: "readwise_export_retryable",
	});
	assert.equal(attempts, 4);
});

test("fetchExportPage maps 401 to an auth failure", async () => {
	const fake = (async () =>
		new Response("no", { status: 401 })) as typeof fetch;
	await assert.rejects(
		createExportReader(fake)("bad", null, null),
		/readwise_auth_failed/,
	);
});

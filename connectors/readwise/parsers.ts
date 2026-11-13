// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { kindleHighlightsSchema } from "./schemas.ts";

const id = z.number().int().positive();
const timestamp = z.iso.datetime({ offset: true });
const tag = z.object({ name: z.string() });
/** Validate provider envelopes before advancing through any page. */
export const booksPage = z.object({
	count: z.number().int().nonnegative(),
	next: z.string().nullable(),
	results: z.array(
		z.object({
			id,
			num_highlights: z.number().int().nonnegative(),
			title: z.string(),
			source: z.string(),
			category: z.string(),
		}),
	),
});
export const exportBook = z.object({
	user_book_id: id,
	source: z.string(),
	category: z.string(),
	title: z.string(),
	author: z.string().nullable(),
	is_deleted: z.boolean(),
	highlights: z.array(
		z.object({
			id,
			text: z.string(),
			note: z.string().nullable(),
			location: z.number().int().nullable(),
			location_type: z.string().nullable(),
			highlighted_at: timestamp.nullable(),
			updated_at: timestamp,
			readwise_url: z.string(),
			tags: z.array(tag),
			is_deleted: z.boolean(),
		}),
	),
});
export const exportPage = z.object({
	nextPageCursor: z
		.union([z.string().min(1), z.number().int().nonnegative().safe()])
		.nullable()
		.transform((value) => (value === null ? null : String(value))),
	results: z.array(exportBook),
});
/** Preserve highlight text and notes; never infer Kindle from a title or category alone. */
export function kindleHighlightsRecord(
	book: z.infer<typeof exportBook>,
	h: z.infer<typeof exportBook>["highlights"][number],
) {
	return kindleHighlightsSchema.parse({
		id: String(h.id),
		book_id: String(book.user_book_id),
		title: book.title,
		author: book.author,
		text: h.text,
		note: h.note,
		location: h.location,
		location_type: h.location_type,
		highlighted_at: h.highlighted_at,
		updated_at: h.updated_at,
		readwise_url: h.readwise_url,
		source: "kindle",
		tags: h.tags.map((t) => t.name),
		deleted: book.is_deleted || h.is_deleted,
	});
}

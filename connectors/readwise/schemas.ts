// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Readwise stream records. Ground truth is the record
 * builders in api.ts (`bookRecord`, `highlightRecord`).
 *
 *   - ids are `String(...)` of Readwise's numeric `user_book_id` / highlight id.
 *   - empty strings from the API are normalized to null.
 *   - `tags` are tag names only.
 *   - `is_deleted` comes from provider deletion flags on every export;
 *     the runtime treats those records as tombstones.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

import { decodeEscapedText, TEXT_ENCODING } from "./text.ts";

// Limits apply to the original text; transport escaping must never truncate it.
const encodedText = (max: number) =>
	pdppSafeText
		.max(max * 6)
		.refine(
			(value) => decodeEscapedText(value).length <= max,
			`decoded text must be at most ${max} characters`,
		);

const NUMERIC_ID_RE = /^\d{1,30}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const numericId = z
	.string()
	.regex(NUMERIC_ID_RE, "must be a numeric Readwise id");
const isoDateTimeNullable = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();
const urlNullable = z.string().max(8192).nullable();
const textNullable = encodedText(100_000).nullable();
const tags = z.array(encodedText(500));

export const booksSchema = z.object({
	text_encoding: z.literal(TEXT_ENCODING),
	id: numericId,
	title: encodedText(4000),
	author: encodedText(4000).nullable(),
	category: encodedText(100).nullable(),
	source: encodedText(200).nullable(),
	cover_image_url: urlNullable,
	source_url: urlNullable,
	readwise_url: urlNullable,
	document_note: textNullable,
	summary: textNullable,
	asin: encodedText(100).nullable(),
	tags,
	is_deleted: z.boolean(),
});

export const highlightsSchema = z.object({
	text_encoding: z.literal(TEXT_ENCODING),
	id: numericId,
	book_id: numericId,
	book_title: encodedText(4000),
	book_author: encodedText(4000).nullable(),
	book_category: encodedText(100).nullable(),
	text: encodedText(100_000),
	note: textNullable,
	color: encodedText(50).nullable(),
	location: z.number().nullable(),
	location_type: encodedText(50).nullable(),
	url: urlNullable,
	readwise_url: urlNullable,
	tags,
	is_favorite: z.boolean(),
	is_discard: z.boolean(),
	is_deleted: z.boolean(),
	highlighted_at: isoDateTimeNullable,
	created_at: isoDateTimeNullable,
	updated_at: isoDateTimeNullable,
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	books: booksSchema,
	highlights: highlightsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

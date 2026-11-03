// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for the goodreads streams. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3. They mirror
 * connectors/goodreads/manifest.json; src/manifest-reconcile.ts checks the
 * stream names across manifest, SCHEMAS and the emitted-stream literals.
 *
 * Only the manifest's `required` keys are required here. The rest are
 * optional so a consent that selects fields (and drops, say, `review_text`)
 * still validates; a present value must still have the declared type.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const PARTIAL_DATE_RE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;
const FULL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

const text = (max: number) => pdppSafeText.max(max).nullable().optional();
const count = z.number().int().min(0).nullable().optional();
const flag = z.boolean().nullable().optional();
const partialDate = z.string().regex(PARTIAL_DATE_RE).nullable().optional();
const tally = z.record(pdppSafeText.max(200), z.number().int().min(0));

const authorSchema = z.object({
	author_id: z.string().max(40).nullable(),
	is_goodreads_author: z.boolean(),
	name: pdppSafeText.max(500),
});

const readingSessionSchema = z.object({
	finished_on: z.string().regex(PARTIAL_DATE_RE).nullable(),
	session_id: z.string().max(64).nullable(),
	started_on: z.string().regex(PARTIAL_DATE_RE).nullable(),
});

/** books: one record per shelving in the owner's library. */
export const booksSchema = z.object({
	added_on: z.string().regex(FULL_DATE_RE).nullable().optional(),
	asin: text(40),
	author: text(500),
	authors: z.array(authorSchema).max(200).optional(),
	average_rating: z.number().min(0).max(5).nullable().optional(),
	book_id: z.string().min(1).max(40),
	book_url: text(2000),
	comments_count: count,
	cover_url: text(2000),
	edition_publication_date: partialDate,
	exclusive_shelf: text(200),
	finished_date: z.string().regex(FULL_DATE_RE).nullable().optional(),
	finished_on: partialDate,
	format: text(200),
	has_review: z.boolean().optional(),
	id: z.string().min(1).max(40),
	isbn: text(40),
	isbn13: text(40),
	likes_count: count,
	num_pages: z.number().int().min(1).nullable().optional(),
	original_publication_date: partialDate,
	owned: flag,
	position: count,
	private_notes: text(1_048_576),
	rating: z.number().int().min(1).max(5).nullable().optional(),
	ratings_count: count,
	read_count: count,
	reading_sessions: z.array(readingSessionSchema).max(500).optional(),
	review_text: text(1_048_576),
	shelves: z.array(pdppSafeText.max(200)).max(500).optional(),
	started_date: z.string().regex(FULL_DATE_RE).nullable().optional(),
	started_on: partialDate,
	title: text(2000),
});

/** shelves: one record per shelf or tag. */
export const shelvesSchema = z.object({
	book_count: count,
	exclusive: z.boolean(),
	id: pdppSafeText.min(1).max(200),
	name: pdppSafeText.min(1).max(200),
	url: pdppSafeText.max(2000).optional(),
});

const sourceOutcome = z.enum(["read", "failed"]);

/** account_profile: singleton. */
export const accountProfileSchema = z.object({
	allow_followers: flag,
	allow_nonfriend_review_comments: flag,
	average_rating: z.number().min(0).max(5).nullable().optional(),
	books_count: count,
	country: z.string().length(2).nullable().optional(),
	favorite_genres: z
		.array(pdppSafeText.max(100))
		.max(200)
		.nullable()
		.optional(),
	friends_count: count,
	id: z.literal("account_profile"),
	joined_on: z.string().regex(MONTH_RE).nullable().optional(),
	last_active: text(100),
	linked_sign_in: z
		.object({
			amazon: flag,
			apple: flag,
			google: flag,
		})
		.nullable()
		.optional(),
	locale: z.string().max(20).nullable().optional(),
	profile_visibility: z
		.enum(["everyone", "members", "friends"])
		.nullable()
		.optional(),
	ratings_count: count,
	reviews_count: count,
	searchable_by_email: flag,
	shelves_count: count,
	sources: z.object({ profile: sourceOutcome, settings: sourceOutcome }),
	tenure_months: count,
});

/** usage_summary: singleton of aggregates over the complete listing. */
export const usageSummarySchema = z.object({
	average_rating_given: z.number().min(1).max(5).nullable().optional(),
	books_added_by_year: tally.optional(),
	books_finished_by_year: tally.optional(),
	books_total: z.number().int().min(0).optional(),
	by_exclusive_shelf: tally.optional(),
	coverage: z.object({
		books_listed: z.number().int().min(0),
		books_with_finish_date: z.number().int().min(0),
		list_pages: z.number().int().min(0),
		listing_complete: z.boolean(),
	}),
	first_added_on: z.string().regex(FULL_DATE_RE).nullable().optional(),
	first_finished_on: partialDate,
	formats: tally.optional(),
	id: z.literal("usage_summary"),
	last_added_on: z.string().regex(FULL_DATE_RE).nullable().optional(),
	last_finished_on: partialDate,
	owned_count: z.number().int().min(0).optional(),
	pages_finished_by_year: tally.optional(),
	rated_count: z.number().int().min(0).optional(),
	rating_histogram: z
		.object({
			"1": z.number().int().min(0),
			"2": z.number().int().min(0),
			"3": z.number().int().min(0),
			"4": z.number().int().min(0),
			"5": z.number().int().min(0),
		})
		.optional(),
	reread_books: z.number().int().min(0).optional(),
	reviewed_count: z.number().int().min(0).optional(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	books: booksSchema,
	shelves: shelvesSchema,
	account_profile: accountProfileSchema,
	usage_summary: usageSummarySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

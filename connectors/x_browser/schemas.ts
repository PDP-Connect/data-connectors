// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for the X browser-session streams. They mirror the records
 * parsers.ts builds (`ProfileRecord`, `PostRecord`), which parsers.test.ts
 * exercises against the synthetic fixtures.
 *
 * Ids are X's numeric snowflake strings. Timestamps are ISO-8601 instants
 * from `Date.prototype.toISOString`. Free text uses `pdppSafeText`.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NUMERIC_ID_RE = /^\d{1,30}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const idSchema = z.string().regex(NUMERIC_ID_RE, "id must be a numeric string");
const handleSchema = z.string().regex(HANDLE_RE, "not an X handle");
const instantSchema = z
	.string()
	.regex(ISO_Z_RE, "must be an ISO-8601 Z timestamp");
const countSchema = z.number().int().min(0).nullable();
const webUrlSchema = z.url().max(2048);

export const profileSchema = z.object({
	id: idSchema,
	handle: handleSchema,
	name: pdppSafeText.max(500).nullable(),
	url: webUrlSchema,
	bio: pdppSafeText.max(2000).nullable(),
	location: pdppSafeText.max(500).nullable(),
	website_url: webUrlSchema.nullable(),
	avatar_url: webUrlSchema.nullable(),
	banner_url: webUrlSchema.nullable(),
	account_created_at: instantSchema.nullable(),
	followers_count: countSchema,
	following_count: countSchema,
	posts_count: countSchema,
	likes_count: countSchema,
	is_blue_verified: z.boolean().nullable(),
	is_verified: z.boolean().nullable(),
	is_protected: z.boolean().nullable(),
});

/** One post. The posts, likes and bookmarks streams share this contract. */
export const postSchema = z.object({
	id: idSchema,
	url: webUrlSchema.nullable(),
	kind: z.enum(["post", "reply", "quote", "repost"]),
	created_at: instantSchema,
	text: pdppSafeText.max(30_000).nullable(),
	lang: pdppSafeText.max(40).nullable(),
	author_id: idSchema,
	author_handle: handleSchema.nullable(),
	author_name: pdppSafeText.max(500).nullable(),
	conversation_id: idSchema.nullable(),
	in_reply_to_post_id: idSchema.nullable(),
	in_reply_to_handle: handleSchema.nullable(),
	quoted_post_id: idSchema.nullable(),
	reposted_post_id: idSchema.nullable(),
	like_count: countSchema,
	repost_count: countSchema,
	reply_count: countSchema,
	quote_count: countSchema,
	bookmark_count: countSchema,
	view_count: countSchema,
	hashtags: z.array(pdppSafeText.max(280)).max(50),
	mention_handles: z.array(handleSchema).max(50),
	urls: z.array(webUrlSchema).max(50),
	media: z
		.array(
			z.object({ type: pdppSafeText.max(40).nullable(), url: webUrlSchema }),
		)
		.max(50),
	sort_index: idSchema.nullable(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	posts: postSchema,
	likes: postSchema,
	bookmarks: postSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

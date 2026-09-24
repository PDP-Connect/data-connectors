// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Meta (Instagram) stream records. Shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3.
 *
 * Streams (per docs/migration/connector-cutover/capability-map.json D6):
 *   profile      — the owner's own Instagram profile (one record/run)
 *   posts        — posts on the owner's own timeline
 *   post_likes   — child stream of posts: (post, liker) pairs from each
 *                  post's `facepile_top_likers` sample (Instagram exposes
 *                  no full-likers listing endpoint from a web session)
 *   following    — accounts the owner follows
 *   ads          — advertisers / ad topics / targeting categories from
 *                  Meta Accounts Center, merged into one stream with a
 *                  `kind` discriminator (D6 merge of the two legacy
 *                  connectors' ad surfaces)
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const AD_ID_RE = /^[0-9a-f]{32}$/;

const isoDateTimeSchema = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();
const usernameSchema = z.string().min(1).max(200);
const postLikerUsernameSchema = z.string().max(200);
const igIdSchema = z.string().min(1).max(200);
const nullableBoolSchema = z.boolean().nullable();
const nonNegativeIntSchema = z.number().int().min(0).nullable();

/**
 * profile stream (manifest required: id, username). One record per run —
 * the owner's own profile.
 */
export const profileSchema = z.object({
	id: igIdSchema,
	username: usernameSchema,
	full_name: pdppSafeText.max(500).nullable(),
	bio: pdppSafeText.max(4000).nullable(),
	profile_pic_url: z.url().nullable(),
	external_url: z.url().nullable(),
	follower_count: nonNegativeIntSchema,
	following_count: nonNegativeIntSchema,
	post_count: nonNegativeIntSchema,
	is_private: nullableBoolSchema,
	is_verified: nullableBoolSchema,
	is_business: nullableBoolSchema,
});

/**
 * posts stream (manifest required: id). One record per post on the owner's
 * own timeline.
 */
export const postsSchema = z.object({
	id: igIdSchema,
	caption: pdppSafeText.max(100_000).nullable(),
	media_type: z.enum(["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]).nullable(),
	media_url: z.url().nullable(),
	like_count: nonNegativeIntSchema,
	comment_count: nonNegativeIntSchema,
	location_name: pdppSafeText.max(500).nullable(),
	taken_at: isoDateTimeSchema,
});

/**
 * post_likes stream. Child stream of posts (D3): one record per (post,
 * liker) pair. Primary key is the pair itself, since a single liker can
 * appear on many of the owner's posts.
 */
export const postLikesSchema = z.object({
	post_id: igIdSchema,
	profile_pic_url: z.url().nullable().optional(),
	pk: igIdSchema.optional(),
	id: igIdSchema.optional(),
	user_id: igIdSchema,
	username: postLikerUsernameSchema,
});

/**
 * following stream (manifest required: id). One record per account the
 * owner follows. D6: must be complete or report honest coverage — see
 * index.ts's SKIP_RESULT on truncation.
 */
export const followingSchema = z.object({
	id: igIdSchema,
	username: usernameSchema,
	full_name: pdppSafeText.max(500).nullable(),
	is_private: nullableBoolSchema,
	is_verified: nullableBoolSchema,
	profile_pic_url: z.url().nullable(),
});

/**
 * ads stream. Merge of the two legacy connectors' ad surfaces (D6): one
 * stream, `kind` discriminates advertiser / ad_topic / ad_category. `id` is
 * a stable hash of `kind|name` (see parsers.ts `stableAdId`) since neither
 * Accounts Center DOM surface exposes a native id for these entries.
 */
export const adsSchema = z.object({
	id: z.string().regex(AD_ID_RE, "id must be a stable kind|name hash"),
	kind: z.enum(["advertiser", "ad_topic", "ad_category"]),
	name: pdppSafeText.min(1).max(500),
	description: pdppSafeText.max(2000).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	posts: postsSchema,
	post_likes: postLikesSchema,
	following: followingSchema,
	ads: adsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

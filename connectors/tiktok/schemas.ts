// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record contracts for the TikTok connector. They restate the stream schemas
 * in manifest.json; keep the two in step.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

/** A TikTok id: a decimal 64-bit integer carried as a string. */
const tiktokId = z.string().regex(/^[0-9]{1,30}$/);
const instant = z.string().datetime({ offset: true });
const shortText = pdppSafeText.max(500);
const counter = z.number().int().nonnegative().nullable();
const httpsUrl = z.string().url().max(2000).startsWith("https://");

export const profileSchema = z.object({
	id: tiktokId,
	sec_uid: pdppSafeText.max(200).nullable(),
	unique_id: shortText.nullable(),
	nickname: shortText.nullable(),
	bio: pdppSafeText.max(1000).nullable(),
	avatar_url: httpsUrl.nullable(),
	private_account: z.boolean().nullable(),
	follower_count: counter,
	following_count: counter,
	like_count: counter,
	video_count: counter,
	created_at: instant.nullable(),
});

export const videosSchema = z.object({
	id: tiktokId,
	created_at: instant,
	caption: pdppSafeText.max(4000).nullable(),
	duration_seconds: counter,
	privacy: z.enum(["public", "friends", "private"]).nullable(),
	play_count: counter,
	like_count: counter,
	comment_count: counter,
	share_count: counter,
	save_count: counter,
	repost_count: counter,
});

const savedVideoSchema = z.object({
	id: tiktokId,
	author_id: tiktokId.nullable(),
	author_unique_id: shortText.nullable(),
	author_nickname: shortText.nullable(),
	caption: pdppSafeText.max(4000).nullable(),
	video_created_at: instant,
});

export const likesSchema = savedVideoSchema;
export const favoritesSchema = savedVideoSchema;

export const favoriteCollectionsSchema = z.object({
	id: tiktokId,
	name: shortText.nullable(),
	item_count: counter,
});

const accountSchema = z.object({
	id: tiktokId,
	unique_id: shortText.nullable(),
	nickname: shortText.nullable(),
	sec_uid: pdppSafeText.max(200).nullable(),
	verified: z.boolean().nullable(),
	private_account: z.boolean().nullable(),
});

export const followingSchema = accountSchema;
export const followersSchema = accountSchema;

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	videos: videosSchema,
	likes: likesSchema,
	favorites: favoritesSchema,
	favorite_collections: favoriteCollectionsSchema,
	following: followingSchema,
	followers: followersSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

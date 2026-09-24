// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Meta (Instagram) connector — one record shape per
 * stream (profile, posts, post_likes, following, ads), matching the record
 * builders in parsers.ts. Complements parsers.test.ts (builder logic) and
 * pilot-fixture.test.ts (fixture-locked drift check) with direct schema
 * boundary assertions (required fields, url shape, enum vocab, bounds).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	adsSchema,
	followingSchema,
	postLikesSchema,
	postsSchema,
	profileSchema,
	validateRecord,
} from "./schemas.ts";

const PROFILE_RECORD = {
	id: "17841401234567890",
	username: "the_owner_codes",
	full_name: "the owner N.",
	bio: "building personal-data tools\nAustin, TX",
	profile_pic_url: "https://scontent.cdninstagram.com/pic.jpg",
	external_url: "https://example.com",
	follower_count: 1280,
	following_count: 311,
	post_count: 94,
	is_private: false,
	is_verified: false,
	is_business: false,
};

const POST_RECORD = {
	id: "3401234567890123456",
	caption: "Sunset over the lake #goldenhour",
	media_type: "IMAGE",
	media_url: "https://scontent.cdninstagram.com/post.jpg",
	like_count: 212,
	comment_count: 14,
	location_name: "Lady Bird Lake",
	taken_at: "2024-05-01T23:10:00.000Z",
};

const POST_LIKE_RECORD = {
	liker_ordinal: 0,
	post_id: "3401234567890123456",
	profile_pic_url: "https://scontent.cdninstagram.com/liker.jpg",
	pk: "999",
	id: "999",
	user_id: "999",
	username: "liker_one",
};

const FOLLOWING_RECORD = {
	id: "17841400000000001",
	username: "followed_account",
	full_name: "Followed Account",
	is_private: false,
	is_verified: true,
	profile_pic_url: "https://scontent.cdninstagram.com/f.jpg",
};

const AD_RECORD = {
	id: "a".repeat(32),
	kind: "advertiser",
	name: "Acme Corp",
	description: null,
};

// ─── profile ──────────────────────────────────────────────────────────

test("profile schema accepts a fully-populated record", () => {
	assert.ok(profileSchema.safeParse(PROFILE_RECORD).success);
});

test("profile schema accepts nulls for every optional field", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		full_name: null,
		bio: null,
		profile_pic_url: null,
		external_url: null,
		follower_count: null,
		following_count: null,
		post_count: null,
		is_private: null,
		is_verified: null,
		is_business: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a missing username", () => {
	const { username: _omit, ...withoutUsername } = PROFILE_RECORD;
	assert.equal(profileSchema.safeParse(withoutUsername).success, false);
});

test("profile schema rejects a negative follower_count", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, follower_count: -1 }).success,
		false,
	);
});

test("profile schema rejects a non-URL profile_pic_url", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, profile_pic_url: "not-a-url" })
			.success,
		false,
	);
});

// ─── posts ────────────────────────────────────────────────────────────

test("posts schema accepts a fully-populated record", () => {
	assert.ok(postsSchema.safeParse(POST_RECORD).success);
});

test("posts schema accepts nulls for every optional field", () => {
	const result = postsSchema.safeParse({
		...POST_RECORD,
		caption: null,
		media_type: null,
		media_url: null,
		like_count: null,
		comment_count: null,
		location_name: null,
		taken_at: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("posts schema rejects a non-ISO taken_at (raw epoch leaked in)", () => {
	assert.equal(
		postsSchema.safeParse({ ...POST_RECORD, taken_at: "1714604200" }).success,
		false,
	);
});

test("posts schema rejects a negative like_count", () => {
	assert.equal(
		postsSchema.safeParse({ ...POST_RECORD, like_count: -5 }).success,
		false,
	);
});

test("posts schema rejects a media_type outside the declared vocabulary", () => {
	assert.equal(
		postsSchema.safeParse({ ...POST_RECORD, media_type: "REEL" }).success,
		false,
	);
});

test("posts schema accepts every declared media_type", () => {
	for (const mediaType of ["IMAGE", "VIDEO", "CAROUSEL_ALBUM"]) {
		assert.ok(
			postsSchema.safeParse({ ...POST_RECORD, media_type: mediaType }).success,
			mediaType,
		);
	}
});

// ─── post_likes ───────────────────────────────────────────────────────

test("post_likes schema accepts a fully-populated record", () => {
	assert.ok(postLikesSchema.safeParse(POST_LIKE_RECORD).success);
});

test("post_likes schema rejects a missing post_id", () => {
	const { post_id: _omit, ...rest } = POST_LIKE_RECORD;
	assert.equal(postLikesSchema.safeParse(rest).success, false);
});

test("post_likes schema rejects a missing username", () => {
	const { username: _omit, ...rest } = POST_LIKE_RECORD;
	assert.equal(postLikesSchema.safeParse(rest).success, false);
});

test("post_likes schema accepts a null picture URL and preserves legacy id fields", () => {
	const result = postLikesSchema.safeParse({
		...POST_LIKE_RECORD,
		profile_pic_url: null,
		pk: "legacy-pk",
		id: "legacy-id",
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("post_likes schema remains compatible with records from before liker parity", () => {
	assert.ok(
		postLikesSchema.safeParse({
			liker_ordinal: 0,
			post_id: "3401234567890123456",
			user_id: "999",
			username: "liker_one",
		}).success,
	);
});

test("post_likes schema accepts an empty username emitted by the legacy source", () => {
	assert.ok(
		postLikesSchema.safeParse({
			liker_ordinal: 0,
			post_id: "3401234567890123456",
			user_id: "999",
			username: "",
		}).success,
	);
});

// ─── following ────────────────────────────────────────────────────────

test("following schema accepts a fully-populated record", () => {
	assert.ok(followingSchema.safeParse(FOLLOWING_RECORD).success);
});

test("following schema accepts nulls for every optional field", () => {
	const result = followingSchema.safeParse({
		...FOLLOWING_RECORD,
		full_name: null,
		is_private: null,
		is_verified: null,
		profile_pic_url: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("following schema rejects a missing id", () => {
	const { id: _omit, ...rest } = FOLLOWING_RECORD;
	assert.equal(followingSchema.safeParse(rest).success, false);
});

// ─── ads ──────────────────────────────────────────────────────────────

test("ads schema accepts a fully-populated record for every kind", () => {
	for (const kind of ["advertiser", "ad_topic", "ad_category"]) {
		assert.ok(adsSchema.safeParse({ ...AD_RECORD, kind }).success, kind);
	}
});

test("ads schema rejects a kind outside the declared vocabulary", () => {
	assert.equal(
		adsSchema.safeParse({ ...AD_RECORD, kind: "sponsor" }).success,
		false,
	);
});

test("ads schema rejects an id that isn't a 32-char hash", () => {
	assert.equal(
		adsSchema.safeParse({ ...AD_RECORD, id: "not-a-hash" }).success,
		false,
	);
});

test("ads schema rejects a blank name", () => {
	assert.equal(adsSchema.safeParse({ ...AD_RECORD, name: "" }).success, false);
});

// ─── validateRecord routing ─────────────────────────────────────────────

test("validateRecord routes every declared stream and passes unknown streams through", () => {
	assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
	assert.equal(validateRecord("posts", POST_RECORD).ok, true);
	assert.equal(validateRecord("post_likes", POST_LIKE_RECORD).ok, true);
	assert.equal(validateRecord("following", FOLLOWING_RECORD).ok, true);
	assert.equal(validateRecord("ads", AD_RECORD).ok, true);
	assert.equal(validateRecord("stories", { id: "x" }).ok, true);
});

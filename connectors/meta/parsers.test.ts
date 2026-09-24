// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	adRecord,
	buildAdRecords,
	dedupeFollowingByUsername,
	followingRecord,
	isoFromTakenAt,
	mediaTypeOf,
	mediaUrlOf,
	nullIfEmpty,
	postLikeRecords,
	postRecord,
	profileCountsFromGraphQL,
	profileRecord,
	stableAdId,
} from "./parsers.ts";
import type { InstagramTimelineEdge, InstagramWebInfoUser } from "./types.ts";

// ─── isoFromTakenAt ─────────────────────────────────────────────────────

test("isoFromTakenAt: converts unix seconds to ISO", () => {
	assert.equal(isoFromTakenAt(1_700_000_000), "2023-11-14T22:13:20.000Z");
});

test("isoFromTakenAt: falls back to taken_at_timestamp when taken_at is absent", () => {
	assert.equal(isoFromTakenAt(null, 1_700_000_000), "2023-11-14T22:13:20.000Z");
});

test("isoFromTakenAt: passes through millisecond-scale values unchanged", () => {
	const ms = 1_700_000_000_000 + 5000;
	assert.equal(isoFromTakenAt(ms), new Date(ms).toISOString());
});

test("isoFromTakenAt: never fabricates a timestamp when neither field is present", () => {
	assert.equal(isoFromTakenAt(null, null), null);
	assert.equal(isoFromTakenAt(undefined, undefined), null);
	assert.equal(isoFromTakenAt(0), null);
	assert.equal(isoFromTakenAt(-5), null);
});

// ─── mediaUrlOf / mediaTypeOf ───────────────────────────────────────────

test("mediaUrlOf: prefers direct image_versions2 over carousel", () => {
	const url = mediaUrlOf({
		carousel_media: [
			{
				image_versions2: {
					candidates: [{ url: "https://example.com/carousel.jpg" }],
				},
			},
		],
		image_versions2: {
			candidates: [{ url: "https://example.com/direct.jpg" }],
		},
	});
	assert.equal(url, "https://example.com/direct.jpg");
});

test("mediaUrlOf: falls back to the first carousel slide's image", () => {
	const url = mediaUrlOf({
		carousel_media: [
			{
				image_versions2: {
					candidates: [{ url: "https://example.com/slide1.jpg" }],
				},
			},
		],
	});
	assert.equal(url, "https://example.com/slide1.jpg");
});

test("mediaUrlOf: returns null (not empty string) when no image is present", () => {
	assert.equal(mediaUrlOf({}), null);
});

test("mediaTypeOf: CAROUSEL_ALBUM when carousel_media is non-empty", () => {
	assert.equal(mediaTypeOf({ carousel_media: [{}] }), "CAROUSEL_ALBUM");
});

test("mediaTypeOf: IMAGE when carousel_media is absent or empty", () => {
	assert.equal(mediaTypeOf({}), "IMAGE");
	assert.equal(mediaTypeOf({ carousel_media: [] }), "IMAGE");
});

// ─── profileRecord ──────────────────────────────────────────────────────

test("profileRecord: maps web_info fields per the live-observed shape (2026-09-22)", () => {
	const user: InstagramWebInfoUser = {
		biography: "hello world",
		external_url: "https://example.com",
		fbid: "123",
		full_name: "Jane Doe",
		id: "123",
		is_business_account: false,
		is_private: true,
		is_verified: false,
		profile_pic_url: "https://cdn.example.com/pic.jpg",
		username: "janedoe",
	};
	assert.deepEqual(profileRecord(user), {
		bio: "hello world",
		external_url: "https://example.com",
		follower_count: null,
		following_count: null,
		full_name: "Jane Doe",
		id: "123",
		is_business: false,
		is_private: true,
		is_verified: false,
		post_count: null,
		profile_pic_url: "https://cdn.example.com/pic.jpg",
		username: "janedoe",
	});
});

test("profileRecord: returns null when id and username are both missing", () => {
	assert.equal(profileRecord({}), null);
});

test("profileRecord: falls back to fbid when id is absent", () => {
	const record = profileRecord({ fbid: "456", username: "x" });
	assert.equal(record?.id, "456");
});

test("profileRecord: normalizes empty-string bio/full_name/external_url/profile_pic_url to null (confirmed live 2026-09-22 shape: unset fields are '', not absent)", () => {
	const record = profileRecord({
		biography: "",
		external_url: "",
		full_name: "",
		id: "1600000001",
		profile_pic_url: "",
		username: "example_user",
	});
	assert.deepEqual(record, {
		bio: null,
		external_url: null,
		follower_count: null,
		following_count: null,
		full_name: null,
		id: "1600000001",
		is_business: null,
		is_private: null,
		is_verified: null,
		post_count: null,
		profile_pic_url: null,
		username: "example_user",
	});
});

test("profileRecord: fills counts from the second arg when provided", () => {
	const user: InstagramWebInfoUser = { id: "1", username: "janedoe" };
	const record = profileRecord(user, {
		follower_count: 1234,
		following_count: 56,
		post_count: 78,
	});
	assert.equal(record?.follower_count, 1234);
	assert.equal(record?.following_count, 56);
	assert.equal(record?.post_count, 78);
});

// ─── profileCountsFromGraphQL ───────────────────────────────────────────
// Synthetic fixture shaped like the legacy connector's captured
// `profileData.data.data.user` (instagram-playwright.js:656-679), with
// invented values — not derived from a real capture.

test("profileCountsFromGraphQL: maps follower_count/following_count/media_count->post_count", () => {
	const counts = profileCountsFromGraphQL({
		data: {
			data: {
				user: {
					follower_count: 4200,
					following_count: 310,
					media_count: 88,
				},
			},
		},
	});
	assert.deepEqual(counts, {
		follower_count: 4200,
		following_count: 310,
		post_count: 88,
	});
});

test("profileCountsFromGraphQL: all-null when the envelope is null", () => {
	assert.deepEqual(profileCountsFromGraphQL(null), {
		follower_count: null,
		following_count: null,
		post_count: null,
	});
});

test("profileCountsFromGraphQL: all-null when undefined", () => {
	assert.deepEqual(profileCountsFromGraphQL(undefined), {
		follower_count: null,
		following_count: null,
		post_count: null,
	});
});

test("profileCountsFromGraphQL: all-null when data.data.user is missing", () => {
	assert.deepEqual(profileCountsFromGraphQL({ data: {} }), {
		follower_count: null,
		following_count: null,
		post_count: null,
	});
});

test("profileCountsFromGraphQL: null for individual fields that are absent, not zero", () => {
	const counts = profileCountsFromGraphQL({
		data: { data: { user: { follower_count: 10 } } },
	});
	assert.equal(counts.follower_count, 10);
	assert.equal(counts.following_count, null);
	assert.equal(counts.post_count, null);
});

test("profileCountsFromGraphQL: rejects negative or non-finite counts as null (never guessed)", () => {
	const counts = profileCountsFromGraphQL({
		data: {
			data: {
				user: {
					follower_count: -1,
					following_count: Number.NaN,
					media_count: 0,
				},
			},
		},
	});
	assert.equal(counts.follower_count, null);
	assert.equal(counts.following_count, null);
	assert.equal(counts.post_count, 0);
});

// ─── nullIfEmpty ────────────────────────────────────────────────────────

test("nullIfEmpty: empty string becomes null", () => {
	assert.equal(nullIfEmpty(""), null);
});

test("nullIfEmpty: non-empty string passes through unchanged", () => {
	assert.equal(nullIfEmpty("hello"), "hello");
});

test("nullIfEmpty: null and undefined both become null", () => {
	assert.equal(nullIfEmpty(null), null);
	assert.equal(nullIfEmpty(undefined), null);
});

// ─── postRecord ─────────────────────────────────────────────────────────

function makeEdge(
	overrides: Partial<InstagramTimelineEdge["node"]> = {},
): InstagramTimelineEdge {
	return {
		node: {
			caption: { text: "a caption" },
			id: "post1",
			image_versions2: { candidates: [{ url: "https://example.com/img.jpg" }] },
			like_count: 5,
			taken_at: 1_700_000_000,
			...overrides,
		},
	};
}

test("postRecord: maps fields and derives media_type/media_url", () => {
	const record = postRecord(makeEdge());
	assert.deepEqual(record, {
		caption: "a caption",
		comment_count: null,
		id: "post1",
		like_count: 5,
		location_name: null,
		media_type: "IMAGE",
		media_url: "https://example.com/img.jpg",
		taken_at: "2023-11-14T22:13:20.000Z",
	});
});

test("postRecord: returns null when no id-like field is present", () => {
	assert.equal(postRecord({ node: {} }), null);
});

test("postRecord: falls back through pk/media_id/code for id", () => {
	assert.equal(postRecord({ node: { pk: "p1" } })?.id, "p1");
	assert.equal(postRecord({ node: { media_id: "m1" } })?.id, "m1");
	assert.equal(postRecord({ node: { code: "c1" } })?.id, "c1");
});

// ─── postLikeRecords ────────────────────────────────────────────────────

test("postLikeRecords: one record per (post, liker) pair", () => {
	const edge = makeEdge({
		facepile_top_likers: [
			{
				id: "u1",
				pk: "pk1",
				profile_pic_url: "https://cdn.example.com/alice.jpg",
				username: "alice",
			},
			{ pk: "u2", username: "bob" },
		],
	});
	assert.deepEqual(postLikeRecords(edge), [
		{
			post_id: "post1",
			profile_pic_url: "https://cdn.example.com/alice.jpg",
			pk: "pk1",
			id: "u1",
			user_id: "u1",
			username: "alice",
		},
		{
			post_id: "post1",
			profile_pic_url: null,
			pk: "u2",
			id: "u2",
			user_id: "u2",
			username: "bob",
		},
	]);
});

test("postLikeRecords: keeps identified likers with a missing username and skips missing ids", () => {
	const edge = makeEdge({
		facepile_top_likers: [
			{ id: "u1" },
			{ username: "no-id" },
			{ id: "u3", username: "carol" },
		],
	});
	assert.deepEqual(postLikeRecords(edge), [
		{
			post_id: "post1",
			profile_pic_url: null,
			pk: "u1",
			id: "u1",
			user_id: "u1",
			username: "",
		},
		{
			post_id: "post1",
			profile_pic_url: null,
			pk: "u3",
			id: "u3",
			user_id: "u3",
			username: "carol",
		},
	]);
});

test("postLikeRecords: empty array when post has no facepile_top_likers", () => {
	assert.deepEqual(postLikeRecords(makeEdge()), []);
});

test("postLikeRecords: empty array when the post itself has no id", () => {
	assert.deepEqual(
		postLikeRecords({
			node: { facepile_top_likers: [{ id: "u1", username: "a" }] },
		}),
		[],
	);
});

// ─── followingRecord ────────────────────────────────────────────────────

test("followingRecord: maps accounts[] fields per the capability-map field_map", () => {
	const record = followingRecord({
		full_name: "Some Name",
		is_private: false,
		is_verified: true,
		pk: "999",
		profile_pic_url: "https://cdn.example.com/p.jpg",
		username: "someone",
	});
	assert.deepEqual(record, {
		full_name: "Some Name",
		id: "999",
		is_private: false,
		is_verified: true,
		profile_pic_url: "https://cdn.example.com/p.jpg",
		username: "someone",
	});
});

test("followingRecord: returns null when username is missing", () => {
	assert.equal(followingRecord({ pk: "1" }), null);
});

// ─── dedupeFollowingByUsername ──────────────────────────────────────────

test("dedupeFollowingByUsername: drops repeats, keeps first-seen order", () => {
	const out = dedupeFollowingByUsername([
		{ username: "a" },
		{ username: "b" },
		{ username: "a" },
	]);
	assert.deepEqual(
		out.map((u) => u.username),
		["a", "b"],
	);
});

// ─── stableAdId / adRecord ──────────────────────────────────────────────

test("stableAdId: deterministic for the same kind+name", () => {
	assert.equal(
		stableAdId("advertiser", "Acme Corp"),
		stableAdId("advertiser", "Acme Corp"),
	);
});

test("stableAdId: differs across kind for the same name", () => {
	assert.notEqual(stableAdId("advertiser", "X"), stableAdId("ad_topic", "X"));
});

test("stableAdId: is a 32-char lowercase hex string", () => {
	assert.match(stableAdId("ad_category", "Fitness"), /^[0-9a-f]{32}$/);
});

test("adRecord: trims whitespace and builds a stable id", () => {
	const record = adRecord("advertiser", "  Acme Corp  ");
	assert.equal(record?.name, "Acme Corp");
	assert.equal(record?.id, stableAdId("advertiser", "Acme Corp"));
	assert.equal(record?.description, null);
});

test("adRecord: returns null for a blank/whitespace-only name", () => {
	assert.equal(adRecord("advertiser", "   "), null);
});

// ─── buildAdRecords ─────────────────────────────────────────────────────

test("buildAdRecords: merges advertisers/ad_topics/categories with kind discriminators", () => {
	const records = buildAdRecords({
		adTopics: ["Sports"],
		advertisers: ["Acme"],
		categories: [{ description: "desc", name: "Pets" }],
	});
	assert.deepEqual(
		records.map((r) => ({ kind: r.kind, name: r.name })),
		[
			{ kind: "advertiser", name: "Acme" },
			{ kind: "ad_topic", name: "Sports" },
			{ kind: "ad_category", name: "Pets" },
		],
	);
	const category = records.find((r) => r.kind === "ad_category");
	assert.equal(category?.description, "desc");
});

test("buildAdRecords: drops blank names from any of the three sources", () => {
	const records = buildAdRecords({
		adTopics: [""],
		advertisers: ["  "],
		categories: [{ description: null, name: "" }],
	});
	assert.deepEqual(records, []);
});

test("buildAdRecords: ad ids are unique across kinds even with matching names", () => {
	const records = buildAdRecords({
		adTopics: ["Shared"],
		advertisers: ["Shared"],
		categories: [{ description: null, name: "Shared" }],
	});
	const ids = new Set(records.map((r) => r.id));
	assert.equal(ids.size, 3);
});

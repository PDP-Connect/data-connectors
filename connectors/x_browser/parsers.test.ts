// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	parseProfileBody,
	parseRequestVariables,
	parseTimelineBody,
	parseXDate,
	type TimelineOperation,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const OWNER_ID = "1900000000000000001";

function page(operation: TimelineOperation, name: string) {
	const parsed = parseTimelineBody(operation, fixture(name));
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) {
		throw new Error("unreachable");
	}
	return parsed;
}

test("parseXDate reads X's created_at without Date.parse", () => {
	assert.equal(
		parseXDate("Mon Mar 10 20:19:52 +0000 2025"),
		"2025-03-10T20:19:52.000Z",
	);
	assert.equal(
		parseXDate("Sat Jan 03 01:02:03 -0500 2026"),
		"2026-01-03T06:02:03.000Z",
	);
	for (const bad of [
		"2025-03-10T20:19:52Z",
		"Mon Foo 10 20:19:52 +0000 2025",
		"",
		null,
		1_741_637_992,
	]) {
		assert.equal(parseXDate(bad), null, String(bad));
	}
});

test("parseRequestVariables reads whose timeline a request was for", () => {
	assert.deepEqual(
		parseRequestVariables(`{"userId":"${OWNER_ID}","count":20,"cursor":"abc"}`),
		{ hasCursor: true, screenName: null, userId: OWNER_ID },
	);
	assert.deepEqual(parseRequestVariables('{"screen_name":"sample_owner"}'), {
		hasCursor: false,
		screenName: "sample_owner",
		userId: null,
	});
	for (const raw of ["", "not json", null, '{"userId":17}']) {
		assert.deepEqual(parseRequestVariables(raw), {
			hasCursor: false,
			screenName: null,
			userId: null,
		});
	}
});

test("the owner's profile is read from UserByScreenName", () => {
	const parsed = parseProfileBody(fixture("user-by-screen-name.json"));
	assert.equal(parsed.ok, true, JSON.stringify(parsed));
	if (!parsed.ok) {
		return;
	}
	assert.deepEqual(parsed.profile, {
		id: OWNER_ID,
		handle: "sample_owner",
		name: "Sample Owner",
		url: "https://x.com/sample_owner",
		bio: "Synthetic account for connector fixtures. Not a real person.",
		location: "Example City",
		website_url: "https://sample-owner.example.invalid/",
		avatar_url:
			"https://pbs.example.invalid/profile_images/1900000000000000001/avatar_normal.jpg",
		banner_url:
			"https://pbs.example.invalid/profile_banners/1900000000000000001/1700000000",
		account_created_at: "2014-03-04T09:15:00.000Z",
		followers_count: 128,
		following_count: 256,
		posts_count: 1024,
		likes_count: 512,
		is_blue_verified: false,
		is_verified: false,
		is_protected: false,
	});
	assert.equal(validateRecord("profile", { ...parsed.profile }).ok, true);
});

test("a profile whose sub-objects change shape keeps its identity and nulls the rest", () => {
	const body = JSON.parse(fixture("user-by-screen-name.json"));
	const user = body.data.user.result;
	// Each field is read from the one key seen on x.com. If X moves it, the
	// field is null: an older or neighbouring key is never read instead.
	user.profile_bio = { text: "elsewhere" };
	user.website = { expanded_url: "https://sample-owner.example.invalid/" };
	user.relationship_counts = { followers_count: 5, friends_count: 6 };
	user.tweet_counts = { statuses_count: 7 };
	user.privacy = { is_protected: true };
	user.verification = { is_verified: true };
	user.banner = undefined;
	const parsed = parseProfileBody(JSON.stringify(body));
	assert.equal(parsed.ok, true);
	if (!parsed.ok) {
		return;
	}
	assert.equal(parsed.profile.id, OWNER_ID);
	assert.equal(parsed.profile.handle, "sample_owner");
	for (const key of [
		"bio",
		"website_url",
		"banner_url",
		"followers_count",
		"following_count",
		"posts_count",
		"is_protected",
		"is_verified",
	] as const) {
		assert.equal(parsed.profile[key], null, key);
	}
	assert.equal(validateRecord("profile", { ...parsed.profile }).ok, true);
});

test("a profile response without a user id or handle is unreadable", () => {
	const parsed = parseProfileBody('{"data":{"user":{"result":{"core":{}}}}}');
	assert.equal(parsed.ok, false);
	assert.equal(parsed.ok ? null : parsed.failure, "unreadable");
});

test("the posts timeline keeps posts, flags the pinned one, and skips promoted, who-to-follow and deleted entries", () => {
	const parsed = page(
		"UserOriginalsTimeline",
		"user-originals-timeline-page-1.json",
	);
	assert.deepEqual(
		parsed.items.map(({ pinned, post }) => [post.id, pinned, post.kind]),
		[
			["1890000000000000090", true, "post"],
			["1990000000000000105", false, "post"],
			["1990000000000000104", false, "post"],
			["1990000000000000103", false, "quote"],
			["1990000000000000102", false, "post"],
		],
	);
	assert.equal(parsed.bottomCursor, "synthetic-originals-bottom-1");
	// The promoted post and the who-to-follow module.
	assert.equal(parsed.skippedEntries, 2);
	// The tombstone.
	assert.equal(parsed.unavailable, 1);
	assert.equal(parsed.unreadable, 0);
	// Five posts and the tombstone were sent; the promoted post is not counted.
	assert.equal(parsed.postResults, 6);
	for (const { post } of parsed.items) {
		assert.equal(post.author_id, OWNER_ID);
		assert.equal(
			validateRecord("posts", { ...post }).ok,
			true,
			JSON.stringify(validateRecord("posts", { ...post })),
		);
	}
});

test("post fields: entities, long text, quote and the visibility wrapper", () => {
	const { items } = page(
		"UserOriginalsTimeline",
		"user-originals-timeline-page-1.json",
	);
	const byId = new Map(items.map(({ post }) => [post.id, post]));
	const withMedia = byId.get("1990000000000000105");
	assert.deepEqual(withMedia, {
		id: "1990000000000000105",
		url: "https://x.com/sample_owner/status/1990000000000000105",
		kind: "post",
		created_at: "2026-10-05T18:30:00.000Z",
		text: "Synthetic post with a photo and a link https://t.example.invalid/a #fixtures",
		lang: "en",
		author_id: OWNER_ID,
		author_handle: "sample_owner",
		author_name: "Sample Owner",
		conversation_id: "1990000000000000105",
		in_reply_to_post_id: null,
		in_reply_to_handle: null,
		quoted_post_id: null,
		reposted_post_id: null,
		like_count: 12,
		repost_count: 1,
		reply_count: 0,
		quote_count: 0,
		bookmark_count: 2,
		view_count: 120,
		hashtags: ["fixtures"],
		mention_handles: [],
		urls: ["https://example.invalid/articles/synthetic"],
		media: [
			{
				type: "photo",
				url: "https://pbs.example.invalid/media/synthetic-photo-1.jpg",
			},
		],
		sort_index: "1990000000000000105",
	});
	// The long post's full text comes from note_tweet, not the truncated head.
	const long = byId.get("1990000000000000104");
	assert.ok(long?.text && long.text.length > 300);
	assert.ok(!long.text.endsWith("…"));
	assert.equal(
		byId.get("1990000000000000103")?.quoted_post_id,
		"1990000000000000050",
	);
	assert.deepEqual(byId.get("1990000000000000102")?.mention_handles, [
		"example_writer",
	]);
});

test("the replies timeline reads both sides of each conversation module", () => {
	const parsed = page(
		"UserRepliesTimeline",
		"user-replies-timeline-page-1.json",
	);
	assert.deepEqual(
		parsed.items.map(({ post }) => [
			post.id,
			post.author_handle,
			post.kind,
			post.in_reply_to_post_id,
		]),
		[
			["1990000000000000201", "example_writer", "post", null],
			["1990000000000000202", "sample_owner", "reply", "1990000000000000201"],
			["1990000000000000105", "sample_owner", "post", null],
			["1990000000000000203", "sample_gardener", "post", null],
			["1990000000000000204", "sample_owner", "reply", "1990000000000000203"],
		],
	);
	assert.equal(parsed.postResults, 5);
	assert.equal(parsed.bottomCursor, "synthetic-replies-bottom-1");
});

test("likes and bookmarks carry the author and text of each post", () => {
	const likes = page("Likes", "likes-page-1.json");
	assert.deepEqual(
		likes.items.map(({ post }) => [
			post.id,
			post.author_handle,
			post.author_name,
			post.text,
			post.sort_index,
		]),
		[
			[
				"1990000000000000301",
				"example_writer",
				"Example Writer",
				"Synthetic liked post one.",
				"2000000000000000305",
			],
			[
				"1980000000000000302",
				"sample_gardener",
				"Sample Gardener",
				"Synthetic liked post two, older than the next.",
				"2000000000000000304",
			],
			[
				"1990000000000000303",
				"example_writer",
				"Example Writer",
				"Synthetic liked post three.",
				"2000000000000000303",
			],
		],
	);
	const bookmarks = page("Bookmarks", "bookmarks-page-1.json");
	assert.deepEqual(
		bookmarks.items.map(({ post }) => post.id),
		["1990000000000000401", "1950000000000000402"],
	);
	for (const { post } of [...likes.items, ...bookmarks.items]) {
		assert.equal(validateRecord("likes", { ...post }).ok, true);
		assert.equal(validateRecord("bookmarks", { ...post }).ok, true);
	}
});

test("Bookmarks is read from its own envelope, not the user timeline's", () => {
	const asUser = parseTimelineBody("Likes", fixture("bookmarks-page-1.json"));
	assert.equal(asUser.ok, false);
	assert.equal(asUser.ok ? null : asUser.failure, "unreadable");
});

test("a page of cursors only has no posts and keeps its bottom cursor", () => {
	const body = JSON.stringify({
		data: {
			user: {
				result: {
					timeline: {
						timeline: {
							instructions: [
								{
									type: "TimelineAddEntries",
									entries: [
										{
											entryId: "cursor-top-1",
											sortIndex: "2",
											content: {
												entryType: "TimelineTimelineCursor",
												cursorType: "Top",
												value: "t",
											},
										},
										{
											entryId: "cursor-bottom-1",
											sortIndex: "1",
											content: {
												entryType: "TimelineTimelineCursor",
												cursorType: "Bottom",
												value: "b",
											},
										},
									],
								},
							],
						},
					},
				},
			},
		},
	});
	const parsed = parseTimelineBody("Likes", body);
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.items.length, 0);
		assert.equal(parsed.postResults, 0);
		assert.equal(parsed.bottomCursor, "b");
	}
});

test("errors without data fail as an error body; errors beside data do not", () => {
	const refused = parseTimelineBody("Likes", fixture("error-body.json"));
	assert.equal(refused.ok, false);
	if (!refused.ok) {
		assert.equal(refused.failure, "error_body");
		assert.match(refused.message, /code 88/);
	}
	const withData = JSON.parse(fixture("likes-page-1.json"));
	withData.errors = [{ message: "Synthetic per-item notice.", code: 144 }];
	const parsed = parseTimelineBody("Likes", JSON.stringify(withData));
	assert.equal(parsed.ok, true);
	const emptyData = parseTimelineBody("Likes", '{"errors":[{}],"data":{}}');
	assert.equal(emptyData.ok ? null : emptyData.failure, "error_body");
});

test("anything but the known envelope is unreadable, never an empty page", () => {
	for (const body of [
		"<html>Something went wrong</html>",
		"{}",
		'{"data":{"user":{"result":{"timeline_v9":{}}}}}',
		'{"data":{"user":{"result":{"timeline":{"timeline":{"instructions":{}}}}}}}',
	]) {
		const parsed = parseTimelineBody("UserOriginalsTimeline", body);
		assert.equal(parsed.ok, false, body);
		assert.equal(parsed.ok ? null : parsed.failure, "unreadable", body);
	}
});

test("a post without an id, author or readable date is counted unreadable, not emitted", () => {
	const body = JSON.parse(fixture("likes-page-1.json"));
	const entries =
		body.data.user.result.timeline.timeline.instructions[0].entries;
	entries[0].content.itemContent.tweet_results.result.legacy.created_at =
		"yesterday";
	entries[1].content.itemContent.tweet_results.result.__typename =
		"SomethingNew";
	const parsed = parseTimelineBody("Likes", JSON.stringify(body));
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.unreadable, 2);
		assert.equal(parsed.postResults, 3);
		assert.deepEqual(
			parsed.items.map(({ post }) => post.id),
			["1990000000000000303"],
		);
	}
});

test("a repost is kind repost and names the reposted post", () => {
	const body = JSON.parse(fixture("likes-page-1.json"));
	const entries =
		body.data.user.result.timeline.timeline.instructions[0].entries;
	const original = structuredClone(
		entries[1].content.itemContent.tweet_results.result,
	);
	entries[0].content.itemContent.tweet_results.result.legacy.retweeted_status_result =
		{ result: original };
	const parsed = parseTimelineBody("Likes", JSON.stringify(body));
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.items[0]?.post.kind, "repost");
		assert.equal(parsed.items[0]?.post.reposted_post_id, "1980000000000000302");
	}
});

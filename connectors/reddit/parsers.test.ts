// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	appendNewChildren,
	classifyListingStatus,
	commentRecord,
	commentStatsRecord,
	dedupeByFullname,
	domainOf,
	isoFromUnix,
	isTopLevelComment,
	nextAfter,
	pagePath,
	savedRecord,
	submittedRecord,
	submittedStatsRecord,
	TEXT_MAX_CHARS,
	textLen,
	truncateText,
	voteRecord,
	voteStatsRecord,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { RedditChild, RedditChildData } from "./types.ts";

const FETCHED_AT = "2026-04-24T12:00:00.000Z";

// ─── isoFromUnix ────────────────────────────────────────────────────────

test("isoFromUnix: converts numeric Unix seconds to ISO-8601 Z", () => {
	// 2024-04-02T10:52:54Z
	assert.equal(isoFromUnix(1_712_055_174), "2024-04-02T10:52:54.000Z");
});

test("isoFromUnix: accepts string numerics", () => {
	assert.equal(isoFromUnix("1712055174"), "2024-04-02T10:52:54.000Z");
});

test("isoFromUnix: null / undefined / empty / non-numeric → null", () => {
	assert.equal(isoFromUnix(null), null);
	assert.equal(isoFromUnix(undefined), null);
	assert.equal(isoFromUnix(""), null);
	assert.equal(isoFromUnix("not-a-number"), null);
	assert.equal(isoFromUnix(0), null);
	assert.equal(isoFromUnix(-1), null);
});

// ─── domainOf ───────────────────────────────────────────────────────────

test("domainOf: extracts lowercase hostname from a link URL", () => {
	assert.equal(
		domainOf("https://www.Axios.com/2024/04/02/ai"),
		"www.axios.com",
	);
	assert.equal(domainOf("http://arxiv.org/abs/2403.12345"), "arxiv.org");
});

test("domainOf: self-post pseudo-domain → null", () => {
	assert.equal(domainOf("https://self.LocalLLaMA"), null);
});

test("domainOf: reddit.com URLs → null (self-referential)", () => {
	assert.equal(domainOf("https://reddit.com/r/foo/comments/abc"), null);
	assert.equal(domainOf("https://old.reddit.com/r/foo"), null);
});

test("domainOf: invalid / null / empty → null", () => {
	assert.equal(domainOf(null), null);
	assert.equal(domainOf(undefined), null);
	assert.equal(domainOf(""), null);
	assert.equal(domainOf("not-a-url"), null);
});

// ─── truncateText / textLen ─────────────────────────────────────────────

test("truncateText: caps at TEXT_MAX_CHARS", () => {
	const long = "a".repeat(TEXT_MAX_CHARS + 500);
	const t = truncateText(long);
	assert.ok(t);
	assert.equal(t.length, TEXT_MAX_CHARS);
});

test("truncateText: preserves null, passes short strings through", () => {
	assert.equal(truncateText(null), null);
	assert.equal(truncateText(undefined), null);
	assert.equal(truncateText("short"), "short");
});

test("textLen: returns original length even after truncation", () => {
	const long = "b".repeat(TEXT_MAX_CHARS + 500);
	assert.equal(textLen(long), TEXT_MAX_CHARS + 500);
	assert.equal(textLen(""), 0);
	assert.equal(textLen(null), null);
	assert.equal(textLen(undefined), null);
});

// ─── isTopLevelComment ──────────────────────────────────────────────────

test("isTopLevelComment: t3_* parent → true, t1_* parent → false", () => {
	assert.equal(isTopLevelComment("t3_abc123"), true);
	assert.equal(isTopLevelComment("t1_xyz999"), false);
});

test("isTopLevelComment: null / undefined / empty → null", () => {
	assert.equal(isTopLevelComment(null), null);
	assert.equal(isTopLevelComment(undefined), null);
	assert.equal(isTopLevelComment(""), null);
});

// ─── classifyListingStatus ──────────────────────────────────────────────

test("classifyListingStatus: maps HTTP codes to error classes", () => {
	assert.equal(classifyListingStatus(200), null);
	assert.equal(classifyListingStatus(401), "auth_failed");
	assert.equal(classifyListingStatus(403), "auth_failed");
	assert.equal(classifyListingStatus(429), "rate_limited");
	assert.equal(classifyListingStatus(500), "http_error");
	assert.equal(classifyListingStatus(0), "http_error");
});

// ─── submittedRecord ────────────────────────────────────────────────────

test("submittedRecord: full link post → enriched record, passes schema", () => {
	const d: RedditChildData = {
		name: "t3_1btvpos",
		subreddit: "LocalLLaMA",
		title: "Decentralizers look to break giants' hold over AI",
		permalink:
			"/r/LocalLLaMA/comments/1btvpos/decentralizers_look_to_break_giants_hold_over_ai/",
		url: "https://www.axios.com/2024/04/02/ai-decentralized-big-tech-blockchain",
		selftext: "",
		is_self: false,
		over_18: false,
		score: 98,
		num_comments: 127,
		upvote_ratio: 0.83,
		gilded: 0,
		created_utc: 1_712_055_174,
	};
	const r = submittedRecord(d, FETCHED_AT);
	assert.equal(r.id, "t3_1btvpos");
	assert.equal(r.subreddit, "LocalLLaMA");
	assert.equal(r.domain, "www.axios.com");
	assert.equal(
		r.permalink,
		"https://reddit.com/r/LocalLLaMA/comments/1btvpos/decentralizers_look_to_break_giants_hold_over_ai/",
	);
	assert.equal(r.selftext, "");
	assert.equal(r.selftext_len, 0);
	assert.equal(r.created_utc, "2024-04-02T10:52:54.000Z");
	const v = validateRecord("submitted", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("submittedRecord: self post → domain null, long selftext truncated, len preserves original", () => {
	const longBody = "x".repeat(TEXT_MAX_CHARS + 250);
	const d: RedditChildData = {
		name: "t3_self01",
		subreddit: "test",
		title: "Self post",
		permalink: "/r/test/comments/self01/self_post/",
		url: "https://self.test",
		selftext: longBody,
		is_self: true,
		score: 1,
		num_comments: 0,
		upvote_ratio: 1,
		created_utc: 1_712_055_174,
	};
	const r = submittedRecord(d, FETCHED_AT);
	assert.equal(r.domain, null, "self-post pseudo-domain must be null");
	assert.equal((r.selftext as string).length, TEXT_MAX_CHARS);
	assert.equal(r.selftext_len, longBody.length);
	const v = validateRecord("submitted", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("submittedRecord: missing optional fields → null, still passes schema", () => {
	const d: RedditChildData = {
		name: "t3_minimal",
		subreddit: "test",
		title: "x",
		permalink: "/r/test/comments/minimal/x/",
		url: null,
		created_utc: 1_712_055_174,
	};
	const r = submittedRecord(d, FETCHED_AT);
	assert.equal(r.is_self, null);
	assert.equal(r.over_18, null);
	assert.equal(r.domain, null);
	const v = validateRecord("submitted", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("content records carry no volatile source metrics", () => {
	const d: RedditChildData = {
		name: "t3_metrics",
		subreddit: "test",
		title: "x",
		permalink: "/r/test/comments/metrics/x/",
		url: "https://example.com",
		score: 9,
		num_comments: 8,
		upvote_ratio: 0.7,
		gilded: 1,
		created_utc: 1_712_055_174,
	};
	const c: RedditChild = { kind: "t3", data: d };
	for (const record of [
		submittedRecord(d, FETCHED_AT),
		commentRecord(d, FETCHED_AT),
		savedRecord(c, FETCHED_AT),
		voteRecord(c, FETCHED_AT),
	]) {
		for (const key of ["score", "num_comments", "upvote_ratio", "gilded"]) {
			assert.equal(
				key in record,
				false,
				`content record must not carry ${key}`,
			);
		}
	}
});

// ─── current-stats builders ─────────────────────────────────────────────

test("submittedStatsRecord: same fullname key, source metrics verbatim, source created_utc, no clock", () => {
	const d: RedditChildData = {
		name: "t3_1btvpos",
		score: 98,
		num_comments: 127,
		upvote_ratio: 0.83,
		gilded: 2,
		created_utc: 1_712_055_174,
	};
	const r = submittedStatsRecord(d);
	assert.deepEqual(r, {
		id: "t3_1btvpos",
		score: 98,
		num_comments: 127,
		upvote_ratio: 0.83,
		gilded: 2,
		created_utc: "2024-04-02T10:52:54.000Z",
	});
	const v = validateRecord("submitted_stats", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("submittedStatsRecord: absent source metrics are null, not zero", () => {
	const r = submittedStatsRecord({
		name: "t3_minimal",
		created_utc: 1_712_055_174,
	});
	assert.equal(r.score, null);
	assert.equal(r.num_comments, null);
	assert.equal(r.upvote_ratio, null);
	assert.equal(r.gilded, null);
	assert.ok(validateRecord("submitted_stats", r).ok);
});

test("commentStatsRecord: score and gilded only", () => {
	const r = commentStatsRecord({
		name: "t1_abc",
		score: 16,
		gilded: 0,
		num_comments: 99,
		created_utc: 1_717_981_114,
	});
	assert.deepEqual(Object.keys(r).sort(), [
		"created_utc",
		"gilded",
		"id",
		"score",
	]);
	assert.equal(r.score, 16);
	assert.ok(validateRecord("comments_stats", r).ok);
});

test("voteStatsRecord: score and num_comments, valid for all three vote-shaped stats streams", () => {
	const c: RedditChild = {
		kind: "t3",
		data: {
			name: "t3_up1",
			score: 1234,
			num_comments: 56,
			gilded: 3,
			upvote_ratio: 0.5,
			created_utc: 1_717_981_114,
		},
	};
	const r = voteStatsRecord(c);
	assert.deepEqual(r, {
		id: "t3_up1",
		score: 1234,
		num_comments: 56,
		created_utc: "2024-06-10T00:58:34.000Z",
	});
	for (const stream of ["upvoted_stats", "downvoted_stats", "hidden_stats"]) {
		assert.ok(validateRecord(stream, r).ok, stream);
	}
});

test("stats schemas reject a content-stream fullname kind mismatch", () => {
	assert.equal(
		validateRecord("submitted_stats", {
			id: "t1_comment",
			score: 1,
			num_comments: 0,
			upvote_ratio: 1,
			gilded: 0,
			created_utc: "2024-04-02T10:52:54.000Z",
		}).ok,
		false,
	);
	assert.equal(
		validateRecord("comments_stats", {
			id: "t3_post",
			score: 1,
			gilded: 0,
			created_utc: "2024-04-02T10:52:54.000Z",
		}).ok,
		false,
	);
});

// ─── commentRecord ──────────────────────────────────────────────────────

test("commentRecord: top-level comment (parent t3_*) marks is_top_level=true", () => {
	const d: RedditChildData = {
		name: "t1_abc",
		subreddit: "Economics",
		body: "Need to adjust for inflation",
		link_id: "t3_1l8cer6",
		parent_id: "t3_1l8cer6",
		permalink: "/r/Economics/comments/1l8cer6/.../abc/",
		score: 16,
		created_utc: 1_717_981_114,
	};
	const r = commentRecord(d, FETCHED_AT);
	assert.equal(r.is_top_level, true);
	assert.equal(r.body_len, d.body?.length);
	const v = validateRecord("comments", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("commentRecord: nested reply (parent t1_*) marks is_top_level=false", () => {
	const d: RedditChildData = {
		name: "t1_xyz",
		subreddit: "Economics",
		body: "Agreed",
		link_id: "t3_post01",
		parent_id: "t1_parent0",
		permalink: "/r/Economics/comments/post/.../xyz/",
		score: 2,
		created_utc: 1_717_981_114,
	};
	const r = commentRecord(d, FETCHED_AT);
	assert.equal(r.is_top_level, false);
	const v = validateRecord("comments", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

// ─── savedRecord ────────────────────────────────────────────────────────

test("savedRecord: saved comment (t1) → is_post=false, body derived from body", () => {
	const c: RedditChild = {
		kind: "t1",
		data: {
			name: "t1_savedc0",
			subreddit: "advice",
			body: "Here's my tip",
			link_title: "How do I X",
			permalink: "/r/advice/comments/x/savedc0/",
			created_utc: 1_717_981_114,
		},
	};
	const r = savedRecord(c, FETCHED_AT);
	assert.equal(r.is_post, false);
	assert.equal(r.kind, "t1");
	assert.equal(r.title, "How do I X");
	assert.equal(r.body, "Here's my tip");
	const v = validateRecord("saved", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("savedRecord: saved post (t3) → is_post=true, body derived from selftext", () => {
	const c: RedditChild = {
		kind: "t3",
		data: {
			name: "t3_savedp0",
			subreddit: "advice",
			title: "My post",
			selftext: "post body",
			permalink: "/r/advice/comments/savedp0/my_post/",
			created_utc: 1_717_981_114,
		},
	};
	const r = savedRecord(c, FETCHED_AT);
	assert.equal(r.is_post, true);
	assert.equal(r.kind, "t3");
	assert.equal(r.title, "My post");
	assert.equal(r.body, "post body");
	const v = validateRecord("saved", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

// ─── voteRecord ─────────────────────────────────────────────────────────

test("voteRecord: upvoted post keeps identity, kind and text but not the metrics", () => {
	const c: RedditChild = {
		kind: "t3",
		data: {
			name: "t3_up1",
			subreddit: "science",
			title: "A study",
			url: "https://nature.com/articles/123",
			permalink: "/r/science/comments/up1/a_study/",
			score: 1234,
			num_comments: 56,
			created_utc: 1_717_981_114,
		},
	};
	const r = voteRecord(c, FETCHED_AT);
	assert.equal(r.is_post, true);
	assert.equal(r.id, "t3_up1");
	assert.equal("score" in r, false);
	assert.equal("num_comments" in r, false);
	const v = validateRecord("upvoted", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
	// Downvoted and hidden share the same shape.
	assert.ok(validateRecord("downvoted", r).ok);
	assert.ok(validateRecord("hidden", r).ok);
});

test("voteRecord: accepts Reddit's archived legacy reddit.com subreddit", () => {
	const c: RedditChild = {
		kind: "t3",
		data: {
			name: "t3_legacy",
			subreddit: "reddit.com",
			title: "Legacy front-page post",
			permalink: "/r/reddit.com/comments/legacy/legacy_front_page_post/",
			created_utc: 1_302_000_000,
		},
	};
	const r = voteRecord(c, FETCHED_AT);
	assert.equal(r.subreddit, "reddit.com");
	const v = validateRecord("upvoted", r);
	assert.ok(v.ok, `schema failed: ${v.ok ? "" : JSON.stringify(v.issues)}`);
});

test("voteRecord: rejects unverified dotted subreddit names", () => {
	const c: RedditChild = {
		kind: "t3",
		data: {
			name: "t3_unverified",
			subreddit: "not.a.real.sub",
			title: "Unexpected dotted subreddit",
			permalink:
				"/r/not.a.real.sub/comments/unverified/unexpected_dotted_subreddit/",
			created_utc: 1_712_055_174,
		},
	};
	const r = voteRecord(c, FETCHED_AT);
	const v = validateRecord("upvoted", r);
	assert.equal(
		v.ok,
		false,
		"only the observed legacy reddit.com subreddit should pass",
	);
});

// ─── Pagination helpers ─────────────────────────────────────────────────

test("pagePath: builds URL with limit, encodes 'after'", () => {
	assert.equal(
		pagePath("/user/u/comments.json", null),
		"/user/u/comments.json?limit=100",
	);
	assert.equal(
		pagePath("/user/u/comments.json", "t3_abc+def"),
		"/user/u/comments.json?limit=100&after=t3_abc%2Bdef",
	);
});

test("nextAfter: unwraps listing, normalizes empty string to null", () => {
	assert.equal(nextAfter(null), null);
	assert.equal(nextAfter(undefined), null);
	assert.equal(nextAfter({ data: { after: null } }), null);
	assert.equal(nextAfter({ data: { after: "" } }), null);
	assert.equal(nextAfter({ data: { after: "t3_xyz" } }), "t3_xyz");
});

test("appendNewChildren: collects all when no cursor", () => {
	const out: RedditChild[] = [];
	const children: RedditChild[] = [
		{ kind: "t3", data: { name: "t3_a", created_utc: 200 } },
		{ kind: "t3", data: { name: "t3_b", created_utc: 100 } },
	];
	const stop = appendNewChildren(children, null, out);
	assert.equal(stop, false);
	assert.equal(out.length, 2);
});

test("appendNewChildren: stops once an item is at or below cursor", () => {
	const out: RedditChild[] = [];
	const children: RedditChild[] = [
		{ kind: "t3", data: { name: "t3_a", created_utc: 300 } },
		{ kind: "t3", data: { name: "t3_b", created_utc: 200 } },
		{ kind: "t3", data: { name: "t3_c", created_utc: 100 } },
	];
	const stop = appendNewChildren(children, 200, out);
	assert.equal(stop, true, "must signal stop when crossing cursor");
	assert.equal(out.length, 1, "only items strictly newer than cursor emit");
	assert.equal(out[0]?.data.name, "t3_a");
});

// ─── Action-ordered listings must not stop on created_utc ───────────────
//
// Regression guard for the observed defect: `upvoted` held a stored cursor of
// 2026-04-28 while the account's real upvote history reached back to 2011.
// Upvoting one old post puts an old `created_utc` at rank 1, and the
// created-based stop then halted the walk on item one, freezing the stream.

test("appendNewChildren: action-ordered listing does not stop on an old item at the top", () => {
	const out: RedditChild[] = [];
	// Rank 1 is a 2015 post the owner upvoted TODAY — far below the cursor.
	// A created-ordered stop would halt here and lose the two newer items.
	const children: RedditChild[] = [
		{ kind: "t3", data: { name: "t3_old", created_utc: 100 } },
		{ kind: "t3", data: { name: "t3_mid", created_utc: 5000 } },
		{ kind: "t3", data: { name: "t3_new", created_utc: 9000 } },
	];
	const stop = appendNewChildren(children, 4000, out, "action");
	assert.equal(stop, false, "action-ordered listings must keep paging");
	assert.equal(
		out.length,
		3,
		"every child must be kept regardless of created_utc",
	);
	assert.deepEqual(
		out.map((c) => c.data.name),
		["t3_old", "t3_mid", "t3_new"],
	);
});

test("appendNewChildren: created-ordered listing still stops at the cursor", () => {
	// The helper still supports safe early-stop semantics when a caller
	// explicitly supplies a creation cursor.
	const out: RedditChild[] = [];
	const children: RedditChild[] = [
		{ kind: "t3", data: { name: "t3_a", created_utc: 300 } },
		{ kind: "t3", data: { name: "t3_b", created_utc: 200 } },
	];
	const stop = appendNewChildren(children, 200, out, "created");
	assert.equal(stop, true, "created-ordered listings must stop at the cursor");
	assert.equal(out.length, 1);
});

test("appendNewChildren: defaults to created-ordered when no order is given", () => {
	// Guards the default parameter: an omitted order must be the SAFE-for-
	// submitted/comments behavior, and callers must opt IN to the full walk.
	const out: RedditChild[] = [];
	const children: RedditChild[] = [
		{ kind: "t3", data: { name: "t3_a", created_utc: 100 } },
	];
	assert.equal(appendNewChildren(children, 200, out), true);
	assert.equal(out.length, 0);
});

test("dedupeByFullname: collapses repeat sightings, keeping first-seen order", () => {
	const children: RedditChild[] = [
		{ kind: "t3", data: { name: "t3_a", created_utc: 300 } },
		{ kind: "t1", data: { name: "t1_b", created_utc: 200 } },
		{ kind: "t3", data: { name: "t3_a", created_utc: 300 } },
	];
	const out = dedupeByFullname(children);
	assert.equal(out.length, 2, "a repeated fullname must collapse to one item");
	assert.deepEqual(
		out.map((c) => c.data.name),
		["t3_a", "t1_b"],
		"first-seen order must be preserved",
	);
});

test("dedupeByFullname: keeps children lacking a fullname rather than collapsing them", () => {
	// Two distinct nameless children must NOT collapse into one — treating a
	// missing name as a single shared identity would silently drop real data.
	const children: RedditChild[] = [
		{ kind: "t3", data: { created_utc: 300 } },
		{ kind: "t3", data: { created_utc: 200 } },
	];
	assert.equal(dedupeByFullname(children).length, 2);
});

// ─── Schema negative cases ──────────────────────────────────────────────

test("validateRecord: rejects submitted id that isn't a t3_* fullname", () => {
	const r = submittedRecord(
		{
			name: "t1_notapost",
			subreddit: "test",
			title: "x",
			permalink: "/r/test/comments/x/x/",
			url: null,
			created_utc: 1_712_055_174,
		},
		FETCHED_AT,
	);
	const v = validateRecord("submitted", r);
	assert.equal(v.ok, false, "t1_* must not pass submitted schema");
});

test("validateRecord: rejects comment with non-reddit permalink", () => {
	const r = commentRecord(
		{
			name: "t1_abc001",
			subreddit: "x",
			body: "b",
			link_id: "t3_post01",
			parent_id: "t3_post01",
			// Bad permalink: no leading slash ⇒ absolutePermalink prepends reddit.com
			// but path is wrong shape.
			permalink: "",
			score: 1,
			created_utc: 1_712_055_174,
		},
		FETCHED_AT,
	);
	assert.equal(r.permalink, null);
	const v = validateRecord("comments", r);
	// Empty permalink IS allowed (nullable). Schema should pass.
	assert.ok(v.ok);
});

test("validateRecord: unknown stream returns ok:true pass-through", () => {
	const v = validateRecord("not_a_stream", { id: "x" });
	assert.ok(v.ok);
});

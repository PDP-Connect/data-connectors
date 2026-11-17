// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DM_ENTRY,
	DM_ENTRY_WITH_MALFORMED,
	TWEET_ENTRY_LEGACY,
	TWEET_ENTRY_MODERN,
	TWEET_NO_DATE,
	TWEET_REPLY,
} from "./__fixtures__/archive-samples.ts";
import {
	advanceCursor,
	buildDmRecord,
	buildTweetRecord,
	isBeforeCursor,
	toIntOrNull,
	toIsoOrNull,
	unwrapDmConversation,
	unwrapDmMessage,
	unwrapTweetEntry,
} from "./parsers.ts";

// ─── toIsoOrNull ────────────────────────────────────────────────────────

test("toIsoOrNull: parses RFC-ish Twitter timestamp → ISO Z", () => {
	assert.equal(
		toIsoOrNull("Wed Jun 05 13:45:22 +0000 2024"),
		"2024-06-05T13:45:22.000Z",
	);
});

test("toIsoOrNull: undefined → null", () => {
	assert.equal(toIsoOrNull(undefined), null);
});

test("toIsoOrNull: garbage → null", () => {
	assert.equal(toIsoOrNull("not-a-date"), null);
});

// ─── toIntOrNull ────────────────────────────────────────────────────────

test("toIntOrNull: string integer → number", () => {
	assert.equal(toIntOrNull("42"), 42);
});

test("toIntOrNull: number passthrough", () => {
	assert.equal(toIntOrNull(7), 7);
});

test("toIntOrNull: undefined / null / empty → null", () => {
	assert.equal(toIntOrNull(undefined), null);
	assert.equal(toIntOrNull(""), null);
});

test("toIntOrNull: non-numeric string → null", () => {
	assert.equal(toIntOrNull("abc"), null);
});

// ─── unwrapTweetEntry ───────────────────────────────────────────────────

test("unwrapTweetEntry: modern layout → .tweet", () => {
	const t = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	assert.equal(t.id_str, "1234567890");
	assert.equal(t.full_text, "Hello world!");
});

test("unwrapTweetEntry: legacy layout → entry itself", () => {
	const t = unwrapTweetEntry(TWEET_ENTRY_LEGACY);
	assert.equal(t.id_str, "9999");
	assert.equal(t.full_text, "Legacy shape");
});

// ─── buildTweetRecord ───────────────────────────────────────────────────

test("buildTweetRecord: modern tweet → full record with media/url counts", () => {
	const t = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	const rec = buildTweetRecord(t);
	assert.ok(rec);
	assert.equal(rec.id, "1234567890");
	assert.equal(rec.text, "Hello world!");
	assert.equal(rec.created_at, "2024-06-05T13:45:22.000Z");
	assert.equal(rec.favorite_count, 42);
	assert.equal(rec.retweet_count, 7);
	assert.equal(rec.lang, "en");
	assert.equal(rec.media_count, 1);
	assert.equal(rec.url_count, 2);
	assert.equal(rec.in_reply_to_status_id, null);
	assert.equal(rec.in_reply_to_screen_name, null);
});

test("buildTweetRecord: counts all extended media without changing other fields", () => {
	const tweet = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	const original = buildTweetRecord(tweet);
	assert.ok(original);
	const rec = buildTweetRecord(
		unwrapTweetEntry({
			tweet: {
				...tweet,
				extended_entities: {
					media: [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }],
					urls: [{ url: "https://example.invalid/ignored" }],
				},
			},
		}),
	);
	assert.deepEqual(rec, { ...original, media_count: 4 });
});

test("buildTweetRecord: extended media repeats rather than adds the first item", () => {
	const tweet = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	assert.deepEqual(
		buildTweetRecord(
			unwrapTweetEntry({
				tweet: { ...tweet, extended_entities: { media: [{ id: "m1" }] } },
			}),
		),
		buildTweetRecord(tweet),
	);
});

test("buildTweetRecord: an empty extended media array takes precedence", () => {
	const tweet = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	const original = buildTweetRecord(tweet);
	assert.ok(original);
	assert.deepEqual(
		buildTweetRecord(
			unwrapTweetEntry({
				tweet: { ...tweet, extended_entities: { media: [] } },
			}),
		),
		{ ...original, media_count: 0 },
	);
});

test("buildTweetRecord: malformed extended media falls back to entities", () => {
	const tweet = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	for (const media of [undefined, null, "not-an-array", { length: 4 }]) {
		assert.deepEqual(
			buildTweetRecord(
				unwrapTweetEntry({
					tweet: { ...tweet, extended_entities: { media } },
				}),
			),
			buildTweetRecord(tweet),
		);
	}
});

test("buildTweetRecord: missing or malformed media arrays count as zero", () => {
	const tweet = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	const original = buildTweetRecord(tweet);
	assert.ok(original);
	for (const media of [undefined, null, "not-an-array", { length: 4 }]) {
		assert.deepEqual(
			buildTweetRecord(
				unwrapTweetEntry({
					tweet: {
						...tweet,
						entities: { ...tweet.entities, media },
						extended_entities: { media: null },
					},
				}),
			),
			{ ...original, media_count: 0 },
		);
	}
});

test("buildTweetRecord: URL counts reject non-arrays and preserve other fields", () => {
	const tweet = {
		id_str: "synthetic-url-count",
		created_at: "2024-06-05T13:45:22.000Z",
		full_text: "Synthetic tweet",
		favorite_count: "3",
		retweet_count: "2",
		lang: "en",
		in_reply_to_status_id_str: "parent",
		in_reply_to_screen_name: "synthetic-parent",
		extended_entities: { media: [{ id: "m1" }, { id: "m2" }] },
	};
	const expected = {
		id: "synthetic-url-count",
		text: "Synthetic tweet",
		created_at: "2024-06-05T13:45:22.000Z",
		favorite_count: 3,
		retweet_count: 2,
		lang: "en",
		in_reply_to_status_id: "parent",
		in_reply_to_screen_name: "synthetic-parent",
		media_count: 2,
		url_count: 0,
	};
	for (const urls of [{}, "not-an-array", null, undefined, []]) {
		assert.deepEqual(
			buildTweetRecord(
				unwrapTweetEntry({ tweet: { ...tweet, entities: { urls } } }),
			),
			expected,
		);
	}
	assert.deepEqual(buildTweetRecord(tweet), expected);
	assert.deepEqual(
		buildTweetRecord({
			...tweet,
			entities: {
				urls: [
					{ url: "https://example.invalid/a" },
					{ url: "https://example.invalid/b" },
				],
			},
		}),
		{ ...expected, url_count: 2 },
	);
});

test("buildTweetRecord: reply tweet populates reply fields", () => {
	const t = unwrapTweetEntry(TWEET_REPLY);
	const rec = buildTweetRecord(t);
	assert.ok(rec);
	assert.equal(rec.in_reply_to_status_id, "1900");
	assert.equal(rec.in_reply_to_screen_name, "alice");
});

test("buildTweetRecord: legacy layout also builds a record", () => {
	const t = unwrapTweetEntry(TWEET_ENTRY_LEGACY);
	const rec = buildTweetRecord(t);
	assert.ok(rec);
	assert.equal(rec.id, "9999");
	assert.equal(rec.favorite_count, 3);
	assert.equal(rec.retweet_count, 0);
	assert.equal(rec.media_count, 0);
});

test("buildTweetRecord: missing created_at → null (skip)", () => {
	const t = unwrapTweetEntry(TWEET_NO_DATE);
	assert.equal(buildTweetRecord(t), null);
});

test("buildTweetRecord: full_text preferred over text when both present", () => {
	const t = unwrapTweetEntry(TWEET_ENTRY_MODERN);
	// modern fixture has both — full_text should win.
	const rec = buildTweetRecord(t);
	assert.ok(rec);
	assert.equal(rec.text, "Hello world!");
});

// ─── DM unwrapping + building ──────────────────────────────────────────

test("unwrapDmConversation: wrapped entry → conversation", () => {
	const c = unwrapDmConversation(DM_ENTRY);
	assert.equal(c.conversationId, "111-222");
	assert.equal(c.messages?.length, 2);
});

test("unwrapDmMessage: wrapped message → DMShape", () => {
	const c = unwrapDmConversation(DM_ENTRY);
	const m = c.messages?.[0];
	assert.ok(m);
	const dm = unwrapDmMessage(m);
	assert.equal(dm.id, "m1");
	assert.equal(dm.text, "hey");
});

test("buildDmRecord: populated DM → full record", () => {
	const c = unwrapDmConversation(DM_ENTRY);
	const m = c.messages?.[0];
	assert.ok(m);
	const dm = unwrapDmMessage(m);
	const rec = buildDmRecord(dm, c.conversationId ?? null);
	assert.ok(rec);
	assert.equal(rec.id, "m1");
	assert.equal(rec.conversation_id, "111-222");
	assert.equal(rec.sender_id, "111");
	assert.equal(rec.recipient_id, "222");
	assert.equal(rec.text, "hey");
	assert.equal(rec.created_at, "2024-06-05T13:45:22.000Z");
});

test("buildDmRecord: malformed message without createdAt → null", () => {
	const c = unwrapDmConversation(DM_ENTRY_WITH_MALFORMED);
	const bad = c.messages?.[1];
	assert.ok(bad);
	const dm = unwrapDmMessage(bad);
	assert.equal(buildDmRecord(dm, c.conversationId ?? null), null);
});

// ─── Cursor helpers ────────────────────────────────────────────────────

test("isBeforeCursor: no cursor → false (keep)", () => {
	assert.equal(isBeforeCursor("2024-06-05T13:00:00.000Z", undefined), false);
});

test("isBeforeCursor: equal timestamp → true (skip already-emitted)", () => {
	assert.equal(
		isBeforeCursor("2024-06-05T13:00:00.000Z", "2024-06-05T13:00:00.000Z"),
		true,
	);
});

test("isBeforeCursor: strictly after → false (keep)", () => {
	assert.equal(
		isBeforeCursor("2024-06-06T13:00:00.000Z", "2024-06-05T13:00:00.000Z"),
		false,
	);
});

test("advanceCursor: monotonic max across prev/next combinations", () => {
	assert.equal(
		advanceCursor(undefined, "2024-06-05T00:00:00.000Z"),
		"2024-06-05T00:00:00.000Z",
	);
	assert.equal(
		advanceCursor("2024-06-05T00:00:00.000Z", "2024-06-06T00:00:00.000Z"),
		"2024-06-06T00:00:00.000Z",
	);
	assert.equal(
		advanceCursor("2024-06-06T00:00:00.000Z", "2024-06-05T00:00:00.000Z"),
		"2024-06-06T00:00:00.000Z",
	);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildLikeRecordFromCsvRow,
	buildPlaylistItemRecordFromCsvRow,
	buildPlaylistRecordFromCsvRow,
	buildProfileRecordFromChannelCsvRow,
	buildSubscriptionRecordFromCsvRow,
	buildWatchHistoryRecordFromEntry,
	buildWatchLaterRecordFromCsvRow,
	durationTextToSeconds,
	extractVideoId,
	hashId,
	intOrNull,
	parseCsvRows,
	parseLikesCsv,
	parsePlaylistItemsCsv,
	parsePlaylistsCsv,
	parseSubscriptionsCsv,
	parseWatchLaterCsv,
	trimmedOrNull,
} from "./parsers.ts";

function columnsOf(header: readonly string[]): Map<string, number> {
	return new Map(header.map((name, i) => [name, i]));
}

test("parseCsvRows handles quoted commas and doubled quotes", () => {
	const rows = parseCsvRows('a,"b, c","d""e"\n1,2,3\n');
	assert.deepEqual(rows, [
		["a", "b, c", 'd"e'],
		["1", "2", "3"],
	]);
});

test("parseCsvRows tolerates no trailing newline", () => {
	const rows = parseCsvRows("a,b\n1,2");
	assert.deepEqual(rows, [
		["a", "b"],
		["1", "2"],
	]);
});

test("trimmedOrNull nulls blank strings, never empty string", () => {
	assert.equal(trimmedOrNull("  "), null);
	assert.equal(trimmedOrNull(undefined), null);
	assert.equal(trimmedOrNull(" hi "), "hi");
});

test("intOrNull parses digits and nulls the rest", () => {
	assert.equal(intOrNull("42"), 42);
	assert.equal(intOrNull(""), null);
	assert.equal(intOrNull("not a number"), null);
});

test("durationTextToSeconds parses MM:SS and H:MM:SS, nulls anything else", () => {
	assert.equal(durationTextToSeconds("4:30"), 270);
	assert.equal(durationTextToSeconds("1:02:03"), 3723);
	assert.equal(durationTextToSeconds(""), null);
	assert.equal(durationTextToSeconds("live"), null);
});

test("extractVideoId reads v= and /shorts/ forms, nulls the rest", () => {
	assert.equal(
		extractVideoId("https://www.youtube.com/watch?v=abcdEFGH123"),
		"abcdEFGH123",
	);
	assert.equal(
		extractVideoId("https://www.youtube.com/shorts/abcdEFGH123"),
		"abcdEFGH123",
	);
	assert.equal(extractVideoId(null), null);
	assert.equal(extractVideoId("https://example.com/"), null);
});

test("buildProfileRecordFromChannelCsvRow requires a Channel Id and nulls unverified fields", () => {
	const columns = columnsOf(["Channel Id", "Channel Url"]);
	const record = buildProfileRecordFromChannelCsvRow(
		["UC123", "https://www.youtube.com/channel/UC123"],
		columns,
		"owner@example.com",
	);
	assert.ok(record);
	assert.equal(record.id, "UC123");
	assert.equal(record.channel_url, "https://www.youtube.com/channel/UC123");
	assert.equal(record.email, "owner@example.com");
	assert.equal(record.title, null);
	assert.equal(record.handle, null);
	assert.equal(record.subscriber_count, null);
});

test("buildProfileRecordFromChannelCsvRow returns null with no Channel Id", () => {
	const columns = columnsOf(["Channel Url"]);
	assert.equal(
		buildProfileRecordFromChannelCsvRow(["https://x"], columns, null),
		null,
	);
});

test("parseSubscriptionsCsv maps rows and skips blank trailing lines", () => {
	const text =
		"Channel Id,Channel Url,Channel Title\n" +
		"UC1,https://www.youtube.com/channel/UC1,Channel One\n" +
		"UC2,https://www.youtube.com/channel/UC2,Channel Two\n";
	const records = parseSubscriptionsCsv(text);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.channel_id, "UC1");
	assert.equal(records[0]?.channel_title, "Channel One");
	assert.equal(records[0]?.is_verified, null);
});

test("parseSubscriptionsCsv returns empty for an empty file", () => {
	assert.deepEqual(parseSubscriptionsCsv(""), []);
});

test("buildSubscriptionRecordFromCsvRow requires a Channel Id", () => {
	const columns = columnsOf(["Channel Title"]);
	assert.equal(buildSubscriptionRecordFromCsvRow(["No Id"], columns), null);
});

test("parsePlaylistsCsv maps rows", () => {
	const text = "Playlist Id,Playlist Name\nPL1,My Mix\nPL2,Favorites\n";
	const records = parsePlaylistsCsv(text);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.id, "PL1");
	assert.equal(records[0]?.title, "My Mix");
	assert.equal(records[0]?.url, null);
});

test("buildPlaylistRecordFromCsvRow requires a Playlist Id", () => {
	const columns = columnsOf(["Playlist Name"]);
	assert.equal(buildPlaylistRecordFromCsvRow(["No Id"], columns), null);
});

test("parsePlaylistItemsCsv maps video ids to a stable per-video record", () => {
	const text =
		"Video Id,Playlist Video Creation Timestamp\nvid123,2024-01-01T00:00:00Z\n";
	const records = parsePlaylistItemsCsv(text, "PL1");
	assert.equal(records.length, 1);
	assert.equal(records[0]?.playlist_id, "PL1");
	assert.equal(records[0]?.video_id, "vid123");
	assert.equal(records[0]?.video_url, "https://www.youtube.com/watch?v=vid123");
	assert.equal(records[0]?.id, hashId("playlist_item|PL1|vid123"));
});

test("buildPlaylistItemRecordFromCsvRow requires a Video Id", () => {
	const columns = columnsOf(["Playlist Video Creation Timestamp"]);
	assert.equal(
		buildPlaylistItemRecordFromCsvRow(["2024-01-01"], columns, "PL1"),
		null,
	);
});

test("parseLikesCsv and parseWatchLaterCsv map Video Id rows independently", () => {
	const text = "Video Id\nvidA\nvidB\n";
	const likes = parseLikesCsv(text);
	const watchLater = parseWatchLaterCsv(text);
	assert.equal(likes.length, 2);
	assert.equal(watchLater.length, 2);
	assert.notEqual(likes[0]?.id, watchLater[0]?.id);
});

test("buildLikeRecordFromCsvRow and buildWatchLaterRecordFromCsvRow require a Video Id", () => {
	const columns = columnsOf(["Something Else"]);
	assert.equal(buildLikeRecordFromCsvRow(["x"], columns), null);
	assert.equal(buildWatchLaterRecordFromCsvRow(["x"], columns), null);
});

test("buildWatchHistoryRecordFromEntry derives video_id via extractVideoId and delegates the shared builder", () => {
	const record = buildWatchHistoryRecordFromEntry({
		time: "2024-06-05T13:45:22Z",
		title: "Watched a video",
		titleUrl: "https://www.youtube.com/watch?v=abc123XYZ",
		subtitles: [
			{ name: "A Channel", url: "https://www.youtube.com/channel/UC1" },
		],
	});
	assert.ok(record);
	assert.equal(record.video_id, "abc123XYZ");
	assert.equal(record.channel_title, "A Channel");
	assert.equal(record.view_count, null);
	assert.equal(record.description, null);
});

test("buildWatchHistoryRecordFromEntry returns null when the shared builder does (no timestamp)", () => {
	assert.equal(buildWatchHistoryRecordFromEntry({ title: "no time" }), null);
});

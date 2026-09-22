// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildWatchHistoryRecord,
	hashWatchHistoryId,
	type WatchHistoryEntry,
} from "./youtube-watch-history.ts";

test("buildWatchHistoryRecord maps a full entry", () => {
	const entry: WatchHistoryEntry = {
		time: "2024-06-05T13:45:22.123Z",
		title: "Watched How to make sourdough",
		titleUrl: "https://www.youtube.com/watch?v=abc123",
		subtitles: [
			{ name: "Baker Channel", url: "https://www.youtube.com/channel/UCxxx" },
		],
	};
	const rec = buildWatchHistoryRecord(entry);
	assert.ok(rec);
	assert.equal(rec.watched_at, "2024-06-05T13:45:22.123Z");
	assert.equal(rec.video_url, "https://www.youtube.com/watch?v=abc123");
	assert.equal(rec.video_title, "Watched How to make sourdough");
	assert.equal(rec.channel_name, "Baker Channel");
	assert.equal(rec.channel_url, "https://www.youtube.com/channel/UCxxx");
	assert.equal(
		rec.id,
		hashWatchHistoryId(`yt|${entry.time}|${entry.titleUrl}`),
	);
});

test("buildWatchHistoryRecord returns null when the entry has no timestamp", () => {
	const entry: WatchHistoryEntry = { title: "Watched Music video" };
	assert.equal(buildWatchHistoryRecord(entry), null);
});

test("buildWatchHistoryRecord tolerates a missing titleUrl and subtitles (e.g. a removed video)", () => {
	const entry: WatchHistoryEntry = {
		time: "2024-06-05T13:45:22Z",
		title: "Watched a removed video",
	};
	const rec = buildWatchHistoryRecord(entry);
	assert.ok(rec);
	assert.equal(rec.video_url, null);
	assert.equal(rec.channel_name, null);
	assert.equal(rec.channel_url, null);
	// Falls back to hashing on title when there's no URL, so two removed
	// videos with different titles still get distinct ids.
	assert.equal(rec.id, hashWatchHistoryId(`yt|${entry.time}|${entry.title}`));
});

test("hashWatchHistoryId is deterministic and 24 hex chars", () => {
	const a = hashWatchHistoryId("yt|2024|x");
	const b = hashWatchHistoryId("yt|2024|x");
	assert.equal(a, b);
	assert.match(a, /^[0-9a-f]{24}$/);
});

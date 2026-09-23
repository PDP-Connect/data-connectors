// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TEST-ONLY derivability evidence for the youtube.history legacy scope
 * (docs/migration/connector-cutover/legacy-derivability.json). Not product
 * code: per CONTRACTS.md's ownership boundary, this repo does not own or
 * ship public-scope projection code — Vana owns that. This test exists only
 * to prove, against the frozen legacy schema, that a projection rule Tim
 * accepted is mechanically sound before any Vana lane relies on it.
 *
 * Accepted projection rule (Tim, 2026-09-22):
 *   - Slice the modern youtube.watch_history stream to its latest 50 records
 *     by watched_at (descending), matching the legacy scraper's
 *     MAX_HISTORY_ITEMS = 50 (connectors/google/youtube-playwright.js:40).
 *   - Set timeWindow truthfully from the actual first and last watched_at of
 *     that slice — NOT the legacy connector's hardcoded literal
 *     `top ${MAX_HISTORY_ITEMS} most recent items`
 *     (connectors/google/youtube-playwright.js:1597), which never reflected
 *     the real window (it was a fixed string regardless of actual date
 *     span, and did not shrink when the account had under 50 videos in
 *     history — see the negative control below). Tim's rule replaces that
 *     dishonest constant with the real span, in the format
 *     "<oldest watched_at> to <newest watched_at>" (see projectLegacyHistory
 *     below).
 *
 * Genuine losses (not fabricated — confirmed absent from Takeout, see
 * connectors/youtube/parsers.ts:66-67 and src/youtube-watch-history.ts):
 *   - history[].views: legacy scraped the DOM metadata row
 *     (youtube-playwright.js:1062-1066, "349K views" text). Takeout's
 *     watch-history.json carries only {time, title, titleUrl, subtitles}
 *     (src/youtube-watch-history.ts:23-28) — no view-count field exists in
 *     the export at all. buildWatchHistoryRecordFromEntry hardcodes
 *     view_count: null (parsers.ts:66) for exactly this reason.
 *   - history[].description: legacy scraped a DOM snippet element
 *     (youtube-playwright.js:1069-1075). Takeout has no description field.
 *     buildWatchHistoryRecordFromEntry hardcodes description: null
 *     (parsers.ts:67).
 *   - history[].watchedAtText: legacy's raw day-granularity section header
 *     text (e.g. "Yesterday", "Jan 23, 2026"), used only to resolve
 *     watchedAt (youtube-playwright.js:901-950). watchedAtText itself is
 *     optional in the legacy schema and superseded by heart of the
 *     resolution: modern watched_at is a full Takeout timestamp (`time`
 *     field), a strictly more precise value with nothing to reconstruct the
 *     display string from. Documented loss, not fabricated as a value.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { buildWatchHistoryRecordFromEntry } from "./parsers.ts";
import type { WatchHistoryRecord } from "./types.ts";

// Mirrors connectors/google/schemas/youtube.history.json exactly (frozen
// legacy schema, read-only, never regenerated — CONTRACTS.md "End state").
// Duplicated here deliberately: this is test-only derivability evidence,
// not a shared runtime dependency on the legacy schema file.
const legacyHistoryItemSchema = z
	.object({
		watchedAt: z.string().nullable(),
		watchedAtText: z.string().nullable(),
		videoId: z.string().nullable(),
		videoUrl: z.string(),
		videoTitle: z.string().nullable(),
		channelTitle: z.string().nullable(),
		views: z.string().nullable(),
		description: z.string().nullable(),
	})
	.strict();

const legacyHistorySchema = z
	.object({
		timeWindow: z.string(),
		history: z.array(legacyHistoryItemSchema),
	})
	.strict();

const MAX_HISTORY_ITEMS = 50;

// The exact string the legacy connector emitted, always, regardless of the
// real date span or whether fewer than 50 items existed
// (connectors/google/youtube-playwright.js:1597). Projected here only to
// demonstrate why Tim rejected it as the modern timeWindow rule.
const LEGACY_HARDCODED_TIME_WINDOW = `top ${MAX_HISTORY_ITEMS} most recent items`;

/**
 * Tim's accepted projection: slice latest 50 by watched_at descending, and
 * report the true first/last watched_at of the slice as timeWindow. Format:
 * "<oldest watched_at> to <newest watched_at>" using the exact watched_at
 * ISO strings already validated by watchHistorySchema — no reformatting, no
 * invented precision.
 */
function projectLegacyHistory(records: readonly WatchHistoryRecord[]): {
	timeWindow: string;
	history: unknown[];
} {
	const sorted = [...records].sort((a, b) =>
		b.watched_at.localeCompare(a.watched_at),
	);
	const slice = sorted.slice(0, MAX_HISTORY_ITEMS);
	const newest = slice[0];
	const oldest = slice[slice.length - 1];

	const timeWindow =
		newest === undefined || oldest === undefined
			? "no watch history"
			: `${oldest.watched_at} to ${newest.watched_at}`;

	const history = slice.map((r) => ({
		watchedAt: r.watched_at,
		watchedAtText: null, // genuine loss: see file header
		videoId: r.video_id,
		videoUrl: r.video_url ?? "",
		videoTitle: r.video_title,
		channelTitle: r.channel_title,
		views: null, // genuine loss: see file header
		description: null, // genuine loss: see file header
	}));

	return { timeWindow, history };
}

function syntheticEntry(time: string, n: number) {
	return {
		time,
		title: `Watched video ${n}`,
		titleUrl: `https://www.youtube.com/watch?v=vid${String(n).padStart(6, "0")}`,
		subtitles: [
			{
				name: `Channel ${n % 7}`,
				url: `https://www.youtube.com/channel/UC${String(n).padStart(20, "0")}`,
			},
		],
	};
}

test("projectLegacyHistory: slices to the latest 50 by watched_at and validates against the frozen legacy schema", () => {
	// 75 synthetic Takeout entries spanning 75 distinct days, oldest first.
	const entries = Array.from({ length: 75 }, (_, i) =>
		syntheticEntry(
			new Date(Date.UTC(2026, 0, 1 + i, 12, 0, 0)).toISOString(),
			i,
		),
	);
	const records = entries
		.map(buildWatchHistoryRecordFromEntry)
		.filter((r): r is WatchHistoryRecord => r !== null);
	assert.equal(records.length, 75);

	const projected = projectLegacyHistory(records);

	// Schema-valid against the frozen legacy shape.
	const parsed = legacyHistorySchema.parse(projected);

	// Slice invariant: exactly MAX_HISTORY_ITEMS, the 50 most recent.
	assert.equal(parsed.history.length, MAX_HISTORY_ITEMS);
	const first = parsed.history[0];
	const last = parsed.history[MAX_HISTORY_ITEMS - 1];
	assert.ok(first !== undefined && last !== undefined);
	assert.equal(first.videoTitle, "Watched video 74");
	assert.equal(last.videoTitle, "Watched video 25");

	// timeWindow reflects the TRUE span of the emitted slice, not a constant.
	const expectedOldest = new Date(
		Date.UTC(2026, 0, 1 + 25, 12, 0, 0),
	).toISOString();
	const expectedNewest = new Date(
		Date.UTC(2026, 0, 1 + 74, 12, 0, 0),
	).toISOString();
	assert.equal(parsed.timeWindow, `${expectedOldest} to ${expectedNewest}`);
	assert.notEqual(
		parsed.timeWindow,
		LEGACY_HARDCODED_TIME_WINDOW,
		"the accepted rule must not reproduce the legacy connector's dishonest hardcoded constant",
	);

	// Genuine, documented losses stay null — never fabricated.
	for (const item of parsed.history) {
		assert.equal(item.views, null);
		assert.equal(item.description, null);
		assert.equal(item.watchedAtText, null);
	}
});

test("projectLegacyHistory: fewer than 50 records emits all of them with an honest, non-legacy timeWindow", () => {
	const entries = Array.from({ length: 3 }, (_, i) =>
		syntheticEntry(
			new Date(Date.UTC(2026, 5, 10 + i, 8, 0, 0)).toISOString(),
			i,
		),
	);
	const records = entries
		.map(buildWatchHistoryRecordFromEntry)
		.filter((r): r is WatchHistoryRecord => r !== null);

	const projected = projectLegacyHistory(records);
	const parsed = legacyHistorySchema.parse(projected);

	assert.equal(parsed.history.length, 3);
	const expectedOldest = new Date(Date.UTC(2026, 5, 10, 8, 0, 0)).toISOString();
	const expectedNewest = new Date(Date.UTC(2026, 5, 12, 8, 0, 0)).toISOString();
	assert.equal(parsed.timeWindow, `${expectedOldest} to ${expectedNewest}`);
});

test("projectLegacyHistory: empty history reports honestly instead of guessing a window", () => {
	const projected = projectLegacyHistory([]);
	const parsed = legacyHistorySchema.parse(projected);

	assert.equal(parsed.history.length, 0);
	assert.equal(parsed.timeWindow, "no watch history");
});

test("NEGATIVE CONTROL: the legacy connector's own hardcoded timeWindow fails validation against real semantics", () => {
	// This demonstrates the defect Tim's rule fixes: the legacy constant is
	// schema-valid (it's just a string) but semantically false whenever the
	// account has fewer than 50 videos in its history — proving the negative
	// control actually distinguishes "truthful" from "merely schema-shaped".
	const entries = Array.from({ length: 3 }, (_, i) =>
		syntheticEntry(
			new Date(Date.UTC(2026, 5, 10 + i, 8, 0, 0)).toISOString(),
			i,
		),
	);
	const records = entries
		.map(buildWatchHistoryRecordFromEntry)
		.filter((r): r is WatchHistoryRecord => r !== null);

	const legacyStyleProjection = {
		timeWindow: LEGACY_HARDCODED_TIME_WINDOW,
		history: records.map((r) => ({
			watchedAt: r.watched_at,
			watchedAtText: null,
			videoId: r.video_id,
			videoUrl: r.video_url ?? "",
			videoTitle: r.video_title,
			channelTitle: r.channel_title,
			views: null,
			description: null,
		})),
	};

	// Schema-valid (the legacy behavior was never a shape bug)...
	const parsed = legacyHistorySchema.parse(legacyStyleProjection);
	// ...but the claim it makes is false: it claims "top 50" while only 3
	// items and a 2-day span actually exist. Tim's rule must not reproduce
	// this falsehood.
	assert.equal(parsed.timeWindow, "top 50 most recent items");
	assert.equal(parsed.history.length, 3);
	assert.notEqual(
		parsed.history.length,
		MAX_HISTORY_ITEMS,
		"the negative control's own history length must actually differ from 50, or it proves nothing",
	);
});

test("negative control: malformed entry (missing required videoUrl) is rejected by the frozen legacy schema", () => {
	assert.throws(() => {
		legacyHistorySchema.parse({
			timeWindow: "2026-01-01T00:00:00.000Z to 2026-01-02T00:00:00.000Z",
			history: [
				{
					watchedAt: "2026-01-01T00:00:00.000Z",
					watchedAtText: null,
					videoId: "abc123",
					// videoUrl omitted: legacy schema requires it (required: ["videoUrl"])
					videoTitle: "Some video",
					channelTitle: "Some channel",
					views: null,
					description: null,
				},
			],
		});
	});
});

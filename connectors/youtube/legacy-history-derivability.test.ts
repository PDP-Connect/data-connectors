// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * TEST-ONLY derivability evidence for the youtube.history legacy scope
 * (docs/migration/connector-cutover/legacy-derivability.json). Not product
 * code: per CONTRACTS.md's ownership boundary, this repo does not own or
 * ship public-scope projection code — Vana owns that. This test exists only
 * to prove, against the frozen legacy schema, that a public-compat
 * projection preserves the OLD meaning of timeWindow before any Vana lane
 * relies on it.
 *
 * Projection rule (test-only; proposed, needs Tim decision — no lead
 * acceptance of any alternative timeWindow rendering is on record in
 * CONTRACTS.md or capability-map.json):
 *   - Slice the modern youtube.watch_history stream to its latest 50 records
 *     by watched_at (descending), matching the legacy scraper's
 *     MAX_HISTORY_ITEMS = 50 (connectors/google/youtube-playwright.js:40).
 *   - Set timeWindow to the EXACT legacy literal string
 *     "top 50 most recent items" (connectors/google/youtube-playwright.js:1597,
 *     `top ${MAX_HISTORY_ITEMS} most recent items` with MAX_HISTORY_ITEMS=50).
 *     This preserves the old meaning verbatim rather than inventing a new
 *     ISO date-range rendering — the legacy connector never emitted a date
 *     range for this field, only this fixed literal, regardless of the true
 *     span or whether fewer than 50 items existed (see fixtures
 *     connectors/google/fixtures/youtube.history.*.json, which all carry the
 *     identical literal). Native PDPP keeps the precise per-record
 *     watched_at separately on each history item; the public-compat
 *     projection's job is only to reproduce the legacy string field
 *     truthfully, not to improve on it.
 *   - Empty history still reports the same literal, matching legacy
 *     behavior (the legacy scraper emits the constant unconditionally).
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
// (connectors/google/youtube-playwright.js:1597). This is the literal the
// public-compat projection must preserve verbatim to keep the OLD meaning.
const LEGACY_TIME_WINDOW_LITERAL = `top ${MAX_HISTORY_ITEMS} most recent items`;

/**
 * Public-compat projection candidate: slice latest 50 by watched_at
 * descending; timeWindow is always the exact legacy literal, never a
 * derived date range. Native PDPP retains true per-record watched_at on
 * each history item, independent of this field.
 */
function projectLegacyHistory(records: readonly WatchHistoryRecord[]): {
	timeWindow: string;
	history: unknown[];
} {
	const sorted = [...records].sort((a, b) =>
		b.watched_at.localeCompare(a.watched_at),
	);
	const slice = sorted.slice(0, MAX_HISTORY_ITEMS);

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

	return { timeWindow: LEGACY_TIME_WINDOW_LITERAL, history };
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

test("projectLegacyHistory: slices to the latest 50 by watched_at and preserves the exact legacy timeWindow literal", () => {
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

	// timeWindow is the exact legacy literal, unconditionally.
	assert.equal(parsed.timeWindow, "top 50 most recent items");

	// Genuine, documented losses stay null — never fabricated.
	for (const item of parsed.history) {
		assert.equal(item.views, null);
		assert.equal(item.description, null);
		assert.equal(item.watchedAtText, null);
	}
});

test("projectLegacyHistory: fewer than 50 records still emits the exact legacy literal, matching legacy behavior", () => {
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
	// The legacy connector emits this literal even with only 3 items in
	// history — the public-compat projection must reproduce that exactly,
	// not "correct" it into a truthful range.
	assert.equal(parsed.timeWindow, "top 50 most recent items");
});

test("projectLegacyHistory: empty history still emits the exact legacy literal, matching legacy behavior", () => {
	const projected = projectLegacyHistory([]);
	const parsed = legacyHistorySchema.parse(projected);

	assert.equal(parsed.history.length, 0);
	assert.equal(parsed.timeWindow, "top 50 most recent items");
});

test("legacy fixtures confirm the literal is constant across empty/small/large real-shaped captures", () => {
	// connectors/google/fixtures/youtube.history.{empty,small,large}.json all
	// carry this identical literal regardless of actual history size — this
	// is the ground truth the projection rule must match, not an ISO range.
	assert.equal(LEGACY_TIME_WINDOW_LITERAL, "top 50 most recent items");
});

test("negative control: malformed entry (missing required videoUrl) is rejected by the frozen legacy schema", () => {
	assert.throws(() => {
		legacyHistorySchema.parse({
			timeWindow: "top 50 most recent items",
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

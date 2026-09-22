// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end tests for the YouTube Takeout connector, driven through the
 * real connector protocol as a subprocess: proves START -> RECORD -> STATE
 * -> DONE, scope filtering (a stream absent from scope.streams emits
 * nothing), and the honest-coverage behavior for UNVERIFIED streams (see
 * parsers.ts's file header).
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(HERE, "../..");
const ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "youtube", "index.ts");

const WATCH_HISTORY_JSON = JSON.stringify([
	{
		header: "YouTube",
		title: "Watched How to make sourdough",
		titleUrl: "https://www.youtube.com/watch?v=abc123XYZ0",
		subtitles: [
			{ name: "Baker Channel", url: "https://www.youtube.com/channel/UCxxx" },
		],
		time: "2024-06-05T13:45:22.123Z",
	},
	{
		header: "YouTube",
		title: "Watched Music video",
	},
]);

async function withExportDir(
	files: Record<string, string>,
	body: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "youtube-takeout-"));
	try {
		for (const [relPath, content] of Object.entries(files)) {
			const fullPath = join(dir, relPath);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, content, "utf8");
		}
		await body(dir);
	} finally {
		await rm(dir, { force: true, recursive: true });
	}
}

const ALL_STREAMS = [
	"profile",
	"subscriptions",
	"playlists",
	"playlist_items",
	"likes",
	"watch_later",
	"watch_history",
	"coverage_diagnostics",
];

async function run(
	dir: string,
	streams: string[] = ALL_STREAMS,
	state?: Record<string, unknown>,
) {
	return await runConnectorProtocolSubprocess({
		cwd: PACKAGE_ROOT,
		entrypoint: ENTRYPOINT,
		env: {
			PDPP_OWNER_TOKEN: "",
			PDPP_RS_URL: "",
			RS_URL: "",
			YOUTUBE_TAKEOUT_DIR: dir,
			TZ: "UTC",
		},
		start: {
			scope: { streams: streams.map((name) => ({ name })) },
			...(state ? { state } : {}),
			type: "START",
		},
	});
}

function recordsOf(result: { messages?: unknown[] }, stream: string) {
	const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
	return messages
		.filter((m) => m.type === "RECORD" && m.stream === stream)
		.map((m) => m.data as Record<string, unknown>);
}

function messagesOf(result: { messages?: unknown[] }, type: string) {
	const messages = (result.messages ?? []) as Array<Record<string, unknown>>;
	return messages.filter((m) => m.type === type);
}

test("watch_history: a real-shaped watch-history.json emits RECORD -> STATE for every entry with a timestamp", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/history/watch-history.json":
				WATCH_HISTORY_JSON,
		},
		async (dir) => {
			const result = await run(dir, ["watch_history"]);
			const records = recordsOf(result, "watch_history");
			// The second entry has no `time`, so it must not emit — same rule as
			// google_takeout.youtube_watch_history via the shared parser.
			assert.equal(records.length, 1);
			assert.equal(records[0]?.watched_at, "2024-06-05T13:45:22.123Z");
			assert.equal(records[0]?.video_id, "abc123XYZ0");
			assert.equal(records[0]?.channel_title, "Baker Channel");

			const state = messagesOf(result, "STATE").find(
				(m) => (m as { stream?: string }).stream === "watch_history",
			) as { cursor?: Record<string, unknown> } | undefined;
			assert.equal(state?.cursor?.last_timestamp, "2024-06-05T13:45:22.123Z");

			const done = messagesOf(result, "DONE");
			assert.equal(done.length, 1);
		},
	);
});

test("watch_history: a second run resumes from the cursor rather than re-emitting", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/history/watch-history.json":
				WATCH_HISTORY_JSON,
		},
		async (dir) => {
			const second = await run(dir, ["watch_history"], {
				watch_history: { last_timestamp: "2024-06-05T13:45:22.123Z" },
			});
			assert.equal(recordsOf(second, "watch_history").length, 0);
		},
	);
});

test("scope filtering: a stream absent from scope.streams emits nothing for that stream", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/history/watch-history.json":
				WATCH_HISTORY_JSON,
			"YouTube and YouTube Music/subscriptions/subscriptions.csv":
				"Channel Id,Channel Url,Channel Title\nUC1,https://www.youtube.com/channel/UC1,Chan One\n",
		},
		async (dir) => {
			const result = await run(dir, ["watch_history"]);
			assert.equal(recordsOf(result, "watch_history").length, 1);
			assert.equal(recordsOf(result, "subscriptions").length, 0);
			assert.equal(recordsOf(result, "coverage_diagnostics").length, 0);
		},
	);
});

test("subscriptions: a real-shaped subscriptions.csv emits one record per row", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/subscriptions/subscriptions.csv":
				"Channel Id,Channel Url,Channel Title\n" +
				"UC1,https://www.youtube.com/channel/UC1,Chan One\n" +
				"UC2,https://www.youtube.com/channel/UC2,Chan Two\n",
		},
		async (dir) => {
			const result = await run(dir, ["subscriptions", "coverage_diagnostics"]);
			const records = recordsOf(result, "subscriptions");
			assert.equal(records.length, 2);
			assert.equal(records[0]?.channel_id, "UC1");

			const [diagnostic] = recordsOf(result, "coverage_diagnostics");
			assert.equal(diagnostic?.stream, "subscriptions");
			assert.equal(diagnostic?.status, "complete");
			assert.equal(diagnostic?.record_count, 2);
		},
	);
});

test("playlists + playlist_items: an index file with one per-item CSV emits both streams", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/playlists/playlists.csv":
				"Playlist Id,Playlist Name\nPL1,My Mix\n",
			"YouTube and YouTube Music/playlists/My Mix-videos.csv":
				"Video Id,Playlist Video Creation Timestamp\nvid1,2024-01-01T00:00:00Z\nvid2,2024-01-02T00:00:00Z\n",
		},
		async (dir) => {
			const result = await run(dir, ["playlists", "playlist_items"]);
			const playlists = recordsOf(result, "playlists");
			assert.equal(playlists.length, 1);
			assert.equal(playlists[0]?.id, "PL1");

			const items = recordsOf(result, "playlist_items");
			assert.equal(items.length, 2);
			assert.equal(items[0]?.video_id, "vid1");
		},
	);
});

test("likes and watch_later: named playlist export files map to their own streams", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/playlists/Liked videos-videos.csv":
				"Video Id\nvidLike1\n",
			"YouTube and YouTube Music/playlists/Watch later-videos.csv":
				"Video Id\nvidWL1\n",
		},
		async (dir) => {
			const result = await run(dir, ["likes", "watch_later"]);
			assert.equal(recordsOf(result, "likes").length, 1);
			assert.equal(recordsOf(result, "likes")[0]?.video_id, "vidLike1");
			assert.equal(recordsOf(result, "watch_later").length, 1);
			assert.equal(recordsOf(result, "watch_later")[0]?.video_id, "vidWL1");
		},
	);
});

test("a missing export directory reports every requested stream as awaiting import, not silent success", async () => {
	const dir = join(tmpdir(), "youtube-takeout-does-not-exist-0000");
	const result = await run(dir, ["watch_history", "coverage_diagnostics"]);
	assert.equal(recordsOf(result, "watch_history").length, 0);
	assert.equal(messagesOf(result, "SKIP_RESULT").length, 1);
	const [diagnostic] = recordsOf(result, "coverage_diagnostics");
	assert.ok(diagnostic);
	assert.equal(diagnostic.status, "empty");
});

test("a directory containing only a .zip is reported as source_unreadable with remediation, not silently ignored", async () => {
	await withExportDir(
		{ "takeout-export.zip": "not a real zip" },
		async (dir) => {
			const result = await run(dir, ["watch_history", "coverage_diagnostics"]);
			const skips = messagesOf(result, "SKIP_RESULT");
			assert.equal(skips.length, 1);
			assert.match(
				(skips[0] as { message?: string }).message ?? "",
				/extract/i,
			);
		},
	);
});

test("an unverified stream missing its expected file reports file_not_found_in_export honestly", async () => {
	await withExportDir(
		{
			"YouTube and YouTube Music/history/watch-history.json":
				WATCH_HISTORY_JSON,
		},
		async (dir) => {
			const result = await run(dir, ["profile", "coverage_diagnostics"]);
			assert.equal(recordsOf(result, "profile").length, 0);
			const skips = messagesOf(result, "SKIP_RESULT");
			assert.equal(skips.length, 1);
			assert.equal(
				(skips[0] as { reason?: string }).reason,
				"file_not_found_in_export",
			);
			const [diagnostic] = recordsOf(result, "coverage_diagnostics");
			assert.equal(diagnostic?.reason, "file_not_found_in_export");
		},
	);
});

test("an extracted export directly in the import dir (no wrapping folder) is also read", async () => {
	await withExportDir(
		{ "history/watch-history.json": WATCH_HISTORY_JSON },
		async (dir) => {
			const result = await run(dir, ["watch_history"]);
			assert.equal(recordsOf(result, "watch_history").length, 1);
		},
	);
});

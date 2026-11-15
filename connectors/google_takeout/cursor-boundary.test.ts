// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	connectorEntrypoint,
	packageRoot,
} from "../../packages/polyfill-connectors/src/connector-paths.ts";
import { runConnectorProtocolSubprocess } from "../../packages/polyfill-connectors/src/test-harness.ts";

const TIME = "2024-06-05T13:45:22.000Z";
const STREAMS = [
	"location_history",
	"youtube_watch_history",
	"search_history",
	"photos",
] as const;

async function exportFixture(root: string, stream: string, expanded: boolean) {
	if (stream === "photos") {
		const dir = join(root, "Photos");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "first.jpg"), Buffer.from([255, 216, 255, 1]));
		await writeFile(
			join(dir, "first.jpg.json"),
			JSON.stringify({ photoTakenTime: { timestamp: TIME } }),
		);
		if (expanded) {
			await writeFile(join(dir, "second.jpg"), Buffer.from([255, 216, 255, 2]));
			await writeFile(
				join(dir, "second.jpg.json"),
				JSON.stringify({ photoTakenTime: { timestamp: TIME } }),
			);
		}
		return;
	}
	const location = stream === "location_history";
	const watch = stream === "youtube_watch_history";
	const parts = location
		? ["Location History", "Records.json"]
		: watch
			? ["YouTube and YouTube Music", "history", "watch-history.json"]
			: ["My Activity", "Search", "MyActivity.json"];
	const file = parts.pop();
	assert.ok(file);
	const dir = join(root, ...parts);
	await mkdir(dir, { recursive: true });
	const entries = (expanded ? [1, 2] : [1]).map((n) =>
		location
			? { timestamp: TIME, latitudeE7: n, longitudeE7: 0 }
			: watch
				? {
						time: TIME,
						title: `Watched video ${n}`,
						titleUrl: `https://www.youtube.com/watch?v=fixture${n}`,
					}
				: { time: TIME, title: `Searched for query ${n}`, header: "Search" },
	);
	await writeFile(
		join(dir, file),
		JSON.stringify(location ? { locations: entries } : entries),
	);
}

STREAMS.forEach((stream) => {
	test(`${stream} replays equal cursor boundary when a later export adds a record`, async () => {
		const root = await mkdtemp(join(tmpdir(), "takeout-boundary-"));
		const collect = (state: Record<string, unknown> = {}) =>
			runConnectorProtocolSubprocess({
				cwd: packageRoot,
				entrypoint: connectorEntrypoint("google_takeout"),
				env: {
					GOOGLE_TAKEOUT_DIR: root,
					PDPP_OWNER_TOKEN: "",
					PDPP_RS_URL: "",
					RS_URL: "",
				},
				start: { type: "START", scope: { streams: [{ name: stream }] }, state },
			});
		try {
			await exportFixture(root, stream, false);
			const first = await collect();
			const cursor = first.messages.find(
				(message) => message.type === "STATE" && message.stream === stream,
			);
			assert.ok(cursor?.type === "STATE");
			assert.deepEqual(cursor.cursor, { last_timestamp: TIME });
			const firstRecords = first.messages.filter(
				(message) => message.type === "RECORD",
			);
			assert.equal(firstRecords.length, 1);
			await exportFixture(root, stream, true);
			const second = await collect({ [stream]: cursor.cursor });
			const secondRecords = second.messages.filter(
				(message) => message.type === "RECORD",
			);
			assert.equal(
				secondRecords.length,
				2,
				"old <= filter drops both equal-boundary records",
			);
			assert.equal(
				new Set(secondRecords.map((message) => message.data.id)).size,
				2,
			);
			assert.ok(
				secondRecords.some(
					(message) => message.data.id === firstRecords[0]?.data.id,
				),
			);
			const next = second.messages.find(
				(message) => message.type === "STATE" && message.stream === stream,
			);
			assert.ok(next?.type === "STATE");
			assert.deepEqual(
				next.cursor,
				cursor.cursor,
				"max cursor remains unchanged",
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

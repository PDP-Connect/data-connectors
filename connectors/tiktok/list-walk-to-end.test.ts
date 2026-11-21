// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
	EmittedMessage,
	RecordData,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	collectTikTok,
	type TikTokCollectContext,
	type TikTokCollectOptions,
	type TikTokPage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Reuse the synthetic fixtures and session.get fake-page seam used by pdpp-semantics.test.ts.
type Json = Record<string, unknown>;
const fixture = (name: string): Json =>
	JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
	) as Json;
const account = fixture("passport-account-info-v2.json");
const posts = fixture("post-item-list.json");
const users = fixture("user-list.json");
const collections = fixture("collection-list.json");
const settings = fixture("user-settings.json");
const item = (posts.itemList as Json[])[0]!;
const user = (users.userList as Json[])[0]!;
const collection = (collections.collectionList as Json[])[0]!;
type Stream = "videos" | "following" | "favorite_collections" | "profile";
type Fault = "cursor" | "ids" | "unreadable" | "terminal-ids" | "shift";
const paths: Record<Stream, string> = {
	videos: "/api/post/item_list/",
	profile: "/api/post/item_list/",
	following: "/api/user/list/",
	favorite_collections: "/api/user/collection_list/",
};

async function run(
	stream: Stream,
	pages: number,
	fault?: Fault,
	options: TikTokCollectOptions = {},
	checkpoint: {
		state?: TikTokCollectContext["state"];
		movedPage?: number;
	} = {},
) {
	let reads = 0;
	let passes = 0;
	const cursors: number[] = [];
	const messages: EmittedMessage[] = [];
	const records: RecordData[] = [];
	const failures: string[] = [];
	const recoveryHints: unknown[] = [];
	const page: TikTokPage = {
		evaluate: async (script: string) => {
			const match = /session\.get\(("[^"]+"), (\{.*?\}), \d+\)/s.exec(script);
			if (!match?.[1] || !match[2])
				return { client: true, transport: null, copied: {} };
			const path = JSON.parse(match[1]) as string;
			const params = JSON.parse(match[2]) as Record<string, string>;
			let json: unknown;
			if (path === "/passport/account/info/v2/") json = account;
			else if (path === "/api/user/settings/") json = settings;
			else {
				assert.equal(path, paths[stream]);
				reads += 1;
				assert.ok(
					reads <= (fault ? 6 : pages * 3),
					"synthetic safety stop: source did not terminate",
				);
				const index = Number(params.cursor ?? params.minCursor ?? "0");
				cursors.push(index);
				// "shift": every full read of the list holds different ids, as when
				// the list changes between two reads under offset paging.
				if (index === 0) passes += 1;
				const sourceIndex =
					fault === "ids" || fault === "terminal-ids"
						? 0
						: fault === "shift"
							? index + passes * 100
							: index;
				const ids = Array.from({ length: 30 }, (_, i) =>
					String(
						900000 +
							sourceIndex * 30 +
							i +
							(checkpoint.movedPage === index ? 500000 : 0),
					),
				);
				const hasMore =
					(fault !== undefined &&
						fault !== "terminal-ids" &&
						fault !== "shift") ||
					index + 1 < pages;
				const cursor = fault === "cursor" ? 0 : index + 1;
				if (stream === "following") {
					json = {
						...users,
						total: pages * 30,
						hasMore,
						minCursor: cursor,
						userList: ids.map((id) =>
							fault === "unreadable"
								? {}
								: { ...user, user: { ...(user.user as Json), id } },
						),
					};
				} else if (stream === "favorite_collections") {
					json = {
						...collections,
						total: fault === "terminal-ids" ? undefined : pages * 30,
						hasMore,
						cursor: String(cursor),
						collectionList: ids.map((collectionId) => ({
							...collection,
							collectionId,
						})),
					};
				} else {
					json = {
						...posts,
						total: fault === "terminal-ids" ? undefined : pages * 30,
						hasMore,
						cursor: String(cursor),
						itemList: ids.map((id) =>
							fault === "unreadable"
								? {}
								: {
										...item,
										id,
										...(stream === "profile"
											? { authorStats: undefined, authorStatsV2: undefined }
											: {}),
									},
						),
					};
				}
			}
			return {
				kind: "response",
				status: 200,
				html: false,
				empty: false,
				json,
				signed: true,
				transport: "fetch",
				retryAfterSeconds: null,
			};
		},
		goto: async () => null,
	};
	const ctx: TikTokCollectContext = {
		page,
		requested: new Map([[stream, { name: stream }]]),
		state: checkpoint.state ?? {},
		collectionMode: "incremental",
		emit: async (message) => {
			// Progress copy is not part of the terminal contract these tests pin.
			if (message.type !== "PROGRESS") messages.push(message);
		},
		emitRecord: async (_stream, data) => {
			assert.equal(validateRecord(_stream, data).ok, true);
			records.push(data);
		},
		reportStreamFailure: async (_stream, message, options) => {
			failures.push(message);
			recoveryHints.push(options?.recoveryHint);
		},
	};
	await collectTikTok(ctx, {
		delay: async () => {},
		random: () => 0,
		...options,
	});
	return { reads, cursors, messages, records, failures, recoveryHints };
}

for (const stream of ["videos", "following", "favorite_collections"] as const) {
	test(`${stream}: 201 pages use the same normal terminal STATE as a short source`, async () => {
		const short = await run(stream, 1);
		const long = await run(stream, 201);
		assert.deepEqual(short.failures, []);
		assert.deepEqual(long.failures, []);
		assert.equal(short.records.length, 30);
		assert.equal(long.records.length, 201 * 30);
		assert.deepEqual(short.messages, [
			{ type: "STATE", stream, cursor: { count: 30 } },
		]);
		assert.deepEqual(long.messages, [
			{ type: "STATE", stream, cursor: { count: 201 * 30 } },
		]);
		assert.equal(long.reads, stream === "favorite_collections" ? 402 : 201);
	});
	for (const fault of ["cursor", "ids"] as const) {
		test(`${stream}: repeating ${fault} refuses within two pages without STATE`, async () => {
			const result = await run(stream, 10, fault);
			assert.equal(result.failures.length, 1);
			assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
			assert.match(result.failures[0]!, /no new|nothing new/);
			assert.ok(result.reads <= 2);
			assert.equal(
				result.messages.some((message) => message.type === "STATE"),
				false,
			);
		});
	}
}

test("videos: a duplicate-only terminal page without a total refuses without STATE", async () => {
	const result = await run("videos", 2, "terminal-ids");
	assert.equal(result.reads, 2);
	assert.equal(result.records.length, 30);
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("favorite_collections: a duplicate-only last page without a total is retryable without STATE", async () => {
	const result = await run("favorite_collections", 2, "terminal-ids");
	assert.equal(result.reads, 2);
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
	assert.match(result.failures[0]!, /added nothing new/);
	assert.deepEqual(result.recoveryHints, [
		{ action: "retry_by_runtime", retryable: true },
	]);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("videos: the old 900-request boundary does not strand the remaining history", async () => {
	// Isolate the request cap from the old 200-page cap for the red control.
	const result = await run("videos", 901, undefined, { maxPages: 1000 });
	assert.deepEqual(result.failures, []);
	assert.equal(result.reads, 901);
	assert.equal(result.records.length, 901 * 30);
	assert.deepEqual(result.messages, [
		{ type: "STATE", stream: "videos", cursor: { count: 901 * 30 } },
	]);
});

test("profile count search: changing cursors with the same IDs refuses promptly", async () => {
	const result = await run("profile", 10, "ids");
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
	assert.match(result.failures[0]!, /no new video/);
	assert.ok(result.reads <= 2);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
});

for (const stream of ["videos", "following"] as const) {
	test(`${stream}: unreadable-only pages with new cursors cannot walk forever`, async () => {
		const result = await run(stream, 10, "unreadable");
		assert.equal(result.failures.length, 1);
		assert.match(result.failures[0]!, /^tiktok_source_unreadable/);
		assert.ok(result.reads <= 2);
		assert.equal(
			result.messages.some((message) => message.type === "STATE"),
			false,
		);
	});
}

test("videos: resumes a capped full walk from a validated anchor, keeping prior count", async () => {
	const interrupted = await run(
		"videos",
		4,
		undefined,
		{ maxPages: 2 },
		{ state: { videos: { count: 17 } } },
	);
	assert.deepEqual(interrupted.cursors, [0, 1]);
	assert.equal(interrupted.failures.length, 1);
	const saved = interrupted.messages.find(
		(message) => message.type === "STATE",
	);
	assert.ok(saved?.type === "STATE");
	assert.equal((saved.cursor as Record<string, unknown>).count, 17);
	assert.equal(
		interrupted.messages.some((message) => message.type === "DETAIL_COVERAGE"),
		false,
	);
	const resumed = await run(
		"videos",
		4,
		undefined,
		{},
		{ state: { videos: saved.cursor } },
	);
	assert.deepEqual(resumed.cursors, [1, 2, 3]);
	assert.equal(
		resumed.records.length,
		60,
		"revalidation does not emit the anchor again",
	);
	assert.deepEqual(resumed.failures, []);
	assert.deepEqual(
		resumed.messages.filter((message) => message.type === "STATE"),
		[{ type: "STATE", stream: "videos", cursor: { count: 17 } }],
	);
	const moved = await run(
		"videos",
		4,
		undefined,
		{},
		{ state: { videos: saved.cursor }, movedPage: 1 },
	);
	assert.deepEqual(moved.cursors, [1, 0, 1, 2, 3]);
	assert.equal(moved.records.length, 120);
	assert.deepEqual(moved.failures, []);
	assert.deepEqual(
		moved.messages.filter((message) => message.type === "STATE").at(-1),
		{ type: "STATE", stream: "videos", cursor: { count: 120 } },
	);
});

test("favorite_collections: a duplicate-only page with a new cursor is retryable without STATE", async () => {
	const result = await run("favorite_collections", 3, "ids");
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
	assert.match(
		result.failures[0]!,
		/continued with a page that added nothing new/,
	);
	assert.deepEqual(result.recoveryHints, [
		{ action: "retry_by_runtime", retryable: true },
	]);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("favorite_collections: ids that differ on every read are retryable without STATE", async () => {
	const result = await run("favorite_collections", 2, "shift");
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
	assert.match(result.failures[0]!, /changed on every read/);
	assert.deepEqual(result.recoveryHints, [
		{ action: "retry_by_runtime", retryable: true },
	]);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("favorite_collections: a repeated cursor stays nonretryable", async () => {
	const result = await run("favorite_collections", 3, "cursor");
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /said it had more but gave no new page/);
	assert.deepEqual(result.recoveryHints, [
		{ action: "unknown", retryable: false },
	]);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
});

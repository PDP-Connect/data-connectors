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
type Fault = "cursor" | "ids" | "unreadable" | "terminal-ids";
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
) {
	let reads = 0;
	const messages: EmittedMessage[] = [];
	const records: RecordData[] = [];
	const failures: string[] = [];
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
				const sourceIndex =
					fault === "ids" || fault === "terminal-ids" ? 0 : index;
				const ids = Array.from({ length: 30 }, (_, i) =>
					String(900000 + sourceIndex * 30 + i),
				);
				const hasMore =
					(fault !== undefined && fault !== "terminal-ids") ||
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
		state: {},
		collectionMode: "incremental",
		emit: async (message) => {
			// Progress copy is not part of the terminal contract these tests pin.
			if (message.type !== "PROGRESS") messages.push(message);
		},
		emitRecord: async (_stream, data) => {
			assert.equal(validateRecord(_stream, data).ok, true);
			records.push(data);
		},
		reportStreamFailure: async (_stream, message) => {
			failures.push(message);
		},
	};
	await collectTikTok(ctx, {
		delay: async () => {},
		random: () => 0,
		...options,
	});
	return { reads, messages, records, failures };
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

test("favorite_collections: a duplicate-only last page without a total refuses without STATE", async () => {
	const result = await run("favorite_collections", 2, "terminal-ids");
	assert.equal(result.reads, 2);
	assert.equal(result.failures.length, 1);
	assert.match(result.failures[0]!, /^tiktok_list_incomplete:/);
	assert.match(result.failures[0]!, /added nothing new/);
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

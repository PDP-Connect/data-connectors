// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { createSpotifyCycleDetector, spotifyCollect } from "./index.ts";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
});

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { status: 200 });
}

function makeContext(
	state: Record<string, unknown> = {},
	requestedNames: string[] = ["saved_tracks"],
	emitRecord: (
		stream: string,
		data: Record<string, unknown>,
	) => Promise<void> = () => Promise.resolve(),
	progress: () => Promise<void> = () => Promise.resolve(),
): {
	messages: EmittedMessage[];
	ctx: Parameters<typeof spotifyCollect>[0];
} {
	const messages: EmittedMessage[] = [];
	const requested = new Map<string, StreamScope>(
		requestedNames.map((name) => [name, { name }]),
	);
	return {
		messages,
		ctx: {
			credentials: { SPOTIFY_ACCESS_TOKEN: "test-token" },
			emit: (message) => {
				messages.push(message);
				return Promise.resolve();
			},
			emitRecord,
			progress,
			requested,
			state,
		},
	};
}

function savedTrack(id: string, addedAt = "2026-01-01T00:00:00Z") {
	return {
		added_at: addedAt,
		track: {
			id,
			name: `Track ${id}`,
			artists: [{ name: "Artist" }],
			album: { name: "Album" },
			duration_ms: 1,
			popularity: 1,
			external_ids: { isrc: null },
		},
	};
}

test("spotify: a 200 page without items fails before saved-track coverage or cursor advancement", async () => {
	globalThis.fetch = async () => jsonResponse({ next: null });
	const { ctx, messages } = makeContext({
		saved_tracks: { last_added_at: "2026-01-01T00:00:00Z" },
	});

	await assert.rejects(() => spotifyCollect(ctx), /spotify_response_malformed/);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "STATE" && message.stream === "saved_tracks",
		),
		false,
		"an absent items array must not advance the saved-track cursor",
	);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks",
		),
		false,
		"an absent items array must not prove an empty saved-track boundary",
	);
});

test("spotify: an explicit empty items array remains a valid zero boundary", async () => {
	globalThis.fetch = async () => jsonResponse({ items: [], next: null });
	const { ctx, messages } = makeContext();

	await spotifyCollect(ctx);
	assert.equal(
		messages.filter(
			(message) =>
				message.type === "STATE" && message.stream === "saved_tracks",
		).length,
		1,
	);
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks",
	);
	assert.ok(coverage);
	assert.equal(coverage.considered, 0);
	assert.equal(coverage.covered, 0);
});

test("spotify: emits the first page before fetching the next page", {
	concurrency: false,
}, async () => {
	const events: string[] = [];
	let fetchCount = 0;
	globalThis.fetch = (input) => {
		fetchCount += 1;
		const path = String(input);
		if (fetchCount === 1) {
			return Promise.resolve(
				jsonResponse({
					items: [savedTrack("first")],
					next: "https://api.spotify.com/v1/me/tracks?offset=50",
				}),
			);
		}
		events.push(`fetch:${path}`);
		return Promise.resolve(
			jsonResponse({ items: [savedTrack("second")], next: null }),
		);
	};
	const { ctx, messages } = makeContext(
		{},
		["saved_tracks"],
		(_stream, data) => {
			events.push(`emit:${String(data.id)}`);
			return Promise.resolve();
		},
	);

	await spotifyCollect(ctx);

	assert.deepEqual(events.slice(0, 2), [
		"emit:first",
		"fetch:https://api.spotify.com/v1/me/tracks?offset=50",
	]);
	assert.equal(events.length, 3);
	const coverage = messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(coverage?.considered, 2);
	assert.equal(coverage?.covered, 2);
});

test("spotify: completes beyond the former 200-page cap with exact totals", {
	concurrency: false,
}, async () => {
	let fetchCount = 0;
	const detector = createSpotifyCycleDetector("/me/tracks?limit=50");
	globalThis.fetch = () => {
		fetchCount += 1;
		const next =
			fetchCount < 201
				? `https://api.spotify.com/v1/me/tracks?offset=${fetchCount * 50}`
				: null;
		if (next !== null) {
			assert.equal(
				detector.observe(new URL(next).pathname + new URL(next).search),
				false,
			);
		}
		return Promise.resolve(
			jsonResponse({ items: [savedTrack(String(fetchCount))], next }),
		);
	};
	const { ctx, messages } = makeContext();

	await spotifyCollect(ctx);

	assert.equal(fetchCount, 201);
	const coverage = messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(coverage?.considered, 201);
	assert.equal(coverage?.covered, 201);
	assert.deepEqual(Object.keys(detector.state()).sort(), [
		"lambda",
		"power",
		"tortoise",
	]);
});

test("spotify: playlists enriches each playlist with its own followers.total via a per-playlist detail fetch", {
	concurrency: false,
}, async () => {
	const requestedPaths: string[] = [];
	globalThis.fetch = (input) => {
		const path = String(input);
		requestedPaths.push(path);
		if (path.includes("/me/playlists")) {
			return Promise.resolve(
				jsonResponse({
					items: [
						{
							id: "pl1",
							name: "Playlist One",
							uri: "spotify:playlist:pl1",
							images: [
								{ url: "https://i.scdn.co/image/p1", width: 300, height: 300 },
							],
						},
					],
					next: null,
				}),
			);
		}
		if (path.includes("/playlists/pl1")) {
			return Promise.resolve(jsonResponse({ followers: { total: 42 } }));
		}
		throw new Error(`unexpected fetch: ${path}`);
	};
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const { ctx, messages } = makeContext({}, ["playlists"], (stream, data) => {
		emittedRecords.push({ stream, data });
		return Promise.resolve();
	});

	await spotifyCollect(ctx);

	assert.ok(
		requestedPaths.some((p) =>
			p.includes("/playlists/pl1?fields=followers.total"),
		),
		"must fetch the full playlist object for its followers.total",
	);
	assert.equal(emittedRecords.length, 1);
	assert.deepEqual(emittedRecords[0]?.data, {
		id: "pl1",
		name: "Playlist One",
		owner_id: null,
		owner_name: null,
		public: null,
		collaborative: null,
		track_count: null,
		snapshot_id: null,
		description: null,
		uri: "spotify:playlist:pl1",
		followers: 42,
		images: [{ url: "https://i.scdn.co/image/p1", width: 300, height: 300 }],
	});
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "playlists",
	);
	assert.deepEqual(coverage?.required_keys, ["pl1"]);
	assert.deepEqual(coverage?.hydrated_keys, ["pl1"]);
});

test("spotify: playlists still emits the record with followers null, and discloses partial hydration, when the per-playlist detail fetch fails", {
	concurrency: false,
}, async () => {
	globalThis.fetch = (input) => {
		const path = String(input);
		if (path.includes("/me/playlists")) {
			return Promise.resolve(
				jsonResponse({
					items: [{ id: "pl1", name: "Playlist One" }],
					next: null,
				}),
			);
		}
		if (path.includes("/playlists/pl1")) {
			return Promise.resolve(new Response("", { status: 500 }));
		}
		throw new Error(`unexpected fetch: ${path}`);
	};
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const { ctx, messages } = makeContext({}, ["playlists"], (stream, data) => {
		emittedRecords.push({ stream, data });
		return Promise.resolve();
	});

	await spotifyCollect(ctx);

	assert.equal(
		emittedRecords.length,
		1,
		"the playlist record is emitted despite the detail-fetch failure",
	);
	assert.equal(emittedRecords[0]?.data.followers, null);
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "playlists",
	);
	assert.deepEqual(coverage?.required_keys, ["pl1"]);
	assert.deepEqual(
		coverage?.hydrated_keys,
		[],
		"a failed followers fetch must not be reported as hydrated",
	);
});

test("spotify: playlist_items paginates each playlist's own tracks endpoint and keys by position", {
	concurrency: false,
}, async () => {
	const requestedPaths: string[] = [];
	globalThis.fetch = (input) => {
		const path = String(input);
		requestedPaths.push(path);
		if (path.includes("/me/playlists")) {
			return Promise.resolve(
				jsonResponse({
					items: [{ id: "pl1" }, { id: "pl2" }],
					next: null,
				}),
			);
		}
		if (path.includes("/playlists/pl1/tracks")) {
			return Promise.resolve(
				jsonResponse({
					items: [
						{
							added_at: "2024-01-01T00:00:00Z",
							added_by: { id: "someone" },
							track: {
								id: "trackA",
								name: "Track A",
								artists: [{ name: "Artist A" }],
								album: { name: "Album A" },
								duration_ms: 1000,
							},
						},
					],
					next: null,
				}),
			);
		}
		if (path.includes("/playlists/pl2/tracks")) {
			return Promise.resolve(jsonResponse({ items: [], next: null }));
		}
		throw new Error(`unexpected fetch: ${path}`);
	};
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const { ctx, messages } = makeContext(
		{},
		["playlist_items"],
		(stream, data) => {
			emittedRecords.push({ stream, data });
			return Promise.resolve();
		},
	);

	await spotifyCollect(ctx);

	assert.ok(
		requestedPaths.some((p) => p.includes("/playlists/pl1/tracks")),
		"must paginate playlist pl1's own tracks endpoint",
	);
	assert.ok(
		requestedPaths.some((p) => p.includes("/playlists/pl2/tracks")),
		"must paginate playlist pl2's own tracks endpoint even when empty",
	);
	assert.equal(emittedRecords.length, 1);
	assert.deepEqual(emittedRecords[0], {
		stream: "playlist_items",
		data: {
			id: "pl1:0",
			playlist_id: "pl1",
			track_id: "trackA",
			position: 0,
			added_at: "2024-01-01T00:00:00Z",
			added_by: "someone",
			name: "Track A",
			artist_names: ["Artist A"],
			album_name: "Album A",
			duration_ms: 1000,
		},
	});
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "playlist_items",
	);
	assert.equal(coverage?.considered, 1);
	assert.equal(coverage?.covered, 1);
});

test("spotify: profile emits a singleton record from GET /me, enriched with GET /me/following's artist total", async () => {
	globalThis.fetch = (input) => {
		const path = String(input);
		if (path.includes("/me/following")) {
			return Promise.resolve(jsonResponse({ artists: { total: 7 } }));
		}
		return Promise.resolve(
			jsonResponse({
				id: "spotify_user_id",
				display_name: "Real Person",
				followers: { total: 12 },
				uri: "spotify:user:spotify_user_id",
				images: [
					{ url: "https://i.scdn.co/image/ab5678", width: 300, height: 300 },
				],
			}),
		);
	};
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const { ctx, messages } = makeContext({}, ["profile"], (stream, data) => {
		emittedRecords.push({ stream, data });
		return Promise.resolve();
	});

	await spotifyCollect(ctx);

	assert.equal(emittedRecords.length, 1);
	assert.deepEqual(emittedRecords[0], {
		stream: "profile",
		data: {
			id: "spotify_user_id",
			display_name: "Real Person",
			followers: 12,
			uri: "spotify:user:spotify_user_id",
			images: [
				{ url: "https://i.scdn.co/image/ab5678", width: 300, height: 300 },
			],
			following: 7,
		},
	});
	const coverage = messages.find(
		(
			message,
		): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
			message.type === "DETAIL_COVERAGE" && message.stream === "profile",
	);
	assert.equal(coverage?.considered, 1);
	assert.equal(coverage?.covered, 1);
});

test("spotify: profile.following is null when GET /me/following fails, without failing the whole profile record", async () => {
	globalThis.fetch = (input) => {
		const path = String(input);
		if (path.includes("/me/following")) {
			return Promise.resolve(new Response("", { status: 500 }));
		}
		return Promise.resolve(
			jsonResponse({
				id: "spotify_user_id",
				display_name: "Real Person",
				followers: { total: 12 },
			}),
		);
	};
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const { ctx } = makeContext({}, ["profile"], (stream, data) => {
		emittedRecords.push({ stream, data });
		return Promise.resolve();
	});

	await spotifyCollect(ctx);

	assert.equal(emittedRecords.length, 1);
	assert.equal(emittedRecords[0]?.data.following, null);
});

test("spotify: fails a non-adjacent cursor cycle before refetching the repeated path", {
	concurrency: false,
}, async () => {
	const requested: string[] = [];
	globalThis.fetch = (input) => {
		const path = String(input);
		requested.push(path);
		if (requested.length === 1) {
			return Promise.resolve(
				jsonResponse({
					items: [savedTrack("first")],
					next: "https://api.spotify.com/v1/me/tracks?offset=50",
				}),
			);
		}
		if (requested.length === 2) {
			return Promise.resolve(
				jsonResponse({
					items: [savedTrack("second")],
					next: "https://api.spotify.com/v1/me/tracks?offset=100",
				}),
			);
		}
		return Promise.resolve(
			jsonResponse({
				items: [savedTrack("third")],
				next: "https://api.spotify.com/v1/me/tracks?offset=50",
			}),
		);
	};
	const { ctx } = makeContext();

	await assert.rejects(() => spotifyCollect(ctx), /spotify_pagination_cycle/);
	assert.equal(requested.length, 3);
});

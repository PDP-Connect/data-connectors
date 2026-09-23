// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { createSpotifyCycleDetector, spotifyCollect } from "./index.ts";

function makeContext(
	webResult: Record<string, unknown>,
	requestedNames: string[] = ["profile", "playlists", "playlist_items"],
): {
	emittedRecords: Array<{ stream: string; data: Record<string, unknown> }>;
	messages: EmittedMessage[];
	ctx: Parameters<typeof spotifyCollect>[0];
	visited: string[];
} {
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const messages: EmittedMessage[] = [];
	const visited: string[] = [];
	const requested = new Map<string, StreamScope>(
		requestedNames.map((name) => [name, { name }]),
	);
	return {
		emittedRecords,
		messages,
		visited,
		ctx: {
			emit: (message) => {
				messages.push(message);
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				emittedRecords.push({ stream, data });
				return Promise.resolve();
			},
			page: {
				goto: (url: string) => {
					visited.push(url);
					return Promise.resolve(null);
				},
				evaluate: () => Promise.resolve(webResult),
			} as never,
			progress: () => Promise.resolve(),
			requested,
		},
	};
}

const webFixture = {
	profile: {
		id: "spotify_user_id",
		display_name: "Real Person",
		followers: 12,
		uri: "spotify:user:spotify_user_id",
		images: [
			{ url: "https://i.scdn.co/image/ab5678", width: null, height: null },
		],
		following: 7,
	},
	playlists: [
		{
			id: "pl1",
			name: "Playlist One",
			owner_id: "owner1",
			owner_name: "Owner One",
			public: null,
			collaborative: null,
			track_count: 1,
			snapshot_id: null,
			description: "",
			uri: "spotify:playlist:pl1",
			followers: 42,
			images: [
				{ url: "https://i.scdn.co/image/p1", width: null, height: null },
			],
		},
	],
	playlist_items: [
		{
			id: "pl1:0",
			playlist_id: "pl1",
			track_id: "trackA",
			position: 0,
			added_at: "2024-01-01T00:00:00Z",
			added_by: "Display Name",
			name: "Track A",
			artist_names: ["Artist A"],
			album_name: "Album A",
			duration_ms: 1000,
		},
	],
	saved_tracks: [],
	warnings: [],
};

test("spotify browser collect emits modern profile, playlists, and playlist_items schemas", async () => {
	const { ctx, emittedRecords, messages, visited } = makeContext(webFixture);

	await spotifyCollect(ctx);

	assert.deepEqual(visited, ["https://open.spotify.com/"]);
	assert.deepEqual(
		emittedRecords.map((record) => record.stream),
		["profile", "playlists", "playlist_items"],
	);
	assert.equal(emittedRecords[2]?.data.added_by, "Display Name");
	assert.equal(
		messages.filter((message) => message.type === "DETAIL_COVERAGE").length,
		3,
	);
	assert.equal(
		messages.every(
			(message) =>
				message.type !== "DETAIL_COVERAGE" ||
				message.considered === message.covered,
		),
		true,
	);
});

test("spotify browser collect skips Web API-only streams during stage 1", async () => {
	const { ctx, messages } = makeContext(
		{ ...webFixture, profile: null, playlists: [], playlist_items: [] },
		["top_artists", "recently_played"],
	);

	await spotifyCollect(ctx);

	assert.deepEqual(
		messages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => message.stream)
			.sort(),
		["recently_played", "top_artists"],
	);
});

test("spotify cycle detector still catches repeated cursor paths", () => {
	const detector = createSpotifyCycleDetector("/me/tracks?limit=50");
	assert.equal(detector.observe("/me/tracks?offset=50"), false);
	assert.equal(detector.observe("/me/tracks?offset=100"), false);
	assert.equal(detector.observe("/me/tracks?offset=50"), true);
	assert.deepEqual(Object.keys(detector.state()).sort(), [
		"lambda",
		"power",
		"tortoise",
	]);
});

test("spotify browser parser paginates library, skips undated saved tracks, and preserves explicit false", async () => {
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const messages: EmittedMessage[] = [];
	const progressMessages: string[] = [];
	const operations: Array<{
		operationName: string;
		variables: Record<string, unknown>;
	}> = [];
	const originalFetch = globalThis.fetch;
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalCaches = globalThis.caches;
	const originalPerformance = globalThis.performance;
	const hashes = {
		fetchLibraryTracks: "a".repeat(64),
		fetchPlaylist: "b".repeat(64),
		libraryV3: "c".repeat(64),
		profileAttributes: "d".repeat(64),
	};
	const bundle = Object.entries(hashes)
		.map(([name, hash]) => `new a.b("${name}","query","${hash}"`)
		.join(";");
	try {
		(globalThis as unknown as { window: unknown }).window = {
			location: { hostname: "open.spotify.com" },
		};
		(globalThis as unknown as { document: unknown }).document = {
			querySelectorAll: () => [
				{ src: "https://open.spotifycdn.com/bundle.js" },
			],
		};
		(globalThis as unknown as { caches: unknown }).caches = {
			keys: () => Promise.resolve([]),
		};
		(globalThis as unknown as { performance: unknown }).performance = {
			getEntriesByType: () => [],
		};
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.startsWith("/api/server-time")) {
				return new Response(JSON.stringify({ serverTime: 1_700_000_000 }), {
					status: 200,
				});
			}
			if (url.startsWith("/api/token")) {
				return new Response(
					JSON.stringify({
						accessToken: "access-token",
						clientId: "client-id",
						isAnonymous: false,
					}),
					{ status: 200 },
				);
			}
			if (url === "https://clienttoken.spotify.com/v1/clienttoken") {
				return new Response(
					JSON.stringify({ granted_token: { token: "client-token" } }),
					{ status: 200 },
				);
			}
			if (url === "https://open.spotifycdn.com/bundle.js") {
				return new Response(bundle, { status: 200 });
			}
			if (url === "https://api-partner.spotify.com/pathfinder/v2/query") {
				const body = JSON.parse(String(init?.body)) as {
					operationName: string;
					variables: Record<string, unknown>;
				};
				operations.push(body);
				if (body.operationName === "libraryV3") {
					const offset = Number(body.variables.offset);
					const playlist = (id: string) => ({
						item: {
							data: { __typename: "Playlist", uri: `spotify:playlist:${id}` },
						},
					});
					const filler = { item: { data: { __typename: "Album" } } };
					const items =
						offset === 0
							? [playlist("pl1"), ...Array.from({ length: 199 }, () => filler)]
							: [playlist("pl2")];
					return new Response(
						JSON.stringify({
							data: { me: { libraryV3: { items, totalCount: 201 } } },
						}),
						{ status: 200 },
					);
				}
				if (body.operationName === "fetchPlaylist") {
					const id = String(body.variables.uri).split(":").pop();
					return new Response(
						JSON.stringify({
							data: {
								playlistV2: {
									uri: `spotify:playlist:${id}`,
									name: `Playlist ${id}`,
									ownerV2: {
										data: { uri: "spotify:user:owner1", name: "Owner" },
									},
									content: { totalCount: 0, items: [] },
									followers: 1,
									images: { items: [] },
								},
							},
						}),
						{ status: 200 },
					);
				}
				if (body.operationName === "fetchLibraryTracks") {
					return new Response(
						JSON.stringify({
							data: {
								me: {
									library: {
										tracks: {
											totalCount: 2,
											items: [
												{
													track: {
														uri: "spotify:track:missingDate",
														data: { name: "No Date" },
													},
												},
												{
													addedAt: { isoString: "2024-02-01T00:00:00Z" },
													track: {
														uri: "spotify:track:goodTrack",
														data: {
															name: "Good Track",
															artists: {
																items: [{ profile: { name: "Artist" } }],
															},
															albumOfTrack: {
																name: "Album",
																artists: { items: [] },
															},
															duration: { totalMilliseconds: 12 },
															contentRating: { label: "NONE" },
														},
													},
												},
											],
										},
									},
								},
							},
						}),
						{ status: 200 },
					);
				}
			}
			throw new Error(`unexpected fetch: ${url}`);
		};
		const requested = new Map<string, StreamScope>([
			["playlists", { name: "playlists" }],
			["saved_tracks", { name: "saved_tracks" }],
		]);
		await spotifyCollect({
			emit: (message) => {
				messages.push(message);
				return Promise.resolve();
			},
			emitRecord: (stream, data) => {
				emittedRecords.push({ stream, data });
				return Promise.resolve();
			},
			page: {
				goto: () => Promise.resolve(null),
				evaluate: (fn: (arg: string[]) => Promise<unknown>, arg: string[]) =>
					fn(arg),
			} as never,
			progress: (message) => {
				progressMessages.push(message);
				return Promise.resolve();
			},
			requested,
		});
	} finally {
		globalThis.fetch = originalFetch;
		(globalThis as unknown as { window: unknown }).window = originalWindow;
		(globalThis as unknown as { document: unknown }).document =
			originalDocument;
		(globalThis as unknown as { caches: unknown }).caches = originalCaches;
		(globalThis as unknown as { performance: unknown }).performance =
			originalPerformance;
	}

	assert.deepEqual(
		operations
			.filter((op) => op.operationName === "libraryV3")
			.map((op) => op.variables.offset),
		[0, 200],
	);
	assert.deepEqual(
		emittedRecords
			.filter((record) => record.stream === "playlists")
			.map((record) => record.data.id),
		["pl1", "pl2"],
	);
	const saved = emittedRecords.filter(
		(record) => record.stream === "saved_tracks",
	);
	assert.equal(saved.length, 1);
	assert.equal(saved[0]?.data.id, "goodTrack");
	assert.equal(saved[0]?.data.added_at, "2024-02-01T00:00:00Z");
	assert.equal(saved[0]?.data.explicit, false);
	assert.ok(
		progressMessages.some((message) => message.includes("missing added_at")),
	);
});

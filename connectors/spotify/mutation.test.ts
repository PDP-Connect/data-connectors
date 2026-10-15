// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeEmitRecord } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	createSpotifyCycleDetector,
	hasSpotifySession,
	parseRecentlyPlayedContexts,
	parseTopContent,
	recentlyPlayedContextsAfterCursor,
	spotifyCollect,
	spotifyRetryablePattern,
	spotifyTotp,
} from "./index.ts";
import { playlistItemsSchema, validateRecord } from "./schemas.ts";

function readFixture(name: string): unknown {
	return JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8"),
	);
}

test("recently-played fixture yields context records identified by URI with millisecond cursors", () => {
	assert.deepEqual(
		parseRecentlyPlayedContexts(
			readFixture("recently-played-contexts-response.json"),
		),
		[
			{
				id: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
				uri: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
				last_played_time: 1720000000123,
				last_played_track_uri: "spotify:track:2takcwOaAZWiXQijPHIx7B",
			},
		],
	);
});

test("recently-played parser accepts empty responses and rejects malformed contexts", () => {
	assert.deepEqual(
		parseRecentlyPlayedContexts(
			readFixture("recently-played-contexts-empty-response.json"),
		),
		[],
	);
	assert.deepEqual(parseRecentlyPlayedContexts({ playContexts: [] }), []);
	assert.throws(
		() =>
			parseRecentlyPlayedContexts({
				playContexts: [{ uri: "spotify:album:x" }],
			}),
		/spotify_recently_played_unusable_context/u,
	);
});

test("top-content fixture parses wrapped artist and track entities with the requested window", () => {
	const records = parseTopContent(
		readFixture("top-content-response.json"),
		"short_term",
	);
	assert.deepEqual(records.top_artists, [
		{
			id: "06HL4z0CvFAxyc27GXpf02",
			uri: "spotify:artist:06HL4z0CvFAxyc27GXpf02",
			name: "Taylor Swift",
			genres: ["pop"],
			followers: 89000000,
			popularity: null,
			time_range: "short_term",
		},
	]);
	assert.deepEqual(records.top_tracks, [
		{
			id: "11dFghVXANMlKmJXsNCbNl",
			uri: "spotify:track:11dFghVXANMlKmJXsNCbNl",
			name: "Cut To The Feeling",
			artist_names: ["Carly Rae Jepsen"],
			album_name: "Cut To The Feeling",
			duration_ms: 207959,
			time_range: "short_term",
		},
	]);
});

test("top-content parser rejects a missing requested page envelope", () => {
	assert.throws(
		() =>
			parseTopContent(
				{ data: { me: { profile: { topArtists: { items: [], totalCount: 0 } } } } },
				"short_term",
				["top_tracks"],
			),
		/spotify_top_content_top_tracks_malformed/u,
	);
});

test("top-content parser rejects items without a usable identifier instead of dropping them", () => {
	assert.throws(
		() =>
			parseTopContent(
				{
					data: {
						me: {
							profile: {
								topArtists: {
									items: [{ data: { profile: { name: "No ID" } } }],
									totalCount: 1,
								},
							},
						},
					},
				},
				"short_term",
				["top_artists"],
			),
		/spotify_top_content_top_artists_unusable_item/u,
	);
});

test("top-content parser retains a wrapper URI as the entity identifier", () => {
	const records = parseTopContent(
		{
			data: {
				me: {
					profile: {
						topArtists: {
							items: [
								{
									_uri: "spotify:artist:wrapperArtistId",
									data: { profile: { name: "Wrapped Artist" } },
								},
							],
							totalCount: 1,
						},
					},
				},
			},
		},
		"short_term",
		["top_artists"],
	);
	assert.equal(records.top_artists[0]?.id, "wrapperArtistId");
	assert.equal(records.top_artists[0]?.uri, "spotify:artist:wrapperArtistId");
});

test("top-content parser omits a missing name while preserving a valid record", () => {
	const records = parseTopContent(
		{
			data: {
				me: {
					profile: {
						topTracks: {
							items: [
								{
									data: {
										uri: "spotify:track:unnamedTrack",
										artists: { items: [] },
									},
								},
							],
							totalCount: 1,
						},
					},
				},
			},
		},
		"short_term",
		["top_tracks"],
	);
	const record = records.top_tracks[0];
	assert.equal(record?.name, undefined);
	assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(record)), "name"), false);
});

test("recent context cursor includes and deduplicates a tie at the prior watermark", () => {
	const tie = {
		uri: "spotify:album:tied",
		last_played_time: 1_000,
		last_played_track_uri: null,
	};
	assert.deepEqual(
		recentlyPlayedContextsAfterCursor(
			[tie, tie, { ...tie, uri: "spotify:album:other" }],
			1_000,
		),
		{
			contexts: [tie, { ...tie, uri: "spotify:album:other" }],
			cursor: 1_000,
		},
	);
});

test("top-content parser accepts empty pages and identifies the fixture 429 path", () => {
	assert.deepEqual(
		parseTopContent(
			readFixture("top-content-empty-response.json"),
			"long_term",
		),
		{ top_artists: [], top_tracks: [] },
	);
	assert.equal(
		(readFixture("spotify-429-response.json") as { error: string }).error,
		"API rate limit exceeded",
	);
});

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
			state: {},
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
			uri: "spotify:local:Artist:Album:Local%20Track:180000",
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
	recently_played_contexts: [
		{
			id: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
			uri: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
			last_played_time: 1720000000123,
			last_played_track_uri: "spotify:track:2takcwOaAZWiXQijPHIx7B",
		},
	],
	top_artists: [
		{
			id: "06HL4z0CvFAxyc27GXpf02",
			name: "Taylor Swift",
			genres: ["pop"],
			popularity: 99,
			followers: 100,
			time_range: "short_term",
		},
	],
	top_tracks: [
		{
			id: "11dFghVXANMlKmJXsNCbNl",
			uri: "spotify:track:11dFghVXANMlKmJXsNCbNl",
			name: "Track A",
			artist_names: ["Artist A"],
			album_name: "Album A",
			duration_ms: 1000,
			time_range: "short_term",
		},
	],
	warnings: [],
};

test("spotifyTotp preserves the provider's decimal-text XOR secret encoding", () => {
	assert.equal(spotifyTotp(1_700_000_000_000), "371599");
});

test("Spotify readiness checks the shared cookie-backed token endpoint without navigating a page", async () => {
	const requests: string[] = [];
	let navigations = 0;
	const page = {
		context: () => ({
			request: {
				get: async (url: string) => {
					requests.push(url);
					return {
						json: async () =>
							url.endsWith("/api/server-time")
								? { serverTime: 1_700_000_000 }
								: { accessToken: "fixture-token", isAnonymous: false },
						ok: () => true,
						dispose: async () => undefined,
					};
				},
			},
		}),
		goto: async () => {
			navigations += 1;
		},
	} as unknown as Page;

	assert.equal(await hasSpotifySession(page), true);
	assert.equal(requests.length, 2);
	assert.equal(requests[0], "https://open.spotify.com/api/server-time");
	assert.match(
		requests[1] ?? "",
		/^https:\/\/open\.spotify\.com\/api\/token\?/u,
	);
	assert.equal(navigations, 0);
});

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
		emittedRecords[2]?.data.uri,
		"spotify:local:Artist:Album:Local%20Track:180000",
	);
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

test("Spotify browser collect emits top-ranking snapshots and the recently-played cursor", async () => {
	const { ctx, emittedRecords, messages } = makeContext(webFixture, [
		"top_artists",
		"top_tracks",
		"recently_played_contexts",
	]);

	await spotifyCollect(ctx);

	assert.deepEqual(
		emittedRecords.map((record) => record.stream),
		["top_artists", "top_tracks", "recently_played_contexts"],
	);
	assert.deepEqual(
		messages.filter((message) => message.type === "SKIP_RESULT"),
		[],
	);
	assert.ok(
		messages.some(
			(message) =>
				message.type === "STATE" &&
				message.stream === "recently_played_contexts" &&
				typeof message.cursor === "object" &&
				message.cursor !== null &&
				"last_played_time" in message.cursor &&
				message.cursor.last_played_time === 1720000000123,
		),
	);
});

test("Spotify ranking records emit canonical composite keys for each time window", async () => {
	const messages: EmittedMessage[] = [];
	const requested = new Map<string, StreamScope>([
		["top_artists", { name: "top_artists" }],
		["top_tracks", { name: "top_tracks" }],
	]);
	const recordEmitter = makeEmitRecord({
		requested,
		emit: (message) => {
			messages.push(message);
			return Promise.resolve();
		},
		emittedAt: "2026-10-15T00:00:00Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => null,
	});
	await spotifyCollect({
		emit: (message) => {
			messages.push(message);
			return Promise.resolve();
		},
		emitRecord: recordEmitter.emit,
		page: {
			goto: () => Promise.resolve(null),
			evaluate: () => Promise.resolve(webFixture),
		} as never,
		progress: () => Promise.resolve(),
		requested,
	});
	const records = messages.filter(
		(message): message is Extract<EmittedMessage, { type: "RECORD" }> =>
			message.type === "RECORD",
	);
	assert.deepEqual(
		records.map((record) => [record.stream, record.key]),
		[
			["top_artists", JSON.stringify(["06HL4z0CvFAxyc27GXpf02", "short_term"])],
			["top_tracks", JSON.stringify(["11dFghVXANMlKmJXsNCbNl", "short_term"])],
		],
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
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => diagnostics.push(line));
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
											totalCount: 3,
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
												{
													addedAt: { isoString: "2024-02-02T00:00:00Z" },
													track: {
														uri: "spotify:track:unknownExplicit",
														data: {
															name: "Unknown Explicit",
															artists: { items: [] },
															albumOfTrack: { artists: { items: [] } },
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
				evaluate: (
					fn: (arg: { requested: string[]; priorContextTime?: number }) => Promise<unknown>,
					arg: { requested: string[]; priorContextTime?: number },
				) =>
					fn(arg),
			} as never,
			progress: (message) => {
				progressMessages.push(message);
				return Promise.resolve();
			},
			requested,
		});
	} finally {
		setConnectorDiagnosticSink(undefined);
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
	assert.equal(saved.length, 2);
	assert.equal(saved[0]?.data.id, "goodTrack");
	assert.equal(saved[0]?.data.added_at, "2024-02-01T00:00:00Z");
	assert.equal(saved[0]?.data.explicit, false);
	assert.equal(saved[1]?.data.id, "unknownExplicit");
	assert.equal(saved[1]?.data.explicit, null);
	assert.deepEqual(
		progressMessages.filter((message) => message.startsWith("Skipped")),
		["Skipped 1 saved track with no save date"],
	);
	assertUserFacingProgress(
		progressMessages.map((message) => ({ type: "PROGRESS", message })),
	);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith("[spotify-diagnostic] saved_track_missing_added_at ") &&
				line.includes('"track_id":'),
		),
	);
});

function installSpotifyBrowserGlobals(): () => void {
	const originalNameHelper = (
		globalThis as unknown as { __name?: (...args: unknown[]) => unknown }
	).__name;
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalCaches = globalThis.caches;
	const originalPerformance = globalThis.performance;
	(globalThis as unknown as { window: unknown }).window = {
		location: { hostname: "open.spotify.com" },
	};
	(globalThis as unknown as { document: unknown }).document = {
		querySelectorAll: () => [{ src: "https://open.spotifycdn.com/bundle.js" }],
	};
	(globalThis as unknown as { caches: unknown }).caches = {
		keys: () => Promise.resolve([]),
	};
	(globalThis as unknown as { performance: unknown }).performance = {
		getEntriesByType: () => [],
	};
	(globalThis as unknown as { __name: (fn: unknown) => unknown }).__name = (
		fn,
	) => fn;
	return () => {
		(globalThis as unknown as { window: unknown }).window = originalWindow;
		(globalThis as unknown as { document: unknown }).document =
			originalDocument;
		(globalThis as unknown as { caches: unknown }).caches = originalCaches;
		(globalThis as unknown as { performance: unknown }).performance =
			originalPerformance;
		if (originalNameHelper === undefined)
			delete (globalThis as unknown as { __name?: unknown }).__name;
		else
			(
				globalThis as unknown as { __name: (...args: unknown[]) => unknown }
			).__name = originalNameHelper;
	};
}

function spotifyWebFixtureBundle(): string {
	return [
		["fetchLibraryTracks", "a".repeat(64)],
		["fetchPlaylist", "b".repeat(64)],
		["libraryV3", "c".repeat(64)],
		["profileAttributes", "d".repeat(64)],
		[
			"userTopContent",
			"61b7353d3625780022dbc63d459eb64cd609e7e5e2a820f9160d65030efe2e15",
		],
	]
		.map(([name, hash]) => `new a.b("${name}","query","${hash}"`)
		.join(";");
}

async function collectWithInPageFetch(
	requestedNames: string[],
	graphql: (
		operationName: string,
		variables: Record<string, unknown>,
	) => unknown,
	recentlyPlayedStatus = 200,
	options: {
		observedMessages?: EmittedMessage[];
		recentlyPlayedPages?: unknown[][];
		recentlyPlayedOffsets?: number[];
		runtimeEmitRecord?: boolean;
		state?: Record<string, unknown>;
	} = {},
): Promise<{
	emittedRecords: Array<{ stream: string; data: Record<string, unknown> }>;
	messages: EmittedMessage[];
}> {
	const restoreGlobals = installSpotifyBrowserGlobals();
	const originalFetch = globalThis.fetch;
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const messages = options.observedMessages ?? [];
	const requested = new Map<string, StreamScope>(
		requestedNames.map((name) => [name, { name }]),
	);
	const runtimeEmitter = options.runtimeEmitRecord
		? makeEmitRecord({
				emit: (message) => {
					messages.push(message);
					return Promise.resolve();
				},
				emittedAt: "2026-10-15T00:00:00Z",
				isTombstone: undefined,
				requested,
				timeRangeFieldFor: () => null,
				validateRecord,
			})
		: undefined;
	try {
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
				return new Response(spotifyWebFixtureBundle(), { status: 200 });
			}
			if (url === "https://api-partner.spotify.com/pathfinder/v2/query") {
				const body = JSON.parse(String(init?.body)) as {
					operationName: string;
					variables: Record<string, unknown>;
				};
				const result = graphql(body.operationName, body.variables);
				return result instanceof Response
					? result
					: new Response(JSON.stringify(result), { status: 200 });
			}
			if (url.startsWith("https://spclient.wg.spotify.com/recently-played/")) {
				const parsedUrl = new URL(url);
				assert.equal(
					parsedUrl.pathname,
					"/recently-played/v3/user/fixture-user/recently-played",
				);
				assert.equal(parsedUrl.searchParams.get("limit"), "50");
				assert.equal(
					new Headers(init?.headers).get("app-platform"),
					"WebPlayer",
				);
				const pageIndex = Number(parsedUrl.searchParams.get("offset") ?? 0) / 50;
				options.recentlyPlayedOffsets?.push(pageIndex * 50);
				const body =
					recentlyPlayedStatus !== 200
						? readFixture("spotify-429-response.json")
						: options.recentlyPlayedPages
							? { playContexts: options.recentlyPlayedPages[pageIndex] ?? [] }
							: readFixture("recently-played-contexts-response.json");
				return new Response(JSON.stringify(body), {
					status: recentlyPlayedStatus,
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		};
		await spotifyCollect({
			emit: (message) => {
				messages.push(message);
				return Promise.resolve();
			},
			emitRecord: (stream, data, emitOptions) => {
				if (runtimeEmitter)
					return runtimeEmitter.emit(stream, data, emitOptions);
				emittedRecords.push({ stream, data });
				return Promise.resolve();
			},
			page: {
				goto: () => Promise.resolve(null),
				evaluate: async (
					fn: (arg: {
						requested: string[];
						priorContextTime?: number;
					}) => Promise<unknown>,
					arg: { requested: string[]; priorContextTime?: number },
				) =>
					new Function(`return (${String(fn)})`)()(
						JSON.parse(JSON.stringify(arg)),
					),
			} as never,
			progress: () => Promise.resolve(),
			requested,
			...(options.state ? { state: options.state } : {}),
		});
		if (runtimeEmitter) {
			emittedRecords.push(
				...messages.flatMap((message) =>
					message.type === "RECORD"
						? [{ stream: message.stream, data: message.data }]
						: [],
				),
			);
		}
		return { emittedRecords, messages };
	} finally {
		globalThis.fetch = originalFetch;
		restoreGlobals();
	}
}

test("recently-played context endpoint parses the fixture and surfaces its 429 status", async () => {
	const success = await collectWithInPageFetch(
		["recently_played_contexts"],
		(operationName) => {
			assert.equal(operationName, "profileAttributes");
			return { data: { me: { profile: { username: "fixture-user" } } } };
		},
	);
	assert.deepEqual(success.emittedRecords, [
		{
			stream: "recently_played_contexts",
			data: {
				id: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
				uri: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
				last_played_time: 1720000000123,
				last_played_track_uri: "spotify:track:2takcwOaAZWiXQijPHIx7B",
			},
		},
	]);
	await assert.rejects(
		() =>
			collectWithInPageFetch(
				["recently_played_contexts"],
				() => ({ data: { me: { profile: { username: "fixture-user" } } } }),
				429,
			),
		/spotify_retryable_status_429/u,
	);
});

test("Spotify page.evaluate callbacks work after browser serialization", async () => {
	const result = await collectWithInPageFetch(
		["recently_played_contexts", "top_artists"],
		(operationName, variables) => {
			if (operationName === "profileAttributes")
				return { data: { me: { profile: { username: "fixture-user" } } } };
			assert.equal(operationName, "userTopContent");
			assert.equal(typeof variables.topArtistsInput, "object");
			return {
				data: {
					me: {
						profile: {
							topArtists: {
								items: [],
								totalCount: 0,
							},
						},
					},
				},
			};
		},
	);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		true,
	);
});

test("recently-played contexts reach wire RECORDs through runtime emitRecord", async () => {
	const result = await collectWithInPageFetch(
		["recently_played_contexts"],
		() => ({ data: { me: { profile: { username: "fixture-user" } } } }),
		200,
		{ runtimeEmitRecord: true },
	);
	assert.deepEqual(
		result.messages.filter((message) => message.type === "RECORD"),
		[
			{
				type: "RECORD",
				stream: "recently_played_contexts",
				key: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
				data: {
					id: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
					uri: "spotify:album:4aawyAB9vmqN3uQ7FjRGTy",
					last_played_time: 1720000000123,
					last_played_track_uri: "spotify:track:2takcwOaAZWiXQijPHIx7B",
				},
				emitted_at: "2026-10-15T00:00:00Z",
			},
		],
	);
});

test("malformed recently-played entries fail before advancing the cursor", async () => {
	const observedMessages: EmittedMessage[] = [];
	await assert.rejects(
		() =>
			collectWithInPageFetch(
				["recently_played_contexts"],
				() => ({ data: { me: { profile: { username: "fixture-user" } } } }),
				200,
				{
					observedMessages,
					recentlyPlayedPages: [
						[
							{
								uri: "spotify:album:valid",
								lastPlayedTime: 2_000,
							},
							{ uri: "spotify:album:missing-time" },
						],
					],
					state: {
						recently_played_contexts: { last_played_time: 1_000 },
					},
				},
			),
		/spotify_recently_played_unusable_context/u,
	);
	assert.equal(
		observedMessages.some(
			(message) =>
				message.type === "STATE" &&
				message.stream === "recently_played_contexts",
		),
		false,
	);
});

test("recently-played pagination crosses the prior watermark and retains tied contexts", async () => {
	const newer = Array.from({ length: 49 }, (_, index) => ({
		uri: `spotify:album:new-${index}`,
		lastPlayedTime: 2_000 - index,
		lastPlayedTrackUri: null,
	}));
	const boundaryTie = {
		uri: "spotify:album:page-boundary-watermark-tie",
		lastPlayedTime: 1_000,
		lastPlayedTrackUri: null,
	};
	const tied = {
		uri: "spotify:album:watermark-tie",
		lastPlayedTime: 1_000,
		lastPlayedTrackUri: null,
	};
	const pages = [
		[...newer, boundaryTie],
		[
			tied,
			tied,
			{
				uri: "spotify:album:older",
				lastPlayedTime: 999,
				lastPlayedTrackUri: null,
			},
		],
	];
	const offsets: number[] = [];
	const response = await collectWithInPageFetch(
		["recently_played_contexts"],
		(operationName) => {
			assert.equal(operationName, "profileAttributes");
			return { data: { me: { profile: { username: "fixture-user" } } } };
		},
		200,
		{
			recentlyPlayedPages: pages,
			recentlyPlayedOffsets: offsets,
			state: { recently_played_contexts: { last_played_time: 1_000 } },
		},
	);
	assert.equal(response.emittedRecords.length, 51);
	assert.ok(
		response.emittedRecords.some((record) => record.data.uri === tied.uri),
	);
	assert.ok(
		response.emittedRecords.some(
			(record) => record.data.uri === boundaryTie.uri,
		),
	);
	assert.equal(
		response.emittedRecords.filter((record) => record.data.uri === tied.uri)
			.length,
		1,
	);
	assert.equal(
		response.messages.filter((message) => message.type === "STATE").length,
		1,
	);
	assert.deepEqual(offsets, [0, 50]);
});

test("spotify browser GraphQL retries 429 using Retry-After and classifies exhausted 5xx", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	const retryDelays: number[] = [];
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay = 0,
	) => {
		retryDelays.push(Number(delay));
		return originalSetTimeout(callback, 0);
	}) as typeof globalThis.setTimeout;
	try {
		let rateLimitAttempts = 0;
		await collectWithInPageFetch(["saved_tracks"], () => {
			rateLimitAttempts += 1;
			if (rateLimitAttempts === 1) {
				return new Response(null, {
					status: 429,
					headers: { "retry-after": "2" },
				});
			}
			return {
				data: {
					me: { library: { tracks: { items: [], totalCount: 0 } } },
				},
			};
		});
		assert.equal(rateLimitAttempts, 2);
		assert.deepEqual(retryDelays, [2000]);

		let serverErrorAttempts = 0;
		await assert.rejects(
			() =>
				collectWithInPageFetch(["saved_tracks"], () => {
					serverErrorAttempts += 1;
					return new Response(null, { status: 503 });
				}),
			(error: unknown) => {
				assert.match(String(error), /spotify_retryable_status_503/);
				assert.equal(spotifyRetryablePattern.test(String(error)), true);
				return true;
			},
		);
		assert.equal(serverErrorAttempts, 3);
		assert.deepEqual(retryDelays, [2000, 1000, 2000]);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("Spotify top streams call Pathfinder for both verified windows and tolerate an initial 429", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: (...args: unknown[]) => void) => {
		originalSetTimeout(callback, 0);
		return 0 as unknown as ReturnType<typeof setTimeout>;
	}) as typeof globalThis.setTimeout;
	try {
		const calls: Array<{
			operationName: string;
			variables: Record<string, unknown>;
		}> = [];
		let rateLimitOnce = true;
		const result = await collectWithInPageFetch(
			["top_artists", "top_tracks"],
			(operationName, variables) => {
				calls.push({ operationName, variables });
				if (rateLimitOnce) {
					rateLimitOnce = false;
					return new Response(null, {
						status: 429,
						headers: { "retry-after": "0" },
					});
				}
				return {
					data: {
						me: {
							profile: {
								topArtists: { items: [], totalCount: 0 },
								topTracks: { items: [], totalCount: 0 },
							},
						},
					},
				};
			},
		);
		assert.deepEqual(result.emittedRecords, []);
		assert.deepEqual(
			calls.map(
				({ variables }) =>
					(variables.topArtistsInput as { timeRange: string }).timeRange,
			),
			["SHORT_TERM", "SHORT_TERM", "LONG_TERM"],
		);
		assert.ok(
			calls.every(({ operationName }) => operationName === "userTopContent"),
		);
		assert.ok(
			calls.every(
				({ variables }) =>
					variables.includeTopArtists === true &&
					variables.includeTopTracks === true,
			),
		);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("Spotify top rankings paginate Pathfinder totalCount to completion", async () => {
	const offsets = new Map<string, number[]>();
	const result = await collectWithInPageFetch(
		["top_artists", "top_tracks"],
		(operationName, variables) => {
			assert.equal(operationName, "userTopContent");
			const timeRange = String(
				(variables.topArtistsInput as { timeRange: string }).timeRange,
			);
			const profile: Record<string, unknown> = {};
			for (const [stream, inputName, pageName] of [
				["top_artists", "topArtistsInput", "topArtists"],
				["top_tracks", "topTracksInput", "topTracks"],
			] as const) {
				const includeName = stream === "top_artists" ? "includeTopArtists" : "includeTopTracks";
				if (variables[includeName] !== true) continue;
				const input = variables[inputName] as { offset: number; limit: number };
				const key = `${stream}:${timeRange}`;
				let streamOffsets = offsets.get(key);
				if (!streamOffsets) {
					streamOffsets = [];
					offsets.set(key, streamOffsets);
				}
				streamOffsets.push(input.offset);
				const totalCount = stream === "top_artists" ? 60 : 55;
				const items = Array.from(
					{ length: Math.min(input.limit, Math.max(0, totalCount - input.offset)) },
					(_, index) => {
						const id = `${stream}-${input.offset + index}`;
						return {
							data:
								stream === "top_artists"
									? {
											uri: `spotify:artist:${id}`,
											profile: { name: `Artist ${id}` },
										}
									: { uri: `spotify:track:${id}`, artists: { items: [] } },
						};
					},
				);
				profile[pageName] = { items, totalCount };
			}
			return { data: { me: { profile } } };
		},
	);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "top_artists")
			.length,
		120,
	);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "top_tracks")
			.length,
		110,
	);
	assert.deepEqual(offsets.get("top_artists:SHORT_TERM"), [0, 50]);
	assert.deepEqual(offsets.get("top_tracks:LONG_TERM"), [0, 50]);
});

test("Spotify top rankings cap at 100 per window and report partial coverage without failing", async () => {
	const result = await collectWithInPageFetch(
		["top_artists", "top_tracks"],
		(operationName, variables) => {
			assert.equal(operationName, "userTopContent");
			const artistInput = variables.topArtistsInput as {
				limit: number;
				offset: number;
			};
			const artists = Array.from({ length: artistInput.limit }, (_, index) => {
				const id = String(artistInput.offset + index).padStart(22, "0");
				return {
					data: {
						uri: `spotify:artist:${id}`,
						profile: { name: `Artist ${id}` },
					},
				};
			});
			return {
				data: {
					me: {
						profile: {
							topArtists: { items: artists, totalCount: 101 },
							topTracks: { items: [], totalCount: 0 },
						},
					},
				},
			};
		},
	);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "top_artists")
			.length,
		200,
	);
	assert.deepEqual(
		result.messages.flatMap((message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "top_artists"
				? [{ considered: message.considered, covered: message.covered }]
				: [],
		),
		[{ considered: 202, covered: 200 }],
	);
});

test("Spotify top rankings reject a repeated Pathfinder page", async () => {
	const items = Array.from({ length: 50 }, (_, index) => ({
		data: { uri: `spotify:artist:repeat-${index}`, profile: { name: `Artist ${index}` } },
	}));
	await assert.rejects(
		() =>
			collectWithInPageFetch(["top_artists"], () => ({
				data: {
					me: {
						profile: { topArtists: { items, totalCount: 150 } },
					},
				},
			})),
		/spotify_top_content_top_artists_pagination_no_progress/u,
	);
});

test("Spotify top rankings reject pages larger than the provider total", async () => {
	await assert.rejects(
		() =>
			collectWithInPageFetch(["top_artists"], (operationName) => {
				assert.equal(operationName, "userTopContent");
				return {
					data: {
						me: {
							profile: {
								topArtists: {
									totalCount: 1,
									items: [
										{
											data: {
												uri: "spotify:artist:one",
												profile: { name: "Artist one" },
											},
										},
										{
											data: {
												uri: "spotify:artist:two",
												profile: { name: "Artist two" },
											},
										},
									],
								},
							},
						},
					},
				};
			}),
		/spotify_top_content_top_artists_invalid_page_size/u,
	);
});

test("spotify browser parser rejects repeated full library pages", async () => {
	const items = Array.from({ length: 200 }, (_, i) => ({
		item: { data: { __typename: "Playlist", uri: `spotify:playlist:pl${i}` } },
	}));
	await assert.rejects(
		() =>
			collectWithInPageFetch(["playlists"], (operationName) => {
				assert.equal(operationName, "libraryV3");
				return { data: { me: { libraryV3: { items, totalCount: 500 } } } };
			}),
		/spotify_library_pagination_no_progress/,
	);
});

test("spotify browser parser rejects repeated full playlist pages", async () => {
	const playlistItem = {
		addedAt: { isoString: "2024-01-01T00:00:00Z" },
		itemV2: {
			data: { __typename: "Track", uri: "spotify:track:t", name: "Track" },
		},
	};
	const items = Array.from({ length: 100 }, () => playlistItem);
	await assert.rejects(
		() =>
			collectWithInPageFetch(["playlist_items"], (operationName) => {
				if (operationName === "libraryV3") {
					return {
						data: {
							me: {
								libraryV3: {
									items: [
										{
											item: {
												data: {
													__typename: "Playlist",
													uri: "spotify:playlist:pl1",
												},
											},
										},
									],
									totalCount: 1,
								},
							},
						},
					};
				}
				assert.equal(operationName, "fetchPlaylist");
				return {
					data: {
						playlistV2: {
							uri: "spotify:playlist:pl1",
							content: { items, totalCount: 500 },
						},
					},
				};
			}),
		/spotify_playlist_pagination_no_progress/,
	);
});

test("spotify browser parser preserves the full playlist track URI alongside its ID", async () => {
	const { emittedRecords } = await collectWithInPageFetch(
		["playlist_items"],
		(operationName) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								items: [
									{
										item: {
											data: {
												__typename: "Playlist",
												uri: "spotify:playlist:pl1",
											},
										},
									},
								],
								totalCount: 1,
							},
						},
					},
				};
			}
			assert.equal(operationName, "fetchPlaylist");
			return {
				data: {
					playlistV2: {
						uri: "spotify:playlist:pl1",
						content: {
							totalCount: 1,
							items: [
								{
									itemV2: {
										data: {
											__typename: "Track",
											uri: "spotify:local:Artist:Album:Local%20Track:180000",
											name: "Track",
										},
									},
								},
							],
						},
					},
				},
			};
		},
	);
	const track = emittedRecords.find(
		(record) => record.stream === "playlist_items",
	);
	assert.equal(track?.data.track_id, "180000");
	assert.equal(
		track?.data.uri,
		"spotify:local:Artist:Album:Local%20Track:180000",
	);
	assert.equal(playlistItemsSchema.safeParse(track?.data).success, true);
});

test("spotify browser parser rejects repeated full saved-track pages even when every row is skipped", async () => {
	const items = Array.from({ length: 100 }, (_, i) => ({
		track: { uri: `spotify:track:t${i}`, data: { name: `Track ${i}` } },
	}));
	await assert.rejects(
		() =>
			collectWithInPageFetch(["saved_tracks"], (operationName) => {
				assert.equal(operationName, "fetchLibraryTracks");
				return {
					data: { me: { library: { tracks: { items, totalCount: 500 } } } },
				};
			}),
		/spotify_saved_tracks_pagination_no_progress/,
	);
});

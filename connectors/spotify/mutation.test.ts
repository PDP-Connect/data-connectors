// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { completeSourceFields } from "./__fixtures__/complete-source-fields.ts";
import assert from "node:assert/strict";
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
import {
	createSpotifyCycleDetector,
	hasSpotifySession,
	parseRecentContextRows,
	parseTopRows,
	spotifyCollect,
	spotifyTotp,
} from "./index.ts";
import { playlistItemsSchema } from "./schemas.ts";

test("recent context rows keep covered rows and withhold malformed rows whole", () => {
	const result = parseRecentContextRows([
		{
			playContexts: [
				{
					uri: "spotify:album:album1",
					lastPlayedTime: 1720000000123,
					lastPlayedTrackUri: "spotify:track:track1",
				},
				{
					uri: "spotify:album:album2",
					lastPlayedTime: "malformed",
					lastPlayedTrackUri: null,
				},
				{
					uri: "spotify:album:album3",
					lastPlayedTime: 1720000000124,
				},
			],
		},
	]);
	assert.equal(result.considered, 3);
	assert.equal(result.rows.length, 1);
	assert.equal(result.withheld, 2);
	assert.deepEqual(result.rows[0], {
		id: "spotify:album:album1",
		uri: "spotify:album:album1",
		last_played_time: 1720000000123,
		last_played_track_uri: "spotify:track:track1",
	});
});

test("top track rows are withheld whole when a mapped artist field is malformed", () => {
	const page = (items: unknown[]) => ({
		data: { me: { profile: { topTracks: { items, totalCount: items.length } } } },
	});
	const good = {
		data: {
			uri: "spotify:track:track1",
			name: "Track One",
			artists: { items: [{ profile: { name: "Artist One" } }] },
			albumOfTrack: { name: "Album One" },
			trackDuration: { totalMilliseconds: 123000 },
		},
	};
	const malformed = {
		data: {
			uri: "spotify:track:track2",
			name: "Track Two",
			artists: { items: [{ profile: {} }] },
			albumOfTrack: { name: "Album Two" },
			trackDuration: { totalMilliseconds: 124000 },
		},
	};
	const result = parseTopRows([page([good, malformed])], "top_tracks", "short_term");
	assert.equal(result.considered, 2);
	assert.equal(result.rows.length, 1);
	assert.equal(result.withheld, 1);
	assert.equal(result.rows[0]?.id, "track1");
});

test("ranked-list coverage counts only inspected rows, not rows outside the cap", () => {
	const page = {
		data: {
			me: {
				profile: {
					topTracks: {
						items: [
							{
								data: {
									uri: "spotify:track:track1",
									name: "Track One",
									artists: { items: [] },
									albumOfTrack: { name: "Album One" },
									trackDuration: { totalMilliseconds: 123000 },
								},
							},
						],
						totalCount: 500,
					},
				},
			},
		},
	};
	const result = parseTopRows([page], "top_tracks", "short_term");
	assert.equal(result.considered, 1);
	assert.equal(result.rows.length, 1);
	assert.equal(result.withheld, 0);
});

test("bounded Spotify streams emit typed gaps and never claim full-scan STATE", async () => {
	const data = {
		...webFixture,
		recent_context_pages: [
			{
				playContexts: [
					{
						uri: "spotify:album:album1",
						lastPlayedTime: 1720000000123,
						lastPlayedTrackUri: null,
					},
				],
			},
		],
		top_artist_pages: [
			{
				timeRange: "SHORT_TERM",
				payload: {
					data: {
						me: {
							profile: {
								topArtists: {
									totalCount: 1,
									items: [{ data: { uri: "spotify:artist:artist1", name: "Artist One", genres: [], stats: { followers: 1 }, popularity: 5 } }],
								},
							},
						},
					},
				},
			},
		],
		top_track_pages: [
			{
				timeRange: "LONG_TERM",
				payload: {
					data: {
						me: {
							profile: {
								topTracks: {
									totalCount: 1,
									items: [{ data: { uri: "spotify:track:track1", name: "Track One", artists: { items: [] }, albumOfTrack: { name: null }, trackDuration: { totalMilliseconds: 1 } } }],
								},
							},
						},
					},
				},
			},
		],
		recently_played_contexts: [
			{
				uri: "spotify:album:album1",
				last_played_time: 1720000000123,
				last_played_track_uri: null,
			},
		],
		sourceCounts: {
			recently_played_contexts: { considered: 1, covered: 1 },
			top_artists: { considered: 1, covered: 1 },
			top_tracks: { considered: 1, covered: 1 },
		},
	};
	const names = ["recently_played_contexts", "top_artists", "top_tracks"];
	const { ctx, emittedRecords, messages } = makeContext(data, names);
	await spotifyCollect(ctx);
	assert.equal(
		emittedRecords.filter((record) => names.includes(record.stream)).length,
		3,
	);
	assert.equal(
		messages.some(
			(message) =>
				message.type === "STATE" && names.includes(message.stream),
		),
		false,
	);
	const gaps = messages.filter((message) => message.type === "SKIP_RESULT");
	assert.deepEqual(
		gaps.map((message) => message.type === "SKIP_RESULT" ? [message.stream, message.reason] : null),
		[
			["recently_played_contexts", "spotify_recent_context_boundary_unverified"],
			["top_artists", "spotify_ranked_list_capped"],
			["top_tracks", "spotify_ranked_list_capped"],
		],
	);
	assert.deepEqual(
		gaps[0]?.type === "SKIP_RESULT" ? gaps[0].recovery_hint : undefined,
		{ action: "retry_on_connector_upgrade", retryable: false },
	);
});

test("recent contexts request their profile query hash and remain explicitly incomplete", async () => {
	const requestedOperations: string[] = [];
	const result = await collectWithInPageFetch(
		["recently_played_contexts"],
		(operationName) => {
			requestedOperations.push(operationName);
			return { data: { me: { profile: { username: "test-user" } } } };
		},
	);
	assert.deepEqual(requestedOperations, ["profileAttributes"]);
	assert.equal(
		result.messages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "spotify_recent_context_boundary_unverified",
		),
		true,
	);
});

test("ranked-list query hash is discovered and a short page continues to the reported total", async () => {
	const offsets: number[] = [];
	const result = await collectWithInPageFetch(["top_artists"], (operationName, variables) => {
		assert.equal(operationName, "userTopContent");
		const input = variables.topArtistsInput as { offset: number };
		offsets.push(input.offset);
		const offset = input.offset;
		return {
			data: {
				me: {
					profile: {
						topArtists: {
							items: offset === 0
								? [{ data: { uri: "spotify:artist:artist1", name: "Artist One", genres: [], stats: { followers: 1 }, popularity: 5 } }]
								: [
									{ data: { uri: "spotify:artist:artist2", name: "Artist Two", genres: [], stats: { followers: 2 }, popularity: 6 } },
									{ data: { uri: "spotify:artist:artist3", name: "Artist Three", genres: [], stats: { followers: 3 }, popularity: 7 } },
								],
							totalCount: 3,
						},
					},
				},
			},
		};
	});
	assert.deepEqual(offsets, [0, 1, 0, 1]);
	assert.equal(result.emittedRecords.filter((record) => record.stream === "top_artists").length, 6);
	assert.equal(result.messages.some((message) => message.type === "STATE" && message.stream === "top_artists"), false);
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
	playlistUris: ["spotify:playlist:pl1"],
	sourceCounts: {
		playlists: { considered: 1, covered: 1 },
		playlist_items: { considered: 1, covered: 1 },
	},
	completion: {
		playlists: {
			stream: "playlists",
			operation: "libraryV3",
			navigation: "https://open.spotify.com/",
			owner: "spotify:user:me",
			selector: "spotify:user:me:library",
			firstOffset: 0,
			lastOffset: 0,
			responseOffset: 0,
			pageCount: 1,
			rawCount: 1,
			expectedCount: 1,
			discardedCount: 0,
			remaining: false,
			terminal: "total_reached",
		},
		playlist_items: {
			stream: "playlist_items",
			operation: "fetchPlaylist",
			navigation: "https://open.spotify.com/",
			owner: "spotify:user:me",
			selector: "spotify:playlist:pl1",
			firstOffset: 0,
			lastOffset: 0,
			responseOffset: 0,
			pageCount: 1,
			rawCount: 1,
			expectedCount: 1,
			discardedCount: 0,
			remaining: false,
			terminal: "total_reached",
		},
	},
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
		["top_artists"],
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
			location: {
				href: "https://open.spotify.com/",
				hostname: "open.spotify.com",
			},
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
			if (url.startsWith("https://spclient.wg.spotify.com/recently-played/")) {
				return new Response(JSON.stringify({ playContexts: [] }), { status: 200 });
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
					const items =
						offset === 0
							? [
									playlist("pl1"),
									...Array.from({ length: 199 }, (_, index) => ({
										item: {
											data: {
												__typename: "Album",
												uri: `spotify:album:album-${offset}-${index}`,
											},
										},
									})),
								]
							: [playlist("pl2")];
					return new Response(
						JSON.stringify({
							data: { me: { libraryV3: { items, totalCount: 201, offset } } },
						}),
						{ status: 200 },
					);
				}
				if (body.operationName === "fetchPlaylist") {
					const id = String(body.variables.uri).split(":").pop();
					return new Response(
						JSON.stringify(
							completeSourceFields(body.operationName, {
							data: {
								playlistV2: {
									uri: `spotify:playlist:${id}`,
									name: `Playlist ${id}`,
									ownerV2: {
										data: { uri: "spotify:user:owner1", name: "Owner" },
									},
									content: {
										totalCount: 0,
										items: [],
										offset: Number(body.variables.offset),
									},
									followers: 1,
									images: { items: [] },
								},
							},
						})),
						{ status: 200 },
					);
				}
				if (body.operationName === "fetchLibraryTracks") {
					return new Response(
						JSON.stringify(
							completeSourceFields(body.operationName, {
							data: {
								me: {
									library: {
										tracks: {
											offset: Number(body.variables.offset),
											totalCount: 3,
											items: [
												{
													addedAt: { isoString: null },
													track: {
														uri: "spotify:track:missingDate",
														data: {
															name: "No Date",
															artists: { items: [] },
															albumOfTrack: { artists: { items: [] } },
														},
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
															contentRating: null,
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
						})),
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
				evaluate: (source: string) =>
					(0, eval)(source) as Promise<unknown>,
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
	assert.equal(saved.length, 3);
	assert.equal(saved[0]?.data.id, "missingDate");
	assert.equal(saved[0]?.data.added_at, null);
	assert.equal(saved[0]?.data.identity_unresolved, false);
	assert.equal(saved[1]?.data.id, "goodTrack");
	assert.equal(saved[1]?.data.added_at, "2024-02-01T00:00:00Z");
	assert.equal(saved[1]?.data.explicit, false);
	assert.equal(saved[2]?.data.id, "unknownExplicit");
	assert.equal(saved[2]?.data.explicit, null);
	assertUserFacingProgress(
		progressMessages.map((message) => ({ type: "PROGRESS", message })),
	);
	assert.equal(
		diagnostics.some((line) =>
			line.startsWith("[spotify-diagnostic] saved_track_missing_added_at "),
		),
		false,
	);
});

function installSpotifyBrowserGlobals(): () => void {
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalCaches = globalThis.caches;
	const originalPerformance = globalThis.performance;
	(globalThis as unknown as { window: unknown }).window = {
		location: {
			href: "https://open.spotify.com/",
			hostname: "open.spotify.com",
		},
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
	return () => {
		(globalThis as unknown as { window: unknown }).window = originalWindow;
		(globalThis as unknown as { document: unknown }).document =
			originalDocument;
		(globalThis as unknown as { caches: unknown }).caches = originalCaches;
		(globalThis as unknown as { performance: unknown }).performance =
			originalPerformance;
	};
}

function spotifyWebFixtureBundle(): string {
	return [
		["fetchLibraryTracks", "a".repeat(64)],
		["fetchPlaylist", "b".repeat(64)],
		["libraryV3", "c".repeat(64)],
		["profileAttributes", "d".repeat(64)],
		["userTopContent", "e".repeat(64)],
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
	onFailure?: (result: {
		emittedRecords: Array<{ stream: string; data: Record<string, unknown> }>;
		messages: EmittedMessage[];
	}) => void,
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
	const messages: EmittedMessage[] = [];
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
			if (url.startsWith("https://spclient.wg.spotify.com/recently-played/")) {
				return new Response(JSON.stringify({ playContexts: [] }), { status: 200 });
			}
			if (url === "https://api-partner.spotify.com/pathfinder/v2/query") {
				const body = JSON.parse(String(init?.body)) as {
					operationName: string;
					variables: Record<string, unknown>;
				};
				const raw = graphql(body.operationName, body.variables);
				const result =
					raw instanceof Response
						? raw
						: completeSourceFields(body.operationName, raw);
				return result instanceof Response
					? result
					: new Response(JSON.stringify(result), { status: 200 });
			}
			throw new Error(`unexpected fetch: ${url}`);
		};
		try {
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
					evaluate: (source: string) =>
						(0, eval)(source) as Promise<unknown>,
				} as never,
				progress: () => Promise.resolve(),
				requested: new Map<string, StreamScope>(
					requestedNames.map((name) => [name, { name }]),
				),
			});
		} catch (error) {
			onFailure?.({ emittedRecords, messages });
			throw error;
		}
		return { emittedRecords, messages };
	} finally {
		globalThis.fetch = originalFetch;
		restoreGlobals();
	}
}

async function assertRejectedWithoutCompletionAuthority(
	requestedNames: string[],
	graphql: Parameters<typeof collectWithInPageFetch>[1],
): Promise<void> {
	let failure:
		| {
				emittedRecords: Array<{
					stream: string;
					data: Record<string, unknown>;
				}>;
				messages: EmittedMessage[];
		  }
		| undefined;
	await assert.rejects(() =>
		collectWithInPageFetch(requestedNames, graphql, (result) => {
			failure = result;
		}),
	);
	assert.ok(failure);
	assert.deepEqual(failure.emittedRecords, []);
	assert.equal(
		failure.messages.some(
			(message) =>
				message.type === "STATE" || message.type === "DETAIL_COVERAGE",
		),
		false,
	);
}

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
					me: {
						library: { tracks: { items: [], totalCount: 0, offset: 0 } },
					},
				},
			};
		});
		assert.equal(rateLimitAttempts, 2);
		assert.deepEqual(retryDelays, [2000]);

		let serverErrorAttempts = 0;
		await assert.rejects(() =>
			collectWithInPageFetch(["saved_tracks"], () => {
				serverErrorAttempts += 1;
				return new Response(null, { status: 503 });
			}),
		);
		assert.equal(serverErrorAttempts, 3);
		assert.deepEqual(retryDelays, [2000, 1000, 2000]);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("spotify browser parser rejects repeated full library pages", async () => {
	const items = Array.from({ length: 200 }, (_, i) => ({
		item: { data: { __typename: "Playlist", uri: `spotify:playlist:pl${i}` } },
	}));
	await assertRejectedWithoutCompletionAuthority(
		["playlists"],
		(operationName, variables) => {
			assert.equal(operationName, "libraryV3");
			return {
				data: {
					me: {
						libraryV3: {
							items,
							totalCount: 500,
							offset: variables.offset,
						},
					},
				},
			};
		},
	);
});

test("spotify browser parser preserves identical playlist pages at distinct offsets", async () => {
	const playlistItem = {
		addedAt: { isoString: "2024-01-01T00:00:00Z" },
		itemV2: {
			data: {
				__typename: "Track",
				uri: "spotify:track:t",
				name: "Track",
				artists: { items: [] },
			},
		},
	};
	const items = Array.from({ length: 100 }, () => playlistItem);
	const { emittedRecords, messages } = await collectWithInPageFetch(
		["playlist_items"],
		(operationName, variables) => {
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
								offset: 0,
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
						content: { items, totalCount: 500, offset: variables.offset },
					},
				},
			};
		},
	);
	const playlistItems = emittedRecords.filter(
		(record) => record.stream === "playlist_items",
	);
	assert.equal(playlistItems.length, 500);
	assert.equal(playlistItems[0]?.data.id, "pl1:0");
	assert.equal(playlistItems.at(-1)?.data.id, "pl1:499");
	assert.ok(
		messages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === "playlist_items" &&
				message.considered === 500 &&
				message.covered === 500,
		),
	);
});

test("equal-duration local playlist tracks keep distinct URIs and no catalog track id", async () => {
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
								offset: 0,
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
							totalCount: 2,
							offset: 0,
							items: [
								{
									itemV2: {
										data: {
											__typename: "Track",
											uri: "spotify:local:Artist:Album:Local%20Track:180000",
											name: "Track",
											artists: { items: [] },
										},
									},
								},
								{
									itemV2: {
										data: {
											__typename: "Track",
											uri: "spotify:local:Artist:Album:Other%20Track:180000",
											name: "Other Track",
											artists: { items: [] },
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
	const tracks = emittedRecords.filter(
		(record) => record.stream === "playlist_items",
	);
	assert.deepEqual(
		tracks.map((track) => track.data.uri),
		[
			"spotify:local:Artist:Album:Local%20Track:180000",
			"spotify:local:Artist:Album:Other%20Track:180000",
		],
	);
	assert.deepEqual(
		tracks.map((track) => track.data.track_id),
		[null, null],
	);
	assert.ok(
		tracks.every((track) => playlistItemsSchema.safeParse(track.data).success),
	);
});

test("spotify browser parser rejects repeated full saved-track pages", async () => {
	const items = Array.from({ length: 100 }, (_, i) => ({
		track: {
			uri: `spotify:track:t${i}`,
			data: {
				name: `Track ${i}`,
				artists: { items: [] },
				albumOfTrack: { artists: { items: [] } },
			},
		},
	}));
	await assertRejectedWithoutCompletionAuthority(
		["saved_tracks"],
		(operationName, variables) => {
			assert.equal(operationName, "fetchLibraryTracks");
			return {
				data: {
					me: {
						library: {
							tracks: {
								items,
								totalCount: 500,
								offset: variables.offset,
							},
						},
					},
				},
			};
		},
	);
});

test("top rows: a field the operation never carries is null, a malformed one withholds the row", () => {
	const page = (items: unknown[]) => ({
		data: { me: { profile: { topTracks: { items, totalCount: items.length } } } },
	});
	const track = (id: string, extra: Record<string, unknown>) => ({
		data: {
			uri: `spotify:track:${id}`,
			name: `Track ${id}`,
			artists: { items: [{ profile: { name: "Artist" } }] },
			albumOfTrack: { name: "Album" },
			...extra,
		},
	});
	const result = parseTopRows(
		[
			page([
				track("absent", {}),
				track("malformed", { trackDuration: [] }),
				track("present", { trackDuration: { totalMilliseconds: 5 } }),
			]),
		],
		"top_tracks",
		"short_term",
	);
	assert.deepEqual(
		result.rows.map((row) => [row.id, row.duration_ms]),
		[
			["absent", null],
			["present", 5],
		],
	);
	assert.equal(result.withheld, 1);
	const artists = parseTopRows(
		[
			{
				data: {
					me: {
						profile: {
							topArtists: {
								totalCount: 1,
								items: [{ data: { uri: "spotify:artist:a1", profile: { name: "A" } } }],
							},
						},
					},
				},
			},
		],
		"top_artists",
		"short_term",
	);
	assert.equal(artists.rows.length, 1, "an absent genres key still emits the row");
	assert.equal(artists.withheld, 0);
	assert.equal(Object.hasOwn(artists.rows[0] ?? {}, "genres"), false, "genres is omitted, not invented");
	const withGenres = (genres: unknown) =>
		parseTopRows(
			[
				{
					data: {
						me: {
							profile: {
								topArtists: {
									totalCount: 1,
									items: [{ data: { uri: "spotify:artist:a1", profile: { name: "A" }, genres } }],
								},
							},
						},
					},
				},
			],
			"top_artists",
			"short_term",
		);
	assert.deepEqual(withGenres([]).rows[0]?.genres, []);
	assert.equal(withGenres([1]).rows.length, 0, "a malformed genres is a gap");
	assert.equal(withGenres([1]).withheld, 1);
	assert.equal(withGenres("pop").withheld, 1);
});

for (const local of [false, true]) {
	test(`saved-track source identity: ${local ? "local row withheld" : "catalog terminal control"}`, async () => {
		const uris = local
			? ["spotify:local:Artist:Album:Song:180", "spotify:track:catalog"]
			: ["spotify:track:catalog"];
		const result = await collectWithInPageFetch(
			["saved_tracks"],
			(operation, variables) => {
				assert.equal(operation, "fetchLibraryTracks");
				return {
					data: {
						me: {
							library: {
								tracks: {
									items: uris.map((uri) => ({
										addedAt: { isoString: "2024-01-01T00:00:00Z" },
										track: {
											uri,
											data: {
												name: "Track",
												artists: { items: [] },
												albumOfTrack: { name: "Album", artists: { items: [] } },
												duration: { totalMilliseconds: 180000 },
												contentRating: { label: "NONE" },
											},
										},
									})),
									totalCount: uris.length,
									offset: variables.offset,
								},
							},
						},
					},
				};
			},
		);
		const rows = result.emittedRecords.filter(
			(row) => row.stream === "saved_tracks",
		);
		assert.deepEqual(
			rows.map((row) => row.data.id),
			["catalog"],
		);
		assert.equal(rows[0]?.data.identity_unresolved, false);
		assert.equal(
			result.messages.some(
				(message) =>
					message.type === "STATE" && message.stream === "saved_tracks",
			),
			!local,
		);
		if (local) {
			const gap = result.messages.find(
				(message) =>
					message.type === "DETAIL_COVERAGE" &&
					message.stream === "saved_tracks",
			);
			assert.ok(gap && gap.type === "DETAIL_COVERAGE");
			assert.equal(gap.considered, 2);
			assert.equal(gap.covered, 1);
		}
	});
}

for (const missing of [true, false]) {
	test(`saved-track source identity: ${missing ? "missing" : "conflicting"} catalog identity is withheld`, async () => {
		const item = (uri: string | null, id: string | null) => ({
			addedAt: { isoString: "2024-01-01T00:00:00Z" },
			track: {
				uri,
				data: {
					id,
					name: "Track",
					artists: { items: [] },
					albumOfTrack: { name: "Album", artists: { items: [] } },
					duration: { totalMilliseconds: 180000 },
					contentRating: { label: "NONE" },
				},
			},
		});
		const result = await collectWithInPageFetch(
			["saved_tracks"],
			(_operation, variables) =>
				new Response(
					JSON.stringify({
						data: {
							me: {
								library: {
									tracks: {
										items: [
											item(
												missing ? null : "spotify:track:bad",
												missing ? null : "different",
											),
											item("spotify:track:catalog", "catalog"),
										],
										totalCount: 2,
										offset: variables.offset,
									},
								},
							},
						},
					}),
					{ status: 200 },
				),
		);
		assert.deepEqual(
			result.emittedRecords.map((row) => row.data.id),
			["catalog"],
		);
		assert.equal(
			result.messages.some((message) => message.type === "STATE"),
			false,
		);
		const coverage = result.messages.find(
			(message) => message.type === "DETAIL_COVERAGE",
		);
		assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
		assert.equal(coverage.considered, 2);
		assert.equal(coverage.covered, 1);
	});
}

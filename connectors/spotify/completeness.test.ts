// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { hasSpotifyEndProof } from "./completion-evidence.ts";
import { spotifyCollect } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const HASHES = {
	fetchLibraryTracks: "a".repeat(64),
	fetchPlaylist: "b".repeat(64),
	libraryV3: "c".repeat(64),
	profileAttributes: "d".repeat(64),
};

function bundleFor(operations = Object.keys(HASHES)): string {
	return operations
		.map(
			(name) =>
				`new a.b("${name}","query","${HASHES[name as keyof typeof HASHES]}")`,
		)
		.join(";");
}

function savedTrack(
	id: string,
	options: { addedAt?: string | null; uri?: string } = {},
) {
	return {
		...("addedAt" in options
			? options.addedAt === null
				? {}
				: { addedAt: { isoString: options.addedAt } }
			: { addedAt: { isoString: "2024-01-01T00:00:00Z" } }),
		track: {
			...(options.uri === undefined
				? { uri: `spotify:track:${id}` }
				: { uri: options.uri }),
			data: {
				id,
				name: `Track ${id}`,
				artists: { items: [] },
				albumOfTrack: { artists: { items: [] } },
			},
		},
	};
}

async function collectSavedTracks(
	graphql: (
		offset: number,
		requestIndex: number,
		operationName?: string,
		variables?: Record<string, unknown>,
	) => unknown,
	options: {
		bundle?: (requestIndex: number) => string;
		cachedBundles?: Array<{ url: string; size: number; body: string }>;
		pathname?: string;
		requested?: string[];
	} = {},
) {
	const originalFetch = globalThis.fetch;
	const originalWindow = globalThis.window;
	const originalDocument = globalThis.document;
	const originalCaches = globalThis.caches;
	const originalPerformance = globalThis.performance;
	const requests: number[] = [];
	const operations: Array<{
		name: string;
		variables: Record<string, unknown>;
	}> = [];
	const emittedRecords: Array<{
		stream: string;
		data: Record<string, unknown>;
	}> = [];
	const messages: EmittedMessage[] = [];
	let bundleRequests = 0;
	(globalThis as unknown as { window: unknown }).window = {
		location: {
			href: `https://open.spotify.com${options.pathname ?? "/"}`,
			hostname: "open.spotify.com",
		},
	};
	(globalThis as unknown as { document: unknown }).document = {
		querySelectorAll: () => [{ src: "https://open.spotifycdn.com/bundle.js" }],
	};
	(globalThis as unknown as { caches: unknown }).caches = {
		keys: () =>
			Promise.resolve(
				options.cachedBundles?.length ? ["workbox-precache-v2"] : [],
			),
		open: async () => ({
			keys: async () =>
				(options.cachedBundles ?? []).map((entry) => ({ url: entry.url })),
			match: async (request: { url: string }) => {
				const entry = options.cachedBundles?.find(
					(candidate) => candidate.url === request.url,
				);
				return entry
					? new Response(entry.body, {
							status: 200,
							headers: { "content-length": String(entry.size) },
						})
					: null;
			},
		}),
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
					accessToken: "synthetic-token",
					clientId: "synthetic-client",
					isAnonymous: false,
				}),
				{ status: 200 },
			);
		}
		if (url === "https://clienttoken.spotify.com/v1/clienttoken") {
			return new Response(
				JSON.stringify({ granted_token: { token: "synthetic-client-token" } }),
				{ status: 200 },
			);
		}
		if (url === "https://open.spotifycdn.com/bundle.js") {
			bundleRequests += 1;
			return new Response(options.bundle?.(bundleRequests) ?? bundleFor(), {
				status: 200,
			});
		}
		if (url === "https://api-partner.spotify.com/pathfinder/v2/query") {
			const body = JSON.parse(String(init?.body)) as {
				operationName: string;
				variables: { offset: number };
			};
			if (body.operationName === "fetchLibraryTracks")
				requests.push(body.variables.offset);
			operations.push({ name: body.operationName, variables: body.variables });
			return new Response(
				JSON.stringify(
					graphql(
						body.variables.offset,
						operations.length,
						body.operationName,
						body.variables,
					),
				),
				{ status: 200 },
			);
		}
		throw new Error(`unexpected synthetic request: ${url}`);
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
				evaluate: (fn: (arg: string[]) => Promise<unknown>, arg: string[]) =>
					fn(arg),
			} as never,
			progress: () => Promise.resolve(),
			requested: new Map<string, StreamScope>(
				(options.requested ?? ["saved_tracks"]).map((name) => [name, { name }]),
			),
		});
		return { bundleRequests, emittedRecords, messages, operations, requests };
	} finally {
		globalThis.fetch = originalFetch;
		(globalThis as unknown as { window: unknown }).window = originalWindow;
		(globalThis as unknown as { document: unknown }).document =
			originalDocument;
		(globalThis as unknown as { caches: unknown }).caches = originalCaches;
		(globalThis as unknown as { performance: unknown }).performance =
			originalPerformance;
	}
}

function savedResponse(items: unknown[], totalCount?: number): unknown {
	return {
		data: {
			me: {
				library: {
					tracks: {
						items,
						...(totalCount === undefined ? {} : { totalCount }),
					},
				},
			},
		},
	};
}

test("requested saved-track hash discovery retries until that operation is ready", async () => {
	const originalSetTimeout = globalThis.setTimeout;
	const delays: number[] = [];
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay = 0,
	) => {
		delays.push(Number(delay));
		callback();
		return 0 as unknown as NodeJS.Timeout;
	}) as typeof globalThis.setTimeout;
	try {
		const result = await collectSavedTracks(() => savedResponse([], 0), {
			bundle: (attempt) =>
				attempt < 3 ? "" : bundleFor(["fetchLibraryTracks"]),
		});
		assert.equal(result.bundleRequests, 3);
		assert.deepEqual(delays, [3000, 3000]);
		assert.deepEqual(result.requests, [0]);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
});

test("hash discovery scans every bounded precache entry when the requested operation is late", async () => {
	const cachedBundles = Array.from({ length: 21 }, (_, index) => ({
		url: `https://open.spotifycdn.com/part-${index}.js`,
		size: index === 20 ? 1 : 500 + index,
		body:
			index === 20
				? bundleFor(["fetchLibraryTracks"])
				: `unrelated bundle ${index}`,
	}));
	const result = await collectSavedTracks(() => savedResponse([], 0), {
		cachedBundles,
	});
	assert.equal(result.bundleRequests, 0);
	assert.deepEqual(result.requests, [0]);
});

test("playlist library pagination continues after a short page while totalCount remains", async () => {
	const libraryOffsets: unknown[] = [];
	const result = await collectSavedTracks(
		(offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				libraryOffsets.push(offset);
				const id = offset === 0 ? "first" : "second";
				return {
					data: {
						me: {
							libraryV3: {
								totalCount: 2,
								items: [
									{
										item: {
											data: {
												__typename: "Playlist",
												uri: `spotify:playlist:${id}`,
											},
										},
									},
								],
							},
						},
					},
				};
			}
			assert.equal(operationName, "fetchPlaylist");
			const uri = String(variables?.uri);
			return {
				data: {
					playlistV2: {
						uri,
						name: "Synthetic playlist",
						ownerV2: { data: { uri: "spotify:user:owner", name: "Owner" } },
						content: { totalCount: 0, items: [] },
						images: { items: [] },
					},
				},
			};
		},
		{ requested: ["playlists"] },
	);
	assert.deepEqual(libraryOffsets, [0, 1]);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "playlists")
			.length,
		2,
	);
});

test("missing playlist library or playlist detail objects cannot prove an empty list", async () => {
	await assert.rejects(
		() =>
			collectSavedTracks(
				(_offset, _index, operationName) =>
					operationName === "libraryV3" ? { data: { me: {} } } : {},
				{ requested: ["playlists"] },
			),
		/spotify_library_response_invalid/,
	);
	await assert.rejects(
		() =>
			collectSavedTracks(
				(_offset, _index, operationName) => {
					if (operationName !== "libraryV3") return { data: {} };
					return {
						data: {
							me: {
								libraryV3: {
									totalCount: 1,
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
								},
							},
						},
					};
				},
				{ requested: ["playlists"] },
			),
		/spotify_playlist_response_invalid/,
	);
});

test("playlist item traversal continues after a short page while its total remains", async () => {
	const offsets: unknown[] = [];
	const result = await collectSavedTracks(
		(offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								totalCount: 1,
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
							},
						},
					},
				};
			}
			assert.equal(operationName, "fetchPlaylist");
			offsets.push(offset);
			const item = (id: string) => ({
				itemV2: {
					data: {
						__typename: "Track",
						uri: `spotify:track:${id}`,
						name: `Track ${id}`,
						artists: { items: [] },
					},
				},
			});
			return {
				data: {
					playlistV2: {
						uri: String(variables?.uri),
						name: "Playlist",
						ownerV2: { data: { uri: "spotify:user:owner", name: "Owner" } },
						content: {
							totalCount: 2,
							items: [item(offset === 0 ? "one" : "two")],
						},
					},
				},
			};
		},
		{ requested: ["playlist_items"] },
	);
	assert.deepEqual(offsets, [0, 1]);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "playlist_items")
			.length,
		2,
	);
});

test("playlist item completion combines terminal evidence across every playlist", async () => {
	const result = await collectSavedTracks(
		(_offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								totalCount: 2,
								items: ["first", "empty"].map((id) => ({
									item: {
									data: {
										__typename: "Playlist",
										uri: `spotify:playlist:${id}`,
									},
									},
								})),
							},
						},
					},
				};
			}
			assert.equal(operationName, "fetchPlaylist");
			const uri = String(variables?.uri);
			const items = uri.endsWith(":first")
				? [
						{
							itemV2: {
								data: {
									__typename: "Track",
									uri: "spotify:track:one",
									name: "Track one",
									artists: { items: [] },
								},
							},
						},
					]
				: [];
			return {
				data: {
					playlistV2: {
						uri,
						name: "Synthetic playlist",
						content:
							items.length === 0
								? { items }
								: { totalCount: items.length, items },
					},
				},
			};
		},
		{ requested: ["playlist_items"] },
	);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "playlist_items")
			.length,
		1,
	);
});

test("saved-track traversal accepts unknown totals and follows short pages until its declared end", async () => {
	const firstPage = Array.from({ length: 100 }, (_, index) =>
		savedTrack(`row${index}`),
	);
	const result = await collectSavedTracks((offset) =>
		offset === 0
			? savedResponse(firstPage)
			: savedResponse([savedTrack("tail")]),
	);
	assert.deepEqual(result.requests, [0, 100]);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "saved_tracks")
			.length,
		101,
	);
});

test("saved-track traversal continues after a nonempty short page while totalCount remains", async () => {
	const result = await collectSavedTracks((offset) =>
		offset === 0
			? savedResponse([savedTrack("one"), savedTrack("two")], 3)
			: savedResponse([savedTrack("three")], 3),
	);
	assert.deepEqual(result.requests, [0, 2]);
	assert.equal(result.emittedRecords.length, 3);
});

test("saved tracks preserve rows with empty or absent source metadata without inventing values", async () => {
	const result = await collectSavedTracks(() =>
		savedResponse(
			[
				savedTrack("source-id-without-uri", { uri: "" }),
				savedTrack("source-id-without-date", { addedAt: null }),
			],
			2,
		),
	);
	const records = result.emittedRecords.map((record) => record.data);
	assert.equal(records.length, 2);
	assert.equal(records[0]?.id, "source-id-without-uri");
	assert.equal(records[0]?.uri, "");
	assert.equal(records[1]?.added_at, null);
	assert.equal(records[1]?.id, "source-id-without-date");
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
		2,
	);
});

test("malformed saved-track response cannot become empty success or advance a checkpoint", async () => {
	await assert.rejects(
		() =>
			collectSavedTracks(() => ({
				data: { me: { library: { tracks: null } } },
			})),
		/spotify_saved_tracks_response_invalid/,
	);
});

test("saved-track row identity uses one source ID resolver and shape failures veto coverage", async () => {
	const invalid = savedTrack("bad-shape");
	invalid.track.data.name = "x".repeat(1001);
	await assert.rejects(
		() =>
			collectSavedTracks(() =>
				savedResponse(
					[savedTrack("uri-id", { uri: "spotify:track:uri-id" }), invalid],
					2,
				),
			),
		/spotify_saved_tracks_record_invalid/,
	);
});

test("saved track with no available identity is retained but cannot advance full-scan state", async () => {
	const result = await collectSavedTracks(() =>
		savedResponse(
			[
				{
					track: {
						data: {
							name: "Unresolved identity",
							artists: { items: [] },
							albumOfTrack: { artists: { items: [] } },
						},
					},
				},
			],
			1,
		),
	);
	assert.equal(result.emittedRecords[0]?.data.id, null);
	assert.equal(result.emittedRecords[0]?.data.identity_unresolved, true);
	assert.ok(
		!result.messages.some(
			(message) =>
				message.type === "STATE" && message.stream === "saved_tracks",
		),
	);
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
		1,
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		0,
	);
});

test("Spotify schemas accept legacy owner identifiers and source URI variants", () => {
	assert.equal(
		validateRecord("playlists", {
			id: "playlist1",
			name: "Playlist",
			owner_id: "legacy.owner@example.com",
			owner_name: "Owner",
			public: null,
			collaborative: null,
			track_count: 0,
			snapshot_id: null,
			description: null,
			uri: "spotify:playlist:playlist1",
			followers: null,
			images: [],
		}).ok,
		true,
	);
	assert.equal(
		validateRecord("saved_tracks", {
			id: null,
			identity_unresolved: true,
			name: "Legacy row",
			artist_names: [],
			album_name: null,
			duration_ms: null,
			popularity: null,
			added_at: null,
			isrc: null,
			uri: "",
			explicit: null,
			album_artist_names: [],
		}).ok,
		true,
	);
});

test("profile collection preserves an explicitly empty source image URL", async () => {
	const result = await collectSavedTracks(
		(_offset, _index, operationName) => {
			assert.equal(operationName, "profileAttributes");
			return {
				data: {
					me: {
						profile: {
							username: "synthetic-user",
							name: "Synthetic user",
							uri: "spotify:user:synthetic-user",
							imageUrl: "",
						},
					},
				},
			};
		},
		{ requested: ["profile"] },
	);
	assert.deepEqual(result.emittedRecords[0]?.data.images, [
		{ url: "", width: null, height: null },
	]);
});

test("a request made from a non-player navigation cannot prove an empty saved-track list", async () => {
	await assert.rejects(
		() =>
			collectSavedTracks(() => savedResponse([], 0), { pathname: "/login" }),
		/spotify_page_not_player/,
	);
});

test("Spotify end proof requires the exact player navigation, owner, request, and terminal counts", () => {
	const evidence = {
		stream: "saved_tracks",
		operation: "fetchLibraryTracks",
		navigation: "https://open.spotify.com/",
		owner: "spotify:user:me:collection",
		selector: "spotify:user:me:collection",
		firstOffset: 0,
		lastOffset: 100,
		pageCount: 2,
		rawCount: 101,
		expectedCount: 101,
		discardedCount: 0,
		remaining: false,
		terminal: "total_reached",
	} as const;
	const expected = {
		stream: "saved_tracks",
		operation: "fetchLibraryTracks",
		owner: "spotify:user:me:collection",
		selector: "spotify:user:me:collection",
	};
	assert.equal(hasSpotifyEndProof(evidence, expected), true);
	assert.equal(
		hasSpotifyEndProof(
			{ ...evidence, navigation: "https://open.spotify.com/login" },
			expected,
		),
		false,
	);
	assert.equal(
		hasSpotifyEndProof({ ...evidence, owner: "spotify:user:other" }, expected),
		false,
	);
	assert.equal(
		hasSpotifyEndProof(
			{ ...evidence, selector: "spotify:user:other:collection" },
			expected,
		),
		false,
	);
	assert.equal(
		hasSpotifyEndProof({ ...evidence, remaining: true }, expected),
		false,
	);
	assert.equal(
		hasSpotifyEndProof({ ...evidence, rawCount: 100 }, expected),
		false,
	);
	assert.equal(
		hasSpotifyEndProof({ ...evidence, discardedCount: 1 }, expected),
		false,
	);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type {
	EmittedMessage,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { setConnectorDiagnosticSink } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { completeSourceFields } from "./__fixtures__/complete-source-fields.ts";
import { hasSpotifyEndProof } from "./completion-evidence.ts";
import { spotifyCollect } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const HASHES = {
	fetchLibraryTracks: "a".repeat(64),
	fetchPlaylist: "b".repeat(64),
	libraryV3: "c".repeat(64),
	profileAttributes: "d".repeat(64),
};

type FailedCollectionCapture = {
	emittedRecords: Array<{ stream: string; data: Record<string, unknown> }>;
	messages: EmittedMessage[];
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
): {
	addedAt: { isoString: unknown };
	track: { uri?: unknown; data: Record<string, unknown> };
} {
	return {
		addedAt: {
			isoString:
				"addedAt" in options ? options.addedAt : "2024-01-01T00:00:00Z",
		},
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
		/** Body served at /service-worker.js; absent means a 404. */
		serviceWorker?: string;
		/** Bodies for precached chunk URLs the service worker lists. */
		chunks?: Record<string, string>;
		pathname?: string;
		requested?: string[];
		profileEnrichment?: unknown;
		profileEnrichmentStatus?: number;
		onFailure?: (result: FailedCollectionCapture) => void;
		/** Set false to send fixtures exactly as written, with no absent field filled. */
		completeFixtures?: boolean;
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
	const chunkRequests: string[] = [];
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
		if (url === "/service-worker.js") {
			return options.serviceWorker === undefined
				? new Response("", { status: 404 })
				: new Response(options.serviceWorker, { status: 200 });
		}
		if (options.chunks && Object.hasOwn(options.chunks, url)) {
			chunkRequests.push(url);
			return new Response(options.chunks[url], { status: 200 });
		}
		if (url.startsWith("https://spclient.wg.spotify.com/user-profile-view/")) {
			return new Response(JSON.stringify(options.profileEnrichment ?? {}), {
				status: options.profileEnrichmentStatus ?? 200,
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
			const authored = graphql(
				body.variables.offset,
				operations.length,
				body.operationName,
				body.variables,
			);
			const response =
				options.completeFixtures === false
					? authored
					: completeSourceFields(body.operationName, authored);
			return new Response(JSON.stringify(response), { status: 200 });
		}
		throw new Error(`unexpected synthetic request: ${url}`);
	};
	try {
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
					(options.requested ?? ["saved_tracks"]).map((name) => [
						name,
						{ name },
					]),
				),
			});
		} catch (error) {
			options.onFailure?.({ emittedRecords, messages });
			throw error;
		}
		return {
			bundleRequests,
			chunkRequests,
			emittedRecords,
			messages,
			operations,
			requests,
		};
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

async function assertRejectedWithoutAuthority(
	graphql: Parameters<typeof collectSavedTracks>[0],
	options: Parameters<typeof collectSavedTracks>[1] = {},
): Promise<void> {
	const capture: { failure?: FailedCollectionCapture } = {};
	await assert.rejects(() =>
		collectSavedTracks(graphql, {
			...options,
			onFailure: (result) => {
				capture.failure = result;
			},
		}),
	);
	const { failure } = capture;
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

function savedResponse(
	items: unknown[],
	totalCount?: number,
	offset = 0,
): unknown {
	return {
		data: {
			me: {
				library: {
					tracks: {
						items,
						offset,
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

test("hash discovery reads lazy chunks from the service worker manifest when there is no precache", async () => {
	// A WebView without service workers (iOS WKWebView) has no workbox cache,
	// and the home page never loads the route chunk that defines the operation.
	const cdn = "https://open.spotifycdn.com/cdn/build/web-player";
	const serviceWorker = `self.__WB_DISABLE_DEV_LOGS=!0,e=[${[
		"1186.d1c1615d.js",
		"xpui-routes-artist.2459ba1a.js",
		"xpui-routes-collection-songs.933cac3b.js",
		"xpui-routes-profile.72480c98.css",
	]
		.map((file) => `{'revision':null,'url':'${cdn}/${file}'}`)
		.join(",")}]||[]`;
	const result = await collectSavedTracks(() => savedResponse([], 0), {
		bundle: () => bundleFor(["profileAttributes"]),
		serviceWorker,
		chunks: {
			[`${cdn}/1186.d1c1615d.js`]: "unrelated",
			[`${cdn}/xpui-routes-artist.2459ba1a.js`]: "unrelated",
			[`${cdn}/xpui-routes-collection-songs.933cac3b.js`]: bundleFor([
				"fetchLibraryTracks",
			]),
		},
	});
	assert.equal(result.bundleRequests, 1);
	assert.deepEqual(result.chunkRequests, [
		`${cdn}/xpui-routes-collection-songs.933cac3b.js`,
	]);
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
								offset,
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
						content: { totalCount: 0, items: [], offset: variables?.offset },
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

test("library pagination accepts Spotify pagingInfo offsets bound to each request", async () => {
	const result = await collectSavedTracks(
		(offset, _index, operationName) => {
			assert.equal(operationName, "libraryV3");
			return {
				data: {
					me: {
						libraryV3: {
							pagingInfo: { offset },
							totalCount: 0,
							items: [],
						},
					},
				},
			};
		},
		{ requested: ["playlists"] },
	);
	assert.equal(result.operations[0]?.variables.offset, 0);
	assert.ok(
		result.messages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === "playlists",
		),
	);
});

test("a verified empty playlist inventory gives exact zero coverage for both streams", async () => {
	const result = await collectSavedTracks(
		(_offset, _index, operationName) => {
			assert.equal(operationName, "libraryV3");
			return {
				data: {
					me: { libraryV3: { pagingInfo: { offset: 0 }, totalCount: 0, items: [] } },
				},
			};
		},
		{ requested: ["playlists", "playlist_items"] },
	);
	assert.deepEqual(result.emittedRecords, []);
	for (const stream of ["playlists", "playlist_items"]) {
		const coverage = result.messages.find(
			(message) => message.type === "DETAIL_COVERAGE" && message.stream === stream,
		);
		assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null, 0);
		assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null, 0);
	}
});

test("missing playlist library or playlist detail objects cannot prove an empty list", async () => {
	await assertRejectedWithoutAuthority(
		(_offset, _index, operationName) =>
			operationName === "libraryV3" ? { data: { me: {} } } : {},
		{ requested: ["playlists"] },
	);
	await assertRejectedWithoutAuthority(
		(_offset, _index, operationName) => {
			if (operationName !== "libraryV3") return { data: {} };
			return {
				data: {
					me: {
						libraryV3: {
							offset: 0,
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
	);
});

test("repeated identities in excluded library rows cannot prove an empty playlist inventory", async () => {
	await assertRejectedWithoutAuthority(
		(offset, _index, operationName) => {
			assert.equal(operationName, "libraryV3");
			const album = {
				item: {
					data: {
						__typename: "Album",
						uri: "spotify:album:album-1",
						name: offset === 0 ? "Album" : "Album updated",
					},
				},
			};
			return {
				data: {
					me: {
						libraryV3: { offset, totalCount: 2, items: [album] },
					},
				},
			};
		},
		{ requested: ["playlists"] },
	);
	await assertRejectedWithoutAuthority(
		() => ({
			data: {
				me: {
					libraryV3: {
						offset: 0,
						totalCount: 2,
						items: ["first", "second"].map(() => ({
							item: {
								data: {
									__typename: "Album",
									uri: "spotify:album:album-1",
								},
							},
						})),
					},
				},
			},
		}),
		{ requested: ["playlists"] },
	);
});

test("playlist rows cannot alias a different Spotify resource URI with the same ID", async () => {
	await assertRejectedWithoutAuthority(
		() => ({
			data: {
				me: {
					libraryV3: {
						offset: 0,
						totalCount: 1,
						items: [
							{
								item: {
									data: {
										__typename: "Playlist",
										uri: "spotify:album:pl1",
									},
								},
							},
						],
					},
				},
			},
		}),
		{ requested: ["playlists"] },
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
								offset,
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
							offset,
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

test("playlists-only collection requires terminal evidence for each child count", async () => {
	await assertRejectedWithoutAuthority(
		(_offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								offset: 0,
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
			return {
				data: {
					playlistV2: {
						uri: String(variables?.uri),
						name: "Playlist",
						ownerV2: { data: { uri: "spotify:user:owner", name: "Owner" } },
						content: { offset: 0, items: [] },
						images: { items: [] },
					},
				},
			};
		},
		{ requested: ["playlists"] },
	);
});

test("playlist pagination preserves identical track occurrences at distinct offsets", async () => {
	const offsets: unknown[] = [];
	const result = await collectSavedTracks(
		(offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								offset: 0,
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
			return {
				data: {
					playlistV2: {
						uri: String(variables?.uri),
						name: "Playlist",
						content: {
							offset,
							totalCount: 2,
							items: [
								{
									itemV2: {
										data: {
											__typename: "Track",
											uri: "spotify:track:repeat",
											name: "Repeat",
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
		{ requested: ["playlist_items"] },
	);
	assert.deepEqual(offsets, [0, 1]);
	assert.deepEqual(
		result.emittedRecords
			.filter((record) => record.stream === "playlist_items")
			.map((record) => record.data.id),
		["pl1:0", "pl1:1"],
	);
});

test("same-count playlist reorder retries from offset zero and emits one coherent revision", async () => {
	const offsets: number[] = [];
	const item = (id: string) => ({
		itemV2: {
			data: {
				__typename: "Track",
				uri: `spotify:track:${id}`,
				name: id,
				artists: { items: [] },
			},
		},
	});
	let attempt = 0;
	const result = await collectSavedTracks(
		(offset, _index, operation) => {
			if (operation === "libraryV3") return playlistLibraryResponse();
			assert.equal(operation, "fetchPlaylist");
			offsets.push(offset);
			if (offset === 0) attempt += 1;
			const revision = attempt === 1 && offset === 0 ? "A" : "B";
			const ids =
				offset === 0
					? Array.from(
							{ length: 100 },
							(_, i) => `t${i + (revision === "B" ? 1 : 0)}`,
						)
					: ["t0"];
			return playlistDetailResponse(
				"spotify:playlist:pl1",
				offset,
				ids.map(item),
				{
					revisionId: revision,
					content: { offset, totalCount: 101, items: ids.map(item) },
				},
			);
		},
		{ requested: ["playlists", "playlist_items"] },
	);
	assert.deepEqual(offsets, [0, 100, 0, 100]);
	const tracks = result.emittedRecords.filter(
		(record) => record.stream === "playlist_items",
	);
	assert.equal(tracks.length, 101);
	assert.equal(tracks[0]?.data.uri, "spotify:track:t1");
	assert.equal(tracks[99]?.data.uri, "spotify:track:t100");
	assert.equal(tracks[100]?.data.uri, "spotify:track:t0");
	assert.equal(
		result.emittedRecords.find((record) => record.stream === "playlists")?.data
			.snapshot_id,
		"B",
	);
});

test("changing playlist revision after bounded retries withholds completion and state", async () => {
	const offsets: number[] = [];
	const result = await collectSavedTracks(
		(offset, _index, operation) => {
			if (operation === "libraryV3") return playlistLibraryResponse();
			assert.equal(operation, "fetchPlaylist");
			offsets.push(offset);
			const ids =
				offset === 0 ? Array.from({ length: 100 }, (_, i) => `t${i}`) : ["t99"];
			return playlistDetailResponse(
				"spotify:playlist:pl1",
				offset,
				ids.map((id) => ({
					itemV2: {
						data: {
							__typename: "Track",
							uri: `spotify:track:${id}`,
							name: id,
							artists: { items: [] },
						},
					},
				})),
				{
					revisionId: offset === 0 ? "A" : "B",
					content: {
						offset,
						totalCount: 101,
						items: ids.map((id) => ({
							itemV2: {
								data: {
									__typename: "Track",
									uri: `spotify:track:${id}`,
									name: id,
									artists: { items: [] },
								},
							},
						})),
					},
				},
			);
		},
		{ requested: ["playlists", "playlist_items"] },
	);
	assert.deepEqual(offsets, [0, 100, 0, 100, 0, 100]);
	assert.deepEqual(result.emittedRecords, []);
	assert.equal(
		result.messages.some(
			(message) =>
				message.type === "STATE" || message.type === "DETAIL_COVERAGE",
		),
		false,
	);
	assert.deepEqual(
		result.messages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => [
				message.stream,
				message.reason,
				message.recovery_hint,
			]),
		[
			["playlists", "inventory_not_proven_complete", { action: "retry_by_runtime", retryable: true }],
			["playlist_items", "inventory_not_proven_complete", { action: "retry_by_runtime", retryable: true }],
		],
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
								offset: 0,
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
								? { totalCount: 0, items, offset: variables?.offset }
								: {
										totalCount: items.length,
										items,
										offset: variables?.offset,
									},
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
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE" && message.stream === "playlist_items",
	);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null, 1);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null, 1);
});

test("an empty child playlist emits exact zero playlist-item coverage", async () => {
	const result = await collectSavedTracks(
		(_offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								offset: 0,
								totalCount: 1,
								items: [
									{
										item: {
											data: {
												__typename: "Playlist",
												uri: "spotify:playlist:empty-child",
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
			return {
				data: {
					playlistV2: {
						uri: String(variables?.uri),
						content: { offset: 0, totalCount: 0, items: [] },
					},
				},
			};
		},
		{ requested: ["playlist_items"] },
	);
	assert.deepEqual(result.emittedRecords, []);
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE" && message.stream === "playlist_items",
	);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null, 0);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null, 0);
});

test("saved-track traversal cannot infer a terminal boundary from short pages without source end evidence", async () => {
	const firstPage = Array.from({ length: 100 }, (_, index) =>
		savedTrack(`row${index}`),
	);
	await assertRejectedWithoutAuthority((offset) =>
		offset === 0
			? savedResponse(firstPage)
			: savedResponse([savedTrack("tail")], undefined, 100),
	);
});

test("saved-track short and empty pages without totals cannot prove completion", async () => {
	for (const items of [[], [savedTrack("one")]]) {
		await assertRejectedWithoutAuthority(() => savedResponse(items));
	}
});

test("a fully covered nonempty saved-track scan emits STATE after exact coverage", async () => {
	const result = await collectSavedTracks(() => savedResponse([savedTrack("full")], 1));
	assert.equal(result.emittedRecords.filter((record) => record.stream === "saved_tracks").length, 1);
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks",
	);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null, 1);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null, 1);
	assert.equal(
		result.messages.filter((message) => message.type === "STATE" && message.stream === "saved_tracks").length,
		1,
	);
});

test("a verified empty saved-track scan emits exact zero coverage and STATE", async () => {
	const result = await collectSavedTracks(() => savedResponse([], 0));
	assert.deepEqual(result.emittedRecords, []);
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks",
	);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null, 0);
	assert.equal(coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null, 0);
	assert.equal(
		result.messages.filter((message) => message.type === "STATE" && message.stream === "saved_tracks").length,
		1,
	);
});

test("saved tracks reject duplicate stable identities within a page", async () => {
	await assertRejectedWithoutAuthority(() =>
		savedResponse(
			[
				savedTrack("same"),
				{
					...savedTrack("same"),
					track: {
						...savedTrack("same").track,
						data: {
							...savedTrack("same").track.data,
							name: "Changed title",
						},
					},
				},
			],
			2,
		),
	);
});

test("saved tracks reject repeated identities across pages even when the page changes", async () => {
	const firstPage = Array.from({ length: 100 }, (_, index) =>
		savedTrack(`row${index}`),
	);
	await assertRejectedWithoutAuthority((offset) =>
		offset === 0
			? savedResponse(firstPage, 101)
			: savedResponse(
					[
						{
							...savedTrack("row0"),
							track: {
								...savedTrack("row0").track,
								data: {
									...savedTrack("row0").track.data,
									name: "Changed title",
								},
							},
						},
					],
					101,
					100,
				),
	);
});

test("saved-track URI and source IDs that disagree withhold the row and STATE", async () => {
	const result = await collectSavedTracks(() =>
		savedResponse(
			[savedTrack("source-id", { uri: "spotify:track:uri-id" })],
			1,
		),
	);
	assert.equal(
		result.emittedRecords.some((record) => record.stream === "saved_tracks"),
		false,
	);
	assert.equal(
		result.messages.some((message) => message.type === "STATE"),
		false,
	);
	const coverage = result.messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "saved_tracks",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		0,
	);
});

test("saved tracks reject a response offset that does not match the request", async () => {
	await assertRejectedWithoutAuthority(() => {
		const response = savedResponse([savedTrack("offset-mismatch")], 1) as {
			data: { me: { library: { tracks: Record<string, unknown> } } };
		};
		response.data.me.library.tracks.offset = 100;
		return response;
	});
});

test("saved tracks reject a terminal response without a returned offset", async () => {
	await assertRejectedWithoutAuthority(() => {
		const response = savedResponse([savedTrack("missing-offset")], 1) as {
			data: { me: { library: { tracks: Record<string, unknown> } } };
		};
		delete response.data.me.library.tracks.offset;
		return response;
	});
});

test("library rows without a type name still reject the run", async () => {
	await assertRejectedWithoutAuthority(
		() => ({
			data: {
				me: {
					libraryV3: {
						items: [{ item: { data: {} } }],
						totalCount: 1,
						offset: 0,
					},
				},
			},
		}),
		{ requested: ["playlists"] },
	);
});

test("unknown library row types and folders are skipped and reported as a coverage gap", async () => {
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => diagnostics.push(line));
	let result: Awaited<ReturnType<typeof collectSavedTracks>>;
	try {
		result = await collectSavedTracks(
			(_offset, _index, operationName, variables) => {
				if (operationName === "libraryV3") {
					return {
						data: {
							me: {
								libraryV3: {
									offset: 0,
									totalCount: 5,
									items: [
										{
											item: {
												data: {
													__typename: "Playlist",
													uri: "spotify:playlist:pl1",
												},
											},
										},
										{
											item: {
												data: {
													__typename: "FutureType",
													uri: "spotify:future:secret-owner-id",
												},
											},
										},
										{
											item: {
												data: {
													__typename: "FutureType",
													uri: "spotify:future:other",
												},
											},
										},
										{
											item: {
												data: {
													__typename: "Folder",
													uri: "spotify:user:alice:folder:f1",
												},
											},
										},
										{
											item: {
												data: {
													__typename: "alice@example.com",
													uri: "spotify:odd:x",
												},
											},
										},
									],
								},
							},
						},
					};
				}
				return {
					data: {
						playlistV2: {
							uri: String(variables?.uri),
							content: {
								offset: variables?.offset,
								totalCount: 1,
								items: [
									{
										itemV2: {
											data: {
												__typename: "Track",
												uri: "spotify:track:t1",
												name: "Track",
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
			{ requested: ["playlists", "playlist_items"] },
		);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	const playlists = result.emittedRecords.filter(
		(record) => record.stream === "playlists",
	);
	assert.deepEqual(
		playlists.map((record) => record.data.id),
		["pl1"],
	);
	assert.equal(
		result.emittedRecords.filter((record) => record.stream === "playlist_items")
			.length,
		1,
	);
	const coverage = (stream: string) => {
		const message = result.messages.find(
			(candidate) =>
				candidate.type === "DETAIL_COVERAGE" && candidate.stream === stream,
		);
		return message?.type === "DETAIL_COVERAGE"
			? { considered: message.considered, covered: message.covered }
			: null;
	};
	// Four skipped rows are weighed but not covered, so neither stream reads complete.
	assert.deepEqual(coverage("playlists"), { considered: 5, covered: 1 });
	assert.deepEqual(coverage("playlist_items"), { considered: 5, covered: 1 });
	for (const stream of ["playlists", "playlist_items"]) {
		assert.equal(
			result.messages.some(
				(message) =>
					message.type === "SKIP_RESULT" &&
					message.stream === stream &&
					message.reason === "spotify_library_rows_unsupported",
			),
			true,
			`SKIP_RESULT for ${stream}`,
		);
	}
	const skipped = diagnostics.filter((line) =>
		line.includes("library_rows_skipped"),
	);
	assert.equal(skipped.length, 1);
	assert.match(skipped[0] ?? "", /"skipped":4/);
	assert.match(
		skipped[0] ?? "",
		/"types":"Folder:1,FutureType:2,unparseable:1"/,
	);
	assert.doesNotMatch(skipped[0] ?? "", /alice|secret-owner-id|spotify:/);
});

test("known Spotify pseudo-playlists count in inventory proof without becoming playlists", async () => {
	const result = await collectSavedTracks(
		() => ({
			data: {
				me: {
					libraryV3: {
						offset: 0,
						totalCount: 1,
						items: [
							{
								item: {
									data: {
										__typename: "PseudoPlaylist",
										uri: "spotify:collection:tracks",
									},
								},
							},
						],
					},
				},
			},
		}),
		{ requested: ["playlists"] },
	);
	assert.equal(
		result.messages.some(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === "playlists" &&
				message.considered === 0 &&
				message.covered === 0,
		),
		true,
	);
});

test("playlist item rows reject unrecognized types instead of silently skipping them", async () => {
	await assertRejectedWithoutAuthority(
		(_offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								offset: 0,
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
			return {
				data: {
					playlistV2: {
						uri: String(variables?.uri),
						name: "List",
						content: {
							totalCount: 1,
							offset: variables?.offset,
							items: [{ itemV2: { data: { __typename: "FutureType" } } }],
						},
					},
				},
			};
		},
		{ requested: ["playlist_items"] },
	);
});

test("playlist item positions retain source slots occupied by episodes", async () => {
	const result = await collectSavedTracks(
		(_offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") {
				return {
					data: {
						me: {
							libraryV3: {
								offset: 0,
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
			return {
				data: {
					playlistV2: {
						uri: String(variables?.uri),
						content: {
							offset: variables?.offset,
							totalCount: 3,
							items: [
								{ itemV2: { data: { __typename: "Episode" } } },
								{
									itemV2: {
										data: {
											__typename: "Track",
											uri: "spotify:track:t1",
											name: "Track",
											artists: { items: [] },
										},
									},
								},
								{ itemV2: { data: { __typename: "PodcastEpisode" } } },
							],
						},
					},
				},
			};
		},
		{ requested: ["playlist_items"] },
	);
	const items = result.emittedRecords.filter(
		(record) => record.stream === "playlist_items",
	);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.data.id, "pl1:1");
	assert.equal(items[0]?.data.position, 1);
});

test("malformed playlist item fields withhold the whole row before coverage", async () => {
	for (const mutate of [
		(track: Record<string, unknown>) => {
			track.trackDuration = { totalMilliseconds: "180000" };
		},
		(track: Record<string, unknown>) => {
			track.artists = [];
		},
		(_track: Record<string, unknown>, item: Record<string, unknown>) => {
			item.addedBy = [];
		},
	]) {
		const result = await collectSavedTracks(
			(_offset, _index, operationName, variables) => {
				if (operationName === "libraryV3") {
					return {
						data: {
							me: {
								libraryV3: {
									offset: 0,
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
				const item: Record<string, unknown> = {
					itemV2: {
						data: {
							__typename: "Track",
							uri: "spotify:track:t1",
							name: "Track",
							artists: { items: [] },
							trackDuration: { totalMilliseconds: 180000 },
						},
					},
				};
				const track = (item.itemV2 as { data: Record<string, unknown> }).data;
				mutate(track, item);
				return {
					data: {
						playlistV2: {
							uri: String(variables?.uri),
							content: {
								totalCount: 1,
								offset: variables?.offset,
								items: [item],
							},
						},
					},
				};
			},
			{ requested: ["playlist_items"] },
		);
		assert.equal(
			result.emittedRecords.some(
				(record) => record.stream === "playlist_items",
			),
			false,
		);
		const coverage = result.messages.find(
			(message) =>
				message.type === "DETAIL_COVERAGE" &&
				message.stream === "playlist_items",
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
			1,
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
			0,
		);
	}
});

test("malformed saved-track mapped fields withhold the whole row before coverage", async () => {
	const malformedRows = [
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.duration = { totalMilliseconds: "180000" };
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.uri = 42 as unknown as string;
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.contentRating = { label: 42 };
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.albumOfTrack =
				false as unknown as typeof row.track.data.albumOfTrack;
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.addedAt = { isoString: 42 };
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.duration = [];
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.artists = [];
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.albumOfTrack = [];
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.albumOfTrack = { artists: [] };
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.contentRating = [];
		},
		(row: ReturnType<typeof savedTrack>) => {
			row.track.data.externalIds = [];
		},
		(row: ReturnType<typeof savedTrack>) => {
			Object.assign(row, { addedAt: [] });
		},
	];
	for (const mutate of malformedRows) {
		const malformed = savedTrack("malformed");
		mutate(malformed);
		const result = await collectSavedTracks(() =>
			savedResponse([savedTrack("covered"), malformed], 2),
		);
		assert.deepEqual(
			result.emittedRecords.map((record) => record.data.id),
			["covered"],
		);
		const coverage = result.messages.find(
			(message) => message.type === "DETAIL_COVERAGE",
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
			2,
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
			1,
		);
		assert.ok(
			!result.messages.some(
				(message) =>
					message.type === "STATE" && message.stream === "saved_tracks",
			),
		);
	}
});

test("unavailable mapped saved-track fields withhold the whole row and reduce coverage", async () => {
	const malformed = savedTrack("unavailable");
	malformed.track.data.duration = [];
	const result = await collectSavedTracks(() =>
		savedResponse([savedTrack("covered"), malformed], 2),
	);
	assert.deepEqual(
		result.emittedRecords.map((record) => record.data.id),
		["covered"],
	);
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
		2,
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		1,
	);
	assert.ok(
		!result.messages.some(
			(message) =>
				message.type === "STATE" && message.stream === "saved_tracks",
		),
	);
});

test("saved-track traversal continues after a nonempty short page while totalCount remains", async () => {
	const result = await collectSavedTracks((offset) =>
		offset === 0
			? savedResponse([savedTrack("one"), savedTrack("two")], 3)
			: savedResponse([savedTrack("three")], 3, 2),
	);
	assert.deepEqual(result.requests, [0, 2]);
	assert.equal(result.emittedRecords.length, 3);
});

function localSavedTrack(uri: string) {
	return {
		addedAt: { isoString: "2024-01-01T00:00:00Z" },
		track: {
			uri,
			data: {
				id: null,
				name: uri,
				artists: { items: [] },
				albumOfTrack: { name: "Album", artists: { items: [] } },
				duration: { totalMilliseconds: 180000 },
				contentRating: { label: "NONE" },
				externalIds: { isrc: null },
			},
		},
	};
}

function localSavedTrackId(uri: string): string {
	return `local:${createHash("sha256").update(uri).digest("hex")}`;
}

test("equal-duration local saved tracks retain distinct URI-derived identities", async () => {
	const uris = [
		"spotify:local:Artist:Album:First%20Track:180000",
		"spotify:local:Artist:Album:Second%20Track:180000",
	];
	const items = uris.map(localSavedTrack);
	const result = await collectSavedTracks(() => savedResponse(items, 2), {
		completeFixtures: false,
	});
	assert.deepEqual(
		result.emittedRecords.map((record) => record.data.id),
		uris.map(localSavedTrackId),
	);
	assert.deepEqual(
		result.emittedRecords.map((record) => record.data.uri),
		uris,
	);
	assert.equal(
		result.messages.some(
			(message) =>
				message.type === "STATE" && message.stream === "saved_tracks",
		),
		true,
	);
});

test("local saved track with a URI over 200 characters remains emitted", async () => {
	const uri = `spotify:local:Artist:Album:${"A".repeat(190)}:180000`;
	assert.ok(uri.length >= 215 && uri.length < 2000);
	const result = await collectSavedTracks(
		() => savedResponse([localSavedTrack(uri)], 1),
		{ completeFixtures: false },
	);
	assert.equal(result.emittedRecords.length, 1);
	const record = result.emittedRecords[0];
	assert.equal(record?.data.id, localSavedTrackId(uri));
	assert.equal(record?.data.uri, uri);
	assert.equal(validateRecord("saved_tracks", record?.data).ok, true);
	assert.equal(
		result.messages.some(
			(message) => message.type === "STATE" && message.stream === "saved_tracks",
		),
		true,
	);
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
	await assertRejectedWithoutAuthority(() => ({
		data: { me: { library: { tracks: null } } },
	}));
});

test("schema-invalid saved rows are withheld from the whole record and coverage", async () => {
	const invalid = savedTrack("bad-shape");
	invalid.track.data.name = "x".repeat(1001);
	const result = await collectSavedTracks(() =>
		savedResponse([savedTrack("valid"), invalid], 2),
	);
	assert.deepEqual(
		result.emittedRecords.map((record) => record.data.id),
		["valid"],
	);
	const coverage = result.messages.find(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
		2,
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		1,
	);
	assert.ok(
		!result.messages.some(
			(message) =>
				message.type === "STATE" && message.stream === "saved_tracks",
		),
	);
});

test("saved track with no available identity is withheld from emission and coverage", async () => {
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
	assert.equal(result.emittedRecords.length, 0);
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

test("Spotify datetime schema rejects impossible calendar values and trailing garbage", () => {
	const valid = {
		id: "track1",
		identity_unresolved: false,
		name: "Track",
		artist_names: [],
		album_name: null,
		duration_ms: null,
		popularity: null,
		added_at: "2024-02-29T00:00:00Z",
		isrc: null,
		uri: null,
		explicit: null,
		album_artist_names: [],
	};
	assert.equal(validateRecord("saved_tracks", valid).ok, true);
	assert.equal(
		validateRecord("saved_tracks", {
			...valid,
			added_at: "2023-02-29T00:00:00Z",
		}).ok,
		false,
	);
	assert.equal(
		validateRecord("saved_tracks", {
			...valid,
			added_at: "2024-02-29T00:00:00Zgarbage",
		}).ok,
		false,
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
		{
			requested: ["profile"],
			profileEnrichment: {
				uri: "spotify:user:synthetic-user",
				followers_count: null,
				following_count: null,
				image_url: null,
			},
		},
	);
	assert.deepEqual(result.emittedRecords[0]?.data.images, [
		{ url: "", width: null, height: null },
	]);
});

test("profile with the image key absent from both sources omits the image field", async () => {
	const result = await collectSavedTracks(
		() => ({
			data: {
				me: {
					profile: {
						username: "synthetic-user",
						name: "Synthetic user",
						uri: "spotify:user:synthetic-user",
					},
				},
			},
		}),
		{
			requested: ["profile"],
			profileEnrichment: { uri: "spotify:user:synthetic-user" },
		},
	);
	const profile = result.emittedRecords.find((r) => r.stream === "profile");
	assert.ok(profile, "profile row is emitted");
	assert.equal(Object.hasOwn(profile.data, "images"), false);
	assert.equal(profile.data.followers, null);
	assert.equal(profile.data.following, null);
});

for (const [label, sourceImage, enrichmentImage, expected] of [
	["null/null", { imageUrl: null }, { image_url: null }, []],
	["null/absent", { imageUrl: null }, {}, []],
	["absent/null", {}, { image_url: null }, []],
	["absent/absent", {}, {}, undefined],
] as const) {
	test(`profile image ${label} follows the explicit-empty contract`, async () => {
		const result = await collectSavedTracks(
			() => ({
				data: {
					me: {
						profile: {
							username: "synthetic-user",
							name: "Synthetic user",
							uri: "spotify:user:synthetic-user",
							...sourceImage,
						},
					},
				},
			}),
			{
				requested: ["profile"],
				profileEnrichment: {
					uri: "spotify:user:synthetic-user",
					...enrichmentImage,
				},
			},
		);
		const profile = result.emittedRecords.find((r) => r.stream === "profile");
		assert.ok(profile, "profile row is emitted");
		if (expected === undefined) {
			assert.equal(Object.hasOwn(profile.data, "images"), false);
		} else {
			assert.deepEqual(profile.data.images, expected);
		}
		const coverage = result.messages.find(
			(m) => m.type === "DETAIL_COVERAGE" && m.stream === "profile",
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
			1,
		);
	});
}

test("malformed profile image data withholds the whole row and coverage", async () => {
	const result = await collectSavedTracks(
		() => ({
			data: {
				me: { profile: { username: "synthetic-user", imageUrl: 42 } },
			},
		}),
		{ requested: ["profile"] },
	);
	assert.equal(
		result.emittedRecords.some((record) => record.stream === "profile"),
		false,
	);
	const coverage = result.messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "profile",
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

test("malformed profile enrichment counts withhold the whole row and coverage", async () => {
	const result = await collectSavedTracks(
		() => ({
			data: {
				me: {
					profile: {
						username: "synthetic-user",
						uri: "spotify:user:synthetic-user",
					},
				},
			},
		}),
		{
			requested: ["profile"],
			profileEnrichment: {
				uri: "spotify:user:synthetic-user",
				followers_count: "42",
				following_count: 10,
			},
		},
	);
	assert.equal(
		result.emittedRecords.some((record) => record.stream === "profile"),
		false,
	);
	const coverage = result.messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "profile",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		0,
	);
});

test("profile enrichment for a different identity withholds the whole row", async () => {
	const result = await collectSavedTracks(
		() => ({
			data: {
				me: {
					profile: {
						username: "synthetic-user",
						uri: "spotify:user:synthetic-user",
					},
				},
			},
		}),
		{
			requested: ["profile"],
			profileEnrichment: {
				uri: "spotify:user:other-user",
				followers_count: 42,
				following_count: 10,
			},
		},
	);
	assert.equal(
		result.emittedRecords.some((record) => record.stream === "profile"),
		false,
	);
	const coverage = result.messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "profile",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		0,
	);
});

test("an unsuccessful profile enrichment response withholds the whole row", async () => {
	const result = await collectSavedTracks(
		() => ({
			data: {
				me: {
					profile: {
						username: "synthetic-user",
						uri: "spotify:user:synthetic-user",
					},
				},
			},
		}),
		{
			requested: ["profile"],
			profileEnrichmentStatus: 503,
			profileEnrichment: {
				uri: "spotify:user:synthetic-user",
				followers_count: 42,
				following_count: 10,
			},
		},
	);
	assert.equal(
		result.emittedRecords.some((record) => record.stream === "profile"),
		false,
	);
	const coverage = result.messages.find(
		(message) =>
			message.type === "DETAIL_COVERAGE" && message.stream === "profile",
	);
	assert.equal(
		coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
		0,
	);
});

test("malformed playlist detail fields veto coverage", async () => {
	for (const mutate of [
		(detail: Record<string, unknown>) => {
			detail.name = 42;
		},
		(detail: Record<string, unknown>) => {
			detail.followers = "10";
		},
		(detail: Record<string, unknown>) => {
			detail.images = { items: [{ sources: "malformed" }] };
		},
		(detail: Record<string, unknown>) => {
			detail.ownerV2 = false;
		},
		(detail: Record<string, unknown>) => {
			detail.images = [];
		},
		(detail: Record<string, unknown>) => {
			detail.public = [];
		},
		(detail: Record<string, unknown>) => {
			detail.collaborative = [];
		},
		(detail: Record<string, unknown>) => {
			detail.revisionId = [];
		},
	]) {
		const result = await collectSavedTracks(
			(_offset, _index, operationName, variables) => {
				if (operationName === "libraryV3") {
					return {
						data: {
							me: {
								libraryV3: {
									offset: 0,
									totalCount: 1,
									items: [
										{
											item: {
												data: {
													__typename: "Playlist",
													uri: "spotify:playlist:p1",
												},
											},
										},
									],
								},
							},
						},
					};
				}
				const detail: Record<string, unknown> = {
					uri: String(variables?.uri),
					name: "Synthetic playlist",
					ownerV2: { data: { uri: "spotify:user:owner", name: "Owner" } },
					content: { offset: variables?.offset, totalCount: 0, items: [] },
					followers: 10,
					images: { items: [] },
				};
				mutate(detail);
				return { data: { playlistV2: detail } };
			},
			{ requested: ["playlists"] },
		);
		assert.equal(
			result.emittedRecords.some((record) => record.stream === "playlists"),
			false,
		);
		const coverage = result.messages.find(
			(message) =>
				message.type === "DETAIL_COVERAGE" && message.stream === "playlists",
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.considered : null,
			1,
		);
		assert.equal(
			coverage?.type === "DETAIL_COVERAGE" ? coverage.covered : null,
			0,
		);
	}
});

test("a request made from a non-player navigation cannot prove an empty saved-track list", async () => {
	await assertRejectedWithoutAuthority(() => savedResponse([], 0), {
		pathname: "/login",
	});
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
		responseOffset: 100,
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

function playlistLibraryResponse(): unknown {
	return {
		data: {
			me: {
				libraryV3: {
					offset: 0,
					totalCount: 1,
					items: [
						{
							item: {
								data: { __typename: "Playlist", uri: "spotify:playlist:pl1" },
							},
						},
					],
				},
			},
		},
	};
}

function completePlaylistTrackItem(): Record<string, unknown> {
	return {
		addedAt: { isoString: "2024-01-01T00:00:00Z" },
		addedBy: { data: { name: "Adder" } },
		itemV2: {
			data: {
				__typename: "Track",
				id: "t1",
				uri: "spotify:track:t1",
				name: "Track",
				artists: { items: [] },
				albumOfTrack: { name: "Album" },
				trackDuration: { totalMilliseconds: 1000 },
			},
		},
	};
}

function playlistDetailResponse(
	uri: string,
	offset: unknown,
	items: unknown[],
	overrides: Record<string, unknown> = {},
): unknown {
	return {
		data: {
			playlistV2: {
				uri,
				name: "Playlist",
				public: false,
				collaborative: false,
				revisionId: "revision",
				description: null,
				followers: 0,
				images: { items: [] },
				ownerV2: { data: { uri: "spotify:user:owner", name: "Owner" } },
				content: { totalCount: items.length, offset, items },
				...overrides,
			},
		},
	};
}

function playlistCoverage(
	messages: EmittedMessage[],
	stream: string,
): { considered: number; covered: number } | null {
	const message = messages.find(
		(candidate) =>
			candidate.type === "DETAIL_COVERAGE" && candidate.stream === stream,
	);
	return message?.type === "DETAIL_COVERAGE"
		? { considered: message.considered ?? -1, covered: message.covered ?? -1 }
		: null;
}

test("playlist detail containers that are not objects withhold the row instead of reading as empty", async () => {
	for (const malformed of [
		{ ownerV2: false },
		{ ownerV2: [] },
		{ ownerV2: { data: [] } },
		{ images: [] },
	]) {
		const result = await collectSavedTracks(
			(offset, _index, operationName, variables) =>
				operationName === "libraryV3"
					? playlistLibraryResponse()
					: playlistDetailResponse(
							String(variables?.uri),
							offset,
							[],
							malformed,
						),
			{ requested: ["playlists"], completeFixtures: false },
		);
		assert.deepEqual(
			result.emittedRecords.filter((record) => record.stream === "playlists"),
			[],
		);
		assert.deepEqual(playlistCoverage(result.messages, "playlists"), {
			considered: 1,
			covered: 0,
		});
	}
});

test("playlist item containers that are not objects withhold the row instead of reading as empty", async () => {
	const mutations: Array<(item: Record<string, unknown>) => void> = [
		(item) => {
			item.addedBy = false;
		},
		(item) => {
			item.addedBy = { data: [] };
		},
		(item) => {
			item.addedAt = [];
		},
		(item) => {
			(item.itemV2 as { data: Record<string, unknown> }).data.artists = false;
		},
		(item) => {
			(item.itemV2 as { data: Record<string, unknown> }).data.albumOfTrack =
				[];
		},
		(item) => {
			(item.itemV2 as { data: Record<string, unknown> }).data.trackDuration =
				[];
		},
	];
	for (const mutate of mutations) {
		const result = await collectSavedTracks(
			(offset, _index, operationName, variables) => {
				if (operationName === "libraryV3") return playlistLibraryResponse();
				const item = completePlaylistTrackItem();
				mutate(item);
				return playlistDetailResponse(String(variables?.uri), offset, [item]);
			},
			{ requested: ["playlist_items"], completeFixtures: false },
		);
		assert.deepEqual(
			result.emittedRecords.filter(
				(record) => record.stream === "playlist_items",
			),
			[],
		);
		assert.deepEqual(playlistCoverage(result.messages, "playlist_items"), {
			considered: 1,
			covered: 0,
		});
	}
});

test("a field absent from a playlist detail or item withholds the row, while an explicit null is kept", async () => {
	const absentDetail = [
		"name",
		"revisionId",
		"description",
		"followers",
		"images",
		"ownerV2",
	];
	for (const key of absentDetail) {
		const result = await collectSavedTracks(
			(offset, _index, operationName, variables) => {
				if (operationName === "libraryV3") return playlistLibraryResponse();
				const response = playlistDetailResponse(
					String(variables?.uri),
					offset,
					[],
				) as { data: { playlistV2: Record<string, unknown> } };
				delete response.data.playlistV2[key];
				return response;
			},
			{ requested: ["playlists"], completeFixtures: false },
		);
		assert.deepEqual(playlistCoverage(result.messages, "playlists"), {
			considered: 1,
			covered: 0,
		});
		assert.equal(
			result.emittedRecords.some((record) => record.stream === "playlists"),
			false,
			`absent ${key} must withhold the playlist`,
		);
	}
	const explicit = await collectSavedTracks(
		(offset, _index, operationName, variables) =>
			operationName === "libraryV3"
				? playlistLibraryResponse()
				: playlistDetailResponse(String(variables?.uri), offset, [], {
						description: null,
						followers: null,
						images: null,
					}),
		{ requested: ["playlists"], completeFixtures: false },
	);
	assert.deepEqual(playlistCoverage(explicit.messages, "playlists"), {
		considered: 1,
		covered: 1,
	});

	const absentItem: Array<[string, (item: Record<string, unknown>) => void]> = [
		["addedAt", (item) => delete item.addedAt],
		["addedBy", (item) => delete item.addedBy],
		[
			"artists",
			(item) =>
				delete (item.itemV2 as { data: Record<string, unknown> }).data.artists,
		],
		[
			"albumOfTrack",
			(item) =>
				delete (item.itemV2 as { data: Record<string, unknown> }).data
					.albumOfTrack,
		],
		[
			"trackDuration",
			(item) =>
				delete (item.itemV2 as { data: Record<string, unknown> }).data
					.trackDuration,
		],
	];
	for (const [key, remove] of absentItem) {
		const result = await collectSavedTracks(
			(offset, _index, operationName, variables) => {
				if (operationName === "libraryV3") return playlistLibraryResponse();
				const item = completePlaylistTrackItem();
				remove(item);
				return playlistDetailResponse(String(variables?.uri), offset, [item]);
			},
			{ requested: ["playlist_items"], completeFixtures: false },
		);
		assert.deepEqual(
			playlistCoverage(result.messages, "playlist_items"),
			{ considered: 1, covered: 0 },
			`absent ${key} must withhold the playlist item`,
		);
	}
	const explicitItem = await collectSavedTracks(
		(offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") return playlistLibraryResponse();
			const item = completePlaylistTrackItem();
			item.addedBy = null;
			item.addedAt = { isoString: null };
			return playlistDetailResponse(String(variables?.uri), offset, [item]);
		},
		{ requested: ["playlist_items"], completeFixtures: false },
	);
	assert.deepEqual(playlistCoverage(explicitItem.messages, "playlist_items"), {
		considered: 1,
		covered: 1,
	});
});


function complete(id: string) {
	const row = savedTrack(id);
	Object.assign(row.track.data, {
		duration: { totalMilliseconds: 1000 },
		contentRating: { label: "NONE" },
		popularity: 10,
		externalIds: { isrc: null },
		albumOfTrack: { name: "Album", artists: { items: [] } },
	});
	return row;
}

test("a field absent from a saved track withholds the row and STATE, while an explicit null is kept", async () => {
	const absent: Array<[string, (row: ReturnType<typeof savedTrack>) => void]> = [
		["duration", (row) => delete row.track.data.duration],
		["contentRating", (row) => delete row.track.data.contentRating],
		["artists", (row) => delete row.track.data.artists],
		["albumOfTrack", (row) => delete row.track.data.albumOfTrack],
		[
			"albumOfTrack.artists",
			(row) =>
				delete (row.track.data.albumOfTrack as Record<string, unknown>).artists,
		],
		[
			"addedAt",
			(row) => delete (row as { addedAt?: unknown }).addedAt,
		],
	];
	for (const [key, remove] of absent) {
		const row = complete("gap");
		remove(row);
		const result = await collectSavedTracks(
			() => savedResponse([complete("whole"), row], 2),
			{ completeFixtures: false },
		);
		assert.deepEqual(
			result.emittedRecords.map((record) => record.data.id),
			["whole"],
			`absent ${key} must withhold the row`,
		);
		assert.deepEqual(playlistCoverage(result.messages, "saved_tracks"), {
			considered: 2,
			covered: 1,
		});
		assert.ok(
			!result.messages.some(
				(message) =>
					message.type === "STATE" && message.stream === "saved_tracks",
			),
		);
	}
	const explicit = complete("explicit");
	Object.assign(explicit.track.data, {
		duration: null,
		contentRating: null,
		popularity: null,
		externalIds: null,
		artists: null,
		albumOfTrack: null,
	});
	const kept = await collectSavedTracks(() => savedResponse([explicit], 1), {
		completeFixtures: false,
	});
	assert.equal(kept.emittedRecords.length, 1);
	assert.deepEqual(playlistCoverage(kept.messages, "saved_tracks"), {
		considered: 1,
		covered: 1,
	});
});

test("a nonempty short playlist detail page without a total cannot be counted as complete", async () => {
	await assertRejectedWithoutAuthority(
		(offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") return playlistLibraryResponse();
			const response = playlistDetailResponse(String(variables?.uri), offset, [
				completePlaylistTrackItem(),
			]) as {
				data: { playlistV2: { content: Record<string, unknown> } };
			};
			delete response.data.playlistV2.content.totalCount;
			return response;
		},
		{ requested: ["playlists"] },
	);
});

test("fields the source operations never carry are not gaps: playlist public/collaborative, saved-track popularity, and track ids derived from the URI", async () => {
	const playlists = await collectSavedTracks(
		(offset, _index, operationName, variables) => {
			if (operationName === "libraryV3") return playlistLibraryResponse();
			const response = playlistDetailResponse(String(variables?.uri), offset, [
				completePlaylistTrackItem(),
			]) as { data: { playlistV2: Record<string, unknown> } };
			delete response.data.playlistV2.public;
			delete response.data.playlistV2.collaborative;
			const item = (
				response.data.playlistV2.content as {
					items: Array<{ itemV2: { data: Record<string, unknown> } }>;
				}
			).items[0];
			delete item?.itemV2.data.id;
			return response;
		},
		{ requested: ["playlists", "playlist_items"], completeFixtures: false },
	);
	const playlist = playlists.emittedRecords.find(
		(record) => record.stream === "playlists",
	)?.data;
	assert.equal(playlist?.public, null);
	assert.equal(playlist?.collaborative, null);
	assert.equal(
		playlists.emittedRecords.find((record) => record.stream === "playlist_items")
			?.data.track_id,
		"t1",
	);
	const saved = complete("no-id");
	delete saved.track.data.id;
	delete saved.track.data.popularity;
	delete saved.track.data.externalIds;
	const result = await collectSavedTracks(() => savedResponse([saved], 1), {
		completeFixtures: false,
	});
	assert.equal(result.emittedRecords[0]?.data.id, "no-id");
	assert.equal(result.emittedRecords[0]?.data.popularity, null);
	assert.equal(result.emittedRecords[0]?.data.isrc, null);
});

test("a profile image absent from one source is read from the other, absent from both is omitted, absent counts are null, and malformed withholds the row", async () => {
	const profile = (imageUrl?: string) => () => ({
		data: {
			me: {
				profile: {
					username: "synthetic-user",
					name: "Synthetic user",
					uri: "spotify:user:synthetic-user",
					...(imageUrl === undefined ? {} : { imageUrl }),
				},
			},
		},
	});
	const enrichment = (image?: string) => ({
		uri: "spotify:user:synthetic-user",
		followers_count: 1,
		following_count: 1,
		...(image === undefined ? {} : { image_url: image }),
	});
	const fromEnrichment = await collectSavedTracks(profile(), {
		requested: ["profile"],
		profileEnrichment: enrichment("https://example.test/a.png"),
	});
	assert.deepEqual(fromEnrichment.emittedRecords[0]?.data.images, [
		{ url: "https://example.test/a.png", width: null, height: null },
	]);
	assert.equal(fromEnrichment.emittedRecords[0]?.data.followers, 1);
	const neither = await collectSavedTracks(profile(), {
		requested: ["profile"],
		profileEnrichment: enrichment(),
	});
	assert.equal(Object.hasOwn(neither.emittedRecords[0]?.data ?? {}, "images"), false);
	const noCounts = await collectSavedTracks(profile(), {
		requested: ["profile"],
		profileEnrichment: { uri: "spotify:user:synthetic-user" },
	});
	assert.equal(noCounts.emittedRecords[0]?.data.followers, null);
	assert.equal(noCounts.emittedRecords[0]?.data.following, null);
	const malformed = await collectSavedTracks(profile(), {
		requested: ["profile"],
		profileEnrichment: { ...enrichment(), image_url: 42 },
	});
	assert.deepEqual(malformed.emittedRecords, []);
});

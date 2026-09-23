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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	recentlyPlayedContextsAfterCursor,
	type SpotifyPlaylist,
	spotifyNextPath,
	spotifyPlaylistItemRecord,
	spotifyPlaylistRecord,
} from "./index.ts";
import { playlistItemsSchema, playlistsSchema } from "./schemas.ts";

const playlist = JSON.parse(
	readFileSync(
		new URL("./__fixtures__/playlist-items-response.json", import.meta.url),
		"utf8",
	),
) as SpotifyPlaylist;

test("Spotify playlist records preserve the current items.total response field", () => {
	const record = spotifyPlaylistRecord(playlist);
	assert.equal(record.track_count, 7);
	assert.equal(playlistsSchema.safeParse(record).success, true);
});

test("recently-played contexts emit only records newer than the millisecond cursor", () => {
	assert.deepEqual(
		recentlyPlayedContextsAfterCursor(
			[
				{ uri: "spotify:album:a", last_played_time: 10 },
				{ uri: "spotify:album:b", last_played_time: 11 },
			],
			10,
		),
		{
			contexts: [{ uri: "spotify:album:b", last_played_time: 11 }],
			cursor: 11,
		},
	);
});

test("Spotify next-page handling stays on the API origin and rejects no-progress links", () => {
	assert.equal(
		spotifyNextPath(
			"https://api.spotify.com/v1/me/playlists?limit=50&offset=50",
			"/me/playlists?limit=50",
		),
		"/me/playlists?limit=50&offset=50",
	);
	assert.equal(spotifyNextPath(null, "/me/playlists?limit=50"), null);
	assert.throws(
		() =>
			spotifyNextPath(
				"https://example.invalid/v1/me/playlists?offset=50",
				"/me/playlists?offset=0",
			),
		/spotify_pagination_invalid_next/,
	);
	assert.throws(
		() =>
			spotifyNextPath(
				"https://api.spotify.com/v1/me/playlists?offset=0",
				"/me/playlists?offset=0",
			),
		/spotify_pagination_no_progress/,
	);
});

test("Spotify playlist item helper preserves URI and validates against the stream schema", () => {
	const record = spotifyPlaylistItemRecord("playlist1", 0, {
		track: {
			id: "track1",
			uri: "spotify:track:track1",
			name: "Track",
			artists: [],
			album: { name: "Album" },
			duration_ms: 180_000,
		},
	});
	assert.equal(record.uri, "spotify:track:track1");
	assert.equal(playlistItemsSchema.safeParse(record).success, true);
});

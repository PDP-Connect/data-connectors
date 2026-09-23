// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Spotify connector. Parsing is inline in index.ts (no
 * parsers.ts), so these assert the schema against literal records shaped
 * exactly as the four `emitRecord(...)` literals build them — the
 * authoritative emitted shape. All four streams are exercised, including the
 * composite recently_played id and the time_range enum on top_artists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	playlistItemsSchema,
	playlistsSchema,
	profileSchema,
	recentlyPlayedSchema,
	savedTracksSchema,
	topArtistsSchema,
	validateRecord,
} from "./schemas.ts";

const PLAYLIST_RECORD = {
	id: "37i9dQZF1DXcBWIGoYBM5M",
	name: "Today's Top Hits",
	owner_id: "spotify",
	owner_name: "Spotify",
	public: true,
	collaborative: false,
	track_count: 50,
	snapshot_id: "MTYsZTBh...",
	description: "The hottest tracks right now.",
};

const SAVED_TRACK_RECORD = {
	id: "11dFghVXANMlKmJXsNCbNl",
	name: "Cut To The Feeling",
	artist_names: ["Carly Rae Jepsen"],
	album_name: "Cut To The Feeling",
	duration_ms: 207_959,
	popularity: 64,
	added_at: "2024-04-01T18:22:05Z",
	isrc: "USUM71703861",
};

const TOP_ARTIST_RECORD = {
	id: "06HL4z0CvFAxyc27GXpf02",
	name: "Taylor Swift",
	genres: ["pop", "pop dance"],
	popularity: 100,
	followers: 89_000_000,
	time_range: "medium_term",
};

const PLAYLIST_ITEM_RECORD = {
	id: "37i9dQZF1DXcBWIGoYBM5M:0",
	playlist_id: "37i9dQZF1DXcBWIGoYBM5M",
	track_id: "11dFghVXANMlKmJXsNCbNl",
	position: 0,
	added_at: "2024-04-01T18:22:05Z",
	added_by: "spotify",
	name: "Cut To The Feeling",
	artist_names: ["Carly Rae Jepsen"],
	album_name: "Cut To The Feeling",
	duration_ms: 207_959,
};

const PROFILE_RECORD = {
	id: "spotify_user_id",
	display_name: "Real Person",
	followers: 12,
};

const RECENTLY_PLAYED_RECORD = {
	id: "11dFghVXANMlKmJXsNCbNl:1714588925000",
	track_id: "11dFghVXANMlKmJXsNCbNl",
	track_name: "Cut To The Feeling",
	artist_names: ["Carly Rae Jepsen"],
	album_name: "Cut To The Feeling",
	played_at: "2024-05-01T18:22:05.000Z",
	context_type: "playlist",
};

test("playlists schema accepts a representative emitted record", () => {
	const result = playlistsSchema.safeParse(PLAYLIST_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("playlists schema accepts a record with an absent name (API omitted the field)", () => {
	const { name: _omit, ...withoutName } = PLAYLIST_RECORD;
	const result = playlistsSchema.safeParse(withoutName);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("saved_tracks schema accepts a representative emitted record", () => {
	const result = savedTracksSchema.safeParse(SAVED_TRACK_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("saved_tracks schema accepts a multi-artist track with null isrc", () => {
	const result = savedTracksSchema.safeParse({
		...SAVED_TRACK_RECORD,
		artist_names: ["A", "B", "C"],
		isrc: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("top_artists schema accepts each of the three time windows", () => {
	for (const time_range of ["short_term", "medium_term", "long_term"]) {
		const result = topArtistsSchema.safeParse({
			...TOP_ARTIST_RECORD,
			time_range,
		});
		assert.ok(
			result.success,
			`${time_range}: ${JSON.stringify(result.error?.issues)}`,
		);
	}
});

test("recently_played schema accepts a representative emitted record", () => {
	const result = recentlyPlayedSchema.safeParse(RECENTLY_PLAYED_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("top_artists schema rejects a time_range outside the three fixed windows", () => {
	assert.equal(
		topArtistsSchema.safeParse({ ...TOP_ARTIST_RECORD, time_range: "all_time" })
			.success,
		false,
	);
});

test("saved_tracks schema rejects a malformed ISRC (parse leak into isrc field)", () => {
	assert.equal(
		savedTracksSchema.safeParse({ ...SAVED_TRACK_RECORD, isrc: "not-an-isrc" })
			.success,
		false,
	);
});

test("recently_played schema rejects a non-composite id (id builder regression)", () => {
	assert.equal(
		recentlyPlayedSchema.safeParse({
			...RECENTLY_PLAYED_RECORD,
			id: "11dFghVXANMlKmJXsNCbNl",
		}).success,
		false,
	);
});

test("playlists schema rejects popularity-like junk in track_count (selector drift)", () => {
	assert.equal(
		playlistsSchema.safeParse({ ...PLAYLIST_RECORD, track_count: -1 }).success,
		false,
	);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
	assert.equal(validateRecord("playlists", PLAYLIST_RECORD).ok, true);
	assert.equal(validateRecord("saved_tracks", SAVED_TRACK_RECORD).ok, true);
	assert.equal(validateRecord("top_artists", TOP_ARTIST_RECORD).ok, true);
	assert.equal(
		validateRecord("recently_played", RECENTLY_PLAYED_RECORD).ok,
		true,
	);
	assert.equal(validateRecord("playlist_items", PLAYLIST_ITEM_RECORD).ok, true);
	assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
	assert.equal(validateRecord("top_tracks", { id: "x" }).ok, true);
});

test("playlist_items schema accepts a representative emitted record", () => {
	const result = playlistItemsSchema.safeParse(PLAYLIST_ITEM_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("playlist_items schema accepts a track with a null track_id and added_by (deleted track, unknown adder)", () => {
	const result = playlistItemsSchema.safeParse({
		...PLAYLIST_ITEM_RECORD,
		track_id: null,
		added_at: null,
		added_by: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("playlist_items schema rejects a negative position (parse leak)", () => {
	assert.equal(
		playlistItemsSchema.safeParse({ ...PLAYLIST_ITEM_RECORD, position: -1 })
			.success,
		false,
	);
});

test("profile schema accepts a representative emitted record", () => {
	const result = profileSchema.safeParse(PROFILE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema accepts null display_name and followers", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		display_name: null,
		followers: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

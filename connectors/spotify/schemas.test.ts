// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Spotify connector. Parsing is inline in index.ts (no
 * parsers.ts), so these assert the schema against literal records shaped
 * shaped exactly as the `emitRecord(...)` literals build them — the
 * authoritative emitted shape. The newer context and bounded ranking streams
 * are covered alongside the original streams.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	playlistItemsSchema,
	playlistsSchema,
	profileSchema,
	recentlyPlayedSchema,
	recentlyPlayedContextsSchema,
	savedTracksSchema,
	topArtistsSchema,
	topTracksSchema,
	validateRecord,
} from "./schemas.ts";

test("new Spotify stream schemas accept the mapped context and ranking records", () => {
	assert.equal(
		recentlyPlayedContextsSchema.safeParse({
			id: "spotify:album:album1",
			uri: "spotify:album:album1",
			last_played_time: 1720000000123,
			last_played_track_uri: null,
		}).success,
		true,
	);
	assert.equal(
		topArtistsSchema.safeParse({
			id: "artist1",
			uri: "spotify:artist:artist1",
			name: "Artist One",
			genres: [],
			followers: null,
			popularity: null,
			time_range: "short_term",
		}).success,
		true,
	);
	assert.equal(
		topTracksSchema.safeParse({
			id: "track1",
			uri: "spotify:track:track1",
			name: "Track One",
			artist_names: [],
			album_name: null,
			duration_ms: null,
			time_range: "long_term",
		}).success,
		true,
	);
});

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
	uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
	followers: 32_000_000,
	images: [{ url: "https://i.scdn.co/image/ab1234", width: 640, height: 640 }],
};

const SAVED_TRACK_RECORD = {
	id: "11dFghVXANMlKmJXsNCbNl",
	identity_unresolved: false,
	name: "Cut To The Feeling",
	artist_names: ["Carly Rae Jepsen"],
	album_name: "Cut To The Feeling",
	duration_ms: 207_959,
	popularity: 64,
	added_at: "2024-04-01T18:22:05Z",
	isrc: "USUM71703861",
	uri: "spotify:track:11dFghVXANMlKmJXsNCbNl",
	explicit: false,
	album_artist_names: ["Carly Rae Jepsen"],
};

const TOP_ARTIST_RECORD = {
	id: "06HL4z0CvFAxyc27GXpf02",
	uri: "spotify:artist:06HL4z0CvFAxyc27GXpf02",
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
	uri: "spotify:track:11dFghVXANMlKmJXsNCbNl",
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
	uri: "spotify:user:spotify_user_id",
	images: [{ url: "https://i.scdn.co/image/ab5678", width: 300, height: 300 }],
	following: 7,
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

test("playlists schema accepts null uri/followers and an empty images array (API omitted them)", () => {
	const result = playlistsSchema.safeParse({
		...PLAYLIST_RECORD,
		uri: null,
		followers: null,
		images: [],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("playlists schema rejects a malformed uri (not the spotify:playlist:<id> shape)", () => {
	assert.equal(
		playlistsSchema.safeParse({ ...PLAYLIST_RECORD, uri: "not-a-uri" }).success,
		false,
	);
});

test("playlists schema rejects an image object missing url", () => {
	assert.equal(
		playlistsSchema.safeParse({
			...PLAYLIST_RECORD,
			images: [{ width: 640, height: 640 }],
		}).success,
		false,
	);
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

test("saved_tracks schema accepts null uri/explicit and an empty album_artist_names array", () => {
	const result = savedTracksSchema.safeParse({
		...SAVED_TRACK_RECORD,
		uri: null,
		explicit: null,
		album_artist_names: [],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("saved_tracks schema accepts a compilation with album artists distinct from track artists", () => {
	const result = savedTracksSchema.safeParse({
		...SAVED_TRACK_RECORD,
		artist_names: ["Carly Rae Jepsen"],
		album_artist_names: ["Various Artists"],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("saved_tracks schema preserves a row with no URI identity or save date", () => {
	const result = savedTracksSchema.safeParse({
		...SAVED_TRACK_RECORD,
		id: null,
		identity_unresolved: true,
		added_at: null,
		uri: "",
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("top_artists schema accepts a record whose genres field is absent", () => {
	const { genres: _genres, ...withoutGenres } = TOP_ARTIST_RECORD;
	assert.equal(validateRecord("top_artists", withoutGenres).ok, true);
	assert.equal(validateRecord("top_artists", { ...withoutGenres, genres: "pop" }).ok, false);
});

test("top_artists schema accepts each of the two time windows", () => {
	for (const time_range of ["short_term", "long_term"]) {
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

test("top_artists schema rejects a time_range outside the two fixed windows", () => {
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
	assert.equal(validateRecord("top_tracks", { id: "x" }).ok, false);
});

test("playlist_items schema accepts a representative emitted record", () => {
	const result = playlistItemsSchema.safeParse(PLAYLIST_ITEM_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("playlist_items schema accepts a track with a null track_id and added_by (deleted track, unknown adder)", () => {
	const result = playlistItemsSchema.safeParse({
		...PLAYLIST_ITEM_RECORD,
		track_id: null,
		uri: null,
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

test("profile schema accepts null uri/following and an empty images array", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		uri: null,
		images: [],
		following: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a uri without the spotify:user: prefix", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, uri: "spotify:track:abc" })
			.success,
		false,
	);
});

test("profile schema rejects a negative following count", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, following: -1 }).success,
		false,
	);
});

// Non-regression: every pre-existing field on the three touched streams
// (playlists, saved_tracks, profile) keeps its exact prior name, type, and
// nullability — the additive fields above must not have displaced any of
// them.
test("playlists schema: pre-existing fields are unchanged by the additive fields", () => {
	const preExisting = {
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
	// uri/followers/images are new required-but-nullable/empty-default keys
	// (the builder always supplies them, never omits), so this checks the
	// pre-existing subset still parses once those are added back at their
	// absent-shape default, not that the pre-existing subset validates alone.
	const result = playlistsSchema.safeParse({
		...preExisting,
		uri: null,
		followers: null,
		images: [],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal(
		playlistsSchema.safeParse({
			...preExisting,
			uri: null,
			followers: null,
			images: [],
			track_count: -1,
		}).success,
		false,
		"track_count keeps its prior non-negative-integer constraint",
	);
});

test("saved_tracks schema: pre-existing fields are unchanged by the additive fields", () => {
	const preExisting = {
		id: "11dFghVXANMlKmJXsNCbNl",
		name: "Cut To The Feeling",
		artist_names: ["Carly Rae Jepsen"],
		album_name: "Cut To The Feeling",
		duration_ms: 207_959,
		popularity: 64,
		added_at: "2024-04-01T18:22:05Z",
		isrc: "USUM71703861",
	};
	const result = savedTracksSchema.safeParse({
		...preExisting,
		identity_unresolved: false,
		uri: null,
		explicit: null,
		album_artist_names: [],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal(
		savedTracksSchema.safeParse({
			...preExisting,
			uri: null,
			explicit: null,
			album_artist_names: [],
			isrc: "bad",
		}).success,
		false,
		"isrc keeps its prior 12-char ISRC constraint",
	);
});

test("profile schema: pre-existing fields are unchanged by the additive fields", () => {
	const preExisting = {
		id: "spotify_user_id",
		display_name: "Real Person",
		followers: 12,
	};
	const result = profileSchema.safeParse({
		...preExisting,
		uri: null,
		images: [],
		following: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal(
		profileSchema.safeParse({
			...preExisting,
			uri: null,
			images: [],
			following: null,
			followers: -1,
		}).success,
		false,
		"followers keeps its prior non-negative-integer constraint",
	);
});

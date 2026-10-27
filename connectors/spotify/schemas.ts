// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Spotify stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the record builders in index.ts. Collection uses logged-in
 * Spotify web-player GraphQL responses and user-profile-view enrichment.
 * Schemas mirror the emitted shape:
 *
 *   - Spotify resource ids are usually base-62 strings. User ids and legacy
 *     source variants can contain other characters, so each field uses the
 *     narrowest constraint supported by its source contract.
 *   - `name` / `track_name` / `album_name` / `description` and each element of
 *     `artist_names` are free-form human text → `pdppSafeText`.
 *   - Several id/name fields are read off optional source interface members
 *     (`p.name`, `t.id`, `a.id`, ...). When the source omits them the builder
 *     assigns `undefined`, which JSON drops. The schema marks those fields
 *     `.optional()` (in addition to `.nullable()` where the builder uses `??
 *     null`) so a legitimately-absent value validates, while a present value of
 *     the wrong shape is still rejected.
 *   - `added_at` / `played_at` are ISO-8601 datetimes where present; saved
 *     tracks can lack a save date and retain that source row with null.
 *   - `isrc` is the 12-char ISRC code or null.
 *   - top ranking `time_range` is one of Spotify's two supported windows.
 *   - recently played contexts use the context URI as the source identity and
 *     retain the last-played timestamp and track URI when available.
 *   - `uri` fields preserve values from web-player GraphQL payloads. Saved
 *     track URIs can be empty or absent in legacy-compatible source rows.
 *   - `images` normalizes web-player image URLs to `[{url, width, height}]`;
 *     width and height are null because that payload does not provide them.
 *   - Playlist follower counts come from authenticated fetchPlaylist data.
 *   - saved_tracks.album_artist_names is the *album's* artist list
 *     (`albumOfTrack.artists.items[].profile.name`), distinct from `artist_names` (the
 *     track's own artists) — both arrays can differ for compilations/features.
 *   - profile.following is the `following_count` returned by user-profile-view
 *     enrichment when its URI matches the authenticated GraphQL identity.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const SPOTIFY_ID_RE = /^[0-9A-Za-z]{1,40}$/; // base-62 resource id
const ISRC_RE = /^[A-Za-z]{2}[0-9A-Za-z]{3}\d{7}$/; // ISO 3901 ISRC
// recently_played id is `${track.id}:${playedAtMs}` — base-62 id, colon, epoch ms.
const RECENTLY_PLAYED_ID_RE = /^[0-9A-Za-z]{1,40}:\d{1,20}$/;

const spotifyIdSchema = z
	.string()
	.regex(SPOTIFY_ID_RE, "must be a Spotify base-62 id");
// `name` etc. are read from optional interface fields; absent → undefined (JSON
// drops the key). Allow optional alongside the free-text brand.
const nameSchema = pdppSafeText.max(1000).optional();
const artistNamesSchema = z.array(pdppSafeText.max(1000));
const isoDateTimeSchema = z.iso.datetime();
const SPOTIFY_URI_RE = /^spotify:[a-z]+:[0-9A-Za-z]{1,40}$/;
const spotifyUriSchema = z
	.string()
	.regex(SPOTIFY_URI_RE, "must be a Spotify URI");
// Normalized web-player image data; this source provides the URL without dimensions.
const spotifyImageSchema = z.object({
	url: z.string().max(2000),
	width: z.number().int().min(0).nullable(),
	height: z.number().int().min(0).nullable(),
});
const spotifyImagesSchema = z.array(spotifyImageSchema);

/**
 * playlists stream: one record per playlist the user owns/follows.
 * No incremental cursor (full list each run).
 */
export const playlistsSchema = z.object({
	id: spotifyIdSchema,
	name: nameSchema,
	owner_id: z.string().min(1).max(80).nullable(),
	owner_name: pdppSafeText.max(1000).nullable(),
	public: z.boolean().nullable(),
	collaborative: z.boolean().nullable(),
	track_count: z.number().int().min(0).nullable(),
	snapshot_id: z.string().min(1).max(200).nullable(),
	description: pdppSafeText.max(4000).nullable(),
	uri: spotifyUriSchema.nullable(),
	followers: z.number().int().min(0).nullable(),
	images: spotifyImagesSchema,
});

/**
 * saved_tracks stream: one record per "liked" track.
 * Cursor: added_at.
 */
export const savedTracksSchema = z.object({
	id: z.string().min(1).max(200),
	identity_unresolved: z.boolean(),
	name: nameSchema,
	artist_names: artistNamesSchema,
	album_name: pdppSafeText.max(1000).nullable(),
	duration_ms: z.number().int().min(0).nullable(),
	popularity: z.number().int().min(0).max(100).nullable(),
	added_at: isoDateTimeSchema.nullable(),
	isrc: z
		.string()
		.regex(ISRC_RE, "isrc must be a 12-char ISRC code")
		.nullable(),
	uri: z.string().max(2000).nullable(),
	explicit: z.boolean().nullable(),
	album_artist_names: artistNamesSchema,
});

/**
 * profile stream: one singleton record for the authenticated user, from the
 * web-player profileAttributes query and same-account profile-view enrichment.
 */
export const profileSchema = z.object({
	// Unlike track/playlist/artist ids, a Spotify user id is not
	// guaranteed base-62: legacy accounts can carry ids derived from an email
	// or a linked Facebook account, so this only bounds length.
	id: z.string().min(1).max(80),
	display_name: pdppSafeText.max(1000).nullable(),
	followers: z.number().int().min(0).nullable(),
	// `spotify:user:<id>` — a user's URI does not require the base-62 id
	// shape (see id's own comment), so this only checks the `spotify:user:`
	// prefix rather than reusing spotifyUriSchema's stricter id segment.
	uri: z
		.string()
		.regex(/^spotify:user:.+$/, "must be a Spotify user URI")
		.nullable(),
	images: spotifyImagesSchema.optional(),
	// Same-account user-profile-view following_count. Null when enrichment is
	// unavailable or its URI does not match the authenticated identity.
	following: z.number().int().min(0).nullable(),
});

/**
 * playlist_items stream: one record per track in a playlist, from
 * Spotify web-player playlist entries. Child of `playlists` via `playlist_id` (D3).
 * `added_by` is the display name exposed by the web-player GraphQL shape.
 * `position` is the zero-based index of the item within Spotify's paginated
 * ordering, so the id stays unique and stable across runs as long as the
 * playlist's ordering does not change (a Spotify-side reorder invalidates
 * positions the same way it would any offset-based list).
 * `uri` preserves the exact web-player Track URI; `track_id` alone cannot
 * reconstruct every URI shape exposed by that payload.
 */
export const playlistItemsSchema = z.object({
	id: z.string().min(1).max(120),
	playlist_id: spotifyIdSchema,
	track_id: z.string().min(1).max(200).nullable(),
	uri: z.string().max(2000).nullable(),
	position: z.number().int().min(0),
	added_at: isoDateTimeSchema.nullable(),
	added_by: pdppSafeText.max(1000).nullable(),
	name: nameSchema,
	artist_names: artistNamesSchema,
	album_name: pdppSafeText.max(1000).nullable(),
	duration_ms: z.number().int().min(0).nullable(),
});

/**
 * top_artists stream: one record per top artist, per time window.
 */
export const topArtistsSchema = z.object({
	id: spotifyIdSchema,
	uri: spotifyUriSchema.nullable(),
	name: pdppSafeText.max(1000),
	genres: z.array(pdppSafeText.max(200)).optional(),
	popularity: z.number().int().min(0).max(100).nullable(),
	followers: z.number().int().min(0).nullable(),
	time_range: z.enum(["short_term", "long_term"]),
});

export const topTracksSchema = z.object({
	id: spotifyIdSchema,
	uri: spotifyUriSchema.nullable(),
	name: pdppSafeText.max(1000),
	artist_names: artistNamesSchema,
	album_name: pdppSafeText.max(1000).nullable(),
	duration_ms: z.number().int().min(0).nullable(),
	time_range: z.enum(["short_term", "long_term"]),
});

export const recentlyPlayedContextsSchema = z.object({
	id: spotifyUriSchema,
	uri: spotifyUriSchema,
	last_played_time: z.number().int().min(0),
	last_played_track_uri: spotifyUriSchema.nullable(),
});

/**
 * recently_played stream: one record per play-history entry.
 * Cursor: played_at (epoch ms). `id` is the composite track:ms key.
 */
export const recentlyPlayedSchema = z.object({
	id: z
		.string()
		.regex(RECENTLY_PLAYED_ID_RE, "id must be <trackId>:<playedAtMs>"),
	track_id: spotifyIdSchema.optional(),
	track_name: nameSchema,
	artist_names: artistNamesSchema,
	album_name: pdppSafeText.max(1000).nullable(),
	played_at: isoDateTimeSchema,
	context_type: z.string().min(1).max(64).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	playlists: playlistsSchema,
	playlist_items: playlistItemsSchema,
	saved_tracks: savedTracksSchema,
	top_artists: topArtistsSchema,
	top_tracks: topTracksSchema,
	recently_played_contexts: recentlyPlayedContextsSchema,
	recently_played: recentlyPlayedSchema,
	profile: profileSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Spotify stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the four `emitRecord(...)` object literals in index.ts
 * (collectPlaylists, collectSavedTracks, collectTopArtists,
 * collectRecentlyPlayed). Schemas mirror the *emitted* shape:
 *
 *   - Spotify resource ids are base-62 strings (22 chars in practice, but the
 *     schema bounds them rather than fixing the length). `id`, `owner_id`,
 *     `track_id` follow SPOTIFY_ID_RE.
 *   - `name` / `track_name` / `album_name` / `description` and each element of
 *     `artist_names` are free-form human text → `pdppSafeText`.
 *   - Several id/name fields are read off optional source interface members
 *     (`p.name`, `t.id`, `a.id`, ...). When the API omits them the builder
 *     assigns `undefined`, which JSON drops. The schema marks those fields
 *     `.optional()` (in addition to `.nullable()` where the builder uses `??
 *     null`) so a legitimately-absent value validates, while a present value of
 *     the wrong shape is still rejected.
 *   - `added_at` / `played_at` are ISO-8601 datetimes (required cursor inputs).
 *   - `isrc` is the 12-char ISRC code or null.
 *   - `time_range` (top_artists) is one of Spotify's three fixed windows.
 *   - recently_played `id` is the composite `"<trackId>:<playedAtMs>"` the
 *     builder constructs — validated by RECENTLY_PLAYED_ID_RE.
 *   - `uri` fields are Spotify's `spotify:<type>:<id>` URIs, already present on
 *     the same Web API objects the connector fetches (playlist/track/user).
 *   - `images` is the Web API's own `[{url, width, height}]` array (width/height
 *     nullable); forwarded verbatim, empty array when the API sends none.
 *   - playlists.followers is `playlist.followers.total` from GET
 *     /playlists/{id}?fields=followers.total, because GET /me/playlists
 *     returns simplified playlist objects without follower counts.
 *   - saved_tracks.album_artist_names is the *album's* artist list
 *     (`track.album.artists[].name`), distinct from `artist_names` (the
 *     track's own artists) — both arrays can differ for compilations/features.
 *   - profile.following is the followed-artist total from GET
 *     /me/following?type=artist (`.artists.total`) — the closest documented
 *     "following" signal the Web API exposes; see index.ts collectProfile.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const SPOTIFY_ID_RE = /^[0-9A-Za-z]{1,40}$/; // base-62 resource id
const ISRC_RE = /^[A-Za-z]{2}[0-9A-Za-z]{3}\d{7}$/; // ISO 3901 ISRC
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
// recently_played id is `${track.id}:${playedAtMs}` — base-62 id, colon, epoch ms.
const RECENTLY_PLAYED_ID_RE = /^[0-9A-Za-z]{1,40}:\d{1,20}$/;

const spotifyIdSchema = z
	.string()
	.regex(SPOTIFY_ID_RE, "must be a Spotify base-62 id");
// `name` etc. are read from optional interface fields; absent → undefined (JSON
// drops the key). Allow optional alongside the free-text brand.
const nameSchema = pdppSafeText.max(1000).optional();
const artistNamesSchema = z.array(pdppSafeText.max(1000));
const isoDateTimeSchema = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime");
// Spotify URIs are `spotify:<type>:<base-62 id>` (spec: developer.spotify.com
// /documentation/web-api/concepts/spotify-uris-ids).
const SPOTIFY_URI_RE = /^spotify:[a-z]+:[0-9A-Za-z]{1,40}$/;
const spotifyUriSchema = z
	.string()
	.regex(SPOTIFY_URI_RE, "must be a Spotify URI");
// The Web API image object: { url, width, height } with width/height nullable
// (some image sources omit dimensions).
const spotifyImageSchema = z.object({
	url: z.string().min(1).max(2000),
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
	owner_id: spotifyIdSchema.nullable(),
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
	id: spotifyIdSchema.optional(),
	name: nameSchema,
	artist_names: artistNamesSchema,
	album_name: pdppSafeText.max(1000).nullable(),
	duration_ms: z.number().int().min(0).nullable(),
	popularity: z.number().int().min(0).max(100).nullable(),
	added_at: isoDateTimeSchema,
	isrc: z
		.string()
		.regex(ISRC_RE, "isrc must be a 12-char ISRC code")
		.nullable(),
	uri: spotifyUriSchema.nullable(),
	explicit: z.boolean().nullable(),
	album_artist_names: artistNamesSchema,
});

/**
 * profile stream: one singleton record for the authenticated user, from
 * GET /me.
 */
export const profileSchema = z.object({
	// Unlike track/playlist/artist ids, a Spotify user id (from GET /me) is not
	// guaranteed base-62: legacy accounts can carry ids derived from an email
	// or a linked Facebook account, so this only bounds length.
	id: z.string().min(1).max(80),
	display_name: pdppSafeText.max(1000).nullable(),
	followers: z.number().int().min(0).nullable(),
	// `spotify:user:<id>` — GET /me's own uri does not require the base-62 id
	// shape (see id's own comment), so this only checks the `spotify:user:`
	// prefix rather than reusing spotifyUriSchema's stricter id segment.
	uri: z
		.string()
		.regex(/^spotify:user:.+$/, "must be a Spotify user URI")
		.nullable(),
	images: spotifyImagesSchema,
	// Followed-artist total from GET /me/following?type=artist — the closest
	// documented "following" signal the Web API exposes (see index.ts comment
	// on collectProfile). Null when the extra call fails or is skipped.
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
	track_id: spotifyIdSchema.nullable(),
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
	id: spotifyIdSchema.optional(),
	name: nameSchema,
	genres: z.array(pdppSafeText.max(200)),
	popularity: z.number().int().min(0).max(100).nullable(),
	followers: z.number().int().min(0).nullable(),
	time_range: z.enum(["short_term", "medium_term", "long_term"]),
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
	recently_played: recentlyPlayedSchema,
	profile: profileSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

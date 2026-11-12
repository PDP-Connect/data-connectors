#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Spotify Connector (v0.1.29)
 *
 * Uses a logged-in open.spotify.com browser session and Spotify web-player
 * GraphQL endpoints. This keeps the legacy Desktop UX and avoids pasted public
 * Web API tokens that expire after roughly one hour.
 */

import { createHmac } from "node:crypto";
import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import { connectorDiagnostic } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	type EnsureSessionArgs,
	emitDetailCoverage,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	hasSpotifyEndProof,
	hasSpotifyTerminalBoundary,
	type SpotifyEndEvidence,
} from "./completion-evidence.ts";
import { validateRecord } from "./schemas.ts";
export { spotifyMobileCollect, probeSpotifyMobileSession } from "./mobile.ts";

const API = "https://api.spotify.com/v1";
const SPOTIFY_WEB_HOME = "https://open.spotify.com/";
// Only 429 and 5xx are worth a retry. A 4xx (the recently-played 404 Spotify
// began returning on 6 Nov 2026) fails the same way on every attempt.
export const spotifyRetryablePattern =
	/rate_limited|ECONN|fetch failed|retryable status (?:429|5\d\d)\b|spotify_retryable_status_(?:429|5\d\d|unknown)\b|spotify_retryable_network\b/i;

/**
 * Streams that read one source surface each. A failure on that surface fails
 * only its own stream: the other streams still export (RSS run 8553d363 lost
 * every stream to a recently-played 404). The library surface (libraryV3 and
 * fetchPlaylist) is one unit: playlists and playlist_items fail together.
 * When the failing streams are all that was asked for, the run fails as before.
 */
export const SPOTIFY_ISOLATED_STREAMS = [
	"playlists",
	"playlist_items",
	"saved_tracks",
	"recently_played_contexts",
	"top_artists",
	"top_tracks",
] as const;
export type SpotifyIsolatedStream = (typeof SPOTIFY_ISOLATED_STREAMS)[number];
/** The streams the manifest declares; every one of them, once requested, ends produced or skipped. */
const SPOTIFY_STREAMS: readonly string[] = ["profile", ...SPOTIFY_ISOLATED_STREAMS];

/**
 * Bounded, non-identifying facts about one failed stream. `endpoint` is a
 * host and path template (the username is `{user}`); `snippet` is at most 80
 * characters of the response with the username and any email removed.
 */
export interface SpotifyStreamFailure {
	code: string;
	endpoint?: string;
	status?: number;
	contentType?: string;
	snippet?: string;
}

/** What the in-page collector learned about the player, for the run log. */
export interface SpotifyCollectorDiagnostics {
	webVersion: string;
	detectedWebVersion: string | null;
	hashesFound: string[];
	hashesMissing: string[];
	hashesFromPlayerRequests: string[];
	/** Which source supplied each found hash. */
	hashSources: Record<string, "requests" | "precache" | "scripts" | "sw-manifest">;
	/** JS entries in the workbox precache; 0 on a first visit before the service worker installs. */
	precacheEntries: number;
	/** Bundles read per source in the last scan. */
	bundlesBySource: Record<string, number>;
	bundlesRead: number;
	scanAttempts: number;
	/** How the recently-played pager ended. */
	recentlyPlayed?: {
		pages: number;
		endedBy: "short_page" | "not_found_past_end" | "not_found_at_start" | "page_cap" | "failed";
	};
}

interface SpotifyImage {
	height?: number | null;
	url?: string;
	width?: number | null;
}

interface SpotifyArtist {
	followers?: { total?: number | null };
	genres?: string[];
	id?: string;
	name?: string;
	popularity?: number | null;
}

interface SpotifyAlbum {
	artists?: SpotifyArtist[];
	name?: string | null;
}

interface SpotifyTrack {
	album?: SpotifyAlbum | null;
	artists?: SpotifyArtist[];
	duration_ms?: number | null;
	explicit?: boolean | null;
	external_ids?: { isrc?: string | null };
	id?: string;
	name?: string;
	popularity?: number | null;
	uri?: string;
}

export interface SpotifyPlaylist {
	collaborative?: boolean | null;
	description?: string | null;
	followers?: { total?: number | null } | null;
	id: string;
	images?: SpotifyImage[] | null;
	name?: string;
	owner?: { id?: string; display_name?: string };
	public?: boolean | null;
	snapshot_id?: string | null;
	uri?: string;
}

interface SpotifyPlaylistItem {
	added_at?: string | null;
	added_by?: { id?: string | null } | null;
	track: SpotifyTrack | null;
}

interface SpotifyProfile {
	display_name?: string | null;
	followers?: { total?: number | null } | null;
	id?: string;
	images?: SpotifyImage[] | null;
	uri?: string;
}

export interface BrowserData {
	playlistRevisionUnproven?: boolean;
	/**
	 * Library rows the connector cannot map (folders and row types it does not
	 * know). They are skipped, not failed, and count as uncovered in the
	 * playlists and playlist_items coverage. `types` maps a bounded GraphQL type
	 * name to its row count; it never carries a URI or other row content.
	 */
	librarySkipped?: { count: number; types: Record<string, number> };
	/**
	 * Playlist rows whose `__typename` the connector does not map. Each is
	 * skipped and counted as an uncovered playlist_items row instead of failing
	 * the run. `types` holds bounded type names only, never row content.
	 */
	playlistRowsSkipped?: { count: number; types: Record<string, number> };
	completion: Partial<
		Record<"playlists" | "playlist_items" | "saved_tracks", SpotifyEndEvidence>
	>;
	playlist_items: Record<string, unknown>[];
	playlistUris: string[];
	playlists: Record<string, unknown>[];
	profile: Record<string, unknown> | null;
	recently_played_contexts: Record<string, unknown>[];
	recent_context_pages: unknown[];
	saved_tracks: Record<string, unknown>[];
	top_artists: Record<string, unknown>[];
	top_artist_pages: unknown[];
	top_tracks: Record<string, unknown>[];
	top_track_pages: unknown[];
	sourceCounts: Partial<
		Record<
			| "playlists"
			| "playlist_items"
			| "saved_tracks"
			| "profile"
			| "recently_played_contexts"
			| "top_artists"
			| "top_tracks",
			{ considered: number; covered: number }
		>
	>;
	/** Isolated streams that failed in the page; their rows are dropped. */
	streamFailures?: Partial<Record<SpotifyIsolatedStream, SpotifyStreamFailure>>;
	/**
	 * Ranked lists read to Spotify's own total in every time window (a total
	 * of at most 100, every row returned). Nothing lies beyond the request
	 * bound, so the list is complete, not capped; with a total of 0 it
	 * exports as "collected, none".
	 */
	topProvenComplete?: Partial<Record<"top_artists" | "top_tracks", { rows: number; total: number }>>;
	diagnostics?: SpotifyCollectorDiagnostics;
}

type TopTimeRange = "short_term" | "long_term";

type FieldRead<T> =
	| { kind: "READ"; value: T }
	| { kind: "EXPLICIT_EMPTY"; value: T }
	// The operation's response never carries this field (observed live), so
	// null is the contract value; a present value is still validated.
	| { kind: "NOT_CARRIED"; value: T }
	| { kind: "UNAVAILABLE"; reason: string };

function notCarried<T>(read: FieldRead<T>, value: T): FieldRead<T> {
	return read.kind === "UNAVAILABLE" && read.reason.endsWith("_missing")
		? { kind: "NOT_CARRIED", value }
		: read;
}

function readText(value: unknown, field: string): FieldRead<string | null> {
	if (value === null) {
		return { kind: "EXPLICIT_EMPTY", value: null };
	}
	if (value === undefined) {
		return { kind: "UNAVAILABLE", reason: `${field}_missing` };
	}
	return typeof value === "string" && value.length > 0
		? { kind: "READ", value }
		: { kind: "UNAVAILABLE", reason: `${field}_malformed` };
}

function readCount(value: unknown, field: string): FieldRead<number | null> {
	if (value === null) {
		return { kind: "EXPLICIT_EMPTY", value: null };
	}
	if (value === undefined) {
		return { kind: "UNAVAILABLE", reason: `${field}_missing` };
	}
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? { kind: "READ", value }
		: { kind: "UNAVAILABLE", reason: `${field}_malformed` };
}

function readStringList(value: unknown, field: string): FieldRead<string[]> {
	if (value === null) {
		return { kind: "EXPLICIT_EMPTY", value: [] };
	}
	if (value === undefined) {
		return { kind: "UNAVAILABLE", reason: `${field}_missing` };
	}
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string" || entry.length === 0)
	) {
		return { kind: "UNAVAILABLE", reason: `${field}_malformed` };
	}
	return value.length === 0
		? { kind: "EXPLICIT_EMPTY", value }
		: { kind: "READ", value };
}

function readPath(record: unknown, ...path: string[]): unknown {
	let value = record;
	for (const key of path) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return undefined;
		}
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

function readNestedText(
	record: unknown,
	containerKey: string,
	fieldKey: string,
	field: string,
): FieldRead<string | null> {
	const container = readPath(record, containerKey);
	if (container === null) {
		return { kind: "EXPLICIT_EMPTY", value: null };
	}
	if (container === undefined) {
		return { kind: "UNAVAILABLE", reason: `${field}_container_missing` };
	}
	if (typeof container !== "object" || Array.isArray(container)) {
		return { kind: "UNAVAILABLE", reason: `${field}_container_malformed` };
	}
	return readText((container as Record<string, unknown>)[fieldKey], field);
}

function readNestedCount(
	record: unknown,
	containerKey: string,
	fieldKey: string,
	field: string,
): FieldRead<number | null> {
	const container = readPath(record, containerKey);
	if (container === null) {
		return { kind: "EXPLICIT_EMPTY", value: null };
	}
	if (container === undefined) {
		return { kind: "UNAVAILABLE", reason: `${field}_container_missing` };
	}
	if (typeof container !== "object" || Array.isArray(container)) {
		return { kind: "UNAVAILABLE", reason: `${field}_container_malformed` };
	}
	return readCount((container as Record<string, unknown>)[fieldKey], field);
}

function fieldValue<T>(read: FieldRead<T>): T | null {
	return read.kind === "UNAVAILABLE" ? null : read.value;
}

function covered(...reads: FieldRead<unknown>[]): boolean {
	return reads.every((read) => read.kind !== "UNAVAILABLE");
}

export function parseRecentContextRows(payloads: unknown[]): {
	rows: Record<string, unknown>[];
	considered: number;
	withheld: number;
} {
	const rows: Record<string, unknown>[] = [];
	let considered = 0;
	let withheld = 0;
	const identities = new Set<string>();
	for (const payload of payloads) {
		const items = readPath(payload, "playContexts");
		if (!Array.isArray(items)) throw new Error("spotify_recently_played_malformed");
		for (const item of items) {
			considered += 1;
			const uri = readText(readPath(item, "uri"), "context_uri");
			const time = readCount(readPath(item, "lastPlayedTime"), "last_played_time");
			const trackUri = readText(
				readPath(item, "lastPlayedTrackUri"),
				"last_played_track_uri",
			);
			const contextUri = fieldValue(uri);
			const playedAt = fieldValue(time);
			if (!covered(uri, time, trackUri) || contextUri === null || playedAt === null) {
				withheld += 1;
				continue;
			}
			if (identities.has(contextUri)) {
				withheld += 1;
				continue;
			}
			identities.add(contextUri);
			rows.push({
				id: contextUri,
				uri: contextUri,
				last_played_time: playedAt,
				last_played_track_uri: fieldValue(trackUri),
			});
		}
	}
	return { rows, considered, withheld };
}

export function parseTopRows(payloads: unknown[], stream: "top_artists" | "top_tracks", timeRange: TopTimeRange): {
	rows: Record<string, unknown>[];
	considered: number;
	withheld: number;
} {
	const rows: Record<string, unknown>[] = [];
	let considered = 0;
	let withheld = 0;
	const identities = new Set<string>();
	const pageKey = stream === "top_artists" ? "topArtists" : "topTracks";
	let expectedTotal: number | null = null;
	for (const payload of payloads) {
		const page = readPath(payload, "data", "me", "profile", pageKey);
		const items = readPath(page, "items");
		if (!Array.isArray(items)) throw new Error(`spotify_top_content_${stream}_malformed`);
		const total = readCount(readPath(page, "totalCount"), "total_count");
		if (total.kind === "UNAVAILABLE" || total.value === null) {
			throw new Error(`spotify_top_content_${stream}_count_unverified`);
		}
		if (expectedTotal !== null && total.value !== expectedTotal) {
			throw new Error(`spotify_top_content_${stream}_count_changed`);
		}
		expectedTotal = total.value;
		for (const item of items) {
			considered += 1;
			const wrapper = item;
			const entity = readPath(wrapper, "data") ?? wrapper;
			const uri = readText(readPath(entity, "uri") ?? readPath(entity, "_uri"), "uri");
			const rawIdValue = readPath(entity, "id");
			const rawId = rawIdValue === undefined
				? { kind: "EXPLICIT_EMPTY" as const, value: null }
				: readText(rawIdValue, "id");
			const sourceId = fieldValue(rawId);
			const uriId = fieldValue(uri)?.split(":").at(-1) ?? null;
			const id = sourceId ?? uriId;
			const name = readText(
				readPath(entity, "name") ?? readPath(entity, "profile", "name"),
				"name",
			);
			const fields: FieldRead<unknown>[] = [uri, rawId, name];
			let extra: Record<string, unknown>;
			if (stream === "top_artists") {
				// Genres are not always carried (observed live); an absent key omits the
				// field, while a present malformed value is still a gap.
				const rawGenres = readPath(entity, "genres");
				const genres = rawGenres === undefined
					? { kind: "EXPLICIT_EMPTY" as const, value: [] as string[] }
					: readStringList(rawGenres, "genres");
				const followers = notCarried(readNestedCount(entity, "stats", "followers", "followers"), null);
				const popularity = notCarried(readCount(readPath(entity, "popularity"), "popularity"), null);
				fields.push(genres, followers, popularity);
				extra = {
					...(rawGenres === undefined ? {} : { genres: fieldValue(genres) }),
					followers: fieldValue(followers),
					popularity: fieldValue(popularity),
				};
			} else {
				const artistContainer = readPath(entity, "artists");
				const artistItems = readPath(entity, "artists", "items");
				const artistNames = artistContainer === null
					? { kind: "EXPLICIT_EMPTY" as const, value: [] }
					: Array.isArray(artistItems)
						? readStringList(artistItems.map((artist) => readPath(artist, "profile", "name") ?? readPath(artist, "name")), "artist_names")
						: artistContainer === undefined
							? { kind: "UNAVAILABLE" as const, reason: "artist_names_container_missing" }
							: artistItems === null
								? { kind: "EXPLICIT_EMPTY" as const, value: [] }
								: { kind: "UNAVAILABLE" as const, reason: "artist_names_malformed" };
				const albumName = readNestedText(entity, "albumOfTrack", "name", "album_name");
				const duration = notCarried(readNestedCount(entity, "trackDuration", "totalMilliseconds", "duration_ms"), null);
				fields.push(artistNames, albumName, duration);
				extra = {
					artist_names: fieldValue(artistNames),
					album_name: fieldValue(albumName),
					duration_ms: fieldValue(duration),
				};
			}
			const itemName = fieldValue(name);
			if (
				!covered(...fields) ||
				!id ||
				!itemName ||
				(sourceId !== null && uriId !== null && sourceId !== uriId)
			) {
				withheld += 1;
				continue;
			}
			const identity = `${id}\u0000${timeRange}`;
			if (identities.has(identity)) {
				withheld += 1;
				continue;
			}
			identities.add(identity);
			rows.push({ id, uri: fieldValue(uri), name: itemName, ...extra, time_range: timeRange });
		}
	}
	return { rows, considered, withheld };
}

type BrowserCollectResult = BrowserData;

/**
 * Spotify's `after` filter is strictly exclusive. Replaying the one-ms
 * boundary keeps same-timestamp plays recoverable; the composite record id
 * makes that replay idempotent at the runtime boundary.
 */
export function recentlyPlayedAfterCursor(
	lastPlayedAtUnix: number | undefined,
): number | undefined {
	if (
		lastPlayedAtUnix === undefined ||
		!Number.isFinite(lastPlayedAtUnix) ||
		lastPlayedAtUnix <= 0
	) {
		return;
	}
	return Math.floor(lastPlayedAtUnix) - 1;
}

/**
 * Normalize Spotify's absolute `next` URL to the path accepted by `sp` while
 * rejecting cross-origin or no-progress links before another request is made.
 */
export function spotifyNextPath(
	next: string | null | undefined,
	currentPath: string,
): string | null {
	if (!next) return null;
	let nextUrl: URL;
	try {
		nextUrl = new URL(next, API);
	} catch (error) {
		throw new Error("spotify_pagination_invalid_next", { cause: error });
	}
	const apiUrl = new URL(API);
	if (
		nextUrl.origin !== apiUrl.origin ||
		!nextUrl.pathname.startsWith(`${apiUrl.pathname}/`)
	) {
		throw new Error("spotify_pagination_invalid_next");
	}
	const nextPath = `${nextUrl.pathname.slice(apiUrl.pathname.length)}${nextUrl.search}`;
	if (nextPath === currentPath)
		throw new Error("spotify_pagination_no_progress");
	return nextPath;
}

export interface SpotifyCycleDetectorState {
	lambda: bigint;
	power: bigint;
	tortoise: string;
}

export function createSpotifyCycleDetector(initialPath: string): {
	observe: (path: string) => boolean;
	state: () => SpotifyCycleDetectorState;
} {
	let tortoise = initialPath;
	let power = 1n;
	let lambda = 0n;
	return {
		observe: (path) => {
			lambda += 1n;
			if (tortoise === path) return true;
			if (power === lambda) {
				tortoise = path;
				power *= 2n;
				lambda = 0n;
			}
			return false;
		},
		state: () => ({ lambda, power, tortoise }),
	};
}

function spotifyImages(
	images: SpotifyImage[] | null | undefined,
): Array<{ height: number | null; url: string; width: number | null }> {
	return (images ?? [])
		.filter(
			(img): img is SpotifyImage & { url: string } =>
				typeof img.url === "string",
		)
		.map((img) => ({
			url: img.url,
			width: img.width ?? null,
			height: img.height ?? null,
		}));
}

export function spotifyPlaylistRecord(
	p: SpotifyPlaylist,
	collectedTrackCount: number | null,
): Record<string, unknown> {
	return {
		id: p.id,
		name: p.name,
		owner_id: p.owner?.id ?? null,
		owner_name: p.owner?.display_name ?? null,
		public: p.public ?? null,
		collaborative: p.collaborative ?? null,
		track_count: collectedTrackCount,
		snapshot_id: p.snapshot_id ?? null,
		description: p.description ?? null,
		uri: p.uri ?? null,
		followers: p.followers?.total ?? null,
		images: spotifyImages(p.images),
	};
}

export function spotifyPlaylistItemRecord(
	playlistId: string,
	position: number,
	item: SpotifyPlaylistItem,
): Record<string, unknown> {
	const t = item.track;
	return {
		id: `${playlistId}:${String(position)}`,
		playlist_id: playlistId,
		track_id: t?.id ?? null,
		uri: t?.uri ?? null,
		position,
		added_at: item.added_at ?? null,
		added_by: item.added_by?.id ?? null,
		name: t?.name,
		artist_names: (t?.artists ?? []).map((a) => a.name),
		album_name: t?.album?.name ?? null,
		duration_ms: t?.duration_ms ?? null,
	};
}

export function spotifyProfileRecord(
	profile: SpotifyProfile,
	following: number | null,
): Record<string, unknown> {
	return {
		id: profile.id,
		display_name: profile.display_name ?? null,
		followers: profile.followers?.total ?? null,
		uri: profile.uri ?? null,
		images: spotifyImages(profile.images),
		following,
	};
}

async function openSpotify(page: BrowserCollectContext["page"]): Promise<void> {
	await page.goto(SPOTIFY_WEB_HOME, { waitUntil: "domcontentloaded" });
}

export function spotifyTotp(timestampMs: number): string {
	const encodedSecret = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
	const xored = encodedSecret
		.split("")
		.map((character, index) => character.charCodeAt(0) ^ ((index % 33) + 9));
	const secret = Buffer.from(xored.join(""), "utf8");
	const counter = BigInt(Math.floor(timestampMs / 1000 / 30));
	const message = Buffer.alloc(8);
	message.writeBigUInt64BE(counter);
	const signature = createHmac("sha1", secret).update(message).digest();
	const offset = (signature.at(-1) ?? 0) & 0x0f;
	const code =
		((((signature[offset] ?? 0) & 0x7f) << 24) |
			(((signature[offset + 1] ?? 0) & 0xff) << 16) |
			(((signature[offset + 2] ?? 0) & 0xff) << 8) |
			((signature[offset + 3] ?? 0) & 0xff)) %
		1000000;
	return String(code).padStart(6, "0");
}

export async function hasSpotifySession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	const request = page.context().request;
	const headers = {
		Origin: "https://open.spotify.com",
		Referer: SPOTIFY_WEB_HOME,
	};
	let serverTime: number | null = null;
	try {
		const timeResponse = await request.get(
			"https://open.spotify.com/api/server-time",
			{ headers, timeout: 10_000 },
		);
		try {
			const timeData = (await timeResponse.json()) as {
				serverTime?: unknown;
			};
			const parsed = Number(timeData.serverTime);
			serverTime = Number.isFinite(parsed) ? parsed : null;
		} finally {
			await timeResponse.dispose();
		}
	} catch {
		// The same token request below can still succeed without server time.
	}

	const now = Date.now();
	const params = new URLSearchParams({
		reason: "init",
		productType: "web_player",
		totp: spotifyTotp(now),
		totpServer: serverTime ? spotifyTotp(serverTime * 1000) : "unavailable",
		totpVer: "61",
	});
	try {
		const tokenResponse = await request.get(
			`https://open.spotify.com/api/token?${params.toString()}`,
			{ headers, timeout: 10_000 },
		);
		try {
			const tokenData = (await tokenResponse.json()) as {
				accessToken?: unknown;
				isAnonymous?: unknown;
			};
			return Boolean(
				tokenResponse.ok() && tokenData.accessToken && !tokenData.isAnonymous,
			);
		} finally {
			await tokenResponse.dispose();
		}
	} catch {
		return false;
	}
}

async function ensureSpotifySession({
	assist,
	capture,
	completeAssistance,
	page,
	sendInteraction,
}: EnsureSessionArgs): Promise<void> {
	if (await hasSpotifySession(page)) return;
	await page.goto(
		"https://accounts.spotify.com/en/login?continue=https%3A%2F%2Fopen.spotify.com%2F",
		{ waitUntil: "domcontentloaded" },
	);
	const ready = await manualBrowserLogin({
		assist,
		capture,
		completeAssistance,
		isProbeSuccessful: (ok) => ok === true,
		message:
			"Sign in to Spotify in the secure browser, then continue. Collection starts once the session is verified.",
		page,
		probe: () => hasSpotifySession(page),
		readinessProbe: hasSpotifySession,
		readinessProbeOnHandoffPage: true,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) throw new Error("spotify_session_dead");
}

/**
 * Runs inside the Spotify page via `page.evaluate`, so it must be
 * self-contained: it is serialized with `toString()`.
 */
export const spotifyPageCollector = async (
	requested: string[],
	fetch: typeof globalThis.fetch = globalThis.fetch,
	seededHashes: Record<string, string> = {},
): Promise<BrowserData> => {
		const wanted = new Set(requested);
		const result: BrowserData = {
			streamFailures: {},
			completion: {},
			profile: null,
			playlistUris: [],
			playlists: [],
			playlist_items: [],
			recently_played_contexts: [],
			recent_context_pages: [],
			saved_tracks: [],
			top_artists: [],
			top_artist_pages: [],
			top_tracks: [],
			top_track_pages: [],
			sourceCounts: {},
		};
		const navigation = new URL(window.location.href);
		// Spotify serves the player root at a locale prefix (`/intl-id/`,
		// `/intl-pt/`) for most non-English markets and redirects `/` there on
		// every load, so that root is the player too, never a transient state.
		if (
			navigation.origin !== "https://open.spotify.com" ||
			!/^\/(?:intl-[a-z]{2}(?:-[a-z0-9]{2,8})?\/?)?$/i.test(navigation.pathname) ||
			navigation.search !== "" ||
			navigation.hash !== ""
		) {
			throw new Error("spotify_page_not_player");
		}
		const navigationProof = navigation.origin + "/";
		const webVersion = "1.2.56.244.g7bfe3dc8";
		let clientId: string | null = null;
		const versionPattern = /\b(1\.2\.\d+\.\d+\.g[0-9a-f]{6,12})\b/;
		let detectedWebVersion: string | null = null;
		const diagnostics: NonNullable<BrowserData["diagnostics"]> = {
			webVersion,
			detectedWebVersion: null,
			hashesFound: [],
			hashesMissing: [],
			hashesFromPlayerRequests: [],
			hashSources: {},
			precacheEntries: 0,
			bundlesBySource: {},
			bundlesRead: 0,
			scanAttempts: 0,
		};
		result.diagnostics = diagnostics;

		// A failed isolated stream keeps only bounded facts: the endpoint as a
		// host and path template, the status, the content type and a short
		// snippet with the username and anything shaped like an email removed.
		function failStream(
			stream: SpotifyIsolatedStream,
			error: unknown,
			detail: Omit<SpotifyStreamFailure, "code"> = {},
		): void {
			const message = error instanceof Error ? error.message : String(error);
			const name = error instanceof Error ? error.name : "";
			// A browser network failure ("Failed to fetch", "Load failed",
			// "NetworkError ...") is a TypeError; the mobile bridge's 12 s deadline
			// is an AbortError. Both can pass on a later run.
			const network =
				name === "TypeError" ||
				name === "AbortError" ||
				name === "TimeoutError" ||
				/failed to fetch|load failed|networkerror|network request failed|aborted|timed? ?out/i.test(message);
			const code =
				/^spotify_[a-z0-9_,]+/i.exec(message)?.[0] ??
				(network ? "spotify_retryable_network" : "spotify_stream_failed");
			result.streamFailures = result.streamFailures ?? {};
			result.streamFailures[stream] = { code, ...detail };
		}
		function safeSnippet(text: string, username: string | null): string {
			// Mask the whole (bounded) body first, then cut, so a cut can never
			// leave part of a username, email or token behind.
			let cleaned = text.slice(0, 16_384);
			if (username) cleaned = cleaned.split(username).join("{user}");
			cleaned = cleaned
				.replace(/[^\s"'<>@]+@[^\s"'<>@]+/g, "{email}")
				.replace(/[A-Za-z0-9_-]{24,}/g, "{token}")
				.replace(/\s+/g, " ")
				.trim();
			return cleaned.slice(0, 80);
		}

		function idFromUri(uri: unknown): string | null {
			if (typeof uri !== "string") return null;
			const parts = uri.split(":");
			const id = parts.length >= 3 ? parts[parts.length - 1] : null;
			return typeof id === "string" && id.length > 0 ? id : null;
		}

		function isRecord(value: unknown): value is Record<string, unknown> {
			return (
				typeof value === "object" && value !== null && !Array.isArray(value)
			);
		}

		function sourceContainer(
			value: unknown,
			field: string,
			prefix: string,
		): Record<string, unknown> | null {
			if (value === undefined) {
				throw new Error(`${prefix}_field_unavailable:${field}_missing`);
			}
			if (value === null) return null;
			if (!isRecord(value)) {
				throw new Error(`${prefix}_field_unavailable:${field}_malformed`);
			}
			return value;
		}

		// A child of an explicitly null container is explicitly null; a child
		// that is absent from a present container stays undefined (a gap).
		function child(
			container: Record<string, unknown> | null,
			key: string,
		): unknown {
			return container === null ? null : container[key];
		}

		function isFieldUnavailable(error: unknown, prefix: string): boolean {
			return (
				error instanceof Error &&
				error.message.startsWith(`${prefix}_field_unavailable:`)
			);
		}

		function spotifyTrackId(
			uri: unknown,
			sourceId: unknown,
			fieldPrefix: string,
		): string | null {
			const parts = typeof uri === "string" ? uri.split(":") : [];
			const uriId =
				parts.length === 3 && parts[0] === "spotify" && parts[1] === "track"
					? parts[2] || null
					: null;
			if (typeof uri === "string" && uri.length > 0 && uriId === null) return null;
			const sourceTrackId =
				typeof sourceId === "string" && sourceId.length > 0 ? sourceId : null;
			if (uriId !== null && sourceTrackId !== null && uriId !== sourceTrackId) {
				throw new Error(`${fieldPrefix}_field_unavailable:identity_conflict`);
			}
			return uriId ?? sourceTrackId;
		}

		async function localTrackId(uri: string): Promise<string> {
			const digest = new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode(uri)),
			);
			return `local:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		}

		type SourceFieldRead<T> =
			| { kind: "READ"; value: T }
			| { kind: "EXPLICIT_EMPTY"; value: T }
			| { kind: "UNAVAILABLE"; reason: string };

		function readField<T>(
			value: unknown,
			field: string,
			isValid: (candidate: unknown) => candidate is T,
			emptyValue: T,
		): SourceFieldRead<T> {
			if (value === undefined) {
				return { kind: "UNAVAILABLE", reason: `${field}_missing` };
			}
			if (value === null) {
				return { kind: "EXPLICIT_EMPTY", value: emptyValue };
			}
			return isValid(value)
				? { kind: "READ", value }
				: { kind: "UNAVAILABLE", reason: `${field}_malformed` };
		}

		function requireField<T>(
			read: SourceFieldRead<T>,
			prefix = "spotify_saved_tracks",
		): T {
			if (read.kind === "UNAVAILABLE") {
				throw new Error(`${prefix}_field_unavailable:${read.reason}`);
			}
			return read.value;
		}

		function readString(
			value: unknown,
			field: string,
		): SourceFieldRead<string | null> {
			return readField(
				value,
				field,
				(candidate): candidate is string => typeof candidate === "string",
				null,
			);
		}

		function readCount(
			value: unknown,
			field: string,
		): SourceFieldRead<number | null> {
			return readField(
				value,
				field,
				(candidate): candidate is number =>
					typeof candidate === "number" &&
					Number.isSafeInteger(candidate) &&
					candidate >= 0,
				null,
			);
		}

		function readBoolean(
			value: unknown,
			field: string,
		): SourceFieldRead<boolean | null> {
			return readField(
				value,
				field,
				(candidate): candidate is boolean => typeof candidate === "boolean",
				null,
			);
		}

		function readPopularity(value: unknown): SourceFieldRead<number | null> {
			return readField(
				value,
				"track_popularity",
				(candidate): candidate is number =>
					typeof candidate === "number" &&
					Number.isSafeInteger(candidate) &&
					candidate >= 0 &&
					candidate <= 100,
				null,
			);
		}

		function readPageOffset(
			page: unknown,
			requestedOffset: number,
			field: string,
		): void {
			if (!isRecord(page)) {
				throw new Error(`${field}_response_invalid`);
			}
			const pagingInfo =
					page.pagingInfo === undefined
						? null
						: sourceContainer(page.pagingInfo, "paging_info", field);
			const directOffset = page.offset;
			const nestedOffset = pagingInfo?.offset;
			if (
				directOffset !== undefined &&
				nestedOffset !== undefined &&
				directOffset !== nestedOffset
			) {
				throw new Error(`${field}_offset_unverified`);
			}
			const responseOffset =
				directOffset !== undefined ? directOffset : nestedOffset;
			if (
				!Number.isSafeInteger(responseOffset) ||
				responseOffset !== requestedOffset
			) {
				throw new Error(`${field}_offset_unverified`);
			}
		}

		function count(value: unknown): number | null {
			return typeof value === "number" &&
				Number.isSafeInteger(value) &&
				value >= 0
				? value
				: null;
		}

		function imageRecords(
			images: unknown,
		): SourceFieldRead<Array<{ height: null; url: string; width: null }>> {
			if (images === undefined) {
				return { kind: "UNAVAILABLE", reason: "playlist_images_missing" };
			}
			if (images === null) {
				return { kind: "EXPLICIT_EMPTY", value: [] };
			}
			if (!isRecord(images)) {
				return { kind: "UNAVAILABLE", reason: "playlist_images_malformed" };
			}
			const items = (images as Record<string, unknown>).items;
			if (!Array.isArray(items)) {
				return { kind: "UNAVAILABLE", reason: "playlist_images_malformed" };
			}
			const records: Array<{ height: null; url: string; width: null }> = [];
			for (const image of items) {
				if (!isRecord(image)) {
					return {
						kind: "UNAVAILABLE",
						reason: "playlist_image_row_malformed",
					};
				}
				const sources = (image as Record<string, unknown>).sources;
				if (!Array.isArray(sources)) {
					return {
						kind: "UNAVAILABLE",
						reason: "playlist_image_sources_malformed",
					};
				}
				if (sources.length === 0) continue;
				const first = sources[0];
				if (!isRecord(first)) {
					return {
						kind: "UNAVAILABLE",
						reason: "playlist_image_source_malformed",
					};
				}
				const url = (first as Record<string, unknown>).url;
				if (typeof url !== "string") {
					return {
						kind: "UNAVAILABLE",
						reason: "playlist_image_url_malformed",
					};
				}
				records.push({ url, width: null, height: null });
			}
			return records.length === 0
				? { kind: "EXPLICIT_EMPTY", value: records }
				: { kind: "READ", value: records };
		}

		function sourceArtistNames(
			value: unknown,
			field: string,
		): SourceFieldRead<string[]> {
			if (value === undefined) {
				return { kind: "UNAVAILABLE", reason: `${field}_missing` };
			}
			if (value === null) {
				return { kind: "EXPLICIT_EMPTY", value: [] };
			}
			if (!Array.isArray(value))
				return { kind: "UNAVAILABLE", reason: `${field}_malformed` };
			const names: string[] = [];
			for (const entry of value) {
				if (!isRecord(entry))
					return { kind: "UNAVAILABLE", reason: `${field}_row_malformed` };
				const profile = (entry as Record<string, unknown>).profile;
				if (!isRecord(profile))
					return { kind: "UNAVAILABLE", reason: `${field}_profile_malformed` };
				const name = (profile as Record<string, unknown>).name;
				if (typeof name !== "string")
					return { kind: "UNAVAILABLE", reason: `${field}_name_malformed` };
				names.push(name);
			}
			return names.length === 0
				? { kind: "EXPLICIT_EMPTY", value: names }
				: { kind: "READ", value: names };
		}

		function sourceArtists(
			value: unknown,
			field: string,
		): SourceFieldRead<string[]> {
			if (value === undefined) {
				return { kind: "UNAVAILABLE", reason: `${field}_container_missing` };
			}
			if (value === null) {
				return { kind: "EXPLICIT_EMPTY", value: [] };
			}
			if (!isRecord(value) || !Array.isArray(value.items)) {
				return { kind: "UNAVAILABLE", reason: `${field}_container_malformed` };
			}
			return sourceArtistNames(value.items, field);
		}

		function pageSignature(items: unknown[]): string {
			return JSON.stringify(items);
		}

		async function accessToken(): Promise<string> {
			let serverTime: number | null = null;
			try {
				const stResp = await fetch("/api/server-time");
				const stData = await stResp.json();
				const parsed = Number(stData.serverTime);
				serverTime = Number.isFinite(parsed) ? parsed : null;
			} catch {}
			const totpSecret = ',7/*F("rLJ2oxaKL^f+E1xvP@N';
			const xored = totpSecret
				.split("")
				.map((c, i) => c.charCodeAt(0) ^ ((i % 33) + 9));
			const joined = xored.join("");
			const secretHex = Array.from(new TextEncoder().encode(joined))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			async function genTOTP(
				hexSecret: string,
				timestampMs: number,
			): Promise<string> {
				const counter = Math.floor(timestampMs / 1000 / 30);
				const buf = new ArrayBuffer(8);
				const v = new DataView(buf);
				v.setUint32(0, Math.floor(counter / 0x100000000));
				v.setUint32(4, counter & 0xffffffff);
				const bytes = hexSecret.match(/.{1,2}/g) || [];
				const kb = new Uint8Array(bytes.map((b) => Number.parseInt(b, 16)));
				const key = await crypto.subtle.importKey(
					"raw",
					kb,
					{ name: "HMAC", hash: "SHA-1" },
					false,
					["sign"],
				);
				const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, buf));
				const o = (sig.at(-1) ?? 0) & 0x0f;
				const code =
					((((sig[o] ?? 0) & 0x7f) << 24) |
						(((sig[o + 1] ?? 0) & 0xff) << 16) |
						(((sig[o + 2] ?? 0) & 0xff) << 8) |
						((sig[o + 3] ?? 0) & 0xff)) %
					1000000;
				return String(code).padStart(6, "0");
			}
			const now = Date.now();
			const params = new URLSearchParams({
				reason: "init",
				productType: "web_player",
				totp: await genTOTP(secretHex, now),
				totpServer: serverTime
					? await genTOTP(secretHex, serverTime * 1000)
					: "unavailable",
				totpVer: "61",
			});
			const tokenResp = await fetch(`/api/token?${params.toString()}`, {
				credentials: "include",
			});
			const tokenData = await tokenResp.json();
			if (!tokenResp.ok || !tokenData.accessToken || tokenData.isAnonymous) {
				throw new Error(`spotify_access_token_${tokenResp.status}`);
			}
			clientId = tokenData.clientId || null;
			return tokenData.accessToken;
		}

		async function clientToken(): Promise<string> {
			const resp = await fetch(
				"https://clienttoken.spotify.com/v1/clienttoken",
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
					},
					body: JSON.stringify({
						client_data: {
							client_version: webVersion,
							client_id: clientId,
							js_sdk_data: {
								device_brand: "unknown",
								device_model: "unknown",
								device_type: "computer",
								os: "macos",
								os_version: "unknown",
							},
						},
					}),
				},
			);
			const data = await resp.json();
			if (!resp.ok || !data.granted_token?.token)
				throw new Error(`spotify_client_token_${resp.status}`);
			return data.granted_token.token;
		}

		async function queryHashes(): Promise<Record<string, string>> {
			const needed = new Set<string>();
			if (wanted.has("profile")) needed.add("profileAttributes");
			if (wanted.has("recently_played_contexts")) needed.add("profileAttributes");
			if (wanted.has("top_artists") || wanted.has("top_tracks")) {
				needed.add("userTopContent");
			}
			if (wanted.has("playlists") || wanted.has("playlist_items")) {
				needed.add("libraryV3");
				needed.add("fetchPlaylist");
			}
			if (wanted.has("saved_tracks")) needed.add("fetchLibraryTracks");
			// The ranked lists are the only streams that need userTopContent, and
			// some players never ship it (RSS: `spotify_missing_hashes_userTopContent`
			// alone). Missing it fails top_artists and top_tracks, not the run,
			// unless they are all that was asked for.
			const optional = new Set<string>();
			if (
				needed.has("userTopContent") &&
				[...wanted].some((stream) => stream !== "top_artists" && stream !== "top_tracks")
			) {
				optional.add("userTopContent");
			}
			// Hashes the player itself sent to pathfinder in this session are the
			// ones it is using now, so they are taken as found. They come from the
			// host's request events (desktop and RSS native) and from the in-page
			// listener below (every host), and are read again before each scan.
			const seeded: Record<string, string> = {};
			const refreshSeeded = () => {
				notePerformance();
				for (const [name, hash] of Object.entries(playerHashes)) {
					if (needed.has(name) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) {
						seeded[name] = hash;
					}
				}
				diagnostics.hashesFromPlayerRequests = Object.keys(seeded).sort();
			};
			refreshSeeded();
			// Each source has its own budget. With one shared budget a fresh
			// session's ~70 loaded scripts used it all, so the service-worker
			// chunk list (the only place the lazy profile chunk with
			// userTopContent is named when the precache is still empty) was
			// never read.
			type HashSource = "precache" | "scripts" | "sw-manifest";
			const maxBundles = 60;
			const maxBundleBytes = 48 * 1024 * 1024;
			// Persisted-query definitions in the player bundles. The minifier has
			// shipped `new a.b("name","query","<sha>")`; the call shape below also
			// takes a bare or deeper constructor, single quotes, spaces and extra
			// arguments. The object shape takes `{name:"x",...sha256Hash:"<sha>"}`.
			const hashPatterns = [
				/\(\s*["'`](\w+)["'`]\s*,\s*["'`](?:query|mutation)["'`]\s*,\s*["'`]([a-f0-9]{64})["'`]/g,
				/\b(?:operationName|name)\s*:\s*["'`](\w+)["'`][^{}]{0,160}?\bsha256Hash\s*:\s*["'`]([a-f0-9]{64})["'`]/g,
			];
			const complete = (found: Record<string, string>) =>
				[...needed].every(
					(name) => typeof found[name] === "string" || optional.has(name),
				) && [...optional].every((name) => typeof found[name] === "string");
			async function scan(): Promise<Record<string, string>> {
				const found: Record<string, string> = { ...seeded };
				const sources: Record<string, string> = {};
				for (const name of Object.keys(seeded)) sources[name] = "requests";
				const spent: Record<HashSource, { bundles: number; bytes: number }> = {
					precache: { bundles: 0, bytes: 0 },
					scripts: { bundles: 0, bytes: 0 },
					"sw-manifest": { bundles: 0, bytes: 0 },
				};
				let source: HashSource = "precache";
				const exhausted = () =>
					spent[source].bundles >= maxBundles || spent[source].bytes >= maxBundleBytes;
				const finish = () => {
					diagnostics.hashSources = { ...sources } as SpotifyCollectorDiagnostics["hashSources"];
					diagnostics.bundlesBySource = {
						precache: spent.precache.bundles,
						scripts: spent.scripts.bundles,
						"sw-manifest": spent["sw-manifest"].bundles,
					};
					diagnostics.bundlesRead =
						spent.precache.bundles + spent.scripts.bundles + spent["sw-manifest"].bundles;
					return found;
				};
				const extract = (text: string) => {
					if (detectedWebVersion === null) {
						const version = versionPattern.exec(text)?.[1];
						if (version) detectedWebVersion = version;
					}
					for (const pattern of hashPatterns) {
						const re = new RegExp(pattern.source, "g");
						let match = re.exec(text);
						while (match !== null) {
							const operation = match[1];
							const hash = match[2];
							if (
								operation &&
								hash &&
								needed.has(operation) &&
								typeof found[operation] !== "string"
							) {
								found[operation] = hash;
								sources[operation] = source;
							}
							match = re.exec(text);
						}
					}
				};
				const read = async (response: Response | undefined | null) => {
					if (!response || exhausted()) return;
					spent[source].bundles += 1;
					const remainingBytes = maxBundleBytes - spent[source].bytes;
					const declaredLength = response.headers.get("content-length");
					const declaredBytes =
						declaredLength === null ? -1 : Number(declaredLength);
					if (Number.isFinite(declaredBytes) && declaredBytes > remainingBytes)
						return;
					const reader = response.body?.getReader();
					if (!reader) return;
					const chunks: Uint8Array[] = [];
					let bytes = 0;
					while (true) {
						const part = await reader.read();
						if (part.done) break;
						bytes += part.value.byteLength;
						if (bytes > remainingBytes) {
							await reader.cancel();
							return;
						}
						chunks.push(part.value);
					}
					const joined = new Uint8Array(bytes);
					let offset = 0;
					for (const chunk of chunks) {
						joined.set(chunk, offset);
						offset += chunk.byteLength;
					}
					spent[source].bytes += bytes;
					extract(new TextDecoder().decode(joined));
				};
				try {
					const names = await caches.keys();
					for (const cacheName of names.filter((name) =>
						name.includes("workbox-precache"),
					)) {
						const cache = await caches.open(cacheName);
						const entries = (await cache.keys())
							.filter((req) => req.url.endsWith(".js"))
							.map((req, index) => ({ req, index }));
						diagnostics.precacheEntries += entries.length;
						const sized = await Promise.all(
							entries.map(async (entry) => {
								const response = await cache.match(entry.req);
								const contentLength = response?.headers.get("content-length");
								const size =
									contentLength === null || contentLength === undefined
										? -1
										: Number(contentLength);
								return {
									...entry,
									response,
									size: Number.isFinite(size) ? size : -1,
								};
							}),
						);
						sized.sort((a, b) => b.size - a.size || a.index - b.index);
						for (const entry of sized) {
							await read(entry.response);
							if (complete(found)) return finish();
							if (exhausted()) break;
						}
					}
				} catch {}
				if (complete(found)) return finish();
				source = "scripts";
				const scripts = [
					...Array.from(document.querySelectorAll("script[src]")).map(
						(s) => (s as HTMLScriptElement).src,
					),
					...performance
						.getEntriesByType("resource")
						.filter(
							(e) =>
								(e as PerformanceResourceTiming).initiatorType === "script" &&
								e.name.endsWith(".js"),
						)
						.map((e) => e.name),
				].filter(
					(url, index, all) =>
						url.includes("spotify") && all.indexOf(url) === index,
				);
				for (const url of scripts) {
					if (exhausted()) break;
					try {
						const response = await fetch(url);
						if (response.ok) await read(response);
						if (complete(found)) return finish();
					} catch {}
				}
				source = "sw-manifest";
				// Some operations (userTopContent) live only in lazily loaded route
				// chunks that the home page never loads. Desktop browsers have them
				// in the workbox precache above, but a WebView without service
				// workers (iOS WKWebView outside app-bound domains) has no precache
				// at all. The service worker script itself is a plain same-origin
				// file that lists every precached chunk, so read the chunk URLs
				// from it and scan the ones whose names match a missing operation
				// first.
				let precacheUrls: string[] = [];
				try {
					const response = await fetch("/service-worker.js");
					if (response.ok) {
						const source = await response.text();
						const urlPattern =
							/["']?url["']?\s*:\s*["'](https:\/\/[\w.-]*spotifycdn\.com\/[^"'\s]+\.js)["']/g;
						precacheUrls = Array.from(
							source.matchAll(urlPattern),
							(match) => match[1] ?? "",
						).filter(
							(url, index, all) =>
								url !== "" &&
								!scripts.includes(url) &&
								all.indexOf(url) === index,
						);
					}
				} catch {}
				const chunkHints: Record<string, string[]> = {
					userTopContent: ["profile"],
					profileAttributes: ["profile"],
					libraryV3: ["library"],
					fetchPlaylist: ["playlist"],
					fetchLibraryTracks: ["collection-songs", "library"],
				};
				const hints = [...needed]
					.filter((name) => typeof found[name] !== "string")
					.flatMap((name) => chunkHints[name] ?? []);
				const hinted = (url: string) => {
					const file = url.slice(url.lastIndexOf("/") + 1);
					return hints.some((hint) => file.includes(hint));
				};
				precacheUrls.sort(
					(a, b) => Number(hinted(b)) - Number(hinted(a)),
				);
				for (const url of precacheUrls) {
					if (exhausted()) break;
					try {
						const response = await fetch(url);
						if (response.ok) await read(response);
						if (complete(found)) return finish();
					} catch {}
				}
				return finish();
			}
			let found: Record<string, string> = {};
			const record = () => {
				diagnostics.scanAttempts += 1;
				diagnostics.detectedWebVersion = detectedWebVersion;
				diagnostics.hashesFound = [...needed].filter((name) => typeof found[name] === "string").sort();
				diagnostics.hashesMissing = [...needed].filter((name) => typeof found[name] !== "string").sort();
			};
			for (let attempt = 0; attempt < 3; attempt += 1) {
				diagnostics.precacheEntries = 0;
				refreshSeeded();
				found = await scan();
				record();
				if (complete(found)) return found;
				if (attempt < 2)
					await new Promise((resolve) => setTimeout(resolve, 3000));
			}
			const missing = [...needed].filter(
				(name) => typeof found[name] !== "string",
			);
			if (missing.every((name) => optional.has(name))) {
				for (const stream of ["top_artists", "top_tracks"] as const) {
					if (wanted.has(stream)) {
						failStream(stream, new Error(`spotify_missing_hashes_${missing.join(",")}`));
					}
				}
				return found;
			}
			// Bounded, non-identifying context for the run log: operation names,
			// how many bundles were read, and the player version if one was seen.
			throw new Error(
				`spotify_missing_hashes_${missing.join(",")} found=${diagnostics.hashesFound.join(",") || "none"} seeded=${diagnostics.hashesFromPlayerRequests.length} bundles=${diagnostics.bundlesRead} webVersion=${detectedWebVersion ?? "unknown"}`,
			);
		}

		// Listen to the player's own pathfinder requests while the token calls
		// and the bundle scans run: the player keeps loading after
		// domcontentloaded, and a fresh session may have no precache at all.
		// The page's fetch is wrapped transparently and restored afterwards.
		const playerHashes: Record<string, string> = { ...(seededHashes ?? {}) };
		const pathfinderPattern = /^https:\/\/api-partner\.spotify\.com\/pathfinder\/v\d+\/query/;
		const notePathfinder = (url: string, body: unknown) => {
			if (!pathfinderPattern.test(url)) return;
			let operation: unknown = null;
			let extensions: unknown = null;
			if (typeof body === "string") {
				const parsed = JSON.parse(body) as { operationName?: unknown; extensions?: unknown };
				operation = parsed.operationName;
				extensions = parsed.extensions;
			} else {
				const query = new URL(url).searchParams;
				operation = query.get("operationName");
				const raw = query.get("extensions");
				extensions = raw ? JSON.parse(raw) : null;
			}
			const hash = (extensions as { persistedQuery?: { sha256Hash?: unknown } } | null)
				?.persistedQuery?.sha256Hash;
			if (
				typeof operation === "string" &&
				/^\w{1,80}$/.test(operation) &&
				typeof hash === "string" &&
				/^[a-f0-9]{64}$/.test(hash) &&
				typeof playerHashes[operation] !== "string"
			) {
				playerHashes[operation] = hash;
			}
		};
		const pageScope = globalThis as unknown as { fetch?: typeof globalThis.fetch };
		const pageFetch = pageScope.fetch;
		let listening: typeof globalThis.fetch | null = null;
		const notePerformance = () => {
			try {
				for (const entry of performance.getEntriesByType("resource")) {
					try {
						notePathfinder(entry.name, null);
					} catch {}
				}
			} catch {}
		};
		if (typeof pageFetch === "function") {
			try {
				const wrapper = function (this: unknown, ...args: Parameters<typeof globalThis.fetch>) {
					try {
						const [input, init] = args;
						const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request)?.url;
						if (typeof url === "string") notePathfinder(url, init?.body);
					} catch {}
					return pageFetch.apply(this, args);
				} as typeof globalThis.fetch;
				pageScope.fetch = wrapper;
				listening = wrapper;
			} catch {}
		}
		let access: string;
		let client: string;
		let hashes: Record<string, string>;
		try {
			notePerformance();
			access = await accessToken();
			client = await clientToken();
			notePerformance();
			hashes = await queryHashes();
		} finally {
			if (listening) {
				try {
					// Only undo our own wrapper; never replace a later one.
					if (pageScope.fetch === listening && pageFetch) pageScope.fetch = pageFetch;
				} catch {}
			}
		}
		async function gql(
			operationName: string,
			variables: Record<string, unknown>,
		): Promise<any> {
			const hash = hashes[operationName];
			if (!hash) throw new Error(`spotify_missing_hash_${operationName}`);
			const request = {
				method: "POST",
				headers: {
					authorization: `Bearer ${access}`,
					"client-token": client,
					"content-type": "application/json",
					accept: "application/json",
					"app-platform": "WebPlayer",
					"spotify-app-version": webVersion,
				},
				body: JSON.stringify({
					operationName,
					variables,
					extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
				}),
			};
			const maxAttempts = 3;
			const maxRetryDelayMs = 30_000;
			for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
				const resp = await fetch(
					"https://api-partner.spotify.com/pathfinder/v2/query",
					request,
				);
				if (resp.ok) {
					const data = await resp.json();
					if (data.errors)
						throw new Error(`spotify_graphql_${operationName}_errors`);
					return data;
				}
				const retryable = resp.status === 429 || resp.status >= 500;
				if (!retryable) {
					throw new Error(`spotify_graphql_${operationName}_${resp.status}`);
				}
				if (attempt === maxAttempts - 1) {
					throw new Error(`spotify_retryable_status_${resp.status}`);
				}
				const retryAfter = resp.headers.get("retry-after");
				const retryAfterSeconds =
					retryAfter === null ? NaN : Number(retryAfter);
				const retryAfterDate =
					retryAfter === null ? NaN : Date.parse(retryAfter);
				const retryAfterMs = Number.isFinite(retryAfterSeconds)
					? retryAfterSeconds * 1000
					: retryAfterDate - Date.now();
				const fallbackDelayMs = 1000 * 2 ** attempt;
				const delayMs = Math.min(
					maxRetryDelayMs,
					Number.isFinite(retryAfterMs) && retryAfterMs >= 0
						? retryAfterMs
						: fallbackDelayMs,
				);
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			throw new Error("spotify_retryable_status_unknown");
		}

		if (wanted.has("profile")) {
			result.sourceCounts.profile = { considered: 1, covered: 0 };
			try {
				const attrs = await gql("profileAttributes", {});
				const pa = sourceContainer(
					attrs?.data?.me?.profile,
					"profile",
					"spotify_profile",
				);
				if (!pa)
					throw new Error("spotify_profile_field_unavailable:profile_missing");
				const username = requireField(
					readString(pa.username, "profile_username"),
					"spotify_profile",
				);
				if (!username)
					throw new Error("spotify_profile_field_unavailable:username_missing");
				const profileName = requireField(
					readString(pa.name, "profile_name"),
					"spotify_profile",
				);
				const sourceUri = requireField(
					readString(pa.uri, "profile_uri"),
					"spotify_profile",
				);
				const identityUri = sourceUri ?? `spotify:user:${username}`;
				let enrichment: unknown = null;
				let enrichmentAvailable = false;
				try {
					const enriched = await fetch(
						`https://spclient.wg.spotify.com/user-profile-view/v3/profile/${encodeURIComponent(username)}`,
						{
							headers: {
								authorization: `Bearer ${access}`,
								"client-token": client,
								accept: "application/json",
								"app-platform": "WebPlayer",
							},
						},
					);
					if (!enriched.ok) {
						throw new Error("spotify_profile_enrichment_http_status");
					}
					enrichment = await enriched.json();
					enrichmentAvailable = true;
				} catch {}
				if (!enrichmentAvailable) {
					throw new Error(
						"spotify_profile_field_unavailable:enrichment_unavailable",
					);
				}
				const enrichmentRecord = sourceContainer(
					enrichment,
					"enrichment",
					"spotify_profile",
				);
				if (!enrichmentRecord) {
					throw new Error(
						"spotify_profile_field_unavailable:enrichment_missing",
					);
				}
				if (enrichmentRecord.uri !== identityUri) {
					throw new Error(
						"spotify_profile_field_unavailable:enrichment_identity_mismatch",
					);
				}
				// Either source may carry the image. Absent from both asserts nothing
				// (omit `images`); an explicit null from either, with no URL from
				// either, is the source saying "no image" (`images: []`). A URL from
				// either source wins; a malformed value is still a gap.
				const imageReads = [
					readString(pa.imageUrl, "profile_image_url"),
					readString(
						enrichmentRecord.image_url,
						"profile_enrichment_image_url",
					),
				];
				for (const read of imageReads) {
					if (read.kind === "UNAVAILABLE" && !read.reason.endsWith("_missing")) {
						requireField(read, "spotify_profile");
					}
				}
				const imageUrl =
					imageReads
						.map((read) => (read.kind === "UNAVAILABLE" ? null : read.value))
						.find((value) => value !== null) ?? null;
				const imageExplicitlyEmpty = imageReads.some(
					(read) => read.kind === "EXPLICIT_EMPTY",
				);
				// The enrichment payload omits a zero count (observed live), so an
				// absent count is unknown (null), not a gap; a present one is checked.
				const followers = Object.hasOwn(enrichmentRecord, "followers_count")
					? requireField(
							readCount(enrichmentRecord.followers_count, "profile_followers"),
							"spotify_profile",
						)
					: null;
				const following = Object.hasOwn(enrichmentRecord, "following_count")
					? requireField(
							readCount(enrichmentRecord.following_count, "profile_following"),
							"spotify_profile",
						)
					: null;
				result.profile = {
					id: username,
					display_name: profileName,
					followers,
					uri: identityUri,
					...(imageUrl !== null
						? { images: [{ url: imageUrl, width: null, height: null }] }
						: imageExplicitlyEmpty
							? { images: [] }
							: {}),
					following,
				};
				result.sourceCounts.profile = { considered: 1, covered: 1 };
			} catch (error) {
				if (!isFieldUnavailable(error, "spotify_profile")) throw error;
				result.profile = null;
			}
		}

		// A stream group fails alone when anything else was asked for; when it is
		// all that was asked for, its error fails the run as before.
		const othersWanted = (group: readonly string[]) =>
			[...wanted].some((stream) => !group.includes(stream));
		const playlistGroup = ["playlists", "playlist_items"] as const;

		if (wanted.has("playlists") || wanted.has("playlist_items")) {
			try {
			const playlistUris: string[] = [];
			let playlistRowSkippedCount = 0;
			const playlistRowSkippedTypes: Record<string, number> = {};
			let libraryOffset = 0;
			const libraryLimit = 200;
			const libraryPageSignatures = new Set<string>();
			const libraryIdentities = new Set<string>();
			let libraryRawCount = 0;
			let libraryExpectedCount: number | null = null;
			let libraryPageCount = 0;
			let libraryTerminal: SpotifyEndEvidence["terminal"] = null;
			let librarySkippedCount = 0;
			const librarySkippedTypes: Record<string, number> = {};
			while (true) {
				const requestOffset = libraryOffset;
				const libData = await gql("libraryV3", {
					filters: [],
					order: null,
					textFilter: "",
					features: ["LIKED_SONGS", "YOUR_EPISODES"],
					limit: libraryLimit,
					offset: libraryOffset,
					flatten: false,
					expandedFolders: [],
					folderUri: null,
					includeFoldersWhenFlattening: true,
					withCuration: false,
				});
				const library = libData?.data?.me?.libraryV3;
				if (!library || !Array.isArray(library.items)) {
					throw new Error("spotify_library_response_invalid");
				}
				readPageOffset(library, requestOffset, "spotify_library");
				const pageItems = library.items;
				if (Object.hasOwn(library, "totalCount")) {
					const parsedTotal = count(library.totalCount);
					if (parsedTotal === null)
						throw new Error("spotify_library_total_invalid");
					if (
						libraryExpectedCount !== null &&
						libraryExpectedCount !== parsedTotal
					) {
						throw new Error("spotify_library_total_changed");
					}
					libraryExpectedCount = parsedTotal;
				}
				const signature = pageSignature(pageItems);
				if (pageItems.length > 0 && libraryPageSignatures.has(signature)) {
					throw new Error("spotify_library_pagination_no_progress");
				}
				if (pageItems.length > 0) libraryPageSignatures.add(signature);
				for (const item of pageItems) {
					const libraryItem = isRecord(item) ? item.item : null;
					const itemData = isRecord(libraryItem) ? libraryItem.data : null;
					if (!isRecord(itemData)) {
						throw new Error("spotify_library_row_invalid");
					}
					const data = itemData;
					const typeName = data.__typename;
					if (typeof typeName !== "string" || typeName.length === 0) {
						throw new Error("spotify_library_row_invalid");
					}
					const supportedLibraryTypes = [
						"Playlist",
						"PseudoPlaylist",
						"Album",
						"Artist",
						"Episode",
						"Track",
						"LikedSongs",
						"YourEpisodes",
						// Saved shows, audiobooks and pre-saved releases are ordinary
						// library items that cannot hide a playlist: read past, no gap.
						"Podcast",
						"Audiobook",
						"PreRelease",
					];
					if (!supportedLibraryTypes.includes(typeName)) {
						// A folder (its playlists are not traversed) or a row type this
						// connector does not know. It may hide playlists, so it is a
						// coverage gap, not a failure: skip it and count it. Only a
						// bounded GraphQL type name is kept, never row content.
						librarySkippedCount += 1;
						const knownSkippedTypes = Object.keys(librarySkippedTypes);
						const typeLabel = !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(typeName)
							? "unparseable"
							: Object.hasOwn(librarySkippedTypes, typeName) ||
									knownSkippedTypes.length < 16
								? typeName
								: "other";
						librarySkippedTypes[typeLabel] =
							(librarySkippedTypes[typeLabel] ?? 0) + 1;
						continue;
					}
					// The web player puts the URI on the response wrapper for some types.
					const uri =
						data._uri ?? data.uri ?? (isRecord(libraryItem) ? libraryItem._uri : undefined);
					if (typeof uri !== "string" || uri.length === 0) {
						throw new Error("spotify_library_identity_missing");
					}
					const expectedResourceTypes: Record<string, string[]> = {
						Playlist: ["playlist"],
						PseudoPlaylist: ["collection"],
						Album: ["album"],
						Artist: ["artist"],
						Episode: ["episode"],
						Track: ["track"],
						LikedSongs: ["collection"],
						YourEpisodes: ["collection"],
						Podcast: ["show"],
						Audiobook: ["show", "audiobook"],
						PreRelease: ["prerelease", "album"],
					};
					const uriParts = uri.split(":");
					if (
						uriParts.length !== 3 ||
						uriParts[0] !== "spotify" ||
						!expectedResourceTypes[typeName]?.includes(uriParts[1] ?? "") ||
						!idFromUri(uri)
					) {
						throw new Error("spotify_library_identity_invalid");
					}
					if (libraryIdentities.has(uri)) {
						throw new Error("spotify_library_identity_repeated");
					}
					libraryIdentities.add(uri);
					if (typeName === "Playlist") playlistUris.push(uri);
				}
				libraryRawCount += pageItems.length;
				libraryPageCount += 1;
				const nextLibraryOffset = libraryOffset + pageItems.length;
				if (
					libraryExpectedCount !== null &&
					nextLibraryOffset > libraryExpectedCount
				) {
					throw new Error("spotify_library_count_mismatch");
				}
				if (
					libraryExpectedCount !== null &&
					nextLibraryOffset === libraryExpectedCount
				) {
					libraryTerminal = "total_reached";
					break;
				}
				if (pageItems.length < libraryLimit && libraryExpectedCount === null) {
					throw new Error("spotify_library_terminal_unverified");
				}
				if (pageItems.length === 0) {
					throw new Error("spotify_library_pagination_no_progress");
				}
				if (nextLibraryOffset <= libraryOffset) {
					throw new Error("spotify_library_pagination_no_progress");
				}
				libraryOffset = nextLibraryOffset;
			}
			if (
				libraryExpectedCount !== null &&
				libraryRawCount !== libraryExpectedCount
			) {
				throw new Error("spotify_library_count_mismatch");
			}
			const libraryProof: SpotifyEndEvidence = {
				stream: wanted.has("playlists") ? "playlists" : "playlist_items",
				operation: "libraryV3",
				navigation: navigationProof,
				owner: "spotify:user:me",
				selector: "spotify:user:me:library",
				firstOffset: 0,
				lastOffset: libraryOffset,
				responseOffset: libraryOffset,
				pageCount: libraryPageCount,
				rawCount: libraryRawCount,
				expectedCount: libraryExpectedCount,
				discardedCount: 0,
				remaining: false,
				terminal: libraryTerminal,
			};
			result.playlistUris = playlistUris;
			if (librarySkippedCount > 0) {
				result.librarySkipped = {
					count: librarySkippedCount,
					types: librarySkippedTypes,
				};
			}
			if (wanted.has("playlists")) result.completion.playlists = libraryProof;
			let childRawCount = 0;
			let childExpectedCount = 0;
			let childCountKnown = true;
			let childPageCount = 0;
			let childTrackCount = 0;
			let childTrackCoveredCount = 0;
			let childTrackUnavailableCount = 0;
			let playlistRowUnavailableCount = 0;
			let childLastOffset = 0;
			for (const uri of playlistUris) {
				let playlistCoherent = false;
				for (let attempt = 0; attempt < 3; attempt += 1) {
					const firstItemIndex = result.playlist_items.length;
					const initialTrackCount = childTrackCount;
					const initialCoveredCount = childTrackCoveredCount;
					const initialUnavailableCount = childTrackUnavailableCount;
					let revisionChanged = false;
					let offset = 0;
					let position = 0;
					let trackCount = 0;
					// Rows of a type the connector does not map, for this attempt only:
					// a revision retry reads the playlist again from the start.
					const attemptSkippedTypes: Record<string, number> = {};
					const requestedPlaylistId = idFromUri(uri);
					if (requestedPlaylistId === null) {
						throw new Error("spotify_library_playlist_identity_missing");
					}
					let playlistName: unknown;
					let ownerId: string | null = null;
					let ownerName: unknown;
					let description: unknown;
					let publicValue: boolean | null = null;
					let collaborativeValue: boolean | null = null;
					let snapshotId: string | null = null;
					let uriValue: unknown = uri;
					let followers: number | null = null;
					let images: Array<{ height: null; url: string; width: null }> = [];
					let playlistRawCount = 0;
					let playlistExpectedCount: number | null = null;
					let playlistPageCount = 0;
					let playlistRowAvailable = wanted.has("playlists");
					while (true) {
						const requestOffset = offset;
						childLastOffset = requestOffset;
						const plData = await gql("fetchPlaylist", {
							uri,
							offset,
							limit: 100,
							enableWatchFeedEntrypoint: false,
						});
						const pl = plData?.data?.playlistV2;
						if (
							!isRecord(pl) ||
							typeof pl.uri !== "string" ||
							pl.uri !== uri ||
							!isRecord(pl.content) ||
							!Array.isArray(pl.content.items)
						) {
							throw new Error("spotify_playlist_response_invalid");
						}
						readPageOffset(pl.content, requestOffset, "spotify_playlist");
						const items = pl.content.items;
						const revisionSource = Object.hasOwn(pl, "revisionId")
							? pl.revisionId
							: pl.snapshotId;
						const pageRevision =
							typeof revisionSource === "string" && revisionSource.length > 0
								? revisionSource
								: null;
						if (
							requestOffset > 0 &&
							(snapshotId === null || pageRevision !== snapshotId)
						) {
							revisionChanged = true;
							break;
						}
						if (Object.hasOwn(pl.content, "totalCount")) {
							const parsedTotal = count(pl.content.totalCount);
							if (parsedTotal === null)
								throw new Error("spotify_playlist_total_invalid");
							if (
								playlistExpectedCount !== null &&
								playlistExpectedCount !== parsedTotal
							) {
								throw new Error("spotify_playlist_total_changed");
							}
							playlistExpectedCount = parsedTotal;
						}
						if (requestOffset === 0) {
							snapshotId = pageRevision;
							const responseId = idFromUri(pl.uri);
							if (responseId === null || responseId !== requestedPlaylistId) {
								throw new Error("spotify_playlist_identity_mismatch");
							}
							if (wanted.has("playlists")) {
								try {
									playlistName = requireField(
										readString(pl.name, "playlist_name"),
										"spotify_playlist",
									);
									// The playlistV2 operation does not carry `public`; null is the
									// contract value for it, not a gap. A present value is validated.
									publicValue = Object.hasOwn(pl, "public")
										? requireField(
												readBoolean(pl.public, "playlist_public"),
												"spotify_playlist",
											)
										: null;
									collaborativeValue = Object.hasOwn(pl, "collaborative")
										? requireField(
												readBoolean(pl.collaborative, "playlist_collaborative"),
												"spotify_playlist",
											)
										: null;
									snapshotId = requireField(
										readString(revisionSource, "playlist_snapshot_id"),
										"spotify_playlist",
									);
									const ownerValue = sourceContainer(
										pl.ownerV2,
										"owner",
										"spotify_playlist",
									);
									const owner = sourceContainer(
										child(ownerValue, "data"),
										"owner_data",
										"spotify_playlist",
									);
									const ownerUri = readString(
										child(owner, "uri"),
										"playlist_owner_uri",
									);
									const ownerNameRead = readString(
										child(owner, "name"),
										"playlist_owner_name",
									);
									ownerId = idFromUri(requireField(ownerUri, "spotify_playlist"));
									ownerName = requireField(ownerNameRead, "spotify_playlist");
									description = requireField(
										readString(pl.description, "playlist_description"),
										"spotify_playlist",
									);
									uriValue = requireField(
										readString(pl.uri, "playlist_uri"),
										"spotify_playlist",
									);
									followers = requireField(
										readCount(pl.followers, "playlist_followers"),
										"spotify_playlist",
									);
									images = requireField(
										imageRecords(pl.images),
										"spotify_playlist",
									);
								} catch (error) {
									if (!isFieldUnavailable(error, "spotify_playlist")) throw error;
									playlistRowAvailable = false;
								}
							}
						}
						for (const item of items) {
							const playlistItem = isRecord(item) ? item.itemV2 : null;
							const trackData = isRecord(playlistItem) ? playlistItem.data : null;
							if (
								!isRecord(trackData) ||
								typeof trackData.__typename !== "string"
							) {
								throw new Error("spotify_playlist_row_invalid");
							}
							const trackPosition = position;
							position += 1;
							// A local file added to a playlist arrives as a LocalTrack row
							// (inside a LocalTrackResponseWrapper) with flat artist/album
							// fields and a spotify:local: URI instead of a catalog track.
							const isLocalTrack = trackData.__typename === "LocalTrack";
							if (trackData.__typename !== "Track" && !isLocalTrack) {
								if (["Episode", "PodcastEpisode"].includes(trackData.__typename))
									continue;
								// Through 0.1.55 this failed the whole export
								// (spotify_playlist_row_type_unrecognized). The row is now
								// skipped and counted as an uncovered playlist_items row, so
								// the stream reads degraded and the type name (bounded, no
								// row content) reaches the run log. If Spotify renamed
								// Track, every row lands here and playlist_items reads
								// omitted, which is still visible.
								const typeName = trackData.__typename;
								const typeLabel = !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(typeName)
									? "unparseable"
									: Object.hasOwn(attemptSkippedTypes, typeName) ||
											Object.hasOwn(playlistRowSkippedTypes, typeName) ||
											Object.keys({ ...playlistRowSkippedTypes, ...attemptSkippedTypes }).length < 16
										? typeName
										: "other";
								attemptSkippedTypes[typeLabel] = (attemptSkippedTypes[typeLabel] ?? 0) + 1;
								continue;
							}
							trackCount += 1;
							if (wanted.has("playlist_items")) childTrackCount += 1;
							if (!wanted.has("playlist_items")) continue;
							try {
								const trackUri = requireField(
									readString(trackData.uri, "playlist_track_uri"),
									"spotify_playlist",
								);
								if (
									isLocalTrack &&
									(trackUri === null || !trackUri.startsWith("spotify:local:"))
								) {
									throw new Error(
										"spotify_playlist_field_unavailable:playlist_local_track_uri_malformed",
									);
								}
								const trackName = requireField(
									readString(trackData.name, "playlist_track_name"),
									"spotify_playlist",
								);
								let artistNames: string[];
								let albumName: string | null;
								if (isLocalTrack) {
									const localArtist = requireField(
										readString(trackData.artistName, "playlist_track_artists"),
										"spotify_playlist",
									);
									artistNames = localArtist ? [localArtist] : [];
									albumName = requireField(
										readString(trackData.albumName, "playlist_album_name"),
										"spotify_playlist",
									);
								} else {
									artistNames = requireField(
										sourceArtists(trackData.artists, "playlist_track_artists"),
										"spotify_playlist",
									);
									const album = sourceContainer(
										trackData.albumOfTrack,
										"album",
										"spotify_playlist",
									);
									albumName = requireField(
										readString(child(album, "name"), "playlist_album_name"),
										"spotify_playlist",
									);
								}
								const durationContainer = sourceContainer(
									isLocalTrack
										? trackData.localTrackDuration
										: trackData.trackDuration,
									"duration",
									"spotify_playlist",
								);
								const duration = requireField(
									readCount(
										child(durationContainer, "totalMilliseconds"),
										"playlist_track_duration",
									),
									"spotify_playlist",
								);
								const addedAtContainer = sourceContainer(
									isRecord(item) ? item.addedAt : undefined,
									"added_at",
									"spotify_playlist",
								);
								const addedAtValue = requireField(
									readString(
										child(addedAtContainer, "isoString"),
										"playlist_added_at",
									),
									"spotify_playlist",
								);
								if (
									addedAtValue !== null &&
									!Number.isFinite(Date.parse(addedAtValue))
								) {
									throw new Error(
										"spotify_playlist_field_unavailable:playlist_added_at_malformed",
									);
								}
								const addedByContainer = sourceContainer(
									isRecord(item) ? item.addedBy : undefined,
									"added_by",
									"spotify_playlist",
								);
								const addedBy = sourceContainer(
									child(addedByContainer, "data"),
									"added_by_data",
									"spotify_playlist",
								);
								const addedByName = requireField(
									readString(child(addedBy, "name"), "playlist_added_by"),
									"spotify_playlist",
								);
								// Track data identifies the track by URI; an `id` key is optional
								// but, when present, must agree with the URI.
								const sourceTrackId = Object.hasOwn(trackData, "id")
									? requireField(
											readString(trackData.id, "playlist_track_id"),
											"spotify_playlist",
										)
									: null;
								const trackId = spotifyTrackId(
									trackUri,
									sourceTrackId,
									"spotify_playlist",
								);
								result.playlist_items.push({
									id: `${requestedPlaylistId}:${trackPosition}`,
									playlist_id: requestedPlaylistId,
									track_id: trackId,
									uri: trackUri,
									position: trackPosition,
									added_at: addedAtValue,
									added_by: addedByName,
									name: trackName ?? undefined,
									artist_names: artistNames,
									album_name: albumName,
									duration_ms: duration,
								});
								childTrackCoveredCount += 1;
							} catch (error) {
								if (!isFieldUnavailable(error, "spotify_playlist")) throw error;
								childTrackUnavailableCount += 1;
							}
						}
						playlistRawCount += items.length;
						playlistPageCount += 1;
						const nextOffset = offset + items.length;
						if (
							playlistExpectedCount !== null &&
							nextOffset > playlistExpectedCount
						) {
							throw new Error("spotify_playlist_count_mismatch");
						}
						if (
							playlistExpectedCount !== null &&
							nextOffset === playlistExpectedCount
						) {
							break;
						}
						if (items.length < 100 && playlistExpectedCount === null) {
							throw new Error("spotify_playlist_terminal_unverified");
						}
						if (items.length === 0)
							throw new Error("spotify_playlist_pagination_no_progress");
						if (nextOffset <= offset) {
							throw new Error("spotify_playlist_pagination_no_progress");
						}
						offset = nextOffset;
					}
					if (revisionChanged) {
						result.playlist_items.length = firstItemIndex;
						childTrackCount = initialTrackCount;
						childTrackCoveredCount = initialCoveredCount;
						childTrackUnavailableCount = initialUnavailableCount;
						continue;
					}
					if (
						playlistExpectedCount !== null &&
						playlistRawCount !== playlistExpectedCount
					) {
						throw new Error("spotify_playlist_count_mismatch");
					}
					childRawCount += playlistRawCount;
					childPageCount += playlistPageCount;
					if (playlistExpectedCount === null) childCountKnown = false;
					else childExpectedCount += playlistExpectedCount;
					if (wanted.has("playlists") && playlistRowAvailable) {
						result.playlists.push({
							id: requestedPlaylistId,
							name: playlistName,
							owner_id: ownerId,
							owner_name: ownerName ?? null,
							public: publicValue,
							collaborative: collaborativeValue,
							track_count: trackCount,
							snapshot_id: snapshotId,
							description: description ?? null,
							uri: uriValue,
							followers,
							images,
						});
					} else if (wanted.has("playlists")) {
						playlistRowUnavailableCount += 1;
					}
					for (const [type, rows] of Object.entries(attemptSkippedTypes)) {
						playlistRowSkippedTypes[type] = (playlistRowSkippedTypes[type] ?? 0) + rows;
						playlistRowSkippedCount += rows;
					}
					playlistCoherent = true;
					break;
				}
				if (!playlistCoherent) {
					// Caught below: only the playlist streams are given up.
					throw new Error("spotify_playlist_revision_unproven");
				}
			}
			if (playlistRowSkippedCount > 0) {
				result.playlistRowsSkipped = {
					count: playlistRowSkippedCount,
					types: playlistRowSkippedTypes,
				};
			}
			if (wanted.has("playlist_items")) {
				result.completion.playlist_items =
					playlistUris.length === 0
						? { ...libraryProof, stream: "playlist_items" }
						: {
								stream: "playlist_items",
								operation: "fetchPlaylist",
								navigation: navigationProof,
								owner: "spotify:user:me",
								selector: playlistUris.join("\n"),
								firstOffset: 0,
								lastOffset: childLastOffset,
								responseOffset: childLastOffset,
								pageCount: childPageCount,
								rawCount: childRawCount,
								expectedCount: childCountKnown ? childExpectedCount : null,
								discardedCount: childTrackUnavailableCount + playlistRowSkippedCount,
								remaining: false,
								terminal:
									childRawCount === 0 ? "empty_verified" : "total_reached",
							};
			}
			if (wanted.has("playlists")) {
				libraryProof.discardedCount =
					playlistRowUnavailableCount + librarySkippedCount;
				result.sourceCounts.playlists = {
					considered: playlistUris.length + librarySkippedCount,
					covered: result.playlists.length,
				};
			}
			if (wanted.has("playlist_items")) {
				// Each skipped library row is at least one unread unit, so the
				// stream cannot read complete while any row was skipped.
				result.sourceCounts.playlist_items = {
					considered: childTrackCount + librarySkippedCount + playlistRowSkippedCount,
					covered: childTrackCoveredCount,
				};
			}
			} catch (error) {
				// The library surface fails its own two streams. Nothing partial is
				// kept: no playlist rows, proofs or counts from this attempt.
				const revision =
					error instanceof Error && error.message === "spotify_playlist_revision_unproven";
				if (!revision && !othersWanted(playlistGroup)) throw error;
				result.playlists.splice(0);
				result.playlist_items.splice(0);
				result.playlistUris = [];
				delete result.completion.playlists;
				delete result.completion.playlist_items;
				delete result.sourceCounts.playlists;
				delete result.sourceCounts.playlist_items;
				delete result.librarySkipped;
				delete result.playlistRowsSkipped;
				if (revision) result.playlistRevisionUnproven = true;
				else {
					for (const stream of playlistGroup) {
						if (wanted.has(stream)) failStream(stream, error);
					}
				}
			}
		}

		if (wanted.has("saved_tracks")) {
			try {
			let offset = 0;
			const savedTrackPageSignatures = new Set<string>();
			const savedTrackIdentities = new Set<string>();
			let rawCount = 0;
			let expectedCount: number | null = null;
			let pageCount = 0;
			let terminal: SpotifyEndEvidence["terminal"] = null;
			let unavailableRowCount = 0;
			let coveredRowCount = 0;
			while (true) {
				const data = await gql("fetchLibraryTracks", {
					uri: "spotify:user:me:collection",
					offset,
					limit: 100,
				});
				const tracks = data?.data?.me?.library?.tracks;
				if (!tracks || !Array.isArray(tracks.items)) {
					throw new Error("spotify_saved_tracks_response_invalid");
				}
				readPageOffset(tracks, offset, "spotify_saved_tracks");
				const items = tracks.items;
				if (Object.hasOwn(tracks, "totalCount")) {
					const parsedTotal = count(tracks.totalCount);
					if (parsedTotal === null)
						throw new Error("spotify_saved_tracks_total_invalid");
					if (expectedCount !== null && expectedCount !== parsedTotal) {
						throw new Error("spotify_saved_tracks_total_changed");
					}
					expectedCount = parsedTotal;
				}
				const signature = pageSignature(items);
				if (items.length > 0 && savedTrackPageSignatures.has(signature)) {
					throw new Error("spotify_saved_tracks_pagination_no_progress");
				}
				if (items.length > 0) savedTrackPageSignatures.add(signature);
				for (const item of items) {
					if (!isRecord(item)) {
						throw new Error("spotify_saved_tracks_row_invalid");
					}
					try {
						const trackContainer = sourceContainer(
							item.track,
							"track",
							"spotify_saved_tracks",
						);
						const trackData = sourceContainer(
							child(trackContainer, "data"),
							"track_data",
							"spotify_saved_tracks",
						);
						if (!trackContainer || !trackData) {
							throw new Error(
								"spotify_saved_tracks_field_unavailable:track_missing",
							);
						}
						const t = trackData;
						const uriSource = trackContainer._uri ?? trackContainer.uri;
						const trackUri = requireField(readString(uriSource, "track_uri"));
						// Track data identifies the track by URI; an `id` key is optional
						// but, when present, must agree with the URI.
						const sourceTrackId = Object.hasOwn(t, "id")
							? requireField(readString(t.id, "track_id"))
							: null;
						const id = typeof trackUri === "string" && trackUri.startsWith("spotify:local:")
							? await localTrackId(trackUri)
							: spotifyTrackId(trackUri, sourceTrackId, "spotify_saved_tracks");
						if (id === null) {
							throw new Error(
								"spotify_saved_tracks_field_unavailable:identity_missing",
							);
						}
						if (savedTrackIdentities.has(id)) {
							throw new Error("spotify_saved_tracks_identity_repeated");
						}
						savedTrackIdentities.add(id);
						const artistNames = requireField(
							sourceArtists(t.artists, "track_artists"),
						);
						const album = sourceContainer(
							t.albumOfTrack,
							"album",
							"spotify_saved_tracks",
						);
						const albumArtistContainer = sourceContainer(
							child(album, "artists"),
							"album_artists",
							"spotify_saved_tracks",
						);
						const albumArtistNames = requireField(
							sourceArtists(albumArtistContainer, "album_artists"),
						);
						const albumName = requireField(
							readString(child(album, "name"), "album_name"),
						);
						const durationContainer = sourceContainer(
							t.duration,
							"duration",
							"spotify_saved_tracks",
						);
						const duration = requireField(
							readCount(child(durationContainer, "totalMilliseconds"), "duration"),
						);
						const contentRating = sourceContainer(
							t.contentRating,
							"content_rating",
							"spotify_saved_tracks",
						);
						const contentLabel = requireField(
							readString(child(contentRating, "label"), "content_rating_label"),
						);
						if (
							contentLabel !== null &&
							contentLabel !== "" &&
							contentLabel !== "EXPLICIT" &&
							contentLabel !== "NONE"
						) {
							throw new Error(
								"spotify_saved_tracks_field_unavailable:content_rating_label_unrecognized",
							);
						}
						const addedAtContainer = sourceContainer(
							item.addedAt,
							"added_at",
							"spotify_saved_tracks",
						);
						const addedAt = requireField(
							readString(child(addedAtContainer, "isoString"), "added_at"),
						);
						if (
							addedAt !== null &&
							!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
								addedAt,
							)
						) {
							throw new Error(
								"spotify_saved_tracks_field_unavailable:added_at_malformed",
							);
						}
						const name = requireField(readString(t.name, "track_name"));
						if (name === null)
							throw new Error(
								"spotify_saved_tracks_field_unavailable:track_name_missing",
							);
						const popularity = Object.hasOwn(t, "popularity")
							? requireField(readPopularity(t.popularity), "spotify_saved_tracks")
							: null;
						// Tracks without external ids omit the container (observed live).
						const externalIds = Object.hasOwn(t, "externalIds")
							? sourceContainer(
									t.externalIds,
									"external_ids",
									"spotify_saved_tracks",
								)
							: null;
						const isrc = requireField(
							readString(child(externalIds, "isrc"), "track_isrc"),
							"spotify_saved_tracks",
						);
						coveredRowCount += 1;
						result.saved_tracks.push({
							id,
							identity_unresolved: false,
							name,
							artist_names: artistNames,
							album_name: albumName,
							duration_ms: duration,
							popularity,
							added_at: addedAt,
							isrc,
							uri: trackUri,
							explicit:
								contentLabel === null || contentLabel === ""
									? null
									: contentLabel === "EXPLICIT",
							album_artist_names: albumArtistNames,
						});
					} catch (error) {
						if (!isFieldUnavailable(error, "spotify_saved_tracks")) throw error;
						unavailableRowCount += 1;
					}
				}
				rawCount += items.length;
				pageCount += 1;
				const nextOffset = offset + items.length;
				if (expectedCount !== null && nextOffset > expectedCount) {
					throw new Error("spotify_saved_tracks_count_mismatch");
				}
				if (expectedCount !== null && nextOffset === expectedCount) {
					terminal = "total_reached";
					break;
				}
				if (items.length < 100 && expectedCount === null) {
					throw new Error("spotify_saved_tracks_terminal_unverified");
				}
				if (items.length === 0)
					throw new Error("spotify_saved_tracks_pagination_no_progress");
				if (nextOffset <= offset) {
					throw new Error("spotify_saved_tracks_pagination_no_progress");
				}
				offset = nextOffset;
			}
			if (expectedCount !== null && rawCount !== expectedCount) {
				throw new Error("spotify_saved_tracks_count_mismatch");
			}
			result.sourceCounts.saved_tracks = {
				considered: rawCount,
				covered: coveredRowCount,
			};
			result.completion.saved_tracks = {
				stream: "saved_tracks",
				operation: "fetchLibraryTracks",
				navigation: navigationProof,
				owner: "spotify:user:me:collection",
				selector: "spotify:user:me:collection",
				firstOffset: 0,
				lastOffset: offset,
				responseOffset: offset,
				pageCount,
				rawCount,
				expectedCount,
				discardedCount: unavailableRowCount,
				remaining: false,
				terminal,
			};
			} catch (error) {
				if (!othersWanted(["saved_tracks"])) throw error;
				result.saved_tracks.splice(0);
				delete result.completion.saved_tracks;
				delete result.sourceCounts.saved_tracks;
				failStream("saved_tracks", error);
			}
		}

		if (wanted.has("recently_played_contexts")) {
			const recentEndpoint =
				"spclient.wg.spotify.com/recently-played/v3/user/{user}/recently-played";
			let failureDetail: Omit<SpotifyStreamFailure, "code"> = {};
			let recentUsername: string | null = null;
			const pagesBefore = result.recent_context_pages.length;
			try {
			const attrs = await gql("profileAttributes", {});
			const profile = attrs?.data?.me?.profile;
			if (typeof profile?.username !== "string" || profile.username.length === 0) {
				throw new Error("spotify_recently_played_owner_unavailable");
			}
			recentUsername = profile.username;
			const pageSize = 50;
			const maxPages = 20;
			const pageSignatures = new Set<string>();
			const identities = new Set<string>();
			let offset = 0;
			let terminal = false;
			for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
				const params = new URLSearchParams({
					format: "json",
					offset: String(offset),
					limit: String(pageSize),
					filter: "default,collection-new-episodes",
					market: "from_token",
				});
				const response = await fetch(
					`https://spclient.wg.spotify.com/recently-played/v3/user/${encodeURIComponent(profile.username)}/recently-played?${params}`,
					{
						headers: {
							authorization: `Bearer ${access}`,
							"app-platform": "WebPlayer",
							accept: "application/json",
						},
					},
				);
				if (!response.ok) {
					let body = "";
					try {
						body = await response.text();
					} catch {}
					// Spotify answers 404 with an EMPTY body for an offset past the
					// end of the list, not an empty page (live probe 8 Nov 2026:
					// offset 0 gave 200 with 9 contexts, offsets 50 to 500 gave 404
					// with 0 bytes). A history that exactly fills its last page
					// therefore always ends in that 404, which until 0.1.55 failed
					// the whole export for those users. At offset 0 it is an empty
					// history. A 404 with a body is not that answer and fails the
					// stream, as does a 403 (owner mismatch).
					if (response.status === 404 && body.trim() === "") {
						diagnostics.recentlyPlayed = {
							pages: pageNumber,
							endedBy: offset > 0 ? "not_found_past_end" : "not_found_at_start",
						};
						terminal = true;
						break;
					}
					failureDetail = {
						endpoint: recentEndpoint,
						status: response.status,
						contentType: (response.headers.get("content-type") ?? "").split(";")[0]?.trim() || "none",
						snippet: safeSnippet(body, recentUsername),
					};
					// 429 and 5xx can pass on a later run; any other status (403, a
					// 404 with a body) will not.
					throw new Error(
						response.status === 429 || response.status >= 500
							? `spotify_retryable_status_${response.status}`
							: `spotify_recently_played_status_${response.status}`,
					);
				}
				const payload: unknown = await response.json();
				const contexts = (payload as { playContexts?: unknown })?.playContexts;
				if (!Array.isArray(contexts)) {
					throw new Error("spotify_recently_played_malformed");
				}
				const signature = pageSignature(contexts);
				if (contexts.length > 0 && pageSignatures.has(signature)) {
					throw new Error("spotify_recently_played_pagination_no_progress");
				}
				pageSignatures.add(signature);
				for (const item of contexts) {
					const uri = (item as Record<string, unknown> | null)?.uri;
					const time = (item as Record<string, unknown> | null)?.lastPlayedTime;
					if (typeof uri === "string" && Number.isSafeInteger(time)) {
						const identity = `${uri}\\u0000${String(time)}`;
						if (identities.has(identity)) {
							throw new Error("spotify_recently_played_repeated_identity");
						}
						identities.add(identity);
					}
				}
				result.recent_context_pages.push(payload);
				if (contexts.length < pageSize) {
					diagnostics.recentlyPlayed = { pages: pageNumber + 1, endedBy: "short_page" };
					terminal = true;
					break;
				}
				const nextOffset = offset + contexts.length;
				if (nextOffset <= offset) {
					throw new Error("spotify_recently_played_pagination_no_progress");
				}
				offset = nextOffset;
			}
			result.sourceCounts.recently_played_contexts = {
				considered: identities.size,
				covered: 0,
			};
			if (!terminal) {
				diagnostics.recentlyPlayed = { pages: maxPages, endedBy: "page_cap" };
				result.sourceCounts.recently_played_contexts.covered = 0;
			}
			} catch (error) {
				// The stream fails alone; its pages so far are dropped so no partial
				// list is exported as if it were the whole one.
				diagnostics.recentlyPlayed = {
					pages: result.recent_context_pages.length - pagesBefore,
					endedBy: "failed",
				};
				result.recent_context_pages.splice(pagesBefore);
				delete result.sourceCounts.recently_played_contexts;
				failStream("recently_played_contexts", error, failureDetail);
			}
		}

		if (wanted.has("top_artists") || wanted.has("top_tracks")) {
			const pageSize = 50;
			const maxItems = 100;
			for (const stream of ["top_artists", "top_tracks"] as const) {
				if (!wanted.has(stream) || result.streamFailures?.[stream]) continue;
				const pages = stream === "top_artists" ? result.top_artist_pages : result.top_track_pages;
				try {
			for (const timeRange of ["SHORT_TERM", "LONG_TERM"] as const) {
				{
					const key = stream === "top_artists" ? "topArtists" : "topTracks";
					const seenPages = new Set<string>();
					let offset = 0;
					let expectedTotal: number | null = null;
					while (offset < maxItems) {
						const limit = Math.min(pageSize, maxItems - offset);
						const data = await gql("userTopContent", {
							includeTopArtists: stream === "top_artists",
							topArtistsInput: { offset, limit, sortBy: "AFFINITY", timeRange },
							includeTopTracks: stream === "top_tracks",
							topTracksInput: { offset, limit, sortBy: "AFFINITY", timeRange },
						});
						const page = data?.data?.me?.profile?.[key];
						const items = page?.items;
						const total = count(page?.totalCount);
						if (!Array.isArray(items) || total === null) {
							throw new Error(`spotify_top_content_${stream}_malformed`);
						}
						if (expectedTotal !== null && total !== expectedTotal) {
							throw new Error(`spotify_top_content_${stream}_count_changed`);
						}
						expectedTotal = total;
						if (items.length > limit || items.length > Math.max(0, total - offset)) {
							throw new Error(`spotify_top_content_${stream}_invalid_page_size`);
						}
						const signature = pageSignature(items);
						if (items.length > 0 && seenPages.has(signature)) {
							throw new Error(`spotify_top_content_${stream}_pagination_no_progress`);
						}
						seenPages.add(signature);
						pages.push({ timeRange, payload: data });
						const nextOffset = offset + items.length;
						if (nextOffset >= total || nextOffset >= maxItems) break;
						if (items.length === 0) {
							throw new Error(`spotify_top_content_${stream}_pagination_stalled`);
						}
						if (nextOffset <= offset) {
							throw new Error(`spotify_top_content_${stream}_pagination_no_progress`);
						}
						offset = nextOffset;
					}
				}
			}
				} catch (error) {
					pages.splice(0);
					failStream(stream, error);
				}
			}
		}

		return result;
};

/**
 * tsx/esbuild wrap nested named functions in `__name(...)`, a helper that
 * exists in the Node bundle but not in the page. Binding it lexically around
 * the serialized callback keeps the page's globals untouched (esbuild would
 * rename a `__name` declared inside the callback itself).
 */
export function spotifyPageEvaluateSource(
	requested: string[],
	collector: (
		requested: string[],
		fetch?: typeof globalThis.fetch,
		seededHashes?: Record<string, string>,
	) => Promise<BrowserData> = spotifyPageCollector,
	seededHashes: Record<string, string> = {},
): string {
	return `(async () => {\nconst __name = (target) => target;\nreturn (${collector.toString()})(${JSON.stringify(requested)}, undefined, ${JSON.stringify(seededHashes)});\n})()`;
}

const PATHFINDER_URL = /^https:\/\/api-partner\.spotify\.com\/pathfinder\/v\d+\/query/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Reads `operationName` and `sha256Hash` from one pathfinder request the
 * player sent: a POST body (v2) or the `operationName` and `extensions` query
 * parameters (v1 GET). Returns null for anything else. Never reads variables.
 */
export function spotifyPathfinderHash(
	url: string,
	postData: string | null,
): { operation: string; hash: string } | null {
	if (!PATHFINDER_URL.test(url)) return null;
	const pick = (operation: unknown, extensions: unknown) => {
		const hash = (extensions as { persistedQuery?: { sha256Hash?: unknown } } | null)
			?.persistedQuery?.sha256Hash;
		return typeof operation === "string" &&
			/^\w{1,80}$/.test(operation) &&
			typeof hash === "string" &&
			SHA256_HEX.test(hash)
			? { operation, hash }
			: null;
	};
	try {
		if (postData) {
			const body = JSON.parse(postData) as { operationName?: unknown; extensions?: unknown };
			const found = pick(body.operationName, body.extensions);
			if (found) return found;
		}
		const query = new URL(url).searchParams;
		const extensions = query.get("extensions");
		return pick(query.get("operationName"), extensions ? JSON.parse(extensions) : null);
	} catch {
		return null;
	}
}

/**
 * Collects the persisted-query hashes the player itself sends while it loads,
 * a source that does not depend on the bundle text the scan reads. Hosts whose
 * page has no request events (PageShim) get an empty map.
 */
function observePlayerHashes(page: BrowserCollectContext["page"]): {
	hashes: Record<string, string>;
	stop: () => void;
} {
	const hashes: Record<string, string> = {};
	const target = page as unknown as {
		on?: (event: "request", listener: (request: unknown) => void) => unknown;
		off?: (event: "request", listener: (request: unknown) => void) => unknown;
	};
	if (typeof target.on !== "function") return { hashes, stop: () => undefined };
	const listener = (request: unknown) => {
		try {
			const r = request as { url?: () => string; postData?: () => string | null };
			const url = typeof r.url === "function" ? r.url() : "";
			if (!PATHFINDER_URL.test(url)) return;
			const found = spotifyPathfinderHash(url, typeof r.postData === "function" ? r.postData() : null);
			if (found) hashes[found.operation] = found.hash;
		} catch {
			// An observer must never fail a run.
		}
	};
	try {
		target.on("request", listener);
	} catch {
		return { hashes, stop: () => undefined };
	}
	return {
		hashes,
		stop: () => {
			try {
				target.off?.("request", listener);
			} catch {}
		},
	};
}

function logCollectorDiagnostics(data: BrowserData | null, attempt: number): void {
	const d = data?.diagnostics;
	if (!d) return;
	connectorDiagnostic("spotify", "query_hashes", {
		attempt,
		webVersion: d.webVersion,
		detectedWebVersion: d.detectedWebVersion ?? "unknown",
		found: d.hashesFound.join(","),
		missing: d.hashesMissing.join(","),
		fromPlayerRequests: d.hashesFromPlayerRequests.join(","),
		sources: Object.entries(d.hashSources ?? {})
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([name, source]) => `${name}:${source}`)
			.join(","),
		precacheEntries: d.precacheEntries,
		bundlesBySource: Object.entries(d.bundlesBySource ?? {})
			.map(([source, count]) => `${source}:${count}`)
			.join(","),
		bundles: d.bundlesRead,
		scans: d.scanAttempts,
	});
	if (d.recentlyPlayed) {
		connectorDiagnostic("spotify", "recently_played_end", {
			pages: d.recentlyPlayed.pages,
			endedBy: d.recentlyPlayed.endedBy,
		});
	}
}

async function collectSpotifyWebData(
	page: BrowserCollectContext["page"],
	requestedStreams: string[],
	evaluateData?: (page: BrowserCollectContext["page"], streams: string[]) => Promise<BrowserData>,
): Promise<BrowserCollectResult> {
	const observer = evaluateData
		? { hashes: {} as Record<string, string>, stop: () => undefined }
		: observePlayerHashes(page);
	try {
		return await collectSpotifyWebDataObserved(page, requestedStreams, observer.hashes, evaluateData);
	} finally {
		observer.stop();
	}
}

async function collectSpotifyWebDataObserved(
	page: BrowserCollectContext["page"],
	requestedStreams: string[],
	playerHashes: Record<string, string>,
	evaluateData?: (page: BrowserCollectContext["page"], streams: string[]) => Promise<BrowserData>,
): Promise<BrowserCollectResult> {
	await openSpotify(page);
	let attempt = 0;
	let reloaded = false;
	const evaluate = async (streams: string[] = requestedStreams): Promise<BrowserData> => {
		attempt += 1;
		const data = evaluateData
			? await evaluateData(page, streams)
			: ((await page.evaluate(
					spotifyPageEvaluateSource(streams, spotifyPageCollector, { ...playerHashes }),
				)) as BrowserData);
		logCollectorDiagnostics(data, attempt);
		return data;
	};
	let evaluated: BrowserData;
	try {
		evaluated = await evaluate();
	} catch (error) {
		// The query hashes are read from the web player's own bundles. A player
		// that yielded none of them (RSS run e898e5d4: all five missing on a
		// remote browser, while the same account read them ten minutes earlier)
		// is loaded once more, to completion, and read again before the export
		// is given up.
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("spotify_missing_hashes_")) throw error;
		const tail = message.slice(message.indexOf("spotify_missing_hashes_") + 23);
		const context = (key: string) => new RegExp(`\\b${key}=(\\S+)`).exec(tail)?.[1];
		connectorDiagnostic("spotify", "query_hashes_reload", {
			missing: tail.split(/\s/)[0] ?? "",
			found: context("found"),
			seeded: context("seeded"),
			bundles: context("bundles"),
			webVersion: context("webVersion"),
			playerRequestHashes: Object.keys(playerHashes).sort().join(","),
		});
		await page.goto(SPOTIFY_WEB_HOME, { waitUntil: "load" });
		reloaded = true;
		evaluated = await evaluate();
	}
	evaluated.streamFailures ??= {};
	// Only userTopContent was missing, so the other streams were read and the
	// ranked lists failed. Load the player once more, as 0.1.54 does for a
	// missing hash, and read the ranked lists alone before giving them up.
	const missingTop = (["top_artists", "top_tracks"] as const).filter((stream) =>
		evaluated.streamFailures?.[stream]?.code.startsWith("spotify_missing_hashes_"),
	);
	if (missingTop.length > 0 && !reloaded) {
		connectorDiagnostic("spotify", "query_hashes_reload", {
			missing: "userTopContent",
			streams: missingTop.join(","),
			playerRequestHashes: Object.keys(playerHashes).sort().join(","),
		});
		reloaded = true;
		let again: BrowserData | null = null;
		let againError: unknown = null;
		try {
			await page.goto(SPOTIFY_WEB_HOME, { waitUntil: "load" });
			again = await evaluate([...missingTop]);
		} catch (error) {
			againError = error;
		}
		for (const stream of missingTop) {
			const failure = again?.streamFailures?.[stream];
			if (again && !failure) {
				delete evaluated.streamFailures[stream];
				if (stream === "top_artists") evaluated.top_artist_pages = again.top_artist_pages ?? [];
				else evaluated.top_track_pages = again.top_track_pages ?? [];
			} else if (failure) {
				evaluated.streamFailures[stream] = failure;
			} else if (againError) {
				const message = againError instanceof Error ? againError.message : String(againError);
				const code = /^spotify_[a-z0-9_,]+/i.exec(message)?.[0];
				if (code) evaluated.streamFailures[stream] = { code };
			}
		}
	}
	if (
		requestedStreams.includes("recently_played_contexts") &&
		!evaluated.streamFailures.recently_played_contexts
	) {
		try {
			const recent = parseRecentContextRows(evaluated.recent_context_pages ?? []);
			evaluated.recently_played_contexts = recent.rows;
			evaluated.sourceCounts.recently_played_contexts = {
				considered: recent.considered,
				covered: recent.rows.length,
			};
		} catch (error) {
			evaluated.streamFailures.recently_played_contexts = {
				code: error instanceof Error ? error.message : "spotify_recently_played_malformed",
			};
		}
	}
	evaluated.top_artists ??= [];
	evaluated.top_tracks ??= [];
	for (const stream of ["top_artists", "top_tracks"] as const) {
		if (!requestedStreams.includes(stream) || evaluated.streamFailures[stream]) continue;
		const pages = (stream === "top_artists" ? evaluated.top_artist_pages : evaluated.top_track_pages) ?? [];
		// One bad ranking page (a total that changed between pages, a
		// malformed page) omits only this stream, as for recently played.
		try {
			const rows: Record<string, unknown>[] = [];
			const counts = { considered: 0, covered: 0 };
			// Every window was read to the total Spotify reported for it.
			let windowsComplete = true;
			let total = 0;
			for (const timeRange of ["short_term", "long_term"] as const) {
				const payloads = pages
					.filter((entry) => readPath(entry, "timeRange") === timeRange.toUpperCase())
					.map((entry) => readPath(entry, "payload"));
				const parsed = parseTopRows(payloads, stream, timeRange);
				rows.push(...parsed.rows);
				counts.considered += parsed.considered;
				counts.covered += parsed.rows.length;
				const key = stream === "top_artists" ? "topArtists" : "topTracks";
				// parseTopRows has already proven the total is the same on every
				// page. A total above the 100-row bound leaves rows unread.
				const windowTotal = readPath(payloads[0], "data", "me", "profile", key, "totalCount");
				if (typeof windowTotal !== "number" || parsed.considered !== windowTotal) {
					windowsComplete = false;
				} else {
					total += windowTotal;
				}
			}
			evaluated[stream] = rows;
			evaluated.sourceCounts[stream] = counts;
			if (windowsComplete) {
				evaluated.topProvenComplete ??= {};
				evaluated.topProvenComplete[stream] = { rows: counts.considered, total };
			}
		} catch (error) {
			evaluated[stream] = [];
			delete evaluated.sourceCounts[stream];
			evaluated.streamFailures[stream] = {
				code: error instanceof Error ? (/^spotify_[a-z0-9_,]+/i.exec(error.message)?.[0] ?? "spotify_top_content_malformed") : "spotify_top_content_malformed",
			};
		}
	}
	for (const [stream, failure] of Object.entries(evaluated.streamFailures)) {
		if (!failure) continue;
		connectorDiagnostic("spotify", "stream_failed", {
			stream,
			code: failure.code,
			endpoint: failure.endpoint,
			status: failure.status,
			contentType: failure.contentType,
			snippet: failure.snippet,
		});
	}
	return evaluated;
}

async function emitRecordsWithCoverage(
	stream: string,
	records: Record<string, unknown>[],
	counts: { considered: number; covered: number },
	emit: (msg: EmittedMessage) => Promise<void>,
	emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	for (const record of records) await emitRecord(stream, record);
	await emitDetailCoverage(
		{ emit },
		{
			stream,
			stateStream: stream,
			requiredKeys: [],
			hydratedKeys: [],
			considered: counts.considered,
			covered: counts.covered,
		},
	);
}

/**
 * One isolated stream failed; the others still export. Through the runtime's
 * `reportStreamFailure` the stream goes out as the portable
 * `stream_collection_failed` SKIP_RESULT. RSS's native host maps that to an
 * omitted scope and delivers the rest as a successful run.
 */
async function reportIsolatedStreamFailure(
	stream: SpotifyIsolatedStream,
	failure: SpotifyStreamFailure,
	emit: (msg: EmittedMessage) => Promise<void>,
	reportStreamFailure: BrowserCollectContext["reportStreamFailure"],
): Promise<void> {
	const retryable = spotifyRetryablePattern.test(failure.code);
	const what: Record<SpotifyIsolatedStream, string> = {
		playlists: "your playlists",
		playlist_items: "your playlist tracks",
		saved_tracks: "your saved tracks",
		recently_played_contexts: "recently played contexts",
		top_artists: "this ranking",
		top_tracks: "this ranking",
	};
	const message = `Spotify did not return ${what[stream]} this time; the other Spotify data was still read.`;
	const recoveryHint = retryable
		? { action: "retry_by_runtime" as const, retryable: true }
		: { action: "retry_on_connector_upgrade" as const, retryable: false };
	const diagnostics = {
		original_reason: failure.code,
		...(failure.status === undefined ? {} : { status: failure.status }),
		...(failure.endpoint === undefined ? {} : { endpoint: failure.endpoint }),
	};
	if (reportStreamFailure) {
		await reportStreamFailure(stream, message, { recoveryHint, diagnostics });
		return;
	}
	await emit({
		type: "SKIP_RESULT",
		stream,
		reason: "stream_collection_failed",
		message,
		recovery_hint: recoveryHint,
		diagnostics,
	});
}

export async function spotifyCollect({
	emit: hostEmit,
	emitRecord: hostEmitRecord,
	page,
	progress,
	reportStreamFailure: hostReportStreamFailure,
	requested,
}: Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "page" | "progress" | "requested"
> &
	Partial<Pick<BrowserCollectContext, "reportStreamFailure">>, evaluateData?: (page: BrowserCollectContext["page"], streams: string[]) => Promise<BrowserData>): Promise<void> {
	const requestedNames = [...requested.keys()];
	// Every requested stream must end with a record, a checkpoint or a skip
	// receipt. A host rejects a run that says nothing about a requested scope
	// (RSS: "requested scope 'spotify.playlists' must be produced or marked
	// omitted", 0.1.55 with an empty library). Track what each stream said so
	// the end of this function can close any stream left silent.
	const accounted = new Set<string>();
	const emit = async (msg: EmittedMessage): Promise<void> => {
		const m = msg as unknown as Record<string, unknown>;
		const stream = typeof m.stream === "string" ? m.stream : "";
		if (
			m.type === "RECORD" ||
			m.type === "STATE" ||
			m.type === "SKIP_RESULT" ||
			(m.type === "DETAIL_COVERAGE" &&
				typeof m.considered === "number" &&
				typeof m.covered === "number" &&
				m.covered < m.considered)
		) {
			accounted.add(stream);
		}
		await hostEmit(msg);
	};
	const emitRecord = async (stream: string, data: Record<string, unknown>): Promise<void> => {
		accounted.add(stream);
		await hostEmitRecord(stream, data);
	};
	const reportStreamFailure: BrowserCollectContext["reportStreamFailure"] = hostReportStreamFailure
		? async (stream, message, options) => {
				accounted.add(stream);
				await hostReportStreamFailure(stream, message, options);
			}
		: undefined;
	// A stream group fails alone when anything else was asked for; when it is
	// all that was asked for, the run fails as before.
	const othersRequested = (group: readonly string[]) =>
		requestedNames.some((stream) => !group.includes(stream));
	const playlistGroup = ["playlists", "playlist_items"] as const;

	await progress("Fetching Spotify data");
	const data = await collectSpotifyWebData(page, requestedNames, evaluateData);
	data.streamFailures ??= {};
	const failures = data.streamFailures;
	if (data.playlistRevisionUnproven) {
		for (const stream of playlistGroup) {
			if (!requested.has(stream)) continue;
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "inventory_not_proven_complete",
				message:
					"Spotify changed a playlist while its pages were being read; retry the inventory.",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
		}
	}
	const playlistsHandled = (stream: string) =>
		data.playlistRevisionUnproven === true &&
		(playlistGroup as readonly string[]).includes(stream);
	const librarySkipped =
		data.librarySkipped && data.librarySkipped.count > 0
			? data.librarySkipped
			: null;
	if (librarySkipped) {
		connectorDiagnostic("spotify", "library_rows_skipped", {
			skipped: librarySkipped.count,
			types: Object.entries(librarySkipped.types)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([type, rows]) => `${type}:${rows}`)
				.join(","),
		});
	}
	const playlistRowsSkipped =
		data.playlistRowsSkipped && data.playlistRowsSkipped.count > 0
			? data.playlistRowsSkipped
			: null;
	if (playlistRowsSkipped) {
		connectorDiagnostic("spotify", "playlist_rows_skipped", {
			skipped: playlistRowsSkipped.count,
			types: Object.entries(playlistRowsSkipped.types)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([type, rows]) => `${type}:${rows}`)
				.join(","),
		});
	}
	if (requested.has("profile") && data.profile) {
		if (!validateRecord("profile", data.profile).ok) {
			data.profile = null;
			data.sourceCounts.profile = { considered: 1, covered: 0 };
		}
	}
	for (const [stream, records] of [
		["playlists", data.playlists],
		["playlist_items", data.playlist_items],
		["saved_tracks", data.saved_tracks],
	] as const) {
		if (requested.has(stream) && !failures[stream]) {
			const validRecords = records.filter(
				(record) => validateRecord(stream, record).ok,
			);
			const invalidCount = records.length - validRecords.length;
			if (invalidCount > 0) {
				records.splice(0, records.length, ...validRecords);
				const covered =
					stream === "saved_tracks"
						? validRecords.filter(
								(record) => record.identity_unresolved !== true,
							).length
						: validRecords.length;
				data.sourceCounts[stream] = {
					considered:
						data.sourceCounts[stream]?.considered ??
						records.length + invalidCount,
					covered,
				};
				const proof = data.completion[stream];
				if (proof) proof.discardedCount += invalidCount;
				connectorDiagnostic("spotify", "source_rows_withheld", {
					stream,
					considered: String(data.sourceCounts[stream].considered),
					covered: String(covered),
				});
			}
		}
	}
	for (const [stream, records] of [
		["recently_played_contexts", data.recently_played_contexts],
		["top_artists", data.top_artists],
		["top_tracks", data.top_tracks],
	] as const) {
		if (!requested.has(stream)) continue;
		const validRecords = records.filter((record) =>
			validateRecord(stream, record).ok,
		);
		const invalidCount = records.length - validRecords.length;
		const counts = data.sourceCounts[stream] ?? {
			considered: records.length,
			covered: records.length,
		};
		if (invalidCount > 0) {
			records.splice(0, records.length, ...validRecords);
			counts.covered = Math.max(0, counts.covered - invalidCount);
		}
		data.sourceCounts[stream] = counts;
	}
	const libraryExpectation = {
		stream: requested.has("playlists") ? "playlists" : "playlist_items",
		operation: "libraryV3",
		owner: "spotify:user:me",
		selector: "spotify:user:me:library",
	};
	const playlistItemsExpectation =
		data.playlistUris.length === 0
			? { ...libraryExpectation, stream: "playlist_items" }
			: {
					stream: "playlist_items",
					operation: "fetchPlaylist",
					owner: "spotify:user:me",
					selector: data.playlistUris.join("\n"),
				};
	const savedExpectation = {
		stream: "saved_tracks",
		operation: "fetchLibraryTracks",
		owner: "spotify:user:me:collection",
		selector: "spotify:user:me:collection",
	};
	// A stream whose end the page could not prove fails alone, like any
	// other isolated stream, unless it is all that was asked for.
	const unproven = (
		stream: "playlists" | "playlist_items" | "saved_tracks",
		group: readonly string[],
		code: string,
	) => {
		if (!othersRequested(group)) throw new Error(code);
		failures[stream] = { code };
		if (stream === "saved_tracks") data.saved_tracks = [];
		else data[stream] = [];
	};
	if (
		requested.has("playlists") &&
		!failures.playlists &&
		!playlistsHandled("playlists") &&
		!hasSpotifyTerminalBoundary(data.completion.playlists, libraryExpectation)
	) {
		unproven("playlists", playlistGroup, "spotify_playlists_completion_unproven");
	}
	if (
		requested.has("playlist_items") &&
		!failures.playlist_items &&
		!playlistsHandled("playlist_items") &&
		!hasSpotifyTerminalBoundary(
			data.completion.playlist_items,
			playlistItemsExpectation,
		)
	) {
		unproven("playlist_items", playlistGroup, "spotify_playlist_items_completion_unproven");
	}
	const savedProof = data.completion.saved_tracks;
	const savedBoundaryProven =
		requested.has("saved_tracks") &&
		hasSpotifyEndProof(savedProof, savedExpectation);
	const savedBoundaryWithIncompleteRows =
		requested.has("saved_tracks") &&
		hasSpotifyTerminalBoundary(savedProof, savedExpectation) &&
		(savedProof.discardedCount > 0 ||
			(data.sourceCounts.saved_tracks?.covered ?? 0) <
				(data.sourceCounts.saved_tracks?.considered ?? 0));
	if (
		requested.has("saved_tracks") &&
		!failures.saved_tracks &&
		!savedBoundaryProven &&
		!savedBoundaryWithIncompleteRows
	) {
		unproven("saved_tracks", ["saved_tracks"], "spotify_saved_tracks_completion_unproven");
	}
	if (requested.has("profile")) {
		if (data.profile) await emitRecord("profile", data.profile);
		await emitDetailCoverage(
			{ emit },
			{
				stream: "profile",
				stateStream: "profile",
				requiredKeys: [],
				hydratedKeys: [],
				considered: data.sourceCounts.profile?.considered ?? 1,
				covered: data.profile ? (data.sourceCounts.profile?.covered ?? 0) : 0,
			},
		);
	}
	// A proven, gap-free full read of the library saves a full-scan checkpoint,
	// as saved_tracks does. On hosts that export a scope only when it has rows
	// or a checkpoint (PageShim, RSS), this is what lets an empty library, or
	// playlists with no tracks, export as "collected, none" instead of being
	// silently dropped.
	const fullScanState = async (
		stream: "playlists" | "playlist_items",
		proof: SpotifyEndEvidence,
	) =>
		emit({
			type: "STATE",
			stream,
			cursor: {
				full_scan_at: new Date().toISOString(),
				completion: {
					operation: proof.operation,
					pages: proof.pageCount,
					rows: proof.rawCount,
					terminal: proof.terminal,
				},
			},
		});
	for (const [stream, expectation] of [
		["playlists", libraryExpectation],
		["playlist_items", playlistItemsExpectation],
	] as const) {
		if (!requested.has(stream) || playlistsHandled(stream)) continue;
		const failure = failures[stream];
		if (failure) {
			await reportIsolatedStreamFailure(stream, failure, emit, reportStreamFailure);
			continue;
		}
		const records = data[stream];
		const counts = data.sourceCounts[stream] ?? {
			considered: records.length,
			covered: records.length,
		};
		await emitRecordsWithCoverage(stream, records, counts, emit, emitRecord);
		const proof = data.completion[stream];
		if (
			counts.covered >= counts.considered &&
			hasSpotifyEndProof(proof, expectation)
		) {
			await fullScanState(stream, proof);
		}
		if (librarySkipped) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_library_rows_unsupported",
				message:
					"Some library entries (folders or entry types this connector does not read yet) were skipped, so playlists inside them may be missing.",
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
			});
		}
		if (stream === "playlist_items" && playlistRowsSkipped) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_playlist_rows_unsupported",
				message:
					"Some playlist entries of a type this connector does not read yet were skipped; the other playlist tracks were still read.",
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
			});
		}
	}
	if (requested.has("saved_tracks")) {
		const failure = failures.saved_tracks;
		if (failure) {
			await reportIsolatedStreamFailure("saved_tracks", failure, emit, reportStreamFailure);
		} else {
			await emitRecordsWithCoverage(
				"saved_tracks",
				data.saved_tracks,
				data.sourceCounts.saved_tracks ?? {
					considered: data.saved_tracks.length,
					covered: data.saved_tracks.length,
				},
				emit,
				emitRecord,
			);
			if (savedBoundaryProven) {
				await emit({
					type: "STATE",
					stream: "saved_tracks",
					cursor: {
						full_scan_at: new Date().toISOString(),
						completion: {
							operation: savedProof.operation,
							pages: savedProof.pageCount,
							rows: savedProof.rawCount,
							terminal: savedProof.terminal,
						},
					},
				});
			}
		}
	}
	for (const stream of [
		"recently_played_contexts",
		"top_artists",
		"top_tracks",
	] as const) {
		if (!requested.has(stream)) continue;
		const failure = failures[stream];
		if (failure) {
			await reportIsolatedStreamFailure(stream, failure, emit, reportStreamFailure);
			continue;
		}
		const counts = data.sourceCounts[stream] ?? { considered: 0, covered: 0 };
		await emitRecordsWithCoverage(
			stream,
			data[stream],
			counts,
			emit,
			emitRecord,
		);
		if (counts.covered < counts.considered) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_source_row_unavailable",
				message: "One or more rows had unavailable mapped fields; each affected row was withheld whole.",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
		}
		if (stream === "recently_played_contexts") {
			// Spotify's pager ends in one of three ways: a page shorter than the
			// limit, a 404 with an empty body past the end, or that same 404 at
			// offset 0 for a history with nothing in it. Each is Spotify's own
			// end of the list it holds for this account, so the list is
			// complete and checkpointed (with 0 rows at offset 0). Only the
			// 20-page cap leaves contexts unread.
			//
			// 0.1.57 called the offset-0 404 "unavailable": two users who got it
			// on several runs then got contexts. On RSS prod (8 to 9 Nov 2026,
			// 21 such reads) the 404 was steady per user across retries up to
			// 80 minutes apart, 10 of the 15 full runs that got it were
			// accounts with no saved tracks, playlists or top items, and the one
			// user whose next run had contexts had exactly 1: a first play.
			const recent = data.diagnostics?.recentlyPlayed;
			if (
				recent &&
				(recent.endedBy === "short_page" ||
					recent.endedBy === "not_found_past_end" ||
					recent.endedBy === "not_found_at_start")
			) {
				if (recent.endedBy === "not_found_at_start") {
					connectorDiagnostic("spotify", "recently_played_empty", {
						endedBy: recent.endedBy,
						othersRequested: String(othersRequested([stream])),
					});
				}
				await emit({
					type: "STATE",
					stream,
					cursor: {
						full_scan_at: new Date().toISOString(),
						completion: {
							operation: "recently-played/v3",
							pages: recent.pages,
							rows: counts.considered,
							terminal: recent.endedBy,
						},
					},
				});
				continue;
			}
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_recent_context_boundary_unverified",
				message: "Spotify did not provide a request-bound terminal boundary; no checkpoint was saved.",
				recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
			});
		} else if (data.topProvenComplete?.[stream]) {
			// Every window was read to Spotify's own total (at most 100): no
			// row is beyond the request bound, so the ranking is complete,
			// whether it holds 0 rows or 40. The checkpoint is what lets
			// PageShim and RSS export it as collected instead of degraded (or,
			// when empty, omitted). Until 0.1.58 only a total of 0 counted, so
			// every short ranking was reported capped and the run partial.
			const proof = data.topProvenComplete[stream];
			if (proof.total === 0) connectorDiagnostic("spotify", "ranked_list_empty", { stream });
			await emit({
				type: "STATE",
				stream,
				cursor: {
					full_scan_at: new Date().toISOString(),
					completion: {
						operation: "userTopContent",
						rows: proof.rows,
						total: proof.total,
						time_ranges: ["short_term", "long_term"],
					},
				},
			});
		} else {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_ranked_list_capped",
				message: "The connector requests at most 100 ranking rows per time window; rows beyond that bound are unobserved, so no full-scan state was saved.",
				recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
			});
		}
	}
	// Last line of defence for the invariant above: a stream that reached
	// here with no record, checkpoint or receipt is reported, never dropped.
	for (const stream of requestedNames) {
		if (accounted.has(stream) || !SPOTIFY_STREAMS.includes(stream)) continue;
		connectorDiagnostic("spotify", "stream_outcome_missing", { stream });
		await emit({
			type: "SKIP_RESULT",
			stream,
			reason: "spotify_stream_outcome_unproven",
			message: "The connector could not prove this stream complete, so it was not exported this time.",
			recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
		});
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "spotify",
		validateRecord,
		retryablePattern: spotifyRetryablePattern,
		browser: { profileName: "spotify" },
		ensureSession: ensureSpotifySession,
		probeSession: ({ page }) => hasSpotifySession(page),
		probeSessionIsAuthoritative: true,
		collect: spotifyCollect,
	});
}

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
export const spotifyRetryablePattern =
	/rate_limited|ECONN|fetch failed|retryable status \d+|spotify_retryable_status_\d+/i;

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
): Promise<BrowserData> => {
		const wanted = new Set(requested);
		const result: BrowserData = {
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
		if (
			navigation.origin !== "https://open.spotify.com" ||
			navigation.pathname !== "/" ||
			navigation.search !== "" ||
			navigation.hash !== ""
		) {
			throw new Error("spotify_page_not_player");
		}
		const navigationProof = navigation.toString();
		const webVersion = "1.2.56.244.g7bfe3dc8";
		let clientId: string | null = null;

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
			const maxBundles = 60;
			const maxBundleBytes = 64 * 1024 * 1024;
			const hashPattern =
				/new\s+\w+\.\w+\("(\w+)","(?:query|mutation)","([a-f0-9]{64})"/g;
			const complete = (found: Record<string, string>) =>
				[...needed].every((name) => typeof found[name] === "string");
			async function scan(): Promise<Record<string, string>> {
				const found: Record<string, string> = {};
				let bundlesRead = 0;
				let bytesRead = 0;
				const extract = (text: string) => {
					const re = new RegExp(hashPattern.source, "g");
					let match = re.exec(text);
					while (match !== null) {
						const operation = match[1];
						const hash = match[2];
						if (operation && hash && needed.has(operation))
							found[operation] = hash;
						match = re.exec(text);
					}
				};
				const read = async (response: Response | undefined | null) => {
					if (
						!response ||
						bundlesRead >= maxBundles ||
						bytesRead >= maxBundleBytes
					)
						return;
					bundlesRead += 1;
					const remainingBytes = maxBundleBytes - bytesRead;
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
					bytesRead += bytes;
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
							if (complete(found)) return found;
							if (bundlesRead >= maxBundles || bytesRead >= maxBundleBytes)
								break;
						}
					}
				} catch {}
				if (complete(found)) return found;
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
					if (bundlesRead >= maxBundles || bytesRead >= maxBundleBytes) break;
					try {
						const response = await fetch(url);
						if (response.ok) await read(response);
						if (complete(found)) return found;
					} catch {}
				}
				return found;
			}
			let found: Record<string, string> = {};
			for (let attempt = 0; attempt < 3; attempt += 1) {
				found = await scan();
				if (complete(found)) return found;
				if (attempt < 2)
					await new Promise((resolve) => setTimeout(resolve, 3000));
			}
			const missing = [...needed].filter(
				(name) => typeof found[name] !== "string",
			);
			throw new Error(`spotify_missing_hashes_${missing.join(",")}`);
		}

		const access = await accessToken();
		const client = await clientToken();
		const hashes = await queryHashes();
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

		if (wanted.has("playlists") || wanted.has("playlist_items")) {
			const playlistUris: string[] = [];
			let libraryOffset = 0;
			const libraryLimit = 200;
			const libraryPageSignatures = new Set<string>();
			const libraryIdentities = new Set<string>();
			let libraryRawCount = 0;
			let libraryExpectedCount: number | null = null;
			let libraryPageCount = 0;
			let libraryTerminal: SpotifyEndEvidence["terminal"] = null;
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
					if (typeName === "Folder") {
						throw new Error("spotify_library_folder_untraversed");
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
					];
					if (!supportedLibraryTypes.includes(typeName)) {
						throw new Error("spotify_library_row_type_unrecognized");
					}
					const uri = data._uri ?? data.uri;
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
							if (trackData.__typename !== "Track") {
								if (["Episode", "PodcastEpisode"].includes(trackData.__typename))
									continue;
								throw new Error("spotify_playlist_row_type_unrecognized");
							}
							trackCount += 1;
							if (wanted.has("playlist_items")) childTrackCount += 1;
							if (!wanted.has("playlist_items")) continue;
							try {
								const artistNames = requireField(
									sourceArtists(trackData.artists, "playlist_track_artists"),
									"spotify_playlist",
								);
								const trackUri = requireField(
									readString(trackData.uri, "playlist_track_uri"),
									"spotify_playlist",
								);
								const trackName = requireField(
									readString(trackData.name, "playlist_track_name"),
									"spotify_playlist",
								);
								const album = sourceContainer(
									trackData.albumOfTrack,
									"album",
									"spotify_playlist",
								);
								const albumName = requireField(
									readString(child(album, "name"), "playlist_album_name"),
									"spotify_playlist",
								);
								const durationContainer = sourceContainer(
									trackData.trackDuration,
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
					playlistCoherent = true;
					break;
				}
				if (!playlistCoherent) {
					result.playlistRevisionUnproven = true;
					return result;
				}
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
								discardedCount: childTrackUnavailableCount,
								remaining: false,
								terminal:
									childRawCount === 0 ? "empty_verified" : "total_reached",
							};
			}
			if (wanted.has("playlists")) {
				libraryProof.discardedCount = playlistRowUnavailableCount;
				result.sourceCounts.playlists = {
					considered: playlistUris.length,
					covered: result.playlists.length,
				};
			}
			if (wanted.has("playlist_items")) {
				result.sourceCounts.playlist_items = {
					considered: childTrackCount,
					covered: childTrackCoveredCount,
				};
			}
		}

		if (wanted.has("saved_tracks")) {
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
		}

		if (wanted.has("recently_played_contexts")) {
			const attrs = await gql("profileAttributes", {});
			const profile = attrs?.data?.me?.profile;
			if (typeof profile?.username !== "string" || profile.username.length === 0) {
				throw new Error("spotify_recently_played_owner_unavailable");
			}
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
					throw new Error(`spotify_retryable_status_${response.status}`);
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
				result.sourceCounts.recently_played_contexts.covered = 0;
			}
		}

		if (wanted.has("top_artists") || wanted.has("top_tracks")) {
			const pageSize = 50;
			const maxItems = 100;
			for (const timeRange of ["SHORT_TERM", "LONG_TERM"] as const) {
				for (const stream of ["top_artists", "top_tracks"] as const) {
					if (!wanted.has(stream)) continue;
					const key = stream === "top_artists" ? "topArtists" : "topTracks";
					const pages = stream === "top_artists" ? result.top_artist_pages : result.top_track_pages;
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
	collector: (requested: string[]) => Promise<BrowserData> = spotifyPageCollector,
): string {
	return `(async () => {\nconst __name = (target) => target;\nreturn (${collector.toString()})(${JSON.stringify(requested)});\n})()`;
}

async function collectSpotifyWebData(
	page: BrowserCollectContext["page"],
	requestedStreams: string[],
	evaluateData?: (page: BrowserCollectContext["page"], streams: string[]) => Promise<BrowserData>,
): Promise<BrowserCollectResult> {
	await openSpotify(page);
	const evaluated = evaluateData ? await evaluateData(page, requestedStreams) : (await page.evaluate(
		spotifyPageEvaluateSource(requestedStreams),
	)) as BrowserData;
	if (requestedStreams.includes("recently_played_contexts")) {
		const recent = parseRecentContextRows(evaluated.recent_context_pages ?? []);
		evaluated.recently_played_contexts = recent.rows;
		evaluated.sourceCounts.recently_played_contexts = {
			considered: recent.considered,
			covered: recent.rows.length,
		};
	}
	evaluated.top_artists ??= [];
	evaluated.top_tracks ??= [];
	for (const timeRange of ["short_term", "long_term"] as const) {
		const artistPages = (evaluated.top_artist_pages ?? [])
			.filter((entry) =>
				readPath(entry, "timeRange") === timeRange.toUpperCase(),
			)
			.map((entry) => readPath(entry, "payload"));
		const trackPages = (evaluated.top_track_pages ?? [])
			.filter((entry) =>
				readPath(entry, "timeRange") === timeRange.toUpperCase(),
			)
			.map((entry) => readPath(entry, "payload"));
		if (requestedStreams.includes("top_artists")) {
			const parsed = parseTopRows(artistPages, "top_artists", timeRange);
			evaluated.top_artists.push(...parsed.rows);
			const counts = evaluated.sourceCounts.top_artists ?? { considered: 0, covered: 0 };
			counts.considered += parsed.considered;
			counts.covered += parsed.rows.length;
			evaluated.sourceCounts.top_artists = counts;
		}
		if (requestedStreams.includes("top_tracks")) {
			const parsed = parseTopRows(trackPages, "top_tracks", timeRange);
			evaluated.top_tracks.push(...parsed.rows);
			const counts = evaluated.sourceCounts.top_tracks ?? { considered: 0, covered: 0 };
			counts.considered += parsed.considered;
			counts.covered += parsed.rows.length;
			evaluated.sourceCounts.top_tracks = counts;
		}
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

export async function spotifyCollect({
	emit,
	emitRecord,
	page,
	progress,
	requested,
}: Pick<
	BrowserCollectContext,
	"emit" | "emitRecord" | "page" | "progress" | "requested"
>, evaluateData?: (page: BrowserCollectContext["page"], streams: string[]) => Promise<BrowserData>): Promise<void> {
	const requestedNames = [...requested.keys()];
	await progress("Fetching Spotify data");
	const data = await collectSpotifyWebData(page, requestedNames, evaluateData);
	if (data.playlistRevisionUnproven) {
		for (const stream of requested.keys()) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "inventory_not_proven_complete",
				message:
					"Spotify changed a playlist while its pages were being read; retry the inventory.",
				recovery_hint: { action: "retry_by_runtime", retryable: true },
			});
		}
		return;
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
		if (requested.has(stream)) {
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
	if (
		requested.has("playlists") &&
		!hasSpotifyTerminalBoundary(data.completion.playlists, libraryExpectation)
	) {
		throw new Error("spotify_playlists_completion_unproven");
	}
	if (
		requested.has("playlist_items") &&
		!hasSpotifyTerminalBoundary(
			data.completion.playlist_items,
			playlistItemsExpectation,
		)
	) {
		throw new Error("spotify_playlist_items_completion_unproven");
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
		!savedBoundaryProven &&
		!savedBoundaryWithIncompleteRows
	) {
		throw new Error("spotify_saved_tracks_completion_unproven");
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
	if (requested.has("playlists")) {
		await emitRecordsWithCoverage(
			"playlists",
			data.playlists,
			data.sourceCounts.playlists ?? {
				considered: data.playlists.length,
				covered: data.playlists.length,
			},
			emit,
			emitRecord,
		);
	}
	if (requested.has("playlist_items")) {
		await emitRecordsWithCoverage(
			"playlist_items",
			data.playlist_items,
			data.sourceCounts.playlist_items ?? {
				considered: data.playlist_items.length,
				covered: data.playlist_items.length,
			},
			emit,
			emitRecord,
		);
	}
	if (requested.has("saved_tracks")) {
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
	for (const stream of [
		"recently_played_contexts",
		"top_artists",
		"top_tracks",
	] as const) {
		if (!requested.has(stream)) continue;
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
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_recent_context_boundary_unverified",
				message: "Spotify did not provide a request-bound terminal boundary; no checkpoint was saved.",
				recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
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

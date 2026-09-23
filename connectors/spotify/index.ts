#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Spotify Connector (v0.1.2)
 *
 * Uses a logged-in open.spotify.com browser session and Spotify web-player
 * GraphQL endpoints. This keeps the legacy Desktop UX and avoids pasted public
 * Web API tokens that expire after roughly one hour.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	type EmittedMessage,
	type EnsureSessionArgs,
	emitDetailCoverage,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { validateRecord } from "./schemas.ts";

const API = "https://api.spotify.com/v1";
const SPOTIFY_WEB_HOME = "https://open.spotify.com/";

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
	items?: { total?: number | null };
	name?: string;
	owner?: { id?: string; display_name?: string };
	public?: boolean | null;
	snapshot_id?: string | null;
	tracks?: { total?: number | null };
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

interface BrowserData {
	playlist_items: Record<string, unknown>[];
	playlists: Record<string, unknown>[];
	profile: Record<string, unknown> | null;
	saved_tracks: Record<string, unknown>[];
}

interface BrowserCollectResult extends BrowserData {
	warnings: string[];
}

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
	return (images || [])
		.filter((img): img is SpotifyImage & { url: string } => Boolean(img.url))
		.map((img) => ({
			url: img.url,
			width: img.width ?? null,
			height: img.height ?? null,
		}));
}

export function spotifyPlaylistRecord(
	p: SpotifyPlaylist,
): Record<string, unknown> {
	return {
		id: p.id,
		name: p.name,
		owner_id: p.owner?.id ?? null,
		owner_name: p.owner?.display_name ?? null,
		public: p.public ?? null,
		collaborative: p.collaborative ?? null,
		track_count: p.items?.total ?? p.tracks?.total ?? null,
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
		position,
		added_at: item.added_at ?? null,
		added_by: item.added_by?.id ?? null,
		name: t?.name,
		artist_names: (t?.artists || []).map((a) => a.name),
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

async function hasSpotifySession(
	page: BrowserCollectContext["page"],
): Promise<boolean> {
	await openSpotify(page);
	return await page.evaluate(async () => {
		if (window.location.hostname !== "open.spotify.com") return false;
		try {
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
			const secretHex = Array.from(new TextEncoder().encode(xored.join("")))
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
			return Boolean(
				tokenResp.ok && tokenData.accessToken && !tokenData.isAnonymous,
			);
		} catch {
			return false;
		}
	});
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
			"Sign in to Spotify in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => hasSpotifySession(page),
		readinessProbe: hasSpotifySession,
		sendInteraction,
		timeoutSeconds: 30 * 60,
	});
	if (!ready) throw new Error("spotify_session_dead");
}

async function collectSpotifyWebData(
	page: BrowserCollectContext["page"],
	requestedStreams: string[],
): Promise<BrowserCollectResult> {
	await openSpotify(page);
	return await page.evaluate(async (requested) => {
		const wanted = new Set(requested);
		const warnings: string[] = [];
		const result: BrowserData = {
			profile: null,
			playlists: [],
			playlist_items: [],
			saved_tracks: [],
		};
		const webVersion = "1.2.56.244.g7bfe3dc8";
		let clientId: string | null = null;

		function idFromUri(uri: unknown): string | null {
			if (typeof uri !== "string") return null;
			const parts = uri.split(":");
			return parts.length >= 3 ? parts[parts.length - 1] || null : null;
		}

		function imageRecords(
			images: any,
		): Array<{ height: null; url: string; width: null }> {
			return (images?.items || [])
				.map((img: any) => img?.sources?.[0]?.url)
				.filter(
					(url: unknown): url is string =>
						typeof url === "string" && url.length > 0,
				)
				.map((url: string) => ({ url, width: null, height: null }));
		}

		function count(value: unknown): number | null {
			return Number.isSafeInteger(value) && Number(value) >= 0
				? Number(value)
				: null;
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
			const needed = [
				"fetchLibraryTracks",
				"fetchPlaylist",
				"libraryV3",
				"profileAttributes",
			];
			const found: Record<string, string> = {};
			const hashPattern =
				/new\s+\w+\.\w+\("(\w+)","(?:query|mutation)","([a-f0-9]{64})"/g;
			const extract = (text: string) => {
				const re = new RegExp(hashPattern.source, "g");
				let m = re.exec(text);
				while (m !== null) {
					const operation = m[1];
					const hash = m[2];
					if (operation && hash && needed.includes(operation))
						found[operation] = hash;
					m = re.exec(text);
				}
			};
			const complete = () => needed.every((name) => found[name]);
			try {
				const names = await caches.keys();
				const pcName = names.find((name) => name.includes("workbox-precache"));
				if (pcName) {
					const cache = await caches.open(pcName);
					for (const req of (await cache.keys())
						.filter((req) => req.url.endsWith(".js"))
						.slice(0, 20)) {
						const resp = await cache.match(req);
						if (resp) extract(await resp.text());
						if (complete()) return found;
					}
				}
			} catch {}
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
				try {
					const resp = await fetch(url);
					if (resp.ok) extract(await resp.text());
					if (complete()) return found;
				} catch {}
			}
			const missing = needed.filter((name) => !found[name]);
			if (missing.length > 0)
				warnings.push(`missing query hashes: ${missing.join(", ")}`);
			return found;
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
			const resp = await fetch(
				"https://api-partner.spotify.com/pathfinder/v2/query",
				{
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
				},
			);
			if (!resp.ok)
				throw new Error(`spotify_graphql_${operationName}_${resp.status}`);
			const data = await resp.json();
			if (data.errors)
				throw new Error(`spotify_graphql_${operationName}_errors`);
			return data;
		}

		if (wanted.has("profile")) {
			const attrs = await gql("profileAttributes", {});
			const pa = attrs?.data?.me?.profile;
			if (!pa?.username) throw new Error("spotify_profile_unavailable");
			const identityUri = pa.uri || `spotify:user:${pa.username}`;
			let enrichment: any = null;
			try {
				const enriched = await fetch(
					`https://spclient.wg.spotify.com/user-profile-view/v3/profile/${encodeURIComponent(pa.username)}`,
					{
						headers: {
							authorization: `Bearer ${access}`,
							"client-token": client,
							accept: "application/json",
							"app-platform": "WebPlayer",
						},
					},
				);
				enrichment = await enriched.json();
			} catch {}
			const sameAccount = enrichment?.uri === identityUri;
			const imageUrl =
				pa.imageUrl || (sameAccount ? enrichment?.image_url : null);
			result.profile = {
				id: pa.username,
				display_name: pa.name ?? null,
				followers: sameAccount ? count(enrichment?.followers_count) : null,
				uri: identityUri,
				images: imageUrl ? [{ url: imageUrl, width: null, height: null }] : [],
				following: sameAccount ? count(enrichment?.following_count) : null,
			};
		}

		if (wanted.has("playlists") || wanted.has("playlist_items")) {
			const playlistUris: string[] = [];
			let libraryOffset = 0;
			const libraryLimit = 200;
			while (true) {
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
				const pageItems = library?.items || [];
				playlistUris.push(
					...pageItems
						.filter((item: any) => item.item?.data?.__typename === "Playlist")
						.map(
							(item: any) =>
								item.item?.data?._uri || item.item?.data?.uri || "",
						)
						.filter(
							(uri: unknown): uri is string =>
								typeof uri === "string" && uri.length > 0,
						),
				);
				const total = count(library?.totalCount);
				if (
					pageItems.length < libraryLimit ||
					(total !== null && libraryOffset + pageItems.length >= total)
				)
					break;
				libraryOffset += libraryLimit;
			}
			for (const uri of playlistUris) {
				let offset = 0;
				let position = 0;
				let playlistId = idFromUri(uri);
				while (true) {
					const plData = await gql("fetchPlaylist", {
						uri,
						offset,
						limit: 100,
						enableWatchFeedEntrypoint: false,
					});
					const pl = plData?.data?.playlistV2;
					if (!pl) break;
					playlistId = idFromUri(pl.uri) || playlistId;
					if (!playlistId) break;
					const items = pl.content?.items || [];
					if (offset === 0 && wanted.has("playlists")) {
						result.playlists.push({
							id: playlistId,
							name: pl.name ?? undefined,
							owner_id: idFromUri(pl.ownerV2?.data?.uri),
							owner_name: pl.ownerV2?.data?.name ?? null,
							public: null,
							collaborative: null,
							track_count: count(pl.content?.totalCount),
							snapshot_id: null,
							description: pl.description ?? null,
							uri: pl.uri ?? uri,
							followers: count(pl.followers),
							images: imageRecords(pl.images),
						});
					}
					if (wanted.has("playlist_items")) {
						for (const item of items) {
							const t = item.itemV2?.data;
							if (t?.__typename !== "Track") continue;
							result.playlist_items.push({
								id: `${playlistId}:${position}`,
								playlist_id: playlistId,
								track_id: idFromUri(t.uri),
								position,
								added_at: item.addedAt?.isoString ?? null,
								added_by: item.addedBy?.data?.name ?? null,
								name: t.name ?? undefined,
								artist_names: (t.artists?.items || []).map(
									(a: any) => a.profile?.name ?? "",
								),
								album_name: t.albumOfTrack?.name ?? null,
								duration_ms: count(t.trackDuration?.totalMilliseconds),
							});
							position += 1;
						}
					}
					const total = count(pl.content?.totalCount) ?? items.length;
					if (items.length < 100 || position >= total) break;
					offset += 100;
				}
			}
		}

		if (wanted.has("saved_tracks")) {
			let offset = 0;
			while (true) {
				const data = await gql("fetchLibraryTracks", {
					uri: "spotify:user:me:collection",
					offset,
					limit: 100,
				});
				const tracks = data?.data?.me?.library?.tracks;
				const items = tracks?.items || [];
				for (const item of items) {
					const t = item.track?.data;
					const id = idFromUri(item.track?._uri || item.track?.uri);
					if (!t || !id) continue;
					const addedAt = item.addedAt?.isoString;
					if (!addedAt) {
						warnings.push(`saved track ${id} missing added_at; skipped`);
						continue;
					}
					result.saved_tracks.push({
						id,
						name: t.name ?? undefined,
						artist_names: (t.artists?.items || []).map(
							(a: any) => a.profile?.name ?? "",
						),
						album_name: t.albumOfTrack?.name ?? null,
						duration_ms: count(t.duration?.totalMilliseconds),
						popularity: null,
						added_at: addedAt,
						isrc: null,
						uri: item.track?._uri || item.track?.uri || null,
						explicit: t.contentRating?.label === "EXPLICIT",
						album_artist_names: (t.albumOfTrack?.artists?.items || []).map(
							(a: any) => a.profile?.name ?? "",
						),
					});
				}
				const total = count(tracks?.totalCount) ?? items.length;
				if (items.length < 100 || result.saved_tracks.length >= total) break;
				offset += 100;
			}
		}

		return { ...result, warnings };
	}, requestedStreams);
}

async function emitRecordsWithCoverage(
	stream: string,
	records: Record<string, unknown>[],
	emit: (msg: EmittedMessage) => Promise<void>,
	emitRecord: (stream: string, data: Record<string, unknown>) => Promise<void>,
): Promise<void> {
	let covered = 0;
	for (const record of records) {
		if (validateRecord(stream, record).ok) covered += 1;
		await emitRecord(stream, record);
	}
	await emitDetailCoverage(
		{ emit },
		{
			stream,
			stateStream: stream,
			requiredKeys: [],
			hydratedKeys: [],
			considered: records.length,
			covered,
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
>): Promise<void> {
	const requestedNames = [...requested.keys()];
	await progress("Fetching Spotify data");
	const data = await collectSpotifyWebData(page, requestedNames);

	if (requested.has("profile") && data.profile) {
		await emitRecord("profile", data.profile);
		await emitDetailCoverage(
			{ emit },
			{
				stream: "profile",
				stateStream: "profile",
				requiredKeys: [],
				hydratedKeys: [],
				considered: 1,
				covered: validateRecord("profile", data.profile).ok ? 1 : 0,
			},
		);
	}
	if (requested.has("playlists")) {
		await emitRecordsWithCoverage(
			"playlists",
			data.playlists,
			emit,
			emitRecord,
		);
	}
	if (requested.has("playlist_items")) {
		await emitRecordsWithCoverage(
			"playlist_items",
			data.playlist_items,
			emit,
			emitRecord,
		);
	}
	if (requested.has("saved_tracks")) {
		await emitRecordsWithCoverage(
			"saved_tracks",
			data.saved_tracks,
			emit,
			emitRecord,
		);
		await emit({
			type: "STATE",
			stream: "saved_tracks",
			cursor: { full_scan_at: new Date().toISOString() },
		});
	}
	for (const warning of data.warnings) {
		await progress(warning);
	}
	for (const stream of ["top_artists", "recently_played"] as const) {
		if (requested.has(stream)) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_browser_stage1_deferred",
				message:
					"Spotify browser connector stage 1 preserves profile, playlists, playlist items, and saved tracks; this Web API-only stream is deferred.",
			});
		}
	}
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "spotify",
		validateRecord,
		retryablePattern: /rate_limited|ECONN|fetch failed|retryable status \d+/i,
		browser: { profileName: "spotify" },
		ensureSession: ensureSpotifySession,
		probeSession: ({ page }) => hasSpotifySession(page),
		probeSessionIsAuthoritative: true,
		collect: spotifyCollect,
	});
}

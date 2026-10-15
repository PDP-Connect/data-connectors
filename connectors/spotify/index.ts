#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Spotify Connector (v0.1.26)
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

interface BrowserData {
	completion: Partial<
		Record<"playlists" | "playlist_items" | "saved_tracks", SpotifyEndEvidence>
	>;
	playlist_items: Record<string, unknown>[];
	playlistUris: string[];
	playlists: Record<string, unknown>[];
	profile: Record<string, unknown> | null;
	saved_tracks: Record<string, unknown>[];
	sourceCounts: Partial<
		Record<
			"playlists" | "playlist_items" | "saved_tracks",
			{ considered: number; covered: number }
		>
	>;
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
			"Sign in to Spotify in the secure browser, then continue. PDPP will verify the session before collecting.",
		page,
		probe: () => hasSpotifySession(page),
		readinessProbe: hasSpotifySession,
		readinessProbeOnHandoffPage: true,
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
		const result: BrowserData = {
			completion: {},
			profile: null,
			playlistUris: [],
			playlists: [],
			playlist_items: [],
			saved_tracks: [],
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

		function spotifyTrackId(uri: unknown, sourceId: unknown): string | null {
			const uriId = idFromUri(uri);
			if (uriId !== null) return uriId;
			return typeof sourceId === "string" && sourceId.length > 0
				? sourceId
				: null;
		}

		function imageRecords(
			images: any,
		): Array<{ height: null; url: string; width: null }> {
			return (images?.items ?? [])
				.map((img: any) => img?.sources?.[0]?.url)
				.filter((url: unknown): url is string => typeof url === "string")
				.map((url: string) => ({ url, width: null, height: null }));
		}

		function count(value: unknown): number | null {
			return Number.isSafeInteger(value) && Number(value) >= 0
				? Number(value)
				: null;
		}

		function sourceArtistNames(value: unknown): string[] | null {
			if (!Array.isArray(value)) return null;
			const names: string[] = [];
			for (const entry of value) {
				if (typeof entry !== "object" || entry === null) return null;
				const profile = (entry as Record<string, unknown>).profile;
				if (typeof profile !== "object" || profile === null) return null;
				const name = (profile as Record<string, unknown>).name;
				if (typeof name !== "string") return null;
				names.push(name);
			}
			return names;
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
			const attrs = await gql("profileAttributes", {});
			const pa = attrs?.data?.me?.profile;
			if (!pa?.username) throw new Error("spotify_profile_unavailable");
			const identityUri = pa.uri ?? `spotify:user:${pa.username}`;
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
				pa.imageUrl ?? (sameAccount ? enrichment?.image_url : null);
			result.profile = {
				id: pa.username,
				display_name: pa.name ?? null,
				followers: sameAccount ? count(enrichment?.followers_count) : null,
				uri: identityUri,
				images:
					typeof imageUrl === "string"
						? [{ url: imageUrl, width: null, height: null }]
						: [],
				following: sameAccount ? count(enrichment?.following_count) : null,
			};
		}

		if (wanted.has("playlists") || wanted.has("playlist_items")) {
			const playlistUris: string[] = [];
			let libraryOffset = 0;
			const libraryLimit = 200;
			const libraryPageSignatures = new Set<string>();
			let libraryRawCount = 0;
			let libraryExpectedCount: number | null = null;
			let libraryPageCount = 0;
			let libraryTerminal: SpotifyEndEvidence["terminal"] = null;
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
				if (!library || !Array.isArray(library.items)) {
					throw new Error("spotify_library_response_invalid");
				}
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
					const data = item?.item?.data;
					if (!data || typeof data !== "object") {
						throw new Error("spotify_library_row_invalid");
					}
					if (data.__typename !== "Playlist") continue;
					const uri = data._uri ?? data.uri;
					if (typeof uri !== "string" || uri.length === 0) {
						throw new Error("spotify_library_playlist_identity_missing");
					}
					playlistUris.push(uri);
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
					libraryTerminal =
						pageItems.length === 0 && libraryRawCount === 0
							? "empty_verified"
							: "short_page";
					break;
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
			let childLastOffset = 0;
			for (const uri of playlistUris) {
				let offset = 0;
				let position = 0;
				const requestedPlaylistId = idFromUri(uri);
				if (requestedPlaylistId === null) {
					throw new Error("spotify_library_playlist_identity_missing");
				}
				let playlistName: unknown;
				let ownerId: string | null = null;
				let ownerName: unknown;
				let description: unknown;
				let uriValue: unknown = uri;
				let followers: number | null = null;
				let images: Array<{ height: null; url: string; width: null }> = [];
				const playlistPageSignatures = new Set<string>();
				let playlistRawCount = 0;
				let playlistExpectedCount: number | null = null;
				let playlistPageCount = 0;
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
						!pl ||
						typeof pl.uri !== "string" ||
						pl.uri !== uri ||
						!pl.content ||
						!Array.isArray(pl.content.items)
					) {
						throw new Error("spotify_playlist_response_invalid");
					}
					const items = pl.content.items;
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
					const signature = pageSignature(items);
					if (items.length > 0 && playlistPageSignatures.has(signature)) {
						throw new Error("spotify_playlist_pagination_no_progress");
					}
					if (items.length > 0) playlistPageSignatures.add(signature);
					if (requestOffset === 0) {
						const responseId = idFromUri(pl.uri);
						if (responseId === null || responseId !== requestedPlaylistId) {
							throw new Error("spotify_playlist_identity_mismatch");
						}
						playlistName = pl.name;
						ownerId = idFromUri(pl.ownerV2?.data?.uri);
						ownerName = pl.ownerV2?.data?.name;
						description = pl.description;
						uriValue = pl.uri;
						followers = count(pl.followers);
						images = imageRecords(pl.images);
					}
					for (const item of items) {
						const t = item.itemV2?.data;
						if (
							!t ||
							typeof t !== "object" ||
							typeof t.__typename !== "string"
						) {
							throw new Error("spotify_playlist_row_invalid");
						}
						if (t.__typename !== "Track") continue;
						const artistNames = sourceArtistNames(t.artists?.items);
						if (artistNames === null) {
							throw new Error("spotify_playlist_track_artists_invalid");
						}
						const trackId = spotifyTrackId(t.uri, t.id);
						if (wanted.has("playlist_items")) {
							result.playlist_items.push({
								id: `${requestedPlaylistId}:${position}`,
								playlist_id: requestedPlaylistId,
								track_id: trackId,
								uri: typeof t.uri === "string" ? t.uri : null,
								position,
								added_at: item.addedAt?.isoString ?? null,
								added_by: item.addedBy?.data?.name ?? null,
								name: t.name ?? undefined,
								artist_names: artistNames,
								album_name: t.albumOfTrack?.name ?? null,
								duration_ms: count(t.trackDuration?.totalMilliseconds),
							});
						}
						position += 1;
						childTrackCount += 1;
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
						break;
					}
					if (items.length === 0)
						throw new Error("spotify_playlist_pagination_no_progress");
					if (nextOffset <= offset) {
						throw new Error("spotify_playlist_pagination_no_progress");
					}
					offset = nextOffset;
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
				if (wanted.has("playlists")) {
					result.playlists.push({
						id: requestedPlaylistId,
						name: playlistName,
						owner_id: ownerId,
						owner_name: ownerName ?? null,
						public: null,
						collaborative: null,
						track_count: position,
						snapshot_id: null,
						description: description ?? null,
						uri: uriValue,
						followers,
						images,
					});
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
								pageCount: childPageCount,
								rawCount: childRawCount,
								expectedCount: childCountKnown ? childExpectedCount : null,
								discardedCount: 0,
								remaining: false,
								terminal:
									childRawCount === 0
										? "empty_verified"
										: childCountKnown
											? "total_reached"
											: "short_page",
							};
			}
			if (wanted.has("playlists")) {
				result.sourceCounts.playlists = {
					considered: playlistUris.length,
					covered: result.playlists.length,
				};
			}
			if (wanted.has("playlist_items")) {
				result.sourceCounts.playlist_items = {
					considered: childTrackCount,
					covered: childTrackCount,
				};
			}
		}

		if (wanted.has("saved_tracks")) {
			let offset = 0;
			const savedTrackPageSignatures = new Set<string>();
			let rawCount = 0;
			let expectedCount: number | null = null;
			let pageCount = 0;
			let terminal: SpotifyEndEvidence["terminal"] = null;
			let unresolvedIdentityCount = 0;
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
					const t = item.track?.data;
					if (!t || typeof t !== "object" || typeof t.name !== "string") {
						throw new Error("spotify_saved_tracks_row_invalid");
					}
					const trackUri = item.track?._uri ?? item.track?.uri;
					const id = spotifyTrackId(trackUri, t.id);
					const artistNames = sourceArtistNames(t.artists?.items);
					if (artistNames === null) {
						throw new Error("spotify_saved_tracks_artists_invalid");
					}
					const albumArtistNames = sourceArtistNames(
						t.albumOfTrack?.artists?.items ?? [],
					);
					if (albumArtistNames === null) {
						throw new Error("spotify_saved_tracks_album_artists_invalid");
					}
					const addedAt = item.addedAt?.isoString;
					if (
						addedAt !== undefined &&
						addedAt !== null &&
						typeof addedAt !== "string"
					) {
						throw new Error("spotify_saved_tracks_added_at_invalid");
					}
					if (id === null) unresolvedIdentityCount += 1;
					result.saved_tracks.push({
						id,
						identity_unresolved: id === null,
						name: t.name,
						artist_names: artistNames,
						album_name: t.albumOfTrack?.name ?? null,
						duration_ms: count(t.duration?.totalMilliseconds),
						popularity: null,
						added_at: addedAt ?? null,
						isrc: null,
						uri: typeof trackUri === "string" ? trackUri : null,
						explicit:
							typeof t.contentRating?.label === "string"
								? t.contentRating.label === "EXPLICIT"
								: null,
						album_artist_names: albumArtistNames,
					});
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
					terminal =
						items.length === 0 && rawCount === 0
							? "empty_verified"
							: "short_page";
					break;
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
				covered: rawCount - unresolvedIdentityCount,
			};
			result.completion.saved_tracks = {
				stream: "saved_tracks",
				operation: "fetchLibraryTracks",
				navigation: navigationProof,
				owner: "spotify:user:me:collection",
				selector: "spotify:user:me:collection",
				firstOffset: 0,
				lastOffset: offset,
				pageCount,
				rawCount,
				expectedCount,
				discardedCount: unresolvedIdentityCount,
				remaining: false,
				terminal,
			};
		}

		return result;
	}, requestedStreams);
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
>): Promise<void> {
	const requestedNames = [...requested.keys()];
	await progress("Fetching Spotify data");
	const data = await collectSpotifyWebData(page, requestedNames);
	if (requested.has("profile")) {
		if (!data.profile) throw new Error("spotify_profile_response_invalid");
		if (!validateRecord("profile", data.profile).ok) {
			throw new Error("spotify_profile_record_invalid");
		}
	}
	for (const [stream, records] of [
		["playlists", data.playlists],
		["playlist_items", data.playlist_items],
		["saved_tracks", data.saved_tracks],
	] as const) {
		if (
			requested.has(stream) &&
			records.some((record) => !validateRecord(stream, record).ok)
		) {
			connectorDiagnostic("spotify", "source_row_invalid", {
				stream,
				considered: String(
					data.sourceCounts[stream]?.considered ?? records.length,
				),
				covered: String(data.sourceCounts[stream]?.covered ?? 0),
			});
			throw new Error(`spotify_${stream}_record_invalid`);
		}
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
		!hasSpotifyEndProof(data.completion.playlists, libraryExpectation)
	) {
		throw new Error("spotify_playlists_completion_unproven");
	}
	if (
		requested.has("playlist_items") &&
		!hasSpotifyEndProof(
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
	const savedBoundaryWithUnresolvedIdentity =
		requested.has("saved_tracks") &&
		hasSpotifyTerminalBoundary(savedProof, savedExpectation) &&
		(savedProof.discardedCount > 0 ||
			(data.sourceCounts.saved_tracks?.covered ?? 0) <
				(data.sourceCounts.saved_tracks?.considered ?? 0));
	if (
		requested.has("saved_tracks") &&
		!savedBoundaryProven &&
		!savedBoundaryWithUnresolvedIdentity
	) {
		throw new Error("spotify_saved_tracks_completion_unproven");
	}
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
	for (const stream of ["top_artists", "recently_played"] as const) {
		if (requested.has(stream)) {
			await emit({
				type: "SKIP_RESULT",
				stream,
				reason: "spotify_browser_stage1_deferred",
				recovery_hint: {
					action: "retry_on_connector_upgrade",
					retryable: false,
				},
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
		retryablePattern: spotifyRetryablePattern,
		browser: { profileName: "spotify" },
		ensureSession: ensureSpotifySession,
		probeSession: ({ page }) => hasSpotifySession(page),
		probeSessionIsAuthoritative: true,
		collect: spotifyCollect,
	});
}

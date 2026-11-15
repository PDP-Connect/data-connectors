// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Google Takeout connector. Kept free of runtime I/O
// orchestration so they can be unit-tested in isolation (see parsers.test.ts).
// File-existence checks and the emit loop live in index.ts.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { buildWatchHistoryRecord as sharedBuildWatchHistoryRecord } from "../../packages/polyfill-connectors/src/youtube-watch-history.ts";
import type {
	LocationPoint,
	LocationRecord,
	PhotoMetadataFile,
	PhotoRecord,
	SearchHistoryEntry,
	SearchRecord,
	WatchHistoryEntry,
	WatchHistoryRecord,
} from "./types.ts";

// E7-scaled geo coords from Google's Android location schema: multiply by 1e-7.
const GOOGLE_E7_DIVISOR = 1e7;
// Length of sha256-derived record IDs — 24 hex chars = 96 bits of entropy.
const RECORD_ID_HASH_LENGTH = 24;

// Module-level regex (Biome useTopLevelRegex).
export const SEARCHED_FOR_PREFIX_RE = /^Searched for /;

export function hashId(s: string): string {
	return createHash("sha256")
		.update(s)
		.digest("hex")
		.slice(0, RECORD_ID_HASH_LENGTH);
}

export async function readJsonIf(path: string): Promise<unknown> {
	if (!existsSync(path)) {
		return null;
	}
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return null;
	}
}

/**
 * Resolve a Google location point's absolute timestamp (Unix ms). Google
 * exports use either `timestampMs` (older) or ISO `timestamp` (newer).
 * Returns null when neither is usable.
 */
export function locationTimestampMs(loc: LocationPoint): number | null {
	if (typeof loc.timestampMs === "string") {
		const n = Number.parseInt(loc.timestampMs, 10);
		return Number.isFinite(n) ? n : null;
	}
	if (loc.timestamp) {
		const n = Date.parse(loc.timestamp);
		return Number.isNaN(n) ? null : n;
	}
	return null;
}

export function scaleE7(v: number | undefined): number | null {
	return typeof v === "number" ? v / GOOGLE_E7_DIVISOR : null;
}

/**
 * Build a location_history record from a raw LocationPoint at a given ISO
 * timestamp. Caller is responsible for the since-cursor filter.
 */
export function buildLocationRecord(
	loc: LocationPoint,
	iso: string,
): LocationRecord {
	const lat = scaleE7(loc.latitudeE7);
	const lon = scaleE7(loc.longitudeE7);
	return {
		id: hashId(`loc|${iso}|${lat}|${lon}`),
		timestamp: iso,
		latitude: lat,
		longitude: lon,
		accuracy_meters: loc.accuracy ?? null,
		activity_type: loc.activity?.[0]?.activity?.[0]?.type ?? null,
		velocity_mps: loc.velocity ?? null,
		altitude_m: loc.altitude ?? null,
	};
}

/**
 * Build a youtube_watch_history record from a raw WatchHistoryEntry. Returns
 * null if the entry is missing a timestamp.
 *
 * Delegates to the shared library module (src/youtube-watch-history.ts),
 * which the `youtube` connector's manual-import reads the same file format
 * through — see D9 in docs/migration/connector-cutover/CONTRACTS.md. Kept
 * as a re-export here so existing imports of `./parsers.ts` (this
 * connector's tests, index.ts) do not need to change.
 */
export function buildWatchHistoryRecord(
	e: WatchHistoryEntry,
): WatchHistoryRecord | null {
	return sharedBuildWatchHistoryRecord(e);
}

/**
 * Build a search_history record from a raw SearchHistoryEntry. Returns null
 * if the entry is missing a timestamp.
 */
export function buildSearchRecord(e: SearchHistoryEntry): SearchRecord | null {
	const ts = e.time || null;
	if (!ts) {
		return null;
	}
	const query = (e.title || "").replace(SEARCHED_FOR_PREFIX_RE, "");
	return {
		id: hashId(`gs|${ts}|${query}`),
		timestamp: ts,
		query,
		product: e.header || null,
	};
}

/**
 * Extract event timestamp from Google Takeout photo metadata.
 * Prefers photoTakenTime (EXIF) over creationTime (upload).
 * Returns null if neither is present or valid.
 */
export function photoEventTimeMs(meta: PhotoMetadataFile): number | null {
	let ts: string | undefined;
	if (meta.photoTakenTime?.timestamp) {
		ts = meta.photoTakenTime.timestamp;
	} else if (meta.creationTime?.timestamp) {
		ts = meta.creationTime.timestamp;
	}
	if (!ts) {
		return null;
	}
	const n = Date.parse(ts);
	return Number.isNaN(n) ? null : n;
}

/**
 * Google Takeout duplicates a photo's file + sidecar into every album folder
 * it belongs to (per-copy fields like creationTime/imageViews can differ
 * between copies of the same underlying photo — see connector-primary-
 * reconcile-0807.md §2). Filename + folder is therefore not a safe identity
 * key. Content sha256 is: identical bytes always mean the same underlying
 * asset, and it naturally collapses duplicate album copies to one record.
 */
export function buildPhotoRecord(
	filename: string,
	iso: string,
	contentSha256: string | null,
	metadata?: PhotoMetadataFile | null,
): Omit<
	PhotoRecord,
	"blob_ref" | "hydration_error" | "hydration_status" | "size_bytes"
> {
	let lat: number | null = null;
	let lon: number | null = null;
	let alt: number | null = null;

	if (metadata?.geoDataExif) {
		lat = metadata.geoDataExif.latitude ?? null;
		lon = metadata.geoDataExif.longitude ?? null;
		alt = metadata.geoDataExif.altitude ?? null;
	} else if (metadata?.geoData) {
		lat = metadata.geoData.latitude ?? null;
		lon = metadata.geoData.longitude ?? null;
		alt = metadata.geoData.altitude ?? null;
	}

	// Fall back to a filename+event_time identity when content bytes are
	// unavailable (e.g. the file could not be read) so the record can still
	// be emitted rather than dropped.
	const id = contentSha256
		? hashId(`photo|${contentSha256}`)
		: hashId(`photo|${iso}|${filename}`);

	return {
		id,
		filename,
		event_time: iso,
		title: metadata?.title ?? null,
		description: metadata?.description ?? null,
		latitude: lat,
		longitude: lon,
		altitude: alt,
		content_sha256: contentSha256,
	};
}

// Match complete names first; only a unique directory-wide truncated stem
// may fall back to prefix matching. Edited variants use an explicit suffix.
const SIDECAR_JSON_RE = /\.json$/i;
const SUPPLEMENTAL_SUFFIX = "supplemental-metadata";
const DUPLICATE_MARKER_RE = /\((\d+)\)$/;
const EDITED_SUFFIX_RE = /-edited(?=\.[^.]+$)/i;
const EXTENSION_RE = /\.[^.]+$/;

/**
 * The media filename a sidecar describes, as far as its possibly truncated
 * name tells: drops `.json`, a whole or cut-off `.supplemental-metadata`,
 * and moves a duplicate marker back before the extension
 * (`IMG.jpg(1).json` and `IMG.jpg.supplemental-metadata(1).json` describe
 * `IMG(1).jpg`).
 */
function sidecarStem(candidate: string): string {
	let stem = candidate.replace(SIDECAR_JSON_RE, "");
	const marker = DUPLICATE_MARKER_RE.exec(stem);
	stem = stem.replace(DUPLICATE_MARKER_RE, "");
	const dot = stem.lastIndexOf(".");
	const tail = dot >= 0 ? stem.slice(dot + 1).toLowerCase() : "";
	if (tail && SUPPLEMENTAL_SUFFIX.startsWith(tail)) {
		stem = stem.slice(0, dot);
	}
	if (marker) {
		const ext = EXTENSION_RE.exec(stem)?.[0] ?? "";
		stem = `${stem.slice(0, stem.length - ext.length)}(${marker[1]})${ext}`;
	}
	return stem;
}

/** Same name, or same name without its extension (a Live Photo's HEIC and MP4). */
function describesMedia(stem: string, name: string): boolean {
	const base = name.replace(EDITED_SUFFIX_RE, "");
	return base === stem || base.replace(EXTENSION_RE, "") === stem;
}

export function sidecarMediaMatches(
	candidate: string,
	mediaFilenamesInDir: readonly string[],
): { matches: string[]; ambiguousCount: number } {
	if (!SIDECAR_JSON_RE.test(candidate)) {
		return { matches: [], ambiguousCount: 0 };
	}
	const stem = sidecarStem(candidate);
	if (!stem) {
		return { matches: [], ambiguousCount: 0 };
	}
	const exact = mediaFilenamesInDir.filter((name) =>
		describesMedia(stem, name),
	);
	if (exact.length > 0) {
		return { matches: exact, ambiguousCount: 0 };
	}
	const matches = mediaFilenamesInDir.filter((name) => name.startsWith(stem));
	return matches.length > 1
		? { matches: [], ambiguousCount: matches.length }
		: { matches, ambiguousCount: 0 };
}

/** Directory callers must supply the complete media list to reject ambiguity. */
export function matchSidecarFilename(
	mediaFilename: string,
	jsonFilenamesInDir: readonly string[],
	mediaFilenamesInDir: readonly string[] = [mediaFilename],
): string | null {
	const exact = `${mediaFilename}.json`;
	if (jsonFilenamesInDir.includes(exact)) {
		return exact;
	}
	let best: string | null = null;
	for (const candidate of jsonFilenamesInDir) {
		if (
			sidecarMediaMatches(candidate, mediaFilenamesInDir).matches.includes(
				mediaFilename,
			) &&
			(best === null || candidate.length > best.length)
		) {
			best = candidate;
		}
	}
	return best;
}

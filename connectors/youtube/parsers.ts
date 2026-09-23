// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the YouTube Takeout connector. Kept free of runtime I/O
 * orchestration (file-existence checks and the emit loop live in index.ts)
 * so they can be unit-tested in isolation.
 *
 * COVERAGE STATUS (verified against a real Takeout only for watch_history):
 *
 *   - watch_history: VERIFIED. Delegates to the shared
 *     src/youtube-watch-history.ts module, whose file path and shape were
 *     confirmed from connectors/google_takeout (existing fixtures/tests).
 *   - profile, subscriptions, playlists, playlist_items, likes, watch_later:
 *     UNVERIFIED. No fixture or repo evidence confirms these files exist in
 *     a real "YouTube and YouTube Music" Takeout export, their exact path,
 *     or their exact column names. The parsers below are written against
 *     Google's publicly documented Takeout CSV/JSON conventions for this
 *     export, but every parser is defensive (tolerates missing/renamed
 *     columns by nulling the field, never guessing) specifically because
 *     that evidence is missing. Do not read a passing parser test as proof
 *     these files exist in the real export — the report says so explicitly.
 */

import { createHash } from "node:crypto";
import {
	buildWatchHistoryRecord as sharedBuildWatchHistoryRecord,
	type WatchHistoryEntry,
} from "../../packages/polyfill-connectors/src/youtube-watch-history.ts";
import type {
	LikeRecord,
	PlaylistItemRecord,
	PlaylistRecord,
	ProfileRecord,
	SubscriptionRecord,
	WatchHistoryRecord,
	WatchLaterRecord,
} from "./types.ts";

const RECORD_ID_HASH_LENGTH = 24;

export function hashId(s: string): string {
	return createHash("sha256")
		.update(s)
		.digest("hex")
		.slice(0, RECORD_ID_HASH_LENGTH);
}

// ── Watch history (shared with google_takeout.youtube_watch_history) ──────

export function buildWatchHistoryRecordFromEntry(
	e: WatchHistoryEntry,
): WatchHistoryRecord | null {
	const shared = sharedBuildWatchHistoryRecord(e);
	if (!shared) {
		return null;
	}
	return {
		id: shared.id,
		watched_at: shared.watched_at,
		video_id: extractVideoId(shared.video_url),
		video_url: shared.video_url,
		video_title: shared.video_title,
		channel_title: shared.channel_name,
		channel_url: shared.channel_url,
		view_count: null,
		description: null,
	};
}

// ── Small shared helpers ───────────────────────────────────────────────────

const VIDEO_ID_QUERY_RE = /[?&]v=([\w-]{6,})/;
const VIDEO_ID_SHORTS_RE = /\/shorts\/([\w-]{6,})/;

export function extractVideoId(url: string | null): string | null {
	if (!url) {
		return null;
	}
	const m = VIDEO_ID_QUERY_RE.exec(url) ?? VIDEO_ID_SHORTS_RE.exec(url);
	return m?.[1] ?? null;
}

export function trimmedOrNull(value: string | undefined | null): string | null {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
}

export function intOrNull(value: string | undefined | null): number | null {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") {
		return null;
	}
	const n = Number.parseInt(trimmed, 10);
	return Number.isFinite(n) ? n : null;
}

/**
 * "MM:SS" or "H:MM:SS" duration text to whole seconds. Google's own
 * documented CSV export for playlist items formats duration this way, not
 * as a raw seconds column. Returns null on anything that doesn't parse —
 * never a guess.
 */
export function durationTextToSeconds(
	value: string | undefined | null,
): number | null {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") {
		return null;
	}
	const parts = trimmed.split(":");
	if (
		parts.length < 2 ||
		parts.length > 3 ||
		!parts.every((p) => /^\d+$/.test(p))
	) {
		return null;
	}
	const nums = parts.map((p) => Number.parseInt(p, 10));
	let seconds = 0;
	for (const n of nums) {
		seconds = seconds * 60 + n;
	}
	return seconds;
}

// ── Minimal RFC 4180 CSV row reader ─────────────────────────────────────────
// Not shared with connectors/strava/parsers.ts (a connector never imports
// another connector, and Strava's export has no repeated-header trap this
// reader needs to guard against) — a small self-contained reader instead.

export function parseCsvRows(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQuotes = false;
	let sawAnyChar = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		if (!sawAnyChar && ch === "﻿") {
			continue;
		}
		sawAnyChar = true;

		if (inQuotes) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			inQuotes = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (ch !== "\r") {
			field += ch;
		}
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

function headerIndex(header: readonly string[]): Map<string, number> {
	const map = new Map<string, number>();
	header.forEach((name, index) => {
		map.set(name.trim(), index);
	});
	return map;
}

function cell(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
	name: string,
): string | undefined {
	const index = columns.get(name);
	return index === undefined ? undefined : row[index];
}

// ── profile (channel.csv, UNVERIFIED path/columns) ─────────────────────────

/**
 * UNVERIFIED (see file header). Google's documented Takeout channel export
 * is a single-row CSV under "YouTube and YouTube Music/Channel/channel.csv"
 * with columns "Channel Id" and "Channel Url". Handle/title/stats are not
 * in that file at all as far as any evidence in this repo shows — those
 * fields are always null from this parser until a real export proves
 * otherwise, and the connector reports the gap via coverage_diagnostics
 * rather than presenting them as "collected but empty".
 */
export function buildProfileRecordFromChannelCsvRow(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
	email: string | null,
): ProfileRecord | null {
	const id = trimmedOrNull(cell(row, columns, "Channel Id"));
	if (!id) {
		return null;
	}
	return {
		id,
		channel_url: trimmedOrNull(cell(row, columns, "Channel Url")),
		title: null,
		handle: null,
		email,
		joined_at: null,
		avatar_url: null,
		description: null,
		country: null,
		subscriber_count: null,
		view_count: null,
		video_count: null,
	};
}

// ── subscriptions (subscriptions.csv, UNVERIFIED path/columns) ─────────────

/**
 * UNVERIFIED (see file header). Google's documented Takeout subscriptions
 * export is "YouTube and YouTube Music/subscriptions/subscriptions.csv"
 * with columns "Channel Id", "Channel Url", "Channel Title". No verified
 * source states this file carries verification, notifications, or
 * subscriber-count columns, so those fields are always null here.
 */
export function buildSubscriptionRecordFromCsvRow(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
): SubscriptionRecord | null {
	const channelId = trimmedOrNull(cell(row, columns, "Channel Id"));
	if (!channelId) {
		return null;
	}
	return {
		id: channelId,
		channel_id: channelId,
		channel_url: trimmedOrNull(cell(row, columns, "Channel Url")),
		channel_title: trimmedOrNull(cell(row, columns, "Channel Title")),
		handle: null,
		avatar_url: null,
		subscriber_count: null,
		description: null,
		is_verified: null,
		notifications: null,
	};
}

export function parseSubscriptionsCsv(text: string): SubscriptionRecord[] {
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header) {
		return [];
	}
	const columns = headerIndex(header);
	const out: SubscriptionRecord[] = [];
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildSubscriptionRecordFromCsvRow(row, columns);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

// ── playlists (playlists.csv, UNVERIFIED path/columns) ──────────────────────

/**
 * UNVERIFIED (see file header). Google's documented Takeout playlists
 * export is "YouTube and YouTube Music/playlists/playlists.csv" listing
 * "Playlist Id" and "Playlist Name" per row; per-playlist item files live
 * alongside it as "<Playlist Name>-videos.csv". No verified source states
 * this index file carries owner/visibility/video-count/view-count columns.
 */
export function buildPlaylistRecordFromCsvRow(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
): PlaylistRecord | null {
	const id = trimmedOrNull(cell(row, columns, "Playlist Id"));
	if (!id) {
		return null;
	}
	return {
		id,
		title: trimmedOrNull(cell(row, columns, "Playlist Name")),
		url: null,
		owner: null,
		owner_url: null,
		visibility: trimmedOrNull(cell(row, columns, "Playlist Visibility")),
		video_count: null,
		view_count: null,
	};
}

export function parsePlaylistsCsv(text: string): PlaylistRecord[] {
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header) {
		return [];
	}
	const columns = headerIndex(header);
	const out: PlaylistRecord[] = [];
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildPlaylistRecordFromCsvRow(row, columns);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

// ── playlist items (<Playlist Name>-videos.csv, UNVERIFIED path/columns) ───

/**
 * UNVERIFIED (see file header). Google's documented per-playlist item
 * export lists one row per video with columns "Video Id" and
 * "Playlist Video Creation Timestamp". No verified source states this file
 * carries title/channel/duration/thumbnail columns — those come from
 * enrichment this connector does not perform, so they are always null.
 */
export function buildPlaylistItemRecordFromCsvRow(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
	playlistId: string,
): PlaylistItemRecord | null {
	const videoId = trimmedOrNull(cell(row, columns, "Video Id"));
	if (!videoId) {
		return null;
	}
	return {
		id: hashId(`playlist_item|${playlistId}|${videoId}`),
		playlist_id: playlistId,
		video_id: videoId,
		video_url: `https://www.youtube.com/watch?v=${videoId}`,
		video_title: null,
		channel_title: null,
		channel_url: null,
		duration_seconds: null,
		thumbnail_url: null,
	};
}

export function parsePlaylistItemsCsv(
	text: string,
	playlistId: string,
): PlaylistItemRecord[] {
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header) {
		return [];
	}
	const columns = headerIndex(header);
	const out: PlaylistItemRecord[] = [];
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildPlaylistItemRecordFromCsvRow(row, columns, playlistId);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

// ── likes / watch later (playlist-shaped, share the item CSV shape) ────────

/**
 * UNVERIFIED (see file header). "Liked videos" and "Watch later" are
 * playlists in YouTube's own data model (ids "LL" and "WL" respectively in
 * the legacy scraper), so this connector treats their Takeout export, if
 * present, as another `<Playlist Name>-videos.csv` under playlists/ and
 * reads it with the same per-item parser, mapped to the likes/watch_later
 * record shape instead of playlist_items.
 */
export function buildLikeRecordFromCsvRow(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
): LikeRecord | null {
	const videoId = trimmedOrNull(cell(row, columns, "Video Id"));
	if (!videoId) {
		return null;
	}
	return {
		id: hashId(`like|${videoId}`),
		video_id: videoId,
		video_url: `https://www.youtube.com/watch?v=${videoId}`,
		video_title: null,
		channel_title: null,
		channel_url: null,
		duration_seconds: null,
		thumbnail_url: null,
	};
}

export function parseLikesCsv(text: string): LikeRecord[] {
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header) {
		return [];
	}
	const columns = headerIndex(header);
	const out: LikeRecord[] = [];
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildLikeRecordFromCsvRow(row, columns);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

export function buildWatchLaterRecordFromCsvRow(
	row: readonly string[],
	columns: ReadonlyMap<string, number>,
): WatchLaterRecord | null {
	const videoId = trimmedOrNull(cell(row, columns, "Video Id"));
	if (!videoId) {
		return null;
	}
	return {
		id: hashId(`watch_later|${videoId}`),
		video_id: videoId,
		video_url: `https://www.youtube.com/watch?v=${videoId}`,
		video_title: null,
		channel_title: null,
		channel_url: null,
		duration_seconds: null,
		thumbnail_url: null,
	};
}

export function parseWatchLaterCsv(text: string): WatchLaterRecord[] {
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header) {
		return [];
	}
	const columns = headerIndex(header);
	const out: WatchLaterRecord[] = [];
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildWatchLaterRecordFromCsvRow(row, columns);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

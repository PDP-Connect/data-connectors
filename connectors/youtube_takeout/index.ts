#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP YouTube Connector (v0.1.0) — file-based, manual import.
 *
 * Auth: none. This optional profile imports a Google Takeout "YouTube and
 * YouTube Music" export. The browser-first Vana profile is connectors/youtube.
 *
 * User goes to https://takeout.google.com/, selects "YouTube and YouTube
 * Music", downloads the archive, and places the .zip (or the extracted
 * directory) into YOUTUBE_TAKEOUT_DIR (defaults to
 * ~/.pdpp/imports/youtube/).
 *
 * Streams (see docs/migration/connector-cutover/capability-map.json,
 * source "youtube"):
 *   - profile             channel.csv                       UNVERIFIED path/columns
 *   - subscriptions       subscriptions/subscriptions.csv   UNVERIFIED path/columns
 *   - playlists           playlists/playlists.csv           UNVERIFIED path/columns
 *   - playlist_items      playlists/<name>-videos.csv       UNVERIFIED path/columns
 *   - likes               playlists/Liked videos-videos.csv UNVERIFIED path/columns
 *   - watch_later         playlists/Watch later-videos.csv  UNVERIFIED path/columns
 *   - watch_history       history/watch-history.json        VERIFIED (shared parser,
 *                                                            same file format as
 *                                                            google_takeout.youtube_watch_history)
 *
 * "UNVERIFIED" means: no fixture or repo evidence confirms this file's
 * existence, path, or column names in a real Takeout export. The parsers
 * are written from Google's documented Takeout conventions and are
 * defensive (null the field rather than guess), but every one of these
 * streams reports itself honestly via coverage_diagnostics — see
 * docs/inbox/report-connector-coverage.md classification.
 *
 * Accepts either a .zip archive (as downloaded from Takeout) or an
 * already-extracted directory in YOUTUBE_TAKEOUT_DIR, following the
 * manual_or_upload pattern of connectors/strava and connectors/google_maps.
 */

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { runConnector } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { WatchHistoryEntry } from "../../packages/polyfill-connectors/src/youtube-watch-history.ts";
import {
	buildPlaylistItemRecordFromCsvRow,
	buildPlaylistRecordFromCsvRow,
	buildProfileRecordFromChannelCsvRow,
	buildSubscriptionRecordFromCsvRow,
	buildWatchHistoryRecordFromEntry,
	hashId,
	parseCsvRows,
	parseLikesCsv,
	parseWatchLaterCsv,
} from "./parsers.ts";
import { type COVERAGE_REASONS, validateRecord } from "./schemas.ts";
import type { YoutubeState } from "./types.ts";

const PROFILE_STREAM = "profile";
const SUBSCRIPTIONS_STREAM = "subscriptions";
const PLAYLISTS_STREAM = "playlists";
const PLAYLIST_ITEMS_STREAM = "playlist_items";
const LIKES_STREAM = "likes";
const WATCH_LATER_STREAM = "watch_later";
const WATCH_HISTORY_STREAM = "watch_history";
const DIAGNOSTICS_STREAM = "coverage_diagnostics";

type CoverageReason = (typeof COVERAGE_REASONS)[number];

/**
 * A Takeout export can be handed over as the downloaded .zip, or already
 * extracted into a directory (the strava/google_maps convention — see
 * findUploadedArtifact in connectors/strava/index.ts). Only the extracted-
 * directory shape is implemented for v0.1.0: Takeout ZIPs are large,
 * multi-file archives, and streaming individual named members out of an
 * arbitrary-depth ZIP (rather than one flat CSV as Strava's archive is)
 * is real additional work this lane has not yet proven against a real
 * export. Until then, a .zip in the import dir is reported through
 * coverage_diagnostics as source_unreadable with remediation text telling
 * the owner to extract it — never silently ignored.
 */
function resolveExportRoot(importDir: string): {
	root: string | null;
	sawZipOnly: boolean;
} {
	if (!existsSync(importDir)) {
		return { root: null, sawZipOnly: false };
	}
	let entries: string[] = [];
	try {
		entries = readdirSync(importDir);
	} catch {
		return { root: null, sawZipOnly: false };
	}
	// The extracted export's own top-level folder is literally named this by
	// Takeout; accept either the import dir itself (owner extracted directly
	// into it) or one level of that named subfolder.
	const named = entries.find((name) => name === "YouTube and YouTube Music");
	if (named) {
		return { root: join(importDir, named), sawZipOnly: false };
	}
	const looksExtracted =
		existsSync(join(importDir, "history")) ||
		existsSync(join(importDir, "subscriptions")) ||
		existsSync(join(importDir, "playlists")) ||
		existsSync(join(importDir, "Channel"));
	if (looksExtracted) {
		return { root: importDir, sawZipOnly: false };
	}
	const sawZipOnly = entries.some((name) =>
		name.toLowerCase().endsWith(".zip"),
	);
	return { root: null, sawZipOnly };
}

function resolveExportedAt(root: string): string | null {
	try {
		return statSync(root).mtime.toISOString();
	} catch {
		return null;
	}
}

async function readJsonIf(path: string): Promise<unknown> {
	if (!existsSync(path)) {
		return null;
	}
	try {
		return JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch {
		return null;
	}
}

async function readTextIf(path: string): Promise<string | null> {
	if (!existsSync(path)) {
		return null;
	}
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

interface Coverage {
	readonly fieldsUnavailable: readonly string[];
	readonly reason: CoverageReason;
	readonly recordCount: number;
	readonly status: "complete" | "partial" | "empty";
}

function emptyCoverage(reason: CoverageReason): Coverage {
	return { reason, status: "empty", recordCount: 0, fieldsUnavailable: [] };
}

async function emitDiagnostics(
	ctx: CollectContext,
	stream: string,
	coverage: Coverage,
	exportedAt: string | null,
): Promise<void> {
	if (!ctx.requested.has(DIAGNOSTICS_STREAM)) {
		return;
	}
	await ctx.emitRecord(DIAGNOSTICS_STREAM, {
		id: hashId(`${stream}|${exportedAt ?? "unknown"}`),
		stream,
		status: coverage.status,
		reason: coverage.reason,
		record_count: coverage.recordCount,
		fields_unavailable: [...coverage.fieldsUnavailable],
		freshness: "snapshot",
		exported_at: exportedAt,
	});
}

async function collectProfile(
	ctx: CollectContext,
	root: string,
	exportedAt: string | null,
): Promise<void> {
	if (!ctx.requested.has(PROFILE_STREAM)) {
		return;
	}
	const path = join(root, "Channel", "channel.csv");
	const text = await readTextIf(path);
	if (!text) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: PROFILE_STREAM,
			reason: "file_not_found_in_export",
			message: `Channel export was not found at the expected path (${path}). Profile coverage for this Takeout export is UNVERIFIED — see the connector's coverage_diagnostics stream.`,
		});
		await emitDiagnostics(
			ctx,
			PROFILE_STREAM,
			emptyCoverage("file_not_found_in_export"),
			exportedAt,
		);
		return;
	}
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header || body.length === 0) {
		await emitDiagnostics(
			ctx,
			PROFILE_STREAM,
			emptyCoverage("source_unreadable"),
			exportedAt,
		);
		return;
	}
	const columns = new Map(header.map((name, i) => [name.trim(), i]));
	const record = buildProfileRecordFromChannelCsvRow(
		body[0] ?? [],
		columns,
		null,
	);
	if (!record) {
		await emitDiagnostics(
			ctx,
			PROFILE_STREAM,
			emptyCoverage("source_unreadable"),
			exportedAt,
		);
		return;
	}
	await ctx.emitRecord(PROFILE_STREAM, { ...record });
	await emitDiagnostics(
		ctx,
		PROFILE_STREAM,
		{
			reason: "covered_in_full",
			status: "complete",
			recordCount: 1,
			fieldsUnavailable: [
				"title",
				"handle",
				"email",
				"joined_at",
				"avatar_url",
				"description",
				"country",
				"subscriber_count",
				"view_count",
				"video_count",
			],
		},
		exportedAt,
	);
}

async function collectSubscriptions(
	ctx: CollectContext,
	root: string,
	exportedAt: string | null,
): Promise<void> {
	if (!ctx.requested.has(SUBSCRIPTIONS_STREAM)) {
		return;
	}
	const path = join(root, "subscriptions", "subscriptions.csv");
	const text = await readTextIf(path);
	if (!text) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: SUBSCRIPTIONS_STREAM,
			reason: "file_not_found_in_export",
			message: `Subscriptions export was not found at the expected path (${path}). Coverage for this stream is UNVERIFIED — see the connector's coverage_diagnostics stream.`,
		});
		await emitDiagnostics(
			ctx,
			SUBSCRIPTIONS_STREAM,
			emptyCoverage("file_not_found_in_export"),
			exportedAt,
		);
		return;
	}
	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	if (!header) {
		await emitDiagnostics(
			ctx,
			SUBSCRIPTIONS_STREAM,
			emptyCoverage("source_unreadable"),
			exportedAt,
		);
		return;
	}
	const columns = new Map(header.map((name, i) => [name.trim(), i]));
	let emitted = 0;
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildSubscriptionRecordFromCsvRow(row, columns);
		if (!record) {
			continue;
		}
		await ctx.emitRecord(SUBSCRIPTIONS_STREAM, { ...record });
		emitted += 1;
	}
	await emitDiagnostics(
		ctx,
		SUBSCRIPTIONS_STREAM,
		{
			reason: emitted > 0 ? "covered_in_full" : "nothing_in_range",
			status: emitted > 0 ? "complete" : "empty",
			recordCount: emitted,
			fieldsUnavailable: [
				"handle",
				"avatar_url",
				"subscriber_count",
				"description",
				"is_verified",
				"notifications",
			],
		},
		exportedAt,
	);
}

interface PlaylistFileEntry {
	name: string;
}

function listPlaylistItemFiles(playlistsDir: string): PlaylistFileEntry[] {
	try {
		return readdirSync(playlistsDir)
			.filter((name) => name.toLowerCase().endsWith("-videos.csv"))
			.map((name) => ({ name }));
	} catch {
		return [];
	}
}

async function collectPlaylists(
	ctx: CollectContext,
	root: string,
	exportedAt: string | null,
): Promise<void> {
	const wantsPlaylists = ctx.requested.has(PLAYLISTS_STREAM);
	const wantsItems = ctx.requested.has(PLAYLIST_ITEMS_STREAM);
	if (!(wantsPlaylists || wantsItems)) {
		return;
	}
	const playlistsDir = join(root, "playlists");
	const indexPath = join(playlistsDir, "playlists.csv");
	const text = await readTextIf(indexPath);
	if (!text) {
		const message = `Playlists export was not found at the expected path (${indexPath}). Coverage for this stream is UNVERIFIED — see the connector's coverage_diagnostics stream.`;
		if (wantsPlaylists) {
			await ctx.emit({
				type: "SKIP_RESULT",
				stream: PLAYLISTS_STREAM,
				reason: "file_not_found_in_export",
				message,
			});
			await emitDiagnostics(
				ctx,
				PLAYLISTS_STREAM,
				emptyCoverage("file_not_found_in_export"),
				exportedAt,
			);
		}
		if (wantsItems) {
			await ctx.emit({
				type: "SKIP_RESULT",
				stream: PLAYLIST_ITEMS_STREAM,
				reason: "file_not_found_in_export",
				message,
			});
			await emitDiagnostics(
				ctx,
				PLAYLIST_ITEMS_STREAM,
				emptyCoverage("file_not_found_in_export"),
				exportedAt,
			);
		}
		return;
	}

	const rows = parseCsvRows(text);
	const [header, ...body] = rows;
	const columns = new Map((header ?? []).map((name, i) => [name.trim(), i]));
	let playlistCount = 0;
	const playlistIds: string[] = [];
	for (const row of body) {
		if (row.length === 1 && row[0]?.trim() === "") {
			continue;
		}
		const record = buildPlaylistRecordFromCsvRow(row, columns);
		if (!record) {
			continue;
		}
		playlistIds.push(record.id);
		if (wantsPlaylists) {
			await ctx.emitRecord(PLAYLISTS_STREAM, { ...record });
		}
		playlistCount += 1;
	}
	if (wantsPlaylists) {
		await emitDiagnostics(
			ctx,
			PLAYLISTS_STREAM,
			{
				reason: playlistCount > 0 ? "covered_in_full" : "nothing_in_range",
				status: playlistCount > 0 ? "complete" : "empty",
				recordCount: playlistCount,
				fieldsUnavailable: [
					"url",
					"owner",
					"owner_url",
					"video_count",
					"view_count",
				],
			},
			exportedAt,
		);
	}

	if (!wantsItems) {
		return;
	}
	const itemFiles = listPlaylistItemFiles(playlistsDir);
	let itemsEmitted = 0;
	for (const file of itemFiles) {
		const itemText = await readTextIf(join(playlistsDir, file.name));
		if (!itemText) {
			continue;
		}
		const itemRows = parseCsvRows(itemText);
		const [itemHeader, ...itemBody] = itemRows;
		const itemColumns = new Map(
			(itemHeader ?? []).map((n, i) => [n.trim(), i]),
		);
		// The per-item file is named after the playlist, not keyed by its id;
		// derive a stable playlist_id from the filename since the item rows
		// carry no playlist identifier of their own.
		const derivedPlaylistId = hashId(`playlist_file|${file.name}`);
		for (const row of itemBody) {
			if (row.length === 1 && row[0]?.trim() === "") {
				continue;
			}
			const record = buildPlaylistItemRecordFromCsvRow(
				row,
				itemColumns,
				derivedPlaylistId,
			);
			if (!record) {
				continue;
			}
			await ctx.emitRecord(PLAYLIST_ITEMS_STREAM, { ...record });
			itemsEmitted += 1;
		}
	}
	await emitDiagnostics(
		ctx,
		PLAYLIST_ITEMS_STREAM,
		{
			reason:
				itemFiles.length === 0
					? "file_not_found_in_export"
					: itemsEmitted > 0
						? "covered_in_full"
						: "nothing_in_range",
			status: itemsEmitted > 0 ? "complete" : "empty",
			recordCount: itemsEmitted,
			fieldsUnavailable: [
				"video_title",
				"channel_title",
				"channel_url",
				"duration_seconds",
				"thumbnail_url",
			],
		},
		exportedAt,
	);
}

/**
 * Liked videos and Watch later are Takeout's own playlist export files
 * (Google's documented naming: "Liked videos-videos.csv" and
 * "Watch later-videos.csv" under playlists/), read with the shared
 * per-item CSV parser but mapped to their own record shapes rather than
 * playlist_items — see D2/D3 in CONTRACTS.md on stream granularity.
 */
async function collectNamedPlaylistStream(
	ctx: CollectContext,
	root: string,
	exportedAt: string | null,
	stream: typeof LIKES_STREAM | typeof WATCH_LATER_STREAM,
	fileName: string,
): Promise<void> {
	if (!ctx.requested.has(stream)) {
		return;
	}
	const path = join(root, "playlists", fileName);
	const text = await readTextIf(path);
	if (!text) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream,
			reason: "file_not_found_in_export",
			message: `${fileName} was not found at the expected path (${path}). Coverage for this stream is UNVERIFIED — see the connector's coverage_diagnostics stream.`,
		});
		await emitDiagnostics(
			ctx,
			stream,
			emptyCoverage("file_not_found_in_export"),
			exportedAt,
		);
		return;
	}
	const records =
		stream === LIKES_STREAM ? parseLikesCsv(text) : parseWatchLaterCsv(text);
	for (const record of records) {
		await ctx.emitRecord(stream, { ...record });
	}
	await emitDiagnostics(
		ctx,
		stream,
		{
			reason: records.length > 0 ? "covered_in_full" : "nothing_in_range",
			status: records.length > 0 ? "complete" : "empty",
			recordCount: records.length,
			fieldsUnavailable: [
				"video_title",
				"channel_title",
				"channel_url",
				"duration_seconds",
				"thumbnail_url",
			],
		},
		exportedAt,
	);
}

async function collectWatchHistory(
	ctx: CollectContext,
	root: string,
	exportedAt: string | null,
	streamState: { last_timestamp?: string } | undefined,
): Promise<void> {
	if (!ctx.requested.has(WATCH_HISTORY_STREAM)) {
		return;
	}
	const path = join(root, "history", "watch-history.json");
	const json = (await readJsonIf(path)) as WatchHistoryEntry[] | null;
	if (!Array.isArray(json)) {
		await ctx.emit({
			type: "SKIP_RESULT",
			stream: WATCH_HISTORY_STREAM,
			reason: "file_not_found_in_export",
			message: `Watch history was not found at the expected path (${path}).`,
		});
		await emitDiagnostics(
			ctx,
			WATCH_HISTORY_STREAM,
			emptyCoverage("file_not_found_in_export"),
			exportedAt,
		);
		return;
	}
	const since = streamState?.last_timestamp;
	let latest: string | undefined = since;
	let emitted = 0;
	await ctx.emit({
		type: "PROGRESS",
		stream: WATCH_HISTORY_STREAM,
		message: `YouTube phase=emit pass=emit stream=watch_history total_items=${json.length}`,
	});
	for (const entry of json) {
		const record = buildWatchHistoryRecordFromEntry(entry);
		if (!record) {
			continue;
		}
		if (since && record.watched_at <= since) {
			continue;
		}
		await ctx.emitRecord(WATCH_HISTORY_STREAM, { ...record });
		emitted += 1;
		if (!latest || record.watched_at > latest) {
			latest = record.watched_at;
		}
	}
	await ctx.emit({
		type: "STATE",
		stream: WATCH_HISTORY_STREAM,
		cursor: { last_timestamp: latest },
	});
	await emitDiagnostics(
		ctx,
		WATCH_HISTORY_STREAM,
		{
			reason: emitted > 0 ? "covered_in_full" : "nothing_in_range",
			status: emitted > 0 ? "complete" : "empty",
			recordCount: emitted,
			fieldsUnavailable: ["view_count", "description"],
		},
		exportedAt,
	);
}

runConnector({
	name: "youtube-takeout",
	validateRecord,
	timeRangeField: "watched_at",
	async collect(ctx) {
		const importDir =
			process.env.YOUTUBE_TAKEOUT_DIR ||
			join(homedir(), ".pdpp", "imports", "youtube");

		const { root, sawZipOnly } = resolveExportRoot(importDir);
		if (!root) {
			const message = sawZipOnly
				? `Found a .zip in ${importDir} but this connector reads an extracted export directory. Extract the Takeout archive and place its contents (or the "YouTube and YouTube Music" folder) in ${importDir}.`
				: `No Google Takeout "YouTube and YouTube Music" export found in ${importDir}. Request an export from https://takeout.google.com/, extract it, and place it there. Set YOUTUBE_TAKEOUT_DIR to use a different location.`;
			for (const stream of [
				PROFILE_STREAM,
				SUBSCRIPTIONS_STREAM,
				PLAYLISTS_STREAM,
				PLAYLIST_ITEMS_STREAM,
				LIKES_STREAM,
				WATCH_LATER_STREAM,
				WATCH_HISTORY_STREAM,
			]) {
				if (!ctx.requested.has(stream)) {
					continue;
				}
				await ctx.emit({
					type: "SKIP_RESULT",
					stream,
					reason: sawZipOnly ? "source_unreadable" : "file_not_found_in_export",
					message,
				});
				await emitDiagnostics(
					ctx,
					stream,
					emptyCoverage(
						sawZipOnly ? "source_unreadable" : "records_unreadable",
					),
					null,
				);
			}
			return;
		}

		let canonicalRoot: string;
		try {
			canonicalRoot = realpathSync(root);
		} catch {
			canonicalRoot = root;
		}
		const exportedAt = resolveExportedAt(canonicalRoot);
		const typedState = ctx.state as YoutubeState;

		await collectProfile(ctx, canonicalRoot, exportedAt);
		await collectSubscriptions(ctx, canonicalRoot, exportedAt);
		await collectPlaylists(ctx, canonicalRoot, exportedAt);
		await collectNamedPlaylistStream(
			ctx,
			canonicalRoot,
			exportedAt,
			LIKES_STREAM,
			"Liked videos-videos.csv",
		);
		await collectNamedPlaylistStream(
			ctx,
			canonicalRoot,
			exportedAt,
			WATCH_LATER_STREAM,
			"Watch later-videos.csv",
		);
		await collectWatchHistory(
			ctx,
			canonicalRoot,
			exportedAt,
			typedState.watch_history,
		);
	},
});

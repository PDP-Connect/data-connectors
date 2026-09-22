// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for the YouTube Takeout connector's streams. Shape-check-
 * before-emit per docs/connector-authoring-guide.md §3.
 *
 * Ground truth: the record builders in parsers.ts and the record interfaces
 * in types.ts. See parsers.ts's file header for which streams are VERIFIED
 * (watch_history, via the shared src/youtube-watch-history.ts module) vs
 * UNVERIFIED (profile, subscriptions, playlists, playlist_items, likes,
 * watch_later — parsers exist but no repo evidence confirms the Takeout
 * file layout they read).
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

const RECORD_ID_RE = /^[0-9a-f]{24}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const isoTimestampSchema = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime");
const urlSchema = z.url().max(4096).nullable();

export const profileSchema = z.object({
	id: pdppSafeText.max(200).nullable(),
	channel_url: urlSchema,
	title: pdppSafeText.max(500).nullable(),
	handle: pdppSafeText.max(200).nullable(),
	email: pdppSafeText.max(320).nullable(),
	joined_at: pdppSafeText.max(40).nullable(),
	avatar_url: urlSchema,
	description: pdppSafeText.max(5000).nullable(),
	country: pdppSafeText.max(80).nullable(),
	subscriber_count: z.number().int().min(0).nullable(),
	view_count: z.number().int().min(0).nullable(),
	video_count: z.number().int().min(0).nullable(),
});

export const subscriptionsSchema = z.object({
	id: pdppSafeText.max(200),
	channel_id: pdppSafeText.max(200),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	handle: pdppSafeText.max(200).nullable(),
	avatar_url: urlSchema,
	subscriber_count: z.number().int().min(0).nullable(),
	description: pdppSafeText.max(5000).nullable(),
	is_verified: z.boolean().nullable(),
	notifications: z.boolean().nullable(),
});

export const playlistsSchema = z.object({
	id: pdppSafeText.max(200),
	url: urlSchema,
	title: pdppSafeText.max(500).nullable(),
	owner: pdppSafeText.max(500).nullable(),
	owner_url: urlSchema,
	visibility: pdppSafeText.max(40).nullable(),
	video_count: z.number().int().min(0).nullable(),
	view_count: z.number().int().min(0).nullable(),
});

export const playlistItemsSchema = z.object({
	id: z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice"),
	playlist_id: pdppSafeText.max(200),
	video_id: pdppSafeText.max(200).nullable(),
	video_url: urlSchema,
	video_title: pdppSafeText.max(2000).nullable(),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	duration_seconds: z.number().int().min(0).nullable(),
	thumbnail_url: urlSchema,
});

export const likesSchema = z.object({
	id: z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice"),
	video_id: pdppSafeText.max(200).nullable(),
	video_url: urlSchema,
	video_title: pdppSafeText.max(2000).nullable(),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	duration_seconds: z.number().int().min(0).nullable(),
	thumbnail_url: urlSchema,
});

export const watchLaterSchema = z.object({
	id: z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice"),
	video_id: pdppSafeText.max(200).nullable(),
	video_url: urlSchema,
	video_title: pdppSafeText.max(2000).nullable(),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	duration_seconds: z.number().int().min(0).nullable(),
	thumbnail_url: urlSchema,
});

export const watchHistorySchema = z.object({
	id: z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice"),
	watched_at: isoTimestampSchema,
	video_id: pdppSafeText.max(200).nullable(),
	video_url: urlSchema,
	video_title: pdppSafeText.max(2000).nullable(),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	view_count: z.number().int().min(0).nullable(),
	description: pdppSafeText.max(5000).nullable(),
});

export const COVERAGE_REASONS = [
	"covered_in_full",
	"nothing_in_range",
	"awaiting_upload",
	"source_unreadable",
	"records_unreadable",
	"file_not_found_in_export",
] as const;

export const coverageDiagnosticsSchema = z.object({
	id: pdppSafeText.max(200),
	stream: pdppSafeText.max(80).nullable(),
	status: z.enum(["complete", "partial", "empty"]),
	reason: z.enum(COVERAGE_REASONS),
	record_count: z.number().int().min(0).nullable(),
	fields_unavailable: z.array(pdppSafeText.max(200)),
	freshness: z.enum(["live", "snapshot"]),
	exported_at: pdppSafeText.max(40).nullable(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	subscriptions: subscriptionsSchema,
	playlists: playlistsSchema,
	playlist_items: playlistItemsSchema,
	likes: likesSchema,
	watch_later: watchLaterSchema,
	watch_history: watchHistorySchema,
	coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

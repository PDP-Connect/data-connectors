// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for the browser-first YouTube connector's streams. Shape-check-
 * before-emit per docs/connector-authoring-guide.md §3.
 *
 * Source: the authenticated YouTube DOM. History dates retain day precision.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const RECORD_ID_RE = /^[0-9a-f]{24}$/;
const urlSchema = z.url().max(4096).nullable();

export const profileSchema = z.object({
	id: pdppSafeText.max(200),
	channel_id: pdppSafeText.max(200).nullable(),
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
	channel_id: pdppSafeText.max(200).nullable(),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	handle: pdppSafeText.max(200).nullable(),
	avatar_url: urlSchema,
	subscriber_count: z.number().int().min(0).nullable(),
	subscriber_count_text: pdppSafeText.max(200).nullable(),
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
	duration_text: pdppSafeText.max(80).nullable(),
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
	duration_text: pdppSafeText.max(80).nullable(),
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
	duration_text: pdppSafeText.max(80).nullable(),
	thumbnail_url: urlSchema,
});

export const watchHistorySchema = z.object({
	id: z.string().regex(RECORD_ID_RE, "id must be a 24-hex sha256 slice"),
	position: z.number().int().min(0),
	watched_date: pdppSafeText.regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
	watched_date_label: pdppSafeText.max(80).nullable(),
	video_id: pdppSafeText.max(200).nullable(),
	video_url: urlSchema,
	video_title: pdppSafeText.max(2000).nullable(),
	channel_title: pdppSafeText.max(500).nullable(),
	channel_url: urlSchema,
	view_count: z.number().int().min(0).nullable(),
	views_text: pdppSafeText.max(200).nullable(),
	description: pdppSafeText.max(5000).nullable(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	subscriptions: subscriptionsSchema,
	playlists: playlistsSchema,
	playlist_items: playlistItemsSchema,
	likes: likesSchema,
	watch_later: watchLaterSchema,
	watch_history: watchHistorySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

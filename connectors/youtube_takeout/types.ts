// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shapes for the YouTube connector. Extracted from index.ts so parsers.ts
// and tests can import them without pulling in runtime entry.

export interface ProfileRecord {
	avatar_url: string | null;
	channel_url: string | null;
	country: string | null;
	description: string | null;
	email: string | null;
	handle: string | null;
	id: string | null;
	joined_at: string | null;
	subscriber_count: number | null;
	title: string | null;
	video_count: number | null;
	view_count: number | null;
}

export interface SubscriptionRecord {
	avatar_url: string | null;
	channel_id: string;
	channel_title: string | null;
	channel_url: string | null;
	description: string | null;
	handle: string | null;
	id: string;
	is_verified: boolean | null;
	notifications: boolean | null;
	subscriber_count: number | null;
}

export interface PlaylistRecord {
	id: string;
	owner: string | null;
	owner_url: string | null;
	title: string | null;
	url: string | null;
	video_count: number | null;
	view_count: number | null;
	visibility: string | null;
}

export interface PlaylistItemRecord {
	channel_title: string | null;
	channel_url: string | null;
	duration_seconds: number | null;
	id: string;
	playlist_id: string;
	thumbnail_url: string | null;
	video_id: string | null;
	video_title: string | null;
	video_url: string | null;
}

export interface LikeRecord {
	channel_title: string | null;
	channel_url: string | null;
	duration_seconds: number | null;
	id: string;
	thumbnail_url: string | null;
	video_id: string | null;
	video_title: string | null;
	video_url: string | null;
}

export interface WatchLaterRecord {
	channel_title: string | null;
	channel_url: string | null;
	duration_seconds: number | null;
	id: string;
	thumbnail_url: string | null;
	video_id: string | null;
	video_title: string | null;
	video_url: string | null;
}

export interface WatchHistoryRecord {
	channel_title: string | null;
	channel_url: string | null;
	description: string | null;
	id: string;
	video_id: string | null;
	video_title: string | null;
	video_url: string | null;
	view_count: number | null;
	watched_at: string;
}

export interface StreamTimestampState {
	last_timestamp?: string;
}

export interface YoutubeState {
	watch_history?: StreamTimestampState;
}

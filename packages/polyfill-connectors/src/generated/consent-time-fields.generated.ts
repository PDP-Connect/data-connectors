// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from every shipped connector
// manifest's per-stream consent_time_field and its declared format. A stream
// maps to null when the runtime cannot compare bounds with its consent field
// (absent, a string with no format, an integer, or a date field not yet
// enabled), so a bounded run reports scope_not_supported for it.
// Regenerate with `node --experimental-strip-types
// scripts/generate-consent-time-fields.ts` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../time-range.ts";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
	amazon: {
		order_items: null,
		orders: null,
		profile: null,
	},
	anthropic: {
		account_profile: null,
		conversations: { field: "create_time", format: "date-time" },
		messages: { field: "create_time", format: "date-time" },
		project_documents: { field: "create_time", format: "date-time" },
		projects: { field: "create_time", format: "date-time" },
	},
	apple_contacts: {
		address_books: null,
		contact_groups: null,
		contacts: null,
	},
	apple_health: {
		records: { field: "start_date", format: "date-time" },
		workouts: { field: "start_date", format: "date-time" },
	},
	apple_photos: {
		photos: { field: "file_modified_at", format: "date-time" },
	},
	chase: {
		accounts: null,
		balances: { field: "as_of", format: "date-time" },
		current_activity: null,
		statements: null,
		transactions: null,
	},
	chatgpt: {
		account_plan: null,
		conversations: { field: "create_time", format: "date-time" },
		custom_gpts: { field: "created_at", format: "date-time" },
		custom_instructions: { field: "updated_at", format: "date-time" },
		memories: { field: "created_at", format: "date-time" },
		messages: { field: "create_time", format: "date-time" },
		shared_conversations: { field: "created_at", format: "date-time" },
	},
	claude_code: {
		attachments: { field: "timestamp", format: "date-time" },
		backup_inventory: null,
		cache_inventory: null,
		config_inventory: null,
		file_history: null,
		memory_notes: null,
		messages: { field: "timestamp", format: "date-time" },
		sessions: { field: "started_at", format: "date-time" },
		skills: null,
		slash_commands: null,
		usage: null,
	},
	codex: {
		cache_inventory: null,
		config_inventory: null,
		function_calls: { field: "timestamp", format: "date-time" },
		history: null,
		messages: { field: "timestamp", format: "date-time" },
		prompts: null,
		rules: null,
		session_index: null,
		sessions: { field: "started_at", format: "date-time" },
		shell_snapshots: null,
		skills: null,
	},
	discord_browser: {
		connections: null,
		messages: { field: "timestamp", format: "date-time" },
		profile: null,
		servers: null,
	},
	doordash: {
		order_items: null,
		orders: { field: "order_date", format: "date-time" },
	},
	github: {
		contributions: null,
		events: { field: "created_at", format: "date-time" },
		gists: { field: "created_at", format: "date-time" },
		issues: { field: "created_at", format: "date-time" },
		organizations: null,
		pinned_repositories: null,
		pull_requests: { field: "created_at", format: "date-time" },
		repositories: { field: "created_at", format: "date-time" },
		starred: { field: "starred_at", format: "date-time" },
		user: { field: "created_at", format: "date-time" },
		user_stats: null,
	},
	github_browser: {
		contributions: null,
		events: null,
		history: null,
		profile: null,
		repositories: null,
		starred: null,
	},
	gmail: {
		attachments: { field: "message_received_at", format: "date-time" },
		labels: null,
		message_bodies: { field: "message_received_at", format: "date-time" },
		messages: { field: "received_at", format: "date-time" },
		threads: { field: "first_message_date", format: "date-time" },
	},
	google_calendar: {
		calendars: null,
		events: { field: "start", format: "date-time" },
	},
	google_contacts: {
		contact_groups: null,
		people: { field: "updated", format: "date-time" },
	},
	google_maps: {
		timeline_points: { field: "timestamp", format: "date-time" },
		timeline_segments: { field: "start_time", format: "date-time" },
	},
	google_maps_data_portability: {
		archive_jobs: { field: "export_time", format: "date-time" },
	},
	google_messages: {
		messages: { field: "sent_at", format: "date-time" },
	},
	google_takeout: {
		location_history: { field: "timestamp", format: "date-time" },
		photos: { field: "event_time", format: "date-time" },
		search_history: { field: "timestamp", format: "date-time" },
		youtube_watch_history: { field: "watched_at", format: "date-time" },
	},
	groupme: {
		attachments: null,
		direct_chat_messages: { field: "created_at", format: "date-time" },
		direct_messages: { field: "last_message_at", format: "date-time" },
		group_messages: { field: "created_at", format: "date-time" },
		groups: { field: "created_at", format: "date-time" },
	},
	heb: {
		nutrition: null,
		order_items: null,
		orders: null,
		profile: null,
	},
	ical: {
		events: { field: "start", format: "date-time" },
	},
	icloud_notes: {
		folders: null,
		notes: null,
	},
	imessage: {
		attachments: null,
		messages: { field: "date", format: "date-time" },
		participants: null,
	},
	jellyfin: {
		items: { field: "last_played_date", format: "date-time" },
		libraries: null,
	},
	linkedin: {
		connections: null,
		education: null,
		experience: null,
		languages: null,
		profile: null,
		skills: null,
	},
	loom: {
		transcripts: null,
		videos: { field: "created_at", format: "date-time" },
	},
	meta: {
		ads: null,
		following: null,
		post_likes: null,
		posts: { field: "taken_at", format: "date-time" },
		profile: null,
	},
	netflix_export: {
		viewing_activity: { field: "watched_at", format: "date-time" },
	},
	notion: {
		databases: { field: "created_time", format: "date-time" },
		pages: { field: "created_time", format: "date-time" },
	},
	oura: {
		activity: null,
		readiness: null,
		sleep: null,
	},
	oura_browser: {
		activity: null,
		readiness: null,
		sleep: null,
	},
	pocket: {
		items: { field: "time_added", format: "date-time" },
	},
	reddit: {
		comments: { field: "created_utc", format: "date-time" },
		downvoted: { field: "created_utc", format: "date-time" },
		hidden: { field: "created_utc", format: "date-time" },
		saved: { field: "created_utc", format: "date-time" },
		submitted: { field: "created_utc", format: "date-time" },
		upvoted: { field: "created_utc", format: "date-time" },
	},
	shopify: {
		orders: { field: "order_date", format: "date-time" },
	},
	signal: {
		attachments: null,
		conversations: null,
		messages: { field: "sent_at", format: "date-time" },
		reactions: null,
	},
	slack: {
		canvases: null,
		channel_memberships: null,
		channel_stats: null,
		channels: null,
		dm_read_states: null,
		files: null,
		message_attachments: null,
		messages: { field: "sent_at", format: "date-time" },
		reactions: null,
		reminders: null,
		stars: null,
		user_groups: null,
		users: null,
		workspace: null,
	},
	spotify: {
		playlist_items: { field: "added_at", format: "date-time" },
		playlists: null,
		profile: null,
		saved_tracks: { field: "added_at", format: "date-time" },
	},
	steam: {
		friends: null,
		owned_games: null,
		profile: null,
		recently_played_games: null,
		steam_level: null,
	},
	strava: {
		activities: { field: "start_date_local", format: "date" },
	},
	strava_browser: {
		activities: { field: "start_date_local", format: "date" },
	},
	twitter_archive: {
		direct_messages: { field: "created_at", format: "date-time" },
		tweets: { field: "created_at", format: "date-time" },
	},
	uber: {
		receipts: null,
		trips: { field: "requested_at", format: "date-time" },
	},
	usaa: {
		account_stats: null,
		accounts: null,
		credit_card_billing: null,
		credit_card_billing_stats: null,
		inbox_messages: null,
		statements: null,
		transactions: null,
	},
	venmo: {
		friends: null,
		profile: null,
		transactions: { field: "date_created", format: "date-time" },
	},
	whatsapp: {
		attachments: null,
		chats: { field: "first_message_date", format: "date-time" },
		messages: { field: "sent_at", format: "date-time" },
	},
	wholefoods: {
		nutrition: null,
		order_items: null,
		orders: null,
		profile: null,
	},
	whoop: {
		body: null,
		cycles: null,
		profile: null,
		recoveries: { field: "created_at", format: "date-time" },
		sleeps: { field: "start_at", format: "date-time" },
		workouts: { field: "start_at", format: "date-time" },
	},
	x_browser: {
		bookmarks: null,
		likes: null,
		posts: { field: "created_at", format: "date-time" },
		profile: null,
	},
	ynab: {
		account_stats: null,
		accounts: null,
		budgets: null,
		categories: null,
		category_groups: null,
		month_categories: null,
		months: null,
		payee_locations: null,
		payees: null,
		scheduled_transactions: null,
		transactions: null,
	},
	youtube: {
		likes: null,
		playlist_items: null,
		playlists: null,
		profile: null,
		subscriptions: null,
		watch_history: null,
		watch_later: null,
	},
	youtube_takeout: {
		likes: null,
		playlist_items: null,
		playlists: null,
		profile: null,
		subscriptions: null,
		watch_history: { field: "watched_at", format: "date-time" },
		watch_later: null,
	},
};

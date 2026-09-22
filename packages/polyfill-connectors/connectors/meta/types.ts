// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes for the Meta (Instagram) connector. Extracted from index.ts
// so parsers.ts and tests can import them without pulling in the
// Playwright-flavored runtime entry.

// ─── Raw Instagram wire shapes (as received from web_info / GraphQL / v1 API) ──

/**
 * `/accounts/web_info/`'s embedded PolarisViewer.data payload (confirmed
 * live 2026-09-22 against an authenticated session). Notably absent:
 * follower_count, following_count, media_count — this endpoint does not
 * carry them. `is_verified` was not observed as a top-level field either
 * (Instagram's own web UI derives the verified badge from
 * `active_meta_verified_benefits`, not a boolean here); left optional and
 * unpopulated pending evidence of where a reliable verified flag comes from.
 */
export interface InstagramWebInfoUser {
	biography?: string | null;
	external_url?: string | null;
	fbid?: string | null;
	full_name?: string | null;
	id?: string | null;
	is_business_account?: boolean | null;
	is_private?: boolean | null;
	is_professional_account?: boolean | null;
	is_verified?: boolean | null;
	profile_pic_url?: string | null;
	username?: string | null;
}

export interface InstagramImageCandidate {
	url?: string | null;
}

export interface InstagramFacepileLiker {
	full_name?: string | null;
	id?: string | null;
	pk?: string | null;
	username?: string | null;
}

export interface InstagramCarouselItem {
	image_versions2?: { candidates?: InstagramImageCandidate[] | null } | null;
}

export interface InstagramTimelineNode {
	caption?: { text?: string | null } | null;
	carousel_media?: InstagramCarouselItem[] | null;
	code?: string | null;
	facepile_top_likers?: InstagramFacepileLiker[] | null;
	id?: string | null;
	image_versions2?: { candidates?: InstagramImageCandidate[] | null } | null;
	like_count?: number | null;
	media_id?: string | null;
	pk?: string | null;
	taken_at?: number | null;
	taken_at_timestamp?: number | null;
}

export interface InstagramTimelineEdge {
	node: InstagramTimelineNode;
}

export interface InstagramPageInfo {
	end_cursor?: string | null;
	has_next_page?: boolean | null;
}

export interface InstagramTimelineConnection {
	edges?: InstagramTimelineEdge[] | null;
	page_info?: InstagramPageInfo | null;
}

/** One entry from `/api/v1/friendships/{userId}/following/`. */
export interface InstagramFollowingUser {
	full_name?: string | null;
	id?: string | null;
	is_private?: boolean | null;
	is_verified?: boolean | null;
	pk?: string | null;
	profile_pic_url?: string | null;
	username?: string | null;
}

export interface InstagramFollowingPage {
	next_max_id?: string | null;
	users?: InstagramFollowingUser[] | null;
}

/** Result of a page.evaluate-driven fetch against an Instagram internal
 *  endpoint. Mirrors the Reddit connector's `RedditFetchResult` shape. */
export interface InstagramFetchResult<T> {
	json: T | null;
	status: number;
}

// ─── Emitted record shapes ──────────────────────────────────────────────

/** `profile` stream record — one per run, the owner's own profile. */
export interface ProfileRecord {
	bio: string | null;
	external_url: string | null;
	follower_count: number | null;
	following_count: number | null;
	full_name: string | null;
	id: string;
	is_business: boolean | null;
	is_private: boolean | null;
	is_verified: boolean | null;
	post_count: number | null;
	profile_pic_url: string | null;
	username: string;
	[field: string]: unknown;
}

/** `posts` stream record — one per post on the owner's timeline. */
export interface PostRecord {
	caption: string | null;
	comment_count: number | null;
	id: string;
	like_count: number | null;
	location_name: string | null;
	media_type: string | null;
	media_url: string | null;
	taken_at: string | null;
	[field: string]: unknown;
}

/** `post_likes` stream record — one per (post, liker) pair, drawn from
 *  `facepile_top_likers` (Instagram only surfaces a bounded top-likers
 *  sample per post via this API; there is no full-likers listing endpoint
 *  reachable from a logged-in web session). */
export interface PostLikeRecord {
	post_id: string;
	user_id: string;
	username: string;
	[field: string]: unknown;
}

/** `following` stream record — one per account the owner follows. */
export interface FollowingRecord {
	full_name: string | null;
	id: string;
	is_private: boolean | null;
	is_verified: boolean | null;
	profile_pic_url: string | null;
	username: string;
	[field: string]: unknown;
}

export type AdKind = "advertiser" | "ad_topic" | "ad_category";

/** `ads` stream record — advertisers, ad topics, and targeting categories
 *  from Meta Accounts Center, merged into one stream per D6 with a `kind`
 *  discriminator. */
export interface AdRecord {
	description: string | null;
	id: string;
	kind: AdKind;
	name: string;
	[field: string]: unknown;
}

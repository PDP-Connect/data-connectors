// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Meta (Instagram) connector. Kept free of Playwright /
// Node I/O so they can be unit-tested in isolation. The fetch loop, browser
// lifecycle, login, and DOM interaction live in index.ts.

import { createHash } from "node:crypto";
import type {
	AdKind,
	AdRecord,
	FollowingRecord,
	InstagramFollowingUser,
	InstagramProfilePageEnvelope,
	InstagramTimelineEdge,
	InstagramWebInfoUser,
	PostLikeRecord,
	PostRecord,
	ProfileRecord,
} from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────────

/** Instagram's internal following endpoint pages at 50 per request. */
export const FOLLOWING_PAGE_LIMIT = 50;

/** Safety ceiling on `following` pagination. The legacy connector capped
 *  collection at 20 pages (~1000 accounts); D6 requires `following` to be
 *  complete or to report honest coverage. This ceiling is deliberately high
 *  (200 pages * 50 = 10,000 accounts) so completion is the normal outcome for
 *  real accounts and `truncated` becomes an honest signal rather than the
 *  expected case. */
export const FOLLOWING_MAX_PAGES = 200;

// ─── Field helpers ──────────────────────────────────────────────────────

/** Instagram represents "not set" as an empty string on several web_info
 *  fields (confirmed live 2026-09-22: `bio`, `full_name`, `external_url` are
 *  all `""` rather than absent on an account that hasn't set them). Per the
 *  authoring rule "nullable fields return null, not sentinel strings",
 *  normalize empty string to null rather than emitting a value a URL/text
 *  schema may reject (`external_url: ""` fails `z.url()`) or that silently
 *  differs in meaning from "the field is genuinely absent". */
export function nullIfEmpty(value: string | null | undefined): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	return value.length > 0 ? value : null;
}

/** Instagram media nodes carry `taken_at` in unix seconds (occasionally
 *  `taken_at_timestamp`, also seconds). Values above 1e12 are already
 *  millisecond-scale and pass through unchanged; never fabricate a
 *  timestamp when neither field is present. */
export function isoFromTakenAt(
	takenAt: number | null | undefined,
	takenAtTimestamp?: number | null,
): string | null {
	const raw = takenAt ?? takenAtTimestamp;
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
		return null;
	}
	const ms = raw > 1e12 ? raw : raw * 1000;
	return new Date(ms).toISOString();
}

/** Best available image URL for a post: single-image posts carry
 *  `image_versions2`; carousels nest the first slide's own
 *  `image_versions2`. Returns null rather than an empty string when
 *  neither is present. */
export function mediaUrlOf(node: {
	carousel_media?: Array<{
		image_versions2?: {
			candidates?: Array<{ url?: string | null }> | null;
		} | null;
	}> | null;
	image_versions2?: {
		candidates?: Array<{ url?: string | null }> | null;
	} | null;
}): string | null {
	const direct = node.image_versions2?.candidates?.[0]?.url;
	if (direct) {
		return direct;
	}
	const carousel =
		node.carousel_media?.[0]?.image_versions2?.candidates?.[0]?.url;
	return carousel ?? null;
}

/** Media type from the raw node's shape. Instagram's v1 API does not return
 *  an explicit `media_type` string on this feed connection — it is inferred
 *  structurally from which fields are present, matching the manifest's
 *  declared IMAGE/CAROUSEL_ALBUM vocabulary. VIDEO cannot be distinguished
 *  from this endpoint's fields alone (no `video_versions` observed in the
 *  legacy capture), so it is left to a future capture; see connector header
 *  "Known untested". */
export function mediaTypeOf(node: {
	carousel_media?: unknown[] | null;
}): "CAROUSEL_ALBUM" | "IMAGE" {
	return Array.isArray(node.carousel_media) && node.carousel_media.length > 0
		? "CAROUSEL_ALBUM"
		: "IMAGE";
}

// ─── Record builders ────────────────────────────────────────────────────

/** A non-negative finite integer from the profile-page GraphQL counts, or
 *  null. Guards against the field being absent, non-numeric, or negative —
 *  never guessed, never coerced from a different shape. */
function nonNegativeIntOrNull(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return null;
	}
	return Math.trunc(value);
}

/**
 * Extracts follower/following/post counts from the passively-observed
 * profile-page GraphQL response (`PolarisProfilePageContentQuery` /
 * `ProfilePageQuery` / `UserByUsernameQuery`). `/accounts/web_info/` (the
 * `profileRecord` source below) does not carry these fields — confirmed
 * absent from a live payload 2026-09-22 — but legacy
 * `connectors/meta/instagram-playwright.js:656-679,1068-1075` mapped them
 * directly from this same query. Returns all-null when the envelope is
 * absent or malformed rather than guessing; never treats a missing field as
 * zero.
 */
export function profileCountsFromGraphQL(
	envelope: InstagramProfilePageEnvelope | null | undefined,
): {
	follower_count: number | null;
	following_count: number | null;
	post_count: number | null;
} {
	const user = envelope?.data?.data?.user;
	return {
		follower_count: nonNegativeIntOrNull(user?.follower_count),
		following_count: nonNegativeIntOrNull(user?.following_count),
		post_count: nonNegativeIntOrNull(user?.media_count),
	};
}

/**
 * `/accounts/web_info/` (the only observed source for identity fields) does
 * not carry follower_count, following_count, or media_count — confirmed
 * absent from a live payload 2026-09-22. `counts` comes from a separate,
 * passively-observed source (the profile-page GraphQL query; see
 * {@link profileCountsFromGraphQL}) and defaults to all-null when that
 * response was not observed, never guessed.
 */
export function profileRecord(
	user: InstagramWebInfoUser,
	counts: {
		follower_count: number | null;
		following_count: number | null;
		post_count: number | null;
	} = { follower_count: null, following_count: null, post_count: null },
): ProfileRecord | null {
	const id = user.id ?? user.fbid ?? null;
	const username = user.username ?? null;
	if (!id || !username) {
		return null;
	}
	return {
		id,
		username,
		full_name: nullIfEmpty(user.full_name),
		bio: nullIfEmpty(user.biography),
		profile_pic_url: nullIfEmpty(user.profile_pic_url),
		external_url: nullIfEmpty(user.external_url),
		follower_count: counts.follower_count,
		following_count: counts.following_count,
		post_count: counts.post_count,
		is_private: user.is_private ?? null,
		is_verified: user.is_verified ?? null,
		is_business: user.is_business_account ?? null,
	};
}

export function postRecord(edge: InstagramTimelineEdge): PostRecord | null {
	const node = edge.node;
	const id = node.id ?? node.pk ?? node.media_id ?? node.code ?? null;
	if (!id) {
		return null;
	}
	return {
		id,
		caption: node.caption?.text ?? null,
		media_type: mediaTypeOf(node),
		media_url: mediaUrlOf(node),
		like_count: node.like_count ?? null,
		comment_count: null,
		location_name: null,
		taken_at: isoFromTakenAt(node.taken_at, node.taken_at_timestamp),
	};
}

/** One record per (post, liker) pair drawn from a post's
 *  `facepile_top_likers`. Instagram's timeline connection only exposes a
 *  bounded top-likers sample per post (no full-likers listing endpoint is
 *  reachable from a logged-in web session) — see the connector header for
 *  the honest coverage note this implies. */
export function postLikeRecords(edge: InstagramTimelineEdge): PostLikeRecord[] {
	const node = edge.node;
	const postId = node.id ?? node.pk ?? node.media_id ?? node.code ?? null;
	if (!postId) {
		return [];
	}
	const likers = node.facepile_top_likers ?? [];
	const out: PostLikeRecord[] = [];
	for (const liker of likers) {
		const userId = liker.id || liker.pk || null;
		if (!userId) {
			continue;
		}
		out.push({
			post_id: postId,
			profile_pic_url: liker.profile_pic_url || null,
			pk: liker.pk || liker.id || userId,
			id: liker.id || liker.pk || userId,
			user_id: userId,
			username: liker.username || "",
		});
	}
	return out;
}

export function followingRecord(
	user: InstagramFollowingUser,
): FollowingRecord | null {
	const id = user.pk ?? user.id ?? null;
	const username = user.username ?? null;
	if (!id || !username) {
		return null;
	}
	return {
		id,
		username,
		full_name: user.full_name ?? null,
		is_private: user.is_private ?? null,
		is_verified: user.is_verified ?? null,
		profile_pic_url: user.profile_pic_url ?? null,
	};
}

/** Stable id for an `ads` record: the native id when the source provides
 *  one (neither Accounts Center DOM surface does today), else a
 *  deterministic hash of `kind|name` per D6. Hashing (not raw name) keeps
 *  the id a short, stable, non-PII-shaped token even though `name` itself
 *  is already the advertiser/topic display string. */
export function stableAdId(kind: AdKind, name: string): string {
	return createHash("sha256")
		.update(`${kind}|${name}`)
		.digest("hex")
		.slice(0, 32);
}

export function adRecord(
	kind: AdKind,
	name: string,
	description: string | null = null,
): AdRecord | null {
	const trimmed = name.trim();
	if (!trimmed) {
		return null;
	}
	return {
		id: stableAdId(kind, trimmed),
		kind,
		name: trimmed,
		description,
	};
}

/** Build every `ads` record for a run from the three raw scraped lists. */
export function buildAdRecords(input: {
	adTopics: string[];
	advertisers: string[];
	categories: Array<{ description: string | null; name: string }>;
}): AdRecord[] {
	const out: AdRecord[] = [];
	for (const name of input.advertisers) {
		const record = adRecord("advertiser", name);
		if (record) {
			out.push(record);
		}
	}
	for (const name of input.adTopics) {
		const record = adRecord("ad_topic", name);
		if (record) {
			out.push(record);
		}
	}
	for (const category of input.categories) {
		const record = adRecord("ad_category", category.name, category.description);
		if (record) {
			out.push(record);
		}
	}
	return out;
}

// ─── Following-list coverage ────────────────────────────────────────────

/** Deduplicate following-page users by username (Instagram's own listing
 *  identity for this endpoint), preserving first-seen order. */
export function dedupeFollowingByUsername(
	users: readonly InstagramFollowingUser[],
): InstagramFollowingUser[] {
	const seen = new Set<string>();
	const out: InstagramFollowingUser[] = [];
	for (const user of users) {
		const username = user.username;
		if (!username || seen.has(username)) {
			continue;
		}
		seen.add(username);
		out.push(user);
	}
	return out;
}

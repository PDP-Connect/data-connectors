// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the GraphQL responses the x.com web app requests for the
 * signed-in owner. The connector never builds these requests; it reads the
 * bodies the app's own requests returned (see page-scripts.ts).
 *
 * Shapes observed on 2026-10-08 (all GET over XHR, HTTP 200):
 *   - UserByScreenName: `data.user.result`, with `rest_id`,
 *     `is_blue_verified`, `core{created_at,name,screen_name}`,
 *     `avatar{image_url}`, `banner{image_url}`, `location{location}`,
 *     `profile_bio{description,entities}`, `website{url}`,
 *     `relationship_counts{followers,following}`,
 *     `tweet_counts{media_tweets,tweets}`, `action_counts{favorites_count}`,
 *     `verification{verified}`, `privacy{protected}`. There is no `legacy`
 *     object.
 *   - UserOriginalsTimeline, UserRepliesTimeline, Likes:
 *     `data.user.result.timeline.timeline.instructions`.
 *   - Bookmarks: `data.bookmark_timeline_v2.timeline.instructions`.
 *
 * The profile is read from exactly those keys. A key that is missing or has
 * another type gives null, never a value from somewhere else.
 *
 * Everything unrecognised fails closed: a body without the known envelope is
 * a failed page, not an empty one, and a post without an id, an author id or
 * a parseable creation time is counted as unreadable rather than emitted with
 * guesses.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";

/** Long posts (`note_tweet`) run to 25,000 characters. */
const POST_TEXT_MAX_CHARS = 30_000;
const SHORT_TEXT_MAX_CHARS = 500;
const URL_MAX_CHARS = 2048;
const MAX_LIST_ENTRIES = 50;

const NUMERIC_ID_RE = /^\d{1,30}$/;
const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
/** `Mon Mar 10 20:19:52 +0000 2025`. `Date.parse` does not read it on every engine. */
const LEGACY_DATE_RE =
	/^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/;
const WEB_URL_RE = /^https?:\/\//i;
const MONTHS: Readonly<Record<string, number>> = {
	Jan: 0,
	Feb: 1,
	Mar: 2,
	Apr: 3,
	May: 4,
	Jun: 5,
	Jul: 6,
	Aug: 7,
	Sep: 8,
	Oct: 9,
	Nov: 10,
	Dec: 11,
};

export const TIMELINE_OPERATIONS = [
	"UserOriginalsTimeline",
	"UserRepliesTimeline",
	"Likes",
	"Bookmarks",
] as const;
export type TimelineOperation = (typeof TIMELINE_OPERATIONS)[number];
export const PROFILE_OPERATION = "UserByScreenName";

export type PostKind = "post" | "reply" | "quote" | "repost";

export interface PostMedia {
	readonly type: string | null;
	readonly url: string;
}

/** The fields shared by the posts, likes and bookmarks streams. */
export interface PostRecord {
	readonly author_handle: string | null;
	readonly author_id: string;
	readonly author_name: string | null;
	readonly bookmark_count: number | null;
	readonly conversation_id: string | null;
	readonly created_at: string;
	readonly hashtags: readonly string[];
	readonly id: string;
	readonly in_reply_to_handle: string | null;
	readonly in_reply_to_post_id: string | null;
	readonly kind: PostKind;
	readonly lang: string | null;
	readonly like_count: number | null;
	readonly media: readonly PostMedia[];
	readonly mention_handles: readonly string[];
	readonly quote_count: number | null;
	readonly quoted_post_id: string | null;
	readonly reply_count: number | null;
	readonly repost_count: number | null;
	readonly reposted_post_id: string | null;
	readonly sort_index: string | null;
	readonly text: string | null;
	readonly url: string | null;
	readonly urls: readonly string[];
	readonly view_count: number | null;
}

export interface ProfileRecord {
	readonly account_created_at: string | null;
	readonly avatar_url: string | null;
	readonly banner_url: string | null;
	readonly bio: string | null;
	readonly followers_count: number | null;
	readonly following_count: number | null;
	readonly handle: string;
	readonly id: string;
	readonly is_blue_verified: boolean | null;
	readonly is_protected: boolean | null;
	readonly is_verified: boolean | null;
	readonly likes_count: number | null;
	readonly location: string | null;
	readonly name: string | null;
	readonly posts_count: number | null;
	readonly url: string;
	readonly website_url: string | null;
}

export interface TimelineItem {
	/** True for the profile's pinned post, which is not in timeline order. */
	readonly pinned: boolean;
	readonly post: PostRecord;
}

export interface TimelinePage {
	readonly bottomCursor: string | null;
	readonly items: readonly TimelineItem[];
	/** Promoted posts and non-post modules (who-to-follow), which are never read. */
	readonly skippedEntries: number;
	/** Every post result in the page, readable or not: what the page cost the owner's allowance. */
	readonly postResults: number;
	/** Tombstones and posts X marked unavailable. */
	readonly unavailable: number;
	/** Post results without a usable id, author or creation time. */
	readonly unreadable: number;
}

export type BodyFailure = "error_body" | "unreadable";

export type TimelineParse =
	| ({ readonly ok: true } & TimelinePage)
	| {
			readonly ok: false;
			readonly failure: BodyFailure;
			readonly message: string;
	  };

export type ProfileParse =
	| { readonly ok: true; readonly profile: ProfileRecord }
	| {
			readonly ok: false;
			readonly failure: BodyFailure;
			readonly message: string;
	  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a nested value; any missing or non-object step gives undefined. */
function dig(value: unknown, ...keys: readonly string[]): unknown {
	let current = value;
	for (const key of keys) {
		if (!isRecord(current)) {
			return;
		}
		current = current[key];
	}
	return current;
}

const list = (value: unknown): readonly unknown[] =>
	Array.isArray(value) ? value : [];

function numericId(value: unknown): string | null {
	return typeof value === "string" && NUMERIC_ID_RE.test(value) ? value : null;
}

function handle(value: unknown): string | null {
	return typeof value === "string" && HANDLE_RE.test(value) ? value : null;
}

function text(value: unknown, maxChars: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	return safeTextPreview(value, maxChars).preview;
}

function webUrl(value: unknown): string | null {
	return typeof value === "string" &&
		WEB_URL_RE.test(value) &&
		value.length <= URL_MAX_CHARS
		? value
		: null;
}

/** A non-negative whole number, from a number or a digit string. */
function count(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? value : null;
	}
	if (typeof value === "string" && NUMERIC_ID_RE.test(value)) {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : null;
	}
	return null;
}

function bool(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

/** X's `created_at` (`Mon Mar 10 20:19:52 +0000 2025`) as an ISO-8601 instant. */
export function parseXDate(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const match = LEGACY_DATE_RE.exec(value);
	if (!match) {
		return null;
	}
	const [, monthName, day, hour, minute, second, sign, offH, offM, year] =
		match;
	const month = MONTHS[monthName ?? ""];
	if (month === undefined) {
		return null;
	}
	const offsetMinutes =
		(Number(offH) * 60 + Number(offM)) * (sign === "-" ? -1 : 1);
	const instant =
		Date.UTC(
			Number(year),
			month,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
		) -
		offsetMinutes * 60_000;
	return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/**
 * The `variables` an observed request carried, when it has the fields this
 * connector reads: whose timeline it was, and whether it was a later page.
 */
export function parseRequestVariables(raw: string | null): {
	readonly hasCursor: boolean;
	readonly screenName: string | null;
	readonly userId: string | null;
} {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		parsed = null;
	}
	return {
		hasCursor: typeof dig(parsed, "cursor") === "string",
		screenName: handle(dig(parsed, "screen_name")),
		userId: numericId(dig(parsed, "userId")),
	};
}

type DataParse =
	| { readonly ok: true; readonly data: Record<string, unknown> }
	| {
			readonly ok: false;
			readonly failure: BodyFailure;
			readonly message: string;
	  };

/**
 * The `data` object of a GraphQL body. A body whose `errors` came without
 * data is X refusing the request. Errors beside data are per-item notices
 * (a deleted post in a list) and do not fail the page.
 */
function parseData(body: string, operation: string): DataParse {
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return {
			ok: false,
			failure: "unreadable",
			message: `X's ${operation} response was not JSON.`,
		};
	}
	const data = dig(payload, "data");
	const hasData = isRecord(data) && Object.keys(data).length > 0;
	const errors = list(dig(payload, "errors"));
	if (!hasData && errors.length > 0) {
		const code = dig(errors[0], "code");
		return {
			ok: false,
			failure: "error_body",
			message: `X answered ${operation} with an error and no data${typeof code === "number" ? ` (code ${code})` : ""}.`,
		};
	}
	if (!(hasData && isRecord(data))) {
		return {
			ok: false,
			failure: "unreadable",
			message: `X's ${operation} response had no data object.`,
		};
	}
	return { ok: true, data };
}

function entityStrings(
	entities: unknown,
	key: string,
	field: string,
	accept: (value: unknown) => string | null,
): string[] {
	const out: string[] = [];
	for (const entry of list(dig(entities, key)).slice(0, MAX_LIST_ENTRIES)) {
		const value = accept(dig(entry, field));
		if (value !== null && !out.includes(value)) {
			out.push(value);
		}
	}
	return out;
}

function postMedia(legacy: unknown): PostMedia[] {
	const extended = list(dig(legacy, "extended_entities", "media"));
	const source =
		extended.length > 0 ? extended : list(dig(legacy, "entities", "media"));
	const out: PostMedia[] = [];
	for (const entry of source.slice(0, MAX_LIST_ENTRIES)) {
		const url = webUrl(dig(entry, "media_url_https"));
		if (url !== null) {
			out.push({ type: text(dig(entry, "type"), 40), url });
		}
	}
	return out;
}

/** The post behind a `tweet_results.result`, or why there is none to read. */
function unwrapPostResult(
	result: unknown,
): { readonly post: Record<string, unknown> } | "unavailable" | "unreadable" {
	if (!isRecord(result)) {
		return "unreadable";
	}
	const typename = result.__typename;
	if (typename === "TweetWithVisibilityResults") {
		return unwrapPostResult(result.tweet);
	}
	if (typename === "TweetTombstone" || typename === "TweetUnavailable") {
		return "unavailable";
	}
	return typename === "Tweet" ? { post: result } : "unreadable";
}

function resultPostId(result: unknown): string | null {
	const unwrapped = unwrapPostResult(result);
	return typeof unwrapped === "string"
		? null
		: numericId(unwrapped.post.rest_id);
}

function postKind(legacy: unknown): PostKind {
	if (dig(legacy, "retweeted_status_result") !== undefined) {
		return "repost";
	}
	if (numericId(dig(legacy, "in_reply_to_status_id_str")) !== null) {
		return "reply";
	}
	return dig(legacy, "is_quote_status") === true ? "quote" : "post";
}

/** One post record, or null when the id, author id or creation time is unusable. */
export function buildPostRecord(
	post: Record<string, unknown>,
	sortIndex: string | null,
): PostRecord | null {
	const legacy = post.legacy;
	const id = numericId(post.rest_id) ?? numericId(dig(legacy, "id_str"));
	const author = dig(post, "core", "user_results", "result");
	const authorId =
		numericId(dig(author, "rest_id")) ?? numericId(dig(legacy, "user_id_str"));
	const createdAt = parseXDate(dig(legacy, "created_at"));
	if (id === null || authorId === null || createdAt === null) {
		return null;
	}
	const authorHandle = handle(dig(author, "core", "screen_name"));
	const entities = dig(legacy, "entities");
	const noteText = dig(
		post,
		"note_tweet",
		"note_tweet_results",
		"result",
		"text",
	);
	return {
		id,
		url: authorHandle ? `https://x.com/${authorHandle}/status/${id}` : null,
		kind: postKind(legacy),
		created_at: createdAt,
		// A long post's full text is in note_tweet; legacy.full_text is its
		// truncated head.
		text:
			text(noteText, POST_TEXT_MAX_CHARS) ??
			text(dig(legacy, "full_text"), POST_TEXT_MAX_CHARS),
		lang: text(dig(legacy, "lang"), 40),
		author_id: authorId,
		author_handle: authorHandle,
		author_name: text(dig(author, "core", "name"), SHORT_TEXT_MAX_CHARS),
		conversation_id: numericId(dig(legacy, "conversation_id_str")),
		in_reply_to_post_id: numericId(dig(legacy, "in_reply_to_status_id_str")),
		in_reply_to_handle: handle(dig(legacy, "in_reply_to_screen_name")),
		quoted_post_id: resultPostId(dig(post, "quoted_status_result", "result")),
		reposted_post_id: resultPostId(
			dig(legacy, "retweeted_status_result", "result"),
		),
		like_count: count(dig(legacy, "favorite_count")),
		repost_count: count(dig(legacy, "retweet_count")),
		reply_count: count(dig(legacy, "reply_count")),
		quote_count: count(dig(legacy, "quote_count")),
		bookmark_count: count(dig(legacy, "bookmark_count")),
		view_count: count(dig(post, "views", "count")),
		hashtags: entityStrings(entities, "hashtags", "text", (value) =>
			text(value, 280),
		),
		mention_handles: entityStrings(
			entities,
			"user_mentions",
			"screen_name",
			handle,
		),
		urls: entityStrings(entities, "urls", "expanded_url", webUrl),
		media: postMedia(legacy),
		sort_index: numericId(sortIndex),
	};
}

interface PageAccumulator {
	bottomCursor: string | null;
	items: TimelineItem[];
	postResults: number;
	skippedEntries: number;
	unavailable: number;
	unreadable: number;
}

function addPostResult(
	page: PageAccumulator,
	itemContent: unknown,
	sortIndex: string | null,
	pinned: boolean,
): void {
	if (dig(itemContent, "promotedMetadata") !== undefined) {
		page.skippedEntries += 1;
		return;
	}
	const result = dig(itemContent, "tweet_results", "result");
	if (result === undefined) {
		page.skippedEntries += 1;
		return;
	}
	page.postResults += 1;
	const unwrapped = unwrapPostResult(result);
	if (unwrapped === "unavailable") {
		page.unavailable += 1;
		return;
	}
	const post =
		unwrapped === "unreadable"
			? null
			: buildPostRecord(unwrapped.post, sortIndex);
	if (post === null) {
		page.unreadable += 1;
		return;
	}
	page.items.push({ pinned, post });
}

function addEntry(
	page: PageAccumulator,
	entry: unknown,
	pinned: boolean,
): void {
	const entryId = dig(entry, "entryId");
	const content = dig(entry, "content");
	const entryType = dig(content, "entryType");
	const rawSortIndex = dig(entry, "sortIndex");
	const sortIndex = typeof rawSortIndex === "string" ? rawSortIndex : null;
	if (entryType === "TimelineTimelineCursor") {
		const value = dig(content, "value");
		if (dig(content, "cursorType") === "Bottom" && typeof value === "string") {
			page.bottomCursor = value;
		}
		return;
	}
	if (typeof entryId === "string" && entryId.startsWith("promoted")) {
		page.skippedEntries += 1;
		return;
	}
	if (entryType === "TimelineTimelineItem") {
		addPostResult(page, dig(content, "itemContent"), sortIndex, pinned);
		return;
	}
	if (entryType === "TimelineTimelineModule") {
		const items = list(dig(content, "items"));
		if (items.length === 0) {
			page.skippedEntries += 1;
		}
		for (const item of items) {
			addPostResult(page, dig(item, "item", "itemContent"), sortIndex, pinned);
		}
		return;
	}
	page.skippedEntries += 1;
}

function addInstruction(page: PageAccumulator, instruction: unknown): void {
	const type = dig(instruction, "type");
	if (type === "TimelineAddEntries") {
		for (const entry of list(dig(instruction, "entries"))) {
			addEntry(page, entry, false);
		}
	} else if (type === "TimelinePinEntry") {
		addEntry(page, dig(instruction, "entry"), true);
	} else if (type === "TimelineAddToModule") {
		for (const item of list(dig(instruction, "moduleItems"))) {
			addPostResult(page, dig(item, "item", "itemContent"), null, false);
		}
	}
	// TimelineClearCache and any other instruction carry no posts.
}

function timelineInstructions(
	operation: TimelineOperation,
	data: Record<string, unknown>,
): unknown {
	return operation === "Bookmarks"
		? dig(data, "bookmark_timeline_v2", "timeline", "instructions")
		: dig(data, "user", "result", "timeline", "timeline", "instructions");
}

/** Parse one timeline response body. Anything but the known envelope fails. */
export function parseTimelineBody(
	operation: TimelineOperation,
	body: string,
): TimelineParse {
	const parsed = parseData(body, operation);
	if (!parsed.ok) {
		return parsed;
	}
	const instructions = timelineInstructions(operation, parsed.data);
	if (!Array.isArray(instructions)) {
		return {
			ok: false,
			failure: "unreadable",
			message: `X's ${operation} response had no timeline instructions where this connector reads them.`,
		};
	}
	const page: PageAccumulator = {
		bottomCursor: null,
		items: [],
		postResults: 0,
		skippedEntries: 0,
		unavailable: 0,
		unreadable: 0,
	};
	for (const instruction of instructions) {
		addInstruction(page, instruction);
	}
	return { ok: true, ...page };
}

/** Parse the owner's `UserByScreenName` response body. */
export function parseProfileBody(body: string): ProfileParse {
	const parsed = parseData(body, PROFILE_OPERATION);
	if (!parsed.ok) {
		return parsed;
	}
	const user = dig(parsed.data, "user", "result");
	const id = numericId(dig(user, "rest_id"));
	const screenName = handle(dig(user, "core", "screen_name"));
	if (id === null || screenName === null) {
		return {
			ok: false,
			failure: "unreadable",
			message:
				"X's UserByScreenName response had no user id or handle where this connector reads them.",
		};
	}
	return {
		ok: true,
		profile: {
			id,
			handle: screenName,
			name: text(dig(user, "core", "name"), SHORT_TEXT_MAX_CHARS),
			url: `https://x.com/${screenName}`,
			bio: text(dig(user, "profile_bio", "description"), 2000),
			location: text(dig(user, "location", "location"), SHORT_TEXT_MAX_CHARS),
			website_url: webUrl(dig(user, "website", "url")),
			avatar_url: webUrl(dig(user, "avatar", "image_url")),
			banner_url: webUrl(dig(user, "banner", "image_url")),
			account_created_at: parseXDate(dig(user, "core", "created_at")),
			followers_count: count(dig(user, "relationship_counts", "followers")),
			following_count: count(dig(user, "relationship_counts", "following")),
			posts_count: count(dig(user, "tweet_counts", "tweets")),
			likes_count: count(dig(user, "action_counts", "favorites_count")),
			is_blue_verified: bool(dig(user, "is_blue_verified")),
			is_verified: bool(dig(user, "verification", "verified")),
			is_protected: bool(dig(user, "privacy", "protected")),
		},
	};
}

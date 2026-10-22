// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers from TikTok web API responses to this connector's records.
 *
 * Shapes come from the factory's recorded evidence (api.md and the synthetic
 * fixtures copied into __fixtures__/): every response is validated with zod at
 * this boundary, and a record keeps only the fields named here. Media URLs,
 * play addresses and tracking fields are never copied.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import { z } from "zod";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

const DIGITS = /^[0-9]{1,30}$/;
/** TikTok caps a caption at a few thousand characters; the bound stops abuse. */
const CAPTION_MAX_CHARS = 4000;
const SHORT_TEXT_MAX_CHARS = 500;
const BIO_MAX_CHARS = 1000;

/** Counts text values replaced because they were not safe text. */
export interface TextNotes {
	replaced: number;
}

export const newTextNotes = (): TextNotes => ({ replaced: 0 });

function text(
	value: unknown,
	notes: TextNotes,
	max = SHORT_TEXT_MAX_CHARS,
): string | null {
	if (typeof value !== "string") return null;
	const result = safeTextPreview(value, max);
	if (result.kind === "binary") {
		notes.replaced += 1;
		return null;
	}
	return result.preview;
}

const digitString = z.string().regex(DIGITS);
const count = z.number().int().nonnegative();

/** TikTok's envelope: a status code of 0 means the call succeeded. */
const envelopeSchema = z.object({
	statusCode: z.number().int().optional(),
	status_code: z.number().int().optional(),
	status_msg: z.string().optional(),
});

/** The status code of a TikTok envelope, or null when the body has none. */
export function envelopeStatus(json: unknown): number | null {
	const parsed = envelopeSchema.safeParse(json);
	if (!parsed.success) return null;
	return parsed.data.statusCode ?? parsed.data.status_code ?? null;
}

// ─── account (/passport/account/info/v2/) ────────────────────────────────

const accountSchema = z.object({
	data: z.object({
		user_id_str: digitString,
		sec_user_id: z.string().min(1).max(200),
		username: z.string().optional(),
		screen_name: z.string().optional(),
		description: z.string().optional(),
		avatar_url: z.string().optional(),
		user_create_time: count.optional(),
	}),
});

export interface Account {
	avatarUrl: string | null;
	createTime: number | null;
	description: unknown;
	id: string;
	screenName: unknown;
	secUid: string;
	username: unknown;
}

/**
 * The signed-in account, or null when the answer carries no account (TikTok
 * answers a signed-out session with an error object in place of `data`).
 */
export function parseAccount(json: unknown): Account | null {
	const parsed = accountSchema.safeParse(json);
	if (!parsed.success) return null;
	const data = parsed.data.data;
	return {
		id: data.user_id_str,
		secUid: data.sec_user_id,
		username: data.username,
		screenName: data.screen_name,
		description: data.description,
		avatarUrl: httpsUrl(data.avatar_url),
		createTime: data.user_create_time ?? null,
	};
}

// ─── settings (/api/user/settings/) ──────────────────────────────────────

const settingsSchema = z.object({
	settings: z.object({ privateAccount: z.boolean().optional() }),
});

/** `{ ok, privateAccount }`; not ok when the answer has no settings object. */
export function parseSettings(
	json: unknown,
): { ok: true; privateAccount: boolean | null } | { ok: false } {
	const parsed = settingsSchema.safeParse(json);
	if (!parsed.success) return { ok: false };
	return {
		ok: true,
		privateAccount: parsed.data.settings.privateAccount ?? null,
	};
}

// ─── item lists (post, favorite, collect) ────────────────────────────────

const statsSchema = z
	.object({
		collectCount: count.optional(),
		commentCount: count.optional(),
		diggCount: count.optional(),
		playCount: count.optional(),
		shareCount: count.optional(),
		repostCount: count.optional(),
	})
	.optional();

/** statsV2 carries the same counts as decimal strings (no 2^31 overflow). */
const statsV2Schema = z
	.object({
		collectCount: digitString.optional(),
		commentCount: digitString.optional(),
		diggCount: digitString.optional(),
		playCount: digitString.optional(),
		shareCount: digitString.optional(),
		repostCount: digitString.optional(),
	})
	.optional();

const authorStatsSchema = z
	.object({
		diggCount: count.optional(),
		followerCount: count.optional(),
		followingCount: count.optional(),
		heartCount: count.optional(),
		videoCount: count.optional(),
	})
	.optional();

const authorStatsV2Schema = z
	.object({
		diggCount: digitString.optional(),
		followerCount: digitString.optional(),
		followingCount: digitString.optional(),
		heartCount: digitString.optional(),
		videoCount: digitString.optional(),
	})
	.optional();

const authorSchema = z.object({
	id: digitString.optional(),
	uniqueId: z.string().optional(),
	nickname: z.string().optional(),
	signature: z.string().optional(),
	secUid: z.string().optional(),
});

const itemSchema = z.object({
	id: digitString,
	createTime: count,
	desc: z.string().optional(),
	author: authorSchema.optional(),
	authorStats: authorStatsSchema,
	authorStatsV2: authorStatsV2Schema,
	stats: statsSchema,
	statsV2: statsV2Schema,
	video: z.object({ duration: count.optional() }).optional(),
	privateItem: z.boolean().optional(),
	secret: z.boolean().optional(),
	forFriend: z.boolean().optional(),
});

export type Item = z.infer<typeof itemSchema>;

const cursorValue = z.union([z.string().max(200), count]);

const itemPageSchema = z.object({
	hasMore: z.boolean(),
	cursor: cursorValue.optional(),
	total: count.optional(),
	// An empty list answers without the key at all (observed on the repost,
	// collect lists).
	itemList: z.array(z.unknown()).optional(),
});

export interface ItemPage {
	cursor: string | null;
	/**
	 * Field paths (never values) dropped from otherwise readable items because
	 * their value did not match the recorded type; those record fields are
	 * then null. For diagnostics.
	 */
	dropped: string[];
	/** Field paths (never values) that made entries unreadable. */
	failed: string[];
	hasMore: boolean;
	items: Item[];
	total: number | null;
	/** Entries that did not match the item shape; never emitted. */
	unreadable: number;
}

/**
 * Fields an item stays readable without. Its id, creation time and caption
 * are what a record is (an item whose caption is present but not a string is
 * unreadable, never a null caption); stats, author details, video details
 * and privacy flags are context that may be dropped to null when TikTok sends
 * them in another type (observed live: one saved video in Favorites and a
 * collection failed the stricter shape).
 */
const DROPPABLE_KEYS = new Set([
	"author",
	"authorStats",
	"authorStatsV2",
	"stats",
	"statsV2",
	"video",
	"privateItem",
	"secret",
	"forFriend",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One item, dropping (to absent) only the droppable fields whose value did
 * not match; null when anything else does not match. Returns the dropped
 * paths, at most two levels deep (e.g. `author.id`), never values.
 */
export function parseItem(
	entry: unknown,
): { item: Item; dropped: string[] } | { item: null; failed: string[] } {
	const first = itemSchema.safeParse(entry);
	if (first.success) return { item: first.data, dropped: [] };
	const failed = [
		...new Set(
			first.error.issues.map(
				(issue) => issue.path.slice(0, 2).map(String).join(".") || "(item)",
			),
		),
	].sort();
	if (!isRecord(entry)) return { item: null, failed };
	const copy: Record<string, unknown> = { ...entry };
	const dropped: string[] = [];
	for (const issue of first.error.issues) {
		const [top, inner] = issue.path;
		if (typeof top !== "string" || !DROPPABLE_KEYS.has(top))
			return { item: null, failed };
		const parent = copy[top];
		if (typeof inner === "string" && isRecord(parent)) {
			const trimmed = { ...parent };
			delete trimmed[inner];
			copy[top] = trimmed;
			dropped.push(`${top}.${inner}`);
		} else {
			delete copy[top];
			dropped.push(top);
		}
	}
	const second = itemSchema.safeParse(copy);
	return second.success
		? { item: second.data, dropped: [...new Set(dropped)] }
		: { item: null, failed };
}

/** One page of an item list, or null when the page itself is not readable. */
export function parseItemPage(json: unknown): ItemPage | null {
	const parsed = itemPageSchema.safeParse(json);
	if (!parsed.success) return null;
	const items: Item[] = [];
	const dropped = new Set<string>();
	const failed = new Set<string>();
	let unreadable = 0;
	for (const entry of parsed.data.itemList ?? []) {
		const parsedItem = parseItem(entry);
		if (parsedItem.item !== null) {
			items.push(parsedItem.item);
			for (const path of parsedItem.dropped) dropped.add(path);
		} else {
			unreadable += 1;
			for (const path of parsedItem.failed) failed.add(path);
		}
	}
	const cursor = parsed.data.cursor;
	return {
		dropped: [...dropped].sort(),
		failed: [...failed].sort(),
		cursor: cursor === undefined ? null : String(cursor),
		hasMore: parsed.data.hasMore,
		items,
		total: parsed.data.total ?? null,
		unreadable,
	};
}

// ─── user lists (/api/user/list/) ────────────────────────────────────────

const userSchema = z.object({
	user: z.object({
		id: digitString,
		uniqueId: z.string().optional(),
		nickname: z.string().optional(),
		secUid: z.string().optional(),
		verified: z.boolean().optional(),
		privateAccount: z.boolean().optional(),
	}),
});

export type User = z.infer<typeof userSchema>["user"];

const userPageSchema = z.object({
	hasMore: z.boolean(),
	isTruncated: z.boolean().optional(),
	minCursor: count.optional(),
	maxCursor: count.optional(),
	total: count.optional(),
	userList: z.array(z.unknown()).optional(),
});

export interface UserPage {
	hasMore: boolean;
	/** TikTok says it cut the list short: the walk cannot prove its end. */
	isTruncated: boolean;
	minCursor: number | null;
	total: number | null;
	unreadable: number;
	users: User[];
}

export function parseUserPage(json: unknown): UserPage | null {
	const parsed = userPageSchema.safeParse(json);
	if (!parsed.success) return null;
	const users: User[] = [];
	let unreadable = 0;
	for (const entry of parsed.data.userList ?? []) {
		const user = userSchema.safeParse(entry);
		if (user.success) users.push(user.data.user);
		else unreadable += 1;
	}
	return {
		hasMore: parsed.data.hasMore,
		isTruncated: parsed.data.isTruncated === true,
		minCursor: parsed.data.minCursor ?? null,
		total: parsed.data.total ?? null,
		unreadable,
		users,
	};
}

// ─── favorite collections (/api/user/collection_list/) ───────────────────

/**
 * One Favorites collection as the live list answers it (api.md, "Added by
 * hand (2026-10-22): collections"): ids and the item count are decimal
 * strings. The cover, owner id and owner name are not copied.
 */
const collectionSchema = z.object({
	collectionId: digitString,
	name: z.string(),
	total: digitString.optional(),
	userName: z.string().optional(),
});

export type Collection = z.infer<typeof collectionSchema>;

const collectionPageSchema = z.object({
	hasMore: z.boolean(),
	cursor: cursorValue.optional(),
	total: count.optional(),
	// An account without collections answers without the key at all.
	collectionList: z.array(z.unknown()).optional(),
});

export interface CollectionPage {
	collections: Collection[];
	/**
	 * Whether the answer carried a `collectionList` array. Before any
	 * collection existed the live answer had `total: 1` and no list key, so a
	 * total is a claim about entries only when the list is present.
	 */
	listed: boolean;
	cursor: string | null;
	hasMore: boolean;
	total: number | null;
	unreadable: number;
}

export function parseCollectionPage(json: unknown): CollectionPage | null {
	const parsed = collectionPageSchema.safeParse(json);
	if (!parsed.success) return null;
	const collections: Collection[] = [];
	let unreadable = 0;
	for (const entry of parsed.data.collectionList ?? []) {
		const collection = collectionSchema.safeParse(entry);
		if (collection.success) collections.push(collection.data);
		else unreadable += 1;
	}
	const cursor = parsed.data.cursor;
	return {
		collections,
		listed: parsed.data.collectionList !== undefined,
		cursor: cursor === undefined ? null : String(cursor),
		hasMore: parsed.data.hasMore,
		total: parsed.data.total ?? null,
		unreadable,
	};
}

/** A collection's item count, or null when absent or not a safe integer. */
export function collectionItemCount(collection: Collection): number | null {
	if (collection.total === undefined) return null;
	const value = Number(collection.total);
	return Number.isSafeInteger(value) ? value : null;
}

// ─── records ─────────────────────────────────────────────────────────────

/** An RFC 3339 UTC instant from Unix seconds. */
export function secondsToInstant(seconds: number): string {
	return new Date(seconds * 1000).toISOString();
}

function httpsUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.length > 2000) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" ? value : null;
	} catch {
		return null;
	}
}

/** A V2 decimal-string count when it is a safe integer, else the V1 number. */
function countOf(
	v2: string | undefined,
	v1: number | undefined,
): number | null {
	if (v2 !== undefined) {
		const value = Number(v2);
		if (Number.isSafeInteger(value)) return value;
	}
	return v1 ?? null;
}

/**
 * Who may see a video: TikTok marks a private video with privateItem (and the
 * older `secret`), and a friends-only one with forFriend.
 */
function privacyOf(item: Item): "private" | "friends" | "public" | null {
	if (item.privateItem === true || item.secret === true) return "private";
	if (item.forFriend === true) return "friends";
	if (
		item.privateItem === false ||
		item.secret === false ||
		item.forFriend === false
	)
		return "public";
	return null;
}

export function buildProfileRecord(
	account: Account,
	privateAccount: boolean | null,
	ownItem: Item | null,
	notes: TextNotes,
): RecordData {
	// The owner's own video names its author: the handle and the counts there
	// are TikTok's public profile values. Without a video, only the account
	// endpoint speaks, and it carries no counts.
	const author = ownItem?.author;
	const stats = ownItem?.authorStats;
	const statsV2 = ownItem?.authorStatsV2;
	const fromVideo = author !== undefined && author.id === account.id;
	return {
		id: account.id,
		sec_uid: text(account.secUid, notes, 200),
		unique_id: text(
			fromVideo && author.uniqueId ? author.uniqueId : account.username,
			notes,
		),
		nickname: text(
			fromVideo && author.nickname !== undefined
				? author.nickname
				: account.screenName,
			notes,
		),
		bio: text(
			fromVideo && author.signature !== undefined
				? author.signature
				: account.description,
			notes,
			BIO_MAX_CHARS,
		),
		avatar_url: account.avatarUrl,
		private_account: privateAccount,
		follower_count: fromVideo
			? countOf(statsV2?.followerCount, stats?.followerCount)
			: null,
		following_count: fromVideo
			? countOf(statsV2?.followingCount, stats?.followingCount)
			: null,
		like_count: fromVideo
			? countOf(statsV2?.heartCount, stats?.heartCount)
			: null,
		video_count: fromVideo
			? countOf(statsV2?.videoCount, stats?.videoCount)
			: null,
		created_at:
			account.createTime === null ? null : secondsToInstant(account.createTime),
	};
}

export function buildVideoRecord(item: Item, notes: TextNotes): RecordData {
	return {
		id: item.id,
		created_at: secondsToInstant(item.createTime),
		caption: text(item.desc, notes, CAPTION_MAX_CHARS),
		duration_seconds: item.video?.duration ?? null,
		privacy: privacyOf(item),
		play_count: countOf(item.statsV2?.playCount, item.stats?.playCount),
		like_count: countOf(item.statsV2?.diggCount, item.stats?.diggCount),
		comment_count: countOf(
			item.statsV2?.commentCount,
			item.stats?.commentCount,
		),
		share_count: countOf(item.statsV2?.shareCount, item.stats?.shareCount),
		save_count: countOf(item.statsV2?.collectCount, item.stats?.collectCount),
		repost_count: countOf(item.statsV2?.repostCount, item.stats?.repostCount),
	};
}

/** A liked or saved video: someone else's video, so no stats are kept. */
export function buildSavedVideoRecord(
	item: Item,
	notes: TextNotes,
): RecordData {
	return {
		id: item.id,
		author_id: item.author?.id ?? null,
		author_unique_id: text(item.author?.uniqueId, notes),
		author_nickname: text(item.author?.nickname, notes),
		caption: text(item.desc, notes, CAPTION_MAX_CHARS),
		video_created_at: secondsToInstant(item.createTime),
	};
}

export function buildUserRecord(user: User, notes: TextNotes): RecordData {
	return {
		id: user.id,
		unique_id: text(user.uniqueId, notes),
		nickname: text(user.nickname, notes),
		sec_uid: text(user.secUid, notes, 200),
		verified: user.verified ?? null,
		private_account: user.privateAccount ?? null,
	};
}

export function buildCollectionRecord(
	collection: Collection,
	notes: TextNotes,
): RecordData {
	return {
		id: collection.collectionId,
		name: text(collection.name, notes),
		item_count: collectionItemCount(collection),
	};
}

/** One video's membership in one Favorites collection. */
export function buildCollectionItemRecord(
	collectionId: string,
	item: Item,
	notes: TextNotes,
): RecordData {
	return {
		id: `${collectionId}:${item.id}`,
		collection_id: collectionId,
		video_id: item.id,
		author_id: item.author?.id ?? null,
		author_unique_id: text(item.author?.uniqueId, notes),
		caption: text(item.desc, notes, CAPTION_MAX_CHARS),
		video_created_at: secondsToInstant(item.createTime),
	};
}

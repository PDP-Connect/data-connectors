// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builders from Discord API objects to this connector's records. The
 * shapes are the User, partial Guild, Connection and Message objects of
 * Discord's public API documentation. Every field but an id is treated as
 * optional, and a record keeps only the fields named here: nothing else in a
 * response is copied.
 */

import { safeTextPreview } from "@pdpp/connector-protocol/safe-text-preview";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";

/** Milliseconds from the Unix epoch to Discord's epoch (2015-01-01T00:00:00Z). */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const SNOWFLAKE = /^[0-9]{1,20}$/;
/** Discord caps a message at 4,000 characters; the bound only stops abuse. */
const MESSAGE_TEXT_MAX_CHARS = 8000;
const SHORT_TEXT_MAX_CHARS = 500;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** A Discord id as a string, or null when the value is not one. */
export function snowflake(value: unknown): string | null {
	return typeof value === "string" && SNOWFLAKE.test(value) ? value : null;
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareSnowflakes(a: string, b: string): number {
	const left = BigInt(a);
	const right = BigInt(b);
	return left < right ? -1 : left > right ? 1 : 0;
}

/** When the object with this id was created, from the id itself. */
export function snowflakeInstant(id: string): string {
	return new Date(Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS)).toISOString();
}

const text = (value: unknown, max = SHORT_TEXT_MAX_CHARS): string | null =>
	typeof value === "string" ? safeTextPreview(value, max).preview : null;

const bool = (value: unknown): boolean | null =>
	typeof value === "boolean" ? value : null;

const integer = (value: unknown): number | null =>
	typeof value === "number" && Number.isSafeInteger(value) ? value : null;

/** An RFC 3339 instant in UTC, or null when the value does not parse as one. */
function instant(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * True when a response asks for a captcha or an account check. The run ends
 * on it: answering or retrying a challenge is the owner's decision.
 */
export function hasVerificationChallenge(json: unknown): boolean {
	if (!isObject(json)) return false;
	return (
		"captcha_key" in json ||
		"captcha_sitekey" in json ||
		"captcha_service" in json ||
		"captcha_rqdata" in json ||
		"captcha_rqtoken" in json ||
		// 40002: "You need to verify your account in order to perform this action."
		json.code === 40_002
	);
}

/** The wait a 429 or 202 body asks for, in milliseconds, or null. */
export function retryAfterMs(
	json: unknown,
	headerSeconds: number | null,
): number | null {
	const body = isObject(json) ? json.retry_after : undefined;
	const seconds =
		typeof body === "number" && Number.isFinite(body) ? body : headerSeconds;
	return seconds === null || seconds < 0 ? null : Math.ceil(seconds * 1000);
}

/** A 429 that applies to the whole account rather than to one route. */
export function isGlobalRateLimit(json: unknown): boolean {
	return isObject(json) && json.global === true;
}

/**
 * `profile` record from a User object, or null when it has no usable id. The
 * email address, phone number and sign-in security settings in that object
 * are deliberately left out.
 */
export function buildProfileRecord(json: unknown): RecordData | null {
	if (!isObject(json)) return null;
	const id = snowflake(json.id);
	const username = text(json.username);
	if (id === null || username === null) return null;
	return {
		id,
		username,
		global_name: text(json.global_name),
		discriminator: text(json.discriminator, 8),
		avatar: text(json.avatar, 80),
		banner: text(json.banner, 80),
		accent_color: integer(json.accent_color),
		bio: text(json.bio, 2000),
		locale: text(json.locale, 20),
		verified: bool(json.verified),
		premium_type: integer(json.premium_type),
		created_at: snowflakeInstant(id),
	};
}

export type ListParse =
	| { ok: true; records: RecordData[]; unreadable: number }
	| { ok: false };

/** `servers` records from the list of partial Guild objects. */
export function buildServerRecords(json: unknown): ListParse {
	if (!Array.isArray(json)) return { ok: false };
	const records: RecordData[] = [];
	let unreadable = 0;
	for (const guild of json) {
		const id = isObject(guild) ? snowflake(guild.id) : null;
		if (id === null || !isObject(guild)) {
			unreadable += 1;
			continue;
		}
		records.push({
			id,
			name: text(guild.name),
			icon: text(guild.icon, 80),
			is_owner: bool(guild.owner),
			permissions: text(guild.permissions, 40),
			features: Array.isArray(guild.features)
				? guild.features.flatMap((feature) => text(feature, 80) ?? [])
				: [],
			created_at: snowflakeInstant(id),
		});
	}
	return { ok: true, records, unreadable };
}

/**
 * `connections` records from the list of Connection objects. A connection's
 * own id is the linked account's id on the other service and is only unique
 * within its type, so the record id joins the two.
 */
export function buildConnectionRecords(json: unknown): ListParse {
	if (!Array.isArray(json)) return { ok: false };
	const records: RecordData[] = [];
	let unreadable = 0;
	for (const connection of json) {
		const type = isObject(connection) ? text(connection.type, 60) : null;
		const accountId = isObject(connection) ? text(connection.id, 200) : null;
		if (!isObject(connection) || type === null || accountId === null) {
			unreadable += 1;
			continue;
		}
		records.push({
			id: `${type}:${accountId}`,
			type,
			account_id: accountId,
			name: text(connection.name),
			verified: bool(connection.verified),
			revoked: bool(connection.revoked),
			visibility: integer(connection.visibility),
			friend_sync: bool(connection.friend_sync),
			show_activity: bool(connection.show_activity),
			two_way_link: bool(connection.two_way_link),
		});
	}
	return { ok: true, records, unreadable };
}

/** One search hit, reduced to what the walk and the record need. */
export interface SearchHit {
	/** Always well formed: a hit whose author id cannot be read is unreadable. */
	authorId: string;
	id: string;
	/** Its group's position in the raw result listing, counted from the page. */
	position: number;
	record: RecordData;
	timestampMs: number;
}

export type SearchPageParse =
	| {
			ok: true;
			/** Groups in the raw listing, readable or not. */
			groups: number;
			hits: SearchHit[];
			total: number;
			unreadable: number;
			/** Raw group positions this page could not read. */
			unreadablePositions: number[];
	  }
	| { ok: false };

function buildAttachments(value: unknown): RecordData[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((attachment) => {
		const id = isObject(attachment) ? snowflake(attachment.id) : null;
		if (id === null || !isObject(attachment)) return [];
		return [
			{
				id,
				filename: text(attachment.filename),
				content_type: text(attachment.content_type, 120),
				size: integer(attachment.size),
			},
		];
	});
}

/** The server a search ran in. A message in the answer does not name it. */
export interface SearchedServer {
	id: string;
	name: string | null;
}

function buildSearchHit(
	message: unknown,
	position: number,
	server: SearchedServer,
): SearchHit | null {
	if (!isObject(message)) return null;
	const id = snowflake(message.id);
	if (id === null) return null;
	// Without a well-formed author id the walk cannot tell the owner's message
	// from anyone else's, so the hit is unreadable rather than silently skipped.
	const authorId = isObject(message.author)
		? snowflake(message.author.id)
		: null;
	if (authorId === null) return null;
	// A message's id carries its send time, so a missing timestamp is not fatal.
	const timestamp = instant(message.timestamp) ?? snowflakeInstant(id);
	const reference = isObject(message.message_reference)
		? message.message_reference
		: null;
	return {
		id,
		position,
		authorId,
		timestampMs: Date.parse(timestamp),
		record: {
			id,
			server_id: server.id,
			server_name: server.name,
			channel_id: snowflake(message.channel_id),
			content: text(message.content, MESSAGE_TEXT_MAX_CHARS),
			timestamp,
			edited_timestamp: instant(message.edited_timestamp),
			type: integer(message.type),
			pinned: bool(message.pinned),
			// Only the id: the message replied to is someone else's.
			reply_to_message_id: reference ? snowflake(reference.message_id) : null,
			attachments: buildAttachments(message.attachments),
			embed_count: Array.isArray(message.embeds) ? message.embeds.length : 0,
		},
	};
}

/**
 * One page of `GET /guilds/{id}/messages/search`. `messages` is a list of
 * groups; each group is the hit (`hit: true`) with its context messages. A
 * group with no marked hit is read as its first message. Context messages are
 * dropped here, so other people's messages never reach a record.
 */
export function parseSearchPage(
	json: unknown,
	server: SearchedServer,
): SearchPageParse {
	if (!isObject(json) || !Array.isArray(json.messages)) return { ok: false };
	const total =
		typeof json.total_results === "number" &&
		Number.isSafeInteger(json.total_results) &&
		json.total_results >= 0
			? json.total_results
			: null;
	if (total === null) return { ok: false };
	const hits: SearchHit[] = [];
	const unreadablePositions: number[] = [];
	let position = 0;
	for (const group of json.messages) {
		const members: unknown[] = Array.isArray(group) ? group : [group];
		const marked = members.filter(
			(member) => isObject(member) && member.hit === true,
		);
		// Exactly one marked hit, or the first message when none is marked. Two
		// or more marked hits make the group ambiguous, so it is unreadable.
		const target = marked.length > 1 ? null : (marked[0] ?? members[0]);
		const hit = buildSearchHit(target, position, server);
		if (hit) hits.push(hit);
		else unreadablePositions.push(position);
		position += 1;
	}
	return {
		ok: true,
		groups: json.messages.length,
		hits,
		total,
		unreadable: unreadablePositions.length,
		unreadablePositions,
	};
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for WhatsApp (web) stream records. Shape-check-before-emit per
 * packages/polyfill-connectors/docs/connector-authoring-guide.md §3; mirrors
 * manifest.json field for field.
 *
 * Every time is RFC 3339 with a zone (WhatsApp Web gives epoch seconds; the
 * parsers normalize them to UTC `Z`). Free text is `pdppSafeText`; a value that
 * fails the printable-text check is replaced with null by parsers.ts and
 * counted, never inlined.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

export const TEXT_MAX_UNITS = 2_000_000;
const SHORT_TEXT_MAX = 10_000;

const idSchema = z.string().min(1).max(1024);
const nullableId = idSchema.nullable();
const dateTime = z.string().datetime({ offset: true });
const nullableDateTime = dateTime.nullable();
const shortText = pdppSafeText.max(SHORT_TEXT_MAX).nullable();
const longText = pdppSafeText.max(TEXT_MAX_UNITS).nullable();

export const chatsSchema = z.object({
	id: idSchema,
	kind: z.enum(["user", "group", "other"]),
	title: shortText,
	last_activity_at: nullableDateTime,
	archived: z.boolean(),
	pinned: z.boolean().nullable(),
	muted: z.boolean(),
	muted_until: nullableDateTime,
	unread_count: z.number().int().min(0),
	read_only: z.boolean(),
	history_state: shortText,
});

export const messagesSchema = z.object({
	id: idSchema,
	chat_id: idSchema,
	from_me: z.boolean(),
	author: nullableId,
	type: shortText,
	subtype: shortText,
	text: longText,
	sent_at: nullableDateTime,
	quoted_id: nullableId,
	is_forwarded: z.boolean(),
	starred: z.boolean(),
	media_mimetype: z.string().min(1).max(200).nullable(),
	media_size: z.number().int().min(0).nullable(),
	media_filename: z.string().min(1).max(1024).nullable(),
	media_duration: z.number().int().min(0).nullable(),
	call_log: z.string().min(1).max(200).nullable(),
	call_duration: z.number().int().min(0).nullable(),
	poll_name: shortText,
	location_lat: z.number().nullable(),
	location_lng: z.number().nullable(),
});

export const contactsSchema = z.object({
	id: idSchema,
	name: shortText,
	short_name: shortText,
	push_name: shortText,
	is_business: z.boolean().nullable(),
	verified_name: shortText,
});

export const groupsSchema = z.object({
	id: idSchema,
	subject: shortText,
	created_at: nullableDateTime,
	owner: nullableId,
	participants: z.array(
		z.object({
			id: idSchema,
			is_admin: z.boolean(),
			is_super_admin: z.boolean(),
		}),
	),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	chats: chatsSchema,
	messages: messagesSchema,
	contacts: contactsSchema,
	groups: groupsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

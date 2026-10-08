// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record contracts for the Discord browser-session profile. They restate the
 * stream schemas in manifest.json; keep the two in step.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

/** A Discord id: a decimal 64-bit integer carried as a string. */
const snowflake = z.string().regex(/^[0-9]{1,20}$/);
const instant = z.string().datetime({ offset: true });
const shortText = pdppSafeText.max(500);

export const profileSchema = z.object({
	id: snowflake,
	username: shortText,
	global_name: shortText.nullable(),
	discriminator: pdppSafeText.max(8).nullable(),
	avatar: pdppSafeText.max(80).nullable(),
	banner: pdppSafeText.max(80).nullable(),
	accent_color: z.number().int().nullable(),
	bio: pdppSafeText.max(2000).nullable(),
	locale: pdppSafeText.max(20).nullable(),
	verified: z.boolean().nullable(),
	premium_type: z.number().int().nullable(),
	created_at: instant,
});

export const serversSchema = z.object({
	id: snowflake,
	name: shortText.nullable(),
	icon: pdppSafeText.max(80).nullable(),
	is_owner: z.boolean().nullable(),
	permissions: pdppSafeText.max(40).nullable(),
	features: z.array(pdppSafeText.max(80)),
	created_at: instant,
});

export const connectionsSchema = z.object({
	id: pdppSafeText.max(261),
	type: pdppSafeText.max(60),
	account_id: pdppSafeText.max(200),
	name: shortText.nullable(),
	verified: z.boolean().nullable(),
	revoked: z.boolean().nullable(),
	visibility: z.number().int().nullable(),
	friend_sync: z.boolean().nullable(),
	show_activity: z.boolean().nullable(),
	two_way_link: z.boolean().nullable(),
});

const attachmentSchema = z.object({
	id: snowflake,
	filename: shortText.nullable(),
	content_type: pdppSafeText.max(120).nullable(),
	size: z.number().int().nullable(),
});

export const messagesSchema = z.object({
	id: snowflake,
	server_id: snowflake,
	server_name: shortText.nullable(),
	channel_id: snowflake.nullable(),
	content: pdppSafeText.max(8000).nullable(),
	timestamp: instant,
	edited_timestamp: instant.nullable(),
	type: z.number().int().nullable(),
	pinned: z.boolean().nullable(),
	reply_to_message_id: snowflake.nullable(),
	attachments: z.array(attachmentSchema),
	embed_count: z.number().int(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	servers: serversSchema,
	connections: connectionsSchema,
	messages: messagesSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

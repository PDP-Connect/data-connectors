// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The Slack source's record contracts, and the Web API answer shapes this
 * browser profile reads.
 *
 * The browser profile emits the same records as the archive profile for the
 * streams it declares, so it registers the archive profile's Zod schemas
 * rather than restating them. index.test.ts asserts the two manifests carry
 * identical stream contracts.
 *
 * The Web API schemas are deliberately loose: a message, channel or user
 * object keeps every field Slack sent, because the record builders in
 * ../slack/parsers.ts read the whole object as the data blob the archive
 * profile would have stored. Each schema pins only the fields this profile's own logic
 * branches on.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";
import {
	channelsSchema,
	filesSchema,
	messageAttachmentsSchema,
	messagesSchema,
	reactionsSchema,
	remindersSchema,
	starsSchema,
	userGroupsSchema,
	usersSchema,
	workspaceSchema,
} from "../slack/schemas.ts";

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	workspace: workspaceSchema,
	channels: channelsSchema,
	users: usersSchema,
	messages: messagesSchema,
	message_attachments: messageAttachmentsSchema,
	reactions: reactionsSchema,
	files: filesSchema,
	user_groups: userGroupsSchema,
	reminders: remindersSchema,
	stars: starsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

// Module-scoped regexes (Biome useTopLevelRegex).
const SLACK_TS_RE = /^\d{10}\.\d{1,6}$/;

// ─── Web API answers ────────────────────────────────────────────────────

/** What every Web API method answers with, on top of its own payload. */
export const envelopeSchema = z.looseObject({
	ok: z.boolean(),
	error: z.string().optional(),
	response_metadata: z
		.looseObject({ next_cursor: z.string().optional() })
		.optional(),
});

/** One workspace the web client is signed in to, as read from its local config. The session token is never part of this. */
export const signedInTeamSchema = z.object({
	id: z.string().min(1),
	name: z.string(),
	domain: z.string(),
	url: z.string(),
});

export const signedInTeamsSchema = z.array(signedInTeamSchema);

export const authTestSchema = envelopeSchema.extend({
	url: z.string().optional(),
	team: z.string().optional(),
	user: z.string().optional(),
	team_id: z.string().optional(),
	user_id: z.string().optional(),
	bot_id: z.string().optional(),
	enterprise_id: z.string().optional(),
});

export const teamInfoSchema = envelopeSchema.extend({
	team: z
		.looseObject({
			id: z.string(),
			name: z.string().optional(),
			domain: z.string().optional(),
			enterprise_id: z.string().optional(),
		})
		.optional(),
});

export const userObjectSchema = z.looseObject({
	id: z.string(),
	name: z.string().optional(),
});

export const usersListSchema = envelopeSchema.extend({
	members: z.array(userObjectSchema).optional(),
});

export const conversationObjectSchema = z.looseObject({
	id: z.string(),
	name: z.string().optional(),
	is_im: z.boolean().optional(),
	is_mpim: z.boolean().optional(),
	is_private: z.boolean().optional(),
	is_archived: z.boolean().optional(),
});

export const conversationsListSchema = envelopeSchema.extend({
	channels: z.array(conversationObjectSchema).optional(),
});

export const messageFileSchema = z.looseObject({
	id: z.string().optional(),
	name: z.string().optional(),
	mode: z.string().optional(),
	url_private: z.string().optional(),
});

export const messageObjectSchema = z.looseObject({
	ts: z.string().regex(SLACK_TS_RE),
	text: z.string().optional(),
	thread_ts: z.string().optional(),
	reply_count: z.number().int().optional(),
	latest_reply: z.string().optional(),
	files: z.array(messageFileSchema).optional(),
});

export const historySchema = envelopeSchema.extend({
	messages: z.array(messageObjectSchema).optional(),
	has_more: z.boolean().optional(),
});

export const userGroupObjectSchema = z.object({
	id: z.string(),
	team_id: z.string().optional(),
	handle: z.string().optional(),
	name: z.string().optional(),
	description: z.string().optional(),
	is_external: z.boolean().optional(),
	is_subteam: z.boolean().optional(),
	users: z.array(z.string()).optional(),
	prefs: z.object({ channels: z.array(z.string()).optional() }).optional(),
	date_create: z.number().optional(),
	date_update: z.number().optional(),
	date_delete: z.number().optional(),
});

export const userGroupsListSchema = envelopeSchema.extend({
	usergroups: z.array(userGroupObjectSchema).optional(),
});

export const reminderObjectSchema = z.object({
	id: z.string(),
	creator: z.string().optional(),
	user: z.string().optional(),
	text: z.string().optional(),
	recurring: z.boolean().optional(),
	time: z.number().optional(),
	complete_ts: z.number().optional(),
});

export const remindersListSchema = envelopeSchema.extend({
	reminders: z.array(reminderObjectSchema).optional(),
});

export const starObjectSchema = z.object({
	type: z.string().optional(),
	channel: z.string().optional(),
	date_create: z.number().optional(),
	file: z.object({ id: z.string().optional() }).optional(),
	message: z
		.object({ ts: z.string().optional(), user: z.string().optional() })
		.optional(),
});

export const starsListSchema = envelopeSchema.extend({
	items: z.array(starObjectSchema).optional(),
});

/** The `messages` stream's checkpoint, as this profile writes it. */
export const messagesCursorSchema = z.object({
	channel_last_ts: z.record(z.string(), z.string()),
	floor_ts: z.number(),
	format: z.literal(1),
});

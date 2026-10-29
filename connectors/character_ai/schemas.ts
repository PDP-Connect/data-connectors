// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Character.AI: the neo.character.ai API responses the
 * connector reads (validated at the boundary, before any record is built) and
 * the records it emits (validated again by the runtime before RECORD).
 *
 * Response shapes follow the factory's observed shape profiles for
 * `GET /chats/recent/` and `GET /turns/:chat_id/`. Unknown extra fields are
 * allowed (the API adds fields freely); the fields records are built from are
 * required with their observed types.
 */

import {
	nullablePdppSafeText,
	pdppSafeText,
} from "@pdpp/connector-protocol/pdpp-safe-text";
import { type z as Zod, z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_TOKEN_RE = /^[A-Z][A-Z0-9_]*$/;

export const uuidSchema = z.string().regex(UUID_RE);
const enumToken = z.string().regex(ENUM_TOKEN_RE);
const rfc3339 = z.iso.datetime({ offset: true });
/**
 * Source timestamps: every time field the chat list, chat detail and turns
 * endpoints returned in the evidence is RFC 3339 with a `Z` zone. A zoneless
 * value has no documented clock, so the response is refused at the boundary
 * (the run fails) rather than guessed or nulled.
 */
const sourceTime = z.iso.datetime({ offset: true });

// ─── API responses (boundary) ────────────────────────────────────────────

/**
 * A chat's text fields are validated here, not repaired later: a present value
 * that is not PDPP-safe (or an enum that is not an UPPER_SNAKE token) makes
 * the response unreadable, so it is never stored as null.
 */
export const apiChatSchema = z.looseObject({
	chat_id: uuidSchema,
	create_time: sourceTime,
	creator_id: pdppSafeText.nullish(),
	character_id: pdppSafeText.min(1),
	character_name: pdppSafeText.nullish(),
	state: enumToken.nullish(),
	type: enumToken.nullish(),
	visibility: enumToken.nullish(),
});

/**
 * The pagination envelope both list endpoints returned in the evidence:
 * `meta.next_token`, a string (empty on the last page). It is required: a
 * response without it says nothing about the end of the list. An explicit
 * null is accepted as an end token.
 */
const paginationMeta = z.looseObject({ next_token: z.string().nullable() });

/** Rows are validated one by one (parseChatsPage), so one bad row never hides the rest. */
export const apiChatsPageSchema = z.looseObject({
	chats: z.array(z.unknown()),
	meta: paginationMeta,
});

const apiCandidateSchema = z.looseObject({
	candidate_id: z.string().min(1),
	create_time: sourceTime.nullish(),
	raw_content: z.string().nullish(),
	is_final: z.boolean().nullish(),
	model_type: z.string().nullish(),
});

export const apiTurnSchema = z.looseObject({
	turn_key: z.looseObject({ chat_id: uuidSchema, turn_id: uuidSchema }),
	create_time: sourceTime,
	last_update_time: sourceTime.nullish(),
	state: z.string().nullish(),
	author: z.looseObject({
		author_id: z.string().nullish(),
		name: z.string().nullish(),
		is_human: z.boolean().nullish(),
	}),
	candidates: z.array(apiCandidateSchema),
	primary_candidate_id: z.string().nullish(),
});

export const apiTurnsPageSchema = z.looseObject({
	turns: z.array(apiTurnSchema),
	meta: paginationMeta,
});

/** GET /chat/:chat_id/ — the chat without the character's display fields. */
export const apiChatDetailSchema = z.looseObject({
	chat: apiChatSchema.omit({ character_name: true }),
});

export type ApiChat = z.infer<typeof apiChatSchema>;
export type ApiTurn = z.infer<typeof apiTurnSchema>;

// ─── Records ─────────────────────────────────────────────────────────────

export const chatRecordSchema = z.object({
	id: uuidSchema,
	character_id: pdppSafeText.min(1),
	character_name: nullablePdppSafeText,
	creator_id: nullablePdppSafeText,
	type: enumToken.nullable(),
	state: enumToken.nullable(),
	visibility: enumToken.nullable(),
	create_time: rfc3339,
	last_interaction_time: rfc3339.nullable(),
	turn_count: z.number().int().min(0).nullable(),
});

export const messageRecordSchema = z.object({
	id: uuidSchema,
	chat_id: uuidSchema,
	author_kind: z.enum(["user", "character"]),
	author_id: nullablePdppSafeText,
	author_name: nullablePdppSafeText,
	text: pdppSafeText,
	primary_candidate_id: pdppSafeText.min(1),
	candidate_count: z.number().int().min(1),
	is_final: z.literal(true),
	model_type: enumToken.nullable(),
	state: enumToken.nullable(),
	create_time: rfc3339,
	last_update_time: rfc3339.nullable(),
});

export type ChatRecord = z.infer<typeof chatRecordSchema>;
export type MessageRecord = z.infer<typeof messageRecordSchema>;

export const SCHEMAS: Record<string, Zod.ZodTypeAny> = {
	chats: chatRecordSchema,
	messages: messageRecordSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

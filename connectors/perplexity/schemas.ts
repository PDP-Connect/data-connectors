// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for the Perplexity connector's stream records, checked before
 * every emit. A record that fails here becomes a SKIP_RESULT instead of a
 * RECORD, so the store never receives data that looks right but is not.
 *
 * Field intents follow the authoring guide's text classification:
 *   - ids, slugs, timestamps → structurally constrained strings
 *   - titles, modes, models, message bodies → pdppSafeText
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

/** A platform identifier: non-empty, bounded, no whitespace or control bytes. */
const idSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^\S+$/, "must not contain whitespace");

/** A UTC ISO-8601 instant as the parsers emit it (`YYYY-MM-DDTHH:MM:SS.ffffffZ`). */
const instantSchema = z
	.string()
	.min(4)
	.max(40)
	.refine((value) => !Number.isNaN(new Date(value).getTime()), {
		message: "unparseable timestamp",
	});

/** Answer or question text. Bound to 1 MB; anything larger is suspicious. */
const contentSchema = pdppSafeText.max(1_048_576);

// ─── conversations ───────────────────────────────────────────────────────

export const conversationSchema = z.object({
	id: idSchema,
	title: pdppSafeText.max(500).nullable(),
	slug: idSchema.nullable(),
	mode: pdppSafeText.max(64).nullable(),
	model: pdppSafeText.max(120).nullable(),
	create_time: instantSchema.nullable(),
	update_time: instantSchema.nullable(),
	entry_count: z.number().int().min(0).nullable(),
	access: z.number().int().nullable(),
});

// ─── messages ───────────────────────────────────────────────────────────

const citationSchema = z.object({
	title: pdppSafeText.max(500).nullable(),
	url: z.string().url().max(2048),
});

export const messageSchema = z.object({
	id: idSchema,
	conversation_id: idSchema,
	role: z.enum(["user", "assistant"]),
	content: contentSchema.nullable(),
	create_time: instantSchema.nullable(),
	model: pdppSafeText.max(120).nullable(),
	citations: z.array(citationSchema),
});

// ─── registry ───────────────────────────────────────────────────────────

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	conversations: conversationSchema,
	messages: messageSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

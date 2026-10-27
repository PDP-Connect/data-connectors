// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for ChatGPT stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that fail the schema
 * become SKIP_RESULT events instead of RECORD events, so the RS never
 * receives data that looks right but isn't.
 *
 * ChatGPT's connector fetches JSON from OpenAI's internal API via an
 * authenticated browser. The shapes below defend against:
 *   - upstream API surface drift (new fields or renamed fields that
 *     our extraction misreads)
 *   - silent type coercion (timestamps becoming numbers, IDs becoming ints)
 *   - accidentally captured UI strings (should never happen since we
 *     never DOM-extract, but defense in depth)
 *
 * UUIDs in ChatGPT are lowercase hex with dashes (standard v4 shape)
 * but the API also uses opaque IDs for some things (memories, messages).
 * Keep ID schemas permissive.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Text-field classification (docs/reference/binary-content-invariant-design-brief.md §4.4):
//   - largeText, display names/descriptions, role, content_type → pdppSafeText
//   - idSchema (regex-validated structural strings) → z.string().regex(...)

// Permissive ID: non-empty, bounded, no whitespace or control chars.
const idSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^\S+$/, "must not contain whitespace");

// ISO-8601 timestamp — not all ChatGPT API responses use strict ISO, so
// be lenient: accept anything parseable by Date as long as it looks
// timestamp-ish (has digits and either T or -).
const looseTimestamp = z
	.string()
	.min(4)
	.max(40)
	.refine((s) => !Number.isNaN(new Date(s).getTime()), {
		message: "unparseable timestamp",
	});

// Large text fields (messages content, memories content, GPT instructions).
// Bound to 1 MB — anything larger is suspicious.
const largeText = pdppSafeText.max(1_048_576);

// ─── conversations ──────────────────────────────────────────────────────

export const conversationSchema = z.object({
	id: idSchema,
	title: pdppSafeText.max(500).nullable(),
	create_time: looseTimestamp.nullable(),
	update_time: looseTimestamp.nullable(),
	is_archived: z.boolean().nullable(),
	is_starred: z.boolean().nullable(),
	workspace_id: idSchema.nullable(),
	current_node: idSchema.nullable(),
	message_count_on_current_branch: z
		.number()
		.int()
		.min(0)
		.max(100_000)
		.nullable(),
	// Assistant replies (not tool calls or other intermediate steps) on the
	// current branch per model slug; null when the conversation detail has not
	// been read. Keys follow `messages.model_slug`
	// (safe text, 1 to 80 characters); values are counts. No message text.
	model_counts: z
		.record(pdppSafeText.min(1).max(80), z.number().int().min(1).max(100_000))
		.nullable(),
	gizmo_id: idSchema.nullable(),
});

const blobRefSchema = z
	.object({
		blob_id: z.string().regex(/^sha256:[0-9a-f]{64}$/),
		mime_type: z.literal("application/json"),
		size_bytes: z.number().int().min(1).max(33_554_432),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
	})
	.strict()
	.refine((ref) => ref.blob_id === `sha256:${ref.sha256}`);

// ─── messages ───────────────────────────────────────────────────────────

// A message record id is `<conversation_id>:<node_id>`, so it can be as long as
// two ids and the separator.
const messageIdSchema = z
	.string()
	.min(1)
	.max(257)
	.regex(/^\S+$/, "must not contain whitespace");

export const messageSchema = z
	.object({
		id: messageIdSchema,
		// The source's node id; the conversation's `current_node` names one.
		node_id: idSchema,
		conversation_id: idSchema,
		parent_id: messageIdSchema.nullable(),
		children_ids: z.array(messageIdSchema),
		// role can be user / assistant / system / tool / etc.
		role: pdppSafeText.max(40).nullable(),
		// A string is the text; null means the source had none, or the text is in
		// `blob_ref`; ABSENT means the text exists but cannot be stored (no blob
		// spool on this host, or over the 32 MiB blob cap).
		content: largeText.nullable().optional(),
		// Entries of the source body's `parts` that are not strings, each
		// `{ index, part }`. Free-form; strings inside are pdpp-safe-escape-v1.
		non_string_parts: z.array(z.unknown()),
		// content_type is like "text" / "code" / "multimodal_text" / etc.
		content_type: pdppSafeText.max(60).nullable(),
		model_slug: pdppSafeText.max(80).nullable(),
		create_time: looseTimestamp.nullable(),
		finish_reason: pdppSafeText.max(60).nullable(),
		citations: z.array(z.unknown()),
		// Free-form entries: every string inside is pdpp-safe-escape-v1 encoded
		// by the extractor (see manifest). The synthesized-call invariant is
		// enforced where the call is built, not here.
		tool_calls: z.array(z.unknown()),
		attachment_ids: z.array(idSchema),
		on_current_branch: z.boolean(),
		// Present only when the full text exceeds the inline cap: `content` is then
		// null and the text is a Core blob (a JSON string, application/json).
		blob_ref: blobRefSchema.optional(),
	})
	.refine(
		(message) => message.blob_ref === undefined || message.content === null,
		{
			message: "blob_ref requires content to be null",
			path: ["content"],
		},
	);

// ─── memories ───────────────────────────────────────────────────────────

export const memorySchema = z.object({
	id: idSchema,
	content: largeText,
	created_at: looseTimestamp.nullable(),
	updated_at: looseTimestamp.nullable(),
	// Legacy classification tag (e.g. "memory", "user_provided"); live API
	// returns it inconsistently, so it's nullable rather than defaulted.
	type: pdppSafeText.max(80).nullable(),
});

// ─── custom_gpts ────────────────────────────────────────────────────────

export const customGptSchema = z.object({
	id: idSchema,
	short_url: pdppSafeText.max(200).nullable(),
	display_name: pdppSafeText.max(200).nullable(),
	display_description: pdppSafeText.max(2000).nullable(),
	display_welcome_message: pdppSafeText.max(2000).nullable(),
	instructions: largeText.nullable(),
	tools: z.array(z.unknown()),
	created_at: looseTimestamp.nullable(),
	updated_at: looseTimestamp.nullable(),
	author_id: idSchema.nullable(),
	author_name: pdppSafeText.max(200).nullable(),
	is_public: z.boolean().nullable(),
	category: pdppSafeText.max(80).nullable(),
	tags: z.array(pdppSafeText.max(100)),
});

// ─── custom_instructions ────────────────────────────────────────────────

export const customInstructionsSchema = z.object({
	id: idSchema,
	about_user: largeText.nullable(),
	response_style: largeText.nullable(),
	enabled: z.boolean().nullable(),
	updated_at: looseTimestamp.nullable(),
});

// ─── account_plan ───────────────────────────────────────────────────────

export const accountPlanSchema = z.object({
	id: idSchema,
	account_id: idSchema.nullable(),
	// "personal" / "workspace"
	account_structure: pdppSafeText.max(80).nullable(),
	account_created_at: looseTimestamp.nullable(),
	// plan_type is like "free" / "plus" / "pro" / "team" / "enterprise".
	plan_type: pdppSafeText.max(80).nullable(),
	plan_display_name: pdppSafeText.max(120).nullable(),
	subscription_plan: pdppSafeText.max(120).nullable(),
	has_active_subscription: z.boolean().nullable(),
	billing_period: pdppSafeText.max(40).nullable(),
	will_renew: z.boolean().nullable(),
	renews_at: looseTimestamp.nullable(),
	expires_at: looseTimestamp.nullable(),
	cancels_at: looseTimestamp.nullable(),
	// Only ever observed as null. Strict, so no key beyond these two (billing
	// ids, profile fields) can be stored.
	scheduled_plan_change: z
		.object({
			plan_type: z
				.string()
				.regex(/^[a-z][a-z_-]{0,39}$/)
				.nullable(),
			changes_at: looseTimestamp.nullable(),
		})
		.strict()
		.nullable(),
});

// ─── shared_conversations ───────────────────────────────────────────────

export const sharedConversationSchema = z.object({
	id: idSchema,
	conversation_id: idSchema.nullable(),
	share_url: pdppSafeText.max(400).nullable(),
	title: pdppSafeText.max(500).nullable(),
	created_at: looseTimestamp.nullable(),
	anonymous: z.boolean().nullable(),
	is_public: z.boolean().nullable(),
	highlighted_text: largeText.nullable(),
});

// ─── Registry ───────────────────────────────────────────────────────────

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	conversations: conversationSchema,
	messages: messageSchema,
	memories: memorySchema,
	custom_gpts: customGptSchema,
	custom_instructions: customInstructionsSchema,
	account_plan: accountPlanSchema,
	shared_conversations: sharedConversationSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

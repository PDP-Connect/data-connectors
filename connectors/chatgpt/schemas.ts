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

export const messageSchema = z
	.object({
		id: idSchema,
		conversation_id: idSchema,
		parent_id: idSchema.nullable(),
		children_ids: z.array(idSchema),
		// role can be user / assistant / system / tool / etc.
		role: pdppSafeText.max(40).nullable(),
		// A string is the text; null means the source had none, or the text is in
		// `blob_ref`; ABSENT means the text exists but cannot be stored (no blob
		// spool on this host, or over the 32 MiB blob cap).
		content: largeText.nullable().optional(),
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

// ─── conversation_usage / usage_summary ─────────────────────────────────
// Metadata only. Every object is strict and every string is an enum, a
// bounded slug or an opaque reference, so no free text (titles, message
// bodies, tool or action names) can be stored even if a builder regresses.

const usageSlug = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/);
const usageRef = z.string().regex(/^[cg]_[0-9a-f]{32}$/);
const count = z.number().int().min(0).max(1_000_000_000);
const usageFeatureCounts = z
	.object({
		web_search: count,
		code_interpreter: count,
		image_generation: count,
		canvas: count,
		deep_research: count,
		memory_update: count,
		file_search: count,
		reasoning: count,
		voice: count,
		other_tool: count,
	})
	.strict();
const usageModelCounts = z
	.array(z.object({ slug: usageSlug, assistant_messages: count }).strict())
	.max(500);

export const conversationUsageSchema = z
	.object({
		id: usageRef,
		create_time: looseTimestamp.nullable(),
		update_time: looseTimestamp.nullable(),
		is_archived: z.boolean().nullable(),
		is_starred: z.boolean().nullable(),
		is_shared: z.boolean().nullable(),
		in_workspace: z.boolean().nullable(),
		gizmo_kind: z.enum(["none", "custom_gpt", "project", "other"]),
		gizmo_ref: usageRef.nullable(),
		detail_status: z.enum(["fetched", "not_fetched", "unavailable", "failed"]),
		default_model_slug: usageSlug.nullable(),
		message_counts: z
			.object({
				user: count,
				assistant: count,
				tool: count,
				system: count,
				other: count,
				hidden: count,
			})
			.strict()
			.nullable(),
		turn_count: count.nullable(),
		branch_count: count.nullable(),
		nodes_total: count.nullable(),
		models: usageModelCounts.nullable(),
		features: usageFeatureCounts.nullable(),
		user_attachments: count.nullable(),
		user_images: count.nullable(),
		user_chars_total: count.nullable(),
		user_chars_max: count.nullable(),
		assistant_chars_total: count.nullable(),
		first_message_at: looseTimestamp.nullable(),
		last_message_at: looseTimestamp.nullable(),
	})
	.strict();

export const usageSummarySchema = z
	.object({
		id: z.literal("usage_summary"),
		timezone: z
			.string()
			.regex(/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/)
			.max(64),
		timezone_source: z.enum(["browser", "default_utc"]),
		coverage: z
			.object({
				conversations_listed: count,
				detail_fetched: count,
				detail_unavailable: count,
				detail_failed: count,
				detail_not_fetched: count,
				detail_complete: z.boolean(),
			})
			.strict(),
		first_activity_at: looseTimestamp.nullable(),
		last_activity_at: looseTimestamp.nullable(),
		active_days: count,
		longest_streak_days: count,
		totals: z
			.object({
				conversations: count,
				archived: count,
				starred: count,
				shared: count.nullable(),
				in_workspace: count,
				custom_gpt_conversations: count,
				project_conversations: count,
				user_messages: count,
				assistant_messages: count,
				tool_messages: count,
				user_attachments: count,
				user_images: count,
				user_chars_total: count,
				regenerated_or_edited_conversations: count,
				custom_gpts_used: count,
				projects_used: count,
			})
			.strict(),
		user_message_chars: z
			.object({
				total: count,
				mean_per_message: count.nullable(),
				median_of_conversation_max: count.nullable(),
			})
			.strict(),
		models: usageModelCounts,
		feature_conversations: usageFeatureCounts,
		months: z
			.array(
				z
					.object({
						month: z.string().regex(/^\d{4}-\d{2}$/),
						conversations_created: count,
						user_messages: count,
						assistant_messages: count,
						active_days: count,
						models: usageModelCounts,
						feature_conversations: usageFeatureCounts,
					})
					.strict(),
			)
			.max(1200),
		hour_of_day: z.array(count).length(24),
		day_of_week: z.array(count).length(7),
		account: z
			.object({
				created_month: z
					.string()
					.regex(/^\d{4}-\d{2}$/)
					.nullable(),
				data_residency_region: usageSlug.nullable(),
				compute_residency_region: usageSlug.nullable(),
			})
			.strict(),
		settings: z
			.object({
				memory_count: count.nullable(),
				memory_num_tokens: count.nullable(),
				memory_max_tokens: count.nullable(),
				custom_instructions_enabled: z.boolean().nullable(),
				custom_instructions_about_user_set: z.boolean().nullable(),
				custom_instructions_response_style_set: z.boolean().nullable(),
				setting_flags: z
					.record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.boolean())
					.nullable(),
			})
			.strict(),
		locale: z
			.object({
				browser_language: z
					.string()
					.regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
					.max(35)
					.nullable(),
				network_country: z
					.string()
					.regex(/^[A-Z]{2}$/)
					.nullable(),
			})
			.strict(),
	})
	.strict();

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
	conversation_usage: conversationUsageSchema,
	usage_summary: usageSummarySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

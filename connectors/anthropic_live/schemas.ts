// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for anthropic_live stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3; mirrors manifest.json.
 *
 * conversations and messages follow connectors/anthropic/schemas.ts, without
 * `blob_ref` (there is no export envelope) and with `model_source` on
 * messages. account_plan follows connectors/chatgpt/schemas.ts field for
 * field.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regex (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const PLAN_TYPE_RE = /^[a-z][a-z_-]{0,39}$/;

const idSchema = z.string().min(1).max(128);
const isoDateTimeNullable = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();

export const conversationsSchema = z.object({
	id: idSchema,
	title: pdppSafeText.max(4000).nullable(),
	create_time: isoDateTimeNullable,
	update_time: isoDateTimeNullable,
	project_id: idSchema.nullable(),
	model: z.string().min(1).max(128).nullable(),
	message_count: z.number().int().min(0).nullable(),
	is_starred: z.boolean().nullable(),
});

export const messagesSchema = z.object({
	id: idSchema,
	conversation_id: idSchema,
	role: z.string().min(1).max(64).nullable(),
	parent_id: idSchema.nullable(),
	content: pdppSafeText.max(10_000_000).nullable(),
	model: z.string().min(1).max(128).nullable(),
	// "conversation": the conversation's model when the message was collected.
	model_source: z.literal("conversation").nullable(),
	create_time: isoDateTimeNullable,
	update_time: isoDateTimeNullable,
	attachments: z.array(z.record(z.string(), z.unknown())).nullable(),
});

export const accountPlanSchema = z.object({
	id: idSchema,
	account_id: idSchema.nullable(),
	// "personal" / "workspace"
	account_structure: pdppSafeText.max(80).nullable(),
	account_created_at: isoDateTimeNullable,
	// "free" / "pro" / "max" / "team" / "enterprise"
	plan_type: pdppSafeText.max(80).nullable(),
	plan_display_name: pdppSafeText.max(120).nullable(),
	subscription_plan: pdppSafeText.max(120).nullable(),
	has_active_subscription: z.boolean().nullable(),
	billing_period: pdppSafeText.max(40).nullable(),
	will_renew: z.boolean().nullable(),
	renews_at: isoDateTimeNullable,
	expires_at: isoDateTimeNullable,
	cancels_at: isoDateTimeNullable,
	// Always null here; kept strict and identical to chatgpt's account_plan.
	scheduled_plan_change: z
		.object({
			plan_type: z.string().regex(PLAN_TYPE_RE).nullable(),
			changes_at: isoDateTimeNullable,
		})
		.strict()
		.nullable(),
});

export const usageLimitsSchema = z.object({
	id: idSchema,
	kind: pdppSafeText.max(80).nullable(),
	group: pdppSafeText.max(80).nullable(),
	scope_model: pdppSafeText.max(120).nullable(),
	scope_surface: pdppSafeText.max(120).nullable(),
	percent_used: z.number().min(0).nullable(),
	severity: pdppSafeText.max(40).nullable(),
	is_active: z.boolean().nullable(),
	resets_at: isoDateTimeNullable,
});

/** Stream → schema registry. Single source of truth for emitted streams. */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	conversations: conversationsSchema,
	messages: messagesSchema,
	account_plan: accountPlanSchema,
	usage_limits: usageLimitsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

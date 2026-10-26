// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Venmo stream records. Used for shape-check-before-emit
 * per docs/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events.
 *
 * Field shapes are sourced from the unofficial API client
 * github.com/mmohades/Venmo (`venmo_api/models/*.py`, MIT, fetched
 * 2026-08-09) — the ground truth for what `api.venmo.com/v1` actually
 * returns, since Venmo publishes no schema of its own. Amounts are USD in
 * integer cents (Venmo's own API returns a float major-unit `amount`; this
 * connector converts once at parse time, never carries a float through).
 */

import { nullablePdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
// Venmo user/story ids are decimal numeric strings of varying length
// (observed 18-19 digits for user ids; story ids similar). Payment ids may
// also be alphanumeric. Treat numeric ids as opaque strings without a fixed
// width since no documented source pins the exact width and a too-tight regex
// would reject legitimate ids the first time Venmo's id space grows.
const NUMERIC_ID_RE = /^\d+$/;
// Live payment stories also use opaque alphanumeric payment ids; story/user ids remain numeric.
const PAYMENT_ID_RE = /^[A-Za-z0-9]+$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Core source fields are required, even when nullable. Optional observations
// may be absent, but explicit null is preserved rather than synthesized.
export const profileSchema = z.object({
	id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric string"),
	username: z.string().nullable(),
	first_name: nullablePdppSafeText.optional(),
	last_name: nullablePdppSafeText.optional(),
	display_name: nullablePdppSafeText,
	phone: z.string().nullable().optional(),
	profile_picture_url: z.string().url().nullable().optional(),
	about: nullablePdppSafeText.optional(),
	date_joined: z
		.string()
		.regex(ISO_DATETIME_RE, "date_joined must be ISO-8601 datetime")
		.nullable()
		.optional(),
	is_business: z.boolean().nullable().optional(),
});

export const friendsSchema = z.object({
	id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric string"),
	username: z.string().nullable(),
	first_name: nullablePdppSafeText.optional(),
	last_name: nullablePdppSafeText.optional(),
	display_name: nullablePdppSafeText,
	phone: z.string().nullable().optional(),
	profile_picture_url: z.string().url().nullable().optional(),
	about: nullablePdppSafeText.optional(),
	date_joined: z
		.string()
		.regex(ISO_DATETIME_RE, "date_joined must be ISO-8601 datetime")
		.nullable()
		.optional(),
	is_group: z.boolean().nullable().optional(),
	is_active: z.boolean().nullable().optional(),
});

const transactionCounterpartySchema = z
	.object({
		id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric string"),
		username: z.string().nullable().optional(),
		display_name: nullablePdppSafeText.optional(),
	})
	.nullable();

export const transactionsSchema = z.object({
	id: z.string().regex(NUMERIC_ID_RE, "id must be a numeric story id"),
	payment_id: z
		.string()
		.regex(PAYMENT_ID_RE, "payment_id must be alphanumeric")
		.nullable(),
	date_created: z
		.string()
		.regex(ISO_DATETIME_RE, "date_created must be ISO-8601 datetime"),
	date_updated: z
		.string()
		.regex(ISO_DATETIME_RE, "date_updated must be ISO-8601 datetime")
		.nullable()
		.optional(),
	date_completed: z
		.string()
		.regex(ISO_DATETIME_RE, "date_completed must be ISO-8601 datetime")
		.nullable()
		.optional(),
	// Venmo's own vocabulary: "pay" (sent) or "charge" (requested). Open
	// vocabulary — see makeValidateRecord's enum-drift retention policy.
	payment_type: z.enum(["pay", "charge"]),
	amount_cents: z.number().int().nullable(),
	audience: z.enum(["private", "friends", "public"]).nullable().optional(),
	status: z
		.enum(["settled", "cancelled", "pending", "failed", "expired"])
		.nullable(),
	note: nullablePdppSafeText.optional(),
	device_used: z.string().nullable().optional(),
	actor: transactionCounterpartySchema,
	target: transactionCounterpartySchema,
	// true when the authenticated owner is the actor (sender/requester) rather
	// than the target — lets an owner-view UI show "you paid X" vs "X paid you"
	// without re-deriving it from actor.id === profile.id at query time.
	is_owner_actor: z.boolean().nullable(),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	profile: profileSchema,
	friends: friendsSchema,
	transactions: transactionsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

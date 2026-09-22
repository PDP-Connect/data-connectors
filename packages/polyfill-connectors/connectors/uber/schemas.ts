// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Uber stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Two streams per D5 (docs/migration/connector-cutover/CONTRACTS.md):
 *   - `trips`: list-level fields from the riders.uber.com Activities GraphQL
 *     response. No detail-only field lives here.
 *   - `receipts`: 1:1 per-trip detail (`primary_key: ["trip_id"]`),
 *     including `fare_breakdown`. Declared with `parent_streams: ["trips"]`
 *     in the manifest so a trips-only START performs no detail fetches.
 *
 * LIVE EVIDENCE (2026-09-22, real account capture — see the connector
 * cutover report's "Live evidence" section): the Activities list feed
 * carries NO structured status/date/currency/vehicle-type/address field —
 * only `title` (destination name), a no-year display `subtitle`, and a
 * currency-prefixed `description` fare string. Every field
 * capability-map.json's `uber.trips` field_map mapped onto `trips` is, in
 * reality, detail-only (`GetTrip`/`GetReceipt`). `trips` therefore always
 * emits those fields `null` — see parsers.ts's module doc and the report's
 * CONTRACT-CHANGE-REQUEST.
 *
 * `currency` is intentionally NOT modeled as a field: every observed
 * amount is a currency-SYMBOL-prefixed display string ("$43.07", "CHF21.31",
 * "€40.95") with no separate ISO 4217 code anywhere in either response.
 * Symbols are ambiguous ("$" alone cannot distinguish USD/CAD/AUD/etc.) —
 * guessing a code from a symbol would violate the "never guess" invariant
 * more than omitting the field. `fare_total` (the display string) is the
 * source of truth for currency; a future revision can add a symbol→code
 * table if the ambiguous cases are resolved by a documented policy.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const isoDateTimeNullable = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();
const centsSchema = z.number().int().nullable();

/**
 * trips stream (manifest required: id). One record per Uber trip. The list
 * feed carries only `id` — every other field is declared (manifest-declared,
 * connector-null per the authoring guide §8) but always null; see module doc.
 */
export const tripsSchema = z.object({
	id: z.string().min(1).max(200),
	status: z.string().min(1).max(64).nullable(),
	requested_at: isoDateTimeNullable,
	completed_at: isoDateTimeNullable,
	pickup_address: pdppSafeText.max(1000).nullable(),
	dropoff_address: pdppSafeText.max(1000).nullable(),
	fare_total: pdppSafeText.max(64).nullable(),
	fare_total_cents: centsSchema,
	product_type: z.string().min(1).max(128).nullable(),
	is_surge: z.boolean().nullable(),
});

const fareBreakdownLineSchema = z.object({
	label: pdppSafeText.max(200),
	amount_cents: z.number().int().nullable(),
});

/**
 * receipts stream (manifest required: trip_id; manifest `primary_key:
 * ["trip_id"]`). 1:1 per trip. `id` mirrors `trip_id` — the runtime's emit
 * gate requires a literal `id` field regardless of the manifest's declared
 * `primary_key` (see parsers.ts's `receiptRecord` doc for the production
 * bug this fixed). `trip_id` is the foreign key to `trips.id`.
 * `fare_breakdown` is a nested array with no independent identity per D3 —
 * stays an array field, not a child stream. Sourced from `GetTrip`
 * (trip/status/dates/waypoints/driver/surge) and `GetReceipt`
 * (fare_breakdown, parsed via structural `data-testid` selectors — see
 * parsers.ts's `parseFareBreakdown`).
 */
export const receiptsSchema = z.object({
	id: z.string().min(1).max(200),
	trip_id: z.string().min(1).max(200),
	status: z.string().min(1).max(64).nullable(),
	requested_at: isoDateTimeNullable,
	completed_at: isoDateTimeNullable,
	pickup_address: pdppSafeText.max(1000).nullable(),
	dropoff_address: pdppSafeText.max(1000).nullable(),
	driver_name: pdppSafeText.max(300).nullable(),
	fare_total: pdppSafeText.max(64).nullable(),
	fare_total_cents: centsSchema,
	distance_meters: z.number().min(0).nullable(),
	duration_seconds: z.number().int().min(0).nullable(),
	product_type: z.string().min(1).max(128).nullable(),
	is_surge: z.boolean().nullable(),
	fare_breakdown: z.array(fareBreakdownLineSchema),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	trips: tripsSchema,
	receipts: receiptsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

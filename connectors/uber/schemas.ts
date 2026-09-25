// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Uber stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Two streams per D5 as revised by capability-map.json's
 * `lead_decision_live` (docs/migration/connector-cutover/CONTRACTS.md):
 *   - `trips`: one record per trip, hydrated from `GetTrip` (status,
 *     requested/completed times, addresses, driver, distance, duration,
 *     product_type, fare_total). The Activities list feed carries only a
 *     trip UUID — see parsers.ts's module doc.
 *   - `receipts`: 1:1 per-trip detail from `GetReceipt`
 *     (`primary_key: ["trip_id"]`): `fare_breakdown`, `currency`, and the
 *     receipt's headline total. Declared `state_stream: "trips"` in the
 *     manifest — it rides trips' checkpoint rather than proving its own,
 *     because it has no independent hydration lane (both streams are
 *     fetched together in the same per-trip loop; see index.ts).
 *
 * `currency` on `receipts` is derived from the fare_total line's leading
 * currency symbol via a closed, small symbol table (parsers.ts's
 * `parseCurrencyCode`) — null when the symbol is missing or ambiguous,
 * never guessed. `trips.fare_total` keeps the raw display string as
 * currency is not resolved at list-detail-hydration time on `trips`
 * (see the report's CONTRACT-CHANGE-REQUEST for `trips`'s own currency
 * field).
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const ISO_4217_RE = /^[A-Z]{3}$/;

const isoDateTimeNullable = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();
const centsSchema = z.number().int().nullable();

/**
 * trips stream (manifest required: id). One record per Uber trip, hydrated
 * from GetTrip. A field is null only when GetTrip itself did not carry it
 * (see parsers.ts's `tripRecord`) — never a stand-in for "not fetched".
 */
export const tripsSchema = z.object({
	id: z.string().min(1).max(200),
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
	distance_display: pdppSafeText.max(128).nullable().optional(),
	duration_display: pdppSafeText.max(128).nullable().optional(),
	product_type: z.string().min(1).max(128).nullable(),
	is_surge: z.boolean().nullable(),
});

const fareBreakdownLineSchema = z.object({
	label: pdppSafeText.max(200),
	amount_cents: z.number().int().nullable(),
});

/**
 * receipts stream (manifest required: trip_id; manifest `primary_key:
 * ["trip_id"]`). 1:1 per trip, hydrated from GetReceipt only. `id` mirrors
 * `trip_id` — the runtime's emit gate requires a literal `id` field
 * regardless of the manifest's declared `primary_key` (see parsers.ts's
 * `receiptRecord` doc for the production bug this fixed). `trip_id` is the
 * foreign key to `trips.id`. `fare_breakdown` is a nested array with no
 * independent identity per D3 — stays an array field, not a child stream.
 */
export const receiptsSchema = z.object({
	id: z.string().min(1).max(200),
	trip_id: z.string().min(1).max(200),
	currency: z
		.string()
		.regex(ISO_4217_RE, "must be an ISO 4217 code")
		.nullable(),
	fare_total: pdppSafeText.max(64).nullable(),
	fare_total_cents: centsSchema,
	fare_breakdown: z.array(fareBreakdownLineSchema),
});

export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	trips: tripsSchema,
	receipts: receiptsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

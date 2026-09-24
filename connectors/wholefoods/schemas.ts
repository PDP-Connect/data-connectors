// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Whole Foods stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Whole Foods orders are fulfilled through Amazon; this connector reuses the
 * Amazon session (see `../../packages/polyfill-connectors/src/auto-login/amazon.ts`) and scrapes Amazon's
 * order-search/order-detail pages filtered to Whole Foods Market, plus
 * wholefoodsmarket.com product pages and the USDA FoodData Central API for
 * nutrition. Four streams, per D8 (docs/migration/connector-cutover/CONTRACTS.md):
 *   - `profile`       — the Amazon account's name/email (the scope is advertised).
 *   - `orders`        — one record per Whole Foods order.
 *   - `order_items`   — one record per line item within an order.
 *   - `nutrition`     — one outcome per unique product, including observed
 *                       not_found/error/blocked results.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * profile stream (manifest required: id). One record per run — the Amazon
 * account whose order history was scraped. `id` is Amazon's own stable
 * opaque customer id (see parsers.ts's parseAmazonProfileDom), not email:
 * live evidence (2026-09-22) showed the capability map's assumed `email`
 * field is not safely obtainable without crossing a re-authentication gate
 * — see the connector's report CONTRACT-CHANGE-REQUEST. `email` is kept in
 * the schema (always null in practice today) so the field stays available
 * if a future safe extraction path is found, rather than silently dropping
 * the D8-declared field.
 */
export const profileSchema = z.object({
	email: z.string().email().nullable(),
	id: z.string().min(1).max(64),
	name: pdppSafeText.max(200).nullable(),
});

/**
 * orders stream (manifest required: id). One record per Whole Foods order.
 * `total_cents` / `item_count` are non-negative ints; `order_date` is a
 * date-only ISO-8601 string (source precision — Amazon's order pages never
 * expose a time-of-day, so a datetime would fabricate precision, violating
 * D4).
 */
export const ordersSchema = z.object({
	id: z.string().min(1).max(200),
	item_count: z.number().int().min(0).nullable(),
	order_date: z
		.string()
		.regex(ISO_DATE_RE, "order_date must be YYYY-MM-DD")
		.nullable(),
	order_url: z.url().nullable(),
	status: z.string().min(1).max(64).nullable(),
	total_cents: z.number().int().min(0).nullable(),
});

/**
 * order_items stream (manifest required: id, order_id, name). One record per
 * line item. `quantity` is float-capable (grocery items sell by weight).
 * No `nutrition` field here — nutrition is its own typed stream (D8).
 */
export const orderItemsSchema = z.object({
	id: z.string().min(1).max(200),
	image_url: z.string().max(2000).nullable(),
	name: pdppSafeText.max(1000),
	order_id: z.string().min(1).max(200),
	product_id: z
		.string()
		.regex(/^[A-Z0-9]{10}$/, "product_id must be a 10-char Amazon ASIN"),
	product_url: z.url().nullable(),
	quantity: z.number().min(0).nullable(),
	unit_price_cents: z.number().int().min(0).nullable(),
});

/**
 * nutrition stream (manifest required: id/product_id). One record per
 * unique product encountered in this run's order_items, keyed by
 * `product_id` (the Amazon ASIN — the same id order_items uses, so
 * consumers can join the two streams). `source` names which surface
 * produced facts or which observed failure occurred. `confidence` reflects
 * match certainty for facts and is low for unsuccessful outcomes.
 */
export const nutritionSchema = z.object({
	calories: z.number().min(0).nullable(),
	carbs_g: z.number().min(0).nullable(),
	confidence: z.enum(["high", "medium", "low"]),
	fat_g: z.number().min(0).nullable(),
	fiber_g: z.number().min(0).nullable(),
	name: pdppSafeText.max(1000).nullable(),
	product_id: z
		.string()
		.regex(/^[A-Z0-9]{10}$/, "product_id must be a 10-char Amazon ASIN"),
	protein_g: z.number().min(0).nullable(),
	serving_size: z.string().max(200).nullable(),
	servings_per_container: z.number().min(0).nullable(),
	sodium_mg: z.number().min(0).nullable(),
	source: z.enum([
		"wholefoods_product_page",
		"usda_fdc",
		"not_found",
		"error",
		"blocked",
	]),
	sugar_g: z.number().min(0).nullable(),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares and emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	nutrition: nutritionSchema,
	order_items: orderItemsSchema,
	orders: ordersSchema,
	profile: profileSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

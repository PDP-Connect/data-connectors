// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Whole Foods stream records. Shape-check-before-emit per
 * docs/connector-authoring-guide.md §3.
 *
 * Whole Foods orders are fulfilled through Amazon; this connector reuses the
 * Amazon session (see `../../packages/polyfill-connectors/src/auto-login/amazon.ts`) and scrapes Amazon's
 * order-search/order-detail pages filtered to Whole Foods Market, plus
 * wholefoodsmarket.com product pages for nutrition. Four streams, per D8 (docs/migration/connector-cutover/CONTRACTS.md):
 *   - `profile`       — the Amazon account's name/email (the scope is advertised).
 *   - `orders`        — one record per Whole Foods order.
 *   - `order_items`   — one record per line item within an order.
 *   - `nutrition`     — one record per unique product whose nutrition was read
 *                       in full. A failed or incomplete lookup emits no row.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * profile stream (manifest required: id). One record per run — the Amazon
 * account whose order history was scraped. `id` is Amazon's own stable
 * opaque customer id when available, otherwise the legacy singleton id
 * `me` when the authenticated greeting is the only positive identity
 * evidence (see parsers.ts's parseAmazonProfileDom), not email:
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
 * `total_cents` and `item_count` remain null without complete, source-bound
 * item inventory evidence. Parsed row counts and partial price sums are not
 * order aggregates.
 * `order_date` is a
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
	quantity_unit: z.string().nullable().optional(),
	price_unit: z.string().nullable().optional(),
	line_total_cents: z.number().int().min(0).nullable().optional(),
});

/**
 * nutrition stream (manifest required: id/product_id). One record per ordered
 * product whose Nutrition Facts panel was read in full, keyed by `product_id`
 * (the Amazon ASIN, the same id order_items uses, so consumers can join the
 * two streams). `source` names the page the panel was read from: the Amazon
 * product page, or a Whole Foods product page (rendered panel, or structured
 * data). `confidence` reflects how firmly the page was bound to the product.
 *
 * The connector collects only what the owner's own sources show. A product
 * whose panel could not be read, or that has none, gets no record: the run log
 * counts it, and a run that could not read some panels reports the stream as
 * not covering them. Connector 0.3.34 also wrote records whose `source` was
 * `not_found`, `error` or `blocked`, or `usda_fdc`; this connector writes none
 * of those. They stay in the published stream schema because stored records
 * may still carry them.
 */
export const nutritionSchema = z
	.object({
		added_sugar_g: z.number().min(0).nullable(),
		allergens: z.string().nullable(),
		calcium_mg: z.number().min(0).nullable(),
		id: z.string().regex(/^[A-Z0-9]{10}$/),
		calories: z.number().min(0).nullable(),
		carbs_g: z.number().min(0).nullable(),
		category: z.array(z.string()),
		cholesterol_mg: z.number().min(0).nullable(),
		confidence: z.enum(["high", "medium", "low"]),
		fat_g: z.number().min(0).nullable(),
		fiber_g: z.number().min(0).nullable(),
		highlights: z.array(z.string()),
		ingredients: z.string().nullable(),
		iron_mg: z.number().min(0).nullable(),
		name: pdppSafeText.max(1000).nullable(),
		product_id: z
			.string()
			.regex(/^[A-Z0-9]{10}$/, "product_id must be a 10-char Amazon ASIN"),
		potassium_mg: z.number().min(0).nullable(),
		protein_g: z.number().min(0).nullable(),
		raw_nutrition_text: z.string().max(1000).nullable(),
		saturated_fat_g: z.number().min(0).nullable(),
		serving_size: z.string().max(200).nullable(),
		servings_per_container: z.number().min(0).nullable(),
		sodium_mg: z.number().min(0).nullable(),
		source: z.enum([
			"amazon_product_page",
			"wholefoods_product_page",
			"wholefoods_structured_data",
		]),
		sugar_g: z.number().min(0).nullable(),
		trans_fat_g: z.number().min(0).nullable(),
		type: z.literal("https://schema.org/NutritionInformation"),
		upc: z.string().nullable(),
		vitamin_d_mcg: z.number().min(0).nullable(),
	})
	.refine((record) => record.id === record.product_id, {
		message: "nutrition id must equal its source product_id",
		path: ["id"],
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

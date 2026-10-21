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
 * nutrition stream (manifest required: id/product_id). Exactly one record per
 * ordered product per run, keyed by `product_id` (the Amazon ASIN, the same
 * id order_items uses, so consumers can join the two streams).
 *
 * `status` says what the lookup concluded:
 *   - `matched`: the facts are this product's; `source` names the surface
 *     that produced them and `cause` is null.
 *   - `not_found`, `error`, `blocked`: the lookup produced no facts. Every
 *     fact field is null (lists empty), `source` repeats the status (the
 *     value connector 0.3.34 published) and `cause` is a stable reason code:
 *       blocked   robot_check          a page was a captcha / robot check
 *       error     http_error           a page answered HTTP 4xx/5xx (not 404/410)
 *       error     navigation_failed    a page read threw
 *       error     unrecognized_page    a 200 page that is not a known product/search page
 *       error     identity_conflict    a page that cannot be this product: another ASIN,
 *                                      order or origin, an ambiguous main product, or
 *                                      a product page whose structured data and
 *                                      heading name different products
 *       error     identity_unbound     a page with no identity evidence to bind it
 *       error     panel_partial        this product's panel was seen but not fully read
 *       error     usda_request_failed  the USDA lookup failed
 *       not_found no_match             every source answered; none had a usable panel
 *
 * `status` and `cause` are optional here so rows stored before they existed
 * (no status, `source` = not_found/error/blocked for a failure) still
 * validate; for such a row the status is read from `source`.
 *
 * The connector keeps no per-key state, and a non-matched row has the same
 * key as a matched one. A store that upserts by key lets a later non-matched
 * row replace an earlier matched row's facts. Consumers MUST NOT apply the
 * fact fields of a row whose status is not `matched`. This is not new: the
 * published 0.3.34 already emits same-key failure rows (`source` =
 * not_found/error/blocked). Splitting outcomes into their own stream is a
 * separate, pending decision.
 */
const FAILURE_STATUSES = ["not_found", "error", "blocked"] as const;
const CAUSES_BY_STATUS = {
	blocked: ["robot_check"],
	error: [
		"http_error",
		"navigation_failed",
		"unrecognized_page",
		"identity_conflict",
		"identity_unbound",
		"panel_partial",
		"usda_request_failed",
	],
	not_found: ["no_match"],
} as const;
const NUTRITION_CAUSES = [
	"robot_check",
	"http_error",
	"navigation_failed",
	"unrecognized_page",
	"identity_conflict",
	"identity_unbound",
	"panel_partial",
	"usda_request_failed",
	"no_match",
] as const;
/** Every field that states something about the matched product. */
const NUTRITION_FACT_FIELDS = [
	"added_sugar_g",
	"allergens",
	"calcium_mg",
	"calories",
	"carbs_g",
	"cholesterol_mg",
	"fat_g",
	"fiber_g",
	"ingredients",
	"iron_mg",
	"potassium_mg",
	"protein_g",
	"raw_nutrition_text",
	"saturated_fat_g",
	"serving_size",
	"servings_per_container",
	"sodium_mg",
	"sugar_g",
	"trans_fat_g",
	"upc",
	"usda_brand",
	"usda_description",
	"usda_fdc_id",
	"usda_match_method",
	"vitamin_d_mcg",
] as const;

export const nutritionSchema = z
	.object({
		added_sugar_g: z.number().min(0).nullable(),
		allergens: z.string().nullable(),
		calcium_mg: z.number().min(0).nullable(),
		id: z.string().regex(/^[A-Z0-9]{10}$/),
		calories: z.number().min(0).nullable(),
		carbs_g: z.number().min(0).nullable(),
		category: z.array(z.string()),
		cause: z.enum(NUTRITION_CAUSES).nullable().optional(),
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
			"usda_fdc",
			"not_found",
			"error",
			"blocked",
		]),
		status: z.enum(["matched", "not_found", "error", "blocked"]).optional(),
		sugar_g: z.number().min(0).nullable(),
		trans_fat_g: z.number().min(0).nullable(),
		type: z.literal("https://schema.org/NutritionInformation"),
		upc: z.string().nullable(),
		usda_brand: z.string().nullable(),
		usda_description: z.string().nullable(),
		usda_fdc_id: z.number().int().nullable(),
		usda_match_method: z.enum(["text", "upc"]).nullable(),
		vitamin_d_mcg: z.number().min(0).nullable(),
	})
	.superRefine((record, ctx) => {
		const issue = (message: string, path: string) =>
			ctx.addIssue({ code: "custom", message, path: [path] });
		if (record.id !== record.product_id) {
			issue("nutrition id must equal its source product_id", "id");
		}
		const sourceStatus = FAILURE_STATUSES.find((s) => s === record.source);
		const status = record.status ?? sourceStatus ?? "matched";
		if (status === "matched") {
			if (sourceStatus) issue("a matched row cannot have a failure source", "source");
			if (record.cause != null) issue("a matched row has no cause", "cause");
			return;
		}
		if (record.source !== status) {
			issue("a non-matched row's source repeats its status", "source");
		}
		if (record.status !== undefined) {
			const allowed: readonly string[] = CAUSES_BY_STATUS[status];
			if (record.cause == null || !allowed.includes(record.cause)) {
				issue(`a ${status} row needs one of: ${allowed.join(", ")}`, "cause");
			}
		}
		// A non-matched row carries no facts, and no other product's identity.
		for (const field of NUTRITION_FACT_FIELDS) {
			if (record[field] !== null) issue("a non-matched row carries no facts", field);
		}
		if (record.category.length > 0) issue("a non-matched row carries no facts", "category");
		if (record.highlights.length > 0) issue("a non-matched row carries no facts", "highlights");
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

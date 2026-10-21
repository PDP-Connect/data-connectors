// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Whole Foods connector. Ground truth is `index.ts`'s
 * record builders (`buildOrderRecord`, `buildOrderItemRecord`,
 * `buildNutritionRecord`, and the `profile` record literal in
 * `collectProfile`) — these tests assert the schema against literal records
 * shaped exactly as those builders produce them.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	nutritionSchema,
	orderItemsSchema,
	ordersSchema,
	profileSchema,
	validateRecord,
} from "./schemas.ts";

const ORDER_ID = "112-1234567-8901234";
const PRODUCT_ID = "B01ABCDEFG";

const PROFILE_RECORD = {
	email: null,
	id: "A39M9I106DZZ8N",
	name: "Jane Owner",
};

test("profile schema accepts a fully-populated record", () => {
	const result = profileSchema.safeParse(PROFILE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema accepts a null name", () => {
	const result = profileSchema.safeParse({ ...PROFILE_RECORD, name: null });
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema accepts a populated email if a future extraction path finds one", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		email: "owner@example.com",
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a malformed email", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		email: "not-an-email",
	});
	assert.equal(result.success, false);
});

const ORDER_RECORD = {
	id: ORDER_ID,
	item_count: 3,
	order_date: "2026-03-03",
	order_url: `https://www.amazon.com/uff/your-account/order-details?orderID=${ORDER_ID}`,
	status: null,
	total_cents: 4299,
};

test("orders schema accepts a fully-populated record", () => {
	const result = ordersSchema.safeParse(ORDER_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts null order_date/total_cents (unparseable source)", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		order_date: null,
		total_cents: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts unknown item_count while source completeness is unproven", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		item_count: null,
	});
	assert.equal(result.success, true);
});

test("orders schema rejects an order_date with a fabricated time component", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		order_date: "2026-03-03T00:00:00.000Z",
	});
	assert.equal(result.success, false);
});

const ORDER_ITEM_RECORD = {
	id: `${ORDER_ID}#${PRODUCT_ID}`,
	image_url: "https://m.media-amazon.com/images/I/example.jpg",
	name: "Organic Bananas, 1 bunch",
	order_id: ORDER_ID,
	product_id: PRODUCT_ID,
	product_url: `https://www.amazon.com/dp/${PRODUCT_ID}`,
	quantity: 1.5,
	unit_price_cents: 199,
};

test("order_items schema accepts a fully-populated record", () => {
	const result = orderItemsSchema.safeParse(ORDER_ITEM_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema rejects a null product_id (legacy orders require source identity)", () => {
	const result = orderItemsSchema.safeParse({
		...ORDER_ITEM_RECORD,
		product_id: null,
	});
	assert.equal(result.success, false);
});

test("order_items schema strips an unknown nutrition field rather than emitting it (D8: nutrition is its own stream)", () => {
	const result = orderItemsSchema.safeParse({
		...ORDER_ITEM_RECORD,
		nutrition: { calories: 100 },
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal((result.data as { nutrition?: unknown }).nutrition, undefined);
});

const NUTRITION_RECORD = {
	added_sugar_g: null,
	allergens: null,
	calcium_mg: null,
	id: PRODUCT_ID,
	calories: 105,
	carbs_g: 27,
	category: [],
	cholesterol_mg: null,
	confidence: "high" as const,
	fat_g: 0.4,
	fiber_g: 3.1,
	highlights: [],
	ingredients: null,
	iron_mg: null,
	name: "Organic Bananas",
	product_id: PRODUCT_ID,
	potassium_mg: null,
	protein_g: 1.3,
	raw_nutrition_text: null,
	saturated_fat_g: null,
	serving_size: "1 medium (118g)",
	servings_per_container: 1,
	sodium_mg: 1,
	source: "wholefoods_product_page" as const,
	sugar_g: 14,
	trans_fat_g: null,
	type: "https://schema.org/NutritionInformation",
	upc: null,
	usda_brand: null,
	usda_description: null,
	usda_fdc_id: null,
	usda_match_method: null,
	vitamin_d_mcg: null,
};

/** A row with no fact at all: what a non-matched lookup emits. */
const NO_FACTS = {
	...NUTRITION_RECORD,
	calories: null,
	carbs_g: null,
	confidence: "low" as const,
	fat_g: null,
	fiber_g: null,
	protein_g: null,
	serving_size: null,
	servings_per_container: null,
	sodium_mg: null,
	sugar_g: null,
};

test("nutrition schema accepts a fully-populated wholefoods_product_page record", () => {
	const result = nutritionSchema.safeParse(NUTRITION_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("nutrition schema accepts a usda_fdc record with medium confidence", () => {
	const result = nutritionSchema.safeParse({
		...NUTRITION_RECORD,
		confidence: "medium",
		source: "usda_fdc",
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

for (const source of ["not_found", "error", "blocked"] as const) {
	test(`nutrition schema accepts a source-backed ${source} outcome`, () => {
		const result = nutritionSchema.safeParse({
			...NO_FACTS,
			source,
		});
		assert.ok(result.success, JSON.stringify(result.error?.issues));
	});

	test(`nutrition schema rejects a ${source} row that carries a fact`, () => {
		const result = nutritionSchema.safeParse({
			...NUTRITION_RECORD,
			confidence: "low",
			source,
		});
		assert.equal(result.success, false);
	});
}

test("nutrition schema rejects an unknown source", () => {
	const result = nutritionSchema.safeParse({
		...NUTRITION_RECORD,
		source: "made_up_source",
	});
	assert.equal(result.success, false);
});

test("nutrition schema rejects a negative macro value", () => {
	const result = nutritionSchema.safeParse({ ...NUTRITION_RECORD, fat_g: -1 });
	assert.equal(result.success, false);
});

test("validateRecord routes an invalid orders record to a SKIP_RESULT-shaped failure", () => {
	const result = validateRecord("orders", { id: "" });
	assert.equal(result.ok, false);
});

test("validateRecord routes a valid nutrition record through as ok", () => {
	const result = validateRecord("nutrition", NUTRITION_RECORD);
	assert.equal(result.ok, true);
});

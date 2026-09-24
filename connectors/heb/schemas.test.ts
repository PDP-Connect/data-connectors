// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the H-E-B connector.
 *
 * Records here are shape-derived from parsers.ts output, LIVE-VERIFIED
 * (2026-07-14) against a real captured heb.com session — see
 * heb-live-verify-report.md.
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

// SYNTHETIC: hand-authored, shape-real record. No real H-E-B profile/nutrition
// page has driven this connector yet (live proof pending — see report). Field
// shapes are derived from the legacy connectors/heb/schemas/heb.profile.json
// and heb.nutrition.json contracts, not a live capture.
const PROFILE_RECORD = {
	delivery_addresses: [
		{
			address: "123 Fictional Ave, Austin, TX 78701",
			is_primary: true,
			label: "Home",
		},
	],
	email: "shopper@example.com",
	fetched_at: "2026-07-14T12:00:00.000Z",
	id: "profile",
	name: "Jamie Shopper",
	phone: "(512) 555-0100",
};

// SYNTHETIC: see PROFILE_RECORD note above.
const NUTRITION_RECORD = {
	added_sugar_g: 0,
	allergens: "Milk",
	calcium_mg: 300,
	calories: 150,
	carbs_g: 12,
	category: "Dairy & Eggs / Milk",
	cholesterol_mg: 20,
	confidence: "high",
	fat_g: 8,
	fetched_at: "2026-07-14T12:00:00.000Z",
	fiber_g: 0,
	highlights: ["Organic"],
	id: "123456789",
	images: {
		full: "https://images.heb.com/is/image/HEBGrocery/123456789-1",
		thumbnail:
			"https://images.heb.com/is/image/HEBGrocery/prd-small/123456789.jpg",
	},
	ingredients: "Grade A organic reduced fat milk, vitamin D3",
	iron_mg: 0,
	name: "H-E-B Organic 2% Reduced Fat Milk",
	potassium_mg: 380,
	product_id: "123456789",
	product_url:
		"https://www.heb.com/product-detail/heb-organic-2-reduced-fat-milk/123456789",
	protein_g: 8,
	saturated_fat_g: 5,
	serving_size: "1 cup (240mL)",
	servings_per_container: "8",
	sodium_mg: 120,
	source: "heb_product_page",
	sugar_g: 12,
	trans_fat_g: 0,
	upc: "072940001234",
	vitamin_d_mcg: 3,
};

const ORDER_RECORD = {
	id: "HEB1029384756",
	order_date: "2026-07-14",
	fulfillment_method: "curbside",
	fulfillment_location: "H-E-B plus! Austin Mueller",
	status: "Delivered",
	status_code: "PAYMENT_RECEIPTED",
	store_name: "H-E-B plus! Austin Mueller",
	timeslot_start: "2026-07-14T16:00:00Z",
	timeslot_end: "2026-07-14T17:00:00Z",
	total: "$87.45",
	total_cents: 8745,
	item_count: 12,
	unfulfilled_count: 0,
	fetched_at: "2026-07-14T12:00:00.000Z",
};

const ORDER_ITEM_RECORD = {
	id: "HEB1029384756|123456789",
	order_id: "HEB1029384756",
	name: "H-E-B Organic 2% Reduced Fat Milk",
	department: "Dairy & eggs",
	product_id: "123456789",
	product_url:
		"https://www.heb.com/product-detail/heb-organic-2-reduced-fat-milk/123456789",
	image_url:
		"https://images.heb.com/is/image/HEBGrocery/prd-small/123456789.jpg",
	quantity: 2,
	line_total: "$4.29",
	line_total_cents: 429,
	order_date: "2026-07-14",
	fetched_at: "2026-07-14T12:00:00.000Z",
};

test("orders schema accepts a parser-shaped record", () => {
	const result = ordersSchema.safeParse(ORDER_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts an in-flight order (nulls for not-yet-known fields)", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		fulfillment_location: null,
		status: null,
		status_code: null,
		store_name: null,
		timeslot_start: null,
		timeslot_end: null,
		total: null,
		total_cents: null,
		item_count: null,
		unfulfilled_count: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts a DOM-sourced record (structured-only fields null)", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		status_code: null,
		store_name: null,
		timeslot_start: null,
		timeslot_end: null,
		unfulfilled_count: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a non-ISO timeslot_start (raw structured text leaked in)", () => {
	assert.equal(
		ordersSchema.safeParse({
			...ORDER_RECORD,
			timeslot_start: "not-a-timestamp",
		}).success,
		false,
	);
});

test("orders schema rejects a non-ISO timeslot_end", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, timeslot_end: "not-a-timestamp" })
			.success,
		false,
	);
});

test("orders schema rejects a negative unfulfilled_count", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, unfulfilled_count: -1 }).success,
		false,
	);
});

test("orders schema accepts an open (non-enum) status_code string, honoring Stop Condition #5", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		status_code: "SOME_FUTURE_STATUS_NOT_YET_OBSERVED",
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts fulfillment_method unknown", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		fulfillment_method: "unknown",
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects an invalid fulfillment_method", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, fulfillment_method: "in_store" })
			.success,
		false,
	);
});

test("orders schema rejects an id without the HEB prefix", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, id: "1029384756" }).success,
		false,
	);
});

test("orders schema rejects a non-ISO-date order_date (raw DOM text leaked in)", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, order_date: "July 14, 2026" })
			.success,
		false,
	);
});

test("orders schema rejects a negative total_cents", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, total_cents: -1 }).success,
		false,
	);
});

test("orders schema rejects a fulfillment_location that leaked a Status:/price cruft pattern", () => {
	assert.equal(
		ordersSchema.safeParse({
			...ORDER_RECORD,
			fulfillment_location: "Status: Delivered",
		}).success,
		false,
	);
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, fulfillment_location: "$87.45" })
			.success,
		false,
	);
});

test("order_items schema accepts a parser-shaped record", () => {
	const result = orderItemsSchema.safeParse(ORDER_ITEM_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema accepts a weighted item with null quantity and null product_id", () => {
	const result = orderItemsSchema.safeParse({
		...ORDER_ITEM_RECORD,
		product_id: null,
		product_url: null,
		image_url: null,
		quantity: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema accepts a null department (row outside a recognized category section)", () => {
	const result = orderItemsSchema.safeParse({
		...ORDER_ITEM_RECORD,
		department: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("order_items schema rejects a missing order_id (manifest-required FK)", () => {
	const { order_id: _omit, ...withoutFk } = ORDER_ITEM_RECORD;
	assert.equal(orderItemsSchema.safeParse(withoutFk).success, false);
});

test("order_items schema rejects an order_id without the HEB prefix", () => {
	assert.equal(
		orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, order_id: "1029384756" })
			.success,
		false,
	);
});

test("order_items schema rejects a name that leaked UI cruft (wrong-node grab)", () => {
	assert.equal(
		orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, name: "Quantity: 2." })
			.success,
		false,
	);
});

test("order_items schema rejects a negative quantity", () => {
	assert.equal(
		orderItemsSchema.safeParse({ ...ORDER_ITEM_RECORD, quantity: -1 }).success,
		false,
	);
});

test("order_items schema rejects a non-ISO-date order_date", () => {
	assert.equal(
		orderItemsSchema.safeParse({
			...ORDER_ITEM_RECORD,
			order_date: "July 14, 2026",
		}).success,
		false,
	);
});

test("validateRecord routes both streams and passes unknown streams through", () => {
	assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
	assert.equal(validateRecord("order_items", ORDER_ITEM_RECORD).ok, true);
	assert.equal(validateRecord("receipts", { id: "x" }).ok, true);
});

test("validateRecord rejects a malformed orders record via shape check", () => {
	const result = validateRecord("orders", { ...ORDER_RECORD, id: "not-heb" });
	assert.equal(result.ok, false);
});

test("profile schema accepts a parser-shaped record", () => {
	const result = profileSchema.safeParse(PROFILE_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema accepts null name/email", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		email: null,
		name: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a malformed email", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, email: "not-an-email" })
			.success,
		false,
	);
});

test("profile schema rejects an id other than the fixed literal", () => {
	assert.equal(
		profileSchema.safeParse({ ...PROFILE_RECORD, id: "other" }).success,
		false,
	);
});

test("profile schema accepts null phone and an empty delivery_addresses array", () => {
	const result = profileSchema.safeParse({
		...PROFILE_RECORD,
		delivery_addresses: [],
		phone: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("profile schema rejects a delivery address missing required fields", () => {
	assert.equal(
		profileSchema.safeParse({
			...PROFILE_RECORD,
			delivery_addresses: [{ address: "123 Fictional Ave" }],
		}).success,
		false,
	);
});

test("nutrition schema accepts a parser-shaped record", () => {
	const result = nutritionSchema.safeParse(NUTRITION_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("nutrition schema accepts an all-null-macros not_found record", () => {
	const result = nutritionSchema.safeParse({
		...NUTRITION_RECORD,
		added_sugar_g: null,
		allergens: null,
		calcium_mg: null,
		calories: null,
		carbs_g: null,
		category: null,
		cholesterol_mg: null,
		confidence: "low",
		fat_g: null,
		fiber_g: null,
		highlights: null,
		images: null,
		ingredients: null,
		iron_mg: null,
		potassium_mg: null,
		protein_g: null,
		saturated_fat_g: null,
		serving_size: null,
		servings_per_container: null,
		sodium_mg: null,
		source: "not_found",
		sugar_g: null,
		trans_fat_g: null,
		upc: null,
		vitamin_d_mcg: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("nutrition schema rejects a non-heb-cdn images url", () => {
	assert.equal(
		nutritionSchema.safeParse({
			...NUTRITION_RECORD,
			images: {
				full: "https://evil.example.com/1",
				thumbnail: NUTRITION_RECORD.images.thumbnail,
			},
		}).success,
		false,
	);
});

test("nutrition schema rejects an unknown source", () => {
	assert.equal(
		nutritionSchema.safeParse({ ...NUTRITION_RECORD, source: "guessed" })
			.success,
		false,
	);
});

test("nutrition schema rejects a negative macro value", () => {
	assert.equal(
		nutritionSchema.safeParse({ ...NUTRITION_RECORD, calories: -1 }).success,
		false,
	);
});

test("validateRecord routes profile and nutrition streams", () => {
	assert.equal(validateRecord("profile", PROFILE_RECORD).ok, true);
	assert.equal(validateRecord("nutrition", NUTRITION_RECORD).ok, true);
});

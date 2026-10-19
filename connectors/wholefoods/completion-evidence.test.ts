// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { makeEmitRecord } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	buildNutritionRecord,
	buildOrderItemRecords,
	buildOrderRecord,
	collectOrders,
} from "./index.ts";
import {
	mapUsdaNutrients,
	parseAmazonProductNutritionDom,
	parseOrderDetailDom,
	parseWholeFoodsProductPageDom,
} from "./parsers.ts";
import { nutritionSchema, validateRecord } from "./schemas.ts";

test("nutrition outcomes survive production keying and schema validation", async () => {
	const wire: any[] = [];
	const runtime = makeEmitRecord({
		requested: new Map([["nutrition", {}]]) as never,
		emit: async (message) => {
			wire.push(message);
		},
		emittedAt: "2026-10-18T00:00:00Z",
		validateRecord,
		isTombstone: undefined,
		timeRangeFieldFor: () => null,
	});
	for (const outcome of ["not_found", "error", "blocked"] as const) {
		await runtime.emit(
			"nutrition",
			buildNutritionRecord("B012345678", "Source product", outcome),
		);
	}
	assert.equal(runtime.counters.totalEmitted, 3);
	assert.equal(runtime.counters.totalSkipped, 0);
	assert.ok(
		wire.every(
			(message) => message.type === "RECORD" && message.key === "B012345678",
		),
	);
});

test("unproven order totals and absent quantity stay unknown", () => {
	const detail = parseOrderDetailDom(
		'<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Source product</a> $2.50</div>',
	);
	assert.equal(detail.items[0]?.quantity, null);
	const order = buildOrderRecord(
		{
			orderId: "order",
			orderUrl: "https://www.amazon.com/order",
			orderDateRaw: null,
			expectedItemCount: 1,
		},
		null,
		detail.items,
	);
	assert.equal(order.item_count, 1);
	assert.equal(order.total_cents, null);
});

test("order-bound detail date survives a missing search-stub date", () => {
	const detail = parseOrderDetailDom(`<html><body>
		<div>Order placed March 3, 2026</div>
		<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Source product</a> Qty: 1 $2.50</div>
	</body></html>`);
	assert.equal(detail.items.length, 1);
	assert.equal(detail.orderDateRaw, "March 3, 2026");
	const order = buildOrderRecord(
		{
			orderId: "order",
			orderUrl: "https://www.amazon.com/order",
			orderDateRaw: null,
			expectedItemCount: 1,
		},
		detail.orderDateRaw,
		detail.items,
	);
	assert.equal(order.order_date, "2026-03-03");
	assert.equal(order.item_count, 1);
	assert.equal(order.total_cents, null);
});

test("unrelated body date is never used as the order date", () => {
	const detail = parseOrderDetailDom(`<html><body>
		<div>Return eligible until April 3, 2026</div>
		<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Source product</a> Qty: 1 $2.50</div>
	</body></html>`);
	assert.equal(detail.items.length, 1);
	assert.equal(detail.orderDateRaw, null);
	const order = buildOrderRecord(
		{
			orderId: "order",
			orderUrl: "https://www.amazon.com/order",
			orderDateRaw: null,
			expectedItemCount: 1,
		},
		detail.orderDateRaw,
		detail.items,
	);
	assert.equal(order.order_date, null);
});

test("USDA absent serving units never imply grams", () => {
	const facts = mapUsdaNutrients(
		{
			description: "food",
			fdcId: 1,
			brandName: null,
			brandOwner: null,
			gtinUpc: null,
			servingSize: 30,
			servingSizeUnit: null,
			foodNutrients: [{ nutrientId: 1008, value: 100 }],
		},
		"text",
	);
	assert.equal(facts.servingSize, null);
	assert.equal(facts.calories, 100);
});

test("nutrition parsing retains the legacy script's expanded nutrition payload", () => {
	const facts = parseWholeFoodsProductPageDom(`<html><head>
		<script type="application/ld+json">{"@type":"Product","gtin12":"012345678905","category":"Produce","ingredients":"Apples","nutrition":{"@type":"NutritionInformation","calories":"52","proteinContent":"0.3 g","carbohydrateContent":"14 g","fatContent":"0.2 g","saturatedFatContent":"0 g","transFatContent":"0 g","cholesterolContent":"0 mg","fiberContent":"2.4 g","sugarContent":"10 g","sodiumContent":"1 mg","potassiumContent":"107 mg","calciumContent":"6 mg","ironContent":"0.1 mg","vitaminDContent":"0 mcg"}}</script>
	</head><body></body></html>`);
	assert.ok(facts);
	const row = buildNutritionRecord("B012345678", "Apples", facts);
	assert.deepEqual(
		{
			calories: row.calories,
			protein_g: row.protein_g,
			carbs_g: row.carbs_g,
			fat_g: row.fat_g,
		saturated_fat_g: row.saturated_fat_g,
		trans_fat_g: row.trans_fat_g,
		cholesterol_mg: row.cholesterol_mg,
		added_sugar_g: row.added_sugar_g,
			potassium_mg: row.potassium_mg,
		calcium_mg: row.calcium_mg,
		iron_mg: row.iron_mg,
		vitamin_d_mcg: row.vitamin_d_mcg,
		ingredients: row.ingredients,
		allergens: row.allergens,
		category: row.category,
		upc: row.upc,
		"@type": row.type,
		},
		{
				calories: 52,
			protein_g: 0.3,
			carbs_g: 14,
			fat_g: 0.2,
			saturated_fat_g: 0,
			trans_fat_g: 0,
			cholesterol_mg: 0,
			added_sugar_g: null,
			potassium_mg: null,
			calcium_mg: null,
			iron_mg: null,
			vitamin_d_mcg: null,
			ingredients: null,
			allergens: null,
			category: [],
			upc: "012345678905",
			"@type": "https://schema.org/NutritionInformation",
		},
	);
	assert.equal(validateRecord("nutrition", row).ok, true);
});

test("Amazon product nutrition parser keeps Amazon-only facts and provenance", () => {
	const facts = parseAmazonProductNutritionDom(`<html><body>
		<div id="detailBullets_feature_div"><li>UPC: 012345678905</li></div>
		<div id="nic-nutrition-facts">Nutrition Facts Serving size 1 cup Calories 150 Total Fat 5g Saturated Fat 1g Trans Fat 0g Cholesterol 2mg Sodium 10mg Total Carbohydrate 20g Dietary Fiber 4g Sugars 8g Added Sugars 2g Protein 3g Potassium 100mg Calcium 20mg Iron 1mg Vitamin D 0mcg</div>
		<div id="ingredients_feature_div">Ingredients: oats and salt</div>
		<div>Contains: wheat</div>
	</body></html>`);
	assert.ok(facts);
	assert.equal(facts.source, "amazon_product_page");
	assert.equal(facts.calories, 150);
	assert.equal(facts.saturatedFatG, 1);
	assert.equal(facts.addedSugarG, 2);
	assert.equal(facts.ingredients, "oats and salt");
	assert.equal(facts.allergens, "wheat");
	assert.equal(facts.upc, "012345678905");
});

test("DOM terminal and loading empty pages emit retryable inventory skip and no checkpoint", async () => {
	for (const html of [
		'<div class="your-orders-content-container">No orders</div>',
		'<div aria-busy="true" class="your-orders-content-container">No orders</div>',
	]) {
		const wire: any[] = [];
		const page = {
			goto: async () => null,
			content: async () => html,
			url: () =>
				"https://www.amazon.com/your-orders/search?search=Whole+Foods+Market&page=1",
			locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		} as unknown as Page;
		await collectOrders({
			credentials: {},
			page,
			state: {},
			requested: new Map([["orders", {}]]) as never,
			progress: async () => {},
			emit: async (message) => {
				wire.push(message);
			},
			emitRecord: async () => {},
			reportStreamFailure: async () => {},
		});
		assert.ok(
			wire.some(
				(message) =>
					message.type === "SKIP_RESULT" &&
					message.reason === "inventory_not_proven_complete" &&
					message.recovery_hint.action === "retry_by_runtime" &&
					message.recovery_hint.retryable === true,
			),
		);
		assert.ok(
			wire.every(
				(message) =>
					!["STATE", "DETAIL_COVERAGE"].includes(message.type) &&
					message.op !== "delete",
			),
		);
	}
});

test("duplicate ASIN lines without source line identity are never silently merged", () => {
	const row =
		'<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Source product</a> Qty: 1 $2.50</div>';
	const detail = parseOrderDetailDom(row + row);
	assert.equal(detail.items.length, 2);
	assert.deepEqual(buildOrderItemRecords("order", detail.items), []);
});

test("nutrition key must agree with its source product identity", () => {
	const record = buildNutritionRecord("B012345678", "Source product", "error");
	assert.equal(
		nutritionSchema.safeParse({ ...record, id: "B087654321" }).success,
		false,
	);
});

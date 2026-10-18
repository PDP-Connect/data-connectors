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
import { mapUsdaNutrients, parseOrderDetailDom } from "./parsers.ts";
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
	assert.equal(order.item_count, null);
	assert.equal(order.total_cents, null);
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

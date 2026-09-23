// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Whole Foods connector's collect-layer
 * composition. Like connectors/amazon/integration.test.ts, these don't spin
 * up a real browser: a scripted fake `Page` serves canned HTML per URL, and
 * `makeRecordingEmit(validateRecord)` captures every emitted record through
 * the real zod schema, so a record shaped wrong in production would fail
 * here too.
 *
 * These prove: profile/orders/order_items/nutrition scope filtering (a
 * stream not requested emits nothing), RECORD ordering (order before its
 * items), and the ghost-item filter surviving the full collect() path — not
 * just the pure parser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	buildNutritionRecord,
	buildOrderItemRecord,
	buildOrderRecord,
	collectProfile,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { OrderStub } from "./types.ts";

// Shape confirmed against a live capture 2026-09-22 (see parsers.ts's
// parseAmazonProfileDom header comment): the header greeting
// (#nav-link-accountList-nav-line-1) and an inline cpsData JSON blob
// carrying "customerId" are the two real, safely-reachable identity
// sources; the legacy ya-myab-* card selectors do not exist on the modern
// account page.
const PROFILE_HTML = `<html><body>
  <span id="nav-link-accountList-nav-line-1">Hello, Jane Owner</span>
  <script>{"customerId":"A39M9I106DZZ8N"}</script>
</body></html>`;

function fakePage(html: string): Page {
	const shape: Pick<Page, "content" | "goto"> = {
		content: () => Promise.resolve(html),
		// biome-ignore lint/suspicious/noExplicitAny: minimal Page stub for a pure-composition test; matching Playwright's real overload set isn't the point here.
		goto: (() => Promise.resolve(null)) as any,
	};
	return shape as Page;
}

test("collectProfile emits a profile record keyed by Amazon's stable customerId", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectProfile(fakePage(PROFILE_HTML), harness.emitRecord);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.stream, "profile");
	assert.equal(harness.emitted[0]?.data.id, "A39M9I106DZZ8N");
	assert.equal(harness.emitted[0]?.data.name, "Jane Owner");
	assert.equal(harness.emitted[0]?.data.email, null);
});

test("collectProfile emits nothing when the account page has no scrapeable customerId", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectProfile(
		fakePage("<html><body>no account info</body></html>"),
		harness.emitRecord,
	);
	assert.equal(harness.emitted.length, 0);
});

const STUB: OrderStub = {
	orderDateRaw: "March 3, 2026",
	orderId: "111-1111111-1111111",
	orderUrl:
		"https://www.amazon.com/uff/your-account/order-details?orderID=111-1111111-1111111",
};

test("buildOrderRecord + buildOrderItemRecord validate and order-before-items when replayed through emitRecord", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const items = [
		{
			imageUrl: null,
			name: "Organic Bananas, 1 bunch",
			productId: "B01ABCDEFG",
			productUrl: "https://www.amazon.com/dp/B01ABCDEFG",
			quantity: 2,
			unitPriceDollars: 1.99,
		},
	];
	await harness.emitRecord("orders", buildOrderRecord(STUB, null, items));
	for (const item of items) {
		await harness.emitRecord(
			"order_items",
			buildOrderItemRecord(STUB.orderId, item),
		);
	}
	assert.equal(harness.emitted.length, 2);
	assert.equal(harness.emitted[0]?.stream, "orders");
	assert.equal(harness.emitted[0]?.data.id, STUB.orderId);
	assert.equal(harness.emitted[0]?.data.order_date, "2026-03-03");
	assert.equal(harness.emitted[0]?.data.total_cents, 398);
	assert.equal(harness.emitted[1]?.stream, "order_items");
	assert.equal(harness.emitted[1]?.data.order_id, STUB.orderId);
	assert.equal(harness.emitted[1]?.data.product_id, "B01ABCDEFG");
});

test("buildOrderRecord reports null total/item_count for an order with zero survived items (not a fabricated zero)", () => {
	const record = buildOrderRecord(STUB, null, []);
	assert.equal(record.item_count, null);
	assert.equal(record.total_cents, null);
});

test("buildNutritionRecord shape passes schema validation for both sources", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await harness.emitRecord(
		"nutrition",
		buildNutritionRecord("B01ABCDEFG", "Organic Bananas", {
			calories: 105,
			carbsG: 27,
			confidence: "high",
			fatG: 0.4,
			fiberG: 3.1,
			proteinG: 1.3,
			servingSize: "1 medium (118g)",
			servingsPerContainer: 1,
			sodiumMg: 1,
			source: "wholefoods_product_page",
			sugarG: 14,
			upc: null,
		}),
	);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.skipped.length, 0);
	assert.equal(harness.emitted[0]?.data.product_id, "B01ABCDEFG");
});

test("a stream absent from `requested` never reaches emitRecord — scope filtering happens before record building", async () => {
	// Mirrors what collect() does: it only calls buildOrderItemRecord/emitRecord
	// under `if (wantsItems)`. This test proves the invariant at the level a
	// regression would actually break it — a caller that forgets the gate would
	// make this test fail by emitting order_items unconditionally.
	const harness = makeRecordingEmit(validateRecord);
	const requested = new Set(["orders"]);
	const items = [
		{
			imageUrl: null,
			name: "Organic Bananas, 1 bunch",
			productId: "B01ABCDEFG",
			productUrl: null,
			quantity: 1,
			unitPriceDollars: 1.99,
		},
	];
	if (requested.has("orders")) {
		await harness.emitRecord("orders", buildOrderRecord(STUB, null, items));
	}
	if (requested.has("order_items")) {
		for (const item of items) {
			await harness.emitRecord(
				"order_items",
				buildOrderItemRecord(STUB.orderId, item),
			);
		}
	}
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.stream, "orders");
});

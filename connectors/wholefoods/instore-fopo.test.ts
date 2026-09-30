// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-store (`/fopo/order-details`) order pages. The fixture is synthetic, shaped
 * like a live capture (2026-09-29) of an in-store Whole Foods page: three
 * rows, one sold by weight ("Qty: 1.84 lb @ $5.49/lb"). Names, ASINs, image
 * paths and prices are invented. The live capture had no row without an ASIN
 * link, so that case is derived from the fixture by removing one row's
 * product link and image.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import * as connector from "./index.ts";
import * as parsers from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { OrderStub } from "./types.ts";

const FIXTURE = readFileSync(
	new URL("./__fixtures__/order-detail-instore-fopo.html", import.meta.url),
	"utf8",
);

const STUB: OrderStub = {
	expectedItemCount: 3,
	orderDateRaw: null,
	orderId: "000-0000000-0000000",
	orderUrl:
		"https://www.amazon.com/fopo/order-details?orderID=000-0000000-0000000",
};

/** Remove the product link and image of the second fixture row. */
function withoutAsinRow(html: string): string {
	return html
		.replace(
			/<a class="a-size-small a-link-normal"[^>]*href="\/dp\/B0TESTBBBB[^"]*">([\s\S]*?)<\/a>/,
			"$1",
		)
		.replace(/<img alt="B0TESTBBBB-1"[^>]*>/, "");
}

test("in-store detail readiness selector matches the fopo fixture", () => {
	const { document } = parseHTML(FIXTURE);
	assert.ok(
		document.querySelector(parsers.ORDER_DETAIL_READY_SELECTOR),
		"fopo page must satisfy the detail readiness wait",
	);
	assert.equal(parsers.hasOrderDetailEvidence(FIXTURE), true);
});

test("readiness and evidence still cover the legacy layouts", () => {
	for (const html of [
		'<div data-component="purchasedItemsRightGrid"></div>',
		'<div data-component="cancelled"></div>',
	]) {
		assert.equal(parsers.hasOrderDetailEvidence(html), true);
		assert.ok(
			parseHTML(html).document.querySelector(
				parsers.ORDER_DETAIL_READY_SELECTOR,
			),
		);
	}
	assert.equal(parsers.hasOrderDetailEvidence("<html></html>"), false);
});

test("parseOrderDetailDom reads every in-store row with its ASIN", () => {
	const detail = parsers.parseOrderDetailDom(FIXTURE);
	assert.deepEqual(
		detail.items.map((item) => item.productId),
		["B0TESTAAAA", "B0TESTBBBB", "B0TESTCCCC"],
	);
	assert.equal(detail.orderDateRaw, "March 3, 2026");
	const [first] = detail.items;
	assert.equal(first?.quantity, 1);
	assert.equal(first?.unitPriceDollars, 6.49);
	assert.equal(first?.lineTotalDollars, 6.49);
	assert.match(first?.imageUrl ?? "", /^https:\/\/m\.media-amazon\.com\//);
});

test("a weighed in-store row keeps its weight, per-weight price and line total", () => {
	const weighed = parsers.parseOrderDetailDom(FIXTURE).items[2];
	assert.equal(weighed?.quantity, 1.84);
	assert.equal(weighed?.quantityUnit, "lb");
	assert.equal(weighed?.unitPriceDollars, 5.49);
	assert.equal(weighed?.lineTotalDollars, 8.10);
});

test("a weighed row counts as one search row when reconciling item counts", () => {
	const { items } = parsers.parseOrderDetailDom(FIXTURE);
	assert.equal(connector.orderDetailCountsMatch(STUB, items), true);
	assert.equal(
		connector.orderDetailCountsMatch({ ...STUB, expectedItemCount: 4 }, items),
		false,
	);
});

test("in-store order record uses charged line totals and validates", () => {
	const { items } = parsers.parseOrderDetailDom(FIXTURE);
	const record = connector.buildOrderRecord(STUB, null, items);
	assert.equal(record.total_cents, 649 + 399 + 810);
	assert.equal(record.item_count, 3);
	validateRecord("orders", record);
	for (const itemRecord of connector.buildOrderItemRecords(
		STUB.orderId,
		items,
	)) {
		validateRecord("order_items", itemRecord);
	}
});

test("an in-store row without an ASIN link is kept for counts but gets no item record or invented id", () => {
	const detail = parsers.parseOrderDetailDom(withoutAsinRow(FIXTURE));
	assert.equal(detail.items.length, 3);
	const bare = detail.items[1];
	assert.equal(bare?.productId, null);
	assert.equal(bare?.productUrl, null);
	assert.equal(bare?.imageUrl, null);
	assert.equal(bare?.name, "Test Deli Item B, 237 ML");
	assert.equal(connector.orderDetailCountsMatch(STUB, detail.items), true);
	const records = connector.buildOrderItemRecords(STUB.orderId, detail.items);
	assert.deepEqual(
		records.map((r) => r.product_id),
		["B0TESTAAAA", "B0TESTCCCC"],
	);
});

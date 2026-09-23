// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Shopify (Shop app) connector's `orders` stream. The
 * fixture record below matches the shape `parsers.ts`/`index.ts` actually
 * build (see `orderRecord()` in index.ts and `parseOrderRef()` in
 * parsers.ts) rather than a hand-authored contract guess — but see the
 * GROUND-TRUTH CAVEAT in schemas.ts: no real Shop cache extract has ever
 * been run through this schema.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { ordersSchema, validateRecord } from "./schemas.ts";

const ORDER_RECORD = {
	id: "gid://shopify/Order/12345",
	order_number: "gid://shopify/Order/12345",
	order_date: "2024-05-01T18:22:05.000Z",
	merchant_name: "Acme Goods",
	status: "fulfilled",
	total_cents: 4999,
	currency: "USD",
	item_count: 3,
	line_item_titles: ["Wireless Mouse", "USB-C Cable"],
	detail_url: "https://shop.app/account/order-history",
};

test("orders schema accepts a fixture-shaped record", () => {
	const result = ordersSchema.safeParse(ORDER_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema accepts an order missing optional fields (nulls, empty line items)", () => {
	const result = ordersSchema.safeParse({
		...ORDER_RECORD,
		order_number: null,
		order_date: null,
		merchant_name: null,
		status: null,
		total_cents: null,
		currency: null,
		item_count: null,
		line_item_titles: [],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("orders schema rejects a non-ISO currency (raw symbol leaked in)", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, currency: "$" }).success,
		false,
	);
});

test("orders schema rejects a negative total_cents", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, total_cents: -100 }).success,
		false,
	);
});

test("orders schema rejects a non-URL detail_url", () => {
	assert.equal(
		ordersSchema.safeParse({ ...ORDER_RECORD, detail_url: "see app" }).success,
		false,
	);
});

test("orders schema rejects a missing detail_url", () => {
	const { detail_url: _unused, ...withoutDetailUrl } = ORDER_RECORD;
	assert.equal(ordersSchema.safeParse(withoutDetailUrl).success, false);
});

test("validateRecord routes orders and passes unknown streams through", () => {
	assert.equal(validateRecord("orders", ORDER_RECORD).ok, true);
	assert.equal(validateRecord("line_items", { id: "x" }).ok, true);
});

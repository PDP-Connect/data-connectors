// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure DoorDash parsers, run against hand-authored
 * SYNTHETIC fixtures (no live DoorDash capture exists for this lane — see
 * connectors/doordash/index.ts header). Fixture shapes are derived from the
 * legacy Playwright scraper's own GraphQL response walk
 * (data-connectors/doordash/doordash-playwright.js) and DoorDash's known
 * public money-envelope convention (`{ unitAmount, displayString }`), not
 * from an observed live response.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	centsFromMonetary,
	deliveryAddressText,
	findOrderNodesInResponse,
	normalizeOrderDate,
	orderId,
	orderItemRecords,
	orderRecord,
	parseOrdersResponse,
	restaurantName,
} from "./parsers.ts";
import type { DoorDashOrderNode } from "./types.ts";

// ─── centsFromMonetary ────────────────────────────────────────────────────

test("centsFromMonetary: reads unitAmount directly as integer cents", () => {
	assert.equal(centsFromMonetary({ unitAmount: 4323 }), 4323);
});

test("centsFromMonetary: rounds a non-integer unitAmount", () => {
	assert.equal(centsFromMonetary({ unitAmount: 4323.4 }), 4323);
});

test("centsFromMonetary: falls back to displayString when unitAmount absent", () => {
	assert.equal(centsFromMonetary({ displayString: "$43.23" }), 4323);
});

test("centsFromMonetary: parses a bare dollar string", () => {
	assert.equal(centsFromMonetary("$12.34"), 1234);
	assert.equal(centsFromMonetary("12.34"), 1234);
});

test("centsFromMonetary: parses a bare number as already-cents", () => {
	assert.equal(centsFromMonetary(500), 500);
});

test("centsFromMonetary: handles thousands separators", () => {
	assert.equal(centsFromMonetary("$1,234.56"), 123_456);
});

test("centsFromMonetary: null/undefined -> null", () => {
	assert.equal(centsFromMonetary(null), null);
	assert.equal(centsFromMonetary(undefined), null);
});

test("centsFromMonetary: unparseable string -> null, never guessed", () => {
	assert.equal(centsFromMonetary("Free"), null);
	assert.equal(centsFromMonetary("N/A"), null);
});

test("centsFromMonetary: empty monetary object -> null", () => {
	assert.equal(centsFromMonetary({}), null);
});

// ─── normalizeOrderDate ────────────────────────────────────────────────────

test("normalizeOrderDate: ISO string round-trips to ISO", () => {
	assert.equal(
		normalizeOrderDate("2026-08-01T18:22:05.000Z"),
		"2026-08-01T18:22:05.000Z",
	);
});

test("normalizeOrderDate: null/undefined -> null", () => {
	assert.equal(normalizeOrderDate(null), null);
	assert.equal(normalizeOrderDate(undefined), null);
});

test("normalizeOrderDate: unparseable date -> null, never fabricated", () => {
	assert.equal(normalizeOrderDate("not-a-date"), null);
	assert.equal(normalizeOrderDate(""), null);
});

// ─── deliveryAddressText / restaurantName ─────────────────────────────────

test("deliveryAddressText: prefers printableAddress, falls back in order", () => {
	assert.equal(
		deliveryAddressText({
			printableAddress: "A",
			formattedAddress: "B",
			shortName: "C",
		}),
		"A",
	);
	assert.equal(
		deliveryAddressText({ formattedAddress: "B", shortName: "C" }),
		"B",
	);
	assert.equal(deliveryAddressText({ shortName: "C" }), "C");
	assert.equal(deliveryAddressText(null), null);
	assert.equal(deliveryAddressText({}), null);
});

test("restaurantName: reads store.name, null when absent", () => {
	assert.equal(restaurantName({ name: "Tatsu-ya Ramen" }), "Tatsu-ya Ramen");
	assert.equal(restaurantName(null), null);
	assert.equal(restaurantName({}), null);
});

// ─── orderId ────────────────────────────────────────────────────────────

test("orderId: reads orderUuid, never fabricates one", () => {
	assert.equal(orderId({ orderUuid: "abc-123" }), "abc-123");
	assert.equal(orderId({}), null);
});

// ─── orderRecord: D4 money-as-cents, field mapping ────────────────────────

const SYNTHETIC_NODE: DoorDashOrderNode = {
	orderUuid: "order-9f3a2b",
	createdAt: "2026-08-01T18:22:05.000Z",
	store: { name: "Tatsu-ya Ramen" },
	deliveryStatus: "delivered",
	subtotal: { unitAmount: 2895, displayString: "$28.95" },
	tax: { unitAmount: 239, displayString: "$2.39" },
	tip: { unitAmount: 500, displayString: "$5.00" },
	deliveryFee: { unitAmount: 399, displayString: "$3.99" },
	serviceFee: { unitAmount: 290, displayString: "$2.90" },
	totalCharged: { unitAmount: 4323, displayString: "$43.23" },
	deliveryAddress: { printableAddress: "123 Main St, Apt 4, Austin, TX 78701" },
	orderItems: [
		{ name: "Tonkotsu Original", quantity: 1, price: { unitAmount: 1495 } },
		{ name: "Gyoza", quantity: 2, price: { unitAmount: 600 } },
	],
};

test("orderRecord: maps every field per the capability-map field_map", () => {
	const record = orderRecord(SYNTHETIC_NODE);
	assert.ok(record);
	assert.equal(record.id, "order-9f3a2b");
	assert.equal(record.order_date, "2026-08-01T18:22:05.000Z");
	assert.equal(record.restaurant_name, "Tatsu-ya Ramen");
	assert.equal(record.status, "delivered");
	assert.equal(record.subtotal_cents, 2895);
	assert.equal(record.tax_cents, 239);
	assert.equal(record.tip_cents, 500);
	assert.equal(record.delivery_fee_cents, 399);
	assert.equal(record.service_fee_cents, 290);
	assert.equal(record.total_cents, 4323);
	assert.equal(record.delivery_address, "123 Main St, Apt 4, Austin, TX 78701");
	assert.equal(record.item_count, 2);
});

test("orderRecord: falls back to grandTotal when totalCharged absent", () => {
	const record = orderRecord({
		...SYNTHETIC_NODE,
		totalCharged: null,
		grandTotal: { unitAmount: 4000 },
	});
	assert.equal(record?.total_cents, 4000);
});

test("orderRecord: missing orderUuid returns null (no synthetic id fabricated)", () => {
	assert.equal(orderRecord({ ...SYNTHETIC_NODE, orderUuid: null }), null);
});

test("orderRecord: item_count is 0 (not null) when orderItems is an empty array", () => {
	const record = orderRecord({ ...SYNTHETIC_NODE, orderItems: [] });
	assert.equal(record?.item_count, 0);
});

test("orderRecord: item_count is null when orderItems is entirely absent", () => {
	const { orderItems: _omit, ...withoutItems } = SYNTHETIC_NODE;
	const record = orderRecord(withoutItems);
	assert.equal(record?.item_count, null);
});

test("orderRecord: missing money fields become null, never zero-guessed", () => {
	const record = orderRecord({
		orderUuid: "order-bare",
		createdAt: "2026-08-01T18:22:05.000Z",
	});
	assert.equal(record?.subtotal_cents, null);
	assert.equal(record?.tax_cents, null);
	assert.equal(record?.total_cents, null);
	assert.equal(record?.payment_method_summary, null);
});

// ─── orderItemRecords: D3 split, positional stable ids ────────────────────

test("orderItemRecords: builds one record per item with a stable positional id", () => {
	const items = orderItemRecords("order-9f3a2b", SYNTHETIC_NODE.orderItems);
	assert.equal(items.length, 2);
	assert.equal(items[0]?.id, "order-9f3a2b-item-0");
	assert.equal(items[0]?.order_id, "order-9f3a2b");
	assert.equal(items[0]?.name, "Tonkotsu Original");
	assert.equal(items[0]?.quantity, 1);
	assert.equal(items[0]?.unit_price_cents, 1495);
	assert.deepEqual(items[0]?.customizations, []);
	assert.equal(items[1]?.id, "order-9f3a2b-item-1");
	assert.equal(items[1]?.quantity, 2);
});

test("orderItemRecords: item missing a name is dropped, not emitted with a blank name", () => {
	const items = orderItemRecords("order-1", [
		{ name: "", quantity: 1, price: { unitAmount: 100 } },
		{ name: "Real item", quantity: 1, price: { unitAmount: 200 } },
	]);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.name, "Real item");
});

test("orderItemRecords: missing quantity defaults to 1, never 0", () => {
	const items = orderItemRecords("order-1", [
		{ name: "Item", price: { unitAmount: 100 } },
	]);
	assert.equal(items[0]?.quantity, 1);
});

test("orderItemRecords: no items array -> empty result", () => {
	assert.deepEqual(orderItemRecords("order-1", null), []);
	assert.deepEqual(orderItemRecords("order-1", undefined), []);
});

// ─── findOrderNodesInResponse / parseOrdersResponse: structural walk ──────

test("findOrderNodesInResponse: finds the order array nested under an arbitrary GraphQL envelope", () => {
	const body = {
		data: {
			consumer: {
				ordersWithDetails: {
					orders: [SYNTHETIC_NODE, { ...SYNTHETIC_NODE, orderUuid: "order-2" }],
				},
			},
		},
	};
	const found = findOrderNodesInResponse(body);
	assert.equal(found?.length, 2);
});

test("findOrderNodesInResponse: returns null when nothing looks like an order", () => {
	assert.equal(
		findOrderNodesInResponse({ data: { unrelated: [{ a: 1 }] } }),
		null,
	);
	assert.equal(findOrderNodesInResponse(null), null);
	assert.equal(findOrderNodesInResponse("not an object"), null);
});

test("parseOrdersResponse: unwraps the top-level data envelope and returns [] on no match", () => {
	const nodes = parseOrdersResponse({ data: { orders: [SYNTHETIC_NODE] } });
	assert.equal(nodes.length, 1);
	assert.equal(parseOrdersResponse(null).length, 0);
	assert.equal(parseOrdersResponse({ data: {} }).length, 0);
});

test("parseOrdersResponse: also handles a response with no 'data' wrapper", () => {
	const nodes = parseOrdersResponse({ orders: [SYNTHETIC_NODE] });
	assert.equal(nodes.length, 1);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser tests for the Shopify (Shop app) connector.
 *
 * SYNTHETIC FIXTURES, NOT A REAL CAPTURE. Every Apollo cache extract below
 * is hand-authored to match the shape the legacy Playwright connector
 * (connectors/shopify/shop-playwright.js) reads from a live Shop session —
 * that legacy connector itself has no committed real capture either (it
 * predates this repo's fixture-capture convention). Per
 * docs/migration/connector-cutover/CONTRACTS.md's per-connector proof gate
 * item 2, a synthetic fixture is labeled synthetic and does not count as
 * the "real capture, scrubbed and reviewed" proof; it exercises the parser
 * logic and shape mapping, nothing more.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	collectAllOrderRefs,
	extractOrders,
	extractOrdersWithCoverage,
	hasNextOrdersPage,
	hasOrderCountMismatch,
	hasVerifiedOrdersEnd,
	parseDomOrderCards,
	parseOrderRef,
} from "./parsers.ts";
import type { ApolloCache } from "./types.ts";

function synthCache(overrides: Partial<ApolloCache> = {}): ApolloCache {
	return {
		ROOT_QUERY: {
			'deliveriesOrdersList:{"filter":{},"sortBy":"PLACED_AT"}': {
				nodes: [{ __ref: "Order:1" }, { __ref: "Order:2" }],
				pageInfo: { hasNextPage: false },
			},
		},
		"Order:1": {
			id: "gid://shopify/Order/1",
			createdAt: "2024-05-01T18:22:05.000Z",
			displayStatus: "FULFILLED",
			shop: { __ref: "Shop:acme" },
			effectiveTotalPrice: { amount: "49.99", currencyCode: "USD" },
			totalItemCount: 2,
			lineItems: {
				nodes: [{ __ref: "ProductVariant:1a" }, { __ref: "ProductVariant:1b" }],
			},
		},
		"Order:2": {
			id: "gid://shopify/Order/2",
			createdAt: "2024-06-10T09:00:00.000Z",
			displayStatus: "IN_TRANSIT",
			shop: { __ref: "Shop:acme" },
			totalPriceAfterOfferApplied: { amount: "12.5", currencyCode: "USD" },
			totalItemCount: 1,
			lineItems: { nodes: [{ __ref: "ProductVariant:2a" }] },
		},
		"Shop:acme": { name: "Acme Goods" },
		"ProductVariant:1a": { productTitle: "Wireless Mouse" },
		"ProductVariant:1b": { productTitle: "USB-C Cable" },
		"ProductVariant:2a": { productTitle: "Notebook" },
		...overrides,
	};
}

test("parseDomOrderCards maps legacy-shaped order cards to Shop records when Apollo is unavailable", () => {
	const fixture = `
		<div class="order-card">
			<a href="https://shop.app/orders/order-123">Acme Goods</a>
			<div>2 items · $19.99</div>
			<div>Delivered</div>
		</div>`;
	const [order] = parseDomOrderCards(fixture);
	assert.deepEqual(order, {
		currency: "USD",
		detailUrl: "https://shop.app/orders/order-123",
		id: "https://shop.app/orders/order-123",
		itemCount: 2,
		lineItemTitles: [],
		merchantName: "Acme Goods",
		orderNumber: null,
		placedAt: null,
		status: "Delivered",
		totalCents: 1999,
	});
});

test("parseDomOrderCards parses a legacy EUR-suffix card without item count", () => {
	const fixture = `
		<div class="order-card">
			<a href="https://shop.app/orders/order-eur">Euro Goods</a>
			<div>40.95 EUR</div>
			<div>Delivered</div>
		</div>`;
	const [order] = parseDomOrderCards(fixture);
	assert.deepEqual(order, {
		currency: "EUR",
		detailUrl: "https://shop.app/orders/order-eur",
		id: "https://shop.app/orders/order-eur",
		itemCount: null,
		lineItemTitles: [],
		merchantName: "Euro Goods",
		orderNumber: null,
		placedAt: null,
		status: "Delivered",
		totalCents: 4095,
	});
});

test("parseDomOrderCards dedupes multiple Shop links in one card and keeps the order link", () => {
	const fixture = `
		<div class="order-card">
			<a href="https://shop.app/merchant/acme">Acme Goods</a>
			<div>1 item · $8.50</div>
			<a href="https://shop.app/orders/order-card">View order</a>
		</div>`;
	const orders = parseDomOrderCards(fixture);
	assert.equal(orders.length, 1);
	assert.equal(orders[0]?.detailUrl, "https://shop.app/orders/order-card");
	assert.equal(orders[0]?.id, "https://shop.app/orders/order-card");
});

test("extractOrders parses every order reachable from ROOT_QUERY", () => {
	const orders = extractOrders(synthCache());
	assert.equal(orders.length, 2);

	const first = orders.find((o) => o.id === "gid://shopify/Order/1");
	assert.ok(first);
	assert.equal(first.orderNumber, "gid://shopify/Order/1");
	assert.equal(first.placedAt, "2024-05-01T18:22:05.000Z");
	assert.equal(first.merchantName, "Acme Goods");
	assert.equal(first.status, "FULFILLED");
	assert.equal(first.totalCents, 4999);
	assert.equal(first.currency, "USD");
	assert.equal(first.itemCount, 2);
	assert.deepEqual(first.lineItemTitles, ["Wireless Mouse", "USB-C Cable"]);
	assert.equal(first.detailUrl, "https://shop.app/account/order-history");
});

test("extractOrders falls back to totalPriceAfterOfferApplied and reads totalItemCount", () => {
	const orders = extractOrders(synthCache());
	const second = orders.find((o) => o.id === "gid://shopify/Order/2");
	assert.ok(second);
	assert.equal(second.totalCents, 1250);
	assert.equal(second.itemCount, 1, "reads the source totalItemCount");
});

test("extractOrders rounds decimal-string amounts to integer cents without float drift", () => {
	const sourceOrder = synthCache()["Order:1"] as Record<string, unknown>;
	const cache = synthCache({
		"Order:1": {
			...sourceOrder,
			effectiveTotalPrice: { amount: "19.999", currencyCode: "USD" },
		},
	});
	const [order] = extractOrders(cache);
	assert.equal(order?.totalCents, 2000);
});

test("extractOrders preserves explicit empty total price fields", () => {
	const cache = synthCache({
		ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{},"sortBy":"PLACED_AT"}': {
			nodes: [{ __ref: "Order:1" }], pageInfo: { hasNextPage: false },
		} },
		"Order:1": {
			id: "gid://shopify/Order/1", createdAt: null, displayStatus: null,
			shop: { __ref: "Shop:acme" }, effectiveTotalPrice: null,
			lineItems: { nodes: [] }, totalItemCount: null,
		},
	});
	const [order] = extractOrders(cache);
	assert.equal(order?.totalCents, null);
	assert.equal(order?.currency, null);
	assert.equal(order?.itemCount, null);
});

test("parseOrderRef returns null for a ref that resolves to nothing", () => {
	const cache = synthCache();
	assert.equal(parseOrderRef(cache, "Order:missing"), null);
});

test("parseOrderRef returns null for an entry with no id", () => {
	const cache = synthCache({ "Order:3": { createdAt: "2024-01-01" } });
	assert.equal(parseOrderRef(cache, "Order:3"), null);
});

test("collectAllOrderRefs dedupes refs seen in both the paginated and cursor-format keys", () => {
	const cache = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: [{ __ref: "Order:1" }],
				pageInfo: { hasNextPage: false },
			},
			'deliveriesOrdersList({"first":10})': {
				nodes: [{ __ref: "Order:1" }, { __ref: "Order:2" }],
				pageInfo: { hasNextPage: false },
			},
		},
	});
	assert.deepEqual(collectAllOrderRefs(cache), ["Order:1", "Order:2"]);
});

test("collectAllOrderRefs returns an empty list when ROOT_QUERY is missing", () => {
	assert.deepEqual(collectAllOrderRefs({}), []);
});

test("hasNextOrdersPage reads pageInfo.hasNextPage off the paginated accumulation key", () => {
	const cache = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: [{ __ref: "Order:1" }],
				pageInfo: { hasNextPage: true },
			},
		},
	});
	assert.equal(hasNextOrdersPage(cache), true);
});

test("hasNextOrdersPage falls back to cursor-format keys when no paginated key exists", () => {
	const cache = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList({"first":10})': {
				nodes: [{ __ref: "Order:1" }],
				pageInfo: { hasNextPage: true },
			},
		},
	});
	assert.equal(hasNextOrdersPage(cache), true);
});

test("hasNextOrdersPage is false when no orders list connection exists", () => {
	assert.equal(hasNextOrdersPage({ ROOT_QUERY: {} }), false);
});

test("Shopify row normalization preserves numeric IDs, numeric strings, and empty source strings", () => {
	const cache = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: [{ __ref: "Order:0" }],
				pageInfo: { hasNextPage: false },
			},
		},
		"Order:0": {
			id: 0,
			createdAt: "",
			displayStatus: "",
			shop: { __ref: "Shop:empty" },
			effectiveTotalPrice: { amount: "0", currencyCode: "" },
			totalItemCount: "0",
			lineItems: { nodes: [{ __ref: "ProductVariant:empty" }] },
		},
		"Shop:empty": { name: "" },
		"ProductVariant:empty": { productTitle: "" },
	});
	const [order] = extractOrders(cache);
	assert.deepEqual(order, {
		currency: "",
		detailUrl: "https://shop.app/account/order-history",
		id: "0",
		itemCount: 0,
		lineItemTitles: [""],
		merchantName: "",
		orderNumber: "0",
		placedAt: "",
		status: "",
		totalCents: 0,
	});
	const coverage = extractOrdersWithCoverage(cache).fieldCoverage[0] ?? [];
	assert.equal(coverage.length, 10, "each mapped field receives one coverage state");
	assert.equal(coverage.find((entry) => entry.field === "placed_at")?.state, "EXPLICIT_EMPTY");
	assert.equal(coverage.find((entry) => entry.field === "status")?.state, "EXPLICIT_EMPTY");
	assert.equal(coverage.find((entry) => entry.field === "currency")?.state, "EXPLICIT_EMPTY");
	assert.equal(coverage.find((entry) => entry.field === "merchant_name")?.state, "EXPLICIT_EMPTY");
	assert.ok(coverage.every((entry) => entry.state !== "UNAVAILABLE"));
});

test("invalid empty numeric source fields are discarded for omission accounting, not coerced to zero", () => {
	const validOrder = synthCache()["Order:1"] as Record<string, unknown>;
	const cache = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: [{ __ref: "Order:1" }],
				pageInfo: { hasNextPage: false },
			},
		},
		"Order:1": {
			...validOrder,
			effectiveTotalPrice: { amount: "", currencyCode: "USD" },
			totalItemCount: "",
		},
	});
	const result = extractOrdersWithCoverage(cache);
	assert.equal(result.orders.length, 0);
	assert.equal(result.discoveredRows, 1);
	assert.equal(result.discardedRows, 1);
	assert.deepEqual(result.withheldRows[0]?.fields.map(({ field, reason }) => ({ field, reason })), [
		{ field: "total", reason: "malformed_value" },
		{ field: "item_count", reason: "malformed_value" },
	]);
});

test("every Shop order connection needs explicit terminal pageInfo", () => {
	const missing = { ROOT_QUERY: {
		'deliveriesOrdersList:{"filter":{}}': { nodes: [] },
	} };
	assert.equal(hasNextOrdersPage(missing), true, "unknown pageInfo keeps the walk open");
	assert.equal(hasVerifiedOrdersEnd(missing), false, "missing pageInfo is not terminal evidence");
	const mixed = { ROOT_QUERY: {
		'deliveriesOrdersList:{"filter":{}}': { nodes: [], pageInfo: { hasNextPage: false } },
		'deliveriesOrdersList({"first":10})': { nodes: [], pageInfo: { hasNextPage: true } },
	} };
	assert.equal(hasNextOrdersPage(mixed), true, "a second connection still advertising a next page vetoes end");
	assert.equal(hasVerifiedOrdersEnd(mixed), false);
	assert.equal(hasVerifiedOrdersEnd({ ROOT_QUERY: {
		'deliveriesOrdersList:{"filter":{}}': { nodes: [], pageInfo: { hasNextPage: false } },
	} }), true);
});

test("a malformed mapped field withholds the full order and reports only field reasons", () => {
	const cache = synthCache({
		ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{}}': {
			nodes: [{ __ref: "Order:1" }], pageInfo: { hasNextPage: false },
		} },
		"Order:1": {
			id: "gid://shopify/Order/1",
			createdAt: {},
			displayStatus: false,
			effectiveTotalPrice: "bad",
			totalItemCount: 2,
			shop: { __ref: "Shop:missing" },
			lineItems: { nodes: [{ __ref: "ProductVariant:missing" }] },
		},
	});
	const result = extractOrdersWithCoverage(cache);
	assert.equal(result.orders.length, 0);
	assert.equal(result.discardedRows, 1);
	assert.deepEqual(result.withheldRows, [{
		fields: [
			{ field: "placed_at", reason: "malformed_value" },
			{ field: "status", reason: "malformed_value" },
			{ field: "total", reason: "malformed_value" },
			{ field: "currency", reason: "malformed_value" },
			{ field: "merchant_name", reason: "missing_reference" },
			{ field: "line_item_titles", reason: "missing_or_malformed_reference" },
		],
	}]);
	assert.equal(JSON.stringify(result.withheldRows).includes("gid://"), false);
});

test("missing mapped scalar fields withhold the whole order instead of becoming empty values", () => {
	const cache = synthCache({
		ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{}}': {
			nodes: [{ __ref: "Order:1" }], pageInfo: { hasNextPage: false },
		} },
		"Order:1": {
			id: "gid://shopify/Order/1",
			shop: { __ref: "Shop:acme" },
			lineItems: { nodes: [] },
		},
	});
	const result = extractOrdersWithCoverage(cache);
	assert.equal(result.orders.length, 0, "partial cache data must not replace a stored whole record");
	assert.deepEqual(result.withheldRows, [{ fields: [
		{ field: "placed_at", reason: "missing_field" },
		{ field: "status", reason: "missing_field" },
		{ field: "total", reason: "missing_field" },
		{ field: "currency", reason: "missing_field" },
		{ field: "item_count", reason: "missing_field" },
	] }]);
});

test("an unreadable nodes body and invalid declared totals veto connection end", () => {
	for (const nodes of [undefined, null, { 0: { __ref: "Order:1" } }]) {
		const cache = synthCache({
			ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{}}': { nodes, pageInfo: { hasNextPage: false } } },
		});
		assert.equal(hasVerifiedOrdersEnd(cache), false);
		assert.ok(extractOrdersWithCoverage(cache).discardedRows > 0);
	}
	for (const totalCount of [true, "not-a-number", Number.POSITIVE_INFINITY, 1.5, null, undefined]) {
		const cache = synthCache({
			ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{}}': {
				nodes: [{ __ref: "Order:1" }, { __ref: "Order:2" }],
				pageInfo: { hasNextPage: false }, totalCount,
			} },
		});
		assert.equal(hasOrderCountMismatch(cache), true);
	}
});

test("cursor suffixes and filtered connections are not verified full-history end proof", () => {
	const suffix = synthCache({
		ROOT_QUERY: { 'deliveriesOrdersList({"first":10,"after":"middle"})': {
			nodes: [{ __ref: "Order:1" }, { __ref: "Order:2" }], pageInfo: { hasNextPage: false },
		} },
	});
	assert.equal(hasVerifiedOrdersEnd(suffix), false);
	const accumulatedSuffix = synthCache({
		ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{},"after":"middle"}': {
			nodes: [{ __ref: "Order:1" }, { __ref: "Order:2" }], pageInfo: { hasNextPage: false },
		} },
	});
	assert.equal(hasVerifiedOrdersEnd(accumulatedSuffix), false);
	const filtered = synthCache({
		ROOT_QUERY: { 'deliveriesOrdersList:{"filter":{"status":"FULFILLED"}}': {
			nodes: [{ __ref: "Order:1" }, { __ref: "Order:2" }], pageInfo: { hasNextPage: false },
		} },
	});
	assert.equal(hasVerifiedOrdersEnd(filtered), false);
});

test("cursor history end requires a connected first-to-terminal request chain", () => {
	const first = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList({"first":10})': {
				nodes: [{ __ref: "Order:1" }], totalCount: 2,
				pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
			},
			'deliveriesOrdersList({"first":10,"after":"cursor-1"})': {
				nodes: [{ __ref: "Order:2" }], totalCount: 2,
				pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
			},
		},
	});
	assert.equal(hasVerifiedOrdersEnd(first), true);
	const disconnected = synthCache({
		ROOT_QUERY: {
			'deliveriesOrdersList({"first":10})': {
				nodes: [{ __ref: "Order:1" }], totalCount: 2,
				pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
			},
			'deliveriesOrdersList({"first":10,"after":"other"})': {
				nodes: [{ __ref: "Order:2" }], totalCount: 2,
				pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
			},
		},
	});
	assert.equal(hasVerifiedOrdersEnd(disconnected), false);
});

test("a connected cursor chain has no outstanding continuation after its terminal frontier", () => {
	const cache = synthCache({ ROOT_QUERY: {
		'deliveriesOrdersList({"first":10})': {
			nodes: [{ __ref: "Order:1" }],
			pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
		},
		'deliveriesOrdersList({"first":10,"after":"cursor-1"})': {
			nodes: [{ __ref: "Order:2" }],
			pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
		},
	} });
	assert.equal(hasVerifiedOrdersEnd(cache), true);
	assert.equal(hasNextOrdersPage(cache), false, "historical first-page continuation is already fulfilled");
});


test("Shop DOM links canonicalize both origins and reject lookalikes", () => {
	const card = (origin: string) => `<div class="order-card"><a href="${origin}/orders/same-order">Acme Goods</a><div>2 items · $19.99</div></div>`;
	const expected = parseDomOrderCards(card("https://shop.app"));
	assert.equal(expected.length, 1);
	assert.deepEqual(parseDomOrderCards(card("https://shop.com")), expected);
	for (const origin of ["https://shop.com.evil", "https://shop.app.evil", "http://shop.com", "https://shop.com:444", "https://evil.test/?shop.com"]) {
		assert.deepEqual(parseDomOrderCards(card(origin)), [], origin);
	}
	const mixed = '<div class="order-card"><a href="https://shop.com/merchant/acme">Acme Goods</a><div>2 items · $19.99</div><a href="https://shop.app/orders/same-order">View order</a></div>';
	assert.equal(parseDomOrderCards(mixed)[0]?.id, "https://shop.app/orders/same-order");
});

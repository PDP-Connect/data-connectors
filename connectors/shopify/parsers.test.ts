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
	hasNextOrdersPage,
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

test("extractOrders falls back to totalPriceAfterOfferApplied and derives itemCount from line items when totalItemCount is absent", () => {
	const orders = extractOrders(synthCache());
	const second = orders.find((o) => o.id === "gid://shopify/Order/2");
	assert.ok(second);
	assert.equal(second.totalCents, 1250);
	assert.equal(second.itemCount, 1, "falls back to lineItemTitles.length");
});

test("extractOrders rounds decimal-string amounts to integer cents without float drift", () => {
	const cache = synthCache({
		"Order:1": {
			id: "gid://shopify/Order/1",
			effectiveTotalPrice: { amount: "19.999", currencyCode: "USD" },
		},
	});
	const [order] = extractOrders(cache);
	assert.equal(order?.totalCents, 2000);
});

test("extractOrders returns null totalCents and currency when price is absent (never guesses)", () => {
	const cache = synthCache({
		"Order:1": { id: "gid://shopify/Order/1" },
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

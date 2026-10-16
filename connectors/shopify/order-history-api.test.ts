// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shop serves order history on shop.com from a JSON endpoint, not an Apollo
 * cache. These tests drive the reshaping of that endpoint's replies and the
 * paging reader with synthetic replies shaped like the live ones
 * (`deliveriesOrdersList.{nodes, pageInfo}`), and prove what may and may not
 * claim a complete history.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createOrderHistoryApiReader,
	type OrderHistoryApiReply,
	orderHistoryPagesToCache,
	readOrderHistoryConnection,
} from "./order-history-api.ts";
import {
	extractOrdersWithCoverage,
	hasNextOrdersPage,
	hasOrderCountMismatch,
	hasVerifiedOrdersEnd,
} from "./parsers.ts";

const ORDER_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const ORDER_B = "22222222-bbbb-4bbb-8bbb-222222222222";
const ORDER_C = "33333333-cccc-4ccc-8ccc-333333333333";

function orderNode(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		__typename: "Order",
		id,
		createdAt: "2026-01-15T10:00:00Z",
		displayStatus: "paid",
		effectiveTotalPrice: { __typename: "MoneyV2", amount: "0.0", currencyCode: "USD" },
		totalPriceAfterOfferApplied: null,
		totalItemCount: 1,
		shop: { __typename: "Shop", name: "Example Shop" },
		lineItems: { __typename: "LineItemConnection", nodes: [{ __typename: "LineItem", productTitle: "Example Item" }] },
		...overrides,
	};
}

function reply(
	nodes: unknown[],
	pageInfo: { hasNextPage: boolean; endCursor?: string | null },
	extra: Record<string, unknown> = {},
): OrderHistoryApiReply {
	return {
		status: 200,
		body: {
			deliveriesOrdersList: {
				__typename: "DeliveriesOrdersListConnection",
				nodes,
				pageInfo: { __typename: "PageInfo", endCursor: null, ...pageInfo },
				...extra,
			},
			accounts: [],
		},
	};
}

function pagesOf(...replies: OrderHistoryApiReply[]) {
	let after: string | null = null;
	return replies.map((entry) => {
		const connection = readOrderHistoryConnection(entry);
		assert.ok(connection, "fixture reply must be readable");
		const page = { after, connection };
		after = typeof connection.pageInfo.endCursor === "string" ? connection.pageInfo.endCursor : null;
		return page;
	});
}

test("one order with a terminal pageInfo is read and proves the end of the list", () => {
	const cache = orderHistoryPagesToCache(pagesOf(reply([orderNode(ORDER_A)], { hasNextPage: false })));
	const coverage = extractOrdersWithCoverage(cache);
	assert.deepEqual(coverage.orders.map((order) => [order.id, order.totalCents, order.currency, order.merchantName]), [
		[ORDER_A, 0, "USD", "Example Shop"],
	]);
	assert.deepEqual(coverage.orders[0]?.lineItemTitles, ["Example Item"]);
	assert.equal(coverage.discardedRows, 0);
	assert.equal(hasVerifiedOrdersEnd(cache), true);
	assert.equal(hasNextOrdersPage(cache), false);
});

test("a cursor chain from the first page to a terminal page proves the end", () => {
	const cache = orderHistoryPagesToCache(pagesOf(
		reply([orderNode(ORDER_A), orderNode(ORDER_B)], { hasNextPage: true, endCursor: "cursor-1" }),
		reply([orderNode(ORDER_C)], { hasNextPage: false }),
	));
	assert.deepEqual(extractOrdersWithCoverage(cache).orders.map((order) => order.id), [ORDER_A, ORDER_B, ORDER_C]);
	assert.equal(hasVerifiedOrdersEnd(cache), true);
});

test("pages that still advertise a next page do not prove the end", () => {
	const cache = orderHistoryPagesToCache(pagesOf(
		reply([orderNode(ORDER_A)], { hasNextPage: true, endCursor: "cursor-1" }),
	));
	assert.equal(extractOrdersWithCoverage(cache).orders.length, 1);
	assert.equal(hasNextOrdersPage(cache), true);
	assert.equal(hasVerifiedOrdersEnd(cache), false);
});

test("a stated total that differs from the orders read is a mismatch, not proof", () => {
	const cache = orderHistoryPagesToCache(pagesOf(
		reply([orderNode(ORDER_A)], { hasNextPage: false }, { totalCount: 2 }),
	));
	assert.equal(extractOrdersWithCoverage(cache).orders.length, 1);
	assert.equal(hasOrderCountMismatch(cache), true);
});

test("a stated total equal to the orders read is not a mismatch", () => {
	const cache = orderHistoryPagesToCache(pagesOf(
		reply([orderNode(ORDER_A)], { hasNextPage: false }, { totalCount: 1 }),
	));
	assert.equal(hasOrderCountMismatch(cache), false);
	assert.equal(hasVerifiedOrdersEnd(cache), true);
});

test("a delivery node contributes the order it belongs to, and a node with no order identity is an unreadable row", () => {
	const cache = orderHistoryPagesToCache(pagesOf(reply([
		{ __typename: "Delivery", id: "delivery-1", order: orderNode(ORDER_A) },
		{ __typename: "Delivery", id: "delivery-2", order: null },
		{ __typename: "Order" },
	], { hasNextPage: false })));
	const coverage = extractOrdersWithCoverage(cache);
	assert.deepEqual(coverage.orders.map((order) => order.id), [ORDER_A]);
	assert.equal(coverage.unidentifiedRows.length, 2);
	assert.equal(coverage.discoveredRows, 3);
});

test("a delivery that repeats an order keeps the fields an earlier node supplied", () => {
	const cache = orderHistoryPagesToCache(pagesOf(reply([
		orderNode(ORDER_A),
		{ __typename: "Delivery", id: "delivery-1", order: { id: ORDER_A } },
	], { hasNextPage: false })));
	assert.deepEqual(extractOrdersWithCoverage(cache).orders.map((order) => order.merchantName), ["Example Shop"]);
});

test("an order whose fields Shop did not return is withheld, not emitted half-read", () => {
	const { totalItemCount: _omitted, ...partial } = orderNode(ORDER_A);
	const coverage = extractOrdersWithCoverage(orderHistoryPagesToCache(pagesOf(reply([partial], { hasNextPage: false }))));
	assert.equal(coverage.orders.length, 0);
	assert.equal(coverage.discardedRows, 1);
});

test("only a 200 reply with a readable connection and no error is a usable page", () => {
	const nodes = [orderNode(ORDER_A)];
	assert.ok(readOrderHistoryConnection(reply(nodes, { hasNextPage: false })));
	assert.equal(readOrderHistoryConnection({ status: 401, body: { error: "UNAUTHORIZED" } }), null);
	assert.equal(readOrderHistoryConnection({ status: 200, body: { error: "UNAUTHORIZED" } }), null);
	assert.equal(readOrderHistoryConnection({ status: 500, body: null }), null);
	assert.equal(readOrderHistoryConnection({ status: 0, body: null }), null);
	assert.equal(readOrderHistoryConnection({ status: 200, body: { deliveriesOrdersList: { nodes } } }), null);
	assert.equal(readOrderHistoryConnection({
		status: 200,
		body: { deliveriesOrdersList: { nodes, pageInfo: { hasNextPage: "no" } } },
	}), null);
});

test("the reader pages from the first page by cursor and stops at the terminal page", async () => {
	const requests: Array<{ after: string | null; pageSize: number }> = [];
	const replies = new Map<string | null, OrderHistoryApiReply>([
		[null, reply([orderNode(ORDER_A)], { hasNextPage: true, endCursor: "cursor-1" })],
		["cursor-1", reply([orderNode(ORDER_B)], { hasNextPage: false })],
	]);
	const reader = createOrderHistoryApiReader({
		fetchPage: async (request) => {
			requests.push(request);
			return replies.get(request.after) ?? { status: 500, body: null };
		},
	});
	const cache = await reader.read();
	assert.ok(cache);
	assert.deepEqual(requests, [{ after: null, pageSize: 10 }, { after: "cursor-1", pageSize: 10 }]);
	assert.equal(hasVerifiedOrdersEnd(cache), true);
	await reader.read();
	assert.equal(requests.length, 2, "a finished walk is not re-fetched");
});

test("the reader returns what it has when its time box is spent and continues on the next read", async () => {
	let clock = 0;
	const reader = createOrderHistoryApiReader({
		readBudgetMs: 100,
		now: () => clock,
		fetchPage: async ({ after }) => {
			clock += 60;
			const index = after === null ? 0 : Number(after.replace("cursor-", ""));
			return reply([orderNode(`order-${String(index)}`)], index >= 3
				? { hasNextPage: false }
				: { hasNextPage: true, endCursor: `cursor-${String(index + 1)}` });
		},
	});
	const first = await reader.read();
	assert.ok(first);
	assert.equal(extractOrdersWithCoverage(first).orders.length, 2);
	assert.equal(hasVerifiedOrdersEnd(first), false);
	clock += 1_000;
	const second = await reader.read();
	assert.ok(second);
	assert.equal(extractOrdersWithCoverage(second).orders.length, 4);
	assert.equal(hasVerifiedOrdersEnd(second), true);
});

test("a failed later page leaves the history unproven but keeps the orders read", async () => {
	const reader = createOrderHistoryApiReader({
		fetchPage: async ({ after }) => after === null
			? reply([orderNode(ORDER_A)], { hasNextPage: true, endCursor: "cursor-1" })
			: { status: 500, body: null },
	});
	const cache = await reader.read();
	assert.ok(cache);
	assert.equal(extractOrdersWithCoverage(cache).orders.length, 1);
	assert.equal(hasVerifiedOrdersEnd(cache), false);
	assert.equal(hasNextOrdersPage(cache), true);
});

test("the reader gives up on an endpoint that never returns a usable first page", async () => {
	let calls = 0;
	const reader = createOrderHistoryApiReader({
		fetchPage: async () => {
			calls += 1;
			return { status: 401, body: { error: "UNAUTHORIZED" } };
		},
	});
	const attempts = [await reader.read(), await reader.read(), await reader.read(), await reader.read(), await reader.read()];
	assert.deepEqual(attempts, [null, null, null, null, null]);
	assert.equal(calls, 3);
});

test("a page that says more exist but repeats its cursor ends the walk unproven", async () => {
	let calls = 0;
	const reader = createOrderHistoryApiReader({
		fetchPage: async () => {
			calls += 1;
			return reply([orderNode(`order-${String(calls)}`)], { hasNextPage: true, endCursor: "cursor-1" });
		},
	});
	const cache = await reader.read();
	assert.ok(cache);
	assert.equal(calls, 2);
	assert.equal(hasVerifiedOrdersEnd(cache), false);
});

test("the page ceiling stops the walk with more pages still advertised", async () => {
	const reader = createOrderHistoryApiReader({
		maxPages: 2,
		fetchPage: async ({ after }) => {
			const index = after === null ? 0 : Number(after.replace("cursor-", ""));
			return reply([orderNode(`order-${String(index)}`)], { hasNextPage: true, endCursor: `cursor-${String(index + 1)}` });
		},
	});
	const cache = await reader.read();
	assert.ok(cache);
	assert.equal(extractOrdersWithCoverage(cache).orders.length, 2);
	assert.equal(hasNextOrdersPage(cache), true);
	assert.equal(hasVerifiedOrdersEnd(cache), false);
});

test("only an empty terminal first page that states no other total proves an empty history", async () => {
	const proves = async (first: OrderHistoryApiReply): Promise<boolean> => {
		const reader = createOrderHistoryApiReader({ fetchPage: async () => first });
		await reader.read();
		return reader.provesEmptyHistory();
	};
	assert.equal(await proves(reply([], { hasNextPage: false })), true);
	assert.equal(await proves(reply([], { hasNextPage: false }, { totalCount: 0 })), true);
	assert.equal(await proves(reply([], { hasNextPage: false }, { totalCount: 3 })), false);
	assert.equal(await proves(reply([], { hasNextPage: true, endCursor: "cursor-1" })), false);
	assert.equal(await proves(reply([orderNode(ORDER_A)], { hasNextPage: false })), false);
	assert.equal(await proves({ status: 401, body: { error: "UNAUTHORIZED" } }), false);
});

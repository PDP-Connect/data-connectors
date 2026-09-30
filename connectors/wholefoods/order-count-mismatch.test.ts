// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One order whose detail item count cannot be reconciled with the search
 * count must not end the run (w28-wf-count: a real run failed on the third of
 * 49 orders, "detail item count 14 did not match search result count 13").
 * The live cause is NOT confirmed; these fixtures are synthetic, derived from
 * the in-store fixture, and only pin the behavior: deliver every order, report
 * the unverifiable ones once with a stable reason code.
 *
 * The integer-quantity fixture covers one hypothesis: an in-store row
 * `Qty: 3 @ $x each` is ONE search row but three units on the detail page.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import * as connector from "./index.ts";
import * as parsers from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { OrderStub } from "./types.ts";

const FIXTURE = readFileSync(
	new URL("./__fixtures__/order-detail-instore-fopo.html", import.meta.url),
	"utf8",
);
/** First fixture row becomes `Qty: 3 @ $6.49 each`: one row, three units. */
const INTEGER_QTY_FIXTURE = FIXTURE.replace("Qty: 1\n", "Qty: 3\n");

function stub(orderId: string, expectedItemCount: number): OrderStub {
	return {
		expectedItemCount,
		orderDateRaw: null,
		orderId,
		orderUrl: `https://www.amazon.com/fopo/order-details?orderID=${orderId}`,
	};
}

function pageServing(htmlByOrder: Record<string, string>): Page {
	let current = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			current = htmlByOrder[new URL(url).searchParams.get("orderID") ?? ""] ?? "";
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => "https://www.amazon.com/fopo/order-details",
	} as unknown as Page;
}

async function runOrders(stubs: OrderStub[], html: Record<string, string>) {
	const harness = makeRecordingEmit(validateRecord);
	await connector.collectOrderStubs({
		credentials: {},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		ordersCursor: openFingerprintCursor(undefined),
		page: pageServing(html),
		progress: () => Promise.resolve(),
		state: {},
		stubs,
		wantsItems: true,
		wantsNutrition: false,
		wantsOrders: true,
	});
	return harness;
}

const A = "111-1111111-1111111";
const B = "222-2222222-2222222";
const C = "333-3333333-3333333";

test("an integer-quantity in-store row is one search row, not three", () => {
	const { items } = parsers.parseOrderDetailDom(INTEGER_QTY_FIXTURE);
	assert.equal(items.length, 3);
	assert.equal(parsers.orderDetailUnitCount(items), 5);
	assert.equal(connector.orderDetailCountsMatch(stub(A, 3), items), true);
	assert.equal(connector.orderDetailCountsMatch(stub(A, 5), items), true);
	assert.equal(connector.orderDetailCountsMatch(stub(A, 4), items), false);
});

test("a count mismatch on order 2 delivers all 3 orders and reports one reason code", async () => {
	const harness = await runOrders([stub(A, 3), stub(B, 9), stub(C, 3)], {
		[A]: FIXTURE,
		[B]: FIXTURE,
		[C]: FIXTURE,
	});
	const orders = harness.emitted.filter((r) => r.stream === "orders");
	assert.deepEqual(
		orders.map((r) => r.data.id),
		[A, B, C],
	);
	assert.equal(harness.emitted.filter((r) => r.stream === "order_items").length, 9);
	const skips = harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT");
	assert.equal(skips.length, 1);
	assert.equal(skips[0]?.reason, connector.ORDER_ITEM_COUNT_UNVERIFIED_REASON);
	assert.equal(skips[0]?.stream, "orders");
	assert.deepEqual(skips[0]?.diagnostics, {
		total_orders: 3,
		unverified_orders: 1,
	});
});

test("a run with matching counts reports no reason code", async () => {
	const harness = await runOrders([stub(A, 3), stub(B, 3)], {
		[A]: FIXTURE,
		[B]: INTEGER_QTY_FIXTURE,
	});
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
	assert.equal(harness.emitted.filter((r) => r.stream === "orders").length, 2);
});

test("a signed-out order page still fails the run", async () => {
	await assert.rejects(
		runOrders([stub(A, 3)], {
			[A]: '<html><form name="signIn"></form></html>',
		}),
		/blocked or signed out/,
	);
});

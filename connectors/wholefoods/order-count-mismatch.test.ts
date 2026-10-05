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
import { afterEach, beforeEach, test } from "node:test";
import type { Page } from "playwright";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import * as connector from "./index.ts";
import * as parsers from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { OrderStub } from "./types.ts";

/** Diagnostic lines written during the current test. */
const diagnostics: string[] = [];
beforeEach(() => {
	diagnostics.length = 0;
	setConnectorDiagnosticSink((line) => {
		diagnostics.push(line);
	});
});
afterEach(() => {
	setConnectorDiagnosticSink(undefined);
});

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
			current =
				htmlByOrder[new URL(url).searchParams.get("orderID") ?? ""] ?? "";
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => "https://www.amazon.com/fopo/order-details",
	} as unknown as Page;
}

async function runOrders(stubs: OrderStub[], html: Record<string, string>) {
	const harness = makeRecordingEmit(validateRecord);
	const progressUpdates: { message: string; details?: unknown }[] = [];
	await connector.collectOrderStubs({
		credentials: {},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		ordersCursor: openFingerprintCursor(undefined),
		page: pageServing(html),
		progress: (message, details) => {
			progressUpdates.push({ message, details });
			return Promise.resolve();
		},
		state: {},
		stubs,
		wantsItems: true,
		wantsNutrition: false,
		wantsOrders: true,
	});
	return { ...harness, progressUpdates };
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

test("a count mismatch on order 2 delivers all 3 orders and reports one progress warning", async () => {
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
	assert.equal(
		harness.emitted.filter((r) => r.stream === "order_items").length,
		9,
	);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
	const warnings = harness.protocolMessages.filter((m) => {
		const progress = m as { type?: string; message?: string };
		return (
			progress.type === "PROGRESS" &&
			progress.message === "Could not confirm the item count for an order"
		);
	}) as unknown as { stream?: string; message?: string }[];
	assert.equal(warnings.length, 1);
	assert.equal(warnings[0]?.stream, "orders");
	assert.equal(
		warnings[0]?.message,
		"Could not confirm the item count for an order",
	);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith(
					"[wholefoods-diagnostic] order_item_count_unverified ",
				) &&
				line.includes(
					`"reason":"${connector.ORDER_ITEM_COUNT_UNVERIFIED_REASON}"`,
				) &&
				line.includes('"search_count":9') &&
				line.includes('"detail_rows":3') &&
				line.includes('"detail_units":3'),
		),
		diagnostics.join("\n"),
	);
	const summaries = harness.progressUpdates.filter((update) =>
		update.message.startsWith("Item counts could not be checked"),
	);
	assert.equal(summaries.length, 1);
	assert.equal(
		summaries[0]?.message,
		"Item counts could not be checked for 1 of 3 Whole Foods orders",
	);
	assert.ok(
		diagnostics.some((line) =>
			line.startsWith(
				'[wholefoods-diagnostic] order_item_counts_unverified_summary {"reason":',
			),
		),
		diagnostics.join("\n"),
	);
	assertUserFacingProgress([
		...harness.protocolMessages,
		...harness.progressUpdates.map((update) => ({
			type: "PROGRESS",
			message: update.message,
		})),
	]);
	assert.deepEqual(summaries[0]?.details, {
		count: 1,
		stream: "orders",
		total: 3,
	});
});

test("an online row without an ASIN keeps its order, omits the item record, and reports PROGRESS", async () => {
	const onlineRow = `<div data-component="purchasedItemsRightGrid">
		<div data-component="itemTitle"><a href="/product/unknown">Unidentified item</a></div>
		<div data-component="unitPrice">$4.99</div>
	</div>`;
	const onlineStub = {
		...stub(A, 1),
		orderUrl: `https://www.amazon.com/your-orders/order-details?orderID=${A}`,
	};
	const harness = await runOrders([onlineStub, stub(B, 3)], {
		[A]: onlineRow,
		[B]: FIXTURE,
	});
	const orders = harness.emitted.filter((record) => record.stream === "orders");
	const itemRecords = harness.emitted.filter(
		(record) => record.stream === "order_items",
	);
	assert.deepEqual(
		orders.map((record) => record.data.id),
		[A, B],
	);
	assert.equal(orders[0]?.data.item_count, 1);
	assert.equal(orders[0]?.data.total_cents, 499);
	assert.equal(itemRecords.length, 3);
	assert.ok(itemRecords.every((record) => record.data.order_id === B));
	const warning = harness.protocolMessages.find((message) => {
		const progress = message as { type?: string; message?: string };
		return progress.message?.includes("had no product ID");
	}) as { message?: string; stream?: string; type?: string } | undefined;
	assert.equal(warning?.type, "PROGRESS");
	assert.equal(warning?.stream, "orders");
	assert.equal(
		warning?.message,
		"1 order item(s) had no product ID and were left out",
	);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith("[wholefoods-diagnostic] order_item_asin_missing ") &&
				line.includes(
					`"reason":"${connector.ORDER_ITEM_ASIN_MISSING_REASON}"`,
				) &&
				line.includes('"count":1'),
		),
		diagnostics.join("\n"),
	);
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

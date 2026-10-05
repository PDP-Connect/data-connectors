// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Synthetic `/uff/your-account/order-details` shape based on the scrubbed
 * structural observations in w28-wf-heb.md. The live page had 31 rows, each
 * with a `/dp/` link and image; one row matched Qty text. Product names,
 * ASINs, image paths and prices below are invented. The show-all control is
 * present while all 31 captured rows are already in the fixture.
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
	new URL("./__fixtures__/order-detail-uff.html", import.meta.url),
	"utf8",
);
const ORDER_ID = "000-0000000-0000000";
const STUB: OrderStub = {
	expectedItemCount: 31,
	orderDateRaw: null,
	orderId: ORDER_ID,
	orderUrl: `https://www.amazon.com/uff/your-account/order-details?orderID=${ORDER_ID}`,
};

function pageServing(html: string): Page {
	return {
		content: () => Promise.resolve(html),
		goto: () => Promise.resolve(null),
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => STUB.orderUrl,
	} as unknown as Page;
}

test("delivery detail evidence and readiness match the captured structure", () => {
	assert.match(FIXTURE, /id="item-list-page"/);
	assert.match(FIXTURE, /id="ufpo-show-all-items-link"/);
	assert.doesNotMatch(FIXTURE, /data-component=/);
	assert.equal((FIXTURE.match(/id="[^"]+-item-grid-row"/g) ?? []).length, 31);
	assert.equal(parsers.hasOrderDetailEvidence(FIXTURE), true);
	assert.match(parsers.ORDER_DETAIL_READY_SELECTOR, /#line-items/);
	assert.match(
		parsers.ORDER_DETAIL_READY_SELECTOR,
		/\[id\$="-item-grid-row"\]/,
	);
});

test("parses all 31 delivery rows without clicking show-all and uses online quantity defaults", () => {
	const { items } = parsers.parseOrderDetailDom(FIXTURE);
	assert.equal(items.length, 31);
	assert.equal(items.filter((item) => item.productId).length, 31);
	assert.equal(items.filter((item) => item.imageUrl).length, 31);
	assert.equal(items[0]?.name, "Synthetic grocery item 1");
	assert.equal(items[0]?.productId, "B0TEST0001");
	assert.equal(items[0]?.quantity, 2);
	assert.equal(items[0]?.unitPriceDollars, 4.99);
	assert.equal(items[1]?.quantity, 1);
	assert.equal(items[1]?.unitPriceDollars, 4.99);
	assert.equal(parsers.orderDetailUnitCount(items), 32);
	assert.equal(connector.orderDetailCountsMatch(STUB, items), true);

	const order = connector.buildOrderRecord(STUB, null, items);
	assert.equal(order.item_count, 31);
	assert.equal(order.total_cents, 15968);
	validateRecord("orders", order);
	const records = connector.buildOrderItemRecords(ORDER_ID, items);
	assert.equal(records.length, 31);
	for (const record of records) validateRecord("order_items", record);
});

test("delivery row without a product link remains countable and priced, without an item record", () => {
	const withoutFirstProductLink = FIXTURE.replace(
		'<a class="product-link" href="/dp/B0TEST0001">Synthetic grocery item 1</a>',
		'<span class="product-link">Synthetic grocery item 1</span>',
	);
	const { items } = parsers.parseOrderDetailDom(withoutFirstProductLink);
	assert.equal(items.length, 31);
	assert.equal(items[0]?.productId, null);
	assert.equal(items[0]?.productUrl, null);
	assert.equal(items[0]?.quantity, 2);
	assert.equal(items[0]?.unitPriceDollars, 4.99);
	assert.equal(connector.orderDetailCountsMatch(STUB, items), true);
	assert.equal(connector.buildOrderItemRecords(ORDER_ID, items).length, 30);
});

test("delivery count mismatch keeps the order and reports PROGRESS", async () => {
	const mismatchStub = { ...STUB, expectedItemCount: 33 };
	const harness = makeRecordingEmit(validateRecord);
	await connector.collectOrderStubs({
		credentials: {},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		ordersCursor: openFingerprintCursor(undefined),
		page: pageServing(FIXTURE),
		progress: () => Promise.resolve(),
		state: {},
		stubs: [mismatchStub],
		wantsItems: true,
		wantsNutrition: false,
		wantsOrders: true,
	});
	assert.equal(
		harness.emitted.filter((record) => record.stream === "orders").length,
		1,
	);
	const warning = harness.protocolMessages.find((message) => {
		const progress = message as { type?: string; message?: string };
		return (
			progress.type === "PROGRESS" &&
			progress.message?.startsWith(
				"Could not confirm the item count for an order",
			)
		);
	});
	assert.ok(warning);
	assert.ok(
		diagnostics.some(
			(line) =>
				line.startsWith(
					"[wholefoods-diagnostic] order_item_count_unverified ",
				) &&
				line.includes('"search_count":33') &&
				line.includes('"detail_rows":31') &&
				line.includes('"detail_units":32'),
		),
		diagnostics.join("\n"),
	);
	assertUserFacingProgress(harness.protocolMessages);
});

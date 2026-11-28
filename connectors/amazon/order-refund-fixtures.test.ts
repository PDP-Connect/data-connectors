// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	buildOrderItemRecord,
	mergeOrderItems,
	parseOrderDetailDom,
	parseOrdersListDom,
} from "./parsers.ts";

// Each fixture is one invented order page. The expected pair is what the
// connector must emit for every item: returned only on completed refund
// evidence, and the status text a reader can verify against the page.
const cases = [
	{
		name: "kept",
		status: "Delivered",
		count: 1,
		returned: false,
		refund: "Return or replace items",
	},
	{
		name: "refunded",
		status: "Refunded",
		count: 1,
		returned: true,
		refund: "Refunded",
	},
	{
		name: "return-complete",
		status: "Return complete",
		count: 1,
		returned: true,
		refund: "Return complete",
	},
	{
		name: "refund-issued",
		status: "Refund issued",
		count: 1,
		returned: true,
		refund: "Refund issued",
	},
	{
		name: "return-started",
		status: "Return started",
		count: 1,
		returned: false,
		refund: "Return started",
	},
	{
		name: "cancelled",
		status: "Cancelled",
		count: 1,
		returned: false,
		refund: "Cancelled",
	},
	// One order status cannot say which of three items was refunded, so no
	// item takes the order label.
	{
		name: "multi-refunded",
		status: "Refunded",
		count: 3,
		returned: false,
		refund: null,
	},
] as const;

function recordsFor(example: (typeof cases)[number]) {
	const html = readFileSync(
		new URL(`./fixtures/refund-${example.name}.html`, import.meta.url),
		"utf8",
	);
	const [order] = parseOrdersListDom(html);
	const detail = parseOrderDetailDom(html);
	assert.ok(order);
	assert.ok(detail);
	assert.equal(order.deliveryStatus, example.status);
	assert.equal(detail.items.length, example.count);
	const merged = mergeOrderItems(order, detail);
	assert.equal(merged.length, example.count);
	// The list path passes the order status and the item count both surfaces agree on.
	return merged.map((item) =>
		buildOrderItemRecord(order.orderId, "2024-01-15", item, {
			orderStatus: order.deliveryStatus,
			itemCount: merged.length,
		}),
	);
}

for (const example of cases) {
	test(`Amazon refund markup applies terminal evidence without guessing: ${example.name}`, () => {
		assert.deepEqual(
			recordsFor(example).map(({ returned, refund_status }) => ({
				returned,
				refund_status,
			})),
			Array.from({ length: example.count }, () => ({
				returned: example.returned,
				refund_status: example.refund,
			})),
		);
	});
}

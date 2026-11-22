import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
	buildOrderItemRecord,
	mergeOrderItems,
	parseOrderDetailDom,
	parseOrdersListDom,
} from "./parsers.ts";

const cases = [
	{
		name: "kept",
		status: "Delivered",
		count: 1,
		itemStatus: "Return or replace items",
		current: true,
		expected: false,
	},
	{
		name: "refunded",
		status: "Refunded",
		count: 1,
		itemStatus: null,
		current: false,
		expected: true,
	},
	{
		name: "return-complete",
		status: "Return complete",
		count: 1,
		itemStatus: null,
		current: false,
		expected: true,
	},
	{
		name: "refund-issued",
		status: "Refund issued",
		count: 1,
		itemStatus: null,
		current: false,
		expected: true,
	},
	{
		name: "return-started",
		status: "Return started",
		count: 1,
		itemStatus: null,
		current: false,
		expected: false,
	},
	{
		name: "cancelled",
		status: "Cancelled",
		count: 1,
		itemStatus: null,
		current: false,
		expected: false,
	},
	{
		name: "multi-refunded",
		status: "Refunded",
		count: 3,
		itemStatus: null,
		current: false,
		expected: false,
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
	const records = mergeOrderItems(order, detail).map((item) =>
		buildOrderItemRecord(order.orderId, "2024-01-15", item),
	);
	assert.equal(records.length, example.count);
	return records;
}

for (const example of cases) {
	test(`Amazon refund markup characterizes pinned behavior: ${example.name}`, () => {
		assert.deepEqual(
			recordsFor(example).map(({ returned, refund_status }) => ({
				returned,
				refund_status,
			})),
			Array.from({ length: example.count }, () => ({
				returned: example.current,
				refund_status: example.itemStatus,
			})),
		);
	});

	const name = `Amazon refund markup applies terminal evidence without guessing: ${example.name}`;
	const check = () => {
		assert.deepEqual(
			recordsFor(example).map(({ returned }) => returned),
			Array.from({ length: example.count }, () => example.expected),
		);
	};
	if (example.current === example.expected) {
		test(name, check);
	} else {
		// Fix builds: amazon-item-returned-evidence-1121, amazon-order-level-refund-status-1122.
		test.todo(name);
	}
}

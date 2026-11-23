// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Page } from "playwright";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type EmitDeps,
	emitOrderAndItems,
	recoverPendingOrderItemDetailGaps,
} from "./index.ts";
import { parseOrderDetailDom, parseOrdersListDom } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const DAY = "2024-01-15";

function fixture(name: string) {
	const html = readFileSync(new URL(`./fixtures/refund-${name}.html`, import.meta.url), "utf8");
	const [order] = parseOrdersListDom(html);
	const detail = parseOrderDetailDom(html);
	assert.ok(order);
	assert.ok(detail);
	return { html, order, detail };
}

function recording() {
	const run = makeRecordingEmit(validateRecord);
	const deps: EmitDeps = {
		capture: null, emit: run.emit, emitRecord: run.emitRecord,
		emittedAt: "2026-01-05T00:00:00.000Z", progress: async () => {},
		skipDetail: false, wantsItems: true, wantsOrders: true,
	};
	return { run, deps };
}

for (const [name, returned, refund, count] of [
	["kept", false, "Return or replace items", 1],
	["refunded", true, "Refunded", 1],
	["multi-refunded", false, "Refunded", 3],
] as const) {
	test(`refund evidence reaches emitted order items: ${name}`, async () => {
		const { order, detail } = fixture(name);
		const { run, deps } = recording();
		await emitOrderAndItems(deps, order, detail, DAY);
		const items = run.emitted.filter(({ stream }) => stream === "order_items");
		assert.deepEqual(items.map(({ data }) => [data.returned, data.refund_status]),
			Array.from({ length: count }, () => [returned, refund]));
	});
}

test("emitted order does not include stray page script", async () => {
	const { order, detail } = fixture("kept");
	const { run, deps } = recording();
	// This is text in an already-parsed fixture record, never executed as script.
	const text = "window.dataLayer = {};";
	await emitOrderAndItems(deps, { ...order, deliveryStatus: text },
		{ ...detail, status_detail: text, payment_method_summary: text }, DAY);
	const rows = run.emitted.filter(({ stream }) => stream === "orders");
	assert.equal(rows.length, 1);
	const data = rows[0]!.data;
	assert.equal(data.status_detail, null);
	assert.equal(data.payment_method_summary, null);
	for (const value of Object.values(data)) {
		if (typeof value === "string") assert.doesNotMatch(value, /[{}]|window\./);
	}
});

function detailPage(html: string): Page {
	return new Proxy({}, {
		get(_target, property) {
			if (property === "goto" || property === "waitForSelector") return async () => null;
			if (property === "content") return async () => html;
			if (property === "url") return () => "https://www.amazon.com/gp/your-account/order-details?orderID=fixture";
			throw new Error(`Unexpected fixture page operation: ${String(property)}`);
		},
	}) as Page;
}

test("detail-gap recovery preserves the kept/refunded distinction", async () => {
	for (const [name, returned] of [["kept", false], ["refunded", true]] as const) {
		const { html, order, detail } = fixture(name);
		const { run, deps } = recording();
		const result = await recoverPendingOrderItemDetailGaps(detailPage(html), {
			capture: null, emit: deps.emit, emitRecord: deps.emitRecord,
			detailGaps: [{
				detail_locator: {
					kind: "amazon.order_detail", order_date: DAY, order_id: order.orderId,
					delivery_status: name === "kept" ? "Delivered" : "Refunded",
					item_count: detail.items.length,
				},
				gap_id: "gap-fixture", record_key: order.orderId,
				reference_only: true, status: "pending", stream: "order_items",
			}],
		}, {
			detailAttempts: 0, detailCaptured: false, failedDetailCaptured: false,
			repairAttempted: false, sessionRepairRequired: false, temporaryDetailFailures: 0,
		});
		assert.deepEqual(result, { recovered: 1, stoppedWithPending: false });
		assert.deepEqual(run.emitted.map(({ data }) => data.returned), [returned]);
	}
});

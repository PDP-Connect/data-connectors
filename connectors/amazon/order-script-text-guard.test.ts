import assert from "node:assert/strict";
import test from "node:test";
import {
	buildOrderItemRecord,
	buildOrderRecord,
	cleanEmittedOrder,
	cleanEmittedOrderItem,
	parseOrderDetailDom,
	parseOrdersListDom,
} from "./parsers.ts";

const date = "2026-01-02";
const orderId = "123-4567890-1234567";
const noisy = '<script>{"fixture":true}</script>';
const card = (status: string) => `<div class="order-card">
  <div class="yohtmlc-order-id"><span>${orderId}</span></div>
  <div class="yohtmlc-shipment-status-primaryText">${status}</div>
  <div class="item-box"><div class="yohtmlc-product-title"><a href="/dp/B000000001">Fixture book</a></div></div>
</div>`;
const list = (status: string) => {
	const row = parseOrdersListDom(card(status))[0];
	assert.ok(row);
	return row;
};

test("order emission removes script-like list and UFF delivery statuses without mutating the raw projection", () => {
	const status = "window.fixture=1;" + noisy;
	const raw = buildOrderRecord(
		list(status),
		parseOrderDetailDom(card(status)),
		date,
		date,
	);
	assert.ok(raw.delivery_status);
	assert.equal(cleanEmittedOrder(raw).delivery_status, null);
	assert.equal(cleanEmittedOrder(raw).status_detail, null);
	assert.ok(raw.delivery_status);
	const clean = buildOrderRecord(
		list("Delivered"),
		parseOrderDetailDom(card("Delivered")),
		date,
		date,
	);
	assert.equal(cleanEmittedOrder(clean).delivery_status, "Delivered");
	assert.equal(cleanEmittedOrder(clean).status_detail, "Delivered");
});

test("classic detail strips script-like alerts and payment text but keeps ordinary labels", () => {
	const classic = (text: string) => `<div id="orderDetails">
      <div data-component="alerts">${text}</div>
      <div data-component="viewPaymentPlanSummaryWidget">Payment method ${text}</div>
      <div data-component="purchasedItemsRightGrid">
        <span data-component="itemTitle"><a href="/dp/B000000001">Fixture book</a></span>
        <span data-component="itemReturnEligibility">${text}</span>
      </div>
    </div>`;
	for (const [source, expected] of [
		["window.fixture=1;" + noisy, null],
		["Sample label", "Sample label"],
	] as const) {
		const detail = parseOrderDetailDom(classic(source));
		assert.ok(detail);
		const record = cleanEmittedOrder(
			buildOrderRecord(list("Delivered"), detail, date, date),
		);
		assert.equal(record.status_detail, expected);
		assert.equal(record.payment_method_summary, expected);
		const item = detail.items[0];
		assert.ok(item);
		assert.equal(
			cleanEmittedOrderItem(buildOrderItemRecord(orderId, date, item))
				.refund_status,
			expected,
		);
	}
});

test("FoPo emission checks status and the dedicated payment fields", () => {
	const grocery = (
		status: string,
		brand: string,
	) => `<div id="f3_food_WfmInStoreOrderSummary">
      <span id="wfm-fixture-card-brand">${brand}</span><span id="wfm-fixture-card-tail">1234</span>
    </div><p id="ufpo-order-status-primary">${status}</p>`;
	for (const [status, brand, expectedStatus, expectedMethod] of [
		["window.fixture=1;" + noisy, "window.fixture=1;" + noisy, null, null],
		["Delivered", "Fixture card", "Delivered", "Fixture card ending in 1234"],
	] as const) {
		const detail = parseOrderDetailDom(grocery(status, brand));
		assert.ok(detail);
		const record = cleanEmittedOrder(
			buildOrderRecord(list("Delivered"), detail, date, date),
		);
		assert.equal(record.status_detail, expectedStatus);
		assert.equal(record.payment_method_summary, expectedMethod);
	}
});

test("UFPO emission checks combined statuses, payment and item-status copy", () => {
	const detail = parseOrderDetailDom(`<div class="ufpo-item-list-table">
     <div id="fixture-item-grid-row" class="a-row"><a href="/dp/B000000001">Fixture book</a>
       <span class="ufpo-item-status">window.fixture=1;${noisy}</span>
     </div></div>
     <p id="ufpo-order-status-primary">Delivered</p>
     <p id="ufpo-order-status-secondary">window.fixture=1;${noisy}</p>
     <p class="pmts-payments-instrument-details">Payment method window.fixture=1;${noisy}</p>`);
	assert.ok(detail);
	const record = cleanEmittedOrder(
		buildOrderRecord(list("Delivered"), detail, date, date),
	);
	assert.equal(record.status_detail, null);
	assert.equal(record.payment_method_summary, null);
	const item = detail.items[0];
	assert.ok(item);
	assert.equal(
		cleanEmittedOrderItem(buildOrderItemRecord(orderId, date, item))
			.refund_status,
		null,
	);
});

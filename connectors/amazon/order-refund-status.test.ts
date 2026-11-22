import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveItemReturnState } from "./order-refund-status.ts";

test("return state uses completed evidence, never eligibility or pending order status", () => {
	const cases = [
		[
			"Return or replace items",
			"Delivered",
			1,
			false,
			"Return or replace items",
		],
		["Return window closed", null, 1, false, "Return window closed"],
		["Return started", null, 1, false, "Return started"],
		["Cancelled", null, 1, false, "Cancelled"],
		[" ", "", 1, false, null],
		["Return or replace items", " Refunded ", 1, true, "Refunded"],
		[null, "refund issued", 1, true, "refund issued"],
		[null, "Return Complete", 1, true, "Return Complete"],
		[null, "Refunded today", 1, false, "Refunded today"],
		["Return or replace items", "Refunded", 3, false, "Refunded"],
		[null, "Refund issued", null, false, "Refund issued"],
		[
			"Item returned on Tuesday",
			"Delivered",
			3,
			true,
			"Item returned on Tuesday",
		],
		["Refund issued", "Delivered", 3, true, "Refund issued"],
		["Refunded", "Delivered", 3, true, "Refunded"],
		["Return complete", "Delivered", 3, true, "Return complete"],
		["<script>Refunded</script>", null, 1, false, null],
		["Not returned", "Delivered", 3, false, "Not returned"],
		["Not yet refunded", "Delivered", 3, false, "Not yet refunded"],
		["Not yet returned", "Delivered", 1, false, "Not yet returned"],
		["No refund issued", "Delivered", 1, false, "No refund issued"],
		["Return started", "Delivered", 3, false, "Return started"],
	] as const;
	for (const [
		itemRefundText,
		orderStatus,
		itemCount,
		returned,
		refund_status,
	] of cases) {
		assert.deepEqual(
			deriveItemReturnState({ itemRefundText, orderStatus, itemCount }),
			{ returned, refund_status },
			JSON.stringify({ itemRefundText, orderStatus, itemCount }),
		);
	}
});

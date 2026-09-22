// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { receiptsSchema, tripsSchema, validateRecord } from "./schemas.ts";

const TRIP_RECORD = {
	id: "b3a1c2d4-5e6f-7081-92a3-b4c5d6e7f809",
	status: null,
	requested_at: null,
	completed_at: null,
	pickup_address: null,
	dropoff_address: null,
	fare_total: null,
	fare_total_cents: null,
	product_type: null,
	is_surge: null,
};

const RECEIPT_RECORD = {
	id: "b3a1c2d4-5e6f-7081-92a3-b4c5d6e7f809",
	trip_id: "b3a1c2d4-5e6f-7081-92a3-b4c5d6e7f809",
	status: "COMPLETED",
	requested_at: "2026-01-15T10:00:00.000Z",
	completed_at: "2026-01-15T10:35:24.000Z",
	pickup_address: "Example Straße 1, 10115 Example City",
	dropoff_address: "Example Airport Terminal 1, 12345 Example City",
	driver_name: "Example Driver",
	fare_total: "$47.43",
	fare_total_cents: 4743,
	distance_meters: 29_490,
	duration_seconds: 2100,
	product_type: "UberX",
	is_surge: false,
	fare_breakdown: [
		{ label: "Trip fare", amount_cents: 4095 },
		{ label: "Booking Fee", amount_cents: 200 },
	],
};

test("trips schema accepts a record where every field but id is null (live evidence: the list feed carries no other structured field)", () => {
	const result = tripsSchema.safeParse(TRIP_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("trips schema rejects a missing id", () => {
	const { id, ...rest } = TRIP_RECORD;
	assert.equal(tripsSchema.safeParse(rest).success, false);
});

test("trips schema has no detail-only field (D3: detail lives on receipts)", () => {
	for (const field of [
		"distance_meters",
		"duration_seconds",
		"fare_breakdown",
		"driver_name",
	]) {
		assert.ok(
			!(field in tripsSchema.shape),
			`trips schema must not declare detail-only field ${field}`,
		);
	}
});

test("trips schema does not model a currency field (live evidence: only a currency-symbol-prefixed display string exists)", () => {
	assert.ok(!("currency" in tripsSchema.shape));
});

test("receipts schema accepts a fully populated record", () => {
	const result = receiptsSchema.safeParse(RECEIPT_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("receipts schema accepts an all-null/empty unhydrated detail", () => {
	const result = receiptsSchema.safeParse({
		...RECEIPT_RECORD,
		status: null,
		requested_at: null,
		completed_at: null,
		pickup_address: null,
		dropoff_address: null,
		driver_name: null,
		fare_total: null,
		fare_total_cents: null,
		distance_meters: null,
		duration_seconds: null,
		product_type: null,
		is_surge: null,
		fare_breakdown: [],
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("receipts schema rejects a missing trip_id", () => {
	const { trip_id, ...rest } = RECEIPT_RECORD;
	assert.equal(receiptsSchema.safeParse(rest).success, false);
});

test("receipts schema rejects a fare_breakdown line with no label", () => {
	assert.equal(
		receiptsSchema.safeParse({
			...RECEIPT_RECORD,
			fare_breakdown: [{ amount_cents: 100 }],
		}).success,
		false,
	);
});

test("validateRecord routes trips and receipts and passes unknown streams through", () => {
	assert.equal(validateRecord("trips", TRIP_RECORD).ok, true);
	assert.equal(validateRecord("receipts", RECEIPT_RECORD).ok, true);
	assert.equal(validateRecord("eats_orders", { id: "x" }).ok, true);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activityTripId,
	parseCurrencyCents,
	parseCurrencyCode,
	parseDistanceMeters,
	parseDurationSeconds,
	parseFareBreakdown,
	parseIsoDateTime,
	receiptRecord,
	tripRecord,
} from "./parsers.ts";
import type { UberActivity, UberReceiptSummary, UberTrip } from "./types.ts";

test("parseCurrencyCents: parses a plain dollar string", () => {
	assert.equal(parseCurrencyCents("$18.42"), 1842);
});

test("parseCurrencyCents: parses a non-USD currency-symbol string", () => {
	assert.equal(parseCurrencyCents("CHF21.31"), 2131);
	assert.equal(parseCurrencyCents("€40.95"), 4095);
});

test("parseCurrencyCents: parses a comma-thousands string", () => {
	assert.equal(parseCurrencyCents("$1,234.56"), 123_456);
});

test("parseCurrencyCents: parses a negative (promotion/refund) string", () => {
	assert.equal(parseCurrencyCents("-$4.50"), -450);
	assert.equal(parseCurrencyCents("-€6.44"), -644);
});

test("parseCurrencyCents: returns null for empty/unparseable input", () => {
	assert.equal(parseCurrencyCents(""), null);
	assert.equal(parseCurrencyCents(null), null);
	assert.equal(parseCurrencyCents("Unable to display"), null);
});

test("parseCurrencyCode: resolves a known currency symbol", () => {
	assert.equal(parseCurrencyCode("$18.42"), "USD");
	assert.equal(parseCurrencyCode("€40.95"), "EUR");
	assert.equal(parseCurrencyCode("CHF21.31"), "CHF");
});

test("parseCurrencyCode: returns null for an unrecognized or missing symbol", () => {
	assert.equal(parseCurrencyCode("18.42"), null);
	assert.equal(parseCurrencyCode(null), null);
	assert.equal(parseCurrencyCode(""), null);
});

test("parseIsoDateTime: normalizes an ISO-8601 string", () => {
	assert.equal(
		parseIsoDateTime("2026-05-01T18:00:00Z"),
		"2026-05-01T18:00:00.000Z",
	);
});

test("parseIsoDateTime: normalizes GetTrip's Date.toString() format", () => {
	assert.equal(
		parseIsoDateTime(
			"Thu Jan 15 2026 10:00:00 GMT+0000 (Coordinated Universal Time)",
		),
		"2026-01-15T10:00:00.000Z",
	);
});

test("parseIsoDateTime: returns null for unparseable input", () => {
	assert.equal(parseIsoDateTime("not a date"), null);
	assert.equal(parseIsoDateTime(null), null);
});

test("parseDistanceMeters: converts kilometers to meters", () => {
	assert.equal(parseDistanceMeters("29.49", "kilometers"), 29_490);
});

test("parseDistanceMeters: converts miles to meters", () => {
	assert.equal(parseDistanceMeters("10", "miles"), 16_093.44);
});

test("parseDistanceMeters: returns null for an unrecognized unit", () => {
	assert.equal(parseDistanceMeters("10", "furlongs"), null);
	assert.equal(parseDistanceMeters("10", null), null);
});

test("parseDistanceMeters: returns null for unparseable input", () => {
	assert.equal(parseDistanceMeters(null, "kilometers"), null);
	assert.equal(parseDistanceMeters("not a number", "kilometers"), null);
});

test("parseDurationSeconds: parses a minutes-only display string", () => {
	assert.equal(parseDurationSeconds("35 minutes"), 2100);
});

test("parseDurationSeconds: parses an hours-and-minutes display string", () => {
	assert.equal(parseDurationSeconds("1 hour 12 minutes"), 4320);
});

test("parseDurationSeconds: returns null for empty/unparseable input", () => {
	assert.equal(parseDurationSeconds(null), null);
	assert.equal(parseDurationSeconds(""), null);
	assert.equal(parseDurationSeconds("unavailable"), null);
});

test("activityTripId: prefers the uuid field", () => {
	const activity: UberActivity = { uuid: "abc-123" };
	assert.equal(activityTripId(activity), "abc-123");
});

test("activityTripId: falls back to the Details button URL", () => {
	const activity: UberActivity = {
		buttons: [{ url: "https://riders.uber.com/trips/def-456" }],
	};
	assert.equal(activityTripId(activity), "def-456");
});

test("activityTripId: returns null with no usable identity", () => {
	assert.equal(activityTripId({}), null);
});

test("tripRecord: builds a full trips record from GetTrip's trip + receipt", () => {
	const trip: UberTrip = {
		beginTripTime:
			"Thu Jan 15 2026 10:00:00 GMT+0000 (Coordinated Universal Time)",
		dropoffTime:
			"Thu Jan 15 2026 10:35:24 GMT+0000 (Coordinated Universal Time)",
		driver: "Example Driver",
		fare: "€41.36",
		isSurgeTrip: false,
		status: "COMPLETED",
		vehicleDisplayName: "",
		waypoints: [
			"Example Straße 1, 10115 Example City",
			"Example Airport Terminal 1, 12345 Example City",
		],
	};
	const receipt: UberReceiptSummary = {
		distance: "29.49",
		distanceLabel: "kilometers",
		duration: "35 minutes",
		vehicleType: "UberX",
	};
	const record = tripRecord("trip-1", trip, receipt);
	assert.ok(record);
	assert.equal(record.id, "trip-1");
	assert.equal(record.status, "COMPLETED");
	assert.equal(record.requested_at, "2026-01-15T10:00:00.000Z");
	assert.equal(record.completed_at, "2026-01-15T10:35:24.000Z");
	assert.equal(record.pickup_address, "Example Straße 1, 10115 Example City");
	assert.equal(
		record.dropoff_address,
		"Example Airport Terminal 1, 12345 Example City",
	);
	assert.equal(record.driver_name, "Example Driver");
	assert.equal(record.fare_total, "€41.36");
	assert.equal(record.fare_total_cents, 4136);
	assert.equal(record.distance_meters, 29_490);
	assert.equal(record.duration_seconds, 2100);
	assert.equal(record.distance_display, "29.49 kilometers");
	assert.equal(record.duration_display, "35 minutes");
	assert.equal(record.product_type, "UberX");
	assert.equal(record.is_surge, false);
	// Detail-only fields that belong to receipts must never appear here (D3).
	assert.ok(!("fare_breakdown" in record));
	assert.ok(!("currency" in record));
});

test("tripRecord: falls back to vehicleDisplayName when receipt carries no vehicleType", () => {
	const record = tripRecord(
		"trip-2",
		{ vehicleDisplayName: "UberX" },
		undefined,
	);
	assert.ok(record);
	assert.equal(record.product_type, "UberX");
});

test("tripRecord: nulls every field cleanly with no trip evidence beyond an id", () => {
	const record = tripRecord("trip-3", {}, undefined);
	assert.ok(record);
	assert.equal(record.status, null);
	assert.equal(record.requested_at, null);
	assert.equal(record.completed_at, null);
	assert.equal(record.pickup_address, null);
	assert.equal(record.dropoff_address, null);
	assert.equal(record.driver_name, null);
	assert.equal(record.fare_total, null);
	assert.equal(record.fare_total_cents, null);
	assert.equal(record.distance_meters, null);
	assert.equal(record.duration_seconds, null);
	assert.equal(record.distance_display, null);
	assert.equal(record.duration_display, null);
	assert.equal(record.product_type, null);
	assert.equal(record.is_surge, null);
});

test("tripRecord: returns null when GetTrip produced no trip at all", () => {
	assert.equal(tripRecord("trip-4", undefined, undefined), null);
});

test("parseFareBreakdown: extracts label/amount pairs by data-testid, ignoring unrelated HTML", () => {
	const html = `<div class="fare-breakdown-wrapper"><div class="fare-breakdown-item"><span data-testid="fare_line_item_label_trip_fare" class="fare-breakdown-name">Trip fare</span><span data-testid="fare_line_item_amount_trip_fare" class="fare-breakdown-amount">€40.95</span></div><div class="fare-breakdown-item"><span data-testid="fare_line_item_label_promotion" class="fare-breakdown-name">Promotion</span><span data-testid="fare_line_item_amount_promotion" class="fare-breakdown-amount">-€6.44</span></div></div><div class="unrelated"><span>Not a fare line</span></div>`;
	const lines = parseFareBreakdown(html);
	assert.deepEqual(lines, [
		{ amountRaw: "€40.95", label: "Trip fare", slug: "trip_fare" },
		{ amountRaw: "-€6.44", label: "Promotion", slug: "promotion" },
	]);
});

test("parseFareBreakdown: returns an empty array for missing/empty input", () => {
	assert.deepEqual(parseFareBreakdown(null), []);
	assert.deepEqual(parseFareBreakdown(""), []);
	assert.deepEqual(parseFareBreakdown("<html>no fare lines here</html>"), []);
});

test("receiptRecord: builds a full detail record from fare_breakdown lines", () => {
	const fareBreakdown = [
		{ amountRaw: "€40.95", label: "Trip fare", slug: "trip_fare" },
		{ amountRaw: "€2.00", label: "Booking Fee", slug: "booking_fee" },
		{ amountRaw: "€4.30", label: "Tip", slug: "tip" },
		{ amountRaw: "-€6.44", label: "Promotion", slug: "promotion" },
		{
			amountRaw: "$0.64",
			label: "Currency conversion fee",
			slug: "currency_conversion_fee",
		},
		{ amountRaw: "$47.43", label: "Fare total", slug: "fare_total" },
	];
	const record = receiptRecord("trip-1", fareBreakdown);
	assert.ok(record);
	// Regression: connector-runtime.ts's emitRecord silently no-ops when
	// `data.id` is missing, regardless of the manifest's declared
	// primary_key — a real bug caught on this connector's first live run
	// (2026-09-22) where every receipts RECORD was silently dropped.
	assert.equal(record.id, "trip-1");
	assert.equal(record.trip_id, "trip-1");
	// fare_total's own line — the settled/converted total — is the source of truth.
	assert.equal(record.fare_total, "$47.43");
	assert.equal(record.fare_total_cents, 4743);
	assert.equal(record.currency, "USD");
	// fare_total's own line is excluded from the itemized breakdown (it IS the total).
	assert.deepEqual(record.fare_breakdown, [
		{ label: "Trip fare", amount_cents: 4095 },
		{ label: "Booking Fee", amount_cents: 200 },
		{ label: "Tip", amount_cents: 430 },
		{ label: "Promotion", amount_cents: -644 },
		{ label: "Currency conversion fee", amount_cents: 64 },
	]);
});

test("receiptRecord: uses the hydrated trip fare when the receipt has no total line", () => {
	const record = receiptRecord("trip-2", [
		{ amountRaw: "$2.00", label: "Booking Fee", slug: "booking_fee" },
	], "$42.00");
	assert.ok(record);
	assert.equal(record.fare_total, "$42.00");
	assert.equal(record.fare_total_cents, 4200);
	assert.equal(record.currency, "USD");
	assert.deepEqual(record.fare_breakdown, [
		{ label: "Booking Fee", amount_cents: 200 },
	]);
});

test("receiptRecord: returns null with no fare-breakdown evidence at all", () => {
	assert.equal(receiptRecord("trip-3", []), null);
});

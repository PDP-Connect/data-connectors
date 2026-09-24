// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Uber connector. No fetch / Node I/O / Playwright here
 * so they can be unit-tested offline (see parsers.test.ts). The GraphQL
 * fetch, session handling, and pagination loop live in index.ts.
 *
 * Ground truth: a real live session captured 2026-09-22 (see the connector
 * cutover report's "Live evidence" section and capability-map.json's
 * `lead_decision_live` for uber). The Activities list feed carries only a
 * trip UUID — no structured date, status, currency, address, or
 * vehicle-type field. Every field the capability map's `uber.trips`
 * field_map declared is therefore hydrated per-trip from `GetTrip`
 * (`tripRecord`), not read off the list row. `GetReceipt`'s `receiptData`
 * HTML supplies the itemized fare breakdown consumed by `receiptRecord`.
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type {
	UberActivity,
	UberFareBreakdownLine,
	UberGetTripResponse,
	UberReceiptSummary,
	UberTrip,
} from "./types.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const CURRENCY_NUMBER_RE = /(\d+(?:\.\d+)?)/;
const CURRENCY_NEGATIVE_SIGN_RE = /^-|\(.*\)$/;
const CURRENCY_THOUSANDS_RE = /,/g;
const CENTS_MULTIPLIER = 100;
const TRIP_URL_UUID_RE = /\/trips\/([a-f0-9-]+)/i;
const FARE_LINE_ITEM_RE =
	/data-testid="fare_line_item_label_([a-z0-9_]+)"[^>]*>([^<]+)<[\s\S]*?data-testid="fare_line_item_amount_\1"[^>]*>([^<]+)</g;
const CURRENCY_SYMBOL_RE = /^\s*(\$|€|£|CHF|¥)/;
const CURRENCY_SYMBOL_TO_CODE: Record<string, string> = {
	$: "USD",
	"€": "EUR",
	"£": "GBP",
	CHF: "CHF",
	"¥": "JPY",
};

/** "$18.42" / "-$4.50" / "(4.50)" / "CHF21.31" / "€40.95" -> integer cents. Null on unparseable input — never guessed. */
export function parseCurrencyCents(
	raw: string | null | undefined,
): number | null {
	if (!raw) {
		return null;
	}
	const s = String(raw);
	const negative = CURRENCY_NEGATIVE_SIGN_RE.test(s);
	const stripped = s.replace(CURRENCY_THOUSANDS_RE, "");
	const m = stripped.match(CURRENCY_NUMBER_RE);
	if (!m?.[1]) {
		return null;
	}
	const cents = Math.round(Number(m[1]) * CENTS_MULTIPLIER);
	return negative ? -cents : cents;
}

/**
 * A currency-symbol-prefixed display string ("$18.42", "CHF21.31", "€40.95")
 * -> an ISO 4217 code, from the closed symbol table observed live. Null for
 * an unrecognized or ambiguous symbol (e.g. a bare "$" cannot itself
 * disambiguate USD/CAD/AUD) — never guessed.
 */
export function parseCurrencyCode(
	raw: string | null | undefined,
): string | null {
	if (!raw) {
		return null;
	}
	const m = String(raw).match(CURRENCY_SYMBOL_RE);
	if (!m?.[1]) {
		return null;
	}
	return CURRENCY_SYMBOL_TO_CODE[m[1]] ?? null;
}

/**
 * ISO-8601 passthrough with validation; null on unparseable input.
 * Handles both ISO strings and `GetTrip`'s JS `Date.toString()` format
 * ("Tue Sep 08 2026 02:09:32 GMT+0000 ...") — `new Date(...)` parses both.
 */
export function parseIsoDateTime(
	raw: string | null | undefined,
): string | null {
	if (!raw) {
		return null;
	}
	const d = new Date(raw);
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	return d.toISOString();
}

/** Extract the trip UUID from an activity, falling back to the Details button URL. */
export function activityTripId(activity: UberActivity): string | null {
	if (activity.uuid) {
		return activity.uuid;
	}
	for (const btn of activity.buttons ?? []) {
		const m = (btn.url ?? "").match(TRIP_URL_UUID_RE);
		if (m?.[1]) {
			return m[1];
		}
	}
	return null;
}

const KILOMETERS_TO_METERS = 1000;
const MILES_TO_METERS = 1609.344;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const DURATION_HOURS_RE = /(\d+)\s*hour/i;
const DURATION_MINUTES_RE = /(\d+)\s*min/i;

/** "29.49" + "kilometers"|"miles" -> meters. Null on an unrecognized unit or unparseable number — never guessed. */
export function parseDistanceMeters(
	distance: string | null | undefined,
	unitLabel: string | null | undefined,
): number | null {
	if (!distance) {
		return null;
	}
	const value = Number(distance);
	if (Number.isNaN(value)) {
		return null;
	}
	if (unitLabel === "kilometers") {
		return value * KILOMETERS_TO_METERS;
	}
	if (unitLabel === "miles") {
		return value * MILES_TO_METERS;
	}
	return null;
}

/** "35 minutes" / "1 hour 12 minutes" -> seconds. Null when neither an hour nor a minute component is found. */
export function parseDurationSeconds(
	duration: string | null | undefined,
): number | null {
	if (!duration) {
		return null;
	}
	const hoursMatch = duration.match(DURATION_HOURS_RE);
	const minutesMatch = duration.match(DURATION_MINUTES_RE);
	if (!(hoursMatch || minutesMatch)) {
		return null;
	}
	const hours = hoursMatch?.[1] ? Number(hoursMatch[1]) : 0;
	const minutes = minutesMatch?.[1] ? Number(minutesMatch[1]) : 0;
	return hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE;
}

/**
 * `trips` record for one trip, hydrated from `GetTrip`'s `trip`/`receipt`
 * (D5 revised per capability-map.json's `lead_decision_live`: the Activities
 * list carries only a trip id, so every other field comes from GetTrip, not
 * the list row). Returns null when GetTrip produced no usable trip — the
 * caller records that trip as an unhydrated key rather than emitting a
 * mostly-null record.
 */
export function tripRecord(
	tripId: string,
	trip: UberTrip | undefined,
	receiptSummary: UberReceiptSummary | undefined,
): RecordData | null {
	if (!trip) {
		return null;
	}
	const waypoints = trip.waypoints ?? [];
	return {
		id: tripId,
		status: trip.status ?? null,
		requested_at: parseIsoDateTime(trip.beginTripTime),
		completed_at: parseIsoDateTime(trip.dropoffTime),
		pickup_address: waypoints[0] ?? null,
		dropoff_address:
			waypoints.length > 0 ? waypoints[waypoints.length - 1] : null,
		driver_name: trip.driver || null,
		fare_total: trip.fare ?? null,
		fare_total_cents: parseCurrencyCents(trip.fare),
		distance_meters: parseDistanceMeters(
			receiptSummary?.distance,
			receiptSummary?.distanceLabel,
		),
		duration_seconds: parseDurationSeconds(receiptSummary?.duration),
		distance_display:
			typeof receiptSummary?.distance === "string" &&
			typeof receiptSummary.distanceLabel === "string" &&
			["kilometers", "miles"].includes(receiptSummary.distanceLabel)
				? `${receiptSummary.distance} ${receiptSummary.distanceLabel}`
				: null,
		duration_display:
			typeof receiptSummary?.duration === "string"
				? receiptSummary.duration
				: null,
		product_type:
			receiptSummary?.vehicleType || trip.vehicleDisplayName || null,
		is_surge: trip.isSurgeTrip ?? null,
	};
}

/** Extract `{label, amountCents}` fare-breakdown lines from a GetReceipt `receiptData` HTML blob via structural `data-testid` attributes (never text-regex over rendered content — see authoring guide §2). */
export function parseFareBreakdown(
	receiptDataHtml: string | null | undefined,
): UberFareBreakdownLine[] {
	if (!receiptDataHtml) {
		return [];
	}
	const lines: UberFareBreakdownLine[] = [];
	for (const m of receiptDataHtml.matchAll(FARE_LINE_ITEM_RE)) {
		const slug = m[1];
		const label = m[2]?.trim();
		const amountRaw = m[3]?.trim();
		if (slug && label && amountRaw) {
			lines.push({ amountRaw, label, slug });
		}
	}
	return lines;
}

/**
 * 1:1 `receipts` record per trip, built entirely from the fare-breakdown
 * lines parsed out of `GetReceipt`'s HTML blob (fare_breakdown, currency,
 * and the receipt's headline total) — see capability-map.json's
 * `uber.receipts` field_map. Returns null when `GetReceipt` produced no
 * fare-breakdown evidence at all (neither a total line nor any itemized
 * line) — an honest "not hydrated" signal, not a record of all nulls.
 */
export function receiptRecord(
	tripId: string,
	fareBreakdown: UberFareBreakdownLine[],
	tripFare?: string | null,
): RecordData {
	const totalLine = fareBreakdown.find((l) => l.slug === "fare_total");
	const breakdownLines = fareBreakdown.filter((l) => l.slug !== "fare_total");
	// GetReceipt often exposes only itemized lines. GetTrip's fare is the
	// same headline value the legacy trip-detail page exposed, so use it when
	// the receipt HTML has no explicit total line.
	const fareRaw = totalLine?.amountRaw ?? tripFare ?? null;
	return {
		// The runtime's emit gate requires a literal `id` field regardless of
		// the manifest's declared `primary_key` (see connector-runtime.ts's
		// makeEmitRecord: `data.id == null` silently no-ops the emit) — a
		// production bug caught on this connector's first live run (2026-09-22,
		// see the connector cutover report's "Live evidence" section): every
		// receipts RECORD was silently dropped because this field was missing.
		id: tripId,
		trip_id: tripId,
		currency: parseCurrencyCode(fareRaw),
		fare_total: fareRaw,
		fare_total_cents: parseCurrencyCents(fareRaw),
		fare_breakdown: breakdownLines.map((l) => ({
			label: l.label,
			amount_cents: parseCurrencyCents(l.amountRaw),
		})),
	};
}

// Kept for parsers.test.ts's direct exercising of the GetTrip response shape.
export type { UberGetTripResponse };

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure parsers for the Uber connector. No fetch / Node I/O / Playwright here
 * so they can be unit-tested offline (see parsers.test.ts). The GraphQL
 * fetch, session handling, and pagination loop live in index.ts.
 *
 * Ground truth: a real live session captured 2026-09-22 (see the connector
 * cutover report's "Live evidence" section). The Activities list feed
 * carries NO structured date, status, currency, or vehicle-type field —
 * only `title` (destination name), `subtitle` (a no-year display
 * date/time), and `description` (a currency-prefixed fare display
 * string). Every field capability-map.json's `uber.trips` field_map
 * mapped to `trips.status` / `.requested_at` / `.completed_at` /
 * `.pickup_address` / `.dropoff_address` / `.fare_total_cents` /
 * `.currency` / `.product_type` / `.city` / `.is_surge` is, in reality,
 * ONLY available from the per-trip GetTrip/GetReceipt detail calls — see
 * the connector cutover report's CONTRACT-CHANGE-REQUEST. `tripRecord`
 * therefore emits those fields as `null` (honest: the list genuinely does
 * not carry them), and `receiptRecord` carries the real values.
 */

import type { RecordData } from "../../src/connector-runtime.ts";
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

/**
 * List-level `trips` record from one Activities GraphQL activity row.
 * The list feed does not carry status, a parseable date, an address split,
 * currency, product type, city, or a surge flag (see module doc) — those
 * fields are declared `null` here, honestly, not guessed from `subtitle`'s
 * no-year display string or `description`'s currency-prefixed fare text.
 */
export function tripRecord(activity: UberActivity): RecordData | null {
	const id = activityTripId(activity);
	if (!id) {
		return null;
	}
	return {
		id,
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
 * 1:1 `receipts` record per trip, built from `GetTrip`'s `trip`/`receipt`
 * plus the fare-breakdown lines parsed from `GetReceipt`'s HTML blob.
 * Every non-`fare_total` line makes up `fare_breakdown`; the `fare_total`
 * line (when present) supplies the receipt's headline amount, since
 * `trip.fare` can reflect a different (pre-conversion) currency than the
 * settled total — see `UberGetReceiptResponse`'s doc on mixed-currency
 * receipts.
 */
export function receiptRecord(
	tripId: string,
	trip: UberTrip | undefined,
	receiptSummary: UberReceiptSummary | undefined,
	fareBreakdown: UberFareBreakdownLine[],
): RecordData {
	const totalLine = fareBreakdown.find((l) => l.slug === "fare_total");
	const fareRaw = totalLine?.amountRaw ?? trip?.fare ?? null;
	const breakdownLines = fareBreakdown.filter((l) => l.slug !== "fare_total");
	const waypoints = trip?.waypoints ?? [];
	return {
		// The runtime's emit gate requires a literal `id` field regardless of
		// the manifest's declared `primary_key` (see connector-runtime.ts's
		// makeEmitRecord: `data.id == null` silently no-ops the emit) — a
		// production bug caught on this connector's first live run (2026-09-22,
		// see the connector cutover report's "Live evidence" section): every
		// receipts RECORD was silently dropped because this field was missing.
		id: tripId,
		trip_id: tripId,
		status: trip?.status ?? null,
		requested_at: parseIsoDateTime(trip?.beginTripTime),
		completed_at: parseIsoDateTime(trip?.dropoffTime),
		pickup_address: waypoints[0] ?? null,
		dropoff_address:
			waypoints.length > 0 ? waypoints[waypoints.length - 1] : null,
		driver_name: trip?.driver || null,
		fare_total: fareRaw,
		fare_total_cents: parseCurrencyCents(fareRaw),
		distance_meters: parseDistanceMeters(
			receiptSummary?.distance,
			receiptSummary?.distanceLabel,
		),
		duration_seconds: parseDurationSeconds(receiptSummary?.duration),
		product_type:
			receiptSummary?.vehicleType || trip?.vehicleDisplayName || null,
		is_surge: trip?.isSurgeTrip ?? null,
		fare_breakdown: breakdownLines.map((l) => ({
			label: l.label,
			amount_cents: parseCurrencyCents(l.amountRaw),
		})),
	};
}

// Kept for parsers.test.ts's direct exercising of the GetTrip response shape.
export type { UberGetTripResponse };

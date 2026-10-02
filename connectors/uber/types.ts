// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Wire shapes for riders.uber.com's Activities/GetTrip/GetReceipt GraphQL
 * operations. Ground truth: a real live session captured 2026-09-22 (see
 * the connector cutover report's "Live evidence" section). Field names
 * below are the REAL response shapes observed against a live account —
 * `operationName: "Activities"` / `"GetTrip"` / `"GetReceipt"` and the
 * `nextPageToken` cursor are all confirmed correct.
 */

export interface UberActivityButton {
	url?: string;
}

/**
 * One row from `data.activities.past.activities[]`. The list feed carries
 * NO structured date, status, currency, or vehicle-type field — only a
 * human-display `subtitle` ("Sep 8 • 3:58 AM", no year) and `description`
 * (a currency-prefixed fare string, sometimes suffixed " • N stop(s)").
 * `title` is the trip's destination/place name, not a full address. The
 * list feed's only durable use here is discovering trip identity for the
 * `GetTrip`/`GetReceipt` detail fetches — see the connector cutover
 * report's "lead_decision_live" revision to D5.
 */
export interface UberActivity {
	uuid?: string;
	title?: string;
	subtitle?: string;
	description?: string;
	cardURL?: string;
	buttons?: UberActivityButton[];
}

export interface UberActivitiesPage {
	activities?: UberActivity[];
	nextPageToken?: string | null;
}

export interface UberActivitiesResponse {
	data?: {
		activities?: {
			past?: UberActivitiesPage;
		};
	};
}

/**
 * `data.getTrip.trip` from the `GetTrip` operation. `beginTripTime`/
 * `dropoffTime` are JavaScript `Date.prototype.toString()` output
 * ("Tue Sep 08 2026 02:09:32 GMT+0000 (Coordinated Universal Time)") — not
 * ISO-8601, but `new Date(...)` parses it correctly. `waypoints` is an
 * ordered array of address strings: first is pickup, last is dropoff (no
 * separate pickup/dropoff fields or coordinates). `fare` is a
 * currency-symbol-prefixed display string, not split into amount+currency.
 * `cityID`/`countryID` are opaque numeric IDs, not names — not exposed as
 * a `city` string without a lookup table this connector does not have.
 */
export interface UberTrip {
	beginTripTime?: string;
	cityID?: number;
	countryID?: number;
	driver?: string;
	dropoffTime?: string;
	fare?: string;
	isSurgeTrip?: boolean;
	jobUUID?: string;
	status?: string;
	uuid?: string;
	vehicleDisplayName?: string;
	vehicleViewID?: number;
	waypoints?: string[];
}

/**
 * `data.getTrip.receipt` — vehicle-type and distance/duration fields only.
 * `distance` is a bare numeric string with the unit given separately by
 * `distanceLabel` ("kilometers" | "miles", observed). `duration` is a
 * display string ("35 minutes"), not seconds. The display values are kept
 * alongside normalized values so legacy payloads can retain their original
 * unit and text.
 */
export interface UberReceiptSummary {
	distance?: string;
	distanceLabel?: string;
	duration?: string;
	vehicleType?: string;
}

export interface UberGetTripResult {
	receipt?: UberReceiptSummary;
	trip?: UberTrip;
}

export interface UberGetTripResponse {
	data?: {
		getTrip?: UberGetTripResult;
	};
}

/**
 * `data.getReceipt.receiptData` from the `GetReceipt` operation is a full
 * HTML email-receipt document (not structured JSON) containing the
 * itemized fare breakdown as
 * `<span data-testid="fare_line_item_label_<slug>" class="fare-breakdown-name">`
 * / `<span data-testid="fare_line_item_amount_<slug>" class="fare-breakdown-amount">`
 * pairs. Observed slugs: `trip_fare`, `booking_fee`, `tip`, `promotion`,
 * `currency_conversion_fee`, `fare_total` — an open vocabulary, not
 * exhaustive. Each line's amount can carry a DIFFERENT currency symbol
 * than the others on the same receipt (a foreign-currency trip charged to
 * a USD-settling card shows original-currency line items alongside a
 * USD-converted `fare_total` and `currency_conversion_fee`) — real,
 * observed behavior, not an edge case to normalize away.
 */
export interface UberGetReceiptResponse {
	data?: {
		getReceipt?: {
			receiptData?: string;
		};
	};
}

export interface UberFareBreakdownLine {
	amountRaw: string;
	label: string;
	slug: string;
}

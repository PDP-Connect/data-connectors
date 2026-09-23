// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes for the DoorDash connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry.
//
// These shapes are inferred from two sources, neither of which is a live
// capture (see connectors/doordash/index.ts header for the PENDING-live
// caveat):
//   1. The legacy Playwright scraper's own GraphQL response walk
//      (data-connectors/doordash/doordash-playwright.js), which reads
//      `getConsumerOrdersWithDetails` responses via fields like
//      `store.name`, `orderUuid`, `createdAt`, `totalCharged.unitAmount`,
//      `deliveryStatus`, `orderItems[].name/quantity/price`.
//   2. DoorDash's known public GraphQL conventions (money as a `MonetaryFields`
//      object with `unitAmount` in cents + `displayString`; deliveries expose
//      a `deliveryAddress` object with `printableAddress`).
//
// Every field below is optional/nullable at the type level — the parser
// never assumes a field is present and always falls back to `null`.

/** DoorDash's money envelope: cents in `unitAmount`, humanized in `displayString`. */
export interface DoorDashMonetaryFields {
	displayString?: string | null;
	unitAmount?: number | null;
}

export interface DoorDashDeliveryAddress {
	formattedAddress?: string | null;
	printableAddress?: string | null;
	shortName?: string | null;
}

export interface DoorDashStore {
	name?: string | null;
}

export interface DoorDashOrderItem {
	name?: string | null;
	price?: DoorDashMonetaryFields | string | number | null;
	quantity?: number | null;
}

/** One entry from the `getConsumerOrdersWithDetails` GraphQL response
 *  (or the per-order detail query DoorDash's order detail page fires). */
export interface DoorDashOrderNode {
	createdAt?: string | null;
	deliveryAddress?: DoorDashDeliveryAddress | null;
	deliveryFee?: DoorDashMonetaryFields | null;
	deliveryStatus?: string | null;
	grandTotal?: DoorDashMonetaryFields | null;
	orderItems?: DoorDashOrderItem[] | null;
	orderUuid?: string | null;
	serviceFee?: DoorDashMonetaryFields | null;
	store?: DoorDashStore | null;
	subtotal?: DoorDashMonetaryFields | null;
	tax?: DoorDashMonetaryFields | null;
	tip?: DoorDashMonetaryFields | null;
	totalCharged?: DoorDashMonetaryFields | null;
}

// ─── Emitted record shapes ──────────────────────────────────────────────

/** `orders` stream record — see manifests/doordash.json for the wire schema. */
export interface OrderRecord {
	delivery_address: string | null;
	delivery_fee_cents: number | null;
	id: string;
	item_count: number | null;
	order_date: string | null;
	payment_method_summary: string | null;
	restaurant_name: string | null;
	service_fee_cents: number | null;
	status: string | null;
	subtotal_cents: number | null;
	tax_cents: number | null;
	tip_cents: number | null;
	total_cents: number | null;
	[field: string]: unknown;
}

/** `order_items` stream record. */
export interface OrderItemRecord {
	customizations: string[];
	id: string;
	name: string;
	order_id: string;
	quantity: number;
	unit_price_cents: number | null;
	[field: string]: unknown;
}

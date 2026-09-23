// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the DoorDash connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation. The network-capture loop,
// browser lifecycle, and orchestration live in index.ts.

import type {
	DoorDashMonetaryFields,
	DoorDashOrderItem,
	DoorDashOrderNode,
	OrderItemRecord,
	OrderRecord,
} from "./types.ts";

// ─── Field helpers ──────────────────────────────────────────────────────

/**
 * DoorDash's own GraphQL money envelope is `{ unitAmount: <cents>, displayString }`.
 * `unitAmount` is already integer minor units (cents) — contract D4. Some
 * responses (and the legacy scraper's DOM fallback) instead hand back a bare
 * display string like `"$12.34"`; parse that as a last resort. Never guess a
 * value from a display string that doesn't parse cleanly — return null.
 */
const DOLLAR_STRING_RE = /^\$?(\d[\d,]*)\.(\d{2})$/;

export function centsFromMonetary(
	value: DoorDashMonetaryFields | string | number | null | undefined,
): number | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.round(value) : null;
	}
	if (typeof value === "string") {
		const m = DOLLAR_STRING_RE.exec(value.trim());
		if (!m) {
			return null;
		}
		const dollars = Number(m[1]?.replace(/,/g, ""));
		const cents = Number(m[2]);
		if (!(Number.isFinite(dollars) && Number.isFinite(cents))) {
			return null;
		}
		return Math.round(dollars * 100 + cents);
	}
	if (
		typeof value.unitAmount === "number" &&
		Number.isFinite(value.unitAmount)
	) {
		return Math.round(value.unitAmount);
	}
	if (value.displayString) {
		return centsFromMonetary(value.displayString);
	}
	return null;
}

/**
 * DoorDash's `createdAt` is an ISO-8601 datetime on every observed shape
 * (legacy scraper's `createdAt`/`submittedAt` fields). Reject anything that
 * doesn't parse as a valid date rather than guessing — contract D4: an
 * unparseable value is null, never fabricated.
 */
export function normalizeOrderDate(
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

export function deliveryAddressText(
	address: DoorDashOrderNode["deliveryAddress"],
): string | null {
	if (!address) {
		return null;
	}
	return (
		address.printableAddress ??
		address.formattedAddress ??
		address.shortName ??
		null
	);
}

export function restaurantName(
	store: DoorDashOrderNode["store"],
): string | null {
	return store?.name ?? null;
}

/** Stable, source-local order id. DoorDash's `orderUuid` is the platform's
 *  own primary key for an order — never derive a synthetic id. */
export function orderId(node: DoorDashOrderNode): string | null {
	return node.orderUuid ?? null;
}

// ─── Record builders ────────────────────────────────────────────────────

export function orderRecord(node: DoorDashOrderNode): OrderRecord | null {
	const id = orderId(node);
	if (!id) {
		return null;
	}
	const items = Array.isArray(node.orderItems) ? node.orderItems : [];
	return {
		id,
		order_date: normalizeOrderDate(node.createdAt),
		restaurant_name: restaurantName(node.store),
		status: node.deliveryStatus ?? null,
		subtotal_cents: centsFromMonetary(node.subtotal),
		tax_cents: centsFromMonetary(node.tax),
		tip_cents: centsFromMonetary(node.tip),
		delivery_fee_cents: centsFromMonetary(node.deliveryFee),
		service_fee_cents: centsFromMonetary(node.serviceFee),
		total_cents:
			centsFromMonetary(node.totalCharged) ??
			centsFromMonetary(node.grandTotal),
		delivery_address: deliveryAddressText(node.deliveryAddress),
		// DoorDash's consumer order GraphQL does not expose a payment-instrument
		// summary on the orders-with-details response the legacy scraper
		// observed (it only ever captured a display total). Never fabricate
		// one; null is the honest "not present on this response" signal.
		payment_method_summary: null,
		item_count: items.length > 0 ? items.length : node.orderItems ? 0 : null,
	};
}

function itemName(item: DoorDashOrderItem): string | null {
	const name = item.name;
	return typeof name === "string" && name.trim().length > 0 ? name : null;
}

/**
 * Build the child `order_items` records for one order. DoorDash's order
 * items do not carry a stable platform-issued item id in the shapes the
 * legacy scraper observed, so the record key is composed from the parent
 * order id + a stable positional index — stable across runs because
 * DoorDash's own order-items array order is stable for an immutable,
 * already-delivered order (contract: historical orders don't reorder their
 * own line items).
 */
export function orderItemRecords(
	parentOrderId: string,
	items: readonly DoorDashOrderItem[] | null | undefined,
): OrderItemRecord[] {
	if (!items) {
		return [];
	}
	const out: OrderItemRecord[] = [];
	items.forEach((item, index) => {
		const name = itemName(item);
		if (!name) {
			return;
		}
		const quantityRaw = item.quantity;
		const quantity =
			typeof quantityRaw === "number" && Number.isFinite(quantityRaw)
				? Math.max(0, Math.round(quantityRaw))
				: 1;
		out.push({
			id: `${parentOrderId}-item-${index}`,
			order_id: parentOrderId,
			name,
			quantity,
			unit_price_cents: centsFromMonetary(item.price ?? null),
			// DoorDash's orderItems response shape observed by the legacy
			// scraper carries no modifier/customization sub-array — only
			// name/quantity/price. There is nothing to populate honestly here;
			// an empty array (not null) matches the manifest's plain `array`
			// schema type.
			customizations: [],
		});
	});
	return out;
}

// ─── Response walking ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * DoorDash's GraphQL response envelope nests the order list at a path that
 * varies with the operation (`getConsumerOrdersWithDetails` vs. per-order
 * detail queries) and DoorDash has changed that nesting before (the legacy
 * scraper's own `findOrdersInResponse` walks the whole tree for exactly this
 * reason). This applies the same structural heuristic — the first array of
 * objects whose first element looks like an order (has a `store`,
 * `orderUuid`, or `createdAt` field) — rather than a single brittle path.
 */
function looksLikeOrderNode(value: unknown): value is DoorDashOrderNode {
	if (!isRecord(value)) {
		return false;
	}
	return (
		"orderUuid" in value ||
		"store" in value ||
		"createdAt" in value ||
		"deliveryStatus" in value
	);
}

export function findOrderNodesInResponse(
	body: unknown,
	depth = 0,
): DoorDashOrderNode[] | null {
	if (body === null || body === undefined || depth > 6) {
		return null;
	}
	if (Array.isArray(body)) {
		if (body.length > 0 && looksLikeOrderNode(body[0])) {
			return body.filter(looksLikeOrderNode);
		}
		for (const entry of body) {
			const found = findOrderNodesInResponse(entry, depth + 1);
			if (found) {
				return found;
			}
		}
		return null;
	}
	if (isRecord(body)) {
		for (const key of Object.keys(body)) {
			const value = body[key];
			if (
				Array.isArray(value) &&
				value.length > 0 &&
				looksLikeOrderNode(value[0])
			) {
				return value.filter(looksLikeOrderNode);
			}
		}
		for (const key of Object.keys(body)) {
			const found = findOrderNodesInResponse(body[key], depth + 1);
			if (found) {
				return found;
			}
		}
	}
	return null;
}

/** Parse one `getConsumerOrdersWithDetails`-shaped GraphQL response body
 *  into order nodes. Returns `[]` (not null) when nothing matches, so
 *  callers can distinguish "fetched, zero orders" from "response shape
 *  didn't parse" only via the raw body they still hold. */
export function parseOrdersResponse(body: unknown): DoorDashOrderNode[] {
	const data = isRecord(body) && "data" in body ? body.data : body;
	return findOrderNodesInResponse(data) ?? [];
}

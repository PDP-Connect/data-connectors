// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for DoorDash stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT: doordash/index.ts now emits real RECORDs, parsed from
 * `getConsumerOrdersWithDetails`-shaped GraphQL responses captured on the
 * orders page (see parsers.ts). Live-verified 2026-09-22 (`cut-doordash-live`
 * lane, two real runs against a real account — see connectors/doordash/
 * index.ts's own header for the full evidence): the real response did not
 * carry `deliveryStatus` or `orderItems` on any observed order, and no
 * `payment_method_summary` source field was ever observed either, which is
 * why the parser emits null for those fields — confirmed against a real
 * capture, not assumed. `fixtures/doordash/scrubbed/pilot-real-shape/` is
 * now populated from that capture. The `__fixtures__/synthetic/` fixture
 * used by synthetic-shape.test.ts remains hand-authored synthetic-but-
 * shape-real data for cases the live capture didn't happen to exercise.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * orders stream (manifest required: id). One record per DoorDash delivery
 * order. All money fields are non-negative cent integers; `restaurant_name` is
 * free-form; `status` / `payment_method_summary` are short labels;
 * `delivery_address` is free-form human text; `order_date` is an ISO datetime.
 */
export const ordersSchema = z.object({
	id: z.string().min(1).max(200),
	order_date: z
		.string()
		.regex(ISO_DT_RE, "order_date must be an ISO-8601 datetime")
		.nullable(),
	restaurant_name: pdppSafeText.max(500).nullable(),
	status: z.string().min(1).max(64).nullable(),
	subtotal_cents: z.number().int().min(0).nullable(),
	tax_cents: z.number().int().min(0).nullable(),
	tip_cents: z.number().int().min(0).nullable(),
	delivery_fee_cents: z.number().int().min(0).nullable(),
	service_fee_cents: z.number().int().min(0).nullable(),
	total_cents: z.number().int().min(0).nullable(),
	delivery_address: pdppSafeText.max(1000).nullable(),
	payment_method_summary: z.string().min(1).max(200).nullable(),
	item_count: z.number().int().min(0).nullable(),
});

/**
 * order_items stream (manifest required: id, order_id, name, quantity,
 * customizations). One record per line item. `name` is the free-form item
 * name; `quantity` is a required non-negative integer (manifest declares plain
 * integer, not nullable); `customizations` is an array of free-form
 * modifier strings (manifest declares a bare array — element shape unverified,
 * so each element is bounded free text rather than `z.any()`).
 */
export const orderItemsSchema = z.object({
	id: z.string().min(1).max(200),
	order_id: z.string().min(1).max(200),
	name: pdppSafeText.max(1000),
	quantity: z.number().int().min(0),
	unit_price_cents: z.number().int().min(0).nullable(),
	customizations: z.array(pdppSafeText.max(1000)),
});

/**
 * Stream → schema registry. Single source of truth for the streams this
 * connector declares (and will emit once extraction is wired).
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	orders: ordersSchema,
	order_items: orderItemsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

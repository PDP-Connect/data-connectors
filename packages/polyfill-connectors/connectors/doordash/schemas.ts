// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for DoorDash stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT: doordash/index.ts now emits real RECORDs, parsed from
 * `getConsumerOrdersWithDetails`-shaped GraphQL responses captured on the
 * orders page (see parsers.ts). No live DoorDash session exists for this
 * lane yet ("PROFILE READY" has not been sent) — the parser's field-level
 * assumptions are derived from the legacy Playwright scraper's own response
 * walk (data-connectors/doordash/doordash-playwright.js) plus DoorDash's
 * known public GraphQL money-envelope convention, NOT a live capture. The
 * `__fixtures__/synthetic/` fixture used by synthetic-shape.test.ts is
 * therefore hand-authored synthetic-but-shape-real data, not a real capture
 * — `fixtures/doordash/scrubbed/pilot-real-shape/` does not exist yet (see
 * pilot-fixture.test.ts). See connectors/doordash/index.ts header for the
 * exact pending-live status. Whoever gets live access MUST re-verify these
 * field shapes against a real captured response and tighten anything that
 * drifts (especially `order_date` presence, the `orderUuid` id format, and
 * whether `payment_method_summary` is ever actually present on this
 * response — the parser currently always emits null for it because no
 * observed shape carries it).
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

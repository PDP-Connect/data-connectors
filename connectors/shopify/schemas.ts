// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Shopify (Shop app) stream records. Shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3.
 *
 * GROUND-TRUTH CAVEAT: this connector's Apollo-cache extraction
 * (parsers.ts) is implemented from the legacy Playwright connector's prior
 * art (connectors/shopify/shop-playwright.js) per
 * docs/migration/connector-cutover/CONTRACTS.md D10 — Tim has no Shop
 * account, so there is no independently-captured real cache extract to
 * derive this schema from. The shape below is the connector's own
 * capability-map field contract (docs/migration/connector-cutover/
 * capability-map.json, `shopify` entry), tightened against the legacy
 * connector's known Apollo field shapes (Shopify Money scalar, GraphQL
 * global ID). It has NOT been shape-checked against a real Shop order.
 * Whoever runs this connector against a live account first MUST re-verify
 * these shapes (especially `id`/`order_number`, which assume a
 * `gid://shopify/Order/<...>`-style GraphQL global ID) and tighten or
 * loosen as observed.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const CURRENCY_CODE_RE = /^[A-Z]{3}$/; // ISO 4217

/**
 * orders stream (manifest required: id). One record per Shop-app order,
 * extracted from the Apollo client cache's `Order:<id>` entries.
 */
export const ordersSchema = z.object({
	id: z.string().min(1).max(200),
	order_number: z.string().min(1).max(200).nullable(),
	order_date: z
		.string()
		.regex(ISO_DT_RE, "order_date must be an ISO-8601 datetime")
		.nullable(),
	merchant_name: pdppSafeText.max(500).nullable(),
	status: z.string().min(1).max(64).nullable(),
	total_cents: z.number().int().min(0).nullable(),
	currency: z
		.string()
		.regex(CURRENCY_CODE_RE, "currency must be a 3-letter ISO 4217 code")
		.nullable(),
	item_count: z.number().int().min(0).nullable(),
	line_item_titles: z.array(pdppSafeText.max(500)).max(500),
	detail_url: z.url().max(4096),
});

/**
 * Stream → schema registry. Single source of truth for the stream this
 * connector declares and emits.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	orders: ordersSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

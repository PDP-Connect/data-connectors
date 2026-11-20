// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Amazon stream records. Used for shape-check-before-emit
 * per docs/reference/connector-authoring-guide.md §3: records that don't match the
 * schema become SKIP_RESULT events instead of RECORD events, so the RS
 * never receives data that looks right but isn't.
 *
 * Each schema asserts:
 *   - primitive types correct
 *   - lengths bounded
 *   - no known cruft patterns in string fields (regex literals like
 *     "Buy it again", "Sold by" that only appear if row parsing failed)
 *   - currency/id shapes correct
 *
 * Schemas intentionally accept `null` for fields that can legitimately be
 * absent. Required fields (id, order_date) must be present.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";
import { MONEY_VALUE_RE } from "./parsers.ts";

// Module-level regexes (Biome useTopLevelRegex) — compiled once, reused
// across every record validated by this module.
const PAYMENT_CRUFT_RE = /Unable to display|Buy it again|View your item/i;
const PAYMENT_DOLLAR_RE = /\$\d/;
const RECIPIENT_FORBIDDEN_RE = /[$\t\n]|Buy it again|View your item/i;
// Any store's money format ("$12.34", "£12.34", "12,34 €", "R$ 1.234,56",
// "￥1,234"): see parsers.ts MONEY_VALUE_RE. A cents-less dollar amount
// ("$10") is still refused: it means a price span was cut short.
const CURRENCY_STRING_RE = MONEY_VALUE_RE;
const ASIN_RE = /^[A-Z0-9]{10}$/;
const ITEM_NAME_CRUFT_RE =
	/Buy it again|View your item|Get product support|Write a product review/i;
const ITEM_NAME_SOLD_BY_RE = /^Sold by/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AMAZON_ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
const LIST_PAGE_TOTAL_RE = MONEY_VALUE_RE;
const POSTAL_CODE_RE = /^[0-9A-Z][0-9A-Z -]{1,10}[0-9A-Z]$/;
const STORE_NAME_RE = /^amazon\.[a-z.]{2,8}$/;

// Payment summary must either be null, a card/digital-wallet style string,
// or an explicit mixed-payment line ("Amazon gift card balance Visa ending
// in 5900"). Must NOT contain "Unable to display" (non-answer text) or
// UI cruft.
const paymentMethodSchema = z
	.string()
	.min(1)
	.max(200)
	.refine((s) => !PAYMENT_CRUFT_RE.test(s), {
		message: "contains cruft or non-answer text",
	})
	.refine((s) => !PAYMENT_DOLLAR_RE.test(s), {
		message: "contains a dollar amount (likely parse leak)",
	})
	.nullable();

const recipientNameSchema = z
	.string()
	.min(2)
	.max(80)
	.refine((s) => !RECIPIENT_FORBIDDEN_RE.test(s), {
		message: "contains forbidden chars or cruft",
	})
	.nullable();

const currencyStringSchema = z
	.string()
	.regex(CURRENCY_STRING_RE, "not a money amount with two decimals")
	.nullable();

const centsSchema = z
	.number()
	.int()
	.min(0)
	.max(10_000_000) // $100,000 max — sane upper bound for consumer orders
	.nullable();

const asinSchema = z
	.string()
	.regex(ASIN_RE, "ASIN must be 10 uppercase alphanumeric")
	.nullable();

// Item name: non-empty, bounded, must not contain obvious cruft patterns.
// Amazon product names run long on multi-pack / gift-basket / variant
// listings (500-chars observed in practice). 1024 is a safe upper bound.
const itemNameSchema = z
	.string()
	.min(2)
	.max(1024)
	.refine((s) => !ITEM_NAME_CRUFT_RE.test(s), {
		message: "contains UI cruft",
	})
	.refine((s) => !ITEM_NAME_SOLD_BY_RE.test(s), {
		message: 'starts with "Sold by" — name parser captured the wrong span',
	});

export const orderSchema = z.object({
	id: z.string().min(5).max(40),
	order_date: z.string().regex(ISO_DATE_RE, "order_date must be YYYY-MM-DD"),
	order_total: currencyStringSchema,
	order_total_cents: centsSchema,
	delivery_status: z.string().nullable(),
	status_detail: z.string().max(200).nullable(),
	recipient_name: recipientNameSchema,
	shipping_address_summary: z.string().max(500).nullable(),
	shipping_postal_code: z.string().regex(POSTAL_CODE_RE).nullable(),
	store: z.string().regex(STORE_NAME_RE).nullable(),
	payment_method_summary: paymentMethodSchema,
	gift_order: z.boolean(),
	digital_order: z.boolean(),
	// Nullable because a deferred order-detail fetch leaves the count genuinely
	// unknown, and a non-nullable count can only express that as `0` — which
	// reads as a proven-empty order. See `resolveItemCount`.
	item_count: z.number().int().min(0).nullable(),
});

export const orderItemSchema = z.object({
	id: z.string().min(5).max(250),
	order_id: z.string().min(5).max(40),
	order_date: z.string().regex(ISO_DATE_RE),
	asin: asinSchema,
	name: itemNameSchema,
	url: z.url().nullable(),
	unit_price: currencyStringSchema,
	unit_price_cents: centsSchema,
	quantity: z.number().positive().max(999),
	seller: z.string().min(1).max(120).nullable(),
	item_image_url: z.string().nullable(),
	returned: z.boolean(),
	refund_status: z.string().max(200).nullable(),
});

// Internal: shape returned by extractOrdersOnPage (pre-enrichment). Used
// to catch list-page selector drift — if our DOM selectors match the
// wrong elements, we'd rather see a SKIP_RESULT with diagnostics than
// silently emit garbage orders.
export const listPageOrderShape = z.object({
	orderId: z
		.string()
		.regex(AMAZON_ORDER_ID_RE, "orderId must match NNN-NNNNNNN-NNNNNNN"),
	orderDateRaw: z.string().min(4).max(60).nullable(),
	orderTotal: z
		.string()
		.regex(LIST_PAGE_TOTAL_RE, "orderTotal must be a money amount when present")
		.nullable(),
	deliveryStatus: z.string().max(200).nullable(),
	items: z.array(
		z.object({
			name: z.string().min(2).max(1024),
			url: z.url().nullable(),
			asin: asinSchema,
		}),
	),
	store: z.string().regex(STORE_NAME_RE).nullable().optional(),
});

// profile: a best-effort nav-bar snapshot (name, Prime status). Both fields
// are nullable per D4 — an unparseable value is null, never guessed.
export const profileSchema = z.object({
	id: z.string().min(1).max(40),
	name: z.string().min(1).max(200).nullable(),
	is_prime: z.boolean().nullable(),
	postal_code: z.string().regex(POSTAL_CODE_RE).nullable(),
	store: z.string().regex(STORE_NAME_RE).nullable(),
});

// Map stream name → schema. Single source of truth for what streams this
// connector produces at shape-check time.
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	orders: orderSchema,
	order_items: orderItemSchema,
	profile: profileSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parsed shapes for the Amazon connector. Extracted from index.ts so
// parsers.ts and tests can import them without pulling in the Playwright-
// flavored runtime entry.

export interface ListPageItem {
	asin: string | null;
	name: string;
	url: string | null;
}

export interface ListPageOrder {
	deliveryStatus: string | null;
	items: ListPageItem[];
	orderDateRaw: string | null;
	orderId: string;
	orderTotal: string | null;
	/** The store the order was listed on (`amazon.ca`). Absent on rows built before stores. */
	store?: string | null;
}

export interface DetailItem {
	asin: string | null;
	item_image_url: string | null;
	name: string;
	quantity: number;
	refund_status: string | null;
	seller: string | null;
	unit_price: string | null;
	url: string | null;
}

export interface OrderDetail {
	digital_order: boolean;
	gift_order: boolean;
	grand_total: string | null;
	items: DetailItem[];
	payment_method_summary: string | null;
	recipient_name: string | null;
	shipping_address_summary: string | null;
	/** The shipping address's postal code, in the store country's shape; null when not shown. */
	shipping_postal_code?: string | null;
	status_detail: string | null;
}

export interface MergedItem {
	asin?: string | null;
	item_image_url?: string | null;
	name: string;
	quantity?: number | null;
	refund_status?: string | null;
	seller?: string | null;
	unit_price?: string | null;
	url?: string | null;
}

// Shape of the emitted `orders` stream record. Field names + nullability
// match the schemas.ts zod shape and the production runtime output.
// Index signature is open so these types satisfy RecordData at the emit site.
export interface OrdersRecord {
	delivery_status: string | null;
	digital_order: boolean;
	gift_order: boolean;
	id: string;
	item_count: number | null;
	order_date: string;
	order_total: string | null;
	order_total_cents: number | null;
	payment_method_summary: string | null;
	recipient_name: string | null;
	shipping_address_summary: string | null;
	shipping_postal_code: string | null;
	status_detail: string | null;
	store: string | null;
	[field: string]: unknown;
}

// Shape of the emitted `order_items` stream record.
export interface OrderItemRecord {
	asin: string | null;
	id: string;
	item_image_url: string | null;
	name: string;
	order_date: string;
	order_id: string;
	quantity: number;
	refund_status: string | null;
	returned: boolean;
	seller: string | null;
	unit_price: string | null;
	unit_price_cents: number | null;
	url: string | null;
	[field: string]: unknown;
}

// Shape of the emitted `profile` stream record.
export interface ProfileRecord {
	id: string;
	is_prime: boolean | null;
	name: string | null;
	/** Postal code of the default delivery address (nav "Deliver to"); null when not shown. */
	postal_code: string | null;
	/** The store this profile was read on (`amazon.ca`). */
	store: string | null;
	[field: string]: unknown;
}

export interface ListPageDiagnostics {
	any_card: number;
	any_order_header: number;
	body_preview: string;
	captcha: string;
	no_orders_text: string;
	order_cards: number;
	sign_in_form: boolean;
	title: string;
	url: string;
}

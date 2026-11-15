// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Amazon connector. Kept free of Playwright / Node
// I/O so they can be unit-tested in isolation.

import { parseHTML } from "linkedom";
import {
	type AmazonStore,
	absoluteStoreUrl,
	DEFAULT_AMAZON_STORE,
	extractPostalCode,
	parsePostalCode,
} from "./stores.ts";
import type {
	DetailItem,
	ListPageItem,
	ListPageOrder,
	MergedItem,
	OrderDetail,
	OrderItemRecord,
	OrdersRecord,
	ProfileRecord,
} from "./types.ts";

const CURRENCY_CENTS_MULTIPLIER = 100;
// Strip thousands-separators (commas or locale spaces) before the numeric
// match, otherwise "$1,234.56" was previously misread as "$1.00".
// A money amount in any store's format: "$1,234.56", "CDN$ 12.34",
// "£12.34", "12,34 €", "1.234,56 €", "R$ 1.234,56", "₹1,23,456.00", "￥1,234".
const CURRENCY_DIGITS_RE = /\d[\d.,\s\u00a0\u202f]*/;
const CURRENCY_DECIMAL_RE = /[.,](\d{1,2})$/;
const CURRENCY_SEPARATORS_RE = /[.,\s\u00a0\u202f]/g;
const CURRENCY_WHOLE_RE = /^\d+$/;
const CURRENCY_NEGATIVE_SIGN_RE = /^\s*-|^\s*\(/;
const ITEM_ID_WHITESPACE_RE = /\s+/g;

// Shared regexes for orders-list DOM parsing (hoisted from the old in-browser
// callback — we now parse in Node via linkedom so module-scoped regexes are
// fine).
const ORDER_ID_RE = /^\d{3}-\d{7}-\d{7}$/;
// The list card's header labels, in each store's language (the value spans
// are language-neutral). English first: amazon.com/.ca/.co.uk/.com.au/.in.
const HEADER_DATE_RE =
	/^(ORDER PLACED|ORDER DATE|PLACED|BESTELLUNG AUFGEGEBEN|BESTELLT AM|COMMANDE EFFECTU[ÉE]E|COMMANDE PASS[ÉE]E|ORDINE EFFETTUATO|PEDIDO REALIZADO|PEDIDO FEITO|DATA DO PEDIDO|注文日|注文確定日)$/i;
const HEADER_TOTAL_RE = /^(TOTAL|SUMME|GESAMT|GESAMTSUMME|TOTALE|合計)$/i;
// A whole money amount: optional currency (symbol and/or code) on either
// side, digits with any grouping, two decimals; or a whole yen amount.
export const MONEY_VALUE_RE =
	/^(?:-?(?:[A-Z]{1,3}\s?)?(?:[$£€₹]|R\$)?\s?\d{1,3}(?:[.,\s\u00a0\u202f]?\d{2,3})*[.,]\d{2}(?:\s?(?:€|EUR|£))?|(?:[￥¥]|JPY)\s?\d{1,3}(?:,?\d{3})*)$/u;
const TOTAL_VALUE_RE = MONEY_VALUE_RE;
const ASIN_HREF_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/;
const WHITESPACE_RE = /\s+/g;

// Profile nav-bar parsing. The greeting reads "Hello, <Name>" when signed in
// (never "Hello, Sign in"); Prime membership is a distinct nav element whose
// link text names actual membership ("your prime"/"prime benefits"), not the
// "Try Prime" upsell shown to non-members.
const NAV_GREETING_RE = /Hello,\s*(.+)/;
const ZERO_WIDTH_RE = /[\u200b-\u200f\u2060\ufeff]/g;
const NAV_SIGN_IN_RE = /sign in/i;
const PRIME_MEMBER_TEXT_RE = /your prime|prime benefits/i;
// The nav's inline config, on every signed-in page of every store:
// `$Nav.declare('config.isPrimeMember',true)` and the menu args'
// `"isPrime":1`. Both read false/0 when signed out, so they are only trusted
// on a signed-in page. `config.customerName` is `false` when signed out.
const NAV_IS_PRIME_MEMBER_RE =
	/\$Nav\.declare\(\s*['"]config\.isPrimeMember['"]\s*,\s*(true|false)\s*\)/;
// Anchored to the nav menu's own config object: an `"isPrime":1` elsewhere on
// the page (an item widget, a recommendation) says nothing about the account.
const NAV_MENU_IS_PRIME_RE =
	/\$Nav\.declare\(\s*['"]config\.dynamicMenuArgs['"]\s*,\s*\{[^{}]*?["']isPrime["']\s*:\s*(1|0|true|false)\b/;
const NAV_CUSTOMER_SIGNED_OUT_RE =
	/\$Nav\.declare\(\s*['"]config\.customerName['"]\s*,\s*false\s*\)/;

// Elements whose text is never shown: a page's inline scripts (Amazon's
// payment widget opens with `try{window.__UPX_HTML_PARSED_TIME__=...`) and
// styles. linkedom's innerText is textContent, so they are removed first.
const NON_VISIBLE_SELECTOR = "script, style, noscript, template";

function textOf(el: Element | null | undefined): string {
	if (!el) {
		return "";
	}
	if (!el.querySelector(NON_VISIBLE_SELECTOR)) {
		return el.textContent ?? "";
	}
	const clone = el.cloneNode(true) as Element;
	for (const hidden of clone.querySelectorAll(NON_VISIBLE_SELECTOR)) {
		hidden.remove();
	}
	return clone.textContent ?? "";
}

/**
 * Visible text with each image read as its alt text: Amazon draws the card
 * brand as `<img alt="Visa">` beside "ending in 1234".
 */
function textWithAlts(el: Element | null | undefined): string {
	if (!el) {
		return "";
	}
	const clone = el.cloneNode(true) as Element;
	for (const hidden of clone.querySelectorAll(NON_VISIBLE_SELECTOR)) {
		hidden.remove();
	}
	for (const img of clone.querySelectorAll("img[alt]")) {
		const alt = img.getAttribute("alt")?.trim();
		const doc = img.ownerDocument;
		if (alt && doc) {
			img.replaceWith(doc.createTextNode(` ${alt} `));
		}
	}
	return (clone.textContent ?? "").replace(WHITESPACE_RE, " ").trim();
}

function findHeaderValue(card: Element, labelPattern: RegExp): string | null {
	const items = card.querySelectorAll<HTMLElement>(
		".order-header__header-list-item",
	);
	for (const item of items) {
		const labelEl = item.querySelector<HTMLElement>(
			".a-color-secondary.a-text-caps",
		);
		const label = textOf(labelEl).trim();
		if (!labelPattern.test(label)) {
			continue;
		}
		const valueEls = [...item.querySelectorAll<HTMLElement>("span")]
			.filter((s) => s !== labelEl)
			.map((s) => textOf(s).trim())
			.filter(Boolean);
		return valueEls[0] || null;
	}
	return null;
}

function findOrderId(card: HTMLElement): string | null {
	const orderIdEl = card.querySelector<HTMLElement>(".yohtmlc-order-id");
	if (!orderIdEl) {
		return null;
	}
	for (const span of orderIdEl.querySelectorAll<HTMLElement>("span")) {
		const txt = textOf(span).trim();
		if (ORDER_ID_RE.test(txt)) {
			return txt;
		}
	}
	return null;
}

function parseListPageItem(
	titleEl: HTMLElement,
	store: AmazonStore,
): ListPageItem | null {
	const name = textOf(titleEl).replace(WHITESPACE_RE, " ").trim();
	if (!name) {
		return null;
	}
	const itemBox =
		titleEl.closest<HTMLElement>(".item-box, .a-fixed-left-grid") ??
		titleEl.parentElement;
	const link =
		itemBox?.querySelector<HTMLAnchorElement>(
			'a[href*="/dp/"], a[href*="/gp/product/"]',
		) ?? titleEl.querySelector<HTMLAnchorElement>("a");
	const href = link?.getAttribute("href") ?? "";
	const url = absoluteStoreUrl(store, href);
	const asin = href.match(ASIN_HREF_RE)?.[1] ?? null;
	return { name, url, asin };
}

function collectListPageItems(
	card: HTMLElement,
	store: AmazonStore,
): ListPageItem[] {
	const items: ListPageItem[] = [];
	const seenAsins = new Set<string>();
	for (const titleEl of card.querySelectorAll<HTMLElement>(
		".yohtmlc-product-title",
	)) {
		const item = parseListPageItem(titleEl, store);
		if (!item) {
			continue;
		}
		if (item.asin) {
			if (seenAsins.has(item.asin)) {
				continue;
			}
			seenAsins.add(item.asin);
		}
		items.push(item);
	}
	return items;
}

function parseOrderCard(
	card: HTMLElement,
	store: AmazonStore,
): ListPageOrder | null {
	const orderId = findOrderId(card);
	if (!orderId) {
		return null;
	}

	const orderDateRaw = findHeaderValue(card, HEADER_DATE_RE);
	const totalRaw = findHeaderValue(card, HEADER_TOTAL_RE);
	const orderTotal =
		totalRaw && TOTAL_VALUE_RE.test(totalRaw) ? totalRaw : null;

	const primaryStatusEl = card.querySelector<HTMLElement>(
		".yohtmlc-shipment-status-primaryText, .delivery-box__primary-text",
	);
	const deliveryStatus = primaryStatusEl
		? textOf(primaryStatusEl).replace(WHITESPACE_RE, " ").trim() || null
		: null;

	return {
		orderId,
		orderDateRaw,
		orderTotal,
		deliveryStatus,
		items: collectListPageItems(card, store),
		store: store.name,
	};
}

// ─── Order-detail DOM parsing ───────────────────────────────────────────

// Only an explicit whole-order statement may discard items and totals.
// Unknown or item-level wording must not become a guessed order state.
const CANCELLED_RE = /^(?:this|your) order has been cancelled[.!]?$/i;
const ITEM_CANCELLED_RE = /^one item has been cancelled[.!]?$/i;
const PAY_PREFIX_RE = /^Payment method\s*/i;
const PAY_SUFFIX_RE = /\s*View related transactions.*$/i;
const CARD_PATCH_RE =
	/(Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card)ending in/gi;
const CARD_ONLY_RE =
	/((?:Visa|Mastercard|Amex|Discover|Diners|Unknown Credit Card|Credit Card|Debit Card) ending in \d{3,5})/i;
const UNABLE_RE = /Unable to display payment details/i;
// Script or markup that reached a text node is never a payment method.
const CODE_LIKE_RE = /[{};<>]|=>|\bfunction\b|\bwindow\.|\bdocument\./;
const GRAND_TOTAL_RE =
	/Grand Total:?\s*((?:[A-Z]{1,3}\s?)?(?:[$£€₹]|R\$)?\s?\d[\d.,\s\u00a0\u202f]*[.,]\d{2}(?:\s?€)?)/i;
const ASIN_RE = /\/(?:gp\/product|dp)\/([A-Z0-9]{10})/;
const SOLD_BY_RE = /^Sold by:?\s*(.+)$/i;
const DOLLAR_RE =
	/((?:[A-Z]{1,3}\s?)?(?:[$£€₹]|R\$)\s?\d[\d.,\s\u00a0\u202f]*[.,]\d{2}|\d[\d.,\s\u00a0\u202f]*[.,]\d{2}\s?€)/;
const INT_RE = /^\d+$/;
const FOPO_BR_RE = /<br\s*\/?>/i;
const FOPO_AT_PRICE_RE = /@\s*(\$[\d,]+\.\d{2})/;
const FOPO_CARD_TAIL_PREFIX_RE = /^\*/;
const HTML_TAG_RE = /<[^>]*>/g;
const FOPO_QTY_RE = /\bQty:\s*(\d+(?:\.\d+)?)/i;
const UFPO_ITEM_ROW_ID_RE = /^([A-Z0-9]{10})-item-grid-row$/;
const UFPO_TOTAL_LABEL_RE = /total/i;

const PAY_METHOD_MAX_LEN = 200;
const ADDRESS_MAX_LEN = 240;
const RECIPIENT_MAX_LEN = 80;
const STATUS_MAX_LEN = 180;
const ITEM_NAME_MAX_LEN = 240;
const SELLER_MAX_LEN = 120;
const ROW_ANCESTOR_SEARCH_DEPTH = 5;

function normText(el: Element | null | undefined): string {
	return textOf(el).replace(WHITESPACE_RE, " ").trim();
}

function parseShippingAddress(
	shipEl: Element | null,
	store: AmazonStore = DEFAULT_AMAZON_STORE,
): {
	postal_code: string | null;
	recipient_name: string | null;
	summary: string | null;
} {
	if (!shipEl) {
		return { postal_code: null, recipient_name: null, summary: null };
	}
	// Amazon wraps each address line as <li><span class="a-list-item">…</span></li>.
	// The previous selector "ul li span.a-list-item, ul li" matched BOTH the
	// outer <li> and its inner <span>, producing duplicated entries like
	// "Name, Name, 123 Main St, 123 Main St". Prefer the inner span when
	// present (it's the clean text node); fall back to the <li> text for
	// address layouts without the spans.
	const lis = [...shipEl.querySelectorAll<HTMLElement>("ul li")];
	const lines = lis
		.map((li) => {
			const span = li.querySelector<HTMLElement>("span.a-list-item");
			return normText(span ?? li);
		})
		.filter(Boolean);
	const [first] = lines;
	const recipient_name =
		first && first.length < RECIPIENT_MAX_LEN ? first : null;
	const summary = lines.length
		? lines.join(", ").slice(0, ADDRESS_MAX_LEN)
		: null;
	return {
		postal_code: extractPostalCode(lines, store),
		recipient_name,
		summary,
	};
}

function parsePaymentMethod(payEl: Element | null): string | null {
	if (!payEl) {
		return null;
	}
	let raw = textWithAlts(payEl);
	raw = raw
		.replace(PAY_PREFIX_RE, "")
		.replace(PAY_SUFFIX_RE, "")
		.replace(CARD_PATCH_RE, "$1 ending in")
		.trim();
	const cardOnly = raw.match(CARD_ONLY_RE);
	if (cardOnly?.[1]) {
		return cardOnly[1];
	}
	if (raw && !UNABLE_RE.test(raw) && !CODE_LIKE_RE.test(raw)) {
		return raw.slice(0, PAY_METHOD_MAX_LEN);
	}
	return null;
}

function parseGrandTotal(chargeEl: Element | null): string | null {
	if (!chargeEl) {
		return null;
	}
	const rows = [
		...chargeEl.querySelectorAll<HTMLElement>("li, .od-line-item-row"),
	];
	for (const r of rows) {
		const t = textOf(r).replace(WHITESPACE_RE, " ");
		const m = t.match(GRAND_TOTAL_RE);
		if (m?.[1]) {
			return m[1].trim();
		}
	}
	const m2 = textOf(chargeEl).replace(WHITESPACE_RE, " ").match(GRAND_TOTAL_RE);
	if (m2?.[1]) {
		return m2[1].trim();
	}
	return null;
}

function findRowRoot(rightGrid: Element): Element {
	let rowRoot: Element | null = rightGrid;
	for (let i = 0; i < ROW_ANCESTOR_SEARCH_DEPTH && rowRoot; i += 1) {
		if (rowRoot.querySelector('[data-component="purchasedItemsLeftGrid"]')) {
			return rowRoot;
		}
		rowRoot = rowRoot.parentElement;
	}
	return rightGrid;
}

function parseDetailItem(
	rightGrid: Element,
	store: AmazonStore,
): DetailItem | null {
	const scanRoot = findRowRoot(rightGrid);

	const titleEl = rightGrid.querySelector<HTMLElement>(
		'[data-component="itemTitle"]',
	);
	const titleLink = titleEl?.querySelector<HTMLAnchorElement>("a") ?? null;
	const name = normText(titleLink ?? titleEl);
	const href = titleLink?.getAttribute("href") ?? "";
	const asinM = href.match(ASIN_RE);
	if (!(asinM?.[1] && name)) {
		return null;
	}
	const absoluteHref = absoluteStoreUrl(store, href);

	const merchantEl = rightGrid.querySelector<HTMLElement>(
		'[data-component="orderedMerchant"]',
	);
	let seller: string | null = null;
	if (merchantEl) {
		const t = normText(merchantEl);
		const sm = t.match(SOLD_BY_RE);
		seller = sm?.[1]
			? sm[1].trim().slice(0, SELLER_MAX_LEN)
			: t.slice(0, SELLER_MAX_LEN) || null;
	}

	const priceEl = rightGrid.querySelector<HTMLElement>(
		'[data-component="unitPrice"]',
	);
	let unit_price: string | null = null;
	if (priceEl) {
		const pt = normText(priceEl);
		const pm = pt.match(DOLLAR_RE);
		unit_price = pm?.[1] ? pm[1].trim() : null;
	}

	const qtyOverlayEl = scanRoot.querySelector<HTMLElement>(
		".od-item-view-qty span, .od-item-view-qty",
	);
	const qtyOverlayText = textOf(qtyOverlayEl).trim();
	const quantity = INT_RE.test(qtyOverlayText) ? Number(qtyOverlayText) : 1;

	const img = scanRoot.querySelector<HTMLElement>(
		'[data-component="itemImage"] img, [data-component="purchasedItemsLeftGrid"] img',
	);
	const item_image_url = img?.getAttribute("src") ?? null;

	let refund_status: string | null = null;
	const returnEl = rightGrid.querySelector<HTMLElement>(
		'[data-component="itemReturnEligibility"]',
	);
	const returnText = normText(returnEl);
	if (returnText && returnText.length < STATUS_MAX_LEN) {
		refund_status = returnText;
	}

	return {
		asin: asinM[1],
		name: name.slice(0, ITEM_NAME_MAX_LEN),
		url: absoluteHref,
		unit_price,
		quantity,
		seller,
		item_image_url,
		refund_status,
	};
}

function parseFopoPaymentMethod(summaryEl: Element | null): string | null {
	const brand = normText(
		summaryEl?.querySelector('[id^="wfm-"][id$="-card-brand"]'),
	);
	const tail = normText(
		summaryEl?.querySelector('[id^="wfm-"][id$="-card-tail"]'),
	).replace(FOPO_CARD_TAIL_PREFIX_RE, "");
	if (brand && tail) {
		return `${brand} ending in ${tail}`.slice(0, PAY_METHOD_MAX_LEN);
	}
	return null;
}

function parseFopoStoreSummary(destinationEl: Element | null): string | null {
	if (!destinationEl) {
		return null;
	}
	const source = destinationEl.querySelector("span") ?? destinationEl;
	const html = (source as { innerHTML?: string }).innerHTML ?? "";
	const lines = (
		html.includes("<br") ? html.split(FOPO_BR_RE) : [textOf(source)]
	)
		.map((line) => line.replace(HTML_TAG_RE, " "))
		.map((line) => line.replace(WHITESPACE_RE, " ").trim())
		.map((line) => line.trim())
		.filter(Boolean);
	return lines.length > 0 ? lines.join(", ").slice(0, ADDRESS_MAX_LEN) : null;
}

function parseFopoDetailItem(
	row: Element,
	store: AmazonStore,
): DetailItem | null {
	const img = row.querySelector<HTMLElement>("img.ufpo-itemListWidget-image");
	const titleLink = row.querySelector<HTMLAnchorElement>(
		'a[href*="/dp/"], a[href*="/gp/product/"]',
	);
	const nameBox = row.querySelector<HTMLElement>(
		".a-column.a-span10 .a-row.a-spacing-none .a-column.a-span10",
	);
	const titleFallback =
		nameBox?.querySelector<HTMLElement>("span.a-size-small") ?? null;
	const name = normText(titleLink ?? titleFallback);
	if (!name) {
		return null;
	}

	const href = titleLink?.getAttribute("href") ?? "";
	const asinM = href.match(ASIN_RE);
	const absoluteHref = absoluteStoreUrl(store, href);

	const priceText = [
		...row.querySelectorAll<HTMLElement>(".a-text-right span.a-size-small"),
	]
		.map((el) => normText(el))
		.find((text) => DOLLAR_RE.test(text));
	const unitPriceMatch =
		normText(row).match(FOPO_AT_PRICE_RE) ?? priceText?.match(DOLLAR_RE);
	let unit_price: string | null = null;
	if (unitPriceMatch?.[1]) {
		unit_price = unitPriceMatch[1].trim();
	}

	const qtyMatch = normText(row).match(FOPO_QTY_RE);
	const quantity = qtyMatch?.[1] ? Number(qtyMatch[1]) : 1;

	return {
		asin: asinM?.[1] ?? null,
		name: name.slice(0, ITEM_NAME_MAX_LEN),
		url: absoluteHref,
		unit_price,
		quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
		seller: null,
		item_image_url: img?.getAttribute("src") ?? null,
		refund_status: null,
	};
}

function parseFopoOrderDetailDom(
	document: Document,
	store: AmazonStore,
): OrderDetail | null {
	const itemList = document.querySelector("#f3_food_ItemList");
	const summaryEl = document.querySelector("#f3_food_WfmInStoreOrderSummary");
	if (!(itemList || summaryEl)) {
		return null;
	}

	const rows = itemList
		? [...itemList.querySelectorAll<HTMLElement>(".a-row.a-spacing-base")]
		: [];
	const items = rows
		.map((row) => parseFopoDetailItem(row, store))
		.filter((item): item is DetailItem => Boolean(item));
	const grandTotal = normText(
		summaryEl?.querySelector("#wfm-grand-total-amount"),
	);
	const status = normText(document.querySelector("#ufpo-order-status-primary"));

	return {
		status_detail: status && status.length < STATUS_MAX_LEN ? status : null,
		recipient_name: null,
		shipping_address_summary: parseFopoStoreSummary(
			document.querySelector("#f3_food_DestinationInfo"),
		),
		payment_method_summary: parseFopoPaymentMethod(summaryEl),
		grand_total: DOLLAR_RE.test(grandTotal)
			? (grandTotal.match(DOLLAR_RE)?.[0] ?? null)
			: null,
		gift_order: false,
		digital_order: false,
		items,
	};
}

function parseUfpoDetailItem(
	row: Element,
	store: AmazonStore,
): DetailItem | null {
	const titleLink = row.querySelector<HTMLAnchorElement>(
		'a[href*="/dp/"], a[href*="/gp/product/"]',
	);
	const name = normText(titleLink);
	const href = titleLink?.getAttribute("href") ?? "";
	const asinM = href.match(ASIN_RE) ?? row.id.match(UFPO_ITEM_ROW_ID_RE);
	if (!(name && asinM?.[1])) {
		return null;
	}

	const absoluteHref = absoluteStoreUrl(store, href);
	const itemRow = titleLink?.closest<HTMLElement>(".a-row") ?? row;
	const cells = [...itemRow.children].filter(
		(child) => child.getAttribute("role") === "gridcell",
	);
	const quantityText = normText(cells[1]);
	const quantity = INT_RE.test(quantityText) ? Number(quantityText) : 1;
	const totalText = normText(cells.at(-1));
	const totalMatch = totalText.match(DOLLAR_RE);
	const itemStatus = normText(row.querySelector(".ufpo-item-status"));

	return {
		asin: asinM[1],
		name: name.slice(0, ITEM_NAME_MAX_LEN),
		url: absoluteHref,
		unit_price: quantity === 1 && totalMatch?.[1] ? totalMatch[1].trim() : null,
		quantity,
		seller: null,
		item_image_url:
			row
				.querySelector<HTMLImageElement>(".ufpo-item-image-column img")
				?.getAttribute("src") ?? null,
		refund_status:
			itemStatus && itemStatus.length < STATUS_MAX_LEN ? itemStatus : null,
	};
}

function parseUfpoGrandTotal(summaryEl: Element | null): string | null {
	if (!summaryEl) {
		return null;
	}
	let total: string | null = null;
	for (const row of summaryEl.querySelectorAll<HTMLElement>(".a-row")) {
		const label = normText(row.querySelector("dt"));
		const value = normText(row.querySelector("dd"));
		const match = value.match(DOLLAR_RE);
		if (UFPO_TOTAL_LABEL_RE.test(label) && match?.[1]) {
			total = match[1].trim();
		}
	}
	return total;
}

function parseUfpoOrderDetailDom(
	document: Document,
	store: AmazonStore,
): OrderDetail | null {
	const itemTable = document.querySelector(".ufpo-item-list-table");
	const status = [
		normText(document.querySelector("#ufpo-order-status-primary")),
		normText(document.querySelector("#ufpo-order-status-secondary")),
	]
		.filter(Boolean)
		.join(" · ");
	if (!(itemTable || status)) {
		return null;
	}

	const rows = itemTable
		? [...itemTable.querySelectorAll<HTMLElement>('[id$="-item-grid-row"]')]
		: [];
	const items = rows
		.map((row) => parseUfpoDetailItem(row, store))
		.filter((item): item is DetailItem => Boolean(item));
	if (items.length === 0) {
		return null;
	}

	return {
		status_detail: status && status.length < STATUS_MAX_LEN ? status : null,
		recipient_name: null,
		shipping_address_summary: null,
		payment_method_summary: parsePaymentMethod(
			document.querySelector(".pmts-payments-instrument-details"),
		),
		grand_total: parseUfpoGrandTotal(
			document.querySelector(".ufpo-order-summary-list"),
		),
		gift_order: false,
		digital_order: false,
		items,
	};
}

function parseUffOrderDetailDom(
	document: Document,
	store: AmazonStore,
): OrderDetail | null {
	const card = document.querySelector<HTMLElement>(
		".order-card, .js-order-card",
	);
	const order = card ? parseOrderCard(card, store) : null;
	if (!order || order.items.length === 0) {
		return null;
	}

	return {
		status_detail: order.deliveryStatus,
		recipient_name: null,
		shipping_address_summary: null,
		payment_method_summary: null,
		grand_total: order.orderTotal,
		gift_order: false,
		digital_order: false,
		items: order.items.map((item) => ({
			asin: item.asin,
			name: item.name,
			url: item.url,
			unit_price: null,
			quantity: 1,
			seller: null,
			item_image_url: null,
			refund_status: null,
		})),
	};
}

export function parseOrderDetailDom(
	html: string,
	store: AmazonStore = DEFAULT_AMAZON_STORE,
): OrderDetail | null {
	const { document } = parseHTML(html);
	const od = document.querySelector("#orderDetails");
	if (!od) {
		return (
			parseFopoOrderDetailDom(document, store) ??
			parseUfpoOrderDetailDom(document, store) ??
			parseUffOrderDetailDom(document, store)
		);
	}

	const cancelledEl = od.querySelector('[data-component="cancelled"]');
	const cancelledText = normText(cancelledEl);
	const isCancelled = CANCELLED_RE.test(cancelledText);

	const shipEl = od.querySelector('[data-component="shippingAddress"]');
	const {
		postal_code: shipping_postal_code,
		recipient_name,
		summary: shipping_address_summary,
	} = parseShippingAddress(shipEl, store);

	const payEl = od.querySelector(
		'[data-component="viewPaymentPlanSummaryWidget"]',
	);
	const payment_method_summary = parsePaymentMethod(payEl);

	const chargeEl = od.querySelector('[data-component="chargeSummary"]');
	const grand_total = parseGrandTotal(chargeEl);

	let status_detail: string | null = null;
	if (isCancelled) {
		status_detail = "This order has been cancelled";
	} else if (ITEM_CANCELLED_RE.test(cancelledText)) {
		// Preserve the recognized partial cancellation without dropping
		// purchased items. Unrecognized wording falls through to alerts.
		if (cancelledText.length < STATUS_MAX_LEN) {
			status_detail = cancelledText;
		}
	} else {
		const alertsEl = od.querySelector('[data-component="alerts"]');
		const alertText = normText(alertsEl);
		if (alertText && alertText.length < STATUS_MAX_LEN) {
			status_detail = alertText;
		}
	}

	const giftEl = od.querySelector(
		'[data-component="giftMessage"], [data-component="giftcardsSender"], [data-component="giftCardDetails"]',
	);
	const gift_order = Boolean(giftEl && textOf(giftEl).trim());
	const digital_order = false;

	if (isCancelled) {
		return {
			status_detail,
			recipient_name: null,
			shipping_address_summary: null,
			payment_method_summary: null,
			grand_total: null,
			gift_order: false,
			digital_order: false,
			items: [],
		};
	}

	const itemContainers = [
		...od.querySelectorAll('[data-component="purchasedItemsRightGrid"]'),
	];
	const items: DetailItem[] = [];
	for (const rightGrid of itemContainers) {
		const item = parseDetailItem(rightGrid, store);
		if (item) {
			items.push(item);
		}
	}

	return {
		status_detail,
		recipient_name,
		shipping_address_summary,
		shipping_postal_code,
		payment_method_summary,
		grand_total,
		gift_order,
		digital_order,
		items,
	};
}

export function parseOrdersListDom(
	html: string,
	store: AmazonStore = DEFAULT_AMAZON_STORE,
): ListPageOrder[] {
	const { document } = parseHTML(html);
	const cards = document.querySelectorAll<HTMLElement>(
		".order-card, .js-order-card",
	);
	const results: ListPageOrder[] = [];
	for (const card of cards) {
		const parsed = parseOrderCard(card, store);
		if (parsed) {
			results.push(parsed);
		}
	}
	return results;
}

/**
 * Count `.order-card`/`.js-order-card` elements that `parseOrdersListDom`
 * silently drops because `findOrderId` found no `.yohtmlc-order-id` span
 * matching the canonical order-id shape. `parseOrderCard`'s `if (!orderId)
 * return null` (and `parseOrdersListDom`'s discard of that `null`) leaves no
 * other trace: the card never reaches the shape-check, so it never produces
 * a SKIP_RESULT, a coverage-considered id, or a rejection — a page can lose
 * cards here with zero connector-visible evidence. Called alongside
 * `parseOrdersListDom` so a caller can detect and report the gap the parse
 * step itself cannot see (it only ever sees what survived).
 */
export function countOrderCardsWithoutOrderId(html: string): number {
	const { document } = parseHTML(html);
	const cards = document.querySelectorAll<HTMLElement>(
		".order-card, .js-order-card",
	);
	let dropped = 0;
	for (const card of cards) {
		if (!findOrderId(card)) {
			dropped += 1;
		}
	}
	return dropped;
}

/**
 * Parse the account nav bar (present on any signed-in Amazon page, not just
 * order pages) for the owner's display name and Prime membership. Both are
 * best-effort: a signed-out or layout-drifted page yields `name: null` and
 * `is_prime: null` rather than a guess (D4 — an unparseable value is null,
 * never guessed). `id` is a stable placeholder ("me") because Amazon's nav
 * bar carries no account id, only a display greeting.
 */
export function parseAmazonProfileDom(
	html: string,
	store: AmazonStore = DEFAULT_AMAZON_STORE,
): ProfileRecord {
	const { document } = parseHTML(html);
	const greetingEl = document.querySelector(
		"#nav-link-accountList .nav-line-1",
	);
	const greeting = normText(greetingEl);
	// "Hello, sign in" is Amazon's signed-out greeting, not a name — the "Hello,"
	// prefix is shared by both states, so the match alone can't tell them apart.
	const isSignedOut =
		NAV_SIGN_IN_RE.test(greeting) || NAV_CUSTOMER_SIGNED_OUT_RE.test(html);
	const nameMatch = isSignedOut ? null : NAV_GREETING_RE.exec(greeting);
	const name = nameMatch?.[1]?.trim() || null;

	const is_prime = isSignedOut ? null : parsePrimeMembership(document, html);

	// The nav's "Deliver to" location is the account's default delivery
	// address while signed in: "Deliver to Ada" / "Toronto M6J 0B3". Only its
	// postal code is kept, never the street. It is in the shape of the
	// country delivered to, which an amazon.com account can set to Canada.
	const postal_code = isSignedOut
		? null
		: parsePostalCode([navDeliverToText(document)], store, {
				skipFirst: false,
			});

	return { id: "me", name, is_prime, postal_code, store: store.name };
}

/**
 * Prime membership on a signed-in page. The nav's inline config states it on
 * every store (`config.isPrimeMember`, then the menu args' `isPrime`). The old
 * `#nav-prime-menu`/`#navbar-prime` elements are gone from amazon.com's nav
 * and are only a fallback. Null when the page carries none of these.
 */
function parsePrimeMembership(
	document: Document,
	html: string,
): boolean | null {
	const declared = NAV_IS_PRIME_MEMBER_RE.exec(html)?.[1];
	if (declared) {
		return declared === "true";
	}
	const menu = NAV_MENU_IS_PRIME_RE.exec(html)?.[1];
	if (menu) {
		return menu === "1" || menu === "true";
	}
	const primeEl = document.querySelector("#nav-prime-menu, #navbar-prime");
	return primeEl ? PRIME_MEMBER_TEXT_RE.test(normText(primeEl)) : null;
}

/** The nav's whole "Deliver to" text: both lines, or the one-line layout. */
function navDeliverToText(document: Document): string {
	const parts = [
		"#glow-ingress-line1",
		"#glow-ingress-line2",
		"#glow-ingress-single-line",
	]
		.map((selector) => normText(document.querySelector(selector)))
		.filter(Boolean);
	const text = parts.length
		? parts.join(" ")
		: normText(document.querySelector("#nav-global-location-slot"));
	return text.replace(ZERO_WIDTH_RE, "");
}

// Month names of every store's language, by their first three letters after
// accents are removed (French "juin"/"juillet" need four). English, German,
// French, Italian, Spanish, Portuguese.
const MONTH_PREFIX: Readonly<Record<string, number>> = {
	jan: 1,
	ene: 1,
	gen: 1,
	feb: 2,
	fev: 2,
	mar: 3,
	apr: 4,
	abr: 4,
	avr: 4,
	may: 5,
	mai: 5,
	mag: 5,
	jun: 6,
	giu: 6,
	juin: 6,
	jul: 7,
	lug: 7,
	juil: 7,
	aug: 8,
	ago: 8,
	aou: 8,
	sep: 9,
	set: 9,
	oct: 10,
	okt: 10,
	ott: 10,
	out: 10,
	nov: 11,
	dec: 12,
	dez: 12,
	dic: 12,
};
const JP_DATE_RE = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const ACCENTS_RE = /[\u0300-\u036f]/g;
const DATE_WORD_RE = /[a-z]+|\d+/g;
const DIGITS_ONLY_RE = /^\d+$/;
const MIN_ORDER_YEAR = 1994;
const MAX_ORDER_YEAR = 2100;

function isoDate(year: number, month: number, day: number): string | null {
	if (year < MIN_ORDER_YEAR || year > MAX_ORDER_YEAR || day < 1) {
		return null;
	}
	const d = new Date(Date.UTC(year, month - 1, day));
	if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
		return null;
	}
	return d.toISOString().slice(0, 10);
}

/** A day written with a month NAME in any store's language: "15 March 2024", "15. März 2024", "15 de março de 2024", "2024年3月15日". */
function parseLocalizedDate(raw: string): string | null {
	const jp = JP_DATE_RE.exec(raw);
	if (jp) {
		return isoDate(Number(jp[1]), Number(jp[2]), Number(jp[3]));
	}
	const words =
		raw
			.normalize("NFD")
			.replace(ACCENTS_RE, "")
			.toLowerCase()
			.match(DATE_WORD_RE) ?? [];
	let month: number | undefined;
	let year: number | undefined;
	let day: number | undefined;
	for (const word of words) {
		if (DIGITS_ONLY_RE.test(word)) {
			if (word.length === 4 && year === undefined) {
				year = Number(word);
			} else if (word.length <= 2 && day === undefined) {
				day = Number(word);
			}
		} else if (month === undefined) {
			month = MONTH_PREFIX[word.slice(0, 4)] ?? MONTH_PREFIX[word.slice(0, 3)];
		}
	}
	if (month === undefined || year === undefined || day === undefined) {
		return null;
	}
	return isoDate(year, month, day);
}

export function parseOrderDate(raw: string | null | undefined): string | null {
	if (!raw) {
		return null;
	}
	const localized = parseLocalizedDate(raw);
	if (localized) {
		return localized;
	}
	const value = raw.trim();
	const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	if (iso) {
		return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
	}
	// Date parses zone-less text in the host zone. Accept it only when the text
	// carries both a time and an explicit zone, so the UTC day is host-independent.
	if (
		!/(?:T|\s)\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\s*(?:Z|[+-]\d{2}:?\d{2}|(?:GMT|UTC)(?:[+-]\d{2}:?\d{2})?|UT|[ECMP][SD]T)$/i.test(
			value,
		)
	) {
		return null;
	}
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) {
		return null;
	}
	return d.toISOString().slice(0, 10);
}

export function parseCurrencyCents(
	raw: string | null | undefined,
): number | null {
	if (!raw) {
		return null;
	}
	const s = String(raw);
	const negative = CURRENCY_NEGATIVE_SIGN_RE.test(s);
	const digits = s.match(CURRENCY_DIGITS_RE)?.[0]?.trim();
	if (!digits) {
		return null;
	}
	// The decimal separator is the LAST "." or "," followed by one or two
	// digits ("1,234.56", "1.234,56", "12,34"); every other separator groups
	// thousands ("$1,000,000", "₹1,23,456.00", "￥1,234").
	const decimal = CURRENCY_DECIMAL_RE.exec(digits);
	const whole = (decimal ? digits.slice(0, decimal.index) : digits).replace(
		CURRENCY_SEPARATORS_RE,
		"",
	);
	if (!CURRENCY_WHOLE_RE.test(whole)) {
		return null;
	}
	const fraction = decimal?.[1] ? decimal[1].padEnd(2, "0") : "00";
	const cents = Number(whole) * CURRENCY_CENTS_MULTIPLIER + Number(fraction);
	return negative ? -cents : cents;
}

/**
 * Canonical form for name-based item identity. Collapses runs of whitespace
 * (so "Item  Name" and "Item\tName" dedupe), trims, and lowercases. Used as
 * the map key in mergeDetailByKey and by itemId's name fallback, so both
 * sides agree on what "same item" means.
 */
function normalizeItemName(name: string): string {
	return name.replace(ITEM_ID_WHITESPACE_RE, " ").trim().toLowerCase();
}

export function itemId(
	orderId: string,
	it: { asin?: string | null; name?: string },
): string {
	const key =
		it.asin || (it.name ? normalizeItemName(it.name) : "") || "unknown";
	return `${orderId}|${key}`;
}

export function mergeDetailByKey(detailItems: DetailItem[]): {
	byAsin: Map<string, DetailItem>;
	byName: Map<string, DetailItem>;
} {
	const byAsin = new Map<string, DetailItem>();
	const byName = new Map<string, DetailItem>();
	for (const di of detailItems) {
		if (di.asin) {
			byAsin.set(di.asin, di);
		} else if (di.name) {
			byName.set(normalizeItemName(di.name), di);
		}
	}
	return { byAsin, byName };
}

// ─── Order record + item merge ───────────────────────────────────────────

export function isActualReturn(status: string | null | undefined): boolean {
	if (!status) {
		return false;
	}
	// Affirmative phrases win even when eligibility text is also present.
	// Window/eligibility wording alone does not match these phrases.
	return /\breturned\b|\breturn\s+(?:is\s+)?(?:started|complete|received)\b|\brefund\s+(?:has\s+been\s+)?issued\b|\brefunded\b/i.test(
		status,
	);
}

/**
 * Merge list-page items with detail-page items into the final emit-ordered
 * sequence. Preserves original collect() semantics exactly:
 *   1. For each list-page item, find its detail-page counterpart (ASIN first,
 *      then normalized name), spread list→detail, emit.
 *   2. After that, append any detail-page items not seen in the list
 *      (dedup by ASIN or normalized name against list items).
 *   3. Dedup emitted items by their final itemId() so repeats within a
 *      single order aren't duplicated.
 */
export function mergeOrderItems(
	listOrder: ListPageOrder,
	detail: OrderDetail | null,
): MergedItem[] {
	const detailItems = detail?.items ?? [];
	const { byAsin: detailByAsin, byName: detailByName } =
		mergeDetailByKey(detailItems);
	const emittedIds = new Set<string>();
	const out: MergedItem[] = [];

	const push = (merged: MergedItem): void => {
		const id = itemId(listOrder.orderId, merged);
		if (emittedIds.has(id)) {
			return;
		}
		emittedIds.add(id);
		out.push(merged);
	};

	for (const it of listOrder.items) {
		const d: Partial<DetailItem> =
			(it.asin ? detailByAsin.get(it.asin) : undefined) ??
			(it.name ? detailByName.get(normalizeItemName(it.name)) : undefined) ??
			{};
		push({ ...it, ...d });
	}
	// Detail-page items that weren't in the list.
	for (const di of detailItems) {
		const dupByAsin =
			di.asin && listOrder.items.some((x) => x.asin === di.asin);
		const diNorm = di.name ? normalizeItemName(di.name) : "";
		const dupByName =
			diNorm &&
			listOrder.items.some(
				(x) => x.name && normalizeItemName(x.name) === diNorm,
			);
		if (!(dupByAsin || dupByName)) {
			push(di);
		}
	}
	return out;
}

/** Build the emitted OrderItemRecord for a single merged item. */
export function buildOrderItemRecord(
	orderId: string,
	orderDate: string,
	merged: MergedItem,
): OrderItemRecord {
	return {
		id: itemId(orderId, merged),
		order_id: orderId,
		order_date: orderDate,
		asin: merged.asin || null,
		name: merged.name,
		url: merged.url || null,
		unit_price: merged.unit_price || null,
		unit_price_cents: parseCurrencyCents(merged.unit_price ?? null),
		quantity: merged.quantity ?? 1,
		seller: merged.seller || null,
		item_image_url: merged.item_image_url || null,
		returned: isActualReturn(merged.refund_status),
		refund_status: merged.refund_status || null,
	};
}

/**
 * Build the emitted OrdersRecord for a list-page order, optionally enriched
 * with the detail-page fetch. Prefers detail-page grand total (includes tax)
 * over the list-page total.
 */
/**
 * Resolve the order's item count, or null when neither surface can prove one.
 *
 * Amazon asserts no item count anywhere we read; the number is the count of
 * item elements we managed to parse, from two independent surfaces. That makes
 * a zero ambiguous, and the ambiguity was being resolved the wrong way.
 *
 * The list card only renders item titles for SMALL orders. Live data is
 * unambiguous about this: across 1,183 collected orders, `item_count === 0`
 * NEVER occurs on an order holding 1 or 2 items, and occurs on 53 orders
 * holding 3-7 — Amazon collapses 3+ item orders behind a "+N more items"
 * affordance that renders no per-item titles. For those orders the list
 * contributes 0 and the count rests entirely on the order-detail page.
 *
 * When that detail fetch is deferred (per-run attempt budget, temporary-failure
 * cap, or a latched session repair) `detail` is null, and the previous
 * `Math.max(list, detail ?? 0)` collapsed to a confident `0`. Every one of
 * those 53 orders also has a null `shipping_address_summary`, confirming the
 * detail page — not the parse — is what was missing. The record then claimed an
 * empty order while the database held 3-7 item rows for it.
 *
 * A non-nullable count cannot express "not fetched", so a fetch failure was
 * indistinguishable from a genuinely empty order. Returning null when no
 * surface saw an item keeps a real empty order (which reaches here with a
 * successful detail) reporting 0, while an unfetched one reports unknown.
 */
function resolveItemCount(
	listOrder: ListPageOrder,
	detail: OrderDetail | null,
): number | null {
	const counted = Math.max(listOrder.items.length, detail?.items?.length ?? 0);
	if (counted > 0) {
		return counted;
	}
	// Nothing counted. Only the detail page can distinguish an empty order from
	// an unobserved one: with it we looked and found nothing, without it we never
	// looked at the surface that carries items for anything but a tiny order.
	return detail ? 0 : null;
}

export function buildOrderRecord(
	listOrder: ListPageOrder,
	detail: OrderDetail | null,
	orderDate: string,
	// `emittedAt` (the run clock) is accepted for call-site/signature stability
	// across every build*Record sibling but intentionally unused: PDPP
	// spec-core now forbids a connector from putting its own collection time
	// into `data` (that is the envelope's `emitted_at`, stamped by the
	// runtime, not the connector). Kept as a parameter so fingerprint-cursor
	// helpers like `listSurfaceFingerprint` don't need their own signatures
	// disturbed.
	_emittedAt: string,
): OrdersRecord {
	const orderTotalRaw = detail?.grand_total || listOrder.orderTotal || null;
	return {
		id: listOrder.orderId,
		order_date: orderDate,
		order_total: orderTotalRaw,
		order_total_cents: parseCurrencyCents(orderTotalRaw),
		delivery_status: listOrder.deliveryStatus || null,
		status_detail: detail?.status_detail || null,
		recipient_name: detail?.recipient_name || null,
		shipping_address_summary: detail?.shipping_address_summary || null,
		shipping_postal_code: detail?.shipping_postal_code || null,
		store: listOrder.store ?? null,
		payment_method_summary: detail?.payment_method_summary || null,
		gift_order: detail?.gift_order ?? false,
		digital_order: detail?.digital_order ?? false,
		item_count: resolveItemCount(listOrder, detail),
	};
}

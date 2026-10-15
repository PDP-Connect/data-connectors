// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure parsers for the Shopify (Shop app) connector. Kept free of
// Playwright/Node I/O so they can be unit-tested against a captured or
// synthetic Apollo cache extract in isolation.
//
// Ground truth for the extraction strategy: connectors/shopify/shop-playwright.js
// (legacy Playwright connector, prior art per docs/migration/connector-cutover/
// CONTRACTS.md D10). Shop app is a React/Apollo Client SPA; the live client
// cache (reachable by walking the React fiber tree from the DOM root, not from
// `window.__APOLLO_STATE__`, which is only the initial SSR snapshot) accumulates
// every order page loaded during the run under a colon-format key:
//   ROOT_QUERY."deliveriesOrdersList:{...}".nodes -> [{ __ref: "Order:<id>" }, ...]
// Each `Order:<id>` cache entry holds the order fields; `shop` and
// `lineItems.nodes[].productTitle` are resolved through their own `__ref`s.

import { parseHTML } from "linkedom";
import type { ApolloCache, ApolloCacheEntry, ParsedOrder } from "./types.ts";
import { isApolloRef } from "./types.ts";

const CENTS_PER_UNIT = 100;
const PAGINATED_LIST_KEY_RE = /^deliveriesOrdersList:/;
const CURSOR_LIST_KEY_RE = /^deliveriesOrdersList\(/;
const SHOP_MONEY_RE =
	/(?:\$\s*([\d,]+(?:\.\d{1,2})?)|([\d,]+(?:\.\d{1,2})?)\s*(USD|EUR|GBP|CAD)\b)/i;
const SHOP_ITEM_COUNT_RE = /\b(\d+)\s*items?\b/i;
const SHOP_STATUS_RE =
	/\b(delivered|shipped|in transit|processing|cancelled|canceled|fulfilled)\b/i;
const SHOP_AMOUNT_LINE_RE =
	/^(?:\$\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|CAD))\b/i;

/**
 * Legacy-parity DOM fallback for cards visible when Apollo has not hydrated
 * its order connection. This follows the prior connector's Shop link/card
 * walk and maps only fields that the visible card supports; item titles and
 * dates stay absent instead of being inferred.
 */
export function parseDomOrderCards(html: string): ParsedOrder[] {
	const { document } = parseHTML(html);
	const orders: ParsedOrder[] = [];
	const seen = new Set<string>();
	for (const link of document.querySelectorAll<HTMLAnchorElement>(
		'a[href*="shop.app"]',
	)) {
		const href = link.getAttribute("href") ?? "";
		let url: URL;
		try {
			url = new URL(href, SHOP_ORDER_HISTORY_URL);
		} catch {
			continue;
		}
		if (url.origin !== "https://shop.app") continue;
		const card =
			link.closest<HTMLElement>(
				'.order-card, [data-testid*="order"], [data-test*="order"], div[class]',
			) ?? link;
		const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text.length < 10) continue;
		const key = text.slice(0, 120);
		if (seen.has(key)) continue;
		const money = text.match(SHOP_MONEY_RE);
		const itemCount = text.match(SHOP_ITEM_COUNT_RE);
		if (!money && !itemCount) continue;
		seen.add(key);

		const orderUrl = resolveCardOrderUrl(card, url);

		const merchantName =
			(card.textContent ?? "")
				.split(/[\n·•]/)
				.map((part) => part.replace(/\s+/g, " ").trim())
				.find(
					(part) =>
						part.length > 2 &&
						part.length < 80 &&
						!/^\d+\s*items?\b/i.test(part) &&
						!SHOP_AMOUNT_LINE_RE.test(part) &&
						!/orders?|order history/i.test(part),
				) ?? null;
		const amount = money
			? Number((money[1] ?? money[2] ?? "").replaceAll(",", ""))
			: Number.NaN;
		const status = text.match(SHOP_STATUS_RE)?.[0] ?? null;
		orders.push({
			currency: money ? (money[3]?.toUpperCase() ?? "USD") : null,
			detailUrl: orderUrl.href,
			id: orderUrl.href,
			itemCount: itemCount ? Number(itemCount[1]) : null,
			lineItemTitles: [],
			merchantName,
			orderNumber: null,
			placedAt: null,
			status,
			totalCents: Number.isFinite(amount) ? Math.round(amount * 100) : null,
		});
	}
	return orders;
}

function resolveCardOrderUrl(card: Element, fallback: URL): URL {
	for (const cardLink of card.querySelectorAll<HTMLAnchorElement>(
		'a[href*="shop.app"]',
	)) {
		const href = cardLink.getAttribute("href") ?? "";
		let url: URL;
		try {
			url = new URL(href, SHOP_ORDER_HISTORY_URL);
		} catch {
			continue;
		}
		if (url.origin === "https://shop.app" && /\/orders?\//.test(url.pathname)) {
			return url;
		}
	}
	return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(cache: ApolloCache, ref: string): ApolloCacheEntry | null {
	const entry = cache[ref];
	return isRecord(entry) ? entry : null;
}

/**
 * Collect every distinct `Order:<id>` ref from a `deliveriesOrdersList`-shaped
 * connection's `nodes` array. Mirrors the legacy `collectRefs` helper.
 */
function collectOrderRefs(nodes: unknown): string[] {
	if (!Array.isArray(nodes)) {
		return [];
	}
	const refs: string[] = [];
	for (const node of nodes) {
		if (isApolloRef(node) && node.__ref.startsWith("Order:")) {
			refs.push(node.__ref);
		}
	}
	return refs;
}

/** True when `ROOT_QUERY` holds any orders connection key, even an empty one. */
export function hasOrdersConnection(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	return (
		isRecord(root) &&
		Object.keys(root).some(
			(key) => PAGINATED_LIST_KEY_RE.test(key) || CURSOR_LIST_KEY_RE.test(key),
		)
	);
}

/**
 * Every `Order:<id>` ref reachable from `ROOT_QUERY`, deduplicated, preferring
 * the paginated accumulation key (populated by scrolling; holds every page
 * loaded so far) and falling back to the cursor-paginated keys (present on
 * first load, before any scroll has happened).
 */
export function collectAllOrderRefs(cache: ApolloCache): string[] {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) {
		return [];
	}
	const seen = new Set<string>();
	const ordered: string[] = [];
	const addAll = (refs: string[]): void => {
		for (const ref of refs) {
			if (!seen.has(ref)) {
				seen.add(ref);
				ordered.push(ref);
			}
		}
	};

	for (const key of Object.keys(root)) {
		if (!PAGINATED_LIST_KEY_RE.test(key)) {
			continue;
		}
		const connection = root[key];
		if (isRecord(connection)) {
			addAll(collectOrderRefs(connection.nodes));
		}
	}
	for (const key of Object.keys(root)) {
		if (!CURSOR_LIST_KEY_RE.test(key)) {
			continue;
		}
		const connection = root[key];
		if (isRecord(connection)) {
			addAll(collectOrderRefs(connection.nodes));
		}
	}
	return ordered;
}

/**
 * `hasNextPage` across every `deliveriesOrdersList` connection reachable from
 * `ROOT_QUERY`. Prefers the paginated accumulation key; falls back to any
 * cursor-paginated key still advertising more.
 */
export function hasNextOrdersPage(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) {
		return false;
	}
	const connections = Object.entries(root).filter(([key]) =>
		PAGINATED_LIST_KEY_RE.test(key) || CURSOR_LIST_KEY_RE.test(key),
	);
	if (connections.length === 0) return false;
	return connections.some(([, value]) =>
		!isRecord(value) || !isRecord(value.pageInfo) || value.pageInfo.hasNextPage !== false,
	);
}

/** A positive end requires every observed connection to declare no continuation. */
export function hasVerifiedOrdersEnd(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) return false;
	const connections = Object.entries(root).filter(([key]) =>
		PAGINATED_LIST_KEY_RE.test(key) || CURSOR_LIST_KEY_RE.test(key),
	);
	return connections.length > 0 && connections.every(([, value]) =>
		isRecord(value) && isRecord(value.pageInfo) && value.pageInfo.hasNextPage === false,
	);
}

/** Known source totals must reconcile with the deduplicated observed order refs. */
export function hasOrderCountMismatch(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) return false;
	const refs = collectAllOrderRefs(cache);
	return Object.entries(root).some(([key, value]) => {
		if (!PAGINATED_LIST_KEY_RE.test(key) && !CURSOR_LIST_KEY_RE.test(key)) return false;
		if (!isRecord(value)) return true;
	const raw = value.totalCount ?? (isRecord(value.pageInfo) ? value.pageInfo.totalCount : undefined);
		if (typeof raw !== "number" && typeof raw !== "string") return false;
		if (typeof raw === "string" && raw.trim().length === 0) return true;
		const expected = Number(raw);
		return Number.isFinite(expected) && Number.isInteger(expected) && expected !== refs.length;
	});
}

function resolveMerchantName(
	cache: ApolloCache,
	order: ApolloCacheEntry,
): string | null {
	const shopField = order.shop;
	if (!isApolloRef(shopField)) {
		return null;
	}
	const shop = readEntry(cache, shopField.__ref);
	const name = shop?.name;
	return typeof name === "string" ? name : null;
}

/** The one source ID normalization path used by parsing and coverage checks. */
export function resolveOrderId(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

function isNumericScalar(value: unknown): value is number | string {
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Number(value));
}

/**
 * Total price in integer cents, from `effectiveTotalPrice` (preferred) or
 * `totalPriceAfterOfferApplied` — both are `{ amount: string, currencyCode }`
 * Shopify Money-scalar shapes. `amount` is a decimal string; multiplying by
 * 100 and rounding avoids float drift from the source's own string encoding.
 * `null` (not 0) when the source gives nothing parseable — D4: an
 * unparseable value is null, never guessed.
 */
function resolveTotalCents(order: ApolloCacheEntry): {
	currency: string | null;
	totalCents: number | null;
} {
	const price = order.effectiveTotalPrice ?? order.totalPriceAfterOfferApplied;
	if (!isRecord(price)) {
		return { currency: null, totalCents: null };
	}
	const currency =
		typeof price.currencyCode === "string" ? price.currencyCode : null;
	const amount = price.amount;
	const parsed =
		typeof amount === "string" || typeof amount === "number"
			? Number(amount)
			: Number.NaN;
	const totalCents = Number.isFinite(parsed)
		? Math.round(parsed * CENTS_PER_UNIT)
		: null;
	return { currency, totalCents };
}

function resolveLineItemTitles(
	cache: ApolloCache,
	order: ApolloCacheEntry,
): string[] {
	const lineItems = order.lineItems;
	const nodes = isRecord(lineItems) ? lineItems.nodes : null;
	if (!Array.isArray(nodes)) {
		return [];
	}
	const titles: string[] = [];
	for (const node of nodes) {
		if (!isApolloRef(node)) {
			continue;
		}
		const lineItem = readEntry(cache, node.__ref);
		const title = lineItem?.productTitle;
		if (typeof title === "string") {
			titles.push(title);
		}
	}
	return titles;
}

const SHOP_ORDER_HISTORY_URL = "https://shop.app/account/order-history";

/**
 * Parse one `Order:<id>` cache entry into a `ParsedOrder`. Returns `null`
 * when the entry is missing or not order-shaped (an order ref that resolved
 * to nothing, or a differently-shaped cache entry) — the caller skips it
 * rather than emitting a record built from absent data.
 */
export function parseOrderRef(
	cache: ApolloCache,
	ref: string,
): ParsedOrder | null {
	const order = readEntry(cache, ref);
	const id = resolveOrderId(order?.id);
	if (!order || id === null) {
		return null;
	}
	const sourcePrice = order.effectiveTotalPrice ?? order.totalPriceAfterOfferApplied;
	if (isRecord(sourcePrice) && sourcePrice.amount !== null && sourcePrice.amount !== undefined &&
		!isNumericScalar(sourcePrice.amount)) return null;
	if (order.totalItemCount !== null && order.totalItemCount !== undefined &&
		!isNumericScalar(order.totalItemCount)) return null;

	const { currency, totalCents } = resolveTotalCents(order);
	const lineItemTitles = resolveLineItemTitles(cache, order);
	const sourceItemCount = order.totalItemCount;
	const parsedItemCount = typeof sourceItemCount === "number" || typeof sourceItemCount === "string"
		? Number(sourceItemCount)
		: Number.NaN;
	const itemCount = Number.isFinite(parsedItemCount)
			? parsedItemCount
			: lineItemTitles.length > 0
				? lineItemTitles.length
				: null;

	return {
		currency,
		detailUrl: SHOP_ORDER_HISTORY_URL,
		id,
		itemCount,
		lineItemTitles,
		merchantName: resolveMerchantName(cache, order),
		orderNumber: id,
		placedAt: typeof order.createdAt === "string" ? order.createdAt : null,
		status:
			typeof order.displayStatus === "string" ? order.displayStatus : null,
		totalCents,
	};
}

/** Parse every distinct order reachable from `ROOT_QUERY` in one cache extract. */
export function extractOrders(cache: ApolloCache): ParsedOrder[] {
	const orders: ParsedOrder[] = [];
	for (const ref of collectAllOrderRefs(cache)) {
		const order = parseOrderRef(cache, ref);
		if (order) {
			orders.push(order);
		}
	}
	return orders;
}

export interface ExtractedOrders {
	orders: ParsedOrder[];
	discoveredRows: number;
	discardedRows: number;
}

/** Reconcile every observed connection row with the rows the parser can emit. */
export function extractOrdersWithCoverage(cache: ApolloCache): ExtractedOrders {
	const refs = collectAllOrderRefs(cache);
	const root = cache.ROOT_QUERY;
	const connectionEntries = isRecord(root)
		? Object.entries(root).filter(([key]) =>
			PAGINATED_LIST_KEY_RE.test(key) || CURSOR_LIST_KEY_RE.test(key),
		)
		: [];
	const malformedRows = connectionEntries.reduce((count, [, value]) => {
		const nodes = isRecord(value) ? value.nodes : null;
		if (!Array.isArray(nodes)) return count;
		return count + nodes.filter((node) =>
			!isApolloRef(node) || !node.__ref.startsWith("Order:"),
		).length;
	}, 0);
	const orders = refs.flatMap((ref) => {
		const order = parseOrderRef(cache, ref);
		return order ? [order] : [];
	});
	return {
		orders,
		discoveredRows: refs.length + malformedRows,
		discardedRows: refs.length - orders.length + malformedRows,
	};
}

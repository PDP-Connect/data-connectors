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
const SHOP_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
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
		!isReadableConnection(value) || value.pageInfo.hasNextPage !== false,
	);
}

function isReadableConnection(value: unknown): value is Record<string, unknown> & {
	nodes: unknown[];
	pageInfo: Record<string, unknown> & { hasNextPage: boolean };
} {
	return isRecord(value) && Array.isArray(value.nodes) && isRecord(value.pageInfo) &&
		typeof value.pageInfo.hasNextPage === "boolean";
}

function connectionArgs(key: string): Record<string, unknown> | null {
	const colon = key.startsWith("deliveriesOrdersList:");
	const argsText = colon
		? key.slice("deliveriesOrdersList:".length)
		: key.slice("deliveriesOrdersList(".length, -1);
	try {
		const parsed: unknown = JSON.parse(argsText);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isFullHistoryRequestKey(key: string): boolean {
	const args = connectionArgs(key);
	if (!args) return false;
	const allowed = new Set(["filter", "sortBy", "sortKey", "first", "after"]);
	if (Object.keys(args).some((name) => !allowed.has(name))) return false;
	const filter = args.filter;
	if (filter !== undefined && filter !== null && (!isRecord(filter) || Object.keys(filter).length > 0)) return false;
	const after = args.after;
	return after === undefined || after === null || (typeof after === "string" && after.length > 0);
}

function isAccumulatingFullHistoryRequestKey(key: string): boolean {
	if (!PAGINATED_LIST_KEY_RE.test(key) || !isFullHistoryRequestKey(key)) return false;
	const args = connectionArgs(key);
	return args !== null && (args.after === undefined || args.after === null);
}

function hasConnectedCursorChain(connections: Array<[string, unknown]>): boolean {
	const pages: Array<{ key: string; args: Record<string, unknown>; value: NonNullable<ReturnType<typeof asReadableConnection>> }> = [];
	for (const [key, value] of connections) {
		const args = connectionArgs(key);
		const readable = asReadableConnection(value);
		if (!args || !readable) return false;
		pages.push({ key, args, value: readable });
	}
	if (pages.length === 1) {
		return (pages[0]?.args.after === undefined || pages[0]?.args.after === null) && pages[0]?.value.pageInfo.hasNextPage === false;
	}
	const firstPages = pages.filter((page) => page.args.after === undefined || page.args.after === null);
	if (firstPages.length !== 1) return false;
	let current = firstPages[0];
	const visited = new Set<string>();
	while (current) {
		if (visited.has(current.key)) return false;
		visited.add(current.key);
		const info = current.value.pageInfo;
		if (info.hasNextPage === false) return visited.size === pages.length;
		if (typeof info.endCursor !== "string" || info.endCursor.length === 0) return false;
		const next = pages.filter((page) => page.args?.after === info.endCursor);
		if (next.length !== 1) return false;
		current = next[0];
	}
	return false;
}

function asReadableConnection(value: unknown): (Record<string, unknown> & {
	nodes: unknown[];
	pageInfo: Record<string, unknown> & { hasNextPage: boolean };
}) | null {
	return isReadableConnection(value) ? value : null;
}

/** Positive end proof requires readable, unfiltered history from its first page. */
export function hasVerifiedOrdersEnd(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) return false;
	const connections = Object.entries(root).filter(([key]) =>
		PAGINATED_LIST_KEY_RE.test(key) || CURSOR_LIST_KEY_RE.test(key),
	);
	if (connections.length === 0 || connections.some(([key, value]) => !isFullHistoryRequestKey(key) || !isReadableConnection(value))) return false;
	const accumulated = connections.filter(([key]) => PAGINATED_LIST_KEY_RE.test(key));
	const cursor = connections.filter(([key]) => CURSOR_LIST_KEY_RE.test(key));
	if (accumulated.length > 0) {
		return cursor.length === 0 && accumulated.every(([key, value]) =>
			isAccumulatingFullHistoryRequestKey(key) && isTerminalConnection(value),
		);
	}
	return hasConnectedCursorChain(cursor);
}

function isTerminalConnection(value: unknown): boolean {
	return isReadableConnection(value) && value.pageInfo.hasNextPage === false;
}

/** Known source totals must reconcile with the deduplicated observed order refs. */
export function hasDeclaredOrderTotal(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) return false;
	return Object.entries(root).some(([key, value]) => {
		if (!PAGINATED_LIST_KEY_RE.test(key) && !CURSOR_LIST_KEY_RE.test(key)) return false;
		if (!isRecord(value)) return false;
		return Object.hasOwn(value, "totalCount") ||
			(isRecord(value.pageInfo) && Object.hasOwn(value.pageInfo, "totalCount"));
	});
}

export function hasOrderCountMismatch(cache: ApolloCache): boolean {
	const root = cache.ROOT_QUERY;
	if (!isRecord(root)) return false;
	const refs = collectAllOrderRefs(cache);
	return Object.entries(root).some(([key, value]) => {
		if (!PAGINATED_LIST_KEY_RE.test(key) && !CURSOR_LIST_KEY_RE.test(key)) return false;
		if (!isReadableConnection(value) || !isFullHistoryRequestKey(key)) return true;
		const totals: unknown[] = [];
		if (Object.hasOwn(value, "totalCount")) totals.push(value.totalCount);
		if (Object.hasOwn(value.pageInfo, "totalCount")) totals.push(value.pageInfo.totalCount);
		return totals.some((raw) => {
			if (raw === undefined || raw === null) return true;
			if (typeof raw !== "number" && typeof raw !== "string") return true;
			if (typeof raw === "string" && raw.trim().length === 0) return true;
			const expected = Number(raw);
			return !Number.isFinite(expected) || !Number.isInteger(expected) || expected < 0 || expected !== refs.length;
		});
	});
}

/** The one source ID normalization path used by parsing and coverage checks. */
export function resolveOrderId(value: unknown): string | null {
	if (typeof value === "string") return value.length > 0 ? value : null;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

export type FieldReadState = "READ" | "EXPLICIT_EMPTY" | "UNAVAILABLE";
export interface FieldCoverage {
	field: string;
	state: FieldReadState;
	reason?: string;
}
interface ParsedOrderCoverage {
	order: ParsedOrder | null;
	fields: FieldCoverage[];
}

function field(field: string, state: FieldReadState, reason?: string): FieldCoverage {
	return reason === undefined ? { field, state } : { field, state, reason };
}

function parseOrderWithCoverage(cache: ApolloCache, ref: string): ParsedOrderCoverage {
	const order = readEntry(cache, ref);
	const id = resolveOrderId(order?.id);
	const fields: FieldCoverage[] = [field("id", id === null ? "UNAVAILABLE" : "READ", id === null ? "invalid_identity" : undefined)];
	if (!order || id === null) return { order: null, fields };
	fields.push(field("order_number", "READ"), field("detail_url", "READ"));

	const placedAt = order.createdAt;
	const status = order.displayStatus;
	const placedAtValue = typeof placedAt === "string" ? placedAt : null;
	const statusValue = typeof status === "string" ? status : null;
	const validPlacedAt = typeof placedAt === "string" && placedAt.length > 0 &&
		SHOP_ISO_DATETIME_RE.test(placedAt) && Number.isFinite(Date.parse(placedAt));
	fields.push(field("placed_at", placedAt === undefined || placedAt === null || placedAt === ""
		? "EXPLICIT_EMPTY" : validPlacedAt ? "READ" : "UNAVAILABLE",
		typeof placedAt === "string" && (placedAt.length === 0 || validPlacedAt) || placedAt === undefined || placedAt === null
			? undefined : "malformed_value"));
	fields.push(field("status", status === undefined || status === null || status === ""
		? "EXPLICIT_EMPTY" : typeof status === "string" ? "READ" : "UNAVAILABLE",
		typeof status === "string" || status === undefined || status === null ? undefined : "malformed_value"));

	const price = order.effectiveTotalPrice === undefined || order.effectiveTotalPrice === null
		? order.totalPriceAfterOfferApplied
		: order.effectiveTotalPrice;
	let totalCents: number | null = null;
	let currency: string | null = null;
	if (price === undefined || price === null) {
		fields.push(field("total", "EXPLICIT_EMPTY"), field("currency", "EXPLICIT_EMPTY"));
	} else if (!isRecord(price)) {
		fields.push(field("total", "UNAVAILABLE", "malformed_value"), field("currency", "UNAVAILABLE", "malformed_value"));
	} else {
		const amount = price.amount;
		const parsed = typeof amount === "string" || typeof amount === "number" ? Number(amount) : Number.NaN;
		if (amount === null) fields.push(field("total", "EXPLICIT_EMPTY"));
		else if (Number.isFinite(parsed) && (typeof amount !== "string" || amount.trim().length > 0)) {
			totalCents = Math.round(parsed * CENTS_PER_UNIT);
			fields.push(field("total", "READ"));
		} else {
			fields.push(field("total", "UNAVAILABLE", "malformed_value"));
		}
		const sourceCurrency = price.currencyCode;
		if (sourceCurrency === null) fields.push(field("currency", "EXPLICIT_EMPTY"));
		else if (typeof sourceCurrency === "string") {
			currency = sourceCurrency;
			fields.push(field("currency", sourceCurrency.length === 0 ? "EXPLICIT_EMPTY" : "READ"));
		} else {
			fields.push(field("currency", "UNAVAILABLE", "malformed_value"));
		}
	}

	let merchantName: string | null = null;
	if (order.shop === null) fields.push(field("merchant_name", "EXPLICIT_EMPTY"));
	else if (!isApolloRef(order.shop)) fields.push(field("merchant_name", "UNAVAILABLE", order.shop === undefined ? "missing_field" : "malformed_value"));
	else {
		const shop = readEntry(cache, order.shop.__ref);
		if (!shop) fields.push(field("merchant_name", "UNAVAILABLE", "missing_reference"));
		else if (shop.name === null) fields.push(field("merchant_name", "EXPLICIT_EMPTY"));
		else if (typeof shop.name === "string") {
			merchantName = shop.name;
			fields.push(field("merchant_name", shop.name.length === 0 ? "EXPLICIT_EMPTY" : "READ"));
		} else fields.push(field("merchant_name", "UNAVAILABLE", shop.name === undefined ? "missing_field" : "malformed_value"));
	}

	const lineItems = order.lineItems;
	const nodes = isRecord(lineItems) ? lineItems.nodes : undefined;
	const lineItemTitles: string[] = [];
	if (lineItems === null) fields.push(field("line_item_titles", "EXPLICIT_EMPTY"));
	else if (!isRecord(lineItems) || !Array.isArray(nodes)) fields.push(field("line_item_titles", "UNAVAILABLE", lineItems === undefined ? "missing_field" : "malformed_connection"));
	else {
		let unresolved = false;
		for (const node of nodes) {
			if (!isApolloRef(node)) {
				unresolved = true;
				continue;
			}
			const item = readEntry(cache, node.__ref);
			if (!item) { unresolved = true; continue; }
			if (item.productTitle === null) continue;
			if (typeof item.productTitle !== "string") { unresolved = true; continue; }
			lineItemTitles.push(item.productTitle);
		}
		fields.push(unresolved
			? field("line_item_titles", "UNAVAILABLE", "missing_or_malformed_reference")
			: field("line_item_titles", lineItemTitles.length === 0 ? "EXPLICIT_EMPTY" : "READ"));
	}

	const sourceItemCount = order.totalItemCount;
	let itemCount: number | null = null;
	if (sourceItemCount === undefined || sourceItemCount === null) {
		itemCount = lineItemTitles.length > 0 ? lineItemTitles.length : null;
		fields.push(field("item_count", itemCount === null ? "EXPLICIT_EMPTY" : "READ"));
	} else {
		const parsedCount = typeof sourceItemCount === "number" || typeof sourceItemCount === "string"
			? Number(sourceItemCount) : Number.NaN;
		if (Number.isFinite(parsedCount) && Number.isInteger(parsedCount) && parsedCount >= 0 &&
			(typeof sourceItemCount !== "string" || sourceItemCount.trim().length > 0)) {
			itemCount = parsedCount;
			fields.push(field("item_count", "READ"));
		} else fields.push(field("item_count", "UNAVAILABLE", "malformed_value"));
	}
	const unavailable = fields.some((entry) => entry.state === "UNAVAILABLE");
	return {
		order: unavailable ? null : {
			currency, detailUrl: SHOP_ORDER_HISTORY_URL, id,
			itemCount, lineItemTitles, merchantName,
			orderNumber: id, placedAt: placedAtValue, status: statusValue, totalCents,
		},
		fields,
	};
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
	return parseOrderWithCoverage(cache, ref).order;
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
	fieldCoverage: FieldCoverage[][];
	withheldRows: Array<{ fields: Array<{ field: string; reason: string }> }>;
	unavailableByRef: Array<{ ref: string; fields: Array<{ field: string; reason: string }> }>;
	unidentifiedRows: Array<{ key: string; fields: Array<{ field: string; reason: string }> }>;
	availableRefs: string[];
	resolvedUnidentifiedKeys: string[];
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
	const withheldRows: ExtractedOrders["withheldRows"] = [];
	const unavailableByRef: ExtractedOrders["unavailableByRef"] = [];
	const unidentifiedRows: ExtractedOrders["unidentifiedRows"] = [];
	const resolvedUnidentifiedKeys: string[] = [];
	let malformedRowCount = 0;
	for (const [key, value] of connectionEntries) {
		if (!isReadableConnection(value)) {
			malformedRowCount += 1;
			const issue = { fields: [{ field: "orders_connection", reason: "unreadable_nodes_or_page_info" }] };
			withheldRows.push(issue);
			unidentifiedRows.push({ key: `${key}#connection`, ...issue });
			continue;
		}
		resolvedUnidentifiedKeys.push(`${key}#connection`);
		for (const [index, node] of value.nodes.entries()) {
			if (!isApolloRef(node) || !node.__ref.startsWith("Order:")) {
				malformedRowCount += 1;
				const issue = { fields: [{ field: "order", reason: "malformed_reference" }] };
				withheldRows.push(issue);
				unidentifiedRows.push({ key: `${key}#node:${index}`, ...issue });
			} else resolvedUnidentifiedKeys.push(`${key}#node:${index}`);
		}
	}
	const orders: ParsedOrder[] = [];
	const availableRefs: string[] = [];
	const fieldCoverage: FieldCoverage[][] = [];
	for (const ref of refs) {
		const parsed = parseOrderWithCoverage(cache, ref);
		fieldCoverage.push(parsed.fields);
		if (parsed.order) {
			orders.push(parsed.order);
			availableRefs.push(ref);
			continue;
		}
		const unavailableFields = parsed.fields.filter((entry) => entry.state === "UNAVAILABLE")
			.map((entry) => ({ field: entry.field, reason: entry.reason ?? "unavailable" }));
		withheldRows.push({ fields: unavailableFields });
		unavailableByRef.push({ ref, fields: unavailableFields });
	}
	return {
		orders,
		discoveredRows: refs.length + malformedRowCount,
		discardedRows: withheldRows.length,
		fieldCoverage,
		withheldRows,
		unavailableByRef,
		unidentifiedRows,
		availableRefs,
		resolvedUnidentifiedKeys,
	};
}

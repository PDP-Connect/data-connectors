// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shop's own order-history JSON, as served on shop.com.
//
// shop.com has no Apollo cache a page reader can reach and renders each order
// as a button with no key, so the page itself is not a source of order
// identities. The page's own list loader is a JSON endpoint: its order-history
// screen pages with `POST /web/api/order-history`, sending the query
// parameters (`pageSize`, `archived`, `locale`, `after`) as a JSON object, and
// reads `deliveriesOrdersList.{nodes, pageInfo}` from the reply. This module
// issues those same requests from the signed-in page and reshapes the replies
// into the Apollo-cache form `parsers.ts` already reads, so field parsing,
// canonical identities and end-of-list proof stay in one place.
//
// Completeness comes only from Shop's reply: the cursor chain from the first
// page must end at a page whose `pageInfo.hasNextPage` is `false`. Page height,
// scroll position and card counts never decide it.

import type { ApolloCache } from "./types.ts";

export const ORDER_HISTORY_API_PAGE_SIZE = 10;
const MAX_ORDER_HISTORY_API_PAGES = 100;
const MAX_CONSECUTIVE_PAGE_FAILURES = 3;
const DEFAULT_READ_BUDGET_MS = 1_500;

export interface OrderHistoryPageIdentity {
	url: string;
	navigation: string;
}

// Provenance is kept outside Apollo's entity namespace and survives cached reads.
const cacheIdentities = new WeakMap<ApolloCache, Readonly<OrderHistoryPageIdentity>>();

export function orderHistoryCacheIdentity(cache: ApolloCache | null): Readonly<OrderHistoryPageIdentity> | null {
	return cache === null ? null : cacheIdentities.get(cache) ?? null;
}

export function sameOrderHistoryPage(
	left: Readonly<OrderHistoryPageIdentity>, right: Readonly<OrderHistoryPageIdentity>,
): boolean {
	return left.url === right.url && left.navigation === right.navigation;
}

export interface OrderHistoryApiRequest {
	after: string | null;
	pageSize: number;
	identity?: Readonly<OrderHistoryPageIdentity>;
}

export interface OrderHistoryApiReply {
	status: number;
	body: unknown;
}

export type FetchOrderHistoryPage = (request: OrderHistoryApiRequest) => Promise<OrderHistoryApiReply>;

/**
 * Evaluated in the signed-in Shop page. Sends the request the order-history
 * screen itself sends, with the page's own session: a JSON `POST` of the query
 * parameters, as its pager does, and, when that gives no usable reply, a `GET`
 * of the same parameters, as its first-page loader does. Returns the status
 * and parsed JSON only; it never throws, so a network failure is a
 * `status: 0` reply the caller treats as an unusable page.
 */
export async function fetchOrderHistoryPageInPage(
	request: OrderHistoryApiRequest,
): Promise<{ status: number; body: unknown }> {
	const sourceUrl = new URL(location.href);
	const identity = request.identity ?? {
		url: `${sourceUrl.origin}${sourceUrl.pathname}`, navigation: String(performance.timeOrigin),
	};
	const params: Record<string, string> = {
		pageSize: String(request.pageSize),
		archived: "false",
		locale: (document.documentElement.lang || "en").split("-")[0] ?? "en",
	};
	if (request.after !== null) params.after = request.after;
	// No nested named functions: this is serialized into the page, where the
	// transpiler's name helper does not exist.
	const attempts = [
		{ method: "POST", url: "/web/api/order-history", body: JSON.stringify(params) },
		{ method: "GET", url: `/web/api/order-history?${new URLSearchParams(params).toString()}`, body: undefined },
	];
	let reply: { status: number; body: unknown } = { status: 0, body: null };
	for (const attempt of attempts) {
		const beforeUrl = new URL(location.href);
		if (`${beforeUrl.origin}${beforeUrl.pathname}` !== identity.url || String(performance.timeOrigin) !== identity.navigation) {
			return { status: 0, body: null };
		}
		try {
			const response = await fetch(attempt.url, {
				method: attempt.method,
				credentials: "same-origin",
				headers: attempt.body === undefined
					? { Accept: "application/json" }
					: { Accept: "application/json", "Content-Type": "application/json" },
				...(attempt.body === undefined ? {} : { body: attempt.body }),
			});
			let body: unknown = null;
			try {
				body = await response.json();
			} catch {
				// A non-JSON reply is an unusable page, reported as `body: null`.
			}
			const afterUrl = new URL(location.href);
			if (`${afterUrl.origin}${afterUrl.pathname}` !== identity.url || String(performance.timeOrigin) !== identity.navigation) {
				return { status: 0, body: null };
			}
			// Mirror readOrderHistoryConnection without outer helpers: this function
			// is serialized into the page. Error-bearing partial data is not usable.
			if (response.status === 200 && typeof body === "object" && body !== null && !Array.isArray(body)) {
				const envelope = body as Record<string, unknown>;
				const connection = envelope.deliveriesOrdersList;
				if (typeof connection === "object" && connection !== null && !Array.isArray(connection)) {
					const list = connection as Record<string, unknown>;
					const pageInfo = list.pageInfo;
					if ([envelope, list].every((value) =>
						(value.error === undefined || value.error === null) &&
						(value.errors === undefined || value.errors === null || (Array.isArray(value.errors) && value.errors.length === 0)) &&
						(value.partial === undefined || value.partial === false)) &&
						Array.isArray(list.nodes) && typeof pageInfo === "object" && pageInfo !== null && !Array.isArray(pageInfo) &&
						typeof (pageInfo as Record<string, unknown>).hasNextPage === "boolean") {
						return { status: response.status, body };
					}
				}
			}
			if (reply.status === 0) reply = { status: response.status, body };
		} catch {
			// A network failure is an unusable page; the next form may still work.
		}
	}
	return reply;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface OrderHistoryConnection {
	nodes: unknown[];
	pageInfo: Record<string, unknown> & { hasNextPage: boolean };
	totalCount?: unknown;
}

/** The connection of one reply, or `null` when the reply is not a usable authenticated page. */
export function readOrderHistoryConnection(reply: OrderHistoryApiReply): OrderHistoryConnection | null {
	if (reply.status !== 200 || !isRecord(reply.body)) return null;
	const connection = reply.body.deliveriesOrdersList;
	if (!isRecord(connection) || !Array.isArray(connection.nodes) || !isRecord(connection.pageInfo)) return null;
	for (const envelope of [reply.body, connection]) {
		if (envelope.error !== undefined && envelope.error !== null) return null;
		if (envelope.errors !== undefined && envelope.errors !== null &&
			(!Array.isArray(envelope.errors) || envelope.errors.length > 0)) return null;
		if (envelope.partial !== undefined && envelope.partial !== false) return null;
	}
	if (typeof connection.pageInfo.hasNextPage !== "boolean") return null;
	return {
		...connection,
		nodes: connection.nodes,
		pageInfo: { ...connection.pageInfo, hasNextPage: connection.pageInfo.hasNextPage },
	};
}

function orderId(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

/** An order node, or the order a delivery node belongs to, when it carries an identity. */
function orderOf(node: unknown): Record<string, unknown> | null {
	if (!isRecord(node)) return null;
	if (node.__typename === "Order") return orderId(node.id) === null ? null : node;
	if (node.__typename === "Delivery" && isRecord(node.order)) {
		return orderId(node.order.id) === null ? null : { __typename: "Order", ...node.order };
	}
	return null;
}

/** Writes one order and the entities it nests into `cache`, returning its Order ref. */
function writeOrder(cache: ApolloCache, order: Record<string, unknown>): string {
	const ref = `Order:${orderId(order.id)}`;
	const { shop, lineItems, ...rest } = order;
	const entry: Record<string, unknown> = { ...rest };
	if (Object.hasOwn(order, "shop")) {
		if (isRecord(shop)) {
			cache[`Shop:${ref}`] = shop;
			entry.shop = { __ref: `Shop:${ref}` };
		} else {
			entry.shop = shop;
		}
	}
	if (Object.hasOwn(order, "lineItems")) {
		if (isRecord(lineItems) && Array.isArray(lineItems.nodes)) {
			entry.lineItems = {
				...lineItems,
				nodes: lineItems.nodes.map((item, index) => {
					if (!isRecord(item)) return item;
					cache[`LineItem:${ref}:${String(index)}`] = item;
					return { __ref: `LineItem:${ref}:${String(index)}` };
				}),
			};
		} else {
			entry.lineItems = lineItems;
		}
	}
	// A delivery repeats its order; fields an earlier node already gave stay.
	const prior = cache[ref];
	cache[ref] = isRecord(prior) ? { ...prior, ...entry } : entry;
	return ref;
}

export interface OrderHistoryApiPage {
	after: string | null;
	identity?: Readonly<OrderHistoryPageIdentity>;
	connection: OrderHistoryConnection;
}

/**
 * Reshapes the pages read so far into the Apollo-cache form: one cursor-keyed
 * `deliveriesOrdersList` connection per request, each node an `Order:<id>` ref.
 * A node that is neither an order nor a delivery with an order identity stays a
 * non-order node, which `extractOrdersWithCoverage` reports as an unreadable
 * row rather than dropping it.
 */
export function orderHistoryPagesToCache(pages: readonly OrderHistoryApiPage[]): ApolloCache {
	const cache: ApolloCache = {};
	const root: Record<string, unknown> = {};
	for (const page of pages) {
		const args: Record<string, unknown> = { first: ORDER_HISTORY_API_PAGE_SIZE };
		if (page.after !== null) args.after = page.after;
		const nodes = page.connection.nodes.map((node) => {
			const order = orderOf(node);
			if (order) return { __ref: writeOrder(cache, order) };
			const typename = isRecord(node) && typeof node.__typename === "string" ? node.__typename : "Unknown";
			return { __ref: `Unresolved:${typename}` };
		});
		root[`deliveriesOrdersList(${JSON.stringify(args)})`] = { ...page.connection, nodes };
	}
	cache.ROOT_QUERY = root;
	return cache;
}

export interface OrderHistoryApiReader {
	/** Fetches further pages within a small time box and returns the cache read so far. */
	read(): Promise<ApolloCache | null>;
	/** True only when Shop's first page is an empty, terminal list that states no other total. */
	provesEmptyHistory(): Promise<boolean>;
}

/**
 * Pages through Shop's order-history endpoint in cursor order. Each `read()`
 * fetches pages until the chain ends, the time box is spent or the page
 * ceiling is reached, and returns every page read so far, so a caller that
 * re-reads after each step sees the history grow and then stop growing.
 * Returns `null` until a first usable page exists.
 */
export function createOrderHistoryApiReader({
	fetchPage,
	readPageIdentity,
	maxPages = MAX_ORDER_HISTORY_API_PAGES,
	readBudgetMs = DEFAULT_READ_BUDGET_MS,
	now = Date.now,
}: {
	fetchPage: FetchOrderHistoryPage;
	/** Required for browser-backed readers; omitted only by synthetic fetchers. */
	readPageIdentity?: () => Promise<OrderHistoryPageIdentity | null>;
	maxPages?: number;
	readBudgetMs?: number;
	now?: () => number;
}): OrderHistoryApiReader {
	const pages: OrderHistoryApiPage[] = [];
	const cursors = new Set<string>();
	let nextAfter: string | null = null;
	let ended = false;
	let consecutiveFailures = 0;
	let identity: Readonly<OrderHistoryPageIdentity> | null = null;
	let invalidated = false;
	const ownsPage = async (): Promise<boolean> => {
		if (invalidated) return false;
		if (!readPageIdentity) return true;
		const current = await readPageIdentity().catch(() => null);
		if (current === null || current.navigation.length === 0 ||
			(identity !== null && !sameOrderHistoryPage(identity, current))) {
			invalidated = true;
			return false;
		}
		identity ??= Object.freeze({ url: current.url, navigation: current.navigation });
		return true;
	};
	return {
		async read() {
			if (!(await ownsPage())) return null;
			const deadline = now() + readBudgetMs;
			while (!ended && pages.length < maxPages && consecutiveFailures < MAX_CONSECUTIVE_PAGE_FAILURES) {
				if (!(await ownsPage())) return null;
				const reply = await fetchPage({ after: nextAfter, pageSize: ORDER_HISTORY_API_PAGE_SIZE,
					...(identity === null ? {} : { identity }) });
				if (!(await ownsPage())) return null;
				const connection = readOrderHistoryConnection(reply);
				if (!connection) {
					consecutiveFailures += 1;
					break;
				}
				consecutiveFailures = 0;
				pages.push({ after: nextAfter, connection, ...(identity === null ? {} : { identity }) });
				const cursor = connection.pageInfo.endCursor;
				if (!connection.pageInfo.hasNextPage || typeof cursor !== "string" || cursor.length === 0 || cursors.has(cursor)) {
					// A page that says more exist but gives no new cursor ends the walk
					// unproven: the chain check in the parser will not connect it.
					ended = true;
				} else {
					cursors.add(cursor);
					nextAfter = cursor;
				}
				if (now() >= deadline) break;
			}
			if (!(await ownsPage()) || pages.length === 0) return null;
			const cache = orderHistoryPagesToCache(pages);
			if (identity !== null) cacheIdentities.set(cache, identity);
			return cache;
		},
		async provesEmptyHistory() {
			if (!(await ownsPage())) return false;
			const [first] = pages;
			return pages.length === 1 && first !== undefined && first.connection.nodes.length === 0 &&
				!first.connection.pageInfo.hasNextPage &&
				(first.connection.totalCount === undefined || Number(first.connection.totalCount) === 0);
		},
	};
}

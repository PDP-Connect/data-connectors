#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Shopify (Shop app) Connector (v0.2.11)
 *
 * Collects order history from https://shop.app/account/order-history via a
 * logged-in browser session. Shop app is a React/Apollo Client SPA; this
 * connector reads the live Apollo Client cache (reached by walking the React
 * fiber tree from the DOM root), falls back to `window.__APOLLO_STATE__`, and
 * parses visible order cards if Apollo does not expose the order connection.
 *
 * Ported from the legacy Playwright connector under
 * docs/migration/connector-cutover/CONTRACTS.md D10. The legacy source
 * (apps/desktop/connectors/shopify/shop-playwright.js in unity-surfaces)
 * supplied the Apollo and DOM extraction strategy. A signed-in empty
 * account was checked on five reloads on 2026-09-26; each emitted a
 * zero-record STATE. No live nonempty cache was captured, so parsing
 * current order fields remains fixture-proven rather than live-proven.
 * Manifest `public_listing.tier` remains `development` pending that
 * nonempty-order check (CONTRACTS.md D11).
 *
 * Streams:
 *   orders   Order history, one RECORD per Shop-app order, extracted from
 *            the Apollo cache's `Order:<id>` entries. See
 *            docs/migration/connector-cutover/capability-map.json's
 *            `shopify` entry for the legacy-scope -> stream field mapping.
 *
 * Session: open order history and inspect the rendered account page, as the
 * legacy connector did. No credentialed auto-login — Shop authenticates by
 * email and verification code. A dead session hands that page to the owner,
 * then verifies order-history access after manual sign-in.
 *
 * Pagination: Shop app's orders list is infinite-scroll, cursor-paginated
 * through Apollo. This connector scrolls the page and re-reads the cache
 * after each scroll, using `hasNextPage` from the cache's `pageInfo` to
 * restore the legacy 25-scroll bootstrap, then read up to 20 continuations.
 *
 * Cursor: Shop app's order-history query has no documented server-side
 * incremental filter this connector can request, and it fully re-derives
 * the order list each run. This connector uses the shared
 * `openFingerprintCursor` per-record fingerprint gate (see
 * docs/reference/connector-authoring-guide.md §6) so a re-run that observes
 * unchanged orders emits no duplicate RECORDs. It prunes unseen fingerprints
 * only after the current page proves exhaustion and every observed row passes
 * normalization and schema validation.
 *
 * CHANGES
 *   v0.2.27 (2026-10-15) — restore bootstrap and continuation loading, bind
 *     end evidence to the current navigation, disclose omitted rows, and
 *     retain fingerprints when a scan is partial.
 *   v0.2.11 (2026-09-28) — read Apollo state and empty-page evidence in the
 *     page's main JavaScript world under Patchright.
 *   v0.2.10 (2026-09-26) — recheck fiber, SSR, and DOM order evidence until
 *     loaded orders or stable verified empty; report evidence deadline expiry.
 *   v0.2.9 (2026-09-26) — bounded cache readiness, legacy DOM-card fallback,
 *     and sanitized skip diagnostics; retain verified-empty semantics.
 *   v0.2.5 (2026-09-25) — require a live, visible empty-state marker before
 *     confirming an account when Apollo has no orders connection.
 *   v0.2.1 (2026-09-24) — open Shop before manual sign-in handoff and verify
 *     the session afterward.
 *   v0.2.0 (2026-09-22) — real Apollo-cache extraction wired (parsers.ts);
 *     fingerprint-cursor incremental gate; added order_number,
 *     detail_url, line_item_titles per capability-map field contract.
 *   v0.1.0 — scaffold: reachability probe + unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import { manualBrowserLogin } from "../../packages/polyfill-connectors/src/browser-handoff.ts";
import {
	type BrowserCollectContext,
	type EnsureSessionArgs,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	collectAllOrderRefs,
	extractOrdersWithCoverage,
	hasNextOrdersPage,
	hasOrderCountMismatch,
	hasOrdersConnection,
	hasVerifiedOrdersEnd,
	parseDomOrderCards,
	resolveOrderId,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache, ParsedOrder } from "./types.ts";

const ORDER_HISTORY_URL = "https://shop.app/account/order-history";
const BOOTSTRAP_SCROLL_DELAY_MS = 800;
const CONTINUATION_SCROLL_DELAY_MS = 1_500;
const MAX_BOOTSTRAP_SCROLLS = 25;
const MAX_CONTINUATION_SCROLLS = 20;
const MAX_UNCHANGED_BOOTSTRAP_ROUNDS = 3;
const APOLLO_READINESS_TIMEOUT_MS = 8_000;
const APOLLO_POLL_INTERVAL_MS = 200;
const ORDER_HISTORY_READY_TIMEOUT_MS = 10_000;
export const ORDERS_STREAM = "orders";

export interface ShopSkipDiagnostics {
	final_url_path: string;
	sign_in_page_detected: boolean;
	order_context_present: boolean;
	fiber_cache_present: boolean;
	ssr_cache_present: boolean;
	navigation_to_first_cache_attempt_ms: number | null;
	navigation_to_cache_success_ms: number | null;
	dom_card_count: number;
}

const EMPTY_SHOP_DIAGNOSTICS: ShopSkipDiagnostics = {
	final_url_path: "",
	sign_in_page_detected: false,
	order_context_present: false,
	fiber_cache_present: false,
	ssr_cache_present: false,
	navigation_to_first_cache_attempt_ms: null,
	navigation_to_cache_success_ms: null,
	dom_card_count: 0,
};

/** Page-local diagnostics. This function is serialized by Playwright, so it
 *  must not depend on module-level helpers or return page text/record fields. */
export function shopSkipDiagnosticsInPage(): ShopSkipDiagnostics {
	const signInPage = Boolean(document.querySelector(
		'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
	)) || /\/(?:login|sign-in|signin)(?:\/|$)/i.test(location.pathname);
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
	const orderContext = !signInPage && (
		headings.some((heading) => /orders?|order history/i.test(heading.textContent ?? "")) ||
		Boolean(document.querySelector(
			'[data-test*="order"], [data-testid*="order"], .order-card, a[href*="/orders/"], a[href*="/order/"]',
		))
	);
	const root: unknown = document.querySelector("#root") ?? document.body;
	let fiberCachePresent = false;
	if (typeof root === "object" && root !== null) {
		const rootObject = root as Record<string, FiberNode>;
		const fiberKey = Object.keys(rootObject).find((key) =>
			key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance"),
		);
		let fiber: FiberNode | null | undefined = fiberKey ? rootObject[fiberKey] : null;
		let steps = 0;
		while (fiber && steps < 300) {
			steps += 1;
			const props = fiber.memoizedProps ?? fiber.pendingProps;
			try {
				const state = props?.client?.cache?.extract?.();
				if (state && typeof state === "object") {
					fiberCachePresent = true;
					break;
				}
			} catch {
				break;
			}
			fiber = fiber.return;
		}
	}
	interface WindowWithApolloState { __APOLLO_STATE__?: Record<string, unknown> }
	const ssrState = (window as Window & WindowWithApolloState).__APOLLO_STATE__;
	const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="shop.app"]'));
	const cardKeys = new Set(
		links.flatMap((link) => {
			const card = link.closest(
				'.order-card, [data-testid*="order"], [data-test*="order"], div[class]',
			) ?? link;
			const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
			return /(?:\$\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|CAD)\b)/i.test(text) ||
				/\b\d+\s*items?\b/i.test(text)
				? [card]
				: [];
		}),
	);
	return {
		final_url_path: location.pathname,
		sign_in_page_detected: signInPage,
		order_context_present: orderContext,
		fiber_cache_present: fiberCachePresent,
		ssr_cache_present: Boolean(ssrState && typeof ssrState === "object"),
		navigation_to_first_cache_attempt_ms: null,
		navigation_to_cache_success_ms: null,
		dom_card_count: cardKeys.size,
	};
}

/** Order-history or sign-in UI has replaced the document-loading shell. */
export function isShopOrderHistoryReadyInPage(): boolean {
	const signIn = document.querySelector(
		'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
	);
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
	const orderContext = headings.some((heading) =>
		/orders?|order history/i.test(heading.textContent ?? ""),
	) || Boolean(document.querySelector(
		'[data-test*="order"], [data-testid*="order"], .order-card, a[href*="/orders/"], a[href*="/order/"]',
	));
	return Boolean(signIn) || orderContext;
}

/** Page ownership/readability evidence used to bind cache proof to this navigation. */
export function readShopOrderPageEvidenceInPage(): ShopOrderPageEvidence {
	const url = new URL(location.href);
	const login = Boolean(document.querySelector(
		'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
	));
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
	const orderContext = !login && (
		headings.some((heading) => /orders?|order history/i.test(heading.textContent ?? "")) ||
		Boolean(document.querySelector(
			'[data-test*="order"], [data-testid*="order"], .order-card, a[href*="/orders/"], a[href*="/order/"]',
		))
	);
	const blockedText = Array.from(document.querySelectorAll("body *")).some((element) => {
		if (element.children.length > 0) return false;
		const text = (element.textContent ?? "").trim().toLowerCase();
		return /access denied|verify you are human|something went wrong|try again later/.test(text);
	});
	const controls = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]"));
	const nextControls = controls.filter((control) =>
		/^(?:next|load more|show more orders)$/i.test((control.textContent ?? "").trim()) ||
		/^(?:next|load-more)$/i.test(control.getAttribute("data-testid") ?? ""),
	);
	const domHasContinuation = nextControls.some((control) =>
		!control.hasAttribute("disabled") && control.getAttribute("aria-disabled") !== "true",
	);
	const domHasEndMarker = Array.from(document.querySelectorAll("body *")).some((element) => {
		if (element.children.length > 0) return false;
		return /^(?:you have reached the end|no more orders|end of order history)$/i.test(
			(element.textContent ?? "").trim().replace(/\s+/g, " "),
		);
	}) || (nextControls.length > 0 && nextControls.every((control) =>
		control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true",
	));
	const domCardCount = new Set(
		Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="shop.app"]')).flatMap((link) => {
			const card = link.closest('.order-card, [data-testid*="order"], [data-test*="order"], div[class]') ?? link;
			const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
			return /(?:\$\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|CAD)\b)/i.test(text) ||
				/\b\d+\s*items?\b/i.test(text) ? [card] : [];
		}),
	).size;
	return {
		url: `${url.origin}${url.pathname}${url.search}`,
		navigation: String(performance.timeOrigin),
		orderContext,
		blocked: login || blockedText || url.origin !== "https://shop.app" || url.pathname !== "/account/order-history",
		pageHeight: Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0),
		domHasContinuation,
		domHasEndMarker,
		domCardCount,
	};
}

export interface WaitForApolloCacheArgs {
	readCache: () => Promise<ApolloCache | null>;
	timeoutMs: number;
	pollIntervalMs: number;
	now?: () => number;
	wait?: (ms: number) => Promise<void>;
}

export async function waitForApolloCache({
	readCache,
	timeoutMs,
	pollIntervalMs,
	now = Date.now,
	wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}: WaitForApolloCacheArgs): Promise<{ cache: ApolloCache | null; timedOut: boolean }> {
	const deadline = now() + timeoutMs;
	while (true) {
		const remainingBeforeRead = deadline - now();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cache = await Promise.race([
			readCache().catch(() => null),
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), Math.max(0, remainingBeforeRead));
			}),
		]).finally(() => {
			if (timer) clearTimeout(timer);
		});
		if (cache) return { cache, timedOut: false };
		const remaining = deadline - now();
		if (remaining <= 0) return { cache: null, timedOut: true };
		await wait(Math.min(pollIntervalMs, remaining));
	}
}

/**
 * Evaluated in the page. Traverses the React fiber tree from the DOM root to
 * find Apollo Client's live `cache`, falling back to the static SSR snapshot
 * (`window.__APOLLO_STATE__`) when no live client is mounted yet. Returns
 * `null` when neither is reachable — the caller treats that as "cache not
 * ready", not "zero orders".
 *
 * Kept minimal on purpose: everything that can be pure lives in parsers.ts
 * and runs in Node against the returned JSON, not here.
 */
/** A React fiber node, typed only as far as this walk needs. React's
 *  internal fiber shape has no shipped public type. */
interface FiberNode {
	memoizedProps?: FiberProps;
	pendingProps?: FiberProps;
	return?: FiberNode | null;
}

interface FiberProps {
	client?: { cache?: { extract?: () => Record<string, unknown> } };
}

export function readApolloCacheInPage(): ApolloCache | null {
	let liveState: Record<string, unknown> | null = null;
	try {
		const root: unknown = document.querySelector("#root") ?? document.body;
		if (typeof root === "object" && root !== null) {
			const rootObject = root as Record<string, FiberNode>;
			const fiberKey = Object.keys(rootObject).find(
				(key) =>
					key.startsWith("__reactFiber") ||
					key.startsWith("__reactInternalInstance"),
			);
			let fiber: FiberNode | null | undefined = fiberKey
				? rootObject[fiberKey]
				: null;
			let steps = 0;
			while (fiber && steps < 300) {
				steps += 1;
				const props = fiber.memoizedProps ?? fiber.pendingProps;
				const extracted = props?.client?.cache?.extract?.();
				if (extracted) {
					liveState = extracted;
					break;
				}
				fiber = fiber.return;
			}
		}
	} catch {
		// Fall through to the SSR snapshot below.
	}

	interface WindowWithApolloState {
		__APOLLO_STATE__?: Record<string, unknown>;
	}
	const globalState = (window as Window & WindowWithApolloState)
		.__APOLLO_STATE__;
	const ssrState = globalState && typeof globalState === "object" ? globalState : null;
	const ssrQuery = ssrState?.ROOT_QUERY;
	const liveQuery = liveState?.ROOT_QUERY;
	const liveHasOrderConnection = typeof liveQuery === "object" && liveQuery !== null &&
		!Array.isArray(liveQuery) && Object.keys(liveQuery).some((key) => /^deliveriesOrdersList[:(]/.test(key));
	const ssrHasOrderConnection = typeof ssrQuery === "object" && ssrQuery !== null &&
		!Array.isArray(ssrQuery) && Object.keys(ssrQuery).some((key) => /^deliveriesOrdersList[:(]/.test(key));
	const state = liveState && liveHasOrderConnection
		? liveState
		: ssrState && ssrHasOrderConnection
			? ssrState
			: liveState ?? ssrState;
	return state && typeof state === "object" ? state : null;
}

/** Only a mounted Apollo client can prove live page completion. */
export function readLiveApolloCacheInPage(): ApolloCache | null {
	try {
		const root: unknown = document.querySelector("#root") ?? document.body;
		if (typeof root !== "object" || root === null) return null;
		const rootObject = root as Record<string, FiberNode>;
		const fiberKey = Object.keys(rootObject).find((key) =>
			key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance"),
		);
		let fiber: FiberNode | null | undefined = fiberKey ? rootObject[fiberKey] : null;
		let steps = 0;
		while (fiber && steps < 300) {
			steps += 1;
			const extracted = (fiber.memoizedProps ?? fiber.pendingProps)?.client?.cache?.extract?.();
			if (extracted && typeof extracted === "object") return extracted;
			fiber = fiber.return;
		}
	} catch {
		return null;
	}
	return null;
}

/** True only for the signed-in order-history route with an Apollo cache,
 *  no order refs, and a visible exact generic empty-state phrase. */
export function hasVerifiedEmptyOrderHistoryInPage(): boolean {
	const allowedPhrases = new Set([
		"no orders yet",
		"no order history",
		"no orders found",
		"you haven't placed any orders",
		"your order history is empty",
	]);
	if (
		location.origin !== "https://shop.app" ||
		location.pathname !== "/account/order-history" ||
		document.querySelector(
			'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
		)
	) {
		return false;
	}
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
	const hasOrderContext =
		headings.some((heading) => /orders?|order history/i.test(heading.textContent ?? "")) ||
		Boolean(
			document.querySelector(
				'[data-test*="order"], [data-testid*="order"], a[href*="/orders/"], a[href*="/order/"]',
			),
		);
	if (!hasOrderContext) return false;

	let state: Record<string, unknown> | null = null;
	try {
		const root: unknown = document.querySelector("#root") ?? document.body;
		if (typeof root === "object" && root !== null) {
			const rootObject = root as Record<string, FiberNode>;
			const fiberKey = Object.keys(rootObject).find(
				(key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance"),
			);
			let fiber: FiberNode | null | undefined = fiberKey ? rootObject[fiberKey] : null;
			let steps = 0;
			while (fiber && steps < 300) {
				steps += 1;
				const extracted = (fiber.memoizedProps ?? fiber.pendingProps)?.client?.cache?.extract?.();
				if (extracted && typeof extracted === "object") {
					state = extracted;
					break;
				}
				fiber = fiber.return;
			}
		}
	} catch {
		// A broken live cache does not make an SSR snapshot authoritative.
		return false;
	}
	if (!state) return false;
	const ssrState = typeof window === "undefined" ? undefined :
		(window as Window & { __APOLLO_STATE__?: Record<string, unknown> }).__APOLLO_STATE__;
	const ssrQuery = ssrState?.ROOT_QUERY;
	if (typeof ssrQuery === "object" && ssrQuery !== null && !Array.isArray(ssrQuery)) {
		const ssrHasOrderRef = Object.entries(ssrQuery).some(([key, value]) => {
			if (!/^deliveriesOrdersList[:(]/.test(key) || typeof value !== "object" || value === null || Array.isArray(value)) return false;
			const nodes = (value as { nodes?: unknown }).nodes;
			return Array.isArray(nodes) && nodes.some((node) =>
				typeof node === "object" && node !== null &&
				typeof (node as { __ref?: unknown }).__ref === "string" &&
				(node as { __ref: string }).__ref.startsWith("Order:"),
			);
		});
		if (ssrHasOrderRef) return false;
	}
	const query = state?.ROOT_QUERY;
	if (!query || typeof query !== "object" || Array.isArray(query)) return false;
	const hasOrderRef = Object.entries(query).some(([key, value]) => {
		if (!/^deliveriesOrdersList[:(]/.test(key)) return false;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const nodes = (value as { nodes?: unknown }).nodes;
		return (
			Array.isArray(nodes) &&
			nodes.some(
				(node) =>
					typeof node === "object" &&
					node !== null &&
					"__ref" in node &&
					typeof node.__ref === "string" &&
					node.__ref.startsWith("Order:"),
			)
		);
	});
	if (hasOrderRef) return false;
	return Array.from(document.querySelectorAll("body *")).some((element) => {
		if (element.children.length > 0) return false;
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		if (
			rect.width <= 0 ||
			rect.height <= 0 ||
			style.display === "none" ||
			style.visibility === "hidden"
		) {
			return false;
		}
		const phrase = (element.textContent ?? "").trim().toLowerCase().replace(/\s+/g, " ");
		return allowedPhrases.has(phrase);
	});
}

/** Patchright isolates evaluate() by default. Shop's Apollo and React state
 *  belongs to the page's main world, so these readers must opt into it. */
export function evaluateShopReaderInMainWorld<T>(
	page: Page,
	reader: () => T,
): Promise<T> {
	return (
		page as unknown as {
			evaluate<R>(
				reader: () => R,
				arg: undefined,
				options: undefined,
				isolatedContext: false,
			): Promise<R>;
		}
	).evaluate(reader, undefined, undefined, false);
}

function scrollToBottomInPage(): void {
	window.scrollTo(0, document.body.scrollHeight);
}

/** Order record shape emitted for the `orders` stream. Exported for tests. */
export function orderRecord(order: ParsedOrder): RecordData {
	const id = resolveOrderId(order.id);
	if (id === null) throw new Error("shopify_order_id_unresolvable");
	return {
		id,
		order_number: order.orderNumber,
		order_date: order.placedAt,
		merchant_name: order.merchantName,
		status: order.status,
		total_cents: order.totalCents,
		currency: order.currency,
		item_count: order.itemCount,
		line_item_titles: order.lineItemTitles,
		detail_url: order.detailUrl,
	};
}

/** Reads the Apollo cache from the page, scrolling to accumulate every page
 *  Shop app's `pageInfo.hasNextPage` still advertises, up to a page ceiling.
 *  Extracted so a fake `readCache`/`scroll` pair can drive the exact same
 *  loop `collectShopify` uses without a real browser. */
export interface CacheWalkArgs {
	initialCache?: ApolloCache | null;
	initialOrders?: ParsedOrder[];
	readDomOrders?: () => Promise<ParsedOrder[]>;
	readPageEvidence?: () => Promise<ShopOrderPageEvidence>;
	readVerifiedEmptyState?: () => Promise<boolean>;
	maxBootstrapScrolls?: number;
	maxContinuationScrolls?: number;
	readCache: () => Promise<ApolloCache | null>;
	scroll: () => Promise<void>;
	wait?: (ms: number) => Promise<void>;
}

export interface ShopOrderPageEvidence {
	url: string;
	navigation: string;
	orderContext: boolean;
	blocked: boolean;
	pageHeight: number;
	domHasContinuation: boolean;
	domHasEndMarker: boolean;
	domCardCount: number;
}

export interface CacheWalkResult {
	cache: ApolloCache | null;
	orders: ParsedOrder[];
	truncated: boolean;
	complete: boolean;
	reason: "terminal" | "page_blocked" | "no_progress" | "page_budget" | "end_unproven";
	pageEvidence: ShopOrderPageEvidence | null;
	domDiscardedRows: number;
}

export async function walkOrdersCache(
	args: CacheWalkArgs,
	): Promise<CacheWalkResult> {
	const {
		readCache, readDomOrders, readPageEvidence, scroll,
		maxBootstrapScrolls = MAX_BOOTSTRAP_SCROLLS,
		maxContinuationScrolls = MAX_CONTINUATION_SCROLLS,
		wait = async () => undefined,
	} = args;
	let cache = args.initialCache ?? null;
	let pageEvidence: ShopOrderPageEvidence | null = null;
	let boundPageIdentity: { url: string; navigation: string } | null = null;
	const currentPageEvidence = (): ShopOrderPageEvidence | null => pageEvidence;
	const currentBoundPageIdentity = (): { url: string; navigation: string } | null => boundPageIdentity;
	const orders = new Map<string, ParsedOrder>();
	let domDiscardedRows = 0;
	const merge = (found: readonly ParsedOrder[], replace = false) => {
		for (const order of found) {
			const id = resolveOrderIdentity(order);
			if (id !== null && (replace || !orders.has(id))) orders.set(id, order);
		}
	};
	merge(args.initialOrders ?? []);
	const read = async (): Promise<boolean> => {
		const before = await readPageEvidence?.();
		if (before) {
			pageEvidence = before;
			if (
				before.blocked || !before.orderContext ||
				before.url !== ORDER_HISTORY_URL || before.navigation.length === 0
			) return false;
		}
		const refreshed = await readCache().catch(() => null);
		const after = await readPageEvidence?.();
		if (after) {
			pageEvidence = after;
			if (
				after.blocked || !after.orderContext || after.url !== ORDER_HISTORY_URL ||
				before?.navigation !== after.navigation || before?.url !== after.url ||
				(boundPageIdentity !== null &&
					(boundPageIdentity.url !== after.url || boundPageIdentity.navigation !== after.navigation))
			) return false;
			boundPageIdentity ??= { url: after.url, navigation: after.navigation };
		}
		cache = refreshed;
		if (cache && hasOrdersConnection(cache)) merge(extractOrdersWithCoverage(cache).orders, true);
		if (readDomOrders) {
			const domOrders = await readDomOrders().catch(() => []);
			domDiscardedRows = Math.max(
				domDiscardedRows,
				Math.max(0, (pageEvidence?.domCardCount ?? domOrders.length) - domOrders.length),
			);
			merge(domOrders);
		}
		return true;
	};
		if (!(await read())) {
		return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "page_blocked", pageEvidence, domDiscardedRows };
	}

	let unchanged = 0;
	let previousSignature = orderWalkSignature(cache, orders, pageEvidence);
	for (let round = 0; round < maxBootstrapScrolls && unchanged < MAX_UNCHANGED_BOOTSTRAP_ROUNDS; round += 1) {
		await scroll();
		await wait(BOOTSTRAP_SCROLL_DELAY_MS);
		if (!(await read())) {
			return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "page_blocked", pageEvidence, domDiscardedRows };
		}
		const signature = orderWalkSignature(cache, orders, pageEvidence);
		unchanged = signature === previousSignature ? unchanged + 1 : 0;
		previousSignature = signature;
	}

	let continuationScrolls = 0;
	let noProgress = 0;
	while (cache && hasNextOrdersPage(cache) && continuationScrolls < maxContinuationScrolls) {
		const before = orderWalkSignature(cache, orders, pageEvidence, false);
		await scroll();
		await wait(CONTINUATION_SCROLL_DELAY_MS);
		continuationScrolls += 1;
		if (!(await read())) {
			return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "page_blocked", pageEvidence, domDiscardedRows };
		}
		const after = orderWalkSignature(cache, orders, pageEvidence, false);
		noProgress = after === before ? noProgress + 1 : 0;
		if (noProgress >= MAX_UNCHANGED_BOOTSTRAP_ROUNDS) {
			return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "no_progress", pageEvidence, domDiscardedRows };
		}
	}
	const finalPageEvidence = currentPageEvidence();
	const finalBoundPageIdentity = currentBoundPageIdentity();
	const cacheEnd = Boolean(cache && hasVerifiedOrdersEnd(cache));
	const domEnd = Boolean(finalPageEvidence?.domHasEndMarker && !finalPageEvidence.domHasContinuation);
	let verifiedEmptyEnd = false;
	if (!cacheEnd && !domEnd && args.readVerifiedEmptyState) {
		const before = await readPageEvidence?.();
		const marker = await args.readVerifiedEmptyState().catch(() => false);
		const after = await readPageEvidence?.();
		verifiedEmptyEnd = marker && ((before === undefined && after === undefined) || (
			before !== undefined && after !== undefined &&
			before.url === after.url && before.navigation === after.navigation &&
			after.url === ORDER_HISTORY_URL && !after.blocked && after.orderContext &&
			(finalBoundPageIdentity === null || (
				finalBoundPageIdentity.url === after.url && finalBoundPageIdentity.navigation === after.navigation
			))
		));
	}
	const complete = (cacheEnd || domEnd || verifiedEmptyEnd) && !finalPageEvidence?.domHasContinuation &&
		!(cache && hasNextOrdersPage(cache)) && !domDiscardedRows;
	const budgetHit = Boolean(cache && hasNextOrdersPage(cache) && continuationScrolls >= maxContinuationScrolls);
	return {
		cache,
		orders: [...orders.values()],
		truncated: budgetHit,
		complete,
		reason: complete ? "terminal" : budgetHit ? "page_budget" : "end_unproven",
		pageEvidence: finalPageEvidence,
		domDiscardedRows,
	};
}

function orderWalkSignature(
	cache: ApolloCache | null,
	orders: ReadonlyMap<string, ParsedOrder>,
	page: ShopOrderPageEvidence | null,
	includeHeight = true,
): string {
	const refs = cache ? collectAllOrderRefs(cache) : [];
	return [
		refs.join(","),
		[...orders.keys()].join(","),
	includeHeight ? page?.pageHeight ?? "" : "",
	].join("|");
}

function resolveOrderIdentity(order: ParsedOrder): string | null {
	const id = resolveOrderId(order.id);
	if (id === null) return null;
	const gid = id.match(/^gid:\/\/shopify\/Order\/(.+)$/);
	if (gid) return `shop-order:${gid[1]}`;
	try {
		const url = new URL(id);
		const pathId = url.pathname.match(/^\/orders?\/([^/]+)\/?$/)?.[1];
		if (url.origin === "https://shop.app" && pathId) {
			return `shop-order:${decodeURIComponent(pathId)}`;
		}
	} catch {
		// Keep non-URL source IDs in their exact namespace below.
	}
	return `source:${id}`;
}

export interface CollectShopifyArgs {
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	progress: BrowserCollectContext["progress"];
	readCache: () => Promise<ApolloCache | null>;
	readDomOrders?: () => Promise<ParsedOrder[]>;
	readSkipDiagnostics?: () => Promise<ShopSkipDiagnostics>;
	readPageEvidence?: () => Promise<ShopOrderPageEvidence>;
	wait?: (ms: number) => Promise<void>;
	navigationStartedAt?: number;
	cacheWaitTimeoutMs?: number;
	cachePollIntervalMs?: number;
	evidenceNow?: () => number;
	evidenceWait?: (ms: number) => Promise<void>;
	orderHistoryReady?: boolean;
	readVerifiedEmptyState?: () => Promise<boolean>;
	requested: BrowserCollectContext["requested"];
	scroll: () => Promise<void>;
	state: BrowserCollectContext["state"];
}

type OrderHistoryEvidence =
	| { kind: "orders"; cache: ApolloCache | null; orders: ParsedOrder[] }
	| { kind: "verified_empty"; cache: ApolloCache }
	| { kind: "deadline_expired"; cache: ApolloCache | null };

/** Keep inspecting the hydrated page until records or stable empty evidence appear. */
async function waitForOrderHistoryEvidence({
	readCache, readDomOrders, readVerifiedEmptyState, timeoutMs, pollIntervalMs,
	now, wait,
}: {
	readCache: CollectShopifyArgs["readCache"];
	readDomOrders: CollectShopifyArgs["readDomOrders"];
	readVerifiedEmptyState: CollectShopifyArgs["readVerifiedEmptyState"];
	timeoutMs: number;
	pollIntervalMs: number;
	now: () => number;
	wait: (ms: number) => Promise<void>;
}): Promise<OrderHistoryEvidence> {
	const deadline = now() + timeoutMs;
	let cache: ApolloCache | null = null;
	let consecutiveEmptyReads = 0;
	let firstRead = true;
	while (firstRead || now() < deadline) {
		firstRead = false;
		const readWithinDeadline = async <T>(reader: () => Promise<T>, fallback: T): Promise<T> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			return Promise.race([
				reader().catch(() => fallback),
				new Promise<T>((resolve) => {
					timer = setTimeout(() => resolve(fallback), Math.max(0, deadline - now()));
				}),
			]).finally(() => {
				if (timer) clearTimeout(timer);
			});
		};
		const refreshed = await readWithinDeadline(readCache, null);
		if (refreshed) cache = refreshed;
		const cacheOrders = cache ? extractOrdersWithCoverage(cache).orders : [];
		if (cacheOrders.length > 0) return { kind: "orders", cache, orders: cacheOrders };
		const domOrders = readDomOrders
			? await readWithinDeadline(readDomOrders, [] as ParsedOrder[])
			: [];
		if (domOrders.length > 0) return { kind: "orders", cache, orders: domOrders };
		const empty = refreshed && readVerifiedEmptyState
			? await readWithinDeadline(readVerifiedEmptyState, false)
			: false;
		consecutiveEmptyReads = empty ? consecutiveEmptyReads + 1 : 0;
		if (cache && consecutiveEmptyReads >= 2) {
			return { kind: "verified_empty", cache };
		}
		const remaining = deadline - now();
		if (remaining <= 0) break;
		await wait(Math.min(pollIntervalMs, remaining));
	}
	return { kind: "deadline_expired", cache };
}

/** The connector's whole `orders` stream logic, independent of Playwright —
 *  `readCache`/`scroll` are injected so integration tests can drive this with
 *  a fake page. `collect()` below binds them to a real `page`. */
export async function collectShopify(args: CollectShopifyArgs): Promise<void> {
	const { emit, emitRecord, progress, readCache, readDomOrders, readSkipDiagnostics, navigationStartedAt, requested, scroll, state } =
		args;
	if (!requested.has(ORDERS_STREAM)) {
		return;
	}
	if (args.orderHistoryReady === false) {
		let pageDiagnostics = EMPTY_SHOP_DIAGNOSTICS;
		try {
			pageDiagnostics = await readSkipDiagnostics?.() ?? EMPTY_SHOP_DIAGNOSTICS;
		} catch {
			// A page failure must not hide the bounded route-readiness outcome.
		}
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_history_readiness_timeout",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: `Shop order-history or sign-in UI did not become ready within ${String(ORDER_HISTORY_READY_TIMEOUT_MS)}ms.`,
			diagnostics: {
				...pageDiagnostics,
				navigation_to_first_cache_attempt_ms: null,
				navigation_to_cache_success_ms: null,
			},
		});
		return;
	}

	const cacheTiming = {
		firstAttemptMs: navigationStartedAt === undefined ? null : Math.max(0, Date.now() - navigationStartedAt),
		successMs: null as number | null,
	};
	const evidence = await waitForOrderHistoryEvidence({
		readCache: async () => {
			const cache = await readCache();
			if (cache && cacheTiming.successMs === null && navigationStartedAt !== undefined) {
				cacheTiming.successMs = Math.max(0, Date.now() - navigationStartedAt);
			}
			return cache;
		},
		readDomOrders,
		readVerifiedEmptyState: args.readVerifiedEmptyState,
		timeoutMs: args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS,
		pollIntervalMs: args.cachePollIntervalMs ?? APOLLO_POLL_INTERVAL_MS,
		now: args.evidenceNow ?? Date.now,
		wait: args.evidenceWait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
	});
	const walked: CacheWalkResult = evidence.kind === "deadline_expired"
		? {
			cache: evidence.cache, orders: [], truncated: false, complete: false,
			reason: "end_unproven", pageEvidence: null, domDiscardedRows: 0,
		}
		: await walkOrdersCache({
		readCache: async () => {
			const refreshed = await readCache();
			if (refreshed && cacheTiming.successMs === null && navigationStartedAt !== undefined) {
				cacheTiming.successMs = Math.max(0, Date.now() - navigationStartedAt);
			}
			return refreshed;
		},
		...(readDomOrders ? { readDomOrders } : {}),
		...(args.readPageEvidence ? { readPageEvidence: args.readPageEvidence } : {}),
		...(args.readVerifiedEmptyState ? { readVerifiedEmptyState: args.readVerifiedEmptyState } : {}),
		scroll,
		...(args.wait ? { wait: args.wait } : {}),
	});
	const diagnostics = async (): Promise<ShopSkipDiagnostics> => {
		let pageDiagnostics = EMPTY_SHOP_DIAGNOSTICS;
		try {
			pageDiagnostics = await readSkipDiagnostics?.() ?? EMPTY_SHOP_DIAGNOSTICS;
		} catch {
			// Diagnostics must not turn a useful skip into a connector crash.
		}
		return {
			...pageDiagnostics,
			navigation_to_first_cache_attempt_ms: cacheTiming.firstAttemptMs,
			navigation_to_cache_success_ms: cacheTiming.successMs,
		};
	};
	let { cache, truncated } = walked;
	const orders = walked.orders;
	const cacheCoverage = cache ? extractOrdersWithCoverage(cache) : {
		orders: [], discoveredRows: 0, discardedRows: 0,
	};
	if (evidence.kind === "deadline_expired") {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: cache ? "shopify_order_history_evidence_timeout" : "shopify_apollo_state_unavailable",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: cache
				? `Shop order history did not expose loaded orders or a stable verified empty marker within ${String(args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS)}ms.`
				: `Shop order history did not expose an Apollo cache, DOM orders, or verified empty evidence within ${String(args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS)}ms.`,
			diagnostics: await diagnostics(),
		});
		return;
	}

	const cursor = openFingerprintCursor(state[ORDERS_STREAM]);
	const validRecords: RecordData[] = [];
	let invalidShapeCount = 0;
	for (const order of orders) {
		const record = orderRecord(order);
		const validation = validateRecord(ORDERS_STREAM, record);
		if (!validation.ok) {
			invalidShapeCount += 1;
			continue;
		}
		validRecords.push(record);
	}
	const discardedRows = cacheCoverage.discardedRows + walked.domDiscardedRows + invalidShapeCount;
	const pageComplete = walked.complete;
	const pageBlocked = walked.reason === "page_blocked";
	const mismatch = Boolean(cache && hasOrderCountMismatch(cache));
	const complete = pageComplete && !truncated && !pageBlocked && !mismatch && discardedRows === 0;
	if (!complete && (pageBlocked || !pageComplete || mismatch)) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: truncated && walked.reason === "page_budget"
				? "older_pages_deferred_page_budget"
				: "shopify_order_history_unconfirmed",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: "Shop order history could not be proven complete; retry to collect the remaining rows.",
			diagnostics: {
				...(await diagnostics()),
				discovered_rows: cacheCoverage.discoveredRows,
				valid_rows: pageBlocked ? 0 : validRecords.length,
				discarded_rows: discardedRows,
				terminal_evidence: pageComplete,
				page_owner: walked.pageEvidence?.url ?? null,
				page_navigation: walked.pageEvidence?.navigation ?? null,
				end_reason: walked.reason,
			},
		});
	} else if (!complete && discardedRows > 0) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_rows_unresolved",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: "Shop order history contained rows that could not be read completely; retry to collect them.",
			diagnostics: {
				...(await diagnostics()),
				discovered_rows: cacheCoverage.discoveredRows,
				valid_rows: pageBlocked ? 0 : validRecords.length,
				discarded_rows: discardedRows,
				terminal_evidence: pageComplete,
				page_owner: walked.pageEvidence?.url ?? null,
				page_navigation: walked.pageEvidence?.navigation ?? null,
				end_reason: walked.reason,
			},
		});
	}

	await progress("Loading Shop order history", { stream: ORDERS_STREAM });
	for (const record of pageBlocked ? [] : validRecords) {
		if (cursor.shouldEmit(record)) await emitRecord(ORDERS_STREAM, record);
	}

	await progress("Extracted Shop orders", {
		stream: ORDERS_STREAM,
		count: orders.length,
	});

	if (!complete) return;
	// Pruning is safe only after positive end-of-list evidence and zero row loss.
	cursor.dropUnseenIds();

	await emit({
		type: "STATE",
		stream: ORDERS_STREAM,
		// `fingerprints` wrapper matches `openFingerprintCursor`'s own
		// `decodePriorFingerprints` read shape (see docs/reference/
		// connector-authoring-guide.md §6) — the cursor only recognizes its
		// prior state nested under this key.
		cursor: { fingerprints: cursor.toState() },
	});
}

export function hasShopOrderHistoryContextInPage(): boolean {
	if (
		document.querySelector(
			'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
		)
	) {
		return false;
	}
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
	return (
		headings.some((heading) =>
			/orders?|order history/i.test(heading.textContent ?? ""),
		) ||
		Boolean(
			document.querySelector(
				'[data-test*="order"], [data-testid*="order"], a[href*="/orders/"], a[href*="/order/"]',
			),
		)
	);
}

async function hasShopOrderHistorySession(page: Page): Promise<boolean> {
	try {
		const currentUrl = new URL(page.url());
		if (
			currentUrl.origin !== "https://shop.app" ||
			!currentUrl.pathname.startsWith("/account/order-history")
		) {
			return false;
		}
		await page.waitForFunction(hasShopOrderHistoryContextInPage, undefined, {
			timeout: 10_000,
		});
		return true;
	} catch {
		return false;
	}
}

export async function ensureShopifySession({
	assist,
	capture,
	completeAssistance,
	page,
	sendInteraction,
	manualLogin,
}: Pick<EnsureSessionArgs, "capture" | "page" | "sendInteraction"> &
	Partial<Pick<EnsureSessionArgs, "assist" | "completeAssistance">> & {
		manualLogin?: () => Promise<void>;
	}): Promise<void> {
	const openOrderHistory = async (targetPage: Page) => {
		try {
			await targetPage.goto(ORDER_HISTORY_URL, {
				waitUntil: "domcontentloaded",
				timeout: 30_000,
			});
		} catch (cause) {
			throw new Error("shopify_login_page_unreachable", { cause });
		}
	};
	await openOrderHistory(page);
	if (await hasShopOrderHistorySession(page)) {
		return;
	}

	if (manualLogin) {
		await manualLogin();
	} else {
		await manualBrowserLogin({
			...(assist ? { assist } : {}),
			...(capture ? { capture } : {}),
			...(completeAssistance ? { completeAssistance } : {}),
			isProbeSuccessful: (ready) => ready,
			message:
				"Sign in to Shop in the secure browser. PDPP will continue when your order history is available.",
			page,
			probe: () => hasShopOrderHistorySession(page),
			readinessProbe: (readinessPage) =>
				hasShopOrderHistorySession(readinessPage),
			readinessProbeOnHandoffPage: true,
			sendInteraction,
			timeoutSeconds: 1800,
		});
	}

	await openOrderHistory(page);
	if (!(await hasShopOrderHistorySession(page))) {
		throw new Error("shopify_login_manual_incomplete");
	}
}

async function collect(ctx: BrowserCollectContext): Promise<void> {
	const { page, emit, emitRecord, progress, requested, state } = ctx;
	const navigationStartedAt = Date.now();
	await page
		.goto(ORDER_HISTORY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	const orderHistoryReady = await page.waitForFunction(
		isShopOrderHistoryReadyInPage,
		undefined,
		{ timeout: ORDER_HISTORY_READY_TIMEOUT_MS },
	).then(() => true).catch(() => false);
	// Capture the connector context before attempting cache reads. If the page
	// closes before a later skip, the last safe structural snapshot still ships.
	let latestDiagnostics = await page
		.evaluate(shopSkipDiagnosticsInPage)
		.catch(() => EMPTY_SHOP_DIAGNOSTICS);

	await collectShopify({
		emit,
		emitRecord,
		progress,
		requested,
		state,
		navigationStartedAt,
		orderHistoryReady,
		readCache: () => evaluateShopReaderInMainWorld(page, readLiveApolloCacheInPage),
		readDomOrders: async () => parseDomOrderCards(await page.content()),
		readPageEvidence: () => evaluateShopReaderInMainWorld(page, readShopOrderPageEvidenceInPage),
		readSkipDiagnostics: async () => {
			try {
				latestDiagnostics = await evaluateShopReaderInMainWorld(page, shopSkipDiagnosticsInPage);
			} catch {
				// Preserve the last captured page-only fields if the page has closed.
			}
			return latestDiagnostics;
		},
		readVerifiedEmptyState: () => evaluateShopReaderInMainWorld(page, hasVerifiedEmptyOrderHistoryInPage),
		scroll: async () => {
			await page.evaluate(scrollToBottomInPage);
		},
		wait: politeDelay,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "shopify",
		browser: {},
		validateRecord,
		async ensureSession(args: EnsureSessionArgs): Promise<void> {
			await ensureShopifySession(args);
		},
		collect,
	});
}

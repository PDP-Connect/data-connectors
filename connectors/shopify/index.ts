#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Shopify (Shop app) Connector (v0.2.9)
 *
 * Collects order history from https://shop.app/account/order-history via a
 * logged-in browser session. Shop app is a React/Apollo Client SPA; this
 * connector reads the live Apollo Client cache (reached by walking the React
 * fiber tree from the DOM root), falls back to `window.__APOLLO_STATE__`, and
 * parses visible order cards if Apollo does not expose the order connection.
 *
 * IMPLEMENTED FROM CONTRACT AND PRIOR ART, NOT FROM A LIVE RUN. Per
 * docs/migration/connector-cutover/CONTRACTS.md D10, this connector was
 * ported from the legacy Playwright connector
 * (connectors/shopify/shop-playwright.js — READ ONLY prior art, not a
 * fixture-proven capture) because no Shop app account was available to
 * capture real Apollo-cache output. There is no independent live evidence
 * that this extraction still matches shop.app's current Apollo schema.
 * Manifest `public_listing.tier` stays `development` until a live run
 * proves it (CONTRACTS.md D11).
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
 * decide whether to keep going, capped by MAX_SCROLL_ROUNDS.
 *
 * Cursor: Shop app's order-history query has no documented server-side
 * incremental filter this connector can request, and it fully re-derives
 * the order list each run. This connector uses the shared
 * `openFingerprintCursor` per-record fingerprint gate (see
 * docs/reference/connector-authoring-guide.md §6) so a re-run that observes
 * unchanged orders emits no duplicate RECORDs, and prunes fingerprints for
 * orders no longer returned (full scan each run).
 *
 * CHANGES
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
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import { extractOrders, hasNextOrdersPage, hasOrdersConnection, parseDomOrderCards } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache, ParsedOrder } from "./types.ts";

const ORDER_HISTORY_URL = "https://shop.app/account/order-history";
const SCROLL_STEP_DELAY_MS = 800;
const MAX_SCROLL_ROUNDS = 20;
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
			return /\$\s*[\d,]+(?:\.\d{1,2})?/.test(text) || /\b\d+\s*items?\b/i.test(text)
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
	const state = liveState ?? globalState ?? null;
	return state && typeof state === "object" ? state : null;
}

/** True only for the signed-in order-history route with a live Apollo cache,
 *  no orders connection, and a visible exact generic empty-state phrase. */
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

	const root: unknown = document.querySelector("#root") ?? document.body;
	if (typeof root !== "object" || root === null) return false;
	const rootObject = root as Record<string, FiberNode>;
	const fiberKey = Object.keys(rootObject).find(
		(key) => key.startsWith("__reactFiber") || key.startsWith("__reactInternalInstance"),
	);
	if (!fiberKey) return false;
	let fiber: FiberNode | null | undefined = rootObject[fiberKey];
	let liveState: Record<string, unknown> | null = null;
	let steps = 0;
	while (fiber && steps < 300) {
		steps += 1;
		const props = fiber.memoizedProps ?? fiber.pendingProps;
		try {
			const extracted = props?.client?.cache?.extract?.();
			if (extracted && typeof extracted === "object") {
				liveState = extracted;
				break;
			}
		} catch {
			return false;
		}
		fiber = fiber.return;
	}
	const query = liveState?.ROOT_QUERY;
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

function scrollToBottomInPage(): void {
	window.scrollTo(0, document.body.scrollHeight);
}

/** Order record shape emitted for the `orders` stream. Exported for tests. */
export function orderRecord(order: ParsedOrder): RecordData {
	return {
		id: order.id,
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
	maxRounds?: number;
	readCache: () => Promise<ApolloCache | null>;
	scroll: () => Promise<void>;
}

export async function walkOrdersCache(
	args: CacheWalkArgs,
): Promise<{ cache: ApolloCache | null; truncated: boolean }> {
	const { readCache, scroll, maxRounds = MAX_SCROLL_ROUNDS } = args;
	let cache = args.initialCache === undefined ? await readCache() : args.initialCache;
	if (!cache) {
		return { cache: null, truncated: false };
	}
	const walk = await walkPagesWithCeiling({
		maxPages: maxRounds,
		fetchPage: async () => {
			if (!hasNextOrdersPage(cache as ApolloCache)) {
				return false;
			}
			await scroll();
			const refreshed = await readCache();
			if (refreshed) {
				cache = refreshed;
			}
			return true;
		},
	});
	return { cache, truncated: walk.truncated };
}

export interface CollectShopifyArgs {
	emit: BrowserCollectContext["emit"];
	emitRecord: BrowserCollectContext["emitRecord"];
	progress: BrowserCollectContext["progress"];
	readCache: () => Promise<ApolloCache | null>;
	readDomOrders?: () => Promise<ParsedOrder[]>;
	readSkipDiagnostics?: () => Promise<ShopSkipDiagnostics>;
	navigationStartedAt?: number;
	cacheWaitTimeoutMs?: number;
	cachePollIntervalMs?: number;
	orderHistoryReady?: boolean;
	readVerifiedEmptyState?: () => Promise<boolean>;
	requested: BrowserCollectContext["requested"];
	scroll: () => Promise<void>;
	state: BrowserCollectContext["state"];
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
	const firstRead = await waitForApolloCache({
		readCache,
		timeoutMs: args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS,
		pollIntervalMs: args.cachePollIntervalMs ?? APOLLO_POLL_INTERVAL_MS,
	});
	if (firstRead.cache && navigationStartedAt !== undefined) {
		cacheTiming.successMs = Math.max(0, Date.now() - navigationStartedAt);
	}
	let { cache, truncated } = await walkOrdersCache({
		initialCache: firstRead.cache,
		readCache: async () => {
			const refreshed = await readCache();
			if (refreshed && cacheTiming.successMs === null && navigationStartedAt !== undefined) {
				cacheTiming.successMs = Math.max(0, Date.now() - navigationStartedAt);
			}
			return refreshed;
		},
		scroll,
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
	let orders = cache ? extractOrders(cache) : [];
	if (orders.length === 0 && readDomOrders) {
		try {
			orders = await readDomOrders();
		} catch {
			orders = [];
		}
	}
	if (!cache && orders.length === 0) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_apollo_state_unavailable",
			message:
				"Shop order-history page did not expose an Apollo cache (client not mounted or session not live).",
			diagnostics: await diagnostics(),
		});
		return;
	}
	// Fail closed: a missing reader, a false result, or a page error all skip.
	if (
		cache && !hasOrdersConnection(cache) && orders.length === 0 &&
		!(await args.readVerifiedEmptyState?.().catch(() => false))
	) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_history_unconfirmed",
			message:
				"Shop Orders (orders) could not be confirmed: the page had no order connection or verified empty-state marker. Confirm order history is loaded, then try again.",
			diagnostics: await diagnostics(),
		});
		return;
	}

	await progress("Loading Shop order history", { stream: ORDERS_STREAM });
	if (
		orders.length === 0 &&
		!(await args.readVerifiedEmptyState?.().catch(() => false))
	) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_history_unconfirmed",
			message:
				"Shop Orders (orders) could not be confirmed: the page had no loaded orders or verified empty-state marker. Confirm order history is loaded, then try again.",
			diagnostics: await diagnostics(),
		});
		return;
	}

	const cursor = openFingerprintCursor(state[ORDERS_STREAM]);
	for (const order of orders) {
		const record = orderRecord(order);
		if (cursor.shouldEmit(record)) {
			await emitRecord(ORDERS_STREAM, record);
		}
	}
	// Full re-derive each run (Apollo cache has no server-side incremental
	// filter this connector can request) — prune fingerprints for orders this
	// run did not see, so a later re-add is not silently gated.
	cursor.dropUnseenIds();

	await progress("Extracted Shop orders", {
		stream: ORDERS_STREAM,
		count: orders.length,
	});

	if (truncated) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "older_pages_deferred_page_budget",
			message: `Shop orders stopped at the ${String(MAX_SCROLL_ROUNDS)}-scroll limit with more orders still listed`,
			diagnostics: {
			...(await diagnostics()),
			page_limit: MAX_SCROLL_ROUNDS,
				total_seen: orders.length,
				unread_pages: 1,
			},
		});
	}

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
		readCache: () => page.evaluate(readApolloCacheInPage),
		readDomOrders: async () => parseDomOrderCards(await page.content()),
		readSkipDiagnostics: async () => {
			try {
				latestDiagnostics = await page.evaluate(shopSkipDiagnosticsInPage);
			} catch {
				// Preserve the last captured page-only fields if the page has closed.
			}
			return latestDiagnostics;
		},
		readVerifiedEmptyState: () => page.evaluate(hasVerifiedEmptyOrderHistoryInPage),
		scroll: async () => {
			await page.evaluate(scrollToBottomInPage);
			await politeDelay(SCROLL_STEP_DELAY_MS);
		},
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

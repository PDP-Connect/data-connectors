#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Shopify (Shop app) Connector (v0.2.1)
 *
 * Collects order history from https://shop.app/account/order-history via a
 * logged-in browser session. Shop app is a React/Apollo Client SPA; this
 * connector reads the live Apollo Client cache (reached by walking the React
 * fiber tree from the DOM root) rather than `window.__APOLLO_STATE__`, which
 * is only the initial SSR snapshot and does not accumulate orders loaded by
 * scrolling.
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
import { extractOrders, hasNextOrdersPage, hasOrdersConnection } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache, ParsedOrder } from "./types.ts";

const ORDER_HISTORY_URL = "https://shop.app/account/order-history";
const SCROLL_STEP_DELAY_MS = 800;
const MAX_SCROLL_ROUNDS = 20;
export const ORDERS_STREAM = "orders";

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
	function isFiberHostLocal(value: unknown): value is Record<string, FiberNode> {
		return typeof value === "object" && value !== null;
	}
	function getLiveApolloState(): Record<string, unknown> | null {
		try {
			const root: unknown = document.querySelector("#root") ?? document.body;
			if (!isFiberHostLocal(root)) return null;
			const fiberKey = Object.keys(root).find(
				(key) =>
					key.startsWith("__reactFiber") ||
					key.startsWith("__reactInternalInstance"),
			);
			if (!fiberKey) return null;
			let fiber: FiberNode | null | undefined = root[fiberKey];
			let steps = 0;
			while (fiber && steps < 300) {
				steps += 1;
				const props = fiber.memoizedProps ?? fiber.pendingProps;
				const extracted = props?.client?.cache?.extract?.();
				if (extracted) return extracted;
				fiber = fiber.return;
			}
		} catch {
			// Fall through to the SSR snapshot below.
		}
		return null;
	}

	interface WindowWithApolloState {
		__APOLLO_STATE__?: Record<string, unknown>;
	}
	const globalState = (window as Window & WindowWithApolloState)
		.__APOLLO_STATE__;
	const state = getLiveApolloState() ?? globalState ?? null;
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
	if (Object.keys(query).some((key) => /^deliveriesOrdersList[:(]/.test(key))) {
		return false;
	}
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
	maxRounds?: number;
	readCache: () => Promise<ApolloCache | null>;
	scroll: () => Promise<void>;
}

export async function walkOrdersCache(
	args: CacheWalkArgs,
): Promise<{ cache: ApolloCache | null; truncated: boolean }> {
	const { readCache, scroll, maxRounds = MAX_SCROLL_ROUNDS } = args;
	let cache = await readCache();
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
	readVerifiedEmptyState?: () => Promise<boolean>;
	requested: BrowserCollectContext["requested"];
	scroll: () => Promise<void>;
	state: BrowserCollectContext["state"];
}

/** The connector's whole `orders` stream logic, independent of Playwright —
 *  `readCache`/`scroll` are injected so integration tests can drive this with
 *  a fake page. `collect()` below binds them to a real `page`. */
export async function collectShopify(args: CollectShopifyArgs): Promise<void> {
	const { emit, emitRecord, progress, readCache, readVerifiedEmptyState, requested, scroll, state } =
		args;
	if (!requested.has(ORDERS_STREAM)) {
		return;
	}

	const { cache, truncated } = await walkOrdersCache({ readCache, scroll });
	if (!cache) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_apollo_state_unavailable",
			message:
				"Shop order-history page did not expose an Apollo cache (client not mounted or session not live).",
		});
		return;
	}
	// Fail closed: a missing reader, a false result, or a page error all skip.
	if (
		!hasOrdersConnection(cache) &&
		!(await readVerifiedEmptyState?.().catch(() => false))
	) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_history_unconfirmed",
			message:
				"Shop Orders (orders) could not be confirmed: the page had no order connection or verified empty-state marker. Confirm order history is loaded, then try again.",
		});
		return;
	}

	await progress("Loading Shop order history", { stream: ORDERS_STREAM });
	const orders = extractOrders(cache);

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
	await page
		.goto(ORDER_HISTORY_URL, { waitUntil: "domcontentloaded", timeout: 30_000 })
		.catch((): undefined => undefined);
	await politeDelay(3000);

	await collectShopify({
		emit,
		emitRecord,
		progress,
		requested,
		state,
		readCache: () => page.evaluate(readApolloCacheInPage),
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

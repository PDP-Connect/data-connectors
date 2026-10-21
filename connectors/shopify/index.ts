#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Shopify (Shop app) Connector (v0.2.32)
 *
 * Collects order history from https://shop.app/account/order-history via a
 * logged-in browser session. Shop app is a React/Apollo Client SPA; this
 * connector reads the live Apollo Client cache (reached by walking the React
 * fiber tree from the DOM root), falls back to `window.__APOLLO_STATE__`, and
 * parses visible order cards if Apollo does not expose the order connection.
 * shop.app now redirects to shop.com, which has no reachable Apollo cache and
 * renders orders as keyless buttons; there the orders come from the order
 * screen's own `POST /web/api/order-history` replies (order-history-api.ts),
 * and the same parsers and end-of-list proof apply to them.
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
 *   v0.2.30 (2026-10-16) — read shop.com order history from Shop's own
 *     order-history endpoint; stop treating the signed-in "Sign in & security"
 *     link as a sign-in wall; claim completeness only from Shop's own
 *     end-of-list evidence and report anything less as
 *     inventory_not_proven_complete.
 *   v0.2.29 (2026-10-16) — recognize shop.com redirects and preserve order identities.
 *   v0.2.28 (2026-10-15) — bound browser reads, withhold incomplete rows, and
 *     require request-bound terminal evidence before pruning.
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
	canonicalShopUrl,
	collectAllOrderRefs,
	extractOrdersWithCoverage,
	hasDeclaredOrderTotal,
	hasNextOrdersPage,
	hasOrderCountMismatch,
	hasOrdersConnection,
	hasVerifiedOrdersEnd,
	isShopOrderHistoryPageUrl,
	isShopOrigin,
	parseDomOrderCards,
	resolveOrderId,
} from "./parsers.ts";
import {
	createOrderHistoryApiReader, fetchOrderHistoryPageInPage, orderHistoryCacheIdentity,
	sameOrderHistoryPage, type OrderHistoryPageIdentity,
} from "./order-history-api.ts";
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
const DEFAULT_BROWSER_OPERATION_TIMEOUT_MS = 3_000;
const DEFAULT_RUN_BUDGET_MS = 90_000;
const SESSION_ESTABLISHMENT_BUDGET_MS = 75_000;
const DIAGNOSTICS_TIMEOUT_MS = 100;
export const ORDERS_STREAM = "orders";

class ShopifyBrowserOperationTimeout extends Error {
	readonly reason = "shopify_browser_operation_timeout";
	readonly operation: string;

	constructor(operation: string) {
		super("shopify_browser_operation_timeout");
		this.operation = operation;
	}
}

async function withBrowserOperationBudget<T>(
	operation: string,
	read: () => Promise<T>,
	deadlineAt: number,
	operationTimeoutMs: number,
): Promise<T> {
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) throw new ShopifyBrowserOperationTimeout("run_deadline");
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve().then(read),
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new ShopifyBrowserOperationTimeout(operation)),
					Math.min(operationTimeoutMs, remaining),
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function isBrowserOperationTimeout(cause: unknown): cause is ShopifyBrowserOperationTimeout {
	return cause instanceof ShopifyBrowserOperationTimeout;
}

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
	const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
	const cardKeys = new Set(
		links.flatMap((link) => {
			try {
				const origin = new URL(link.getAttribute("href") ?? "", location.href).origin;
				if (origin !== "https://shop.app" && origin !== "https://shop.com") return [];
			} catch {
				return [];
			}
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
	const hasSignInCTA = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]")).some((element) => {
		const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ");
		// A sign-in prompt, not an account link that merely starts with the same words
		// (the signed-in sidebar has "Sign in & security").
		if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
		return /^(?:(?:sign|log)[\s-]?in(?:\s+to\s+[^&]+)?|continue to (?:sign|log) in)$/i.test(label);
	});
	const signIn = document.querySelector(
		'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
	);
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"));
	const orderContext = headings.some((heading) =>
		/orders?|order history/i.test(heading.textContent ?? ""),
	) || Boolean(document.querySelector(
		'[data-test*="order"], [data-testid*="order"], .order-card, a[href*="/orders/"], a[href*="/order/"]',
	));
	return Boolean(signIn) || orderContext || hasSignInCTA;
}

/** Page ownership/readability evidence used to bind cache proof to this navigation. */
export function readShopOrderPageEvidenceInPage(): ShopOrderPageEvidence {
	const url = new URL(location.href);
	const hasSignInCTA = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]")).some((element) => {
		const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ");
		if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
		return /^(?:(?:sign|log)[\s-]?in(?:\s+to\s+[^&]+)?|continue to (?:sign|log) in)$/i.test(label);
	});
	const login = Boolean(document.querySelector(
		'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
	)) || hasSignInCTA;
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
	).filter((control) => {
		const rect = control.getBoundingClientRect();
		const style = getComputedStyle(control);
		const owner = control.closest('[data-testid*="order"], [data-test*="order"], [role="list"], ul, ol, .order-list');
		return rect.width > 0 && rect.height > 0 && style.display !== "none" &&
			style.visibility !== "hidden" && owner !== null;
	});
	const domHasContinuation = nextControls.some((control) =>
		!control.hasAttribute("disabled") && control.getAttribute("aria-disabled") !== "true",
	);
	const domCardCount = new Set(
		Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).flatMap((link) => {
			try {
				const origin = new URL(link.getAttribute("href") ?? "", location.href).origin;
				if (origin !== "https://shop.app" && origin !== "https://shop.com") return [];
			} catch {
				return [];
			}
			const card = link.closest('.order-card, [data-testid*="order"], [data-test*="order"], div[class]') ?? link;
			const text = (card.textContent ?? "").replace(/\s+/g, " ").trim();
			return /(?:\$\s*[\d,]+(?:\.\d{1,2})?|[\d,]+(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|CAD)\b)/i.test(text) ||
				/\b\d+\s*items?\b/i.test(text) ? [card] : [];
		}),
	).size;
	return {
		url: `${url.origin}${url.pathname}`,
		navigation: String(performance.timeOrigin),
		orderContext,
		blocked: login || blockedText || (url.origin !== "https://shop.app" && url.origin !== "https://shop.com") || url.pathname !== "/account/order-history",
		pageHeight: Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0),
		domHasContinuation,
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
}: WaitForApolloCacheArgs): Promise<{ cache: ApolloCache | null; timedOut: boolean; reason?: string }> {
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
		if (remaining <= 0) return { cache: null, timedOut: true, reason: "shopify_browser_operation_timeout" };
		try {
			await withBrowserOperationBudget(
				"apollo_poll_wait", () => wait(Math.min(pollIntervalMs, remaining)),
				Date.now() + remaining, remaining,
			);
		} catch (cause) {
			if (isBrowserOperationTimeout(cause)) {
				return { cache: null, timedOut: true, reason: cause.reason };
			}
			throw cause;
		}
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

/** True only with an authenticated viewer, an unfiltered terminal empty
 *  orders request, and a visible exact generic empty-state phrase. */
export function hasVerifiedEmptyOrderHistoryInPage(): boolean {
	const hasSignInCTA = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]")).some((element) => {
		const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ");
		if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
		return /^(?:(?:sign|log)[\s-]?in(?:\s+to\s+[^&]+)?|continue to (?:sign|log) in)$/i.test(label);
	});
	const allowedPhrases = new Set([
		"no orders yet",
		"no order history",
		"no orders found",
		"you haven't placed any orders",
		"your order history is empty",
	]);
	if (
		(location.origin !== "https://shop.app" && location.origin !== "https://shop.com") ||
		location.pathname !== "/account/order-history" ||
		document.querySelector(
			'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
		) || hasSignInCTA
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
	const viewer = (query as Record<string, unknown>).viewer;
	if (typeof viewer !== "object" || viewer === null || !("__ref" in viewer) || typeof viewer.__ref !== "string") return false;
	const viewerEntity = state[viewer.__ref];
	if (typeof viewerEntity !== "object" || viewerEntity === null || Array.isArray(viewerEntity)) return false;
	const viewerId = (viewerEntity as Record<string, unknown>).id;
	if (typeof viewerId !== "string" || viewerId.length === 0) return false;
	const orderRequests = Object.entries(query).filter(([key]) =>
		key.startsWith("deliveriesOrdersList:") || key.startsWith("deliveriesOrdersList("),
	);
	if (orderRequests.length === 0) return false;
	for (const [key, value] of orderRequests) {
		const argsText = key.startsWith("deliveriesOrdersList:")
			? key.slice("deliveriesOrdersList:".length)
			: key.slice("deliveriesOrdersList(".length, -1);
		let args: unknown;
		try {
			args = JSON.parse(argsText);
		} catch {
			return false;
		}
		if (typeof args !== "object" || args === null || Array.isArray(args)) return false;
		const request = args as Record<string, unknown>;
		if (Object.keys(request).some((name) => !["filter", "sortBy", "sortKey", "first", "after"].includes(name))) return false;
		if (request.filter !== undefined && request.filter !== null &&
			(typeof request.filter !== "object" || request.filter === null || Array.isArray(request.filter) || Object.keys(request.filter).length > 0)) return false;
		if (request.after !== undefined && request.after !== null) return false;
		if (request.first !== undefined && (!Number.isInteger(request.first) || Number(request.first) <= 0)) return false;
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const connection = value as Record<string, unknown>;
		const pageInfo = connection.pageInfo;
		if (!Array.isArray(connection.nodes) || connection.nodes.length !== 0 ||
			typeof pageInfo !== "object" || pageInfo === null || Array.isArray(pageInfo) ||
			(pageInfo as Record<string, unknown>).hasNextPage !== false) return false;
		const totals: unknown[] = [];
		if (Object.hasOwn(connection, "totalCount")) totals.push(connection.totalCount);
		if (Object.hasOwn(pageInfo, "totalCount")) totals.push((pageInfo as Record<string, unknown>).totalCount);
		if (totals.some((total) => total === undefined || total === null ||
			((typeof total !== "number" && typeof total !== "string") ||
				(typeof total === "string" && total.trim().length === 0) || Number(total) !== 0))) return false;
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
		detail_url: canonicalShopUrl(order.detailUrl),
	};
}

/** Reads the Apollo cache from the page, scrolling to accumulate every page
 *  Shop app's `pageInfo.hasNextPage` still advertises, up to a page ceiling.
 *  Extracted so a fake `readCache`/`scroll` pair can drive the exact same
 *  loop `collectShopify` uses without a real browser. */
export interface CacheWalkArgs {
	initialPageIdentity?: Readonly<OrderHistoryPageIdentity> | null;
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
	browserOperationTimeoutMs?: number;
	runDeadlineAt?: number;
}

export interface ShopOrderPageEvidence {
	url: string;
	navigation: string;
	orderContext: boolean;
	blocked: boolean;
	pageHeight: number;
	domHasContinuation: boolean;
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
	coverage: {
		discoveredRows: number;
		discardedRows: number;
		withheldRows: Array<{ fields: Array<{ field: string; reason: string }> }>;
	};
	countMismatch: boolean;
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
	const deadlineAt = args.runDeadlineAt ?? Date.now() + DEFAULT_RUN_BUDGET_MS;
	const operationTimeoutMs = args.browserOperationTimeoutMs ?? DEFAULT_BROWSER_OPERATION_TIMEOUT_MS;
	let cache = args.initialCache ?? null;
	let pageEvidence: ShopOrderPageEvidence | null = null;
	const initialCacheIdentity = orderHistoryCacheIdentity(cache);
	let boundPageIdentity = args.initialPageIdentity ?? initialCacheIdentity;
	const currentPageEvidence = (): ShopOrderPageEvidence | null => pageEvidence;
	const currentBoundPageIdentity = (): { url: string; navigation: string } | null => boundPageIdentity;
	const orders = new Map<string, ParsedOrder>();
	const apolloIdentities = new Set<string>();
	const unavailableDomOrders = new Map<string, Array<{ field: string; reason: string }>>();
	const discoveredRows = new Set<string>();
	const unavailableByRef = new Map<string, Array<{ field: string; reason: string }>>();
	const unidentifiedIssues = new Map<string, Array<{ field: string; reason: string }>>();
	let countMismatch = false;
	let freshCache: ApolloCache | null = null;
	const mergeCoverage = (snapshot: ApolloCache): void => {
		const coverage = extractOrdersWithCoverage(snapshot);
		for (const ref of collectAllOrderRefs(snapshot)) discoveredRows.add(`ref:${ref}`);
		for (const ref of coverage.availableRefs) unavailableByRef.delete(ref);
		for (const item of coverage.unavailableByRef) {
			discoveredRows.add(`ref:${item.ref}`);
			unavailableByRef.set(item.ref, item.fields);
		}
		for (const issue of coverage.unidentifiedRows) {
			discoveredRows.add(`unidentified:${issue.key}`);
			unidentifiedIssues.set(issue.key, issue.fields);
		}
		for (const order of coverage.orders) {
			const identity = resolveOrderIdentity(order);
			if (identity !== null) {
				apolloIdentities.add(identity);
				unavailableDomOrders.delete(identity);
			}
		}
		merge(coverage.orders, true);
		if (hasDeclaredOrderTotal(snapshot)) {
			countMismatch = hasOrderCountMismatch(snapshot);
			if (hasVerifiedOrdersEnd(snapshot) && !countMismatch) unidentifiedIssues.clear();
		}
	};
	const coverageSummary = () => {
		const withheldRows = [
			...unavailableByRef.values(),
			...unidentifiedIssues.values(),
			...unavailableDomOrders.values(),
		].map((fields) => ({ fields }));
		for (let index = 0; index < domDiscardedRows; index += 1) {
			withheldRows.push({ fields: [{ field: "order", reason: "unreadable_dom_card" }] });
		}
		return {
			discoveredRows: discoveredRows.size + domDiscardedRows,
			discardedRows: withheldRows.length,
			withheldRows,
		};
	};
	let domDiscardedRows = 0;
	const merge = (found: readonly ParsedOrder[], replace = false) => {
		for (const order of found) {
			const id = resolveOrderIdentity(order);
			if (id !== null && (replace || !orders.has(id))) orders.set(id, order);
		}
	};
	const mergeDomOrder = (order: ParsedOrder): void => {
		const identity = resolveOrderIdentity(order);
		if (identity === null) {
			domDiscardedRows += 1;
			return;
		}
		if (apolloIdentities.has(identity)) return;
		const missing = domUnavailableFields(order);
		if (missing.length === 0) merge([order]);
		else {
			discoveredRows.add(`dom:${identity}`);
			unavailableDomOrders.set(identity, missing);
		}
	};
	if (args.initialCache) mergeCoverage(args.initialCache);
	for (const order of args.initialOrders ?? []) mergeDomOrder(order);
	const read = async (): Promise<boolean> => {
		if (initialCacheIdentity !== null && boundPageIdentity !== null &&
			!sameOrderHistoryPage(initialCacheIdentity, boundPageIdentity)) return false;
		const before = readPageEvidence
			? await withBrowserOperationBudget("page_evidence_read", readPageEvidence, deadlineAt, operationTimeoutMs)
			: undefined;
		if (before) {
			pageEvidence = before;
			if (
				before.blocked || !before.orderContext ||
				!isShopOrderHistoryPageUrl(before.url) || before.navigation.length === 0 ||
				(boundPageIdentity !== null && !sameOrderHistoryPage(boundPageIdentity, before))
			) return false;
		}
		const refreshed = await withBrowserOperationBudget("apollo_cache_read", readCache, deadlineAt, operationTimeoutMs).catch((cause: unknown) => {
			if (isBrowserOperationTimeout(cause)) throw cause;
			return null;
		});
		const after = readPageEvidence
			? await withBrowserOperationBudget("page_evidence_read", readPageEvidence, deadlineAt, operationTimeoutMs)
			: undefined;
		if (after) {
			pageEvidence = after;
			if (
				after.blocked || !after.orderContext || !isShopOrderHistoryPageUrl(after.url) ||
				before?.navigation !== after.navigation || before?.url !== after.url ||
				(boundPageIdentity !== null &&
					(boundPageIdentity.url !== after.url || boundPageIdentity.navigation !== after.navigation))
			) return false;
			boundPageIdentity ??= { url: after.url, navigation: after.navigation };
		}
		const source = orderHistoryCacheIdentity(refreshed);
		if (source !== null) {
			if ((boundPageIdentity !== null && !sameOrderHistoryPage(boundPageIdentity, source)) ||
				(after !== undefined && !sameOrderHistoryPage(after, source))) return false;
			boundPageIdentity ??= source;
		}
		freshCache = refreshed;
		if (refreshed) {
			cache = refreshed;
			if (hasOrdersConnection(refreshed)) mergeCoverage(refreshed);
		}
		if (readDomOrders) {
			const domOrders = await withBrowserOperationBudget("dom_order_read", readDomOrders, deadlineAt, operationTimeoutMs).catch((cause: unknown) => {
				if (isBrowserOperationTimeout(cause)) throw cause;
				return [];
			});
			domDiscardedRows = Math.max(
				domDiscardedRows,
				Math.max(0, (pageEvidence?.domCardCount ?? domOrders.length) - domOrders.length),
			);
			for (const order of domOrders) mergeDomOrder(order);
		}
		return true;
	};
		if (!(await read())) {
		return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "page_blocked", pageEvidence, domDiscardedRows, coverage: coverageSummary(), countMismatch };
	}

	let unchanged = 0;
	let previousSignature = orderWalkSignature(cache, orders, pageEvidence);
	for (let round = 0; round < maxBootstrapScrolls && unchanged < MAX_UNCHANGED_BOOTSTRAP_ROUNDS; round += 1) {
		await withBrowserOperationBudget("scroll", scroll, deadlineAt, operationTimeoutMs);
		await withBrowserOperationBudget("bootstrap_wait", () => wait(BOOTSTRAP_SCROLL_DELAY_MS), deadlineAt, operationTimeoutMs);
		if (!(await read())) {
			return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "page_blocked", pageEvidence, domDiscardedRows, coverage: coverageSummary(), countMismatch };
		}
		const signature = orderWalkSignature(cache, orders, pageEvidence);
		unchanged = signature === previousSignature ? unchanged + 1 : 0;
		previousSignature = signature;
	}

	let continuationScrolls = 0;
	let noProgress = 0;
	while (cache && hasNextOrdersPage(cache) && continuationScrolls < maxContinuationScrolls) {
		const before = orderWalkSignature(cache, orders, pageEvidence, false);
		await withBrowserOperationBudget("scroll", scroll, deadlineAt, operationTimeoutMs);
		await withBrowserOperationBudget("continuation_wait", () => wait(CONTINUATION_SCROLL_DELAY_MS), deadlineAt, operationTimeoutMs);
		continuationScrolls += 1;
		if (!(await read())) {
			return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "page_blocked", pageEvidence, domDiscardedRows, coverage: coverageSummary(), countMismatch };
		}
		const after = orderWalkSignature(cache, orders, pageEvidence, false);
		noProgress = after === before ? noProgress + 1 : 0;
		if (noProgress >= MAX_UNCHANGED_BOOTSTRAP_ROUNDS) {
			return { cache, orders: [...orders.values()], truncated: true, complete: false, reason: "no_progress", pageEvidence, domDiscardedRows, coverage: coverageSummary(), countMismatch };
		}
	}
	const finalPageEvidence = currentPageEvidence();
	const finalBoundPageIdentity = currentBoundPageIdentity();
	const cacheEnd = Boolean(freshCache && hasVerifiedOrdersEnd(freshCache));
	let verifiedEmptyEnd = false;
	if (!cacheEnd && args.readVerifiedEmptyState) {
		const before = readPageEvidence
			? await withBrowserOperationBudget("page_evidence_read", readPageEvidence, deadlineAt, operationTimeoutMs)
			: undefined;
		const marker = await withBrowserOperationBudget("verified_empty_read", args.readVerifiedEmptyState, deadlineAt, operationTimeoutMs).catch((cause: unknown) => {
			if (isBrowserOperationTimeout(cause)) throw cause;
			return false;
		});
		const after = readPageEvidence
			? await withBrowserOperationBudget("page_evidence_read", readPageEvidence, deadlineAt, operationTimeoutMs)
			: undefined;
		verifiedEmptyEnd = marker && ((before === undefined && after === undefined) || (
			before !== undefined && after !== undefined &&
			before.url === after.url && before.navigation === after.navigation &&
			isShopOrderHistoryPageUrl(after.url) && !after.blocked && after.orderContext &&
			(finalBoundPageIdentity === null || (
				finalBoundPageIdentity.url === after.url && finalBoundPageIdentity.navigation === after.navigation
			))
		));
	}
	const coverage = coverageSummary();
	const cacheSnapshotIsCurrent = cache === null || freshCache !== null;
	const complete = cacheSnapshotIsCurrent && (cacheEnd || verifiedEmptyEnd) && !finalPageEvidence?.domHasContinuation &&
		!(cache && hasNextOrdersPage(cache)) && !domDiscardedRows && coverage.discardedRows === 0 && !countMismatch;
	const budgetHit = Boolean(cache && hasNextOrdersPage(cache) && continuationScrolls >= maxContinuationScrolls);
	return {
		cache,
		orders: [...orders.values()],
		truncated: budgetHit,
		complete,
		reason: complete ? "terminal" : budgetHit ? "page_budget" : "end_unproven",
		pageEvidence: finalPageEvidence,
		domDiscardedRows,
		coverage,
		countMismatch,
	};
}

function domUnavailableFields(order: ParsedOrder): Array<{ field: string; reason: string }> {
	const fields: Array<{ field: string; reason: string }> = [];
	if (order.orderNumber === null) fields.push({ field: "order_number", reason: "not_present_in_dom" });
	if (order.placedAt === null) fields.push({ field: "placed_at", reason: "not_present_in_dom" });
	if (order.merchantName === null) fields.push({ field: "merchant_name", reason: "not_present_in_dom" });
	if (order.totalCents === null) fields.push({ field: "total", reason: "not_present_in_dom" });
	if (order.currency === null) fields.push({ field: "currency", reason: "not_present_in_dom" });
	if (order.status === null) fields.push({ field: "status", reason: "not_present_in_dom" });
	if (order.itemCount === null) fields.push({ field: "item_count", reason: "not_present_in_dom" });
	if (order.lineItemTitles.length === 0) fields.push({ field: "line_item_titles", reason: "not_present_in_dom" });
	return fields;
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
		if (isShopOrigin(url.origin) && pathId) {
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
	reportStreamFailure?: BrowserCollectContext["reportStreamFailure"];
	scroll: () => Promise<void>;
	state: BrowserCollectContext["state"];
	browserOperationTimeoutMs?: number;
	runBudgetMs?: number;
	runDeadlineAt?: number;
}

type OrderHistoryEvidence =
	| { kind: "orders"; cache: ApolloCache | null; orders: ParsedOrder[] }
	| { kind: "verified_empty"; cache: ApolloCache; orders: ParsedOrder[] }
	| { kind: "deadline_expired"; cache: ApolloCache | null; orders: ParsedOrder[] };

function aggregateWithheldFields(
	rows: Array<{ fields: Array<{ field: string; reason: string }> }>,
): Array<{ field: string; reason: string; count: number }> {
	const counts = new Map<string, number>();
	for (const row of rows) {
		for (const item of row.fields) {
			const key = `${item.field}\u0000${item.reason}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts].map(([key, count]) => {
		const [fieldName, reason] = key.split("\u0000");
		return { field: fieldName ?? "unknown", reason: reason ?? "unavailable", count };
	});
}

function schemaWithheldRows(
	issues: readonly { path: string; message: string }[],
): Array<{ fields: Array<{ field: string; reason: string }> }> {
	const uniqueFields = new Set(issues.map((issue) => issue.path.split(".")[0] ?? "record"));
	return [{
		fields: [...uniqueFields].map((fieldName) => ({ field: fieldName, reason: "schema_validation_failed" })),
	}];
}

/** Keep inspecting the hydrated page until records or stable empty evidence appear. */
async function waitForOrderHistoryEvidence({
	readCache, readDomOrders, readVerifiedEmptyState, timeoutMs, pollIntervalMs,
	now, wait, runDeadlineAt, operationTimeoutMs,
}: {
	readCache: CollectShopifyArgs["readCache"];
	readDomOrders: CollectShopifyArgs["readDomOrders"];
	readVerifiedEmptyState: CollectShopifyArgs["readVerifiedEmptyState"];
	timeoutMs: number;
	pollIntervalMs: number;
	now: () => number;
	wait: (ms: number) => Promise<void>;
	runDeadlineAt: number;
	operationTimeoutMs: number;
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
				reader().catch((cause: unknown) => {
					if (isBrowserOperationTimeout(cause)) throw cause;
					return fallback;
				}),
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
		const coverage = cache ? extractOrdersWithCoverage(cache) : null;
		if (coverage && coverage.discoveredRows > 0) return { kind: "orders", cache, orders: coverage.orders };
		const domOrders = readDomOrders
			? await readWithinDeadline(readDomOrders, [] as ParsedOrder[])
			: [];
		if (domOrders.length > 0) return { kind: "orders", cache, orders: domOrders };
		const empty = refreshed && readVerifiedEmptyState
			? await readWithinDeadline(readVerifiedEmptyState, false)
			: false;
		consecutiveEmptyReads = empty ? consecutiveEmptyReads + 1 : 0;
		if (cache && consecutiveEmptyReads >= 2) {
			return { kind: "verified_empty", cache, orders: [] };
		}
		const remaining = deadline - now();
		if (remaining <= 0) break;
		await withBrowserOperationBudget(
			"evidence_poll_wait", () => wait(Math.min(pollIntervalMs, remaining)),
			runDeadlineAt, operationTimeoutMs,
		);
	}
	return { kind: "deadline_expired", cache, orders: cache ? extractOrdersWithCoverage(cache).orders : [] };
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
	const runDeadlineAt = args.runDeadlineAt ?? Date.now() + (args.runBudgetMs ?? DEFAULT_RUN_BUDGET_MS);
	const operationTimeoutMs = args.browserOperationTimeoutMs ?? DEFAULT_BROWSER_OPERATION_TIMEOUT_MS;
	let cachedDiagnostics = EMPTY_SHOP_DIAGNOSTICS;
	const refreshDiagnostics = (): void => {
		if (!readSkipDiagnostics) return;
		void withBrowserOperationBudget(
			"diagnostics_read", readSkipDiagnostics, runDeadlineAt,
			Math.min(operationTimeoutMs, DIAGNOSTICS_TIMEOUT_MS),
		).then((diagnostics) => { cachedDiagnostics = diagnostics; }).catch(() => undefined);
	};
	const diagnostics = (): ShopSkipDiagnostics => ({
		...cachedDiagnostics,
		navigation_to_first_cache_attempt_ms: navigationStartedAt === undefined ? null : Math.max(0, Date.now() - navigationStartedAt),
		navigation_to_cache_success_ms: null,
	});
	const emitBrowserTimeout = async (cause: ShopifyBrowserOperationTimeout): Promise<void> => {
		await emit({
			type: "SKIP_RESULT", stream: ORDERS_STREAM,
			reason: "shopify_browser_operation_timeout",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: "Shop order-history browser read exceeded its time budget; retry to collect it.",
			diagnostics: { ...diagnostics(), timed_out_operation: cause.operation },
		});
	};
	if (args.orderHistoryReady === false) {
		refreshDiagnostics();
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_history_readiness_timeout",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: `Shop order-history or sign-in UI did not become ready within ${String(ORDER_HISTORY_READY_TIMEOUT_MS)}ms.`,
			diagnostics: diagnostics(),
		});
		return;
	}
	refreshDiagnostics();
	let initialPageIdentity: Readonly<OrderHistoryPageIdentity> | null = null;
	if (args.readPageEvidence) {
		try {
			const page = await withBrowserOperationBudget(
				"page_evidence_read", args.readPageEvidence, runDeadlineAt, operationTimeoutMs,
			);
			initialPageIdentity = { url: page.url, navigation: page.navigation };
			if (page.blocked || !page.orderContext || !isShopOrderHistoryPageUrl(page.url) || page.navigation.length === 0) {
				await emit({
					type: "SKIP_RESULT", stream: ORDERS_STREAM,
					reason: page.blocked ? "shopify_signed_out_or_blocked" : "shopify_order_history_unconfirmed",
					recovery_hint: { action: "retry_by_runtime", retryable: true },
					message: "Shop did not show an authenticated order-history page.",
					diagnostics: { ...diagnostics(), page_owner: page.url, page_navigation: page.navigation },
				});
				return;
			}
		} catch (cause) {
			if (isBrowserOperationTimeout(cause)) {
				await emitBrowserTimeout(cause);
				return;
			}
		}
	}

	const cacheTiming = {
		firstAttemptMs: navigationStartedAt === undefined ? null : Math.max(0, Date.now() - navigationStartedAt),
		successMs: null as number | null,
	};
	let evidence: OrderHistoryEvidence;
	let walked: CacheWalkResult;
	try {
		evidence = await waitForOrderHistoryEvidence({
			readCache: async () => {
				const cache = await withBrowserOperationBudget("apollo_cache_read", readCache, runDeadlineAt, operationTimeoutMs);
				if (cache && cacheTiming.successMs === null && navigationStartedAt !== undefined) {
					cacheTiming.successMs = Math.max(0, Date.now() - navigationStartedAt);
				}
				return cache;
			},
			readDomOrders: readDomOrders ? async () => withBrowserOperationBudget("dom_order_read", readDomOrders, runDeadlineAt, operationTimeoutMs) : undefined,
			readVerifiedEmptyState: args.readVerifiedEmptyState ? async () => withBrowserOperationBudget("verified_empty_read", args.readVerifiedEmptyState as () => Promise<boolean>, runDeadlineAt, operationTimeoutMs) : undefined,
			timeoutMs: Math.min(args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS, Math.max(0, runDeadlineAt - Date.now())),
			pollIntervalMs: args.cachePollIntervalMs ?? APOLLO_POLL_INTERVAL_MS,
			now: args.evidenceNow ?? Date.now,
			wait: args.evidenceWait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
			runDeadlineAt,
			operationTimeoutMs,
		});
		walked = evidence.kind === "deadline_expired"
			? {
				cache: evidence.cache, orders: evidence.orders, truncated: false, complete: false,
				reason: "end_unproven", pageEvidence: null, domDiscardedRows: 0,
				coverage: { discoveredRows: 0, discardedRows: 0, withheldRows: [] },
				countMismatch: false,
			}
			: await walkOrdersCache({
		initialCache: evidence.cache,
		initialPageIdentity,
		initialOrders: evidence.orders,
		browserOperationTimeoutMs: operationTimeoutMs,
		runDeadlineAt,
		readCache: async () => {
			const refreshed = await withBrowserOperationBudget("apollo_cache_read", readCache, runDeadlineAt, operationTimeoutMs);
			if (refreshed && cacheTiming.successMs === null && navigationStartedAt !== undefined) {
				cacheTiming.successMs = Math.max(0, Date.now() - navigationStartedAt);
			}
			return refreshed;
		},
		...(readDomOrders ? { readDomOrders: async () => withBrowserOperationBudget("dom_order_read", readDomOrders, runDeadlineAt, operationTimeoutMs) } : {}),
		...(args.readPageEvidence ? { readPageEvidence: async () => withBrowserOperationBudget("page_evidence_read", args.readPageEvidence as () => Promise<ShopOrderPageEvidence>, runDeadlineAt, operationTimeoutMs) } : {}),
		...(args.readVerifiedEmptyState ? { readVerifiedEmptyState: async () => withBrowserOperationBudget("verified_empty_read", args.readVerifiedEmptyState as () => Promise<boolean>, runDeadlineAt, operationTimeoutMs) } : {}),
		scroll,
		...(args.wait ? { wait: args.wait } : {}),
		});
	} catch (cause) {
		if (!isBrowserOperationTimeout(cause)) throw cause;
		await emitBrowserTimeout(cause);
		return;
	}
	let { cache, truncated } = walked;
	const orders = walked.orders;
	const cacheCoverage = walked.coverage;
	if (evidence.kind === "deadline_expired") {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: cache ? "shopify_order_history_evidence_timeout" : "shopify_apollo_state_unavailable",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: cache
				? `Shop order history did not expose loaded orders or a stable verified empty marker within ${String(args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS)}ms.`
				: `Shop order history did not expose an Apollo cache, DOM orders, or verified empty evidence within ${String(args.cacheWaitTimeoutMs ?? APOLLO_READINESS_TIMEOUT_MS)}ms.`,
			diagnostics: diagnostics(),
		});
		return;
	}

	const cursor = openFingerprintCursor(state[ORDERS_STREAM]);
	const validRecords: RecordData[] = [];
	let invalidShapeCount = 0;
	const schemaIssues: Array<{ path: string; message: string }> = [];
	for (const order of orders) {
		const record = orderRecord(order);
		const validation = validateRecord(ORDERS_STREAM, record);
		if (!validation.ok) {
			invalidShapeCount += 1;
			schemaIssues.push(...validation.issues);
			continue;
		}
		validRecords.push(record);
	}
	const discardedRows = cacheCoverage.discardedRows + invalidShapeCount;
	const pageComplete = walked.complete;
	const pageBlocked = walked.reason === "page_blocked";
	const mismatch = walked.countMismatch || Boolean(cache && hasOrderCountMismatch(cache));
	const allWithheldRows = [
		...cacheCoverage.withheldRows,
		...schemaIssues.flatMap((issue) => schemaWithheldRows([issue])),
		...(mismatch ? [{ fields: [{ field: "total_count", reason: "invalid_or_unreconciled" }] }] : []),
	];
	const complete = pageComplete && !truncated && !pageBlocked && !mismatch && discardedRows === 0;
	// A sign-in or block page during the walk is the session's failure, not a
	// list that failed to prove its end: end the run as `ensureShopifySession`
	// does.
	if (pageBlocked && walked.pageEvidence?.blocked === true) {
		throw new Error("shopify_signed_out_or_blocked");
	}
	const skipDiagnostics = () => ({
		...diagnostics(),
		discovered_rows: cacheCoverage.discoveredRows + invalidShapeCount,
		valid_rows: pageBlocked ? 0 : validRecords.length,
		discarded_rows: discardedRows,
		withheld_fields: aggregateWithheldFields(allWithheldRows),
		terminal_evidence: pageComplete,
		page_owner: walked.pageEvidence?.url ?? null,
		page_navigation: walked.pageEvidence?.navigation ?? null,
		end_reason: walked.reason,
	});
	if (!complete && discardedRows > 0) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: "shopify_order_rows_unresolved",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: "Shop order history contained rows that could not be read completely; retry to collect them.",
			diagnostics: skipDiagnostics(),
		});
	} else if (!complete && pageBlocked) {
		// The page changed or lost its order-history context mid-walk: the read
		// failed, so nothing about the list's end was observed.
		const message = "Shop order history changed during the read; retry to collect the remaining rows.";
		const failure = {
			recoveryHint: { action: "retry_by_runtime", retryable: true },
			diagnostics: skipDiagnostics(),
		};
		if (args.reportStreamFailure) await args.reportStreamFailure(ORDERS_STREAM, message, failure);
		else await emit({
			type: "SKIP_RESULT", stream: ORDERS_STREAM, reason: "stream_collection_failed", message,
			recovery_hint: failure.recoveryHint, diagnostics: failure.diagnostics,
		});
	} else if (!complete && (!pageComplete || mismatch)) {
		await emit({
			type: "SKIP_RESULT",
			stream: ORDERS_STREAM,
			reason: truncated && walked.reason === "page_budget"
				? "older_pages_deferred_page_budget"
				: "inventory_not_proven_complete",
			recovery_hint: { action: "retry_by_runtime", retryable: true },
			message: "Shop order history could not be proven complete; retry to collect the remaining rows.",
			diagnostics: skipDiagnostics(),
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
	const hasSignInCTA = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]")).some((element) => {
		const ariaLabel = typeof element.getAttribute === "function" ? element.getAttribute("aria-label") : null;
		const label = (ariaLabel ?? element.textContent ?? "").trim().replace(/\s+/g, " ");
		if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
		return /^(?:(?:sign|log)[\s-]?in(?:\s+to\s+[^&]+)?|continue to (?:sign|log) in)$/i.test(label);
	});
	if (
		document.querySelector(
			'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
		)
	) {
		return false;
	}
	if (hasSignInCTA) return false;
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

export function hasShopSignInWallInPage(): boolean {
	const hasSignInCTA = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=button]")).some((element) => {
		const label = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().replace(/\s+/g, " ");
		if (typeof element.getClientRects === "function" && element.getClientRects().length === 0) return false;
		return /^(?:(?:sign|log)[\s-]?in(?:\s+to\s+[^&]+)?|continue to (?:sign|log) in)$/i.test(label);
	});
	return hasSignInCTA || Boolean(document.querySelector(
		'input[type="email"], input[name="email"], input[type="password"], input[autocomplete="one-time-code"], input[name="code"]',
	));
}

async function hasShopOrderHistorySession(page: Page): Promise<boolean> {
	try {
		const currentUrl = new URL(page.url());
		if (
			!isShopOrigin(currentUrl.origin) ||
			currentUrl.pathname !== "/account/order-history"
		) {
			return false;
		}
		await withBrowserOperationBudget(
			"session_readiness_wait",
			() => page.waitForFunction(isShopOrderHistoryReadyInPage, undefined, { timeout: 10_000 }),
			Date.now() + 10_000,
			10_000,
		);
		if (typeof page.evaluate === "function") {
			const wall = await withBrowserOperationBudget(
				"auth_wall_probe", () => page.evaluate(hasShopSignInWallInPage),
				Date.now() + 1_000, 1_000,
			);
			return !wall && await withBrowserOperationBudget(
				"order_history_context_probe", () => page.evaluate(hasShopOrderHistoryContextInPage),
				Date.now() + 1_000, 1_000,
			);
		}
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
	// A sign-in wall is the reason to request manual login, not to abort it.

	if (manualLogin) {
		await manualLogin();
	} else {
		await manualBrowserLogin({
			...(assist ? { assist } : {}),
			...(capture ? { capture } : {}),
			...(completeAssistance ? { completeAssistance } : {}),
			isProbeSuccessful: (ready) => ready,
			message:
				"Sign in to Shop in the secure browser. The import continues when your order history is available.",
			page,
			probe: () => hasShopOrderHistorySession(page),
			readinessProbe: (readinessPage) =>
				hasShopOrderHistorySession(readinessPage),
			readinessProbeOnHandoffPage: true,
			sendInteraction,
			timeoutSeconds: 45,
		});
	}

	await openOrderHistory(page);
	if (!(await hasShopOrderHistorySession(page))) {
		throw new Error("shopify_signed_out_or_blocked");
	}
}

export async function collect(
	ctx: BrowserCollectContext,
	options: { wait?: (ms: number) => Promise<void> } = {},
): Promise<void> {
	const { page, emit, emitRecord, progress, requested, state } = ctx;
	const runDeadlineAt = Date.now() + DEFAULT_RUN_BUDGET_MS;
	const navigationStartedAt = Date.now();
	await withBrowserOperationBudget(
		"order_history_navigation",
		() => page.goto(ORDER_HISTORY_URL, {
			waitUntil: "domcontentloaded",
			timeout: Math.min(30_000, Math.max(1, runDeadlineAt - Date.now())),
		}),
		runDeadlineAt,
		30_000,
	).catch(() => null);
	const orderHistoryReady = await withBrowserOperationBudget(
		"order_history_readiness_wait",
		() => page.waitForFunction(isShopOrderHistoryReadyInPage, undefined, {
			timeout: Math.min(ORDER_HISTORY_READY_TIMEOUT_MS, Math.max(1, runDeadlineAt - Date.now())),
		}),
		runDeadlineAt,
		ORDER_HISTORY_READY_TIMEOUT_MS,
	).then(() => true).catch(() => false);
	// Diagnostics refresh in the background. A stalled page evaluation cannot
	// block the typed readiness/operation failure emitted by collectShopify.
	let latestDiagnostics = EMPTY_SHOP_DIAGNOSTICS;
	const orderHistoryApi = createOrderHistoryApiReader({
		readPageIdentity: async () => {
			const evidence = await evaluateShopReaderInMainWorld(page, readShopOrderPageEvidenceInPage);
			return evidence.blocked || !evidence.orderContext || !isShopOrderHistoryPageUrl(evidence.url) ? null : evidence;
		},
		fetchPage: (request) => page.evaluate(fetchOrderHistoryPageInPage, request),
	});

	await collectShopify({
		emit,
		emitRecord,
		progress,
		requested,
		reportStreamFailure: ctx.reportStreamFailure,
		state,
		navigationStartedAt,
		runDeadlineAt,
		orderHistoryReady,
		// shop.com serves orders from its own JSON endpoint, with no reachable
		// Apollo cache; shop.app still has one, so it remains the fallback.
		readCache: async () =>
			(await orderHistoryApi.read()) ?? evaluateShopReaderInMainWorld(page, readLiveApolloCacheInPage),
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
		readVerifiedEmptyState: async () =>
			(await orderHistoryApi.provesEmptyHistory()) ||
			evaluateShopReaderInMainWorld(page, hasVerifiedEmptyOrderHistoryInPage),
		scroll: async () => {
			await page.evaluate(scrollToBottomInPage);
		},
		wait: options.wait ?? politeDelay,
	});
}

if (isMainModule(import.meta.url)) {
	runConnector({
		name: "shopify",
		browser: {},
		validateRecord,
		async ensureSession(args: EnsureSessionArgs): Promise<void> {
			await withBrowserOperationBudget(
				"session_establishment",
				() => ensureShopifySession(args),
				Date.now() + SESSION_ESTABLISHMENT_BUDGET_MS,
				SESSION_ESTABLISHMENT_BUDGET_MS,
			);
		},
		collect,
	});
}

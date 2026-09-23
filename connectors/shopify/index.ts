#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Shopify (Shop app) Connector (v0.2.0)
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
 * Session: cookie-probed (shop.app sets a session/consumer-access-token
 * cookie on login). No credentialed auto-login — Shop app authenticates by
 * email + emailed verification code, not a password an env var can hold, so
 * `ensureSession` is intentionally absent; a dead session surfaces to the
 * owner as `manual_action` per the manifest's `human_interaction` capability.
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
 *   v0.2.0 (2026-09-22) — real Apollo-cache extraction wired (parsers.ts);
 *     fingerprint-cursor incremental gate; added order_number,
 *     detail_url, line_item_titles per capability-map field contract.
 *   v0.1.0 — scaffold: reachability probe + unconditional SKIP_RESULT.
 */

import { isMainModule } from "@pdpp/connector-protocol";
import {
	type BrowserCollectContext,
	type ProbeSessionArgs,
	politeDelay,
	type RecordData,
	runConnector,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { openFingerprintCursor } from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import { walkPagesWithCeiling } from "../../packages/polyfill-connectors/src/page-ceiling.ts";
import { extractOrders, hasNextOrdersPage } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache, ParsedOrder } from "./types.ts";

const SESSION_COOKIE = /session|_shop_session|consumer_access_token/;
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

function isFiberHost(value: unknown): value is Record<string, FiberNode> {
	return typeof value === "object" && value !== null;
}

function readApolloCacheInPage(): ApolloCache | null {
	function getLiveApolloState(): Record<string, unknown> | null {
		try {
			const root: unknown = document.querySelector("#root") ?? document.body;
			if (!isFiberHost(root)) {
				return null;
			}
			const fiberKey = Object.keys(root).find(
				(k) =>
					k.startsWith("__reactFiber") ||
					k.startsWith("__reactInternalInstance"),
			);
			if (!fiberKey) {
				return null;
			}
			let fiber: FiberNode | null | undefined = root[fiberKey];
			let steps = 0;
			while (fiber && steps < 300) {
				steps += 1;
				const props = fiber.memoizedProps ?? fiber.pendingProps;
				const extracted = props?.client?.cache?.extract?.();
				if (extracted) {
					return extracted;
				}
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
	requested: BrowserCollectContext["requested"];
	scroll: () => Promise<void>;
	state: BrowserCollectContext["state"];
}

/** The connector's whole `orders` stream logic, independent of Playwright —
 *  `readCache`/`scroll` are injected so integration tests can drive this with
 *  a fake page. `collect()` below binds them to a real `page`. */
export async function collectShopify(args: CollectShopifyArgs): Promise<void> {
	const { emit, emitRecord, progress, readCache, requested, scroll, state } =
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

async function probeSession({ context }: ProbeSessionArgs): Promise<boolean> {
	const cookies = await context.cookies("https://shop.app/");
	return cookies.some((c) => SESSION_COOKIE.test(c.name) && Boolean(c.value));
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
		probeSession,
		collect,
	});
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol-level tests for the Shopify (Shop app) connector's `collectShopify`
 * — the connector's business logic with `readCache`/`scroll` injected so
 * these run with no real browser, per docs/reference/connector-authoring-guide.md
 * (browser-driven connectors in this repo test their collect logic this way;
 * see connectors/heb/index.test.ts for the established pattern). Proves:
 *   - START -> RECORD -> STATE ordering and scope filtering (a stream absent
 *     from `scope.streams` emits nothing);
 *   - the fingerprint-cursor incremental gate: a second run with unchanged
 *     orders emits no duplicate RECORDs, and a changed order re-emits;
 *   - the `shopify_apollo_state_unavailable` SKIP_RESULT path when the cache
 *     is never readable;
 *   - the page-ceiling truncation disclosure.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectShopify,
	ensureShopifySession,
	hasVerifiedEmptyOrderHistoryInPage,
	waitForApolloCache,
	readApolloCacheInPage,
	hasShopOrderHistoryContextInPage,
	isShopOrderHistoryReadyInPage,
	shopSkipDiagnosticsInPage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache } from "./types.ts";

test("Shop sign-in returns from the provider redirect to order history and checks that page", async () => {
	const navigations: string[] = [];
	let liveSession = false;
	let currentUrl = "about:blank";
	const page = Object.assign({} as Page, {
		goto: async (url: string) => {
			navigations.push(url);
			currentUrl = url;
			return null;
		},
		url: () => currentUrl,
		waitForFunction: async () => {
			assert.equal(currentUrl, "https://shop.app/account/order-history");
			if (!liveSession) throw new Error("order history not visible");
			return {};
		},
	});

	await ensureShopifySession({
		capture: null,
		page,
		manualLogin: async () => {
			assert.deepEqual(navigations, ["https://shop.app/account/order-history"]);
			currentUrl = "https://shop.app/account/login?return_to=%2Faccount%2Forder-history";
			liveSession = true;
		},
		sendInteraction: async (): Promise<never> => {
			throw new Error("manualAction should be injected in this test");
		},
	});
	assert.equal(liveSession, true);
	assert.deepEqual(navigations, [
		"https://shop.app/account/order-history",
		"https://shop.app/account/order-history",
	]);
});

test("Shop sign-in does not hand off a blank page when navigation fails", async () => {
	let handoffStarted = false;
	const page = Object.assign({} as Page, {
		goto: (async () => {
			throw new Error("navigation failed");
		}) as Page["goto"],
	});

	await assert.rejects(
		() =>
			ensureShopifySession({
				capture: null,
				page,
				manualLogin: async () => {
					handoffStarted = true;
				},
				sendInteraction: async (): Promise<never> => {
					throw new Error("manualAction should be injected in this test");
				},
			}),
		/shopify_login_page_unreachable/,
	);
	assert.equal(handoffStarted, false);
});

test("Shop sign-in rejects a completed handoff without an authenticated order page", async () => {
	const page = Object.assign({} as Page, {
		goto: async () => null,
		url: () => "https://shop.app/account/order-history",
		waitForFunction: async () => {
			throw new Error("order history not visible");
		},
	});
	await assert.rejects(
		() =>
			ensureShopifySession({
				capture: null,
				page,
				manualLogin: async () => undefined,
				sendInteraction: async (): Promise<never> => {
					throw new Error("manualAction should be injected in this test");
				},
			}),
		/shopify_login_manual_incomplete/,
	);
});

test("Shop sign-in accepts a visible order page without requiring a cookie probe", async () => {
	const navigations: string[] = [];
	const page = Object.assign({} as Page, {
		goto: async (url: string) => {
			navigations.push(url);
			return null;
		},
		url: () => navigations.at(-1) ?? "about:blank",
		waitForFunction: async () => ({}),
	});
	await ensureShopifySession({
		capture: null,
		page,
		manualLogin: async () => {
			throw new Error("live session must not request manual login");
		},
		sendInteraction: async (): Promise<never> => {
			throw new Error("live session must not request manual action");
		},
	});
	assert.deepEqual(navigations, ["https://shop.app/account/order-history"]);
});

test("Shop sign-in self-resolves through an order-page readiness probe", async () => {
	let ownerReady = false;
	let responseContract: string | undefined;
	let completionStatus: string | undefined;
	let currentUrl = "about:blank";
	const navigations: string[] = [];
	const page = Object.assign({} as Page, {
		goto: async (url: string) => {
			navigations.push(url);
			currentUrl = url;
			return null;
		},
		url: () => currentUrl,
		waitForFunction: async () => {
			if (!ownerReady) throw new Error("sign-in needed");
			return {};
		},
		context: () => ({
			newPage: async () => {
				throw new Error("Shop readiness must stay in the sign-in tab");
			},
		}),
	});

	await ensureShopifySession({
		assist: async (request) => {
			responseContract = request.response_contract;
			assert.equal(currentUrl, "https://shop.app/account/order-history");
			assert.deepEqual(navigations, ["https://shop.app/account/order-history"]);
			ownerReady = true;
			return "shop-assistance";
		},
		capture: null,
		completeAssistance: async (id, status) => {
			assert.equal(id, "shop-assistance");
			completionStatus = status;
		},
		page,
		sendInteraction: async (): Promise<never> => {
			throw new Error("automatic readiness must not request a button click");
		},
	});
	assert.equal(responseContract, "none");
	assert.equal(completionStatus, "resolved");
	assert.deepEqual(navigations, [
		"https://shop.app/account/order-history",
		"https://shop.app/account/order-history",
	]);
});

test("Shop order-page signal rejects a login form even when the page has an orders heading", () => {
	const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
	let loginVisible = true;
	let ordersVisible = true;
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			querySelector: (selector: string) =>
				selector.startsWith("input") && loginVisible ? {} : null,
			querySelectorAll: () =>
				ordersVisible ? [{ textContent: "Your orders" }] : [],
		},
	});
	try {
		assert.equal(hasShopOrderHistoryContextInPage(), false);
		loginVisible = false;
		assert.equal(hasShopOrderHistoryContextInPage(), true);
		ordersVisible = false;
		assert.equal(hasShopOrderHistoryContextInPage(), false);
	} finally {
		if (priorDocument) {
			Object.defineProperty(globalThis, "document", priorDocument);
		} else {
			Reflect.deleteProperty(globalThis, "document");
		}
	}
});

function makeCacheWithoutOrdersConnection(): ApolloCache {
	return { ROOT_QUERY: { viewer: { __ref: "Customer:current" } } };
}

function makeCache(orderRefs: string[], hasNextPage: boolean): ApolloCache {
	const entries: Record<string, unknown> = {
		ROOT_QUERY: {
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: orderRefs.map((ref) => ({ __ref: ref })),
				pageInfo: { hasNextPage },
			},
		},
	};
	for (const ref of orderRefs) {
		const id = ref.slice("Order:".length);
		entries[ref] = {
			id: `gid://shopify/Order/${id}`,
			createdAt: "2024-05-01T18:22:05.000Z",
			displayStatus: "FULFILLED",
			shop: { __ref: "Shop:acme" },
			effectiveTotalPrice: { amount: "10.00", currencyCode: "USD" },
			totalItemCount: 1,
			lineItems: { nodes: [] },
		};
	}
	entries["Shop:acme"] = { name: "Acme Goods" };
	return entries;
}

function installApolloFixtureInPage(apolloState: ApolloCache): void {
	const root = document.querySelector("#root") as HTMLElement & Record<string, unknown>;
	root["__reactFiber$fixture"] = {
		memoizedProps: {
			client: {
				cache: {
					extract() {
						return apolloState;
					},
				},
			},
		},
	};
}

function recordsOf(
	events: Array<{ data: RecordData; stream: string }>,
	stream: string,
): RecordData[] {
	return events.filter((e) => e.stream === stream).map((e) => e.data);
}

function requestedMap(streams: string[]): Map<string, StreamScope> {
	return new Map(streams.map((name) => [name, { name }]));
}

test("collectShopify emits nothing when orders is not in scope.streams", async () => {
	const { emit, emitRecord, emitted, protocolMessages } =
		makeRecordingEmit(validateRecord);
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap([]),
		state: {},
		readCache: () => Promise.resolve(makeCache(["Order:1"], false)),
		scroll: () => Promise.resolve(),
	});
	assert.equal(emitted.length, 0);
	assert.equal(protocolMessages.length, 0);
});

test("collectShopify emits a RECORD per order then a STATE, in order", async () => {
	const { emit, emitRecord, events } = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(makeCache(["Order:1", "Order:2"], false)),
		scroll: () => Promise.resolve(),
	});

	const kinds = events.map((e) => e.kind);
	assert.deepEqual(
		kinds.filter((k) => k === "record" || k === "message"),
		["record", "record", "message"],
		"both RECORDs land before the STATE message",
	);
	const last = events.at(-1);
	assert.ok(last && last.kind === "message" && last.message.type === "STATE");
});

test("collectShopify emits RECORD data matching the field contract (order_number, line_item_titles, detail_url)", async () => {
	const { emit, emitRecord, emitted } = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(makeCache(["Order:1"], false)),
		scroll: () => Promise.resolve(),
	});
	const [order] = recordsOf(emitted, "orders");
	assert.ok(order);
	assert.equal(order.id, "gid://shopify/Order/1");
	assert.equal(order.order_number, "gid://shopify/Order/1");
	assert.deepEqual(order.line_item_titles, []);
	assert.equal(order.detail_url, "https://shop.app/account/order-history");
});

test("collectShopify's fingerprint cursor suppresses a duplicate RECORD on a second run with unchanged orders", async () => {
	const requested = requestedMap(["orders"]);
	const state: Record<string, unknown> = {};

	const run1 = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run1.emit,
		emitRecord: run1.emitRecord,
		progress: async () => undefined,
		requested,
		state,
		readCache: () => Promise.resolve(makeCache(["Order:1"], false)),
		scroll: () => Promise.resolve(),
	});
	assert.equal(recordsOf(run1.emitted, "orders").length, 1);

	const stateMsg = run1.protocolMessages.findLast(
		(m): m is Extract<EmittedMessage, { type: "STATE" }> =>
			m.type === "STATE" && m.stream === "orders",
	);
	assert.ok(stateMsg);
	const nextState = { orders: stateMsg.cursor };

	const run2 = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run2.emit,
		emitRecord: run2.emitRecord,
		progress: async () => undefined,
		requested,
		state: nextState,
		readCache: () => Promise.resolve(makeCache(["Order:1"], false)),
		scroll: () => Promise.resolve(),
	});
	assert.equal(
		recordsOf(run2.emitted, "orders").length,
		0,
		"an unchanged order does not re-emit on the next run",
	);
});

test("collectShopify re-emits a changed order (fingerprint mismatch) on the next run", async () => {
	const requested = requestedMap(["orders"]);

	const run1 = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run1.emit,
		emitRecord: run1.emitRecord,
		progress: async () => undefined,
		requested,
		state: {},
		readCache: () => Promise.resolve(makeCache(["Order:1"], false)),
		scroll: () => Promise.resolve(),
	});
	const stateMsg = run1.protocolMessages.findLast(
		(m): m is Extract<EmittedMessage, { type: "STATE" }> =>
			m.type === "STATE" && m.stream === "orders",
	);
	assert.ok(stateMsg);

	const changedCache = makeCache(["Order:1"], false);
	const order1 = changedCache["Order:1"] as Record<string, unknown>;
	order1.displayStatus = "DELIVERED";

	const run2 = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run2.emit,
		emitRecord: run2.emitRecord,
		progress: async () => undefined,
		requested,
		state: { orders: stateMsg.cursor },
		readCache: () => Promise.resolve(changedCache),
		scroll: () => Promise.resolve(),
	});
	const [order] = recordsOf(run2.emitted, "orders");
	assert.equal(order?.status, "DELIVERED");
});

test("verified empty Shop page requires route, live cache, no order refs, and visible exact marker", () => {
	const prior = {
		document: Object.getOwnPropertyDescriptor(globalThis, "document"),
		location: Object.getOwnPropertyDescriptor(globalThis, "location"),
		getComputedStyle: Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle"),
	};
	const empty = { textContent: "No orders yet", children: [], getBoundingClientRect: () => ({ width: 10, height: 10 }) };
	const root = { "__reactFiber$fixture": { memoizedProps: { client: { cache: { extract: () => makeCacheWithoutOrdersConnection() } } } } };
	Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://shop.app", pathname: "/account/order-history" } });
	Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ display: "block", visibility: "visible" }) });
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		querySelector: (selector: string) => selector === "#root" ? root : null,
		querySelectorAll: (selector: string) => selector === "body *" ? [empty] : selector === "h1, h2, h3" ? [{ textContent: "Your orders" }] : [],
	} });
	try {
		assert.equal(hasVerifiedEmptyOrderHistoryInPage(), true);
		Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://shop.app", pathname: "/account/login" } });
		assert.equal(hasVerifiedEmptyOrderHistoryInPage(), false);
	} finally {
		for (const [key, descriptor] of Object.entries(prior)) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test("Shop page.evaluate readers work with a serialized Playwright function", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://shop.app/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: '<div id="root"><h1>Orders</h1><span>No orders yet</span></div>',
			}),
		);
		await page.goto("https://shop.app/account/order-history");
		assert.doesNotMatch(String(installApolloFixtureInPage), /__name/);
		assert.doesNotMatch(String(readApolloCacheInPage), /__name/);
		assert.doesNotMatch(String(hasVerifiedEmptyOrderHistoryInPage), /__name/);
		assert.doesNotMatch(String(isShopOrderHistoryReadyInPage), /__name/);
		await page.evaluate(installApolloFixtureInPage, { ROOT_QUERY: { viewer: {} } });
		assert.deepEqual(await page.evaluate(readApolloCacheInPage), {
			ROOT_QUERY: { viewer: {} },
		});
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), true);
		assert.equal(await page.evaluate(isShopOrderHistoryReadyInPage), true);
		const pageDiagnostics = await page.evaluate(shopSkipDiagnosticsInPage);
		assert.equal(pageDiagnostics.final_url_path, "/account/order-history");
		assert.equal(pageDiagnostics.order_context_present, true);
		assert.equal(pageDiagnostics.fiber_cache_present, true);
		assert.equal(pageDiagnostics.ssr_cache_present, false);
		await page.evaluate(installApolloFixtureInPage, {
			ROOT_QUERY: { 'deliveriesOrdersList:{}': { nodes: [] } },
		});
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), true);
		await page.evaluate(installApolloFixtureInPage, {
			ROOT_QUERY: {
				'deliveriesOrdersList:{}': { nodes: [{ __ref: "Order:1" }] },
			},
		});
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), false);
		await page.setContent('<div class="order-card"><a href="https://shop.app/orders/fixture">Acme Goods</a><div>2 items · $19.99</div></div>');
		assert.equal((await page.evaluate(shopSkipDiagnosticsInPage)).dom_card_count, 1);
		await page.setContent('<div class="order-card"><a href="https://shop.app/orders/fixture">Acme Goods</a><div>19.99 EUR</div></div>');
		assert.equal((await page.evaluate(shopSkipDiagnosticsInPage)).dom_card_count, 1);
	} finally {
		await browser.close();
	}
});

test("verified empty Shop page accepts SSR cache without a React fiber", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://shop.app/**", (route) => route.fulfill({
			status: 200,
			contentType: "text/html",
			body: '<div id="root"><h1>Orders</h1><span>No orders yet</span></div>',
		}));
		await page.goto("https://shop.app/account/order-history");
		await page.evaluate(() => {
			Object.assign(window, { __APOLLO_STATE__: { ROOT_QUERY: { viewer: {} } } });
		});
		assert.deepEqual(await page.evaluate(readApolloCacheInPage), { ROOT_QUERY: { viewer: {} } });
		assert.equal((await page.evaluate(shopSkipDiagnosticsInPage)).fiber_cache_present, false);
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), true);
		const run = makeRecordingEmit(validateRecord);
		await collectShopify({
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: () => page.evaluate(readApolloCacheInPage),
			readVerifiedEmptyState: () => page.evaluate(hasVerifiedEmptyOrderHistoryInPage),
			cacheWaitTimeoutMs: 1000, cachePollIntervalMs: 25,
			scroll: async () => undefined,
		});
		assert.equal(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"), false);
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), true);
	} finally {
		await browser.close();
	}
});

test("Shop cache reader sees SSR orders while the fiber cache is still an empty shell", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://shop.app/**", (route) => route.fulfill({
			status: 200,
			contentType: "text/html",
			body: '<div id="root"><h1>Orders</h1><span>No orders yet</span></div>',
		}));
		await page.goto("https://shop.app/account/order-history");
		const ssrOrders = makeCache(["Order:1"], false);
		await page.evaluate(installApolloFixtureInPage, makeCacheWithoutOrdersConnection());
		await page.evaluate((state) => { Object.assign(window, { __APOLLO_STATE__: state }); }, ssrOrders);
		assert.deepEqual(await page.evaluate(readApolloCacheInPage), ssrOrders);
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), false);
		const liveEmpty = makeCache([], false);
		await page.evaluate(installApolloFixtureInPage, liveEmpty);
		assert.deepEqual(await page.evaluate(readApolloCacheInPage), liveEmpty);
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), true);
	} finally {
		await browser.close();
	}
});

test("collectShopify waits for a delayed empty marker after the first cache", async () => {
	const run = makeRecordingEmit(validateRecord);
	let cacheReads = 0;
	let markerReads = 0;
	let clock = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => { cacheReads += 1; return makeCacheWithoutOrdersConnection(); },
		readVerifiedEmptyState: async () => ++markerReads >= 3,
		scroll: async () => undefined,
		cacheWaitTimeoutMs: 500, cachePollIntervalMs: 50,
		evidenceNow: () => clock,
		evidenceWait: async (ms) => { clock += ms; },
	});
	assert.ok(cacheReads >= 4);
	assert.ok(markerReads >= 4);
	assert.equal(run.protocolMessages.some((m) => m.type === "SKIP_RESULT"), false);
	assert.equal(run.protocolMessages.some((m) => m.type === "STATE"), true);
});

test("collectShopify waits for a delayed Apollo order connection", async () => {
	const run = makeRecordingEmit(validateRecord);
	let cacheReads = 0;
	let clock = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => ++cacheReads < 3 ? makeCacheWithoutOrdersConnection() : makeCache(["Order:1"], false),
		readVerifiedEmptyState: async () => false,
		scroll: async () => undefined,
		cacheWaitTimeoutMs: 500, cachePollIntervalMs: 50,
		evidenceNow: () => clock,
		evidenceWait: async (ms) => { clock += ms; },
	});
	assert.ok(cacheReads >= 3);
	assert.equal(recordsOf(run.emitted, "orders").length, 1);
	assert.equal(run.protocolMessages.some((m) => m.type === "STATE"), true);
});

test("collectShopify rejects a transient empty marker", async () => {
	const run = makeRecordingEmit(validateRecord);
	let markerReads = 0;
	let clock = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => makeCacheWithoutOrdersConnection(),
		readVerifiedEmptyState: async () => ++markerReads === 1,
		scroll: async () => undefined,
		cacheWaitTimeoutMs: 100, cachePollIntervalMs: 50,
		evidenceNow: () => clock,
		evidenceWait: async (ms) => { clock += ms; },
	});
	assert.ok(markerReads >= 2);
	assert.equal(run.protocolMessages.some((m) => m.type === "STATE"), false);
	const skip = run.protocolMessages.find((m) => m.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_history_evidence_timeout");
});

test("collectShopify explains order-history evidence deadline expiry", async () => {
	const run = makeRecordingEmit(validateRecord);
	let clock = 0;
	let cacheReads = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => { cacheReads += 1; return makeCacheWithoutOrdersConnection(); },
		readVerifiedEmptyState: async () => false,
		scroll: async () => undefined,
		cacheWaitTimeoutMs: 120, cachePollIntervalMs: 50,
		evidenceNow: () => clock,
		evidenceWait: async (ms) => { clock += ms; },
	});
	assert.equal(clock, 120);
	assert.ok(cacheReads >= 3);
	const skip = run.protocolMessages.find((m) => m.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_history_evidence_timeout");
	assert.match(skip.message, /120ms/);
	assert.match(skip.message, /orders|empty/i);
	assert.equal(run.protocolMessages.some((m) => m.type === "STATE"), false);
});

test("collectShopify expires when a page reader never returns", async () => {
	const run = makeRecordingEmit(validateRecord);
	const startedAt = Date.now();
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => makeCacheWithoutOrdersConnection(),
		readDomOrders: () => new Promise(() => undefined),
		readVerifiedEmptyState: async () => false,
		cacheWaitTimeoutMs: 20, cachePollIntervalMs: 10,
		scroll: async () => undefined,
	});
	assert.ok(Date.now() - startedAt < 500);
	const skip = run.protocolMessages.find((m) => m.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_history_evidence_timeout");
});

test("collectShopify emits scope_unavailable SKIP_RESULT when the Apollo cache never resolves", async () => {
	const { emit, emitRecord, protocolMessages } =
		makeRecordingEmit(validateRecord);
	const navigationStartedAt = Date.now();
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		navigationStartedAt,
		readCache: () => Promise.resolve(null),
		cacheWaitTimeoutMs: 0,
		readSkipDiagnostics: () => Promise.resolve({
			final_url_path: "/account/order-history",
			sign_in_page_detected: false,
			order_context_present: true,
			fiber_cache_present: false,
			ssr_cache_present: false,
			navigation_to_first_cache_attempt_ms: 0,
			navigation_to_cache_success_ms: null,
			dom_card_count: 0,
		}),
		scroll: () => Promise.resolve(),
	});
	const skip = protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	assert.ok(skip);
	assert.equal(skip.reason, "shopify_apollo_state_unavailable");
	assert.deepEqual(skip.diagnostics, {
		final_url_path: "/account/order-history",
		sign_in_page_detected: false,
		order_context_present: true,
		fiber_cache_present: false,
		ssr_cache_present: false,
		navigation_to_first_cache_attempt_ms: 0,
		navigation_to_cache_success_ms: null,
		dom_card_count: 0,
	});
	assert.doesNotMatch(JSON.stringify(skip.diagnostics), /@|gid|email|123/);
});

test("collectShopify does not poll Apollo when order-history readiness times out", async () => {
	const { emit, emitRecord, protocolMessages } = makeRecordingEmit(validateRecord);
	let cacheReads = 0;
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		orderHistoryReady: false,
		readCache: async () => { cacheReads += 1; return null; },
		readSkipDiagnostics: () => Promise.resolve({
			final_url_path: "/account/order-history",
			sign_in_page_detected: false,
			order_context_present: false,
			fiber_cache_present: false,
			ssr_cache_present: false,
			navigation_to_first_cache_attempt_ms: null,
			navigation_to_cache_success_ms: null,
			dom_card_count: 0,
		}),
		scroll: async () => undefined,
	});
	const skip = protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	assert.ok(skip);
	assert.equal(skip.reason, "shopify_order_history_readiness_timeout");
	assert.equal(cacheReads, 0);
	assert.deepEqual(skip.diagnostics, {
		final_url_path: "/account/order-history",
		sign_in_page_detected: false,
		order_context_present: false,
		fiber_cache_present: false,
		ssr_cache_present: false,
		navigation_to_first_cache_attempt_ms: null,
		navigation_to_cache_success_ms: null,
		dom_card_count: 0,
	});
});

test("collectShopify falls back to parsed DOM orders when Apollo is missing", async () => {
	const { emit, emitRecord, emitted, protocolMessages } =
		makeRecordingEmit(validateRecord);
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(null),
		cacheWaitTimeoutMs: 0,
		readDomOrders: () => Promise.resolve([{
			currency: "USD", detailUrl: "https://shop.app/orders/order-123",
			id: "https://shop.app/orders/order-123", itemCount: 2,
			lineItemTitles: [], merchantName: "Acme Goods", orderNumber: null,
			placedAt: null, status: "Delivered", totalCents: 1999,
		}]),
		scroll: () => Promise.resolve(),
	});
	assert.equal(recordsOf(emitted, "orders").length, 1);
	assert.equal(protocolMessages.some((message) => message.type === "SKIP_RESULT"), false);
});

test("collectShopify uses DOM orders when Apollo is readable but contains no order refs", async () => {
	const run = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run.emit,
		emitRecord: run.emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(makeCache([], false)),
		cacheWaitTimeoutMs: 0,
		readDomOrders: () => Promise.resolve([{
			currency: "USD", detailUrl: "https://shop.app/orders/order-123",
			id: "https://shop.app/orders/order-123", itemCount: 1,
			lineItemTitles: [], merchantName: "Acme Goods", orderNumber: null,
			placedAt: null, status: null, totalCents: 1999,
		}]),
		scroll: () => Promise.resolve(),
	});
	assert.equal(recordsOf(run.emitted, "orders").length, 1);
	assert.equal(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"), false);
});

test("waitForApolloCache retries until cache readiness, bounded by its deadline", async () => {
	let attempts = 0;
	let now = 0;
	const waits: number[] = [];
	const cache = makeCache(["Order:1"], false);
	const result = await waitForApolloCache({
		readCache: async () => ++attempts < 3 ? null : cache,
		timeoutMs: 500,
		pollIntervalMs: 100,
		now: () => now,
		wait: async (ms) => { waits.push(ms); now += ms; },
	});
	assert.equal(result.cache, cache);
	assert.equal(attempts, 3);
	assert.deepEqual(waits, [100, 100]);

	const expired = await waitForApolloCache({
		readCache: async () => null,
		timeoutMs: 250,
		pollIntervalMs: 100,
		now: () => now,
		wait: async (ms) => { now += ms; },
	});
	assert.equal(expired.cache, null);
	assert.equal(expired.timedOut, true);
	const startedAt = Date.now();
	const hung = await waitForApolloCache({
		readCache: () => new Promise(() => undefined),
		timeoutMs: 20,
		pollIntervalMs: 10,
	});
	assert.equal(hung.timedOut, true);
	assert.ok(Date.now() - startedAt < 500);
});

test("collectShopify emits a clean empty STATE only with verified empty-history page evidence", async () => {
	const { emit, emitRecord, emitted, events, protocolMessages } =
		makeRecordingEmit(validateRecord);
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(makeCache([], false)),
		readVerifiedEmptyState: () => Promise.resolve(true),
		scroll: () => Promise.resolve(),
	});
	const skip = protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	assert.equal(skip, undefined);
	assert.equal(recordsOf(emitted, "orders").length, 0);
	const last = events.at(-1);
	assert.ok(last && last.kind === "message" && last.message.type === "STATE");
});

test("collectShopify does not prune prior fingerprints from an unconfirmed empty connection", async () => {
	const priorState = {
		orders: {
			fingerprints: {
				"Order:1": "existing-fingerprint",
			},
		},
	};
	for (const readVerifiedEmptyState of [
		undefined,
		() => Promise.resolve(false),
		() => Promise.reject(new Error("page closed")),
	]) {
		const run = makeRecordingEmit(validateRecord);
		const args = {
			emit: run.emit,
			emitRecord: run.emitRecord,
			progress: async () => undefined,
			requested: requestedMap(["orders"]),
			state: priorState,
			readCache: () => Promise.resolve(makeCache([], false)),
			cacheWaitTimeoutMs: 0,
			scroll: () => Promise.resolve(),
		};
		await collectShopify(
			readVerifiedEmptyState ? { ...args, readVerifiedEmptyState } : args,
		);
		const skip = run.protocolMessages.find((m) => m.type === "SKIP_RESULT");
		assert.ok(skip && skip.type === "SKIP_RESULT");
		assert.equal(skip.reason, "shopify_order_history_evidence_timeout");
		assert.deepEqual(skip.diagnostics, {
			final_url_path: "",
			sign_in_page_detected: false,
			order_context_present: false,
			fiber_cache_present: false,
			ssr_cache_present: false,
			navigation_to_first_cache_attempt_ms: null,
			navigation_to_cache_success_ms: null,
			dom_card_count: 0,
		});
		assert.equal(run.protocolMessages.some((m) => m.type === "STATE"), false);
	}
});

test("collectShopify confirms an empty account with verified page evidence when cache has no orders connection", async () => {
	const confirmed = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: confirmed.emit, emitRecord: confirmed.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: () => Promise.resolve(makeCacheWithoutOrdersConnection()),
		readVerifiedEmptyState: () => Promise.resolve(true), scroll: () => Promise.resolve(),
	});
	assert.equal(confirmed.protocolMessages.some((m) => m.type === "SKIP_RESULT"), false);
	const confirmedLast = confirmed.events.at(-1);
	assert.equal(
		confirmedLast?.kind === "message" && confirmedLast.message.type === "STATE",
		true,
	);

	const unconfirmed = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: unconfirmed.emit, emitRecord: unconfirmed.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: () => Promise.resolve(makeCacheWithoutOrdersConnection()),
		readVerifiedEmptyState: () => Promise.resolve(false), scroll: () => Promise.resolve(),
		cacheWaitTimeoutMs: 0,
	});
	const skip = unconfirmed.protocolMessages.find((m) => m.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_history_evidence_timeout");
});

test("collectShopify fails closed when the empty-state reader is missing or throws", async () => {
	for (const readVerifiedEmptyState of [undefined, () => Promise.reject(new Error("page closed"))]) {
		const run = makeRecordingEmit(validateRecord);
		const args = {
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: () => Promise.resolve(makeCacheWithoutOrdersConnection()),
			cacheWaitTimeoutMs: 0,
			scroll: () => Promise.resolve(),
		};
		await collectShopify(
			readVerifiedEmptyState ? { ...args, readVerifiedEmptyState } : args,
		);
		const skip = run.protocolMessages.find((m) => m.type === "SKIP_RESULT");
		assert.ok(skip && skip.type === "SKIP_RESULT");
		assert.equal(skip.reason, "shopify_order_history_evidence_timeout");
		assert.equal(run.protocolMessages.some((m) => m.type === "STATE"), false);
	}
});

test("collectShopify discloses truncation when the scroll ceiling is hit with more pages advertised", async () => {
	const { emit, emitRecord, protocolMessages } =
		makeRecordingEmit(validateRecord);
	// Always reports hasNextPage: true so the walk never exits naturally and
	// must be stopped by the page ceiling.
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(makeCache(["Order:1"], true)),
		scroll: () => Promise.resolve(),
	});
	const skip = protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT" &&
			m.reason === "older_pages_deferred_page_budget",
	);
	assert.ok(
		skip,
		"a walk that never sees hasNextPage:false must disclose truncation",
	);
});

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
import { chromium as patchrightChromium } from "patchright";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectShopify,
	orderRecord,
	walkOrdersCache,
	evaluateShopReaderInMainWorld,
	ensureShopifySession,
	hasVerifiedEmptyOrderHistoryInPage,
	waitForApolloCache,
	readApolloCacheInPage,
	readLiveApolloCacheInPage,
	readShopOrderPageEvidenceInPage,
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
	return {
		ROOT_QUERY: { viewer: { __ref: "Customer:current" } },
		"Customer:current": { id: "gid://shopify/Customer/current" },
	};
}

function makeCacheWithVerifiedEmptyOrdersConnection(): ApolloCache {
	return {
		ROOT_QUERY: {
			viewer: { __ref: "Customer:current" },
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: [], pageInfo: { hasNextPage: false },
			},
		},
		"Customer:current": { id: "gid://shopify/Customer/current" },
	};
}

function makeCache(orderRefs: string[], hasNextPage: boolean): ApolloCache {
	const entries: Record<string, unknown> = {
		ROOT_QUERY: {
			viewer: { __ref: "Customer:current" },
			'deliveriesOrdersList:{"filter":{}}': {
				nodes: orderRefs.map((ref) => ({ __ref: ref })),
				pageInfo: { hasNextPage },
			},
		},
	};
	entries["Customer:current"] = { id: "gid://shopify/Customer/current" };
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
	const root = entries.ROOT_QUERY;
	if (typeof root === "object" && root !== null && !Array.isArray(root) && !("viewer" in root)) {
		(root as Record<string, unknown>).viewer = { __ref: "Customer:current" };
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
	let cache = makeCacheWithVerifiedEmptyOrdersConnection();
	const root = { "__reactFiber$fixture": { memoizedProps: { client: { cache: { extract: () => cache } } } } };
	Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://shop.app", pathname: "/account/order-history" } });
	Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ display: "block", visibility: "visible" }) });
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		querySelector: (selector: string) => selector === "#root" ? root : null,
		querySelectorAll: (selector: string) => selector === "body *" ? [empty] : selector === "h1, h2, h3" ? [{ textContent: "Your orders" }] : [],
	} });
	try {
		assert.equal(hasVerifiedEmptyOrderHistoryInPage(), true);
		cache = makeCacheWithoutOrdersConnection();
		assert.equal(hasVerifiedEmptyOrderHistoryInPage(), false, "a viewer and empty placeholder do not prove an orders request ran");
		cache = {
			ROOT_QUERY: {
				viewer: { __ref: "Customer:current" },
				'deliveriesOrdersList:{"filter":{"status":"OPEN"}}': {
					nodes: [], pageInfo: { hasNextPage: false },
				},
			},
			"Customer:current": { id: "gid://shopify/Customer/current" },
		};
		assert.equal(hasVerifiedEmptyOrderHistoryInPage(), false, "a filtered empty request does not prove full-history emptiness");
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
		assert.doesNotMatch(String(readLiveApolloCacheInPage), /__name/);
		assert.doesNotMatch(String(hasVerifiedEmptyOrderHistoryInPage), /__name/);
		assert.doesNotMatch(String(isShopOrderHistoryReadyInPage), /__name/);
		await page.evaluate(installApolloFixtureInPage, makeCacheWithVerifiedEmptyOrdersConnection());
		assert.deepEqual(await page.evaluate(readApolloCacheInPage), {
			...makeCacheWithVerifiedEmptyOrdersConnection(),
		});
		assert.deepEqual(await page.evaluate(readLiveApolloCacheInPage), makeCacheWithVerifiedEmptyOrdersConnection());
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), true);
		assert.equal(await page.evaluate(isShopOrderHistoryReadyInPage), true);
		const pageDiagnostics = await page.evaluate(shopSkipDiagnosticsInPage);
		assert.equal(pageDiagnostics.final_url_path, "/account/order-history");
		assert.equal(pageDiagnostics.order_context_present, true);
		assert.equal(pageDiagnostics.fiber_cache_present, true);
		assert.equal(pageDiagnostics.ssr_cache_present, false);
		await page.evaluate(installApolloFixtureInPage, makeCache([], false));
		assert.deepEqual(await page.evaluate(readLiveApolloCacheInPage), {
			...makeCache([], false),
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

test("Shop Apollo readers see main-world state under Patchright", async () => {
	const browser = await patchrightChromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		const apolloState = { ROOT_QUERY: { viewer: {} } };
		await page.route("https://shop.app/**", (route) =>
			route.fulfill({
				status: 200,
				contentType: "text/html",
				body: '<div id="root"><h1>Your orders</h1><span>No orders found</span></div>',
			}),
		);
		await page.addInitScript((state) => {
			Object.assign(window, { __APOLLO_STATE__: state });
		}, apolloState);
		await page.goto("https://shop.app/account/order-history");

		assert.deepEqual(
			await evaluateShopReaderInMainWorld(page as unknown as Page, readApolloCacheInPage),
			apolloState,
		);
		assert.equal(
			await evaluateShopReaderInMainWorld(page as unknown as Page, readLiveApolloCacheInPage),
			null,
			"static SSR state cannot authorize a complete scan",
		);
		assert.equal(
			(await evaluateShopReaderInMainWorld(page as unknown as Page, shopSkipDiagnosticsInPage))
				.ssr_cache_present,
			true,
		);
		assert.equal(
			await evaluateShopReaderInMainWorld(page as unknown as Page, hasVerifiedEmptyOrderHistoryInPage),
			false,
		);
	} finally {
		await browser.close();
	}
});

test("SSR-only empty evidence cannot authorize a complete Shop scan", async () => {
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
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), false);
		const run = makeRecordingEmit(validateRecord);
		await collectShopify({
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: () => page.evaluate(readApolloCacheInPage),
			readVerifiedEmptyState: () => page.evaluate(hasVerifiedEmptyOrderHistoryInPage),
			cacheWaitTimeoutMs: 1000, cachePollIntervalMs: 25,
			scroll: async () => undefined,
		});
		assert.equal(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"), true);
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
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
		await page.evaluate((state) => { Object.assign(window, { __APOLLO_STATE__: state }); }, liveEmpty);
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

test("collectShopify emits scope_unavailable SKIP_RESULT when the Apollo cache never resolves", async (t) => {
	const { emit, emitRecord, protocolMessages } =
		makeRecordingEmit(validateRecord);
	// Cache diagnostics use Date.now(); keep both timing samples on one clock.
	// Mock only Date so the evidence deadline's timers retain their normal behavior.
	t.mock.timers.enable({ apis: ["Date"], now: 1_000 });
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
		browserOperationTimeoutMs: 15,
		runBudgetMs: 100,
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
		final_url_path: "",
		sign_in_page_detected: false,
		order_context_present: false,
		fiber_cache_present: false,
		ssr_cache_present: false,
		navigation_to_first_cache_attempt_ms: null,
		navigation_to_cache_success_ms: null,
		dom_card_count: 0,
	});
});

test("collectShopify withholds DOM-only rows when mapped fields are unavailable", async () => {
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
		readPageEvidence: () => Promise.resolve({
			url: "https://shop.app/account/order-history", navigation: "synthetic-nav",
			orderContext: true, blocked: false, pageHeight: 100,
			domHasContinuation: false, domHasEndMarker: true, domCardCount: 1,
		}),
		scroll: () => Promise.resolve(),
	});
	assert.equal(recordsOf(emitted, "orders").length, 0);
	const skip = protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_rows_unresolved");
});

test("collectShopify withholds DOM orders with absent mapped fields when Apollo is empty", async () => {
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
	assert.equal(recordsOf(run.emitted, "orders").length, 0);
	const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT", JSON.stringify(run.protocolMessages));
	assert.equal(skip.reason, "shopify_order_rows_unresolved");
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
	const hungWait = await waitForApolloCache({
		readCache: async () => null,
		timeoutMs: 20,
		pollIntervalMs: 10,
		wait: () => new Promise(() => undefined),
	});
	assert.equal(hungWait.timedOut, true);
	assert.equal(hungWait.reason, "shopify_browser_operation_timeout");
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

test("collectShopify discloses a no-progress continuation and withholds STATE", async () => {
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
			m.type === "SKIP_RESULT",
	);
	assert.ok(
		skip,
		"a walk that repeats the same page while continuation remains must disclose a gap",
	);
	assert.equal(skip.reason, "shopify_order_history_unconfirmed");
	assert.equal(protocolMessages.some((message) => message.type === "STATE"), false);
});

test("collectShopify keeps polling after first-viewport DOM rows so hydrated Apollo rows are merged", async () => {
	const run = makeRecordingEmit(validateRecord);
	let cacheReads = 0;
	let scrolls = 0;
	const domOrder = {
		currency: "USD", detailUrl: "https://shop.app/orders/dom-1",
		id: "https://shop.app/orders/dom-1", itemCount: 1,
		lineItemTitles: [], merchantName: "DOM store", orderNumber: null,
		placedAt: null, status: null, totalCents: 100,
	};
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => ++cacheReads === 1 ? null : makeCache(["Order:1", "Order:2"], false),
		readDomOrders: async () => [domOrder],
		cacheWaitTimeoutMs: 0,
		scroll: async () => { scrolls += 1; },
	});
	const ids = recordsOf(run.emitted, "orders").map((order) => order.id);
	assert.ok(scrolls > 0, "the first DOM snapshot cannot short circuit bootstrap loading");
	assert.deepEqual(ids.sort(), ["gid://shopify/Order/1", "gid://shopify/Order/2"]);
	assert.ok(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"));
});

test("collectShopify reports rejected source rows and does not commit cursor state", async () => {
	const run = makeRecordingEmit(validateRecord);
	const priorState = { orders: { fingerprints: { "gid://shopify/Order/old": "prior" } } };
	const cache = makeCache(["Order:1", "Order:bad"], false);
	(cache["Order:bad"] as Record<string, unknown>) = { id: null };
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: priorState,
		readCache: async () => cache,
		readDomOrders: async () => [],
		cacheWaitTimeoutMs: 0,
		scroll: async () => undefined,
	});
	const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT", "a dropped source ref needs a durable gap");
	assert.equal(skip.reason, "shopify_order_rows_unresolved");
	assert.match(JSON.stringify(skip.diagnostics), /"discovered_rows":2/);
	assert.match(JSON.stringify(skip.diagnostics), /"valid_rows":1/);
	assert.match(JSON.stringify(skip.diagnostics), /"discarded_rows":1/);
	assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
});

test("collectShopify does not treat missing or mixed pageInfo as terminal or prune prior state", async () => {
	for (const root of [
		{ 'deliveriesOrdersList:{"filter":{}}': { nodes: [{ __ref: "Order:1" }] } },
		{
			'deliveriesOrdersList:{"filter":{}}': { nodes: [{ __ref: "Order:1" }], pageInfo: { hasNextPage: false } },
			'deliveriesOrdersList({"first":10})': { nodes: [{ __ref: "Order:1" }], pageInfo: { hasNextPage: true } },
		},
	]) {
		const run = makeRecordingEmit(validateRecord);
		const priorState = { orders: { fingerprints: { "gid://shopify/Order/prior": "prior" } } };
		const cache = makeCache(["Order:1"], false);
		cache.ROOT_QUERY = root;
		await collectShopify({
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: priorState,
			readCache: async () => cache,
			readDomOrders: async () => [],
			cacheWaitTimeoutMs: 0,
			scroll: async () => undefined,
		});
		assert.ok(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"));
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
	}
});

test("Shop record identity merges matching DOM and Apollo orders before validation and emission", async () => {
	const run = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => makeCache(["Order:1"], false),
		readDomOrders: async () => [{
			currency: "USD", detailUrl: "https://shop.app/orders/1",
			id: "https://shop.app/orders/1", itemCount: 1,
			lineItemTitles: [], merchantName: "DOM version", orderNumber: null,
			placedAt: null, status: null, totalCents: 1000,
		}],
		readPageEvidence: async () => ({
			url: "https://shop.app/account/order-history", navigation: "same-nav",
			orderContext: true, blocked: false, pageHeight: 100,
			domHasContinuation: false, domHasEndMarker: true, domCardCount: 1,
		}),
		cacheWaitTimeoutMs: 0,
		scroll: async () => undefined,
	});
	const orders = recordsOf(run.emitted, "orders");
	assert.equal(orders.length, 1);
	assert.equal(orders[0]?.id, "gid://shopify/Order/1");
});

test("a declared count mismatch is reported before records and prevents STATE", async () => {
	const run = makeRecordingEmit(validateRecord);
	const cache = makeCache(["Order:1"], false);
	const connection = (cache.ROOT_QUERY as Record<string, unknown>)[
		'deliveriesOrdersList:{"filter":{}}'
	] as Record<string, unknown>;
	connection.totalCount = 2;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => cache,
		cacheWaitTimeoutMs: 0,
		scroll: async () => undefined,
	});
	const skipIndex = run.events.findIndex((event) => event.kind === "message" && event.message.type === "SKIP_RESULT");
	const recordIndex = run.events.findIndex((event) => event.kind === "record");
	assert.ok(skipIndex >= 0 && skipIndex < recordIndex, "coverage veto precedes record emission");
	assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
});

test("a count mismatch from a partial snapshot clears only after a later snapshot reconciles it", async () => {
	const run = makeRecordingEmit(validateRecord);
	const partial = makeCache(["Order:1"], true);
	const terminal = makeCache(["Order:1", "Order:2"], false);
	const terminalConnection = (terminal.ROOT_QUERY as Record<string, unknown>)[
		'deliveriesOrdersList:{"filter":{}}'
	] as Record<string, unknown>;
	terminalConnection.totalCount = 2;
	const firstConnection = (partial.ROOT_QUERY as Record<string, unknown>)[
		'deliveriesOrdersList:{"filter":{}}'
	] as Record<string, unknown>;
	firstConnection.totalCount = 2;
	let reads = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => ++reads === 1 ? partial : terminal,
		cacheWaitTimeoutMs: 0,
		scroll: async () => undefined,
	});
	assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), true);
	assert.equal(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"), false);
});

test("a failed current cache read cannot reuse a terminal readiness snapshot for STATE", async () => {
	for (const failure of ["null", "reject"] as const) {
		const run = makeRecordingEmit(validateRecord);
		const terminal = makeCache(["Order:1"], false);
		let reads = 0;
		await collectShopify({
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: async () => {
				reads += 1;
				if (reads === 1) return terminal;
				if (failure === "reject") throw new Error("ordinary cache read failure");
				return null;
			},
			readPageEvidence: async () => ({
				url: "https://shop.app/account/order-history", navigation: "same-nav",
				orderContext: true, blocked: false, pageHeight: 100,
				domHasContinuation: false, domHasEndMarker: true, domCardCount: 0,
			}),
			cacheWaitTimeoutMs: 0,
			scroll: async () => undefined,
		});
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false, `${failure} read cannot authorize terminal proof`);
		assert.equal(recordsOf(run.emitted, "orders").length, 1, "readiness rows remain available as partial records");
	}
});

test("a later smaller snapshot cannot erase an unidentified earlier row by reusing its node index", async () => {
	const run = makeRecordingEmit(validateRecord);
	const first = makeCache(["Order:1"], false);
	const firstConnection = (first.ROOT_QUERY as Record<string, Record<string, unknown>>)['deliveriesOrdersList:{"filter":{}}'];
	assert.ok(firstConnection);
	firstConnection.nodes = [null, { __ref: "Order:1" }];
	const smaller = makeCache(["Order:1"], false);
	let reads = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => ++reads === 1 ? first : smaller,
		cacheWaitTimeoutMs: 0,
		scroll: async () => undefined,
	});
	assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false, "index reuse does not recover the lost row identity");
	const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_rows_unresolved");
});

test("collectShopify completes a connected cursor chain at its terminal frontier", async () => {
	const run = makeRecordingEmit(validateRecord);
	const cache = makeCache(["Order:1", "Order:2"], false);
	cache.ROOT_QUERY = {
		'deliveriesOrdersList({"first":10})': {
			nodes: [{ __ref: "Order:1" }],
			totalCount: 2,
			pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
		},
		'deliveriesOrdersList({"first":10,"after":"cursor-1"})': {
			nodes: [{ __ref: "Order:2" }],
			totalCount: 2,
			pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
		},
	};
	let scrolls = 0;
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => cache,
		cacheWaitTimeoutMs: 0,
		scroll: async () => { scrolls += 1; },
	});
	assert.equal(scrolls, 3, "bootstrap settles, then the terminal cursor frontier stops continuation scrolling");
	assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), true);
});

test("Shopify restores the 25-scroll bootstrap and 20 continuation ceilings", async () => {
	let heightReads = 0;
	let bootstrapScrolls = 0;
	const bootstrap = await walkOrdersCache({
		initialCache: makeCache(["Order:1"], false),
		readCache: async () => makeCache(["Order:1"], false),
		readPageEvidence: async () => ({
			url: "https://shop.app/account/order-history", navigation: "nav",
			orderContext: true, blocked: false, pageHeight: ++heightReads,
			domHasContinuation: false, domHasEndMarker: false, domCardCount: 0,
		}),
		maxBootstrapScrolls: 25,
		scroll: async () => { bootstrapScrolls += 1; },
	});
	assert.equal(bootstrapScrolls, 25);
	assert.equal(bootstrap.complete, true);

	let page = 0;
	let continuationScrolls = 0;
	const continuation = await walkOrdersCache({
		initialCache: makeCache(["Order:1"], true),
		readCache: async () => {
			page += 1;
			return makeCache(Array.from({ length: page + 1 }, (_, index) => `Order:${index + 1}`), true);
		},
		maxBootstrapScrolls: 0,
		maxContinuationScrolls: 20,
		scroll: async () => { continuationScrolls += 1; },
	});
	assert.equal(continuationScrolls, 20);
	assert.equal(continuation.truncated, true);
	assert.equal(continuation.complete, false);
	assert.equal(continuation.reason, "page_budget");
});

test("collectShopify vetoes page-end evidence when navigation changes or another page remains", async () => {
	const cases = [
		{ blocked: true, readPageEvidence: async () => ({
			url: "https://shop.app/account/login", navigation: "wrong-route",
			orderContext: false, blocked: true, pageHeight: 100,
			domHasContinuation: false, domHasEndMarker: true, domCardCount: 0,
		}) },
		{ blocked: true, readPageEvidence: letSwitchingEvidence() },
		{ blocked: false, readPageEvidence: async () => ({
			url: "https://shop.app/account/order-history", navigation: "same-route",
			orderContext: true, blocked: false, pageHeight: 100,
			domHasContinuation: true, domHasEndMarker: true, domCardCount: 1,
		}) },
	];
	for (const { readPageEvidence, blocked } of cases) {
		const run = makeRecordingEmit(validateRecord);
		await collectShopify({
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: async () => makeCache(["Order:1"], false),
			readDomOrders: async () => [],
			readPageEvidence,
			cacheWaitTimeoutMs: 0,
			scroll: async () => undefined,
		});
		assert.ok(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"));
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
		if (blocked) assert.equal(recordsOf(run.emitted, "orders").length, 0);
	}
});

test("a stalled diagnostics read cannot prevent a readiness failure from terminating", { timeout: 300 }, async () => {
	const run = makeRecordingEmit(validateRecord);
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		orderHistoryReady: false,
		readCache: async () => null,
		readSkipDiagnostics: () => new Promise(() => undefined),
		scroll: async () => undefined,
	});
	const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT", JSON.stringify(run.protocolMessages));
	assert.equal(skip.reason, "shopify_order_history_readiness_timeout");
});

test("stalled post-readiness cache, page evidence, and scroll reads terminate with a typed skip", { timeout: 900 }, async () => {
	const stuckReaders: Array<{
		name: string;
		configure: (args: Parameters<typeof collectShopify>[0]) => void;
	}> = [
		{ name: "cache", configure: (args) => { args.readCache = () => new Promise(() => undefined); } },
		{ name: "page evidence", configure: (args) => { args.readPageEvidence = () => new Promise(() => undefined); } },
		{ name: "scroll", configure: (args) => { args.scroll = () => new Promise(() => undefined); } },
	];
	for (const { name, configure } of stuckReaders) {
		const run = makeRecordingEmit(validateRecord);
		const args: Parameters<typeof collectShopify>[0] = {
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: async () => makeCache(["Order:1"], false),
			readPageEvidence: async () => ({
				url: "https://shop.app/account/order-history", navigation: "same",
				orderContext: true, blocked: false, pageHeight: 100,
				domHasContinuation: false, domHasEndMarker: false, domCardCount: 1,
			}),
			readDomOrders: async () => [],
			scroll: async () => undefined,
			cacheWaitTimeoutMs: 30,
			browserOperationTimeoutMs: 15,
			runBudgetMs: 100,
		};
		if (name === "cache") {
			let reads = 0;
			args.readCache = () => ++reads === 1 ? Promise.resolve(makeCache(["Order:1"], false)) : new Promise(() => undefined);
		}
		if (name === "scroll") {
			args.readCache = async () => makeCache(["Order:1"], true);
		}
		configure(args);
		await collectShopify(args);
		const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
		assert.ok(skip && skip.type === "SKIP_RESULT", `${name} must fail closed`);
		assert.equal(skip.reason, "shopify_browser_operation_timeout", `${name} reason`);
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
	}
});

test("coverage from readiness survives a smaller terminal snapshot", async () => {
	const run = makeRecordingEmit(validateRecord);
	let reads = 0;
	const first = makeCache(["Order:1", "Order:missing"], false);
	first["Order:missing"] = { id: null };
	const later = makeCache(["Order:1"], false);
	await collectShopify({
		emit: run.emit, emitRecord: run.emitRecord,
		progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
		readCache: async () => ++reads === 1 ? first : later,
		readDomOrders: async () => [],
		cacheWaitTimeoutMs: 0,
		scroll: async () => undefined,
	});
	const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.ok(skip && skip.type === "SKIP_RESULT");
	assert.equal(skip.reason, "shopify_order_rows_unresolved");
	assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
});

test("button-only signed-out order shell is not authenticated or empty", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://shop.app/**", (route) => route.fulfill({
			status: 200, contentType: "text/html",
			body: '<main><h1>Your orders</h1><button>Sign in to Shop</button><p>No orders yet</p><div id="root"></div></main>',
		}));
		await page.goto("https://shop.app/account/order-history");
		await page.evaluate(installApolloFixtureInPage, {
			ROOT_QUERY: { viewer: { __ref: "Customer:current" } },
			"Customer:current": { id: "gid://shopify/Customer/current" },
		});
		assert.equal(await page.evaluate(hasShopOrderHistoryContextInPage), false);
		assert.equal(await page.evaluate(isShopOrderHistoryReadyInPage), true, "auth wall is detected so it can fail fast");
		assert.equal(await page.evaluate(readShopOrderPageEvidenceInPage).then((evidence) => evidence.blocked), true);
		assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), false);
		const run = makeRecordingEmit(validateRecord);
		await collectShopify({
			emit: run.emit, emitRecord: run.emitRecord,
			progress: async () => undefined, requested: requestedMap(["orders"]), state: {},
			readCache: () => page.evaluate(readLiveApolloCacheInPage),
			readPageEvidence: () => page.evaluate(readShopOrderPageEvidenceInPage),
			readVerifiedEmptyState: () => page.evaluate(hasVerifiedEmptyOrderHistoryInPage),
			scroll: async () => undefined,
		});
		const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
		assert.ok(skip && skip.type === "SKIP_RESULT");
		assert.equal(skip.reason, "shopify_signed_out_or_blocked");
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
	} finally {
		await browser.close();
	}
});

test("hidden or unrelated disabled controls do not prove an order-history end", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://shop.app/**", (route) => route.fulfill({
			status: 200, contentType: "text/html",
			body: '<main><h1>Orders</h1><section data-testid="orders-list"><div class="order-card"><a href="/orders/1">Order</a><span>$10.00</span><button disabled>Next</button></div></section><footer><span style="display:none">No more orders</span><button disabled>Next</button></footer></main>',
		}));
		await page.goto("https://shop.app/account/order-history");
		const evidence = await page.evaluate(readShopOrderPageEvidenceInPage);
		assert.equal(evidence.domHasEndMarker, false);
		await page.setContent('<main><h1>Orders</h1><section data-testid="orders-list"><p>No more orders</p></section></main>');
		assert.equal((await page.evaluate(readShopOrderPageEvidenceInPage)).domHasEndMarker, true);
		await page.setContent('<main><h1>Orders</h1><section data-testid="orders-list" aria-busy="true"><p>No more orders</p></section></main>');
		assert.equal((await page.evaluate(readShopOrderPageEvidenceInPage)).domHasEndMarker, false);
	} finally {
		await browser.close();
	}
});

function letSwitchingEvidence(): () => Promise<{
	url: string; navigation: string; orderContext: boolean; blocked: boolean;
	pageHeight: number; domHasContinuation: boolean; domHasEndMarker: boolean; domCardCount: number;
}> {
	let reads = 0;
	return async () => ({
		url: "https://shop.app/account/order-history", navigation: ++reads < 3 ? "nav-1" : "nav-2",
		orderContext: true, blocked: false, pageHeight: 100,
		domHasContinuation: false, domHasEndMarker: true, domCardCount: 1,
	});
}

test("Shop session accepts shop.com redirect with tracking parameters without handoff", async () => {
	const navigations: string[] = [];
	const page = Object.assign({} as Page, {
		goto: async (url: string) => { navigations.push(url); return null; },
		url: () => "https://shop.com/account/order-history?_m_id=fixture&_m_attempted=1",
		waitForFunction: async () => ({}),
		evaluate: async (reader: unknown) => reader === hasShopOrderHistoryContextInPage,
	});
	await ensureShopifySession({
		capture: null, page,
		manualLogin: async () => { throw new Error("already signed in"); },
		sendInteraction: async (): Promise<never> => { throw new Error("unexpected handoff"); },
	});
	assert.deepEqual(navigations, ["https://shop.app/account/order-history"]);
});

test("Shop page readers recognize both origins and reject lookalike order pages and cards", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("**/*", (route) => route.fulfill({
			status: 200, contentType: "text/html",
			body: '<div id="root"><h1>Orders</h1><span>No orders yet</span></div>',
		}));
		for (const origin of ["https://shop.app", "https://shop.com", "https://shop.com.evil"]) {
			await page.goto(origin + "/account/order-history?_m_id=fixture&_m_attempted=1");
			await page.evaluate(installApolloFixtureInPage, makeCacheWithVerifiedEmptyOrdersConnection());
			const trusted = origin !== "https://shop.com.evil";
			assert.equal((await page.evaluate(readShopOrderPageEvidenceInPage)).blocked, !trusted);
			assert.equal(await page.evaluate(hasVerifiedEmptyOrderHistoryInPage), trusted);
		}
		await page.goto("https://shop.com/account/order-history");
		for (const origin of ["https://shop.app", "https://shop.com", "https://shop.com.evil", "http://shop.com"]) {
			await page.setContent(`<div class="order-card"><a href="${origin}/orders/fixture">Acme Goods</a><div>2 items · $19.99</div></div>`);
			const count = origin === "https://shop.app" || origin === "https://shop.com" ? 1 : 0;
			assert.equal((await page.evaluate(shopSkipDiagnosticsInPage)).dom_card_count, count);
			assert.equal((await page.evaluate(readShopOrderPageEvidenceInPage)).domCardCount, count);
		}
	} finally {
		await browser.close();
	}
});

test("Shop order records keep the same primary key and fingerprint fields across domains", () => {
	const order = {
		id: "https://shop.app/orders/same-order", detailUrl: "https://shop.app/orders/same-order",
		currency: "USD", itemCount: 1, lineItemTitles: [], merchantName: "Acme",
		orderNumber: null, placedAt: null, status: "Delivered", totalCents: 1000,
	};
	assert.deepEqual(orderRecord({
		...order, id: "https://shop.com/orders/same-order", detailUrl: "https://shop.com/orders/same-order",
	}), orderRecord(order));
});

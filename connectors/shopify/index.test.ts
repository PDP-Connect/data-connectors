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
import type { Page } from "playwright";
import type {
	EmittedMessage,
	RecordData,
	StreamScope,
} from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectShopify,
	ensureShopifySession,
	hasShopOrderHistoryContextInPage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ApolloCache } from "./types.ts";

test("Shop sign-in opens order history before the manual handoff and checks the returned page", async () => {
	const navigations: string[] = [];
	let liveSession = false;
	const page = Object.assign({} as Page, {
		goto: async (url: string) => {
			navigations.push(url);
			return null;
		},
		url: () => navigations.at(-1) ?? "about:blank",
		waitForFunction: async () => {
			if (!liveSession) throw new Error("order history not visible");
			return {};
		},
	});

	await ensureShopifySession({
		capture: null,
		page,
		manualLogin: async () => {
			assert.deepEqual(navigations, ["https://shop.app/account/order-history"]);
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
	const readinessPage = Object.assign({} as Page, {
		goto: async () => null,
		url: () => "https://shop.app/account/order-history",
		waitForFunction: async () => {
			ownerReady = true;
			return {};
		},
		close: async () => undefined,
	});
	const page = Object.assign({} as Page, {
		goto: async () => null,
		url: () => "https://shop.app/account/order-history",
		waitForFunction: async () => {
			if (!ownerReady) throw new Error("sign-in needed");
			return {};
		},
		context: () => ({ newPage: async () => readinessPage }),
	});

	await ensureShopifySession({
		assist: async (request) => {
			responseContract = request.response_contract;
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

test("collectShopify emits scope_unavailable SKIP_RESULT when the Apollo cache never resolves", async () => {
	const { emit, emitRecord, protocolMessages } =
		makeRecordingEmit(validateRecord);
	await collectShopify({
		emit,
		emitRecord,
		progress: async () => undefined,
		requested: requestedMap(["orders"]),
		state: {},
		readCache: () => Promise.resolve(null),
		scroll: () => Promise.resolve(),
	});
	const skip = protocolMessages.find(
		(m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
			m.type === "SKIP_RESULT",
	);
	assert.ok(skip);
	assert.equal(skip.reason, "shopify_apollo_state_unavailable");
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the DoorDash connector's `collect()` layer.
 *
 * No live DoorDash account exists for this lane (see connectors/doordash/
 * index.ts header). These tests don't spin up a real browser — they build a
 * fake Playwright `Page` whose `goto`/`evaluate` no-op and whose
 * `waitForResponse` is driven by `collectOrderNodes`'s injectable
 * `waitForResponseFn`/`scrollFn` hooks, then drive `collectAllStreams`
 * through `makeRecordingEmit(validateRecord)` — the same harness Reddit's
 * integration suite uses. Every emitted record passes through the real Zod
 * schema the runtime applies in production.
 *
 * What these prove (per the cut-doordash proof gate, item 3): START-shaped
 * scope filtering, RECORD emission for requested streams only, order/item
 * splitting per the capability-map field_map, and SKIP_RESULT on an empty
 * observed response. They do NOT prove field-shape correctness against a
 * real DoorDash response — that needs a live capture (pending).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	collectOrderNodes,
	MAX_SCROLL_PAGES,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DoorDashOrderNode } from "./types.ts";

const EMITTED_AT = "2026-09-22T00:00:00.000Z";

function makeOrderNode(
	id: string,
	overrides: Partial<DoorDashOrderNode> = {},
): DoorDashOrderNode {
	return {
		orderUuid: id,
		createdAt: "2026-08-01T18:22:05.000Z",
		store: { name: "Tatsu-ya Ramen" },
		deliveryStatus: "delivered",
		subtotal: { unitAmount: 2895 },
		tax: { unitAmount: 239 },
		tip: { unitAmount: 500 },
		deliveryFee: { unitAmount: 399 },
		serviceFee: { unitAmount: 290 },
		totalCharged: { unitAmount: 4323 },
		deliveryAddress: { printableAddress: "123 Main St, Austin, TX 78701" },
		orderItems: [
			{ name: "Tonkotsu Original", quantity: 1, price: { unitAmount: 1495 } },
		],
		...overrides,
	};
}

function graphqlEnvelope(nodes: DoorDashOrderNode[]): unknown {
	return { data: { consumer: { ordersWithDetails: { orders: nodes } } } };
}

/** Minimal fake Page: goto/evaluate no-op. Not used directly by
 *  collectOrderNodes when scrollFn/waitForResponseFn are injected, but
 *  collectAllStreams's ctx.page type requires a Page-shaped value. */
function fakePage(): Page {
	return {
		evaluate: async () => undefined,
		goto: async () => null,
	} as unknown as Page;
}

function makeCtx(
	harness: ReturnType<typeof makeRecordingEmit>,
	requestedStreams: string[],
	page: Page,
): BrowserCollectContext {
	const requested = new Map(requestedStreams.map((s) => [s, { name: s }]));
	return {
		assist: async (): Promise<never> => {
			throw new Error("mock assist not implemented");
		},
		capture: null,
		completeAssistance: async () => undefined,
		context: {} as never,
		credentials: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: async () => undefined,
		requestDetailGapPage: async (): Promise<readonly never[]> => [],
		requested,
		scope: { streams: requestedStreams.map((name) => ({ name })) },
		sendInteraction: async (): Promise<never> => {
			throw new Error("mock sendInteraction not implemented");
		},
		state: {},
	};
}

// ─── collectOrderNodes: pagination shape ─────────────────────────────────

test("collectOrderNodes: single page, no scroll continuation when the scroll yields nothing new", async () => {
	const page = fakePage();
	const firstBody = graphqlEnvelope([
		makeOrderNode("order-1"),
		makeOrderNode("order-2"),
	]);
	let waitCalls = 0;
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			waitCalls += 1;
			await action();
			return waitCalls === 1 ? firstBody : null;
		},
	});
	assert.equal(result.nodes.length, 2);
	assert.equal(result.truncated, false);
	assert.equal(
		waitCalls,
		2,
		"one initial load + one scroll that found nothing",
	);
});

test("collectOrderNodes: dedupes overlapping orderUuid across pages", async () => {
	const page = fakePage();
	const pageBodies = [
		graphqlEnvelope([makeOrderNode("order-1"), makeOrderNode("order-2")]),
		// Scroll refetch overlaps order-2, adds order-3.
		graphqlEnvelope([makeOrderNode("order-2"), makeOrderNode("order-3")]),
		null,
	];
	let call = 0;
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			await action();
			const body = pageBodies[call];
			call += 1;
			return body ?? null;
		},
	});
	assert.deepEqual(
		result.nodes.map((n) => n.orderUuid),
		["order-1", "order-2", "order-3"],
	);
	assert.equal(result.truncated, false);
});

test("collectOrderNodes: hits the page ceiling and reports truncated", async () => {
	const page = fakePage();
	let call = 0;
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			await action();
			call += 1;
			// Every page (including the ceiling page) returns exactly one NEW
			// order, so the ceiling — not an empty page — is what stops the walk.
			return graphqlEnvelope([makeOrderNode(`order-${call}`)]);
		},
	});
	assert.equal(result.truncated, true);
	assert.equal(result.nodes.length, MAX_SCROLL_PAGES + 1);
});

test("collectOrderNodes: no response observed at all returns zero nodes, not truncated", async () => {
	const page = fakePage();
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			await action();
			return null;
		},
	});
	assert.equal(result.nodes.length, 0);
	assert.equal(result.truncated, false);
});

// ─── collectAllStreams: scope filtering + RECORD/split behavior ─────────

/**
 * collectAllStreams calls the real page.waitForResponse-based
 * `waitForOrdersResponse`, which this harness cannot satisfy without a real
 * browser. To exercise collectAllStreams' record-splitting and scope-gating
 * logic without a browser, these tests reimplement the same
 * request/response wiring collectAllStreams performs, but through
 * `collectOrderNodes` directly (the same function collectAllStreams calls),
 * then apply collectAllStreams' own record-building loop inline via a tiny
 * local harness that mirrors it exactly. This keeps the test honest about
 * what's proven (splitting + scope-gating logic) vs. what needs a live
 * browser (the actual GraphQL response capture).
 */
async function runCollectAllStreamsWithNodes(
	nodes: DoorDashOrderNode[],
	requestedStreams: string[],
): Promise<ReturnType<typeof makeRecordingEmit>> {
	const harness = makeRecordingEmit(validateRecord);
	const page = fakePage();
	const ctx = makeCtx(harness, requestedStreams, page);
	// Patch collectOrderNodes indirectly by driving collectAllStreams with a
	// page whose waitForResponse-shaped calls are impossible to hit in a
	// browserless test; instead, call the two pure halves collectAllStreams
	// composes (collectOrderNodes + the record loop) by exercising
	// collectAllStreams through a page stub that fakes `waitForResponse`.
	(page as unknown as { waitForResponse: unknown }).waitForResponse = async (
		predicate: (res: { url: () => string }) => boolean,
	) => {
		void predicate;
		let resolved = false;
		return {
			json: async () => {
				if (resolved) {
					return null;
				}
				resolved = true;
				return graphqlEnvelope(nodes);
			},
		};
	};
	await collectAllStreams(ctx, async () => undefined);
	return harness;
}

test("collectAllStreams: requesting only 'orders' emits orders and no order_items", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("order-1")],
		["orders"],
	);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders"],
	);
});

test("collectAllStreams: requesting only 'order_items' emits order_items and no orders", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("order-1")],
		["order_items"],
	);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["order_items"],
	);
});

test("collectAllStreams: requesting both streams splits one order node into one order + N items (D3 split)", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[
			makeOrderNode("order-1", {
				orderItems: [
					{
						name: "Tonkotsu Original",
						quantity: 1,
						price: { unitAmount: 1495 },
					},
					{ name: "Gyoza", quantity: 2, price: { unitAmount: 600 } },
				],
			}),
		],
		["orders", "order_items"],
	);
	const orders = harness.emitted.filter((r) => r.stream === "orders");
	const items = harness.emitted.filter((r) => r.stream === "order_items");
	assert.equal(orders.length, 1);
	assert.equal(items.length, 2);
	assert.equal(orders[0]?.data.id, "order-1");
	for (const item of items) {
		assert.equal(item.data.order_id, "order-1");
	}
	assert.equal(harness.skipped.length, 0);
});

test("collectAllStreams: field mapping matches the capability-map field_map", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("order-42")],
		["orders", "order_items"],
	);
	const order = harness.emitted.find((r) => r.stream === "orders");
	assert.ok(order);
	assert.equal(order.data.id, "order-42");
	assert.equal(order.data.restaurant_name, "Tatsu-ya Ramen");
	assert.equal(order.data.order_date, "2026-08-01T18:22:05.000Z");
	assert.equal(order.data.total_cents, 4323);
	assert.equal(order.data.status, "delivered");
	assert.equal(order.data.delivery_address, "123 Main St, Austin, TX 78701");
	assert.equal(order.data.item_count, 1);

	const item = harness.emitted.find((r) => r.stream === "order_items");
	assert.ok(item);
	assert.equal(item.data.name, "Tonkotsu Original");
	assert.equal(item.data.quantity, 1);
	assert.equal(item.data.unit_price_cents, 1495);
});

test("collectAllStreams: neither stream requested performs no work and emits nothing", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("order-1")],
		[],
	);
	assert.equal(harness.emitted.length, 0);
	assert.equal(harness.protocolMessages.length, 0);
});

test("collectAllStreams: zero observed orders reports SKIP_RESULT doordash_orders_response_not_observed for requested streams", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[],
		["orders", "order_items"],
	);
	assert.equal(harness.emitted.length, 0);
	const skipReasons = harness.protocolMessages
		.filter((m) => m.type === "SKIP_RESULT")
		.map((m) => (m as { reason: string }).reason);
	assert.ok(skipReasons.includes("doordash_orders_response_not_observed"));
});

test("collectAllStreams: never emits a STATE message (full refresh only, no incremental cursor)", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("order-1")],
		["orders", "order_items"],
	);
	const stateMessages = harness.protocolMessages.filter(
		(m) => m.type === "STATE",
	);
	assert.equal(stateMessages.length, 0);
});

test("collectAllStreams: order missing orderUuid is reported via SKIP_RESULT, not emitted as a RECORD", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("order-1", { orderUuid: null })],
		["orders"],
	);
	assert.equal(harness.emitted.length, 0);
	const skipReasons = harness.protocolMessages
		.filter((m) => m.type === "SKIP_RESULT")
		.map((m) => (m as { reason: string }).reason);
	assert.ok(skipReasons.includes("shape_check_failed"));
});

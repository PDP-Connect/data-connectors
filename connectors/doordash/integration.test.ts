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
 * splitting per the capability-map field_map, observed exhaustion, and
 * SKIP_RESULT for incomplete history. They do NOT prove field-shape correctness against a
 * real DoorDash response — that needs a live capture (pending).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import {
	assertUserFacingProgress,
	setConnectorDiagnosticSink,
} from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collectAllStreams,
	collectOrderNodes,
	waitForOrdersResponse,
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

test("collectOrderNodes: single page followed by silence is partial", async () => {
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
			return waitCalls === 1
				? { kind: "body", body: firstBody }
				: { kind: "none" };
		},
	});
	assert.equal(result.nodes.length, 2);
	assert.equal(result.truncated, true);
	assert.equal(
		waitCalls,
		2,
		"one initial load + one scroll without a response",
	);
});

test("collectOrderNodes: dedupes overlapping orderUuid across pages", async () => {
	const page = fakePage();
	const pageBodies = [
		graphqlEnvelope([makeOrderNode("order-1"), makeOrderNode("order-2")]),
		// Scroll refetch overlaps order-2, adds order-3.
		graphqlEnvelope([makeOrderNode("order-2"), makeOrderNode("order-3")]),
		graphqlEnvelope([]),
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
			return body == null ? { kind: "none" } : { kind: "body", body };
		},
	});
	assert.deepEqual(
		result.nodes.map((n) => n.orderUuid),
		["order-1", "order-2", "order-3"],
	);
	assert.equal(result.truncated, false);
});

test("collectOrderNodes: reads all 30 advancing scrolls before an observed empty page", async () => {
	const page = fakePage();
	let call = 0;
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			await action();
			call += 1;
			if (call > 31) return responseWith();
			return {
				kind: "body",
				body: graphqlEnvelope([makeOrderNode(`order-${call}`)]),
			};
		},
	});
	assert.equal(result.truncated, false);
	assert.equal(result.nodes.length, 31);
	assert.equal(call, 32);
});

test("collectOrderNodes: no response observed at all is partial", async () => {
	const page = fakePage();
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			await action();
			return { kind: "none" };
		},
	});
	assert.equal(result.nodes.length, 0);
	assert.equal(result.truncated, true);
});

type OrdersResponse = Awaited<ReturnType<typeof waitForOrdersResponse>>;

async function walkResponses(responses: OrdersResponse[]) {
	let calls = 0,
		scrolls = 0;
	const result = await collectOrderNodes({
		page: fakePage(),
		delay: async () => undefined,
		scrollFn: async () => {
			scrolls += 1;
		},
		waitForResponseFn: async (_page, action) => {
			await action();
			return responses[calls++] ?? { kind: "none" };
		},
	});
	return { result, calls, scrolls };
}
const responseWith = (...ids: string[]): OrdersResponse => ({
	kind: "body",
	body: graphqlEnvelope(ids.map((id) => makeOrderNode(id))),
});

test("collectOrderNodes: unreadable scroll truncates instead of certifying history", async () => {
	const { result, calls } = await walkResponses([
		responseWith("synthetic-1"),
		{ kind: "unreadable" },
		responseWith("unreachable"),
	]);
	assert.deepEqual(
		result.nodes.map((node) => node.orderUuid),
		["synthetic-1"],
	);
	assert.equal(result.truncated, true);
	assert.equal(calls, 2);
});

test("collectOrderNodes: a scroll body without the orders list is not the end of history", async () => {
	const { result, calls } = await walkResponses([
		responseWith("synthetic-1"),
		{ kind: "body", body: { data: { consumer: {} } } },
		responseWith("unreachable"),
	]);
	assert.deepEqual(
		result.nodes.map((node) => node.orderUuid),
		["synthetic-1"],
	);
	assert.equal(result.truncated, true);
	assert.equal(calls, 2);
});

test("collectOrderNodes: isolated duplicate pages do not stop or accumulate across new orders", async () => {
	const { result, calls, scrolls } = await walkResponses([
		responseWith("synthetic-1"),
		responseWith("synthetic-1"),
		responseWith("synthetic-2"),
		responseWith("synthetic-2"),
		responseWith("synthetic-3"),
		responseWith(),
	]);
	assert.deepEqual(
		result.nodes.map((node) => node.orderUuid),
		["synthetic-1", "synthetic-2", "synthetic-3"],
	);
	assert.equal(result.truncated, false);
	assert.equal(calls, 6);
	assert.equal(scrolls, 5);
});

test("collectOrderNodes: two consecutive zero-add pages report partial", async () => {
	const { result, calls } = await walkResponses([
		responseWith("synthetic-1"),
		responseWith("synthetic-1"),
		responseWith("synthetic-1"),
		responseWith("unreachable"),
	]);
	assert.equal(result.nodes.length, 1);
	assert.equal(result.truncated, true);
	assert.equal(calls, 3);
});

test("collectOrderNodes: no response on second scroll is partial", async () => {
	const { result, calls, scrolls } = await walkResponses([
		responseWith("synthetic-1"),
		responseWith("synthetic-2"),
		{ kind: "none" },
	]);
	assert.equal(result.nodes.length, 2);
	assert.equal(result.truncated, true);
	assert.equal(calls, 3);
	assert.equal(scrolls, 2);
});

function capturePage(
	bodies: ("none" | "unreadable" | { body: unknown })[],
): Page {
	let call = 0;
	return {
		...fakePage(),
		waitForResponse: async () => {
			const next = bodies[call++] ?? "none";
			if (next === "none") throw new Error("synthetic timeout");
			return {
				json: async () => {
					if (next === "unreadable")
						throw new SyntaxError("synthetic non-JSON response");
					return next.body;
				},
			};
		},
	} as unknown as Page;
}

test("waitForOrdersResponse distinguishes absence from unreadable JSON", async () => {
	assert.deepEqual(
		await waitForOrdersResponse(capturePage(["none"]), async () => undefined),
		{ kind: "none" },
	);
	assert.deepEqual(
		await waitForOrdersResponse(
			capturePage(["unreadable"]),
			async () => undefined,
		),
		{ kind: "unreadable" },
	);
	assert.deepEqual(
		await waitForOrdersResponse(
			capturePage([{ body: null }]),
			async () => undefined,
		),
		{ kind: "body", body: null },
	);
});

test("collectAllStreams: unreadable scroll emits incomplete-history signal for both streams", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const page = capturePage([
		{ body: graphqlEnvelope([makeOrderNode("synthetic-1")]) },
		"unreadable",
	]);
	await collectAllStreams(
		makeCtx(harness, ["orders", "order_items"], page),
		async () => undefined,
	);
	assert.equal(
		harness.emitted.filter((record) => record.stream === "orders").length,
		1,
	);
	assert.deepEqual(
		harness.protocolMessages
			.filter((message) => message.type === "SKIP_RESULT")
			.map((message) => [message.stream, message.reason]),
		[
			["orders", "older_pages_deferred_page_budget"],
			["order_items", "older_pages_deferred_page_budget"],
		],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("collectAllStreams: unreadable initial capture reports partial history", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(harness, ["orders"], capturePage(["unreadable", "none"])),
		async () => undefined,
	);
	assert.equal(harness.emitted.length, 0);
	assert.ok(
		harness.protocolMessages.some(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "older_pages_deferred_page_budget" &&
				(message.diagnostics as { stop_reason?: unknown } | undefined)
					?.stop_reason === "unreadable_response",
		),
	);
});

// ─── collectAllStreams: scope filtering + RECORD/split behavior ─────────

async function runCollectAllStreamsWithNodes(
	nodes: DoorDashOrderNode[],
	requestedStreams: string[],
): Promise<ReturnType<typeof makeRecordingEmit>> {
	const harness = makeRecordingEmit(validateRecord);
	const page = capturePage([
		{ body: graphqlEnvelope(nodes) },
		{ body: graphqlEnvelope([]) },
	]);
	await collectAllStreams(
		makeCtx(harness, requestedStreams, page),
		async () => undefined,
	);
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

test("collectAllStreams: an observed empty initial list completes without a skip", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[],
		["orders", "order_items"],
	);
	assert.equal(harness.emitted.length, 0);
	assert.equal(harness.skipped.length, 0);
});

const prefixResponse = {
	body: graphqlEnvelope([makeOrderNode("synthetic-1")]),
};

const RUNTIME_RETRY = { action: "retry_by_runtime", retryable: true };
const UPGRADE_RETRY = {
	action: "retry_on_connector_upgrade",
	retryable: false,
};

for (const [tail, stopReason, hint] of [
	[["none"], "response_not_observed", RUNTIME_RETRY],
	[[prefixResponse, prefixResponse], "no_new_order_ids", RUNTIME_RETRY],
	[
		[{ body: { errors: [{ message: "synthetic error" }] } }],
		"unreadable_response",
		UPGRADE_RETRY,
	],
] as const) {
	test(`collectAllStreams: ${stopReason} after a prefix is partial without STATE`, async () => {
		const harness = makeRecordingEmit(validateRecord);
		const page = capturePage([prefixResponse, ...tail]);
		await collectAllStreams(
			makeCtx(harness, ["orders"], page),
			async () => undefined,
		);
		assert.equal(harness.emitted.length, 1);
		const skip = harness.protocolMessages.find(
			(message) =>
				message.type === "SKIP_RESULT" &&
				message.reason === "older_pages_deferred_page_budget" &&
				(message.diagnostics as { stop_reason?: unknown } | undefined)
					?.stop_reason === stopReason,
		);
		assert.ok(skip);
		assert.deepEqual((skip as { recovery_hint?: unknown }).recovery_hint, hint);
		assert.equal(
			harness.protocolMessages.some((message) => message.type === "STATE"),
			false,
		);
	});
}

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

test("collectAllStreams: order missing orderUuid is a record-level diagnostic, not a RECORD and not a stream SKIP_RESULT", async () => {
	const diagnostics: string[] = [];
	setConnectorDiagnosticSink((line) => diagnostics.push(line));
	let harness: Awaited<ReturnType<typeof runCollectAllStreamsWithNodes>>;
	try {
		harness = await runCollectAllStreamsWithNodes(
			[makeOrderNode("order-1", { orderUuid: null })],
			["orders"],
		);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
	// The mock page serves the same bad node on every page, so the line repeats.
	assert.ok(diagnostics.length >= 1);
	for (const line of diagnostics) {
		assert.equal(
			line,
			'[doordash-diagnostic] shape_check_failed {"stream":"orders","reason":"order node missing orderUuid"}',
		);
	}
	assert.equal(harness.emitted.length, 0);
	// One bad node must not skip the whole orders stream: Desktop drops every
	// order of the run for a stream-level skip.
	assert.equal(
		harness.protocolMessages.filter(
			(m) => m.type === "SKIP_RESULT" && m.reason === "shape_check_failed",
		).length,
		0,
	);
	assert.ok(
		harness.protocolMessages.some(
			(m) =>
				m.type === "PROGRESS" &&
				m.stream === "orders" &&
				m.message === "Skipped an order DoorDash returned without an ID",
		),
	);
	assertUserFacingProgress(
		harness.protocolMessages.filter((m) => m.type === "PROGRESS"),
	);
});

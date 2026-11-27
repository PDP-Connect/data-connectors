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
			return waitCalls === 1
				? { kind: "body", body: firstBody }
				: { kind: "body", body: graphqlEnvelope([]) };
		},
	});
	assert.equal(result.nodes.length, 2);
	assert.equal(result.incompletePage, null);
	assert.equal(
		waitCalls,
		3,
		"one initial load + two scrolls that found nothing new",
	);
});

async function collectWithReplies(replies: Awaited<ReturnType<typeof waitForOrdersResponse>>[]) {
	return collectOrderNodes({
		page: fakePage(),
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_page, action) => {
			await action();
			return replies.shift() ?? { kind: "none" };
		},
	});
}

test("collectOrderNodes: unreadable first page keeps older orders and marks page zero incomplete", async () => {
	const result = await collectWithReplies([
		{ kind: "unreadable" },
		{ kind: "body", body: graphqlEnvelope([makeOrderNode("older-order")]) },
		{ kind: "none" },
	]);
	assert.deepEqual(result.nodes.map((node) => node.orderUuid), ["older-order"]);
	assert.equal(result.incompletePage, 0);
});

test("collectOrderNodes: a missing first page with older orders after it is incomplete at page zero", async () => {
	const result = await collectWithReplies([
		{ kind: "none" },
		{ kind: "body", body: graphqlEnvelope([makeOrderNode("older-order")]) },
		{ kind: "none" },
	]);
	assert.deepEqual(result.nodes.map((node) => node.orderUuid), ["older-order"]);
	assert.equal(result.incompletePage, 0);
});

test("collectOrderNodes: an unreadable first page stays incomplete when two replies add no orders", async () => {
	const older = graphqlEnvelope([makeOrderNode("older-order")]);
	const result = await collectWithReplies([
		{ kind: "unreadable" },
		{ kind: "body", body: older },
		{ kind: "body", body: older },
		{ kind: "body", body: older },
	]);
	assert.deepEqual(result.nodes.map((node) => node.orderUuid), ["older-order"]);
	assert.equal(result.incompletePage, 0);
});

test("collectOrderNodes: readable first page followed by no response is complete", async () => {
	const result = await collectWithReplies([
		{ kind: "body", body: graphqlEnvelope([makeOrderNode("current-order")]) },
		{ kind: "none" },
	]);
	assert.deepEqual(result.nodes.map((node) => node.orderUuid), ["current-order"]);
	assert.equal(result.incompletePage, null);
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
	assert.equal(result.incompletePage, null);
});

test("collectOrderNodes: walks 45 scrolls before an observed empty result", async () => {
	const page = fakePage();
	let call = 0;
	const result = await collectOrderNodes({
		page,
		delay: async () => undefined,
		scrollFn: async () => undefined,
		waitForResponseFn: async (_p, action) => {
			await action();
			call += 1;
			return {
				kind: "body",
				body: graphqlEnvelope(call <= 46 ? [makeOrderNode(`order-${call}`)] : []),
			};
		},
	});
	assert.equal(result.incompletePage, null);
	assert.equal(result.nodes.length, 46);
	assert.equal(call, 48);
});

test("collectOrderNodes: no response observed at all returns zero nodes, not truncated", async () => {
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
	assert.equal(result.incompletePage, null);
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
	assert.notEqual(result.incompletePage, null);
	assert.equal(calls, 2);
});

test("collectOrderNodes: isolated duplicate pages do not stop or accumulate across new orders", async () => {
	const { result, calls, scrolls } = await walkResponses([
		responseWith("synthetic-1"),
		responseWith("synthetic-1"),
		responseWith("synthetic-2"),
		responseWith("synthetic-2"),
		responseWith("synthetic-3"),
		{ kind: "none" },
	]);
	assert.deepEqual(
		result.nodes.map((node) => node.orderUuid),
		["synthetic-1", "synthetic-2", "synthetic-3"],
	);
	assert.equal(result.incompletePage, null);
	assert.equal(calls, 6);
	assert.equal(scrolls, 5);
});

test("collectOrderNodes: two consecutive zero-add pages end cleanly", async () => {
	const { result, calls } = await walkResponses([
		responseWith("synthetic-1"),
		responseWith("synthetic-1"),
		responseWith("synthetic-1"),
		responseWith("unreachable"),
	]);
	assert.equal(result.nodes.length, 1);
	assert.equal(result.incompletePage, null);
	assert.equal(calls, 3);
});

test("collectOrderNodes: no response on second scroll still ends cleanly", async () => {
	const { result, calls, scrolls } = await walkResponses([
		responseWith("synthetic-1"),
		responseWith("synthetic-2"),
		{ kind: "none" },
	]);
	assert.equal(result.nodes.length, 2);
	assert.equal(result.incompletePage, null);
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
			["orders", "doordash_orders_response_unreadable"],
			["order_items", "doordash_orders_response_unreadable"],
		],
	);
	assert.equal(
		harness.protocolMessages.some((message) => message.type === "STATE"),
		false,
	);
});

test("collectAllStreams: an unreadable first page names the first page and the newest orders", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectAllStreams(
		makeCtx(
			harness,
			["orders"],
			capturePage(["unreadable", { body: graphqlEnvelope([makeOrderNode("older-order")]) }, "none"]),
		),
		async () => undefined,
	);
	const skip = harness.protocolMessages.find((message) => message.type === "SKIP_RESULT");
	assert.equal(skip?.reason, "doordash_orders_response_unreadable");
	assert.match(String(skip?.message), /first DoorDash orders page.*newest orders/);
});

test("collectAllStreams: unreadable initial capture with no orders retains not-observed signal", async () => {
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
				message.reason === "doordash_orders_response_not_observed",
		),
	);
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
	missingAtCall?: number,
	priorScrolls: DoorDashOrderNode[][] = [],
): Promise<ReturnType<typeof makeRecordingEmit>> {
	const harness = makeRecordingEmit(validateRecord);
	const page = fakePage();
	const ctx = makeCtx(harness, requestedStreams, page);
	let waitCalls = 0;
	// Patch collectOrderNodes indirectly by driving collectAllStreams with a
	// page whose waitForResponse-shaped calls are impossible to hit in a
	// browserless test; instead, call the two pure halves collectAllStreams
	// composes (collectOrderNodes + the record loop) by exercising
	// collectAllStreams through a page stub that fakes `waitForResponse`.
	(page as unknown as { waitForResponse: unknown }).waitForResponse = async (
		predicate: (res: { url: () => string }) => boolean,
	) => {
		void predicate;
		waitCalls += 1;
		if (waitCalls === missingAtCall) throw new Error("synthetic missing response");
		let resolved = false;
		return {
			json: async () => {
				if (resolved) {
					return null;
				}
				resolved = true;
				return graphqlEnvelope(priorScrolls[waitCalls - 2] ?? nodes);
			},
		};
	};
	await collectAllStreams(ctx, async () => undefined);
	return harness;
}

test("collectAllStreams: no reply to a later scroll ends the walk cleanly with what was read", async () => {
	const harness = await runCollectAllStreamsWithNodes(
		[makeOrderNode("fixture-1")],
		["orders", "order_items"],
		4,
		[[makeOrderNode("fixture-2")], [makeOrderNode("fixture-3")]],
	);
	assert.deepEqual(
		harness.protocolMessages.filter((message) => message.type === "SKIP_RESULT"),
		[],
	);
	assert.equal(
		harness.emitted.filter((record) => record.stream === "orders").length,
		3,
	);
});

test("collectAllStreams: counts unnamed items in progress without emitting a nameless record", async () => {
	const harness = await runCollectAllStreamsWithNodes([
		makeOrderNode("fixture", { orderItems: [{ name: " " }] }),
	], ["order_items"]);
	assert.equal(harness.emitted.length, 0);
	assert.ok(harness.protocolMessages.some((message) =>
		message.type === "PROGRESS" && message.message === "Skipped 1 DoorDash line item(s) without a name",
	));
});

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
	for (const m of harness.protocolMessages) {
		if (m.type !== "SKIP_RESULT") continue;
		assert.deepEqual(
			(m as { recovery_hint?: unknown }).recovery_hint,
			{ action: "retry_on_connector_upgrade", retryable: false },
			"drift or an account with no orders looks the same on every run",
		);
	}
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-order fingerprint behavior for the Amazon `orders` stream.
 *
 * Before this gate, `emitOrderAndItems` appended a fresh version of every
 * re-scraped order on every run because the record body carried a run-clock
 * `fetched_at: deps.emittedAt`. Year-freezing already caps the blast radius
 * to the current (unfrozen) year, but every order in that window was
 * re-emitted each run with a fresh `fetched_at` even when nothing moved. An
 * order's identity (id = order id) is immutable and its total is fixed once
 * placed; the only field that moved between byte-identical runs was
 * `fetched_at`.
 *
 * `order_items` carries NO `fetched_at`, so a re-scraped item is
 * byte-identical and the storage byte-equivalence backstop already
 * suppresses it — only `orders` needs this gate.
 *
 * These tests pin:
 *
 *   1. Re-scraping the same order (only fetched_at differs) is fully
 *      suppressed on the second run.
 *   2. A genuinely-new order still emits.
 *   3. A real field move (delivery_status transitioning while the order
 *      ships) re-emits.
 *   4. NO prune: an order in a year not scraped this run keeps its
 *      fingerprint — the partial-scan (year-freeze) invariant.
 *   5. Legacy callers without a cursor emit unconditionally.
 *   6. `order_items` is unaffected by the orders gate.
 *   7. Connector fingerprint (excludes fetched_at) == compaction fingerprint
 *      over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { makeEmitRecord } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type FingerprintCursor,
	openFingerprintCursor,
	recordFingerprint,
} from "../../packages/polyfill-connectors/src/fingerprint-cursor.ts";
import {
	type EmittedRecord,
	makeRecordingEmit,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type EmitDeps,
	emitOrderAndItems,
	newOrderItemsCoverage,
	newOrdersCoverage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ListPageOrder, OrderDetail } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";

function makeDeps(
	emittedAt: string,
	ordersFingerprintCursor?: FingerprintCursor,
): { deps: EmitDeps; emitted: EmittedRecord[] } {
	const harness = makeRecordingEmit(validateRecord);
	const deps: EmitDeps = {
		capture: null,
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt,
		ordersFingerprintCursor,
		progress: (): Promise<void> => Promise.resolve(),
		skipDetail: false,
		wantsItems: true,
		wantsOrders: true,
	};
	return { deps, emitted: harness.emitted };
}

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
	return {
		orderId: "111-1234567-8901234",
		orderDateRaw: "January 5, 2026",
		orderTotal: "$42.99",
		deliveryStatus: "Shipping",
		items: [
			{
				asin: "B01ABCDEFG",
				name: "Widget",
				url: "https://amazon.com/dp/B01ABCDEFG",
			},
		],
		...overrides,
	};
}

function makeDetail(overrides: Partial<OrderDetail> = {}): OrderDetail {
	return {
		grand_total: "$42.99",
		recipient_name: "Fake Name",
		shipping_address_summary: "123 Fake St",
		payment_method_summary: "Visa ending in 0000",
		status_detail: null,
		gift_order: false,
		digital_order: false,
		items: [
			{
				asin: "B01ABCDEFG",
				name: "Widget",
				url: null,
				unit_price: "$39.99",
				quantity: 1,
				seller: null,
				item_image_url: null,
				refund_status: null,
			},
		],
		...overrides,
	};
}

function ordersOf(emitted: EmittedRecord[]): EmittedRecord[] {
	return emitted.filter((r) => r.stream === "orders");
}

test("orders: re-scraping the same order (only fetched_at differs) is fully suppressed", async () => {
	const cursor1 = openFingerprintCursor(undefined, {
		excludeFromFingerprint: ["fetched_at"],
	});
	const run1 = makeDeps(RUN1_AT, cursor1);
	await emitOrderAndItems(
		run1.deps,
		makeListOrder(),
		makeDetail(),
		"2026-01-05",
	);
	assert.equal(
		ordersOf(run1.emitted).length,
		1,
		"first run emits the order once",
	);

	// Carry the cursor forward (as the orders STATE would) and re-scrape.
	const cursor2 = openFingerprintCursor(
		{ fingerprints: cursor1.toState() },
		{ excludeFromFingerprint: ["fetched_at"] },
	);
	const run2 = makeDeps(RUN2_AT, cursor2);
	await emitOrderAndItems(
		run2.deps,
		makeListOrder(),
		makeDetail(),
		"2026-01-05",
	);
	assert.equal(
		ordersOf(run2.emitted).length,
		0,
		"re-scraped unchanged order fully suppressed despite new fetched_at",
	);
});

test("orders: a genuinely-new order still emits", async () => {
	const cursor1 = openFingerprintCursor(undefined, {
		excludeFromFingerprint: ["fetched_at"],
	});
	const run1 = makeDeps(RUN1_AT, cursor1);
	await emitOrderAndItems(
		run1.deps,
		makeListOrder({ orderId: "ORDER-A" }),
		makeDetail(),
		"2026-01-05",
	);

	const cursor2 = openFingerprintCursor(
		{ fingerprints: cursor1.toState() },
		{ excludeFromFingerprint: ["fetched_at"] },
	);
	const run2 = makeDeps(RUN2_AT, cursor2);
	// Re-scrape the known order (suppressed) + a new order (emits).
	await emitOrderAndItems(
		run2.deps,
		makeListOrder({ orderId: "ORDER-A" }),
		makeDetail(),
		"2026-01-05",
	);
	await emitOrderAndItems(
		run2.deps,
		makeListOrder({ orderId: "ORDER-B" }),
		makeDetail(),
		"2026-01-06",
	);
	const orders = ordersOf(run2.emitted);
	assert.equal(orders.length, 1, "only the new order emits");
	assert.equal(orders[0]?.data.id, "ORDER-B");
});

test("orders: a delivery_status transition (Shipping → Delivered) re-emits", async () => {
	const cursor1 = openFingerprintCursor(undefined, {
		excludeFromFingerprint: ["fetched_at"],
	});
	const run1 = makeDeps(RUN1_AT, cursor1);
	await emitOrderAndItems(
		run1.deps,
		makeListOrder({ deliveryStatus: "Shipping" }),
		makeDetail(),
		"2026-01-05",
	);

	const cursor2 = openFingerprintCursor(
		{ fingerprints: cursor1.toState() },
		{ excludeFromFingerprint: ["fetched_at"] },
	);
	const run2 = makeDeps(RUN2_AT, cursor2);
	// The order shipped: delivery_status moved. A real field move re-emits.
	await emitOrderAndItems(
		run2.deps,
		makeListOrder({ deliveryStatus: "Delivered" }),
		makeDetail(),
		"2026-01-05",
	);
	const orders = ordersOf(run2.emitted);
	assert.equal(
		orders.length,
		1,
		"a delivery_status move is a fingerprint boundary and re-emits",
	);
	assert.equal(
		orders[0]?.data.delivery_status,
		"Delivered",
		"the re-emitted record carries the new status",
	);
});

test("orders: NO prune — an order in a year not scraped this run keeps its fingerprint", async () => {
	// Run 1: two orders observed (e.g. across two years).
	const cursor1 = openFingerprintCursor(undefined, {
		excludeFromFingerprint: ["fetched_at"],
	});
	const run1 = makeDeps(RUN1_AT, cursor1);
	await emitOrderAndItems(
		run1.deps,
		makeListOrder({ orderId: "ORDER-2025" }),
		makeDetail(),
		"2025-12-20",
	);
	await emitOrderAndItems(
		run1.deps,
		makeListOrder({ orderId: "ORDER-2026" }),
		makeDetail(),
		"2026-01-05",
	);

	// Run 2: the 2025 year froze, so only the 2026 order is re-scraped. The
	// cursor is NEVER pruned (no dropUnseenIds call), so ORDER-2025's fingerprint
	// must survive even though it was not observed this run.
	const cursor2 = openFingerprintCursor(
		{ fingerprints: cursor1.toState() },
		{ excludeFromFingerprint: ["fetched_at"] },
	);
	const run2 = makeDeps(RUN2_AT, cursor2);
	await emitOrderAndItems(
		run2.deps,
		makeListOrder({ orderId: "ORDER-2026" }),
		makeDetail(),
		"2026-01-05",
	);
	assert.equal(
		ordersOf(run2.emitted).length,
		0,
		"the re-scraped 2026 order unchanged stays silent",
	);
	assert.ok(
		cursor2.priorFingerprint("ORDER-2025"),
		"the un-scraped 2025 order's fingerprint survived (never pruned)",
	);
});

test("orders: legacy callers without a cursor emit unconditionally", async () => {
	const run = makeDeps(RUN1_AT);
	await emitOrderAndItems(
		run.deps,
		makeListOrder(),
		makeDetail(),
		"2026-01-05",
	);
	await emitOrderAndItems(
		run.deps,
		makeListOrder(),
		makeDetail(),
		"2026-01-05",
	);
	assert.equal(ordersOf(run.emitted).length, 2, "no cursor → emits every time");
});

test("orders: order_items is unaffected by the orders gate (no fetched_at, never suppressed here)", async () => {
	const cursor1 = openFingerprintCursor(undefined, {
		excludeFromFingerprint: ["fetched_at"],
	});
	const run1 = makeDeps(RUN1_AT, cursor1);
	await emitOrderAndItems(
		run1.deps,
		makeListOrder(),
		makeDetail(),
		"2026-01-05",
	);
	const items1 = run1.emitted.filter((r) => r.stream === "order_items");
	assert.ok(items1.length >= 1, "items emit on the first run");

	// Re-scrape: the ORDER is suppressed (byte-identical modulo fetched_at) but
	// the orders gate does not touch order_items — they still flow (the storage
	// backstop dedupes them downstream because they carry no fetched_at).
	const cursor2 = openFingerprintCursor(
		{ fingerprints: cursor1.toState() },
		{ excludeFromFingerprint: ["fetched_at"] },
	);
	const run2 = makeDeps(RUN2_AT, cursor2);
	await emitOrderAndItems(
		run2.deps,
		makeListOrder(),
		makeDetail(),
		"2026-01-05",
	);
	assert.equal(ordersOf(run2.emitted).length, 0, "order suppressed");
	assert.equal(
		run2.emitted.filter((r) => r.stream === "order_items").length,
		items1.length,
		"items still emit from the orders gate's perspective (no fetched_at to gate on)",
	);
});

test("orders: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
	const body = {
		id: "111-1234567-8901234",
		order_date: "2026-01-05",
		order_total: "$42.99",
		order_total_cents: 4299,
		delivery_status: "Shipping",
		status_detail: null,
		recipient_name: "Fake Name",
		shipping_address_summary: "123 Fake St",
		payment_method_summary: "Visa ending in 0000",
		gift_order: false,
		digital_order: false,
		item_count: 1,
		fetched_at: RUN1_AT,
	};
	const later = { ...body, fetched_at: RUN2_AT };
	const shipped = { ...later, delivery_status: "Delivered" };
	assert.equal(
		recordFingerprint(body, ["fetched_at"]),
		recordFingerprint(later, ["fetched_at"]),
		"fetched_at must not participate; a no-op re-scrape hashes identically",
	);
	assert.notEqual(
		recordFingerprint(body, ["fetched_at"]),
		recordFingerprint(shipped, ["fetched_at"]),
		"a delivery_status move MUST produce a different fingerprint — real order state is never hidden",
	);
});

for (const rejection of ["selection", "schema", "throw", "item"] as const) {
	test(`actual emitter ${rejection}: rejected order bundle cannot seed a retry baseline`, async () => {
		const cursor = openFingerprintCursor(undefined, {
			excludeFromFingerprint: ["fetched_at"],
		});
		const hydratedOrders = new Map<string, string>();
		const harness = makeRecordingEmit();
		const runtime = makeEmitRecord({
			requested: new Map([
				[
					"orders",
					{
						name: "orders",
						...(rejection === "selection"
							? { resources: ["different-order"] }
							: {}),
					},
				],
				["order_items", { name: "order_items" }],
			]),
			emittedAt: RUN1_AT,
			emit: async (message) => {
				if (rejection === "throw" && message.type === "RECORD")
					throw new Error("write failed");
				await harness.emit(message);
			},
			isTombstone: undefined,
			timeRangeFieldFor: () => null,
			validateRecord: (stream, data) => {
				if (
					(rejection === "schema" && stream === "orders") ||
					(rejection === "item" && stream === "order_items")
				) {
					return {
						ok: false,
						issues: [{ path: "id", message: "rejected by schema" }],
					};
				}
				return validateRecord(stream, data);
			},
		});
		const deps: EmitDeps = {
			...makeDeps(RUN1_AT, cursor).deps,
			emit: harness.emit,
			emitRecord: runtime.emit,
			hydratedOrders,
			ordersCoverage: newOrdersCoverage(),
			orderItemsCoverage: newOrderItemsCoverage(),
		};
		const run = emitOrderAndItems(
			deps,
			makeListOrder(),
			makeDetail(),
			"2026-01-05",
		);
		if (rejection === "throw") await assert.rejects(run, /write failed/);
		else await run;
		assert.deepEqual(
			cursor.toState(),
			{},
			"unaccepted bundle must not commit a fingerprint",
		);
		assert.equal(
			hydratedOrders.size,
			0,
			"unaccepted bundle must not establish hydration",
		);

		const retryCursor = openFingerprintCursor(
			{ fingerprints: cursor.toState() },
			{ excludeFromFingerprint: ["fetched_at"] },
		);
		const retry = makeDeps(RUN2_AT, retryCursor);
		retry.deps.hydratedOrders = hydratedOrders;
		const retryRuntime = makeEmitRecord({
			requested: new Map([
				["orders", { name: "orders" }],
				["order_items", { name: "order_items" }],
			]),
			emittedAt: RUN2_AT,
			emit: harness.emit,
			validateRecord,
			isTombstone: undefined,
			timeRangeFieldFor: () => null,
		});
		retry.deps.emitRecord = retryRuntime.emit;
		const before = harness.protocolMessages.length;
		await emitOrderAndItems(
			retry.deps,
			makeListOrder(),
			makeDetail(),
			"2026-01-05",
		);
		assert.equal(
			harness.protocolMessages
				.slice(before)
				.filter((m) => m.type === "RECORD" && m.stream === "orders").length,
			1,
		);
		assert.equal(
			hydratedOrders.size,
			1,
			"accepted bundle establishes hydration",
		);
		assert.equal(Object.keys(retryCursor.toState()).length, 1);
	});
}

for (const scenario of ["parent-resource", "parent-time", "child-resource", "child-time", "parent-schema", "child-schema", "child-throw", "accepted"] as const) {
 test(`actual production child coverage: ${scenario}`, async () => {
  const { processResolvedListOrder } = await import("./index.ts");
  const harness = makeRecordingEmit();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const deps = {
   ...makeDeps(RUN1_AT, cursor).deps,
   emit: harness.emit,
   hydratedOrders: new Map<string, string>(),
   orderItemsCoverage: newOrderItemsCoverage(),
   ordersCoverage: newOrdersCoverage(),
  };
  const runtime = makeEmitRecord({
   requested: new Map([
    ["orders", {name:"orders", ...(scenario === "parent-resource" ? {resources:["other"]} : {}), ...(scenario === "parent-time" ? {time_range:{since:"2026-02-01"}} : {})}],
    ["order_items", {name:"order_items",
     ...(scenario === "child-resource" ? {resources:["other"]} : {}),
     ...(scenario === "child-time" ? {time_range:{since:"2026-02-01"}} : {}),
    }],
   ]),
   emittedAt: RUN1_AT,
   emit: async (message) => {
    if (scenario === "child-throw" && message.type === "RECORD" && message.stream === "order_items") throw new Error("child write failed");
    await harness.emit(message);
   },
   validateRecord: (stream, data) => {
    if ((scenario === "parent-schema" && stream === "orders") || (scenario === "child-schema" && stream === "order_items"))
     return {ok:false, issues:[{path:"id",message:"schema rejection"}]};
    return validateRecord(stream,data);
   },
   isTombstone: undefined,
   timeRangeFieldFor: () => ({field:"order_date",format:"date"}),
  });
  Object.assign(deps, {emitRecord:runtime.emit, isRecordSelected:runtime.isSelected});
  const run = processResolvedListOrder(deps, makeListOrder(), "2026-01-05", {
   detail:makeDetail(), detailGapReason:"temporary_unavailable", detailFailureKind:null,
  });
  if (scenario === "child-throw") await assert.rejects(run,/child write failed/);
  else await run;
  const excluded = scenario === "child-resource" || scenario === "child-time";
  const debt = scenario === "child-schema" || scenario === "child-throw";
  assert.deepEqual(deps.orderItemsCoverage.required, excluded ? [] : [makeListOrder().orderId]);
  assert.deepEqual(deps.orderItemsCoverage.hydrated, excluded || debt ? [] : [makeListOrder().orderId]);
  assert.deepEqual(deps.orderItemsCoverage.gap, [], "schema/write debt is not an invented transport gap");
  if (scenario !== "accepted") {
   assert.equal(deps.hydratedOrders.size,0,"partial or rejected bundles cannot seed a global hydration baseline");
   assert.deepEqual(cursor.toState(),{});
  }
  const retryRuntime = makeEmitRecord({
   requested:new Map([["orders",{name:"orders"}],["order_items",{name:"order_items"}]]),
   emittedAt:RUN2_AT, emit:harness.emit,validateRecord,isTombstone:undefined,timeRangeFieldFor:()=>({field:"order_date",format:"date"}),
  });
  Object.assign(deps,{emitRecord:retryRuntime.emit,isRecordSelected:retryRuntime.isSelected,
   orderItemsCoverage:newOrderItemsCoverage(),ordersCoverage:newOrdersCoverage()});
  await processResolvedListOrder(deps,makeListOrder(),"2026-01-05",{
   detail:makeDetail(),detailGapReason:"temporary_unavailable",detailFailureKind:null,
  });
  assert.deepEqual(deps.orderItemsCoverage.required,[makeListOrder().orderId]);
  assert.deepEqual(deps.orderItemsCoverage.hydrated,[makeListOrder().orderId]);
  assert.equal(deps.hydratedOrders.size,1);
 });
}

test("processListOrder: time-excluded order and children require no hydration or debt", async () => {
 const {processListOrder} = await import("./index.ts");
 const harness = makeRecordingEmit();
 const runtime = makeEmitRecord({
  requested:new Map(["orders","order_items"].map(name=>[name,{name,time_range:{since:"2026-02-01"}}])),
  emittedAt:RUN1_AT,emit:harness.emit,validateRecord,isTombstone:undefined,
  timeRangeFieldFor:()=>({field:"order_date",format:"date"}),
 });
 const deps:EmitDeps = {...makeDeps(RUN1_AT).deps,emit:harness.emit,emitRecord:runtime.emit,
  isRecordSelected:runtime.isSelected,orderItemsCoverage:newOrderItemsCoverage(),ordersCoverage:newOrdersCoverage()};
 const flags = {
  detailAttempts:0,detailCaptured:false,failedDetailCaptured:false,repairAttempted:false,
  sessionRepairRequired:false,temporaryDetailFailures:0,
 };
 await processListOrder({} as Parameters<typeof processListOrder>[0],deps,flags,makeListOrder());
 assert.equal(flags.detailAttempts, 0, "excluded order must not attempt detail hydration");
 assert.deepEqual(deps.orderItemsCoverage,newOrderItemsCoverage());
 assert.deepEqual(deps.ordersCoverage,newOrdersCoverage());
 assert.equal(harness.protocolMessages.length,0);
});

test("malformed source identity is not a child resource exclusion or hydration baseline", async () => {
 const {processResolvedListOrder} = await import("./index.ts");
 const harness=makeRecordingEmit();
 const runtime=makeEmitRecord({
  requested:new Map([["orders",{name:"orders"}],["order_items",{name:"order_items",resources:["other"]}]]),
  emittedAt:RUN1_AT,emit:harness.emit,validateRecord,isTombstone:undefined,timeRangeFieldFor:()=>null,
 });
 const deps:EmitDeps={...makeDeps(RUN1_AT).deps,emit:harness.emit,emitRecord:runtime.emit,isRecordSelected:runtime.isSelected,
  hydratedOrders:new Map(),orderItemsCoverage:newOrderItemsCoverage()};
 await processResolvedListOrder(deps,makeListOrder({orderId:""}),"2026-01-05",{
  detail:makeDetail(),detailGapReason:"temporary_unavailable",detailFailureKind:null,
 });
 assert.deepEqual(deps.orderItemsCoverage,{required:[""],hydrated:[],gap:[]});
 assert.equal(deps.hydratedOrders?.size,0);
});

test("accepted sibling plus excluded child covers the order without caching a partial bundle", async () => {
 const {processResolvedListOrder} = await import("./index.ts");
 const harness=makeRecordingEmit();
 const list=makeListOrder();
 // Discover a real builder-generated child ID, never duplicate its construction rule.
 const probe=makeDeps(RUN1_AT);
 await emitOrderAndItems(probe.deps,list,makeDetail(),"2026-01-05");
 const selected=probe.emitted.find(r=>r.stream==="order_items")?.data.id;
 assert.equal(typeof selected,"string");
 const runtime=makeEmitRecord({
  requested:new Map([["orders",{name:"orders"}],["order_items",{name:"order_items",resources:[String(selected)]}]]),
  emittedAt:RUN1_AT,emit:harness.emit,validateRecord,isTombstone:undefined,timeRangeFieldFor:()=>null,
 });
 const detail=makeDetail(); detail.items.push({...detail.items[0]!,asin:"B02ABCDEFG",name:"Other"});
 const deps:EmitDeps={...makeDeps(RUN1_AT).deps,emit:harness.emit,emitRecord:runtime.emit,isRecordSelected:runtime.isSelected,
  hydratedOrders:new Map(),orderItemsCoverage:newOrderItemsCoverage()};
 await processResolvedListOrder(deps,list,"2026-01-05",{detail,detailGapReason:"temporary_unavailable",detailFailureKind:null});
 assert.deepEqual(deps.orderItemsCoverage,{required:[list.orderId],hydrated:[list.orderId],gap:[]});
 assert.equal(deps.hydratedOrders?.size,0);
 assert.equal(harness.protocolMessages.filter(m=>m.type==="RECORD"&&m.stream==="order_items").length,1);
});

test("processListOrder: narrow child resources hydrate selected child, not the parent ID", async () => {
 const { processListOrder } = await import("./index.ts");
 const list = makeListOrder();
 const probe = makeDeps(RUN1_AT);
 await emitOrderAndItems(probe.deps, list, makeDetail(), "2026-01-05");
 const selected = probe.emitted.find(r => r.stream === "order_items")?.data.id;
 assert.equal(typeof selected, "string");
 assert.notEqual(selected, list.orderId, "fixture must distinguish child and parent resource IDs");
 const harness = makeRecordingEmit();
 const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
 const runtime = makeEmitRecord({
  requested: new Map([["orders", {name:"orders"}], ["order_items", {name:"order_items", resources:[String(selected)]}]]),
  emittedAt: RUN1_AT, emit:harness.emit, validateRecord, isTombstone:undefined,
  timeRangeFieldFor:()=>({field:"order_date",format:"date"}),
 });
 const deps: EmitDeps = {
  ...makeDeps(RUN1_AT, cursor).deps, emit:harness.emit, emitRecord:runtime.emit,
  isRecordSelected:runtime.isSelected, itemResourcesRestricted:true,
  hydratedOrders:new Map(), orderItemsCoverage:newOrderItemsCoverage(),
 };
 const flags = {detailAttempts:0,detailCaptured:false,failedDetailCaptured:false,repairAttempted:false,
  sessionRepairRequired:false,temporaryDetailFailures:0};
 let navigations = 0;
 let reads = 0;
 const html = '<div id="orderDetails"><div data-component="chargeSummary">Grand Total: $42.99</div>' +
  '<div data-component="purchasedItemsRightGrid"><div data-component="itemTitle"><a href="/dp/B01ABCDEFG">Widget</a></div><div data-component="unitPrice">$39.99</div></div>' +
  '<div data-component="purchasedItemsRightGrid"><div data-component="itemTitle"><a href="/dp/B02ABCDEFG">Other</a></div><div data-component="unitPrice">$3.00</div></div></div>';
 const page = {
  goto:async()=>{navigations += 1;},
  waitForSelector:async()=>{},
  url:()=> "https://www.amazon.com/gp/your-account/order-details?orderID=" + list.orderId,
  content:async()=>{reads += 1;return html;},
 } as unknown as Parameters<typeof processListOrder>[0];
 await processListOrder(page,deps,flags,list);
 assert.equal(flags.detailAttempts,1,"selected child requires a real detail attempt");
 assert.equal(navigations,1);
 assert.equal(reads,1,"actual detail HTML must be parsed");
 const children = harness.protocolMessages.filter(m=>m.type==="RECORD"&&m.stream==="order_items");
 assert.equal(children.length,1,"exactly the selected child must be emitted once");
 assert.ok(children[0]?.type==="RECORD");
 assert.equal(children[0].data.id,selected);
 assert.deepEqual(deps.orderItemsCoverage,{required:[list.orderId],hydrated:[list.orderId],gap:[]});
 assert.equal(deps.hydratedOrders?.size,0,"partial scope must not establish global hydration");
 assert.deepEqual(cursor.toState(),{},"partial scope must not establish a global fingerprint");
});

for (const invalid of [false,true]) {
 test(`resource-excluded ${invalid ? "schema-invalid" : "valid"} child ${invalid ? "remains debt" : "leaves the required set"}`, async () => {
  const {processResolvedListOrder} = await import("./index.ts");
  const list = makeListOrder({items:[]});
  const detail = makeDetail();
  if (invalid) detail.items[0]!.quantity = Number.NaN;
  const harness = makeRecordingEmit();
  const cursor = openFingerprintCursor(undefined,{excludeFromFingerprint:["fetched_at"]});
  const probe = makeDeps(RUN1_AT);
  let checkedChild = false;
  probe.deps.emitRecord = async (stream, data) => {
   if (stream === "order_items") {
    checkedChild = true;
    assert.equal(validateRecord(stream, data).ok, !invalid, "fixture uses actual builder and schema");
   }
  };
  await emitOrderAndItems(probe.deps, list, detail, "2026-01-05");
  assert.equal(checkedChild, true);
  const runtime = makeEmitRecord({
   requested:new Map([["orders",{name:"orders"}],["order_items",{name:"order_items",resources:["different-child"]}]]),
   emittedAt:RUN1_AT,emit:harness.emit,isTombstone:undefined,timeRangeFieldFor:()=>null,
   validateRecord,
  });
  const deps:EmitDeps={...makeDeps(RUN1_AT,cursor).deps,emit:harness.emit,emitRecord:runtime.emit,
   isRecordSelected:runtime.isSelected,hydratedOrders:new Map(),orderItemsCoverage:newOrderItemsCoverage()};
  await processResolvedListOrder(deps,list,"2026-01-05",{detail,detailGapReason:"temporary_unavailable",detailFailureKind:null});
  assert.deepEqual(deps.orderItemsCoverage,{required:invalid?[list.orderId]:[],hydrated:[],gap:[]});
  assert.equal(deps.hydratedOrders?.size,0);
  assert.deepEqual(cursor.toState(),{});
  assert.equal(harness.protocolMessages.filter(m=>m.type==="RECORD"&&m.stream==="order_items").length,0);
 });
}

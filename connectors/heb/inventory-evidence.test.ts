// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { parseHTML } from "linkedom";
import {
	collectNutrition,
	collectProfile,
	fetchOrderDetail,
	newOrderItemsCoverage,
	processListOrder,
	recoverPendingOrderItemDetailGaps,
	runForwardScan,
} from "./index.ts";
import {
	type InventoryEvidence,
	inventoryIsComplete,
	inventoryMatchesSourceTotal,
} from "./inventory-evidence.ts";
import {
	inspectOrderListParsing,
	parseNutritionDom,
	parseOrderDetailDom,
	parseProfileDom,
} from "./parsers.ts";

function pageFor(html: string, landed?: string): Page {
	let url = "";
	return {
		goto: async (requested: string) => {
			url = landed ?? requested;
			return { ok: () => true };
		},
		url: () => url,
		content: async () => html,
		// Each outermost line is one row, keyed by document order, as the
		// browser function reports a complete snapshot.
		evaluate: async () => {
			const { document } = parseHTML(html);
			const lines = [...document.querySelectorAll("li")].filter(
				(li) => !li.parentElement?.closest("li"),
			);
			return {
				actionableControl: null,
				actionPerformed: null,
				atEnd: true,
				clientHeight: 100,
				loading: false,
				rowCount: lines.length,
				rows: lines.map((li, i) => ({
					key: `position:document-order=${i}`,
					html: li.outerHTML,
					unitCount: 1,
				})),
				scrollHeight: 100,
				scrollTop: 0,
				staticListEvidence: "declared_count",
			};
		},
		waitForTimeout: async () => {},
	} as unknown as Page;
}
const row =
	'<li data-index="0"><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a></li>';
function sink() {
	const messages: any[] = [];
	const records: { stream: string; data: any }[] = [];
	return {
		messages,
		records,
		emit: async (message: any) => {
			messages.push(message);
		},
		emitRecord: async (stream: string, data: any) => {
			records.push({ stream, data });
		},
		emittedAt: "2026-10-17T12:00:00Z",
		waitForHydration: async () => {},
	};
}
test("mounted rows and matching unit counts retain items without claiming inventory proof", async () => {
	const result = await fetchOrderDetail(pageFor(row), "HEB1", {
		expectedItemCount: 1,
		waitForHydration: async () => {},
		detailSurfaceTimeoutMs: 20,
	});
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.equal(result.detail.items.length, 1);
	assert.equal((result as any).inventoryComplete, false);
});
test("name-only profile is withheld as a retryable failed read", async () => {
	const deps = sink();
	await collectProfile(
		pageFor("<main><p>Name</p><p>Example Person</p></main>"),
		deps,
	);
	assert.equal(deps.records.length, 0);
	assert.ok(
		deps.messages.some(
			(m) =>
				m.reason === "stream_collection_failed" &&
				m.recovery_hint.retryable,
		),
	);
});
for (const [label, html, landed] of [
	["blank successful shell", "<main></main>", undefined],
	[
		"login response",
		'<form><input type="password"></form>',
		"https://www.heb.com/sign-in",
	],
	[
		"wrong product",
		"<main><h2>Nutrition Facts</h2></main>",
		"https://www.heb.com/product-detail/other/999",
	],
	[
		"loading panel",
		'<main aria-busy="true"><h2>Nutrition Facts</h2></main>',
		undefined,
	],
] as const) {
	test(`nutrition ${label} remains unknown and retryable`, async () => {
		const deps = sink();
		const target = {
			name: "Widget",
			productId: "500",
			productUrl: "https://www.heb.com/product-detail/widget/500",
		};
		if (label === "login response") {
			// A sign-in page is a session failure, not an unknown lookup.
			await assert.rejects(
				() => collectNutrition(pageFor(html, landed), [target], deps),
				{ message: "heb_session_required" },
			);
			assert.deepEqual(
				deps.messages.map((m) => m.reason),
				["session_repair_required"],
			);
			return;
		}
		const result = await collectNutrition(
			pageFor(html, landed),
			[target],
			deps,
		);
		assert.equal(result.lookupSkips, 1);
		assert.ok(
			deps.messages.some(
				(m) =>
					m.reason ===
					(label === "blank successful shell"
						? "inventory_not_proven_complete"
						: "stream_collection_failed"),
			),
		);
		assert.ok(deps.records.every((r) => r.data.source !== "not_found"));
	});
}
test("missing product URL is an unknown lookup, not definitive absence", async () => {
	const deps = sink();
	const result = await collectNutrition(
		pageFor(""),
		[{ name: "Widget", productId: "500", productUrl: null }],
		deps,
	);
	assert.equal(result.lookupSkips, 1);
	assert.equal(deps.records.length, 0);
});
test("an unread calorie value stays null", () => {
	const result = parseNutritionDom(
		"<main><div><h3>Nutrition Facts</h3><ul><li><span>Total Fat</span><ul><li>2g</li></ul></li></ul></div></main>",
	);
	assert.equal(result.calories, null);
});

const verified: InventoryEvidence = {
	entity: "order_items",
	ownerIdentity: "owner-1",
	signedInOwnerIdentity: "owner-1",
	requestedResource: "https://www.heb.com/my-account/order-history/HEB123456",
	landedResource: "https://www.heb.com/my-account/order-history/HEB123456",
	snapshotId: "synthetic-source-response",
	responseSucceeded: true,
	loading: false,
	coherent: true,
	sourceIds: ["line-1", "line-2"],
	acceptedIds: ["line-1", "line-2"],
	rejectedRows: 0,
	missingIdentityRows: 0,
	signal: { entity: "order_items", exactTotal: 2 },
};
test("an order's own server total proves its rows only when every row was read and they number exactly that total", () => {
	const read = {
		...verified,
		ownerIdentity: null,
		signedInOwnerIdentity: null,
		signal: null,
		lineCountProven: true,
	};
	assert.equal(inventoryIsComplete(read), false);
	assert.equal(inventoryMatchesSourceTotal(read, 2), true);
	for (const total of [null, 0, 1, 3, 2.5])
		assert.equal(inventoryMatchesSourceTotal(read, total), false, String(total));
	for (const invalid of [
		{ entity: "orders" },
		{ snapshotId: null },
		{ landedResource: "https://www.heb.com/other" },
		{ loading: true },
		{ responseSucceeded: null },
		{ coherent: false },
		{ rejectedRows: 1 },
		{ missingIdentityRows: 1 },
		{ acceptedIds: ["line-1"] },
		{ sourceIds: ["line-1", "line-1"] },
		{ lineCountProven: false },
		{ lineCountProven: undefined },
		{ linklessLines: 1 },
		{ multiNameLines: 1 },
		{ duplicateRecordIds: 1 },
	] as Partial<InventoryEvidence>[])
		assert.equal(
			inventoryMatchesSourceTotal({ ...read, ...invalid }, 2),
			false,
			JSON.stringify(invalid),
		);
});

test("the evidence contract accepts only an exact same-entity owner-bound source response", () => {
	assert.equal(inventoryIsComplete(verified), true);
	assert.equal(
		inventoryIsComplete({
			...verified,
			signal: { entity: "order_items", explicitEnd: true },
		}),
		true,
	);
	for (const invalid of [
		{ ownerIdentity: null },
		{ signedInOwnerIdentity: "other" },
		{ snapshotId: null },
		{ landedResource: "https://www.heb.com/other" },
		{ loading: true },
		{ responseSucceeded: null },
		{ coherent: false },
		{ rejectedRows: 1 },
		{ missingIdentityRows: 1 },
		{ acceptedIds: ["line-1"] },
		{ sourceIds: ["line-1", "line-1"] },
		{ signal: null },
		{ signal: { entity: "orders", exactTotal: 2 } },
		{ signal: { entity: "order_items", exactTotal: 1 } },
		{ signal: { entity: "order_items", exactTotal: 3 } },
	] as Partial<InventoryEvidence>[])
		assert.equal(
			inventoryIsComplete({ ...verified, ...invalid }),
			false,
			JSON.stringify(invalid),
		);
	assert.equal(
		inventoryIsComplete({
			...verified,
			sourceIds: [],
			acceptedIds: [],
			signal: { entity: "order_items", exactTotal: 0 },
		}),
		true,
	);
});
const itemRow = (id: number, name = "Widget", quantity = 1) =>
	`<li data-index="${id}"><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/${500 + id}">${name}</a><span data-qe-id="orderItemQty">Qty: ${quantity}</span></li>`;
function sequencePage(
	snapshots: {
		loading?: boolean;
		rows: { key: string; html: string; unitCount: number }[];
	}[],
): Page {
	let poll = 0;
	const page = pageFor(
		snapshots
			.at(-1)!
			.rows.map((r) => r.html)
			.join(""),
	);
	page.evaluate = (async () => {
		const snapshot = snapshots[Math.min(poll++, snapshots.length - 1)]!;
		return {
			actionableControl: null,
			actionPerformed: null,
			atEnd: true,
			clientHeight: 100,
			loading: snapshot.loading ?? false,
			rowCount: snapshot.rows.length,
			rows: snapshot.rows,
			scrollHeight: 100,
			scrollTop: 0,
			staticListEvidence: null,
		};
	}) as Page["evaluate"];
	return page;
}
test("loading observations are discarded before settled rows accumulate", async () => {
	const result = await fetchOrderDetail(
		sequencePage([
			{
				loading: true,
				rows: [
					{
						key: "position:data-index=0",
						html: itemRow(0, "Stale"),
						unitCount: 1,
					},
				],
			},
			{
				rows: [
					{
						key: "position:data-index=1",
						html: itemRow(1, "Settled"),
						unitCount: 1,
					},
				],
			},
		]),
		"HEB123456",
		{ waitForHydration: async () => {}, detailSurfaceTimeoutMs: 50 },
	);
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.deepEqual(
		result.detail.items.map((i) => i.name),
		["Settled"],
	);
	assert.equal(result.inventoryComplete, false);
});
test("mixed per-row identity schemes cannot prove a coherent inventory", async () => {
	const result = await fetchOrderDetail(
		sequencePage([
			{
				rows: [
					{ key: "position:data-index=0", html: itemRow(0), unitCount: 1 },
					{
						key: "content:href=/product-detail/widget/501",
						html: itemRow(1),
						unitCount: 1,
					},
				],
			},
		]),
		"HEB123456",
		{ waitForHydration: async () => {}, detailSurfaceTimeoutMs: 50 },
	);
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.equal(result.evidence.coherent, false);
	assert.equal(result.inventoryComplete, false);
	assert.equal(result.detail.items.length, 2);
});
test("continuous same-href quantity replacement is ambiguous, never a count proof", async () => {
	const key = "content:href=/product-detail/widget/500";
	const result = await fetchOrderDetail(
		sequencePage([
			{ rows: [{ key, html: itemRow(0, "Widget", 1), unitCount: 1 }] },
			{ rows: [{ key, html: itemRow(0, "Widget", 2), unitCount: 2 }] },
		]),
		"HEB123456",
		{ waitForHydration: async () => {}, detailSurfaceTimeoutMs: 50 },
	);
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.equal(result.evidence.coherent, false);
	assert.equal(result.inventoryComplete, false);
	assert.equal(result.detail.items[0]?.quantity, 1);
});
const flags = () => ({
	detailAttempts: 0,
	isManualRun: false,
	manualRepairAttempted: false,
	sessionRepairRequired: false,
});
const order = {
	orderId: "HEB123456",
	orderDateRaw: "July 14, 2026",
	fulfillmentLocation: null,
	fulfillmentMethod: "unknown" as const,
	itemCount: 2,
	status: null,
	statusCode: null,
	storeName: null,
	timeslotEnd: null,
	timeslotStart: null,
	total: null,
	unfulfilledCount: null,
	source: "dom" as const,
};
for (const [label, bad] of [
	["missing name", itemRow(1, "")],
	[
		"missing identity",
		'<li data-index="1"><a data-qe-id="itemRowDetailsName">Unread identity</a></li>',
	],
	["schema rejection", itemRow(1, "Quantity: invalid field leakage")],
] as const) {
	for (const recovery of [false, true])
		test(`${recovery ? "recovery" : "fresh"} preserves valid rows after ${label} without a receipt`, async () => {
			const deps = sink();
			const html = itemRow(0) + bad;
			const page = pageFor(html);
			const coverage = newOrderItemsCoverage();
			if (recovery) {
				const result = await recoverPendingOrderItemDetailGaps(
					page,
					{
						...deps,
						sendInteraction: async () => {
							throw new Error("unexpected interaction");
						},
						detailSurfaceTimeoutMs: 50,
						detailGaps: [
							{
								detail_locator: {
									kind: "heb.order_detail",
									order_id: order.orderId,
									order_date: "2026-07-14",
								},
								gap_id: "gap-test",
								record_key: order.orderId,
								reference_only: true,
								status: "pending",
								stream: "order_items",
							},
						],
					},
					flags(),
				);
				assert.equal(result.recovered, 0);
				assert.equal(result.stoppedWithPending, true);
			} else {
				await processListOrder(
					page,
					{
						...deps,
						detailSurfaceTimeoutMs: 50,
						emitItems: true,
						wantsItems: true,
						wantsOrders: true,
						orderItemsCoverage: coverage,
						ordersCoverage: undefined,
						ordersFingerprintCursor: undefined,
						progress: async () => {},
						sendInteraction: async () => {
							throw new Error("unexpected interaction");
						},
					},
					flags(),
					order,
				);
				assert.equal(coverage.hydrated.length, 0);
			}
			assert.equal(
				deps.records.filter((r) => r.stream === "order_items").length,
				1,
			);
			assert.ok(
				deps.messages.some((m) => m.reason === "inventory_not_proven_complete"),
			);
			assert.ok(deps.messages.some((m) => m.type === "DETAIL_GAP"));
			assert.ok(
				deps.messages.every(
					(m) =>
						!["STATE", "DETAIL_GAP_RECOVERED", "DETAIL_COVERAGE"].includes(
							m.type,
						),
				),
			);
		});
}
/** A synthetic order-detail page as H-E-B renders it for the signed-in owner
 * (shape captured live on 2026-11-18; every value here is invented). */
const detailPage = (opts: { lines: number; orderId?: string; control?: boolean }) => {
	const data = {
		page: "/my-account/order-history/[orderId]",
		gssp: true,
		props: {
			__N_SSP: true,
			pageProps: {
				order: {
					orderId: opts.orderId ?? order.orderId,
					orderItems: Array.from({ length: opts.lines }, (_, i) => ({
						sequenceNumber: i + 1,
						quantity: 1,
						product: { id: String(500 + i) },
					})),
				},
			},
		},
	};
	return `${itemRow(0)}${itemRow(1)}${opts.control === false ? "" : '<section data-qe-id="orderSummaryCard"></section>'}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
};
for (const recovery of [false, true]) {
	const read = async (html: string) => {
		const deps = sink();
		const coverage = newOrderItemsCoverage();
		const noInteraction = async () => {
			throw new Error("unexpected interaction");
		};
		const recovered = recovery
			? (
					await recoverPendingOrderItemDetailGaps(
						pageFor(html),
						{
							...deps,
							sendInteraction: noInteraction,
							detailSurfaceTimeoutMs: 50,
							detailGaps: [
								{
									detail_locator: {
										kind: "heb.order_detail",
										order_id: order.orderId,
										order_date: "2026-07-14",
									},
									gap_id: "gap-test",
									record_key: order.orderId,
									reference_only: true,
									status: "pending",
									stream: "order_items",
								},
							],
						},
						flags(),
					)
				).recovered
			: (await processListOrder(
					pageFor(html),
					{
						...deps,
						detailSurfaceTimeoutMs: 50,
						emitItems: true,
						wantsItems: true,
						wantsOrders: true,
						orderItemsCoverage: coverage,
						ordersCoverage: undefined,
						ordersFingerprintCursor: undefined,
						progress: async () => {},
						sendInteraction: noInteraction,
					},
					flags(),
					order,
				),
				coverage.hydrated.length);
		return { deps, recovered };
	};
	const mode = recovery ? "recovery" : "fresh read";
	test(`${mode}: an order whose server payload reports exactly its read rows is complete`, async () => {
		const { deps, recovered } = await read(detailPage({ lines: 2 }));
		assert.equal(recovered, 1);
		assert.equal(deps.records.filter((r) => r.stream === "order_items").length, 2);
		assert.ok(deps.messages.every((m) => m.type !== "DETAIL_GAP"));
		assert.ok(deps.messages.every((m) => m.reason !== "inventory_not_proven_complete"));
		if (recovery)
			assert.ok(deps.messages.some((m) => m.type === "DETAIL_GAP_RECOVERED"));
	});
	for (const [label, html] of [
		["a server total above the rows read", detailPage({ lines: 3 })],
		["a server total below the rows read", detailPage({ lines: 1 })],
		["another order's payload", detailPage({ lines: 2, orderId: "HEB999999" })],
		["no signed-in summary card", detailPage({ lines: 2, control: false })],
		["no server payload", itemRow(0) + itemRow(1)],
		["a rejected row", `${detailPage({ lines: 3 })}${itemRow(2, "")}`],
	] as const)
		test(`${mode}: ${label} keeps the order's rows and its pending gap`, async () => {
			const { deps, recovered } = await read(html);
			assert.equal(recovered, 0);
			assert.ok(deps.records.some((r) => r.stream === "order_items"));
			assert.ok(deps.messages.some((m) => m.type === "DETAIL_GAP"));
			assert.ok(deps.messages.every((m) => m.type !== "DETAIL_GAP_RECOVERED"));
		});
}

test("parser reports observed rows and losses, including malformed list identities", () => {
	const detail = parseOrderDetailDom(itemRow(0) + itemRow(1, ""));
	assert.equal(detail?.parsing?.observedRows, 2);
	assert.equal(detail?.parsing?.rejectedRows, 1);
	assert.equal(detail?.items.length, 1);
	const list = inspectOrderListParsing(
		'<script id="__NEXT_DATA__">{"props":{"pageProps":{"orders":[{"orderId":"HEB123456"},{}]}}}</script>',
	);
	assert.deepEqual(list.sourceIds, ["HEB123456"]);
	assert.equal(list.missingIdentityRows, 1);
});
test("unread address inventory and primary status remain unknown", () => {
	assert.equal(
		parseProfileDom("<main><p>Name</p><p>Reader</p></main>").deliveryAddresses,
		null,
	);
	const extraction = parseProfileDom(
		"<main><div><div><p>Austin, TX 78701</p></div></div></main>",
	);
	assert.equal(extraction.deliveryAddresses?.[0]?.is_primary, null);
});
for (const html of [
	'<main><p>Name</p><p>Reader</p><div aria-busy="true">Loading addresses</div></main>',
	"<main><p>Name</p><p>Reader</p><p>No delivery addresses</p></main>",
])
	test("address text without owner-bound complete profile evidence cannot replace an aggregate", async () => {
		const deps = sink();
		await collectProfile(pageFor(html), deps);
		assert.equal(deps.records.length, 0);
		assert.ok(
			deps.messages.some((m) => m.reason === "stream_collection_failed"),
		);
	});
test("literal zero calories stays zero; absent serving values stay null", () => {
	const extraction = parseNutritionDom(
		"<div><h3>Nutrition Facts</h3><ul><li>Calories 0</li></ul><div>Serving Size</div></div>",
	);
	assert.equal(extraction.calories, 0);
	assert.equal(extraction.servingSize, null);
});
test("ingredients are independent of a nutrition panel", () => {
	const extraction = parseNutritionDom(
		"<main><h4>Ingredients</h4><p>Water</p></main>",
	);
	assert.equal(extraction.ingredients, "Water");
	assert.equal(extraction.found, false);
});
test("safe independent product fields are emitted while panel absence stays retryable", async () => {
	const deps = sink();
	const result = await collectNutrition(
		pageFor("<main><h4>Ingredients</h4><p>Water</p></main>"),
		[
			{
				productId: "500",
				productUrl: "https://www.heb.com/product-detail/widget/500",
				name: "Water",
			},
		],
		deps,
	);
	assert.equal(result.lookupSkips, 1);
	assert.equal(deps.records[0]?.data.ingredients, "Water");
	assert.equal(deps.records[0]?.data.source, "error");
});

test("debug diagnostics do not sample away a third large order or a small order", async () => {
	const previous = process.env.HEB_DETAIL_SURFACE_DEBUG;
	process.env.HEB_DETAIL_SURFACE_DEBUG = "1";
	try {
		const deps = sink();
		const list =
			"<main>" +
			[84, 84, 84, 1]
				.map(
					(count, i) =>
						`<a href="/my-account/order-history/HEB12345${i}">July 14, 2026 $10.00, ${count} items</a>`,
				)
				.join("") +
			'<nav aria-label="Pagination"><a href="?page=1">1</a></nav></main>';
		let current = "";
		const page = pageFor(row);
		page.goto = (async (url: string) => {
			current = url;
			return { ok: () => true };
		}) as Page["goto"];
		page.url = () => current;
		page.content = async () => (current.includes("your-orders") ? list : row);
		page.waitForSelector = (async () =>
			null) as unknown as Page["waitForSelector"];
		const coverage = newOrderItemsCoverage();
		const result = await runForwardScan(
			page,
			{
				...deps,
				detailSurfaceTimeoutMs: 50,
				emitItems: true,
				wantsItems: true,
				wantsOrders: true,
				orderItemsCoverage: coverage,
				ordersCoverage: undefined,
				ordersFingerprintCursor: undefined,
				progress: async () => {},
				sendInteraction: async () => {
					throw new Error("unexpected interaction");
				},
			},
			flags(),
			null,
		);
		assert.equal(deps.records.filter((r) => r.stream === "orders").length, 4);
		assert.equal(
			deps.records.filter((r) => r.stream === "order_items").length,
			4,
		);
		assert.equal(inventoryIsComplete(result.evidence), false);
		assert.equal(coverage.hydrated.length, 0);
		assert.equal(coverage.gap.length, 4);
	} finally {
		if (previous === undefined) delete process.env.HEB_DETAIL_SURFACE_DEBUG;
		else process.env.HEB_DETAIL_SURFACE_DEBUG = previous;
	}
});

test("missing ingredient sibling is unknown, never the heading itself", () => {
	assert.equal(
		parseNutritionDom("<main><h4>Ingredients</h4></main>").ingredients,
		null,
	);
});
test("an empty nutrition panel shell is an unknown lookup", async () => {
	const deps = sink();
	const result = await collectNutrition(
		pageFor("<main><div><h3>Nutrition Facts</h3></div></main>"),
		[
			{
				productId: "500",
				productUrl: "https://www.heb.com/product-detail/widget/500",
				name: "Widget",
			},
		],
		deps,
	);
	assert.equal(result.lookupSkips, 1);
	assert.equal(deps.records.length, 0);
});
test("a browser row count that disagrees with the parsed html does not prove an order's lines", async () => {
	const html = detailPage({ lines: 1 });
	const page = {
		...pageFor(html),
		// One reported row whose html holds two outer lines.
		evaluate: async () => ({
			actionableControl: null,
			actionPerformed: null,
			atEnd: true,
			clientHeight: 100,
			loading: false,
			rowCount: 1,
			rows: [
				{
					key: "position:document-order=0",
					html: `<ul>${itemRow(0)}${itemRow(1)}</ul>`,
					unitCount: 1,
				},
			],
			scrollHeight: 100,
			scrollTop: 0,
			staticListEvidence: "declared_count",
		}),
	} as unknown as Page;
	const result = await fetchOrderDetail(page, order.orderId, {
		waitForHydration: async () => {},
		detailSurfaceTimeoutMs: 50,
	});
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.equal(result.sourceItemTotal, 1);
	assert.equal(result.evidence.lineCountProven, false);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, result.sourceItemTotal), false);
});
for (const [label, lineHtml] of [
	[
		"one line with two name links for the same product",
		'<li><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a><span data-qe-id="orderItemQty">Qty: 1</span></li>',
	],
	[
		"a substitute line without its own name link",
		'<li><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a><span data-qe-id="orderItemQty">Qty: 1</span><ul><li><span data-qe-id="orderItemQty">Qty: 1</span></li></ul></li>',
	],
	[
		"a line without its own name link whose substitute has one",
		'<li><span data-qe-id="orderItemQty">Qty: 1</span><ul><li><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/501">Substitute</a><span data-qe-id="orderItemQty">Qty: 1</span></li></ul></li>',
	],
] as const)
	test(`${label} does not prove an order's lines`, async () => {
		const html = detailPage({ lines: 1 }).replace(itemRow(0) + itemRow(1), lineHtml);
		const result = await fetchOrderDetail(pageFor(html), order.orderId, {
			waitForHydration: async () => {},
			detailSurfaceTimeoutMs: 50,
		});
		assert.equal(result.status, "hydrated");
		if (result.status !== "hydrated") return;
		assert.equal(result.sourceItemTotal, 1);
		assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, result.sourceItemTotal), false);
	});
test("a substituted line with one name link per line proves its one source line", async () => {
	const html = detailPage({ lines: 1 }).replace(
		itemRow(0) + itemRow(1),
		'<li><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a><span data-qe-id="orderItemQty">Qty: 1</span><ul><li><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/501">Substitute</a><span data-qe-id="orderItemQty">Qty: 1</span></li></ul></li>',
	);
	const result = await fetchOrderDetail(pageFor(html), order.orderId, {
		waitForHydration: async () => {},
		detailSurfaceTimeoutMs: 50,
	});
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.equal(result.detail.items.length, 2);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, result.sourceItemTotal), true);
});
test("two lines whose records would share one id do not prove an order's lines", async () => {
	const line = (quantity: number) =>
		`<li data-index="0"><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a><span data-qe-id="orderItemQty">Qty: ${quantity}</span></li>`;
	const html = detailPage({ lines: 2 }).replace(itemRow(0) + itemRow(1), line(1) + line(2));
	const result = await fetchOrderDetail(pageFor(html), order.orderId, {
		waitForHydration: async () => {},
		detailSurfaceTimeoutMs: 50,
	});
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") return;
	assert.equal(result.detail.items.length, 2);
	assert.equal(result.evidence.duplicateRecordIds, 1);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, result.sourceItemTotal), false);
});

for (const [label, image, name, copies, expected] of [
	["image", "501", "", 1, true],
	["text", "999", "  ssr   name ", 1, true],
	["conflict", "501", "Other", 1, false],
	["reused", "501", "", 2, false],
	["unknown", "999", "Unknown", 1, false],
	["nested", "501", "SSR Name", 1, false],
] as const) {
	test(`linkless SSR resolution: ${label}`, async () => {
		const extra = label === "conflict" || label === "reused";
		const items = [
			{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1 },
			{ product: { id: "501", fullDisplayName: "SSR Name" }, quantity: 1 },
			...(extra ? [{ product: { id: "502", fullDisplayName: "Other" }, quantity: 1 }] : []),
		];
		const line = `<li><img src="https://images.heb.com/is/image/HEBGrocery/prd-small/${image.padStart(9, "0")}.jpg"><p>${name}</p><span data-qe-id="orderItemQty">Qty: 3</span><span data-qe-id="checkoutItemPrice">$6.00</span></li>`;
		const rows = label === "nested" ? itemRow(0).replace("</li>", `<ul>${line}</ul></li>`) : itemRow(0) + line.repeat(copies);
		const data = { page: "/my-account/order-history/[orderId]", gssp: true, props: { __N_SSP: true, pageProps: { order: { orderId: order.orderId, orderItems: items } } } };
		const html = rows + '<section data-qe-id="orderSummaryCard"></section>' + `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
		const result = await fetchOrderDetail(pageFor(html), order.orderId, { waitForHydration: async () => {}, detailSurfaceTimeoutMs: 50 });
		assert.equal(result.status, "hydrated");
		if (result.status !== "hydrated") return;
		assert.equal(result.evidence.linklessLines, expected ? 0 : 1);
		assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), expected);
		if (expected) {
			assert.equal(result.detail.items[1]?.name, "SSR Name");
			assert.equal(result.detail.items[1]?.quantity, 3);
			assert.equal(result.detail.items[1]?.lineTotal, "$6.00");
		}
	});
}

async function resolveLinkless(items: unknown[], rows: string) {
	const data = { page: "/my-account/order-history/[orderId]", gssp: true, props: { __N_SSP: true, pageProps: { order: { orderId: order.orderId, orderItems: items } } } };
	const html = rows + '<section data-qe-id="orderSummaryCard"></section>' + `<script id="__NEXT_DATA__">${JSON.stringify(data)}</script>`;
	const result = await fetchOrderDetail(pageFor(html), order.orderId, { waitForHydration: async () => {}, detailSurfaceTimeoutMs: 50 });
	assert.equal(result.status, "hydrated");
	if (result.status !== "hydrated") throw new Error("not hydrated");
	return result;
}
const linklessLine = (image: string, name = "") =>
	`<li><img src="https://images.heb.com/is/image/HEBGrocery/prd-small/${image.padStart(9, "0")}.jpg"><p>${name}</p><span data-qe-id="orderItemQty">Qty: 3</span></li>`;

test("a linked substitute named under subbedProducts[].product.id claims its SSR item before a linkless line can", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1 },
		{ product: { id: "777", fullDisplayName: "Original" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "502", fullDisplayName: "Gone" }, quantity: 1 },
	];
	const result = await resolveLinkless(items, itemRow(0) + itemRow(1) + linklessLine("777", "Original"));
	assert.equal(result.evidence.linklessLines, 1);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), false);
});

test("a resolved line keeps the SSR product page URL only when it is an heb.com product page for that id", async () => {
	for (const [productPageURL, expected] of [
		["/product-detail/ssr-name/501", "https://www.heb.com/product-detail/ssr-name/501"],
		["https://www.heb.com/product-detail/ssr-name/501", "https://www.heb.com/product-detail/ssr-name/501"],
		["https://example.test/product-detail/ssr-name/501", null],
		["/product-detail/ssr-name/999", null],
		[null, null],
	] as const) {
		const items = [
			{ product: { id: "500", fullDisplayName: null }, quantity: 1 },
			{ product: { id: "501", fullDisplayName: "SSR Name", productPageURL }, quantity: 1 },
		];
		const result = await resolveLinkless(items, itemRow(0) + linklessLine("501"));
		assert.equal(result.evidence.linklessLines, 0, String(productPageURL));
		assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), true);
		assert.equal(result.detail.items[1]?.productId, "501");
		assert.equal(result.detail.items[1]?.productUrl, expected, String(productPageURL));
	}
});

test("an SSR item without a name cannot become a record for a linkless line", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1 },
		{ product: { id: "501", fullDisplayName: null }, quantity: 1 },
	];
	const result = await resolveLinkless(items, itemRow(0) + linklessLine("501"));
	assert.equal(result.evidence.linklessLines, 1);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), false);
});

test("an order with a substitute still resolves its linkless line from the item left over", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1 },
		{ product: { id: "777", fullDisplayName: "Original" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "502", fullDisplayName: "Left Over" }, quantity: 1 },
	];
	const result = await resolveLinkless(items, itemRow(0) + itemRow(1) + linklessLine("502"));
	assert.equal(result.evidence.linklessLines, 0);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), true);
	assert.equal(result.detail.items[2]?.name, "Left Over");
});

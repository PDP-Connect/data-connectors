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
import { orderItemsSchema } from "./schemas.ts";
import {
	type InventoryEvidence,
	inventoryIsComplete,
	inventoryMatchesSourceTotal,
} from "./inventory-evidence.ts";
import {
	buildOrderItemRecord,
	orderItemId,
	inspectOrderListParsing,
	parseNutritionDom,
	parseOrderDetailDom,
	parseProfileDom,
	resolveLinklessOrderItems,
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
					// As the browser function wraps a row in its department section.
					html: ((title) => title ? `<section><h2 data-qe-id="orderDetailsGroupTitle">${title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</h2>${li.outerHTML}</section>` : li.outerHTML)(li.closest("section")?.querySelector('[data-qe-id="orderDetailsGroupTitle"]')?.textContent),
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
	["unknown", "999", "Unknown", 1, true],
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
	const cases = [
		["/product-detail/ssr-name/501", "https://www.heb.com/product-detail/ssr-name/501"],
		["https://www.heb.com/product-detail/ssr-name/501", "https://www.heb.com/product-detail/ssr-name/501"],
		["https://example.test/product-detail/ssr-name/501", null],
		["/product-detail/ssr-name/999", null],
		[null, null],
	] as const;
	const results = await Promise.all(
		cases.map(([productPageURL]) =>
			resolveLinkless(
				[
					{ product: { id: "500", fullDisplayName: null }, quantity: 1 },
					{ product: { id: "501", fullDisplayName: "SSR Name", productPageURL }, quantity: 1 },
				],
				itemRow(0) + linklessLine("501"),
			),
		),
	);
	for (const [index, [productPageURL, expected]] of cases.entries()) {
		const result = results[index]!;
		assert.equal(result.evidence.linklessLines, 0, String(productPageURL));
		assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, 2), true);
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

test("a linkless line's key that names a claimed SSR item still contradicts its other key", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1 },
		{ product: { id: "501", fullDisplayName: "Other" }, quantity: 1 },
	];
	const [imageClaimed, textClaimed] = await Promise.all([
		resolveLinkless(items, itemRow(0) + linklessLine("500", "Other")),
		resolveLinkless(items, itemRow(0) + linklessLine("501", "Widget")),
	]);
	for (const result of [imageClaimed, textClaimed]) {
		assert.equal(result.evidence.linklessLines, 1);
		assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), false);
	}
});

test("a linked line that takes no SSR item leaves every linkless line unresolved", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1 },
		{ product: { id: "501", fullDisplayName: "Missing" }, quantity: 1 },
		{ product: { id: "502", fullDisplayName: "Other" }, quantity: 1 },
	];
	const repeatedLink = itemRow(0).replace('data-index="0"', 'data-index="7"');
	const [repeated, absent] = await Promise.all([
		resolveLinkless(items, itemRow(0) + repeatedLink + linklessLine("502")),
		resolveLinkless(items, itemRow(0) + itemRow(499) + linklessLine("502")),
	]);
	for (const result of [repeated, absent]) {
		assert.equal(result.evidence.linklessLines, 1);
		assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), false);
	}
});

test("a shared substitute cannot let a linked line take an SSR item whose original it contradicts", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "600", fullDisplayName: "Hidden" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "502", fullDisplayName: "Other" }, quantity: 1 },
	];
	const substituted = (index: number) => itemRow(0).replace('data-index="0"', `data-index="${index}"`)
		.replace("</li>", `<ul>${itemRow(1).replace('data-index="1"', `data-index="${index + 50}"`)}</ul></li>`);
	const result = await resolveLinkless(items, substituted(0) + substituted(1) + linklessLine("502"));
	assert.equal(result.evidence.linklessLines, 1);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), false);
});

test("linked lines are matched one-to-one, so a substitute-only line ahead of its original does not block the order", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "600", fullDisplayName: "Gadget" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "502", fullDisplayName: "Other" }, quantity: 1 },
	];
	const substituteOnly = itemRow(1).replace('data-index="1"', 'data-index="10"');
	const originalWithSubstitute = itemRow(0).replace("</li>", `<ul>${itemRow(1).replace('data-index="1"', 'data-index="60"')}</ul></li>`);
	const result = await resolveLinkless(items, substituteOnly + originalWithSubstitute + linklessLine("502"));
	assert.equal(result.evidence.linklessLines, 0);
	assert.ok(result.detail.items.some((item) => item.productId === "502" && item.name === "Other"));
});

test("a linkless line stays unresolved when which SSR item is left over depends on how linked lines are matched", async () => {
	const items = [
		{ product: { id: "500", fullDisplayName: "Widget" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
		{ product: { id: "600", fullDisplayName: "Gadget" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] },
	];
	const result = await resolveLinkless(items, itemRow(1) + linklessLine("600"));
	assert.equal(result.evidence.linklessLines, 1);
	assert.equal(inventoryMatchesSourceTotal({ ...result.evidence, acceptedIds: result.evidence.sourceIds }, items.length), false);
});

const unrelatedLine = () => `<li><img src="https://example.test/unrelated.jpg"><p>Unrelated label</p><span data-qe-id="orderItemQty">Qty: 3</span><span data-qe-id="checkoutItemPrice">$6.00</span></li>`;
const ssrItem = (id: string, quantity = 1) => ({ product: { id, fullDisplayName: `SSR ${id}` }, quantity });
test("elimination resolves one unmatched line using its own quantity and price", async () => {
 const r = await resolveLinkless([ssrItem("500"), ssrItem("501", 7)], itemRow(0) + unrelatedLine());
 assert.equal(r.evidence.linklessLines, 0);
 assert.equal(r.detail.items[1]?.productId, "501");
 assert.equal(r.detail.items[1]?.quantity, 3);
 assert.equal(r.detail.items[1]?.lineTotal, "$6.00");
});
test("multiple unmatched lines resolve the SSR inventory, not an invented line pairing", async () => {
 const r = await resolveLinkless([ssrItem("500"), ssrItem("501", 7), ssrItem("502", 9)], itemRow(0) + unrelatedLine().repeat(2));
 assert.equal(r.evidence.linklessLines, 0);
 assert.deepEqual(r.detail.items.slice(1).map(({ productId, quantity, lineTotal, imageUrl, department, productUrl }) => ({ productId, quantity, lineTotal, imageUrl, department, productUrl })), [
  { productId: "501", quantity: 7, lineTotal: null, imageUrl: null, department: null, productUrl: null },
  { productId: "502", quantity: 9, lineTotal: null, imageUrl: null, department: null, productUrl: null },
 ]);
});
test("a linked unmatched id uses only its own image ids and keeps its record id", async () => {
 const results = await Promise.all([
  "https://images.heb.com/is/image/HEBGrocery/prd-small/000000500.jpg",
  "https://images.heb.com/is/image/HEBGrocery/000000500-1",
 ].map(src => resolveLinkless([ssrItem("500"), ssrItem("501")], itemRow(499).replace("</li>", `<img src="${src}"></li>`) + unrelatedLine())));
 for (const r of results) {
  assert.equal(r.evidence.linklessLines, 0);
  assert.equal(r.detail.items[0]?.productId, "999");
  assert.equal(r.detail.items[1]?.productId, "501");
 }
});
test("elimination refuses count mismatch, claimed keys, nested-only images and overfull linked ledger", async () => {
 const results = await Promise.all([
  resolveLinkless([ssrItem("500"), ssrItem("501"), ssrItem("502")], itemRow(0) + unrelatedLine()),
  resolveLinkless([ssrItem("500"), ssrItem("501")], itemRow(0) + linklessLine("500")),
  resolveLinkless([ssrItem("500"), ssrItem("501")], itemRow(499).replace("</li>", '<ul><li><img src="https://images.heb.com/is/image/HEBGrocery/000000500-1"></li></ul></li>') + unrelatedLine()),
  resolveLinkless(Array.from({length:45}, (_,i)=>ssrItem(String(500+i))), Array.from({length:46}, (_,i)=>itemRow(i)).join("") + unrelatedLine()),
 ]);
 for (const r of results) assert.equal(r.evidence.linklessLines, 1);
});
test("a linkless image naming a claimed item's substitute blocks elimination", async () => {
	const r = await resolveLinkless(
		[{ ...ssrItem("500"), subbedProducts: [{ id: "777" }] }, ssrItem("501")],
		itemRow(0) + linklessLine("777"),
	);
	assert.equal(r.evidence.linklessLines, 1);
});

test("a linkless image naming a claimed item's numeric substitute blocks elimination", async () => {
	const results = await Promise.all([
		resolveLinkless([{ ...ssrItem("500"), subbedProducts: [{ id: 777 }] }, ssrItem("501")], itemRow(0) + linklessLine("777")),
		resolveLinkless([{ ...ssrItem("500"), subbedProducts: [{ product: { id: 777 } }] }, ssrItem("501")], itemRow(0) + linklessLine("777")),
	]);
	for (const r of results) assert.equal(r.evidence.linklessLines, 1);
});

test("a linked line's H-E-B image in a size folder with digits or underscores fits its SSR item", async () => {
	const r = await resolveLinkless(
		[ssrItem("500"), ssrItem("501")],
		itemRow(499).replace("</li>", '<img src="https://images.heb.com/is/image/HEBGrocery/prd_medium2/000000500.jpg"></li>') + unrelatedLine(),
	);
	assert.equal(r.evidence.linklessLines, 0);
	assert.equal(r.detail.items[1]?.productId, "501");
});

test("the diagnostic names why elimination refused: a line naming a claimed item, or an unnamed left-over item", async () => {
	const [claimedText, unnamed] = await Promise.all([
		resolveLinkless([ssrItem("500"), ssrItem("501")], itemRow(0) + linklessLine("999", "SSR 500")),
		resolveLinkless([ssrItem("500"), { product: { id: "501" }, quantity: 1 }], itemRow(0) + linklessLine("999")),
	]);
	assert.equal(claimedText.evidence.linklessLines, 1);
	assert.match(claimedText.linklessTrace ?? "", /elim:0;stop=unsafe;why=txt_claimed:1;ll_img=heb_image\/hebgrocery_id\/jpg(;|$)/);
	assert.equal(unnamed.evidence.linklessLines, 1);
	assert.match(unnamed.linklessTrace ?? "", /elim:0;stop=unnamed;nameless_held=[a-z_]+(?::[^;]*)?;why=none:1;ll_img=/);
	assert.doesNotMatch(`${claimedText.linklessTrace}${unnamed.linklessTrace}`, /500|501|999|SSR/);
});

test("the gap message carries only fixed codes and counts: no DOM ids, no SSR key names, no text", async () => {
	const line = '<li><img src="https://www.heb.com/static/invented.svg" alt="Invented Bakery Loaf"><div><span data-qe-id="itemRowDetailsName">Invented Bakery Loaf</span><p></p></div>' +
		'<span data-qe-id="orderItemQty">Qty: 2</span><span data-qe-id="checkoutItemPrice">$6.00</span><span data-qe-id="item4417">12</span></li>';
	const reads = await Promise.all([
		resolveLinkless([ssrItem("500"), { product: { id: "501", fullDisplayName: null, displayName: "Invented Bakery Loaf", brand: { name: "Invented Kitchen" }, OrganicLoaf: "x", item4417: { label: "x" } }, quantity: 1 }],
			itemRow(0) + linklessLine("999", "Invented Bakery Loaf")),
		resolveLinkless([ssrItem("500"), { product: { id: "501", fullDisplayName: "  ", longName: "Invented Bakery Loaf, Sliced" }, quantity: 1 }],
			itemRow(0) + linklessLine("999", "Invented Bakery Loaf")),
		resolveLinkless([ssrItem("500"), { product: { id: "501", fullDisplayName: "" }, quantity: 2, totalLineItemPricePaid: { formattedAmount: "$6.00" } }], itemRow(0) + line),
	]);
	for (const r of reads) {
		assert.equal(r.evidence.linklessLines, 1);
		const trace = r.linklessTrace ?? "";
		assert.match(trace, /;stop=unnamed;nameless_held=(?:naming_key|naming_attr|text|qty|total|pairing|count|scan_incomplete)(?::[^;]*)?;why=/);
		assert.doesNotMatch(trace, /ll_dom|;un=|un_hit|un_sub|un_keys|qe|span|itemRow/);
		assert.doesNotMatch(trace, /Invented|Bakery|Kitchen|Sliced|Organic|displayName|longName|brand|item4417|4417|500|501|999|6\.00/);
	}
});

test("SSR items whose product id is a number or whose quantity is missing still resolve", async () => {
	const results = await Promise.all([
		resolveLinkless([ssrItem("500"), { product: { id: 501, fullDisplayName: "SSR 501" }, quantity: 1 }], itemRow(0) + unrelatedLine()),
		resolveLinkless([ssrItem("500"), { product: { id: "501", fullDisplayName: "SSR 501" } }], itemRow(0) + unrelatedLine()),
	]);
	for (const r of results) {
		assert.equal(r.evidence.linklessLines, 0);
		assert.equal(r.detail.items[1]?.productId, "501");
	}
});

test("a linked line's prd-medium H-E-B image id fits its SSR item", async () => {
	const r = await resolveLinkless(
		[ssrItem("500"), ssrItem("501")],
		itemRow(499).replace("</li>", '<img src="https://images.heb.com/is/image/HEBGrocery/prd-medium/000000500.jpg?v=2"></li>') + unrelatedLine(),
	);
	assert.equal(r.evidence.linklessLines, 0);
	assert.equal(r.detail.items[1]?.productId, "501");
});

test("the detail diagnostic says which linkless step refused, in counts and shapes only", async () => {
	const [countMismatch, unfit, unread] = await Promise.all([
		resolveLinkless([ssrItem("500"), ssrItem("501"), ssrItem("502")], itemRow(0) + unrelatedLine()),
		resolveLinkless([ssrItem("500"), ssrItem("501")], itemRow(499).replace("</li>", '<img src="https://cdn.example.test/p/widget-name_000000500.png"><img src="https://images.heb.com/is/image/HEBGrocery/prd-small/000000999.jpg"></li>') + unrelatedLine()),
		resolveLinkless([{ product: { fullDisplayName: "No id" }, quantity: 1 }], itemRow(0)),
	]);
	const diag = (r: { linklessTrace?: string }): string => r.linklessTrace ?? "";
	assert.match(diag(countMismatch), /linkless_trace=ssr:3,linked:1,unfit:0,by_img:0,ledger:complete,linkless:1,keyed:0,remaining:1,unclaimed:2,elim:0/);
	assert.match(diag(countMismatch), /elim:0;stop=count;why=none:1;ll_img=other_host\/other_path\/jpg(;|$)/);
	assert.match(diag(unfit), /linkless_trace=ssr:2,linked:1,unfit:1,by_img:0,ledger:unplaced,linkless:1,/);
	assert.match(diag(unfit), /unfit_img=other_host\/other_path\/png\+heb_image\/hebgrocery_id\/jpg(;|$)/);
	assert.doesNotMatch(diag(unfit), /500|999|widget|cdn|example/i);
	assert.match(diag(unread), /ssr=unread:order\.orderItems\.#\.product\.id:invalid_union/);
});


// ─── lines H-E-B serves with no name ──────────────────────────────────────
// Invented data in the shape seen live: a weighed line whose sentence has an
// empty name slot, an empty-alt img, a price span, one more text span and a
// quantity span; one order adds a price span after the price.
const realLine = (o: { ordered: number; actualText: string; total: string; second?: string; extraPrice?: string; attrs?: string; text?: string }) =>
	`<li><span class="visuallyHidden"${o.attrs ?? ""}>Item, . Quantity: ${o.ordered} lb. Price: ${o.total}.</span><img src="https://www.heb.com/static/invented.svg" alt=""><span data-qe-id="checkoutItemPrice">${o.total}</span>` +
	`${o.extraPrice ? `<span>${o.extraPrice}</span>` : ""}<span>${o.second ?? "Avg. 1.2 lb"}</span><span data-qe-id="orderItemQty">${o.actualText}</span>${o.text ?? ""}</li>`;
const nlLine = (quantity: number, total: string) => realLine({ ordered: quantity, actualText: `Qty: ${quantity} lb`, total });
const nlSsr = (total: string, quantity: number | null, product: Record<string, unknown> = { fullDisplayName: "" }) =>
	({ product, quantity, totalLineItemPricePaid: { formattedAmount: total } });
const asRecords = (r: Awaited<ReturnType<typeof resolveLinkless>>) =>
	r.detail.items.map((item, i) => buildOrderItemRecord(order.orderId, "2026-07-14", item, i, "2026-07-15T00:00:00Z", r.detail.items));
const heldOf = (r: { linklessTrace?: string }) => /;stop=unnamed;nameless_held=([^;]*);/.exec(r.linklessTrace ?? "")?.[1];

test("a left-over with no name and no product id pairs with its linkless line by line total and is kept with name null", async () => {
	const r = await resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + nlLine(1.2, "$3.17"));
	assert.equal(r.evidence.linklessLines, 0);
	const [named, nameless] = asRecords(r);
	assert.equal(named?.name_unavailable_reason, null);
	assert.deepEqual(nameless, {
		id: `${order.orderId}|nameless|317|1.2|0`, order_id: order.orderId, name: null, name_unavailable_reason: "source_omits_name",
		department: null, product_id: null, product_url: null, image_url: null,
		quantity: 1.2, line_total: "$3.17", line_total_cents: 317, order_date: "2026-07-14",
	});
	assert.equal(orderItemsSchema.safeParse(nameless).success, true);
	assert.match(r.linklessTrace ?? "", /;stop=nameless;nameless=1;/);
	assert.doesNotMatch(r.linklessTrace ?? "", /3\.17/);
});

test("the real instance's left-overs carry a product id: it is not naming evidence, and the record keeps it", async () => {
	const items = [ssrItem("500"), nlSsr("$3.17", 1, { id: "7001", fullDisplayName: "" }), nlSsr("$8.40", 1, { id: "7002", fullDisplayName: "" })];
	const r = await resolveLinkless(items, itemRow(0) +
		realLine({ ordered: 1, actualText: "Qty: 1.27 of 1 lb", total: "$3.17" }) +
		realLine({ ordered: 1, actualText: "Qty: 1.4 lb", total: "$8.40", second: "$4.00 / lb", extraPrice: "$8.40" }));
	assert.equal(r.evidence.linklessLines, 0);
	const [, a, b] = asRecords(r);
	assert.deepEqual([a?.id, a?.product_id, a?.name, a?.name_unavailable_reason, a?.product_url, a?.image_url, a?.quantity],
		[`${order.orderId}|7001`, "7001", null, "source_omits_name", null, null, 1.27]);
	assert.deepEqual([b?.id, b?.product_id, b?.quantity], [`${order.orderId}|7002`, "7002", 1.4]);
	assert.ok([a, b].every((record) => orderItemsSchema.safeParse(record).success));
	assert.equal(inventoryMatchesSourceTotal({ ...r.evidence, acceptedIds: [...r.evidence.sourceIds] }, 3), true);
});

test("a nameless line whose product id equals a named line's makes both ids positional, as two named lines of one product do", () => {
	const named = { department: null, imageUrl: null, lineTotal: "$1.00", name: "Widget", productId: "500", productUrl: null, quantity: 1, sourcePosition: 0 };
	const nameless = { ...named, name: null, sourcePosition: 3 };
	const items = [named, nameless];
	assert.deepEqual(items.map((item, i) => orderItemId(order.orderId, item, i, items)), [`${order.orderId}|500|0`, `${order.orderId}|500|3`]);
	assert.equal(orderItemId(order.orderId, nameless, 0, [nameless]), `${order.orderId}|500`);
});

test("an order with nameless lines passes the order-total proof once every record is accepted", async () => {
	const items = [ssrItem("500"), nlSsr("$3.17", 1.2), nlSsr("$8.40", 2.1)];
	const r = await resolveLinkless(items, itemRow(0) + nlLine(1.2, "$3.17") + nlLine(2.1, "$8.40"));
	assert.equal(r.evidence.linklessLines, 0);
	assert.equal(r.sourceItemTotal, 3);
	// fetchOrderDetail leaves acceptedIds empty; the caller sets it after emitting.
	assert.equal(inventoryMatchesSourceTotal(r.evidence, 3), false);
	const accepted = { ...r.evidence, acceptedIds: [...r.evidence.sourceIds] };
	assert.equal(inventoryMatchesSourceTotal(accepted, 3), true);
	assert.equal(accepted.duplicateRecordIds, 0);
	assert.ok(asRecords(r).every((record) => orderItemsSchema.safeParse(record).success));
});

test("a nameless line with no product id keeps its id when the SSR items are reordered or a named line is inserted", async () => {
	const a = nlSsr("$8.40", 2.1);
	const b = nlSsr("$3.17", 1.2);
	const rowA = nlLine(2.1, "$8.40");
	const rowB = nlLine(1.2, "$3.17");
	const idsByTotal = async (items: unknown[], rows: string) =>
		new Map((await resolveLinkless(items, rows).then(asRecords)).filter((record) => record.name === null).map((record) => [record.line_total, record.id]));
	const base = await idsByTotal([a, ssrItem("500"), b], rowA + itemRow(0) + rowB);
	assert.deepEqual([...base].sort(), [["$3.17", `${order.orderId}|nameless|317|1.2|0`], ["$8.40", `${order.orderId}|nameless|840|2.1|0`]]);
	assert.deepEqual(await idsByTotal([b, a, ssrItem("500")], rowB + rowA + itemRow(0)), base);
	assert.deepEqual(await idsByTotal([ssrItem("500"), ssrItem("501"), a, b], itemRow(0) + itemRow(1) + rowA + rowB), base);
	// The same input read twice gives the same ids.
	assert.deepEqual(await idsByTotal([a, ssrItem("500"), b], rowA + itemRow(0) + rowB), base);
});

test("two identical nameless lines get occurrence 0 and 1, clear of every named id", async () => {
	const r = await resolveLinkless(
		[ssrItem("500"), nlSsr("$3.17", 1.2), nlSsr("$3.17", 1.2)],
		itemRow(0) + nlLine(1.2, "$3.17") + nlLine(1.2, "$3.17"),
	);
	assert.equal(r.evidence.linklessLines, 0);
	assert.deepEqual(asRecords(r).map((record) => record.id),
		[`${order.orderId}|500`, `${order.orderId}|nameless|317|1.2|0`, `${order.orderId}|nameless|317|1.2|1`]);
	assert.equal(r.evidence.duplicateRecordIds, 0);
	const differ = await resolveLinkless(
		[ssrItem("500"), nlSsr("$3.17", 1.2), nlSsr("$3.17", 1.3)],
		itemRow(0) + nlLine(1.2, "$3.17") + nlLine(1.3, "$3.17"),
	);
	assert.equal(differ.evidence.linklessLines, 2);
	assert.equal(heldOf(differ), "pairing");
});

test("the charged quantity is the first number of the one quantity span; the sentence quantity may differ", async () => {
	const rows = itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.27 of 1.2 lb", total: "$3.17" });
	const reads = await Promise.all([1.2, 1.27, null].map((quantity) => resolveLinkless([ssrItem("500"), nlSsr("$3.17", quantity)], rows)));
	for (const r of reads) {
		assert.equal(r.evidence.linklessLines, 0);
		assert.equal(asRecords(r)[1]?.quantity, 1.27);
	}
});

test("a missing, numberless or conflicting charged quantity holds the line; no fallback to the ordered or SSR amount", async () => {
	const base = (actualText: string) => realLine({ ordered: 1.2, actualText, total: "$3.17" });
	const doubled = base("Qty: 1.2 lb").replace("</li>", '<span data-qe-id="orderItemQty">Qty: 1.3 lb</span></li>');
	const reads = await Promise.all([base(""), base("Qty: lb"), doubled, base("Qty: 1.2 lb").replace("</li>", '<span data-qe-id="orderItemQty">Qty: 1.2 of 2 lb</span></li>')]
		.map((row) => resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + row)));
	assert.deepEqual(reads.map(heldOf), ["qty", "qty", "qty", "qty"], "two spans hold, even when they state the same number");
	assert.ok(reads.every((r) => r.evidence.linklessLines === 1));
	const truncated = await Promise.all(["Qty: 1.", "Qty: 1.2.3 lb", "Qty: 1.2-3", "Qty: .", "Qty: 1 - 2 lb", "Qty: 1 of", "Qty: 1 of 2 3 lb", "Qty 1 lb", "Qty: 1 lb lb"].map((text) =>
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + base(text))));
	assert.ok(truncated.every((r) => heldOf(r) === "qty" || /^text:/.test(heldOf(r) ?? "")), truncated.map(heldOf).join());
	assert.deepEqual(truncated.map(heldOf).filter((reason) => reason !== "qty"), []);
	const complete = await Promise.all(["Qty: 1.2", "Qty: 1.2lb", "QTY: 1.2 LB", "Qty: 1.2 lb", "Qty: 1.2 of 1.3", "Qty: 1.2 of 1.3 lb", "Qty: 1.2  of  1.3  oz"].map((text) =>
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + base(text))));
	assert.ok(complete.every((r) => r.evidence.linklessLines === 0));
});

test("a held nameless order says why with a fixed code, never a source value", async () => {
	const line = (second: string) => realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", second });
	const ok = line("Avg. 1.2 lb");
	const deep = { fullDisplayName: "", a: { b: { c: { d: { e: { f: { displayName: "Zq9x Deep Name" } } } } } } };
	const wide = { fullDisplayName: "", ...Object.fromEntries(Array.from({ length: 80 }, (_, n) => [`k${n}`, "filler"])), tail: { productTitle: "Zq9x Late Name" } };
	let endless: Record<string, unknown> = { leaf: "x" };
	for (let n = 0; n < 300; n++) endless = { n: endless };
	const [word, ascii, noMatch, key, deepKey, wideKey, incomplete, url, mixed, totalGap, pairGap, attr, labelled, title, alt, link] = await Promise.all([
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + line("Organic Bananas, 4417")),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + line("Café Ñandú")),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 2)], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, { fullDisplayName: "", brandNameZq9x: "Zq9x Brand" })], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, deep)], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, wide)], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, { fullDisplayName: "", deeper: endless })], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, { fullDisplayName: "", productPageURL: "https://www.heb.com/product-detail/x/501" })], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), ssrItem("501"), nlSsr("$3.17", 1.2)], itemRow(0) + ok + unrelatedLine()),
		resolveLinkless([ssrItem("500"), { product: { fullDisplayName: "" }, quantity: 1.2 }], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.18", 1.2)], itemRow(0) + ok),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", attrs: ' aria-label="Zq9x Bread"' })),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", attrs: ' aria-labelledby="zq9xlabel"' })),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", attrs: ' title="Zq9x Bread"' })),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17" }).replace('alt=""', 'alt="Zq9x Bread"')),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", text: '<a href="/x">go</a>' })),
	]);
	assert.equal(heldOf(word), "text:w w, d");
	assert.equal(heldOf(ascii), "text:w w");
	assert.equal(heldOf(noMatch), "qty");
	assert.equal(heldOf(key), "naming_key:product.?");
	assert.equal(heldOf(deepKey), "naming_key:product.?.?.?.?.?.?.displayName");
	assert.equal(heldOf(wideKey), "naming_key:product.?.?");
	assert.equal(heldOf(incomplete), "scan_incomplete");
	assert.equal(heldOf(url), "naming_key:product.productPageURL");
	assert.match(heldOf(mixed) ?? "", /^naming_key/);
	assert.equal(heldOf(totalGap), "total");
	assert.equal(heldOf(pairGap), "pairing");
	assert.deepEqual([attr, labelled, title, alt].map(heldOf), ["naming_attr", "naming_attr", "naming_attr", "naming_attr"]);
	assert.equal(heldOf(link), "text");
	for (const r of [word, ascii, noMatch, key, deepKey, wideKey, incomplete, url, mixed, totalGap, pairGap, attr, labelled, title, alt, link]) {
		assert.ok((r.evidence.linklessLines ?? 0) >= 1);
		assert.ok(r.detail.items.every((item) => item.name !== null));
		assert.doesNotMatch(r.linklessTrace ?? "", /Organic|Bananas|4417|Caf|Ñ|andú|Zq9x|zq9x|Brand|Late|Deep|3\.17|3\.18/);
	}
});

test("the held reason leads the trace, ahead of the 300 characters a stored gap keeps", async () => {
	const r = await resolveLinkless([ssrItem("500"), nlSsr("$3.17", 2)],
		itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17" }));
	assert.ok((r.linklessTrace ?? "").indexOf(";stop=unnamed;nameless_held=qty;") < 200);
});

test("nameless lines are held, not emitted, when the line count is not proven", async () => {
	const items = [ssrItem("500"), nlSsr("$3.17", 1.2)];
	const withOrderItems = (n: number) => JSON.stringify({ page: "/my-account/order-history/[orderId]", gssp: true, props: { __N_SSP: true, pageProps: { order: { orderId: order.orderId, orderItems: [...items, ...Array.from({ length: n }, () => ssrItem("900"))] } } } });
	const rows = itemRow(0) + nlLine(1.2, "$3.17") + '<section data-qe-id="orderSummaryCard"></section>';
	const page = pageFor(rows + `<script id="__NEXT_DATA__">${withOrderItems(0)}</script>`);
	// The first read states a different item total than the one parsed later.
	const first = rows + `<script id="__NEXT_DATA__">${withOrderItems(1)}</script>`;
	const later = page.content;
	let calls = 0;
	(page as unknown as { content: () => Promise<string> }).content = async () => (calls++ === 0 ? first : later());
	const r = await fetchOrderDetail(page, order.orderId, { waitForHydration: async () => {}, detailSurfaceTimeoutMs: 50 });
	assert.equal(r.status, "hydrated");
	if (r.status !== "hydrated") return;
	assert.equal(r.evidence.lineCountProven, false);
	assert.equal(r.evidence.linklessLines, 1);
	assert.ok(r.detail.items.every((item) => item.name !== null));
	assert.match(r.linklessTrace ?? "", /;stop=unnamed;nameless_held=count;/);
});

test("an SSR item that names itself but has no product id still fails the whole SSR read", async () => {
	const r = await resolveLinkless([{ product: { fullDisplayName: "Named, no id" }, quantity: 1 }], itemRow(0));
	assert.match(r.linklessTrace ?? "", /ssr=unread:/);
});

test("any aria-labelledby in the line holds it as naming_attr, whatever it points at", async () => {
	const line = (ref: string) => realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", attrs: ` aria-labelledby="${ref}"` });
	const reads = await Promise.all([
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + line("gone")),
		// A target whose name sits in an attribute, not its text.
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0).replace("</li>", '<span id="lbl" aria-label="Zq9x Bread"></span></li>') + line("lbl")),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0).replace("</li>", '<span id="lbl">lb</span></li>') + line("lbl")),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2)], itemRow(0) + realLine({ ordered: 1.2, actualText: "Qty: 1.2 lb", total: "$3.17", text: '<span aria-labelledby=""></span>' })),
	]);
	assert.deepEqual(reads.map(heldOf), ["naming_attr", "naming_attr", "naming_attr", "naming_attr"]);
	for (const r of reads) {
		assert.equal(r.evidence.linklessLines, 1);
		assert.doesNotMatch(r.linklessTrace ?? "", /Zq9x|Bread|gone|lbl/);
	}
});

test("two nameless lines whose cents are written differently still get distinct ids", async () => {
	const r = await resolveLinkless(
		[ssrItem("500"), nlSsr("$1,003.10", 1.2), nlSsr("$1003.10", 1.2)],
		itemRow(0) + nlLine(1.2, "$1,003.10") + nlLine(1.2, "$1003.10"),
	);
	assert.equal(r.evidence.linklessLines, 0);
	const ids = asRecords(r).map((record) => record.id);
	assert.equal(new Set(ids).size, 3);
	assert.deepEqual(ids.slice(1), [`${order.orderId}|nameless|100310|1.2|0`, `${order.orderId}|nameless|100310|1.2|1`]);
	assert.ok(asRecords(r).every((record) => orderItemsSchema.safeParse(record).success));
	assert.equal(r.evidence.duplicateRecordIds, 0);
});

// The left-over shape H-E-B serves live: blank name and link, a product id, a
// category name, image URLs and SKUs that carry no product name.
const liveLeftOver = (extra: Record<string, unknown> = {}) => ({
	id: "7001", fullDisplayName: "", productPageURL: "",
	__typename: "Product", bestAvailable: true, isEbtSnapProduct: false, maximumOrderQuantity: 50, minimumOrderQuantity: 1,
	productCategory: { __typename: "Category", id: "cat-42", name: "Produce" },
	productImageUrls: [{ url: "https://images.heb.com/is/image/HEBGrocery/007001", size: "MEDIUM", __typename: "Image" }],
	thumbnailImageUrls: [{ url: "https://images.heb.com/is/image/HEBGrocery/007001-t", size: "SMALL", __typename: "Image" }],
	shoppingContext: "CURBSIDE_PICKUP", storeId: 92,
	SKUs: [{ id: "9001", customerFriendlySize: "1 lb", weightSelectionIncrements: [0.5], twelveDigitUPC: "000000000001", contextPrices: [{ isOnSale: false }], __typename: "SKU" }],
	...extra,
});
const inSection = (rows: string) => `<main><section><h2 data-qe-id="orderDetailsGroupTitle">Produce</h2><ul>${rows}</ul></section></main>`;

test("the real left-over shape (category name, image urls, SKUs without names) is kept nameless with its department", async () => {
	const r = await resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, liveLeftOver())], inSection(itemRow(0) + nlLine(1.2, "$3.17")));
	assert.equal(r.evidence.linklessLines, 0);
	const nameless = asRecords(r)[1]!;
	assert.equal(nameless.name, null);
	assert.equal(nameless.name_unavailable_reason, "source_omits_name");
	assert.equal(nameless.department, "Produce");
	assert.equal(nameless.product_id, "7001");
	assert.equal(nameless.image_url, null);
	assert.equal(nameless.product_url, null);
	assert.equal(orderItemsSchema.safeParse(nameless).success, true);
});

test("a name under SKUs or an unknown key still holds, and the trace names the path from a fixed alphabet", async () => {
	const sku = liveLeftOver({ SKUs: [{ id: "9001", displayName: "Zq9x Bread" }] });
	const unknown = liveLeftOver({ productName: "Zq9x Bread" });
	const [a, b] = await Promise.all([
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, sku)], inSection(itemRow(0) + nlLine(1.2, "$3.17"))),
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, unknown)], inSection(itemRow(0) + nlLine(1.2, "$3.17"))),
	]);
	assert.equal(heldOf(a), "naming_key:product.SKUs.#.displayName");
	assert.equal(heldOf(b), "naming_key:product.?");
	for (const r of [a, b]) assert.doesNotMatch(r.linklessTrace ?? "", /Zq9x|Bread|productName/);
});

test("a name hidden in a skipped-looking subtree still holds; only the proven leaves are allowed", async () => {
	const image = liveLeftOver({ productImageUrls: [{ url: "https://images.heb.com/x", displayName: "Zq9x Bread" }] });
	const category = liveLeftOver({ productCategory: { name: "Produce", description: "Zq9x Bread" } });
	const thumb = liveLeftOver({ thumbnailImageUrls: [{ url: "https://images.heb.com/x", title: "Zq9x Bread" }] });
	const [a, b, c] = (await Promise.all([image, category, thumb].map((product) =>
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, product)], inSection(itemRow(0) + nlLine(1.2, "$3.17")))))) as [Awaited<ReturnType<typeof resolveLinkless>>, Awaited<ReturnType<typeof resolveLinkless>>, Awaited<ReturnType<typeof resolveLinkless>>];
	assert.equal(heldOf(a), "naming_key:product.productImageUrls.#.displayName");
	assert.equal(heldOf(b), "naming_key:product.productCategory.description");
	assert.equal(heldOf(c), "naming_key:product.thumbnailImageUrls.#.title");
	for (const r of [a, b, c]) assert.doesNotMatch(r.linklessTrace ?? "", /Zq9x|Bread/);
});

test("a displayName added to a real image object still holds the line", async () => {
	const product = liveLeftOver({ productImageUrls: [{ url: "https://images.heb.com/x", size: "MEDIUM", __typename: "Image", displayName: "Zq9x Bread" }] });
	const r = await resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, product)], inSection(itemRow(0) + nlLine(1.2, "$3.17")));
	assert.equal(heldOf(r), "naming_key:product.productImageUrls.#.displayName");
	assert.doesNotMatch(r.linklessTrace ?? "", /Zq9x|Bread/);
});

test("a literal dotted key does not pass as the allowed nested leaf, and an object __typename is walked", async () => {
	const dotted = liveLeftOver({ "productCategory.name": "Zq9x Bread" });
	const typed = liveLeftOver({ __typename: { displayName: "Zq9x Bread" } });
	const hashKey = liveLeftOver({ productImageUrls: [{ "#": "Zq9x Bread" }] });
	const [a, b, c] = (await Promise.all([dotted, typed, hashKey].map((product) =>
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, product)], inSection(itemRow(0) + nlLine(1.2, "$3.17")))))) as [Awaited<ReturnType<typeof resolveLinkless>>, Awaited<ReturnType<typeof resolveLinkless>>, Awaited<ReturnType<typeof resolveLinkless>>];
	assert.equal(heldOf(a), "naming_key:product.?");
	assert.equal(heldOf(b), "naming_key:product.__typename.displayName");
	assert.equal(heldOf(c), "naming_key:product.productImageUrls.#.?");
	for (const r of [a, b, c]) assert.doesNotMatch(r.linklessTrace ?? "", /Zq9x|Bread/);
});

test("an image size passes only as an uppercase enum token", async () => {
	const sized = (size: string) => liveLeftOver({
		productImageUrls: [{ url: "https://images.heb.com/x", size, __typename: "Image" }],
		thumbnailImageUrls: [{ url: "https://images.heb.com/y", size: "LARGE", __typename: "Image" }],
	});
	const [ok, loaf, lower] = (await Promise.all(["MEDIUM", "Bakery Loaf", "bakery"].map((size) =>
		resolveLinkless([ssrItem("500"), nlSsr("$3.17", 1.2, sized(size))], inSection(itemRow(0) + nlLine(1.2, "$3.17")))))) as [Awaited<ReturnType<typeof resolveLinkless>>, Awaited<ReturnType<typeof resolveLinkless>>, Awaited<ReturnType<typeof resolveLinkless>>];
	assert.equal(ok.evidence.linklessLines, 0);
	assert.equal(heldOf(loaf), "naming_key:product.productImageUrls.#.size");
	assert.equal(heldOf(lower), "naming_key:product.productImageUrls.#.size");
	for (const r of [loaf, lower]) assert.doesNotMatch(r.linklessTrace ?? "", /Bakery|bakery|Loaf/);
});

test("a named row's department survives a section title with < and &", async () => {
	const r = await resolveLinkless([ssrItem("500")], `<main><section><h2 data-qe-id="orderDetailsGroupTitle">Fish &amp; &lt;Chips&gt;</h2><ul>${itemRow(0)}</ul></section></main>`);
	assert.equal(r.detail.items[0]?.department, "Fish & <Chips>");
});

// ─── the ledger conflict trace (stop=ledger) ─────────────────────────────
const lgOf = (r: { linklessTrace?: string }) => /;stop=ledger;(lg=[^;]*)/.exec(r.linklessTrace ?? "")?.[1];
const promoRow = `<li><a data-qe-id="itemRowDetailsName" href="/product-detail/zq9x-free-sample/ZQ9X77">Zq9x Free Sample</a><span data-qe-id="orderItemQty">Qty: 1</span></li>`;

test("a ledger stop counts the maximum matching and classifies each unplaced row, by fixed codes", async () => {
	const withSubstitute = { product: { id: "500", fullDisplayName: "SSR 500" }, quantity: 1, subbedProducts: [{ product: { id: "501" } }] };
	const [dup, flat, promo] = await Promise.all([
		resolveLinkless([ssrItem("500"), ssrItem("501")], itemRow(0) + itemRow(1) + itemRow(0)),
		resolveLinkless([withSubstitute], itemRow(0) + itemRow(1)),
		resolveLinkless([ssrItem("500")], itemRow(0) + promoRow),
	]);
	assert.equal(lgOf(dup), "lg=mx:2/3/2,u:1[dup_product:1yn],ssr:0/0");
	assert.equal(lgOf(flat), "lg=mx:1/2/1,u:1[sub_pair:1yn],ssr:1/0");
	assert.equal(lgOf(promo), "lg=mx:1/2/1,u:1[no_ssr_product:1yy],ssr:0/0");
	for (const r of [dup, flat, promo]) {
		assert.match(r.linklessTrace ?? "", /;stop=ledger;lg=[^;]*;why=/);
		assert.ok((lgOf(r) ?? "").length <= 120);
		assert.doesNotMatch(r.linklessTrace ?? "", /Zq9x|ZQ9X|Sample|zq9x/i);
		assert.equal(r.inventoryComplete, false);
	}
});

test("the ledger trace changes no record: the parsed items are the rows' own", async () => {
	const r = await resolveLinkless([ssrItem("500")], itemRow(0) + promoRow);
	assert.deepEqual(r.detail.items.map((item) => item.productId), ["500", "ZQ9X77"]);
	assert.equal(r.evidence.linklessLines, 0);
	assert.doesNotMatch(r.linklessTrace ?? "", /nameless/);
});

// ─── the ledger trace is bounded and never throws ────────────────────────
const bareRow = (id: string) => `<li><a data-qe-id="itemRowDetailsName" href="/product-detail/x/${id}">Row</a><span data-qe-id="orderItemQty">Qty: 1</span></li>`;
const bareItem = (productId: string, substituteIds: string[] = []) =>
	({ productId, quantity: 1, substituteIds, fullDisplayName: "SSR", productUrl: null, lineTotal: null });

test("a dense order past the work budget reports mx:? with the SSR counts and finishes quickly", () => {
	const ids = Array.from({ length: 400 }, (_, i) => `D${i}`);
	const items = ids.slice(0, 399).map((id) => bareItem(id, ids));
	const started = Date.now();
	const r = resolveLinklessOrderItems(ids.map(bareRow).join(""), items);
	assert.ok(Date.now() - started < 20_000);
	assert.match(r.trace, /;stop=ledger;lg=mx:\?\/400\/399,x:budget,ssr:399\/0;why=/);
});

test("a long chain of forced shifts is matched exactly within the budget", () => {
	// Row i fits items i and i+1; the last row fits only item 0, so placing it
	// shifts every earlier row by one: an augmenting path as long as the order.
	const n = 2500;
	const rowIds = Array.from({ length: n }, (_, i) => `C${i}`);
	const items = Array.from({ length: n - 1 }, (_, i) => bareItem(`C${i}`, i > 0 ? [`C${i - 1}`] : []));
	const rows = rowIds.map((id, i) => (i === n - 1 ? bareRow("C0") : bareRow(id)));
	const r = resolveLinklessOrderItems(rows.join(""), items);
	assert.match(r.trace, /;stop=ledger;lg=mx:2499\/2500\/2499,u:1\[/);
});

test("an error inside the ledger diagnostic becomes lg=err and changes nothing else", () => {
	const rows = bareRow("E0") + bareRow("E1") + bareRow("E0");
	let reads = 0;
	let throwAt = Infinity;
	const counted = (id: string) => ({
		...bareItem(id),
		get substituteIds() {
			if (++reads >= throwAt) throw new Error("injected");
			return [] as string[];
		},
	});
	const base = resolveLinklessOrderItems(rows, [counted("E0"), counted("E1")]);
	assert.match(base.trace, /;stop=ledger;lg=mx:2\/3\/2,u:1\[/);
	const total = reads;
	reads = 0;
	throwAt = total; // the last read is inside the diagnostic
	const hurt = resolveLinklessOrderItems(rows, [counted("E0"), counted("E1")]);
	assert.match(hurt.trace, /;stop=ledger;lg=err;why=/);
	assert.equal(hurt.unresolved, base.unresolved);
	assert.deepEqual(hurt.nameless, base.nameless);
	assert.equal(JSON.stringify(hurt.detail), JSON.stringify(base.detail));
});

test("a large dense order with many duplicate candidates keeps the gap with the budget code, quickly", () => {
	// Every row and every item carries the same product id: all 1000 rows fit
	// all 1500 items.
	const items = Array.from({ length: 1500 }, () => bareItem("X"));
	const started = Date.now();
	const r = resolveLinklessOrderItems(Array.from({ length: 1000 }, () => bareRow("X")).join(""), items);
	assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
	assert.match(r.trace, /ledger:budget,/);
	assert.match(r.trace, /;stop=ledger;lg=mx:\?\/1000\/1500,x:budget,ssr:0\/1;why=/);
	assert.equal(r.unresolved, 0);
});

test("the ambiguity pass draws on the same budget and fails closed when it runs out", () => {
	// 30 rows, 400 items, all one product: the matching fits the budget, the
	// walk over swaps for the 370 free items does not.
	const items = Array.from({ length: 400 }, () => bareItem("X"));
	const r = resolveLinklessOrderItems(Array.from({ length: 30 }, () => bareRow("X")).join(""), items);
	assert.match(r.trace, /ledger:budget,/);
	assert.match(r.trace, /;stop=ledger;lg=mx:\?\/30\/400,x:budget,/);
	assert.match(r.trace, /unclaimed:-,/);
});

test("an order inside the budget keeps its ledger result", () => {
	const r = resolveLinklessOrderItems(bareRow("K0") + bareRow("K1"), [bareItem("K0"), bareItem("K1")]);
	assert.match(r.trace, /ledger:complete,/);
	const amb = resolveLinklessOrderItems(bareRow("K0") + bareRow("K0"), [bareItem("K0"), bareItem("K0"), bareItem("K0")]);
	assert.match(amb.trace, /ledger:ambiguous,/);
});

// ─── one product drawn twice: collapse an identical extra rendering ───────
// Invented order: SSR holds P once, Q twice (real repeat, different prices), R
// once and O once (a removed original whose substitute S is nested in its row).
// The DOM draws P a second time, identical, at the top of the list.
const dupRow = (id: string, o: { cents?: string; qty?: string; nested?: string } = {}) =>
	`<li><a aria-hidden="true" href="/product-detail/x/${id}"><img src="https://images.heb.com/is/image/HEBGrocery/prd-small/${id.padStart(9, "0")}.jpg"></a>` +
	`<a data-qe-id="itemRowDetailsName" href="/product-detail/x/${id}">Item ${id}</a>` +
	`<span data-qe-id="checkoutItemPrice">${o.cents ?? "$5.00"}</span><span data-qe-id="orderItemQty">${o.qty ?? "Qty: 1"}</span>${o.nested ?? ""}</li>`;
const nestedSub = (id: string) => `<ul>${dupRow(id, { cents: "$2.00" })}</ul>`;
const dupSsr = [
	ssrItem("900"), ssrItem("901"), ssrItem("901"), ssrItem("902"),
	{ product: { id: "903", fullDisplayName: "SSR 903" }, quantity: 1, subbedProducts: [{ product: { id: "904" } }] },
];
const dupPage = (top: string, bottom: string) =>
	top + dupRow("902") + dupRow("901", { cents: "$3.00" }) + dupRow("901", { cents: "$4.00" }) + dupRow("903", { nested: nestedSub("904") }) + bottom;
const matchesTotal = (r: Awaited<ReturnType<typeof resolveLinkless>>, total: number) =>
	inventoryMatchesSourceTotal({ ...r.evidence, acceptedIds: r.evidence.sourceIds }, total);

test("an identical extra rendering of a product SSR holds once collapses; a real repeat and a substitute stay", async () => {
	const r = await resolveLinkless(dupSsr, dupPage(dupRow("900"), dupRow("900")));
	assert.match(r.linklessTrace ?? "", /;dup_render=1/);
	assert.equal(matchesTotal(r, 5), true);
	assert.equal(r.evidence.sourceIds.length, 5);
	assert.deepEqual(r.detail.items.map((item) => item.productId).sort(), ["900", "901", "901", "902", "903", "904"]);
	const ids = asRecords(r).map((record) => record.id);
	assert.ok(ids.includes(`${order.orderId}|900`));
	assert.equal(new Set(ids).size, ids.length);
});

test("nothing collapses when the two renderings differ in line cents or in qty text", async () => {
	const cents = await resolveLinkless(dupSsr, dupPage(dupRow("900", { cents: "$6.00" }), dupRow("900")));
	const qty = await resolveLinkless(dupSsr, dupPage(dupRow("900", { qty: "Qty: 2" }), dupRow("900")));
	for (const r of [cents, qty]) {
		assert.doesNotMatch(r.linklessTrace ?? "", /dup_render/);
		assert.equal(matchesTotal(r, 5), false);
		assert.equal(r.evidence.sourceIds.length, 6);
	}
});

test("nothing collapses when SSR holds the product as many times as the DOM draws it", async () => {
	const twice = [...dupSsr, ssrItem("900")];
	const r = await resolveLinkless(twice, dupPage(dupRow("900"), dupRow("900")));
	assert.doesNotMatch(r.linklessTrace ?? "", /dup_render/);
	assert.equal(matchesTotal(r, 6), true);
});

test("nothing collapses when the product is also a substitute id, or a rendering holds a nested row", async () => {
	const asSubstitute = dupSsr.map((item, i) => (i === 3 ? { ...item, subbedProducts: [{ product: { id: "900" } }] } : item));
	const sub = await resolveLinkless(asSubstitute, dupPage(dupRow("900"), dupRow("900")));
	const nested = await resolveLinkless(dupSsr, dupPage(dupRow("900", { nested: nestedSub("905") }), dupRow("900", { nested: nestedSub("905") })));
	for (const r of [sub, nested]) assert.doesNotMatch(r.linklessTrace ?? "", /dup_render/);
});

// ─── ledger exhaustion is a value, and building candidates is bounded ─────
test("building the candidate edges is charged to the budget: a dense order exhausts fast", () => {
	const n = 3000;
	const items = Array.from({ length: n }, () => bareItem("X"));
	const started = Date.now();
	const r = resolveLinklessOrderItems(Array.from({ length: n }, () => bareRow("X")).join(""), items);
	assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
	assert.equal(r.ledgerExhausted, true);
	assert.match(r.trace, /ledger:budget,/);
	assert.match(r.trace, new RegExp(`;stop=ledger;lg=mx:\\?/${n}/${n},x:budget,`));
});

test("budget exhaustion keeps the gap even when every row is named and the counts match", async () => {
	const n = 300;
	const r = await resolveLinkless(
		Array.from({ length: n }, () => ssrItem("X")),
		Array.from({ length: n }, () => bareRow("X")).join(""),
	);
	assert.equal(r.evidence.ledgerExhausted, true);
	assert.equal(r.detail.items.length, n);
	assert.equal(r.evidence.linklessLines, 0);
	assert.equal(matchesTotal(r, n), false);
	assert.equal(r.inventoryComplete, false);
});

test("an order inside the budget is not flagged exhausted, the collapse case included", async () => {
	const r = await resolveLinkless(dupSsr, dupPage(dupRow("900"), dupRow("900")));
	assert.notEqual(r.evidence.ledgerExhausted, true);
	assert.equal(matchesTotal(r, 5), true);
});

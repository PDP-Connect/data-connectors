// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { chromium, type Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	type EmitDeps,
	emitOrderItemsCoverage,
	hebConnector,
	isCanceledOrder,
	newOrderItemsCoverage,
	processListOrder,
	recoverPendingOrderItemDetailGaps,
	type RunFlags,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ListPageOrder } from "./types.ts";

interface RecordingDeps {
	deps: EmitDeps;
	emitted: ReturnType<typeof makeRecordingEmit>["emitted"];
	protocolMessages: EmittedMessage[];
}

function noopSendInteraction(): ReturnType<
	BrowserCollectContext["sendInteraction"]
> {
	throw new Error("sendInteraction should not be called in this test");
}

const immediateWait = (): Promise<void> => Promise.resolve();

/** Make every `setTimeout` fire on the next microtask so a collect run does not
 *  wait out its polite delays. Returns the restore function. */
function collapseTimers(): () => void {
	const original = globalThis.setTimeout;
	globalThis.setTimeout = ((callback: () => void) => {
		queueMicrotask(callback);
		return 0;
	}) as unknown as typeof setTimeout;
	return () => {
		globalThis.setTimeout = original;
	};
}

function makeRecordingDeps(overrides: Partial<EmitDeps> = {}): RecordingDeps {
	const harness = makeRecordingEmit(validateRecord);
	const deps: EmitDeps = {
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: "2026-07-14T12:00:00.000Z",
		emitItems: true,
		orderItemsCoverage: undefined,
		ordersCoverage: undefined,
		ordersFingerprintCursor: undefined,
		progress: (): Promise<void> => Promise.resolve(),
		sendInteraction: noopSendInteraction,
		waitForHydration: immediateWait,
		wantsItems: true,
		wantsOrders: true,
		...overrides,
	};
	return {
		deps,
		emitted: harness.emitted,
		protocolMessages: harness.protocolMessages,
	};
}

function makeRunFlags(overrides: Partial<RunFlags> = {}): RunFlags {
	return {
		detailAttempts: 0,
		isManualRun: false,
		manualRepairAttempted: false,
		sessionRepairRequired: false,
		...overrides,
	};
}

function makeListOrder(overrides: Partial<ListPageOrder> = {}): ListPageOrder {
	return {
		orderId: "HEB1000000001",
		orderDateRaw: "July 14, 2026",
		fulfillmentMethod: "curbside",
		fulfillmentLocation: "H-E-B plus! Austin Mueller",
		status: "Delivered",
		statusCode: null,
		storeName: null,
		timeslotStart: null,
		timeslotEnd: null,
		total: "$42.00",
		itemCount: 1,
		source: "dom",
		unfulfilledCount: null,
		...overrides,
	};
}

const DETAIL_HTML = `<html><body><main><ul>${[0, 1, 2]
	.map(
		(index) =>
			`<li data-index="${index}"><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/${500 + index}">Widget</a><span data-qe-id="checkoutItemPrice">$10.00</span><span data-qe-id="orderItemQty">Qty: 4</span></li>`,
	)
	.join("")}</ul></main></body></html>`;

function makePageStub(
	html: string,
	visited: string[] = [],
	detailHtmlFor: string | ((orderUrl: string) => string) = html,
): Page {
	let currentUrl = "about:blank";
	const currentDetailHtml = (): string =>
		typeof detailHtmlFor === "function"
			? detailHtmlFor(currentUrl)
			: detailHtmlFor;
	return new Proxy(
		{},
		{
			get(_target, prop): unknown {
				if (prop === "goto") {
					return (url: string): Promise<null> => {
						visited.push(url);
						currentUrl = url;
						return Promise.resolve(null);
					};
				}
				if (prop === "waitForSelector" || prop === "waitForTimeout") {
					return (): Promise<null> => Promise.resolve(null);
				}
				if (prop === "content") {
					return (): Promise<string> =>
						Promise.resolve(
							currentUrl.includes("/my-account/order-history/")
								? currentDetailHtml()
								: html,
						);
				}
				if (prop === "url") {
					return (): string => currentUrl;
				}
				if (prop === "evaluate") {
					return (): Promise<unknown> => {
						const detailHtml = currentDetailHtml();
						return Promise.resolve({
							actionableControl: null,
							actionPerformed: null,
							atEnd: true,
							clientHeight: 100,
							loading: false,
							rowCount: detailHtml.includes("itemRowDetailsName") ? 3 : 0,
							rows: detailHtml.includes("itemRowDetailsName")
								? [...detailHtml.matchAll(/<li[\s\S]*?<\/li>/g)].map(
										([row], index) => ({
											html: row,
											key: `position:data-index=${index}`,
											unitCount: 4,
										}),
									)
								: [],
							scrollHeight: 100,
							scrollTop: 0,
							staticListEvidence: "declared_count",
						});
					};
				}
				throw new Error(`unexpected page.${String(prop)} in test stub`);
			},
		},
	) as Page;
}

const EMITTED_AT = "2026-10-05T12:00:00.000Z";

type TestContext = BrowserCollectContext & {
	emitted: { stream: string }[];
	events: ReturnType<typeof makeRecordingEmit>["events"];
	protocolMessages: EmittedMessage[];
	reportedStreamFailures: Extract<EmittedMessage, { type: "SKIP_RESULT" }>[];
};

function makeContext(
	streams: readonly string[],
	page: Page,
	overrides: Partial<BrowserCollectContext> = {},
): TestContext {
	const harness = makeRecordingEmit(validateRecord);
	const reportedStreamFailures: Extract<
		EmittedMessage,
		{ type: "SKIP_RESULT" }
	>[] = [];
	const ctx = {
		context: {},
		detailGaps: [],
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		emittedAt: EMITTED_AT,
		page,
		progress: (): Promise<void> => Promise.resolve(),
		emitted: harness.emitted,
		events: harness.events,
		protocolMessages: harness.protocolMessages,
		recoveryOnly: false,
		reportedStreamFailures,
		reportStreamFailure: async (
			stream: string,
			message: string,
			options: { retryable?: boolean } = {},
		): Promise<void> => {
			const skip: Extract<EmittedMessage, { type: "SKIP_RESULT" }> = {
				type: "SKIP_RESULT",
				stream,
				reason: "stream_collection_failed",
				message,
				recovery_hint: {
					action: "retry_by_runtime",
					retryable: options.retryable === true,
				},
			};
			reportedStreamFailures.push(skip);
			await harness.emit(skip);
		},
		requestDetailGapPage: (): Promise<[]> => Promise.resolve([]),
		requested: new Map(streams.map((name) => [name, { name }])),
		scope: {
			streams: streams.map((name) => ({ name })),
		},
		sendInteraction: (): Promise<never> =>
			Promise.reject(new Error("sendInteraction should not be called")),
		state: {},
		...overrides,
	} satisfies Record<string, unknown> & {
		emitted: { stream: string }[];
		events: ReturnType<typeof makeRecordingEmit>["events"];
		protocolMessages: EmittedMessage[];
		reportedStreamFailures: Extract<EmittedMessage, { type: "SKIP_RESULT" }>[];
	};
	return ctx as unknown as TestContext;
}

async function collectQuickly(ctx: BrowserCollectContext): Promise<void> {
	const restoreTimers = collapseTimers();
	try {
		await hebConnector.collect(ctx);
	} finally {
		restoreTimers();
	}
}

function onePageCanceledOrdersList(): string {
	const html = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			"__fixtures__",
			"orders-list.html",
		),
		"utf8",
	);
	const card = html
		.match(
			/<div data-qe-id="orderDetailsCard">[\s\S]*?<\/a>\s*<\/div>\s*<\/div>/g,
		)
		?.find((candidate) => candidate.includes("Order canceled"));
	assert.ok(card);
	return `<html><body><main><div data-qe-id="orderResults">${card}</div>
		<nav aria-label="Pagination Navigation"><ul data-qe-id="paginationList">
		<li><a data-qe-id="paginationListNum" aria-current="true" href="/my-account/your-orders?page=1">1</a></li>
		</ul></nav></main></body></html>`;
}

test("isCanceledOrder recognizes canceled statuses, not cancellation requests", () => {
	for (const status of ["Order canceled", "Order cancelled"]) {
		assert.equal(isCanceledOrder({ status, statusCode: null }), true);
	}
	for (const statusCode of ["CANCELED", "ORDER_CANCELLED"]) {
		assert.equal(isCanceledOrder({ status: null, statusCode }), true);
	}
	for (const status of [
		"Delivered",
		"Picked up",
		"Cancel order",
		"Cancellation requested",
		null,
	]) {
		assert.equal(isCanceledOrder({ status, statusCode: null }), false);
	}
});

const NO_ROWS_HTML = "<html><body><main>no items here</main></body></html>";
const SIGN_IN_HTML =
	'<html><body><main><form><input type="password" name="password"></form></main></body></html>';

test("processListOrder accounts for a canceled zero-item order whose page shows no rows as empty", async () => {
	const order = makeListOrder({
		itemCount: 0,
		status: "Order canceled",
		unfulfilledCount: 0,
	});
	const coverage = newOrderItemsCoverage();
	const { deps, emitted, protocolMessages } = makeRecordingDeps({
		orderItemsCoverage: coverage,
	});
	const visited: string[] = [];
	await processListOrder(
		makePageStub(NO_ROWS_HTML, visited),
		deps,
		makeRunFlags(),
		order,
	);
	assert.ok(
		visited.some((url) => url.includes("/my-account/order-history/")),
		"the page is fetched first; the declared zero is only the fallback",
	);
	assert.deepEqual(coverage.required, [order.orderId]);
	assert.deepEqual(coverage.empty, [order.orderId]);
	assert.deepEqual(coverage.hydrated, []);
	assert.deepEqual(coverage.gap, []);
	assert.deepEqual(
		emitted.map((record) => record.stream),
		["orders"],
	);
	assert.equal(
		protocolMessages.some((message) => message.type === "DETAIL_GAP"),
		false,
	);
});

test("processListOrder collects the rows a canceled zero-item order's page does list", async () => {
	const order = makeListOrder({
		itemCount: 0,
		status: "Order canceled",
		unfulfilledCount: 0,
	});
	const coverage = newOrderItemsCoverage();
	const { deps, emitted } = makeRecordingDeps({ orderItemsCoverage: coverage });
	await processListOrder(
		makePageStub(DETAIL_HTML),
		deps,
		makeRunFlags(),
		order,
	);
	assert.deepEqual(coverage.hydrated, [order.orderId]);
	assert.deepEqual(coverage.empty, []);
	assert.deepEqual(coverage.gap, []);
	assert.equal(
		emitted.filter((record) => record.stream === "order_items").length,
		3,
		"the rows H-E-B shows are kept, not replaced by an empty claim",
	);
});

test("processListOrder keeps a canceled zero-item order that needs a sign-in as a gap", async () => {
	const order = makeListOrder({
		itemCount: 0,
		status: "Order canceled",
		unfulfilledCount: 0,
	});
	const coverage = newOrderItemsCoverage();
	const { deps, protocolMessages } = makeRecordingDeps({
		orderItemsCoverage: coverage,
	});
	await processListOrder(
		makePageStub(SIGN_IN_HTML),
		deps,
		makeRunFlags(),
		order,
	);
	assert.deepEqual(coverage.empty, []);
	assert.deepEqual(coverage.gap, [order.orderId]);
	assert.equal(
		protocolMessages.filter((message) => message.type === "DETAIL_GAP").length,
		1,
		"a sign-in problem is not a declared-empty order",
	);
});

test("processListOrder keeps a delivered zero-item detail failure as a gap", async () => {
	const order = makeListOrder({ itemCount: 0, unfulfilledCount: 0 });
	const coverage = newOrderItemsCoverage();
	const { deps, protocolMessages } = makeRecordingDeps({
		orderItemsCoverage: coverage,
	});
	await processListOrder(
		makePageStub("<html><body><main>no items here</main></body></html>"),
		deps,
		makeRunFlags(),
		order,
	);
	assert.deepEqual(coverage.required, [order.orderId]);
	assert.deepEqual(coverage.empty, []);
	assert.deepEqual(coverage.gap, [order.orderId]);
	assert.equal(
		protocolMessages.filter((message) => message.type === "DETAIL_GAP").length,
		1,
	);
});

test("emitOrderItemsCoverage folds empty orders into hydrated coverage", async () => {
	const { deps, protocolMessages } = makeRecordingDeps();
	await emitOrderItemsCoverage(deps, {
		required: ["a", "b", "c"],
		hydrated: ["a"],
		empty: ["b"],
		gap: ["c"],
	});
	const messages = protocolMessages.filter(
		(message) => message.type === "DETAIL_COVERAGE",
	);
	assert.equal(messages.length, 1);
	assert.deepEqual(messages[0], {
		type: "DETAIL_COVERAGE",
		reference_only: true,
		stream: "order_items",
		state_stream: "orders",
		hydrated_keys: ["a", "b"],
		gap_keys: ["c"],
		required_keys: ["a", "b", "c"],
		covered: 2,
		considered: 3,
	});
});

test("collect completes a canceled-only history whose detail page has no rows", async () => {
	const visited: string[] = [];
	const page = makePageStub(onePageCanceledOrdersList(), visited, NO_ROWS_HTML);
	const ctx = makeContext(["orders", "order_items"], page);
	await collectQuickly(ctx);
	assert.deepEqual(ctx.reportedStreamFailures, []);
	assert.equal(
		ctx.protocolMessages.some((message) => message.type === "DETAIL_GAP"),
		false,
	);
	assert.deepEqual(
		ctx.emitted.map((record) => record.stream),
		["orders"],
	);
	assert.ok(visited.some((url) => url.includes("/my-account/your-orders")));
	assert.ok(
		visited.some((url) => url.includes("/my-account/order-history/")),
		"the order page is fetched before the declared zero is accepted",
	);
});

for (const itemCount of [12, null]) {
	test(`a canceled order whose card count is ${itemCount ?? "unknown"} is still fetched and hydrated`, async () => {
		const order = makeListOrder({ itemCount, status: "Order canceled" });
		const coverage = newOrderItemsCoverage();
		const { deps, emitted } = makeRecordingDeps({
			orderItemsCoverage: coverage,
		});
		const visited: string[] = [];
		await processListOrder(
			makePageStub(DETAIL_HTML, visited),
			deps,
			makeRunFlags(),
			order,
		);
		assert.deepEqual(coverage.required, [order.orderId]);
		assert.deepEqual(coverage.hydrated, [order.orderId]);
		assert.deepEqual(coverage.empty, []);
		assert.deepEqual(coverage.gap, []);
		assert.equal(
			emitted.filter((record) => record.stream === "order_items").length,
			3,
		);
		assert.ok(
			visited.some((url) => url.includes("/my-account/order-history/")),
		);
	});
}

test("collect hydrates a canceled card with a positive item count", async () => {
	const visited: string[] = [];
	const listHtml = onePageCanceledOrdersList().replace(
		"<!-- -->0<!-- --> <!-- -->items",
		"<!-- -->12<!-- --> <!-- -->items",
	);
	const ctx = makeContext(
		["orders", "order_items"],
		makePageStub(listHtml, visited, DETAIL_HTML),
	);
	await collectQuickly(ctx);
	assert.deepEqual(ctx.reportedStreamFailures, []);
	assert.equal(
		ctx.protocolMessages.some((message) => message.type === "DETAIL_GAP"),
		false,
	);
	assert.equal(
		ctx.emitted.filter((record) => record.stream === "order_items").length,
		3,
	);
	assert.ok(visited.some((url) => url.includes("/my-account/order-history/")));
});

for (const scenario of [
	{
		name: "matching canceled gap",
		orderId: "HEB1029384600",
		unreadable: false,
		nutrition: false,
		probe: "empty",
	},
	{
		name: "unlisted pending gap",
		orderId: "HEB9999999999",
		unreadable: false,
		nutrition: false,
		probe: "empty",
	},
	{
		name: "matching gap plus unreadable gap",
		orderId: "HEB1029384600",
		unreadable: true,
		nutrition: false,
		probe: "empty",
	},
	{
		name: "matching canceled gap with nutrition",
		orderId: "HEB1029384600",
		unreadable: false,
		nutrition: true,
		probe: "empty",
	},
	{
		name: "unseen gap on probe",
		orderId: "HEB1029384600",
		unreadable: false,
		nutrition: false,
		probe: "unseen",
	},
	{
		name: "rejected gap probe",
		orderId: "HEB1029384600",
		unreadable: false,
		nutrition: false,
		probe: "reject",
	},
]) {
	test(`collect reconciles pending gaps from canceled zero-item evidence: ${scenario.name}`, async () => {
		const detailGaps: BrowserCollectContext["detailGaps"][number][] = [
			{
				gap_id: "gap_canceled",
				record_key: scenario.orderId,
				reference_only: true,
				status: "pending",
				stream: "order_items",
				detail_locator: {
					kind: "heb.order_detail",
					order_id: scenario.orderId,
					order_date: "2026-05-20",
				},
			},
		];
		if (scenario.unreadable) {
			detailGaps.push({
				gap_id: "gap_unreadable",
				record_key: "unknown",
				reference_only: true,
				status: "pending",
				stream: "order_items",
			});
		}
		let probeCalls = 0;
		const ctx = makeContext(
			["orders", "order_items", ...(scenario.nutrition ? ["nutrition"] : [])],
			makePageStub(
				onePageCanceledOrdersList(),
				[],
				"<html><body><main>no items here</main></body></html>",
			),
			{
				detailGaps,
				requestDetailGapPage: async () => {
					probeCalls += 1;
					if (scenario.probe === "reject") throw new Error("probe unavailable");
					return scenario.probe === "unseen"
						? [
								{
									gap_id: "gap_unseen",
									record_key: "unseen",
									status: "pending",
									stream: "order_items",
								},
							]
						: [];
				},
			},
		);
		await collectQuickly(ctx);
		assert.equal(probeCalls, 1);
		const recovered = ctx.protocolMessages.filter(
			(message) => message.type === "DETAIL_GAP_RECOVERED",
		);
		assert.deepEqual(
			recovered,
			scenario.orderId === "HEB1029384600"
				? [
						{
							type: "DETAIL_GAP_RECOVERED",
							reference_only: true,
							gap_id: "gap_canceled",
							stream: "order_items",
							record_key: scenario.orderId,
						},
					]
				: [],
		);
		assert.equal(
			ctx.reportedStreamFailures.some(
				(message) => message.stream === "order_items",
			),
			scenario.unreadable ||
				scenario.orderId !== "HEB1029384600" ||
				scenario.probe !== "empty",
		);
		assert.equal(
			ctx.emitted.filter((record) => record.stream === "order_items").length,
			0,
		);
		assert.ok(
			ctx.protocolMessages.some(
				(message) =>
					message.type === "DETAIL_COVERAGE" &&
					message.stream === "order_items" &&
					message.hydrated_keys?.includes("HEB1029384600"),
			),
		);
		if (scenario.nutrition) {
			assert.deepEqual(ctx.reportedStreamFailures, []);
			assert.ok(
				ctx.protocolMessages.some(
					(message) =>
						message.type === "STATE" && message.stream === "nutrition",
				),
			);
		}
	});
}

// ─── The declared zero is only believed on a page that shows zero rows ─────
// The tests above answer `evaluate` from a stub. These load real HTML in
// Chromium, so the fallback is decided by what a page contains.

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__",
);

async function withOrderPage<T>(
	handler: Parameters<Page["route"]>[1],
	run: (page: Page) => Promise<T>,
): Promise<T> {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		await page.route("https://www.heb.com/**", handler);
		return await run(page);
	} finally {
		await browser.close();
	}
}

async function processCanceledZeroItemOrder(
	page: Page,
): Promise<{
	coverage: ReturnType<typeof newOrderItemsCoverage>;
	emitted: RecordingDeps["emitted"];
	protocolMessages: EmittedMessage[];
}> {
	const order = makeListOrder({
		itemCount: 0,
		status: "Order canceled",
		unfulfilledCount: 0,
	});
	const coverage = newOrderItemsCoverage();
	const { deps, emitted, protocolMessages } = makeRecordingDeps({
		orderItemsCoverage: coverage,
	});
	await processListOrder(page, deps, makeRunFlags(), order);
	return { coverage, emitted, protocolMessages };
}

test("a canceled zero-item order whose own page settles with no rows is empty", async () => {
	await withOrderPage(
		(route) => route.fulfill({ body: NO_ROWS_HTML, contentType: "text/html" }),
		async (page) => {
			const { coverage, emitted, protocolMessages } =
				await processCanceledZeroItemOrder(page);
			assert.deepEqual(coverage.empty, ["HEB1000000001"]);
			assert.deepEqual(coverage.gap, []);
			assert.equal(
				protocolMessages.some((message) => message.type === "DETAIL_GAP"),
				false,
			);
			assert.equal(
				emitted.some((record) => record.stream === "order_items"),
				false,
			);
		},
	);
});

test("a canceled zero-item order whose rows no identity can key stays a gap, not an empty claim", async () => {
	// Rows inside a scroll port with no position attribute: the surface cannot
	// show that the mounted rows are the whole list, with or without a card.
	const unkeyable = readFileSync(
		join(FIXTURES_DIR, "order-detail-missing-row-identity.html"),
		"utf8",
	);
	await withOrderPage(
		(route) => route.fulfill({ body: unkeyable, contentType: "text/html" }),
		async (page) => {
			const { coverage, emitted, protocolMessages } =
				await processCanceledZeroItemOrder(page);
			assert.deepEqual(
				coverage.empty,
				[],
				"the page shows rows; saying it has none would contradict it",
			);
			assert.deepEqual(coverage.gap, ["HEB1000000001"]);
			assert.equal(
				protocolMessages.filter((message) => message.type === "DETAIL_GAP")
					.length,
				1,
			);
			assert.equal(
				emitted.some((record) => record.stream === "order_items"),
				false,
			);
		},
	);
});

test("a canceled zero-item order whose rows the parser cannot read stays a gap", async () => {
	// Rows keyed by position but without a name: the page lists items, so a
	// parse failure on them is not the same as an empty order.
	const unreadable = `<html><body><main><ul>${[0, 1]
		.map(
			(index) =>
				`<li data-index="${index}"><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/${500 + index}"></a><span data-qe-id="orderItemQty">Qty: 1</span></li>`,
		)
		.join("")}</ul></main></body></html>`;
	await withOrderPage(
		(route) => route.fulfill({ body: unreadable, contentType: "text/html" }),
		async (page) => {
			const { coverage } = await processCanceledZeroItemOrder(page);
			assert.deepEqual(coverage.empty, []);
			assert.deepEqual(coverage.gap, ["HEB1000000001"]);
		},
	);
});

test("a zero-row page that moved off the order's URL is not the order's own page", async () => {
	// A client-side router sending the browser to another route, such as the
	// order list, when the order is not found.
	const movedOn = `${NO_ROWS_HTML}<script>history.replaceState(null, "", "/my-account/your-orders")</script>`;
	await withOrderPage(
		(route) => route.fulfill({ body: movedOn, contentType: "text/html" }),
		async (page) => {
			const { coverage, protocolMessages } =
				await processCanceledZeroItemOrder(page);
			assert.deepEqual(coverage.empty, []);
			assert.deepEqual(coverage.gap, ["HEB1000000001"]);
			assert.equal(
				protocolMessages.filter((message) => message.type === "DETAIL_GAP")
					.length,
				1,
			);
		},
	);
});

// ─── Gap recovery accounting ───────────────────────────────────────────────

const DATED_GAP = (orderId: string, gapId: string) =>
	({
		gap_id: gapId,
		record_key: orderId,
		reference_only: true,
		status: "pending",
		stream: "order_items",
		detail_locator: {
			kind: "heb.order_detail",
			order_id: orderId,
			order_date: "2026-05-20",
		},
	}) satisfies BrowserCollectContext["detailGaps"][number];

test("recovery keeps a gap pending when a page that recovered one gap is followed by an empty page", async () => {
	// Page one recovers order A and fails order B; the host then has nothing
	// more to lease. Stopping on an empty page must not read as "nothing is
	// pending": B was re-deferred and is still open.
	const orderA = "HEB7000000001";
	const orderB = "HEB7000000002";
	const harness = makeRecordingEmit(validateRecord);
	const pending = new Map<string, { gapId: string; recordKey: string | number }>();
	const page = makePageStub(
		NO_ROWS_HTML,
		[],
		(url) => (url.includes(orderA) ? DETAIL_HTML : NO_ROWS_HTML),
	);
	let pagesRequested = 0;
	const result = await recoverPendingOrderItemDetailGaps(
		page,
		{
			detailGaps: [DATED_GAP(orderA, "gap_a"), DATED_GAP(orderB, "gap_b")],
			emit: harness.emit,
			emitRecord: harness.emitRecord,
			emittedAt: EMITTED_AT,
			pendingGapsByOrderId: pending,
			requestDetailGapPage: () => {
				pagesRequested += 1;
				return Promise.resolve([]);
			},
			sendInteraction: noopSendInteraction,
			waitForHydration: immediateWait,
		},
		makeRunFlags(),
	);
	assert.equal(pagesRequested, 1);
	assert.equal(result.recovered, 1);
	assert.equal(result.stoppedWithPending, true);
	assert.deepEqual([...pending.keys()], [orderB]);
});

test("collect fails order_items when a mixed recovery page leaves a gap it cannot read", async () => {
	const ctx = makeContext(
		["orders", "order_items"],
		makePageStub(onePageCanceledOrdersList(), [], DETAIL_HTML),
		{
			detailGaps: [
				DATED_GAP("HEB7000000001", "gap_recovered"),
				{
					gap_id: "gap_unreadable",
					record_key: "unknown",
					reference_only: true,
					status: "pending",
					stream: "order_items",
				},
			],
		},
	);
	await collectQuickly(ctx);
	assert.equal(
		ctx.protocolMessages.filter((message) => message.type === "DETAIL_GAP_RECOVERED")
			.length,
		1,
	);
	assert.ok(
		ctx.reportedStreamFailures.some(
			(message) =>
				message.stream === "order_items" &&
				message.message.includes("unresolved gaps"),
		),
		"one gap was recovered and one cannot be read; the run still has an open gap",
	);
});

test("collect closes a legacy dateless gap once the forward scan delivers the order", async () => {
	// The gap has no date, so recovery cannot emit items for it and re-defers it.
	// The order is on the list page, which supplies the date, and its detail
	// hydrates: the items are delivered and the gap is settled in the same run.
	const orderId = "HEB1029384600";
	const listHtml = onePageCanceledOrdersList().replace(
		"<!-- -->0<!-- --> <!-- -->items",
		"<!-- -->12<!-- --> <!-- -->items",
	);
	const ctx = makeContext(
		["orders", "order_items"],
		makePageStub(listHtml, [], DETAIL_HTML),
		{
			detailGaps: [
				{
					gap_id: "gap_dateless",
					record_key: orderId,
					reference_only: true,
					status: "pending",
					stream: "order_items",
					detail_locator: { kind: "heb.order_detail", order_id: orderId },
				},
			],
		},
	);
	await collectQuickly(ctx);
	assert.deepEqual(ctx.reportedStreamFailures, []);
	const recoveredAt = ctx.events.findIndex(
		(event) =>
			event.kind === "message" &&
			event.message.type === "DETAIL_GAP_RECOVERED" &&
			event.message.gap_id === "gap_dateless",
	);
	assert.notEqual(recoveredAt, -1, "the settled gap is closed");
	const lastItemAt = ctx.events.findLastIndex(
		(event) => event.kind === "record" && event.stream === "order_items",
	);
	assert.ok(lastItemAt !== -1 && lastItemAt < recoveredAt, "items first");
	assert.equal(
		ctx.protocolMessages.filter((message) => message.type === "DETAIL_GAP_RECOVERED")
			.length,
		1,
	);
});

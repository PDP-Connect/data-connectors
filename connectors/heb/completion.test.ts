// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import { hebConnector } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const FIXTURES_DIR = join(
	dirname(fileURLToPath(import.meta.url)),
	"__fixtures__",
);

const EMITTED_AT = "2026-10-05T12:00:00.000Z";

function fixture(name: string): string {
	return readFileSync(join(FIXTURES_DIR, name), "utf8");
}

function onePageOrdersList(): string {
	return fixture("orders-list.html").replace(
		/<li><a data-qe-id="paginationListNum" aria-current="false" href="\/my-account\/your-orders\?page=2">2<\/a><\/li>\s*<li><a data-qe-id="paginationListNum" aria-current="false" href="\/my-account\/your-orders\?page=3">3<\/a><\/li>/,
		"",
	);
}

/** One page whose every order declares a single item, matching the one
 *  Widget row the detail stub renders. */
function singleItemOrdersList(): string {
	return onePageOrdersList().replace(
		/<!-- -->\d+<!-- --> <!-- -->items/g,
		"<!-- -->1<!-- --> <!-- -->items",
	);
}

function findMessages<T extends EmittedMessage["type"]>(
	messages: readonly EmittedMessage[],
	type: T,
): Extract<EmittedMessage, { type: T }>[] {
	return messages.filter(
		(message): message is Extract<EmittedMessage, { type: T }> =>
			message.type === type,
	);
}

const WIDGET_ROW = {
	html: '<li data-qe-id="itemRow" data-index="0"><a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a></li>',
	key: "position:data-index=0",
	unitCount: 1,
};

function makeCollectPage(routes: {
	detailHtml?: string;
	failProductNavigation?: boolean;
	listHtml: string;
	/** Overrides `listHtml` per `?page=N`, for multi-page order history. */
	listHtmlForPage?: (pageNum: number) => string;
	productHtml?: string;
}): Page {
	let currentUrl = "about:blank";
	let currentHtml = routes.listHtml;
	return new Proxy(
		{},
		{
			get(_target, prop): unknown {
				if (prop === "goto") {
					return (url: string): Promise<null> => {
						if (
							routes.failProductNavigation &&
							url.includes("/product-detail/")
						) {
							return Promise.reject(new Error("net::ERR_CONNECTION_RESET"));
						}
						currentUrl = url;
						if (url.includes("/my-account/order-history/")) {
							currentHtml = routes.detailHtml ?? "";
						} else if (url.includes("/product-detail/")) {
							currentHtml = routes.productHtml ?? "<html><body></body></html>";
						} else if (url.includes("/my-account/your-orders")) {
							const requestedPage = /page=(\d+)/.exec(url)?.[1];
							currentHtml =
								routes.listHtmlForPage?.(
									requestedPage ? Number(requestedPage) : 1,
								) ?? routes.listHtml;
						} else {
							currentHtml = "";
						}
						return Promise.resolve(null);
					};
				}
				if (prop === "waitForSelector") {
					return (): Promise<null> =>
						Promise.reject(new Error("selector timeout"));
				}
				if (prop === "waitForTimeout") {
					return (): Promise<void> => Promise.resolve();
				}
				if (prop === "content") {
					return (): Promise<string> => Promise.resolve(currentHtml);
				}
				if (prop === "url") {
					return (): string => currentUrl;
				}
				if (prop === "evaluate") {
					return (): Promise<unknown> => {
						const rows = currentHtml.includes('data-qe-id="itemRowDetailsName"')
							? [WIDGET_ROW]
							: [];
						return Promise.resolve({
							actionableControl: null,
							actionPerformed: null,
							atEnd: true,
							clientHeight: 100,
							loading: false,
							rowCount: rows.length,
							rows,
							scrollHeight: 100,
							scrollTop: 0,
							staticListEvidence: null,
						});
					};
				}
				throw new Error(`unexpected page.${String(prop)} in collect test stub`);
			},
		},
	) as Page;
}

type TestContext = BrowserCollectContext & {
	emitted: { stream: string }[];
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
		protocolMessages: EmittedMessage[];
		reportedStreamFailures: Extract<EmittedMessage, { type: "SKIP_RESULT" }>[];
	};
	return ctx as unknown as TestContext;
}

test("collect: nutrition-only completes verified-empty zero-product runs after H-E-B's empty order renderer", async () => {
	const page = makeCollectPage({
		listHtml: fixture("orders-list-no-past-orders.html"),
	});
	const ctx = makeContext(["nutrition"], page);

	await hebConnector.collect(ctx);

	const states = findMessages(ctx.protocolMessages, "STATE");
	assert.deepEqual(
		states.map((state) => state.stream),
		["nutrition"],
		"nutrition-only verified empty must emit only the requested stream's completion state",
	);
	assert.deepEqual(states[0]?.cursor, {
		completed_at: EMITTED_AT,
		product_count: 0,
		source: "heb_order_history",
	});
	assert.equal(
		findMessages(ctx.protocolMessages, "SKIP_RESULT").length,
		0,
		"H-E-B's own empty order renderer is positive source evidence",
	);
});

test("collect: missing order-list evidence reports stream_collection_failed for requested dependent streams", async () => {
	const page = makeCollectPage({
		listHtml: "<html><body><main><h1>Your orders</h1></main></body></html>",
	});
	const ctx = makeContext(["orders", "order_items", "nutrition"], page);

	await assert.doesNotReject(
		() => hebConnector.collect(ctx),
		"unprovable enumeration must report stream failure instead of a generic thrown error",
	);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream),
		["orders", "order_items", "nutrition"],
	);
	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.reason),
		[
			"stream_collection_failed",
			"stream_collection_failed",
			"stream_collection_failed",
		],
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "STATE").length,
		0,
		"an unproven list enumeration must not mark any requested dependent stream complete",
	);
});

test("collect: nutrition detail coverage gaps report stream_collection_failed and do not emit nutrition STATE", async () => {
	const page = makeCollectPage({
		listHtml: onePageOrdersList(),
	});
	const ctx = makeContext(["order_items", "nutrition"], page, {
		detailGaps: [
			{
				gap_id: "gap_unrecoverable",
				record_key: "HEB0000000000",
				reference_only: true,
				status: "pending",
				stream: "order_items",
			},
		],
		recoveryOnly: true,
	});

	await hebConnector.collect(ctx);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream),
		["nutrition"],
	);
	assert.equal(
		ctx.reportedStreamFailures[0]?.reason,
		"stream_collection_failed",
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "STATE").some(
			(state) => state.stream === "nutrition",
		),
		false,
		"failed nutrition coverage must not mark nutrition complete",
	);
});

test("collect: unresolved prior detail gaps fail the nutrition coverage gate after a verified empty scan", async () => {
	const ctx = makeContext(
		["order_items", "nutrition"],
		makeCollectPage({ listHtml: fixture("orders-list-no-past-orders.html") }),
		{
			detailGaps: [
				{
					gap_id: "gap_unrecoverable",
					record_key: "HEB0000000000",
					reference_only: true,
					status: "pending",
					stream: "order_items",
				},
			],
		},
	);
	await hebConnector.collect(ctx);
	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream),
		["order_items", "nutrition"],
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "STATE").length,
		0,
		"unresolved coverage cannot commit a completed nutrition cursor",
	);
});
test("collect: nutrition-only missing list evidence fails only the requested stream", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({ listHtml: "<html><body></body></html>" }),
	);
	await assert.doesNotReject(
		() => hebConnector.collect(ctx),
		"unprovable enumeration must report stream failure instead of a generic thrown error",
	);
	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream),
		["nutrition"],
	);
	assert.deepEqual(
		ctx.protocolMessages.flatMap((message) =>
			"stream" in message ? [message.stream] : [],
		),
		["nutrition"],
	);
});

const WIDGET_DETAIL_HTML = `<html><body><main><ul>
  <li data-qe-id="itemRow">
    <a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a>
    <span data-qe-id="checkoutItemPrice">$10.00</span>
    <span data-qe-id="orderItemQty">Qty: 1</span>
  </li>
</ul></main></body></html>`;

test("collect: nutrition-only with products emits nutrition records and STATE, no unrequested streams", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			listHtml: singleItemOrdersList(),
		}),
	);

	await hebConnector.collect(ctx);

	assert.deepEqual(
		ctx.emitted.map((record) => record.stream),
		["nutrition"],
		"orders and order_items evidence stays internal",
	);
	assert.deepEqual(
		findMessages(ctx.protocolMessages, "STATE").map((s) => s.cursor),
		[
			{
				completed_at: EMITTED_AT,
				product_count: 1,
				source: "heb_order_history",
			},
		],
	);
	assert.equal(ctx.reportedStreamFailures.length, 0);
});

test("collect: a skipped nutrition product lookup keeps its skip and withholds the completion STATE", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			failProductNavigation: true,
			listHtml: singleItemOrdersList(),
		}),
	);

	await hebConnector.collect(ctx);

	assert.deepEqual(
		findMessages(ctx.protocolMessages, "SKIP_RESULT").map((s) => s.reason),
		["nutrition_navigation_failed"],
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "STATE").length,
		0,
		"a stream with an unresolved product lookup is not finished",
	);
});

test("collect: a failure that is not an enumeration-end problem keeps its own failure meaning", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			listHtml: singleItemOrdersList(),
		}),
		{
			progress: (): Promise<void> => Promise.reject(new Error("boom")),
		},
	);

	await assert.rejects(() => hebConnector.collect(ctx), /boom/);
	assert.equal(ctx.reportedStreamFailures.length, 0);
});

/** One order per page, `maxPage` pages advertised in H-E-B's pagination nav.
 *  `dateForPage` supplies each order's date text. */
function pagedOrdersList(
	pageNum: number,
	maxPage: number,
	dateForPage: (pageNum: number) => string,
): string {
	const nav = `<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=${maxPage}">${maxPage}</a></nav>`;
	const id = `HEB${String(2_000_000_000 + pageNum)}`;
	return `<html><body><main>
      <a href="/my-account/order-history/${id}">${dateForPage(pageNum)} $10.00, 1 items</a>
      ${nav}
    </main></body></html>`;
}

/** Make every `setTimeout` fire on the next microtask so a many-page walk does
 *  not wait out its polite delays. Returns the restore function. */
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

const PENDING_ORDER_ITEMS_GAP = {
	gap_id: "gap_pending_items",
	record_key: "HEB0000000000",
	reference_only: true,
	status: "pending",
	stream: "order_items",
} as const;

test("collect: nutrition-only run does not complete over a pending order_items gap", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({ listHtml: fixture("orders-list-no-past-orders.html") }),
		{ detailGaps: [PENDING_ORDER_ITEMS_GAP] },
	);

	await hebConnector.collect(ctx);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream),
		["nutrition"],
		"a pending item-detail gap leaves some orders' products unenumerated",
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "STATE").length,
		0,
		"nutrition must not emit a completion STATE while item gaps are pending",
	);
	assert.equal(
		ctx.emitted.some((record) => record.stream === "order_items"),
		false,
		"the unrequested order_items stream stays unemitted",
	);
});

test("collect: nutrition-only run still completes when only another stream's gap is pending", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({ listHtml: fixture("orders-list-no-past-orders.html") }),
		{
			detailGaps: [{ ...PENDING_ORDER_ITEMS_GAP, stream: "orders" }],
		},
	);

	await hebConnector.collect(ctx);

	assert.equal(ctx.reportedStreamFailures.length, 0);
	assert.deepEqual(
		findMessages(ctx.protocolMessages, "STATE").map((state) => state.stream),
		["nutrition"],
	);
});

test("collect: nutrition completes when the last advertised page is also older than the resume boundary", async () => {
	const dateForPage = (pageNum: number): string =>
		pageNum === 1 ? "Jul 1, 2026" : "Jan 5, 2026";
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			listHtml: "",
			listHtmlForPage: (pageNum) => pagedOrdersList(pageNum, 2, dateForPage),
		}),
		// The checkpoint a previous healthy run of this account emitted.
		{ state: { orders: { checkpoint: "2026-07-01" } } },
	);

	await hebConnector.collect(ctx);

	assert.equal(
		ctx.reportedStreamFailures.length,
		0,
		"reading the advertised last page is evidence of the end, even when it is older than the boundary",
	);
	assert.deepEqual(
		findMessages(ctx.protocolMessages, "STATE").map((state) => state.stream),
		["nutrition"],
	);
});

test("collect: nutrition still fails when the resume boundary stops the walk before the last page", async () => {
	const dateForPage = (pageNum: number): string =>
		pageNum === 1 ? "Jul 1, 2026" : "Jan 5, 2026";
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			listHtml: "",
			listHtmlForPage: (pageNum) => pagedOrdersList(pageNum, 3, dateForPage),
		}),
		{ state: { orders: { checkpoint: "2026-07-01" } } },
	);

	await hebConnector.collect(ctx);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream),
		["nutrition"],
		"a boundary stop short of the last page is not source evidence of the end",
	);
	assert.equal(findMessages(ctx.protocolMessages, "STATE").length, 0);
});

async function collectOverPageCeiling(streams: readonly string[]) {
	const dateForPage = (pageNum: number): string => {
		const day = 60 - pageNum;
		return day > 30 ? `Jul ${day - 30}, 2026` : `Jun ${day}, 2026`;
	};
	const restoreTimers = collapseTimers();
	try {
		const ctx = makeContext(
			streams,
			makeCollectPage({
				detailHtml: WIDGET_DETAIL_HTML,
				listHtml: "",
				listHtmlForPage: (pageNum) => pagedOrdersList(pageNum, 51, dateForPage),
			}),
		);
		await hebConnector.collect(ctx);
		return ctx;
	} finally {
		restoreTimers();
	}
}

test("collect: an items-only run truncated at the page ceiling fails order_items instead of finishing silently", async () => {
	const ctx = await collectOverPageCeiling(["order_items"]);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => [
			failure.stream,
			typeof failure.recovery_hint === "object" &&
				failure.recovery_hint.retryable,
		]),
		[["order_items", true]],
		"the unread 51st page leaves order_items unproven; orders was not requested so it is not failed",
	);
	assert.equal(findMessages(ctx.protocolMessages, "STATE").length, 0);
	assert.ok(
		ctx.emitted.some((record) => record.stream === "order_items"),
		"records already emitted are kept",
	);
	const coverage = findMessages(ctx.protocolMessages, "DETAIL_COVERAGE").find(
		(message) => message.stream === "order_items",
	);
	assert.ok(coverage);
	assert.ok((coverage.considered ?? 0) > (coverage.covered ?? 0));
});

test("collect: an orders-only run truncated at the page ceiling fails orders and emits no orders STATE", async () => {
	const ctx = await collectOverPageCeiling(["orders"]);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => [
			failure.stream,
			typeof failure.recovery_hint === "object" &&
				failure.recovery_hint.retryable,
		]),
		[["orders", true]],
	);
	assert.equal(findMessages(ctx.protocolMessages, "STATE").length, 0);
	assert.ok(ctx.emitted.some((record) => record.stream === "orders"));
});

test("collect: orders and order_items both fail when the page ceiling cuts the walk", async () => {
	const ctx = await collectOverPageCeiling(["orders", "order_items"]);

	assert.deepEqual(
		ctx.reportedStreamFailures.map((failure) => failure.stream).sort(),
		["order_items", "orders"],
	);
	assert.equal(findMessages(ctx.protocolMessages, "STATE").length, 0);
});

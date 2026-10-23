// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type EmittedRecord,
	makeRecordingEmit,
	skipPoliteDelays,
} from "../../packages/polyfill-connectors/src/test-harness.ts";
import { hebConnector } from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Pacing pauses are anti-bot courtesy that these tests do not assert on, so
// they fire on the next tick instead of sleeping.
after(skipPoliteDelays());

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
	profileHtml?: string;
	responseSucceeded?: boolean;
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
					return (url: string): Promise<unknown> => {
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
							currentHtml =
								routes.productHtml ??
								"<main><div><h3>Nutrition Facts</h3><ul><li>Calories 0</li></ul></div></main>";
						} else if (url.includes("/my-account/your-orders")) {
							const requestedPage = /page=(\d+)/.exec(url)?.[1];
							currentHtml =
								routes.listHtmlForPage?.(
									requestedPage ? Number(requestedPage) : 1,
								) ?? routes.listHtml;
						} else {
							currentHtml = routes.profileHtml ?? "";
						}
						return Promise.resolve({
							ok: () => routes.responseSucceeded ?? true,
						});
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
	emitted: EmittedRecord[];
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
		emitted: EmittedRecord[];
		protocolMessages: EmittedMessage[];
		reportedStreamFailures: Extract<EmittedMessage, { type: "SKIP_RESULT" }>[];
	};
	return ctx as unknown as TestContext;
}

function assertPartial(ctx: TestContext): void {
	assert.equal(findMessages(ctx.protocolMessages, "STATE").length, 0);
	assert.equal(findMessages(ctx.protocolMessages, "DETAIL_COVERAGE").length, 0);
	assert.equal(
		findMessages(ctx.protocolMessages, "DETAIL_GAP_RECOVERED").length,
		0,
	);
	const skips = findMessages(ctx.protocolMessages, "SKIP_RESULT").filter(
		(s) => s.reason === "inventory_not_proven_complete",
	);
	for (const stream of ctx.scope?.streams ?? []) {
		assert.ok(
			skips.some(
				(skip) =>
					skip.stream === stream.name &&
					typeof skip.recovery_hint === "object" &&
					skip.recovery_hint.action === "retry_by_runtime" &&
					skip.recovery_hint.retryable,
			),
			stream.name,
		);
	}
	assert.equal(
		ctx.reportedStreamFailures.length,
		0,
		"unproven inventory is a retryable skip, not a fabricated stream failure",
	);
}

test("collect: nutrition-only keeps owner-unbound empty-renderer results partial", async () => {
	const page = makeCollectPage({
		listHtml: fixture("orders-list-no-past-orders.html"),
	});
	const ctx = makeContext(["nutrition"], page);

	await hebConnector.collect(ctx);
	assertPartial(ctx);
});

test("collect: missing order-list evidence reports retryable inventory skip for requested dependent streams", async () => {
	const page = makeCollectPage({
		listHtml: "<html><body><main><h1>Your orders</h1></main></body></html>",
	});
	const ctx = makeContext(["orders", "order_items", "nutrition"], page);

	await assert.doesNotReject(
		() => hebConnector.collect(ctx),
		"unprovable enumeration must report stream failure instead of a generic thrown error",
	);

	assertPartial(ctx);
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
	assertPartial(ctx);
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
	assertPartial(ctx);
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
	assertPartial(ctx);
});

const WIDGET_DETAIL_HTML = `<html><body><main><ul>
  <li data-qe-id="itemRow">
    <a data-qe-id="itemRowDetailsName" href="/product-detail/widget/500">Widget</a>
    <span data-qe-id="checkoutItemPrice">$10.00</span>
    <span data-qe-id="orderItemQty">Qty: 1</span>
  </li>
</ul></main></body></html>`;

test("collect: nutrition-only with products emits nutrition records without STATE, no unrequested streams", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			listHtml: singleItemOrdersList(),
		}),
	);

	await hebConnector.collect(ctx);
	assertPartial(ctx);
	assert.deepEqual(
		ctx.emitted.map((record) => record.stream),
		["nutrition"],
	);
});

for (const [label, field, amount, expected] of [
	["Calcium", "calcium_mg", "100 mg", 100],
	["Includes Added Sugars", "added_sugar_g", "0 g", 0],
	["Cholesterol", "cholesterol_mg", "5 mg", 5],
	["Saturated Fat", "saturated_fat_g", "1 g", 1],
	["Trans Fat", "trans_fat_g", "0 g", 0],
	["Iron", "iron_mg", "2 mg", 2],
	["Potassium", "potassium_mg", "50 mg", 50],
	["Vitamin D", "vitamin_d_mcg", "3 mcg", 3],
] as const) {
	test(`collect: ${label}-only nutrition survives without proving inventory complete`, async () => {
		const ctx = makeContext(
			["nutrition"],
			makeCollectPage({
				detailHtml: WIDGET_DETAIL_HTML,
				listHtml: singleItemOrdersList(),
				productHtml: `<main><div><h3>Nutrition Facts</h3><ul><li><span>${label}</span><ul><li>${amount}</li></ul></li></ul></div></main>`,
			}),
		);
		await hebConnector.collect(ctx);
		assertPartial(ctx);
		assert.deepEqual(
			ctx.emitted.map((record) => record.stream),
			["nutrition"],
		);
		const record = ctx.emitted[0] as {
			stream: string;
			data: Record<string, unknown>;
		};
		assert.equal(record.data[field], expected);
		assert.equal(record.data.source, "heb_product_page");
		assert.equal(record.data.calories, null);
	});
}

test("collect: a truly empty nutrition panel stays unemitted and retryable", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({
			detailHtml: WIDGET_DETAIL_HTML,
			listHtml: singleItemOrdersList(),
			productHtml: "<main><div><h3>Nutrition Facts</h3><ul></ul></div></main>",
		}),
	);
	await hebConnector.collect(ctx);
	assertPartial(ctx);
	assert.equal(ctx.emitted.length, 0);
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
	assertPartial(ctx);
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
	assertPartial(ctx);
});

test("collect: nutrition-only run still needs source evidence when only another stream's gap is pending", async () => {
	const ctx = makeContext(
		["nutrition"],
		makeCollectPage({ listHtml: fixture("orders-list-no-past-orders.html") }),
		{
			detailGaps: [{ ...PENDING_ORDER_ITEMS_GAP, stream: "orders" }],
		},
	);

	await hebConnector.collect(ctx);
	assertPartial(ctx);
});

test("collect: nutrition remains partial when the last advertised page is also older than the resume boundary", async () => {
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
	assertPartial(ctx);
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
	assertPartial(ctx);
});

test("collect: a full refresh ignores the resume boundary and reads the whole order history", async () => {
	const dateForPage = (pageNum: number): string =>
		pageNum === 1 ? "Jul 1, 2026" : "Jan 5, 2026";
	const pagesRead = new Set<number>();
	const restoreTimers = collapseTimers();
	try {
		const ctx = makeContext(
			["nutrition"],
			makeCollectPage({
				detailHtml: WIDGET_DETAIL_HTML,
				listHtml: "",
				listHtmlForPage: (pageNum) => {
					pagesRead.add(pageNum);
					return pagedOrdersList(pageNum, 3, dateForPage);
				},
			}),
			{
				collectionMode: "full_refresh",
				state: { orders: { checkpoint: "2026-07-01" } },
			},
		);

		await hebConnector.collect(ctx);

		assert.deepEqual(
			[...pagesRead],
			[1, 2, 3],
			"the history that stops an incremental run at page 2 is read to its last page",
		);
		assert.equal(ctx.reportedStreamFailures.length, 0);
	} finally {
		restoreTimers();
	}
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
	assertPartial(ctx);
	assert.ok(
		ctx.emitted.some((record) => record.stream === "order_items"),
		"valid upserts survive a page ceiling",
	);
});

test("collect: an orders-only run truncated at the page ceiling fails orders and emits no orders STATE", async () => {
	const ctx = await collectOverPageCeiling(["orders"]);
	assertPartial(ctx);
	assert.ok(
		ctx.emitted.some((record) => record.stream === "orders"),
		"valid upserts survive a page ceiling",
	);
});

test("collect: orders and order_items both fail when the page ceiling cuts the walk", async () => {
	const ctx = await collectOverPageCeiling(["orders", "order_items"]);
	assertPartial(ctx);
	assert.ok(
		ctx.emitted.some((record) => record.stream === "orders"),
		"valid upserts survive a page ceiling",
	);
});

test("recorded source shape: profile emits all account fields and addresses", async () => {
	const page = makeCollectPage({
		listHtml: "",
		profileHtml: fixture("profile-nextdata-synthetic.html"),
	});
	const ctx = makeContext(["profile"], page);
	await hebConnector.collect(ctx);
	assert.equal(ctx.emitted.length, 1);
	assert.equal(ctx.emitted[0]?.stream, "profile");
	assert.deepEqual(ctx.emitted[0]?.data, {
		id: "profile",
		name: "Example Shopper",
		email: "shopper@example.invalid",
		phone: "2025550100",
		delivery_addresses: [
			{
				address: "123 Example Street, Example City, TX 00000",
				label: "Home",
				is_primary: false,
			},
		],
	});
	assert.equal(findMessages(ctx.protocolMessages, "SKIP_RESULT").length, 0);
});

test("recorded source shape: first-page empty history completes all dependent streams", async () => {
	const page = makeCollectPage({
		listHtml: fixture("orders-empty-nextdata-synthetic.html"),
	});
	const ctx = makeContext(["orders", "order_items", "nutrition"], page);
	await hebConnector.collect(ctx);
	assert.equal(ctx.emitted.length, 0);
	assert.equal(findMessages(ctx.protocolMessages, "SKIP_RESULT").length, 0);
	assert.deepEqual(
		findMessages(ctx.protocolMessages, "STATE")
			.map((m) => m.stream)
			.sort(),
		["nutrition", "orders"],
	);
	assert.deepEqual(
		findMessages(ctx.protocolMessages, "DETAIL_COVERAGE")
			.map((m) => m.stream)
			.sort(),
		["order_items", "orders"],
	);
});

test("recorded source shape: empty first page with a remaining page stays partial", async () => {
	const html = fixture("orders-empty-nextdata-synthetic.html").replace(
		'"pages":[]',
		'"pages":[1,2]',
	);
	const ctx = makeContext(
		["orders", "order_items", "nutrition"],
		makeCollectPage({ listHtml: html }),
	);
	await hebConnector.collect(ctx);
	assertPartial(ctx);
});

test("recorded source shape: failed HTTP response cannot complete profile or empty history", async () => {
	const page = makeCollectPage({
		listHtml: fixture("orders-empty-nextdata-synthetic.html"),
		profileHtml: fixture("profile-nextdata-synthetic.html"),
		responseSucceeded: false,
	});
	const ctx = makeContext(
		["profile", "orders", "order_items", "nutrition"],
		page,
	);
	await hebConnector.collect(ctx);
	assert.equal(ctx.emitted.length, 0);
	assertPartial(ctx);
});

test("recorded source shape: recent prior orders prevent empty-history completion", async () => {
	const ctx = makeContext(
		["orders", "order_items", "nutrition"],
		makeCollectPage({
			listHtml: fixture("orders-empty-nextdata-synthetic.html"),
		}),
		{
			state: { orders: { checkpoint: new Date().toISOString().slice(0, 10) } },
		},
	);
	await hebConnector.collect(ctx);
	assertPartial(ctx);
});

test("recorded source shape: rendered continuation contradicts empty server payload", async () => {
	const html = fixture("orders-empty-nextdata-synthetic.html").replace(
		"</main>",
		'<nav aria-label="Pagination"><a href="?page=1">1</a><a href="?page=2">2</a></nav></main>',
	);
	const ctx = makeContext(
		["orders", "order_items", "nutrition"],
		makeCollectPage({ listHtml: html }),
	);
	await hebConnector.collect(ctx);
	assertPartial(ctx);
});

test("recorded source shape: empty history does not resolve pending item gaps", async () => {
	const ctx = makeContext(
		["orders", "order_items", "nutrition"],
		makeCollectPage({
			listHtml: fixture("orders-empty-nextdata-synthetic.html"),
		}),
		{ detailGaps: [PENDING_ORDER_ITEMS_GAP] },
	);
	await hebConnector.collect(ctx);
	assert.equal(
		findMessages(ctx.protocolMessages, "DETAIL_GAP_RECOVERED").length,
		0,
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "STATE").some(
			(m) => m.stream === "nutrition",
		),
		false,
	);
	assert.equal(
		findMessages(ctx.protocolMessages, "DETAIL_COVERAGE").some(
			(m) => m.stream === "order_items",
		),
		false,
	);
});

for (const rel of ["next nofollow", "nofollow next"]) {
	test(`recorded source shape: multi-token ${rel} continuation stays partial`, async () => {
		const html = fixture("orders-empty-nextdata-synthetic.html").replace(
			"</main>",
			`<a rel="${rel}" href="?cursor=next-batch">Next</a></main>`,
		);
		const ctx = makeContext(
			["orders", "order_items", "nutrition"],
			makeCollectPage({ listHtml: html }),
		);
		await hebConnector.collect(ctx);
		assertPartial(ctx);
	});
}

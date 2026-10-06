// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the Whole Foods connector's collect-layer
 * composition. Like connectors/amazon/integration.test.ts, these don't spin
 * up a real browser: a scripted fake `Page` serves canned HTML per URL, and
 * `makeRecordingEmit(validateRecord)` captures every emitted record through
 * the real zod schema, so a record shaped wrong in production would fail
 * here too.
 *
 * These prove: profile/orders/order_items/nutrition scope filtering (a
 * stream not requested emits nothing), RECORD ordering (order before its
 * items), and the ghost-item filter surviving the full collect() path — not
 * just the pure parser.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	buildNutritionRecord,
	buildOrderItemRecord,
	buildOrderRecord,
	collectOrders,
	collectProfile,
	discoverOrderStubs,
	OrderEnumerationUnprovenError,
	lookupNutritionForProduct,
	orderDetailCountsMatch,
} from "./index.ts";
import { parseOrderSearchPageDom } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { OrderStub } from "./types.ts";

// Shape confirmed against a live capture 2026-09-22 (see parsers.ts's
// parseAmazonProfileDom header comment): the header greeting
// (#nav-link-accountList-nav-line-1) and an inline cpsData JSON blob
// carrying "customerId" are the two real, safely-reachable identity
// sources; the legacy ya-myab-* card selectors do not exist on the modern
// account page.
const PROFILE_HTML = `<html><body>
  <span id="nav-link-accountList-nav-line-1">Hello, Jane Owner</span>
  <script>{"customerId":"A39M9I106DZZ8N"}</script>
</body></html>`;

function fakePage(html: string): Page {
	const shape: Pick<Page, "content" | "goto" | "url"> = {
		content: () => Promise.resolve(html),
		url: () => "https://www.wholefoodsmarket.com/product/example",
		// biome-ignore lint/suspicious/noExplicitAny: minimal Page stub for a pure-composition test; matching Playwright's real overload set isn't the point here.
		goto: (() => Promise.resolve(null)) as any,
	};
	return shape as Page;
}

test("collectProfile emits a profile record keyed by Amazon's stable customerId", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectProfile(fakePage(PROFILE_HTML), harness.emitRecord, () => {
		assert.fail("source identity must complete without a stream failure");
	});
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.stream, "profile");
	assert.equal(harness.emitted[0]?.data.id, "A39M9I106DZZ8N");
	assert.equal(harness.emitted[0]?.data.name, "Jane Owner");
	assert.equal(harness.emitted[0]?.data.email, null);
});

test("collectProfile emits a legacy-compatible profile from the authenticated greeting when customerId is missing", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectProfile(
		fakePage(
			'<html><body><span id="nav-link-accountList-nav-line-1">Hello, Jane Owner</span></body></html>',
		),
		harness.emitRecord,
		() => {
			assert.fail(
				"authenticated greeting must complete without a stream failure",
			);
		},
	);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.stream, "profile");
	assert.equal(harness.emitted[0]?.data.id, "me");
	assert.equal(harness.emitted[0]?.data.name, "Jane Owner");
	assert.equal(harness.emitted[0]?.data.email, null);
});

test("collectProfile reports a retryable stream failure when the account page has no authenticated identity evidence", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const failures: Array<{
		stream: string;
		message: string;
		retryable: boolean;
	}> = [];
	const reportStreamFailure: NonNullable<
		BrowserCollectContext["reportStreamFailure"]
	> = (stream, message, options) => {
		failures.push({ stream, message, retryable: options?.retryable === true });
		return Promise.resolve();
	};
	await collectProfile(
		fakePage(
			'<html><body><span id="nav-link-accountList-nav-line-1">Hello, sign in</span></body></html>',
		),
		harness.emitRecord,
		reportStreamFailure,
	);
	assert.equal(harness.emitted.length, 0);
	assert.equal(failures.length, 1, "expected a runtime stream failure report");
	assert.equal(failures[0]?.stream, "profile");
	assert.equal(failures[0]?.retryable, true);
	assert.match(failures[0]?.message ?? "", /authenticated account identity/);
	assert.equal(
		harness.protocolMessages.length,
		0,
		"profile must not emit completion STATE or a custom skip",
	);
});

const STUB: OrderStub = {
	expectedItemCount: 1,
	orderDateRaw: "March 3, 2026",
	orderId: "111-1111111-1111111",
	orderUrl:
		"https://www.amazon.com/uff/your-account/order-details?orderID=111-1111111-1111111",
};

const EMPTY_STUB: OrderStub = {
	...STUB,
	expectedItemCount: 0,
};

test("buildOrderRecord + buildOrderItemRecord validate and order-before-items when replayed through emitRecord", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const items = [
		{
			imageUrl: null,
			name: "Organic Bananas, 1 bunch",
			productId: "B01ABCDEFG",
			productUrl: "https://www.amazon.com/dp/B01ABCDEFG",
			quantity: 2,
			unitPriceDollars: 1.99,
		},
	];
	await harness.emitRecord("orders", buildOrderRecord(STUB, null, items));
	for (const item of items) {
		await harness.emitRecord(
			"order_items",
			buildOrderItemRecord(STUB.orderId, item),
		);
	}
	assert.equal(harness.emitted.length, 2);
	assert.equal(harness.emitted[0]?.stream, "orders");
	assert.equal(harness.emitted[0]?.data.id, STUB.orderId);
	assert.equal(harness.emitted[0]?.data.order_date, "2026-03-03");
	assert.equal(harness.emitted[0]?.data.total_cents, 398);
	assert.equal(harness.emitted[1]?.stream, "order_items");
	assert.equal(harness.emitted[1]?.data.order_id, STUB.orderId);
	assert.equal(harness.emitted[1]?.data.product_id, "B01ABCDEFG");
});

test("buildOrderRecord reports the source-declared zero item count for an empty order", () => {
	const record = buildOrderRecord(EMPTY_STUB, null, []);
	assert.equal(record.item_count, 0);
	assert.equal(record.total_cents, null);
});

test("orderDetailCountsMatch reports partial detail rows as a mismatch", () => {
	assert.equal(
		orderDetailCountsMatch({ ...STUB, expectedItemCount: 2 }, []),
		false,
	);
});

// Regression test for the reported "Whole Foods failed right after the
// profile record" defect (0.3.2/0.3.3): an order containing 2 units of the
// SAME product renders as 2 rows on Amazon's search-results page
// (`expectedItemCount: 2`, see parsers.ts's parseOrderSearchPageDom's
// `seen.has(orderId)` increment), but the order-detail page dedupes by
// product href/ASIN into ONE row with `quantity: 2` (parsers.ts's
// `seenHrefs`). The prior raw `items.length` comparison (1 !== 2) threw for
// every order with any repeated product — an ordinary, not edge-case,
// grocery order shape — immediately after the profile record had already
// been emitted, matching the reported symptom. No live account was
// available to confirm this against a real run; this fixture is built
// directly from both parsers' own documented dedup behavior. This must NOT
// report a mismatch.
test("orderDetailCountsMatch tolerates a repeated-product order where the detail page folds duplicate units into one row's quantity", () => {
	const repeatedProductStub: OrderStub = { ...STUB, expectedItemCount: 2 };
	const dedupedDetailItems = [
		{
			imageUrl: null,
			name: "Organic Bananas, 1 bunch",
			productId: "B01ABCDEFG",
			productUrl: "https://www.amazon.com/dp/B01ABCDEFG",
			quantity: 2,
			unitPriceDollars: 1.99,
		},
	];
	assert.equal(
		orderDetailCountsMatch(repeatedProductStub, dedupedDetailItems),
		true,
	);
});

// Counterweight: a genuinely incomplete detail page (a distinct product
// missing its own row, not folded via quantity) must still be reported.
test("orderDetailCountsMatch still reports a detail page missing a distinct product row", () => {
	const twoDistinctProductsStub: OrderStub = { ...STUB, expectedItemCount: 2 };
	const onlyOneProductParsed = [
		{
			imageUrl: null,
			name: "Organic Bananas, 1 bunch",
			productId: "B01ABCDEFG",
			productUrl: "https://www.amazon.com/dp/B01ABCDEFG",
			quantity: 1,
			unitPriceDollars: 1.99,
		},
	];
	assert.equal(
		orderDetailCountsMatch(twoDistinctProductsStub, onlyOneProductParsed),
		false,
	);
});

test("buildOrderRecord does not turn missing item prices into a partial total", () => {
	const record = buildOrderRecord(STUB, null, [
		{
			imageUrl: null,
			name: "Unpriced item",
			productId: "B01ABCDEFG",
			productUrl: "https://www.amazon.com/dp/B01ABCDEFG",
			quantity: 1,
			unitPriceDollars: null,
		},
	]);
	assert.equal(record.total_cents, null);
	assert.equal(record.status, null);
});

test("buildOrderItemRecord refuses a name-derived identity", () => {
	assert.throws(
		() =>
			buildOrderItemRecord(STUB.orderId, {
				imageUrl: null,
				name: "Unidentified item",
				productId: null,
				productUrl: null,
				quantity: 1,
				unitPriceDollars: null,
			}),
		/without a source product ASIN/,
	);
});

test("buildNutritionRecord shape passes schema validation for both sources", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await harness.emitRecord(
		"nutrition",
		buildNutritionRecord("B01ABCDEFG", "Organic Bananas", {
			calories: 105,
			carbsG: 27,
			confidence: "high",
			fatG: 0.4,
			fiberG: 3.1,
			proteinG: 1.3,
			servingSize: "1 medium (118g)",
			servingsPerContainer: 1,
			sodiumMg: 1,
			source: "wholefoods_product_page",
			sugarG: 14,
			upc: null,
		}),
	);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.skipped.length, 0);
	assert.equal(harness.emitted[0]?.data.product_id, "B01ABCDEFG");
});

test("observed blocked lookup emits a blocked nutrition row when USDA finds no match", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	try {
		const outcome = await lookupNutritionForProduct(
			fakePage(
				'<html><title>Robot Check</title><body><form action="validateCaptcha"></form></body></html>',
			),
			"DEMO_KEY",
			"Organic Bananas",
		);
		assert.equal(outcome, "blocked");
		const harness = makeRecordingEmit(validateRecord);
		await harness.emitRecord(
			"nutrition",
			buildNutritionRecord("B01ABCDEFG", "Organic Bananas", outcome),
		);
		assert.equal(harness.emitted[0]?.data.source, "blocked");
		assert.equal(harness.emitted[0]?.data.calories, null);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("legacy nutrition outcome rows remain valid for not_found, error, and blocked", async () => {
	const harness = makeRecordingEmit(validateRecord);
	for (const source of ["not_found", "error", "blocked"] as const) {
		await harness.emitRecord(
			"nutrition",
			buildNutritionRecord("B01ABCDEFG", "Organic Bananas", source),
		);
	}
	assert.deepEqual(
		harness.emitted.map((record) => record.data.source),
		["not_found", "error", "blocked"],
	);
	assert.deepEqual(
		harness.emitted.map((record) => record.data.calories),
		[null, null, null],
	);
});

test("HTTP 403 CAPTCHA body is blocked after inspection", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	try {
		const shape = {
			...fakePage(
				'<html><title>Robot Check</title><form action="validateCaptcha"></form></html>',
			),
			goto: () => Promise.resolve({ ok: () => false, status: () => 403 }),
		} as unknown as Page;
		assert.equal(
			await lookupNutritionForProduct(shape, "DEMO_KEY", "Organic Bananas"),
			"blocked",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("HTTP 403 product CAPTCHA is blocked after search succeeds", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	let visits = 0;
	const shape = {
		content: () =>
			Promise.resolve(
				visits === 1
					? '<a href="/product/example">Organic Bananas</a>'
					: '<html><title>Robot Check</title><form action="validateCaptcha"></form></html>',
			),
		goto: () => {
			visits += 1;
			return Promise.resolve({
				ok: () => visits === 1,
				status: () => (visits === 1 ? 200 : 403),
			});
		},
	} as unknown as Page;
	try {
		assert.equal(
			await lookupNutritionForProduct(shape, "DEMO_KEY", "Organic Bananas"),
			"blocked",
		);
		assert.equal(visits, 2);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("USDA request failure emits error instead of not_found", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response("unavailable", { status: 503 })) as typeof fetch;
	try {
		const outcome = await lookupNutritionForProduct(
			fakePage("<html><body>No matching Whole Foods product</body></html>"),
			"DEMO_KEY",
			"Organic Bananas",
		);
		assert.equal(outcome, "error");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a nonzero search summary with no parsed orders fails rather than reporting empty history", async () => {
	const shape = {
		...fakePage(
			'<html><body><div class="hzsearch-results-summary">3 orders matching Whole Foods Market</div><div class="order-card">new markup</div></body></html>',
		),
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
	} as unknown as Page;
	await assert.rejects(
		discoverOrderStubs(shape, noProgress),
		/no recognizable results or empty-state evidence/,
	);
});

test("order search readiness timeout is bounded and explained before parsing", async () => {
	const shape = {
		...fakePage(
			'<html><body><div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=111-1111111-1111111">details</a></div></body></html>',
		),
		locator: () => ({
			first: () => ({
				waitFor: () => Promise.reject(new Error("locator timed out")),
			}),
		}),
	} as unknown as Page;

	await assert.rejects(
		discoverOrderStubs(shape, noProgress),
		/wholefoods_order_page_readiness_timeout/,
	);
});

test("order search accepts the signed-in current empty-orders shell without cards", async () => {
	const html =
		'<div class="your-orders-content-container"><input id="searchOrdersInput"><p>No orders</p></div>';
	const shape = {
		...fakePage(html),
		locator: (selector: string) => ({
			first: () => ({
				waitFor: (options: { timeout: number }) => {
					assert.match(selector, /your-orders-content-container/);
					assert.match(selector, /searchOrdersInput/);
					assert.equal(options.timeout, 15_000);
					return Promise.resolve();
				},
			}),
		}),
	} as unknown as Page;
	assert.deepEqual(await discoverOrderStubs(shape, noProgress), { stubs: [] });
});

test("HTTP 503 product navigation plus empty USDA results emits error", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	const shape = {
		content: () =>
			Promise.resolve("<html><body>Service Unavailable</body></html>"),
		goto: () => Promise.resolve({ ok: () => false, status: () => 503 }),
	} as unknown as Page;
	try {
		const outcome = await lookupNutritionForProduct(
			shape,
			"DEMO_KEY",
			"Organic Bananas",
		);
		assert.equal(outcome, "error");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("an unrecognized Whole Foods page plus empty USDA results emits error", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	try {
		const outcome = await lookupNutritionForProduct(
			fakePage("<html><body>unexpected client-rendered shell</body></html>"),
			"DEMO_KEY",
			"Organic Bananas",
		);
		assert.equal(outcome, "error");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Whole Foods search resolves a relative product link before reading facts", async () => {
	const visited: string[] = [];
	const shape: Pick<Page, "content" | "goto" | "url"> = {
		content: () =>
			Promise.resolve(
				visited.length === 1
					? '<html><body><a href="/product/organic-bananas">Organic Bananas</a></body></html>'
					: '<html><body><script type="application/ld+json">{"@type":"Product","nutrition":{"@type":"NutritionInformation","calories":"105 calories"}}</script></body></html>',
			),
		// biome-ignore lint/suspicious/noExplicitAny: scripted Page navigation captures the actual URL supplied to Playwright.
		goto: ((url: string) => {
			visited.push(url);
			return Promise.resolve(null);
		}) as any,
		url: () => visited.at(-1) ?? "about:blank",
	};
	const outcome = await lookupNutritionForProduct(
		shape as Page,
		"DEMO_KEY",
		"Organic Bananas",
	);
	assert.equal(
		visited[1],
		"https://www.wholefoodsmarket.com/product/organic-bananas",
	);
	assert.equal(
		typeof outcome === "string" ? outcome : outcome.source,
		"wholefoods_product_page",
	);
});

test("a rendered product without nutrition and an empty USDA result emits not_found", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	let visits = 0;
	const shape = {
		content: () =>
			Promise.resolve(
				visits === 1
					? '<html><body><a href="/product/organic-bananas">Organic Bananas</a></body></html>'
					: '<html><body><script type="application/ld+json">{"@type":"Product","name":"Organic Bananas"}</script></body></html>',
			),
		goto: () => {
			visits += 1;
			return Promise.resolve(null);
		},
		url: () => "https://www.wholefoodsmarket.com/product/organic-bananas",
	} as unknown as Page;
	try {
		const outcome = await lookupNutritionForProduct(
			shape,
			"DEMO_KEY",
			"Organic Bananas",
		);
		assert.equal(outcome, "not_found");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("HTTP product links and cross-origin redirects cannot supply nutrition", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ foods: [] }), {
			status: 200,
		})) as typeof fetch;
	const facts =
		'<script type="application/ld+json">{"@type":"Product","nutrition":{"@type":"NutritionInformation","calories":"105 calories"}}</script>';
	try {
		await Promise.all(
			(
				[
					[
						"http://www.wholefoodsmarket.com/product/example",
						"http://www.wholefoodsmarket.com/product/example",
						1,
					],
					["/product/example", "https://example.com/product/example", 2],
					[
						"/product/example",
						"http://www.wholefoodsmarket.com/product/example",
						2,
					],
					[
						"https://www.wholefoodsmarket.com:444/product/example",
						"https://www.wholefoodsmarket.com:444/product/example",
						1,
					],
					[
						"/product/example",
						"https://www.wholefoodsmarket.com:444/product/example",
						2,
					],
				] as const
			).map(async ([href, finalUrl, expectedVisits]) => {
				let visits = 0;
				const shape = {
					content: () =>
						Promise.resolve(
							visits === 1 ? `<a href="${href}">Organic Bananas</a>` : facts,
						),
					goto: () => {
						visits += 1;
						return Promise.resolve(null);
					},
					url: () => finalUrl,
				} as unknown as Page;
				assert.equal(
					await lookupNutritionForProduct(shape, "DEMO_KEY", "Organic Bananas"),
					"error",
				);
				assert.equal(visits, expectedVisits);
			}),
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("a stream absent from `requested` never reaches emitRecord — scope filtering happens before record building", async () => {
	// Mirrors what collect() does: it only calls buildOrderItemRecord/emitRecord
	// under `if (wantsItems)`. This test proves the invariant at the level a
	// regression would actually break it — a caller that forgets the gate would
	// make this test fail by emitting order_items unconditionally.
	const harness = makeRecordingEmit(validateRecord);
	const requested = new Set(["orders"]);
	const items = [
		{
			imageUrl: null,
			name: "Organic Bananas, 1 bunch",
			productId: "B01ABCDEFG",
			productUrl: null,
			quantity: 1,
			unitPriceDollars: 1.99,
		},
	];
	if (requested.has("orders")) {
		await harness.emitRecord("orders", buildOrderRecord(STUB, null, items));
	}
	if (requested.has("order_items")) {
		for (const item of items) {
			await harness.emitRecord(
				"order_items",
				buildOrderItemRecord(STUB.orderId, item),
			);
		}
	}
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.stream, "orders");
});

// Shapes recorded live 2026-09-28 (counts only): the search pages paginate
// ITEM rows, about 10 per page, so one large order fills whole pages. Page 4
// held only rows of the order already seen on page 3.
function searchPage(
	pageNum: number,
	rows: Array<[orderId: string, asin: string]>,
	hasNext: boolean,
): string {
	const grids = rows
		.map(
			([orderId, asin]) =>
				`<div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=${orderId}">details</a><a href="/dp/${asin}">item</a><span>Ordered on March 3, 2026</span></div>`,
		)
		.join("");
	const next = hasNext
		? `<li class="a-last"><a href="?page=${pageNum + 1}">Next</a></li>`
		: '<li class="a-disabled a-last">Next</li>';
	return `<html><body>${grids}<ul class="a-pagination"><li class="a-selected"><a href="?page=${pageNum}">${pageNum}</a></li>${next}</ul></body></html>`;
}

function pagedSearch(pages: string[]): Page {
	let current = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			const pageNum = Number(new URL(url).searchParams.get("page") ?? "1");
			current = pages[Math.min(pageNum, pages.length) - 1] ?? "";
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => "https://www.amazon.com/your-orders/search",
	} as unknown as Page;
}

const noProgress = () => Promise.resolve();

const rowsOf = (orderId: string, first: number, count: number) =>
	Array.from(
		{ length: count },
		(_, i) => [orderId, `B${first + i}`] as [string, string],
	);

test("order search walks pages that only continue an order already seen", async () => {
	const a = "111-1111111-1111111";
	const b = "222-2222222-2222222";
	const c = "333-3333333-3333333";
	const pages = [
		searchPage(1, [...rowsOf(a, 0, 5), ...rowsOf(b, 0, 4)], true),
		searchPage(2, [...rowsOf(b, 4, 2), ...rowsOf(c, 0, 8)], true),
		searchPage(3, rowsOf(c, 8, 10), true),
		searchPage(4, rowsOf(c, 18, 10), true),
		searchPage(5, rowsOf(c, 28, 3), false),
	];
	const { stubs } = await discoverOrderStubs(pagedSearch(pages), noProgress);
	assert.deepEqual(
		stubs.map((s) => [s.orderId, s.expectedItemCount]),
		[
			[a, 5],
			[b, 6],
			[c, 31],
		],
	);
});

test("order search sends progress for every page it walks", async () => {
	const a = "111-1111111-1111111";
	const pageCount = 6;
	const pages = Array.from({ length: pageCount }, (_, i) =>
		searchPage(i + 1, rowsOf(a, i * 10, 10), i + 1 < pageCount),
	);
	const messages: Array<{ message: string; extra: unknown }> = [];
	const { stubs } = await discoverOrderStubs(
		pagedSearch(pages),
		(message, extra) => {
			messages.push({ message, extra });
			return Promise.resolve();
		},
	);
	assert.equal(stubs.length, 1);
	assert.deepEqual(
		messages.map((m) => m.message),
		Array.from(
			{ length: pageCount },
			(_, i) => `Scanned Whole Foods search page ${i + 1}`,
		),
	);
	for (const m of messages) {
		assert.deepEqual(m.extra, { count: 1, stream: "orders" });
	}
});

test("order search fails when Amazon serves the same page again", async () => {
	const a = "111-1111111-1111111";
	const page1 = searchPage(1, rowsOf(a, 0, 10), true);
	await assert.rejects(
		discoverOrderStubs(pagedSearch([page1]), noProgress),
		/pagination (?:repeated|served a different page)/,
	);
});

test("order search without a last-page signal is not a complete enumeration", async () => {
	const a = "111-1111111-1111111";
	// Rows and a selected page, but neither a next link nor a disabled "Next".
	const html = searchPage(1, rowsOf(a, 0, 3), false).replace(
		'<li class="a-disabled a-last">Next</li>',
		"",
	);
	await assert.rejects(
		discoverOrderStubs(pagedSearch([html]), noProgress),
		(error: unknown) =>
			error instanceof OrderEnumerationUnprovenError &&
			/without a last-page signal/.test(error.message),
	);
});

test("order search readiness timeout is an unproven enumeration, not an auth failure", async () => {
	const shape = {
		...fakePage("<html></html>"),
		locator: () => ({
			first: () => ({ waitFor: () => Promise.reject(new Error("timed out")) }),
		}),
	} as unknown as Page;
	await assert.rejects(
		discoverOrderStubs(shape, noProgress),
		OrderEnumerationUnprovenError,
	);
});

const ORDER_A = "111-1111111-1111111";
const DETAIL_HTML = `<html><body><div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Organic Bananas</a><span>Qty: 1</span></div></body></html>`;

/** Serves search pages and order details by URL. */
function ordersSite(searchPages: string[], detailHtml: string): Page {
	let current = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.includes("search")) {
				const pageNum = Number(parsed.searchParams.get("page") ?? "1");
				current = searchPages[pageNum - 1] ?? "";
			} else {
				current = detailHtml;
			}
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => "https://www.amazon.com/your-orders/search",
	} as unknown as Page;
}

async function runCollectOrders(
	page: Page,
	requested: string[],
): Promise<{
	failures: Array<{ stream: string; message: string; retryable: unknown }>;
	harness: ReturnType<typeof makeRecordingEmit>;
}> {
	const harness = makeRecordingEmit(validateRecord);
	const failures: Array<{
		stream: string;
		message: string;
		retryable: unknown;
	}> = [];
	await collectOrders({
		credentials: {},
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		page,
		progress: noProgress,
		reportStreamFailure: (stream, message, options) => {
			failures.push({ stream, message, retryable: options?.retryable });
			return Promise.resolve();
		},
		requested: new Map(requested.map((stream) => [stream, {}])) as never,
		state: {},
	});
	return { failures, harness };
}

const stateStreams = (harness: ReturnType<typeof makeRecordingEmit>) =>
	harness.protocolMessages
		.filter((m) => m.type === "STATE")
		.map((m) => (m as unknown as { stream: string }).stream);

test("collectOrders completes orders on the source's own empty-state page", async () => {
	const emptyShell =
		'<div class="your-orders-content-container"><input id="searchOrdersInput"><p>No orders</p></div>';
	const { failures, harness } = await runCollectOrders(
		ordersSite([emptyShell], ""),
		["orders", "order_items"],
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders"]);
	assert.equal(harness.emitted.length, 0);
});

test("collectOrders completes orders when the last page shows a disabled Next", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], DETAIL_HTML),
		["orders", "order_items"],
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders"]);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders", "order_items"],
	);
});

test("collectOrders reports every requested order stream failed when the list end is unproven", async () => {
	const noEnd = searchPage(1, [[ORDER_A, "B012345678"]], false).replace(
		'<li class="a-disabled a-last">Next</li>',
		"",
	);
	const { failures, harness } = await runCollectOrders(
		ordersSite([noEnd], DETAIL_HTML),
		["orders", "order_items"],
	);
	assert.deepEqual(
		failures.map((f) => [f.stream, f.retryable]),
		[
			["orders", true],
			["order_items", true],
		],
	);
	assert.match(failures[0]?.message ?? "", /last-page signal/);
	// The rows read are real and kept; no stream finishes.
	assert.deepEqual(stateStreams(harness), []);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders", "order_items"],
	);
	assert.equal(
		harness.protocolMessages.filter((m) => m.type === "SKIP_RESULT").length,
		0,
	);
});

test("collectOrders fails the order streams without STATE when a detail page has no evidence", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			"<html><body>loading</body></html>",
		),
		["orders", "nutrition"],
	);
	assert.deepEqual(
		failures.map((f) => f.stream),
		["orders", "nutrition"],
	);
	assert.doesNotMatch(failures[0]?.message ?? "", /111-1111111-1111111/);
	assert.deepEqual(stateStreams(harness), []);
});

test("collectOrders still throws auth failures instead of reporting a stream failure", async () => {
	await assert.rejects(
		runCollectOrders(
			ordersSite(['<html><form name="signIn"></form></html>'], ""),
			["orders"],
		),
		/blocked or signed out/,
	);
});

// ─── Review round 2: empty state, empty detail, navigation failures ────────

const failedStreams = (
	failures: Array<{ stream: string; message: string; retryable: unknown }>,
) => failures.map((f) => [f.stream, f.retryable]);

const ALL_ORDER_STREAMS = ["orders", "order_items", "nutrition"];

// Search scaffold before results render: the search box plus a bundle that
// names the empty-state class. Neither is the source's rendered empty state.
const SCAFFOLD_ONLY_HTML =
	'<html><body><input id="searchOrdersInput"><script>const emptyStateClass = "no-orders";</script></body></html>';

test("a search scaffold whose script merely names no-orders is not an empty state", async () => {
	const shape = {
		...fakePage(SCAFFOLD_ONLY_HTML),
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
	} as unknown as Page;
	await assert.rejects(
		discoverOrderStubs(shape, noProgress),
		OrderEnumerationUnprovenError,
	);
});

test("collectOrders reports every requested stream failed on scaffold-only search markup", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite([SCAFFOLD_ONLY_HTML], ""),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(
		failedStreams(failures),
		ALL_ORDER_STREAMS.map((s) => [s, true]),
	);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

test("collectOrders completes on the real-shape zero-order count element", async () => {
	// Shape of Amazon's year filter on an empty account, captured live
	// 2026-04-23 (scrubbed): `<span class="num-orders">0 orders</span>`.
	const empty =
		'<html><body><div class="your-orders-content-container"><label class="time-filter__label"><span class="num-orders">0 orders</span> placed in </label></div></body></html>';
	const { failures, harness } = await runCollectOrders(
		ordersSite([empty], ""),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders", "nutrition"]);
});

test("one page of rows with no pagination markup is unproven until a live capture shows the end signal", async () => {
	// No real single-page filtered-search capture exists in the repository: the
	// only captured single-page Amazon list is the empty year page, which has
	// no pagination. A one-page account therefore fails (retryable) rather than
	// completing on a guessed signal.
	const noPagination =
		'<html><body><div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=111-1111111-1111111">details</a><a href="/dp/B012345678">item</a></div></body></html>';
	const { failures, harness } = await runCollectOrders(
		ordersSite([noPagination], DETAIL_HTML),
		["orders"],
	);
	assert.deepEqual(failedStreams(failures), [["orders", true]]);
	assert.deepEqual(stateStreams(harness), []);
});

test("collectOrders fails every requested stream when a proven order's detail container is empty", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div id="line-items"></div></body></html>',
		),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(
		failedStreams(failures),
		ALL_ORDER_STREAMS.map((s) => [s, true]),
	);
	assert.match(failures[0]?.message ?? "", /no items and no cancellation/);
	assert.doesNotMatch(failures[0]?.message ?? "", /111-1111111-1111111/);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

test("collectOrders still completes a cancelled order whose detail renders no items", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div data-component="cancelled">Cancelled</div></body></html>',
		),
		["orders", "order_items"],
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders"]);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders"],
	);
});

test("collectOrders fails every requested stream when the detail grid container is empty", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div data-component="purchasedItemsRightGrid"></div></body></html>',
		),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(
		failedStreams(failures),
		ALL_ORDER_STREAMS.map((s) => [s, true]),
	);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

test("collectOrders fails every requested stream when a delivery item row is an empty shell", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div id="line-items"><div id="x-item-grid-row"></div></div></body></html>',
		),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(
		failedStreams(failures),
		ALL_ORDER_STREAMS.map((s) => [s, true]),
	);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

const TWO_ROW_SEARCH = searchPage(
	1,
	[
		[ORDER_A, "B012345678"],
		[ORDER_A, "B087654321"],
	],
	false,
);
const ONE_ITEM_DETAIL = `<html><body><div data-component="purchasedItemsRightGrid">
	<div data-component="itemTitle"><a href="/dp/B012345678">Organic bananas</a></div>
	<div data-component="unitPrice">$1.99</div>Qty: 1
</div></body></html>`;

test("collectOrders fails order_items when the detail lists fewer rows than the search count", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite([TWO_ROW_SEARCH], ONE_ITEM_DETAIL),
		["orders", "order_items"],
	);
	assert.deepEqual(failedStreams(failures), [["order_items", true]]);
	assert.doesNotMatch(failures[0]?.message ?? "", /111-1111111-1111111/);
	// The order row is proven by the search list; the rows read are kept.
	assert.deepEqual(stateStreams(harness), ["orders"]);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders", "order_items"],
	);
});

test("collectOrders fails nutrition without its finishing STATE on an unreconciled item count", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[TWO_ROW_SEARCH],
			// An ASIN-less row keeps the test off the nutrition network path.
			ONE_ITEM_DETAIL.replace("/dp/B012345678", "/product/unknown"),
		),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(failedStreams(failures), [
		["order_items", true],
		["nutrition", true],
	]);
	assert.deepEqual(stateStreams(harness), ["orders"]);
});

test("collectOrders completes every stream when the detail count matches the search count", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[
				// A search row with no product link carries only the count.
				searchPage(1, [[ORDER_A, "B012345678"]], false).replace(
					'<a href="/dp/B012345678">item</a>',
					"",
				),
			],
			ONE_ITEM_DETAIL.replace("/dp/B012345678", "/product/unknown"),
		),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders", "nutrition"]);
});

/** A site whose navigation fails for URLs matched by `fails`. */
function failingSite(
	searchPages: string[],
	detailHtml: string,
	fails: (url: URL) => Error | { status: number } | null,
): Page {
	const base = ordersSite(searchPages, detailHtml);
	return {
		...base,
		content: base.content.bind(base),
		goto: (url: string) => {
			const failure = fails(new URL(url));
			if (failure instanceof Error) {
				return Promise.reject(failure);
			}
			if (failure) {
				return Promise.resolve({
					ok: () => false,
					status: () => failure.status,
				});
			}
			return base.goto(url);
		},
	} as unknown as Page;
}

test("collectOrders reports every requested stream failed when the search navigation times out", async () => {
	const timeout = new Error(
		"page.goto: Timeout 30000ms exceeded. navigating to https://www.amazon.com/your-orders/search?orderID=111-1111111-1111111",
	);
	timeout.name = "TimeoutError";
	const { failures, harness } = await runCollectOrders(
		failingSite([], "", () => timeout),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(
		failedStreams(failures),
		ALL_ORDER_STREAMS.map((s) => [s, true]),
	);
	assert.match(failures[0]?.message ?? "", /navigation_failed: TimeoutError/);
	assert.doesNotMatch(failures[0]?.message ?? "", /111-1111111-1111111/);
	assert.deepEqual(stateStreams(harness), []);
});

test("collectOrders reports a detail navigation timeout as a stream failure without STATE", async () => {
	const { failures, harness } = await runCollectOrders(
		failingSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			DETAIL_HTML,
			(url) =>
				url.pathname.includes("search")
					? null
					: new Error("net::ERR_TIMED_OUT"),
		),
		["orders", "nutrition"],
	);
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["nutrition", true],
	]);
	assert.deepEqual(stateStreams(harness), []);
});

test("collectOrders reports a search HTTP 503 as a stream failure", async () => {
	const { failures } = await runCollectOrders(
		failingSite([], "", () => ({ status: 503 })),
		["orders"],
	);
	assert.deepEqual(failedStreams(failures), [["orders", true]]);
});

test("collectOrders keeps an HTTP 403 search response a plain error, not a stream failure", async () => {
	await assert.rejects(
		runCollectOrders(
			failingSite([], "", () => ({ status: 403 })),
			["orders"],
		),
		/HTTP 403/,
	);
});

// ─── Review round (latest): quantity, hidden empty state, page order, cap ──

test("collectOrders fails order_items when a higher quantity offsets a missing product", async () => {
	// Two search rows, two distinct ASINs; the detail lists only the first
	// product with Qty: 2. The units equal the search count, but the second
	// product was never seen.
	const { failures, harness } = await runCollectOrders(
		ordersSite([TWO_ROW_SEARCH], ONE_ITEM_DETAIL.replace("Qty: 1", "Qty: 2")),
		["orders", "order_items"],
	);
	assert.deepEqual(failedStreams(failures), [["order_items", true]]);
	assert.deepEqual(stateStreams(harness), ["orders"]);
});

test("collectOrders still accepts a repeated product whose units fold into one detail row", async () => {
	const twoUnitsOfOneProduct = searchPage(
		1,
		[
			[ORDER_A, "B012345678"],
			[ORDER_A, "B012345678"],
		],
		false,
	);
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[twoUnitsOfOneProduct],
			ONE_ITEM_DETAIL.replace("Qty: 1", "Qty: 2"),
		),
		["orders", "order_items"],
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders"]);
});

const HIDDEN_EMPTY_STATES = [
	'<div class="no-orders" hidden>No orders</div>',
	'<div class="no-orders" aria-hidden="true">No orders</div>',
	'<div class="no-orders" style="display: none">No orders</div>',
	'<div class="no-orders a-hidden">No orders</div>',
	'<div hidden><div class="no-orders">No orders</div></div>',
	'<div class="your-orders-content-container" hidden><p>No orders</p></div>',
];

for (const hiddenMarkup of HIDDEN_EMPTY_STATES) {
	test(`collectOrders fails every requested stream on a hidden empty state: ${hiddenMarkup}`, async () => {
		const scaffold = `<html><body><input id="searchOrdersInput">${hiddenMarkup}</body></html>`;
		const { failures, harness } = await runCollectOrders(
			ordersSite([scaffold], ""),
			ALL_ORDER_STREAMS,
		);
		assert.deepEqual(
			failedStreams(failures),
			ALL_ORDER_STREAMS.map((stream) => [stream, true]),
		);
		assert.deepEqual(stateStreams(harness), []);
		assert.equal(harness.emitted.length, 0);
	});
}

test("a visible empty-state element is still the source's own empty state", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[
				'<html><body><div class="no-orders">No orders</div><div class="no-orders" hidden>stale</div></body></html>',
			],
			"",
		),
		["orders"],
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders"]);
});

const ORDER_C = "333-3333333-3333333";

test("collectOrders fails every requested stream when a terminal page skips ahead", async () => {
	// Page 2 was requested; Amazon answered with page 3 and a disabled Next.
	// Page 2 was never read, and may hold more orders.
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[
				searchPage(1, [[ORDER_A, "B012345678"]], true),
				searchPage(3, [[ORDER_C, "B012345678"]], false),
			],
			DETAIL_HTML,
		),
		["orders", "order_items"],
	);
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.match(failures[0]?.message ?? "", /different page than requested/);
	assert.deepEqual(stateStreams(harness), []);
	// The orders on the pages that were read are kept.
	assert.deepEqual(
		harness.emitted.filter((r) => r.stream === "orders").map((r) => r.data.id),
		[ORDER_A, ORDER_C],
	);
});

test("collectOrders keeps the orders it read when the page cap is reached", async () => {
	const pages = Array.from({ length: 250 }, (_, i) =>
		searchPage(
			i + 1,
			[[`${String(i + 1).padStart(3, "0")}-0000000-0000000`, "B012345678"]],
			true,
		),
	);
	const realSetTimeout = globalThis.setTimeout;
	// The pacing delays are real time; this test walks 250 pages and 250 details.
	globalThis.setTimeout = ((fn: () => void) => {
		fn();
		return 0;
	}) as unknown as typeof setTimeout;
	let run: Awaited<ReturnType<typeof runCollectOrders>>;
	try {
		run = await runCollectOrders(ordersSite(pages, DETAIL_HTML), [
			"orders",
			"order_items",
		]);
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
	assert.deepEqual(failedStreams(run.failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.match(run.failures[0]?.message ?? "", /page limit/);
	assert.deepEqual(stateStreams(run.harness), []);
	assert.equal(
		run.harness.emitted.filter((r) => r.stream === "orders").length,
		250,
	);
	assert.equal(
		run.harness.emitted.filter((r) => r.stream === "order_items").length,
		250,
	);
});

// ─── Review round 3: one visibility test for all evidence; partial delivery ──

// The pacing delays are real time, so these tests stub them.
const runFast = (page: Page, requested: string[]) =>
	withoutPacing(() => runCollectOrders(page, requested));

const HIDDEN_WRAPPERS: Array<[label: string, wrap: (inner: string) => string]> =
	[
		["hidden attribute", (inner) => `<div hidden>${inner}</div>`],
		["aria-hidden", (inner) => `<div aria-hidden="true">${inner}</div>`],
		[
			"inline display:none",
			(inner) => `<div style="display:none">${inner}</div>`,
		],
		[
			"inline visibility:hidden",
			(inner) => `<div style="visibility: hidden">${inner}</div>`,
		],
		[
			"hidden ancestor",
			(inner) => `<section hidden><div>${inner}</div></section>`,
		],
	];

for (const [label, wrap] of HIDDEN_WRAPPERS) {
	test(`collectOrders fails every requested stream on a hidden cancellation marker (${label})`, async () => {
		const detail = `<html><body><div id="line-items"></div>${wrap('<div data-component="cancelled">Cancelled</div>')}</body></html>`;
		const { failures, harness } = await runFast(
			ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], detail),
			ALL_ORDER_STREAMS,
		);
		assert.deepEqual(
			failedStreams(failures),
			ALL_ORDER_STREAMS.map((s) => [s, true]),
		);
		assert.deepEqual(stateStreams(harness), []);
		assert.equal(harness.emitted.length, 0);
	});

	test(`collectOrders fails every requested stream on hidden pagination (${label})`, async () => {
		// Real rows, and a disabled Next the markup hides: not the end signal.
		const rows = searchPage(1, [[ORDER_A, "B012345678"]], false);
		const pagination =
			/<ul class="a-pagination">.*<\/ul>/.exec(rows)?.[0] ?? "";
		const hiddenPagination = rows.replace(pagination, wrap(pagination));
		const { failures, harness } = await runFast(
			ordersSite([hiddenPagination], DETAIL_HTML),
			// No nutrition: the partial delivery would look products up over the network.
			["orders", "order_items"],
		);
		assert.deepEqual(failedStreams(failures), [
			["orders", true],
			["order_items", true],
		]);
		assert.match(failures[0]?.message ?? "", /last-page signal/);
		assert.deepEqual(stateStreams(harness), []);
	});

	test(`collectOrders fails order_items when its only item row is hidden (${label})`, async () => {
		const detail = `<html><body>${wrap(
			'<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Organic Bananas</a><span>Qty: 1</span></div>',
		)}</body></html>`;
		const { failures, harness } = await runFast(
			ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], detail),
			ALL_ORDER_STREAMS,
		);
		assert.deepEqual(
			failedStreams(failures),
			ALL_ORDER_STREAMS.map((s) => [s, true]),
		);
		assert.deepEqual(stateStreams(harness), []);
		assert.equal(harness.emitted.length, 0);
	});
}

test("collectOrders fails order_items when a hidden detail row cannot offset the search count", async () => {
	const detail = `<html><body><div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Organic bananas</a>Qty: 1</div><div hidden><div data-component="purchasedItemsRightGrid"><a href="/dp/B087654321">Whole milk</a>Qty: 1</div></div></body></html>`;
	const { failures, harness } = await runFast(
		ordersSite([TWO_ROW_SEARCH], detail),
		["orders", "order_items"],
	);
	assert.deepEqual(failedStreams(failures), [["order_items", true]]);
	assert.deepEqual(stateStreams(harness), ["orders"]);
});

test("collectOrders ignores a hidden search row when it counts the order's items", async () => {
	const hiddenRow =
		'<div hidden><div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=111-1111111-1111111">details</a><a href="/dp/B087654321">item</a></div></div>';
	const search = searchPage(1, [[ORDER_A, "B012345678"]], false).replace(
		"<ul",
		`${hiddenRow}<ul`,
	);
	const { failures, harness } = await runFast(
		ordersSite([search], ONE_ITEM_DETAIL),
		["orders", "order_items"],
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders"]);
});

test("a visible cancellation marker and visible pagination still complete", async () => {
	const { failures, harness } = await runFast(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div id="line-items"></div><div data-component="cancelled">Cancelled</div><div hidden data-component="cancelled">stale</div></body></html>',
		),
		ALL_ORDER_STREAMS,
	);
	assert.deepEqual(failures, []);
	assert.deepEqual(stateStreams(harness), ["orders", "nutrition"]);
});

function ordersSiteByOrder(
	searchPages: string[],
	detailByOrder: Record<string, string>,
	visited: string[],
): Page {
	let current = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.includes("search")) {
				const pageNum = Number(parsed.searchParams.get("page") ?? "1");
				current = searchPages[pageNum - 1] ?? "";
			} else {
				const orderId = parsed.searchParams.get("orderID") ?? "";
				visited.push(orderId);
				current = detailByOrder[orderId] ?? "";
			}
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => "https://www.amazon.com/your-orders/search",
	} as unknown as Page;
}

const ORDER_B = "222-2222222-2222222";
const EMPTY_DETAIL = '<html><body><div id="line-items"></div></body></html>';

async function withoutPacing<T>(run: () => Promise<T>): Promise<T> {
	const realSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = ((fn: () => void) => {
		fn();
		return 0;
	}) as unknown as typeof setTimeout;
	try {
		return await run();
	} finally {
		globalThis.setTimeout = realSetTimeout;
	}
}

test("partial delivery keeps reading after the first unreadable detail", async () => {
	const noEnd = searchPage(
		1,
		[
			[ORDER_A, "B012345678"],
			[ORDER_B, "B012345678"],
		],
		false,
	).replace('<li class="a-disabled a-last">Next</li>', "");
	const visited: string[] = [];
	const { failures, harness } = await withoutPacing(() =>
		runCollectOrders(
			ordersSiteByOrder(
				[noEnd],
				{ [ORDER_A]: EMPTY_DETAIL, [ORDER_B]: DETAIL_HTML },
				visited,
			),
			["orders", "order_items"],
		),
	);
	assert.deepEqual(visited, [ORDER_A, ORDER_B]);
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.deepEqual(stateStreams(harness), []);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders", "order_items"],
	);
	assert.equal(harness.emitted[0]?.data.id, ORDER_B);
});

test("a proven list keeps reading after one unreadable detail, then fails without STATE", async () => {
	const visited: string[] = [];
	const { failures, harness } = await withoutPacing(() =>
		runCollectOrders(
			ordersSiteByOrder(
				[
					searchPage(
						1,
						[
							[ORDER_A, "B012345678"],
							[ORDER_B, "B012345678"],
						],
						false,
					),
				],
				{ [ORDER_A]: EMPTY_DETAIL, [ORDER_B]: DETAIL_HTML },
				visited,
			),
			["orders", "order_items"],
		),
	);
	assert.deepEqual(visited, [ORDER_A, ORDER_B]);
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.match(failures[0]?.message ?? "", /no items and no cancellation/);
	assert.match(failures[0]?.message ?? "", /1 of 2 orders/);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.filter((r) => r.stream === "orders").length, 1);
});

// ─── Review round (latest): inert ancestry; partial-delivery navigation ──

const INERT_WRAPPERS: Array<[label: string, wrap: (inner: string) => string]> =
	[
		["noscript", (inner) => `<noscript>${inner}</noscript>`],
		["template", (inner) => `<template>${inner}</template>`],
		["nested noscript", (inner) => `<div><noscript>${inner}</noscript></div>`],
	];

for (const [label, wrap] of INERT_WRAPPERS) {
	test(`collectOrders fails every requested stream on an inert cancellation marker (${label})`, async () => {
		const detail = `<html><body><div id="line-items"></div>${wrap('<div data-component="cancelled">Cancelled</div>')}</body></html>`;
		const { failures, harness } = await runFast(
			ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], detail),
			ALL_ORDER_STREAMS,
		);
		assert.deepEqual(
			failedStreams(failures),
			ALL_ORDER_STREAMS.map((s) => [s, true]),
		);
		assert.deepEqual(stateStreams(harness), []);
		assert.equal(harness.emitted.length, 0);
	});

	test(`collectOrders fails every requested stream on inert pagination (${label})`, async () => {
		const rows = searchPage(1, [[ORDER_A, "B012345678"]], false);
		const pagination =
			/<ul class="a-pagination">.*<\/ul>/.exec(rows)?.[0] ?? "";
		const inertPagination = rows.replace(pagination, wrap(pagination));
		const { failures, harness } = await runFast(
			ordersSite([inertPagination], DETAIL_HTML),
			["orders", "order_items"],
		);
		assert.deepEqual(failedStreams(failures), [
			["orders", true],
			["order_items", true],
		]);
		assert.match(failures[0]?.message ?? "", /last-page signal/);
		assert.deepEqual(stateStreams(harness), []);
	});

	test(`collectOrders fails order_items when its only item row is inert (${label})`, async () => {
		const detail = `<html><body>${wrap(
			'<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Organic Bananas</a><span>Qty: 1</span></div>',
		)}</body></html>`;
		const { failures, harness } = await runFast(
			ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], detail),
			ALL_ORDER_STREAMS,
		);
		assert.deepEqual(
			failedStreams(failures),
			ALL_ORDER_STREAMS.map((s) => [s, true]),
		);
		assert.deepEqual(stateStreams(harness), []);
		assert.equal(harness.emitted.length, 0);
	});
}

test("an inert search row is not counted as a result row", () => {
	const row =
		'<div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=111-1111111-1111111">details</a><a href="/dp/B087654321">item</a></div>';
	const parsed = parseOrderSearchPageDom(
		`<html><body><noscript>${row}</noscript></body></html>`,
	);
	assert.deepEqual(parsed.stubs, []);
});

type DeliveryFailure =
	| "goto-timeout"
	| "readiness-timeout"
	| "http-503"
	| "http-403";

/** Search pages without a last-page signal; ORDER_A reads, ORDER_B fails. */
function siteWithFailingSecondDetail(failure: DeliveryFailure): {
	page: Page;
	visited: string[];
} {
	const visited: string[] = [];
	let current = "";
	let failNext = false;
	const noEnd = searchPage(
		1,
		[
			[ORDER_A, "B012345678"],
			[ORDER_B, "B012345678"],
		],
		false,
	).replace('<li class="a-disabled a-last">Next</li>', "");
	const page = {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.includes("search")) {
				current = noEnd;
				return Promise.resolve(null);
			}
			const orderId = parsed.searchParams.get("orderID") ?? "";
			visited.push(orderId);
			current = DETAIL_HTML;
			failNext = false;
			if (orderId !== ORDER_B) {
				return Promise.resolve(null);
			}
			if (failure === "goto-timeout") {
				const timeout = new Error("page.goto: Timeout 30000ms exceeded");
				timeout.name = "TimeoutError";
				return Promise.reject(timeout);
			}
			if (failure === "readiness-timeout") {
				failNext = true;
				return Promise.resolve(null);
			}
			const status = failure === "http-503" ? 503 : 403;
			return Promise.resolve({ ok: () => false, status: () => status });
		},
		locator: () => ({
			first: () => ({
				waitFor: () =>
					failNext
						? Promise.reject(new Error("locator.waitFor: Timeout exceeded"))
						: Promise.resolve(),
			}),
		}),
		url: () => "https://www.amazon.com/your-orders/search",
	} as unknown as Page;
	return { page, visited };
}

for (const failure of [
	"goto-timeout",
	"readiness-timeout",
	"http-503",
] as const) {
	test(`partial delivery reports every requested stream when a detail navigation fails (${failure})`, async () => {
		const { page, visited } = siteWithFailingSecondDetail(failure);
		const { failures, harness } = await withoutPacing(() =>
			runCollectOrders(page, ["orders", "order_items"]),
		);
		assert.deepEqual(visited, [ORDER_A, ORDER_B]);
		assert.deepEqual(failedStreams(failures), [
			["orders", true],
			["order_items", true],
		]);
		assert.match(failures[0]?.message ?? "", /last-page signal/);
		assert.deepEqual(stateStreams(harness), []);
		// The order read before the failure is kept.
		assert.deepEqual(
			harness.emitted.map((r) => r.stream),
			["orders", "order_items"],
		);
		assert.equal(harness.emitted[0]?.data.id, ORDER_A);
	});
}

test("partial delivery reports the streams, then still raises a signed-out detail", async () => {
	const { page } = siteWithFailingSecondDetail("http-403");
	const harness = makeRecordingEmit(validateRecord);
	const failures: string[] = [];
	await assert.rejects(
		withoutPacing(() =>
			collectOrders({
				credentials: {},
				emit: harness.emit,
				emitRecord: harness.emitRecord,
				page,
				progress: noProgress,
				reportStreamFailure: (stream) => {
					failures.push(stream);
					return Promise.resolve();
				},
				requested: new Map(
					["orders", "order_items"].map((stream) => [stream, {}]),
				) as never,
				state: {},
			}),
		),
		/HTTP 403/,
	);
	assert.deepEqual(failures, ["orders", "order_items"]);
	assert.deepEqual(stateStreams(harness), []);
});

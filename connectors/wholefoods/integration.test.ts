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
import { after, before, test } from "node:test";

// Fixture-only suite: navigation is scripted, so production politeness waits add no evidence.
const fixtureSetTimeout = globalThis.setTimeout;
before(() => {
	globalThis.setTimeout = ((fn: () => void) => {
		fn();
		return 0;
	}) as unknown as typeof setTimeout;
});
after(() => {
	globalThis.setTimeout = fixtureSetTimeout;
});

// The connector reads pages through the browser and calls no other service. A
// fetch from any test is a lookup the connector must not make.
const originalFetch = globalThis.fetch;
const fetchCalls: string[] = [];
before(() => {
	globalThis.fetch = ((input: RequestInfo | URL) => {
		fetchCalls.push(String(input));
		return Promise.reject(new Error("the connector must not call out"));
	}) as typeof fetch;
});
after(() => {
	globalThis.fetch = originalFetch;
	assert.deepEqual(fetchCalls, []);
});

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
	lookupNutritionForProduct,
	NUTRITION_UNREAD_REASON,
	OrderEnumerationUnprovenError,
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

/** The lookup's outcome in the shape most tests assert on: the accepted facts,
 *  or the status string of a non-matched outcome. The typed outcome (status
 *  and cause) is asserted separately through the emitted rows. */
async function lookupFlat(
	...args: Parameters<typeof lookupNutritionForProduct>
) {
	const outcome = await lookupNutritionForProduct(...args);
	return outcome.status === "matched" ? outcome.facts : outcome.status;
}

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
	assert.equal(harness.emitted[0]?.data.total_cents, null);
	assert.equal(harness.emitted[1]?.stream, "order_items");
	assert.equal(harness.emitted[1]?.data.order_id, STUB.orderId);
	assert.equal(harness.emitted[1]?.data.product_id, "B01ABCDEFG");
});

test("buildOrderRecord preserves the parsed zero item count for an empty order", () => {
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

test("buildNutritionRecord shape passes schema validation for each source", async () => {
	const harness = makeRecordingEmit(validateRecord);
	const facts = {
		accepted: true as const,
		coreStated: ["calories", "carbs", "fat", "protein"] as const,
		addedSugarG: null,
		allergens: null,
		calciumMg: null,
		calories: 105,
		carbsG: 27,
		category: [],
		cholesterolMg: null,
		confidence: "high" as const,
		fatG: 0.4,
		fiberG: 3.1,
		highlights: [],
		ingredients: null,
		ironMg: null,
		potassiumMg: null,
		proteinG: 1.3,
		rawNutritionText: null,
		saturatedFatG: null,
		servingSize: "1 medium (118g)",
		servingsPerContainer: 1,
		sodiumMg: 1,
		source: "wholefoods_product_page" as const,
		sugarG: 14,
		transFatG: null,
		type: "https://schema.org/NutritionInformation" as const,
		upc: null,
		vitaminDMcg: null,
	};
	for (const source of [
		"amazon_product_page",
		"wholefoods_product_page",
		"wholefoods_structured_data",
	] as const) {
		await harness.emitRecord(
			"nutrition",
			buildNutritionRecord("B01ABCDEFG", "Organic Bananas", {
				...facts,
				source,
			}),
		);
	}
	assert.equal(harness.emitted.length, 3);
	assert.equal(harness.skipped.length, 0);
	assert.deepEqual(
		harness.emitted.map((record) => record.data.source),
		[
			"amazon_product_page",
			"wholefoods_product_page",
			"wholefoods_structured_data",
		],
	);
	assert.equal(harness.emitted[0]?.data.product_id, "B01ABCDEFG");
});

test("a robot check is a blocked lookup", async () => {
	const outcome = await lookupFlat(
		fakePage(
			'<html><title>Robot Check</title><body><form action="validateCaptcha"></form></body></html>',
		),

		"Organic Bananas",
	);
	assert.equal(outcome, "blocked");
});

test("HTTP 403 CAPTCHA body is blocked after inspection", async () => {
	const shape = {
		...fakePage(
			'<html><title>Robot Check</title><form action="validateCaptcha"></form></html>',
		),
		goto: () => Promise.resolve({ ok: () => false, status: () => 403 }),
	} as unknown as Page;
	assert.equal(await lookupFlat(shape, "Organic Bananas"), "blocked");
});

test("HTTP 403 product CAPTCHA is blocked after search succeeds", async () => {
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
	assert.equal(await lookupFlat(shape, "Organic Bananas"), "blocked");
	assert.equal(visits, 2);
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

test("HTTP 503 product navigation is an error", async () => {
	const shape = {
		content: () =>
			Promise.resolve("<html><body>Service Unavailable</body></html>"),
		goto: () => Promise.resolve({ ok: () => false, status: () => 503 }),
	} as unknown as Page;
	const outcome = await lookupFlat(
		shape,

		"Organic Bananas",
	);
	assert.equal(outcome, "error");
});

test("an unrecognized Whole Foods page is an error", async () => {
	const outcome = await lookupFlat(
		fakePage("<html><body>unexpected client-rendered shell</body></html>"),

		"Organic Bananas",
	);
	assert.equal(outcome, "error");
});

test("Whole Foods search resolves a relative product link before reading facts", async () => {
	const visited: string[] = [];
	const shape: Pick<Page, "content" | "goto" | "url"> = {
		content: () =>
			Promise.resolve(
				visited.length === 1
					? "<html><body>No nutrition panel</body></html>"
					: visited.length === 2
						? '<html><body><a href="/product/organic-bananas">Organic Bananas</a></body></html>'
						: '<html><body><script type="application/ld+json">{"@type":"Product","name":"Organic Bananas","nutrition":{"@type":"NutritionInformation","calories":"105 calories","proteinContent":"1.3 g","carbohydrateContent":"27 g","fatContent":"0.4 g"}}</script></body></html>',
			),
		// biome-ignore lint/suspicious/noExplicitAny: scripted Page navigation captures the actual URL supplied to Playwright.
		goto: ((url: string) => {
			visited.push(url);
			return Promise.resolve(null);
		}) as any,
		url: () => visited.at(-1) ?? "about:blank",
	};
	const outcome = await lookupFlat(shape as Page, "Organic Bananas");
	assert.equal(
		visited[2],
		"https://www.wholefoodsmarket.com/product/organic-bananas",
	);
	assert.equal(
		typeof outcome === "string" ? outcome : outcome.source,
		"wholefoods_structured_data",
	);
});

test("Whole Foods search skips a first tile whose product identity differs", async () => {
	let currentUrl = "about:blank";
	const page = {
		content: async () =>
			currentUrl.includes("/search?")
				? '<a href="/product/pears">Organic Pears</a><a href="/product/apples">Organic Apples</a>'
				: currentUrl.endsWith("/product/pears")
					? '<script type="application/ld+json">{"@type":"Product","name":"Organic Pears","nutrition":{"@type":"NutritionInformation","calories":"95","proteinContent":"0.6 g","carbohydrateContent":"25 g","fatContent":"0.2 g"}}</script>'
					: '<script type="application/ld+json">{"@type":"Product","name":"Organic Apples","nutrition":{"@type":"NutritionInformation","calories":"52","proteinContent":"0.3 g","carbohydrateContent":"14 g","fatContent":"0.2 g"}}</script>',
		goto: async (url: string) => {
			currentUrl = url;
			return null;
		},
		locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		url: () => currentUrl,
	} as unknown as Page;
	const outcome = await lookupFlat(page, "Organic Apples", "B012345678");
	assert.equal(typeof outcome === "string" ? null : outcome.calories, 52);
	assert.match(currentUrl, /\/product\/apples$/);
});

test("a rendered product without nutrition has no panel (not_found)", async () => {
	let visits = 0;
	let currentUrl = "";
	const shape = {
		content: () =>
			Promise.resolve(
				visits === 1
					? '<html><body><span id="productTitle">Organic Bananas</span></body></html>'
					: visits === 2
						? '<html><body><a href="/product/organic-bananas">Organic Bananas</a></body></html>'
						: '<html><body><script type="application/ld+json">{"@type":"Product","name":"Organic Bananas"}</script></body></html>',
			),
		goto: (url: string) => {
			visits += 1;
			currentUrl = url;
			return Promise.resolve(null);
		},
		url: () => currentUrl,
	} as unknown as Page;
	const outcome = await lookupFlat(
		shape,

		"Organic Bananas",
	);
	assert.equal(outcome, "not_found");
});

test("HTTP product links and cross-origin redirects cannot supply nutrition", async () => {
	const facts =
		'<script type="application/ld+json">{"@type":"Product","nutrition":{"@type":"NutritionInformation","calories":"105 calories"}}</script>';
	await Promise.all(
		(
			[
				[
					"http://www.wholefoodsmarket.com/product/example",
					"http://www.wholefoodsmarket.com/product/example",
					2,
				],
				["/product/example", "https://example.com/product/example", 3],
				[
					"/product/example",
					"http://www.wholefoodsmarket.com/product/example",
					3,
				],
				[
					"https://www.wholefoodsmarket.com:444/product/example",
					"https://www.wholefoodsmarket.com:444/product/example",
					2,
				],
				[
					"/product/example",
					"https://www.wholefoodsmarket.com:444/product/example",
					3,
				],
			] as const
		).map(async ([href, finalUrl, expectedVisits]) => {
			let visits = 0;
			const shape = {
				content: () =>
					Promise.resolve(
						visits === 1
							? "<html><body>No nutrition here</body></html>"
							: visits === 2
								? `<a href="${href}">Organic Bananas</a>`
								: facts,
					),
				goto: () => {
					visits += 1;
					return Promise.resolve(null);
				},
				// Only the product tile is redirected; the search answers
				// from Whole Foods.
				url: () =>
					visits === 3
						? finalUrl
						: "https://www.wholefoodsmarket.com/search?text=organic+bananas",
			} as unknown as Page;
			assert.equal(await lookupFlat(shape, "Organic Bananas"), "error");
			assert.equal(visits, expectedVisits);
		}),
	);
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
	let currentUrl = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			currentUrl = url;
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
		url: () => currentUrl,
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
		emit: async (message) => {
			await harness.emit(message);
			if (
				message.type === "SKIP_RESULT" &&
				message.reason === "inventory_not_proven_complete"
			) {
				failures.push({
					stream: message.stream,
					message: message.message ?? "",
					retryable:
						typeof message.recovery_hint === "object"
							? message.recovery_hint?.retryable
							: undefined,
				});
			}
		},
		emitRecord: harness.emitRecord,
		page,
		progress: noProgress,
		reportStreamFailure: (_stream, _message, options) => {
			// Genuine runtime failure reporting is distinct from inventory incompleteness.
			assert.equal(options?.retryable, true);
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

test("collectOrders retains partial orders on the source's own empty-state page", async () => {
	const emptyShell =
		'<div class="your-orders-content-container"><input id="searchOrdersInput"><p>No orders</p></div>';
	const { failures, harness } = await runCollectOrders(
		ordersSite([emptyShell], ""),
		["orders", "order_items"],
	);
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
	assert.equal(harness.emitted.length, 0);
});

test("collectOrders retains partial orders when the last page shows a disabled Next", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], DETAIL_HTML),
		["orders", "order_items"],
	);
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
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
		harness.protocolMessages.filter(
			(m) =>
				m.type === "SKIP_RESULT" &&
				m.reason === "inventory_not_proven_complete",
		).length,
		2,
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

test("collectOrders emits no nutrition row for a product whose lookup read nothing", async () => {
	const { harness } = await runCollectOrders(
		ordersSite([searchPage(1, [[ORDER_A, "B012345678"]], false)], DETAIL_HTML),
		ALL_ORDER_STREAMS,
	);
	assert.ok(harness.emitted.some((record) => record.stream === "orders"));
	assert.ok(harness.emitted.some((record) => record.stream === "order_items"));
	assert.deepEqual(
		harness.emitted.filter((record) => record.stream === "nutrition"),
		[],
		"a row with no facts would replace stored facts under the same key",
	);
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
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
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
	assert.equal(
		harness.emitted.length,
		0,
		"an unreadable refresh must not replace a stored header",
	);
});

test("collectOrders remain partials a cancelled order whose detail renders no items", async () => {
	const { failures, harness } = await runCollectOrders(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div data-component="cancelled">Cancelled</div></body></html>',
		),
		["orders", "order_items"],
	);
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders"],
	);
	assert.equal(harness.emitted[0]?.data.status, "Cancelled");
	assert.equal(harness.emitted[0]?.data.item_count, 0);
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
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.doesNotMatch(failures[0]?.message ?? "", /111-1111111-1111111/);
	// The count mismatch makes this order refresh incomplete, so withhold both rows.
	assert.deepEqual(stateStreams(harness), []);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		[],
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
		["orders", true],
		["order_items", true],
		["nutrition", true],
	]);
	assert.deepEqual(stateStreams(harness), []);
});

test("collectOrders keeps all streams partial when parsed detail counts match search counts", async () => {
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
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
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
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.deepEqual(stateStreams(harness), []);
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
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
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
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
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
	assert.deepEqual(failedStreams(failures), [
		["orders", true],
		["order_items", true],
	]);
	assert.deepEqual(stateStreams(harness), []);
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
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
});

test("a visible cancellation marker and visible pagination remain partial", async () => {
	const { failures, harness } = await runFast(
		ordersSite(
			[searchPage(1, [[ORDER_A, "B012345678"]], false)],
			'<html><body><div id="line-items"></div><div data-component="cancelled">Cancelled</div><div hidden data-component="cancelled">stale</div></body></html>',
		),
		ALL_ORDER_STREAMS,
	);
	assert.ok(
		failures.length > 0 &&
			failures.every((failure) => failure.retryable === true),
	);
	assert.deepEqual(stateStreams(harness), []);
});

function ordersSiteByOrder(
	searchPages: string[],
	detailByOrder: Record<string, string>,
	visited: string[],
): Page {
	let current = "";
	let currentUrl = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			currentUrl = url;
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
		url: () => currentUrl,
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
	let currentUrl = "";
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
			currentUrl = url;
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
		url: () => currentUrl,
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

// ─── Nutrition acceptance: absent data never replaces present data ────────

const CORE_PANEL =
	'"calories":"52","proteinContent":"0.3 g","carbohydrateContent":"14 g","fatContent":"0.2 g"';
const AMAZON_UPC_PAGE =
	'<html><body><div id="detailBullets_feature_div"><li>UPC: 012345678905</li></div></body></html>';

/** Scripted browser: `pages` maps a URL predicate to the HTML served. */
function scriptedBrowser(
	htmlFor: (url: string) => string,
	finalUrlFor: (url: string) => string = (url) => url,
): Page {
	let current = "about:blank";
	return {
		content: async () => htmlFor(current),
		goto: async (url: string) => {
			current = url;
			return null;
		},
		locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		url: () => finalUrlFor(current),
	} as unknown as Page;
}

test("an Amazon panel that shows only calories cannot replace stored nutrition", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			url.startsWith("https://www.amazon.com/")
				? '<html><body><div id="nic-nutrition-facts">Nutrition Facts Calories 150</div></body></html>'
				: "<html><body>No matching products</body></html>",
		),

		"Apples",
		"B012345678",
	);
	assert.equal(typeof outcome, "string");
});

test("nutrition from another Product node on the page cannot be attributed to the requested product", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			url.includes("/search?")
				? '<a href="/product/apples">Apples</a>'
				: url.includes("/product/apples")
					? `<script type="application/ld+json">[{"@type":"Product","name":"Apples","gtin12":"111111111111"},{"@type":"Product","name":"Pears","nutrition":{"@type":"NutritionInformation",${CORE_PANEL}}}]</script>`
					: "<html><body>no panel</body></html>",
		),

		"Apples",
	);
	assert.equal(typeof outcome, "string");
});

// ─── Order identity: the returned detail must be the requested order ──────

const ORDER_OTHER = "999-9999999-9999999";
const ordersWithIdentity = (orderId: string, body: string) =>
	`<html><body><div id="progress-tracker-refresh-data" data-orderid="${orderId}"></div>${body}</body></html>`;

function redirectingOrdersSite(
	searchPages: string[],
	servedFor: (requestedOrderId: string) => {
		html: string;
		finalOrderId: string;
	},
): Page {
	let current = "";
	let finalUrl = "https://www.amazon.com/your-orders/search";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			const parsed = new URL(url);
			if (parsed.pathname.includes("search")) {
				const pageNum = Number(parsed.searchParams.get("page") ?? "1");
				current = searchPages[pageNum - 1] ?? "";
				finalUrl = url;
			} else {
				const served = servedFor(parsed.searchParams.get("orderID") ?? "");
				current = served.html;
				finalUrl = `https://www.amazon.com/your-orders/order-details?orderID=${served.finalOrderId}`;
			}
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => finalUrl,
	} as unknown as Page;
}

const ONE_ROW_SEARCH = searchPage(1, [[ORDER_A, "B012345678"]], false);

test("a detail page for a different order is never emitted under the requested order id", async () => {
	const { failures, harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], () => ({
			html: ordersWithIdentity(ORDER_OTHER, DETAIL_HTML),
			finalOrderId: ORDER_OTHER,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(harness.emitted, []);
	assert.ok(failures.length > 0);
});

test("a page showing another order's id is rejected even when the URL kept the requested id", async () => {
	const { harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], () => ({
			html: ordersWithIdentity(ORDER_OTHER, DETAIL_HTML),
			finalOrderId: ORDER_A,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(harness.emitted, []);
});

test("a cancellation page for a different order does not cancel the requested order", async () => {
	const { harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], () => ({
			html: ordersWithIdentity(
				ORDER_OTHER,
				'<div data-component="cancelled">This order was cancelled</div>',
			),
			finalOrderId: ORDER_OTHER,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(harness.emitted, []);
});

test("a detail page that shows the requested order id is accepted", async () => {
	const { harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], (orderId) => ({
			html: ordersWithIdentity(orderId, DETAIL_HTML),
			finalOrderId: orderId,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders", "order_items"],
	);
});

/** An Amazon page that states a barcode and a complete panel. */
const AMAZON_UPC_PANEL_PAGE =
	'<html><body><span id="productTitle">Apples</span><div id="detailBullets_feature_div"><li>UPC: 012345678905</li></div><div id="nic-nutrition-facts">Calories 52 Total Fat 0.2g Total Carbohydrate 14g Protein 0.3g</div></body></html>';

function nutritionSite(
	searchPages: string[],
	amazonHtml: string = AMAZON_UPC_PAGE,
): Page {
	let current = "";
	let currentUrl = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			currentUrl = url;
			const parsed = new URL(url);
			if (parsed.hostname === "www.wholefoodsmarket.com") {
				current = "<html><body>No matching products</body></html>";
			} else if (parsed.pathname.startsWith("/dp/")) {
				current = amazonHtml;
			} else if (parsed.pathname.includes("search")) {
				const pageNum = Number(parsed.searchParams.get("page") ?? "1");
				current = searchPages[pageNum - 1] ?? "";
			} else {
				current = ordersWithIdentity(
					parsed.searchParams.get("orderID") ?? "",
					DETAIL_HTML,
				);
			}
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => currentUrl,
	} as unknown as Page;
}

test("collectOrders emits no nutrition row for a product with no panel on its pages", async () => {
	const { harness } = await runCollectOrders(nutritionSite([ONE_ROW_SEARCH]), [
		"orders",
		"nutrition",
	]);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders"],
	);
});

test("collectOrders emits the nutrition row when the lookup reads the core panel", async () => {
	const { harness } = await runCollectOrders(
		nutritionSite([ONE_ROW_SEARCH], AMAZON_UPC_PANEL_PAGE),
		["nutrition"],
	);
	const rows = harness.emitted.filter((r) => r.stream === "nutrition");
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.data.calories, 52);
	assert.equal(rows[0]?.data.upc, "012345678905");
	assert.equal(rows[0]?.data.source, "amazon_product_page");
});

// ─── Round 2: degraded refreshes ─────────────────────────────────────────

const NO_PAGE_SOURCE = () => "<html><body>No matching products</body></html>";
test("a blocked Amazon page is a blocked lookup, whatever the other source says", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			url.startsWith("https://www.amazon.com/")
				? '<html><title>Robot Check</title><form action="validateCaptcha"></form></html>'
				: NO_PAGE_SOURCE(),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "blocked");
});

test("an HTTP-failed Amazon page is an error, not an absence", async () => {
	let current = "";
	const page = {
		content: async () => NO_PAGE_SOURCE(),
		goto: async (url: string) => {
			current = url;
			return url.startsWith("https://www.amazon.com/")
				? { ok: () => false, status: () => 503 }
				: null;
		},
		locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		url: () => current,
	} as unknown as Page;
	const outcome = await lookupFlat(
		page,

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "error");
});

// ─── Store-level: good -> degraded -> recovered ───────────────────────────

const AMAZON_FULL_PANEL =
	'<html><body><div id="nic-nutrition-facts">Calories 150 Total Fat 8g Total Carbohydrate 37g Protein 3g</div></body></html>';

function degradingSite(amazonPage: () => string, searchPages: string[]): Page {
	let current = "";
	let currentUrl = "";
	return {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			currentUrl = url;
			const parsed = new URL(url);
			if (parsed.hostname === "www.wholefoodsmarket.com") {
				current = NO_PAGE_SOURCE();
			} else if (parsed.pathname.startsWith("/dp/")) {
				current = amazonPage();
			} else if (parsed.pathname.includes("search")) {
				const pageNum = Number(parsed.searchParams.get("page") ?? "1");
				current = searchPages[pageNum - 1] ?? "";
			} else {
				current = ordersWithIdentity(
					parsed.searchParams.get("orderID") ?? "",
					DETAIL_HTML,
				);
			}
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => currentUrl,
	} as unknown as Page;
}

test("a degraded refresh emits nothing for a product the previous run read from its page", async () => {
	let amazon = AMAZON_FULL_PANEL;
	const nutritionRows = async () => {
		const { harness } = await runCollectOrders(
			degradingSite(() => amazon, [ONE_ROW_SEARCH]),
			["nutrition"],
		);
		return harness.emitted.filter((r) => r.stream === "nutrition");
	};
	const good = await nutritionRows();
	assert.equal(good.length, 1);
	assert.equal(good[0]?.data.source, "amazon_product_page");
	assert.equal(good[0]?.data.calories, 150);

	amazon =
		'<html><title>Robot Check</title><form action="validateCaptcha"></form></html>';
	assert.deepEqual(
		await nutritionRows(),
		[],
		"a blocked refresh emits nothing, so it cannot replace stored facts",
	);

	amazon = AMAZON_FULL_PANEL;
	const recovered = await nutritionRows();
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.data.source, "amazon_product_page");
});

// ─── Round 3: page health from positive evidence ──────────────────────────

const AMAZON_PRODUCT_NO_PANEL =
	'<html><body><span id="productTitle">Banana Peppers</span></body></html>';
const AMAZON_UNKNOWN_200 =
	"<html><body><h1>Hmm, something went sideways</h1></body></html>";

/** Like `scriptedBrowser`, with an HTTP status per URL. */
function statusBrowser(
	htmlFor: (url: string) => string,
	statusFor: (url: string) => number | null,
): Page {
	let current = "about:blank";
	return {
		content: async () => htmlFor(current),
		goto: async (url: string) => {
			current = url;
			const status = statusFor(url);
			return status === null
				? null
				: { ok: () => status < 400, status: () => status };
		},
		locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		url: () => current,
	} as unknown as Page;
}

const isAmazon = (url: string) => url.startsWith("https://www.amazon.com/");

test("a 200 Amazon page with no product evidence leaves the product unchecked", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url) ? AMAZON_UNKNOWN_200 : NO_PAGE_SOURCE(),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "error");
});

test("a 404 ASIN page is an answer: this product has no panel there", async () => {
	const outcome = await lookupFlat(
		statusBrowser(
			(url) => (isAmazon(url) ? AMAZON_UNKNOWN_200 : NO_PAGE_SOURCE()),
			(url) => (isAmazon(url) ? 404 : null),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "not_found");
});

test("a real Amazon product page with no panel is an answer: this product has no panel there", async () => {
	// Accepted limitation: a page that renders as a product but has lost its
	// panel is indistinguishable from a product that never had one.
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url) ? AMAZON_PRODUCT_NO_PANEL : NO_PAGE_SOURCE(),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "not_found");
});

test("a Whole Foods product page 404 is an answer, not a failure", async () => {
	const outcome = await lookupFlat(
		statusBrowser(
			(url) =>
				isAmazon(url)
					? AMAZON_PRODUCT_NO_PANEL
					: url.includes("/search?")
						? '<a href="/product/banana-peppers">Banana Peppers</a>'
						: "<html><body>Not found</body></html>",
			(url) => (url.includes("/product/") ? 404 : null),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "not_found");
});

test("a Whole Foods product page that is not a recognisable product leaves the product unchecked", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: url.includes("/search?")
					? '<a href="/product/banana-peppers">Banana Peppers</a>'
					: "<html><body>Please wait while we check your browser</body></html>",
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "error");
});

test("a good -> interstitial -> recovered refresh never swaps in another brand's facts", async () => {
	let amazon = AMAZON_FULL_PANEL;
	const nutritionRows = async () => {
		const { harness } = await runCollectOrders(
			degradingSite(() => amazon, [ONE_ROW_SEARCH]),
			["nutrition"],
		);
		return harness.emitted.filter((r) => r.stream === "nutrition");
	};
	assert.equal((await nutritionRows()).length, 1);
	amazon = AMAZON_UNKNOWN_200;
	assert.deepEqual(
		await nutritionRows(),
		[],
		"a degraded refresh emits nothing, so it cannot replace stored facts",
	);
	amazon = AMAZON_FULL_PANEL;
	const recovered = await nutritionRows();
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.data.source, "amazon_product_page");
});

// ─── Round 4: a partial panel of this product is not "no panel" ───────────

const AMAZON_PARTIAL_PANEL =
	'<html><body><span id="productTitle">Banana Peppers</span><div id="nic-nutrition-facts">Calories 160 Total Fat 15g Total Carbohydrate 9g</div></body></html>';

test("a partial Amazon panel for this product is an unread product, not no panel", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url) ? AMAZON_PARTIAL_PANEL : NO_PAGE_SOURCE(),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "error");
});

test("a partial Whole Foods panel for this product is an unread product, not no panel", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: url.includes("/search?")
					? '<a href="/product/banana-peppers">Banana Peppers</a>'
					: '<html><body><script type="application/ld+json">{"@type":"Product","name":"Banana Peppers"}</script><h1>Banana Peppers</h1><div><h3>Nutrition Facts</h3><div>Calories 160 Total Fat 15g</div></div></body></html>',
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "error");
});

test("a partial panel of another product says nothing about this product's panel", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: url.includes("/search?")
					? '<a href="/product/pears">Pears</a>'
					: '<html><body><script type="application/ld+json">{"@type":"Product","name":"Pears"}</script><h1>Pears</h1><div><h3>Nutrition Facts</h3><div>Calories 160 Total Fat 15g</div></div></body></html>',
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "not_found");
});

test("an Amazon id=dp shell around interstitial text is not a product page", async () => {
	const outcome = await lookupFlat(
		scriptedBrowser((url) =>
			isAmazon(url)
				? '<html><body><div id="dp"><p>Click the button below to continue shopping</p></div></body></html>'
				: NO_PAGE_SOURCE(),
		),

		"Banana Peppers",
		"B012345678",
	);
	assert.equal(outcome, "error");
});

test("a good -> partial -> recovered refresh never swaps in another brand's facts", async () => {
	let amazon = AMAZON_FULL_PANEL;
	const nutritionRows = async () => {
		const { harness } = await runCollectOrders(
			degradingSite(() => amazon, [ONE_ROW_SEARCH]),
			["nutrition"],
		);
		return harness.emitted.filter((r) => r.stream === "nutrition");
	};
	assert.equal((await nutritionRows()).length, 1);
	amazon =
		'<html><body><span id="productTitle">Organic Bananas</span><div id="nic-nutrition-facts">Calories 150 Total Fat 8g Total Carbohydrate 37g</div></body></html>';
	assert.deepEqual(
		await nutritionRows(),
		[],
		"a degraded refresh emits nothing, so it cannot replace stored facts",
	);
	amazon = AMAZON_FULL_PANEL;
	const recovered = await nutritionRows();
	assert.equal(recovered.length, 1);
	assert.equal(recovered[0]?.data.source, "amazon_product_page");
});

// ─── Round 5: a nutrition row is a source's own panel, nothing else ───────
//
// The connector collects only what the owner's own pages show. A product
// whose panel could not be read, or that has none, gets no row: a row with no
// facts would replace the stored facts under the same key. The run says why
// through its log and, when a read failed, a SKIP_RESULT.

import { setConnectorDiagnosticSink } from "../../packages/polyfill-connectors/src/connector-diagnostic.ts";

/** One nutrition run over a single ordered product whose Amazon page is
 *  `amazon`: the rows it emitted, its unread SKIP_RESULTs and the coverage
 *  line it logged. */
async function nutritionRunFor(
	amazon: string,
	options: {
		status?: (url: string) => number | null;
		throwOn?: (url: string) => boolean;
	} = {},
) {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	try {
		const inner = degradingSite(() => amazon, [ONE_ROW_SEARCH]);
		const page = {
			...inner,
			content: inner.content.bind(inner),
			url: inner.url.bind(inner),
			locator: inner.locator.bind(inner),
			goto: (url: string) => {
				if (options.throwOn?.(url)) return Promise.reject(new Error("boom"));
				const status = options.status?.(url) ?? null;
				return inner
					.goto(url)
					.then((response) =>
						status === null
							? response
							: { ok: () => status < 400, status: () => status },
					);
			},
		} as unknown as Page;
		const { harness } = await runCollectOrders(page, ["nutrition"]);
		return {
			coverage:
				lines.find((line) => line.includes("nutrition_lookup_coverage")) ?? "",
			rows: harness.emitted.filter((r) => r.stream === "nutrition"),
			unread: harness.protocolMessages.filter(
				(m) => m.type === "SKIP_RESULT" && m.reason === NUTRITION_UNREAD_REASON,
			),
		};
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
}

test("a product whose panel was read gets one row with its facts", async () => {
	const { rows, unread } = await nutritionRunFor(AMAZON_FULL_PANEL);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]?.data.source, "amazon_product_page");
	assert.equal(rows[0]?.data.calories, 150);
	assert.deepEqual(unread, []);
	// The row states what the page showed and nothing about how it was found.
	assert.deepEqual(
		Object.keys(rows[0]?.data ?? {}).filter((key) =>
			/^usda_|^status$|^cause$/.test(key),
		),
		[],
	);
});

test("a product with no panel anywhere gets no row, and that is not an unread product", async () => {
	const { coverage, rows, unread } = await nutritionRunFor(
		AMAZON_PRODUCT_NO_PANEL,
	);
	assert.deepEqual(rows, []);
	assert.deepEqual(unread, []);
	assert.match(coverage, /"no_panel":1/);
	assert.match(coverage, /"unread":0/);
});

test("a robot check gets no row and is reported unread", async () => {
	const { coverage, rows, unread } = await nutritionRunFor(
		'<html><title>Robot Check</title><form action="validateCaptcha"></form></html>',
	);
	assert.deepEqual(rows, []);
	assert.equal(unread.length, 1);
	assert.match(coverage, /"unread":1/);
	assert.match(coverage, /"unread_robot_check":1/);
});

test("failed and unrecognised reads get no row and are reported unread with their own cause", async () => {
	const unrecognised = await nutritionRunFor(AMAZON_UNKNOWN_200);
	assert.deepEqual(unrecognised.rows, []);
	assert.equal(unrecognised.unread.length, 1);
	assert.match(unrecognised.coverage, /"unread_unrecognized_page":1/);

	const http = await nutritionRunFor(AMAZON_FULL_PANEL, {
		status: (url) =>
			url.startsWith("https://www.amazon.com/dp/") ? 503 : null,
	});
	assert.deepEqual(http.rows, []);
	assert.equal(http.unread.length, 1);
	assert.match(http.coverage, /"unread_http_error":1/);

	const thrown = await nutritionRunFor(AMAZON_FULL_PANEL, {
		throwOn: (url) => url.startsWith("https://www.amazon.com/dp/"),
	});
	assert.deepEqual(thrown.rows, []);
	assert.equal(thrown.unread.length, 1);
	assert.match(thrown.coverage, /"unread_navigation_failed":1/);
});

test("a partial panel of this product gets no row and is reported unread", async () => {
	const { coverage, rows, unread } = await nutritionRunFor(
		'<html><body><span id="productTitle">Organic Bananas</span><div id="nic-nutrition-facts">Calories 150 Total Fat 8g Total Carbohydrate 37g</div></body></html>',
	);
	assert.deepEqual(rows, []);
	assert.equal(unread.length, 1);
	assert.match(coverage, /"unread_panel_partial":1/);
});

test("the unread SKIP_RESULT is retryable and counts the products it covers", async () => {
	const { unread } = await nutritionRunFor(AMAZON_UNKNOWN_200);
	assert.deepEqual(
		unread.map((m) => ({
			stream: m.type === "SKIP_RESULT" ? m.stream : null,
			reason: m.type === "SKIP_RESULT" ? m.reason : null,
			hint: m.type === "SKIP_RESULT" ? m.recovery_hint : null,
			message: m.type === "SKIP_RESULT" ? m.message : null,
		})),
		[
			{
				stream: "nutrition",
				reason: NUTRITION_UNREAD_REASON,
				hint: { action: "retry_by_runtime", retryable: true },
				message:
					"The nutrition panel of 1 product(s) could not be read; they have no nutrition row.",
			},
		],
	);
});

test("the same ASIN in two orders gets one row", async () => {
	const { harness } = await runCollectOrders(
		degradingSite(
			() => AMAZON_FULL_PANEL,
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
		),
		["nutrition"],
	);
	assert.equal(
		harness.emitted.filter((r) => r.stream === "nutrition").length,
		1,
	);
});

test("a mixed order gets a row only for the product whose panel was read, and the coverage counts agree", async () => {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	const detail = `<html><body><span data-orderid="${ORDER_A}"></span>
		<div data-component="purchasedItemsRightGrid"><a href="/dp/B012345678">Organic Bananas</a><span>Qty: 1</span></div>
		<div data-component="purchasedItemsRightGrid"><a href="/dp/B087654321">Mystery Item</a><span>Qty: 1</span></div></body></html>`;
	let currentUrl = "";
	let current = "";
	const page = {
		content: () => Promise.resolve(current),
		goto: (url: string) => {
			currentUrl = url;
			const parsed = new URL(url);
			if (parsed.hostname === "www.wholefoodsmarket.com") {
				current = NO_PAGE_SOURCE();
			} else if (parsed.pathname === "/dp/B012345678") {
				current = AMAZON_FULL_PANEL;
			} else if (parsed.pathname.startsWith("/dp/")) {
				current = AMAZON_PRODUCT_NO_PANEL;
			} else if (parsed.pathname.includes("search")) {
				current = searchPage(
					1,
					[
						[ORDER_A, "B012345678"],
						[ORDER_A, "B087654321"],
					],
					false,
				);
			} else {
				current = detail;
			}
			return Promise.resolve(null);
		},
		locator: () => ({ first: () => ({ waitFor: () => Promise.resolve() }) }),
		url: () => currentUrl,
	} as unknown as Page;
	try {
		const { harness } = await runCollectOrders(page, ["nutrition"]);
		const rows = harness.emitted.filter((r) => r.stream === "nutrition");
		assert.deepEqual(
			rows.map((r) => [r.data.product_id, r.data.source]),
			[["B012345678", "amazon_product_page"]],
		);
		const coverage = lines.find((line) =>
			line.includes("nutrition_lookup_coverage"),
		);
		assert.match(coverage ?? "", /"products":2/);
		assert.match(coverage ?? "", /"read":1/);
		assert.match(coverage ?? "", /"no_panel":1/);
		assert.match(coverage ?? "", /"unread":0/);
	} finally {
		setConnectorDiagnosticSink(undefined);
	}
});

test("a nutrition run makes no network request of its own, only page navigations", async () => {
	const calls: string[] = [];
	const guard = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL) => {
		calls.push(String(input));
		return Promise.reject(new Error("the connector must not call out"));
	}) as typeof fetch;
	try {
		await nutritionRunFor(AMAZON_FULL_PANEL);
		await nutritionRunFor(AMAZON_PRODUCT_NO_PANEL);
		await nutritionRunFor(AMAZON_UNKNOWN_200);
	} finally {
		globalThis.fetch = guard;
	}
	assert.deepEqual(calls, []);
});

// ─── Round 6: identity is decided in one place (binding.ts) ───────────────
//
// All pages below are synthetic: the repo holds no scrubbed real capture of an
// Amazon /dp page, a Whole Foods product page with recommendations, or a
// cancelled order detail.

const FULL_PANEL_TEXT =
	"Calories 150 Total Fat 8g Total Carbohydrate 37g Protein 3g";
const amazonPage = (inner: string, panel = FULL_PANEL_TEXT) =>
	`<html><head>${inner}</head><body><span id="productTitle">Organic Bananas</span><div id="nic-nutrition-facts">${panel}</div></body></html>`;
const B_ASIN = "B087654321";

async function typedLookup(page: Page, name = "Organic Bananas") {
	return lookupNutritionForProduct(page, name, "B012345678");
}

test("an Amazon redirect from A to B is not an answer about A, even with a complete panel", async () => {
	const outcome = await typedLookup(
		scriptedBrowser(
			(url) => (isAmazon(url) ? amazonPage("") : NO_PAGE_SOURCE()),
			(url) => (isAmazon(url) ? `https://www.amazon.com/dp/${B_ASIN}` : url),
		),
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "identity_conflict");
});

test("an Amazon page whose content ASIN differs from its URL is not an answer about A", async () => {
	const outcome = await typedLookup(
		scriptedBrowser((url) =>
			isAmazon(url)
				? amazonPage(`<input type="hidden" id="ASIN" value="${B_ASIN}">`)
				: NO_PAGE_SOURCE(),
		),
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "identity_conflict");
});

test("an Amazon page that ends up off amazon.com is not an answer", async () => {
	const outcome = await typedLookup(
		scriptedBrowser(
			(url) => (isAmazon(url) ? amazonPage("") : NO_PAGE_SOURCE()),
			(url) =>
				isAmazon(url) ? "https://amazon.example.net/dp/B012345678" : url,
		),
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "identity_conflict");
});

const PEARS_PAGE = `<html><head>
	<link rel="canonical" href="https://www.wholefoodsmarket.com/product/organic-pears">
	<script type="application/ld+json">{"@type":"Product","name":"Organic Apples","gtin12":"012345678905","url":"https://www.wholefoodsmarket.com/product/organic-apples"}</script>
	</head><body><h1>Organic Pears</h1><div><h3>Nutrition Facts</h3><div>Calories 95 Total Fat 0g Total Carbohydrate 25g Protein 1g</div></div></body></html>`;
const wfSite = (productHtml: string) =>
	scriptedBrowser((url) =>
		isAmazon(url)
			? AMAZON_PRODUCT_NO_PANEL
			: url.includes("/search?")
				? '<a href="/product/organic-pears">Organic Pears</a>'
				: productHtml,
	);

test("a Pears page with an Apples recommendation node is not Apples", async () => {
	const outcome = await typedLookup(wfSite(PEARS_PAGE), "Organic Apples");
	assert.notEqual(outcome.status, "matched");
});

test("the same Pears page, for Pears, keeps Pears' own identity and lends no GTIN", async () => {
	const outcome = await typedLookup(wfSite(PEARS_PAGE), "Organic Pears");
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.calories, 95);
	assert.equal(outcome.facts.upc, null);
	assert.equal(outcome.facts.productName, "Organic Pears");
});

test("equal names with unequal GTINs are different products", async () => {
	const page = `<html><body><h1>Organic Bananas</h1><script type="application/ld+json">{"@type":"Product","name":"Organic Bananas","gtin12":"036000291452","nutrition":{"@type":"NutritionInformation","calories":"105","proteinContent":"1.3 g","carbohydrateContent":"27 g","fatContent":"0.4 g"}}</script></body></html>`;
	const outcome = await typedLookup(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_UPC_PAGE // a bound page with UPC 012345678905 and no panel
				: url.includes("/search?")
					? '<a href="/product/organic-bananas">Organic Bananas</a>'
					: page,
		),
	);
	assert.notEqual(outcome.status, "matched");
});

test("zero-padded spellings of one GTIN match, and bind by gtin", async () => {
	const page = `<html><body><h1>Some Different Name</h1><script type="application/ld+json">{"@type":"Product","name":"Some Different Name","gtin13":"0012345678905","nutrition":{"@type":"NutritionInformation","calories":"105","proteinContent":"1.3 g","carbohydrateContent":"27 g","fatContent":"0.4 g"}}</script></body></html>`;
	const outcome = await typedLookup(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_UPC_PAGE
				: url.includes("/search?")
					? '<a href="/product/x">Some</a>'
					: page,
		),
	);
	assert.equal(outcome.status, "matched");
});

test("organic and plain are different products; a size mismatch is too", async () => {
	const product = (name: string) =>
		`<html><body><h1>${name}</h1><script type="application/ld+json">{"@type":"Product","name":"${name}","nutrition":{"@type":"NutritionInformation","calories":"105","proteinContent":"1.3 g","carbohydrateContent":"27 g","fatContent":"0.4 g"}}</script></body></html>`;
	const lookup = (requested: string, page: string) =>
		typedLookup(
			scriptedBrowser((url) =>
				isAmazon(url)
					? AMAZON_PRODUCT_NO_PANEL
					: url.includes("/search?")
						? '<a href="/product/x">x</a>'
						: page,
			),
			requested,
		);
	assert.notEqual(
		(await lookup("Organic Apples", product("Apples"))).status,
		"matched",
	);
	assert.notEqual(
		(await lookup("Apples", product("Organic Apples"))).status,
		"matched",
	);
	assert.notEqual(
		(await lookup("Apples, 3 lb", product("Apples 5 lb"))).status,
		"matched",
	);
	assert.equal(
		(await lookup("Apples, 16 oz", product("Apples 1 lb"))).status,
		"matched",
	);
});

test("a produce item with no GTIN anywhere still binds by name, at medium confidence", async () => {
	const page = `<html><body><h1>Organic Hass Avocado</h1><script type="application/ld+json">{"@type":"Product","name":"Organic Hass Avocado","nutrition":{"@type":"NutritionInformation","calories":"160","proteinContent":"2 g","carbohydrateContent":"9 g","fatContent":"15 g"}}</script></body></html>`;
	const outcome = await typedLookup(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: url.includes("/search?")
					? '<a href="/product/organic-hass-avocado">a</a>'
					: page,
		),
		"Whole Foods Market, Organic Hass Avocado, 1 Each",
	);
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.confidence, "medium");
});

test("the tile loop visits at most 8 distinct tiles per product", async () => {
	const visited: string[] = [];
	const tiles = Array.from(
		{ length: 20 },
		(_, i) => `<a href="/product/item-${i}">Item ${i}</a>`,
	).join("");
	await typedLookup(
		scriptedBrowser((url) => {
			if (url.includes("/product/")) visited.push(url);
			return isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: url.includes("/search?")
					? tiles + tiles
					: `<html><body><h1>Other Thing</h1></body></html>`;
		}),
	);
	assert.equal(visited.length, 8);
});

test("a tile on another origin skips that tile and the later tiles still count", async () => {
	const visited: string[] = [];
	const good = `<html><body><h1>Organic Bananas</h1><script type="application/ld+json">{"@type":"Product","name":"Organic Bananas","nutrition":{"@type":"NutritionInformation","calories":"105","proteinContent":"1.3 g","carbohydrateContent":"27 g","fatContent":"0.4 g"}}</script></body></html>`;
	const outcome = await typedLookup(
		scriptedBrowser((url) => {
			if (url.includes("evil.example")) visited.push(url);
			return isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: url.includes("/search?")
					? '<a href="https://evil.example/product/x">x</a><a href="/product/organic-bananas">b</a>'
					: good;
		}),
	);
	assert.deepEqual(visited, []);
	assert.equal(outcome.status, "matched");
});

// ─── Orders: final URL A, header B, incidental A ──────────────────────────

const HEADER_B = `<div id="progress-tracker-refresh-data" data-orderid="${ORDER_OTHER}"></div>`;
const INCIDENTAL_A = `<script>var returnUrl="/your-orders/order-details?orderID=${ORDER_A}";</script><a href="/your-orders/order-details?orderID=${ORDER_A}">previous order</a>`;

test("final URL A with a header for order B is withheld even when the page mentions A elsewhere (items)", async () => {
	const { harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], () => ({
			html: `<html><body>${HEADER_B}${INCIDENTAL_A}${DETAIL_HTML}</body></html>`,
			finalOrderId: ORDER_A,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(harness.emitted, []);
});

test("final URL A with a header for order B is withheld even when the page mentions A elsewhere (cancellation)", async () => {
	const { harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], () => ({
			html: `<html><body>${HEADER_B}${INCIDENTAL_A}<div data-component="cancelled">cancelled</div></body></html>`,
			finalOrderId: ORDER_A,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(harness.emitted, []);
});

test("a healthy order page that merely mentions other orders is accepted", async () => {
	const other = `<a href="/your-orders/order-details?orderID=${ORDER_OTHER}">other</a>`;
	const { harness } = await runCollectOrders(
		redirectingOrdersSite([ONE_ROW_SEARCH], (orderId) => ({
			html: `<html><body>${other}${DETAIL_HTML}</body></html>`,
			finalOrderId: orderId,
		})),
		["orders", "order_items"],
	);
	assert.deepEqual(
		harness.emitted.map((r) => r.stream),
		["orders", "order_items"],
	);
});

test("nutrition reports progress once per product", async () => {
	const progress: { message: string; details?: { stream?: string } }[] = [];
	const harness = makeRecordingEmit(validateRecord);
	await collectOrders({
		emit: harness.emit,
		emitRecord: harness.emitRecord,
		page: degradingSite(() => AMAZON_FULL_PANEL, [ONE_ROW_SEARCH]),
		progress: async (message, details) => {
			progress.push({ message, details: details as { stream?: string } });
		},
		reportStreamFailure: () => Promise.resolve(),
		requested: new Map([["nutrition", {}]]) as never,
		state: {},
	});
	assert.equal(
		progress.filter(
			(p) => p.details?.stream === "nutrition" && /Looked up/.test(p.message),
		).length,
		2, // one per product, plus the closing summary
	);
});

// ─── Round 7: the relaxed tie, GTIN laundering, off-origin tiles ──────────
//
// Synthetic pages, as in round 6.

const PANEL95 =
	"<div><h2>Nutrition Facts</h2><p>Calories 95 Total Fat 0.2g Total Carbohydrate 25g Protein 0.6g</p></div>";
const ldNode = (node: unknown) =>
	`<script type="application/ld+json">${JSON.stringify(node)}</script>`;
const tileSearch = (...hrefs: string[]) =>
	`<html><body>${hrefs.map((h) => `<div data-testid="product-tile"><a href="${h}">t</a></div>`).join("")}</body></html>`;
const fullSite = (
	amazon: string,
	tiles: string[],
	productFor: (url: string) => string,
	visited: string[] = [],
) => {
	let current = "";
	return {
		content: async () =>
			isAmazon(current)
				? amazon
				: current.includes("/search?")
					? tileSearch(...tiles)
					: productFor(current),
		goto: async (url: string) => {
			current = url;
			visited.push(url);
			return null;
		},
		locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		url: () => current,
	} as unknown as Page;
};
const APPLES_NODE = {
	"@type": "Product",
	name: "Apples",
	gtin12: "111111111117",
};

test("a Pears panel under a title element is not Apples, with or without an h1", async () => {
	const titles = ['<div class="product-title">Pears</div>', "<h1>Pears</h1>"];
	const outcomes = await Promise.all(
		titles.map(async (title) => ({
			title,
			outcome: await typedLookup(
				fullSite(
					AMAZON_PRODUCT_NO_PANEL,
					["/product/pears"],
					() =>
						`<html><body>${title}${PANEL95}${ldNode(APPLES_NODE)}</body></html>`,
				),
				"Apples",
			),
		})),
	);
	for (const { title, outcome } of outcomes) {
		assert.notEqual(outcome.status, "matched", title);
	}
});

test("a rendered panel with no title and no tied node has no subject, so it is taken by no one", async () => {
	const outcome = await typedLookup(
		fullSite(
			AMAZON_PRODUCT_NO_PANEL,
			["/product/x"],
			() => `<html><body>${PANEL95}${ldNode(APPLES_NODE)}</body></html>`,
		),
		"Apples",
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "identity_unbound");
});

test("with no title, a sole node still releases its OWN nutrition and GTIN", async () => {
	const outcome = await typedLookup(
		fullSite(
			AMAZON_PRODUCT_NO_PANEL,
			["/product/x"],
			() =>
				`<html><body>${ldNode({ ...APPLES_NODE, nutrition: { "@type": "NutritionInformation", calories: "52", proteinContent: "0.3 g", carbohydrateContent: "14 g", fatContent: "0.2 g" } })}</body></html>`,
		),
		"Apples",
	);
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.calories, 52);
	assert.equal(outcome.facts.upc, "111111111117");
});

test("a GTIN read from a name-bound tile is not a bound GTIN for the next tile", async () => {
	const first = `<html><body><h1>Organic Bananas</h1><div><h2>Nutrition Facts</h2><p>Calories 105</p></div>${ldNode({ "@type": "Product", name: "Organic Bananas", gtin12: "012345678905" })}</body></html>`;
	const second = `<html><body><h1>Banana Bread Mix</h1>${ldNode({ "@type": "Product", name: "Banana Bread Mix", gtin12: "012345678905", nutrition: { "@type": "NutritionInformation", calories: "200", proteinContent: "3 g", carbohydrateContent: "40 g", fatContent: "2 g" } })}</body></html>`;
	const outcome = await typedLookup(
		fullSite(AMAZON_PRODUCT_NO_PANEL, ["/product/a", "/product/b"], (url) =>
			url.endsWith("/a") ? first : second,
		),
		"Organic Bananas",
	);
	assert.notEqual(outcome.status, "matched");
});

test("a GTIN bound to Amazon only by URL binds a tile at medium, not high", async () => {
	const tile = `<html><body><h1>Some Different Name</h1>${ldNode({ "@type": "Product", name: "Some Different Name", gtin12: "012345678905", nutrition: { "@type": "NutritionInformation", calories: "105", proteinContent: "1.3 g", carbohydrateContent: "27 g", fatContent: "0.4 g" } })}</body></html>`;
	const outcome = await typedLookup(
		fullSite(AMAZON_UPC_PAGE, ["/product/x"], () => tile),
	);
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.confidence, "medium");
});

test("an off-origin search link is not a read of this product", async () => {
	const visited: string[] = [];
	const outcome = await typedLookup(
		fullSite(
			AMAZON_PRODUCT_NO_PANEL,
			["https://www.amazon.com/dp/B000000001", "/product/pears"],
			() => `<html><body><h1>Pears</h1>${PANEL95}</body></html>`,
			visited,
		),
		"Apples",
	);
	assert.deepEqual(
		visited.filter((u) => u.includes("/dp/B000000001")),
		[],
	);
	assert.equal(outcome.status, "not_found");
});

test("untied nodes under a heading that is not the request are another product, not an ambiguity", async () => {
	const page = `<html><body><h1>Pears</h1>${PANEL95}${ldNode([
		{ "@type": "Product", name: "365 Pear Halves" },
		{ "@type": "Product", name: "Kiwi" },
	])}</body></html>`;
	const outcome = await typedLookup(
		fullSite(AMAZON_PRODUCT_NO_PANEL, ["/product/pears"], () => page),
		"Apples",
	);
	assert.equal(outcome.status, "not_found");
});

test("a tile linked by a relative and an absolute href is one tile", async () => {
	const visited: string[] = [];
	const hrefs = Array.from({ length: 6 }, (_, i) => [
		`/product/p${i}`,
		`https://www.wholefoodsmarket.com/product/p${i}`,
	]).flat();
	await typedLookup(
		fullSite(
			AMAZON_PRODUCT_NO_PANEL,
			hrefs,
			() => "<html><body><h1>Other</h1></body></html>",
			visited,
		),
		"Apples",
	);
	assert.equal(visited.filter((u) => u.includes("/product/")).length, 6);
});

// ─── Round 8: subject-scoped, lossless evidence (F1-F8) ───────────────────
//
// Each test is one failing input from the design review of 7138d906d, run
// through the whole lookup. Pages are synthetic, as above.

const AMAZON_APPLES_NO_PANEL =
	'<html><body><span id="productTitle">Apples</span></body></html>';
const APPLES_PANEL =
	"<div><h3>Nutrition Facts</h3><p>Calories 52 Total Fat 0.2g Total Carbohydrate 14g Protein 0.3g</p></div>";
const ldNode8 = (node: Record<string, unknown>) =>
	`<script type="application/ld+json">${JSON.stringify(node)}</script>`;
/** Amazon answers `amazonHtml`; Whole Foods search lists `tiles`; each tile
 *  path serves its page. */
const site8 = (
	amazonHtml: string,
	tiles: Record<string, string>,
	finalUrlFor?: (url: string) => string,
) =>
	scriptedBrowser((url) => {
		if (isAmazon(url)) return amazonHtml;
		if (url.includes("/search?")) {
			return Object.keys(tiles)
				.map((path) => `<a href="${path}">tile</a>`)
				.join("");
		}
		const path = new URL(url).pathname;
		return tiles[path] ?? "<html><body>gone</body></html>";
	}, finalUrlFor);

test("F1: a recommendation's rendered panel is not the main heading's panel", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_APPLES_NO_PANEL, {
			"/product/apples":
				"<html><body><h1>Apples</h1><aside><h2>Recommended Pears</h2><div><h3>Nutrition Facts</h3><p>Calories 95 Total Fat 0g Total Carbohydrate 25g Protein 1g</p></div></aside></body></html>",
		}),
		"Apples",
	);
	assert.notEqual(outcome.status, "matched");
});

test("F1: a hidden or inert panel is not observed", async () => {
	const outcomes = await Promise.all(
		[
			(panel: string) => `<div hidden>${panel}</div>`,
			(panel: string) => `<template>${panel}</template>`,
			(panel: string) => `<div style="display:none">${panel}</div>`,
		].map((wrap) =>
			typedLookup(
				site8(AMAZON_APPLES_NO_PANEL, {
					"/product/apples": `<html><body><h1>Apples</h1>${wrap(APPLES_PANEL)}</body></html>`,
				}),
				"Apples",
			),
		),
	);
	assert.deepEqual(
		outcomes.map((outcome) => outcome.status === "matched"),
		[false, false, false],
	);
});

test("F2: a URL-tied node named otherwise lends its GTIN to no one", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_APPLES_NO_PANEL, {
			"/product/apples": `<html><head>${ldNode8({ "@type": "Product", name: "Pears", url: "/product/apples", gtin12: "036000291452" })}</head><body><h1>Apples</h1>${APPLES_PANEL}</body></html>`,
		}),
		"Apples",
	);
	// The page contradicts itself; nothing on it is Apples' with a Pears barcode.
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "identity_conflict");
});

test("F3: a partial Amazon panel with no calories row is still an unread product", async () => {
	const outcome = await typedLookup(
		scriptedBrowser((url) =>
			isAmazon(url)
				? '<html><body><span id="productTitle">Banana Peppers</span><div id="nic-nutrition-facts">Total Fat 1g Total Carbohydrate 3g Protein 1g</div></body></html>'
				: NO_PAGE_SOURCE(),
		),
		"Banana Peppers",
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "panel_partial");
});

test("F3: a partial Whole Foods panel with no calories row is still an unread product", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_PRODUCT_NO_PANEL, {
			"/product/banana-peppers": `<html><body>${ldNode8({ "@type": "Product", name: "Banana Peppers" })}<h1>Banana Peppers</h1><div><h3>Nutrition Facts</h3><div>Total Fat 1g Total Carbohydrate 3g Protein 1g</div></div></body></html>`,
		}),
		"Banana Peppers",
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "panel_partial");
});

test("F5: partial structured nutrition does not hide a complete rendered panel of the same subject", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_APPLES_NO_PANEL, {
			"/product/apples": `<html><body>${ldNode8({ "@type": "Product", name: "Apples", nutrition: { "@type": "NutritionInformation", calories: "52" } })}<h1>Apples</h1><div><h3>Nutrition Facts</h3><p>Calories 52 Total Fat 0.2g Total Carbohydrate 14g Protein 0.3g</p></div></body></html>`,
		}),
		"Apples",
	);
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.source, "wholefoods_product_page");
	assert.equal(outcome.facts.carbsG, 14);
	assert.equal(outcome.facts.confidence, "medium");
});

test("F6 guard: a Whole Foods GTIN never binds a later tile by barcode", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_APPLES_NO_PANEL, {
			"/product/apples": `<html><body>${ldNode8({ "@type": "Product", name: "Apples", gtin12: "012345678905" })}<h1>Apples</h1></body></html>`,
			"/product/other": `<html><body>${ldNode8({ "@type": "Product", name: "Some Other Thing", gtin12: "012345678905" })}<h1>Some Other Thing</h1>${APPLES_PANEL}</body></html>`,
		}),
		"Apples",
	);
	assert.notEqual(outcome.status, "matched");
});

test("F7: one tile whose read throws does not strand a later bound tile", async () => {
	const inner = site8(AMAZON_APPLES_NO_PANEL, {
		"/product/a": "<html><body></body></html>",
		"/product/b": `<html><body><h1>Apples</h1>${APPLES_PANEL}</body></html>`,
	});
	const page = {
		...inner,
		content: inner.content,
		url: inner.url,
		locator: inner.locator,
		goto: async (url: string) => {
			if (url.endsWith("/product/a"))
				throw new Error("net::ERR_CONNECTION_RESET");
			return inner.goto(url);
		},
	} as unknown as Page;
	const outcome = await typedLookup(page, "Apples");
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.calories, 52);
});

test("F8: a search that ends off Whole Foods is not a no-results answer", async () => {
	const outcome = await typedLookup(
		scriptedBrowser(
			(url) =>
				isAmazon(url)
					? AMAZON_PRODUCT_NO_PANEL
					: "<html><body>No results</body></html>",
			(url) => (url.includes("/search?") ? "https://example.com/error" : url),
		),
		"Banana Peppers",
	);
	assert.notEqual(outcome.status, "matched");
});

test("F8: a tile or an Amazon page redirected off its site to a 404 is not 'no page'", async () => {
	const browser = (offSite: (url: string) => boolean): Page => {
		let current = "about:blank";
		return {
			content: async () =>
				isAmazon(current)
					? AMAZON_PRODUCT_NO_PANEL
					: current.includes("/search?")
						? '<a href="/product/banana-peppers">b</a>'
						: "<html><body>Not found</body></html>",
			goto: async (url: string) => {
				current = url;
				return offSite(url) ? { ok: () => false, status: () => 404 } : null;
			},
			locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
			url: () => (offSite(current) ? "https://example.com/404" : current),
		} as unknown as Page;
	};
	const tile = await typedLookup(
		browser((url) => url.includes("/product/")),
		"Banana Peppers",
	);
	assert.notEqual(tile.status, "matched");
	const amazon = await typedLookup(browser(isAmazon), "Banana Peppers");
	assert.notEqual(amazon.status, "matched");
});

// ─── Round 9: one source answer per read; descriptors are scoped (N1-N7) ──
//
// Each test is one failing input from the design review of f50a9b4ac.

const PEPPERS_PANEL =
	"<div><h3>Nutrition Facts</h3><p>Calories 20 Total Fat 1g Total Carbohydrate 3g Protein 1g</p></div>";
const RECOMMENDED_PEARS_DETAILS =
	'<aside><h2>Recommended Pears</h2><div><h3>Allergens</h3><p>Peanuts</p></div><div><h3>Ingredients</h3><p>peanuts</p></div><span class="badge">Vegan</span></aside>';

test("N1: a recommendation's allergens, ingredients and badges are not the bound product's", async () => {
	const outcomes = await Promise.all(
		[
			`<html><body>${RECOMMENDED_PEARS_DETAILS}<h1>Apples</h1>${APPLES_PANEL}</body></html>`,
			`<html><body><h1>Apples</h1>${APPLES_PANEL}${RECOMMENDED_PEARS_DETAILS}</body></html>`,
			`<html><body><h1>Apples</h1>${APPLES_PANEL}<div hidden><h3>Ingredients</h3><p>peanuts</p><span class="badge">Vegan</span></div></body></html>`,
		].map((html) =>
			typedLookup(
				site8(AMAZON_APPLES_NO_PANEL, { "/product/apples": html }),
				"Apples",
			),
		),
	);
	for (const outcome of outcomes) {
		assert.equal(outcome.status, "matched");
		if (outcome.status !== "matched") continue;
		assert.equal(outcome.facts.calories, 52);
		assert.equal(outcome.facts.allergens, null);
		assert.equal(outcome.facts.ingredients, null);
		assert.deepEqual(outcome.facts.highlights, []);
	}
});

test("N1: the bound product's own details are kept next to a recommendation's", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_APPLES_NO_PANEL, {
			"/product/apples": `<html><body><h1>Apples</h1>${APPLES_PANEL}<div><h3>Ingredients</h3><p>apples</p></div>${RECOMMENDED_PEARS_DETAILS}</body></html>`,
		}),
		"Apples",
	);
	assert.equal(outcome.status, "matched");
	if (outcome.status !== "matched") return;
	assert.equal(outcome.facts.ingredients, "apples");
	assert.equal(outcome.facts.allergens, null);
	assert.deepEqual(outcome.facts.highlights, []);
});

test("N2: a script or hidden 'No results' text is not the source's empty state", async () => {
	const outcomes = await Promise.all(
		[
			'<html><body><script>const emptyLabel = "No products";</script></body></html>',
			"<html><body><div hidden>No results</div></body></html>",
			'<html><body><div style="display:none"><p>0 results</p></div><div class="spinner">Loading</div></body></html>',
		].map((searchHtml) =>
			typedLookup(
				scriptedBrowser((url) =>
					isAmazon(url) ? AMAZON_PRODUCT_NO_PANEL : searchHtml,
				),
				"Banana Peppers",
			),
		),
	);
	assert.deepEqual(
		outcomes.map((outcome) => [
			outcome.status,
			(outcome as { cause?: string }).cause,
		]),
		[
			["error", "unrecognized_page"],
			["error", "unrecognized_page"],
			["error", "unrecognized_page"],
		],
	);
});

test("N2 control: a visible empty state on the search page is the source's own no-results answer", async () => {
	const outcome = await typedLookup(
		scriptedBrowser((url) =>
			isAmazon(url)
				? AMAZON_PRODUCT_NO_PANEL
				: "<html><body><p>No results for banana peppers</p></body></html>",
		),
		"Banana Peppers",
	);
	assert.deepEqual(outcome, { status: "not_found", cause: "no_match" });
});

test("N3: a walk cut off by the tile budget is unfinished, not 'no panel'", async () => {
	const tiles: Record<string, string> = {};
	for (let i = 0; i < 8; i += 1) {
		tiles[`/product/other-${i}`] =
			`<html><body>${ldNode8({ "@type": "Product", name: `Other Thing ${i}` })}<h1>Other Thing ${i}</h1></body></html>`;
	}
	tiles["/product/banana-peppers"] =
		`<html><body>${ldNode8({ "@type": "Product", name: "Banana Peppers" })}<h1>Banana Peppers</h1>${PEPPERS_PANEL}</body></html>`;
	const outcome = await typedLookup(
		site8(AMAZON_PRODUCT_NO_PANEL, tiles),
		"Banana Peppers",
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "search_incomplete");
});

const N4_PAGE = `<html><body><script type="application/ld+json">{"@type":"Product","name":"Banana Peppers","url":"/product/banana-peppers"}</script><section><h2>Banana Peppers</h2>${PEPPERS_PANEL}</section></body></html>`;

test("N4: a panel the binding cannot attribute is unresolved, not absent", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_PRODUCT_NO_PANEL, { "/product/banana-peppers": N4_PAGE }),
		"Banana Peppers",
	);
	assert.equal(outcome.status, "error");
	assert.equal((outcome as { cause: string }).cause, "panel_unresolved");
});

test("N4 control: a recommendation's h2 panel is never the product's facts", async () => {
	const outcome = await typedLookup(
		site8(AMAZON_PRODUCT_NO_PANEL, {
			"/product/banana-peppers": `<html><body>${ldNode8({ "@type": "Product", name: "Banana Peppers" })}<h1>Banana Peppers</h1><aside><h2>Recommended Pears</h2>${PEPPERS_PANEL}</aside></body></html>`,
		}),
		"Banana Peppers",
	);
	assert.notEqual(outcome.status, "matched");
	assert.notEqual(outcome.status, "not_found");
});

// ─── N6, N7: order recovery ───────────────────────────────────────────────

const asinN = (i: number) => `B00000000${i}`;
const tenItemDetail = (orderId: string) =>
	ordersWithIdentity(
		orderId,
		Array.from(
			{ length: 10 },
			(_, i) =>
				`<div data-component="purchasedItemsRightGrid"><a href="/dp/${asinN(i)}">Item ${i}</a><span>Qty: 1</span></div>`,
		).join(""),
	);

test("N6: a repeated search page changes no partial order count", async () => {
	const page1 = searchPage(
		1,
		Array.from(
			{ length: 10 },
			(_, i) => [ORDER_A, asinN(i)] as [string, string],
		),
		true,
	);
	const { failures, harness } = await runCollectOrders(
		redirectingOrdersSite([page1, page1], (orderId) => ({
			html: tenItemDetail(orderId),
			finalOrderId: orderId,
		})),
		["orders", "order_items"],
	);
	assert.ok(failures.length > 0);
	assert.deepEqual(stateStreams(harness), []);
	const orders = harness.emitted.filter((r) => r.stream === "orders");
	assert.equal(orders.length, 1);
	assert.equal(orders[0]?.data.item_count, 10);
	assert.equal(
		harness.emitted.filter((r) => r.stream === "order_items").length,
		10,
	);
});

const MALFORMED_DETAIL = (orderId: string) =>
	ordersWithIdentity(
		orderId,
		'<div data-component="purchasedItemsRightGrid"><div data-component="itemTitle"><a href="/dp/B01ABCDEFG"></a></div></div>',
	);
test("N7: a malformed detail is that order's failure; the next readable order is still delivered", async () => {
	const twoOrders = (lastPageSignal: boolean) => {
		const html = searchPage(
			1,
			[
				[ORDER_A, "B01ABCDEFG"],
				[ORDER_B, "B012345678"],
			],
			false,
		);
		return lastPageSignal
			? html
			: html.replace('<li class="a-disabled a-last">Next</li>', "");
	};
	const runs = await Promise.all(
		[true, false].map((lastPageSignal) =>
			runCollectOrders(
				redirectingOrdersSite([twoOrders(lastPageSignal)], (orderId) => ({
					html:
						orderId === ORDER_A
							? MALFORMED_DETAIL(orderId)
							: ordersWithIdentity(orderId, DETAIL_HTML),
					finalOrderId: orderId,
				})),
				["orders", "order_items"],
			),
		),
	);
	for (const { failures, harness } of runs) {
		assert.ok(failures.length > 0);
		assert.deepEqual(stateStreams(harness), []);
		assert.deepEqual(
			harness.emitted
				.filter((r) => r.stream === "orders")
				.map((r) => r.data.id),
			[ORDER_B],
		);
	}
});

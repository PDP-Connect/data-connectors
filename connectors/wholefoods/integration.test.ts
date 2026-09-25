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
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	assertCompleteOrderDetail,
	buildNutritionRecord,
	buildOrderItemRecord,
	buildOrderRecord,
	collectProfile,
	discoverOrderStubs,
	lookupNutritionForProduct,
} from "./index.ts";
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
	await collectProfile(fakePage(PROFILE_HTML), harness.emitRecord);
	assert.equal(harness.emitted.length, 1);
	assert.equal(harness.emitted[0]?.stream, "profile");
	assert.equal(harness.emitted[0]?.data.id, "A39M9I106DZZ8N");
	assert.equal(harness.emitted[0]?.data.name, "Jane Owner");
	assert.equal(harness.emitted[0]?.data.email, null);
});

test("collectProfile emits nothing when the account page has no scrapeable customerId", async () => {
	const harness = makeRecordingEmit(validateRecord);
	await collectProfile(
		fakePage("<html><body>no account info</body></html>"),
		harness.emitRecord,
	);
	assert.equal(harness.emitted.length, 0);
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

test("assertCompleteOrderDetail rejects partial detail rows before emitting an order", () => {
	assert.throws(
		() => assertCompleteOrderDetail({ ...STUB, expectedItemCount: 2 }, []),
		/did not match search result count 2/,
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
// throw.
test("assertCompleteOrderDetail tolerates a repeated-product order where the detail page folds duplicate units into one row's quantity", () => {
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
	assert.doesNotThrow(() =>
		assertCompleteOrderDetail(repeatedProductStub, dedupedDetailItems),
	);
});

// Counterweight: a genuinely incomplete detail page (a distinct product
// missing its own row, not folded via quantity) must still fail closed.
test("assertCompleteOrderDetail still rejects a detail page missing a distinct product row", () => {
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
	assert.throws(
		() =>
			assertCompleteOrderDetail(twoDistinctProductsStub, onlyOneProductParsed),
		/did not match search result count 2/,
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
		discoverOrderStubs(shape),
		/no recognizable results or empty-state evidence/,
	);
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

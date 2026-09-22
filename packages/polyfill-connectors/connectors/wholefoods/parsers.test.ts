// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the Whole Foods connector's pure parsers. All fixtures here
 * are SYNTHETIC — hand-written HTML/JSON shaped like the real pages the
 * legacy connectors/wholefoods/wholefoods-playwright.js scraped, not
 * captures from a live account (this session has no live browser profile).
 * They lock down parser behavior; they do not satisfy the fixture-proof gate
 * in CONNECTOR-CHECKLIST.md, which requires a scrubbed real capture.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	bestUsdaMatch,
	cleanProductName,
	mapUsdaNutrients,
	parseAmazonProfileDom,
	parseDollarsToCents,
	parseOrderDateIso,
	parseOrderDetailDom,
	parseOrderSearchPageDom,
	parseWholeFoodsProductPageDom,
	parseWholeFoodsSearchResultDom,
	scoreUsdaMatch,
} from "./parsers.ts";
import type { UsdaFood } from "./types.ts";

// ─── Profile ────────────────────────────────────────────────────────────

// Shapes confirmed against a live capture 2026-09-22 (see parsers.ts's
// parseAmazonProfileDom header comment for why the legacy ya-myab-* card
// selectors were replaced).
test("parseAmazonProfileDom extracts the name from the header greeting and the id from the inline cpsData blob", () => {
	const html = `<html><body>
    <span id="nav-link-accountList-nav-line-1">Hello, Jane Owner</span>
    <script>{"marketplaceId":"ATVPDKIKX0DER","customerId":"A39M9I106DZZ8N","httpRequestId":"x"}</script>
  </body></html>`;
	const { customerId, name } = parseAmazonProfileDom(html);
	assert.equal(name, "Jane Owner");
	assert.equal(customerId, "A39M9I106DZZ8N");
});

test("parseAmazonProfileDom returns null fields when the page has none of the known sources", () => {
	const { customerId, name } = parseAmazonProfileDom(
		"<html><body>nothing here</body></html>",
	);
	assert.equal(name, null);
	assert.equal(customerId, null);
});

// ─── Order search page ────────────────────────────────────────────────────

function searchResultRow(orderId: string, orderedOnText: string): string {
	return `
    <div class="a-fixed-left-grid">
      <div class="a-row">
        <a title="View order details" href="/gp/your-account/order-details?orderID=${orderId}">details</a>
        <span>${orderedOnText}</span>
      </div>
    </div>`;
}

test("parseOrderSearchPageDom extracts unique order stubs and their order date text", () => {
	const html = `<html><body>
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
    ${searchResultRow("222-2222222-2222222", "Ordered on April 1, 2026")}
  </body></html>`;
	const { hasNextPage, stubs } = parseOrderSearchPageDom(html);
	assert.equal(hasNextPage, false);
	assert.equal(stubs.length, 2);
	assert.equal(stubs[0]?.orderId, "111-1111111-1111111");
	assert.equal(stubs[0]?.orderDateRaw, "March 3, 2026");
	assert.equal(stubs[1]?.orderId, "222-2222222-2222222");
});

test("parseOrderSearchPageDom dedupes repeated item rows for the same order", () => {
	const html = `<html><body>
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
  </body></html>`;
	const { stubs } = parseOrderSearchPageDom(html);
	assert.equal(stubs.length, 1);
});

test("parseOrderSearchPageDom reports hasNextPage from the pagination control", () => {
	const html = `<html><body>
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
    <ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>
  </body></html>`;
	const { hasNextPage } = parseOrderSearchPageDom(html);
	assert.equal(hasNextPage, true);
});

// ─── Order detail page ────────────────────────────────────────────────────
//
// Shapes confirmed against a live capture 2026-09-22 (see parsers.ts's
// parseOrderDetailDom header comment): real line items live inside
// [data-component="purchasedItemsRightGrid"], which structurally excludes
// the global nav's Whole-Foods-storefront link (the legacy `almBrandId`
// "marker" the prior code filtered FOR — backwards, see the header comment)
// and footer/cross-sell ad links.

function purchasedItemRow(opts: {
	asin: string;
	name: string;
	price?: string;
	qty?: string;
	imageSrc?: string;
}): string {
	return `<div data-component="purchasedItemsRightGrid">
    <div data-component="itemTitle"><a href="/dp/${opts.asin}?ref_=ppx_hzod_title_dt_b_fed_asin_title_0_0">${opts.name}</a></div>
    <div data-component="orderedMerchant"><span>Sold by: Whole Foods Market</span></div>
    <div data-component="quantity">${opts.qty ? `Qty: ${opts.qty}` : ""}</div>
    <div data-component="unitPrice">${opts.price ? `$${opts.price}` : ""}</div>
    ${opts.imageSrc ? `<img src="${opts.imageSrc}" />` : ""}
  </div>`;
}

// The global nav renders a Whole-Foods-storefront link with an almBrandId
// query param on every order-detail page, regardless of order content — it
// must never be treated as a line item.
const WHOLE_FOODS_NAV_LINK =
	'<li class="nav-li"><a href="/alm/storefront?almBrandId=VUZHIFdob2xlIEZvb2Rz&ref_=nav_cs_whole_foods">Whole Foods Market</a></li>';

test("parseOrderDetailDom extracts real Whole Foods line items from purchasedItemsRightGrid", () => {
	const html = `<html><body>
    ${WHOLE_FOODS_NAV_LINK}
    ${purchasedItemRow({
			asin: "B01ABCDEFG",
			imageSrc: "https://m.media-amazon.com/images/I/example.jpg",
			name: "Organic Bananas, 1 bunch",
			price: "1.99",
			qty: "2",
		})}
    <div>Order Placed: March 3, 2026</div>
  </body></html>`;
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items.length, 1);
	const [item] = detail.items;
	assert.equal(item?.productId, "B01ABCDEFG");
	assert.equal(item?.name, "Organic Bananas, 1 bunch");
	assert.equal(item?.quantity, 2);
	assert.equal(item?.unitPriceDollars, 1.99);
	assert.equal(
		item?.imageUrl,
		"https://m.media-amazon.com/images/I/example.jpg",
	);
	assert.equal(detail.orderDateRaw, "March 3, 2026");
});

test("parseOrderDetailDom ignores the global nav's Whole-Foods-storefront link (the legacy almBrandId filter was backwards)", () => {
	const html = `<html><body>
    ${WHOLE_FOODS_NAV_LINK}
    ${purchasedItemRow({ asin: "B01ABCDEFG", name: "Real Whole Foods item" })}
  </body></html>`;
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items.length, 1);
	assert.equal(detail.items[0]?.productId, "B01ABCDEFG");
});

test("parseOrderDetailDom ignores footer/cross-sell links outside purchasedItemsRightGrid", () => {
	const html = `<html><body>
    ${purchasedItemRow({ asin: "B01ABCDEFG", name: "Real Whole Foods item" })}
    <a href="/dp/product/B084KP3NG6?plattr=SCFOOT&ref_=footer_ACB">Amazon Secured Card</a>
  </body></html>`;
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items.length, 1);
	assert.equal(detail.items[0]?.productId, "B01ABCDEFG");
});

test("parseOrderDetailDom defaults quantity to 1 when the row has no Qty text", () => {
	const html = `<html><body>${purchasedItemRow({ asin: "B01ABCDEFG", name: "Single item" })}</body></html>`;
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items[0]?.quantity, 1);
});

// ─── Shared value parsing ──────────────────────────────────────────────────

test("parseOrderDateIso converts a free-text date to date-only ISO precision", () => {
	assert.equal(parseOrderDateIso("March 3, 2026"), "2026-03-03");
});

test("parseOrderDateIso returns null for unparseable text rather than guessing", () => {
	assert.equal(parseOrderDateIso("sometime last spring"), null);
	assert.equal(parseOrderDateIso(null), null);
	assert.equal(parseOrderDateIso(undefined), null);
});

test("parseDollarsToCents converts a dollar string to integer cents", () => {
	assert.equal(parseDollarsToCents("$1,234.56"), 123_456);
	assert.equal(parseDollarsToCents(1.99), 199);
});

test("parseDollarsToCents returns null for absent input", () => {
	assert.equal(parseDollarsToCents(null), null);
	assert.equal(parseDollarsToCents(undefined), null);
});

// ─── Nutrition: name cleaning + USDA fuzzy match ──────────────────────────

test("cleanProductName strips brand prefix and trailing size", () => {
	assert.equal(
		cleanProductName("365 by Whole Foods Market Organic Bananas, 1 lb"),
		"Bananas",
	);
});

function usdaFood(overrides: Partial<UsdaFood> = {}): UsdaFood {
	return {
		brandName: null,
		brandOwner: null,
		description: "Bananas, raw",
		fdcId: 1,
		foodNutrients: [],
		gtinUpc: null,
		servingSize: null,
		servingSizeUnit: null,
		...overrides,
	};
}

test("scoreUsdaMatch scores full word overlap as 1", () => {
	const score = scoreUsdaMatch(
		"bananas raw",
		usdaFood({ description: "Bananas, raw" }),
	);
	assert.equal(score, 1);
});

test("scoreUsdaMatch scores no overlap as 0", () => {
	const score = scoreUsdaMatch(
		"bananas raw",
		usdaFood({ description: "Chicken breast" }),
	);
	assert.equal(score, 0);
});

test("bestUsdaMatch returns null when nothing clears the minimum score", () => {
	const foods = [usdaFood({ description: "Chicken breast" })];
	assert.equal(bestUsdaMatch("bananas raw", foods, 0.4), null);
});

test("bestUsdaMatch returns the highest-scoring food above the threshold", () => {
	const foods = [
		usdaFood({ description: "Chicken breast", fdcId: 1 }),
		usdaFood({ description: "Bananas, raw", fdcId: 2 }),
	];
	const match = bestUsdaMatch("bananas raw", foods, 0.4);
	assert.equal(match?.fdcId, 2);
});

test("mapUsdaNutrients scales per-100g nutrients to the food's own serving size", () => {
	const food = usdaFood({
		foodNutrients: [
			{ nutrientId: 1008, value: 89 }, // calories
			{ nutrientId: 1003, value: 1.1 }, // protein
		],
		gtinUpc: "012345678905",
		servingSize: 118,
		servingSizeUnit: "g",
	});
	const facts = mapUsdaNutrients(food, "upc");
	assert.equal(facts.confidence, "high");
	assert.equal(facts.source, "usda_fdc");
	assert.equal(facts.servingSize, "118g");
	assert.equal(facts.calories, Math.round(89 * 1.18 * 100) / 100);
	assert.equal(facts.upc, "012345678905");
});

test("mapUsdaNutrients reports medium confidence for a text-matched result", () => {
	const facts = mapUsdaNutrients(usdaFood(), "text");
	assert.equal(facts.confidence, "medium");
});

test("mapUsdaNutrients falls back to per-100g scale when servingSize is absent", () => {
	const food = usdaFood({
		foodNutrients: [{ nutrientId: 1008, value: 89 }],
	});
	const facts = mapUsdaNutrients(food, "text");
	assert.equal(facts.calories, 89);
	assert.equal(facts.servingSize, null);
});

// ─── Nutrition: Whole Foods product page ──────────────────────────────────

test("parseWholeFoodsProductPageDom prefers JSON-LD NutritionInformation when present", () => {
	const html = `<html><body>
    <script type="application/ld+json">
      {"@type":"Product","nutrition":{"@type":"NutritionInformation","calories":"105 calories","proteinContent":"1.3g","servingSize":"1 medium (118g)"}}
    </script>
  </body></html>`;
	const facts = parseWholeFoodsProductPageDom(html);
	assert.equal(facts?.source, "wholefoods_product_page");
	assert.equal(facts?.confidence, "high");
	assert.equal(facts?.calories, 105);
	assert.equal(facts?.proteinG, 1.3);
	assert.equal(facts?.servingSize, "1 medium (118g)");
});

test("parseWholeFoodsProductPageDom falls back to text-pattern parsing of the nutrition panel", () => {
	const html = `<html><body>
    <div>
      <h3>Nutrition Facts</h3>
      <div>Serving size 1 medium (118g)
      Calories 105
      Total Fat 0.4g
      Protein 1.3g
      </div>
    </div>
  </body></html>`;
	const facts = parseWholeFoodsProductPageDom(html);
	assert.equal(facts?.source, "wholefoods_product_page");
	assert.equal(facts?.calories, 105);
	assert.equal(facts?.fatG, 0.4);
	assert.equal(facts?.proteinG, 1.3);
});

test("parseWholeFoodsProductPageDom returns null when the page has no nutrition evidence", () => {
	const facts = parseWholeFoodsProductPageDom(
		"<html><body>no nutrition here</body></html>",
	);
	assert.equal(facts, null);
});

test("parseWholeFoodsSearchResultDom extracts the first product tile link", () => {
	const html = `<html><body><a href="/product/organic-bananas">Organic Bananas</a></body></html>`;
	assert.equal(
		parseWholeFoodsSearchResultDom(html),
		"/product/organic-bananas",
	);
});

test("parseWholeFoodsSearchResultDom returns null when no product tile is present", () => {
	assert.equal(
		parseWholeFoodsSearchResultDom("<html><body>no results</body></html>"),
		null,
	);
});

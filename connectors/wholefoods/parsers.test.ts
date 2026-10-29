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
	hasOrderSearchEmptyState,
	isCancelledOrderDetail,
	parseAmazonProductNutritionDom,
	parseAmazonProfileDom,
	parseDollarsToCents,
	parseOrderDateIso,
	parseOrderDetailDom,
	parseOrderSearchPageDom,
	parseWholeFoodsSearchResultDom,
} from "./parsers.ts";
import { parseWholeFoodsProductPageDom } from "./test-support.ts";

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
	assert.equal(stubs[0]?.expectedItemCount, 1);
	assert.equal(stubs[0]?.orderDateRaw, "March 3, 2026");
	assert.equal(stubs[1]?.orderId, "222-2222222-2222222");
});

test("parseOrderSearchPageDom counts repeated item rows for the same order", () => {
	const html = `<html><body>
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
  </body></html>`;
	const { stubs } = parseOrderSearchPageDom(html);
	assert.equal(stubs.length, 1);
	assert.equal(stubs[0]?.expectedItemCount, 2);
});

test("parseOrderSearchPageDom reports hasNextPage from the pagination control", () => {
	const html = `<html><body>
    ${searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026")}
    <ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>
  </body></html>`;
	const { hasNextPage } = parseOrderSearchPageDom(html);
	assert.equal(hasNextPage, true);
});

test("parseOrderSearchPageDom gives a continued order's next page a new row signature and reads the selected page", () => {
	// Live 2026-09-28: search pages hold ~10 item rows, so one large order
	// fills whole pages with no new order id. Its item links still differ.
	const row = (asin: string) =>
		searchResultRow("111-1111111-1111111", "Ordered on March 3, 2026").replace(
			"</div>\n    </div>",
			`<a href="/dp/${asin}">item</a></div>\n    </div>`,
		);
	const pager = (n: number) =>
		`<ul class="a-pagination"><li class="a-selected"><a href="?page=${n}">${n}</a></li><li class="a-last"><a href="?page=${n + 1}">Next</a></li></ul>`;
	const page4 = parseOrderSearchPageDom(
		`<html><body>${row("A1")}${pager(4)}</body></html>`,
	);
	const page5 = parseOrderSearchPageDom(
		`<html><body>${row("A2")}${pager(5)}</body></html>`,
	);
	assert.equal(page4.stubs[0]?.orderId, page5.stubs[0]?.orderId);
	assert.notEqual(page4.rowSignature, page5.rowSignature);
	assert.equal(page4.selectedPage, 4);
	assert.equal(page5.selectedPage, 5);
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

test("parseOrderDetailDom preserves unknown quantity when the row has no Qty text", () => {
	const html = `<html><body>${purchasedItemRow({ asin: "B01ABCDEFG", name: "Single item" })}</body></html>`;
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items[0]?.quantity, null);
});

test("parseOrderDetailDom retains an online row without an ASIN for order accounting", () => {
	const html =
		'<html><body><div data-component="purchasedItemsRightGrid"><div data-component="itemTitle"><a href="/product/unknown">Unidentified item</a></div></div><div data-component="purchasedItemsRightGrid"><div data-component="itemTitle">Another unidentified item</div></div></body></html>';
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items.length, 2);
	assert.equal(detail.items[0]?.name, "Unidentified item");
	assert.equal(detail.items[0]?.productId, null);
	assert.equal(detail.items[0]?.productUrl, null);
	assert.equal(detail.items[1]?.name, "Another unidentified item");
	assert.equal(detail.items[1]?.productId, null);
});

test("parseOrderDetailDom prefers a source product link over another title link", () => {
	const html = `<div data-component="purchasedItemsRightGrid">
		<div data-component="itemTitle"><a href="/product/unknown">More details</a></div>
		<a href="/dp/B01ABCDEFG">Source product</a>
	</div>`;
	const detail = parseOrderDetailDom(html);
	assert.equal(detail.items[0]?.productId, "B01ABCDEFG");
	assert.equal(detail.items[0]?.name, "Source product");
});

test("parseOrderDetailDom still rejects a source product row with no usable name", () => {
	const html = `<div data-component="purchasedItemsRightGrid">
		<div data-component="itemTitle"><a href="/dp/B01ABCDEFG"></a></div>
	</div>`;
	assert.throws(() => parseOrderDetailDom(html), /has no source product name/);
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

// ─── Nutrition: Whole Foods product page ──────────────────────────────────

test("parseWholeFoodsProductPageDom preserves legacy JSON-LD provenance", () => {
	const html = `<html><body>
    <script type="application/ld+json">
      {"@type":"Product","nutrition":{"@type":"NutritionInformation","calories":"105 calories","proteinContent":"1.3g","servingSize":"1 medium (118g)"}}
    </script>
  </body></html>`;
	const facts = parseWholeFoodsProductPageDom(html);
	assert.equal(facts?.source, "wholefoods_structured_data");
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
		"https://www.wholefoodsmarket.com/product/organic-bananas",
	);
});

test("parseWholeFoodsSearchResultDom returns null when no product tile is present", () => {
	assert.equal(
		parseWholeFoodsSearchResultDom("<html><body>no results</body></html>"),
		null,
	);
});

test("parseOrderSearchPageDom reads the disabled Next control as the last-page signal", () => {
	const row = `<div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=111-1111111-1111111">details</a></div>`;
	const last = parseOrderSearchPageDom(
		`${row}<ul class="a-pagination"><li class="a-selected">2</li><li class="a-disabled a-last">Next</li></ul>`,
	);
	assert.equal(last.hasNextPage, false);
	assert.equal(last.isLastPage, true);
	const missing = parseOrderSearchPageDom(
		`${row}<ul class="a-pagination"><li class="a-selected">2</li></ul>`,
	);
	assert.equal(missing.isLastPage, false);
	const more = parseOrderSearchPageDom(
		`${row}<ul class="a-pagination"><li class="a-last"><a href="?page=3">Next</a></li></ul>`,
	);
	assert.equal(more.hasNextPage, true);
	assert.equal(more.isLastPage, false);
});

// ─── Order search empty state / cancelled detail ───────────────────────────

test("hasOrderSearchEmptyState accepts a rendered empty-orders element and a zero count", () => {
	assert.equal(
		hasOrderSearchEmptyState(
			'<div class="your-orders-content-container"><p>No orders</p></div>',
		),
		true,
	);
	assert.equal(
		hasOrderSearchEmptyState(
			'<label><span class="num-orders">0 orders</span> placed in</label>',
		),
		true,
	);
	assert.equal(
		hasOrderSearchEmptyState(
			'<div class="no-orders-banner">You have not placed any orders</div>',
		),
		true,
	);
});

test("hasOrderSearchEmptyState rejects scaffold, script strings and nonzero counts", () => {
	assert.equal(
		hasOrderSearchEmptyState(
			'<input id="searchOrdersInput"><script>const c = "no-orders"; // 0 orders</script>',
		),
		false,
	);
	assert.equal(
		hasOrderSearchEmptyState(
			'<div class="hzsearch-results-summary">30 orders matching Whole Foods Market</div>',
		),
		false,
	);
	assert.equal(
		hasOrderSearchEmptyState('<div class="no-orders"></div>'),
		false,
	);
	assert.equal(hasOrderSearchEmptyState("<html></html>"), false);
});

test("isCancelledOrderDetail needs the cancellation marker as an element", () => {
	assert.equal(
		isCancelledOrderDetail('<div data-component="cancelled">x</div>'),
		true,
	);
	assert.equal(
		isCancelledOrderDetail(
			'<div id="line-items"></div><script>"data-component=\\"cancelled\\""</script>',
		),
		false,
	);
});

test("an empty item container is not an item row", () => {
	for (const html of [
		'<div data-component="purchasedItemsRightGrid"></div>',
		'<div id="line-items"><div id="x-item-grid-row"></div></div>',
	]) {
		assert.deepEqual(parseOrderDetailDom(html).items, [], html);
	}
});

test("parseOrderSearchPageDom records the distinct product ASINs each order's search rows link", () => {
	const row = (asin: string) =>
		`<div class="a-fixed-left-grid"><a title="View order details" href="/your-orders/order-details?orderID=111-1111111-1111111">details</a><a href="/dp/${asin}">item</a></div>`;
	const { stubs } = parseOrderSearchPageDom(
		`<html><body>${row("B012345678")}${row("B087654321")}${row("B012345678")}</body></html>`,
	);
	assert.equal(stubs[0]?.expectedItemCount, 3);
	assert.deepEqual(stubs[0]?.searchProductIds, ["B012345678", "B087654321"]);
});

test("a hidden empty-orders element is not an empty state", () => {
	assert.equal(
		hasOrderSearchEmptyState('<div class="no-orders" hidden>No orders</div>'),
		false,
	);
	assert.equal(
		hasOrderSearchEmptyState('<div class="no-orders">No orders</div>'),
		true,
	);
});

// ─── Nutrition: identity binding, units and basis ─────────────────────────

const LD_NUTRITION_95 =
	'"nutrition":{"@type":"NutritionInformation","calories":"95"}';

function ld(json: string): string {
	return `<html><head><script type="application/ld+json">${json}</script></head><body></body></html>`;
}

const ldWithHeading = (json: string, heading: string) =>
	`<html><head><script type="application/ld+json">${json}</script></head><body><h1>${heading}</h1></body></html>`;

test("JSON-LD nutrition belongs to the Product node that holds it, not to the first named node", () => {
	const facts = parseWholeFoodsProductPageDom(
		ldWithHeading(
			`[{"@type":"Product","name":"Apples","gtin12":"111111111111"},{"@type":"Product","name":"Pears",${LD_NUTRITION_95}}]`,
			"Pears",
		),
	);
	assert.equal(facts?.calories, 95);
	assert.equal(facts?.productName, "Pears");
	assert.equal(facts?.upc, null);
});

test("several Product nodes with no tie to the page have no main subject", () => {
	assert.equal(
		parseWholeFoodsProductPageDom(
			ld(
				`[{"@type":"Product","name":"Apples","gtin12":"111111111111"},{"@type":"Product","name":"Pears",${LD_NUTRITION_95}}]`,
			),
		),
		null,
	);
});

test("JSON-LD @graph keeps nutrition, name and gtin from one Product node", () => {
	const facts = parseWholeFoodsProductPageDom(
		ldWithHeading(
			`{"@graph":[{"@type":"Product","name":"Apples","gtin12":"111111111111"},{"@type":"Product","name":"Pears","gtin13":"2222222222222",${LD_NUTRITION_95}}]}`,
			"Pears",
		),
	);
	assert.equal(facts?.productName, "Pears");
	assert.equal(facts?.upc, "2222222222222");
});

test("a Product without a GTIN has a null UPC, never the string 'undefined'", () => {
	const facts = parseWholeFoodsProductPageDom(
		ld(`{"@type":"Product","name":"Apples",${LD_NUTRITION_95}}`),
	);
	assert.equal(facts?.upc, null);
});

test("GTINs are validated and normalized to digits", () => {
	const upcOf = (gtin: string) =>
		parseWholeFoodsProductPageDom(
			ld(
				`{"@type":"Product","name":"Apples","gtin12":"${gtin}",${LD_NUTRITION_95}}`,
			),
		)?.upc;
	assert.equal(upcOf("0-12345-67890-5"), "012345678905");
	assert.equal(upcOf("not-a-code"), null);
	assert.equal(upcOf("12345"), null);
});

test("structured nutrition units are normalized to the field's unit", () => {
	const facts = parseWholeFoodsProductPageDom(
		ld(
			'{"@type":"Product","name":"Apples","nutrition":{"@type":"NutritionInformation","calories":"95 kcal","sodiumContent":"0.5 g","fatContent":"500 mg","vitaminDContent":"5 µg","potassiumContent":"0.1 g","proteinContent":"2"}}',
		),
	);
	assert.equal(facts?.calories, 95);
	assert.equal(facts?.sodiumMg, 500);
	assert.equal(facts?.fatG, 0.5);
	assert.equal(facts?.vitaminDMcg, 5);
	assert.equal(facts?.potassiumMg, 100);
	assert.equal(facts?.proteinG, 2);
});

test("structured nutrition with an unsupported unit is withheld, not relabelled", () => {
	const facts = parseWholeFoodsProductPageDom(
		ld(
			'{"@type":"Product","name":"Apples","nutrition":{"@type":"NutritionInformation","calories":"398 kJ","sodiumContent":"3 oz","fatContent":"2 g"}}',
		),
	);
	assert.equal(facts?.calories, null);
	assert.equal(facts?.sodiumMg, null);
	assert.equal(facts?.fatG, 2);
});

test("text-panel units are normalized to the field's unit", () => {
	const facts = parseWholeFoodsProductPageDom(`<html><body><div>
      <h3>Nutrition Facts</h3>
      <div>Serving size 1 cup
      Calories 105
      Total Fat 500 mg
      Sodium 0.5 g
      Protein 1.3g
      </div></div></body></html>`);
	assert.equal(facts?.fatG, 0.5);
	assert.equal(facts?.sodiumMg, 500);
	assert.equal(facts?.proteinG, 1.3);
});

test("Amazon panel units are normalized and a non-GTIN id is not a UPC", () => {
	const facts = parseAmazonProductNutritionDom(`<html><body>
		<div id="detailBullets_feature_div"><li>ASIN: 0123456789</li></div>
		<div id="nic-nutrition-facts">Nutrition Facts Calories 150 Sodium 0.5 g Total Fat 5g</div>
	</body></html>`);
	assert.equal(facts?.sodiumMg, 500);
	assert.equal(facts?.upc, null);
});

// ─── Round 2: panel rows, stated core rows ────────────────────────────────

// Amazon renders the panel with no separators ("Total Fat12g20%Sodium480mg…").
// Legacy keeps Calories outside #nic-nutrition-facts, in the enclosing
// expander, and reads the panel from that wider scope.
const RUN_TOGETHER_ROWS =
	"10%Total Fat8g25%Saturated Fat5gTrans Fat0gCholesterol5mg2%Sodium160mg7%Total Carbohydrate37g13%Dietary Fiber4g14%Sugars11gProtein3gVitamin D2mcg10%";

test("Amazon run-together panel: every row keeps its whole value", () => {
	const facts = parseAmazonProductNutritionDom(
		`<html><body><div id="nic-nutrition-facts">Calories250% Daily Value*15%Total Fat12g20%Sodium480mg21%Total Carbohydrate31g11%Sugars14gProtein22gVitamin D2mcg10%</div></body></html>`,
	);
	assert.equal(facts?.calories, 250);
	assert.equal(facts?.fatG, 12);
	assert.equal(facts?.sodiumMg, 480);
	assert.equal(facts?.carbsG, 31);
	assert.equal(facts?.sugarG, 14);
	assert.equal(facts?.proteinG, 22);
	assert.equal(facts?.vitaminDMcg, 2);
});

test("Amazon run-together panel: a row before the next label is not truncated", () => {
	const facts = parseAmazonProductNutritionDom(
		`<html><body><div class="a-expander-content">Calories150% Daily Value*<div id="nic-nutrition-facts">${RUN_TOGETHER_ROWS}</div></div></body></html>`,
	);
	assert.equal(facts?.saturatedFatG, 5);
	assert.equal(facts?.transFatG, 0);
	assert.equal(facts?.cholesterolMg, 5);
	assert.equal(facts?.fiberG, 4);
	assert.equal(facts?.proteinG, 3);
});

test("Amazon panel: Calories outside #nic-nutrition-facts are read from the enclosing expander", () => {
	const facts = parseAmazonProductNutritionDom(
		`<html><body><div class="a-expander-content">Serving size 1 cup (240g) Calories150% Daily Value*<div id="nic-nutrition-facts">${RUN_TOGETHER_ROWS}</div></div></body></html>`,
	);
	assert.equal(facts?.calories, 150);
	assert.equal(facts?.fatG, 8);
	assert.equal(facts?.carbsG, 37);
	assert.deepEqual([...(facts?.coreStated ?? [])].sort(), [
		"calories",
		"carbs",
		"fat",
		"protein",
	]);
});

test("rendered Whole Foods run-together panel keeps every row's whole value", () => {
	const facts = parseWholeFoodsProductPageDom(
		`<html><body><div><h3>Nutrition Facts</h3><div>Calories250% Daily Value*15%Total Fat12g20%Sodium480mg21%Total Carbohydrate31g11%Sugars14gProtein22gVitamin D2mcg10%</div></div></body></html>`,
	);
	assert.equal(facts?.proteinG, 22);
	assert.equal(facts?.sugarG, 14);
	assert.equal(facts?.fatG, 12);
});

test("a '<1g' row is stated with no amount, so a core row is not lost and not invented", () => {
	const amazon = parseAmazonProductNutritionDom(
		`<html><body><div id="nic-nutrition-facts">Calories 15 Total Fat 0g Sodium 140mg Total Carbohydrate 3g Sugars 2g Protein <1g</div></body></html>`,
	);
	assert.equal(amazon?.proteinG, null);
	assert.ok(amazon?.coreStated.includes("protein"));
	const structured = parseWholeFoodsProductPageDom(
		ld(
			'{"@type":"Product","name":"Apples","nutrition":{"@type":"NutritionInformation","calories":"95 calories","fatContent":"<1 g","carbohydrateContent":"25 g","proteinContent":"0.5 g"}}',
		),
	);
	assert.equal(structured?.fatG, null);
	assert.ok(structured?.coreStated.includes("fat"));
});

test("a core row that was never stated is not counted as stated", () => {
	const facts = parseAmazonProductNutritionDom(
		`<html><body><div id="nic-nutrition-facts">Calories 15 Total Fat 0g Total Carbohydrate 3g</div></body></html>`,
	);
	assert.ok(!facts?.coreStated.includes("protein"));
});

test("panel percentages and IU are not read as mass amounts", () => {
	const percent = parseAmazonProductNutritionDom(
		`<html><body><div id="nic-nutrition-facts">Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3g Calcium 20% Iron 6% Vitamin D 10%</div></body></html>`,
	);
	assert.equal(percent?.calciumMg, null);
	assert.equal(percent?.ironMg, null);
	assert.equal(percent?.vitaminDMcg, null);
	const iu = parseAmazonProductNutritionDom(
		`<html><body><div id="nic-nutrition-facts">Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3g Vitamin D 100 IU</div></body></html>`,
	);
	assert.equal(iu?.vitaminDMcg, 2.5);
});

// ─── Round 3: units, labels, scope and numbers ────────────────────────────

const panelOf = (rows: string) =>
	`<html><body><div id="nic-nutrition-facts">${rows}</div></body></html>`;

test("a row marker or punctuation after the unit does not un-state the row", () => {
	for (const fat of ["2g*", "2g†", "2g,", "2 g."]) {
		const facts = parseAmazonProductNutritionDom(
			panelOf(
				`Calories 100 Total Fat ${fat} Total Carbohydrate 10g Protein 3g`,
			),
		);
		assert.equal(facts?.fatG, 2, fat);
		assert.ok(facts?.coreStated.includes("fat"), fat);
	}
});

test("a label inside a longer word is not a row", () => {
	const facts = parseAmazonProductNutritionDom(
		panelOf(
			"Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3g Environ 5mg",
		),
	);
	assert.equal(facts?.ironMg, null);
	const glued = parseAmazonProductNutritionDom(
		panelOf(
			"Calories100% Daily Value*Total Fat2gTotal Carbohydrate10gProtein3gIron5mg",
		),
	);
	assert.equal(glued?.ironMg, 5);
	assert.equal(glued?.proteinG, 3);
});

test("ingredient text in the panel's container never supplies a row", () => {
	const inline = parseAmazonProductNutritionDom(
		`<html><body><div class="a-expander-content"><div id="nic-nutrition-facts">Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3g</div>Ingredients: water, salt, sodium 5mg</div></body></html>`,
	);
	assert.equal(inline?.sodiumMg, null);
	const section = parseAmazonProductNutritionDom(
		`<html><body><div class="a-expander-content"><div id="nic-nutrition-facts">Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3g</div><div id="ingredients_feature_div">Ingredients: sodium 5mg</div></div></body></html>`,
	);
	assert.equal(section?.sodiumMg, null);
});

test("a number with a thousands separator is read whole; an unclean number is not stated", () => {
	const calories = parseAmazonProductNutritionDom(
		panelOf(
			"Calories 1,200 Total Fat 2g Total Carbohydrate 10g Protein 3g Sodium 1,200mg",
		),
	);
	assert.equal(calories?.calories, 1200);
	assert.equal(calories?.sodiumMg, 1200);
	const unclean = parseAmazonProductNutritionDom(
		panelOf("Calories 100 Total Fat 12,5g Total Carbohydrate 10g Protein 3g"),
	);
	assert.equal(unclean?.fatG, null);
	assert.ok(!unclean?.coreStated.includes("fat"));
});

test("a glued unit followed by prose is still the unit", () => {
	const facts = parseAmazonProductNutritionDom(
		panelOf(
			"Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3gIngredients",
		),
	);
	assert.equal(facts?.proteinG, 3);
});

// ─── Round 4: panel ends and glued labels ─────────────────────────────────

test("the footnotes under a panel never supply rows", () => {
	const perGram = parseAmazonProductNutritionDom(
		panelOf(
			"Calories 100 Total Fat 2g Total Carbohydrate 10g Sodium 5mg *Percent Daily Values are based on a 2,000 calorie diet. Calories per gram: Fat 9 Carbohydrate 4 Protein 4",
		),
	);
	assert.equal(perGram?.proteinG, null);
	assert.ok(!perGram?.coreStated.includes("protein"));
	const allowance = parseAmazonProductNutritionDom(
		panelOf(
			"Total Fat 2g Total Carbohydrate 10g Protein 3g *Percent Daily Values Calories: 2,000 2,500",
		),
	);
	assert.ok(allowance === null || allowance.calories === null);
});

test("an Ingredients heading without a colon ends the panel", () => {
	const facts = parseAmazonProductNutritionDom(
		panelOf(
			"Calories 100 Total Fat 2g Total Carbohydrate 10g IngredientsWater, whey protein 20g",
		),
	);
	assert.equal(facts?.proteinG, null);
	assert.ok(!facts?.coreStated.includes("protein"));
});

test("an Ingredients line before the panel neither cuts the panel nor supplies rows", () => {
	const facts = parseAmazonProductNutritionDom(
		`<html><body><div class="a-expander-content">Ingredients: whey protein 20g, sodium 5mg<div id="nic-nutrition-facts">Calories 100 Total Fat 2g Total Carbohydrate 10g Protein 3g</div></div></body></html>`,
	);
	assert.equal(facts?.calories, 100);
	assert.equal(facts?.proteinG, 3);
	assert.equal(facts?.sodiumMg, null);
});

test("the Whole Foods panel ends at its footnotes and starts at its heading", () => {
	const facts = parseWholeFoodsProductPageDom(
		`<html><body><div>Ingredients: whey protein 20g<h3>Nutrition Facts</h3><div>Calories 100 Total Fat 2g Total Carbohydrate 10g *Percent Daily Values Calories per gram: Fat 9 Carbohydrate 4 Protein 4</div></div></body></html>`,
	);
	assert.equal(facts?.proteinG, null);
	assert.ok(!facts?.coreStated.includes("protein"));
});

test("plural and glued labels still state their rows", () => {
	const plural = parseAmazonProductNutritionDom(
		panelOf("Calories 100 Total Fat 2g Total Carbohydrates 10g Protein 3g"),
	);
	assert.equal(plural?.carbsG, 10);
	const afterKcal = parseAmazonProductNutritionDom(
		panelOf("150kcalTotal Fat3gTotal Carbohydrate10gProtein5g Calories 150"),
	);
	assert.equal(afterKcal?.fatG, 3);
	const afterIu = parseAmazonProductNutritionDom(
		panelOf(
			"Calories 100 Total Fat 2g Total Carbohydrate 10g Vitamin D80IUProtein5g",
		),
	);
	assert.equal(afterIu?.vitaminDMcg, 2);
	assert.equal(afterIu?.proteinG, 5);
});

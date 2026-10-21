// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parsers return observations that carry ALL the identity evidence on a page
 * and choose nothing; binding.ts decides. The order-detail fixtures are the
 * repo's captured-shape pages (`order-detail-instore-fopo.html` has a rendered
 * header id, the `uff` page carries none). The Amazon and Whole Foods product
 * pages here are synthetic: no scrubbed real capture of either exists.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { bindOrder, bindProduct, mainSubject } from "./binding.ts";
import {
	readAmazonProductPage,
	readOrderObservation,
	readWholeFoodsProductPage,
} from "./parsers.ts";

const fixture = (name: string) =>
	readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const FOPO = fixture("order-detail-instore-fopo.html");
const UFF = fixture("order-detail-uff.html");
const FOPO_ID = "000-0000000-0000000";

test("the fopo fixture's rendered header id is read, and binds by content_id", () => {
	const url = `https://www.amazon.com/fopo/order-details?orderID=${FOPO_ID}`;
	const obs = readOrderObservation(url, FOPO);
	assert.deepEqual(obs.headerIds, [FOPO_ID]);
	assert.deepEqual(bindOrder({ orderId: FOPO_ID }, obs), {
		kind: "BOUND",
		via: "content_id",
	});
	assert.deepEqual(
		bindOrder({ orderId: "111-1111111-1111111" }, obs),
		{ kind: "UNKNOWN", cause: "order_id_mismatch" },
	);
});

test("the uff fixture has no header id, so it binds by url only", () => {
	const obs = readOrderObservation(
		"https://www.amazon.com/uff/your-account/order-details?orderID=111-1111111-1111111",
		UFF,
	);
	assert.deepEqual(obs.headerIds, []);
	assert.deepEqual(bindOrder({ orderId: "111-1111111-1111111" }, obs), {
		kind: "BOUND",
		via: "url",
	});
});

test("order-shaped text in scripts, links and return URLs is not read as a header id", () => {
	const html = `<script>var u="/o?orderID=222-2222222-2222222"</script><a href="/o?orderID=333-3333333-3333333">other</a><p>111-1111111-1111111</p>`;
	assert.deepEqual(readOrderObservation("https://www.amazon.com/o", html).headerIds, []);
});

test("a rendered order-id header element is read", () => {
	const html = `<span data-component="orderId">Order # 111-1111111-1111111</span>`;
	assert.deepEqual(readOrderObservation("https://www.amazon.com/o", html).headerIds, [
		"111-1111111-1111111",
	]);
});

test("an Amazon page reports every authoritative ASIN position, and chooses nothing", () => {
	const read = readAmazonProductPage(
		`<html><head><link rel="canonical" href="https://www.amazon.com/Some-Name/dp/B012345678"></head><body><input id="ASIN" value="B012345678"><div id="dp" data-asin="B012345678"><span id="productTitle">x</span></div><a href="/dp/B099999999">also bought</a></body></html>`,
		"https://www.amazon.com/dp/B012345678",
	);
	assert.deepEqual(read.observation, {
		finalUrl: "https://www.amazon.com/dp/B012345678",
		canonical: "https://www.amazon.com/Some-Name/dp/B012345678",
		input: "B012345678",
		dataAsin: "B012345678",
		gtin: null,
		panel: null,
		details: null,
	});
	assert.equal(read.hasProductTitle, true);
});

test("a Whole Foods page reports every Product node, the canonical URL, the h1 and the panel", () => {
	const obs = readWholeFoodsProductPage(`<html><head>
		<link rel="canonical" href="https://www.wholefoodsmarket.com/product/organic-pears">
		<script type="application/ld+json">[{"@type":"Product","name":"Organic Apples","gtin12":"012345678905","url":"https://www.wholefoodsmarket.com/product/organic-apples"},{"@type":"Product","name":"Organic Pears"}]</script>
		</head><body><h1>Organic Pears</h1><div><h3>Nutrition Facts</h3><div>Calories 95 Total Fat 0g Total Carbohydrate 25g Protein 1g</div></div></body></html>`);
	assert.equal(obs.canonicalUrl, "https://www.wholefoodsmarket.com/product/organic-pears");
	assert.equal(obs.h1, "Organic Pears");
	assert.deepEqual(
		obs.products.map((node) => node.name),
		["Organic Apples", "Organic Pears"],
	);
	assert.deepEqual(
		obs.panels.map((panel) => [panel.scope, panel.facts.calories]),
		[["main_heading", 95]],
	);
	// Choosing is binding.ts's job: the h1 ties to the Pears node, so the
	// Apples recommendation lends nothing, and the panel is the h1 subject's.
	const subject = mainSubject(obs);
	assert.equal(subject.kind === "SUBJECT" && subject.identity.name, "Organic Pears");
	assert.equal(subject.kind === "SUBJECT" && subject.identity.gtin, null);
	assert.equal(
		bindProduct(
			{ asin: "B012345678", name: "Organic Pears", boundGtin: null, boundGtinVia: null },
			{ source: "wholefoods", obs, finalUrl: "https://www.wholefoodsmarket.com/product/organic-pears" },
		).kind,
		"BOUND",
	);
});

test("the convenience parser for tests is not reachable from production code", () => {
	for (const file of ["index.ts", "parsers.ts", "binding.ts"]) {
		const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
		assert.equal(/parseWholeFoodsProductPageDom/.test(source), false, file);
	}
});

test("a Whole Foods page reports every rendered panel with its scope, partial ones included", () => {
	const scopes = (body: string) =>
		readWholeFoodsProductPage(`<html><body>${body}</body></html>`).panels.map(
			(panel) => [panel.scope, panel.facts.coreStated.join(",")],
		);
	const full = "<p>Calories 52 Total Fat 0.2g Total Carbohydrate 14g Protein 0.3g</p>";
	// The main panel and a recommendation card's panel are both observed, each
	// with its own scope, whichever comes first.
	assert.deepEqual(
		scopes(`<aside><div><h2>Recommended Pears</h2><h3>Nutrition Facts</h3>${full}</div></aside><h1>Apples</h1><div><h3>Nutrition Facts</h3>${full}</div>`),
		[
			["other_heading", "calories,carbs,fat,protein"],
			["main_heading", "calories,carbs,fat,protein"],
		],
	);
	// A section heading and a heading inside the panel are not products.
	assert.deepEqual(
		scopes(`<h1>Apples</h1><section><h2>Nutrition</h2><div><h3>Nutrition Facts</h3><h4>Serving size 1 apple</h4>${full}</div></section>`),
		[["main_heading", "calories,carbs,fat,protein"]],
	);
	// A panel with no calories row is kept as the rows it states.
	assert.deepEqual(
		scopes("<h1>Apples</h1><div><h3>Nutrition Facts</h3><p>Total Fat 1g Protein 1g</p></div>"),
		[["main_heading", "fat,protein"]],
	);
	// No product heading anywhere.
	assert.deepEqual(scopes(`<div><h3>Nutrition Facts</h3>${full}</div>`), [
		["no_heading", "calories,carbs,fat,protein"],
	]);
	// A heading with no row is not a panel.
	assert.deepEqual(scopes("<h1>Apples</h1><div><h3>Nutrition Facts</h3><p>Serving size 1 apple</p></div>"), []);
});

test("an Amazon page reports its barcode and a calorie-less panel separately", () => {
	const read = readAmazonProductPage(
		'<html><body><span id="productTitle">x</span><div id="detailBullets_feature_div"><li>UPC: 012345678905</li></div><div id="nic-nutrition-facts">Total Fat 1g Total Carbohydrate 3g Protein 1g</div></body></html>',
		"https://www.amazon.com/dp/B012345678",
	);
	assert.equal(read.observation.gtin, "012345678905");
	assert.deepEqual(read.observation.panel?.coreStated, ["carbs", "fat", "protein"]);
	assert.equal(read.observation.panel?.calories, null);
});

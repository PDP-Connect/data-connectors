// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The identity owner's decision tables, one test per row. Observations here are
 * built by hand (synthetic): the repo holds no scrubbed real capture of an
 * Amazon /dp page, a Whole Foods product page or a cancelled order detail.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type AmazonProductObservation,
	bindGtin,
	bindOrder,
	bindProduct,
	capConfidence,
	gtin14,
	gtinQueryForms,
	mainSubject,
	normalizeGtin,
	normalizeName,
	type ProductNode,
	sameGtin,
	type WholeFoodsProductObservation,
} from "./binding.ts";

const ASIN = "B012345678";
const OTHER_ASIN = "B087654321";
const request = (
	overrides: Partial<{
		name: string;
		boundGtin: string | null;
		boundGtinVia: "content_id" | "url" | "name" | null;
	}> = {},
) => ({
	asin: ASIN,
	name: "Organic Apples",
	boundGtin: null,
	boundGtinVia: null,
	...overrides,
});

// ─── Amazon ───────────────────────────────────────────────────────────────

const amazon = (obs: Partial<AmazonProductObservation> = {}) => ({
	source: "amazon" as const,
	obs: {
		finalUrl: `https://www.amazon.com/dp/${ASIN}`,
		canonical: null,
		input: null,
		dataAsin: null,
		...obs,
	},
});

test("amazon row 1: a final URL off amazon.com is untrusted", () => {
	for (const finalUrl of [
		`https://evil.example/dp/${ASIN}`,
		`https://amazon.com.evil.example/dp/${ASIN}`,
		`http://www.amazon.com/dp/${ASIN}`,
		"not a url",
	]) {
		assert.deepEqual(bindProduct(request(), amazon({ finalUrl })), {
			kind: "UNKNOWN",
			cause: "untrusted_origin",
		});
	}
});

test("amazon row 2: authoritative ASIN positions that disagree", () => {
	assert.deepEqual(
		bindProduct(request(), amazon({ input: OTHER_ASIN })),
		{ kind: "UNKNOWN", cause: "asin_sources_disagree" },
	);
	assert.deepEqual(
		bindProduct(
			request(),
			amazon({ canonical: `https://www.amazon.com/x/dp/${OTHER_ASIN}` }),
		),
		{ kind: "UNKNOWN", cause: "asin_sources_disagree" },
	);
});

test("amazon row 3: every position names another ASIN", () => {
	assert.deepEqual(
		bindProduct(
			request(),
			amazon({ finalUrl: `https://www.amazon.com/dp/${OTHER_ASIN}` }),
		),
		{ kind: "UNKNOWN", cause: "asin_mismatch" },
	);
	assert.deepEqual(
		bindProduct(
			request(),
			amazon({
				finalUrl: `https://www.amazon.com/dp/${OTHER_ASIN}`,
				canonical: `https://www.amazon.com/dp/${OTHER_ASIN}`,
				input: OTHER_ASIN,
			}),
		),
		{ kind: "UNKNOWN", cause: "asin_mismatch" },
	);
});

test("amazon row 4: a content-side ASIN equal to the request binds by content_id", () => {
	for (const position of [
		{ canonical: `https://www.amazon.com/Name/dp/${ASIN}` },
		{ input: ASIN },
		{ dataAsin: ASIN },
	]) {
		assert.deepEqual(bindProduct(request(), amazon(position)), {
			kind: "BOUND",
			via: "content_id",
		});
	}
});

test("amazon row 5: no content-side ASIN, the URL ASIN binds by url", () => {
	assert.deepEqual(bindProduct(request(), amazon()), { kind: "BOUND", via: "url" });
});

test("amazon row 6: no ASIN position at all", () => {
	assert.deepEqual(
		bindProduct(request(), amazon({ finalUrl: "https://www.amazon.com/errors/validate" })),
		{ kind: "UNKNOWN", cause: "no_identity_evidence" },
	);
});

// ─── Whole Foods ──────────────────────────────────────────────────────────

const node = (overrides: Partial<ProductNode> = {}): ProductNode => ({
	name: "Organic Apples",
	urls: [],
	gtin: null,
	facts: null,
	...overrides,
});
const wf = (
	obs: Partial<WholeFoodsProductObservation> = {},
	finalUrl = "https://www.wholefoodsmarket.com/product/organic-apples",
) => ({
	source: "wholefoods" as const,
	finalUrl,
	obs: { canonicalUrl: null, h1: null, products: [], panel: null, ...obs },
});

test("wholefoods row 1: a final URL off wholefoodsmarket.com is untrusted", () => {
	assert.deepEqual(
		bindProduct(
			request(),
			wf({ h1: "Organic Apples" }, "https://example.com/product/organic-apples"),
		),
		{ kind: "UNKNOWN", cause: "untrusted_origin" },
	);
});

test("wholefoods row 2: several Product nodes and no tie to the page are ambiguous", () => {
	assert.deepEqual(
		bindProduct(
			request(),
			wf({ products: [node(), node({ name: "Organic Pears" })] }),
		),
		{ kind: "UNKNOWN", cause: "ambiguous_main_product" },
	);
});

test("wholefoods row 3: a recommendation node under another product's h1 is OTHER", () => {
	assert.deepEqual(
		bindProduct(
			request(),
			wf({ h1: "Pears", products: [node({ name: "Apples", gtin: "012345678905" })] }),
		),
		{ kind: "OTHER" },
	);
});

test("wholefoods rows 4 and 5: GTINs decide, and a conflict beats an equal name", () => {
	const page = (gtin: string) =>
		wf({ h1: "Organic Apples", products: [node({ gtin })] });
	assert.deepEqual(
		bindProduct(request({ boundGtin: "012345678905" }), page("012345678905")),
		{ kind: "BOUND", via: "gtin" },
	);
	assert.deepEqual(
		bindProduct(request({ boundGtin: "012345678905" }), page("0012345678905")),
		{ kind: "BOUND", via: "gtin" },
	);
	assert.deepEqual(
		bindProduct(request({ boundGtin: "012345678905" }), page("036000291452")),
		{ kind: "OTHER" },
	);
});

test("wholefoods row 6: equal base names bind by name, with at most one GTIN", () => {
	assert.deepEqual(
		bindProduct(request(), wf({ h1: "Organic Apples", products: [node()] })),
		{ kind: "BOUND", via: "name" },
	);
	assert.deepEqual(
		bindProduct(
			request(),
			wf({ h1: "Organic Apples", products: [node({ gtin: "012345678905" })] }),
		),
		{ kind: "BOUND", via: "name" },
	);
	assert.deepEqual(
		bindProduct(request({ name: "Whole Foods Market, Organic Hass Avocado, 1 Each" }),
			wf({ h1: "Organic Hass Avocado" })),
		{ kind: "BOUND", via: "name" },
	);
});

test("wholefoods row 7: organic and plain, other products, and size mismatches are OTHER", () => {
	assert.deepEqual(
		bindProduct(request({ name: "Organic Milk" }), wf({ h1: "Milk" })),
		{ kind: "OTHER" },
	);
	assert.deepEqual(
		bindProduct(request({ name: "Milk" }), wf({ h1: "Organic Milk" })),
		{ kind: "OTHER" },
	);
	assert.deepEqual(
		bindProduct(request({ name: "Apples, 3 lb" }), wf({ h1: "Apples 5 lb" })),
		{ kind: "OTHER" },
	);
	assert.deepEqual(
		bindProduct(request({ name: "Apples, 16 oz" }), wf({ h1: "Apples 1 lb" })),
		{ kind: "BOUND", via: "name" },
	);
	assert.deepEqual(
		bindProduct(request({ name: "Apples" }), wf({ h1: "Apples 5 lb" })),
		{ kind: "BOUND", via: "name" },
	);
});

test("wholefoods row 8: a page with no name and no id says nothing", () => {
	assert.deepEqual(bindProduct(request(), wf()), {
		kind: "UNKNOWN",
		cause: "no_identity_evidence",
	});
});

test("main subject: url tie, then name tie, then the only node; a node borrows nothing", () => {
	const apples = node({ name: "Apples", urls: ["https://www.wholefoodsmarket.com/product/apples"] });
	const pears = node({ name: "Pears", gtin: "036000291452" });
	const byUrl = mainSubject(
		{ canonicalUrl: "https://www.wholefoodsmarket.com/product/apples", h1: null, products: [pears, apples], panel: null },
	);
	assert.equal(byUrl.kind === "SUBJECT" && byUrl.identity.name, "Apples");
	const byName = mainSubject({ canonicalUrl: null, h1: "Pears", products: [apples, pears], panel: null });
	assert.equal(byName.kind === "SUBJECT" && byName.identity.gtin, "036000291452");
	// The only node is untied when the page shows a different heading: its GTIN
	// is not lent to the page.
	const untied = mainSubject({ canonicalUrl: null, h1: "Pears", products: [node({ name: "Apples", gtin: "012345678905" })], panel: null });
	assert.equal(untied.kind === "SUBJECT" && untied.identity.gtin, null);
	assert.equal(untied.kind === "SUBJECT" && untied.identity.name, "Pears");
});

// ─── Orders ───────────────────────────────────────────────────────────────

const A = "111-1111111-1111111";
const B = "222-2222222-2222222";
const order = (finalUrl: string, headerIds: string[] = []) => ({ finalUrl, headerIds });
const detail = (id: string | null) =>
	`https://www.amazon.com/your-orders/order-details${id ? `?orderID=${id}` : ""}`;

test("order rows 1 to 6", () => {
	assert.deepEqual(bindOrder({ orderId: A }, order(`https://evil.example/o?orderID=${A}`)), { kind: "UNKNOWN", cause: "untrusted_origin" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(A), [B])), { kind: "UNKNOWN", cause: "order_id_sources_disagree" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(B), [B])), { kind: "UNKNOWN", cause: "order_id_mismatch" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(B))), { kind: "UNKNOWN", cause: "order_id_mismatch" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(null), [A])), { kind: "BOUND", via: "content_id" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(A), [A])), { kind: "BOUND", via: "content_id" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(A))), { kind: "BOUND", via: "url" });
	assert.deepEqual(bindOrder({ orderId: A }, order(detail(null))), { kind: "UNKNOWN", cause: "no_identity_evidence" });
});

// ─── GTINs, names, confidence ─────────────────────────────────────────────

test("one GTIN normalizer: valid lengths only, padded to 14 to compare", () => {
	assert.equal(normalizeGtin("0-12345-67890-5"), "012345678905");
	assert.equal(normalizeGtin("12345"), null);
	assert.equal(normalizeGtin("not-a-code"), null);
	assert.equal(gtin14("012345678905"), "00012345678905");
	assert.equal(sameGtin("012345678905", "0012345678905"), true);
	assert.equal(sameGtin("012345678905", "036000291452"), false);
	assert.equal(sameGtin("012345678905", "short"), false);
	assert.deepEqual(gtinQueryForms("012345678905"), [
		"012345678905",
		"00012345678905",
		"0012345678905",
	]);
});

test("one name normalizer: brand prefixes go, organic stays, sizes convert", () => {
	assert.equal(normalizeName("Whole Foods Market, Organic Hass Avocado, 1 Each").base, "organic hass avocado");
	assert.equal(normalizeName("Organic Hass Avocado").base, "organic hass avocado");
	assert.equal(normalizeName("365 by Whole Foods Market Organic Bananas, 1 lb").base, "organic bananas");
	assert.equal(normalizeName("Milk, 1 gal").size?.amount, 3785.41);
	assert.equal(normalizeName("Water 12 fl oz").size?.dimension, "volume");
	assert.equal(normalizeName("Eggs, 12 ct").size?.amount, 12);
	assert.equal(normalizeName("Apples").size, null);
});

test("a weak binding caps confidence at medium", () => {
	assert.equal(capConfidence("high", "name"), "medium");
	assert.equal(capConfidence("high", "url"), "medium");
	assert.equal(capConfidence("high", "gtin"), "high");
	assert.equal(capConfidence("high", "content_id"), "high");
	assert.equal(capConfidence("low", "name"), "low");
});

test("a USDA barcode binds to the request's GTIN only when they are the same product", () => {
	assert.deepEqual(bindGtin("012345678905", "0012345678905"), { kind: "BOUND", via: "gtin" });
	assert.deepEqual(bindGtin("012345678905", "036000291452"), { kind: "OTHER" });
	assert.deepEqual(bindGtin("012345678905", null), { kind: "UNKNOWN", cause: "no_identity_evidence" });
	assert.deepEqual(bindGtin(null, "012345678905"), { kind: "UNKNOWN", cause: "no_identity_evidence" });
});

// ─── Round 7: untied sole nodes, ambiguity under another h1, GTIN strength ─

test("the relaxed tie releases a sole node's own facts only; a rendered panel needs a tied node", () => {
	const panel = { calories: 95 } as never;
	const own = { calories: 52 } as never;
	// No title: the sole node's own nutrition is released with its identity.
	const ownFacts = mainSubject({ canonicalUrl: null, h1: null, products: [node({ name: "Apples", gtin: "111111111117", facts: own })], panel });
	assert.equal(ownFacts.kind === "SUBJECT" && ownFacts.facts, own);
	// No title: a rendered panel is not released to an untied sole node, and
	// takes neither its name nor its GTIN.
	const rendered = mainSubject({ canonicalUrl: null, h1: null, products: [node({ name: "Apples", gtin: "111111111117" })], panel });
	assert.equal(rendered.kind === "SUBJECT" && rendered.facts, null);
	assert.equal(rendered.kind === "SUBJECT" && rendered.identity.name, null);
	assert.equal(rendered.kind === "SUBJECT" && rendered.identity.gtin, null);
	assert.deepEqual(
		bindProduct(request({ name: "Apples" }), wf({ panel, products: [node({ name: "Apples", gtin: "111111111117" })] })),
		{ kind: "UNKNOWN", cause: "no_identity_evidence" },
	);
});

test("a title that is not the request settles it as OTHER before any ambiguity", () => {
	assert.deepEqual(
		bindProduct(
			request({ name: "Apples" }),
			wf({ h1: "Pears", products: [node({ name: "365 Pear Halves" }), node({ name: "Kiwi" })] }),
		),
		{ kind: "OTHER" },
	);
	// Ambiguity still matters when the title could be the request.
	assert.deepEqual(
		bindProduct(
			request({ name: "Apples" }),
			wf({ h1: "Apples", products: [node({ name: "Pears" }), node({ name: "Kiwi" })] }),
		),
		{ kind: "UNKNOWN", cause: "ambiguous_main_product" },
	);
});

test("a GTIN binding is only as strong as the binding that supplied the GTIN", () => {
	const page = wf({ h1: "Organic Apples", products: [node({ gtin: "012345678905" })] });
	const asked = (boundGtinVia: "content_id" | "url" | "name" | null) =>
		bindProduct(request({ boundGtin: "012345678905", boundGtinVia }), page);
	assert.deepEqual(asked("content_id"), { kind: "BOUND", via: "gtin" });
	assert.deepEqual(asked("url"), { kind: "BOUND", via: "url" });
	assert.deepEqual(asked("name"), { kind: "BOUND", via: "name" });
});

test("the name normalizer reads FZ and dozen, and ignores apostrophes", () => {
	assert.equal(normalizeName("Organic Whole Milk, 64 FZ").size?.dimension, "volume");
	assert.equal(normalizeName("Organic Whole Milk, 64 FZ").size?.amount, normalizeName("Organic Whole Milk, 64 fl oz").size?.amount);
	assert.equal(normalizeName("Large Brown Eggs, 1 Dozen").size?.amount, 12);
	assert.equal(normalizeName("Siggi's Skyr").base, normalizeName("Siggis Skyr").base);
	// None of this loosens a match: different words still differ.
	assert.notEqual(normalizeName("Siggi's Skyr").base, normalizeName("Skyr").base);
});

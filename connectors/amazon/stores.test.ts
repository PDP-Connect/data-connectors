// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Amazon stores: which store a run reads, the URLs it builds there, and the
// store-specific parsing (postal codes, dates, money) that comes with it.

import assert from "node:assert/strict";
import { test } from "node:test";
import { amazonNoOrdersOnStoreMessage, noOrdersOnStore } from "./index.ts";
import {
	buildOrderRecord,
	parseAmazonProfileDom,
	parseCurrencyCents,
	parseOrderDate,
	parseOrderDetailDom,
	parseOrdersListDom,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import {
	AMAZON_STORES,
	absoluteStoreUrl,
	DEFAULT_AMAZON_STORE,
	extractPostalCode,
	matchPostalCode,
	orderDetailUrl,
	ordersListUrl,
	ordersUrl,
	resolveAmazonStore,
	signedInStores,
	signInUrl,
	storeById,
	storeForCountry,
	storeForHost,
	storeForUrl,
} from "./stores.ts";

// biome-ignore lint/style/noNonNullAssertion: the store table is a literal.
const store = (id: string) => storeById(id)!;

test("store table: the common marketplaces, amazon.com first", () => {
	assert.deepEqual(
		AMAZON_STORES.map((s) => s.name),
		[
			"amazon.com",
			"amazon.ca",
			"amazon.co.uk",
			"amazon.de",
			"amazon.fr",
			"amazon.it",
			"amazon.es",
			"amazon.com.au",
			"amazon.co.jp",
			"amazon.in",
			"amazon.com.mx",
			"amazon.com.br",
		],
	);
	assert.equal(DEFAULT_AMAZON_STORE.name, "amazon.com");
	assert.equal(new Set(AMAZON_STORES.map((s) => s.country)).size, 12);
	assert.equal(new Set(AMAZON_STORES.map((s) => s.authCookie)).size, 12);
});

test("store lookup by host, URL, country and id", () => {
	assert.equal(storeForHost("www.amazon.ca")?.id, "ca");
	assert.equal(storeForHost("amazon.ca")?.id, "ca");
	assert.equal(storeForHost(".amazon.co.uk")?.id, "co.uk");
	assert.equal(storeForHost("smile.amazon.com")?.id, "com");
	assert.equal(storeForHost("www.amazon.com.au")?.id, "com.au");
	assert.equal(storeForHost("na.account.amazon.com"), null);
	assert.equal(storeForHost("www.amazon.cn"), null);
	assert.equal(storeForHost("evil-amazon.ca"), null);
	assert.equal(
		storeForUrl("https://www.amazon.ca/your-orders/orders?x=1")?.id,
		"ca",
	);
	assert.equal(storeForUrl("about:blank"), null);
	assert.equal(storeForUrl("not a url"), null);
	assert.equal(storeForCountry("ca")?.id, "ca");
	assert.equal(storeForCountry("GB")?.id, "co.uk");
	assert.equal(storeForCountry("jp")?.id, "co.jp");
	assert.equal(storeForCountry("nl"), null);
	assert.equal(storeById("amazon.de")?.id, "de");
	assert.equal(storeById("co.uk")?.id, "co.uk");
	assert.equal(storeById("https://www.amazon.in/")?.id, "in");
	assert.equal(storeById(""), null);
});

test("URLs are built on the store's own host", () => {
	const ca = store("ca");
	assert.equal(ordersUrl(ca), "https://www.amazon.ca/your-orders/orders");
	assert.equal(
		ordersListUrl(ca, 2024, 10),
		"https://www.amazon.ca/your-orders/orders?timeFilter=year-2024&startIndex=10",
	);
	assert.equal(
		orderDetailUrl(store("co.uk"), "202-1234567-1234567"),
		"https://www.amazon.co.uk/gp/your-account/order-details?orderID=202-1234567-1234567",
	);
	const signin = new URL(signInUrl(store("de")));
	assert.equal(signin.origin, "https://www.amazon.de");
	assert.equal(signin.pathname, "/ap/signin");
	assert.equal(signin.searchParams.get("openid.assoc_handle"), "deflex");
	assert.equal(
		signin.searchParams.get("openid.return_to"),
		"https://www.amazon.de/",
	);
	// amazon.com's sign-in page is the one the connector always used.
	assert.equal(
		signInUrl(DEFAULT_AMAZON_STORE),
		"https://www.amazon.com/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select",
	);
	assert.equal(
		absoluteStoreUrl(ca, "/dp/B000000001"),
		"https://www.amazon.ca/dp/B000000001",
	);
	assert.equal(
		absoluteStoreUrl(ca, "//m.media-amazon.com/x.jpg"),
		"https://m.media-amazon.com/x.jpg",
	);
	assert.equal(absoluteStoreUrl(ca, "https://x.test/a"), "https://x.test/a");
	assert.equal(absoluteStoreUrl(ca, ""), null);
});

test("signed-in stores are read from each store's own token on its own domain", () => {
	assert.deepEqual(
		signedInStores([
			{ domain: ".amazon.ca", name: "at-acbca", value: "x" },
			{ domain: ".amazon.ca", name: "session-id", value: "x" },
			{ domain: ".amazon.com", name: "ubid-main", value: "x" },
		]).map((s) => s.id),
		["ca"],
	);
	// a store's token on another store's domain does not count
	assert.deepEqual(
		signedInStores([{ domain: ".amazon.com", name: "at-acbca", value: "x" }]),
		[],
	);
	assert.deepEqual(
		signedInStores([{ domain: ".amazon.ca", name: "at-acbca", value: "" }]),
		[],
	);
});

test("resolveAmazonStore: request, then page, then the one signed-in store, then amazon.com", () => {
	const cookies = [{ domain: ".amazon.ca", name: "at-acbca", value: "x" }];
	assert.deepEqual(
		resolveAmazonStore({
			cookies,
			pageUrl: "https://www.amazon.ca/your-orders/orders",
			requested: "co.uk",
		}),
		{ store: store("co.uk"), from: "requested" },
	);
	// The hosted service hands over the page of the store it signed in on.
	assert.deepEqual(
		resolveAmazonStore({ pageUrl: "https://www.amazon.ca/your-orders/orders" }),
		{ store: store("ca"), from: "page" },
	);
	assert.deepEqual(resolveAmazonStore({ cookies, pageUrl: "about:blank" }), {
		store: store("ca"),
		from: "cookies",
	});
	// Two signed-in stores and nothing to choose: not guessed.
	assert.deepEqual(
		resolveAmazonStore({
			cookies: [
				...cookies,
				{ domain: ".amazon.com", name: "at-main", value: "x" },
			],
			pageUrl: "about:blank",
		}),
		{ store: DEFAULT_AMAZON_STORE, from: "default" },
	);
	assert.deepEqual(resolveAmazonStore({}), {
		store: DEFAULT_AMAZON_STORE,
		from: "default",
	});
	// A request that names no store is reported, and the next signal decides.
	assert.deepEqual(
		resolveAmazonStore({
			pageUrl: "https://www.amazon.ca/",
			requested: "amazon.zz",
		}),
		{ store: store("ca"), from: "page", unknownRequest: "amazon.zz" },
	);
});

test("postal codes in each store country's shape, normalized", () => {
	assert.equal(
		matchPostalCode("Seattle, WA 98101-1234", store("com")),
		"98101-1234",
	);
	assert.equal(matchPostalCode("Vancouver, BC v6b1a1", store("ca")), "V6B 1A1");
	assert.equal(matchPostalCode("Vancouver V6B 1A1‌", store("ca")), "V6B 1A1");
	assert.equal(matchPostalCode("London SW1A 1AA", store("co.uk")), "SW1A 1AA");
	assert.equal(matchPostalCode("10115 Berlin", store("de")), "10115");
	assert.equal(matchPostalCode("SYDNEY, NSW 2000", store("com.au")), "2000");
	assert.equal(
		matchPostalCode("〒100-0001 東京都", store("co.jp")),
		"100-0001",
	);
	assert.equal(matchPostalCode("Mumbai 400 001", store("in")), "400001");
	assert.equal(
		matchPostalCode("São Paulo 01310-100", store("com.br")),
		"01310-100",
	);
	assert.equal(matchPostalCode("Vancouver", store("ca")), null);
	assert.equal(matchPostalCode("", store("ca")), null);
});

test("an address's postal code is read from its last line upwards, never from the recipient", () => {
	assert.equal(
		extractPostalCode(
			["Ada Lovelace", "12345 Main St", "Seattle, WA 98101", "United States"],
			store("com"),
		),
		"98101",
	);
	assert.equal(
		extractPostalCode(
			["Ada", "100 Queen St W", "Toronto, ON M5H 2N2", "Canada"],
			store("ca"),
		),
		"M5H 2N2",
	);
	assert.equal(extractPostalCode(["98101"], store("com")), null);
	assert.equal(extractPostalCode([], store("com")), null);
});

test("order detail on amazon.ca: shipping postal code and store-relative item URLs", () => {
	const html = `<html><body><div id="orderDetails">
		<div data-component="shippingAddress"><ul>
			<li><span class="a-list-item">Ada Lovelace</span></li>
			<li><span class="a-list-item">100 Queen St W</span></li>
			<li><span class="a-list-item">Toronto, ON M5H 2N2</span></li>
			<li><span class="a-list-item">Canada</span></li>
		</ul></div>
		<div data-component="chargeSummary"><ul><li>Grand Total: $54.21</li></ul></div>
		<div data-component="purchasedItemsRightGrid">
			<div data-component="itemTitle"><a href="/dp/B000000001">Maple syrup</a></div>
			<div data-component="unitPrice">$27.10 $27.10</div>
		</div>
	</div></body></html>`;
	const detail = parseOrderDetailDom(html, store("ca"));
	assert.ok(detail);
	assert.equal(detail.shipping_postal_code, "M5H 2N2");
	assert.equal(detail.recipient_name, "Ada Lovelace");
	assert.equal(detail.grand_total, "$54.21");
	assert.equal(detail.items[0]?.url, "https://www.amazon.ca/dp/B000000001");
	assert.equal(detail.items[0]?.unit_price, "$27.10");
});

test("order detail on amazon.co.uk: pound amounts are kept as written", () => {
	const html = `<html><body><div id="orderDetails">
		<div data-component="shippingAddress"><ul>
			<li><span class="a-list-item">Ada Lovelace</span></li>
			<li><span class="a-list-item">London SW1A 1AA</span></li>
		</ul></div>
		<div data-component="chargeSummary"><ul><li>Grand Total: £12.34</li></ul></div>
		<div data-component="purchasedItemsRightGrid">
			<div data-component="itemTitle"><a href="/dp/B000000002">Tea</a></div>
			<div data-component="unitPrice">£6.17</div>
		</div>
	</div></body></html>`;
	const detail = parseOrderDetailDom(html, store("co.uk"));
	assert.equal(detail?.shipping_postal_code, "SW1A 1AA");
	assert.equal(detail?.grand_total, "£12.34");
	assert.equal(detail?.items[0]?.unit_price, "£6.17");
});

const LIST_CARD = (
	date: string,
	total: string,
	labels = ["Order placed", "Total"],
) => `
	<div class="order-card">
		<ul>
			<li class="order-header__header-list-item"><span class="a-color-secondary a-text-caps">${labels[0]}</span><span>${date}</span></li>
			<li class="order-header__header-list-item"><span class="a-color-secondary a-text-caps">${labels[1]}</span><span>${total}</span></li>
		</ul>
		<div class="yohtmlc-order-id"><span>Order #</span><span>702-1234567-1234567</span></div>
		<div class="item-box"><div class="yohtmlc-product-title"><a href="/dp/B000000003">Hockey tape</a></div></div>
	</div>`;

test("list page on amazon.ca: the order carries its store and store-relative item URLs, and passes the schema", () => {
	const [order] = parseOrdersListDom(
		`<html><body>${LIST_CARD("March 3, 2024", "$15.54")}</body></html>`,
		store("ca"),
	);
	assert.ok(order);
	assert.equal(order.store, "amazon.ca");
	assert.equal(order.orderTotal, "$15.54");
	assert.equal(order.items[0]?.url, "https://www.amazon.ca/dp/B000000003");
	const record = buildOrderRecord(
		order,
		null,
		"2024-03-03",
		"2026-01-01T00:00:00.000Z",
	);
	assert.equal(record.store, "amazon.ca");
	assert.equal(record.shipping_postal_code, null);
	assert.equal(record.order_total_cents, 1554);
	assert.equal(validateRecord("orders", record).ok, true);
});

test("list page on amazon.de: German header labels, euro total, German date", () => {
	const [order] = parseOrdersListDom(
		`<html><body>${LIST_CARD("15. März 2024", "1.234,56 €", ["Bestellung aufgegeben", "Summe"])}</body></html>`,
		store("de"),
	);
	assert.ok(order);
	assert.equal(order.orderDateRaw, "15. März 2024");
	assert.equal(order.orderTotal, "1.234,56 €");
	assert.equal(parseOrderDate(order.orderDateRaw), "2024-03-15");
	const record = buildOrderRecord(
		order,
		null,
		"2024-03-15",
		"2026-01-01T00:00:00.000Z",
	);
	assert.equal(record.order_total_cents, 123_456);
	assert.equal(validateRecord("orders", record).ok, true);
});

test("dates in every store's language", () => {
	const cases: [string, string][] = [
		["March 3, 2024", "2024-03-03"],
		["3 March 2024", "2024-03-03"],
		["15. März 2024", "2024-03-15"],
		["15 mars 2024", "2024-03-15"],
		["1 juin 2023", "2023-06-01"],
		["4 juillet 2023", "2023-07-04"],
		["15 marzo 2024", "2024-03-15"],
		["15 de marzo de 2024", "2024-03-15"],
		["15 de março de 2024", "2024-03-15"],
		["2 de dezembro de 2022", "2022-12-02"],
		["12 août 2021", "2021-08-12"],
		["2024年3月15日", "2024-03-15"],
	];
	for (const [raw, expected] of cases) {
		assert.equal(parseOrderDate(raw), expected, raw);
	}
	assert.equal(parseOrderDate("31 février 2024"), null);
});

test("money in every store's format", () => {
	assert.equal(parseCurrencyCents("£12.34"), 1234);
	assert.equal(parseCurrencyCents("12,34 €"), 1234);
	assert.equal(parseCurrencyCents("1.234,56 €"), 123_456);
	assert.equal(parseCurrencyCents("R$ 1.234,56"), 123_456);
	assert.equal(parseCurrencyCents("CDN$ 12.34"), 1234);
	assert.equal(parseCurrencyCents("₹1,23,456.00"), 12_345_600);
	assert.equal(parseCurrencyCents("￥1,234"), 123_400);
	assert.equal(parseCurrencyCents("-12,34 €"), -1234);
});

test("profile: the default delivery postal code from the nav bar, in the store's shape", () => {
	const html = `<html><body>
		<div id="nav-link-accountList"><span class="nav-line-1">Hello, Ada</span></div>
		<div id="glow-ingress-line1">Deliver to Ada</div>
		<div id="glow-ingress-line2">Vancouver V6B 1A1‌</div>
	</body></html>`;
	const record = parseAmazonProfileDom(html, store("ca"));
	assert.equal(record.postal_code, "V6B 1A1");
	assert.equal(record.store, "amazon.ca");
	assert.equal(validateRecord("profile", record).ok, true);
	// signed out: the nav shows a guessed location, not the account's
	const out = parseAmazonProfileDom(
		html.replace("Hello, Ada", "Hello, sign in"),
		store("ca"),
	);
	assert.equal(out.postal_code, null);
});

test("noOrdersOnStore: only when every listed year was read empty and nothing was ever stored", () => {
	assert.equal(noOrdersOnStore([2026, 2025], 0, {}), true);
	assert.equal(noOrdersOnStore([2026], 3, {}), false);
	assert.equal(noOrdersOnStore([], 0, {}), false);
	assert.equal(
		noOrdersOnStore([2026], 0, {
			"2019": { frozen: true, last_scraped: "2026-01-01", order_count: 4 },
		}),
		false,
	);
	assert.match(
		amazonNoOrdersOnStoreMessage(store("com")),
		/^No orders on amazon\.com for this Amazon account\. .*pick that store/,
	);
});

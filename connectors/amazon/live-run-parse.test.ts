// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Parse fixes from a live amazon.com run for an account that ships to Canada:
// the payment summary read the payment widget's inline script, the shipping and
// nav postal codes were read only in the store country's (US) shape, and Prime
// membership was read from nav elements amazon.com no longer renders.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildOrderRecord,
	parseAmazonProfileDom,
	parseOrderDetailDom,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import { parsePostalCode, storeById } from "./stores.ts";

// biome-ignore lint/style/noNonNullAssertion: the store table is a literal.
const store = (id: string) => storeById(id)!;

const UPX_SCRIPT = `<script>try{window.__UPX_HTML_PARSED_TIME__=performance.now()}catch(e){}!function(){try{var e=document.createElement("meta");e.name="upx";document.head.appendChild(e)}catch(t){}}();</script>`;

function detailHtml(payment: string, address: string[]): string {
	return `<html><body><div id="orderDetails">
		<div data-component="shippingAddress"><ul>
			${address.map((line) => `<li><span class="a-list-item">${line}</span></li>`).join("\n")}
		</ul></div>
		<div data-component="viewPaymentPlanSummaryWidget">${payment}</div>
		<div data-component="chargeSummary"><ul><li>Grand Total: $65.00</li></ul></div>
		<div data-component="purchasedItemsRightGrid">
			<div data-component="itemTitle"><a href="/dp/B000000009">Winter gloves</a></div>
			<div data-component="unitPrice">$65.00</div>
		</div>
	</div></body></html>`;
}

const TORONTO = [
	"Ada Lovelace",
	"100 Queen St W Toronto, Ontario M6J 0B3",
	"Canada",
];

test("payment: a script inside the payment widget is never read as the payment method", () => {
	const html = detailHtml(
		`<div class="a-row"><span>Payment method</span></div>
		<div class="pmts-instrument">${UPX_SCRIPT}
			<img alt="Visa" src="https://example.com/visa.png">
			<span>ending in 4242</span>
		</div>`,
		TORONTO,
	);
	const detail = parseOrderDetailDom(html, store("com"));
	assert.equal(detail?.payment_method_summary, "Visa ending in 4242");
});

test("payment: a widget that holds only a script and a style yields null, not script text", () => {
	const html = detailHtml(
		`${UPX_SCRIPT}<style>.pmts{color:red}</style><noscript>Enable JavaScript</noscript>`,
		TORONTO,
	);
	const detail = parseOrderDetailDom(html, store("com"));
	assert.ok(detail);
	assert.equal(detail.payment_method_summary, null);
});

test("payment: a script next to the payment text is skipped and the text kept", () => {
	const html = detailHtml(
		`Payment method ${UPX_SCRIPT} Mastercard ending in 5100 View related transactions`,
		TORONTO,
	);
	const detail = parseOrderDetailDom(html, store("com"));
	assert.equal(detail?.payment_method_summary, "Mastercard ending in 5100");
});

test("payment: code-like text that reached a text node is rejected", () => {
	const html = detailHtml(
		"try{window.__UPX_HTML_PARSED_TIME__=performance.now()}catch(e){}",
		TORONTO,
	);
	assert.equal(
		parseOrderDetailDom(html, store("com"))?.payment_method_summary,
		null,
	);
});

test("shipping postal code: a Canadian address on an amazon.com order", () => {
	const detail = parseOrderDetailDom(
		detailHtml("Visa ending in 4242", TORONTO),
		store("com"),
	);
	assert.ok(detail);
	assert.equal(detail.shipping_postal_code, "M6J 0B3");
	const record = buildOrderRecord(
		{
			orderId: "111-1234567-1234567",
			orderDateRaw: "February 23, 2023",
			orderTotal: "$65.00",
			deliveryStatus: null,
			items: [],
			store: "amazon.com",
		},
		detail,
		"2023-02-23",
		"2026-11-18T00:00:00.000Z",
	);
	assert.equal(record.shipping_postal_code, "M6J 0B3");
	assert.equal(record.payment_method_summary, "Visa ending in 4242");
	assert.equal(validateRecord("orders", record).ok, true);
});

test("shipping postal code: a Canadian code without its space and with no country line, on amazon.com", () => {
	assert.equal(
		parsePostalCode(
			["Ada", "12345 Yonge St", "Toronto, ON m6j0b3"],
			store("com"),
		),
		"M6J 0B3",
	);
	// street number and code on one line: the code, which comes last, wins
	assert.equal(
		parsePostalCode(
			["Ada", "12345 Yonge St Toronto, ON M6J 0B3"],
			store("com"),
		),
		"M6J 0B3",
	);
});

test("shipping postal code: each supported country's shape, whatever the store", () => {
	const cases: [string, string[], string][] = [
		[
			"us",
			["Ada", "12345 Main St", "Seattle, WA 98101", "United States"],
			"98101",
		],
		[
			"us+4",
			["Ada", "1 Main St", "Seattle, WA 98101-1234", "United States"],
			"98101-1234",
		],
		[
			"ca",
			["Ada", "100 Queen St W", "Toronto, ON M5H 2N2", "Canada"],
			"M5H 2N2",
		],
		[
			"gb",
			["Ada", "10 Downing St", "London SW1A 2AA", "United Kingdom"],
			"SW1A 2AA",
		],
		["au", ["Ada", "1234 George St", "Sydney NSW 2000", "Australia"], "2000"],
		["de", ["Ada", "Hauptstr. 12", "10115 Berlin", "Deutschland"], "10115"],
		["fr", ["Ada", "12 rue de Rivoli", "75001 Paris", "France"], "75001"],
		["it", ["Ada", "Via Roma 1", "00184 Roma RM", "Italia"], "00184"],
		["es", ["Ada", "Calle Mayor 5", "28013 Madrid", "España"], "28013"],
		["jp", ["Ada", "〒100-0001", "東京都千代田区", "日本"], "100-0001"],
		[
			"in",
			["Ada", "12 MG Road", "Bengaluru, Karnataka 560001", "India"],
			"560001",
		],
		[
			"mx",
			["Ada", "Av. Reforma 222", "06600 Ciudad de México, CDMX", "México"],
			"06600",
		],
		[
			"br",
			["Ada", "Av. Paulista 1000", "São Paulo, SP 01310-100", "Brasil"],
			"01310-100",
		],
	];
	for (const storeId of ["com", "ca", "co.uk", "de", "co.jp"]) {
		for (const [label, lines, expected] of cases) {
			assert.equal(
				parsePostalCode(lines, store(storeId)),
				expected,
				`${label} address on amazon.${storeId}`,
			);
		}
	}
});

test("shipping postal code: never a street number, a phone number or the recipient", () => {
	// a phone line below the address is not a Japanese 123-4567 code
	assert.equal(
		parsePostalCode(
			["Ada", "100 Queen St W", "Toronto, ON M5H 2N2", "Phone: 416-555-1234"],
			store("com"),
		),
		"M5H 2N2",
	);
	assert.equal(
		parsePostalCode(["Ada", "Phone: 416-555-1234"], store("com")),
		null,
	);
	assert.equal(parsePostalCode(["98101"], store("com")), null);
	// a German store's address with a bare street number names no country:
	// the store's own 5-digit shape applies, and the city line wins
	assert.equal(
		parsePostalCode(["Ada", "Hauptstr. 12345", "10115 Berlin"], store("de")),
		"10115",
	);
	// "New Mexico" is a US state, not Mexico; "New South Wales" not Wales
	assert.equal(
		parsePostalCode(
			["Ada", "1 Central Ave", "Albuquerque, New Mexico 87102"],
			store("com"),
		),
		"87102",
	);
	assert.equal(
		parsePostalCode(
			["Ada", "1 George St", "Sydney, New South Wales 2000", "Australia"],
			store("com"),
		),
		"2000",
	);
});

const NAV_SIGNED_IN = (deliverTo: [string, string], primeMember: boolean) => `
	<html><head><script>
		window.$Nav && $Nav.declare('config.dynamicMenuArgs',{"rid":"X","isFullWidthPrime":0,"isPrime":${primeMember ? 1 : 0},"dynamicRequest":1});
		window.$Nav && $Nav.declare('config.customerName','Ada');
		window.$Nav && $Nav.declare('config.isPrimeMember',${primeMember});
	</script></head><body>
		<div id="nav-logo"><a id="nav-logo-sprites" aria-label="Amazon"></a></div>
		<div id="nav-global-location-slot"><div id="glow-ingress-block">
			<span class="nav-line-1" id="glow-ingress-line1">${deliverTo[0]}</span>
			<span class="nav-line-2" id="glow-ingress-line2">${deliverTo[1]}</span>
		</div></div>
		<div id="nav-link-accountList"><span class="nav-line-1">Hello, Ada</span></div>
	</body></html>`;

test("profile on amazon.com: Canadian default delivery postal code from the nav", () => {
	const record = parseAmazonProfileDom(
		NAV_SIGNED_IN(["Deliver to Ada", "Toronto M6J 0B3‌"], true),
		store("com"),
	);
	assert.equal(record.postal_code, "M6J 0B3");
	assert.equal(record.store, "amazon.com");
	assert.equal(validateRecord("profile", record).ok, true);
	// the one-line layout: "Delivering to Toronto M6J 0B3" / "Update location"
	assert.equal(
		parseAmazonProfileDom(
			NAV_SIGNED_IN(["Delivering to Toronto M6J 0B3", "Update location"], true),
			store("com"),
		).postal_code,
		"M6J 0B3",
	);
	assert.equal(
		parseAmazonProfileDom(
			NAV_SIGNED_IN(["Deliver to Ada", "Seattle 98101"], true),
			store("com"),
		).postal_code,
		"98101",
	);
});

test("profile on amazon.com: Prime membership from the nav config, true and false", () => {
	const member = parseAmazonProfileDom(
		NAV_SIGNED_IN(["Deliver to Ada", "Toronto M6J 0B3"], true),
		store("com"),
	);
	assert.equal(member.is_prime, true);
	assert.equal(member.name, "Ada");
	const nonMember = parseAmazonProfileDom(
		NAV_SIGNED_IN(["Deliver to Ada", "Toronto M6J 0B3"], false),
		store("com"),
	);
	assert.equal(nonMember.is_prime, false);
	// only the menu args carry it
	const menuOnly = NAV_SIGNED_IN(
		["Deliver to Ada", "Toronto M6J 0B3"],
		true,
	).replace(/.*config\.isPrimeMember.*\n/, "");
	assert.equal(parseAmazonProfileDom(menuOnly, store("com")).is_prime, true);
});

test("profile: a signed-out page's nav config (isPrimeMember false) is not a non-member", () => {
	const html = `<html><head><script>
		window.$Nav && $Nav.declare('config.customerName',false);
		window.$Nav && $Nav.declare('config.isPrimeMember',false);
	</script></head><body>
		<span id="glow-ingress-line1">Deliver to</span><span id="glow-ingress-line2">Canada</span>
		<div id="nav-link-accountList"><span class="nav-line-1">Hello, sign in</span></div>
	</body></html>`;
	const record = parseAmazonProfileDom(html, store("com"));
	assert.equal(record.is_prime, null);
	assert.equal(record.postal_code, null);
	assert.equal(record.name, null);
});

test("shipping postal code: a bare phone number under the address is never a 123-4567 code", () => {
	assert.equal(
		parsePostalCode(
			["Ada", "100 Queen St W", "Toronto, ON M5H 2N2", "416-555-1234"],
			store("com"),
		),
		"M5H 2N2",
	);
	for (const phone of [
		"416-555-1234",
		"(416) 555-1234",
		"+1 416 555 1234",
		"Mobile: 555-1234",
		"03-1234-5678",
		"4165551234",
	]) {
		assert.equal(
			parsePostalCode(["Ada", phone], store("com")),
			null,
			`${phone} on amazon.com`,
		);
	}
	// outside Japan a 123-4567 is a postal code only with its 〒 mark
	assert.equal(parsePostalCode(["Ada", "Tokyo 100-0001"], store("com")), null);
	assert.equal(
		parsePostalCode(["Ada", "〒100-0001 東京都"], store("com")),
		"100-0001",
	);
	assert.equal(
		parsePostalCode(["Ada", "東京都千代田区 100-0001"], store("co.jp")),
		"100-0001",
	);
	// a postal code alone on its line is not taken for a phone number
	assert.equal(
		parsePostalCode(["Ada", "1 Main St", "98101-1234"], store("com")),
		"98101-1234",
	);
});

test("shipping postal code: lowercase apartment text is not a UK postcode outside the UK", () => {
	assert.equal(
		parsePostalCode(["Ada", "Apt B2 3rd Floor", "Seattle"], store("com")),
		null,
	);
	assert.equal(
		parsePostalCode(["Ada", "1 Main St", "Apt B2 3rd Floor"], store("ca")),
		null,
	);
	// the UK store still reads its own codes in any case
	assert.equal(
		parsePostalCode(["Ada", "London sw1a 1aa"], store("co.uk")),
		"SW1A 1AA",
	);
});

test("shipping postal code: a country word on a street line is a street name, not the country", () => {
	assert.equal(
		parsePostalCode(
			["Ada", "12345 France St", "Montreal QC H2X 1Y4"],
			store("ca"),
		),
		"H2X 1Y4",
	);
	assert.equal(
		parsePostalCode(
			["Ada", "12345 Canada Way", "Burnaby, WA 98101"],
			store("com"),
		),
		"98101",
	);
	// the country on the last line, a phone line below it passed over
	assert.equal(
		parsePostalCode(
			[
				"Ada",
				"100 Queen St W",
				"Toronto, ON M5H 2N2",
				"Canada",
				"Phone: 416-555-1234",
			],
			store("com"),
		),
		"M5H 2N2",
	);
});

test("profile: an isPrime outside the nav menu config is not Prime membership", () => {
	const html = `<html><head><script>
		window.$Nav && $Nav.declare('config.customerName','Ada');
		var widget = {"asin":"B000000001","isPrime":1};
	</script></head><body>
		<div id="nav-link-accountList"><span class="nav-line-1">Hello, Ada</span></div>
	</body></html>`;
	assert.equal(parseAmazonProfileDom(html, store("com")).is_prime, null);
	const anchored = html.replace(
		"var widget",
		`window.$Nav && $Nav.declare('config.dynamicMenuArgs',{"rid":"X","isPrime":0,"dynamicRequest":1});\n\t\tvar widget`,
	);
	assert.equal(parseAmazonProfileDom(anchored, store("com")).is_prime, false);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	parseAccountProfile,
	readAccountProfile,
	sourceOrderItemTotal,
	sourceReportsEmptyHistory,
} from "./account-source.ts";

const profile = readFileSync(
	new URL("./__fixtures__/profile-nextdata-synthetic.html", import.meta.url),
	"utf8",
);
const orders = readFileSync(
	new URL(
		"./__fixtures__/orders-empty-nextdata-synthetic.html",
		import.meta.url,
	),
	"utf8",
);

test("profile reads complete SSR fields including a false primary marker", () => {
	assert.deepEqual(parseAccountProfile(profile), {
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
});

test("explicit empty address array is a complete profile", () => {
	const html = profile.replace(/"addresses":\[[\s\S]*?\]/, '"addresses":[]');
	assert.deepEqual(parseAccountProfile(html)?.delivery_addresses, []);
});

for (const [label, transform] of [
	[
		"missing primary marker",
		(s: string) => s.replace('"defaultAddress":false', '"unrelated":false'),
	],
	[
		"unreadable address id",
		(s: string) => s.replace('"id":"synthetic-address"', '"id":null'),
	],
	[
		"absent addresses",
		(s: string) => s.replace('"addresses":', '"unrelated":'),
	],
	[
		"wrong route",
		(s: string) =>
			s.replace('"page":"/my-account/profile"', '"page":"/public"'),
	],
	["signed out", (s: string) => s.replace("/oidc/prompt/edit_account", "/login")],
	["non-SSR payload", (s: string) => s.replace('"gssp":true', '"gssp":false')],
] as const)
	test(`profile withholds ${label}`, () =>
		assert.equal(parseAccountProfile(transform(profile)), null));

test("source reports first-page empty history", () =>
	assert.equal(sourceReportsEmptyHistory(orders), true));
for (const [label, transform] of [
	["partial page", (s: string) => s.replace('"pages":[]', '"pages":[1,2]')],
	["later page", (s: string) => s.replace('"page":1', '"page":2')],
	["unreadable rows", (s: string) => s.replace('"orders":[]', '"orders":[{}]')],
	[
		"source error",
		(s: string) =>
			s.replace('"errorMessage":null', '"errorMessage":"Unavailable"'),
	],
	[
		"missing error status",
		(s: string) => s.replace('"errorMessage":null', '"unrelated":null'),
	],
	[
		"missing terminal pages",
		(s: string) => s.replace('"pages":[]', '"pages":null'),
	],
	["signed out", (s: string) => s.replace('data-qe-id="orderResults"', 'data-qe-id="unrelated"')],
	[
		"missing empty state",
		(s: string) => s.replace("Empty_box__synthetic", "Unrelated"),
	],
	[
		"wrong route",
		(s: string) =>
			s.replace('"page":"/my-account/your-orders"', '"page":"/public"'),
	],
	["malformed JSON", (s: string) => s.replace('"orders":[]', '"orders":[')],
] as const)
	test(`empty history rejects ${label}`, () =>
		assert.equal(sourceReportsEmptyHistory(transform(orders)), false));

const detailData = (orderId: string, lines: number, page = "/my-account/order-history/[orderId]") =>
	JSON.stringify({
		page,
		gssp: true,
		props: { __N_SSP: true, pageProps: { order: { orderId, orderItems: Array.from({ length: lines }, () => ({ quantity: 1 })) } } },
	});
const detail = (orderId: string, lines: number, page?: string) =>
	`<section data-qe-id="orderSummaryCard"></section><script id="__NEXT_DATA__" type="application/json">${detailData(orderId, lines, page)}</script>`;

test("an order page's server payload reports its item lines for the requested order only", () => {
	assert.equal(sourceOrderItemTotal(detail("HEBSYNTH0001", 3), "HEBSYNTH0001"), 3);
	assert.equal(sourceOrderItemTotal(detail("HEBSYNTH0001", 0), "HEBSYNTH0001"), 0);
	for (const [label, html] of [
		["another order", detail("HEBSYNTH0002", 3)],
		["another route", detail("HEBSYNTH0001", 3, "/my-account/your-orders")],
		["no summary card", detail("HEBSYNTH0001", 3).replace("orderSummaryCard", "unrelated")],
		["no payload", '<section data-qe-id="orderSummaryCard"></section>'],
		["no item list", detail("HEBSYNTH0001", 3).replace('"orderItems"', '"unrelated"')],
		["malformed payload", detail("HEBSYNTH0001", 3).replace('"orderId"', '"orderId" BAD')],
	] as const)
		assert.equal(sourceOrderItemTotal(html, "HEBSYNTH0001"), null, label);
});

test("profile accepts absent optional address fields", () => {
	const html = profile.replace('"nickname":"Home",', "").replace('"address2":null,', "");
	const result = readAccountProfile(html);
	assert.equal(result.failure, null);
	assert.ok(result.record);
	assert.equal(result.record.delivery_addresses[0]?.label, null);
	assert.equal(result.record.delivery_addresses[0]?.address, "123 Example Street, Example City, TX 00000");
	assert.deepEqual(parseAccountProfile(html), result.record);
});

test("profile keeps the parts of an address H-E-B saved without them all", () => {
	const html = profile.replace('"address1":"123 Example Street"', '"address1":null').replace('"city":"Example City",', "");
	const result = readAccountProfile(html);
	assert.equal(result.failure, null);
	assert.equal(result.record?.delivery_addresses[0]?.address, "TX 00000");
	assert.equal(result.record?.delivery_addresses[0]?.label, "Home");
});

test("profile leaves out a saved address with no street, city, state or postal code", () => {
	const empty = '{"id":"synthetic-empty","nickname":null,"address1":null,"address2":null,"city":"","defaultAddress":false}';
	const html = profile.replace(/"addresses":\[/, `"addresses":[${empty},`);
	const result = readAccountProfile(html);
	assert.equal(result.failure, null);
	assert.deepEqual(result.record?.delivery_addresses, [
		{ address: "123 Example Street, Example City, TX 00000", label: "Home", is_primary: false },
	]);
});

for (const replacement of ["", '"daytimeTelephoneNumber":"",', '"daytimeTelephoneNumber":"   ",']) {
	test(`profile accepts optional phone: ${JSON.stringify(replacement)}`, () => {
		const result = readAccountProfile(profile.replace('"daytimeTelephoneNumber":"2025550100",', replacement));
		assert.equal(result.failure, null);
		assert.ok(result.record);
		assert.equal(result.record.phone, null);
	});
}

for (const [label, transform, gate, paths] of [
	["missing primary marker", (s: string) => s.replace('"defaultAddress":false', '"unrelated":false'), "schema", ["addresses.0.defaultAddress"]],
	["unreadable address id", (s: string) => s.replace('"id":"synthetic-address"', '"id":null'), "schema", ["addresses.0.id"]],
	["wrong address part type", (s: string) => s.replace('"address1":"123 Example Street"', '"address1":7'), "schema", ["addresses.0.address1"]],
	["absent addresses", (s: string) => s.replace('"addresses":', '"unrelated":'), "schema", ["addresses"]],
	["signed out", (s: string) => s.replace("/oidc/prompt/edit_account", "/login"), "signed_out_marker", []],
	["wrong route", (s: string) => s.replace('"/my-account/profile"', '"/public"'), "ssr_route_mismatch", []],
	["non-SSR", (s: string) => s.replace('"gssp":true', '"gssp":false'), "ssr_route_mismatch", []],
	["missing SSP", (s: string) => s.replace('"__N_SSP":true', '"__N_SSP":false'), "ssr_route_mismatch", []],
	["missing payload", (s: string) => s.replace('__NEXT_DATA__', 'UNRELATED'), "next_data_missing", []],
	["malformed payload", (s: string) => s.replace('"profileId":', '"profileId" INVALID:'), "next_data_unparseable", []],
	["duplicate address", (s: string) => s.replace(/"addresses":\[({[^\]]+})\]/, '"addresses":[$1,$1]'), "duplicate_address_id", []],
] as const) {
	test(`profile failure reports value-free gate: ${label}`, () => {
		const html = transform(profile);
		assert.notEqual(html, profile);
		const result = readAccountProfile(html);
		assert.equal(result.record, null);
		assert.equal(parseAccountProfile(html), null);
		assert.deepEqual(result.failure, { gate, issue_paths: paths });
		assert.doesNotMatch(JSON.stringify(result.failure), /Example|Shopper|shopper@example|2025550100|synthetic-address|123 Example Street/);
	});
}

test("profile still refuses malformed optional fields without including their values", () => {
	const html = profile.replace('"nickname":"Home"', '"nickname":{"private":"VALUE_SENTINEL"}');
	assert.deepEqual(readAccountProfile(html), {
		record: null, failure: { gate: "schema", issue_paths: ["addresses.0.nickname"] },
	});
});

test("a sign-out link alone is no longer profile evidence", () => {
	const html = profile.replace(
		'<a href="/oidc/prompt/edit_account" data-component="link">Verify</a>',
		'<a href="/oidc/session/end">Log out</a>',
	);
	assert.notEqual(html, profile);
	assert.equal(readAccountProfile(html).failure?.gate, "signed_out_marker");
});

test("an account-edit control on another route is not orders evidence", () => {
	const html = orders.replace(
		'data-qe-id="orderResults"',
		'data-qe-id="unrelated"><a href="/oidc/prompt/edit_account">Edit</a',
	);
	assert.equal(sourceReportsEmptyHistory(html), false);
});

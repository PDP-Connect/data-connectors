// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	parseAccountProfile,
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
		"unreadable address",
		(s: string) =>
			s.replace('"address1":"123 Example Street"', '"address1":null'),
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
	["signed out", (s: string) => s.replace("/oidc/session/end", "/login")],
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
	["signed out", (s: string) => s.replace("/oidc/session/end", "/login")],
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

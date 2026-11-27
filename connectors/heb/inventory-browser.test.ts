// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium } from "playwright";
import { fetchOrderDetail } from "./index.ts";

for (const [fixture, expectedRows, coherent] of [
	["order-detail-mixed-schemes.html", 2, false],
	["order-detail-loading-settled.html", 1, true],
	["order-detail-continuous-href.html", 1, false],
	["order-detail-multiple-scrollports.html", 4, true],
] as const) {
	test(`source evidence: ${fixture} collects safe rows without completion`, async () => {
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage();
			const html = readFileSync(
				new URL("./__fixtures__/" + fixture, import.meta.url),
				"utf8",
			);
			await page.route(
				"https://www.heb.com/my-account/order-history/HEB123456",
				(route) => route.fulfill({ body: html, contentType: "text/html" }),
			);
			const result = await fetchOrderDetail(page, "HEB123456", {
				waitForHydration: async () => {},
				detailSurfaceTimeoutMs: 5000,
			});
			assert.equal(result.status, "hydrated");
			if (result.status !== "hydrated") return;
			assert.equal(result.detail.items.length, expectedRows);
			assert.equal(result.inventoryComplete, false);
			assert.equal(result.evidence.coherent, coherent);
			if (fixture.includes("loading"))
				assert.equal(result.detail.items[0]?.name, "Settled");
			if (fixture.includes("continuous"))
				assert.equal(result.detail.items[0]?.quantity, 1);
			if (fixture.includes("multiple")) {
				assert.deepEqual(
					await page
						.locator(".port")
						.evaluateAll((ports) =>
							ports.map((port) => (port as HTMLElement).dataset.loaded),
						),
					["true", "true"],
				);
			}
		} finally {
			await browser.close();
		}
	});
}

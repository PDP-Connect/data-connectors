/**
 * Live 2026-11-19, amazon.ca: every run stopped after the last page of 2026.
 * That page said "0 orders" and carried Amazon's hidden header sign-in form, and
 * the empty-page check read the form as a lost sign-in. Real Chromium: layout
 * decides what a person can see.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { chromium } from "patchright";
import type { Page } from "playwright";
import { scrapeListPage } from "./index.ts";
import { storeForCountry } from "./stores.ts";

const OFFLINE = {
	headless: true,
	proxy: { server: "http://127.0.0.1:9" },
	args: ["--host-resolver-rules=MAP * ~NOTFOUND"],
};

const HEADER_FORM =
	'<div id="nav-flyout-accountList" style="display:none"><form name="signIn" method="post" action="/ap/signin"><input type="email" name="email"><input type="submit" value="Sign in"></form></div>';
const LAST_PAGE = (header: string, extra = "") =>
	`<!doctype html><html lang="en-ca"><head><title>Your Orders</title></head><body>${header}<div class="your-orders-content-container"><span class="num-orders">0 orders</span> placed in 2026</div>${extra}</body></html>`;

async function scrape(
	html: string,
): Promise<{ orders: number; error: string | null }> {
	const browser = await chromium.launch(OFFLINE);
	try {
		const page = await browser.newPage();
		await page.route("**/*", (route) =>
			route.fulfill({ status: 200, contentType: "text/html", body: html }),
		);
		const store = storeForCountry("ca");
		assert(store);
		const emitted: EmittedMessage[] = [];
		try {
			const orders = await scrapeListPage(
				page as unknown as Page,
				null,
				2026,
				40,
				async (message) => {
					emitted.push(message);
				},
				{ hasPriorOrders: false },
				store,
			);
			return { orders: orders.length, error: null };
		} catch (error) {
			return {
				orders: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	} finally {
		await browser.close();
	}
}

test("the last page of a year with Amazon's hidden header sign-in form ends the year", async () => {
	assert.deepEqual(await scrape(LAST_PAGE(HEADER_FORM)), {
		orders: 0,
		error: null,
	});
});

test("a sign-in form the person can see still stops the walk as a lost sign-in", async () => {
	const visible =
		'<form name="signIn" method="post" action="/ap/signin"><label>Email<input type="email" name="email"></label><input type="submit" value="Continue"></form>';
	const result = await scrape(LAST_PAGE(HEADER_FORM, visible));
	assert.equal(result.error, "amazon_empty_list_page_source_auth_or_challenge");
});

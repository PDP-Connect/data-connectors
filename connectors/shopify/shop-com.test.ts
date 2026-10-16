// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-browser tests for Shop's order history as served on shop.com, with
 * synthetic pages and replies shaped like the live ones: a signed-in account
 * page whose sidebar links to "Sign in & security", a signed-out page whose
 * prompt is "Sign in to your account" with a "Sign in" button, and the
 * `POST /web/api/order-history` replies the order screen pages with.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page, type Route } from "patchright";
import type { Page as PlaywrightPage } from "playwright";
import type { BrowserCollectContext } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import { makeRecordingEmit } from "../../packages/polyfill-connectors/src/test-harness.ts";
import {
	collect,
	ensureShopifySession,
	hasShopOrderHistoryContextInPage,
	hasShopSignInWallInPage,
	isShopOrderHistoryReadyInPage,
	readShopOrderPageEvidenceInPage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

const ORDER_A = "11111111-aaaa-4aaa-8aaa-111111111111";
const ORDER_B = "22222222-bbbb-4bbb-8bbb-222222222222";

const SIGNED_IN_PAGE = `<!doctype html><html lang="en"><body>
<header data-testid="header">
  <a data-testid="ShopLogoLink" href="/">Shop</a>
  <a data-testid="HeaderLink-Orders" href="/orders">Orders</a>
  <a data-testid="cart-indicator" href="/cart">Cart</a>
  <button data-testid="account-menu" aria-label="Account menu">Account</button>
</header>
<div class="account-layout">
  <div class="sidebar">
    <nav data-testid="account-sidebar-menu" aria-label="Account">
      <a href="/account/order-history">Order history</a>
      <a href="/account/settings/addresses">Addresses</a>
      <a href="/account/settings/sign-in-security">Sign in &amp; security</a>
    </nav>
  </div>
  <main>
    <h1>Order history</h1>
    <div class="flex flex-col"><button type="button" data-testid="order-history-item"><div>Example Shop</div><div>1 item · $0.00</div></button></div>
  </main>
</div>
<footer><a href="/terms-of-service">Terms of Service</a></footer>
</body></html>`;

const SIGNED_OUT_PAGE = `<!doctype html><html lang="en"><body>
<header data-testid="header">
  <a data-testid="ShopLogoLink" href="/">Shop</a>
  <a data-testid="HeaderLink-Orders" href="/orders">Orders</a>
  <div data-testid="sign-in-button"><button type="button">Sign in</button></div>
</header>
<main>
  <div data-testid="empty-view"><h2>Sign in to your account</h2><button type="button">Sign in</button></div>
</main>
<footer><a href="/terms-of-service">Terms of Service</a></footer>
</body></html>`;

function orderNode(id: string): Record<string, unknown> {
	return {
		__typename: "Order",
		id,
		createdAt: "2026-01-15T10:00:00Z",
		displayStatus: "paid",
		effectiveTotalPrice: { __typename: "MoneyV2", amount: "0.0", currencyCode: "USD" },
		totalPriceAfterOfferApplied: null,
		totalItemCount: 1,
		shop: { __typename: "Shop", name: "Example Shop" },
		lineItems: { __typename: "LineItemConnection", nodes: [{ __typename: "LineItem", productTitle: "Example Item" }] },
	};
}

function historyBody(nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }): unknown {
	return { deliveriesOrdersList: { __typename: "DeliveriesOrdersListConnection", nodes, pageInfo }, accounts: [] };
}

interface ShopComFixture {
	html: string;
	/** Reply for one order-history request, by the `after` cursor the page sent. */
	api: (params: Record<string, string>) => { status: number; body: unknown };
	/** When set, every POST gets this bare status, so only the GET form can succeed. */
	postStatus?: number;
}

/**
 * Serves shop.com and lands every order-history navigation there, as the live
 * site's shop.app redirect does. Chromium does not route a redirect hop a route
 * handler fulfilled, so the landing is applied at `goto` instead.
 */
async function serveShopCom(page: Page, fixture: ShopComFixture): Promise<Array<Record<string, string>>> {
	const requests: Array<Record<string, string>> = [];
	await page.route("**/*", async (route: Route) => {
		const url = new URL(route.request().url());
		if (url.origin === "https://shop.com" && url.pathname === "/web/api/order-history") {
			const method = route.request().method();
			const params = method === "POST"
				? JSON.parse(route.request().postData() ?? "{}") as Record<string, string>
				: Object.fromEntries(url.searchParams);
			requests.push({ method, ...params });
			const reply = method === "POST" && fixture.postStatus !== undefined
				? { status: fixture.postStatus, body: null }
				: fixture.api(params);
			await route.fulfill({ status: reply.status, contentType: "application/json", body: JSON.stringify(reply.body) });
		} else if (url.origin === "https://shop.com") {
			await route.fulfill({ status: 200, contentType: "text/html", body: fixture.html });
		} else {
			await route.abort();
		}
	});
	const goto = page.goto.bind(page);
	page.goto = ((_url, options) =>
		goto("https://shop.com/account/order-history?_m_id=fixture&_m_attempted=1", options)) as Page["goto"];
	return requests;
}

async function runCollect(page: Page, state: Record<string, unknown> = {}) {
	const run = makeRecordingEmit(validateRecord);
	await collect(
		{
			page,
			emit: run.emit,
			emitRecord: run.emitRecord,
			progress: async () => undefined,
			requested: new Map([["orders", { name: "orders" }]]),
			state,
		} as unknown as BrowserCollectContext,
		{ wait: async () => undefined },
	);
	return run;
}

async function withPage<T>(body: (page: Page) => Promise<T>): Promise<T> {
	const browser = await chromium.launch({ headless: true });
	try {
		return await body(await browser.newPage());
	} finally {
		await browser.close();
	}
}

test("the signed-in shop.com account page with a 'Sign in & security' link is not a sign-in wall", async () => {
	await withPage(async (page) => {
		await serveShopCom(page, { html: SIGNED_IN_PAGE, api: () => ({ status: 200, body: null }) });
		await page.goto("https://shop.com/account/order-history?_m_id=fixture&_m_attempted=1");
		assert.equal(await page.evaluate(hasShopSignInWallInPage), false);
		assert.equal(await page.evaluate(isShopOrderHistoryReadyInPage), true);
		assert.equal(await page.evaluate(hasShopOrderHistoryContextInPage), true);
		const evidence = await page.evaluate(readShopOrderPageEvidenceInPage);
		assert.equal(evidence.blocked, false);
		assert.equal(evidence.orderContext, true);
		assert.equal(evidence.url, "https://shop.com/account/order-history");
	});
});

test("the signed-out shop.com page with Shop's sign-in prompt is a sign-in wall", async () => {
	await withPage(async (page) => {
		await serveShopCom(page, { html: SIGNED_OUT_PAGE, api: () => ({ status: 401, body: { error: "UNAUTHORIZED" } }) });
		await page.goto("https://shop.com/account/order-history?_m_id=fixture&_m_attempted=1");
		assert.equal(await page.evaluate(hasShopSignInWallInPage), true);
		assert.equal(await page.evaluate(hasShopOrderHistoryContextInPage), false);
		const evidence = await page.evaluate(readShopOrderPageEvidenceInPage);
		assert.equal(evidence.blocked, true);
		assert.equal(evidence.orderContext, false);
	});
});

test("sign-in labels that only start with 'Sign in' are not prompts, and hidden prompts do not count", async () => {
	await withPage(async (page) => {
		await page.setContent('<main><h1>Order history</h1><a href="/s">Sign in &amp; security</a><a href="/t">Sign in and security</a><a href="/u">Sign in settings</a></main>');
		assert.equal(await page.evaluate(hasShopSignInWallInPage), false);
		await page.setContent('<main><h1>Order history</h1><button style="display:none">Sign in</button></main>');
		assert.equal(await page.evaluate(hasShopSignInWallInPage), false);
		for (const label of ["Sign in", "Log in", "Sign in to Shop", "Sign-in", "Continue to sign in"]) {
			await page.setContent(`<main><button>${label}</button></main>`);
			assert.equal(await page.evaluate(hasShopSignInWallInPage), true, label);
		}
		await page.setContent('<main><input type="email" name="email"></main>');
		assert.equal(await page.evaluate(hasShopSignInWallInPage), true);
	});
});

test("a signed-in shop.com session opens order history without a sign-in handoff, and a signed-out one fails closed", async () => {
	await withPage(async (page) => {
		await serveShopCom(page, { html: SIGNED_IN_PAGE, api: () => ({ status: 200, body: null }) });
		await ensureShopifySession({
			capture: null, page: page as unknown as PlaywrightPage,
			manualLogin: async () => { throw new Error("a signed-in session must not ask for sign-in"); },
			sendInteraction: async (): Promise<never> => { throw new Error("unexpected handoff"); },
		});
	});
	await withPage(async (page) => {
		await serveShopCom(page, { html: SIGNED_OUT_PAGE, api: () => ({ status: 401, body: { error: "UNAUTHORIZED" } }) });
		await assert.rejects(
			() => ensureShopifySession({
				capture: null, page: page as unknown as PlaywrightPage,
				manualLogin: async () => { throw new Error("must stop before a handoff"); },
				sendInteraction: async (): Promise<never> => { throw new Error("unexpected handoff"); },
			}),
			/shopify_signed_out_or_blocked/,
		);
	});
});

test("shop.com orders are read from Shop's order-history replies and complete on Shop's own end of list", async () => {
	await withPage(async (page) => {
		const requests = await serveShopCom(page, {
			html: SIGNED_IN_PAGE,
			api: (params) => params.after === undefined
				? { status: 200, body: historyBody([orderNode(ORDER_A)], { hasNextPage: true, endCursor: "cursor-1" }) }
				: { status: 200, body: historyBody([orderNode(ORDER_B)], { hasNextPage: false, endCursor: null }) },
		});
		const run = await runCollect(page);
		assert.deepEqual(
			run.emitted.filter((record) => record.stream === "orders").map((record) => record.data.id),
			[ORDER_A, ORDER_B],
		);
		const first = run.emitted[0]?.data;
		assert.equal(first?.total_cents, 0);
		assert.equal(first?.currency, "USD");
		assert.equal(first?.merchant_name, "Example Shop");
		assert.deepEqual(first?.line_item_titles, ["Example Item"]);
		assert.equal(first?.detail_url, "https://shop.app/account/order-history");
		assert.equal(run.protocolMessages.filter((message) => message.type === "STATE").length, 1);
		assert.equal(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"), false);
		assert.deepEqual(requests, [
			{ method: "POST", pageSize: "10", archived: "false", locale: "en" },
			{ method: "POST", pageSize: "10", archived: "false", locale: "en", after: "cursor-1" },
		]);
	});
});

test("when Shop's pager POST is refused, the same page is read with the first-page loader's GET", async () => {
	await withPage(async (page) => {
		const requests = await serveShopCom(page, {
			html: SIGNED_IN_PAGE,
			postStatus: 405,
			api: () => ({ status: 200, body: historyBody([orderNode(ORDER_A)], { hasNextPage: false, endCursor: null }) }),
		});
		const run = await runCollect(page);
		assert.deepEqual(run.emitted.map((record) => record.data.id), [ORDER_A]);
		assert.equal(run.protocolMessages.filter((message) => message.type === "STATE").length, 1);
		assert.deepEqual(requests.map((request) => request.method), ["POST", "GET"]);
		assert.deepEqual(requests[1], { method: "GET", pageSize: "10", archived: "false", locale: "en" });
	});
});

test("a zero-order account is complete only because Shop's reply says the list ended", async () => {
	await withPage(async (page) => {
		await serveShopCom(page, {
			html: SIGNED_IN_PAGE,
			api: () => ({ status: 200, body: historyBody([], { hasNextPage: false, endCursor: null }) }),
		});
		const run = await runCollect(page);
		assert.equal(run.emitted.length, 0);
		assert.equal(run.protocolMessages.filter((message) => message.type === "STATE").length, 1);
	});
});

test("shop.com orders read without Shop's end of list are kept and the skip says the inventory is unproven", async () => {
	await withPage(async (page) => {
		await serveShopCom(page, {
			html: SIGNED_IN_PAGE,
			api: (params) => params.after === undefined
				? { status: 200, body: historyBody([orderNode(ORDER_A)], { hasNextPage: true, endCursor: "cursor-1" }) }
				: { status: 500, body: { error: "Failed to fetch page" } },
		});
		const run = await runCollect(page, {});
		assert.deepEqual(run.emitted.map((record) => record.data.id), [ORDER_A]);
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
		const skip = run.protocolMessages.find((message) => message.type === "SKIP_RESULT");
		assert.ok(skip && skip.type === "SKIP_RESULT");
		assert.equal(skip.reason, "inventory_not_proven_complete");
		assert.deepEqual(skip.recovery_hint, { action: "retry_by_runtime", retryable: true });
	});
});

test("an unauthorized order-history reply yields no orders and no completeness claim", async () => {
	await withPage(async (page) => {
		await serveShopCom(page, {
			html: SIGNED_IN_PAGE,
			api: () => ({ status: 401, body: { error: "UNAUTHORIZED" } }),
		});
		const run = await runCollect(page);
		assert.equal(run.emitted.length, 0);
		assert.equal(run.protocolMessages.some((message) => message.type === "STATE"), false);
		assert.ok(run.protocolMessages.some((message) => message.type === "SKIP_RESULT"));
	});
});

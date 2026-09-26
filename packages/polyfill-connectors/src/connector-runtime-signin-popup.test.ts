// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Chromium fixture for the adjacent provider-popup path. The observed
 * H-E-B defect came from the shared readiness poller opening a sibling page;
 * this fixture tests a second way a provider could create an extra page during
 * sign-in (`window.open`, `target="_blank"`, or a targeted form). The runtime
 * owns one page and must contain these requests before a parallel OIDC attempt
 * can start.
 *
 * This test does not launch the full connector runtime (no network
 * dependency on a real OAuth provider). It reproduces the exact page-count
 * defect against real headless Chromium: open a working page, simulate a
 * sign-in flow that spawns a popup the way an OAuth redirect does, then
 * assert whether the context still holds a stray page. The historical
 * post-sign-in sweep remains a cleanup guard; the one-page policy now acts
 * while sign-in is in progress.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import {
	closeBrowserContextPagesExcept,
	installSingleBrowserPagePolicy,
} from "./connector-runtime.ts";

const POPUP_TRIGGER_HTML = `<!doctype html>
<html><body>
<a id="signin" href="popup.html" target="_blank" rel="opener">Continue with provider</a>
<button id="scripted" onclick="window.open('popup.html', '_blank')">Scripted provider</button>
<form id="form" action="popup.html" target="_blank"><button id="form-button">Form provider</button></form>
<button id="programmatic-form" onclick="document.getElementById('form').submit()">Programmatic form</button>
</body></html>`;

// Mirrors a provider's post-auth popup-closer page: it opens, then the
// provider's own script leaves it at rest (some close themselves via
// window.close(); this file intentionally does NOT, matching the providers
// where Tim observed a stuck second tab rather than a vanishing one).
const POPUP_TARGET_HTML = `<!doctype html>
<html><body>Signed in.</body></html>`;

async function withPopupFixture(
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pdpp-signin-popup-"));
	try {
		await writeFile(join(dir, "index.html"), POPUP_TRIGGER_HTML);
		await writeFile(join(dir, "popup.html"), POPUP_TARGET_HTML);
		await run(`file://${dir}/index.html`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("sign-in popup left open after establishSession is NOT swept by the one-time pre-sign-in cleanup alone", async () => {
	await withPopupFixture(async (baseUrl) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(baseUrl);

			// Pre-sign-in sweep, as connector-runtime.ts does before
			// establishSession. Nothing to clean up yet: only `page` exists.
			await closeBrowserContextPagesExcept(context, page);
			assert.equal(context.pages().length, 1);

			// Simulate the sign-in phase: the provider's login flow spawns a
			// popup (OAuth/SSO), exactly like clicking a target="_blank" link.
			const [popup] = await Promise.all([
				context.waitForEvent("page"),
				page.click("#signin"),
			]);
			await popup.waitForLoadState();

			// establishSession has now "returned" with the working page back in
			// focus, but nothing swept the context again — this is the bug: two
			// pages are open, and only the caller who calls
			// closeBrowserContextPagesExcept a SECOND time (post-sign-in) would
			// close it.
			assert.equal(
				context.pages().length,
				2,
				"popup survives sign-in with no post-establishSession sweep — this is the reported two-tab defect",
			);
		} finally {
			await browser.close();
		}
	});
});

test("closeBrowserContextPagesExcept called again after sign-in closes the stray popup (the fix)", async () => {
	await withPopupFixture(async (baseUrl) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(baseUrl);

			await closeBrowserContextPagesExcept(context, page);

			const [popup] = await Promise.all([
				context.waitForEvent("page"),
				page.click("#signin"),
			]);
			await popup.waitForLoadState();
			assert.equal(context.pages().length, 2);

			// The fix: connector-runtime.ts now calls this again right after
			// establishSession resolves, before minimizeBrowserWindow/collect.
			const closed = await closeBrowserContextPagesExcept(context, page);

			assert.equal(closed, 1);
			assert.equal(context.pages().length, 1);
			assert.equal(context.pages()[0], page);
			assert.equal(page.isClosed(), false);
		} finally {
			await browser.close();
		}
	});
});

test("closeBrowserContextPagesExcept called after sign-in is a no-op when the provider closed its own popup", async () => {
	await withPopupFixture(async (baseUrl) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			await page.goto(baseUrl);
			await closeBrowserContextPagesExcept(context, page);

			const [popup] = await Promise.all([
				context.waitForEvent("page"),
				page.click("#signin"),
			]);
			await popup.waitForLoadState();
			await popup.close();

			const closed = await closeBrowserContextPagesExcept(context, page);

			assert.equal(closed, 0);
			assert.equal(context.pages().length, 1);
		} finally {
			await browser.close();
		}
	});
});

test("OIDC target blank stays on the owned sign-in page and makes one request", async () => {
	await withPopupFixture(async (baseUrl) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const stopPolicy = await installSingleBrowserPagePolicy(context, page);
			const oidcRequests: string[] = [];
			context.on("request", (request) => {
				if (request.url().endsWith("/popup.html")) {
					oidcRequests.push(request.url());
				}
			});
			await page.goto(baseUrl);
			await page.click("#signin");
			await page.waitForURL("**/popup.html");
			assert.equal(context.pages().length, 1);
			assert.deepEqual(oidcRequests.length, 1);
			stopPolicy();
		} finally {
			await browser.close();
		}
	});
});

for (const trigger of ["#scripted", "#form-button", "#programmatic-form"]) {
	test(`OIDC ${trigger} stays on the owned page`, async () => {
		await withPopupFixture(async (baseUrl) => {
			const browser = await chromium.launch({ headless: true });
			try {
				const context = await browser.newContext();
				const page = await context.newPage();
				const stopPolicy = await installSingleBrowserPagePolicy(context, page);
				await page.goto(baseUrl);
				await page.click(trigger);
				await page.waitForURL(/popup\.html/);
				assert.equal(context.pages().length, 1);
				await stopPolicy();
			} finally {
				await browser.close();
			}
		});
	});
}

test("direct context.newPage is rejected while a run owns its page", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		const stopPolicy = await installSingleBrowserPagePolicy(context, page);
		await assert.rejects(
			context.newPage(),
			/additional_browser_page_forbidden/,
		);
		assert.deepEqual(context.pages(), [page]);
		await stopPolicy();
		const nextRunPage = await context.newPage();
		const stopNextRun = await installSingleBrowserPagePolicy(
			context,
			nextRunPage,
		);
		await closeBrowserContextPagesExcept(context, nextRunPage);
		await nextRunPage.goto("data:text/html,<title>next run</title>");
		assert.deepEqual(context.pages(), [nextRunPage]);
		await stopNextRun();
	} finally {
		await browser.close();
	}
});

test("single-page policy cleanup tolerates a closed browser context", async () => {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const page = await context.newPage();
	const stopPolicy = await installSingleBrowserPagePolicy(context, page);
	await context.close();
	await assert.doesNotReject(stopPolicy());
	await browser.close();
});

test("HTTP OIDC redirect makes one authorize request on the owned page", async () => {
	let authorizeRequests = 0;
	let callbackRequests = 0;
	const server = createServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path === "/authorize") {
			authorizeRequests += 1;
			response.writeHead(302, { location: "/callback?state=synthetic" }).end();
			return;
		}
		if (path === "/callback") {
			callbackRequests += 1;
			response
				.writeHead(200, { "content-type": "text/html" })
				.end("Callback complete");
			return;
		}
		response
			.writeHead(200, { "content-type": "text/html" })
			.end(
				'<a id="oidc" href="/authorize?state=synthetic" target="_blank">Sign in</a>',
			);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const baseUrl = `http://127.0.0.1:${String(address.port)}`;
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		const stopPolicy = await installSingleBrowserPagePolicy(context, page);
		await page.goto(baseUrl);
		await page.click("#oidc");
		await page.waitForURL("**/callback?state=synthetic");
		assert.deepEqual([authorizeRequests, callbackRequests], [1, 1]);
		assert.deepEqual(context.pages(), [page]);
		await stopPolicy();
	} finally {
		await browser.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("unexpected native popup is closed before its first OIDC request", async () => {
	let authorizeRequests = 0;
	const server = createServer((request, response) => {
		if (request.url?.startsWith("/authorize")) {
			authorizeRequests += 1;
		}
		response
			.writeHead(200, { "content-type": "text/html" })
			.end(
				"<button id=\"oidc\" onclick=\"window.nativeOpen('/authorize?state=synthetic', '_blank')\">Sign in</button>",
			);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(`http://127.0.0.1:${String(address.port)}`);
		await page.evaluate(() => {
			Object.defineProperty(window, "nativeOpen", {
				value: window.open.bind(window),
			});
		});
		const stopPolicy = await installSingleBrowserPagePolicy(context, page);
		await page.click("#oidc");
		await page.waitForTimeout(200);
		assert.equal(authorizeRequests, 0);
		assert.deepEqual(context.pages(), [page]);
		await stopPolicy();
	} finally {
		await browser.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Chromium reproduction for the "two tabs at sign-in" defect (w28
 * directive item #1): GitHub, YouTube/Google, Spotify, LinkedIn and other
 * providers' sign-in flows open an OAuth/SSO popup or intermediate-redirect
 * tab (`window.open` / `target="_blank"`, matching browser-handoff.ts's own
 * doc comment on "popup creation"). `runInBrowser`'s ONLY pre-sign-in sweep
 * (`closeBrowserContextPagesExcept` called once, before `establishSession`)
 * never runs again afterward, so a popup opened DURING sign-in survives to
 * collection and teardown as a second visible tab — reloading or parked at
 * "about:blank" once the provider's popup-closer script runs (or fails to,
 * under CSP).
 *
 * This test does not launch the full connector runtime (no network
 * dependency on a real OAuth provider). It reproduces the exact page-count
 * defect against real headless Chromium: open a working page, simulate a
 * sign-in flow that spawns a popup the way an OAuth redirect does, then
 * assert whether the context still holds a stray page — first demonstrating
 * the pre-fix behavior class (a naive single pre-sign-in sweep leaves the
 * popup behind), then proving `closeBrowserContextPagesExcept` called again
 * after sign-in (the actual fix in connector-runtime.ts) sweeps it.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { closeBrowserContextPagesExcept } from "./connector-runtime.ts";

const POPUP_TRIGGER_HTML = `<!doctype html>
<html><body>
<a id="signin" href="popup.html" target="_blank" rel="opener">Continue with provider</a>
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

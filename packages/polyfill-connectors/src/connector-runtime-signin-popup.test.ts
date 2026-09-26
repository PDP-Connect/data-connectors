// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-Chromium fixture for provider popups. The runtime owns one top-level
 * page; sites can open child pages for SSO callbacks, including from iframes.
 * The callback must reach its opener, and each child must close at run teardown.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { chromium as patchrightChromium } from "patchright";
import { chromium } from "playwright";
import {
	closeBrowserContextPagesExcept,
	installOwnedRunPagePolicy,
} from "./connector-runtime.ts";

const POPUP_TRIGGER_HTML = `<!doctype html>
<html><body>
<a id="signin" href="popup.html" target="_blank" rel="opener">Continue with provider</a>
<button id="scripted" onclick="window.open('popup.html', '_blank')">Scripted provider</button>
<form id="form" action="popup.html" target="_blank"><button id="form-button">Form provider</button></form>
<button id="programmatic-form" onclick="document.getElementById('form').submit()">Programmatic form</button>
</body></html>`;

// Some providers leave their popup open after sign-in. The runtime must close
// those children at run teardown without interrupting authentication.
const POPUP_TARGET_HTML = `<!doctype html>
<html><body>Signed in.</body></html>`;

async function withOpenerCallbackFixture(
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server = createServer((request, response) => {
		response.setHeader("content-type", "text/html");
		switch (request.url) {
			case "/callback":
				response.end(`<script>
					if (window.opener) {
						window.opener.postMessage('signed-in', location.origin);
						window.close();
					}
				</script>`);
				break;
			case "/iframe":
				response.end(`<button id="login" onclick="window.open('/callback', 'auth')">Sign in</button>
					<script>addEventListener('message', event => {
						if (event.origin === location.origin) parent.postMessage(event.data, location.origin);
					})</script>`);
				break;
			default:
				response.end(`<button id="login" onclick="window.open('/callback', 'auth')">Sign in</button>
					<iframe src="/iframe"></iframe>
					<script>addEventListener('message', event => {
						if (event.origin === location.origin && event.data === 'signed-in') {
							document.body.dataset.signedIn = 'true';
						}
					})</script>`);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	try {
		await run(`http://127.0.0.1:${String(address.port)}`);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

for (const [engineName, engine] of [
	["Playwright", chromium],
	["Patchright", patchrightChromium],
] as const) {
	for (const fromIframe of [false, true]) {
		test(`${engineName} provider popup returns authentication through opener from ${fromIframe ? "iframe" : "page"}`, async () => {
			await withOpenerCallbackFixture(async (baseUrl) => {
				const browser = await engine.launch({ headless: true });
				try {
					const context = await browser.newContext();
					const page = await context.newPage();
					// Patchright mirrors the runtime API but ships independent TS types.
					const stopPolicy = await installOwnedRunPagePolicy(
						context as unknown as Parameters<
							typeof installOwnedRunPagePolicy
						>[0],
						page as unknown as Parameters<typeof installOwnedRunPagePolicy>[1],
					);
					await page.goto(baseUrl);
					if (fromIframe) {
						await page.frameLocator("iframe").locator("#login").click();
					} else {
						await page.click("#login");
					}
					await page
						.locator("body[data-signed-in='true']")
						.waitFor({ timeout: 2_000 });
					assert.equal(new URL(page.url()).pathname, "/");
					await stopPolicy();
				} finally {
					await browser.close();
				}
			});
		});
	}
}

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

for (const trigger of [
	"#signin",
	"#scripted",
	"#form-button",
	"#programmatic-form",
]) {
	test(`site popup ${trigger} stays visible during the run and closes at teardown`, async () => {
		await withPopupFixture(async (baseUrl) => {
			const browser = await chromium.launch({ headless: true });
			try {
				const context = await browser.newContext();
				const page = await context.newPage();
				const stopPolicy = await installOwnedRunPagePolicy(context, page);
				await page.goto(baseUrl);
				const [popup] = await Promise.all([
					context.waitForEvent("page"),
					page.click(trigger),
				]);
				await popup.waitForLoadState();
				assert.equal(popup.isClosed(), false);
				assert.equal(await popup.opener(), page);
				assert.equal(page.url(), baseUrl);
				assert.deepEqual(context.pages(), [page, popup]);
				await stopPolicy();
				assert.equal(popup.isClosed(), true);
				assert.deepEqual(context.pages(), [page]);
			} finally {
				await browser.close();
			}
		});
	});
}

test("Patchright leaves a provider popup visible until run teardown", async () => {
	await withPopupFixture(async (baseUrl) => {
		const browser = await patchrightChromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const stopPolicy = await installOwnedRunPagePolicy(
				context as unknown as Parameters<typeof installOwnedRunPagePolicy>[0],
				page as unknown as Parameters<typeof installOwnedRunPagePolicy>[1],
			);
			await page.goto(baseUrl);
			const [popup] = await Promise.all([
				context.waitForEvent("page"),
				page.click("#scripted"),
			]);
			await popup.waitForLoadState();
			assert.equal(popup.isClosed(), false);
			assert.equal(await popup.opener(), page);
			await stopPolicy();
			assert.equal(popup.isClosed(), true);
			assert.deepEqual(context.pages(), [page]);
		} finally {
			await browser.close();
		}
	});
});

test("site popup closed by provider is harmless at teardown", async () => {
	await withPopupFixture(async (baseUrl) => {
		const browser = await chromium.launch({ headless: true });
		try {
			const context = await browser.newContext();
			const page = await context.newPage();
			const stopPolicy = await installOwnedRunPagePolicy(context, page);
			await page.goto(baseUrl);
			const [popup] = await Promise.all([
				context.waitForEvent("page"),
				page.click("#scripted"),
			]);
			await popup.close();
			await assert.doesNotReject(stopPolicy());
			assert.deepEqual(context.pages(), [page]);
		} finally {
			await browser.close();
		}
	});
});

test("direct context.newPage is rejected while a run owns its page", async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		const stopPolicy = await installOwnedRunPagePolicy(context, page);
		await assert.rejects(
			context.newPage(),
			/additional_browser_page_forbidden/,
		);
		assert.deepEqual(context.pages(), [page]);
		await stopPolicy();
		const nextRunPage = await context.newPage();
		const stopNextRun = await installOwnedRunPagePolicy(context, nextRunPage);
		await closeBrowserContextPagesExcept(context, nextRunPage);
		await nextRunPage.goto("data:text/html,<title>next run</title>");
		assert.deepEqual(context.pages(), [nextRunPage]);
		await stopNextRun();
	} finally {
		await browser.close();
	}
});

test("owned-page policy cleanup tolerates a closed browser context", async () => {
	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext();
	const page = await context.newPage();
	const stopPolicy = await installOwnedRunPagePolicy(context, page);
	await context.close();
	await assert.doesNotReject(stopPolicy());
	await browser.close();
});

test("HTTP OIDC popup redirect makes one authorize request and leaves owner page intact", async () => {
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
				'<a id="oidc" href="/authorize?state=synthetic" target="_blank" rel="opener">Sign in</a>',
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
		const stopPolicy = await installOwnedRunPagePolicy(context, page);
		await page.goto(baseUrl);
		const [popup] = await Promise.all([
			context.waitForEvent("page"),
			page.click("#oidc"),
		]);
		await popup.waitForURL("**/callback?state=synthetic");
		assert.deepEqual([authorizeRequests, callbackRequests], [1, 1]);
		assert.equal(page.url(), `${baseUrl}/`);
		assert.deepEqual(context.pages(), [page, popup]);
		await stopPolicy();
		assert.deepEqual(context.pages(), [page]);
	} finally {
		await browser.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

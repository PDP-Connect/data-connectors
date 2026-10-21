// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { ensureOuraApiAccess, probeOuraCachedApiAccess } from "./api-access.ts";

const portal = "https://developer.ouraring.com";
const apps = `${portal}/applications`;
const moi = "https://moi.ouraring.com";
const callback = "https://vana.org/oauth/oura/callback";
const STORAGE_KEY = "vana:oura-connector:token";
const accountKey = (email: string) => createHash("sha256").update(email).digest("hex");
const signedInAccount = accountKey("synthetic@example.test");

async function seedToken(page: Page, accessToken: string, account?: string) {
	await page.evaluate(({ key, entry }) => localStorage.setItem(key, JSON.stringify(entry)), {
		key: STORAGE_KEY,
		entry: { accessToken, refreshToken: null, expiresAt: Date.now() + 3_600_000,
			clientId: "synthetic-app", clientSecret: "synthetic-secret", ...(account ? { account } : {}) },
	});
}

async function storedToken(page: Page): Promise<{ accessToken?: string; account?: string } | null> {
	return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), STORAGE_KEY);
}

async function withReplay(stale: boolean, run: (page: Page, state: { signOuts: () => number; appRequests: () => number; faultInjected: () => boolean; authorizeAttempts: () => number; tokenExchanges: () => number; dailyProbes: () => number }) => Promise<void>, prefixFault = false, initialSignedIn = stale, scopeProbeStatuses = [200]) {
	const browser = await chromium.launch({ headless: true });
	try {
		const context = await browser.newContext({ serviceWorkers: "block" });
		await context.addInitScript({ content: "globalThis.__name = (target) => target;" });
		let signedIn = initialSignedIn;
		let staleApps = stale;
		let signOuts = 0;
		let appRequests = 0;
		let faultInjected = false;
		let oauthState = "";
		let authorizeAttempts = 0;
		let tokenExchanges = 0;
		let dailyProbes = 0;
		const exchangedCodes = new Set<string>();
		const document = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
		await context.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
			const html = (body: string) => route.fulfill({ contentType: "text/html", body: document(body) });
			if (url.origin === portal) {
				if (url.pathname === "/api/auth/get-session") return json(signedIn ? { user: { email: "synthetic@example.test" } } : null);
				if (url.pathname === "/api/auth/session") return json(null);
				if (url.pathname === "/api/auth/sign-out") { signOuts++; signedIn = false; return json({}); }
				if (url.pathname === "/api/extapi/v2/oauth/applications") {
					appRequests++;
					return staleApps ? json({}, 401) : json([{
						client_id: "synthetic-app", client_secret: "synthetic-secret", application_name: "Personal access",
						redirect_uris: [callback], scopes: ["extapi:daily"],
					}]);
				}
				if (url.pathname === "/finish-first") {
					signedIn = true;
					staleApps = false;
					return html(`<script>location.replace('${apps}')</script>`);
				}
				if (url.pathname === "/signin") return html(`<button onclick="location.href='${moi}/authn/authentication/default'">Sign In</button>`);
				return html(`<button id="start-sign-in" onclick="location.href='${portal}/signin?callbackUrl=%2Fapplications'">Sign In</button>`);
			}
			if (url.origin === moi) {
				if (url.pathname === "/authn/authentication/default" || url.pathname === "/authn/authentication/default_ext") {
					const stage = url.pathname.endsWith("default_ext") ? "second" : "first";
					return html(`<form onsubmit="event.preventDefault();location.href='${moi}/authn/enter-otp?stage=${stage}'"><input id="username" type="email"><button type="submit">Continue</button></form>`);
				}
				if (url.pathname === "/authn/enter-otp") {
					const next = url.searchParams.get("stage") === "second"
						? `${moi}/oauth/v2/ext/oauth-authorize?stage=consent&state=${oauthState}`
						: `${portal}/finish-first`;
					return html(`<input id="otp-code" autocomplete="one-time-code"><button id="submit-otp" onclick="location.href='${next}'">Continue</button>`);
				}
				if (url.pathname === "/oauth/v2/ext/oauth-authorize") {
					if (url.searchParams.get("stage") !== "consent") {
						authorizeAttempts++;
						oauthState = url.searchParams.get("state") ?? "";
						return html(`<script>location.replace('${moi}/authn/authentication/default_ext')</script>`);
					}
					return html(`<input type="checkbox" name="consent.scope.extapi:daily"><button name="submit_consent" onclick="location.href='${callback}?code=synthetic-code-${authorizeAttempts}&state=${oauthState}'">Allow</button>`);
				}
			}
			if (url.href.startsWith(callback)) return html("Callback complete");
			return route.fulfill({ status: 404, body: "" });
		});
		const page = await context.newPage();
		await page.goto(apps);
		const wrapped = new Proxy(page, {
			get(target, property) {
				if (property === "context") return () => ({ request: {
					get: async () => ({ status: () => scopeProbeStatuses[Math.min(dailyProbes++, scopeProbeStatuses.length - 1)], dispose: async () => {} }),
					post: async (_url: string, options: { data: string }) => {
						const code = new URLSearchParams(options.data).get("code") ?? "";
						assert.match(code, /^synthetic-code-\d+$/);
						assert.equal(exchangedCodes.has(code), false, "each authorization uses a fresh code");
						exchangedCodes.add(code);
						tokenExchanges++;
						const access = scopeProbeStatuses.length > 1 ? `synthetic-access-${tokenExchanges}` : "synthetic-access";
						return { ok: () => true, status: () => 200, json: async () => ({ access_token: access, refresh_token: "synthetic-refresh", expires_in: 3600 }), dispose: async () => {} };
					},
				} });
				if (property === "evaluate") return async (...args: Parameters<Page["evaluate"]>) => {
					if (prefixFault && !faultInjected && String(args[0]).includes("/api/extapi/v2/oauth/applications")) {
						faultInjected = true;
						throw new Error("Error evaluating script: Execution context was destroyed");
					}
					try { return await page.evaluate(...args); }
					catch (error) { throw new Error(`PageShim evaluation failed: ${String(error)}`); }
				};
				const value = target[property as keyof Page];
				return typeof value === "function" ? value.bind(target) : value;
			},
		}) as Page;
		await run(wrapped, { signOuts: () => signOuts, appRequests: () => appRequests, faultInjected: () => faultInjected, authorizeAttempts: () => authorizeAttempts, tokenExchanges: () => tokenExchanges, dailyProbes: () => dailyProbes });
	} finally { await browser.close(); }
}

async function completeSignIn(page: Page, url: string, ready: () => Promise<boolean>, onManualConsent?: () => void) {
	if (page.url() !== url) await page.goto(url);
	if (url === apps) await page.locator("#start-sign-in").click();
	if (page.url().startsWith(`${portal}/signin`)) {
		assert.equal(await ready(), false);
		await page.waitForURL(`${moi}/authn/authentication/default`);
	}
	if (page.url().endsWith("/default")) {
		await page.locator("#username").fill("synthetic@example.test");
		await page.locator('button[type="submit"]').click();
	}
	if (page.url().endsWith("/default_ext")) {
		await page.locator("#username").waitFor();
		assert.equal(await ready(), false);
		await page.waitForURL(/\/authn\/enter-otp/);
	}
	if (page.url().includes("/enter-otp")) {
		const second = page.url().includes("stage=second");
		assert.equal(await probeOuraCachedApiAccess(page), null);
		assert.match(page.url(), /\/enter-otp/);
		assert.equal(await ready(), false);
		await page.locator("#otp-code").fill("123456");
		await page.locator("#submit-otp").click();
		await page.waitForURL(second ? /stage=consent/ : apps);
	}
	if (page.url().includes("stage=consent")) {
		assert.equal(await ready(), false);
		assert.equal(await ready(), false);
		await page.waitForURL(new RegExp(`^${callback.replaceAll(".", "\\.")}`), { timeout: 500 }).catch(() => {});
		if (page.url().includes("stage=consent")) {
			onManualConsent?.();
			await page.locator('button[name="submit_consent"]').click();
		}
		await page.waitForURL(new RegExp(`^${callback.replaceAll(".", "\\.")}`));
	}
	assert.equal(await ready(), true);
}

test("Oura page replay completes portal OTP and OAuth OTP without replacing either page", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page, state) => {
		const token = await ensureOuraApiAccess(page, (url, _message, ready) => completeSignIn(page, url, ready));
		assert.deepEqual(token, { accessToken: "synthetic-access", account: signedInAccount });
		assert.equal(state.signOuts(), 0);
	});
});

test("Oura page replay signs out a stale session after prefixed evaluation errors", { timeout: 120_000 }, async () => {
	await withReplay(true, async (page, state) => {
		const token = await ensureOuraApiAccess(page, (url, _message, ready) => completeSignIn(page, url, ready));
		assert.deepEqual(token, { accessToken: "synthetic-access", account: signedInAccount });
		assert.equal(state.signOuts(), 1);
		assert.ok(state.appRequests() >= 12);
	});
});

test("Oura page replay keeps a valid cached token while an OTP page is active", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page, state) => {
		await seedToken(page, "cached-access", signedInAccount);
		await page.goto(`${moi}/authn/enter-otp?stage=first`);
		assert.equal(await probeOuraCachedApiAccess(page), null);
		assert.match(page.url(), /\/enter-otp/);
		const token = await ensureOuraApiAccess(page, (url, _message, ready) => completeSignIn(page, url, ready));
		assert.deepEqual(token, { accessToken: "cached-access", account: signedInAccount });
		assert.equal(state.appRequests(), 0);
	});
});

test("Oura page replay retries a host-prefixed evaluation error after navigation settles", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page, state) => {
		const token = await ensureOuraApiAccess(page, (url, _message, ready) => completeSignIn(page, url, ready));
		assert.deepEqual(token, { accessToken: "synthetic-access", account: signedInAccount });
		assert.equal(state.faultInjected(), true);
		assert.equal(state.signOuts(), 0);
	}, true, true);
});

test("Oura page replay retries an unscoped automatic grant with manual consent", { timeout: 60_000 }, async () => {
	let manualApprovals = 0;
	await withReplay(false, async (page, state) => {
		const token = await ensureOuraApiAccess(page, (url, _message, ready) =>
			completeSignIn(page, url, ready, () => { manualApprovals++; }));
		assert.deepEqual(token, { accessToken: "synthetic-access-2", account: signedInAccount });
		assert.equal(state.authorizeAttempts(), 2);
		assert.equal(state.tokenExchanges(), 2);
		assert.equal(state.dailyProbes(), 2);
		assert.equal(manualApprovals, 1);
	}, false, false, [403, 200]);
});

test("Oura page replay stops after one manual retry when daily scope is still missing", { timeout: 60_000 }, async () => {
	let manualApprovals = 0;
	await withReplay(false, async (page, state) => {
		await assert.rejects(
			ensureOuraApiAccess(page, (url, _message, ready) =>
				completeSignIn(page, url, ready, () => { manualApprovals++; })),
			/oura_daily_scope_missing/,
		);
		assert.equal(state.authorizeAttempts(), 2);
		assert.equal(state.tokenExchanges(), 2);
		assert.equal(state.dailyProbes(), 2);
		assert.equal(manualApprovals, 1);
	}, false, false, [401, 403]);
});

for (const [label, account] of [["another account", accountKey("previous@example.test")], ["no account", undefined]] as const) {
	test(`Oura page replay discards a cached token bound to ${label} and authorizes the signed-in account`, { timeout: 60_000 }, async () => {
		await withReplay(false, async (page, state) => {
			await seedToken(page, "previous-access", account);
			const token = await ensureOuraApiAccess(page, (url, _message, ready) => completeSignIn(page, url, ready));
			assert.equal(state.authorizeAttempts(), 1, "the signed-in account authorizes its own grant");
			assert.deepEqual(token, { accessToken: "synthetic-access", account: signedInAccount });
			const stored = await storedToken(page);
			assert.equal(stored?.accessToken, "synthetic-access");
			assert.equal(stored?.account, signedInAccount);
		}, false, true);
	});
}

test("Oura page replay discards another account's token even when authorization does not finish", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page) => {
		await seedToken(page, "previous-access", accountKey("previous@example.test"));
		await assert.rejects(ensureOuraApiAccess(page, async () => { throw new Error("owner_left"); }), /owner_left/);
		assert.equal(await storedToken(page), null);
	}, false, true);
});

test("Oura page replay reuses a bound token without sign-in when no portal session is visible", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page, state) => {
		await seedToken(page, "cached-access", accountKey("previous@example.test"));
		assert.equal(await probeOuraCachedApiAccess(page), "cached-access");
		const token = await ensureOuraApiAccess(page, async () => { throw new Error("sign-in requested"); });
		assert.deepEqual(token, { accessToken: "cached-access", account: accountKey("previous@example.test") });
		assert.equal(state.appRequests(), 0);
	});
});

test("Oura page replay probe rejects a cached token bound to another signed-in account", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page) => {
		await seedToken(page, "previous-access", accountKey("previous@example.test"));
		assert.equal(await probeOuraCachedApiAccess(page), null);
		await seedToken(page, "cached-access", signedInAccount);
		assert.equal(await probeOuraCachedApiAccess(page), "cached-access");
	}, false, true);
});

test("Oura page replay does not reuse another account's token while the portal session is unreadable", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page, state) => {
		await seedToken(page, "previous-access", accountKey("previous@example.test"));
		await page.route(`${portal}/api/auth/get-session`, (route) => route.fulfill({ status: 500, body: "" }));
		let signInPrompts = 0;
		const token = await ensureOuraApiAccess(page, async (url, _message, ready) => {
			if (url === apps) {
				signInPrompts++;
				await page.unroute(`${portal}/api/auth/get-session`);
				assert.equal(await ready(), true);
				return;
			}
			await completeSignIn(page, url, ready);
		});
		assert.equal(signInPrompts, 1, "an unreadable session asks for sign-in before any reuse");
		assert.deepEqual(token, { accessToken: "synthetic-access", account: signedInAccount });
		assert.equal(state.authorizeAttempts(), 1);
	}, false, true);
});

test("Oura page replay keeps this account's grant when its refresh fails and authorization does not finish", { timeout: 60_000 }, async () => {
	await withReplay(false, async (page) => {
		await page.evaluate(({ key, entry }) => localStorage.setItem(key, JSON.stringify(entry)), {
			key: STORAGE_KEY,
			entry: { accessToken: "expired-access", refreshToken: "kept-refresh", expiresAt: Date.now() - 1000,
				clientId: "synthetic-app", clientSecret: "synthetic-secret", account: signedInAccount },
		});
		// The replay's token endpoint accepts only authorization codes, so the refresh fails.
		await assert.rejects(ensureOuraApiAccess(page, async () => { throw new Error("owner_left"); }), /owner_left/);
		assert.equal((await storedToken(page) as { refreshToken?: string } | null)?.refreshToken, "kept-refresh");
	}, false, true);
});

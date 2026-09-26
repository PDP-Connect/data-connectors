// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { BrowserContext, Locator, Page } from "playwright";
import type { InteractionRequest } from "../connector-runtime.ts";
import { ensureDoorDashSession, isLoginChallengeUrl } from "./doordash.ts";

const ORDERS_URL = "https://www.doordash.com/orders";
const LOGIN_URL = "https://www.doordash.com/consumer/login/";
const IDENTITY_URL = "https://identity.doordash.com/auth?state=%2Forders";

interface SessionState {
	authenticated: boolean;
	ownerNavigations: string[];
	readinessNavigations: string[];
}

function makePage(state: SessionState, navigations: string[]): Page {
	let currentUrl = "about:blank";
	const page: Partial<Page> = {
		close: async () => {},
		context: () => {
			const context: Partial<BrowserContext> = {
				newPage: async () => makePage(state, state.readinessNavigations),
			};
			return context as BrowserContext;
		},
		goto: async (url) => {
			navigations.push(url);
			currentUrl =
				url === ORDERS_URL
					? state.authenticated
						? ORDERS_URL
						: IDENTITY_URL
					: url;
			return null;
		},
		locator: () => {
			const locator: Partial<Locator> = { count: async () => 0 };
			return locator as Locator;
		},
		url: () => currentUrl,
		waitForTimeout: async () => {},
	};
	return page as Page;
}

function makeLoginState(): SessionState {
	return {
		authenticated: false,
		ownerNavigations: [],
		readinessNavigations: [],
	};
}

// Shape captured live 2026-09-22 against the cut-doordash profile (identifying
// query params stripped/replaced) — see the cut-doordash lane report's "Live
// evidence" section. This is the exact bug: identity.doordash.com is a HOST,
// not a `/identity/` path segment on www.doordash.com, so a path-only regex
// against the raw URL string never matched it.
const CAPTURED_IDENTITY_CHALLENGE_URL =
	"https://identity.doordash.com/auth?client_id=REDACTED&intl=en-US&layout=consumer_web&prompt=none&redirect_uri=https%3A%2F%2Fwww.doordash.com%2Fpost-login%2F&response_type=code&scope=%2A&state=%2Forders%2F%7C%7CREDACTED";

test("isLoginChallengeUrl: detects the real identity.doordash.com challenge host (regression for the 2026-09-22 false-negative)", () => {
	assert.equal(isLoginChallengeUrl(CAPTURED_IDENTITY_CHALLENGE_URL), true);
});

test("isLoginChallengeUrl: detects the /consumer/login path challenge", () => {
	assert.equal(
		isLoginChallengeUrl("https://www.doordash.com/consumer/login/"),
		true,
	);
});

test("isLoginChallengeUrl: an authenticated orders page is not a challenge", () => {
	assert.equal(isLoginChallengeUrl("https://www.doordash.com/orders"), false);
});

test("isLoginChallengeUrl: a www.doordash.com/identity/ path (not the identity subdomain) is not a challenge on its own — only the real host or the /consumer/login path count", () => {
	assert.equal(
		isLoginChallengeUrl("https://www.doordash.com/identity/some-page"),
		false,
	);
});

test("isLoginChallengeUrl: malformed URL never throws, returns false", () => {
	assert.equal(isLoginChallengeUrl("not a url"), false);
});

test("ensureDoorDashSession resumes initial owner login after the visible Continue control and a live orders probe", async () => {
	const state = makeLoginState();
	const page = makePage(state, state.ownerNavigations);
	const requests: InteractionRequest[] = [];

	const ready = await ensureDoorDashSession({
		sendInteraction: async (request) => {
			requests.push(request);
			state.authenticated = true;
			return {
				request_id: request.request_id ?? "test_interaction",
				status: "success",
				type: "INTERACTION_RESPONSE",
			};
		},
		context: page.context(),
		credentials: {},
		page,
	});

	assert.equal(ready, true);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.kind, "manual_action");
	assert.match(requests[0]?.message ?? "", /sign in to DoorDash/i);
	assert.deepEqual(state.ownerNavigations, [ORDERS_URL, ORDERS_URL]);
	assert.deepEqual(state.readinessNavigations, []);
});

test("ensureDoorDashSession hands a CAPTCHA recovery surface to the owner and resumes after Continue plus live probe", async () => {
	const state = makeLoginState();
	const page = makePage(state, state.ownerNavigations);
	const requests: InteractionRequest[] = [];

	const ready = await ensureDoorDashSession({
		sendInteraction: async (request) => {
			requests.push(request);
			state.authenticated = true;
			return {
				request_id: request.request_id ?? "test_interaction",
				status: "success",
				type: "INTERACTION_RESPONSE",
			};
		},
		capture: null,
		context: page.context(),
		credentials: {
			DOORDASH_PASSWORD: "fixture-password",
			DOORDASH_USERNAME: "owner@example.test",
		},
		fieldTimeoutMs: 0,
		page,
	});

	assert.equal(ready, true);
	assert.equal(requests.length, 1);
	assert.equal(requests[0]?.kind, "manual_action");
	assert.match(requests[0]?.message ?? "", /Cloudflare is showing a challenge/);
	assert.ok(state.ownerNavigations.includes(LOGIN_URL));
	assert.deepEqual(state.readinessNavigations, []);
});

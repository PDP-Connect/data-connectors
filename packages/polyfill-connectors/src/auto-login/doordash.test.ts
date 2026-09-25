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

function rejectUnexpectedInteraction(
	request: InteractionRequest,
): Promise<never> {
	return Promise.reject(
		new Error(`unexpected ${request.kind} interaction during automatic resume`),
	);
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

test("ensureDoorDashSession auto-resumes initial owner login from a temporary orders probe", async () => {
	const state = makeLoginState();
	const page = makePage(state, state.ownerNavigations);
	const completions: { id: string; status: string }[] = [];
	const assistanceMessages: string[] = [];

	const ready = await ensureDoorDashSession({
		assist: async (request) => {
			assistanceMessages.push(request.message);
			state.authenticated = true;
			return "doordash-login-assistance";
		},
		completeAssistance: async (id, status) => {
			completions.push({ id, status });
		},
		context: page.context(),
		credentials: {},
		page,
		sendInteraction: rejectUnexpectedInteraction,
	});

	assert.equal(ready, true);
	assert.equal(completions.length, 1);
	assert.deepEqual(completions[0], {
		id: "doordash-login-assistance",
		status: "resolved",
	});
	assert.match(assistanceMessages[0] ?? "", /sign in to DoorDash/i);
	assert.deepEqual(state.ownerNavigations, [ORDERS_URL]);
	assert.deepEqual(state.readinessNavigations, [ORDERS_URL]);
});

test("ensureDoorDashSession hands a CAPTCHA recovery surface to the owner and auto-resumes after login", async () => {
	const state = makeLoginState();
	const page = makePage(state, state.ownerNavigations);
	const completions: { id: string; status: string }[] = [];
	const assistanceMessages: string[] = [];

	const ready = await ensureDoorDashSession({
		assist: async (request) => {
			assistanceMessages.push(request.message);
			state.authenticated = true;
			return "doordash-challenge-assistance";
		},
		capture: null,
		completeAssistance: async (id, status) => {
			completions.push({ id, status });
		},
		context: page.context(),
		credentials: {
			DOORDASH_PASSWORD: "fixture-password",
			DOORDASH_USERNAME: "owner@example.test",
		},
		fieldTimeoutMs: 0,
		page,
		sendInteraction: rejectUnexpectedInteraction,
	});

	assert.equal(ready, true);
	assert.equal(completions.length, 1);
	assert.deepEqual(completions[0], {
		id: "doordash-challenge-assistance",
		status: "resolved",
	});
	assert.match(
		assistanceMessages[0] ?? "",
		/Cloudflare is showing a challenge/,
	);
	assert.ok(state.ownerNavigations.includes(LOGIN_URL));
	assert.deepEqual(state.readinessNavigations, [ORDERS_URL]);
});

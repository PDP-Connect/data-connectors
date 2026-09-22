// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoginChallengeUrl } from "./doordash.ts";

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

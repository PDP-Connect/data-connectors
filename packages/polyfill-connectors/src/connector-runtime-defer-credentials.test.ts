// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldDeferCredentialsToProbe } from "./connector-runtime.ts";

const fn = async (): Promise<boolean> => true;
const auth = { kind: "env", required: ["X_USERNAME", "X_PASSWORD"] };

test("defers credentials for a browser connector with auth and probeSession only", () => {
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth,
			browser: {},
			ensureSession: undefined,
			probeSession: fn,
		}),
		true,
	);
});

test("defers credentials when ensureSession is also declared AND probeSessionIsAuthoritative is set (heb shape): establishSession probes first", () => {
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth,
			browser: {},
			ensureSession: fn,
			probeSession: fn,
			probeSessionIsAuthoritative: true,
		}),
		true,
	);
});

test("keeps credentials eager when ensureSession is declared but probeSessionIsAuthoritative is NOT set (doordash/wholefoods shape)", () => {
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth,
			browser: {},
			ensureSession: fn,
			probeSession: fn,
		}),
		false,
	);
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth,
			browser: {},
			ensureSession: fn,
			probeSession: fn,
			probeSessionIsAuthoritative: false,
		}),
		false,
	);
});

test("keeps credentials eager without a probe, without auth, or without a browser", () => {
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth,
			browser: {},
			ensureSession: undefined,
			probeSession: undefined,
		}),
		false,
	);
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth: undefined,
			browser: {},
			ensureSession: undefined,
			probeSession: fn,
		}),
		false,
	);
	assert.equal(
		shouldDeferCredentialsToProbe({
			auth,
			browser: undefined,
			ensureSession: undefined,
			probeSession: fn,
		}),
		false,
	);
});

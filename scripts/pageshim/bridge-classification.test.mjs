// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Bridge failures reach DONE, the run error and logs as a fixed class. These
// cases drive the bridge proxy with hostile exceptions: the leak oracle is an
// invented row value that must never come back out.
import assert from "node:assert/strict";
import test from "node:test";
import { withBridgeCallTimeout } from "./runtime.ts";

const LEAK = "ACME-4417";
const wrap = (shim) => withBridgeCallTimeout(shim, () => undefined);
const rejection = async (run) => {
	try {
		await run();
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
};

test("a host rejection of a non-setData call becomes a fixed class", async () => {
	const page = wrap({
		evaluate: async () => {
			throw new Error(`host echoed ${LEAK}`);
		},
	});
	const error = await rejection(() => page.evaluate("1"));
	assert.equal(error.message, "bridge_rejected (Error)");
	assert.equal(String(error.stack).includes(LEAK), false);
});

test("a throwing name getter still classifies", async () => {
	const hostile = new Error(`row ${LEAK}`);
	Object.defineProperty(hostile, "name", {
		get() {
			throw new Error(LEAK);
		},
	});
	const page = wrap({
		setData: async () => {
			throw hostile;
		},
	});
	const error = await rejection(() => page.setData("k", {}));
	assert.equal(error.message, "bridge_rejected (other)");
	assert.equal(error.message.includes(LEAK), false);
});

test("a throwing property lookup still classifies", async () => {
	const page = wrap(
		new Proxy(
			{},
			{
				get() {
					throw new Error(`lookup ${LEAK}`);
				},
			},
		),
	);
	const error = await rejection(async () => page.setData);
	assert.equal(error.message, "bridge_rejected (Error)");
});

test("an exception that is not an object classifies as other", async () => {
	const page = wrap({
		setData: async () => {
			throw `raw ${LEAK}`;
		},
	});
	assert.equal(
		(await rejection(() => page.setData("k", {}))).message,
		"bridge_rejected (other)",
	);
	const nothing = wrap({
		setData: async () => {
			throw null;
		},
	});
	assert.equal(
		(await rejection(() => nothing.setData("k", {}))).message,
		"bridge_rejected (other)",
	);
});

test("an unlisted error name is reported as other", async () => {
	const named = Object.assign(new Error(LEAK), { name: `Custom${LEAK}` });
	const page = wrap({
		setData: async () => {
			throw named;
		},
	});
	assert.equal(
		(await rejection(() => page.setData("k", {}))).message,
		"bridge_rejected (other)",
	);
});

test("a host rejection during the login wait becomes a fixed class", async () => {
	const page = wrap({
		promptUser: async () => {
			throw new Error(`login wait failed for ${LEAK}`);
		},
	});
	const error = await rejection(() =>
		page.promptUser("Sign in", async () => false, 2000),
	);
	assert.equal(error.message, "login_wait_failed (Error)");
	assert.equal(String(error.stack).includes(LEAK), false);
});

test("the host's login-wait expiry stays a login failure and names the timeout", async () => {
	const expiry = Object.assign(new Error(`gave up waiting ${LEAK}`), {
		name: "TimeoutError",
	});
	const page = wrap({
		promptUser: async () => {
			throw expiry;
		},
	});
	const error = await rejection(() =>
		page.promptUser("Sign in", async () => false, 2000),
	);
	assert.equal(error.message, "login_wait_failed (TimeoutError)");
});

test("a synchronous requestedScopes exception becomes a fixed class", () => {
	const page = wrap({
		requestedScopes: () => {
			throw new Error(`scopes failed for ${LEAK}`);
		},
	});
	let thrown;
	try {
		page.requestedScopes();
	} catch (error) {
		thrown = error;
	}
	assert.equal(thrown?.message, "bridge_rejected (Error)");
	assert.equal(String(thrown?.stack).includes(LEAK), false);
});

test("requestedScopes still returns the host's scopes synchronously", () => {
	const page = wrap({ requestedScopes: () => ["chatgpt.conversations"] });
	assert.deepEqual(page.requestedScopes(), ["chatgpt.conversations"]);
});

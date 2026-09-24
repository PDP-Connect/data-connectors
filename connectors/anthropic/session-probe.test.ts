// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { probeAnthropicSession } from "./index.ts";

function makeArgs(
	cookies: Array<{ name: string; value: string }>,
	goto?: () => Promise<unknown>,
) {
	const navigations: Array<{ url: string; options: unknown }> = [];
	return {
		navigations,
		args: {
			context: { cookies: async () => cookies },
			page: {
				goto: async (url: string, options: unknown) => {
					navigations.push({ url, options });
					return goto?.();
				},
			},
		} as never,
	};
}

test("dead Claude cookie probe opens login origin for manual handoff", async () => {
	const { args, navigations } = makeArgs([]);
	assert.equal(await probeAnthropicSession(args), false);
	assert.deepEqual(navigations, [
		{
			url: "https://claude.ai/new",
			options: { waitUntil: "domcontentloaded" },
		},
	]);
});

test("Claude login-origin navigation failure propagates", async () => {
	const failure = new Error("navigation failed");
	const { args, navigations } = makeArgs([], async () => {
		throw failure;
	});
	await assert.rejects(
		probeAnthropicSession(args),
		(error) => error === failure,
	);
	assert.equal(navigations.length, 1);
});

test("live Claude cookie probe leaves the current page alone", async () => {
	const { args, navigations } = makeArgs([
		{ name: "sessionKey", value: "synthetic" },
	]);
	assert.equal(await probeAnthropicSession(args), true);
	assert.deepEqual(navigations, []);
});

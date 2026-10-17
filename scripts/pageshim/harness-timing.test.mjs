// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runHarness } from "./harness.mjs";

async function scenario(t, source) {
	const root = await mkdtemp(join(tmpdir(), "pageshim-timing-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const bundle = join(root, "bundle.js");
	await writeFile(bundle, `\n(async () => {\n${source}\n})();\n`);
	return {
		bundle,
		scopes: [],
		resultSpoolDirectory: join(root, "results"),
		fixtures: {
			hosts: /^https:\/\/fixture\.invalid\//,
			loginUrl: "https://fixture.invalid/login",
			homeUrl: "https://fixture.invalid/home",
			setLoggedIn() {},
			resolve() {
				return {
					status: 200,
					contentType: "text/html",
					body: "<!doctype html><p id='ready'>fixture ready</p>",
				};
			},
		},
	};
}

test("a frozen fixture calendar cannot freeze a login deadline", {
	timeout: 30_000,
}, async (t) => {
	const options = await scenario(
		t,
		`
		await page.setData("calendar", Date.now());
		await page.promptUser("sign in", async () => false, 10);
	`,
	);
	const fixed = Date.parse("2026-10-17T12:00:00Z");
	const result = await runHarness({
		...options,
		clockNowMs: fixed,
		loginWaitMs: 50,
		loginAfterMs: Number.POSITIVE_INFINITY,
	});
	assert.equal(result.data.calendar, fixed, "the page still sees the fixed date");
	assert.deepEqual(result.ret, { ok: false, error: "login wait timed out" });
	assert.ok(result.elapsedMs >= 50, "the deadline ran on real elapsed time");
});

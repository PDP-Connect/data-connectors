// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFixtureHarness, runHarness } from "./harness.mjs";

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

test("fixture readiness keeps a run's results and skips the fixed navigation delay", {
	timeout: 30_000,
}, async (t) => {
	const options = await scenario(
		t,
		`
		await page.goto("https://fixture.invalid/home");
		await page.setData("ready", await page.evaluate(
			"document.querySelector('#ready').textContent"));
	`,
	);
	const authentic = await runHarness(options);
	const fast = await runFixtureHarness(options);
	assert.deepEqual(authentic.ret, { ok: true });
	assert.deepEqual(fast.ret, authentic.ret);
	assert.deepEqual(fast.data, authentic.data);
	assert.deepEqual(fast.calls, authentic.calls);
	assert.deepEqual(fast.pageNavigations, authentic.pageNavigations);
	assert.equal(fast.data.ready, "fixture ready");
	assert.ok(
		authentic.elapsedMs >= 2_000,
		"the authentic path waits the 2 s navigation delay once per goto",
	);
	assert.ok(
		fast.elapsedMs < authentic.elapsedMs - 1_000,
		`readiness should save most of the delay: ${fast.elapsedMs} ms against ${authentic.elapsedMs} ms`,
	);
});

test("an explicit timing control keeps the authentic navigation delay", {
	timeout: 30_000,
}, async (t) => {
	const options = await scenario(
		t,
		'await page.goto("https://fixture.invalid/home");',
	);
	const result = await runFixtureHarness({ ...options, gotoDelayMs: 300 });
	assert.deepEqual(result.ret, { ok: true });
	assert.ok(result.elapsedMs >= 300, "the explicit delay is not removed");
});

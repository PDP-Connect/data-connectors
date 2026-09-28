// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Gate for the pageshim build target: build each enabled connector and run
// it in the PageShim harness against recorded fixtures.
//
// run: node --test scripts/pageshim/pageshim.test.mjs  (needs Playwright Chromium)

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { buildPageshim } from "./build.mjs";
import { githubBrowserFixtures } from "./fixtures/github_browser.mjs";
import { runHarness } from "./harness.mjs";

const out = mkdtempSync(join(tmpdir(), "pageshim-"));
const GITHUB_SCOPES = [
	"profile",
	"repositories",
	"starred",
	"events",
	"contributions",
	"history",
].map((s) => `github.${s}`);
let github;

before(async () => {
	github = await buildPageshim({
		connector: "github_browser",
		outfile: join(out, "github_browser.js"),
	});
});

function assertCompleteGithubRun(run) {
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assert.equal(run.data.error, undefined);
	assert.deepEqual(
		run.stubHits,
		[],
		"the bundle called a Node-only stub or a missing Page member",
	);
	assert.deepEqual(run.result.errors, []);
	for (const scope of GITHUB_SCOPES)
		assert.ok(run.result[scope], `missing ${scope}`);
	// Legacy github-1.5.0.js shape: details is an object of counts, not a string.
	assert.deepEqual(run.result.exportSummary, {
		count: 2,
		label: "items",
		details: { repositories: 1, starred: 0, events: 1, contributions: 1234 },
	});
}

test("github_browser bundle stubs only Node-only modules", () => {
	assert.deepEqual(github.stubbed, [
		"crypto",
		"fs",
		"fs/promises",
		"os",
		"patchright",
		"readline",
	]);
});

test("github_browser signed in: 6/6 scopes", { timeout: 120_000 }, async () => {
	const run = await runHarness({
		bundle: github.outfile,
		fixtures: githubBrowserFixtures,
		scopes: GITHUB_SCOPES,
	});
	assertCompleteGithubRun(run);
	assert.equal(
		run.calls.showBrowser,
		undefined,
		"a signed-in run must not ask for login",
	);
});

test("github_browser signed out, then sign-in: 6/6 scopes", {
	timeout: 180_000,
}, async () => {
	const run = await runHarness({
		bundle: github.outfile,
		fixtures: githubBrowserFixtures,
		scopes: GITHUB_SCOPES,
		loginAfterMs: 5000,
	});
	assertCompleteGithubRun(run);
	assert.equal(run.calls.showBrowser, 1);
	assert.equal(run.calls.promptUser, 1);
	assert.equal(run.calls.goHeadless, 1);
});

test("harness rejects a page member the host does not offer", {
	timeout: 60_000,
}, async () => {
	const bundle = join(out, "negative.js");
	writeFileSync(
		bundle,
		"(async () => {\n  await page.requestInput({});\n})();\n",
	);
	const run = await runHarness({
		bundle,
		fixtures: githubBrowserFixtures,
		scopes: [],
	});
	assert.equal(run.ret.ok, false);
	assert.match(
		run.ret.error,
		/page\.requestInput is not part of the PageShim API/,
	);
});

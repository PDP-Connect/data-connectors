// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Gate for the pageshim build target: build each enabled connector and run
// it in the PageShim harness against recorded fixtures. Every name in
// PAGESHIM_CONNECTORS needs scripts/pageshim/fixtures/<name>.mjs exporting
// `pageshimCase`; a connector without one fails here.
//
// run: node --test scripts/pageshim/pageshim.test.mjs  (needs Playwright Chromium)

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildPageshim, PAGESHIM_CONNECTORS } from "./build.mjs";
import { runHarness } from "./harness.mjs";

const out = mkdtempSync(join(tmpdir(), "pageshim-"));
const NODE_ONLY = new Set([
	"crypto",
	"fs",
	"fs/promises",
	"os",
	"patchright",
	"readline",
]);
const manifestVersion = (name) =>
	JSON.parse(
		readFileSync(
			new URL(`../../connectors/${name}/manifest.json`, import.meta.url),
			"utf8",
		),
	).version;

function assertCleanRun(run) {
	assert.deepEqual(
		run.stubHits,
		[],
		"the bundle called a Node-only stub or a missing Page member",
	);
}

function assertFatal(run, c, name, { errorClass, phase, requestedScopes }) {
	assert.deepEqual(run.ret, { ok: true }, run.log.slice(-20).join("\n"));
	assertCleanRun(run);
	// Legacy shape: an empty result whose only error is the fatal one.
	assert.deepEqual(run.result.requestedScopes, requestedScopes);
	assert.equal(run.result.version, manifestVersion(name));
	assert.deepEqual(run.result.exportSummary, c.emptyExportSummary);
	assert.equal(run.result.errors.length, 1, JSON.stringify(run.result.errors));
	const [error] = run.result.errors;
	assert.deepEqual(Object.keys(error), [
		"errorClass",
		"reason",
		"disposition",
		"phase",
	]);
	assert.equal(error.errorClass, errorClass);
	assert.equal(error.disposition, "fatal");
	assert.equal(error.phase, phase);
	assert.equal(run.data.error, error.reason);
	for (const scope of c.scopes) assert.equal(run.result[scope], undefined);
}

for (const name of PAGESHIM_CONNECTORS) {
	test(`${name}: pageshim gate`, { timeout: 600_000 }, async (t) => {
		let c;
		try {
			({ pageshimCase: c } = await import(`./fixtures/${name}.mjs`));
		} catch (error) {
			assert.fail(`${name} has no fixtures/${name}.mjs: ${error.message}`);
		}
		assert.ok(c, `fixtures/${name}.mjs must export pageshimCase`);
		const built = await buildPageshim({
			connector: name,
			outfile: join(out, `${name}.js`),
		});
		const run = (o) =>
			runHarness({ bundle: built.outfile, fixtures: c.fixtures, ...o });

		await t.test("stubs only Node-only modules", () => {
			for (const spec of built.stubbed)
				assert.ok(NODE_ONLY.has(spec), `unexpected stub: ${spec}`);
		});

		const assertComplete = (r) => {
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assert.equal(r.data.error, undefined);
			assertCleanRun(r);
			assert.deepEqual(r.result.errors, []);
			for (const scope of c.scopes)
				assert.ok(r.result[scope], `missing ${scope}`);
			assert.deepEqual(r.result.exportSummary, c.exportSummary);
			// The export version is the connector manifest's semver.
			assert.equal(r.result.version, manifestVersion(name));
		};

		await t.test("signed in: every scope", async () => {
			const r = await run({ scopes: c.scopes });
			assertComplete(r);
			assert.equal(r.calls.showBrowser, undefined, "must not ask for login");
		});

		await t.test("signed out, then sign-in: every scope", async () => {
			const r = await run({ scopes: c.scopes, loginAfterMs: 5000 });
			assertComplete(r);
			assert.equal(r.calls.showBrowser, 1);
			assert.equal(r.calls.promptUser, 1);
			assert.equal(r.calls.goHeadless, 1);
		});

		await t.test("empty requestedScopes: protocol_violation", async () => {
			const r = await run({ scopes: [] });
			assertFatal(r, c, name, {
				errorClass: "protocol_violation",
				phase: "init",
				requestedScopes: c.scopes,
			});
		});

		await t.test("foreign requestedScopes: protocol_violation", async () => {
			const r = await run({ scopes: [c.scopes[0], "other.thing"] });
			assertFatal(r, c, name, {
				errorClass: "protocol_violation",
				phase: "init",
				requestedScopes: c.scopes,
			});
		});

		await t.test("login wait runs out: auth_failed", async () => {
			const r = await run({
				scopes: c.scopes,
				loginAfterMs: Number.POSITIVE_INFINITY,
				loginWaitMs: 3000,
			});
			assertFatal(r, c, name, {
				errorClass: "auth_failed",
				phase: "collect",
				requestedScopes: c.scopes,
			});
		});
	});
}

test("github_browser: an incomplete stream is an omitted error", {
	timeout: 180_000,
}, async () => {
	const { pageshimCase: c, resolveFixture } = await import(
		"./fixtures/github_browser.mjs"
	);
	const built = await buildPageshim({
		connector: "github_browser",
		outfile: join(out, "github_browser-skip.js"),
	});
	// Starred page that parses to nothing usable.
	const resolve = (raw) => {
		const u = new URL(raw);
		return u.pathname === "/stars/sample-user" ||
			u.searchParams.get("tab") === "stars"
			? { status: 500, contentType: "text/html", body: "<html></html>" }
			: resolveFixture(raw);
	};
	const r = await runHarness({
		bundle: built.outfile,
		fixtures: { ...c.fixtures, resolve },
		scopes: c.scopes,
	});
	assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
	assertCleanRun(r);
	assert.equal(r.result["github.starred"], undefined);
	assert.deepEqual(r.result.errors, [
		{
			errorClass: "runtime_error",
			reason: "GitHub did not return a complete result for this stream.",
			disposition: "omitted",
			scope: "github.starred",
			phase: "collect",
		},
	]);
});

test("harness rejects a page member the host does not offer", {
	timeout: 60_000,
}, async () => {
	const { pageshimCase: c } = await import("./fixtures/github_browser.mjs");
	const bundle = join(out, "negative.js");
	writeFileSync(
		bundle,
		"(async () => {\n  await page.requestInput({});\n})();\n",
	);
	const run = await runHarness({ bundle, fixtures: c.fixtures, scopes: [] });
	assert.equal(run.ret.ok, false);
	assert.match(
		run.ret.error,
		/page\.requestInput is not part of the PageShim API/,
	);
});

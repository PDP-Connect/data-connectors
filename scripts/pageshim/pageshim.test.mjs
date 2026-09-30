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
import { desktopRecords } from "./fixtures/anthropic-desktop.mjs";
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

test("oura_browser: PageShim preserves required-window failures", {
	timeout: 180_000,
}, async () => {
	const fx = await import("./fixtures/oura_browser.mjs");
	fx.setDailyDataStatus(500);
	try {
		const built = await buildPageshim({
			connector: "oura_browser",
			outfile: join(out, "oura-browser-failure.js"),
		});
		const r = await runHarness({
			bundle: built.outfile,
			fixtures: fx.pageshimCase.fixtures,
			scopes: fx.pageshimCase.scopes,
		});
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assert.equal(r.data.status.startsWith("Partial:"), true);
		assert.equal(r.result.errors.length, 3);
		assert.ok(r.result.errors.every((e) => e.errorClass === "partial"));
	} finally {
		fx.setDailyDataStatus(200);
	}
});

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

test("anthropic shim copies the desktop ZIP entry-name regexes exactly", () => {
	const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
	const desktop = source(
		"../../packages/polyfill-connectors/src/bounded-zip-archive.ts",
	);
	const shim = source("./shims/anthropic-export.ts");
	for (const name of [
		"UNSAFE_ZIP_ENTRY_NAME_RE",
		"WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE",
	]) {
		const literal = (text) =>
			text.match(new RegExp(`const ${name} =\\s*(/.+/[a-z]*);`))?.[1];
		assert.ok(literal(desktop), `${name} not found in bounded-zip-archive.ts`);
		assert.equal(literal(shim), literal(desktop), name);
	}
});

test("anthropic: export paths on the PageShim host", {
	timeout: 300_000,
}, async (t) => {
	const fx = await import("./fixtures/anthropic.mjs");
	const c = fx.pageshimCase;
	const built = await buildPageshim({
		connector: "anthropic",
		outfile: join(out, "anthropic-paths.js"),
	});
	const run = (o) => {
		fx.reset(o);
		return runHarness({
			bundle: built.outfile,
			fixtures: c.fixtures,
			scopes: c.scopes,
		});
	};
	const assertFatalReason = (r, pattern) => {
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assertCleanRun(r);
		assert.equal(r.result.errors.length, 1, JSON.stringify(r.result.errors));
		assert.equal(r.result.errors[0].disposition, "fatal");
		assert.match(r.result.errors[0].reason, pattern);
		assert.equal(r.data.error, r.result.errors[0].reason);
		for (const scope of c.scopes) assert.equal(r.result[scope], undefined);
	};

	const streams = c.scopes.map((scope) => scope.replace(/^claude\./, ""));
	const pageshimRecords = (r) =>
		Object.fromEntries(
			c.scopes.map((scope) => [
				scope,
				(r.result[scope]?.records ?? []).map(({ blob_ref: _, ...x }) => x),
			]),
		);

	await t.test("records deep-equal the desktop collectAnthropic", async () => {
		const r = await run();
		assertCleanRun(r);
		assert.deepEqual(r.result.errors, []);
		assert.equal(r.calls.captureDownload, 1);
		assert.equal(r.calls.extractZipEntries, 1);
		assert.deepEqual(fx.counts, { exportRequests: 1, mints: 1 });
		// No blob store on this host, so no blob_ref.
		for (const x of r.result["claude.conversations"].records)
			assert.equal(x.blob_ref, undefined);
		const desktop = await desktopRecords(fx.syntheticExport, streams);
		assert.deepEqual(
			Object.fromEntries(
				streams.map((s) => [s, desktop[`claude.${s}`].length]),
			),
			c.exportSummary.details,
		);
		assert.deepEqual(pageshimRecords(r), desktop);
	});

	// Archives the desktop reader refuses. The shim must refuse them too.
	const refused = {
		"a duplicate entry name": [
			["conversations.json", []],
			["conversations.json", []],
		],
		"a traversal entry name": [
			["../evil.json", {}],
			["conversations.json", []],
		],
		"an absolute entry name": [
			["/abs.json", {}],
			["conversations.json", []],
		],
		"an entry that does not inflate": [
			["conversations.json", Buffer.from([0xff, 0xff, 0xff, 0xff])],
		],
	};
	for (const [label, entries] of Object.entries(refused))
		await t.test(`${label}: fatal, as on desktop`, async () => {
			const zip = fx.zipOf(entries);
			await assert.rejects(desktopRecords(zip, streams));
			assertFatalReason(await run({ zip }), /./);
		});

	await t.test("layout not recognized: fail closed, no records", async () => {
		const r = await run({
			zip: fx.zipOf({
				"memories.json": [{ id: "m1" }],
				"users.json": [{ uuid: "u1" }],
			}),
		});
		assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
		assertCleanRun(r);
		assert.equal(r.data.error, undefined);
		for (const scope of c.scopes) assert.equal(r.result[scope], undefined);
		assert.deepEqual(
			r.result.errors.map((e) => [e.scope, e.disposition]),
			c.scopes.map((s) => [s, "omitted"]),
		);
		for (const e of r.result.errors)
			assert.match(e.reason, /does not claim the account is empty/);
		assert.deepEqual(r.result.exportSummary, c.emptyExportSummary);
	});

	await t.test(
		"export not ready, then ready: polls the same nonce",
		async () => {
			const r = await run({ notReadyPolls: 1 });
			assertCleanRun(r);
			assert.deepEqual(r.result.errors, []);
			assert.deepEqual(r.result.exportSummary, c.exportSummary);
			assert.equal(r.calls.captureDownload, 2);
			assert.deepEqual(fx.counts, { exportRequests: 1, mints: 2 });
		},
	);

	await t.test("spent nonce: the host error ends the run", async () => {
		const r = await run({ mintFailure: { error: "nonce consumed" } });
		assertFatalReason(r, /could not be downloaded \(consumed\)/);
		assert.equal(r.calls.captureDownload, 1);
	});

	await t.test("multi-part export format: fatal, named", async () => {
		const r = await run({ exportFormat: "new" });
		assertFatalReason(r, /multi-part export format/);
		assert.equal(r.calls.captureDownload, undefined);
		// The storage URL is never loaded in the WebView.
		assert.ok(
			!r.log.some((l) => l.includes("claude-export.test")),
			r.log.join("\n"),
		);
		assert.equal(r.calls.goto, 1);
	});
});

test("strava_browser: records and fail-closed paths on the PageShim host", {
	timeout: 180_000,
}, async (t) => {
	const { pageshimCase: c, resolveFixture } = await import(
		"./fixtures/strava_browser.mjs"
	);
	const built = await buildPageshim({
		connector: "strava_browser",
		outfile: join(out, "strava_browser-paths.js"),
	});
	const run = (resolve = resolveFixture) =>
		runHarness({
			bundle: built.outfile,
			fixtures: { ...c.fixtures, resolve },
			scopes: c.scopes,
		});

	await t.test(
		"activities cross as live records",
		async () => {
			const r = await run();
			assertCleanRun(r);
			assert.deepEqual(r.result.errors, []);
			const activities = r.result["strava.activities"].records;
			assert.deepEqual(
				activities.map((a) => [a.id, a.activity_type, a.freshness]),
				[
					["90000000005", "Ride", "live"],
					["90000000004", "Run", "live"],
					["90000000003", "Yoga", "live"],
					["90000000002", "EBikeRide", "live"],
					["90000000001", "Swim", "live"],
				],
			);
		},
	);

	await t.test(
		"an unrecognised list fails closed: no activities, one omitted error",
		async () => {
			const r = await run((raw) =>
				new URL(raw).pathname === "/athlete/training_activities"
					? {
							status: 200,
							contentType: "application/json",
							body: '{"activities":[]}',
						}
					: resolveFixture(raw),
			);
			assert.deepEqual(r.ret, { ok: true }, r.log.slice(-20).join("\n"));
			assertCleanRun(r);
			assert.equal(r.result["strava.activities"], undefined);
			assert.equal(r.result.errors.length, 1, JSON.stringify(r.result.errors));
			assert.equal(r.result.errors[0].scope, "strava.activities");
			assert.equal(r.result.errors[0].disposition, "omitted");
			assert.deepEqual(r.result.exportSummary, c.emptyExportSummary);
		},
	);
});

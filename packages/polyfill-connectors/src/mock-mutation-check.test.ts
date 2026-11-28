// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findPathLiteralSites } from "../scripts/mock-mutation-check.ts";
import { packageRoot } from "./connector-paths.ts";

test("findPathLiteralSites: detects === string-equality path matchers", () => {
	const source = ['if (path === "/System/Info") {', "  respond();", "}"].join(
		"\n",
	);
	const sites = findPathLiteralSites("fake.test.ts", source);
	assert.deepEqual(
		sites.map((s) => s.literal),
		["/System/Info"],
	);
	assert.equal(sites[0]?.line, 1);
});

test("findPathLiteralSites: detects .startsWith and .includes path matchers", () => {
	const source = [
		'if (path.startsWith("/api/")) {',
		"  return notFound();",
		"}",
		'if (path.includes("/Users/test-user-123/Items")) {',
		"  return items();",
		"}",
	].join("\n");
	const sites = findPathLiteralSites("fake.test.ts", source);
	assert.deepEqual(
		sites.map((s) => s.literal),
		["/api/", "/Users/test-user-123/Items"],
	);
});

test("findPathLiteralSites: ignores comment lines quoting a path", () => {
	const source = [
		"// Jellyfin serves its REST API at the root, NOT under /api/ — a request",
		"// path with that prefix indicates a regression to a URL shape that 404s.",
		" * See /api/ for background.",
		'if (path === "/System/Info") {',
		"  respond();",
		"}",
	].join("\n");
	const sites = findPathLiteralSites("fake.test.ts", source);
	assert.deepEqual(
		sites.map((s) => s.literal),
		["/System/Info"],
		"commented-out path mentions must not be treated as executable matchers",
	);
});

test("findPathLiteralSites: ignores non-path string literals and non-matcher comparisons", () => {
	const source = [
		'const label = "not a path";',
		'assert.equal(status, "ok");',
		'const greeting = "/not/really/checked" + suffix;', // string concat — not a matcher shape
	].join("\n");
	const sites = findPathLiteralSites("fake.test.ts", source);
	assert.deepEqual(
		sites,
		[],
		"no `===`, `.startsWith(...)`, or `.includes(...)` path-matcher shape is present",
	);
});

test("findPathLiteralSites: returns empty for a file with zero path literals (the UNKNOWN case)", () => {
	const source = [
		"const fetchStub = () => Promise.resolve({ ok: true });",
		"test('does nothing HTTP-shaped', () => {});",
	].join("\n");
	assert.deepEqual(findPathLiteralSites("fake.test.ts", source), []);
});

test("findPathLiteralSites: records the correct file and 1-indexed line for a multi-line file", () => {
	const source = ["", "", 'if (url === "/Users/Me") {', "  ok();", "}"].join(
		"\n",
	);
	const sites = findPathLiteralSites(
		"connectors/jellyfin/integration.test.ts",
		source,
	);
	assert.deepEqual(sites, [
		{
			file: "connectors/jellyfin/integration.test.ts",
			line: 3,
			literal: "/Users/Me",
		},
	]);
});

const fixtureCases = [
	{
		key: "assertion",
		source: `test("asserts real request path", () => assert.ok(matchesPath));`,
		verdict: "PASS",
		loadBearing: 1,
		detail: /load-bearing/,
	},
	{
		key: "survivor",
		source: `test("does not depend on request path", () => assert.equal(typeof matchesPath, "boolean"));`,
		verdict: "WEAK",
		loadBearing: 0,
		detail: /decorative/,
	},
	{
		key: "import",
		source: `
await import(matchesPath ? "node:assert/strict" : "./missing-module.mjs");
test("runs only if the import loaded", () => assert.ok(true));
`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /ERR_MODULE_NOT_FOUND/,
	},
	{
		key: "timeout",
		source: `
test("fails to finish after mutation", { timeout: 20 }, async () => {
	if (!matchesPath) await new Promise(resolve => setTimeout(resolve, 150));
});
`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /timed out/,
	},
	{
		key: "baseline",
		source: `test("already failing", () => assert.equal(matchesPath ? 1 : 2, 0));`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /baseline/,
	},
	{
		key: "skipped",
		source: `test("never ran", { skip: true }, () => assert.ok(matchesPath));`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /baseline: no tests ran and passed/,
	},
	{
		key: "different-test",
		source: `
if (matchesPath) {
	test("original test", () => assert.ok(true));
} else {
	test("different case", () => assert.ok(false));
}
`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /no failing assertion from a test that passed the baseline/,
	},
	{
		key: "same-name",
		source: `
if (matchesPath) {
	test("same name", () => assert.ok(true));
} else {
	test("same name", () => assert.ok(false));
}
`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /no failing assertion from a test that passed the baseline/,
	},
	{
		key: "same-name-and-line",
		source: `if (matchesPath) test("same name", () => assert.ok(true)); else test("same name", () => assert.ok(false));`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /no failing assertion from a test that passed the baseline/,
	},
	{
		key: "same-line-mutation",
		source: `const observed = actualPath === "/expected"; test("checks request path", () => assert.ok(observed));`,
		verdict: "PASS",
		loadBearing: 1,
		detail: /load-bearing/,
	},
	{
		key: "repeated-registration",
		source: `for (const attempt of [1, 2]) test("same registration", () => assert.ok(matchesPath, String(attempt)));`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /no failing assertion from a test that passed the baseline/,
	},
	{
		key: "mixed",
		source: `
test("checks request path", () => assert.ok(matchesPath));
test("has a separate error", () => {
	if (!matchesPath) throw new TypeError("setup unavailable");
});
`,
		verdict: "UNKNOWN",
		loadBearing: 0,
		detail: /setup unavailable/,
	},
] as const;

test("mutation CLI credits assertions only on a green baseline", () => {
	const root = mkdtempSync(join(tmpdir(), "mock-mutation-fixtures-"));
	try {
		writeFileSync(join(root, "package.json"), '{"type":"module"}');
		for (const fixture of fixtureCases) {
			const directory = join(root, "connectors", fixture.key);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "request-path.test.ts"),
				`import assert from "node:assert/strict";
import {test} from "node:test";
const actualPath = ["/", "expected"].join("");
const matchesPath = actualPath === "/expected";
${fixture.source}
`,
			);
		}
		const output = execFileSync(
			process.execPath,
			["--import", "tsx", "scripts/mock-mutation-check.ts", "--json"],
			{
				cwd: packageRoot,
				encoding: "utf8",
				env: {
					...process.env,
					NODE_TEST_CONTEXT: undefined,
					PDPP_CONNECTOR_PATHS_TEST_ROOT: root,
				},
				timeout: 30_000,
			},
		);
		const reports = JSON.parse(output) as Array<{
			connector: string;
			verdict: string;
			loadBearing: number;
			detail: string;
		}>;
		assert.equal(reports.length, fixtureCases.length);
		for (const fixture of fixtureCases) {
			const report = reports.find(({ connector }) => connector === fixture.key);
			assert.ok(report, fixture.key);
			assert.equal(
				report.verdict,
				fixture.verdict,
				`${fixture.key}: ${report.detail}`,
			);
			assert.equal(report.loadBearing, fixture.loadBearing, fixture.key);
			assert.match(report.detail, fixture.detail, fixture.key);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

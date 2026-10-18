// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Every tracked test file must run in some lane, or be listed in MANUAL with a
// reason. A test that no script, workflow, or runner glob names runs nowhere,
// so a regression in it goes unseen.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tracked test files that intentionally run in no automatic lane.
const MANUAL = new Map([
	[
		"scripts/pageshim/claude-real-size.test.mjs",
		"needs real Claude exports under ~/Downloads; run by hand",
	],
	[
		"packages/connector-installer-core/oci-live-registry.test.mjs",
		"talks to a live registry; run by hand",
	],
	[
		"connectors/github/index.test.ts",
		"imports the absent reference implementation; runs nowhere",
	],
]);

const norm = (p) => p.replace(/^\.\//, "");

function trackedTests() {
	return execFileSync("git", ["ls-files", "*.test.mjs", "*.test.ts"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean)
		.filter((f) => !f.split("/").some((s) => s === "node_modules" || s === "vendor"));
}

// Whitespace/quote-separated tokens of `text`, with leading "./" removed.
function tokens(text) {
	return new Set(text.split(/[\s"'`=]+/).map(norm));
}

function packageScriptTokens() {
	const { scripts } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
	return tokens(Object.values(scripts).join("\n"));
}

function workflowTokens() {
	const dir = path.join(root, ".github/workflows");
	const text = readdirSync(dir)
		.filter((f) => /\.ya?ml$/.test(f))
		.map((f) => readFileSync(path.join(dir, f), "utf8"))
		.flatMap((t) => t.split("\n"))
		.filter((line) => !line.trimStart().startsWith("#"))
		.join("\n");
	return tokens(text);
}

function polyfillRunnerFiles() {
	const cwd = path.join(root, "packages/polyfill-connectors");
	const out = execFileSync("node", ["scripts/run-tests.mjs", "--list"], {
		cwd,
		encoding: "utf8",
	});
	return new Set(
		out
			.split("\n")
			.filter(Boolean)
			.map((f) => path.relative(root, path.resolve(cwd, f)).split(path.sep).join("/")),
	);
}

function coverage() {
	const scripts = packageScriptTokens();
	const workflows = workflowTokens();
	const runner = polyfillRunnerFiles();
	return (file) => scripts.has(file) || workflows.has(file) || runner.has(file);
}

test("every tracked test file runs in a lane or is listed as manual", () => {
	const covered = coverage();
	const orphans = trackedTests().filter((f) => !covered(f) && !MANUAL.has(f));
	assert.deepEqual(
		orphans,
		[],
		`${orphans.length} test file(s) run in no lane. Add each to a package.json script ` +
			`or workflow step, or to MANUAL in scripts/test-lanes-coverage.test.mjs with a reason:\n  ` +
			orphans.join("\n  "),
	);
});

test("MANUAL entries exist and are not covered by any lane", () => {
	const covered = coverage();
	const stale = [];
	for (const file of MANUAL.keys()) {
		if (!existsSync(path.join(root, file))) stale.push(`${file}: no longer exists`);
		else if (covered(file)) stale.push(`${file}: is covered by a lane; remove it from MANUAL`);
	}
	assert.deepEqual(stale, [], `stale MANUAL entries:\n  ${stale.join("\n  ")}`);
});

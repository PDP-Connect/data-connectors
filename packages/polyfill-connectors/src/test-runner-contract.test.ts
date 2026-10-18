// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { NAMESPACE_TESTS } from "../scripts/test-lanes.mjs";

test("package test runner bounds file concurrency and retains a finite hang guard", async () => {
	// "npm test" runs scripts/run-tests.mjs (not a literal `node --test ...` in
	// package.json) so the @pdpp/reference-contract-dependent and
	// monorepo-only files can be excluded by path; see that script's header
	// comment. The concurrency/timeout invariants this test guards live in its
	// spawn() call now, not in package.json's scripts.test string.
	// TEST_CONCURRENCY overrides the file concurrency; its default is 4.
	for (const path of [
		"../scripts/run-tests.mjs",
		"../scripts/related-tests/run.ts",
	]) {
		const runner = await readFile(new URL(path, import.meta.url), "utf8");

		assert.match(runner, /process\.env\.TEST_CONCURRENCY \?\? "4"/, path);
		assert.match(runner, /--test-concurrency=\$\{[^}`]*rawConcurrency\}/, path);
		assert.match(runner, /--test-timeout=120000/, path);
		assert.doesNotMatch(runner, /--test-timeout=30000/, path);
	}
});

test("NAMESPACE_TESTS lists exactly the files that need their own namespaces", async () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const listed: ReadonlySet<string> = NAMESPACE_TESTS;

	for (const entry of listed) {
		assert.ok(
			existsSync(`${packageRoot}${entry}`),
			`NAMESPACE_TESTS entry does not exist: ${entry}`,
		);
	}

	// The patterns run-tests.mjs globs; this file and the runner are not in them.
	const needsNamespaces =
		/namespaceSkip|bwrapUsable|unshareUsable|bindMountCapable|spawn(?:Sync)?\(\s*["'`](?:bwrap|unshare)["'`]/;
	const missing: string[] = [];
	for (const pattern of [
		"bin/**/*.test.ts",
		"../../connectors/**/*.test.ts",
		"scripts/related-tests/*.test.ts",
		"scripts/**/*.test.mjs",
		"src/**/*.test.ts",
	]) {
		for await (const entry of glob(pattern, { cwd: packageRoot })) {
			if (entry === "src/test-runner-contract.test.ts") {
				continue;
			}
			const text = await readFile(`${packageRoot}${entry}`, "utf8");
			if (needsNamespaces.test(text) && !listed.has(entry)) {
				missing.push(entry);
			}
		}
	}
	assert.deepEqual(
		missing,
		[],
		"these files need their own namespaces; add them to NAMESPACE_TESTS in scripts/test-lanes.mjs",
	);
});

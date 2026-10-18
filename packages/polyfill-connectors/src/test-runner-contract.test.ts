// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("package test runner bounds file concurrency and retains a finite hang guard", async () => {
	// "npm test" runs scripts/run-tests.mjs (not a literal `node --test ...` in
	// package.json) so the @pdpp/reference-contract-dependent and
	// monorepo-only files can be excluded by path; see that script's header
	// comment. The concurrency/timeout invariants this test guards live in its
	// spawn() call now, not in package.json's scripts.test string.
	// TEST_CONCURRENCY overrides the file concurrency; its default stays 2.
	for (const path of [
		"../scripts/run-tests.mjs",
		"../scripts/related-tests/run.ts",
	]) {
		const runner = await readFile(new URL(path, import.meta.url), "utf8");

		assert.match(runner, /process\.env\.TEST_CONCURRENCY \?\? "2"/, path);
		assert.match(runner, /--test-concurrency=\$\{rawConcurrency\}/, path);
		assert.match(runner, /--test-timeout=120000/, path);
		assert.doesNotMatch(runner, /--test-timeout=30000/, path);
	}
});

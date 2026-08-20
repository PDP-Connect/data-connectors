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
	const runner = await readFile(
		new URL("../scripts/run-tests.mjs", import.meta.url),
		"utf8",
	);

	assert.match(runner, /--test-concurrency=2/);
	assert.match(runner, /--test-timeout=120000/);
	assert.doesNotMatch(runner, /--test-timeout=30000/);
});

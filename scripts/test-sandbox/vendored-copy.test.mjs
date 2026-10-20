// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name) => readFileSync(new URL(name, import.meta.url));

test("vendored test-sandbox matches its recorded sha256", () => {
	const actual = createHash("sha256")
		.update(read("./test-sandbox"))
		.digest("hex");
	const expected = read("./test-sandbox.sha256")
		.toString("utf8")
		.trim()
		.split(/\s+/)[0];
	assert.equal(
		actual,
		expected,
		"scripts/test-sandbox/test-sandbox was edited. Do not edit it here: update the canonical copy " +
			"(dotfiles ai/skills/local/test-architecture/scripts/test-sandbox), re-copy it, " +
			"then run `sha256sum test-sandbox > test-sandbox.sha256` in scripts/test-sandbox.",
	);
});

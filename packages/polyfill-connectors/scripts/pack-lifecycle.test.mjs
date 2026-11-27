// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("pack-install-run leaves the build to prepack, which npm pack runs", async () => {
	const { scripts } = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	// `npm pack` runs prepack, and prepack builds. A second build ahead of the
	// pack repeats the same tsc run for the same output.
	assert.match(scripts.prepack, /\bnpm run build\b/);
	assert.doesNotMatch(scripts["pack-install-run"], /\bbuild\b/);
});

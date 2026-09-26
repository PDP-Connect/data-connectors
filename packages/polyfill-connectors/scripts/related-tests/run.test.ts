// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { connectorsDir } from "../../src/connector-paths.ts";
import { testFileArgument } from "./run.ts";

test("root connector test labels run from their real repo-root path", () => {
	assert.equal(
		testFileArgument("connectors/shopify/parsers.test.ts"),
		join(connectorsDir, "shopify", "parsers.test.ts"),
	);
});

test("package-local test labels stay relative to the package cwd", () => {
	assert.equal(testFileArgument("src/runtime.test.ts"), "src/runtime.test.ts");
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { manifestPath } from "../../src/connector-paths.ts";

const manifest = readFileSync(manifestPath("github"), "utf8");

test("GitHub setup copy names the profile, repository, and gist read capabilities", () => {
	for (const scope of ["read:user", "public_repo", "repo", "gist"]) {
		assert.match(
			manifest,
			new RegExp(scope.replace(".", "\\.")),
			`setup copy must mention ${scope}`,
		);
	}
});

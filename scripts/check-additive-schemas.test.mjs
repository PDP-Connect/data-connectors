// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { permitsBreakingChange } from "./check-additive-schemas.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a pre-1.0 minor bump permits a breaking schema while a patch bump does not", () => {
  assert.equal(permitsBreakingChange("0.1.0", "0.2.0"), true);
  assert.equal(permitsBreakingChange("0.1.0", "0.1.1"), false);
  assert.equal(permitsBreakingChange("1.0.0", "1.1.0"), false);
  assert.equal(permitsBreakingChange("1.0.0", "2.0.0"), true);
  assert.equal(permitsBreakingChange("0.2.0", "0.1.0"), false);
  assert.equal(permitsBreakingChange("0.1.0", "0.02.0"), false);
  assert.equal(permitsBreakingChange("1.0.0", "02.0.0"), false);
});

test("additive schema check runs over root Collection Profile manifests", () => {
  const stdout = execFileSync(process.execPath, ["scripts/check-additive-schemas.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, BASE_REF: "origin/main" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(stdout, /^Schemas additive: \d+ schema\(s\) checked\.\n$/);
});

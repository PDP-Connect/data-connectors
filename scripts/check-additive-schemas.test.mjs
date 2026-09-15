// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("additive schema check reports the registry schemas it compared", () => {
  const stdout = execFileSync(process.execPath, ["scripts/check-additive-schemas.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, BASE_REF: "origin/main" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(stdout, /^Schemas additive: \d+ schema\(s\) checked\.\n$/);
});

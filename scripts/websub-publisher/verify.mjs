// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error(`use Node 24, got ${process.version}`);
await mkdir(".runtime", { recursive: true });
for (const args of [
  ["build.mjs"],
  [
    "--test",
    "test/client-workflow.test.mjs",
    "test/service.test.mjs",
    "test/immediate.test.mjs",
    "test/rollout.test.mjs",
    "test/retry.test.mjs",
  ],
]) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

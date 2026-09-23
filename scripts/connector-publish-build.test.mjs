// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getPublishShards, PUBLISHABLE_CONNECTORS } from "./connector-publish-allowlist.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const shard = process.env.CONNECTOR_TEST_SHARD;
const selected = shard === undefined
  ? PUBLISHABLE_CONNECTORS
  : getPublishShards().find((entry) => String(entry.shard) === shard)?.connectors;
assert.ok(selected?.length, `invalid CONNECTOR_TEST_SHARD: ${shard}`);

test("C-T1 every allowlist entry builds and verifies", async (t) => {
  const temporaryRoot = process.env.RUNNER_TEMP || process.env.TMPDIR || join(homedir(), ".tmp");
  mkdirSync(temporaryRoot, { recursive: true });
  const workspace = mkdtempSync(join(temporaryRoot, "connector-publish-build-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const { manifest, connectorKey } of selected) {
    await t.test(connectorKey, () => {
      const artifact = join(workspace, manifest);
      for (const [script, args] of [
        ["build-connector-oci-artifact.mjs", [
          "--connector", manifest, "--out", artifact,
          "--esbuild", join(repoRoot, "node_modules/esbuild/lib/main.js"),
        ]],
        ["verify-connector-oci-artifact.mjs", ["--artifact", artifact]],
      ]) {
        const result = spawnSync(process.execPath, [join(repoRoot, "scripts", script), ...args], {
          cwd: repoRoot, encoding: "utf8", timeout: 300_000,
        });
        assert.equal(result.status, 0, `${manifest}: ${script}\n${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
      }
      const config = JSON.parse(readFileSync(join(artifact, "config.json"), "utf8"));
      assert.equal(config.connector_key, connectorKey, "publish repository must match built identity");
    });
  }
});

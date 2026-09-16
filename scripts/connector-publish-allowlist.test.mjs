// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONNECTOR_PUBLISH_INVENTORY, PUBLISHABLE_CONNECTORS, PUBLISH_EXCLUSIONS,
} from "./connector-publish-allowlist.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = join(repoRoot, "packages/polyfill-connectors/manifests");

test("C-T2 every non-allowlisted manifest has a recorded exclusion reason", () => {
  const files = readdirSync(manifests).filter((name) => name.endsWith(".json"));
  assert.deepEqual(
    CONNECTOR_PUBLISH_INVENTORY.map(({ manifest }) => `${manifest}.json`).sort(),
    files.sort(), "every manifest must be classified exactly once; no unknown entries",
  );
  assert.equal(new Set(CONNECTOR_PUBLISH_INVENTORY.map((row) => row.connectorKey)).size,
    CONNECTOR_PUBLISH_INVENTORY.length, "two manifests must never target the same repository");
  for (const row of CONNECTOR_PUBLISH_INVENTORY) {
    const profile = JSON.parse(readFileSync(join(manifests, `${row.manifest}.json`), "utf8"));
    assert.equal(row.connectorKey, profile.connector_key, row.manifest);
    assert.ok(profile.connector_id.endsWith(`/${row.connectorKey}`), row.manifest);
    assert.match(row.manifest, /^[a-z0-9][a-z0-9_]*$/);
    assert.match(row.connectorKey, /^[a-z0-9][a-z0-9-]{0,63}$/);
    if (!PUBLISHABLE_CONNECTORS.includes(row)) {
      assert.equal(typeof row.exclusionReason, "string", row.manifest);
      assert.ok(row.exclusionReason.trim().length > 0, row.manifest);
    }
  }
  assert.deepEqual(PUBLISH_EXCLUSIONS.map((row) => row.manifest).sort(),
    ["google_messages", "signal", "slack"]);
});

function workflow(name) {
  return readFileSync(join(repoRoot, ".github/workflows", name), "utf8")
    .split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
}

function emittedMatrix(source, option) {
  const command = source.match(new RegExp(`node scripts/connector-publish-allowlist\\.mjs ${option}[^\\n]*`));
  assert.ok(command, `workflow must execute the allowlist module with ${option}`);
  // Execute the actual command arguments from the workflow, without a shell.
  const args = command[0].trim().split(/\s+/).slice(1);
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot, encoding: "utf8", env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).include;
}

test("C-T4 the workflow matrix and the allowlist module agree", () => {
  const publish = workflow("publish-polyfill-connectors.yml");
  const gate = workflow("connector-artifact-gate.yml");
  const targets = emittedMatrix(publish, "--matrix");
  assert.deepEqual(targets, PUBLISHABLE_CONNECTORS.map(({ connectorKey, manifest }) => ({
    connector: connectorKey, manifest,
  })));
  const shards = emittedMatrix(gate, "--shard-matrix");
  const tested = shards.flatMap((row) => row.connectors.map((connector) => connector.connectorKey));
  assert.deepEqual(tested.sort(), targets.map((row) => row.connector).sort(),
    "the PR gate must cover every publish target exactly once");
  assert.equal(shards.length, 6, "six installs amortize setup over the fleet");
  assert.ok(Math.max(...shards.map((row) => row.connectors.length)) -
    Math.min(...shards.map((row) => row.connectors.length)) <= 1);
  for (const source of [publish, gate]) {
    // Only catalog-only dispatch may bypass connector enumeration; normal
    // publishes must still consume the reviewed allowlist output.
    const connectorMatrix = source.replace(
      `inputs.catalog-only && fromJSON('{"include":[{"connector":"catalog"}]}') || `,
      "",
    );
    assert.match(connectorMatrix, /matrix: \$\{\{ fromJSON\(needs\.[\w-]+\.outputs\.matrix\) \}\}/);
    assert.match(source, /matrix: \$\{\{ steps\.[\w-]+\.outputs\.matrix \}\}/);
    assert.doesNotMatch(source, /matrix:\s*\n/, "no independent inline connector matrix");
  }
  assert.match(publish, /INPUT_CONNECTOR: \$\{\{ inputs\.connector \}\}/);
  assert.match(publish, /run: node scripts\/select-publish-target\.mjs/);
  assert.match(publish, /--connector "\$\{\{ steps\.target\.outputs\.manifest \}\}"/);
  assert.match(gate, /CONNECTOR_TEST_SHARD: \$\{\{ matrix\.shard \}\}/);
  assert.match(gate, /node --test scripts\/connector-publish-build\.test\.mjs/);
  const aggregate = gate.slice(gate.indexOf("  artifact-contract:"));
  assert.match(aggregate, /needs: \[prepare, artifact-builds\]/);
  assert.match(aggregate, /if: \$\{\{ always\(\) \}\}/);
  assert.match(aggregate, /BUILD_RESULT: \$\{\{ needs\.artifact-builds\.result \}\}/);
  assert.match(aggregate, /run: test "\$BUILD_RESULT" = success/);
  assert.doesNotMatch(aggregate, /continue-on-error:/);
  assert.doesNotMatch(gate, /(?:id-token|packages): write|oras push|cosign sign/);
});

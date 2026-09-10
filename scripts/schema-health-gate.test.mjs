// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the schema health check gate: the script must exit non-zero when a
// schema is broken, and the workflow must propagate that exit code instead of
// hardcoding success.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, ".github", "workflows", "schema-health-check.yml");

function runCheck() {
  return spawnSync(
    process.execPath,
    ["scripts/schema-health-check.mjs", "--json", "--base-ref", "origin/main"],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

test("a clean tree passes the schema health check", () => {
  const result = runCheck();

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}\n${result.stderr}`);
  assert.match(result.stderr, /Schema health check PASSED/);

  const report = JSON.parse(result.stdout);
  assert.equal(report.summary.missingSchemaFile, 0);
  assert.equal(report.summary.orphanedSchemas, 0);
});

test("a missing connector schema file fails the check", () => {
  // Pick a real schema file declared by a registered connector, move it aside,
  // and confirm the check notices. Restored in the finally block.
  const baseline = JSON.parse(runCheck().stdout);
  const scope = baseline.scopes.find((entry) => entry.schemaFileExists && !entry.scope.includes(":"));
  assert.ok(scope, "expected at least one file-backed scope to perturb");

  const registry = JSON.parse(readFileSync(join(repoRoot, "registry.json"), "utf8"));
  const connector = registry.connectors.find((entry) => entry.id === scope.connector);
  const metadataPath = join(repoRoot, "connectors", connector.files.metadata);
  const schemaPath = join(dirname(metadataPath), "schemas", `${scope.scope}.json`);

  const stash = join(mkdtempSync(join(tmpdir(), "schema-gate-")), "held.json");
  copyFileSync(schemaPath, stash);
  rmSync(schemaPath);

  try {
    const result = runCheck();

    assert.equal(result.status, 1, "removing a declared schema must fail the check");
    assert.match(result.stderr, /Schema health check FAILED/);
    assert.match(result.stderr, new RegExp(scope.scope.replace(/\./g, "\\.")));

    // The report is still emitted on failure so the PR comment can render it.
    const report = JSON.parse(result.stdout);
    assert.equal(report.summary.missingSchemaFile, 1);
  } finally {
    copyFileSync(stash, schemaPath);
    rmSync(dirname(stash), { recursive: true, force: true });
  }

  // The tree is back to a passing state.
  assert.equal(runCheck().status, 0, "schema file was not restored cleanly");
});

test("an orphaned schema file fails the check", () => {
  const orphanPath = join(repoRoot, "connectors", "github", "schemas", "github.__gate_probe.json");
  writeFileSync(
    orphanPath,
    `${JSON.stringify({ scope: "github.__gate_probe", type: "object", properties: {} }, null, 2)}\n`,
  );

  try {
    const result = runCheck();

    assert.equal(result.status, 1, "an undeclared schema file must fail the check");
    assert.match(result.stderr, /Orphaned schema files/);
    assert.match(result.stderr, /github\.__gate_probe/);
  } finally {
    rmSync(orphanPath, { force: true });
  }

  assert.equal(runCheck().status, 0, "probe schema was not removed cleanly");
});

test("the exit code does not depend on the base ref", () => {
  // Several checks in this repo have failed on PRs only because the branch was
  // behind main. This one must not: --base-ref only labels scopes as new, it
  // never feeds the pass/fail decision. An unresolvable ref is the extreme
  // case — every scope looks new, and the check must still pass on a clean tree.
  for (const baseRef of ["origin/main", "HEAD", "refs/does-not-exist"]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/schema-health-check.mjs", "--json", "--base-ref", baseRef],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, `base ref ${baseRef} changed the outcome`);
  }
});

test("the workflow propagates the script's exit code", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.ok(
    !/echo\s+"?exit_code=0"?\s*>>/.test(workflow),
    "the workflow must not hardcode a passing exit code",
  );
  assert.match(
    workflow,
    /echo "exit_code=\$exit_code"/,
    "the workflow must record the script's real exit code",
  );
  assert.match(
    workflow,
    /steps\.check\.outputs\.exit_code != '0'/,
    "the workflow must fail the job when the recorded exit code is non-zero",
  );
});

test("the recorded exit code drives the job outcome", () => {
  // Executes the workflow's run block verbatim under GitHub's default shell
  // (bash -e) against a real broken tree, asserting both the step exit status
  // and the GITHUB_OUTPUT value the gating step reads.
  const workflow = readFileSync(workflowPath, "utf8");
  const block = workflow.match(/set \+e\n([\s\S]*?)\n        continue-on-error/);
  assert.ok(block, "could not locate the check step's run block");

  const script = `set +e\n${block[1]}`
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n")
    .replace(/\$\{\{ github\.base_ref \}\}/g, "main");

  const outputDir = mkdtempSync(join(tmpdir(), "schema-gate-out-"));
  const githubOutput = join(outputDir, "output.txt");
  writeFileSync(githubOutput, "");

  const orphanPath = join(repoRoot, "connectors", "github", "schemas", "github.__gate_probe2.json");
  writeFileSync(
    orphanPath,
    `${JSON.stringify({ scope: "github.__gate_probe2", type: "object" }, null, 2)}\n`,
  );

  try {
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: githubOutput },
    });

    assert.equal(result.status, 1, "the check step must exit non-zero on a broken schema");
    assert.match(readFileSync(githubOutput, "utf8"), /exit_code=1/);
  } finally {
    rmSync(orphanPath, { force: true });
    rmSync(join(repoRoot, "report.json"), { force: true });
    rmSync(join(repoRoot, "summary.txt"), { force: true });
    rmSync(outputDir, { recursive: true, force: true });
  }

  // And the same block reports success on a clean tree.
  const cleanDir = mkdtempSync(join(tmpdir(), "schema-gate-out-"));
  const cleanOutput = join(cleanDir, "output.txt");
  writeFileSync(cleanOutput, "");

  try {
    const result = spawnSync("bash", ["-e", "-c", script], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: cleanOutput },
    });

    assert.equal(result.status, 0, "the check step must pass on a clean tree");
    assert.match(readFileSync(cleanOutput, "utf8"), /exit_code=0/);
  } finally {
    rmSync(join(repoRoot, "report.json"), { force: true });
    rmSync(join(repoRoot, "summary.txt"), { force: true });
    rmSync(cleanDir, { recursive: true, force: true });
  }
});

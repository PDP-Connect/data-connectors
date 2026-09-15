// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the published-vocabulary gate in
// check-pdpp-authoring-docs.mjs. The gate's job is to reject a Collection
// Profile that publishes a binding or coverage-strategy name the executable set
// does not recognize. An earlier row parser matched only its own preferred cell
// spacing and required backticks, so three rows that Markdown renders exactly
// like the canonical ones were dropped from the extracted set and an invented
// published row passed green.
//
// These tests run the REAL script through a shadow root: every repository entry
// is symlinked except the spec document, which is a mutated real copy. The
// observed postcondition is the script's own exit status and diagnostic, not an
// assertion about its source text.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptName = "check-pdpp-authoring-docs.mjs";
const specRelativePath = join("docs", "spec", "collection-profile.md");
const spec = readFileSync(join(root, specRelativePath), "utf8");
const temporaryRoot = join(homedir(), ".tmp");
mkdirSync(temporaryRoot, { recursive: true });

/** A real binding row and a real coverage row, used as mutation anchors. */
const bindingAnchor = "| `network` | Outbound network access. |";
const coverageAnchor =
  "| `singleton_presence` | A run checks one stable singleton record. |";

/**
 * Builds a shadow repository root: symlinks to every real entry, except
 * `scripts/` and `docs/spec/` which are real directories so the spec document
 * and the script under test can be replaced with copies.
 */
function shadowRoot(mutatedSpec) {
  const shadow = mkdtempSync(join(temporaryRoot, "authoring-gate-"));
  for (const entry of readdirSync(root)) {
    if (entry === "scripts" || entry === "docs") continue;
    symlinkSync(join(root, entry), join(shadow, entry));
  }
  mkdirSync(join(shadow, "scripts"));
  for (const entry of readdirSync(join(root, "scripts"))) {
    if (entry === scriptName) continue;
    symlinkSync(join(root, "scripts", entry), join(shadow, "scripts", entry));
  }
  copyFileSync(join(root, "scripts", scriptName), join(shadow, "scripts", scriptName));
  mkdirSync(join(shadow, "docs", "spec"), { recursive: true });
  for (const entry of readdirSync(join(root, "docs"))) {
    if (entry === "spec") continue;
    symlinkSync(join(root, "docs", entry), join(shadow, "docs", entry));
  }
  for (const entry of readdirSync(join(root, "docs", "spec"))) {
    if (entry === "collection-profile.md") continue;
    symlinkSync(
      join(root, "docs", "spec", entry),
      join(shadow, "docs", "spec", entry),
    );
  }
  writeFileSync(join(shadow, specRelativePath), mutatedSpec);
  return shadow;
}

function runGate(mutatedSpec) {
  const shadow = shadowRoot(mutatedSpec);
  try {
    const result = spawnSync("node", [join(shadow, "scripts", scriptName)], {
      encoding: "utf8",
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
}

function withRowAfter(anchor, row) {
  assert.ok(spec.includes(anchor), `spec must still contain the anchor ${anchor}`);
  return spec.replace(anchor, `${anchor}\n${row}`);
}

test("the gate accepts the published spec unchanged", () => {
  const { status, output } = runGate(spec);
  assert.equal(status, 0, output);
});

for (const [name, row] of [
  ["canonical cell spacing", "| `quantum_teleport` | Unsupported binding. |"],
  ["padded code cell", "|  `quantum_teleport`  | Unsupported binding. |"],
  ["no code span", "| quantum_teleport | Unsupported binding. |"],
]) {
  test(`an invented binding row is rejected with ${name}`, () => {
    const { status, output } = runGate(withRowAfter(bindingAnchor, row));
    assert.equal(status, 1, `invented binding row passed with ${name}: ${output}`);
  });
}

for (const [name, row] of [
  ["canonical cell spacing", "| `warp_drive` | Unsupported strategy. |"],
  ["padded code cell", "|  `warp_drive`  | Unsupported strategy. |"],
  ["no code span", "| warp_drive | Unsupported strategy. |"],
]) {
  test(`an invented coverage_strategy row is rejected with ${name}`, () => {
    const { status, output } = runGate(withRowAfter(coverageAnchor, row));
    assert.equal(
      status,
      1,
      `invented coverage_strategy row passed with ${name}: ${output}`,
    );
  });
}

test("a deleted binding row is rejected", () => {
  const removed = "| `filesystem` | Local filesystem access. |\n";
  assert.ok(spec.includes(removed));
  const { status, output } = runGate(spec.replace(removed, ""));
  assert.equal(status, 1, output);
});

test("a deleted coverage_strategy row is rejected", () => {
  const removed =
    "| `full_inventory` | A run accounts for the full current source inventory. |\n";
  assert.ok(spec.includes(removed));
  const { status, output } = runGate(spec.replace(removed, ""));
  assert.equal(status, 1, output);
});

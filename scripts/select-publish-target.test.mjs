// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Executes scripts/select-publish-target.mjs against a real temporary manifest
// tree. The claim under test is an ORDERING claim — that a connector name is
// checked for syntax and allowlist membership BEFORE anything constructs a path
// or reads a file — and an ordering claim can only be tested by running the
// thing and observing what did not happen.
//
// The injection probes here are written so they WOULD have succeeded against the
// previous inline implementation, which built
//   node -p "require('./…/manifests/${CONNECTOR}.json').version"
// and compared against the matrix only afterward. Against that code a name
// carrying `').version + require('fs').writeFileSync(…)` wrote a marker file and
// the step still reported selected=false and exited 0. If these tests ever stop
// discriminating — if the marker can no longer be written even by broken code —
// they are worth nothing, so `the probe payload is executable in principle`
// below pins that the payload really does run when evaluated.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "select-publish-target.mjs");

/** A checkout-shaped tree with one real manifest, plus a marker path nothing should write. */
function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), "select-publish-"));
  const manifests = join(dir, "packages", "polyfill-connectors", "manifests");
  mkdirSync(manifests, { recursive: true });
  writeFileSync(join(manifests, "oura.json"), JSON.stringify({ version: "0.1.0" }));
  writeFileSync(join(manifests, "slack.json"), JSON.stringify({ version: "2.0.0" }));
  return { dir, marker: join(dir, "MARKER") };
}

function run(tree, env) {
  const outputFile = join(tree.dir, "step-output.txt");
  writeFileSync(outputFile, "");
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: tree.dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tree.dir, GITHUB_OUTPUT: outputFile, ...env },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  return { ...result, outputs };
}

const BASE = { MATRIX_CONNECTOR: "oura", GITHUB_REPOSITORY_OWNER: "PDP-Connect" };

// The payload from the reproduction: valid JavaScript once spliced into
// `require('./…/manifests/<HERE>.json').version`, writing $HOME/MARKER.
const INJECTION = `oura.json').version + require('fs').writeFileSync(process.env.HOME + '/MARKER', 'pwned') + ('`;

test("the probe payload is executable in principle — the test discriminates", () => {
  // Guards the guard. If this stopped being true, every injection assertion
  // below would pass against arbitrarily broken code, so pin it explicitly by
  // evaluating exactly the construction the old step built.
  const tree = makeTree();
  try {
    const result = spawnSync(
      process.execPath,
      ["-p", `require('./packages/polyfill-connectors/manifests/${INJECTION}.json').version`],
      { cwd: tree.dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: tree.dir } },
    );
    assert.equal(result.status, 0, `the probe must evaluate: ${result.stderr}`);
    assert.ok(
      existsSync(tree.marker),
      "the probe payload no longer writes its marker — the injection tests below would not discriminate",
    );
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("an injected connector name is refused and executes nothing", () => {
  const tree = makeTree();
  try {
    const result = run(tree, { ...BASE, EVENT_NAME: "workflow_dispatch", INPUT_CONNECTOR: INJECTION });

    assert.ok(
      !existsSync(tree.marker),
      "the injected payload executed — the name reached a program before it was validated",
    );
    assert.equal(result.status, 1, "an invalid connector name must refuse, not skip the leg");
    assert.match(result.stderr, /is not a valid connector key/);
    assert.notEqual(
      result.outputs.selected,
      "true",
      "an injected name must never select",
    );
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("an injected connector name in a TAG is refused and executes nothing", () => {
  // The push path parsed the tag with shell expansion rather than node -p, so it
  // was not the reproduced hole — but it feeds the same downstream manifest read
  // and must be held to the same rule.
  const tree = makeTree();
  try {
    const result = run(tree, {
      ...BASE,
      EVENT_NAME: "push",
      GIT_REF_NAME: `connector-${INJECTION}-v0.1.0`,
    });

    assert.ok(!existsSync(tree.marker), "a tag-borne payload executed");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a valid connector key/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a path traversal in the connector name is refused before any read", () => {
  const tree = makeTree();
  try {
    const result = run(tree, {
      ...BASE,
      EVENT_NAME: "workflow_dispatch",
      INPUT_CONNECTOR: "../../../../etc/passwd",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a valid connector key/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a well-formed name outside the allowlist skips the leg without reading its manifest", () => {
  // slack.json EXISTS in the fixture. The membership check must reject before
  // the manifest read, and the observable consequence is that no version is
  // emitted — the leg is skipped, not versioned.
  const tree = makeTree();
  try {
    const result = run(tree, { ...BASE, EVENT_NAME: "workflow_dispatch", INPUT_CONNECTOR: "slack" });

    assert.equal(result.status, 0, "an unmatched leg skips rather than fails");
    assert.equal(result.outputs.selected, "false");
    assert.equal(result.outputs.version, undefined, "a skipped leg must not resolve a version");
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a normal dispatch selects the connector and its manifest version", () => {
  const tree = makeTree();
  try {
    const result = run(tree, { ...BASE, EVENT_NAME: "workflow_dispatch", INPUT_CONNECTOR: "oura" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.outputs.selected, "true");
    assert.equal(result.outputs.connector, "oura");
    assert.equal(result.outputs.version, "0.1.0");
    assert.equal(result.outputs.repository, "ghcr.io/pdp-connect/connector/oura");
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a matching tag selects, and a version-mismatched tag refuses", () => {
  const tree = makeTree();
  try {
    const ok = run(tree, { ...BASE, EVENT_NAME: "push", GIT_REF_NAME: "connector-oura-v0.1.0" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.outputs.selected, "true");
    assert.equal(ok.outputs.version, "0.1.0");

    const mismatch = run(tree, { ...BASE, EVENT_NAME: "push", GIT_REF_NAME: "connector-oura-v9.9.9" });
    assert.equal(mismatch.status, 1, "a tag disagreeing with the manifest must refuse");
    assert.match(mismatch.stderr, /but the manifest declares '0\.1\.0'/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("an undeclared event refuses", () => {
  const tree = makeTree();
  try {
    const result = run(tree, { ...BASE, EVENT_NAME: "schedule" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /is not a publish trigger/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("an allowlisted name with no manifest refuses rather than selecting a blank version", () => {
  const tree = makeTree();
  try {
    const result = run(tree, {
      ...BASE,
      MATRIX_CONNECTOR: "fitbit",
      EVENT_NAME: "workflow_dispatch",
      INPUT_CONNECTOR: "fitbit",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot read manifest/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

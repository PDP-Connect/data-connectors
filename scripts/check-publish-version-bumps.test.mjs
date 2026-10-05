// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "check-publish-version-bumps.mjs");
const CONNECTORS = [{ manifest: "oura", connectorKey: "oura" }];
const SOURCE = "https://registry.pdpp.dev/sources/oura";
const VERSION = "0.1.0";

// A trimmed single-connector mirror of select-publish-connectors.test.mjs's
// fixture repo: just enough of the shared artifact-input surface for
// artifactInputHash to resolve, reproducing the #342 shape (a shared runtime
// file changes, no manifest/index version moves) one commit at a time.
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "check-publish-version-bumps-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Publish Version Bump Check Test");

  function write(path, content) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  function writeState(version) {
    write(
      "connectors/oura/manifest.json",
      JSON.stringify({
        connector_key: "oura",
        source: { id: SOURCE },
        version,
        brand: { icon: "icon.svg" },
        streams: [],
      }),
    );
    write(
      "connector-implementation-index.json",
      JSON.stringify({
        version: 1,
        connectors: [{ manifest: { connector_key: "oura", version } }],
      }),
    );
  }

  function commit(message) {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  }

  write("LICENSE", "license\n");
  write("NOTICE", "notice\n");
  write("package.json", "{}\n");
  write("package-lock.json", "{}\n");
  write("scripts/build-connector-oci-artifact.mjs", "builder\n");
  write("scripts/connector-host-runtime-contract.mjs", "contract\n");
  write("packages/connector-installer-core/package.json", "{}\n");
  write(
    "scripts/connector-publish-allowlist.mjs",
    `export const CONNECTOR_PUBLISH_INVENTORY = ${JSON.stringify(
      CONNECTORS.map((connector) => ({ ...connector, exclusionReason: null })),
    )};\n`,
  );
  write("packages/polyfill-connectors/package.json", "{}\n");
  write("packages/polyfill-connectors/package-lock.json", "{}\n");
  write("connectors/oura/icon.svg", "oura icon\n");
  write(
    "packages/polyfill-connectors/src/runtime.ts",
    "export const runtime = 'before';\n",
  );
  write(
    "connectors/oura/index.ts",
    "import { runtime } from '../../packages/polyfill-connectors/src/runtime.ts'; export { runtime };\n",
  );
  writeState(VERSION);
  const before = commit("before");

  return { dir, before, write, writeState, commit };
}

function runCheck(before, after, cwd) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, BEFORE_SHA: before, AFTER_SHA: after },
  });
}

test("fails when a shared-source change ships without a version bump (the #342 shape)", () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'after';\n");
    const after = repo.commit("change shared runtime without bumping oura");
    const result = runCheck(repo.before, after, repo.dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /oura shipped artifact content changed without a version bump/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("passes when the same shared-source change carries a version bump", () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'after';\n");
    repo.writeState("0.1.1");
    const after = repo.commit("change shared runtime and bump oura");
    const result = runCheck(repo.before, after, repo.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /oura@0\.1\.1/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("passes as a clean no-op when nothing changed", () => {
  const repo = makeRepo();
  try {
    const result = runCheck(repo.before, repo.before, repo.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No connector version changed/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("fails with a clear message when BEFORE_SHA is missing", () => {
  const repo = makeRepo();
  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repo.dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, AFTER_SHA: repo.before },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /BEFORE_SHA is not set/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

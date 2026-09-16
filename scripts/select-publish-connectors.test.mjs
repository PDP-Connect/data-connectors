// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  filterAbsentVersions,
  selectChangedConnectors,
} from "./select-publish-connectors.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "select-publish-connectors.mjs");
const CONNECTORS = [
  { manifest: "oura", connectorKey: "oura" },
  { manifest: "github", connectorKey: "github" },
];

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "select-publish-connectors-"));
  const manifests = join(dir, "packages", "polyfill-connectors", "manifests");
  mkdirSync(manifests, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Publish Connector Selection Test");

  function writeState(versions) {
    for (const connector of CONNECTORS) {
      writeFileSync(
        join(manifests, `${connector.manifest}.json`),
        JSON.stringify({ connector_key: connector.connectorKey, version: versions[connector.connectorKey] }),
      );
    }
    writeFileSync(
      join(dir, "packages", "polyfill-connectors", "connector-index.json"),
      JSON.stringify({
        version: 1,
        connectors: CONNECTORS.map((connector) => ({
          manifest: {
            connector_key: connector.connectorKey,
            version: versions[connector.connectorKey],
          },
        })),
      }),
    );
  }

  function commit(message) {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  }

  writeState({ oura: "0.1.0", github: "0.5.1" });
  const before = commit("before");
  writeState({ oura: "0.2.0", github: "0.5.1" });
  const after = commit("bump oura");
  return { dir, before, after };
}

test("a manifest and generated connector-index version bump is selected", () => {
  const repo = makeRepo();
  try {
    assert.deepEqual(
      selectChangedConnectors({
        before: repo.before,
        after: repo.after,
        cwd: repo.dir,
        connectors: CONNECTORS,
      }),
      [{ connector: "oura", manifest: "oura", version: "0.2.0" }],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unchanged connector version is not selected", () => {
  const repo = makeRepo();
  try {
    const selected = selectChangedConnectors({
      before: repo.before,
      after: repo.after,
      cwd: repo.dir,
      connectors: CONNECTORS,
    });
    assert.equal(selected.some(({ connector }) => connector === "github"), false);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("no changed version emits a clean no-op notice and an empty matrix", () => {
  const outputRoot = mkdtempSync(join(tmpdir(), "select-publish-noop-"));
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    const outputFile = join(outputRoot, "output");
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        BEFORE_SHA: sha,
        AFTER_SHA: sha,
        GITHUB_REPOSITORY_OWNER: "pdp-connect",
        GITHUB_OUTPUT: outputFile,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /No connector version changed/);
    const outputs = Object.fromEntries(
      readFileSync(outputFile, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const index = line.indexOf("=");
          return [line.slice(0, index), line.slice(index + 1)];
        }),
    );
    assert.deepEqual(JSON.parse(outputs.matrix), { include: [] });
    assert.equal(outputs["has-version-changes"], "false");
    assert.equal(outputs["has-publishable-changes"], "false");
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test("a changed version already present in GHCR is skipped", async () => {
  const notices = [];
  const candidate = { connector: "oura", manifest: "oura", version: "0.2.0" };
  const selected = await filterAbsentVersions([candidate], {
    owner: "pdp-connect",
    lookup: async () => ({
      outcome: "present",
      digest: `sha256:${"a".repeat(64)}`,
    }),
    notice: (message) => notices.push(message),
  });

  assert.deepEqual(selected, []);
  assert.match(notices.join("\n"), /already present in GHCR/);
});

test("an unknown GHCR lookup is skipped with a notice and never selected", async () => {
  const notices = [];
  const candidate = { connector: "oura", manifest: "oura", version: "0.2.0" };
  const selected = await filterAbsentVersions([candidate], {
    owner: "pdp-connect",
    lookup: async () => ({ outcome: "unknown", reason: "registry timed out" }),
    notice: (message) => notices.push(message),
  });

  assert.deepEqual(selected, []);
  assert.match(notices.join("\n"), /GHCR lookup is unknown/);
  assert.match(notices.join("\n"), /will not be published blindly/);
});

test("only a definite absent lookup reaches the publish matrix", async () => {
  const candidate = { connector: "oura", manifest: "oura", version: "0.2.0" };
  const selected = await filterAbsentVersions([candidate], {
    owner: "pdp-connect",
    lookup: async () => ({ outcome: "absent" }),
    notice: () => {},
  });

  assert.deepEqual(selected, [candidate]);
});

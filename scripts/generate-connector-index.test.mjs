import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeRepoCopy() {
  const fixtureBase = join(homedir(), ".tmp");
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(fixtureBase, "connector-index-generator-"));
  cpSync(repoRoot, root, {
    recursive: true,
    filter: (source) => {
      const name = basename(source);
      return ![".git", "node_modules", "reports"].includes(name);
    },
  });
  execFileSync("npm", ["ci", "--ignore-scripts"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "tests@example.com"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Tests"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], {
    cwd: root,
    stdio: "ignore",
  });
  return root;
}

function runGenerator(root, args = [], env = {}) {
  return spawnSync("node", ["scripts/generate-connector-index.mjs", ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

test("same-version GitHub PDPP maintained source drift fails check mode", () => {
  const root = makeRepoCopy();
  try {
    const sourcePath = join(
      root,
      "connectors",
      "github-pdpp",
      "src",
      "connector",
      "index.ts",
    );
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\n// drift\n`);

    const result = runGenerator(root, ["--check"]);

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /github-pdpp@0\.5\.0 maintained source changed without a version bump: src\/connector\/index\.ts/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-version ChatGPT PDPP artifact configuration drift fails check mode", () => {
  const root = makeRepoCopy();
  try {
    const sourcePath = join(root, "connectors", "chatgpt-pdpp", "artifact.json");
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\n`);

    const result = runGenerator(root, ["--check"]);

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /chatgpt-pdpp@0\.1\.0 maintained source changed without a version bump: artifact\.json/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-version GitHub PDPP provenance drift fails check mode", () => {
  const root = makeRepoCopy();
  try {
    const provenancePath = join(
      root,
      "connectors",
      "github-pdpp",
      "provenance.json",
    );
    writeFileSync(provenancePath, `${readFileSync(provenancePath, "utf8")}\n`);

    const result = runGenerator(root, ["--check"]);

    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /github-pdpp@0\.5\.0 source changed without a version bump/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release-assets refresh preserves every PDPP artifact when generated dist is absent", () => {
  const root = makeRepoCopy();
  try {
    const originalIndex = JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8"));
    rmSync(
      join(root, "connectors", "github-pdpp", "dist", "collection-profile.mjs"),
      { force: true },
    );
    rmSync(
      join(root, "connectors", "chatgpt-pdpp", "dist", "collection-profile.mjs"),
      { force: true },
    );

    const result = runGenerator(root, [], {
      CONNECTOR_USE_RELEASE_ASSETS: "1",
      CONNECTOR_ENABLE_SIGSTORE_METADATA: "1",
      CONNECTOR_SOURCE_COMMIT: "a".repeat(40),
      CONNECTOR_RELEASE_TAG: "connectors-release-test",
      CONNECTOR_RELEASE_ID: "connectors-release-test",
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const index = JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8"));
    const pdpp = index.connectors["github-pdpp"][0];
    assert.equal(
      pdpp.artifactUrl,
      "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-release-test/github-pdpp-0.5.0.tgz",
    );
    assert.equal(
      pdpp.artifactSha256,
      originalIndex.connectors["github-pdpp"][0].artifactSha256,
    );
    assert.equal(pdpp.releaseId, "connectors-release-test");
    assert.equal(pdpp.artifactSignature?.type, "sigstoreBundle");
    const chatgpt = index.connectors["chatgpt-pdpp"][0];
    assert.equal(
      chatgpt.artifactUrl,
      "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-release-test/chatgpt-pdpp-0.1.0.tgz",
    );
    assert.equal(chatgpt.artifactSignature?.type, "sigstoreBundle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  PublishSelectionError,
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
  const manifests = join(dir, "connectors");
  mkdirSync(manifests, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Publish Connector Selection Test");

  function write(path, content) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }

  function writeState(versions) {
    for (const connector of CONNECTORS) {
      write(
        `connectors/${connector.manifest}/manifest.json`,
        JSON.stringify({
          connector_key: connector.connectorKey,
          version: versions[connector.connectorKey],
          brand: { icon: "icon.svg" },
        }),
      );
    }
    write(
      "connector-implementation-index.json",
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

  write("LICENSE", "license\n");
  write("NOTICE", "notice\n");
  write("package.json", "{}\n");
  write("package-lock.json", "{}\n");
  write("scripts/build-connector-oci-artifact.mjs", "builder\n");
  write("scripts/connector-host-runtime-contract.mjs", "contract\n");
  write("packages/polyfill-connectors/package.json", "{}\n");
  write("packages/polyfill-connectors/package-lock.json", "{}\n");
  write("connectors/oura/icon.svg", "oura icon\n");
  write("connectors/github/icon.svg", "github icon\n");
  write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'before';\n");
  write("packages/polyfill-connectors/src/setup.ts", "globalThis.__publishSelectionFixture = 'before';\n");
  write("connectors/oura/index.ts", "import { runtime } from '../../packages/polyfill-connectors/src/runtime.ts'; export { runtime };\n");
  write("connectors/github/index.ts", "import '../../packages/polyfill-connectors/src/setup.ts'; export const github = true;\n");
  writeState({ oura: "0.1.0", github: "0.5.1" });
  const before = commit("before");
  writeState({ oura: "0.2.0", github: "0.5.1" });
  const after = commit("bump oura");
  return { dir, before, after, commit, write, writeState };
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

test("shipped source changes without a version bump are refused", () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'after';\n");
    const after = repo.commit("change shipped source");
    assert.throws(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed.*bump the manifest and connector-index\.json version/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("side-effect imported source changes are refused", () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/setup.ts", "globalThis.__publishSelectionFixture = 'after';\n");
    const after = repo.commit("change side-effect source");
    assert.throws(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /github shipped artifact content changed/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("builder toolchain metadata changes are refused without a version bump", () => {
  const repo = makeRepo();
  try {
    repo.write("package.json", "{\"build\":\"after\"}\n");
    const after = repo.commit("change builder metadata");
    assert.throws(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unrelated root file does not select a connector", () => {
  const repo = makeRepo();
  try {
    repo.write("README.md", "unrelated\n");
    const after = repo.commit("change readme");
    assert.deepEqual(
      selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      [],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unreachable connector test does not select its connector", () => {
  const repo = makeRepo();
  try {
    repo.write("connectors/oura/index.test.ts", "throw new Error('test only');\n");
    const after = repo.commit("change unreachable test");
    assert.deepEqual(
      selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      [],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a shared source change selects only its importing connector when versioned", () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'after';\n");
    repo.writeState({ oura: "0.3.0", github: "0.5.1" });
    const after = repo.commit("version shipped oura source");
    assert.deepEqual(
      selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      [{ connector: "oura", manifest: "oura", version: "0.3.0" }],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the layout transition skips once and later versioned releases select normally", () => {
  const repo = makeRepo();
  try {
    const oldIndex = "packages/polyfill-connectors/connector-index.json";
    repo.write(oldIndex, JSON.stringify({ connectors: [] }));
    const beforeMove = repo.commit("old layout still present");
    rmSync(join(repo.dir, oldIndex));
    const cut = repo.commit("remove old layout");
    assert.deepEqual(
      selectChangedConnectors({ before: beforeMove, after: cut, cwd: repo.dir, connectors: CONNECTORS }),
      [],
    );

    repo.writeState({ oura: "0.3.0", github: "0.5.1" });
    const later = repo.commit("version oura after layout cut");
    assert.deepEqual(
      selectChangedConnectors({ before: cut, after: later, cwd: repo.dir, connectors: CONNECTORS }),
      [{ connector: "oura", manifest: "oura", version: "0.3.0" }],
    );
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

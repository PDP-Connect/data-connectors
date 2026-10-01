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
import { artifactInputHash } from "./connector-artifact-inputs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "select-publish-connectors.mjs");
const CONNECTORS = [
  { manifest: "oura", connectorKey: "oura" },
  { manifest: "oura_browser", connectorKey: "oura_browser" },
  { manifest: "github", connectorKey: "github" },
];
const SOURCES = {
  oura: "https://registry.pdpp.dev/sources/oura",
  oura_browser: "https://registry.pdpp.dev/sources/oura",
  github: "https://registry.pdpp.dev/sources/github",
};
const VERSIONS = { oura: "0.1.0", oura_browser: "0.1.0", github: "0.5.1" };

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

  function writeState(versionChanges, streams = {}) {
    const versions = { ...VERSIONS, ...versionChanges };
    for (const connector of CONNECTORS) {
      write(
        `connectors/${connector.manifest}/manifest.json`,
        JSON.stringify({
          connector_key: connector.connectorKey,
          source: { id: SOURCES[connector.connectorKey] },
          version: versions[connector.connectorKey],
          brand: { icon: "icon.svg" },
          streams: streams[connector.connectorKey] ?? [],
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
  write("packages/connector-installer-core/package.json", "{}\n");
  write("packages/connector-installer-core/source-declaration.mjs", "declaration builder\n");
  write("packages/connector-installer-core/pdpp-source-contract.mjs", "source contract\n");
  write("scripts/source-declaration-members.mjs", "members\n");
  write("vendor/pdpp-reference-contract/source.ts", "reference contract\n");
  write(
    "scripts/connector-publish-allowlist.mjs",
    `export const CONNECTOR_PUBLISH_INVENTORY = ${JSON.stringify(
      CONNECTORS.map((connector) => ({ ...connector, exclusionReason: null })),
    )};\n`,
  );
  write("packages/polyfill-connectors/package.json", "{}\n");
  write("packages/polyfill-connectors/package-lock.json", "{}\n");
  write("connectors/oura/icon.svg", "oura icon\n");
  write("connectors/github/icon.svg", "github icon\n");
  write("connectors/oura_browser/icon.svg", "oura browser icon\n");
  write("connectors/oura_browser/index.ts", "export const ouraBrowser = true;\n");
  write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'before';\n");
  write("packages/polyfill-connectors/src/setup.ts", "globalThis.__publishSelectionFixture = 'before';\n");
  write("connectors/oura/index.ts", "import { runtime } from '../../packages/polyfill-connectors/src/runtime.ts'; export { runtime };\n");
  write("connectors/github/index.ts", "import '../../packages/polyfill-connectors/src/setup.ts'; export const github = true;\n");
  writeState({});
  const before = commit("before");
  writeState({ oura: "0.2.0" });
  const after = commit("bump oura");
  function writeAllowlist(rows, prefix = "") {
    write(
      "scripts/connector-publish-allowlist.mjs",
      `${prefix}export const CONNECTOR_PUBLISH_INVENTORY = ${JSON.stringify(rows)};\n`,
    );
  }
  return { dir, before, after, commit, write, writeState, writeAllowlist };
}

test("a manifest and generated connector-index version bump is selected", async () => {
  const repo = makeRepo();
  try {
    assert.deepEqual(
      await selectChangedConnectors({
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

test("an unchanged connector version is not selected", async () => {
  const repo = makeRepo();
  try {
    const selected = await selectChangedConnectors({
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

test("shipped source changes without a version bump are refused", async () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'after';\n");
    const after = repo.commit("change shipped source");
    await assert.rejects(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed.*bump the manifest and connector-index\.json version/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("side-effect imported source changes are refused", async () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/setup.ts", "globalThis.__publishSelectionFixture = 'after';\n");
    const after = repo.commit("change side-effect source");
    await assert.rejects(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /github shipped artifact content changed/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("builder toolchain metadata changes are refused without a version bump", async () => {
  const repo = makeRepo();
  try {
    repo.write("package.json", "{\"build\":\"after\"}\n");
    const after = repo.commit("change builder metadata");
    await assert.rejects(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unrelated root file does not select a connector", async () => {
  const repo = makeRepo();
  try {
    repo.write("README.md", "unrelated\n");
    const after = repo.commit("change readme");
    assert.deepEqual(
      await selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      [],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a root developer script does not change non-PageShim artifact identity", async () => {
  const repo = makeRepo();
  try {
    const before = await artifactInputHash({ commit: repo.after, manifest: "oura", cwd: repo.dir });
    repo.write("package.json", JSON.stringify({ scripts: { "mobile:bundle": "node scripts/pageshim/mobile-bundle.mjs" } }));
    const afterCommit = repo.commit("add a local mobile bundle command");
    const after = await artifactInputHash({ commit: afterCommit, manifest: "oura", cwd: repo.dir });
    assert.equal(after, before);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("sibling runtime metadata does not change shared SourceDeclaration identity", async () => {
  const repo = makeRepo();
  try {
    const before = await artifactInputHash({ commit: repo.after, manifest: "oura", cwd: repo.dir });
    const siblingPath = join(repo.dir, "connectors/oura_browser/manifest.json");
    const sibling = JSON.parse(readFileSync(siblingPath, "utf8"));
    sibling.runtime_requirements = { bindings: { browser: { required: true, features: ["evaluate"] } } };
    sibling.mobile = { pageshim: { scope_prefix: "oura" } };
    repo.write("connectors/oura_browser/manifest.json", JSON.stringify(sibling));
    const afterCommit = repo.commit("add sibling runtime metadata");
    const after = await artifactInputHash({ commit: afterCommit, manifest: "oura", cwd: repo.dir });
    assert.equal(after, before);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a PageShim-only edit changes only connectors with a PageShim entry", async () => {
  const repo = makeRepo();
  try {
    const pageShimFiles = {
      "scripts/pageshim/attach-to-artifact.mjs": "attach before\n",
      "scripts/pageshim/build.mjs": "build before\n",
      "scripts/pageshim/runtime.ts": "runtime before\n",
      "scripts/pageshim/shims/buffer.js": "buffer shim\n",
      "scripts/pageshim/shims/path.js": "path shim\n",
      "scripts/pageshim/shims/process.js": "process shim\n",
      "scripts/pageshim/shims/url.js": "url shim\n",
      "scripts/pageshim/shims/anthropic-export.ts": "anthropic shim\n",
      "scripts/pageshim/entries/helper.ts": "export const helper = 'before';\n",
      "scripts/pageshim/entries/oura_browser.ts":
        "import { ouraBrowser } from '../../../connectors/oura_browser/index.ts';\nimport { helper } from './helper.ts';\nexport { ouraBrowser, helper };\n",
    };
    for (const [path, content] of Object.entries(pageShimFiles)) repo.write(path, content);
    const before = repo.commit("add PageShim target");
    const beforeHashes = await fleetHashes(repo, before);
    repo.write("scripts/pageshim/runtime.ts", "runtime after\n");
    const after = repo.commit("change PageShim runtime");
    const afterHashes = await fleetHashes(repo, after);
    assert.deepEqual(changedConnectors(beforeHashes, afterHashes), ["oura_browser"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a PageShim entry's local helper is part of its connector artifact hash", async () => {
  const repo = makeRepo();
  try {
    const pageShimFiles = {
      "scripts/pageshim/attach-to-artifact.mjs": "attach\n",
      "scripts/pageshim/build.mjs": "build\n",
      "scripts/pageshim/runtime.ts": "runtime\n",
      "scripts/pageshim/shims/buffer.js": "buffer shim\n",
      "scripts/pageshim/shims/path.js": "path shim\n",
      "scripts/pageshim/shims/process.js": "process shim\n",
      "scripts/pageshim/shims/url.js": "url shim\n",
      "scripts/pageshim/shims/anthropic-export.ts": "anthropic shim\n",
      "scripts/pageshim/entries/helper.ts": "export const helper = 'before';\n",
      "scripts/pageshim/entries/oura_browser.ts":
        "import { helper } from './helper.ts';\nexport { helper };\n",
    };
    for (const [path, content] of Object.entries(pageShimFiles)) repo.write(path, content);
    const before = repo.commit("add PageShim helper");
    const beforeHashes = await fleetHashes(repo, before);
    repo.write("scripts/pageshim/entries/helper.ts", "export const helper = 'after';\n");
    const after = repo.commit("change PageShim helper");
    const afterHashes = await fleetHashes(repo, after);
    assert.deepEqual(changedConnectors(beforeHashes, afterHashes), ["oura_browser"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a PageShim injected shim's local helper is part of its connector artifact hash", async () => {
  const repo = makeRepo();
  try {
    const pageShimFiles = {
      "scripts/pageshim/attach-to-artifact.mjs": "attach\n",
      "scripts/pageshim/build.mjs": "build\n",
      "scripts/pageshim/runtime.ts": "runtime\n",
      "scripts/pageshim/shims/buffer.js": "buffer shim\n",
      "scripts/pageshim/shims/path.js": "path shim\n",
      "scripts/pageshim/shims/process.js": "import { helper } from './helper.js'; export { helper };\n",
      "scripts/pageshim/shims/url.js": "url shim\n",
      "scripts/pageshim/shims/anthropic-export.ts": "anthropic shim\n",
      "scripts/pageshim/shims/helper.js": "export const helper = 'before';\n",
      "scripts/pageshim/entries/oura_browser.ts": "export {}\n",
    };
    for (const [path, content] of Object.entries(pageShimFiles)) repo.write(path, content);
    const before = repo.commit("add PageShim injected shim helper");
    const beforeHashes = await fleetHashes(repo, before);
    repo.write("scripts/pageshim/shims/helper.js", "export const helper = 'after';\n");
    const after = repo.commit("change injected shim helper");
    const afterHashes = await fleetHashes(repo, after);
    assert.deepEqual(changedConnectors(beforeHashes, afterHashes), ["oura_browser"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unreachable connector test does not select its connector", async () => {
  const repo = makeRepo();
  try {
    repo.write("connectors/oura/index.test.ts", "throw new Error('test only');\n");
    const after = repo.commit("change unreachable test");
    assert.deepEqual(
      await selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      [],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a shared source change selects only its importing connector when versioned", async () => {
  const repo = makeRepo();
  try {
    repo.write("packages/polyfill-connectors/src/runtime.ts", "export const runtime = 'after';\n");
    repo.writeState({ oura: "0.3.0" });
    const after = repo.commit("version shipped oura source");
    assert.deepEqual(
      await selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      [{ connector: "oura", manifest: "oura", version: "0.3.0" }],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a sibling-only manifest change selects every member of the shared source", async () => {
  const repo = makeRepo();
  try {
    const sleep = [{ name: "sleep" }];
    repo.writeState({ oura: "0.2.0", oura_browser: "0.1.0" }, { oura_browser: sleep });
    const unversioned = repo.commit("change only oura_browser streams");
    await assert.rejects(
      () => selectChangedConnectors({ before: repo.after, after: unversioned, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed/.test(error.message),
    );

    repo.writeState({ oura: "0.2.1", oura_browser: "0.1.1" }, { oura_browser: sleep });
    const versioned = repo.commit("version both oura members");
    assert.deepEqual(
      await selectChangedConnectors({ before: repo.after, after: versioned, cwd: repo.dir, connectors: CONNECTORS }),
      [
        { connector: "oura", manifest: "oura", version: "0.2.1" },
        { connector: "oura_browser", manifest: "oura_browser", version: "0.1.1" },
      ],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a source declaration validator change is refused without a version bump", async () => {
  const repo = makeRepo();
  try {
    repo.write("packages/connector-installer-core/source-declaration.mjs", "declaration builder changed\n");
    const after = repo.commit("change declaration builder");
    await assert.rejects(
      () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
      (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed/.test(error.message),
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("the layout transition skips once and later versioned releases select normally", async () => {
  const repo = makeRepo();
  try {
    const oldIndex = "packages/polyfill-connectors/connector-index.json";
    repo.write(oldIndex, JSON.stringify({ connectors: [] }));
    const beforeMove = repo.commit("old layout still present");
    rmSync(join(repo.dir, oldIndex));
    const cut = repo.commit("remove old layout");
    assert.deepEqual(
      await selectChangedConnectors({ before: beforeMove, after: cut, cwd: repo.dir, connectors: CONNECTORS }),
      [],
    );

    repo.writeState({ oura: "0.3.0" });
    const later = repo.commit("version oura after layout cut");
    assert.deepEqual(
      await selectChangedConnectors({ before: cut, after: later, cwd: repo.dir, connectors: CONNECTORS }),
      [{ connector: "oura", manifest: "oura", version: "0.3.0" }],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("no changed version emits a clean no-op notice and an empty matrix", async () => {
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

const ROWS = CONNECTORS.map((connector) => ({ ...connector, exclusionReason: null }));

async function fleetHashes(repo, commit) {
  const hashes = {};
  for (const { manifest } of CONNECTORS) {
    hashes[manifest] = await artifactInputHash({ commit, manifest, cwd: repo.dir });
  }
  return hashes;
}

function changedConnectors(before, after) {
  return Object.keys(before).filter((manifest) => before[manifest] !== after[manifest]);
}

test("an allowlist row for a new source changes no existing artifact hash", async () => {
  const repo = makeRepo();
  try {
    const before = await fleetHashes(repo, repo.after);
    repo.write(
      "connectors/strava/manifest.json",
      JSON.stringify({ connector_key: "strava", source: { id: "https://registry.pdpp.dev/sources/strava" }, version: "0.1.0" }),
    );
    repo.writeAllowlist([...ROWS, { manifest: "strava", connectorKey: "strava", exclusionReason: null }]);
    const after = await fleetHashes(repo, repo.commit("add strava"));
    assert.deepEqual(changedConnectors(before, after), []);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an allowlist row change for a source changes only that source's artifact hashes", async () => {
  const repo = makeRepo();
  try {
    const before = await fleetHashes(repo, repo.after);
    repo.writeAllowlist(
      ROWS.map((row) => (row.connectorKey === "oura_browser" ? { ...row, exclusionReason: "held" } : row)),
    );
    const excluded = await fleetHashes(repo, repo.commit("hold oura_browser"));
    assert.deepEqual(changedConnectors(before, excluded), ["oura", "oura_browser"]);

    repo.write(
      "connectors/oura_ring/manifest.json",
      JSON.stringify({ connector_key: "oura_ring", source: { id: SOURCES.oura }, version: "0.1.0" }),
    );
    repo.writeAllowlist([...ROWS, { manifest: "oura_ring", connectorKey: "oura_ring", exclusionReason: null }]);
    const added = await fleetHashes(repo, repo.commit("add a third oura member"));
    assert.deepEqual(changedConnectors(before, added), ["oura", "oura_browser"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a sibling manifest edit changes only its source's artifact hashes", async () => {
  const repo = makeRepo();
  try {
    const before = await fleetHashes(repo, repo.after);
    repo.writeState({ oura: "0.2.0" }, { oura_browser: [{ name: "sleep" }] });
    const after = await fleetHashes(repo, repo.commit("change oura_browser streams"));
    assert.deepEqual(changedConnectors(before, after), ["oura", "oura_browser"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("allowlist comments, formatting, and row order change no artifact hash", async () => {
  const repo = makeRepo();
  try {
    const before = await fleetHashes(repo, repo.after);
    repo.write(
      "scripts/connector-publish-allowlist.mjs",
      `// A comment.\nexport const CONNECTOR_PUBLISH_INVENTORY = ${JSON.stringify([...ROWS].reverse(), null, 2)};\n`,
    );
    const after = await fleetHashes(repo, repo.commit("reformat allowlist"));
    assert.deepEqual(changedConnectors(before, after), []);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

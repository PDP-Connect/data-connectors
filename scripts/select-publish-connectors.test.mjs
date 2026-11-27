// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import {
  filterAbsentVersions,
  PublishSelectionError,
  selectChangedConnectors,
  selectPublishCandidates,
  selectPublishTargets,
} from "./select-publish-connectors.mjs";
import { artifactInputHash } from "./connector-artifact-inputs.mjs";

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

test("the publish selector's dependencies are installed before every main-push selection", () => {
  const workflow = parseYaml(readFileSync(new URL("../.github/workflows/publish-polyfill-connectors.yml", import.meta.url), "utf8"));
  const steps = workflow.jobs.prepare.steps;
  const selectorIndex = steps.findIndex((step) => step.id === "main-selection");
  const installIndex = steps.findIndex((step) => /\bnpm ci\b.*--ignore-scripts/.test(step.run ?? ""));
  const nodeIndex = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));

  assert.ok(selectorIndex >= 0, "the main-push selector must exist");
  assert.ok(nodeIndex >= 0 && nodeIndex < installIndex && installIndex < selectorIndex,
    "set up Node and install the root lockfile before selecting connector releases");
  const install = steps[installIndex];
  assert.equal(install.if, steps[selectorIndex].if, "install must run for the same events as selection");
  assert.equal(install["working-directory"], undefined, "install must use the root lockfile");
  assert.match(install.run, /(?:^|\s)--include=dev(?:\s|$)/, "selector build dependencies must be present even with production npm settings");
  assert.notEqual(install["continue-on-error"], true, "a failed install must stop selection");
});

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

test("installer npm pack file lists do not change connector artifact identity", async () => {
  const repo = makeRepo();
  try {
    const before = await artifactInputHash({ commit: repo.after, manifest: "oura", cwd: repo.dir });
    for (const path of ["package.json", "packages/connector-installer-core/package.json"]) {
      repo.write(path, JSON.stringify({ files: ["index.mjs"] }));
      const after = repo.commit(`change ${path} pack list`);
      assert.equal(await artifactInputHash({ commit: after, manifest: "oura", cwd: repo.dir }), before);
    }
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a polyfill package test script does not change artifact identity, a dependency does", async () => {
  const repo = makeRepo();
  try {
    const before = await artifactInputHash({ commit: repo.after, manifest: "oura", cwd: repo.dir });
    repo.write(
      "packages/polyfill-connectors/package.json",
      JSON.stringify({ scripts: { test: "../../scripts/test-sandbox/test-sandbox -- node scripts/run-tests.mjs" } }),
    );
    const scriptCommit = repo.commit("route the package test script through the sandbox");
    assert.equal(await artifactInputHash({ commit: scriptCommit, manifest: "oura", cwd: repo.dir }), before);
    repo.write(
      "packages/polyfill-connectors/package.json",
      JSON.stringify({ dependencies: { zod: "4.0.0" } }),
    );
    const depCommit = repo.commit("add a runtime dependency");
    assert.notEqual(await artifactInputHash({ commit: depCommit, manifest: "oura", cwd: repo.dir }), before);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a polyfill package export entry does not change artifact identity", async () => {
  const repo = makeRepo();
  try {
    const before = await artifactInputHash({ commit: repo.after, manifest: "oura", cwd: repo.dir });
    repo.write(
      "packages/polyfill-connectors/package.json",
      JSON.stringify({ exports: { "./browser-launch": "./src/browser-launch.js" } }),
    );
    const exportCommit = repo.commit("export a module for hosts");
    assert.equal(await artifactInputHash({ commit: exportCommit, manifest: "oura", cwd: repo.dir }), before);
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

test("extending PageShim support does not change an already eligible artifact identity", async () => {
  const repo = makeRepo();
  try {
    const manifestPath = "connectors/oura/manifest.json";
    const profile = JSON.parse(readFileSync(join(repo.dir, manifestPath), "utf8"));
    profile.runtime_requirements = {
      bindings: {
        browser: { required: true, features: ["page_script_evaluation"] },
        network: { required: true, features: ["same_origin_page_fetch"] },
      },
    };
    profile.mobile = { pageshim: { scope_prefix: "oura" } };
    repo.write(manifestPath, JSON.stringify(profile));
    const writeCapabilityPolicy = (features) => repo.write(
      "scripts/pageshim/capabilities.mjs",
      `const supported = new Set(${JSON.stringify(features)});\n` +
        `export function isPageShimCapable(m) { return Object.values(m.runtime_requirements.bindings).filter((r) => r.required).every((r) => r.features.every((f) => supported.has(f))); }\n`,
    );
    writeCapabilityPolicy(["page_script_evaluation", "same_origin_page_fetch"]);
    const before = repo.commit("set up an eligible PageShim connector");
    const beforeHash = await artifactInputHash({ commit: before, manifest: "oura", cwd: repo.dir });
    writeCapabilityPolicy([
      "page_script_evaluation",
      "same_origin_page_fetch",
      "host_download_capture",
    ]);
    const after = repo.commit("extend PageShim support for another connector");
    const afterHash = await artifactInputHash({ commit: after, manifest: "oura", cwd: repo.dir });
    assert.equal(afterHash, beforeHash);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a PageShim eligibility transition changes artifact identity", async () => {
  const repo = makeRepo();
  try {
    const manifestPath = "connectors/oura/manifest.json";
    const profile = JSON.parse(readFileSync(join(repo.dir, manifestPath), "utf8"));
    profile.runtime_requirements = {
      bindings: {
        browser: { required: true, features: ["page_script_evaluation"] },
        network: { required: true, features: ["same_origin_page_fetch"] },
      },
    };
    profile.mobile = { pageshim: { scope_prefix: "oura" } };
    repo.write(manifestPath, JSON.stringify(profile));
    const writeCapabilityPolicy = (features) => repo.write(
      "scripts/pageshim/capabilities.mjs",
      `const supported = new Set(${JSON.stringify(features)});\n` +
        `export function isPageShimCapable(m) { return Object.values(m.runtime_requirements.bindings).filter((r) => r.required).every((r) => r.features.every((f) => supported.has(f))); }\n`,
    );
    writeCapabilityPolicy(["page_script_evaluation"]);
    const before = repo.commit("set up an ineligible PageShim connector");
    const beforeHash = await artifactInputHash({ commit: before, manifest: "oura", cwd: repo.dir });
    writeCapabilityPolicy(["page_script_evaluation", "same_origin_page_fetch"]);
    const after = repo.commit("enable a PageShim connector");
    const afterHash = await artifactInputHash({ commit: after, manifest: "oura", cwd: repo.dir });
    assert.notEqual(afterHash, beforeHash);
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

/**
 * A fake GHCR: `published` maps `repository:tag` to a digest. Every reference
 * not in it is definitely absent. `calls` records each lookup, so a test can
 * assert how many registry questions a push asks.
 */
function fakeRegistry(published) {
  const calls = [];
  async function lookup({ registry, name, tag }) {
    calls.push(`${registry}/${name}:${tag}`);
    const digest = published[`${name}:${tag}`];
    return digest ? { outcome: "present", digest } : { outcome: "absent" };
  }
  return { lookup, calls };
}

const DIGEST = `sha256:${"c".repeat(64)}`;

test("every connector at its main version is a publish candidate, not only the bumped one", async () => {
  const repo = makeRepo();
  try {
    assert.deepEqual(
      await selectPublishCandidates({ before: repo.before, after: repo.after, cwd: repo.dir, connectors: CONNECTORS }),
      [
        { connector: "oura", manifest: "oura", version: "0.2.0" },
        { connector: "oura_browser", manifest: "oura_browser", version: "0.1.0" },
        { connector: "github", manifest: "github", version: "0.5.1" },
      ],
    );
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a push that changed no connector publishes the main version GHCR lacks", async () => {
  const repo = makeRepo();
  try {
    // A README-only push. oura_browser@0.1.0 is on main but absent from GHCR,
    // as after a run that was cancelled in the concurrency queue.
    repo.write("README.md", "unrelated\n");
    const after = repo.commit("unrelated push");
    const registry = fakeRegistry({
      "pdp-connect/connector/oura:0.2.0": DIGEST,
      "pdp-connect/connector/github:0.5.1": DIGEST,
    });

    const selected = await selectPublishTargets({
      before: repo.after,
      after,
      cwd: repo.dir,
      connectors: CONNECTORS,
      owner: "pdp-connect",
      lookup: registry.lookup,
      notice: () => {},
    });

    assert.deepEqual(selected, [{ connector: "oura_browser", manifest: "oura_browser", version: "0.1.0" }]);
    assert.equal(registry.calls.length, CONNECTORS.length, "one GHCR question per candidate, not per change");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a main with every version already in GHCR publishes nothing", async () => {
  const repo = makeRepo();
  try {
    const registry = fakeRegistry({
      "pdp-connect/connector/oura:0.2.0": DIGEST,
      "pdp-connect/connector/oura_browser:0.1.0": DIGEST,
      "pdp-connect/connector/github:0.5.1": DIGEST,
    });
    const notices = [];
    const selected = await selectPublishTargets({
      before: null,
      after: repo.after,
      cwd: repo.dir,
      connectors: CONNECTORS,
      owner: "pdp-connect",
      lookup: registry.lookup,
      notice: (message) => notices.push(message),
    });

    assert.deepEqual(selected, []);
    assert.match(notices.join("\n"), /already present in GHCR/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
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

test("an unknown GHCR lookup fails selection instead of reporting a successful no-op", async () => {
  const candidate = { connector: "oura", manifest: "oura", version: "0.2.0" };
  await assert.rejects(filterAbsentVersions([candidate], {
    owner: "pdp-connect",
    lookup: async () => ({ outcome: "unknown", reason: "registry timed out" }),
    notice: () => {},
  }), /GHCR lookup is unknown.*registry timed out/);
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

for (const [label, path, metadata] of [
  ["installer version", "packages/connector-installer-core/package.json", { version: "0.2.0" }],
  ["installer dependency", "packages/connector-installer-core/package.json", { dependencies: { tar: "7.5.22" } }],
  ["installer engine", "packages/connector-installer-core/package.json", { engines: { node: ">=24" } }],
  ["polyfill engine", "packages/polyfill-connectors/package.json", { engines: { node: ">=24" } }],
]) {
  test(`${label} metadata remains an artifact input requiring a version bump`, async () => {
    const repo = makeRepo();
    try {
      const before = await artifactInputHash({ commit: repo.after, manifest: "oura", cwd: repo.dir });
      repo.write(path, JSON.stringify(metadata));
      const after = repo.commit(`change ${label}`);
      assert.notEqual(await artifactInputHash({ commit: after, manifest: "oura", cwd: repo.dir }), before);
      await assert.rejects(
        () => selectChangedConnectors({ before: repo.after, after, cwd: repo.dir, connectors: CONNECTORS }),
        (error) => error instanceof PublishSelectionError && /oura shipped artifact content changed/.test(error.message),
      );
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
}

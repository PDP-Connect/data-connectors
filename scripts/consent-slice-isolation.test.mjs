// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A connector's consent_time_field edit must move that connector's artifact
// input hash and no other connector's. Each case builds a small scratch git
// repo, regenerates the consent modules the way the generator does, and
// compares artifactInputHash across commits.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactInputHash } from "./connector-artifact-inputs.mjs";
import {
  renderAggregate,
  renderSlice,
} from "../packages/polyfill-connectors/scripts/consent-time-fields-render.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const real = (path) => readFileSync(join(repoRoot, path), "utf8");

const RESOLUTION = "scripts/consent-slice-resolution.mjs";
const RENDERER = "packages/polyfill-connectors/scripts/consent-time-fields-render.mjs";
const AGGREGATE = "packages/polyfill-connectors/src/generated/consent-time-fields.generated.ts";
const slicePath = (dir) => `packages/polyfill-connectors/src/generated/consent-time-fields/${dir}.generated.ts`;

// alpha and beta import the shared runtime from their entrypoint. gamma only
// reaches it through the PageShim runtime. delta imports nothing.
const CONNECTORS = ["alpha", "beta", "gamma", "delta"];
const stream = (field) => ({
  name: "events",
  consent_time_field: field,
  schema: { properties: { [field]: { type: "string", format: "date-time" } } },
});

function makeRepo({ layout = "sliced" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "consent-slice-isolation-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Consent Slice Isolation Test");
  const write = (path, content) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const fields = { alpha: "at", beta: "at", gamma: "at", delta: "at" };

  function writeManifests() {
    for (const name of CONNECTORS) {
      write(
        `connectors/${name}/manifest.json`,
        JSON.stringify({
          connector_key: name,
          source: { id: `https://registry.pdpp.dev/sources/${name}` },
          version: "0.1.0",
          streams: [stream(fields[name])],
        }),
      );
    }
  }
  function regenerate() {
    const manifests = CONNECTORS.map((name) => [
      name,
      JSON.parse(readFileSync(join(dir, `connectors/${name}/manifest.json`), "utf8")),
    ]);
    write(AGGREGATE, renderAggregate(manifests));
    if (layout !== "sliced") return;
    for (const [name, manifest] of manifests) write(slicePath(name), renderSlice(name, manifest));
  }
  function commit(message) {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  }

  for (const [path, content] of Object.entries({
    LICENSE: "license\n",
    NOTICE: "notice\n",
    "package.json": "{}\n",
    "package-lock.json": "{}\n",
    "scripts/build-connector-oci-artifact.mjs": "builder\n",
    "scripts/connector-host-runtime-contract.mjs": "contract\n",
    "packages/connector-installer-core/package.json": "{}\n",
    "packages/connector-installer-core/source-declaration.mjs": "declaration builder\n",
    "packages/connector-installer-core/pdpp-source-contract.mjs": "source contract\n",
    "scripts/source-declaration-members.mjs": "members\n",
    "vendor/pdpp-reference-contract/source.ts": "reference contract\n",
    "packages/polyfill-connectors/package.json": "{}\n",
    "packages/polyfill-connectors/package-lock.json": "{}\n",
    "packages/polyfill-connectors/src/runtime.ts":
      "import { CONSENT_TIME_FIELDS } from './generated/consent-time-fields.generated.ts';\nexport const table = CONSENT_TIME_FIELDS;\n",
    "scripts/connector-publish-allowlist.mjs": `export const CONNECTOR_PUBLISH_INVENTORY = ${JSON.stringify(
      CONNECTORS.map((name) => ({ manifest: name, connectorKey: name, exclusionReason: null })),
    )};\n`,
    // PageShim: the runtime shared by every bundle, and gamma's entry.
    "scripts/pageshim/attach-to-artifact.mjs": "attach\n",
    "scripts/pageshim/build.mjs": "build\n",
    "scripts/pageshim/runtime.ts": "export * from '../../packages/polyfill-connectors/src/runtime.ts';\n",
    "scripts/pageshim/shims/anthropic-export.ts": "shim\n",
    "scripts/pageshim/shims/buffer.js": "shim\n",
    "scripts/pageshim/shims/path.js": "shim\n",
    "scripts/pageshim/shims/process.js": "shim\n",
    "scripts/pageshim/shims/url.js": "shim\n",
    "scripts/pageshim/entries/gamma.ts": "import '../runtime.ts';\n",
  })) write(path, content);
  for (const name of ["alpha", "beta"]) {
    write(
      `connectors/${name}/index.ts`,
      "import { table } from '../../packages/polyfill-connectors/src/runtime.ts';\nexport { table };\n",
    );
  }
  for (const name of ["gamma", "delta"]) write(`connectors/${name}/index.ts`, `export const ${name} = true;\n`);
  if (layout === "sliced") {
    write(RESOLUTION, real(RESOLUTION));
    write(RENDERER, real(RENDERER));
    // The real PageShim builder imports both.
    write(
      "scripts/pageshim/build.mjs",
      "import '../consent-slice-resolution.mjs';\nimport '../../packages/polyfill-connectors/scripts/consent-time-fields-render.mjs';\n",
    );
  }
  writeManifests();
  regenerate();
  return {
    dir,
    fields,
    write,
    commit,
    regenerate,
    writeManifests,
    remove: (path) => rmSync(join(dir, path), { force: true }),
    hash: (commit, manifest) => artifactInputHash({ commit, manifest, cwd: dir }),
    hashes: async (commit) =>
      Object.fromEntries(
        await Promise.all(CONNECTORS.map(async (name) => [name, await artifactInputHash({ commit, manifest: name, cwd: dir })])),
      ),
  };
}

const changed = (before, after) => CONNECTORS.filter((name) => before[name] !== after[name]);

test("editing one connector's consent field changes only that connector's artifact hash", async () => {
  const repo = makeRepo();
  try {
    const before = await repo.hashes(repo.commit("base"));
    repo.fields.alpha = "seen_at";
    repo.writeManifests();
    repo.regenerate();
    const after = await repo.hashes(repo.commit("alpha consent edit"));
    assert.deepEqual(changed(before, after), ["alpha"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a consent edit reaching a PageShim bundle through the PageShim runtime changes only that bundle's connector", async () => {
  const repo = makeRepo();
  try {
    const before = await repo.hashes(repo.commit("base"));
    repo.fields.gamma = "seen_at";
    repo.writeManifests();
    repo.regenerate();
    const after = await repo.hashes(repo.commit("gamma consent edit"));
    assert.deepEqual(changed(before, after), ["gamma"]);
    repo.fields.beta = "seen_at";
    repo.writeManifests();
    repo.regenerate();
    const final = await repo.hashes(repo.commit("beta consent edit"));
    assert.deepEqual(changed(after, final), ["beta"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a change to the consent resolution policy changes every connector that bundles it", async () => {
  const repo = makeRepo();
  try {
    const before = await repo.hashes(repo.commit("base"));
    repo.write(RESOLUTION, `${real(RESOLUTION)}\n// a changed resolution rule\n`);
    const after = await repo.hashes(repo.commit("change the resolution policy"));
    assert.deepEqual(changed(before, after), CONNECTORS);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a change to the slice renderer that leaves every slice unchanged changes no artifact hash", async () => {
  const repo = makeRepo();
  try {
    const before = await repo.hashes(repo.commit("base"));
    repo.write(RENDERER, `${real(RENDERER)}\n// a renderer edit with identical output\n`);
    const after = await repo.hashes(repo.commit("edit the renderer"));
    assert.deepEqual(changed(before, after), []);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a missing slice for the selected connector fails closed", async () => {
  const repo = makeRepo();
  try {
    repo.remove(slicePath("alpha"));
    const commit = repo.commit("lose alpha's slice");
    await assert.rejects(repo.hash(commit, "alpha"), /alpha.*missing|missing.*alpha/);
    // Another connector's slice is not alpha's input.
    await assert.doesNotReject(repo.hash(commit, "beta"));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a missing slice for a PageShim-only connector fails closed", async () => {
  const repo = makeRepo();
  try {
    repo.remove(slicePath("gamma"));
    await assert.rejects(repo.hash(repo.commit("lose gamma's slice"), "gamma"), /gamma.*missing|missing.*gamma/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a slice that no longer matches its manifest fails closed", async () => {
  const repo = makeRepo();
  try {
    repo.fields.alpha = "seen_at";
    repo.writeManifests(); // the manifest moves; the slice is not regenerated
    const commit = repo.commit("edit the manifest without regenerating");
    await assert.rejects(repo.hash(commit, "alpha"), /alpha.*stale|stale.*alpha/);
    await assert.doesNotReject(repo.hash(commit, "beta"));
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a slice tampered by hand fails closed", async () => {
  const repo = makeRepo();
  try {
    repo.write(slicePath("alpha"), `${readFileSync(join(repo.dir, slicePath("alpha")), "utf8")}// hand edit\n`);
    await assert.rejects(repo.hash(repo.commit("hand edit"), "alpha"), /stale/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a commit from before the slice layout still hashes, with the aggregate as an input", async () => {
  const repo = makeRepo({ layout: "legacy" });
  try {
    const before = await repo.hashes(repo.commit("legacy base"));
    repo.fields.alpha = "seen_at";
    repo.writeManifests();
    repo.regenerate();
    const after = await repo.hashes(repo.commit("legacy alpha consent edit"));
    // The legacy layout bundles the whole table: this is what the slice layout removes.
    assert.deepEqual(changed(before, after), ["alpha", "beta", "gamma"]);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a checkout that has the resolution policy but no slices does not fall back to the aggregate", async () => {
  const repo = makeRepo({ layout: "legacy" });
  try {
    repo.write(RESOLUTION, real(RESOLUTION));
    repo.write(RENDERER, real(RENDERER));
    await assert.rejects(repo.hash(repo.commit("policy without slices"), "alpha"), /missing/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

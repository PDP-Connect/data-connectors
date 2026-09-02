// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { fetchResolvedArtifact, generateLock, installFromLock, loadConnectorIndex, verifyInstalled } from "../../packages/connector-installer-core/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const connectorRoot = join(root, "connectors", "github-pdpp");
const secret = "github-pdpp-test-secret";
const sha256 = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
const sha256Buffer = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const artifact = join(root, "artifacts", "github-pdpp", "github-pdpp-0.5.0.tgz");
const expectedCommit = "597cc012611df90d07edbed187ba3e3212dbf258";
const artifactEntrypoint = execFileSync("tar", ["-xOf", artifact, "./dist/collection-profile.mjs"]);
const smokeDirectory = mkdtempSync(join(tmpdir(), "github-pdpp-smoke-"));
const entrypoint = join(smokeDirectory, "collection-profile.mjs");
writeFileSync(entrypoint, artifactEntrypoint);
const pinnedFile = (repository, path) =>
  execFileSync("git", ["show", `${expectedCommit}:${path}`], { cwd: repository });

test.after(() => rmSync(smokeDirectory, { recursive: true, force: true }));

test("github-pdpp has canonical manifest, complete provenance, and Node-only bundle", () => {
  const manifest = JSON.parse(readFileSync(join(connectorRoot, "collection-profile.json"), "utf8"));
  const index = JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8"));
  const entry = index.connectors["github-pdpp"][0];
  const provenance = JSON.parse(readFileSync(join(connectorRoot, "provenance.json"), "utf8"));
  assert.equal(entry.connectorId, "github-pdpp");
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.artifactKind, "pdpp-collection-profile");
  assert.deepEqual(manifest.runtime_requirements.bindings, { network: { required: true } });
  assert.equal(entry.manifestSha256, sha256(join(connectorRoot, "collection-profile.json")));
  assert.equal(entry.entrypointSha256, sha256Buffer(artifactEntrypoint));
  assert.equal(entry.provenanceSha256, sha256(join(connectorRoot, "provenance.json")));
  assert.equal(provenance.outputs["profile/collection-profile.json"], entry.manifestSha256);
  assert.equal(provenance.outputs["dist/collection-profile.mjs"], entry.entrypointSha256);
  assert.equal(provenance.upstream.commit, "597cc012611df90d07edbed187ba3e3212dbf258");
  assert.equal(provenance.build.options.target, "node22");
  assert.deepEqual(provenance.outputs.unresolved_non_node_imports, []);
  assert.equal(provenance.source_inventory.upstream_connector.length, 5);
  assert.ok(provenance.source_inventory.upstream_runtime.length > 0);
  assert.deepEqual(provenance.source_inventory.bundled_dependencies.map((dependency) => ({
    name: dependency.name,
    version: dependency.version,
    files: dependency.files.length,
  })), [{ name: "zod", version: "4.4.3", files: 79 }]);
  assert.match(readFileSync(entrypoint, "utf8"), /Browser runtime is unavailable/);
  assert.doesNotMatch(execFileSync("tar", ["-xOf", artifact, "./provenance.json"], { encoding: "utf8" }), new RegExp(secret));
  assert.deepEqual(execFileSync("tar", ["-xOf", artifact, "./provenance.json"]), readFileSync(join(connectorRoot, "provenance.json")));
});

test("github-pdpp checked-in source matches its provenance inventory", () => {
  const provenance = JSON.parse(readFileSync(join(connectorRoot, "provenance.json"), "utf8"));
  for (const file of provenance.source_inventory.maintained_local) {
    assert.equal(sha256(join(connectorRoot, file.path)), file.sha256, `${file.path} must match its recorded source hash`);
  }
  assert.equal(existsSync(join(connectorRoot, "src", "runtime")), false);
  assert.equal(existsSync(join(connectorRoot, "src", "browser-runtime-unavailable.mjs")), false);
});

test("github-pdpp optionally verifies a dirty upstream worktree cannot affect the pinned rebuild", { skip: !process.env.PDPP_GITHUB_SOURCE_ROOT }, () => {
  const upstreamRoot = process.env.PDPP_GITHUB_SOURCE_ROOT;
  const upstream = "packages/polyfill-connectors";
  assert.deepEqual(
    JSON.parse(readFileSync(join(connectorRoot, "collection-profile.json"), "utf8")),
    JSON.parse(pinnedFile(upstreamRoot, `${upstream}/manifests/github.json`).toString("utf8")),
  );
  for (const file of ["parsers.ts", "types.ts"]) {
    assert.deepEqual(
      readFileSync(join(connectorRoot, "src", "connector", file)),
      pinnedFile(upstreamRoot, `${upstream}/connectors/github/${file}`),
      `${file} must remain a direct source copy`,
    );
  }
  assert.equal(
    readFileSync(join(connectorRoot, "src", "connector", "schemas.ts"), "utf8").replaceAll("../runtime/", "../../src/"),
    pinnedFile(upstreamRoot, `${upstream}/connectors/github/schemas.ts`).toString("utf8"),
    "schemas.ts may differ only at the runtime import seam",
  );
  const upstreamIndex = pinnedFile(upstreamRoot, `${upstream}/connectors/github/index.ts`).toString("utf8");
  const localIndex = readFileSync(join(connectorRoot, "src", "connector", "index.ts"), "utf8");
  assert.equal(
    localIndex.replaceAll("../runtime/", "../../src/"),
    upstreamIndex,
    "only the runtime import seam may differ",
  );
  const provenance = JSON.parse(readFileSync(join(connectorRoot, "provenance.json"), "utf8"));
  for (const file of provenance.source_inventory.upstream_runtime) {
    assert.equal(
      sha256Buffer(pinnedFile(upstreamRoot, file.path)),
      file.sha256,
      `${file.path} must match the pinned runtime inventory`,
    );
  }
  const before = sha256Buffer(artifactEntrypoint);
  const provenanceBefore = readFileSync(join(connectorRoot, "provenance.json"));
  const tempBase = join(homedir(), ".tmp");
  mkdirSync(tempBase, { recursive: true });
  const dirtyWorktree = mkdtempSync(join(tempBase, "github-pdpp-dirty-worktree-"));
  try {
    execFileSync("git", ["worktree", "add", "--detach", dirtyWorktree, expectedCommit], { cwd: upstreamRoot });
    writeFileSync(
      join(dirtyWorktree, `${upstream}/src/auth.ts`),
      "\nthrow new Error('dirty tracked source must not be packaged');\n",
      { flag: "a" },
    );
    writeFileSync(
      join(dirtyWorktree, `${upstream}/src/untracked-build-input.ts`),
      "throw new Error('untracked source must not be packaged');\n",
    );
    assert.notEqual(
      execFileSync("git", ["status", "--porcelain"], { cwd: dirtyWorktree, encoding: "utf8" }).trim(),
      "",
    );
    execFileSync(process.execPath, ["scripts/build-github-pdpp-artifact.mjs", "--pdpp-root", dirtyWorktree], { cwd: root });
    assert.equal(sha256(join(connectorRoot, "dist", "collection-profile.mjs")), before, "rebuild must ignore dirty source and remain byte-stable");
    assert.deepEqual(readFileSync(join(connectorRoot, "provenance.json")), provenanceBefore);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", dirtyWorktree], { cwd: upstreamRoot });
    rmSync(dirtyWorktree, { recursive: true, force: true });
  }
});

test("connector index generation prunes stale legacy and PDPP artifacts globally", () => {
  const staleLegacy = join(root, "artifacts", "github-playwright", "stale-legacy.tgz");
  const stalePdpp = join(root, "artifacts", "github-pdpp", "stale-pdpp.tgz");
  try {
    writeFileSync(staleLegacy, "stale legacy artifact");
    writeFileSync(stalePdpp, "stale PDPP artifact");
    execFileSync(process.execPath, ["scripts/generate-connector-index.mjs"], { cwd: root });
    assert.equal(existsSync(staleLegacy), false);
    assert.equal(existsSync(stalePdpp), false);
  } finally {
    rmSync(staleLegacy, { force: true });
    rmSync(stalePdpp, { force: true });
  }
});

test("PDPP artifact packaging leaves every legacy artifact and index entry byte-for-byte intact", () => {
  const base = process.env.PDPP_ARTIFACT_BASE_REF ?? "origin/main";
  const beforeIndex = JSON.parse(execFileSync("git", ["show", `${base}:connector-index.json`], { cwd: root, encoding: "utf8" }));
  const currentIndex = JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8"));
  for (const index of [beforeIndex, currentIndex]) {
    for (const [connectorId, versions] of Object.entries(index.connectors)) {
      if (versions.some((version) => version.artifactKind === "pdpp-collection-profile")) {
        delete index.connectors[connectorId];
      }
    }
  }
  assert.deepEqual(currentIndex, beforeIndex);
  const pdppArtifactPaths = new Set(
    Object.values(JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8")).connectors)
      .flatMap((versions) => versions)
      .filter((entry) => entry.artifactKind === "pdpp-collection-profile")
      .map((entry) => entry.artifactPath),
  );
  const legacyArtifacts = execFileSync("git", ["ls-tree", "-r", "--name-only", base, "artifacts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => path.endsWith(".tgz"))
    .filter((path) => existsSync(join(root, path)))
    .filter((path) => !pdppArtifactPaths.has(path));
  for (const artifact of legacyArtifacts) {
    assert.deepEqual(readFileSync(join(root, artifact)), execFileSync("git", ["show", `${base}:${artifact}`], { cwd: root }));
  }
});

test("github-pdpp subprocess completes START to RECORD, STATE, DONE through mocked fetch without secret leakage", () => {
  const result = spawnSync(process.execPath, ["--import", join(root, "test", "github-pdpp", "mock-fetch.mjs"), entrypoint], {
    cwd: root,
    env: { ...process.env, GITHUB_PERSONAL_ACCESS_TOKEN: secret },
    input: `${JSON.stringify({ type: "START", scope: { streams: [{ name: "user" }, { name: "repositories" }] }, state: {} })}\n`,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const messages = result.stdout.trim().split("\n").map(JSON.parse);
  const done = messages.at(-1);
  assert.equal(done.type, "DONE");
  assert.equal(done.status, "succeeded");
  assert.equal(done.records_emitted, 2);
  assert.deepEqual(messages.filter((message) => message.type === "RECORD").map((message) => message.stream), ["user", "repositories"]);
  assert.deepEqual(messages.filter((message) => message.type === "STATE").map((message) => message.stream), ["user", "repositories", "user"]);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${readFileSync(join(connectorRoot, "provenance.json"), "utf8")}`, new RegExp(secret));
});

test("github-pdpp artifact fetches, verifies, and locks through installer-core without a legacy projection", async () => {
  const source = await loadConnectorIndex({ fromLocal: root });
  const indexEntry = source.doc.connectors["github-pdpp"][0];
  const fetched = await fetchResolvedArtifact(source, indexEntry);
  assert.equal(fetched.entrypointPath, "dist/collection-profile.mjs");
  assert.equal(fetched.scriptBuffer, undefined);
  const lock = await generateLock({ dependencies: { connectors: { "github-pdpp": "0.5.0" } }, source, generatedAt: "2026-07-30T00:00:00.000Z" });
  assert.equal(lock.connectors[0].provenanceSha256, indexEntry.provenanceSha256);
  const installRoot = mkdtempSync(join(tmpdir(), "github-pdpp-install-"));
  test.after(() => rmSync(installRoot, { recursive: true, force: true }));
  await installFromLock({ lock, source, installRoot, layout: "snapshot" });
  const installedRoot = join(installRoot, "collection-profiles", "github-pdpp");
  assert.equal(sha256(join(installedRoot, indexEntry.manifestPath)), indexEntry.manifestSha256);
  assert.equal(sha256(join(installedRoot, indexEntry.entrypointPath)), indexEntry.entrypointSha256);
  assert.equal(sha256(join(installedRoot, indexEntry.provenancePath)), indexEntry.provenanceSha256);
  assert.equal((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).ok, true);
  writeFileSync(join(installedRoot, indexEntry.provenancePath), "tampered\n");
  assert.deepEqual((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).mismatched, [
    `collection-profiles/github-pdpp/${indexEntry.provenancePath}`,
  ]);
});

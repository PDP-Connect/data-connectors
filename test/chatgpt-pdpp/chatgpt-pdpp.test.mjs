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
const connectorRoot = join(root, "connectors", "chatgpt-pdpp");
const artifact = join(root, "artifacts", "chatgpt-pdpp", "chatgpt-pdpp-0.1.0.tgz");
const expectedCommit = "76effa378dc40b269095db6f85682d6a10920f68";
const sha256 = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
const sha256Buffer = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const pinnedFile = (repository, path) =>
  execFileSync("git", ["show", `${expectedCommit}:${path}`], { cwd: repository });
const pdppSourceRoot = process.env.PDPP_CHATGPT_SOURCE_ROOT;

test("chatgpt-pdpp preserves the canonical browser profile and complete stream contract", () => {
  const manifest = JSON.parse(readFileSync(join(connectorRoot, "collection-profile.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(connectorRoot, "provenance.json"), "utf8"));
  const index = JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8"));
  const entry = index.connectors["chatgpt-pdpp"][0];
  const entrypoint = execFileSync("tar", ["-xOf", artifact, "./dist/collection-profile.mjs"]);

  assert.equal(entry.artifactKind, "pdpp-collection-profile");
  assert.equal(entry.version, manifest.version);
  assert.deepEqual(manifest.runtime_requirements.bindings, { network: { required: true }, browser: { required: true } });
  assert.deepEqual(manifest.capabilities.human_interaction, ["manual_action"]);
  assert.deepEqual(manifest.streams.map((stream) => stream.name), [
    "conversations", "messages", "memories", "custom_gpts", "custom_instructions", "shared_conversations",
  ]);
  assert.deepEqual(manifest.streams.filter((stream) => stream.incremental).map((stream) => stream.name), manifest.streams.map((stream) => stream.name));
  assert.deepEqual(manifest.streams.map((stream) => stream.coverage_strategy), [
    "checkpoint_window", "parent_detail_accounting", "full_inventory", "full_inventory", "singleton_presence", "checkpoint_window",
  ]);
  assert.equal(provenance.upstream.commit, expectedCommit);
  assert.deepEqual(provenance.runtime_requirements, manifest.runtime_requirements);
  assert.deepEqual(provenance.external_runtime_packages, [
    { name: "@pdpp/connector-protocol", version: "^1.0.0" },
    { name: "@pdpp/connector-protocol/auth", version: "^1.0.0" },
    { name: "@pdpp/connector-protocol/http-retry", version: "^1.0.0" },
    { name: "@pdpp/connector-protocol/pdpp-safe-text", version: "^1.0.0" },
    { name: "p-queue", version: "^9.3.3" },
    { name: "patchright", version: "^1.61.1" },
  ]);
  assert.deepEqual(provenance.source_inventory.bundled_dependencies.map((dependency) => ({
    name: dependency.name,
    version: dependency.version,
    files: dependency.files.length,
  })), [{ name: "zod", version: "4.5.2", files: 94 }]);
  assert.deepEqual(provenance.outputs.undeclared_external_imports, []);
  assert.equal(provenance.source_inventory.upstream_connector.length, 6);
  assert.ok(provenance.source_inventory.upstream_runtime.length > 0);
  assert.equal(entry.manifestSha256, sha256(join(connectorRoot, "collection-profile.json")));
  assert.equal(entry.entrypointSha256, sha256Buffer(entrypoint));
  assert.equal(entry.provenanceSha256, sha256(join(connectorRoot, "provenance.json")));
  assert.match(entrypoint.toString("utf8"), /DETAIL_GAP/);
  assert.match(entrypoint.toString("utf8"), /INTERACTION/);
  assert.match(entrypoint.toString("utf8"), /AdaptiveLaneCancelledError/);
});

test("chatgpt-pdpp artifact installs and detects provenance tampering", async () => {
  const source = await loadConnectorIndex({ fromLocal: root });
  const entry = source.doc.connectors["chatgpt-pdpp"][0];
  const fetched = await fetchResolvedArtifact(source, entry);
  assert.equal(fetched.entrypointPath, "dist/collection-profile.mjs");
  const lock = await generateLock({ dependencies: { connectors: { "chatgpt-pdpp": "0.1.0" } }, source, generatedAt: "2026-07-31T00:00:00.000Z" });
  const installRoot = mkdtempSync(join(tmpdir(), "chatgpt-pdpp-install-"));
  try {
    await installFromLock({ lock, source, installRoot, layout: "snapshot" });
    const installed = join(installRoot, "collection-profiles", "chatgpt-pdpp");
    assert.equal(sha256(join(installed, entry.entrypointPath)), entry.entrypointSha256);
    assert.equal((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).ok, true);
    writeFileSync(join(installed, entry.provenancePath), "tampered\n");
    assert.deepEqual((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).mismatched, [
      `collection-profiles/chatgpt-pdpp/${entry.provenancePath}`,
    ]);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("chatgpt-pdpp rebuild is pinned and unaffected by dirty upstream source", { skip: !pdppSourceRoot && !process.env.CI }, () => {
  assert.ok(pdppSourceRoot, "PDPP_CHATGPT_SOURCE_ROOT is required in CI for the pinned-source test");
  const upstreamRoot = pdppSourceRoot;
  const specification = JSON.parse(readFileSync(join(connectorRoot, "artifact.json"), "utf8"));
  const provenanceBefore = readFileSync(join(connectorRoot, "provenance.json"));
  const provenance = JSON.parse(provenanceBefore);
  const entrypointBefore = execFileSync("tar", ["-xOf", artifact, "./dist/collection-profile.mjs"]);
  for (const sourceInventory of [
    provenance.source_inventory.upstream_connector,
    provenance.source_inventory.upstream_runtime,
  ]) {
    for (const file of sourceInventory) {
      assert.deepEqual(
        sha256Buffer(pinnedFile(upstreamRoot, file.path)),
        file.sha256,
        `${file.path} must equal the cc07e3a source closure`,
      );
    }
  }
  assert.deepEqual(
    readFileSync(join(connectorRoot, "collection-profile.json")),
    pinnedFile(upstreamRoot, specification.upstream.manifest),
    "the canonical profile must equal the cc07e3a manifest byte-for-byte",
  );
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: upstreamRoot, encoding: "utf8" }),
    "",
    "the reproducibility source must start clean",
  );
  execFileSync(process.execPath, ["scripts/build-pdpp-artifact.mjs", "--artifact", "chatgpt-pdpp", "--pdpp-root", upstreamRoot], { cwd: root });
  assert.deepEqual(readFileSync(join(connectorRoot, "provenance.json")), provenanceBefore);
  assert.deepEqual(readFileSync(join(connectorRoot, "dist", "collection-profile.mjs")), entrypointBefore);
  const tempBase = join(homedir(), ".tmp");
  mkdirSync(tempBase, { recursive: true });
  const dirtyWorktree = mkdtempSync(join(tempBase, "chatgpt-pdpp-dirty-worktree-"));
  rmSync(dirtyWorktree, { recursive: true, force: true });
  try {
    execFileSync("git", ["worktree", "add", "--detach", dirtyWorktree, expectedCommit], { cwd: upstreamRoot });
    const dirtyRuntime = join(dirtyWorktree, "packages", "polyfill-connectors", "src", "adaptive-lane.ts");
    writeFileSync(dirtyRuntime, "\nthrow new Error('dirty tracked runtime must not be packaged');\n", { flag: "a" });
    assert.notEqual(execFileSync("git", ["status", "--porcelain"], { cwd: dirtyWorktree, encoding: "utf8" }).trim(), "");
    execFileSync(process.execPath, ["scripts/build-pdpp-artifact.mjs", "--artifact", "chatgpt-pdpp", "--pdpp-root", dirtyWorktree], { cwd: root });
    assert.deepEqual(readFileSync(join(connectorRoot, "provenance.json")), provenanceBefore);
    assert.deepEqual(readFileSync(join(connectorRoot, "dist", "collection-profile.mjs")), entrypointBefore);
  } finally {
    if (existsSync(dirtyWorktree)) {
      execFileSync("git", ["worktree", "remove", "--force", dirtyWorktree], { cwd: upstreamRoot });
      rmSync(dirtyWorktree, { recursive: true, force: true });
    }
  }
});

test("bundled zod tampering changes provenance and output, then fails the immutable index gate", { skip: !pdppSourceRoot && !process.env.CI }, () => {
  assert.ok(pdppSourceRoot, "PDPP_CHATGPT_SOURCE_ROOT is required in CI for the bundled-dependency test");
  const provenancePath = join(connectorRoot, "provenance.json");
  const entrypointPath = join(connectorRoot, "dist", "collection-profile.mjs");
  const provenanceBefore = readFileSync(provenancePath);
  const entrypointBefore = readFileSync(entrypointPath);
  const provenance = JSON.parse(provenanceBefore);
  const zod = provenance.source_inventory.bundled_dependencies.find((dependency) => dependency.name === "zod");
  assert.ok(zod, "zod must be recorded as a bundled dependency");
  const source = join(root, zod.package_path, "v4/core/util.js");
  const original = readFileSync(source);
  try {
    writeFileSync(source, "\nexport const PDPP_PROVENANCE_TAMPER_CANARY = 'zod';\n", { flag: "a" });
    const provenanceCheck = spawnSync(process.execPath, ["scripts/generate-connector-index.mjs", "--check"], { cwd: root, encoding: "utf8" });
    assert.notEqual(provenanceCheck.status, 0);
    assert.match(`${provenanceCheck.stdout}\n${provenanceCheck.stderr}`, /chatgpt-pdpp@0\.1\.0 bundled dependency changed without a version bump: zod\/v4\/core\/util\.js/);
    execFileSync(process.execPath, ["scripts/build-pdpp-artifact.mjs", "--artifact", "chatgpt-pdpp", "--pdpp-root", pdppSourceRoot], { cwd: root });
    const provenanceAfter = readFileSync(provenancePath);
    const entrypointAfter = readFileSync(entrypointPath);
    assert.notDeepEqual(provenanceAfter, provenanceBefore);
    assert.notDeepEqual(entrypointAfter, entrypointBefore);
    assert.match(entrypointAfter.toString("utf8"), /PDPP_PROVENANCE_TAMPER_CANARY/);
    const recordedZod = JSON.parse(provenanceAfter).source_inventory.bundled_dependencies.find((dependency) => dependency.name === "zod");
    assert.notEqual(recordedZod.closure_sha256, zod.closure_sha256);
    const indexCheck = spawnSync(process.execPath, ["scripts/generate-connector-index.mjs", "--check"], { cwd: root, encoding: "utf8" });
    assert.notEqual(indexCheck.status, 0);
    assert.match(`${indexCheck.stdout}\n${indexCheck.stderr}`, /chatgpt-pdpp@0\.1\.0 source changed without a version bump/);
  } finally {
    writeFileSync(source, original);
    execFileSync(process.execPath, ["scripts/build-pdpp-artifact.mjs", "--artifact", "chatgpt-pdpp", "--pdpp-root", pdppSourceRoot], { cwd: root });
    assert.deepEqual(readFileSync(provenancePath), provenanceBefore);
    assert.deepEqual(readFileSync(entrypointPath), entrypointBefore);
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  fetchResolvedArtifact,
  generateLock,
  installFromLock,
  loadConnectorIndex,
  verifyInstalled,
} from "../../packages/connector-installer-core/index.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const connectorRoot = join(root, "connectors", "whoop-pdpp");
const artifact = join(root, "artifacts", "whoop-pdpp", "whoop-pdpp-0.1.0.tgz");
const expectedCommit = "ef2eb4137d51135dd063edc5cf7771be61c32c13";
const pdppSourceRoot = process.env.PDPP_WHOOP_SOURCE_ROOT;
const sha256 = (file) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
const sha256Buffer = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const pinnedFile = (repository, path) =>
  execFileSync("git", ["show", `${expectedCommit}:${path}`], { cwd: repository });

test("whoop-pdpp preserves the browser-session profile and six-stream contract", () => {
  const manifest = JSON.parse(readFileSync(join(connectorRoot, "collection-profile.json"), "utf8"));
  const provenance = JSON.parse(readFileSync(join(connectorRoot, "provenance.json"), "utf8"));
  const index = JSON.parse(readFileSync(join(root, "connector-index.json"), "utf8"));
  const entry = index.connectors["whoop-pdpp"][0];
  const entrypoint = execFileSync("tar", ["-xOf", artifact, "./dist/collection-profile.mjs"]);

  assert.equal(entry.artifactKind, "pdpp-collection-profile");
  assert.equal(entry.version, manifest.version);
  assert.deepEqual(manifest.runtime_requirements.bindings, {
    network: { required: true },
    browser: { required: true },
  });
  assert.deepEqual(manifest.capabilities.human_interaction, ["manual_action"]);
  assert.equal(manifest.capabilities.refresh_policy.background_safe, true);
  assert.deepEqual(
    manifest.streams.map((stream) => stream.name),
    ["profile", "body", "cycles", "recoveries", "sleeps", "workouts"],
  );
  assert.equal(provenance.upstream.commit, expectedCommit);
  assert.deepEqual(provenance.runtime_requirements, manifest.runtime_requirements);
  assert.deepEqual(provenance.external_runtime_packages, [
    { name: "patchright", version: "^1.61.1" },
  ]);
  assert.deepEqual(provenance.outputs.undeclared_external_imports, []);
  assert.equal(entry.manifestSha256, sha256(join(connectorRoot, "collection-profile.json")));
  assert.equal(entry.entrypointSha256, sha256Buffer(entrypoint));
  assert.equal(entry.provenanceSha256, sha256(join(connectorRoot, "provenance.json")));
  assert.match(entrypoint.toString("utf8"), /whoop-auth-token/);
  assert.match(entrypoint.toString("utf8"), /cycles\/details/);
});

test("whoop-pdpp artifact installs and detects provenance tampering", async () => {
  const source = await loadConnectorIndex({ fromLocal: root });
  const entry = source.doc.connectors["whoop-pdpp"][0];
  const fetched = await fetchResolvedArtifact(source, entry);
  assert.equal(fetched.entrypointPath, "dist/collection-profile.mjs");
  const lock = await generateLock({
    dependencies: { connectors: { "whoop-pdpp": "0.1.0" } },
    source,
    generatedAt: "2026-08-13T00:00:00.000Z",
  });
  const installRoot = mkdtempSync(join(tmpdir(), "whoop-pdpp-install-"));
  try {
    await installFromLock({ lock, source, installRoot, layout: "snapshot" });
    const installed = join(installRoot, "collection-profiles", "whoop-pdpp");
    assert.equal(sha256(join(installed, entry.entrypointPath)), entry.entrypointSha256);
    assert.equal((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).ok, true);
    writeFileSync(join(installed, entry.provenancePath), "tampered\n");
    assert.deepEqual((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).mismatched, [
      `collection-profiles/whoop-pdpp/${entry.provenancePath}`,
    ]);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test("whoop-pdpp rebuild is pinned to the reviewed PDPP commit", { skip: !pdppSourceRoot }, () => {
  const specification = JSON.parse(readFileSync(join(connectorRoot, "artifact.json"), "utf8"));
  const provenanceBefore = readFileSync(join(connectorRoot, "provenance.json"));
  const entrypointBefore = readFileSync(join(connectorRoot, "dist", "collection-profile.mjs"));
  const provenance = JSON.parse(provenanceBefore);

  for (const sourceInventory of [
    provenance.source_inventory.upstream_connector,
    provenance.source_inventory.upstream_runtime,
  ]) {
    for (const file of sourceInventory) {
      assert.equal(sha256Buffer(pinnedFile(pdppSourceRoot, file.path)), file.sha256);
    }
  }
  assert.deepEqual(
    readFileSync(join(connectorRoot, "collection-profile.json")),
    pinnedFile(pdppSourceRoot, specification.upstream.manifest),
  );
  execFileSync(
    process.execPath,
    ["scripts/build-pdpp-artifact.mjs", "--artifact", "whoop-pdpp", "--pdpp-root", pdppSourceRoot],
    { cwd: root },
  );
  assert.deepEqual(readFileSync(join(connectorRoot, "provenance.json")), provenanceBefore);
  assert.deepEqual(readFileSync(join(connectorRoot, "dist", "collection-profile.mjs")), entrypointBefore);
});

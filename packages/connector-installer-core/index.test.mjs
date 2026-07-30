import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  fetchResolvedArtifact,
  generateLock,
  installFromLock,
  loadConnectorIndex,
  resolveConnectorArtifacts,
  verifyInstalled,
} from "./index.mjs";

function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function createArtifact(root, files) {
  const bundleDir = join(root, "bundle");
  const artifactPath = join(root, "artifact.tgz");
  mkdirSync(bundleDir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const target = join(bundleDir, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  execFileSync("tar", ["-czf", artifactPath, "-C", bundleDir, "."]);
  return { artifactPath, artifactBuffer: readFileSync(artifactPath) };
}

function baseEntry(overrides = {}) {
  return {
    connectorId: "synthetic-profile",
    company: "Synthetic",
    version: "1.0.0",
    name: "Synthetic profile",
    description: "Synthetic contract fixture",
    publishedAt: "2026-07-30T00:00:00.000Z",
    sourceTag: "test",
    sourceCommit: "a".repeat(40),
    releaseId: "test",
    artifactPath: "artifact.tgz",
    artifactUrl: "https://example.test/artifact.tgz",
    ...overrides,
  };
}

function pdppFixture(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "pdpp-artifact-test-"));
  const manifestPath = "profile/collection-profile.json";
  const entrypointPath = "dist/collection-profile.cjs";
  const manifestBuffer = Buffer.from('{"version":"1.0.0","profileVersion":"1"}\n');
  const entrypointBuffer = Buffer.from("export default {};\n");
  const artifact = createArtifact(root, {
    [manifestPath]: manifestBuffer,
    [entrypointPath]: entrypointBuffer,
  });
  const entry = baseEntry({
    artifactKind: "pdpp-collection-profile",
    manifestPath,
    entrypointPath,
    artifactSha256: sha256(artifact.artifactBuffer),
    manifestSha256: sha256(manifestBuffer),
    entrypointSha256: sha256(entrypointBuffer),
    ...overrides,
  });
  return { root, entry, manifestBuffer, entrypointBuffer };
}

function legacyFixture() {
  const root = mkdtempSync(join(tmpdir(), "legacy-artifact-test-"));
  const manifestBuffer = Buffer.from(
    '{"connector_id":"legacy-connector","version":"1.0.0","name":"Legacy"}\n',
  );
  const scriptBuffer = Buffer.from("module.exports = {};\n");
  const artifact = createArtifact(root, {
    "manifest.json": manifestBuffer,
    "script.js": scriptBuffer,
  });
  const entry = baseEntry({
    connectorId: "legacy-connector",
    name: "Legacy",
    artifactSha256: sha256(artifact.artifactBuffer),
    manifestSha256: sha256(manifestBuffer),
    scriptSha256: sha256(scriptBuffer),
    sourceFiles: {
      metadata: "synthetic/legacy-connector.json",
      script: "synthetic/legacy-connector.js",
    },
  });
  return { root, entry, manifestBuffer, scriptBuffer };
}

test("accepts a PDPP Collection Profile bundle and records its discriminated lock entry", async () => {
  const fixture = pdppFixture();
  writeFileSync(
    join(fixture.root, "connector-index.json"),
    JSON.stringify({ connectors: { [fixture.entry.connectorId]: [fixture.entry] } }),
  );
  const source = await loadConnectorIndex({ fromLocal: fixture.root });
  const resolution = await resolveConnectorArtifacts({
    dependencies: { connectors: { [fixture.entry.connectorId]: "1.0.0" } },
    source,
  });
  assert.equal(resolution.resolved[0].entrypointPath, fixture.entry.entrypointPath);
  assert.deepEqual(resolution.resolved[0].entrypointBuffer, fixture.entrypointBuffer);

  const lock = await generateLock({
    dependencies: { connectors: { [fixture.entry.connectorId]: "1.0.0" } },
    source,
    generatedAt: "2026-07-30T00:00:00.000Z",
  });
  assert.deepEqual(lock.connectors[0].artifactKind, "pdpp-collection-profile");
  assert.deepEqual(lock.connectors[0].entrypointPath, fixture.entry.entrypointPath);
  assert.equal(lock.connectors[0].scriptSha256, undefined);
});

test("rejects a PDPP bundle whose declared entrypoint is missing", async () => {
  const fixture = pdppFixture({ entrypointPath: "dist/missing.cjs" });
  await assert.rejects(
    () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
    /Artifact missing dist\/missing\.cjs/,
  );
});

test("rejects absolute, backslash, and traversal PDPP entrypoint paths", async (t) => {
  for (const path of ["/outside.cjs", "dist\\outside.cjs", "dist/../outside.cjs"]) {
    await t.test(path, async () => {
      const fixture = pdppFixture({ entrypointPath: path });
      await assert.rejects(
        () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
        /Invalid pdpp entrypoint path/i,
      );
    });
  }
});

test("rejects link entries before unpacking a PDPP artifact", async () => {
  const fixture = pdppFixture();
  symlinkSync(
    "dist/collection-profile.cjs",
    join(fixture.root, "bundle", "linked-entrypoint.cjs"),
  );
  execFileSync("tar", ["-czf", join(fixture.root, "artifact.tgz"), "-C", join(fixture.root, "bundle"), "."]);
  fixture.entry.artifactSha256 = sha256(readFileSync(join(fixture.root, "artifact.tgz")));
  const artifactTempDirsBefore = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith("connector-artifact-")),
  );
  await assert.rejects(
    () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
    /Artifact contains unsupported link entry/,
  );
  const artifactTempDirsAfter = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith("connector-artifact-")),
  );
  assert.deepEqual(artifactTempDirsAfter, artifactTempDirsBefore);
});

test("rejects artifact, manifest, and entrypoint digest mismatches", async (t) => {
  for (const field of ["artifactSha256", "manifestSha256", "entrypointSha256"]) {
    await t.test(field, async () => {
      const fixture = pdppFixture({ [field]: `sha256:${"0".repeat(64)}` });
      await assert.rejects(
        () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
        /checksum mismatch/,
      );
    });
  }
});

test("fails closed for unknown artifact kinds", async () => {
  const fixture = pdppFixture({ artifactKind: "unrecognized-artifact" });
  await assert.rejects(
    () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
    /Unsupported artifact kind "unrecognized-artifact"/,
  );
});

test("legacy bundle resolution and both legacy install layouts remain unchanged", async () => {
  const fixture = legacyFixture();
  const source = { mode: "local", rootDir: fixture.root, doc: { connectors: { [fixture.entry.connectorId]: [fixture.entry] } } };
  const dependencies = { connectors: { [fixture.entry.connectorId]: "1.0.0" } };
  const lock = await generateLock({ dependencies, source, generatedAt: "2026-07-30T00:00:00.000Z" });
  assert.equal(lock.connectors[0].artifactKind, undefined);
  assert.equal(lock.connectors[0].scriptSha256, fixture.entry.scriptSha256);
  const fetched = await fetchResolvedArtifact(source, fixture.entry);
  assert.deepEqual(fetched.scriptBuffer, fixture.scriptBuffer);
  assert.equal(fetched.checksums.script, fixture.entry.scriptSha256);

  const snapshotRoot = join(fixture.root, "snapshot");
  await installFromLock({ lock, source, installRoot: snapshotRoot, layout: "snapshot" });
  assert.deepEqual(readFileSync(join(snapshotRoot, "manifests", "legacy-connector.json")), fixture.manifestBuffer);
  assert.deepEqual(readFileSync(join(snapshotRoot, "scripts", "legacy-connector.js")), fixture.scriptBuffer);
  assert.equal((await verifyInstalled({ lock, source, installRoot: snapshotRoot, layout: "snapshot" })).ok, true);

  const sourceRoot = join(fixture.root, "source");
  await installFromLock({ lock, source, installRoot: sourceRoot, layout: "source" });
  assert.deepEqual(readFileSync(join(sourceRoot, "synthetic", "legacy-connector.json")), fixture.manifestBuffer);
  assert.deepEqual(readFileSync(join(sourceRoot, "synthetic", "legacy-connector.js")), fixture.scriptBuffer);
});

test("legacy install layouts explicitly reject PDPP artifacts", async () => {
  const fixture = pdppFixture();
  const source = { mode: "local", rootDir: fixture.root, doc: { connectors: { [fixture.entry.connectorId]: [fixture.entry] } } };
  const lock = await generateLock({
    dependencies: { connectors: { [fixture.entry.connectorId]: "1.0.0" } },
    source,
  });
  await assert.rejects(
    () => installFromLock({ lock, source, installRoot: join(fixture.root, "install"), layout: "snapshot" }),
    /does not support pdpp-collection-profile artifacts/,
  );
});

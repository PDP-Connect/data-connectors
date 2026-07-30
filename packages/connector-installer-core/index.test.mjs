import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
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
  pruneInstalled,
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
  const manifestPath = overrides.manifestPath ?? "profile/collection-profile.json";
  const entrypointPath = overrides.entrypointPath ?? "dist/collection-profile.cjs";
  const manifestBuffer = Buffer.from('{"version":"1.0.0","profileVersion":"1"}\n');
  const entrypointBuffer = Buffer.from("export default {};\n");
  const safeFixturePath = (path, fallback) =>
    typeof path === "string" &&
    path !== "." &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.split("/").includes("..")
      ? path
      : fallback;
  const artifact = createArtifact(root, {
    [safeFixturePath(manifestPath, "profile/collection-profile.json")]: manifestBuffer,
    [safeFixturePath(entrypointPath, "dist/collection-profile.cjs")]: entrypointBuffer,
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
  const fixture = pdppFixture();
  fixture.entry.entrypointPath = "dist/missing.cjs";
  await assert.rejects(
    () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
    /Artifact missing dist\/missing\.cjs/,
  );
});

test("runtime enforces the portable bundle-path contract", async (t) => {
  const invalidPaths = [
    [".", false],
    ["dist/\0profile.cjs", false],
    ["/outside.cjs", false],
    ["C:relative.cjs", false],
    ["C:/outside.cjs", false],
    ["dist\\outside.cjs", false],
    ["dist/../outside.cjs", false],
  ];
  const cases = [
    ["manifestPath", "profile/collection-profile.json"],
    ["entrypointPath", "dist/collection-profile.cjs"],
  ];
  for (const [field, validPath] of cases) {
    for (const [path, accepted] of [[validPath, true], ...invalidPaths]) {
      await t.test(`${field}=${JSON.stringify(path)}`, async () => {
        const fixture = pdppFixture({ [field]: path });
        const fetch = () =>
          fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry);
        if (accepted) {
          await assert.doesNotReject(fetch);
          return;
        }
        await assert.rejects(
          fetch,
          /Invalid pdpp .* path/i,
        );
      });
    }
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
    /Artifact contains unsupported archive entry type "l"/,
  );
  const artifactTempDirsAfter = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith("connector-artifact-")),
  );
  assert.deepEqual(artifactTempDirsAfter, artifactTempDirsBefore);
});

test("rejects FIFO archive entries before extraction and cleans up", async () => {
  const fixture = pdppFixture();
  execFileSync("mkfifo", [join(fixture.root, "bundle", "payload.fifo")]);
  execFileSync("tar", ["-czf", join(fixture.root, "artifact.tgz"), "-C", join(fixture.root, "bundle"), "."]);
  fixture.entry.artifactSha256 = sha256(readFileSync(join(fixture.root, "artifact.tgz")));
  const artifactTempDirsBefore = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith("connector-artifact-")),
  );
  await assert.rejects(
    () => fetchResolvedArtifact({ mode: "local", rootDir: fixture.root }, fixture.entry),
    /Artifact contains unsupported archive entry type "p"/,
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
  assert.deepEqual(fetched, {
    manifest: JSON.parse(fixture.manifestBuffer),
    manifestBuffer: fixture.manifestBuffer,
    scriptBuffer: fixture.scriptBuffer,
    schemaFiles: [],
    assetFiles: [],
    readme: null,
    checksums: {
      artifact: fixture.entry.artifactSha256,
      manifest: fixture.entry.manifestSha256,
      script: fixture.entry.scriptSha256,
    },
  });

  const resolution = await resolveConnectorArtifacts({ dependencies, source });
  assert.deepEqual(resolution.resolved[0], {
    connectorId: fixture.entry.connectorId,
    constraint: "1.0.0",
    entry: fixture.entry,
    ...fetched,
  });

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

test("pruning preserves configured link subtrees and removes only unpreserved links", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "prune-install-test-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "prune-external-test-"));
  const externalFile = join(externalRoot, "must-survive.txt");
  writeFileSync(externalFile, "outside\n");
  writeFileSync(join(installRoot, "expected.txt"), "expected\n");
  symlinkSync(externalRoot, join(installRoot, "preserved-link"));
  mkdirSync(join(installRoot, "preserved-subtree"), { recursive: true });
  symlinkSync(externalRoot, join(installRoot, "preserved-subtree", "nested-link"));
  symlinkSync(externalRoot, join(installRoot, "remove-link"));

  pruneInstalled({
    installRoot,
    expectedPaths: ["expected.txt"],
    preserveTopLevel: ["preserved-link", "preserved-subtree"],
  });

  assert.equal(lstatSync(join(installRoot, "preserved-link")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(installRoot, "preserved-subtree", "nested-link")).isSymbolicLink(), true);
  assert.equal(existsSync(join(installRoot, "remove-link")), false);
  assert.equal(readFileSync(externalFile, "utf8"), "outside\n");
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

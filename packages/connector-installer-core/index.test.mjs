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
  DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
  defaultArtifactCertificateIdentityResolver,
  fetchResolvedArtifact,
  generateLock,
  installFromLock,
  loadConnectorIndex,
  pruneInstalled,
  resolveConnectorArtifacts,
  verifyInstalled,
} from "./index.mjs";

const VANA_LEGACY_CERTIFICATE_IDENTITY =
  "https://github.com/vana-com/data-connectors/.github/workflows/publish-connectors.yml@refs/heads/main";

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
  const provenancePath = overrides.provenancePath ?? "provenance.json";
  const manifestBuffer = Buffer.from('{"version":"1.0.0","profileVersion":"1"}\n');
  const entrypointBuffer = Buffer.from("export default {};\n");
  const provenanceBuffer = Buffer.from('{"upstream":{"commit":"test"}}\n');
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
    [safeFixturePath(provenancePath, "provenance.json")]: provenanceBuffer,
  });
  const entry = baseEntry({
    artifactKind: "pdpp-collection-profile",
    manifestPath,
    entrypointPath,
    artifactSha256: sha256(artifact.artifactBuffer),
    manifestSha256: sha256(manifestBuffer),
    entrypointSha256: sha256(entrypointBuffer),
    provenancePath,
    provenanceSha256: sha256(provenanceBuffer),
    ...overrides,
  });
  return { root, entry, manifestBuffer, entrypointBuffer, provenanceBuffer };
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

async function withRemoteArtifactFetch(routes, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const route = routes[String(url)];
    if (!route) {
      return new Response("not found\n", { status: 404, statusText: "Not Found" });
    }
    return new Response(route);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function artifactVerifierFor(expectedCertificateIdentityURI) {
  return async (_bundle, _payloadBuffer, options) => {
    assert.equal(options.certificateIdentityURI, expectedCertificateIdentityURI);
  };
}

async function fetchRemoteLegacyArtifactWithIdentity({
  artifactUrl,
  resolver,
  expectedCertificateIdentityURI,
  entryOverrides = {},
}) {
  const fixture = legacyFixture();
  const bundleUrl = `${artifactUrl}.sigstore.json`;
  const entry = {
    ...fixture.entry,
    artifactPath: null,
    artifactUrl,
    artifactSignature: {
      type: "sigstoreBundle",
      bundleUrl,
    },
    ...entryOverrides,
  };

  return withRemoteArtifactFetch(
    {
      [artifactUrl]: readFileSync(join(fixture.root, "artifact.tgz")),
      [bundleUrl]: Buffer.from("{}\n"),
    },
    () =>
      fetchResolvedArtifact(
        { mode: "remote", doc: { connectors: { [entry.connectorId]: [entry] } } },
        entry,
        {
          artifactCertificateIdentityResolver: resolver,
          sigstoreVerifier: artifactVerifierFor(expectedCertificateIdentityURI),
        },
      ),
  );
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
    ["provenancePath", "provenance.json"],
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

test("rejects artifact, manifest, entrypoint, and provenance digest mismatches", async (t) => {
  for (const field of ["artifactSha256", "manifestSha256", "entrypointSha256", "provenanceSha256"]) {
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

test("remote artifact verification defaults to the PDP workflow identity", async () => {
  const artifact = await fetchRemoteLegacyArtifactWithIdentity({
    artifactUrl:
      "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-test/legacy-connector-1.0.0.tgz",
    expectedCertificateIdentityURI: DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
  });

  assert.equal(artifact.manifest.connector_id, "legacy-connector");
});

test("remote artifact verification accepts a caller-mapped legacy Vana signer", async () => {
  const artifactUrl =
    "https://github.com/vana-com/data-connectors/releases/download/connectors-test/legacy-connector-1.0.0.tgz";
  const resolverCalls = [];
  const artifact = await fetchRemoteLegacyArtifactWithIdentity({
    artifactUrl,
    expectedCertificateIdentityURI: VANA_LEGACY_CERTIFICATE_IDENTITY,
    resolver: ({ artifactUrl: url, entry }) => {
      resolverCalls.push({ artifactUrl: url, connectorId: entry.connectorId });
      if (new URL(url).hostname === "github.com" && url.includes("/vana-com/data-connectors/")) {
        return VANA_LEGACY_CERTIFICATE_IDENTITY;
      }
      return null;
    },
  });

  assert.equal(artifact.manifest.connector_id, "legacy-connector");
  assert.deepEqual(resolverCalls, [{ artifactUrl, connectorId: "legacy-connector" }]);
});

test("remote artifact verification rejects a caller-selected wrong signer", async () => {
  await assert.rejects(
    () =>
      fetchRemoteLegacyArtifactWithIdentity({
        artifactUrl:
          "https://github.com/vana-com/data-connectors/releases/download/connectors-test/legacy-connector-1.0.0.tgz",
        resolver: () => DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
        expectedCertificateIdentityURI: VANA_LEGACY_CERTIFICATE_IDENTITY,
      }),
    /signature verification failed: Expected values to be strictly equal/,
  );
});

test("remote artifact verification fails closed when caller policy rejects the artifact origin", async () => {
  await assert.rejects(
    () =>
      fetchRemoteLegacyArtifactWithIdentity({
        artifactUrl:
          "https://evil.example/connectors/releases/download/connectors-test/legacy-connector-1.0.0.tgz",
        resolver: ({ artifactUrl: url }) => {
          if (new URL(url).hostname === "github.com") {
            return VANA_LEGACY_CERTIFICATE_IDENTITY;
          }
          return null;
        },
        expectedCertificateIdentityURI: VANA_LEGACY_CERTIFICATE_IDENTITY,
      }),
    /No trusted Sigstore certificate identity configured/,
  );
});

test("remote artifact verification ignores identity metadata supplied by the connector index", async () => {
  await fetchRemoteLegacyArtifactWithIdentity({
    artifactUrl:
      "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-test/legacy-connector-1.0.0.tgz",
    expectedCertificateIdentityURI: DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
    entryOverrides: {
      certificateIdentityURI:
        "https://github.com/attacker/data-connectors/.github/workflows/publish.yml@refs/heads/main",
    },
  });
  assert.equal(defaultArtifactCertificateIdentityResolver(), DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY);
});

test("pruning preserves configured link subtrees and removes only unpreserved links", () => {
  const installRoot = mkdtempSync(join(tmpdir(), "prune-install-test-"));
  const externalRoot = mkdtempSync(join(tmpdir(), "prune-external-test-"));
  const externalFile = join(externalRoot, "must-survive.txt");
  writeFileSync(externalFile, "outside\n");
  writeFileSync(join(installRoot, "expected.txt"), "expected\n");
  writeFileSync(join(installRoot, ".legacy-file"), "hidden\n");
  mkdirSync(join(installRoot, ".legacy-directory", "nested"), { recursive: true });
  writeFileSync(join(installRoot, ".legacy-directory", "nested", "state.txt"), "hidden\n");
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
  assert.equal(readFileSync(join(installRoot, ".legacy-file"), "utf8"), "hidden\n");
  assert.equal(
    readFileSync(join(installRoot, ".legacy-directory", "nested", "state.txt"), "utf8"),
    "hidden\n",
  );
  assert.equal(existsSync(join(installRoot, "remove-link")), false);
  assert.equal(readFileSync(externalFile, "utf8"), "outside\n");
});

test("PDPP collection profiles install, verify, and report tampering without a legacy projection", async () => {
  const fixture = pdppFixture();
  const source = { mode: "local", rootDir: fixture.root, doc: { connectors: { [fixture.entry.connectorId]: [fixture.entry] } } };
  const lock = await generateLock({
    dependencies: { connectors: { [fixture.entry.connectorId]: "1.0.0" } },
    source,
  });
  const installRoot = join(fixture.root, "install");
  const expectedRoot = join(installRoot, "collection-profiles", fixture.entry.connectorId);
  const result = await installFromLock({ lock, source, installRoot, layout: "snapshot" });
  assert.deepEqual(result.expectedPaths, [
    `collection-profiles/${fixture.entry.connectorId}/${fixture.entry.manifestPath}`,
    `collection-profiles/${fixture.entry.connectorId}/${fixture.entry.entrypointPath}`,
    `collection-profiles/${fixture.entry.connectorId}/${fixture.entry.provenancePath}`,
  ]);
  assert.deepEqual(readFileSync(join(expectedRoot, fixture.entry.manifestPath)), fixture.manifestBuffer);
  assert.deepEqual(readFileSync(join(expectedRoot, fixture.entry.entrypointPath)), fixture.entrypointBuffer);
  assert.deepEqual(readFileSync(join(expectedRoot, fixture.entry.provenancePath)), fixture.provenanceBuffer);
  assert.equal(existsSync(join(installRoot, "scripts", `${fixture.entry.connectorId}.js`)), false);
  assert.equal((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).ok, true);

  for (const relativePath of [fixture.entry.manifestPath, fixture.entry.entrypointPath, fixture.entry.provenancePath]) {
    const installed = join(expectedRoot, relativePath);
    writeFileSync(installed, "tampered\n");
    const verification = await verifyInstalled({ lock, source, installRoot, layout: "snapshot" });
    assert.equal(verification.ok, false);
    assert.deepEqual(verification.mismatched, [
      `collection-profiles/${fixture.entry.connectorId}/${relativePath}`,
    ]);
    await installFromLock({ lock, source, installRoot, layout: "snapshot" });
  }
  assert.equal((await verifyInstalled({ lock, source, installRoot, layout: "snapshot" })).ok, true);

  const sourceRoot = join(fixture.root, "source-install");
  await installFromLock({ lock, source, installRoot: sourceRoot, layout: "source" });
  assert.equal((await verifyInstalled({ lock, source, installRoot: sourceRoot, layout: "source" })).ok, true);
});

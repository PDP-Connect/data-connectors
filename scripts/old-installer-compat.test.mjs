// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  FixtureRegistry,
  PINNED_IDENTITY,
  canonicalJson,
  cosignSignatureAnnotations,
  createFixtureVerifier,
  createSigner,
} from "../packages/connector-installer-core/oci-fixture.mjs";

// The RI's installer pin before #212, rather than a moving parent expression.
const OLD_INSTALLER_REVISION = "8803c30c31f6d514bdc237df2f224b5ff77fa232";
const SOURCE_DECLARATION_MEDIA_TYPE =
  "application/vnd.pdpp.connector.source-declaration.v1+json";
const COSIGN_BUNDLE_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const BUILDER = resolve("scripts/build-connector-oci-artifact.mjs");
const ESBUILD_LIB = resolve("node_modules/esbuild/lib/main.js");

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function extractOldInstallerCore(destination) {
  mkdirSync(destination, { recursive: true });
  const archive = execFileSync("git", [
    "archive",
    "--format=tar",
    OLD_INSTALLER_REVISION,
    "packages/connector-installer-core",
  ]);
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive });
  symlinkSync(resolve("node_modules"), join(destination, "node_modules"), "dir");
  return join(destination, "packages", "connector-installer-core", "index.mjs");
}

function signConnectorDigest(registry, signer, digest, connectorKey = "ynab") {
  const payload = canonicalJson({
    critical: {
      identity: {
        "docker-reference": `${registry.registry}/pdp-connect/connector/${connectorKey}`,
      },
      image: { "docker-manifest-digest": digest },
      type: "cosign container image signature",
    },
    optional: null,
  });

  registry.putManifest(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: registry.putBlob(Buffer.from("{}")),
        size: 2,
      },
      layers: [
        {
          mediaType: "application/vnd.dev.cosign.simplesigning.v1+json",
          digest: registry.putBlob(payload),
          size: payload.length,
          annotations: cosignSignatureAnnotations(signer, payload),
        },
      ],
    },
    `${digest.replace(":", "-")}.sig`
  );
}

function putCosignBundleReferrerDescriptor(registry, artifact) {
  const bundleBytes = canonicalJson({
    mediaType: COSIGN_BUNDLE_MEDIA_TYPE,
    verificationMaterial: {},
    dsseEnvelope: { payload: "", payloadType: "application/vnd.in-toto+json", signatures: [] },
  });
  const bundleManifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: COSIGN_BUNDLE_MEDIA_TYPE,
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: registry.putBlob(Buffer.from("{}")),
      size: 2,
    },
    layers: [
      {
        mediaType: COSIGN_BUNDLE_MEDIA_TYPE,
        digest: registry.putBlob(bundleBytes),
        size: bundleBytes.length,
      },
    ],
    subject: {
      mediaType: artifact.manifest.mediaType,
      digest: artifact.digest,
      size: canonicalJson(artifact.manifest).length,
    },
  };
  const { digest, bytes } = registry.putManifest(bundleManifest);

  return {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    size: bytes.length,
    digest,
    artifactType: COSIGN_BUNDLE_MEDIA_TYPE,
  };
}

function putSourceDeclarationReferrer(registry, artifactRoot, artifact, signer) {
  const sourceDeclarationBytes = readFileSync(join(artifactRoot, "source-declaration.json"));
  const emptyConfigBytes = Buffer.from("{}");
  const referrerManifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: SOURCE_DECLARATION_MEDIA_TYPE,
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest: sha256(emptyConfigBytes),
      size: emptyConfigBytes.length,
    },
    layers: [
      {
        mediaType: SOURCE_DECLARATION_MEDIA_TYPE,
        digest: registry.putBlob(sourceDeclarationBytes),
        size: sourceDeclarationBytes.length,
        annotations: { "org.opencontainers.image.title": "source-declaration.json" },
      },
    ],
    subject: {
      mediaType: artifact.manifest.mediaType,
      digest: artifact.digest,
      size: canonicalJson(artifact.manifest).length,
    },
  };
  registry.putBlob(emptyConfigBytes);

  const { digest: referrerDigest, bytes: referrerManifestBytes } =
    registry.putManifest(referrerManifest);
  signConnectorDigest(registry, signer, referrerDigest, artifact.config.connector_key);

  const fallbackTag = artifact.digest.replace(":", "-");
  const existingIndexDigest = registry.tags.get(fallbackTag);
  const existingIndex = existingIndexDigest
    ? JSON.parse(registry.manifests.get(existingIndexDigest).toString("utf8"))
    : null;
  const manifests = existingIndex?.manifests ? [...existingIndex.manifests] : [];
  manifests.push(
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      size: referrerManifestBytes.length,
      digest: referrerDigest,
      artifactType: SOURCE_DECLARATION_MEDIA_TYPE,
    },
    putCosignBundleReferrerDescriptor(registry, artifact)
  );

  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests,
  };
  registry.putManifest(index, fallbackTag);
  registry.referrersIndex = index;

  return { digest: referrerDigest, index, manifest: referrerManifest };
}

function buildOuraArtifact(destination) {
  const built = spawnSync(
    process.execPath,
    [BUILDER, "--connector", "oura", "--out", destination, "--esbuild", ESBUILD_LIB],
    { encoding: "utf8", timeout: 300_000 }
  );
  assert.equal(
    built.status,
    0,
    `building the current Oura artifact failed:\n${built.stdout}\n${built.stderr}`
  );
}

function putBuilderArtifact(registry, artifactRoot, signer) {
  const layerPlan = JSON.parse(readFileSync(join(artifactRoot, "layers.json"), "utf8"));
  const configBytes = readFileSync(join(artifactRoot, layerPlan.config.file));

  assert.equal(layerPlan.artifactType, "application/vnd.pdpp.connector.v1+json");
  assert.equal(
    layerPlan.layers.some((layer) => layer.mediaType === SOURCE_DECLARATION_MEDIA_TYPE),
    false,
    "current builder must keep source-declaration.json out of OCI image layers"
  );

  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: layerPlan.artifactType,
    config: {
      mediaType: layerPlan.config.mediaType,
      digest: registry.putBlob(configBytes),
      size: configBytes.length,
    },
    layers: layerPlan.layers.map((layer) => {
      const bytes = readFileSync(join(artifactRoot, layer.file));
      return {
        mediaType: layer.mediaType,
        digest: registry.putBlob(bytes),
        size: bytes.length,
        annotations: { "org.opencontainers.image.title": layer.file },
      };
    }),
    annotations: layerPlan.annotations,
  };

  const config = JSON.parse(configBytes.toString("utf8"));
  const { digest } = registry.putManifest(manifest, config.version);
  signConnectorDigest(registry, signer, digest, config.connector_key);

  return { config, digest, layerPlan, manifest };
}

function ociLockEntryForBuilderArtifact(registry, artifact) {
  return {
    connectorId: artifact.config.connector_key,
    connectorKey: artifact.config.connector_key,
    company: artifact.config.display_name,
    version: artifact.config.version,
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    oci: {
      registry: registry.registry,
      repository: `pdp-connect/connector/${artifact.config.connector_key}`,
      digest: artifact.digest,
    },
  };
}

test("pre-5fa1e7bb installer accepts the current builder's layer-free OCI connector artifact", async () => {
  const registry = await new FixtureRegistry({ challenge: true }).start();
  const scratch = mkdtempSync(join(tmpdir(), "old-installer-compat-"));
  const installRoot = join(scratch, "install");
  mkdirSync(installRoot);

  try {
    const signer = createSigner();
    const builderOutput = join(scratch, "builder", "oura");
    mkdirSync(dirname(builderOutput), { recursive: true });
    buildOuraArtifact(builderOutput);
    const artifact = putBuilderArtifact(registry, builderOutput, signer);
    const sourceDeclarationReferrer = putSourceDeclarationReferrer(
      registry,
      builderOutput,
      artifact,
      signer
    );

    const oldIndex = extractOldInstallerCore(join(scratch, "old"));
    const oldInstaller = await import(pathToFileURL(resolve(oldIndex)).href);

    const lockEntry = ociLockEntryForBuilderArtifact(registry, artifact);
    const result = await oldInstaller.installFromLock({
      lock: { lockVersion: "2.0", connectors: [lockEntry] },
      source: null,
      installRoot,
      layout: "snapshot",
      ociScheme: "http",
      allowedOciRegistries: new Set([registry.registry]),
      ociCertificateIdentityResolver: () => PINNED_IDENTITY,
      sigstoreVerifier: createFixtureVerifier(signer),
      retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
    });

    assert.equal(result.connectorCount, 1);
    assert.deepEqual(
      result.expectedPaths.sort(),
      [
        "collection-profiles/oura/dist/collection-profile.mjs",
        "collection-profiles/oura/licenses/LICENSE",
        "collection-profiles/oura/licenses/NOTICE",
        "collection-profiles/oura/profile/collection-profile.json",
        "collection-profiles/oura/provenance.json",
      ].sort()
    );
    assert.equal(result.pinned[0].digest, artifact.digest);
    assert.equal(sourceDeclarationReferrer.manifest.subject.digest, artifact.digest);
    assert.equal(
      sourceDeclarationReferrer.index.manifests.some(
        (descriptor) =>
          descriptor.digest === sourceDeclarationReferrer.digest &&
          descriptor.artifactType === SOURCE_DECLARATION_MEDIA_TYPE
      ),
      true
    );
    assert.equal(
      sourceDeclarationReferrer.index.manifests.some(
        (descriptor) => descriptor.artifactType === COSIGN_BUNDLE_MEDIA_TYPE
      ),
      true
    );
  } finally {
    await registry.stop();
    rmSync(scratch, { recursive: true, force: true });
  }
});

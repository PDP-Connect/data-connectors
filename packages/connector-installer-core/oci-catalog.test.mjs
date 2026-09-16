// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG_MEDIA_TYPE, CATALOG_REPOSITORY, fetchCatalog } from "./oci-catalog.mjs";
import { FixtureRegistry, PINNED_IDENTITY, canonicalJson, cosignSignatureAnnotations, createFixtureVerifier, createSigner } from "./oci-fixture.mjs";

const freshCatalog = () => ({
  catalog_version: "1.0",
  generated_at: "2026-09-15T12:00:00.000Z",
  source_commit: "a".repeat(40),
  connectors: [{
    connector_key: "ynab",
    connector_id: "https://registry.pdpp.dev/connectors/ynab",
    display_name: "YNAB",
    tier: "supported",
    runtime_requirements: { bindings: { network: { required: true } } },
    setup: { modality: "static_secret" },
    latest: { version: "0.3.0", digest: `sha256:${"b".repeat(64)}` },
    versions: [{ version: "0.3.0", digest: `sha256:${"b".repeat(64)}` }],
  }],
});

function publishCatalog(registry, signer, { catalog = freshCatalog(), changeLayer, rawBytes, artifactType = CATALOG_MEDIA_TYPE } = {}) {
  const bytes = rawBytes ?? canonicalJson(catalog);
  const layer = { mediaType: CATALOG_MEDIA_TYPE, digest: registry.putBlob(bytes), size: bytes.length };
  changeLayer?.(layer);
  const { digest } = registry.putManifest({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType,
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: registry.putBlob(Buffer.from("{}")), size: 2 },
    layers: [layer],
  }, "latest");
  const payload = canonicalJson({ critical: { image: { "docker-manifest-digest": digest }, type: "cosign container image signature" } });
  registry.putManifest({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    layers: [{ mediaType: "application/vnd.dev.cosign.simplesigning.v1+json", digest: registry.putBlob(payload), size: payload.length, annotations: cosignSignatureAnnotations(signer, payload) }],
  }, `${digest.replace(":", "-")}.sig`);
  return { digest, catalog, layer };
}

async function fixture(t, identity = PINNED_IDENTITY) {
  const registry = await new FixtureRegistry({ challenge: true }).start();
  t.after(() => registry.stop());
  const signer = createSigner(identity);
  return {
    registry,
    signer,
    options: {
      registry: registry.registry,
      allowedRegistries: new Set([registry.registry]),
      scheme: "http",
      sigstoreVerifier: createFixtureVerifier(signer),
      retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
    },
  };
}

test("catalog accepts a fresh signed catalog through the registry token flow", async (t) => {
  const { registry, signer, options } = await fixture(t);
  const { digest, catalog } = publishCatalog(registry, signer);
  assert.deepEqual(await fetchCatalog({ ...options, lastAcceptedGeneratedAt: "2026-09-14T12:00:00.000Z" }), { catalog, digest });
  assert.ok(registry.requests.includes(`/v2/${CATALOG_REPOSITORY}/manifests/${digest}`));
  assert.ok(registry.requests.some((path) => path.startsWith("/token?")));
});

for (const identity of ["https://github.com/foreign/repo/workflow@refs/heads/main", `${PINNED_IDENTITY}line`]) {
  test(`catalog refuses foreign signer ${identity}`, async (t) => {
    const { registry, signer, options } = await fixture(t, identity);
    publishCatalog(registry, signer);
    await assert.rejects(fetchCatalog(options), { reason: "misidentified" });
  });
}

test("catalog refuses rollback and accepts the previously accepted timestamp", async (t) => {
  const { registry, signer, options } = await fixture(t);
  const { catalog } = publishCatalog(registry, signer);
  await assert.rejects(fetchCatalog({ ...options, lastAcceptedGeneratedAt: "2026-09-16T00:00:00Z" }), { reason: "stale-catalog" });
  assert.deepEqual((await fetchCatalog({ ...options, lastAcceptedGeneratedAt: catalog.generated_at })).catalog, catalog);
});

for (const [name, changes, reason] of [
  ["unknown schema version", { catalog: { ...freshCatalog(), catalog_version: "2.0" } }, "invalid-catalog"],
  ["invalid date", { catalog: { ...freshCatalog(), generated_at: "2026-02-30T00:00:00Z" } }, "invalid-catalog"],
  ["non-JSON layer", { rawBytes: Buffer.from("no") }, "invalid-catalog"],
  ["foreign media type", { changeLayer: (layer) => { layer.mediaType = "application/json"; } }, "unsupported-layer"],
  ["foreign artifact type", { artifactType: "application/json" }, "unsupported-layer"],
  ["incorrect size", { changeLayer: (layer) => { layer.size += 1; } }, "tampered"],
]) {
  test(`catalog refuses ${name}`, async (t) => {
    const { registry, signer, options } = await fixture(t);
    publishCatalog(registry, signer, changes);
    await assert.rejects(fetchCatalog(options), { reason });
  });
}

test("catalog refuses a corrupted catalog blob", async (t) => {
  const { registry, signer, options } = await fixture(t);
  const { layer } = publishCatalog(registry, signer);
  registry.blobs.set(layer.digest, Buffer.from("tampered"));
  await assert.rejects(fetchCatalog(options), { reason: "tampered" });
});

test("catalog refuses absent and unknown latest without accepting a fallback", async (t) => {
  const { registry, options } = await fixture(t);
  await assert.rejects(fetchCatalog(options), { reason: "absent" });
  registry.faultManifest("latest", { status: 503, body: "registry unavailable" });
  await assert.rejects(fetchCatalog(options), { reason: "unverifiable" });
});

test("catalog rejects malformed rollback input before network access", async () => {
  for (const lastAcceptedGeneratedAt of ["not-a-date", "2026-02-30T00:00:00Z", "September 15, 2026", null, 1]) {
    await assert.rejects(fetchCatalog({ lastAcceptedGeneratedAt, fetchImpl() { assert.fail("unexpected network request"); } }), { reason: "invalid-reference" });
  }
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Asserts that oci-fixture.mjs's programmatically-built cosign v3 bundle
// fixture has the same SHAPE — same top-level keys, same nesting, same
// media types — as real bytes a live registry:3.1.1 + real cosign v3.1.3
// actually produced (test-fixtures/cosign-v3-bundle/, captured 2026-09-23;
// see that directory's README for exactly how and why).
//
// WHY THIS TEST EXISTS SEPARATELY FROM oci-identity.test.mjs. That file
// proves the CONSUMER accepts a bundle it is handed. It cannot prove the
// bundle oci-fixture.mjs hands it is the shape a real cosign run produces,
// because the fixture and the consumer are authored by the same
// understanding — exactly the failure mode that let an earlier revision's
// wrong assumption (the fallback tag resolves directly to the bundle
// manifest, not to an index wrapping it) ship with a fully green test suite.
// This test's oracle is the captured real bytes, not this package's code, so
// it can catch a regression the other tests structurally cannot.
//
// This checks SHAPE, not values: the specific digests, signatures and
// timestamps in the real capture are frozen at the moment they were
// captured and are not meaningful to compare against a fresh fixture run.
// What has to match is which keys exist, at which nesting, with which
// literal media-type strings.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FixtureRegistry, publishArtifact } from "./oci-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "test-fixtures", "cosign-v3-bundle");

function readCaptured(name) {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

/** A minimal, real-shaped bundle signer, matching oci-identity.test.mjs's
 * own minimal factory but with no CA/Rekor machinery — this test is about
 * envelope SHAPE, not cryptographic validity, so it does not need real
 * signatures. */
function shapeOnlyBundleSignatureFactory() {
  return ({ digest }) => ({
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      publicKey: { hint: "shape-test-hint" },
      tlogEntries: [
        {
          logIndex: "0",
          logId: { keyId: "shape-test-log-id" },
          kindVersion: { kind: "dsse", version: "0.0.1" },
          integratedTime: "0",
          inclusionPromise: { signedEntryTimestamp: "shape-test-set" },
        },
      ],
    },
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify({ subject: [{ digest: { sha256: digest.replace(/^sha256:/, "") } }] })).toString(
        "base64"
      ),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "shape-test-sig" }],
    },
  });
}

test("the fixture's tag manifest is an OCI image index, matching the real captured shape", async () => {
  const captured = readCaptured("tag-index.json");
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest } = publishArtifact(registry, {
      bundleSignatureFactory: shapeOnlyBundleSignatureFactory(),
    });
    const tagBytes = registry.manifests.get(registry.tags.get(digest.replace(":", "-")));
    assert.ok(tagBytes, "publishArtifact did not write anything at the fallback tag");
    const built = JSON.parse(tagBytes.toString("utf8"));

    assert.equal(built.mediaType, captured.mediaType);
    assert.equal(built.mediaType, "application/vnd.oci.image.index.v1+json");
    assert.ok(Array.isArray(built.manifests), "built index has no manifests[] array");
    assert.equal(built.manifests.length, captured.manifests.length);
    assert.equal(built.manifests[0].artifactType, captured.manifests[0].artifactType);
    assert.equal(built.manifests[0].mediaType, captured.manifests[0].mediaType);
    // The digest itself differs every run (different bytes); what must
    // match is that a digest-shaped string is present at all, not its tag.
    assert.match(built.manifests[0].digest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    await registry.stop();
  }
});

test("the fixture's inner bundle manifest has subject + one layer, matching the real captured shape", async () => {
  const captured = readCaptured("inner-manifest.json");
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest } = publishArtifact(registry, {
      bundleSignatureFactory: shapeOnlyBundleSignatureFactory(),
    });
    const tagBytes = registry.manifests.get(registry.tags.get(digest.replace(":", "-")));
    const index = JSON.parse(tagBytes.toString("utf8"));
    const innerDigest = index.manifests[0].digest;
    const innerBytes = registry.manifests.get(innerDigest);
    assert.ok(innerBytes, "the index's descriptor does not resolve to a stored manifest");
    const built = JSON.parse(innerBytes.toString("utf8"));

    assert.equal(built.mediaType, captured.mediaType);
    assert.equal(built.artifactType, captured.artifactType);
    assert.equal(built.artifactType, "application/vnd.dev.sigstore.bundle.v0.3+json");
    assert.ok(built.subject, "built inner manifest has no subject field");
    assert.equal(built.subject.mediaType, captured.subject.mediaType);
    assert.equal(built.subject.digest, digest, "built manifest's subject does not name the signed artifact");
    assert.equal(built.layers.length, captured.layers.length);
    assert.equal(built.layers[0].mediaType, captured.layers[0].mediaType);
  } finally {
    await registry.stop();
  }
});

test("the real captured bundle blob has the DSSE envelope shape this consumer parses", () => {
  // Not built from oci-fixture.mjs at all — this is a direct assertion
  // about the captured bytes, proving the shape assertBundlePayloadNamesDigest
  // and extractBundleLayerDigest were written against actually occurs, not
  // assumed.
  const captured = readCaptured("bundle-blob.json");
  assert.equal(captured.mediaType, "application/vnd.dev.sigstore.bundle.v0.3+json");
  assert.ok(captured.verificationMaterial, "captured bundle has no verificationMaterial");
  assert.ok(captured.dsseEnvelope, "captured bundle has no dsseEnvelope");
  assert.equal(typeof captured.dsseEnvelope.payload, "string");
  const payload = JSON.parse(Buffer.from(captured.dsseEnvelope.payload, "base64").toString("utf8"));
  assert.ok(Array.isArray(payload.subject), "captured bundle's DSSE payload has no subject array");
  assert.match(payload.subject[0].digest.sha256, /^[0-9a-f]{64}$/);
});

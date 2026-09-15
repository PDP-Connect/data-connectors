// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The identity pin and the Rekor requirement, against the REAL @sigstore/verify
// engine.
//
// oci.test.mjs injects `createFixtureVerifier`, which is the right tool for
// layer dispatch, unpacking and digest binding but cannot be evidence about
// identity matching: it is a reimplementation of the property under test.
// sigstore matches `certificateIdentityURI` as an UNANCHORED regular expression
// against the certificate SAN, so a fixture comparing with `!==` reports
// "exact" for a pin that in fact accepts every SAN containing the pinned
// string. A-T3 passed while production had no anchoring at all.
//
// So these tests run the production `verifyOciSignature` — the same bundle
// assembly, the same Rekor-annotation parsing, the same options — against
// sigstore's own Verifier and policy, over certificates minted by a synthetic
// CA and an inclusion promise signed by a synthetic Rekor log. No TUF: the
// synthetic roots are installed directly as the TrustedRoot. Everything after
// that is the stock engine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FixtureRegistry, PINNED_IDENTITY, publishArtifact } from "./oci-fixture.mjs";
import {
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
  verifyOciSignature,
} from "./oci-verify.mjs";

const require = createRequire(import.meta.url);
const { toSignedEntity, toTrustMaterial, Verifier } = require("@sigstore/verify");
const { TrustedRoot } = require("@sigstore/protobuf-specs");
const { bundleFromJSON } = require("@sigstore/bundle");
const { createVerificationPolicy } = require("sigstore/dist/config.js");
const { json: canonicalJson } = require("@sigstore/core");

const ISSUER = DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER;
const workDir = mkdtempSync(join(tmpdir(), "oci-identity-test-"));

function openssl(args) {
  execFileSync("openssl", args, { stdio: ["ignore", "pipe", "pipe"] });
}

function pemToDer(pem) {
  return Buffer.from(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, ""), "base64");
}

// --- synthetic Fulcio ------------------------------------------------------

openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", join(workDir, "ca.key")]);
openssl([
  "req", "-x509", "-new",
  "-key", join(workDir, "ca.key"),
  "-days", "3650",
  "-subj", "/O=synthetic/CN=Synthetic Fulcio Test CA",
  "-out", join(workDir, "ca.crt"),
]);

let leafSerial = 0;
// A signer in the shape `publishArtifact` expects, but backed by a real
// CA-issued certificate: the SAN is `san` and the Fulcio issuer extension
// (OID 1.3.6.1.4.1.57264.1.8) is `issuer` — the two values the pin checks.
function realSigner(san, { issuer = ISSUER } = {}) {
  const name = `leaf-${(leafSerial += 1)}`;
  const keyPath = join(workDir, `${name}.key`);
  const crtPath = join(workDir, `${name}.crt`);
  const csrPath = join(workDir, `${name}.csr`);
  const extPath = join(workDir, `${name}.cnf`);
  writeFileSync(
    extPath,
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=codeSigning",
      `subjectAltName=URI:${san}`,
      "subjectKeyIdentifier=hash",
      "authorityKeyIdentifier=keyid",
      `1.3.6.1.4.1.57264.1.8=ASN1:UTF8String:${issuer}`,
      "",
    ].join("\n"),
  );
  openssl(["ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", keyPath]);
  openssl(["req", "-new", "-key", keyPath, "-subj", `/CN=${name}`, "-out", csrPath]);
  openssl([
    "x509", "-req",
    "-in", csrPath,
    "-CA", join(workDir, "ca.crt"),
    "-CAkey", join(workDir, "ca.key"),
    "-CAcreateserial",
    "-days", "30",
    "-extfile", extPath,
    "-out", crtPath,
  ]);
  const privateKey = readFileSync(keyPath, "utf8");
  return {
    identity: san,
    privateKey,
    certificatePem: readFileSync(crtPath, "utf8"),
    sign(payload) {
      const signer = createSign("SHA256");
      signer.update(payload);
      signer.end();
      return signer.sign(privateKey).toString("base64");
    },
  };
}

// --- synthetic Rekor -------------------------------------------------------

const rekorKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rekorPublicKeyDer = rekorKeyPair.publicKey.export({ type: "spki", format: "der" });
const rekorLogId = createHash("sha256").update(rekorPublicKeyDer).digest();

const trustMaterial = toTrustMaterial(
  TrustedRoot.fromJSON({
    mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
    certificateAuthorities: [
      {
        subject: { organization: "synthetic", commonName: "Synthetic Fulcio Test CA" },
        uri: "https://fulcio.test.invalid",
        certChain: {
          certificates: [
            { rawBytes: pemToDer(readFileSync(join(workDir, "ca.crt"), "utf8")).toString("base64") },
          ],
        },
        validFor: { start: "2000-01-01T00:00:00.000Z" },
      },
    ],
    tlogs: [
      {
        baseUrl: "https://rekor.test.invalid",
        hashAlgorithm: "SHA2_256",
        publicKey: {
          rawBytes: rekorPublicKeyDer.toString("base64"),
          keyDetails: "PKIX_ECDSA_P256_SHA_256",
          validFor: { start: "2000-01-01T00:00:00.000Z" },
        },
        logId: { keyId: rekorLogId.toString("base64") },
      },
    ],
    ctlogs: [],
    timestampAuthorities: [],
  }),
);

// Cosign's Rekor annotation, signed by the synthetic log so its inclusion
// promise verifies offline the way a real one does.
//
// `signature` is the one already on the layer, not a fresh one: ECDSA is
// randomised, so signing the same payload twice yields two different valid
// signatures, and `verifyTLogBody` checks that the body records the SAME
// signature the bundle carries. A real Rekor entry is made from the signature
// cosign uploaded, so reusing it here is the faithful shape, not a shortcut.
function rekorBundleAnnotation(signer, payload, signature) {
  const body = Buffer.from(
    JSON.stringify({
      apiVersion: "0.0.1",
      kind: "hashedrekord",
      spec: {
        data: {
          hash: { algorithm: "sha256", value: createHash("sha256").update(payload).digest("hex") },
        },
        signature: {
          content: signature,
          publicKey: { content: Buffer.from(signer.certificatePem).toString("base64") },
        },
      },
    }),
  ).toString("base64");

  const entry = {
    body,
    integratedTime: Math.floor(Date.now() / 1000),
    logIndex: 1,
    logID: rekorLogId.toString("hex"),
  };

  const setSigner = createSign("SHA256");
  setSigner.update(Buffer.from(canonicalJson.canonicalize(entry), "utf8"));
  setSigner.end();

  return JSON.stringify({
    SignedEntryTimestamp: setSigner.sign(rekorKeyPair.privateKey).toString("base64"),
    Payload: entry,
  });
}

// The stock sigstore verifier with the synthetic roots swapped in for TUF's.
// ctlogThreshold is 0 because synthetic leaves carry no SCT; tlogThreshold is
// the library default of 1, which is the point of D2.
async function realSigstoreVerifier(bundle, payload, options) {
  const verifier = new Verifier(trustMaterial, { ctlogThreshold: 0 });
  return verifier.verify(
    toSignedEntity(bundleFromJSON(bundle), payload),
    createVerificationPolicy(options),
  );
}

// Publishes an artifact signed by `signer` and runs the production
// `verifyOciSignature` over it against the real engine. Resolves on success,
// rejects on refusal.
async function verifyPublishedBy(signer, { annotate } = {}) {
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest } = publishArtifact(registry, { signer, omitRekorBundle: true });

    // Attach the Rekor annotation the synthetic log signed. `publishArtifact`
    // omits its canned one so this test controls the whole inclusion promise.
    const sigTag = `${digest.replace(":", "-")}.sig`;
    const sigManifest = JSON.parse(
      registry.manifests.get(registry.tags.get(sigTag)).toString("utf8"),
    );
    for (const layer of sigManifest.layers) {
      const payload = registry.blobs.get(layer.digest);
      const signature = layer.annotations["dev.cosignproject.cosign/signature"];
      const annotation = annotate
        ? annotate(signer, payload, signature)
        : rekorBundleAnnotation(signer, payload, signature);
      if (annotation !== null) layer.annotations["dev.sigstore.cosign/bundle"] = annotation;
    }
    registry.putManifest(sigManifest, sigTag);

    return await verifyOciSignature({
      registry: registry.registry,
      repository: "pdp-connect/connector/ynab",
      digest,
      scheme: "http",
      certificateIdentityResolver: () => PINNED_IDENTITY,
      sigstoreVerifier: realSigstoreVerifier,
    });
  } finally {
    await registry.stop();
  }
}

// --- D1: the identity pin --------------------------------------------------

test("A-T3 (real engine) accepts the pinned publish-workflow identity", async () => {
  const result = await verifyPublishedBy(realSigner(PINNED_IDENTITY));
  assert.equal(result.certificateIdentityURI, PINNED_IDENTITY);
});

// Every SAN here CONTAINS the pinned identity, so an unanchored pattern matches
// it. The first three are branches a collaborator with push rights can create
// in this repository — the exact case the pin exists for, since the workflow's
// `github.ref == 'refs/heads/main'` gate lives in the editable checkout.
for (const [label, san] of [
  ["a branch whose name extends main", PINNED_IDENTITY.replace(/main$/, "mainline")],
  ["a branch suffixed with a digit", PINNED_IDENTITY.replace(/main$/, "main2")],
  ["a branch suffixed with a hyphen", PINNED_IDENTITY.replace(/main$/, "main-fix")],
  [
    "a foreign SAN that embeds the pinned identity",
    `https://github.com/attacker/evil/.github/workflows/publish.yml@refs/heads/main?u=${PINNED_IDENTITY}`,
  ],
]) {
  test(`A-T3 (real engine) refuses ${label}`, async () => {
    await assert.rejects(
      () => verifyPublishedBy(realSigner(san)),
      /certificate identity error/,
    );
  });
}

// Already refused before the pin was anchored; they stay refused.
for (const [label, san] of [
  ["a tag ref", PINNED_IDENTITY.replace("refs/heads/main", "refs/tags/v1")],
  ["a fork of this repository", PINNED_IDENTITY.replace("PDP-Connect", "attacker")],
  [
    "another workflow in this repository",
    PINNED_IDENTITY.replace("publish-polyfill-connectors.yml", "ci.yml"),
  ],
]) {
  test(`A-T3 (real engine) refuses ${label}`, async () => {
    await assert.rejects(
      () => verifyPublishedBy(realSigner(san)),
      /certificate identity error/,
    );
  });
}

test("A-T3 (real engine) refuses the pinned identity from the wrong issuer", async () => {
  await assert.rejects(
    () => verifyPublishedBy(realSigner(PINNED_IDENTITY, { issuer: "https://evil.example" })),
    /invalid certificate extension/,
  );
});

// --- D2: the Rekor inclusion promise ---------------------------------------

test("a signature layer with no Rekor inclusion promise is refused", async () => {
  await assert.rejects(
    () => verifyPublishedBy(realSigner(PINNED_IDENTITY), { annotate: () => null }),
    /carries no Rekor inclusion promise/,
  );
});

test("a signature layer with an unparseable Rekor annotation is refused", async () => {
  await assert.rejects(
    () => verifyPublishedBy(realSigner(PINNED_IDENTITY), { annotate: () => "{not json" }),
    /carries an unreadable Rekor inclusion promise/,
  );
});

test("a Rekor inclusion promise signed by an untrusted log is refused", async () => {
  const foreignLog = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  await assert.rejects(
    () =>
      verifyPublishedBy(realSigner(PINNED_IDENTITY), {
        annotate: (signer, payload, signature) => {
          const parsed = JSON.parse(rekorBundleAnnotation(signer, payload, signature));
          const resigned = createSign("SHA256");
          resigned.update(Buffer.from(canonicalJson.canonicalize(parsed.Payload), "utf8"));
          resigned.end();
          parsed.SignedEntryTimestamp = resigned.sign(foreignLog.privateKey).toString("base64");
          return JSON.stringify(parsed);
        },
      }),
    /inclusion promise could not be verified/,
  );
});

test("a Rekor inclusion promise whose integratedTime was altered is refused", async () => {
  await assert.rejects(
    () =>
      verifyPublishedBy(realSigner(PINNED_IDENTITY), {
        annotate: (signer, payload, signature) => {
          // Signed over the honest time, then the field is moved: the SET no
          // longer covers what the entry claims, which is what makes the
          // timestamp trustworthy rather than merely present.
          const parsed = JSON.parse(rekorBundleAnnotation(signer, payload, signature));
          parsed.Payload.integratedTime += 86400;
          return JSON.stringify(parsed);
        },
      }),
    /inclusion promise could not be verified/,
  );
});

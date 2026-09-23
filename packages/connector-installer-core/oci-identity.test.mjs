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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

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

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

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
//
// Mirrors `sigstore`'s own `verify(bundle, dataOrOptions, options?)`
// dispatch: when the 2nd argument is not a Buffer, it IS the options and
// there is no external payload — which is the DSSE bundle case, where the
// payload lives inside the envelope rather than being supplied separately.
// A fixed 3-arg signature here would silently swallow `options` into the
// unused `payload` slot for every DSSE call, which is exactly the bug this
// mirrors production away from.
async function realSigstoreVerifier(bundle, dataOrOptions, maybeOptions) {
  const payload = Buffer.isBuffer(dataOrOptions) ? dataOrOptions : undefined;
  const options = Buffer.isBuffer(dataOrOptions) ? maybeOptions : dataOrOptions;
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

// --- cosign v3-default bundle format ----------------------------------------
//
// Everything above signs with the legacy (cosign v2-default) `.sig` tag
// shape. Cosign v3 makes a DIFFERENT default: a Sigstore protobuf bundle
// (DSSE-wrapped in-toto statement) stored as an OCI referring artifact at a
// `sha256-<hex>` tag with no `.sig` suffix. `verifyOciSignature` has to
// accept BOTH, because the catalog holds artifacts published under each
// cosign version, and these tests mint a REAL bundle of the new shape —
// same synthetic Fulcio CA and synthetic Rekor log as above, a real DSSE
// signature over a real in-toto statement — rather than asserting the code
// merely calls a function, for the same reason A-T3 above runs against the
// real @sigstore/verify engine instead of the fixture verifier.

const { canonicalize: canonicalizeDsse } = require("@sigstore/core").json;

// A Rekor `dsse` entry, mirroring `rekorBundleAnnotation`'s `hashedrekord`
// entry for the legacy path. The kind is `dsse` because that is what cosign
// v3 actually uploads for a DSSE-enveloped signature — observed on a real
// `cosign sign` v3.1.3 run against ghcr.io.
//
// Shape matched against `verifyDSSE001TLogBody`
// (@sigstore/verify/dist/tlog/dsse.js), not guessed: exactly one entry in
// `spec.signatures[]` (a bundle with more is refused as a "signature count
// mismatch" this fixture triggered on a first attempt), `signatures[0].signature`
// base64 of the DSSE signature bytes, and `spec.payloadHash.value` HEX of the
// raw (undecoded) in-toto payload's SHA-256 — the payload digest, not the
// envelope digest, which is a different field this format does not use.
function dsseRekorEntryBody(signatureB64, payloadBytes) {
  const entry = {
    apiVersion: "0.0.1",
    kind: "dsse",
    spec: {
      signatures: [{ signature: signatureB64 }],
      payloadHash: {
        algorithm: "sha256",
        value: createHash("sha256").update(payloadBytes).digest("hex"),
      },
    },
  };
  return Buffer.from(JSON.stringify(entry));
}

// RFC6962 leaf hash: SHA256(0x00 || canonicalizedBody bytes) — the same
// hashing rule @sigstore/verify's merkle.js applies to the entry it parses
// out of the bundle. With a single-leaf tree (index 0, size 1) the inclusion
// proof's hash list is EMPTY and the calculated root is exactly the leaf
// hash, which is what makes a synthetic single-artifact log tractable to
// build here without reimplementing a general Merkle tree.
function rfc6962LeafHash(canonicalizedBodyBuffer) {
  return createHash("sha256").update(Buffer.concat([Buffer.from([0x00]), canonicalizedBodyBuffer])).digest();
}

// A signed transparency-log checkpoint over a single-leaf tree, in the
// "origin\nsize\nbase64(root)\n\n— name base64(keyHint+sig)\n" shape
// @sigstore/verify's checkpoint.js parses.
//
// The origin LINE (checkpoint header) and the signature line's NAME are two
// different things that happen to share a value in real Rekor checkpoints,
// and conflating them broke this the first time: `verifySignedNote`'s
// signature-line regex is `\S+` for the name, so it cannot contain a space,
// while `tlog.baseURL.includes(signature.name)` only requires the name be a
// literal substring of the trust material's tlog baseURL
// (`https://rekor.test.invalid`) — it does not have to equal the origin
// header. `rekor.test.invalid` alone satisfies both constraints.
function signedCheckpoint(rootHash) {
  const origin = "rekor.test.invalid";
  const signerName = "rekor.test.invalid";
  const note = `${origin}\n1\n${rootHash.toString("base64")}\n`;
  const signer = createSign("SHA256");
  signer.update(Buffer.from(note, "utf8"));
  signer.end();
  const sig = signer.sign(rekorKeyPair.privateKey);
  const keyHint = rekorLogId.subarray(0, 4);
  const sigLine = `— ${signerName} ${Buffer.concat([keyHint, sig]).toString("base64")}\n`;
  return `${note}\n${sigLine}`;
}

// `getTLogTimestamp` (@sigstore/verify/dist/timestamp) only counts a tlog
// entry as a verifiable timestamp source when it carries `inclusionPromise`
// — an entry with an inclusion PROOF but no promise SET yields zero
// timestamps and the verify call fails with "expected 1 timestamps, got 0",
// regardless of the proof itself being valid. A real cosign v3 bundle
// carries both (observed on the real GHCR fetch this PR's report cites), so
// this synthetic entry does too rather than picking one.
function dsseRekorInclusionEntry(signatureB64, payloadBytes) {
  const body = dsseRekorEntryBody(signatureB64, payloadBytes);
  const leafHash = rfc6962LeafHash(body);
  const integratedTime = Math.floor(Date.now() / 1000);
  // The SET covers `{body, integratedTime, logIndex, logID}` with `body`
  // BASE64-encoded — @sigstore/verify's `toVerificationPayload` rebuilds
  // this exact shape from the parsed entry to check the SET, so signing over
  // anything else (a raw Buffer, a different field order the canonicalizer
  // would not care about but a different VALUE would) makes the promise
  // real Rekor never issued, and refuses to verify accordingly.
  const promiseEntry = {
    body: body.toString("base64"),
    integratedTime,
    logIndex: 0,
    logID: rekorLogId.toString("hex"),
  };
  const setSigner = createSign("SHA256");
  setSigner.update(Buffer.from(canonicalizeDsse(promiseEntry), "utf8"));
  setSigner.end();
  return {
    body,
    integratedTime,
    logIndex: 0,
    logID: rekorLogId.toString("hex"),
    inclusionPromise: {
      signedEntryTimestamp: setSigner.sign(rekorKeyPair.privateKey).toString("base64"),
    },
    inclusionProof: {
      logIndex: "0",
      rootHash: leafHash,
      treeSize: "1",
      hashes: [],
      checkpoint: signedCheckpoint(leafHash),
    },
  };
}

/**
 * Mint a real cosign v3-shaped bundle: a DSSE envelope over an in-toto
 * Statement naming `digest`, signed by `signer`'s real (CA-issued in the
 * calling test) private key, with a Rekor inclusion promise from the
 * synthetic log this file already trusts.
 */
function realBundleSignatureFactory(signer, { statementDigestOverride = null } = {}) {
  return ({ digest }) => {
    // Normally the same digest the manifest-level `subject` names — the two
    // claims agree by construction, the way a real cosign publish would.
    // `statementDigestOverride` breaks that agreement deliberately, so a
    // test can prove the DSSE-payload check (assertBundlePayloadNamesDigest)
    // fires on its own even when the outer manifest's `subject` is honest.
    const digestHex = (statementDigestOverride ?? digest).replace(/^sha256:/, "");
    const statement = {
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ digest: { sha256: digestHex }, annotations: {} }],
      predicateType: "https://sigstore.dev/cosign/sign/v1",
      predicate: {},
    };
    const payloadBytes = Buffer.from(JSON.stringify(statement));
    const payloadB64 = payloadBytes.toString("base64");
    const payloadType = "application/vnd.in-toto+json";

    // DSSE PAE (pre-authentication encoding) is what is actually signed —
    // not the raw payload bytes, which is the message-signature path's
    // rule. This is `@sigstore/core`'s own `dsse.preAuthEncoding`, matched
    // field-for-field against its source rather than approximated: the
    // length that precedes `payloadType` is the BYTE length of the type
    // STRING, not of the payload, and there are two length-prefixed fields
    // before the raw payload bytes, not one. A first attempt here used a
    // shorter 2-field encoding that signed different bytes than the real
    // engine hashes, and every downstream check failed opaquely as a result.
    const payloadTypeBytes = Buffer.from(payloadType, "utf8");
    const pae = Buffer.concat([
      Buffer.from(`DSSEv1 ${payloadTypeBytes.length} `, "ascii"),
      payloadTypeBytes,
      Buffer.from(` ${payloadBytes.length} `, "ascii"),
      payloadBytes,
    ]);
    const dsseSigner = createSign("SHA256");
    dsseSigner.update(pae);
    dsseSigner.end();
    const signature = dsseSigner.sign(signer.privateKey).toString("base64");

    const envelope = { payload: payloadB64, payloadType, signatures: [{ sig: signature }] };

    const tlogEntry = dsseRekorInclusionEntry(signature, payloadBytes);

    return {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: pemToDer(signer.certificatePem).toString("base64") },
        tlogEntries: [
          {
            logIndex: String(tlogEntry.logIndex),
            logId: { keyId: rekorLogId.toString("base64") },
            kindVersion: { kind: "dsse", version: "0.0.1" },
            integratedTime: String(tlogEntry.integratedTime),
            inclusionPromise: {
              signedEntryTimestamp: tlogEntry.inclusionPromise.signedEntryTimestamp,
            },
            inclusionProof: {
              logIndex: tlogEntry.inclusionProof.logIndex,
              rootHash: tlogEntry.inclusionProof.rootHash.toString("base64"),
              treeSize: tlogEntry.inclusionProof.treeSize,
              hashes: tlogEntry.inclusionProof.hashes,
              checkpoint: { envelope: tlogEntry.inclusionProof.checkpoint },
            },
            canonicalizedBody: tlogEntry.body.toString("base64"),
          },
        ],
      },
      dsseEnvelope: envelope,
    };
  };
}

async function verifyBundlePublishedBy(signer, { digestOverride = null } = {}) {
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest } = publishArtifact(registry, {
      bundleSignatureFactory: realBundleSignatureFactory(signer),
      payloadDigestOverride: digestOverride,
    });
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

test("A-T3 (real engine, cosign v3 bundle format) accepts the pinned identity", async () => {
  const result = await verifyBundlePublishedBy(realSigner(PINNED_IDENTITY));
  assert.equal(result.certificateIdentityURI, PINNED_IDENTITY);
});

test("cosign v3 bundle format refuses a foreign identity the same way the legacy format does", async () => {
  await assert.rejects(
    () => verifyBundlePublishedBy(realSigner(PINNED_IDENTITY.replace("PDP-Connect", "attacker"))),
    /certificate identity error/,
  );
});

test("cosign v3 bundle format refuses a bundle manifest whose subject names a different digest", async () => {
  // The referrer MANIFEST's own `subject` field is the first claim checked
  // (fetchCandidateBundleManifest), before the bundle layer is even fetched
  // — a referrer for a different artifact that happens to sit in the same
  // repository is refused as misidentified at the cheapest possible point,
  // not treated as this artifact's signature.
  const registry = await new FixtureRegistry({}).start();
  try {
    const signer = realSigner(PINNED_IDENTITY);
    const { digest } = publishArtifact(registry, {
      bundleSignatureFactory: realBundleSignatureFactory(signer),
      payloadDigestOverride: `sha256:${"0".repeat(64)}`,
    });
    await assert.rejects(
      () =>
        verifyOciSignature({
          registry: registry.registry,
          repository: "pdp-connect/connector/ynab",
          digest,
          scheme: "http",
          certificateIdentityResolver: () => PINNED_IDENTITY,
          sigstoreVerifier: realSigstoreVerifier,
        }),
      /names subject .*, not/,
    );
  } finally {
    await registry.stop();
  }
});

test("cosign v3 bundle format refuses a bundle whose DSSE payload names a different digest than its manifest's subject", async () => {
  // A stricter attack than the one above: the referrer MANIFEST's `subject`
  // is honest (this digest), but the SIGNED STATEMENT inside the bundle
  // claims a different one. assertBundlePayloadNamesDigest exists precisely
  // because the manifest-level subject and the cryptographically-signed
  // claim are two independent things — cosign writes them to agree, but
  // this consumer checks the one the signature actually covers rather than
  // trusting the manifest that merely carries it.
  const registry = await new FixtureRegistry({}).start();
  try {
    const signer = realSigner(PINNED_IDENTITY);
    const { digest } = publishArtifact(registry, {
      bundleSignatureFactory: realBundleSignatureFactory(signer, {
        statementDigestOverride: `sha256:${"0".repeat(64)}`,
      }),
    });
    await assert.rejects(
      () =>
        verifyOciSignature({
          registry: registry.registry,
          repository: "pdp-connect/connector/ynab",
          digest,
          scheme: "http",
          certificateIdentityResolver: () => PINNED_IDENTITY,
          sigstoreVerifier: realSigstoreVerifier,
        }),
      /does not name manifest/,
    );
  } finally {
    await registry.stop();
  }
});

test("an artifact with only a legacy signature still verifies (no bundle tag present)", async () => {
  const result = await verifyPublishedBy(realSigner(PINNED_IDENTITY));
  assert.equal(result.certificateIdentityURI, PINNED_IDENTITY);
});

test("an artifact with only a cosign v3 bundle signature still verifies (no legacy tag present)", async () => {
  const result = await verifyBundlePublishedBy(realSigner(PINNED_IDENTITY));
  assert.equal(result.certificateIdentityURI, PINNED_IDENTITY);
});

test("cosign v3 bundle format verifies via the referrers API, when the registry supports it", async () => {
  // Neither real registry this consumer talks to (a local registry:3.1.1,
  // ghcr.io) implements `/referrers/` as of this writing, which is why the
  // live network test against the real scratch GHCR artifact exercises the
  // tag-schema fallback and not this path. This test is the only place the
  // referrers-API discovery code runs at all, so it has to prove the path
  // works rather than merely exist: the fixture registry is configured to
  // answer the SAME index `publishArtifact` wrote for the tag fallback, at
  // the referrers endpoint instead, and `discoverCosignBundleReferrers` is
  // proven to find and use it WITHOUT ever falling back to the tag — by
  // deleting the tag before verifying.
  const signer = realSigner(PINNED_IDENTITY);
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest, bundleReferrer } = publishArtifact(registry, {
      bundleSignatureFactory: realBundleSignatureFactory(signer),
    });
    assert.ok(bundleReferrer, "publishArtifact did not build a bundle referrer");

    // Serve the same index at the referrers endpoint...
    registry.referrersIndex = bundleReferrer.index;
    // ...and remove the fallback tag, so a pass here can only mean the
    // referrers-API branch ran, not that it silently fell through to the
    // tag this same index also happens to sit at.
    registry.tags.delete(digest.replace(":", "-"));

    const result = await verifyOciSignature({
      registry: registry.registry,
      repository: "pdp-connect/connector/ynab",
      digest,
      scheme: "http",
      certificateIdentityResolver: () => PINNED_IDENTITY,
      sigstoreVerifier: realSigstoreVerifier,
    });
    assert.equal(result.certificateIdentityURI, PINNED_IDENTITY);
  } finally {
    await registry.stop();
  }
});

test("an artifact with BOTH a legacy and a cosign v3 bundle signature verifies (neither format is required to be absent)", async () => {
  // Not expected to occur for a given digest in production — a single
  // publish run signs with one cosign version — but the catalog as a whole
  // holds both eras, and nothing in `verifyOciSignature` assumes at most one
  // tag exists. Proving this rather than assuming it: if a future change
  // made the bundle lookup short-circuit before the legacy lookup ran, or
  // vice versa, this is the test that would catch it.
  const signer = realSigner(PINNED_IDENTITY);
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest } = publishArtifact(registry, {
      signer,
      omitRekorBundle: true,
      bundleSignatureFactory: realBundleSignatureFactory(signer),
    });
    const sigTag = `${digest.replace(":", "-")}.sig`;
    const sigManifest = JSON.parse(registry.manifests.get(registry.tags.get(sigTag)).toString("utf8"));
    for (const layer of sigManifest.layers) {
      const payload = registry.blobs.get(layer.digest);
      const signature = layer.annotations["dev.cosignproject.cosign/signature"];
      layer.annotations["dev.sigstore.cosign/bundle"] = rekorBundleAnnotation(signer, payload, signature);
    }
    registry.putManifest(sigManifest, sigTag);

    const result = await verifyOciSignature({
      registry: registry.registry,
      repository: "pdp-connect/connector/ynab",
      digest,
      scheme: "http",
      certificateIdentityResolver: () => PINNED_IDENTITY,
      sigstoreVerifier: realSigstoreVerifier,
    });
    assert.equal(result.certificateIdentityURI, PINNED_IDENTITY);
  } finally {
    await registry.stop();
  }
});

test("an artifact with neither signature format is refused as unsigned", async () => {
  const registry = await new FixtureRegistry({}).start();
  try {
    const { digest } = publishArtifact(registry, {});
    await assert.rejects(
      () =>
        verifyOciSignature({
          registry: registry.registry,
          repository: "pdp-connect/connector/ynab",
          digest,
          scheme: "http",
          certificateIdentityResolver: () => PINNED_IDENTITY,
          sigstoreVerifier: realSigstoreVerifier,
        }),
      /has no cosign signature \(checked both the new bundle tag and the legacy .sig tag\)/,
    );
  } finally {
    await registry.stop();
  }
});

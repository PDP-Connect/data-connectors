// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Exercises the signer-identity pin against the real @sigstore/verify engine.
//
// The rest of index.test.mjs injects a fixture verifier, which can only prove
// that production passes the identity it was given — not how sigstore matches
// it. sigstore treats `certificateIdentityURI` as an unanchored regular
// expression against the certificate SAN, so a fixture that compares with
// `assert.equal` reports "exact" for a pin that in fact accepts every SAN
// containing the pinned string. These tests run the production verification
// path (`fetchResolvedArtifact` -> `verifyRemoteSignature` -> sigstore's own
// Verifier and policy) over certificates minted by a synthetic CA, so the
// assertion is about the library's matching behaviour and not about ours.
//
// No TUF: the synthetic CA and a synthetic Rekor log are installed directly as
// the TrustedRoot. Everything else — bundle parsing, certificate chain
// building, SET and inclusion-proof checks, signature verification, policy —
// is the stock engine.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
  DEFAULT_SIGSTORE_CERTIFICATE_ISSUER,
  fetchResolvedArtifact,
} from "./index.mjs";

const require = createRequire(import.meta.url);
const { toSignedEntity, toTrustMaterial, Verifier } = require("@sigstore/verify");
const { TrustedRoot } = require("@sigstore/protobuf-specs");
const { bundleFromJSON } = require("@sigstore/bundle");
const { createVerificationPolicy } = require("sigstore/dist/config.js");
const { json: canonicalJson } = require("@sigstore/core");

const PINNED = DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY;
const ARTIFACT_URL =
  "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-test/legacy-connector-1.0.0.tgz";

const workDir = mkdtempSync(join(tmpdir(), "signer-identity-test-"));

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
// Mints a leaf whose SAN is `san` and whose Fulcio issuer extension (OID
// 1.3.6.1.4.1.57264.1.8) is `issuer` — the two values the pin checks.
function mintLeaf(san, issuer = DEFAULT_SIGSTORE_CERTIFICATE_ISSUER) {
  const name = `leaf-${(leafSerial += 1)}`;
  const keyPath = join(workDir, `${name}.key`);
  const csrPath = join(workDir, `${name}.csr`);
  const crtPath = join(workDir, `${name}.crt`);
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
  return { privateKey: readFileSync(keyPath, "utf8"), certificatePem: readFileSync(crtPath, "utf8") };
}

// --- synthetic Rekor -------------------------------------------------------

const rekorKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const rekorPublicKeyDer = rekorKeyPair.publicKey.export({ type: "spki", format: "der" });
const rekorLogId = createHash("sha256").update(rekorPublicKeyDer).digest();
const REKOR_ORIGIN = "rekor.test.invalid";

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
        baseUrl: `https://${REKOR_ORIGIN}`,
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

function signWith(privateKey, data) {
  const signer = createSign("SHA256");
  signer.update(data);
  signer.end();
  return signer.sign(privateKey);
}

// Builds a v0.3 bundle the stock engine accepts: a hashedrekord entry in a
// one-leaf log, carrying both an inclusion promise (SET) and an inclusion proof
// against a signed checkpoint. The tlog entry is also what anchors certificate
// validity in time, so the leaf's ten-minute window is actually checked.
function buildBundle(leaf, payload) {
  const signature = signWith(leaf.privateKey, payload);
  const payloadDigest = createHash("sha256").update(payload).digest();
  const canonicalizedBody = Buffer.from(
    JSON.stringify({
      apiVersion: "0.0.1",
      kind: "hashedrekord",
      spec: {
        data: { hash: { algorithm: "sha256", value: payloadDigest.toString("hex") } },
        signature: {
          content: signature.toString("base64"),
          publicKey: { content: Buffer.from(leaf.certificatePem).toString("base64") },
        },
      },
    }),
    "utf8",
  );

  const integratedTime = Math.floor(Date.now() / 1000);
  const logIndex = 0;
  const signedEntryTimestamp = signWith(
    rekorKeyPair.privateKey,
    Buffer.from(
      canonicalJson.canonicalize({
        body: canonicalizedBody.toString("base64"),
        integratedTime,
        logIndex,
        logID: rekorLogId.toString("hex"),
      }),
      "utf8",
    ),
  );

  // One leaf, so the RFC6962 root hash is the leaf hash and the proof is empty.
  const leafHash = createHash("sha256")
    .update(Buffer.concat([Buffer.from([0x00]), canonicalizedBody]))
    .digest();
  const note = `${REKOR_ORIGIN}\n1\n${leafHash.toString("base64")}\n`;
  const noteSignature = Buffer.concat([
    rekorLogId.subarray(0, 4),
    signWith(rekorKeyPair.privateKey, Buffer.from(note, "utf8")),
  ]);
  const envelope = `${note}\n— ${REKOR_ORIGIN} ${noteSignature.toString("base64")}\n`;

  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: {
      certificate: { rawBytes: pemToDer(leaf.certificatePem).toString("base64") },
      tlogEntries: [
        {
          logIndex: String(logIndex),
          logId: { keyId: rekorLogId.toString("base64") },
          kindVersion: { kind: "hashedrekord", version: "0.0.1" },
          integratedTime: String(integratedTime),
          inclusionPromise: { signedEntryTimestamp: signedEntryTimestamp.toString("base64") },
          inclusionProof: {
            logIndex: String(logIndex),
            rootHash: leafHash.toString("base64"),
            treeSize: "1",
            hashes: [],
            checkpoint: { envelope },
          },
          canonicalizedBody: canonicalizedBody.toString("base64"),
        },
      ],
    },
    messageSignature: {
      messageDigest: { algorithm: "SHA2_256", digest: payloadDigest.toString("base64") },
      signature: signature.toString("base64"),
    },
  };
}

// The stock sigstore verifier, with the synthetic roots swapped in for TUF's.
// Option mapping mirrors sigstore's own createVerifier(); ctlogThreshold is 0
// because synthetic leaves carry no SCT.
async function realSigstoreVerifier(bundle, payload, options) {
  const verifier = new Verifier(trustMaterial, { tlogThreshold: 1, ctlogThreshold: 0 });
  return verifier.verify(
    toSignedEntity(bundleFromJSON(bundle), payload),
    createVerificationPolicy(options),
  );
}

// --- artifact fixture ------------------------------------------------------

function legacyArtifact() {
  const root = mkdtempSync(join(tmpdir(), "signer-identity-artifact-"));
  const bundleDir = join(root, "bundle");
  execFileSync("mkdir", ["-p", bundleDir]);
  const manifestBuffer = Buffer.from(
    '{"connector_id":"legacy-connector","version":"1.0.0","name":"Legacy"}\n',
  );
  const scriptBuffer = Buffer.from("module.exports = {};\n");
  writeFileSync(join(bundleDir, "manifest.json"), manifestBuffer);
  writeFileSync(join(bundleDir, "script.js"), scriptBuffer);
  const artifactPath = join(root, "artifact.tgz");
  execFileSync("tar", ["-czf", artifactPath, "-C", bundleDir, "."]);
  const artifactBuffer = readFileSync(artifactPath);
  return {
    artifactBuffer,
    entry: {
      connectorId: "legacy-connector",
      company: "Synthetic",
      version: "1.0.0",
      name: "Legacy",
      description: "Synthetic contract fixture",
      publishedAt: "2026-07-30T00:00:00.000Z",
      sourceTag: "test",
      sourceCommit: "a".repeat(40),
      releaseId: "test",
      artifactPath: null,
      artifactUrl: ARTIFACT_URL,
      artifactSha256: `sha256:${createHash("sha256").update(artifactBuffer).digest("hex")}`,
      manifestSha256: `sha256:${createHash("sha256").update(manifestBuffer).digest("hex")}`,
      scriptSha256: `sha256:${createHash("sha256").update(scriptBuffer).digest("hex")}`,
      sourceFiles: {
        metadata: "synthetic/legacy-connector.json",
        script: "synthetic/legacy-connector.js",
      },
      artifactSignature: { type: "sigstoreBundle", bundleUrl: `${ARTIFACT_URL}.sigstore.json` },
    },
  };
}

// Runs the production fetch-and-verify path for an artifact signed by a
// certificate bearing `san`. Returns nothing on success; throws on refusal.
async function installWithSignerSan(san, { issuer } = {}) {
  const artifact = legacyArtifact();
  const bundle = buildBundle(mintLeaf(san, issuer), artifact.artifactBuffer);
  const routes = {
    [ARTIFACT_URL]: artifact.artifactBuffer,
    [`${ARTIFACT_URL}.sigstore.json`]: Buffer.from(JSON.stringify(bundle)),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const route = routes[String(url)];
    return route
      ? new Response(route)
      : new Response("not found\n", { status: 404, statusText: "Not Found" });
  };
  try {
    await fetchResolvedArtifact(
      { mode: "remote", doc: { connectors: { [artifact.entry.connectorId]: [artifact.entry] } } },
      artifact.entry,
      { sigstoreVerifier: realSigstoreVerifier },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// --- the pin ---------------------------------------------------------------

test("real sigstore verification accepts the pinned release-index workflow identity", async () => {
  await installWithSignerSan(PINNED);
});

// Each of these SANs contains the pinned identity as a substring, so an
// unanchored pattern matches them. They are the branches a collaborator with
// push rights can create in this repository, plus the general case of a SAN
// that merely embeds the pinned string.
for (const [label, san] of [
  ["a branch whose name extends main", PINNED.replace(/main$/, "mainline")],
  ["a branch suffixed with a digit", PINNED.replace(/main$/, "main2")],
  ["a branch suffixed with a hyphen", PINNED.replace(/main$/, "main-fix")],
  ["a SAN that embeds the pinned identity", `https://github.com/attacker/evil/.github/workflows/publish.yml@refs/heads/main?u=${PINNED}`],
]) {
  test(`real sigstore verification refuses ${label}`, async () => {
    await assert.rejects(
      () => installWithSignerSan(san),
      /signature verification failed: certificate identity error/,
    );
  });
}

// These were already refused before the pin was anchored; they stay refused.
for (const [label, san] of [
  ["a tag ref", PINNED.replace("refs/heads/main", "refs/tags/v1")],
  ["a fork of this repository", PINNED.replace("PDP-Connect", "attacker")],
  ["another workflow in this repository", PINNED.replace("publish-connector-release-index.yml", "ci.yml")],
]) {
  test(`real sigstore verification refuses ${label}`, async () => {
    await assert.rejects(
      () => installWithSignerSan(san),
      /signature verification failed: certificate identity error/,
    );
  });
}

test("real sigstore verification refuses the pinned identity from the wrong issuer", async () => {
  await assert.rejects(
    () => installWithSignerSan(PINNED, { issuer: "https://evil.example" }),
    /signature verification failed: invalid certificate extension/,
  );
});

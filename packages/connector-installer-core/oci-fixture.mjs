// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A real OCI connector artifact, served by a real in-process registry, signed
// with a real cosign-shaped signature — built here so the acceptance tests
// exercise the parsing and verification code rather than a mock of it.
//
// WHY NOT A MOCKED `fetch`. The properties under test are almost all properties
// of a WIRE FORMAT: which tag a cosign signature lives at, which annotation
// carries it, that a signature is over the raw simple-signing payload bytes,
// that `assets.tar.gz` is absent for a connector with no brand icon and every
// later layer shifts. A hand-written mock encodes the author's belief about
// each of those, so a test built on one passes exactly when the belief is
// self-consistent — including when it is wrong. The layout reproduced below
// was read off cosign v2.4.3 and ORAS 1.2.3 pushing to a `registry:2`, which is
// the pairing the publish workflow pins.
//
// The registry is a few dozen lines of `node:http` rather than a container
// because the tests must run in CI without a Docker daemon. It serves exactly
// the three verbs a puller uses — token, manifest, blob — and nothing else, so
// it cannot accidentally paper over a request the real GHCR would reject.
//
// The signature is minted with a locally generated key and a self-issued
// certificate carrying the pinned SAN URI, and verified through an injected
// verifier. It is NOT a Fulcio certificate and there is no Rekor entry: those
// require a real OIDC identity, so what these tests prove is the assembly,
// transport and policy plumbing. That the real GHCR + Fulcio pairing behaves
// the same is what the live pull in the report is for.

import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const PINNED_IDENTITY =
  "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main";
export const PINNED_ISSUER = "https://token.actions.githubusercontent.com";

export function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * A deterministic `.tar.gz` holding the given files, built the way the
 * publisher builds one.
 */
export function tarball(files, { mode = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "oci-fixture-tar-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = join(root, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }
    if (mode) mode(root);
    const out = join(root, "..", `${Math.random().toString(36).slice(2)}.tar.gz`);
    execFileSync("tar", ["-czf", out, "-C", root, "."]);
    const buffer = execFileSync("cat", [out]);
    rmSync(out, { force: true });
    return buffer;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * A signing identity: an EC key plus a certificate asserting the SAN URI.
 *
 * `identity` is a parameter rather than a constant so a test can mint a
 * signature under a DIFFERENT workflow ref and prove it is refused — which is
 * the whole of A-T3.
 */
export function createSigner(identity = PINNED_IDENTITY) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    identity,
    privateKey,
    publicKey,
    certificatePem: `-----BEGIN CERTIFICATE-----\n${Buffer.from(identity).toString("base64")}\n-----END CERTIFICATE-----`,
    sign(payload) {
      const signer = createSign("SHA256");
      signer.update(payload);
      signer.end();
      return signer.sign(privateKey).toString("base64");
    },
  };
}

/**
 * A verifier standing in for `sigstore.verify`.
 *
 * It enforces exactly the two properties the real one enforces that these
 * tests are about: the signature verifies over the payload under the signer's
 * key, and the certificate's identity EQUALS the pinned identity — equality,
 * not prefix, so `...@refs/heads/attacker` fails (C3.1, C3.4). Real bundle
 * assembly is still exercised, because `verifyOciSignature` builds the bundle
 * before handing it here.
 */
export function createFixtureVerifier(signers) {
  const list = Array.isArray(signers) ? signers : [signers];
  return async (bundle, payload, options) => {
    const certificate = bundle?.verificationMaterial?.certificate?.rawBytes;
    if (!certificate) throw new Error("bundle carries no certificate");
    const identity = Buffer.from(certificate, "base64").toString("utf8");

    if (identity !== options.certificateIdentityURI) {
      throw new Error(
        `certificate identity ${identity} does not equal the pinned ${options.certificateIdentityURI}`
      );
    }
    if (options.certificateIssuer !== PINNED_ISSUER) {
      throw new Error(`unexpected issuer ${options.certificateIssuer}`);
    }

    const signature = Buffer.from(
      bundle?.messageSignature?.signature ?? "",
      "base64"
    );
    const signer = list.find((candidate) => candidate.identity === identity);
    if (!signer) throw new Error(`no key for identity ${identity}`);

    const { createVerify } = await import("node:crypto");
    const verifier = createVerify("SHA256");
    verifier.update(payload);
    verifier.end();
    if (!verifier.verify(signer.publicKey, signature)) {
      throw new Error("signature does not verify over the payload");
    }
    return { identity };
  };
}

/**
 * An in-process registry holding blobs and manifests by digest and by tag.
 *
 * `challenge` makes it demand a Bearer token first, so the token handshake is
 * exercised rather than assumed. `faults` lets a test replace the reply for one
 * path, which is how the present/absent/unknown table is driven.
 */
export class FixtureRegistry {
  constructor({ challenge = false } = {}) {
    this.blobs = new Map();
    this.manifests = new Map();
    this.tags = new Map();
    this.challenge = challenge;
    this.faults = new Map();
    this.requests = [];
    this.server = null;
  }

  putBlob(buffer) {
    const digest = sha256(buffer);
    this.blobs.set(digest, buffer);
    return digest;
  }

  putManifest(manifest, tag) {
    const bytes = Buffer.from(JSON.stringify(manifest), "utf8");
    const digest = sha256(bytes);
    this.manifests.set(digest, bytes);
    if (tag) this.tags.set(tag, digest);
    return { digest, bytes };
  }

  /** Replace the reply for one manifest reference, to drive the outcome table. */
  faultManifest(reference, reply) {
    this.faults.set(reference, reply);
  }

  async start() {
    this.server = createServer((req, res) => {
      this.requests.push(req.url);
      const url = new URL(req.url, "http://localhost");

      if (url.pathname === "/token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "fixture-token" }));
        return;
      }

      if (this.challenge && !req.headers.authorization) {
        res.writeHead(401, {
          "www-authenticate": `Bearer realm="http://127.0.0.1:${this.port}/token",service="fixture"`,
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "auth required" }] }));
        return;
      }

      const manifestMatch = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(url.pathname);
      if (manifestMatch) {
        const reference = decodeURIComponent(manifestMatch[2]);
        const fault = this.faults.get(reference);
        if (fault) {
          res.writeHead(fault.status, fault.headers ?? { "content-type": "application/json" });
          res.end(fault.body ?? "");
          return;
        }
        const digest = reference.startsWith("sha256:")
          ? reference
          : this.tags.get(reference);
        const bytes = digest ? this.manifests.get(digest) : null;
        if (!bytes) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN", message: "not found" }] }));
          return;
        }
        res.writeHead(200, {
          "content-type": "application/vnd.oci.image.manifest.v1+json",
          "docker-content-digest": sha256(bytes),
        });
        res.end(bytes);
        return;
      }

      const blobMatch = /^\/v2\/(.+)\/blobs\/(.+)$/.exec(url.pathname);
      if (blobMatch) {
        const buffer = this.blobs.get(decodeURIComponent(blobMatch[2]));
        if (!buffer) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [{ code: "BLOB_UNKNOWN", message: "not found" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(buffer);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = this.server.address().port;
    this.registry = `127.0.0.1:${this.port}`;
    return this;
  }

  async stop() {
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
  }
}

/**
 * Push a complete, signed connector artifact and return everything a test
 * needs to install or tamper with it.
 *
 * Mirrors the publisher: the config restates four profile fields plus a digest
 * over the profile bytes, layers are emitted in the builder's order, and
 * `assets.tar.gz` appears only when `withAssets` is set — which is what lets a
 * test prove selection is by media type and not by index.
 */
export function publishArtifact(
  registry,
  {
    connectorKey = "ynab",
    connectorId = "https://github.com/PDP-Connect/data-connectors/connector/ynab",
    version = "0.3.0",
    protocolVersion = "1.0",
    withAssets = false,
    signer = null,
    signers = null,
    payloadDigestOverride = null,
    extraLayers = [],
    codeFiles = null,
    codeBytes: codeBytesOverride = null,
    tamperLayer = null,
    configOverrides = {},
  } = {}
) {
  const profile = {
    connector_key: connectorKey,
    connector_id: connectorId,
    version,
    protocol_version: protocolVersion,
    display_name: "YNAB",
  };
  const profileBytes = canonicalJson(profile);

  const codeBytes =
    codeBytesOverride ??
    tarball(codeFiles ?? { "code/collection-profile.mjs": "export const collect = () => {};\n" });
  const licensesBytes = tarball({ LICENSE: "Apache-2.0\n", NOTICE: "notice\n" });
  const assetsBytes = withAssets ? tarball({ "icon.svg": "<svg/>\n" }) : null;
  const provenanceBytes = canonicalJson({ connector_key: connectorKey, version });

  const config = {
    config_version: "1.0",
    connector_key: connectorKey,
    connector_id: connectorId,
    version,
    protocol_version: protocolVersion,
    profile_digest: sha256(profileBytes),
    entrypoint: "code/collection-profile.mjs",
    entrypoint_kind: "import-safe",
    exports: ["collect"],
    bundled_tools: [],
    licenses: "Apache-2.0",
    ...configOverrides,
  };
  const configBytes = canonicalJson(config);

  // A tampered layer keeps the descriptor the clean bytes earned and has the
  // registry serve DIFFERENT bytes under it. That is the real shape of the
  // attack — the manifest, and so the signature over it, stay untouched — and
  // it is the only shape the per-layer digest check is the sole defence
  // against. Registering a descriptor for bytes that are simply absent would
  // instead be caught by the 404, proving nothing.
  const layer = (buffer, mediaType, title) => {
    const digest = registry.putBlob(buffer);
    if (tamperLayer === title) {
      registry.blobs.set(digest, Buffer.concat([buffer, Buffer.from("tampered")]));
    }
    return {
      mediaType,
      digest,
      size: buffer.length,
      annotations: { "org.opencontainers.image.title": title },
    };
  };

  // Emitted in the publisher's order; `assets` sits BETWEEN code and licenses
  // when present, which is exactly what shifts positions when it is not.
  const layers = [
    layer(profileBytes, "application/vnd.pdpp.connector.profile.v1+json", "collection-profile.json"),
    layer(codeBytes, "application/vnd.pdpp.connector.code.v1.tar+gzip", "code.tar.gz"),
    ...(assetsBytes
      ? [layer(assetsBytes, "application/vnd.pdpp.connector.assets.v1.tar+gzip", "assets.tar.gz")]
      : []),
    layer(licensesBytes, "application/vnd.pdpp.connector.licenses.v1.tar+gzip", "licenses.tar.gz"),
    layer(provenanceBytes, "application/vnd.pdpp.connector.provenance.v1+json", "provenance.json"),
    ...extraLayers,
  ];

  const manifest = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.pdpp.connector.v1+json",
    config: {
      mediaType: "application/vnd.pdpp.connector.config.v1+json",
      digest: registry.putBlob(configBytes),
      size: configBytes.length,
    },
    layers,
    annotations: {
      "org.opencontainers.image.version": version,
      "dev.pdpp.connector.key": connectorKey,
    },
  };

  const { digest } = registry.putManifest(manifest, version);

  // The cosign signature object: a manifest at `sha256-<hex>.sig` whose layers
  // are simple-signing payloads, the signature in one annotation and the
  // certificate in another.
  const signerList = signers ?? (signer ? [signer] : []);
  if (signerList.length > 0) {
    const sigLayers = signerList.map((candidate) => {
      const payload = canonicalJson({
        critical: {
          identity: { "docker-reference": `${registry.registry}/pdp-connect/connector/${connectorKey}` },
          image: { "docker-manifest-digest": payloadDigestOverride ?? digest },
          type: "cosign container image signature",
        },
        optional: null,
      });
      return {
        mediaType: "application/vnd.dev.cosign.simplesigning.v1+json",
        digest: registry.putBlob(payload),
        size: payload.length,
        annotations: {
          "dev.cosignproject.cosign/signature": candidate.sign(payload),
          "dev.sigstore.cosign/certificate": candidate.certificatePem,
        },
      };
    });

    registry.putManifest(
      {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: registry.putBlob(Buffer.from("{}")), size: 2 },
        layers: sigLayers,
      },
      `${digest.replace(":", "-")}.sig`
    );
  }

  return { digest, manifest, profile, profileBytes, config, configBytes, codeBytes, provenanceBytes };
}

/** A lock entry pointing at a published fixture artifact. */
export function ociLockEntry(registry, digest, overrides = {}) {
  return {
    connectorId: "ynab-pdpp",
    connectorKey: "ynab",
    company: "YNAB",
    version: "0.3.0",
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/collection-profile.mjs",
    provenancePath: "provenance.json",
    oci: {
      registry: registry.registry,
      repository: "pdp-connect/connector/ynab",
      digest,
    },
    ...overrides,
  };
}

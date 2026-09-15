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
// the endpoints a puller uses — token, tags, manifest, blob — so
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
 * A `.tar.gz` with the publisher's layer-relative file names. A mode callback
 * can add hostile members, so those tests archive the entire staging tree.
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
    execFileSync("tar", ["-czf", out, "-C", root, ...(mode ? ["."] : Object.keys(files).sort())]);
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
 * The three annotations cosign puts on a signature layer.
 *
 * The Rekor one matters to production: a layer without an inclusion promise is
 * refused, because with no tlog entry there is no timestamp and the
 * certificate's validity window stops being checked. The fixture verifier does
 * not check the promise — the real engine does, in oci-identity.test.mjs — but
 * the annotation must be present or every layout test would be exercising that
 * refusal path instead of the behaviour it names. `omitRekorBundle` drives the
 * refusal deliberately.
 */
export function cosignSignatureAnnotations(signer, payload, { omitRekorBundle = false } = {}) {
  const annotations = {
    "dev.cosignproject.cosign/signature": signer.sign(payload),
    "dev.sigstore.cosign/certificate": signer.certificatePem,
  };
  if (!omitRekorBundle) {
    annotations["dev.sigstore.cosign/bundle"] = JSON.stringify({
      SignedEntryTimestamp: Buffer.from("fixture-set").toString("base64"),
      Payload: {
        body: Buffer.from(
          JSON.stringify({ apiVersion: "0.0.1", kind: "hashedrekord", spec: {} })
        ).toString("base64"),
        integratedTime: 1757894400,
        logIndex: 1,
        logID: "c0d23d6a".repeat(8),
      },
    });
  }
  return annotations;
}

/**
 * A verifier standing in for `sigstore.verify` in tests that are about LAYOUT —
 * layer dispatch, unpacking, digest binding, registry behaviour. It is not
 * evidence about identity matching and must not be used as such.
 *
 * It previously compared the identity with `!==`, which reimplemented the
 * property under test and reported "exact" for a pin that was not: production
 * hands sigstore an unanchored regular expression, and this fixture could not
 * see the difference. The identity cases now live in oci-identity.test.mjs
 * against the real `@sigstore/verify` engine.
 *
 * What remains here applies the pattern the way sigstore does — as a regular
 * expression — so this fixture can never accept a SAN the real engine refuses.
 * Real bundle assembly is still exercised, because `verifyOciSignature` builds
 * the bundle before handing it here.
 */
export function createFixtureVerifier(signers) {
  const list = Array.isArray(signers) ? signers : [signers];
  return async (bundle, payload, options) => {
    const certificate = bundle?.verificationMaterial?.certificate?.rawBytes;
    if (!certificate) throw new Error("bundle carries no certificate");
    const identity = Buffer.from(certificate, "base64").toString("utf8");

    if (!new RegExp(options.certificateIdentityURI).test(identity)) {
      throw new Error(
        `certificate identity ${identity} does not match the pinned ${options.certificateIdentityURI}`
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
  constructor({ challenge = false, realm = null } = {}) {
    this.blobs = new Map();
    this.manifests = new Map();
    this.tags = new Map();
    this.challenge = challenge;
    // Points the Bearer challenge somewhere other than this server, which is
    // how a test drives the token-realm destination policy.
    this.realm = realm;
    // When set, the next /token request answers 302 to this location instead of
    // a token, so a test can drive the per-hop token-realm check.
    this.redirectTokenTo = null;
    this.faults = new Map();
    this.requests = [];
    this.requestHeaders = [];
    this.pathFaults = new Map();
    this.tagLists = new Map();
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
      this.requestHeaders.push({ url: req.url, authorization: req.headers.authorization });
      const url = new URL(req.url, "http://localhost");

      const pathFault = this.pathFaults.get(url.pathname);
      const sendPathFault = () => {
        res.writeHead(pathFault.status, pathFault.headers ?? { "content-type": "application/json" });
        res.end(pathFault.body ?? "");
      };

      if (url.pathname === "/token") {
        if (pathFault) {
          sendPathFault();
          return;
        }
        // `redirectTokenTo` makes this realm answer a 302 instead of a token,
        // which is how a test drives the per-hop origin check. It fires once so
        // the redirected request is answered normally and a same-origin hop can
        // still complete.
        if (this.redirectTokenTo && !url.searchParams.has("hop")) {
          const location = this.redirectTokenTo;
          this.redirectTokenTo = null;
          res.writeHead(302, { location });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "fixture-token" }));
        return;
      }

      if (this.challenge && !req.headers.authorization) {
        res.writeHead(401, {
          "www-authenticate": `Bearer realm="${this.realm ?? `http://127.0.0.1:${this.port}/token`}",service="fixture"`,
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ errors: [{ code: "UNAUTHORIZED", message: "auth required" }] }));
        return;
      }

      if (pathFault) {
        sendPathFault();
        return;
      }

      const tagsMatch = /^\/v2\/(.+)\/tags\/list$/.exec(url.pathname);
      if (tagsMatch) {
        const repository = tagsMatch[1];
        const listing = this.tagLists.get(repository);
        if (!listing) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [{ code: "NAME_UNKNOWN", message: "repository unknown" }] }));
          return;
        }
        const { tags, pageSize = tags.length, nextLink = null } = listing;
        const last = url.searchParams.get("last");
        const start = last === null ? 0 : tags.indexOf(last) + 1;
        const page = tags.slice(start, start + pageSize);
        const headers = { "content-type": "application/json" };
        if (page.length && start + page.length < tags.length) {
          headers.link = nextLink ?? `<${url.pathname}?last=${encodeURIComponent(page.at(-1))}&n=${pageSize}>; rel="next"`;
        }
        res.writeHead(200, headers);
        res.end(JSON.stringify({ name: repository, tags: page }));
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
    omitRekorBundle = false,
    payloadDigestOverride = null,
    extraLayers = [],
    codeFiles = null,
    codeBytes: codeBytesOverride = null,
    assetsBytes: assetsBytesOverride = null,
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
    ...(withAssets ? { brand: { icon: "icons/ynab.svg" } } : {}),
  };
  const profileBytes = canonicalJson(profile);

  const codeBytes =
    codeBytesOverride ??
    tarball(codeFiles ?? { "collection-profile.mjs": "export const collect = () => {};\n" });
  const licensesBytes = tarball({ LICENSE: "Apache-2.0\n", NOTICE: "notice\n" });
  const assetsBytes = withAssets
    ? (assetsBytesOverride ?? tarball({ "icons/ynab.svg": "<svg/>\n" }))
    : null;
  const provenanceBytes = canonicalJson({ connector_key: connectorKey, version });

  // Contract: config.entrypoint is artifact-wide (`code/<member>`), while the
  // code layer tar member itself is layer-relative (`<member>`).
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
        annotations: cosignSignatureAnnotations(candidate, payload, { omitRekorBundle }),
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

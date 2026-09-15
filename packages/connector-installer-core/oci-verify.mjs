// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The trust half of OCI connector consumption: prove that the bytes the
// registry served are the bytes this repository's publish workflow signed, and
// refuse everything else.
//
// WHY THIS IS NOT `sigstore.verify(bundle, payload)` AND DONE. The tarball path
// verifies a Sigstore bundle fetched from a sibling URL — one file, already in
// the shape the library reads. Cosign does not publish a bundle. It publishes a
// SEPARATE REGISTRY OBJECT at a tag derived from the digest, and scatters the
// pieces of a bundle across that object's manifest:
//
//   tag     `sha256-<hex>.sig`                            (the digest, `:`→`-`)
//   layer   application/vnd.dev.cosign.simplesigning.v1+json
//   body    the simple-signing payload — the signed bytes
//   ann.    dev.cosignproject.cosign/signature   base64 signature over the body
//   ann.    dev.sigstore.cosign/certificate      PEM Fulcio cert (keyless)
//
// So the work here is to fetch those pieces and reassemble the bundle the
// library can verify. The layout above is not read off the cosign docs: it was
// observed against cosign v2.4.3 — the version the publish workflow pins —
// pushing to a local registry, and the signature was confirmed to be a plain
// ECDSA-SHA256 signature over the RAW payload bytes, which is exactly what
// `toMessageSignatureBundle` expects. `oci.test.mjs` builds its fixtures the
// same way, so the assembly below is exercised against the real shape rather
// than against an idea of it.
//
// THE TWO DIGESTS, AND WHY BOTH ARE CHECKED. The payload cosign signs does not
// contain the artifact; it contains a CLAIM about the artifact, in
// `critical.image.docker-manifest-digest`. A valid signature over a payload
// naming a DIFFERENT manifest is a real signature by the real signer that says
// nothing about the bytes being installed — it is a signature lifted from
// another artifact. So the signature must verify AND the digest it names must
// be the digest being installed (C3.3). Verifying only the first is the mistake
// this file exists to not make.
//
// TLOG. `toMessageSignatureBundle` produces a bundle with no transparency-log
// entries, because cosign keeps the Rekor entry in its own annotation rather
// than in the layer. The verification below therefore runs with a tlog
// threshold of 0 and rests on the Fulcio certificate's identity, which is the
// property being pinned. That is a narrower guarantee than the tarball path's
// bundle gives, and it is stated here rather than left to be discovered.

import { toMessageSignatureBundle, bundleToJSON } from "@sigstore/bundle";
import { verify as verifySigstoreBundle } from "sigstore";

import {
  OciRegistryError,
  fetchBlob,
  fetchSignatureManifest,
  isValidDigest,
  sha256Digest,
} from "./oci-registry.mjs";

export const COSIGN_SIGNATURE_MEDIA_TYPE =
  "application/vnd.dev.cosign.simplesigning.v1+json";
export const COSIGN_SIGNATURE_ANNOTATION = "dev.cosignproject.cosign/signature";
export const COSIGN_CERTIFICATE_ANNOTATION = "dev.sigstore.cosign/certificate";

// The layer media types the connector artifact contract defines. Selection is
// BY MEDIA TYPE, never by position: `assets.tar.gz` is emitted only when the
// profile declares a brand icon, so every later layer shifts when it is absent
// (C4.2).
export const OCI_LAYER_MEDIA_TYPES = {
  profile: "application/vnd.pdpp.connector.profile.v1+json",
  code: "application/vnd.pdpp.connector.code.v1.tar+gzip",
  assets: "application/vnd.pdpp.connector.assets.v1.tar+gzip",
  licenses: "application/vnd.pdpp.connector.licenses.v1.tar+gzip",
  provenance: "application/vnd.pdpp.connector.provenance.v1+json",
};

export const OCI_CONFIG_MEDIA_TYPE =
  "application/vnd.pdpp.connector.config.v1+json";

const KNOWN_LAYER_MEDIA_TYPES = new Set(Object.values(OCI_LAYER_MEDIA_TYPES));

// Which layers an artifact cannot be without. `assets` is deliberately absent
// from this list, and that absence is the thing A-T6 pins.
const REQUIRED_LAYERS = ["profile", "code", "licenses", "provenance"];

export const DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER =
  "https://token.actions.githubusercontent.com";

// The identity the publish workflow signs as. EXACT match, never a prefix: the
// trailing `@refs/heads/main` is what distinguishes a signature minted by a run
// on main from one minted by a run on any branch, and prefix-matching it would
// accept `...publish-polyfill-connectors.yml@refs/heads/attacker` (C3.1, C3.2).
export const DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY =
  "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main";

/**
 * Reference → trusted identity, fail-closed.
 *
 * The OCI analogue of the tarball path's URL→identity resolver. It returns a
 * string for a reference this consumer trusts and `null` for everything else,
 * and `null` is a hard refusal at the call site — never a downgrade to
 * unsigned, and never a fallback to a default (C3.2).
 *
 * Note what it is a function OF: the registry and repository — the coordinates
 * the LOCK named. It is not passed the artifact, and that is the point (C3.5):
 * if the thing being verified could select the identity it is verified against,
 * verification would prove only that the artifact agrees with itself.
 */
export function defaultOciCertificateIdentityResolver({ registry, repository }) {
  if (registry !== "ghcr.io") return null;
  if (!/^pdp-connect\/connector\/[a-z0-9][a-z0-9-]*$/.test(repository)) return null;
  return DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY;
}

/**
 * Pull the signature, certificate and signed payload out of a cosign `.sig`
 * manifest.
 *
 * A `.sig` manifest may carry MORE THAN ONE signature layer — cosign appends
 * rather than replaces, so a re-signed artifact accumulates them. Every layer
 * is returned and the caller tries each, because a single valid signature by
 * the pinned identity is what authorises the install; an older signature by a
 * rotated key sitting alongside it is not a reason to refuse.
 */
export function extractCosignSignatures(signatureManifest) {
  const layers = Array.isArray(signatureManifest?.layers) ? signatureManifest.layers : [];
  const signatures = [];

  for (const layer of layers) {
    if (layer?.mediaType !== COSIGN_SIGNATURE_MEDIA_TYPE) continue;
    const signature = layer?.annotations?.[COSIGN_SIGNATURE_ANNOTATION];
    const certificate = layer?.annotations?.[COSIGN_CERTIFICATE_ANNOTATION];
    if (typeof signature !== "string" || signature.length === 0) continue;
    if (!isValidDigest(layer?.digest)) continue;
    signatures.push({
      signature,
      certificate: typeof certificate === "string" ? certificate : null,
      payloadDigest: layer.digest,
    });
  }

  return signatures;
}

/**
 * Check that a simple-signing payload is about the artifact being installed.
 *
 * `critical.image.docker-manifest-digest` is the claim; the manifest digest the
 * lock pinned is the fact. They must be equal, or the signature — however
 * valid — belongs to a different artifact (C3.3).
 */
export function assertPayloadNamesDigest(payloadBytes, manifestDigest) {
  let payload;
  try {
    payload = JSON.parse(payloadBytes.toString("utf8"));
  } catch (error) {
    throw new OciRegistryError(
      `The cosign signature payload is not JSON: ${error.message}`,
      "tampered"
    );
  }

  const claimed = payload?.critical?.image?.["docker-manifest-digest"];
  if (typeof claimed !== "string" || claimed.length === 0) {
    throw new OciRegistryError(
      "The cosign signature payload names no manifest digest",
      "tampered"
    );
  }
  if (claimed.trim() !== manifestDigest.trim()) {
    throw new OciRegistryError(
      `The cosign signature covers manifest ${claimed.trim()}, not ${manifestDigest.trim()}`,
      "misidentified"
    );
  }
  return payload;
}

/**
 * Assemble a cosign signature into the bundle shape `sigstore` verifies.
 *
 * The signature is over the raw payload bytes, so it becomes a message
 * signature whose digest is those bytes' SHA-256, with the Fulcio certificate
 * as the verification material.
 */
function assembleBundle({ payloadBytes, signature, certificate }) {
  const der = Buffer.from(
    certificate
      .replace(/-----BEGIN CERTIFICATE-----/g, "")
      .replace(/-----END CERTIFICATE-----/g, "")
      .replace(/\s+/g, ""),
    "base64"
  );

  return bundleToJSON(
    toMessageSignatureBundle({
      digest: Buffer.from(sha256Digest(payloadBytes).slice("sha256:".length), "hex"),
      signature: Buffer.from(signature, "base64"),
      certificate: der,
    })
  );
}

/**
 * Verify that a manifest digest was signed by the pinned identity.
 *
 * Every refusal path here is a refusal, never a downgrade: a missing signature,
 * a signature that verifies under another identity, and a signature naming
 * another artifact all abort the install (C3.1, C3.3, C3.4). Returns the
 * identity that was proven, so a caller can log what it trusted rather than
 * what it hoped for.
 */
export async function verifyOciSignature({
  registry,
  repository,
  digest,
  scheme = "https",
  timeoutMs = 30000,
  fetchImpl = fetch,
  certificateIdentityResolver = defaultOciCertificateIdentityResolver,
  certificateIssuer = DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
  sigstoreVerifier = verifySigstoreBundle,
}) {
  // Resolved from the LOCK'S coordinates, before the artifact is consulted, so
  // nothing the artifact carries can influence what it is checked against.
  const certificateIdentityURI = await certificateIdentityResolver({ registry, repository });
  if (typeof certificateIdentityURI !== "string" || certificateIdentityURI.length === 0) {
    throw new OciRegistryError(
      `No trusted Sigstore certificate identity configured for ${registry}/${repository}`,
      "misidentified"
    );
  }

  const signatureObject = await fetchSignatureManifest({
    registry,
    repository,
    digest,
    scheme,
    timeoutMs,
    fetchImpl,
  });
  if (signatureObject === null) {
    throw new OciRegistryError(
      `${registry}/${repository}@${digest} has no cosign signature`,
      "unsigned"
    );
  }

  const signatures = extractCosignSignatures(signatureObject.manifest);
  if (signatures.length === 0) {
    throw new OciRegistryError(
      `The cosign signature object for ${registry}/${repository}@${digest} carries no usable signature layer`,
      "unsigned"
    );
  }

  const failures = [];
  for (const candidate of signatures) {
    if (!candidate.certificate) {
      failures.push("a signature layer carries no Fulcio certificate");
      continue;
    }

    // Verified against the digest that named it, like any other blob.
    const payloadBytes = await fetchBlob({
      registry,
      repository,
      digest: candidate.payloadDigest,
      scheme,
      timeoutMs,
      fetchImpl,
    });

    // Checked BEFORE the cryptographic verification, so a signature lifted from
    // another artifact is refused as misidentified rather than reported as a
    // verification failure.
    assertPayloadNamesDigest(payloadBytes, digest);

    try {
      await sigstoreVerifier(
        assembleBundle({
          payloadBytes,
          signature: candidate.signature,
          certificate: candidate.certificate,
        }),
        payloadBytes,
        {
          certificateIssuer,
          certificateIdentityURI,
          // Cosign stores its Rekor entry in a separate annotation rather than
          // in the layer, so an assembled bundle legitimately has none. See the
          // TLOG note at the top of this file for what that narrows.
          tlogThreshold: 0,
          ctLogThreshold: 0,
        }
      );
      return { certificateIdentityURI, certificateIssuer };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new OciRegistryError(
    `No cosign signature for ${registry}/${repository}@${digest} verifies as ` +
      `${certificateIdentityURI}: ${failures.join("; ")}`,
    "misidentified"
  );
}

/**
 * Index an artifact manifest's layers by media type, refusing anything unknown.
 *
 * Fail-closed on an unrecognised media type (C4.3), matching how the tarball
 * path treats an unknown `artifactKind`: a layer this consumer cannot name is a
 * layer it cannot reason about, and installing the rest of the artifact while
 * ignoring it would be deciding that the publisher's addition did not matter.
 */
export function indexLayersByMediaType(manifest, { repository = "" } = {}) {
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : [];
  const byKind = {};

  for (const layer of layers) {
    if (!KNOWN_LAYER_MEDIA_TYPES.has(layer?.mediaType)) {
      throw new OciRegistryError(
        `Refusing ${repository}: unrecognised layer media type "${layer?.mediaType}"`,
        "unsupported-layer"
      );
    }
    const kind = Object.keys(OCI_LAYER_MEDIA_TYPES).find(
      (name) => OCI_LAYER_MEDIA_TYPES[name] === layer.mediaType
    );
    if (byKind[kind]) {
      throw new OciRegistryError(
        `Refusing ${repository}: duplicate "${kind}" layer`,
        "unsupported-layer"
      );
    }
    if (!isValidDigest(layer?.digest)) {
      throw new OciRegistryError(
        `Refusing ${repository}: "${kind}" layer has an invalid digest`,
        "tampered"
      );
    }
    byKind[kind] = layer;
  }

  for (const required of REQUIRED_LAYERS) {
    if (!byKind[required]) {
      throw new OciRegistryError(
        `Refusing ${repository}: artifact has no "${required}" layer`,
        "unsupported-layer"
      );
    }
  }

  return byKind;
}

/**
 * Cross-check the config blob against the profile it describes (C4.4).
 *
 * The publisher runs this check too, and that does not discharge the
 * obligation: the whole reason the config restates these four fields instead of
 * pointing at them is that two independently stored copies can be compared. A
 * consumer that trusts the publisher ran the check is storing them twice for
 * no reason.
 */
export function assertConfigMatchesProfile({ config, profileBytes, profile, repository = "" }) {
  const profileDigest = sha256Digest(profileBytes);
  if (config?.profile_digest !== profileDigest) {
    throw new OciRegistryError(
      `Refusing ${repository}: config.profile_digest is ${config?.profile_digest}, ` +
        `but the profile layer hashes to ${profileDigest}`,
      "tampered"
    );
  }

  for (const field of ["connector_key", "connector_id", "protocol_version", "version"]) {
    if (config?.[field] !== profile?.[field]) {
      throw new OciRegistryError(
        `Refusing ${repository}: config.${field} is ${JSON.stringify(config?.[field])}, ` +
          `but the profile declares ${JSON.stringify(profile?.[field])}`,
        "tampered"
      );
    }
  }
}

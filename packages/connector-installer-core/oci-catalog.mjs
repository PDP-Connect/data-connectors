// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { assertCatalog, isCatalogTimestamp } from "./catalog-schema.mjs";
import {
  DEFAULT_OCI_REGISTRY,
  OciRegistryError,
  fetchBlob,
  fetchManifestByDigest,
  isValidDigest,
  parseOciReference,
  resolveVersionToDigest,
} from "./oci-registry.mjs";
import {
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
  verifyOciSignature,
} from "./oci-verify.mjs";

export const CATALOG_MEDIA_TYPE = "application/vnd.pdpp.connector-catalog.v1+json";
export const CATALOG_REPOSITORY = "pdp-connect/connector-catalog";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

/** Fetch a signed discovery catalog; callers persist generated_at after acceptance. */
export async function fetchCatalog({
  registry = DEFAULT_OCI_REGISTRY,
  identity = DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
  lastAcceptedGeneratedAt,
  // Explicit caller-owned transport/trust hooks for the local registry fixture.
  scheme = "https",
  timeoutMs = 30000,
  fetchImpl = fetch,
  retryOptions = {},
  allowedRegistries,
  sigstoreVerifier,
} = {}) {
  parseOciReference({ registry, repository: CATALOG_REPOSITORY, version: "latest", allowedRegistries });
  if (typeof identity !== "string" || identity.length === 0) {
    throw new OciRegistryError("Catalog requires a trusted certificate identity", "misidentified");
  }
  if (lastAcceptedGeneratedAt !== undefined && !isCatalogTimestamp(lastAcceptedGeneratedAt)) {
    throw new OciRegistryError("Invalid lastAcceptedGeneratedAt", "invalid-reference");
  }
  const previous = lastAcceptedGeneratedAt === undefined ? null : Date.parse(lastAcceptedGeneratedAt);
  const transport = {
    registry,
    repository: CATALOG_REPOSITORY,
    scheme,
    timeoutMs,
    fetchImpl,
    retryOptions,
  };
  const digest = await resolveVersionToDigest({ ...transport, version: "latest" });
  const { manifest } = await fetchManifestByDigest({ ...transport, digest });
  await verifyOciSignature({
    ...transport,
    digest,
    certificateIdentityResolver: () => identity,
    sigstoreVerifier,
  });

  const layer = manifest?.layers?.[0];
  if (
    manifest?.schemaVersion !== 2 ||
    manifest?.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    manifest?.artifactType !== CATALOG_MEDIA_TYPE ||
    !Array.isArray(manifest.layers) || manifest.layers.length !== 1 ||
    layer?.mediaType !== CATALOG_MEDIA_TYPE
  ) {
    throw new OciRegistryError("Catalog must have exactly one catalog JSON layer in an OCI image manifest", "unsupported-layer");
  }
  if (!isValidDigest(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 0 || layer.size > MAX_CATALOG_BYTES) {
    throw new OciRegistryError("Catalog layer has an invalid digest or size", "tampered");
  }
  const bytes = await fetchBlob({ ...transport, digest: layer.digest, maxBytes: MAX_CATALOG_BYTES });
  if (bytes.length !== layer.size) {
    throw new OciRegistryError("Catalog layer size does not match its descriptor", "tampered");
  }
  let catalog;
  try {
    catalog = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new OciRegistryError("Catalog layer is not JSON", "invalid-catalog");
  }
  try {
    assertCatalog(catalog);
  } catch (error) {
    throw new OciRegistryError(`Invalid catalog: ${error.message}`, "invalid-catalog");
  }
  if (previous !== null && Date.parse(catalog.generated_at) < previous) {
    throw new OciRegistryError(`Catalog generated_at ${catalog.generated_at} is older than ${lastAcceptedGeneratedAt}`, "stale-catalog");
  }
  return { catalog, digest };
}

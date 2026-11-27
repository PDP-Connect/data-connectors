// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve as resolvePath, sep } from "node:path";

import { readTarGzEntries } from "./tar-stream.mjs";

import {
  DEFAULT_OCI_REGISTRY as DEFAULT_OCI_REGISTRY_NAME,
  OciRegistryError,
  discoverSourceDeclarationReferrers,
  fetchBlob,
  fetchManifestByDigest,
  isValidConnectorKey,
  parseOciReference,
  resolveVersionToDigest,
  sha256Digest,
} from "./oci-registry.mjs";
import {
  OCI_CONFIG_MEDIA_TYPE,
  OCI_LAYER_MEDIA_TYPES,
  assertConfigMatchesProfile,
  defaultOciCertificateIdentityResolver,
  indexLayersByMediaType,
  verifyOciSignature,
} from "./oci-verify.mjs";

export {
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
  defaultOciCertificateIdentityResolver,
  toAnchoredIdentityPattern,
} from "./oci-verify.mjs";
export {
  OciRegistryError,
  DEFAULT_OCI_REGISTRY,
  parseConnectorOciReference,
} from "./oci-registry.mjs";

export { fetchCatalog } from "./oci-catalog.mjs";

// Where an OCI install writes the verified SourceDeclaration, relative
// to the connector's collection-profile directory.
export const SOURCE_DECLARATION_PATH = "source-declaration.json";

// The one artifact kind this installer accepts: a signed OCI Collection
// Profile. A lock entry must name it; there is no default.
const PDPP_COLLECTION_PROFILE = "pdpp-collection-profile";

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function validateRelativeArtifactPath(relativePath, label = "Artifact path") {
  if (
    typeof relativePath !== "string" ||
    relativePath === "" ||
    relativePath === "." ||
    relativePath.startsWith("/") ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error(`Invalid ${label.toLowerCase()} "${relativePath}"`);
  }
  return relativePath;
}

export function toPortableArtifactPath(relativePath, pathSeparator = sep) {
  return relativePath.split(pathSeparator).join("/");
}

function validateArchiveMemberPath(memberPath) {
  const trimmedPath = memberPath.replace(/^\.\//, "").replace(/\/$/, "");
  if (trimmedPath === "") {
    return;
  }
  validateRelativeArtifactPath(trimmedPath, "archive member path");
}

function lockEntries(lock) {
  if (!lock || typeof lock !== "object" || Array.isArray(lock) ||
      !Object.hasOwn(lock, "connectors") || !Array.isArray(lock.connectors)) {
    throw new Error("Invalid lock: connectors must be an explicit array");
  }
  return lock.connectors;
}

function isPortableDestinationSegment(segment) {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) &&
    !segment.endsWith(".") &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment);
}

function validateConnectorId(connectorId) {
  if (typeof connectorId !== "string" || !isPortableDestinationSegment(connectorId)) {
    throw new Error(`Invalid connector id "${connectorId}"`);
  }
  return connectorId;
}

function validateDestinationPath(path, label = "install destination path") {
  if (typeof path !== "string" || !path.split("/").every(isPortableDestinationSegment)) {
    throw new Error(`Invalid ${label.toLowerCase()} "${path}"`);
  }
  return path;
}

/**
 * Read one lock entry into the shape the OCI pipeline consumes, or refuse it.
 *
 * Every entry must carry an `oci` block and name the Collection Profile
 * artifact kind. An entry without either is refused here, before any network
 * call, rather than routed to another transport.
 *
 * `connectorKey` is carried separately from `connectorId` because they are
 * genuinely different strings — `chatgpt-pdpp` is installed at
 * `collection-profiles/chatgpt-pdpp/`, but its artifact lives at
 * `.../connector/chatgpt`. The repository path is a function of the key and the
 * install path is a function of the id, so a consumer that conflates them
 * either fetches the wrong repository or moves every install root.
 *
 * The three paths are install DESTINATIONS under that root, so they are held
 * to the portable canonical destination rule before any registry request.
 */
function normalizeLockEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid lock connector entry");
  }
  const connectorId = validateConnectorId(entry.connectorId);
  const oci = entry?.oci;
  if (!oci || typeof oci !== "object") {
    throw new Error(
      `Connector ${connectorId} has no oci block; only signed OCI Collection Profiles can be installed`
    );
  }
  if (entry.artifactKind !== PDPP_COLLECTION_PROFILE) {
    throw new Error(`Unsupported artifact kind "${entry.artifactKind}"`);
  }
  return {
    connectorId,
    connectorKey: entry.connectorKey ?? null,
    version: entry.version,
    artifactKind: entry.artifactKind,
    manifestPath: validateDestinationPath(entry.manifestPath, "PDPP manifest path"),
    entrypointPath: validateDestinationPath(entry.entrypointPath, "PDPP entrypoint path"),
    provenancePath: validateDestinationPath(entry.provenancePath, "PDPP provenance path"),
    oci: {
      registry: oci.registry ?? DEFAULT_OCI_REGISTRY_NAME,
      repository: oci.repository ?? null,
      digest: oci.digest ?? null,
    },
  };
}

// Callers keep the `source` slot (`fetchResolvedArtifact(null, entry)`,
// `installFromLock({ source: null })`), so a non-null value is a caller that
// still expects an index to be read. Refuse it instead of ignoring it.
function assertNoIndexSource(source) {
  if (source !== null && source !== undefined) {
    throw new Error("Connector index sources are not supported; pass source: null");
  }
}

/**
 * Read one `.tar.gz` layer, refusing unsafe members and oversized content.
 *
 * Member type and path are checked from the archive's own headers, so a
 * symlink, hardlink or FIFO is refused as it is read rather than after a tree
 * exists (C4.5). Nothing is written to a temp directory at all, so a refusal
 * has nothing to clean up (C6.1).
 *
 * `MAX_BLOB_BYTES` limits compressed input. The tar reader separately limits
 * regular-file bytes, decompressed input consumed, and entry count. It checks
 * effective member sizes before collecting bodies and stops at the archive
 * terminator. These are byte/count limits, not a measured peak-memory bound.
 * The returned regular-file buffers are measured again here.
 */
export const MAX_LAYER_UNPACKED_BYTES = 64 * 1024 * 1024;

async function readLayerArchive(
  buffer,
  label,
  { maxUnpackedBytes = MAX_LAYER_UNPACKED_BYTES } = {}
) {
  try {
    const entries = await readTarGzEntries(buffer, {
      maxUnpackedBytes,
      validateMemberPath: validateArchiveMemberPath,
    });

    let unpacked = 0;
    for (const entry of entries) {
      unpacked += entry.buffer.length;
      if (unpacked > maxUnpackedBytes) {
        throw new Error(
          `archive unpacked to more than the ${maxUnpackedBytes}-byte ceiling`
        );
      }
    }

    return entries.map((entry) => ({
      path: toPortableArtifactPath(entry.path.replace(/^\.\//, ""), "/"),
      buffer: entry.buffer,
    }));
  } catch (error) {
    throw new OciRegistryError(
      `Refusing ${label}: ${error instanceof Error ? error.message : String(error)}`,
      "unsafe-archive"
    );
  }
}

/**
 * Resolve, verify and unpack one OCI connector artifact.
 *
 * The ORDER here is the contract, and it is the reason this is one function
 * rather than a pipeline a caller assembles: nothing is written, and no layer
 * is even fetched, until the manifest has been proven to be what the lock
 * pinned AND signed by the pinned identity. Every step refuses rather than
 * degrades (C6.1), and because the only writes happen after all of them, a
 * failure at any point leaves the install tree untouched.
 *
 *   1. coordinates are validated, and a non-GHCR registry is refused    (C1.1, C1.3)
 *   2. a version is resolved to a digest ONLY when the lock has none    (C2.1, C2.3)
 *   3. the manifest is fetched by digest and self-verified             (C2.1)
 *   4. the cosign signature is verified against the pinned identity    (C3)
 *   5. layers are selected by media type, unknown types refuse         (C4.2, C4.3)
 *   6. every blob is verified against its descriptor digest            (C4.1)
 *   7. config and profile are cross-checked                            (C4.4)
 */
async function fetchOciDescriptorBlob(transport, descriptor, label) {
  if (!Number.isSafeInteger(descriptor?.size) || descriptor.size < 0) {
    throw new OciRegistryError(`Refusing ${transport.repository}: ${label} has an invalid size`, "tampered");
  }
  // OCI permits a small blob to travel inline in its descriptor. ORAS uses
  // this for the empty config in some attached artifact manifests.
  let bytes;
  if (typeof descriptor.data === "string") {
    bytes = Buffer.from(descriptor.data, "base64");
    if (bytes.toString("base64") !== descriptor.data || sha256Digest(bytes) !== descriptor.digest) {
      throw new OciRegistryError(`Refusing ${transport.repository}: ${label} has invalid inline data`, "tampered");
    }
  } else {
    bytes = await fetchBlob({ ...transport, digest: descriptor.digest });
  }
  if (bytes.length !== descriptor.size) {
    throw new OciRegistryError(
      `Refusing ${transport.repository}: ${label} claims ${descriptor.size} bytes but returned ${bytes.length}`,
      "tampered"
    );
  }
  return bytes;
}

async function fetchDeclarationReferrerBytes({ transport, imageDigest, imageManifest, imageManifestBytes, options }) {
  const artifactType = OCI_LAYER_MEDIA_TYPES.sourceDeclaration;
  const candidates = await discoverSourceDeclarationReferrers({
    ...transport,
    digest: imageDigest,
    artifactType,
  });
  let acceptedBytes = null;

  for (const candidate of candidates) {
    const { manifest, bytes: manifestBytes } = await fetchManifestByDigest({
      ...transport,
      digest: candidate.digest,
    });
    if (manifestBytes.length !== candidate.size ||
        manifest?.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
        manifest?.artifactType !== artifactType ||
        manifest?.subject?.digest !== imageDigest ||
        manifest?.subject?.mediaType !== imageManifest.mediaType ||
        manifest?.subject?.size !== imageManifestBytes.length) {
      throw new OciRegistryError(
        `Refusing ${transport.repository}: declaration referrer ${candidate.digest} does not bind to connector ${imageDigest}`,
        "misidentified"
      );
    }

    const config = manifest.config;
    const layer = Array.isArray(manifest.layers) && manifest.layers.length === 1
      ? manifest.layers[0]
      : null;
    if (config?.mediaType !== "application/vnd.oci.empty.v1+json" ||
        layer?.mediaType !== artifactType ||
        !Number.isSafeInteger(config?.size) || config.size < 1 ||
        !Number.isSafeInteger(layer?.size) || layer.size < 1) {
      throw new OciRegistryError(
        `Refusing ${transport.repository}: declaration referrer ${candidate.digest} has invalid config or layer descriptors`,
        "tampered"
      );
    }

    // The declaration's own manifest needs its own trusted signature. A
    // signature on the connector image does not authenticate a later referrer.
    await verifyOciSignature({
      ...transport,
      digest: candidate.digest,
      certificateIdentityResolver:
        options.ociCertificateIdentityResolver ?? defaultOciCertificateIdentityResolver,
      sigstoreVerifier: options.sigstoreVerifier,
    });
    const configBytes = await fetchOciDescriptorBlob(transport, config, "declaration config");
    const declarationBytes = await fetchOciDescriptorBlob(transport, layer, "declaration layer");
    if (configBytes.toString("utf8") !== "{}") {
      throw new OciRegistryError(
        `Refusing ${transport.repository}: declaration referrer ${candidate.digest} descriptor size or config disagrees with its blob`,
        "tampered"
      );
    }
    if (acceptedBytes && !acceptedBytes.equals(declarationBytes)) {
      throw new OciRegistryError(
        `Refusing ${transport.repository}: multiple declaration referrers disagree`,
        "tampered"
      );
    }
    acceptedBytes = declarationBytes;
  }
  return acceptedBytes;
}

async function fetchOciArtifact(entry, options = {}) {
  const connectorKey = entry.connectorKey;
  // Checked before any network call: a key that could never have been
  // published is a lock defect, not a registry question (C1.1).
  if (!isValidConnectorKey(connectorKey)) {
    throw new OciRegistryError(
      `Connector ${entry.connectorId} has an invalid connectorKey "${connectorKey}"`,
      "invalid-reference"
    );
  }

  const reference = parseOciReference({
    registry: entry.oci.registry,
    repository: entry.oci.repository,
    digest: entry.oci.digest,
    version: entry.version,
    ...(options.allowedOciRegistries ? { allowedRegistries: options.allowedOciRegistries } : {}),
  });
  const transport = {
    registry: reference.registry,
    repository: reference.repository,
    scheme: options.ociScheme ?? "https",
    timeoutMs: options.ociTimeoutMs,
    fetchImpl: options.fetchImpl,
    retryOptions: options.retryOptions,
  };

  // A pinned digest is used as-is, and an unpinned entry is REFUSED rather
  // than resolved — unless the caller is the first-pin entrypoint and says so.
  //
  // Resolving a tag at install time is the defect C1.2 and C2.3 name: a tag is
  // a mutable name, so an entry carrying only a version installs whatever that
  // name points at today, and the lock records nothing that would detect the
  // change. This was previously only a comment; `fetchOciArtifact` serves both
  // the lock-driven path and the CLI's first pin, so the comment described an
  // intent the code did not enforce and every digest-less lock entry silently
  // re-resolved. `allowTagResolution` is set by the first-pin path alone, which
  // is the one operation whose whole purpose is to turn a tag into a digest.
  if (!reference.digest && !options.allowTagResolution) {
    throw new OciRegistryError(
      `OCI entry for ${entry.connectorId} carries no digest; ` +
        `a lock entry must be pinned by digest and is never resolved from its version at install time`,
      "invalid-reference"
    );
  }
  const digest = reference.digest ?? (await resolveVersionToDigest({ ...transport, version: entry.version }));

  const { manifest, bytes: manifestBytes } = await fetchManifestByDigest({ ...transport, digest });

  // Before any layer is written — or fetched (C3.1).
  const trust = await verifyOciSignature({
    ...transport,
    digest,
    certificateIdentityResolver:
      options.ociCertificateIdentityResolver ?? defaultOciCertificateIdentityResolver,
    sigstoreVerifier: options.sigstoreVerifier,
  });

  const layers = indexLayersByMediaType(manifest, { repository: reference.repository });

  if (manifest?.config?.mediaType !== OCI_CONFIG_MEDIA_TYPE) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: unexpected config media type "${manifest?.config?.mediaType}"`,
      "unsupported-layer"
    );
  }

  // Every one of these is digest-verified inside `fetchBlob` against the
  // descriptor that named it (C4.1).
  const configBytes = await fetchOciDescriptorBlob(transport, manifest.config, "connector config");
  const profileBytes = await fetchOciDescriptorBlob(transport, layers.profile, "profile layer");
  const codeBytes = await fetchOciDescriptorBlob(transport, layers.code, "code layer");
  const layerDeclarationBytes = layers.sourceDeclaration
    ? await fetchOciDescriptorBlob(transport, layers.sourceDeclaration, "source declaration layer")
    : null;
  const referrerDeclarationBytes = await fetchDeclarationReferrerBytes({
    transport,
    imageDigest: digest,
    imageManifest: manifest,
    imageManifestBytes: manifestBytes,
    options,
  });
  if (layerDeclarationBytes && referrerDeclarationBytes &&
      !layerDeclarationBytes.equals(referrerDeclarationBytes)) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: declaration layer and referrer bytes disagree`,
      "tampered"
    );
  }
  const sourceDeclarationBytes = layerDeclarationBytes ?? referrerDeclarationBytes;
  if (!sourceDeclarationBytes) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: artifact has no signed source declaration layer or referrer`,
      "unsigned"
    );
  }
  const provenanceBytes = await fetchOciDescriptorBlob(transport, layers.provenance, "provenance layer");
  const licensesBytes = await fetchOciDescriptorBlob(transport, layers.licenses, "licenses layer");
  const assetsBytes = layers.assets
    ? await fetchOciDescriptorBlob(transport, layers.assets, "assets layer")
    : null;

  let config;
  let profile;
  let sourceDeclaration;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
    profile = JSON.parse(profileBytes.toString("utf8"));
    sourceDeclaration = JSON.parse(sourceDeclarationBytes.toString("utf8"));
  } catch (error) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: config, profile, or source declaration is not JSON (${error.message})`,
      "tampered"
    );
  }

  assertConfigMatchesProfile({
    config,
    profileBytes,
    profile,
    sourceDeclarationBytes,
    sourceDeclaration,
    repository: reference.repository,
  });

  // The key the lock used to build the repository path must be the key the
  // artifact declares, or the lock fetched from a repository that does not
  // belong to the connector it is installing.
  if (config.connector_key !== connectorKey) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: artifact declares connector_key ` +
        `"${config.connector_key}" but the lock names "${connectorKey}"`,
      "misidentified"
    );
  }

  // C4.7: the version installed is the version the lock claims.
  if (entry.version && profile.version !== entry.version) {
    throw new OciRegistryError(
      `${entry.connectorId} version mismatch: lock says ${entry.version} ` +
        `but the artifact profile declares ${profile.version}`,
      "tampered"
    );
  }

  const codeFiles = await readLayerArchive(codeBytes, `${reference.repository} code layer`);
  const entrypointInArtifact = config.entrypoint;
  let entrypointSegments;
  try {
    const validPath = validateRelativeArtifactPath(entrypointInArtifact, "config.entrypoint");
    entrypointSegments = validPath.split("/");
    if (entrypointSegments.some((segment) => segment === "" || segment === ".")) {
      throw new Error(`Invalid config.entrypoint "${entrypointInArtifact}"`);
    }
  } catch (error) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: ${error.message}`,
      "tampered"
    );
  }
  const [entrypointLayer, ...memberSegments] = entrypointSegments;
  if (entrypointLayer !== "code" || memberSegments.length === 0) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: config.entrypoint "${entrypointInArtifact}" ` +
        `must name a member of the code layer`,
      "tampered"
    );
  }
  const codeEntrypointMember = memberSegments.join("/");
  const entrypointFile = codeFiles.find((file) => file.path === codeEntrypointMember);
  // C4.6: the entrypoint the config declares must actually be in the code layer.
  if (!entrypointFile) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: config.entrypoint "${entrypointInArtifact}" ` +
        `is not present in the code layer`,
      "tampered"
    );
  }

  const licenseFiles = await readLayerArchive(
    licensesBytes,
    `${reference.repository} licenses layer`
  );
  const assetFiles = assetsBytes
    ? await readLayerArchive(assetsBytes, `${reference.repository} assets layer`)
    : [];

  // Translated into the layout the installed tree already has (C5.1): the
  // artifact stores its entrypoint at `code/collection-profile.mjs`, the
  // installed tree expects it at the lock's `entrypointPath`. Licences and
  // assets get their own subtrees, and licences are written rather than
  // dropped because distribution requires shipping them (C5.4).
  return {
    manifest: profile,
    manifestBuffer: profileBytes,
    entrypointBuffer: entrypointFile.buffer,
    entrypointPath: entry.entrypointPath,
    provenanceBuffer: provenanceBytes,
    provenancePath: entry.provenancePath,
    // Retained next to the profile so the host can read back the exact
    // declaration bytes the signed manifest pins.
    sourceDeclarationBuffer: sourceDeclarationBytes,
    sourceDeclarationPath: SOURCE_DECLARATION_PATH,
    artifactKind: entry.artifactKind,
    assetFiles: [
      ...licenseFiles.map((file) => ({ path: `licenses/${file.path}`, buffer: file.buffer })),
      ...assetFiles.map((file) => ({ path: `assets/${file.path}`, buffer: file.buffer })),
    ],
    oci: {
      registry: reference.registry,
      repository: reference.repository,
      digest,
      configDigest: manifest.config.digest,
      certificateIdentityURI: trust.certificateIdentityURI,
    },
    checksums: {
      artifact: digest,
      manifest: sha256Digest(profileBytes),
      entrypoint: sha256Digest(entrypointFile.buffer),
      provenance: sha256Digest(provenanceBytes),
      sourceDeclaration: sha256Digest(sourceDeclarationBytes),
    },
  };
}

function buildPdppCollectionProfileWrites(resolved) {
  const artifactRoot = `collection-profiles/${resolved.connectorId}`;
  const writes = [
    {
      relativePath: `${artifactRoot}/${resolved.entry.manifestPath}`,
      buffer: resolved.manifestBuffer,
    },
    {
      relativePath: `${artifactRoot}/${resolved.entry.entrypointPath}`,
      buffer: resolved.entrypointBuffer,
    },
    {
      relativePath: `${artifactRoot}/${resolved.entry.provenancePath}`,
      buffer: resolved.provenanceBuffer,
    },
    {
      relativePath: `${artifactRoot}/${resolved.sourceDeclarationPath}`,
      buffer: resolved.sourceDeclarationBuffer,
    },
    // Licences and brand assets, which the publisher ships unconditionally
    // because distributing the code requires distributing them (C5.4), so they
    // are written rather than dropped on the floor.
    ...resolved.assetFiles.map((file) => ({
      relativePath: `${artifactRoot}/${validateRelativeArtifactPath(file.path, "artifact asset path")}`,
      buffer: file.buffer,
    })),
  ];

  return writes;
}

// A Collection Profile installs into the same `collection-profiles/<id>/`
// subtree under either layout name, so both are accepted and mean the same.
function buildInstallWrites(layout, resolved) {
  if (layout === "snapshot" || layout === "source") {
    return buildPdppCollectionProfileWrites(resolved);
  }
  throw new Error(`Unsupported install layout "${layout}"`);
}

async function fetchLockArtifacts({ lock, source, ...options }) {
  assertNoIndexSource(source);
  const normalizedEntries = lockEntries(lock).map(normalizeLockEntry);
  const resolved = [];

  for (const entry of normalizedEntries) {
    const artifact = await fetchOciArtifact(entry, options);
    resolved.push({
      connectorId: entry.connectorId,
      version: entry.version,
      entry,
      ...artifact,
    });
  }

  return resolved;
}

function expectedWritesForLock({ installRoot, layout, resolved }) {
  return destinationPlan(installRoot, resolved.flatMap((entry) => buildInstallWrites(layout, entry)));
}

// Every OCI destination meets here. Identity is portable and case-folded
// for collisions, but the original canonical spelling is used for every effect.
function destinationPlan(installRoot, writes) {
  const root = resolvePath(installRoot);
  const identities = new Set();
  const directorySpellings = new Map();
  const plan = writes.map(({ relativePath, ...write }) => {
    validateDestinationPath(relativePath);
    const absolutePath = resolvePath(root, relativePath);
    if (!absolutePath.startsWith(`${root}${sep}`)) {
      throw new Error(`Install destination escapes root: ${relativePath}`);
    }
    const segments = relativePath.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      const directory = segments.slice(0, i).join("/");
      const identity = directory.toLowerCase();
      const previous = directorySpellings.get(identity);
      if (previous !== undefined && previous !== directory) {
        throw new Error(`Install destination case collision: ${directory}`);
      }
      directorySpellings.set(identity, directory);
    }
    const identity = relativePath.toLowerCase();
    if (identities.has(identity)) throw new Error(`Duplicate install destination: ${relativePath}`);
    identities.add(identity);
    return { ...write, relativePath, absolutePath };
  });
  for (const write of plan) {
    const segments = write.relativePath.toLowerCase().split("/");
    for (let i = 1; i < segments.length; i += 1) {
      if (identities.has(segments.slice(0, i).join("/"))) {
        throw new Error(`Install destination conflict: ${write.relativePath}`);
      }
    }
  }
  assertDestinationTree(root);
  for (const write of plan) assertDestinationTree(write.absolutePath, root);
  return plan;
}

function assertDestinationTree(path, root = path) {
  const paths = [root];
  let current = root;
  for (const segment of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    paths.push(current);
  }
  for (const candidate of paths) {
    if (candidate !== root) {
      let names = [];
      try { names = readdirSync(dirname(candidate)); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const name = basename(candidate);
      if (names.some((actual) => actual !== name && actual.toLowerCase() === name.toLowerCase())) {
        throw new Error(`Noncanonical install destination case alias: ${candidate}`);
      }
    }
    let stat;
    try { stat = lstatSync(candidate); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symbolic link destination: ${candidate}`);
    if (candidate !== path || candidate === root) {
      if (!stat.isDirectory()) throw new Error(`Install destination parent is not a directory: ${candidate}`);
    } else if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(`Install destination is not a single regular file: ${candidate}`);
    }
  }
}

function openDestination(installRoot, write, flags) {
  const root = resolvePath(installRoot);
  assertDestinationTree(write.absolutePath, root);
  // O_NOFOLLOW also covers replacement of the leaf after the tree preflight.
  const fd = openSync(write.absolutePath, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {
    closeSync(fd);
    throw new Error(`Install destination is not a single regular file: ${write.relativePath}`);
  }
  return fd;
}

function removeUnexpectedEntries(installRoot, expectedPaths, preserveTopLevel = []) {
  const expected = new Set(expectedPaths);
  const preserve = new Set(preserveTopLevel);

  function pruneDirectory(dir, relativeDir = "") {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) {
        continue;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry}` : entry;
      const topLevel = relativePath.split("/")[0];
      if (preserve.has(topLevel)) {
        continue;
      }

      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        pruneDirectory(path, relativePath);
        if (readdirSync(path).length === 0) {
          rmSync(path, { recursive: true, force: true });
        }
        continue;
      }
      if (!expected.has(relativePath)) {
        rmSync(path, { force: true });
      }
    }
  }

  if (existsSync(installRoot)) {
    pruneDirectory(installRoot);
  }
}

/**
 * Fetch and verify one signed OCI Collection Profile without installing it.
 *
 * The first argument must be null: it is the slot existing callers already
 * pass, kept so their `(null, entry, options)` call shape still resolves.
 */
export async function fetchResolvedArtifact(source, entry, options = {}) {
  assertNoIndexSource(source);
  return fetchOciArtifact(normalizeLockEntry(entry), options);
}

export function pruneInstalled({
  installRoot,
  expectedPaths,
  preserveTopLevel = [],
}) {
  destinationPlan(installRoot, expectedPaths.map((relativePath) => ({ relativePath })));
  removeUnexpectedEntries(installRoot, expectedPaths, preserveTopLevel);
  return {
    installRoot,
    expectedCount: expectedPaths.length,
  };
}

export async function installFromLock({
  lock,
  source,
  installRoot,
  layout,
  prune = false,
  preserveTopLevel = [],
  ...options
}) {
  const resolved = await fetchLockArtifacts({ lock, source, ...options });
  const writes = expectedWritesForLock({ installRoot, layout, resolved });
  const expectedPaths = writes.map((write) => write.relativePath);

  for (const write of writes) {
    assertDestinationTree(write.absolutePath, resolvePath(installRoot));
    mkdirSync(dirname(write.absolutePath), { recursive: true });
    const fd = openDestination(installRoot, write, constants.O_WRONLY | constants.O_CREAT);
    try {
      // Opening without O_TRUNC lets us check regular-file identity first.
      writeFileSync(fd, write.buffer);
      ftruncateSync(fd, write.buffer.length);
    } finally { closeSync(fd); }
  }

  if (prune) {
    pruneInstalled({
      installRoot,
      expectedPaths,
      preserveTopLevel,
    });
  }

  return {
    installRoot,
    layout,
    connectorCount: resolved.length,
    filesWritten: writes.length,
    expectedPaths,
    // What was actually installed, by digest. A first pin resolves a tag, and
    // the digest it resolved to is the thing the caller needs in order to write
    // a lock entry that will not re-resolve (C1.2); printing it is how a
    // one-off `--oci ref:version` pull becomes a pinned one.
    pinned: resolved.map((artifact) => ({
      connectorId: artifact.connectorId,
      version: artifact.version,
      registry: artifact.oci.registry,
      repository: artifact.oci.repository,
      digest: artifact.oci.digest,
      sourceDeclarationPath: `collection-profiles/${artifact.connectorId}/${artifact.sourceDeclarationPath}`,
      sourceDeclarationSha256: artifact.checksums.sourceDeclaration,
    })),
  };
}

export async function verifyInstalled({
  lock,
  source,
  installRoot,
  layout,
  ...options
}) {
  const resolved = await fetchLockArtifacts({ lock, source, ...options });
  const writes = expectedWritesForLock({ installRoot, layout, resolved });
  const missing = [];
  const mismatched = [];

  for (const write of writes) {
    if (!existsSync(write.absolutePath)) {
      missing.push(write.relativePath);
      continue;
    }

    const fd = openDestination(installRoot, write, constants.O_RDONLY);
    let currentChecksum;
    try { currentChecksum = sha256Buffer(readFileSync(fd)); } finally { closeSync(fd); }
    const expectedChecksum = sha256Buffer(write.buffer);
    if (currentChecksum !== expectedChecksum) {
      mismatched.push(write.relativePath);
    }
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    installRoot,
    layout,
    expectedCount: writes.length,
    missing,
    mismatched,
    // The declaration digest each OCI artifact's signed config pins, taken
    // from the layer or referrer this call just re-fetched and checked against
    // that config, not from the installed file. A host passes this value through;
    // `installedMatches` says whether the file on disk still has those bytes.
    sourceDeclarations: resolved.map((artifact) => {
      const sourceDeclarationPath = `collection-profiles/${artifact.connectorId}/${artifact.sourceDeclarationPath}`;
      return {
        connectorId: artifact.connectorId,
        version: artifact.version,
        digest: artifact.oci.digest,
        sourceDeclarationPath,
        sourceDeclarationSha256: artifact.checksums.sourceDeclaration,
        installedMatches:
          !missing.includes(sourceDeclarationPath) &&
          !mismatched.includes(sourceDeclarationPath),
      };
    }),
  };
}

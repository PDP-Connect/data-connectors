// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  dirname,
  join,
  normalize,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { verify as verifySigstoreBundle } from "sigstore";

import { readTarGzEntries } from "./tar-stream.mjs";
import {
  DEFAULT_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  DEFAULT_RETRY_MAX_DELAY_MS,
  fetchWithRetry,
} from "./retry.mjs";

import {
  DEFAULT_OCI_REGISTRY as DEFAULT_OCI_REGISTRY_NAME,
  OciRegistryError,
  fetchBlob,
  fetchManifestByDigest,
  isValidConnectorKey,
  parseOciReference,
  resolveVersionToDigest,
  sha256Digest,
} from "./oci-registry.mjs";
import {
  OCI_CONFIG_MEDIA_TYPE,
  assertConfigMatchesProfile,
  defaultOciCertificateIdentityResolver,
  indexLayersByMediaType,
  toAnchoredIdentityPattern,
  verifyOciSignature,
} from "./oci-verify.mjs";

export {
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_IDENTITY,
  DEFAULT_OCI_SIGSTORE_CERTIFICATE_ISSUER,
  defaultOciCertificateIdentityResolver,
  // One definition, used by both paths: the tarball pin and the OCI pin have
  // the same unanchored-regex hazard and must not drift apart.
  toAnchoredIdentityPattern,
} from "./oci-verify.mjs";
export {
  OciRegistryError,
  DEFAULT_OCI_REGISTRY,
  parseConnectorOciReference,
} from "./oci-registry.mjs";

export { fetchCatalog } from "./oci-catalog.mjs";

export const DEFAULT_CONNECTOR_INDEX_URL =
  "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-latest/connector-index.json";
export const DEFAULT_SIGSTORE_CERTIFICATE_ISSUER =
  "https://token.actions.githubusercontent.com";
export const DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY =
  "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-connector-release-index.yml@refs/heads/main";

export function defaultArtifactCertificateIdentityResolver() {
  return DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY;
}

export function defaultIndexCertificateIdentityResolver() {
  return DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) {
    throw new Error(`Unsupported version format "${version}"`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareVersions(a, b) {
  const av = typeof a === "string" ? parseVersion(a) : a;
  const bv = typeof b === "string" ? parseVersion(b) : b;
  if (av.major !== bv.major) return av.major - bv.major;
  if (av.minor !== bv.minor) return av.minor - bv.minor;
  return av.patch - bv.patch;
}

function evaluateComparator(version, comparator) {
  if (comparator === "*" || comparator === "") {
    return true;
  }

  const match = /^(>=|<=|>|<|=|\^|~)?\s*(\d+\.\d+\.\d+)$/.exec(comparator);
  if (!match) {
    throw new Error(`Unsupported comparator "${comparator}"`);
  }

  const operator = match[1] ?? "=";
  const target = parseVersion(match[2]);
  const cmp = compareVersions(version, target);

  switch (operator) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
    case "^":
      return (
        cmp >= 0 &&
        compareVersions(version, {
          major: target.major + 1,
          minor: 0,
          patch: 0,
        }) < 0
      );
    case "~":
      return (
        cmp >= 0 &&
        compareVersions(version, {
          major: target.major,
          minor: target.minor + 1,
          patch: 0,
        }) < 0
      );
    default:
      return false;
  }
}

export function satisfies(versionString, range) {
  const version = parseVersion(versionString);
  const normalized = range.trim();
  if (normalized === "" || normalized === "*") {
    return true;
  }
  return normalized
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => evaluateComparator(version, token));
}

export function selectResolvedEntry(entries, constraint, connectorId) {
  const matches = entries.filter((entry) => satisfies(entry.version, constraint));
  if (matches.length === 0) {
    const available = entries.map((entry) => entry.version).join(", ");
    throw new Error(
      `No published version for ${connectorId} satisfies "${constraint}". Available: ${available || "(none)"}`
    );
  }
  return matches.sort((a, b) => compareVersions(b.version, a.version))[0];
}

export function extractAvailableVersions(indexDoc, connectorId) {
  if (!indexDoc.connectors || typeof indexDoc.connectors !== "object") {
    throw new Error("Unsupported connector index shape");
  }
  const entries = indexDoc.connectors[connectorId];
  return Array.isArray(entries) ? entries : [];
}

function findMatchingIndexEntry(indexSource, entry) {
  const entries = extractAvailableVersions(indexSource?.doc ?? {}, entry.connectorId);
  return entries.find((candidate) => candidate.version === entry.version) ?? null;
}

function enrichRemoteEntry(indexSource, entry) {
  if (indexSource?.mode !== "remote") {
    return entry;
  }

  const matched = findMatchingIndexEntry(indexSource, entry);
  if (!matched) {
    return entry;
  }

  return {
    ...entry,
    artifactUrl: matched.artifactUrl ?? entry.artifactUrl,
    artifactSignature:
      normalizeSignature(entry.artifactSignature) ??
      normalizeSignature(matched.artifactSignature ?? null),
  };
}

export const ARTIFACT_FETCH_ATTEMPTS = DEFAULT_RETRY_ATTEMPTS;
export const ARTIFACT_FETCH_BASE_DELAY_MS = DEFAULT_RETRY_BASE_DELAY_MS;
export const ARTIFACT_FETCH_MAX_DELAY_MS = DEFAULT_RETRY_MAX_DELAY_MS;

/**
 * Downloads a release asset, retrying transient failures.
 *
 * GitHub's release-asset CDN intermittently answers a valid, immutable URL with
 * a 5xx that succeeds seconds later. A single attempt turns that blip into a
 * failed `npm ci` for every consumer, so 5xx responses and network errors are
 * retried with exponential backoff.
 *
 * Retries cover only failures a later attempt can plausibly fix. A 4xx is a
 * statement about the request itself — a wrong or withdrawn URL — and repeating
 * it just delays the same error, so it fails immediately. Digest and signature
 * mismatches are likewise never retried: they are verification failures raised
 * by the caller, and bytes that fail a hash check are not made trustworthy by
 * downloading them again.
 */
export async function fetchBinary(
  url,
  {
    fetchImpl = fetch,
    attempts = ARTIFACT_FETCH_ATTEMPTS,
    baseDelayMs = ARTIFACT_FETCH_BASE_DELAY_MS,
    maxDelayMs = ARTIFACT_FETCH_MAX_DELAY_MS,
    jitter = true,
    random = Math.random,
    sleep,
    now,
    onRetry,
  } = {}
) {
  const response = await fetchWithRetry(url, {
    fetchImpl,
    attempts,
    baseDelayMs,
    maxDelayMs,
    jitter,
    random,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
    ...(onRetry ? { onRetry } : {}),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function normalizeSignature(signature) {
  if (!signature || typeof signature !== "object") {
    return null;
  }

  return {
    type: signature.type ?? null,
    bundlePath: signature.bundlePath ?? signature.bundle_path ?? null,
    bundleUrl: signature.bundleUrl ?? signature.bundle_url ?? null,
  };
}

function resolveBundleUrl(subjectUrl, signature) {
  if (signature?.bundleUrl) {
    return signature.bundleUrl;
  }
  if (signature?.bundlePath) {
    return new URL(signature.bundlePath, subjectUrl).toString();
  }
  return `${subjectUrl}.sigstore.json`;
}

async function verifyRemoteSignature({
  payloadBuffer,
  subjectLabel,
  subjectUrl,
  signature,
  allowUnsignedRemote = false,
  certificateIdentityURI = DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY,
  sigstoreVerifier = verifySigstoreBundle,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  const normalizedSignature = normalizeSignature(signature);
  if (!normalizedSignature) {
    if (allowUnsignedRemote) {
      return false;
    }
    throw new Error(`${subjectLabel} is missing Sigstore bundle metadata`);
  }
  if (
    normalizedSignature.type &&
    normalizedSignature.type !== "sigstoreBundle"
  ) {
    throw new Error(
      `${subjectLabel} uses unsupported signature type "${normalizedSignature.type}"`
    );
  }

  const bundleUrl = resolveBundleUrl(subjectUrl, normalizedSignature);
  const bundleBuffer = await fetchBinary(bundleUrl, {
    fetchImpl,
    ...retryOptions,
  });
  const bundle = JSON.parse(bundleBuffer.toString("utf8"));

  try {
    await sigstoreVerifier(bundle, payloadBuffer, {
      certificateIssuer: DEFAULT_SIGSTORE_CERTIFICATE_ISSUER,
      certificateIdentityURI: toAnchoredIdentityPattern(certificateIdentityURI),
    });
  } catch (error) {
    throw new Error(
      `${subjectLabel} signature verification failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  return true;
}

async function resolveArtifactCertificateIdentity({
  artifactCertificateIdentityResolver = defaultArtifactCertificateIdentityResolver,
  artifactUrl,
  entry,
}) {
  const certificateIdentityURI = await artifactCertificateIdentityResolver({
    artifactUrl,
    entry,
  });
  if (typeof certificateIdentityURI !== "string" || certificateIdentityURI.length === 0) {
    throw new Error(
      `No trusted Sigstore certificate identity configured for connector artifact ${entry.connectorId}@${entry.version}`
    );
  }
  return certificateIdentityURI;
}

async function resolveIndexCertificateIdentity({
  indexCertificateIdentityResolver = defaultIndexCertificateIdentityResolver,
  indexUrl,
}) {
  const certificateIdentityURI = await indexCertificateIdentityResolver({
    indexUrl,
  });
  if (
    typeof certificateIdentityURI !== "string" ||
    certificateIdentityURI.length === 0
  ) {
    throw new Error(
      `No trusted Sigstore certificate identity configured for connector index ${indexUrl}`
    );
  }
  return certificateIdentityURI;
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

function ensureInside(baseDir, relativePath) {
  const validPath = validateRelativeArtifactPath(relativePath);
  return join(baseDir, normalize(validPath));
}

export function toPortableArtifactPath(relativePath, pathSeparator = sep) {
  return relativePath.split(pathSeparator).join("/");
}

function walkArtifactFiles(dir, root = dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const relativePath = toPortableArtifactPath(relative(root, full));
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      throw new Error(`Artifact contains unsupported link "${relativePath}"`);
    }
    if (st.isDirectory()) {
      out.push(...walkArtifactFiles(full, root));
      continue;
    }
    if (!st.isFile()) {
      throw new Error(`Artifact contains unsupported entry "${relativePath}"`);
    }
    out.push({
      path: full,
      relativePath,
    });
  }
  return out;
}

function validateArchiveMemberPath(memberPath) {
  const trimmedPath = memberPath.replace(/^\.\//, "").replace(/\/$/, "");
  if (trimmedPath === "") {
    return;
  }
  validateRelativeArtifactPath(trimmedPath, "archive member path");
}

function assertSafeArchive(tarPath) {
  const members = execFileSync("tar", ["-tzf", tarPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const memberPath of members) {
    validateArchiveMemberPath(memberPath);
  }

  const verboseMembers = execFileSync("tar", ["-tvzf", tarPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  for (const member of verboseMembers) {
    const type = member[0];
    if (type !== "-" && type !== "d") {
      throw new Error(`Artifact contains unsupported archive entry type "${type}"`);
    }
  }
}

function artifactContract(entry) {
  const artifactKind = entry.artifactKind ?? "legacy";

  if (artifactKind === "legacy") {
    return {
      manifestPath: "manifest.json",
      entrypointPath: "script.js",
      entrypointChecksum: entry.scriptSha256,
      entrypointLabel: "script",
      provenancePath: null,
      provenanceChecksum: null,
    };
  }

  if (artifactKind === "pdpp-collection-profile") {
    const manifestPath = validateRelativeArtifactPath(
      entry.manifestPath,
      "PDPP manifest path"
    );
    const entrypointPath = validateRelativeArtifactPath(
      entry.entrypointPath,
      "PDPP entrypoint path"
    );
    const provenancePath = validateRelativeArtifactPath(
      entry.provenancePath,
      "PDPP provenance path"
    );
    for (const [label, checksum] of Object.entries({
      artifact: entry.artifactSha256,
      manifest: entry.manifestSha256,
      entrypoint: entry.entrypointSha256,
      provenance: entry.provenanceSha256,
    })) {
      if (typeof checksum !== "string" || !/^sha256:[0-9a-f]{64}$/.test(checksum)) {
        throw new Error(`${entry.connectorId} PDPP ${label} checksum is required`);
      }
    }
    return {
      manifestPath,
      entrypointPath,
      entrypointChecksum: entry.entrypointSha256,
      entrypointLabel: "entrypoint",
      provenancePath,
      provenanceChecksum: entry.provenanceSha256,
    };
  }

  throw new Error(`Unsupported artifact kind "${artifactKind}"`);
}

function unpackArtifactBuffer(entry, buffer) {
  const contract = artifactContract(entry);
  const tempRoot = mkdtempSync(join(tmpdir(), "connector-artifact-"));
  const tarPath = join(tempRoot, "artifact.tgz");
  const unpackDir = join(tempRoot, "bundle");

  try {
    mkdirSync(unpackDir, { recursive: true });
    writeFileSync(tarPath, buffer);
    assertSafeArchive(tarPath);
    execFileSync("tar", ["-xzf", tarPath, "-C", unpackDir]);

    const files = walkArtifactFiles(unpackDir);
    const manifestFile = files.find((file) => file.relativePath === contract.manifestPath);
    const entrypointFile = files.find((file) => file.relativePath === contract.entrypointPath);
    const provenanceFile = contract.provenancePath
      ? files.find((file) => file.relativePath === contract.provenancePath)
      : null;
    if (!manifestFile || !entrypointFile || (contract.provenancePath && !provenanceFile)) {
      throw new Error(
        `Artifact missing ${!manifestFile ? contract.manifestPath : !entrypointFile ? contract.entrypointPath : contract.provenancePath}`
      );
    }

    const schemaFiles = [];
    const assetFiles = [];
    let readme = null;

    for (const file of files) {
      if (
        file.relativePath === contract.manifestPath ||
        file.relativePath === contract.entrypointPath ||
        file.relativePath === contract.provenancePath
      ) {
        continue;
      }
      if (file.relativePath === "README.md") {
        readme = {
          path: file.relativePath,
          buffer: readFileSync(file.path),
        };
        continue;
      }
      if (file.relativePath.startsWith("schemas/")) {
        schemaFiles.push({
          path: file.relativePath,
          buffer: readFileSync(file.path),
        });
        continue;
      }
      assetFiles.push({
        path: file.relativePath,
        buffer: readFileSync(file.path),
      });
    }

    return {
      manifestBuffer: readFileSync(manifestFile.path),
      entrypointBuffer: readFileSync(entrypointFile.path),
      entrypointPath: contract.entrypointPath,
      entrypointChecksum: contract.entrypointChecksum,
      entrypointLabel: contract.entrypointLabel,
      provenanceBuffer: provenanceFile ? readFileSync(provenanceFile.path) : null,
      provenancePath: contract.provenancePath,
      provenanceChecksum: contract.provenanceChecksum,
      schemaFiles,
      assetFiles,
      readme,
    };
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function resolveIndexSourcePath(rootDir) {
  const candidates = [
    join(rootDir, "connector-index.json"),
    join(rootDir, "dist", "connector-index.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function loadConnectorIndex({
  fromLocal = null,
  indexUrl = null,
  defaultLocalSource = null,
  defaultIndexUrl = DEFAULT_CONNECTOR_INDEX_URL,
  preferDefaultLocal = false,
  allowUnsignedRemote = false,
  indexCertificateIdentityResolver = defaultIndexCertificateIdentityResolver,
  sigstoreVerifier = undefined,
  fetchImpl = fetch,
  retryOptions = {},
}) {
  const resolvedLocal = fromLocal
    ? resolvePath(fromLocal)
    : preferDefaultLocal && defaultLocalSource
      ? resolvePath(defaultLocalSource)
      : null;

  if (resolvedLocal && existsSync(resolvedLocal)) {
    const indexPath = resolveIndexSourcePath(resolvedLocal);
    if (!indexPath) {
      throw new Error(`No connector-index.json found under ${resolvedLocal}`);
    }
    return {
      mode: "local",
      rootDir: resolvedLocal,
      indexUrl: null,
      indexPath,
      doc: readJson(indexPath),
    };
  }

  const url = indexUrl ?? defaultIndexUrl;
  if (!url) {
    throw new Error("No connector index source configured");
  }

  const indexBuffer = await fetchBinary(url, { fetchImpl, ...retryOptions });
  const doc = JSON.parse(indexBuffer.toString("utf8"));
  const certificateIdentityURI = await resolveIndexCertificateIdentity({
    indexCertificateIdentityResolver,
    indexUrl: url,
  });
  const signatureVerified = await verifyRemoteSignature({
    payloadBuffer: indexBuffer,
    subjectLabel: "Connector index",
    subjectUrl: url,
    signature: doc.signature,
    allowUnsignedRemote,
    certificateIdentityURI,
    fetchImpl,
    retryOptions,
    ...(sigstoreVerifier ? { sigstoreVerifier } : {}),
  });

  return {
    mode: "remote",
    rootDir: null,
    indexUrl: url,
    indexPath: null,
    doc,
    signatureVerified,
  };
}

function resolveArtifactLocalPath(rootDir, artifactPath, connectorId) {
  if (!artifactPath) {
    throw new Error(`Local connector index entry for ${connectorId} is missing artifactPath`);
  }
  const resolvedPath = ensureInside(rootDir, artifactPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Local artifact not found: ${resolvedPath}`);
  }
  return resolvedPath;
}

function deriveSourceMeta(indexSource, connectors = []) {
  if (indexSource?.mode === "local" && indexSource.rootDir) {
    try {
      const sourceTag = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: indexSource.rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: indexSource.rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return { sourceTag, sourceCommit };
    } catch {
      return {
        sourceTag: resolvePath(indexSource.rootDir),
        sourceCommit: "unknown",
      };
    }
  }

  const sourceTags = [...new Set(connectors.map((entry) => entry.sourceTag).filter(Boolean))];
  const sourceCommits = [...new Set(connectors.map((entry) => entry.sourceCommit).filter(Boolean))];
  return {
    sourceTag: sourceTags.length === 1 ? sourceTags[0] : "mixed",
    sourceCommit: sourceCommits.length === 1 ? sourceCommits[0] : "mixed",
  };
}

/**
 * Read an `oci` block off a lock entry, or null when the entry is a tarball one.
 *
 * `connectorKey` is carried separately from `connectorId` because they are
 * genuinely different strings — `chatgpt-pdpp` is installed at
 * `collection-profiles/chatgpt-pdpp/`, but its artifact lives at
 * `.../connector/chatgpt`. The repository path is a function of the key and the
 * install path is a function of the id, so a consumer that conflates them
 * either fetches the wrong repository or moves every install root.
 */
function normalizeOciBlock(entry) {
  const oci = entry.oci ?? null;
  if (!oci || typeof oci !== "object") return null;
  return {
    registry: oci.registry ?? DEFAULT_OCI_REGISTRY_NAME,
    repository: oci.repository ?? null,
    digest: oci.digest ?? null,
    configDigest: oci.configDigest ?? oci.config_digest ?? null,
  };
}

/**
 * Which entries in a lock need the signed index, and which do not.
 *
 * The transport is a property of each ENTRY — `fetchEntryArtifact` dispatches on
 * `entry.oci` and never consults `source` for an OCI entry — so whether an index
 * is needed is a question about the lock, not about which flag the operator
 * typed. Deciding it from `--oci` made a lock of digest-pinned OCI entries
 * depend on the old index service anyway, and fail when it was down, while the
 * identical reference passed as `--oci` did not.
 *
 * Exported so the CLI asks this module rather than re-deriving it: a second
 * reading of "is this entry OCI" is a second thing to keep in step with the
 * dispatch, and the two going out of step is exactly the defect.
 *
 * The mixed case is real and stays supported: the twelve legacy `*-playwright`
 * connectors keep the tarball path until they are ported or retired, so a lock
 * naming both transports must load the index for the entries that need it.
 */
export function lockNeedsIndexSource(lock) {
  return (lock?.connectors ?? []).some((entry) => !normalizeOciBlock(entry));
}

function normalizeLockEntry(entry) {
  const artifactKind = entry.artifactKind ?? entry.artifact_kind ?? "legacy";
  return {
    connectorId: entry.connectorId ?? entry.id,
    connectorKey: entry.connectorKey ?? entry.connector_key ?? null,
    oci: normalizeOciBlock(entry),
    company: entry.company,
    version: entry.version,
    resolvedFrom: entry.resolvedFrom ?? entry.resolved_from ?? entry.version,
    sourceFiles: entry.sourceFiles ?? entry.source_files ?? entry.files,
    artifactUrl: entry.artifactUrl ?? entry.artifact_url ?? null,
    artifactPath: entry.artifactPath ?? entry.artifact_path ?? null,
    artifactSha256: entry.artifactSha256 ?? entry.artifact_sha256 ?? entry.checksums?.artifact,
    artifactSignature: normalizeSignature(
      entry.artifactSignature ?? entry.artifact_signature ?? null
    ),
    manifestSha256:
      entry.manifestSha256 ?? entry.manifest_sha256 ?? entry.checksums?.metadata,
    scriptSha256: entry.scriptSha256 ?? entry.script_sha256 ?? entry.checksums?.script,
    artifactKind,
    manifestPath: entry.manifestPath ?? entry.manifest_path ?? null,
    entrypointPath: entry.entrypointPath ?? entry.entrypoint_path ?? null,
    entrypointSha256:
      entry.entrypointSha256 ?? entry.entrypoint_sha256 ?? entry.checksums?.entrypoint,
    provenancePath: entry.provenancePath ?? entry.provenance_path ?? null,
    provenanceSha256:
      entry.provenanceSha256 ?? entry.provenance_sha256 ?? entry.checksums?.provenance,
    sourceTag: entry.sourceTag ?? entry.source_tag ?? entry.gitRef ?? entry.git_ref ?? null,
    sourceCommit:
      entry.sourceCommit ?? entry.source_commit ?? entry.gitRef ?? entry.git_ref ?? null,
    releaseId: entry.releaseId ?? entry.release_id ?? null,
    publishedAt: entry.publishedAt ?? entry.published_at ?? null,
    name: entry.name ?? null,
    description: entry.description ?? null,
  };
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
 *
 * Returns the same shape `unpackAndVerifyArtifact` returns for a tarball, so
 * everything downstream — install writes, prune, verify — is untouched.
 */
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

  const { manifest } = await fetchManifestByDigest({ ...transport, digest });

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
  const configBytes = await fetchBlob({ ...transport, digest: manifest.config.digest });
  const profileBytes = await fetchBlob({ ...transport, digest: layers.profile.digest });
  const codeBytes = await fetchBlob({ ...transport, digest: layers.code.digest });
  const provenanceBytes = await fetchBlob({ ...transport, digest: layers.provenance.digest });
  const licensesBytes = await fetchBlob({ ...transport, digest: layers.licenses.digest });
  const assetsBytes = layers.assets
    ? await fetchBlob({ ...transport, digest: layers.assets.digest })
    : null;

  let config;
  let profile;
  try {
    config = JSON.parse(configBytes.toString("utf8"));
    profile = JSON.parse(profileBytes.toString("utf8"));
  } catch (error) {
    throw new OciRegistryError(
      `Refusing ${reference.repository}: config or profile is not JSON (${error.message})`,
      "tampered"
    );
  }

  assertConfigMatchesProfile({
    config,
    profileBytes,
    profile,
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
    artifactKind: entry.artifactKind,
    schemaFiles: [],
    assetFiles: [
      ...licenseFiles.map((file) => ({ path: `licenses/${file.path}`, buffer: file.buffer })),
      ...assetFiles.map((file) => ({ path: `assets/${file.path}`, buffer: file.buffer })),
    ],
    readme: null,
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
    },
  };
}

async function fetchArtifactForEntry(indexSource, entry, options = {}) {
  const resolvedEntry = enrichRemoteEntry(indexSource, entry);

  if (indexSource?.mode === "local") {
    const artifactPath = resolveArtifactLocalPath(
      indexSource.rootDir,
      resolvedEntry.artifactPath,
      resolvedEntry.connectorId
    );
    return readFileSync(artifactPath);
  }

  if (!resolvedEntry.artifactUrl) {
    throw new Error(`Connector ${resolvedEntry.connectorId} is missing artifactUrl`);
  }
  const artifactBuffer = await fetchBinary(resolvedEntry.artifactUrl, {
    fetchImpl: options.fetchImpl,
    ...options.retryOptions,
  });
  const certificateIdentityURI = await resolveArtifactCertificateIdentity({
    artifactCertificateIdentityResolver: options.artifactCertificateIdentityResolver,
    artifactUrl: resolvedEntry.artifactUrl,
    entry: resolvedEntry,
  });
  await verifyRemoteSignature({
    payloadBuffer: artifactBuffer,
    subjectLabel: `Connector artifact ${resolvedEntry.connectorId}@${resolvedEntry.version}`,
    subjectUrl: resolvedEntry.artifactUrl,
    signature: resolvedEntry.artifactSignature,
    certificateIdentityURI,
    sigstoreVerifier: options.sigstoreVerifier,
    fetchImpl: options.fetchImpl,
    retryOptions: options.retryOptions,
  });
  return artifactBuffer;
}

function unpackAndVerifyArtifact(entry, artifactBuffer) {
  const artifactChecksum = sha256Buffer(artifactBuffer);
  if (entry.artifactSha256 && entry.artifactSha256 !== artifactChecksum) {
    throw new Error(
      `${entry.connectorId} artifact checksum mismatch: expected ${entry.artifactSha256}, got ${artifactChecksum}`
    );
  }

  const unpacked = unpackArtifactBuffer(entry, artifactBuffer);
  const manifest = JSON.parse(unpacked.manifestBuffer.toString("utf8"));
  const manifestChecksum = sha256Buffer(unpacked.manifestBuffer);
  const entrypointChecksum = sha256Buffer(unpacked.entrypointBuffer);
  const provenanceChecksum = unpacked.provenanceBuffer
    ? sha256Buffer(unpacked.provenanceBuffer)
    : null;

  if (entry.manifestSha256 && entry.manifestSha256 !== manifestChecksum) {
    throw new Error(
      `${entry.connectorId} manifest checksum mismatch: expected ${entry.manifestSha256}, got ${manifestChecksum}`
    );
  }
  if (unpacked.entrypointChecksum && unpacked.entrypointChecksum !== entrypointChecksum) {
    throw new Error(
      `${entry.connectorId} ${unpacked.entrypointLabel} checksum mismatch: expected ${unpacked.entrypointChecksum}, got ${entrypointChecksum}`
    );
  }
  if (unpacked.provenanceChecksum && unpacked.provenanceChecksum !== provenanceChecksum) {
    throw new Error(
      `${entry.connectorId} provenance checksum mismatch: expected ${unpacked.provenanceChecksum}, got ${provenanceChecksum}`
    );
  }

  if (entry.version && manifest.version !== entry.version) {
    throw new Error(
      `${entry.connectorId} version mismatch: index says ${entry.version} but artifact manifest declares ${manifest.version}`
    );
  }

  if (entry.artifactKind === "legacy" && manifest.connector_id && manifest.connector_id !== entry.connectorId) {
    throw new Error(
      `${entry.connectorId} artifact manifest declares connector_id ${manifest.connector_id}`
    );
  }

  return {
    manifest,
    manifestBuffer: unpacked.manifestBuffer,
    entrypointBuffer: unpacked.entrypointBuffer,
    entrypointPath: unpacked.entrypointPath,
    provenanceBuffer: unpacked.provenanceBuffer,
    provenancePath: unpacked.provenancePath,
    artifactKind: entry.artifactKind,
    ...(entry.artifactKind === "legacy" ? { scriptBuffer: unpacked.entrypointBuffer } : {}),
    schemaFiles: unpacked.schemaFiles,
    assetFiles: unpacked.assetFiles,
    readme: unpacked.readme,
    checksums: {
      artifact: artifactChecksum,
      manifest: manifestChecksum,
      entrypoint: entrypointChecksum,
      ...(provenanceChecksum ? { provenance: provenanceChecksum } : {}),
      ...(entry.artifactKind === "legacy" ? { script: entrypointChecksum } : {}),
    },
  };
}

function normalizeFetchedArtifact(entry, artifact) {
  return {
    connectorId: entry.connectorId,
    company: entry.company,
    version: entry.version,
    resolvedFrom: entry.resolvedFrom,
    entry,
    ...artifact,
  };
}

function projectFetchedArtifact(entry, artifact) {
  if (entry.artifactKind === "legacy") {
    return {
      manifest: artifact.manifest,
      manifestBuffer: artifact.manifestBuffer,
      scriptBuffer: artifact.entrypointBuffer,
      schemaFiles: artifact.schemaFiles,
      assetFiles: artifact.assetFiles,
      readme: artifact.readme,
      checksums: {
        artifact: artifact.checksums.artifact,
        manifest: artifact.checksums.manifest,
        script: artifact.checksums.script,
      },
    };
  }
  return artifact;
}

function metadataDirFromSourceFiles(entry) {
  const sourceFiles = entry.sourceFiles;
  if (!sourceFiles?.metadata || !sourceFiles?.script) {
    throw new Error(`Connector ${entry.connectorId} is missing sourceFiles metadata/script`);
  }
  return dirname(sourceFiles.metadata);
}

function buildSnapshotWrites(installRoot, resolved) {
  const writes = [
    {
      relativePath: `manifests/${resolved.connectorId}.json`,
      buffer: resolved.manifestBuffer,
    },
    {
      relativePath: `scripts/${resolved.connectorId}.js`,
      buffer: resolved.entrypointBuffer,
    },
  ];

  for (const schemaFile of resolved.schemaFiles) {
    const fileName = schemaFile.path.split("/").at(-1);
    if (!fileName) continue;
    const relativePath = `schemas/${fileName}`;
    writes.push({
      relativePath,
      buffer: schemaFile.buffer,
    });
  }

  for (const assetFile of resolved.assetFiles) {
    writes.push({
      relativePath: `assets/${resolved.connectorId}/${assetFile.path}`,
      buffer: assetFile.buffer,
    });
  }

  return writes.map((write) => ({
    ...write,
    absolutePath: join(installRoot, write.relativePath),
  }));
}

function buildSourceWrites(installRoot, resolved) {
  const metadataDir = metadataDirFromSourceFiles(resolved.entry);
  const writes = [
    {
      relativePath: resolved.entry.sourceFiles.metadata,
      buffer: resolved.manifestBuffer,
    },
    {
      relativePath: resolved.entry.sourceFiles.script,
      buffer: resolved.entrypointBuffer,
    },
  ];

  for (const schemaFile of resolved.schemaFiles) {
    const fileName = schemaFile.path.split("/").at(-1);
    if (!fileName || fileName === "manifest.schema.json") continue;
    writes.push({
      relativePath: join(metadataDir, "schemas", fileName),
      buffer: schemaFile.buffer,
    });
  }

  for (const assetFile of resolved.assetFiles) {
    writes.push({
      relativePath: join(metadataDir, assetFile.path),
      buffer: assetFile.buffer,
    });
  }

  if (resolved.readme) {
    writes.push({
      relativePath: join(metadataDir, resolved.readme.path),
      buffer: resolved.readme.buffer,
    });
  }

  return writes.map((write) => ({
    ...write,
    absolutePath: join(installRoot, write.relativePath),
  }));
}

function buildPdppCollectionProfileWrites(installRoot, resolved) {
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
    // Licences and brand assets, which the publisher ships unconditionally
    // because distributing the code requires distributing them (C5.4), so they
    // are written rather than dropped on the floor.
    //
    // Gated on `resolved.oci` rather than on `assetFiles` being non-empty,
    // and the difference is not cosmetic. A TARBALL collection-profile
    // artifact also populates `assetFiles` — `unpackArtifactBuffer` puts every
    // file that is not the manifest, entrypoint, provenance, a schema or the
    // README there. Spreading it unconditionally therefore starts installing
    // stray files from tarball artifacts that were previously ignored, which
    // is a behaviour change to the path this PR is supposed to leave alone.
    // Measured, not assumed: an unconditional spread wrote a fourth file for a
    // tarball artifact carrying one extra member. Today's two published
    // collection profiles happen to carry no such member, so no existing test
    // fails either way — which is exactly why the gate is on the transport and
    // not on whether the list happens to be empty.
    ...(resolved.oci
      ? resolved.assetFiles.map((file) => ({
          relativePath: `${artifactRoot}/${validateRelativeArtifactPath(file.path, "artifact asset path")}`,
          buffer: file.buffer,
        }))
      : []),
  ];

  return writes.map((write) => ({
    ...write,
    absolutePath: join(installRoot, write.relativePath),
  }));
}

function buildInstallWrites(layout, installRoot, resolved) {
  if (resolved.artifactKind === "pdpp-collection-profile") {
    if (layout === "snapshot" || layout === "source") {
      return buildPdppCollectionProfileWrites(installRoot, resolved);
    }
    throw new Error(`Unsupported install layout "${layout}"`);
  }
  if (layout === "snapshot") {
    return buildSnapshotWrites(installRoot, resolved);
  }
  if (layout === "source") {
    return buildSourceWrites(installRoot, resolved);
  }
  throw new Error(`Unsupported install layout "${layout}"`);
}

async function fetchLockArtifacts({
  lock,
  source,
  artifactCertificateIdentityResolver,
  ...options
}) {
  const normalizedEntries = (lock.connectors ?? []).map(normalizeLockEntry);
  const resolved = [];

  for (const entry of normalizedEntries) {
    const artifact = await fetchEntryArtifact(source, entry, {
      artifactCertificateIdentityResolver,
      ...options,
    });
    resolved.push(normalizeFetchedArtifact(entry, artifact));
  }

  return resolved;
}

/**
 * The transport dispatch: an entry carrying an `oci` block is pulled from a
 * registry, everything else keeps the tarball path byte for byte.
 *
 * The lock is the switch. There is no feature flag and no environment
 * variable, because the presence of `oci` on an entry already says which
 * transport that entry uses, and a flag would be a second place for the answer
 * to live — one that CI cannot diff.
 */
async function fetchEntryArtifact(source, entry, options = {}) {
  if (entry.oci) {
    return fetchOciArtifact(entry, options);
  }
  const artifactBuffer = await fetchArtifactForEntry(source, entry, options);
  return unpackAndVerifyArtifact(entry, artifactBuffer);
}

function expectedWritesForLock({ installRoot, layout, resolved }) {
  return resolved.flatMap((entry) => buildInstallWrites(layout, installRoot, entry));
}

function ensureParentDir(path) {
  mkdirSync(dirname(path), { recursive: true });
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

export async function fetchResolvedArtifact(indexSource, entry, options = {}) {
  const normalizedEntry = normalizeLockEntry(entry);
  return projectFetchedArtifact(
    normalizedEntry,
    await fetchEntryArtifact(indexSource, normalizedEntry, options)
  );
}

export async function resolveConnectorArtifacts({
  dependencies,
  requestedConnectorIds,
  source,
  artifactCertificateIdentityResolver,
}) {
  const connectorIds = requestedConnectorIds ?? Object.keys(dependencies.connectors);
  const resolved = [];

  for (const connectorId of connectorIds) {
    const constraint = dependencies.connectors[connectorId];
    if (!constraint) {
      throw new Error(`Missing version constraint for ${connectorId}`);
    }
    const availableEntries = extractAvailableVersions(source.doc, connectorId);
    const selected = selectResolvedEntry(availableEntries, constraint, connectorId);
    const artifact = await fetchResolvedArtifact(source, selected, {
      artifactCertificateIdentityResolver,
    });
    resolved.push({
      connectorId,
      constraint,
      entry: selected,
      ...artifact,
    });
  }

  return {
    source,
    resolved,
  };
}

export async function generateLock({
  dependencies,
  source,
  dependencyFile = null,
  lockVersion = "1.0",
  generatedAt = new Date().toISOString(),
  requestedConnectorIds,
  artifactCertificateIdentityResolver,
}) {
  const resolution = await resolveConnectorArtifacts({
    dependencies,
    source,
    requestedConnectorIds,
    artifactCertificateIdentityResolver,
  });
  const sourceMeta = deriveSourceMeta(
    source,
    resolution.resolved.map((entry) => entry.entry)
  );

  return {
    lockVersion,
    dependencyFile,
    generatedAt,
    sourceRepo:
      source.doc.sourceRepo ??
      dependencies.source_repo ??
      "https://github.com/PDP-Connect/data-connectors",
    sourceTag: sourceMeta.sourceTag,
    sourceCommit: sourceMeta.sourceCommit,
    index: {
      mode: source.mode,
      path: source.indexPath,
      url: source.indexUrl,
      version: source.doc.indexVersion ?? "unknown",
      signatureVerified: source.signatureVerified ?? false,
    },
    dependencies: dependencies.connectors,
    connectors: resolution.resolved
      .map((resolved) => ({
        connectorId: resolved.connectorId,
        company: resolved.entry.company,
        version: resolved.entry.version,
        resolvedFrom: resolved.constraint,
        sourceFiles: resolved.entry.sourceFiles,
        artifactUrl: resolved.entry.artifactUrl ?? null,
        artifactPath: resolved.entry.artifactPath ?? null,
        artifactSha256: resolved.checksums.artifact,
        artifactSignature: resolved.entry.artifactSignature ?? null,
        manifestSha256: resolved.checksums.manifest,
        ...(resolved.entry.artifactKind === "pdpp-collection-profile"
          ? {
              artifactKind: resolved.entry.artifactKind,
              manifestPath: resolved.entry.manifestPath,
              entrypointPath: resolved.entry.entrypointPath,
              entrypointSha256: resolved.checksums.entrypoint,
              provenancePath: resolved.entry.provenancePath,
              provenanceSha256: resolved.checksums.provenance,
            }
          : { scriptSha256: resolved.checksums.script }),
        sourceTag: resolved.entry.sourceTag ?? resolved.entry.gitRef ?? sourceMeta.sourceTag,
        sourceCommit:
          resolved.entry.sourceCommit ?? resolved.entry.gitRef ?? sourceMeta.sourceCommit,
        releaseId: resolved.entry.releaseId ?? null,
        publishedAt: resolved.entry.publishedAt ?? null,
        name: resolved.entry.name ?? resolved.manifest.name,
        description: resolved.entry.description ?? resolved.manifest.description,
      }))
      .sort((a, b) => a.connectorId.localeCompare(b.connectorId)),
  };
}

export async function checkForUpdates({ lock, indexDoc }) {
  const updates = [];

  for (const rawLockEntry of lock.connectors ?? []) {
    const lockEntry = normalizeLockEntry(rawLockEntry);
    const availableEntries = extractAvailableVersions(indexDoc, lockEntry.connectorId);
    if (availableEntries.length === 0) {
      updates.push({
        connectorId: lockEntry.connectorId,
        status: "missing_from_index",
        currentVersion: lockEntry.version,
        latestVersion: null,
      });
      continue;
    }

    const latest = availableEntries.sort((a, b) => compareVersions(b.version, a.version))[0];
    if (compareVersions(latest.version, lockEntry.version) > 0) {
      updates.push({
        connectorId: lockEntry.connectorId,
        status: "update_available",
        currentVersion: lockEntry.version,
        latestVersion: latest.version,
        artifactSha256: latest.artifactSha256,
        artifactSignature: normalizeSignature(latest.artifactSignature ?? null),
      });
    }
  }

  return {
    hasUpdates: updates.length > 0,
    updates,
  };
}

export function pruneInstalled({
  installRoot,
  expectedPaths,
  preserveTopLevel = [],
}) {
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
  artifactCertificateIdentityResolver,
  ...options
}) {
  const resolved = await fetchLockArtifacts({
    lock,
    source,
    artifactCertificateIdentityResolver,
    ...options,
  });
  const writes = expectedWritesForLock({ installRoot, layout, resolved });
  const expectedPaths = writes.map((write) => write.relativePath);

  for (const write of writes) {
    ensureParentDir(write.absolutePath);
    writeFileSync(write.absolutePath, write.buffer);
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
    pinned: resolved
      .filter((artifact) => artifact.oci)
      .map((artifact) => ({
        connectorId: artifact.connectorId,
        version: artifact.version,
        registry: artifact.oci.registry,
        repository: artifact.oci.repository,
        digest: artifact.oci.digest,
      })),
  };
}

export async function verifyInstalled({
  lock,
  source,
  installRoot,
  layout,
  artifactCertificateIdentityResolver,
  ...options
}) {
  const resolved = await fetchLockArtifacts({
    lock,
    source,
    artifactCertificateIdentityResolver,
    ...options,
  });
  const writes = expectedWritesForLock({ installRoot, layout, resolved });
  const missing = [];
  const mismatched = [];

  for (const write of writes) {
    if (!existsSync(write.absolutePath)) {
      missing.push(write.relativePath);
      continue;
    }

    const currentChecksum = sha256Buffer(readFileSync(write.absolutePath));
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
  };
}

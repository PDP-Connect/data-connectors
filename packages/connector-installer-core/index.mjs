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
import { dirname, join, normalize, resolve as resolvePath } from "node:path";
import { verify as verifySigstoreBundle } from "sigstore";

export const DEFAULT_CONNECTOR_INDEX_URL =
  "https://github.com/PDP-Connect/data-connectors/releases/download/connectors-latest/connector-index.json";
export const DEFAULT_SIGSTORE_CERTIFICATE_ISSUER =
  "https://token.actions.githubusercontent.com";
export const DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY =
  "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-connector-release-index.yml@refs/heads/main";

export function defaultArtifactCertificateIdentityResolver() {
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

async function fetchBinary(url) {
  const response = await fetch(url);
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
  const bundleBuffer = await fetchBinary(bundleUrl);
  const bundle = JSON.parse(bundleBuffer.toString("utf8"));

  try {
    await sigstoreVerifier(bundle, payloadBuffer, {
      certificateIssuer: DEFAULT_SIGSTORE_CERTIFICATE_ISSUER,
      certificateIdentityURI,
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

function walkArtifactFiles(dir, root = dir) {
  if (!existsSync(dir)) {
    return [];
  }

  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      throw new Error(`Artifact contains unsupported link "${full.slice(root.length + 1)}"`);
    }
    if (st.isDirectory()) {
      out.push(...walkArtifactFiles(full, root));
      continue;
    }
    if (!st.isFile()) {
      throw new Error(`Artifact contains unsupported entry "${full.slice(root.length + 1)}"`);
    }
    out.push({
      path: full,
      relativePath: full.slice(root.length + 1),
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

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const indexBuffer = Buffer.from(await response.arrayBuffer());
  const doc = JSON.parse(indexBuffer.toString("utf8"));
  const signatureVerified = await verifyRemoteSignature({
    payloadBuffer: indexBuffer,
    subjectLabel: "Connector index",
    subjectUrl: url,
    signature: doc.signature,
    allowUnsignedRemote,
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

function normalizeLockEntry(entry) {
  const artifactKind = entry.artifactKind ?? entry.artifact_kind ?? "legacy";
  return {
    connectorId: entry.connectorId ?? entry.id,
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
  const artifactBuffer = await fetchBinary(resolvedEntry.artifactUrl);
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

async function fetchLockArtifacts({ lock, source, artifactCertificateIdentityResolver }) {
  const normalizedEntries = (lock.connectors ?? []).map(normalizeLockEntry);
  const resolved = [];

  for (const entry of normalizedEntries) {
    const artifactBuffer = await fetchArtifactForEntry(source, entry, {
      artifactCertificateIdentityResolver,
    });
    const artifact = unpackAndVerifyArtifact(entry, artifactBuffer);
    resolved.push(normalizeFetchedArtifact(entry, artifact));
  }

  return resolved;
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
  const artifactBuffer = await fetchArtifactForEntry(indexSource, normalizedEntry, options);
  return projectFetchedArtifact(
    normalizedEntry,
    unpackAndVerifyArtifact(normalizedEntry, artifactBuffer)
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
}) {
  const resolved = await fetchLockArtifacts({ lock, source, artifactCertificateIdentityResolver });
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
  };
}

export async function verifyInstalled({
  lock,
  source,
  installRoot,
  layout,
  artifactCertificateIdentityResolver,
}) {
  const resolved = await fetchLockArtifacts({ lock, source, artifactCertificateIdentityResolver });
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

#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBundledScopeSchemasMatch,
  assertConnectorIndexSigned,
} from "./connector-artifact-contract.mjs";
import { assertBundledDependenciesMatch } from "./pdpp-bundled-dependencies.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const registryPath = join(repoRoot, "registry.json");
const indexPath = join(repoRoot, "connector-index.json");
const artifactsDir = join(repoRoot, "artifacts");
const polyfillManifestsDir = join(repoRoot, "packages", "polyfill-connectors", "manifests");
const sourceRepository = "PDP-Connect/data-connectors";
const shouldEmitSignatureMetadata =
  process.env.CONNECTOR_ENABLE_SIGSTORE_METADATA === "1";
const shouldUseReleaseAssets =
  process.env.CONNECTOR_USE_RELEASE_ASSETS === "1";

function resolveSourceCommit() {
  const explicitCommit = process.env.CONNECTOR_SOURCE_COMMIT?.trim();
  if (explicitCommit) {
    return explicitCommit;
  }
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function resolveSourceTag(sourceCommit) {
  const explicitTag = process.env.CONNECTOR_SOURCE_TAG?.trim();
  if (explicitTag) {
    return explicitTag;
  }

  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  if (branch && branch !== "HEAD") {
    return branch;
  }
  return sourceCommit;
}

function resolveReleaseMetadata(sourceCommit) {
  const releaseTag =
    process.env.CONNECTOR_RELEASE_TAG?.trim() ||
    `connectors-${sourceCommit.slice(0, 12)}`;
  const releaseId = process.env.CONNECTOR_RELEASE_ID?.trim() || releaseTag;
  const repo =
    process.env.GITHUB_REPOSITORY?.trim() || "PDP-Connect/data-connectors";

  return {
    releaseTag,
    releaseId,
    repo,
  };
}

function buildArtifactUrl({
  artifactRelativePath,
  releaseTag,
  repo,
  sourceCommit,
}) {
  if (process.env.CONNECTOR_RELEASE_ASSET_BASE_URL?.trim()) {
    const baseUrl = process.env.CONNECTOR_RELEASE_ASSET_BASE_URL.trim().replace(
      /\/$/,
      "",
    );
    return `${baseUrl}/${artifactRelativePath.split("/").at(-1)}`;
  }

  if (process.env.CONNECTOR_USE_RELEASE_ASSETS === "1") {
    return `https://github.com/${repo}/releases/download/${releaseTag}/${artifactRelativePath.split("/").at(-1)}`;
  }

  return `https://raw.githubusercontent.com/${repo}/${sourceCommit}/${artifactRelativePath}`;
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertRelativeBrandAssetPath(path, manifestPath, field) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(`${manifestPath}: brand.${field} must be a non-empty relative path`);
  }
  const normalized = path.trim();
  if (normalized.startsWith("/") || normalized.includes("\\") || normalized.split("/").includes("..")) {
    throw new Error(`${manifestPath}: brand.${field} must stay inside the manifest directory`);
  }
  return normalized;
}

function resolvePolyfillBrandIcons(sourceCommit) {
  const brandIcons = {};
  for (const filename of readdirSync(polyfillManifestsDir).filter((file) => file.endsWith(".json")).sort()) {
    const manifestPath = join(polyfillManifestsDir, filename);
    const manifest = readJson(manifestPath);
    const connectorId = manifest.connector_id;
    if (typeof connectorId !== "string" || connectorId.trim() === "") {
      throw new Error(`${manifestPath}: connector_id must be a non-empty string`);
    }
    if (!manifest.brand || typeof manifest.brand !== "object" || Array.isArray(manifest.brand)) {
      throw new Error(`${manifestPath}: brand is required`);
    }
    const icon = assertRelativeBrandAssetPath(manifest.brand.icon, manifestPath, "icon");
    const iconPath = join(dirname(manifestPath), icon);
    if (!existsSync(iconPath) || !statSync(iconPath).isFile()) {
      throw new Error(`${manifestPath}: brand.icon asset is missing: ${icon}`);
    }
    const iconReference = {
      url: `https://raw.githubusercontent.com/${sourceRepository}/${sourceCommit}/packages/polyfill-connectors/manifests/${icon}`,
    };
    if (manifest.brand.dark_icon !== undefined) {
      const darkIcon = assertRelativeBrandAssetPath(manifest.brand.dark_icon, manifestPath, "dark_icon");
      const darkIconPath = join(dirname(manifestPath), darkIcon);
      if (!existsSync(darkIconPath) || !statSync(darkIconPath).isFile()) {
        throw new Error(`${manifestPath}: brand.dark_icon asset is missing: ${darkIcon}`);
      }
      iconReference.darkUrl = `https://raw.githubusercontent.com/${sourceRepository}/${sourceCommit}/packages/polyfill-connectors/manifests/${darkIcon}`;
    }
    if (manifest.brand.background_color !== undefined) {
      iconReference.backgroundColor = manifest.brand.background_color;
    }
    brandIcons[connectorId] = iconReference;
  }
  return brandIcons;
}

function buildSigstoreBundleMetadata(bundlePath, bundleUrl = null) {
  if (!shouldEmitSignatureMetadata) {
    return null;
  }

  return {
    type: "sigstoreBundle",
    bundlePath,
    ...(bundleUrl ? { bundleUrl } : {}),
  };
}

function refreshReleaseDistributionMetadata(entry, releaseMetadata) {
  const artifactRelativePath = entry.artifactPath;
  const artifactFilename = basename(artifactRelativePath);
  const sourceCommit = entry.sourceCommit ?? entry.gitRef ?? resolveSourceCommit();
  const signature = buildSigstoreBundleMetadata(
    `${artifactFilename}.sigstore.json`,
    buildArtifactUrl({
      artifactRelativePath: `${artifactRelativePath}.sigstore.json`,
      releaseTag: releaseMetadata.releaseTag,
      repo: releaseMetadata.repo,
      sourceCommit,
    }),
  );

  return {
    ...entry,
    releaseId: releaseMetadata.releaseId,
    artifactUrl: buildArtifactUrl({
      artifactRelativePath,
      releaseTag: releaseMetadata.releaseTag,
      repo: releaseMetadata.repo,
      sourceCommit,
    }),
    ...(signature ? { artifactSignature: signature } : {}),
  };
}

function resolveCommittedArtifactRef(existingIndex) {
  if (!existingIndex?.connectors) {
    return null;
  }

  const refs = new Set();
  for (const versions of Object.values(existingIndex.connectors)) {
    if (!Array.isArray(versions) || versions.length === 0) {
      continue;
    }

    const latest = versions.at(-1);
    if (latest?.sourceCommit) {
      refs.add(latest.sourceCommit);
    }
  }

  if (refs.size === 1) {
    return [...refs][0];
  }

  return null;
}

function resolveCommittedArtifactTag(existingIndex) {
  if (!existingIndex?.connectors) {
    return null;
  }

  const tags = new Set();
  for (const versions of Object.values(existingIndex.connectors)) {
    if (!Array.isArray(versions) || versions.length === 0) {
      continue;
    }

    const latest = versions.at(-1);
    if (latest?.sourceTag) {
      tags.add(latest.sourceTag);
    }
  }

  if (tags.size === 1) {
    return [...tags][0];
  }

  return null;
}

function resolveCommittedBrandSourceCommit(existingIndex) {
  if (!existingIndex?.brandIcons) {
    return null;
  }

  const refs = new Set();
  for (const brandIcon of Object.values(existingIndex.brandIcons)) {
    if (!brandIcon || typeof brandIcon !== "object" || typeof brandIcon.url !== "string") {
      continue;
    }
    const match = brandIcon.url.match(
      /^https:\/\/raw\.githubusercontent\.com\/PDP-Connect\/data-connectors\/([0-9a-f]{40})\/packages\/polyfill-connectors\/manifests\//,
    );
    if (match) refs.add(match[1]);
  }

  return refs.size === 1 ? [...refs][0] : null;
}

function resolveRetainedArtifactSourceUrl(entry, repo) {
  if (
    typeof entry.artifactUrl === "string" &&
    entry.artifactUrl.trim() !== ""
  ) {
    return entry.artifactUrl;
  }

  if (!entry.artifactPath) {
    throw new Error(
      `Retained connector ${entry.connectorId}@${entry.version} is missing artifactPath`,
    );
  }

  const sourceCommit = entry.sourceCommit ?? entry.gitRef ?? null;
  if (!sourceCommit) {
    throw new Error(
      `Retained connector ${entry.connectorId}@${entry.version} is missing sourceCommit`,
    );
  }

  return `https://raw.githubusercontent.com/${repo}/${sourceCommit}/${entry.artifactPath}`;
}

function shouldRepackageRetainedEntry(entry) {
  if (process.env.CONNECTOR_USE_RELEASE_ASSETS !== "1") {
    return false;
  }

  const artifactUrl =
    typeof entry.artifactUrl === "string" ? entry.artifactUrl : "";
  const hasReleaseAssetUrl = artifactUrl.includes("/releases/download/");
  const signature = entry.artifactSignature;
  const hasSignatureMetadata =
    signature &&
    typeof signature === "object" &&
    (signature.type === "sigstoreBundle" ||
      signature.bundlePath ||
      signature.bundleUrl);

  return !hasReleaseAssetUrl || !hasSignatureMetadata;
}

function sha256Buffer(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function verifyPdppArtifactMaintainedSources({ entry, provenance }) {
  const connectorDir = join(repoRoot, "connectors", dirname(entry.files.manifest));
  for (const source of provenance.source_inventory?.maintained_local ?? []) {
    if (!source?.path || !source?.sha256) {
      throw new Error(
        `${entry.id}@${entry.version} provenance has an invalid maintained source entry`,
      );
    }
    const sourcePath = join(connectorDir, source.path);
    if (!existsSync(sourcePath)) {
      throw new Error(
        `${entry.id}@${entry.version} maintained source missing: ${source.path}`,
      );
    }
    const actual = sha256Buffer(readFileSync(sourcePath));
    if (actual !== source.sha256) {
      throw new Error(
        `${entry.id}@${entry.version} maintained source changed without a version bump: ${source.path}`,
      );
    }
  }
  assertBundledDependenciesMatch({
    repoRoot,
    dependencies: provenance.source_inventory?.bundled_dependencies,
    artifactLabel: `${entry.id}@${entry.version}`,
  });
}

function copyIntoBundle(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, readFileSync(sourcePath));
}

function walkFiles(dir, root = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkFiles(full, root));
    } else {
      out.push({
        path: full,
        relativePath: full.slice(root.length + 1),
      });
    }
  }
  return out;
}

function normalizeManifestAssetPaths(manifest) {
  const assetPaths = [];
  if (typeof manifest.icon === "string" && manifest.icon.trim() !== "") {
    assetPaths.push(manifest.icon.trim());
  }
  if (typeof manifest.iconURL === "string" && manifest.iconURL.trim() !== "") {
    assetPaths.push(manifest.iconURL.trim());
  }
  return [...new Set(assetPaths)];
}

function resolveConnectorSchemaPath(metadataSource, scope) {
  const schemaSource = join(
    dirname(metadataSource),
    "schemas",
    `${scope}.json`,
  );
  if (!existsSync(schemaSource)) {
    throw new Error(
      `Schema not found for ${metadataSource.slice(repoRoot.length + 1)}: schemas/${scope}.json`,
    );
  }
  return schemaSource;
}

function createArtifactBundle(entry, metadata) {
  const tempRoot = mkdtempSync(join(tmpdir(), "connector-bundle-"));
  const bundleDir = join(tempRoot, "bundle");
  mkdirSync(bundleDir, { recursive: true });

  try {
    const scriptSource = join(repoRoot, "connectors", entry.files.script);
    const metadataSource = join(repoRoot, "connectors", entry.files.metadata);
    copyIntoBundle(metadataSource, join(bundleDir, "manifest.json"));
    copyIntoBundle(scriptSource, join(bundleDir, "script.js"));

    for (const scopeEntry of metadata.scopes ?? []) {
      const scope =
        typeof scopeEntry === "string" ? scopeEntry : scopeEntry?.scope;
      if (!scope) continue;
      const schemaSource = resolveConnectorSchemaPath(metadataSource, scope);
      copyIntoBundle(schemaSource, join(bundleDir, "schemas", `${scope}.json`));
    }

    copyIntoBundle(
      join(repoRoot, "schemas", "manifest.schema.json"),
      join(bundleDir, "schemas", "manifest.schema.json"),
    );

    for (const relativeAssetPath of normalizeManifestAssetPaths(metadata)) {
      const assetSource = join(dirname(metadataSource), relativeAssetPath);
      if (!existsSync(assetSource)) {
        throw new Error(
          `Asset not found for ${entry.id}: ${relativeAssetPath}`,
        );
      }
      copyIntoBundle(assetSource, join(bundleDir, relativeAssetPath));
    }

    const readmeSource = join(dirname(metadataSource), "README.md");
    if (existsSync(readmeSource)) {
      copyIntoBundle(readmeSource, join(bundleDir, "README.md"));
    }

    return {
      scriptSource,
      metadataSource,
      bundleDir,
    };
  } finally {
    // Caller is responsible for cleanup because bundleDir is needed for tar creation.
  }
}

function createPdppArtifactBundle(entry) {
  const tempRoot = mkdtempSync(join(tmpdir(), "pdpp-connector-bundle-"));
  const bundleDir = join(tempRoot, "bundle");
  const connectorDir = join(repoRoot, "connectors", dirname(entry.files.manifest));
  mkdirSync(bundleDir, { recursive: true });
  try {
    copyIntoBundle(join(repoRoot, "connectors", entry.files.manifest), join(bundleDir, entry.manifestPath));
    copyIntoBundle(join(repoRoot, "connectors", entry.files.entrypoint), join(bundleDir, entry.entrypointPath));
    copyIntoBundle(join(repoRoot, "connectors", entry.files.provenance), join(bundleDir, entry.provenancePath));
    const readmeSource = join(connectorDir, "README.md");
    if (existsSync(readmeSource)) copyIntoBundle(readmeSource, join(bundleDir, "README.md"));
    return { bundleDir };
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

function createDeterministicTar(bundleDir, outputPath) {
  execFileSync("tar", [
    "--sort=name", "--mtime=@0", "--owner=0", "--group=0", "--numeric-owner",
    "--pax-option=delete=atime,delete=ctime", "-I", "gzip -n", "-cf", outputPath, "-C", bundleDir, ".",
  ]);
}

function hasCommittedPdppArtifactVersion(entry) {
  try {
    const committedIndex = JSON.parse(execFileSync("git", ["show", "HEAD:connector-index.json"], {
      cwd: repoRoot,
      encoding: "utf8",
    }));
    return Boolean(
      committedIndex.connectors?.[entry.id]?.some((version) => version.version === entry.version),
    );
  } catch {
    return false;
  }
}

function materializePdppArtifact({
  entry,
  existingIndex,
  checkMode,
  allowUnpublishedRebuild,
  expectedArtifactPaths,
  releaseMetadata,
}) {
  const manifestPath = join(repoRoot, "connectors", entry.files.manifest);
  const entrypointPath = join(repoRoot, "connectors", entry.files.entrypoint);
  const provenancePath = join(repoRoot, "connectors", entry.files.provenance);
  const manifestBuffer = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBuffer);
  if (entry.version !== manifest.version) throw new Error(`${entry.id} version must match its canonical manifest`);
  if (allowUnpublishedRebuild && entry.releaseId !== "unpublished") {
    throw new Error("--allow-unpublished-rebuild requires an unpublished PDPP artifact");
  }
  const existing = existingIndex?.connectors?.[entry.id]?.find((version) => version.version === entry.version);
  if (existing) {
    const provenanceBuffer = readFileSync(provenancePath);
    const provenance = JSON.parse(provenanceBuffer);
    verifyPdppArtifactMaintainedSources({ entry, provenance });
    const entrypointMatches =
      !existsSync(entrypointPath) ||
      existing.entrypointSha256 === sha256Buffer(readFileSync(entrypointPath));
    const sourceMatches =
      existing.manifestSha256 === sha256Buffer(manifestBuffer) &&
      existing.provenanceSha256 === sha256Buffer(provenanceBuffer) &&
      entrypointMatches;
    if (sourceMatches) {
      const artifactPath = join(repoRoot, existing.artifactPath);
      if (!existsSync(artifactPath) || existing.artifactSha256 !== sha256Buffer(readFileSync(artifactPath))) {
        throw new Error(`${entry.id}@${entry.version} immutable artifact drifted`);
      }
      expectedArtifactPaths.add(existing.artifactPath);
      return shouldUseReleaseAssets
        ? refreshReleaseDistributionMetadata(existing, releaseMetadata)
        : existing;
    }
    if (hasCommittedPdppArtifactVersion(entry) && !allowUnpublishedRebuild) {
      throw new Error(`${entry.id}@${entry.version} source changed without a version bump`);
    }
  }
  const entrypointBuffer = readFileSync(entrypointPath);
  const provenanceBuffer = readFileSync(provenancePath);
  const bundle = createPdppArtifactBundle(entry);
  const artifactRelativePath = `artifacts/${entry.id}/${entry.id}-${entry.version}.tgz`;
  const artifactPath = join(repoRoot, artifactRelativePath);
  mkdirSync(dirname(artifactPath), { recursive: true });
  const tempArtifactPath = join(dirname(bundle.bundleDir), basename(artifactPath));
  createDeterministicTar(bundle.bundleDir, tempArtifactPath);
  const artifactBuffer = readFileSync(tempArtifactPath);
  if (!checkMode) writeFileSync(artifactPath, artifactBuffer);
  rmSync(dirname(bundle.bundleDir), { recursive: true, force: true });
  expectedArtifactPaths.add(artifactRelativePath);
  return {
    connectorId: entry.id,
    company: entry.company,
    version: entry.version,
    name: entry.name,
    status: entry.status,
    description: entry.description,
    artifactKind: entry.artifactKind,
    manifestPath: entry.manifestPath,
    entrypointPath: entry.entrypointPath,
    provenancePath: entry.provenancePath,
    manifestSha256: sha256Buffer(manifestBuffer),
    entrypointSha256: sha256Buffer(entrypointBuffer),
    provenanceSha256: sha256Buffer(provenanceBuffer),
    artifactSha256: sha256Buffer(artifactBuffer),
    artifactPath: artifactRelativePath,
    artifactUrl: entry.artifactUrl,
    publishedAt: entry.publishedAt ?? entry.lastUpdated,
    sourceTag: entry.sourceTag ?? releaseMetadata.releaseTag,
    sourceCommit: entry.sourceCommit,
    releaseId: entry.releaseId ?? "unpublished",
    upstream: entry.upstream,
    scopes: manifest.streams.map((stream) => stream.name),
    consumerMetadata: entry.consumerMetadata ?? null,
  };
}

function sortIndex(indexDoc) {
  const sorted = Object.fromEntries(
    Object.entries(indexDoc.connectors)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([connectorId, entries]) => [
        connectorId,
        entries.sort((a, b) => {
          const partsA = a.version.split(".").map(Number);
          const partsB = b.version.split(".").map(Number);
          return (
            partsA[0] - partsB[0] ||
            partsA[1] - partsB[1] ||
            partsA[2] - partsB[2]
          );
        }),
      ]),
  );
  return {
    ...indexDoc,
    connectors: sorted,
  };
}

async function materializeRetainedArtifact({
  entry,
  releaseMetadata,
  expectedArtifactPaths,
  checkMode,
}) {
  if (!entry.artifactPath) {
    throw new Error(
      `Retained connector ${entry.connectorId}@${entry.version} is missing artifactPath`,
    );
  }

  const artifactRelativePath = entry.artifactPath;
  const artifactPath = join(repoRoot, artifactRelativePath);
  const sourceCommit =
    entry.sourceCommit ?? entry.gitRef ?? resolveSourceCommit();

  if (shouldRepackageRetainedEntry(entry)) {
    // Prefer whatever is already on disk: the local artifacts/ tree is the
    // source of truth for anything still checked in, and skipping the
    // network round-trip avoids depending on history/URLs that may not
    // survive a repo transfer (see the missing-history fallback below).
    const hasLocalArtifact = existsSync(artifactPath);

    if (checkMode && !hasLocalArtifact) {
      throw new Error(`Missing artifact: ${artifactRelativePath}`);
    }

    if (!checkMode && !hasLocalArtifact) {
      const sourceUrl = resolveRetainedArtifactSourceUrl(
        entry,
        releaseMetadata.repo,
      );
      let artifactBuffer;
      try {
        artifactBuffer = await fetchBuffer(sourceUrl);
      } catch (error) {
        // A retained historical artifact that is neither committed locally
        // nor reachable at its recorded source URL (e.g. after a repo
        // transfer that didn't carry every historical commit) must not
        // hard-fail the whole publish. Drop just this version and keep
        // going; the URLs for every other, reachable version are left
        // untouched.
        console.warn(
          `Dropping unreachable retained artifact for ${entry.connectorId}@${entry.version}: ${sourceUrl} (${error.message})`,
        );
        return null;
      }
      mkdirSync(dirname(artifactPath), { recursive: true });
      writeFileSync(artifactPath, artifactBuffer);
    }

    const retainedArtifactBuffer = readFileSync(artifactPath);
    if (
      entry.artifactSha256 &&
      entry.artifactSha256 !== sha256Buffer(retainedArtifactBuffer)
    ) {
      throw new Error(
        `Retained connector ${entry.connectorId}@${entry.version} artifact checksum drifted`,
      );
    }

    expectedArtifactPaths.add(artifactRelativePath);
    return {
      ...entry,
      artifactUrl: buildArtifactUrl({
        artifactRelativePath,
        releaseTag: releaseMetadata.releaseTag,
        repo: releaseMetadata.repo,
        sourceCommit,
      }),
      ...(buildSigstoreBundleMetadata(
        `${basename(artifactRelativePath)}.sigstore.json`,
        buildArtifactUrl({
          artifactRelativePath: `${artifactRelativePath}.sigstore.json`,
          releaseTag: releaseMetadata.releaseTag,
          repo: releaseMetadata.repo,
          sourceCommit,
        }),
      )
        ? {
            artifactSignature: buildSigstoreBundleMetadata(
              `${basename(artifactRelativePath)}.sigstore.json`,
              buildArtifactUrl({
                artifactRelativePath: `${artifactRelativePath}.sigstore.json`,
                releaseTag: releaseMetadata.releaseTag,
                repo: releaseMetadata.repo,
                sourceCommit,
              }),
            ),
          }
        : {}),
      releaseId: releaseMetadata.releaseId,
    };
  }

  if (existsSync(artifactPath)) {
    expectedArtifactPaths.add(artifactRelativePath);
  }
  return entry;
}

async function main() {
  const checkMode = process.argv.includes("--check");
  const allowUnpublishedRebuild = process.argv.includes("--allow-unpublished-rebuild");
  if (checkMode && allowUnpublishedRebuild) {
    throw new Error("--allow-unpublished-rebuild cannot be used with --check");
  }
  const registry = readJson(registryPath);
  const existingIndex = existsSync(indexPath) ? readJson(indexPath) : null;
  const sourceCommit =
    process.env.CONNECTOR_SOURCE_COMMIT?.trim() ||
    (checkMode && resolveCommittedArtifactRef(existingIndex)) ||
    resolveSourceCommit();
  const sourceTag =
    process.env.CONNECTOR_SOURCE_TAG?.trim() ||
    (checkMode && resolveCommittedArtifactTag(existingIndex)) ||
    resolveSourceTag(sourceCommit);
  const brandSourceCommit =
    process.env.CONNECTOR_BRAND_SOURCE_COMMIT?.trim() ||
    (checkMode && resolveCommittedBrandSourceCommit(existingIndex)) ||
    sourceCommit;
  const releaseMetadata = resolveReleaseMetadata(sourceCommit);
  const nextIndex = {
    indexVersion: "2.0",
    sourceRepo: "https://github.com/PDP-Connect/data-connectors",
    generatedAt: registry.lastUpdated ?? new Date().toISOString(),
    brandIcons: resolvePolyfillBrandIcons(brandSourceCommit),
    signature: buildSigstoreBundleMetadata(
      "connector-index.json.sigstore.json",
    ),
    connectors: {},
  };

  if (!checkMode && !existsSync(artifactsDir)) {
    mkdirSync(artifactsDir, { recursive: true });
  }

  const expectedArtifactPaths = new Set();

  for (const entry of registry.connectors) {
    if (entry.artifactKind === "pdpp-collection-profile") {
      nextIndex.connectors[entry.id] = [materializePdppArtifact({
        entry,
        existingIndex,
        checkMode,
        allowUnpublishedRebuild,
        expectedArtifactPaths,
        releaseMetadata,
      })];
      continue;
    }
    const metadataPath = join(repoRoot, "connectors", entry.files.metadata);
    const scriptPath = join(repoRoot, "connectors", entry.files.script);
    const metadata = readJson(metadataPath);
    const manifestBuffer = readFileSync(metadataPath);
    const scriptBuffer = readFileSync(scriptPath);
    const previousVersions = existingIndex?.connectors?.[entry.id] ?? [];
    const existingVersion = previousVersions.find(
      (version) => version.version === entry.version,
    );

    if (existingVersion) {
      if (
        existingVersion.manifestSha256 !== sha256Buffer(manifestBuffer) ||
        existingVersion.scriptSha256 !== sha256Buffer(scriptBuffer)
      ) {
        throw new Error(
          `${entry.id}@${entry.version} source changed without a version bump`,
        );
      }
      if (!existingVersion.artifactPath) {
        throw new Error(`${entry.id}@${entry.version} is missing artifactPath`);
      }
      const existingArtifactPath = join(repoRoot, existingVersion.artifactPath);
      if (!existsSync(existingArtifactPath)) {
        throw new Error(`Missing artifact: ${existingVersion.artifactPath}`);
      }
      if (
        existingVersion.artifactSha256 !==
        sha256Buffer(readFileSync(existingArtifactPath))
      ) {
        throw new Error(`${entry.id}@${entry.version} immutable artifact drifted`);
      }
      assertBundledScopeSchemasMatch({
        artifactPath: existingArtifactPath,
        manifestPath: metadataPath,
      });
      expectedArtifactPaths.add(existingVersion.artifactPath);
      const preservedVersion = shouldUseReleaseAssets
        ? refreshReleaseDistributionMetadata(existingVersion, releaseMetadata)
        : existingVersion;
      // Retained (superseded) versions must flow through
      // materializeRetainedArtifact on every release-assets publish, not only
      // on the publish that bumps the connector: the committed index carries
      // no artifactSignature, so a verbatim carry ships entries the installer
      // cannot verify (the 2026-07-13 index outage).
      const carriedVersions = [];
      for (const version of previousVersions) {
        if (version.version === entry.version) {
          carriedVersions.push(preservedVersion);
          continue;
        }
        const materialized = await materializeRetainedArtifact({
          entry: version,
          releaseMetadata,
          expectedArtifactPaths,
          checkMode,
        });
        if (materialized) {
          carriedVersions.push(materialized);
        }
      }
      nextIndex.connectors[entry.id] = carriedVersions;
      continue;
    }

    const bundle = createArtifactBundle(entry, metadata);
    const artifactDir = join(artifactsDir, entry.id);
    mkdirSync(artifactDir, { recursive: true });
    const artifactFilename = `${entry.id}-${entry.version}.tgz`;
    const artifactPath = join(artifactDir, artifactFilename);
    const tempArtifactPath = join(dirname(bundle.bundleDir), artifactFilename);

    execFileSync("tar", [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--pax-option=delete=atime,delete=ctime",
      "-I",
      "gzip -n",
      "-cf",
      tempArtifactPath,
      "-C",
      bundle.bundleDir,
      ".",
    ]);

    const artifactBuffer = readFileSync(tempArtifactPath);

    const packaged = {
      connectorId: entry.id,
      company: entry.company,
      version: entry.version,
      name: entry.name,
      status: entry.status,
      description: entry.description,
      sourceFiles: entry.files,
      publishedAt:
        entry.publishedAt ?? entry.lastUpdated ?? registry.lastUpdated,
      sourceTag: entry.sourceTag ?? entry.gitRef ?? sourceTag,
      sourceCommit: entry.sourceCommit ?? entry.gitRef ?? sourceCommit,
      releaseId: entry.releaseId ?? releaseMetadata.releaseId,
      pageApiVersion: metadata.page_api_version,
      manifestSha256: sha256Buffer(manifestBuffer),
      scriptSha256: sha256Buffer(scriptBuffer),
      // In check mode, reuse the committed artifact checksum instead of
      // recomputing it. Tarball bytes are not reproducible across Node/tar
      // versions even with --sort=name --mtime=@0 flags, so recomputing
      // causes spurious drift detection in CI.
      artifactSha256: checkMode
        ? (existingIndex?.connectors?.[entry.id]?.find(
            (v) => v.version === entry.version,
          )?.artifactSha256 ?? sha256Buffer(artifactBuffer))
        : sha256Buffer(artifactBuffer),
      artifactPath: artifactPath.slice(repoRoot.length + 1),
      artifactUrl: buildArtifactUrl({
        artifactRelativePath: artifactPath.slice(repoRoot.length + 1),
        releaseTag: releaseMetadata.releaseTag,
        repo: releaseMetadata.repo,
        sourceCommit,
      }),
      ...(buildSigstoreBundleMetadata(
        `${artifactFilename}.sigstore.json`,
        buildArtifactUrl({
          artifactRelativePath: `${artifactPath.slice(repoRoot.length + 1)}.sigstore.json`,
          releaseTag: releaseMetadata.releaseTag,
          repo: releaseMetadata.repo,
          sourceCommit,
        }),
      )
        ? {
            artifactSignature: buildSigstoreBundleMetadata(
              `${artifactFilename}.sigstore.json`,
              buildArtifactUrl({
                artifactRelativePath: `${artifactPath.slice(repoRoot.length + 1)}.sigstore.json`,
                releaseTag: releaseMetadata.releaseTag,
                repo: releaseMetadata.repo,
                sourceCommit,
              }),
            ),
          }
        : {}),
      scopes: (metadata.scopes ?? []).map((scopeEntry) =>
        typeof scopeEntry === "string" ? scopeEntry : scopeEntry.scope,
      ),
      consumerMetadata: entry.consumerMetadata ?? null,
    };

    if (!checkMode) {
      writeFileSync(artifactPath, artifactBuffer);
    }

    expectedArtifactPaths.add(packaged.artifactPath);
    rmSync(dirname(bundle.bundleDir), { recursive: true, force: true });

    const retained = [];
    for (const version of previousVersions) {
      if (version.version === entry.version) {
        continue;
      }
      const materialized = await materializeRetainedArtifact({
        entry: version,
        releaseMetadata,
        expectedArtifactPaths,
        checkMode,
      });
      if (materialized) {
        retained.push(materialized);
      }
    }
    nextIndex.connectors[entry.id] = [...retained, packaged];
  }

  const normalizedIndex = sortIndex(nextIndex);
  // Publishing an entry without artifactSignature bricks every consumer's
  // install (the installer hard-fails on missing Sigstore metadata), so fail
  // the publish here instead of shipping a broken index.
  if (shouldEmitSignatureMetadata) {
    assertConnectorIndexSigned(normalizedIndex);
  }
  const nextText = `${JSON.stringify(normalizedIndex, null, 2)}\n`;
  const beforeText = existsSync(indexPath)
    ? readFileSync(indexPath, "utf8")
    : null;

  if (checkMode) {
    if (beforeText !== nextText) {
      throw new Error(
        "connector-index.json drift detected. Run `node scripts/generate-connector-index.mjs`.",
      );
    }

    for (const artifactPath of expectedArtifactPaths) {
      if (!existsSync(join(repoRoot, artifactPath))) {
        throw new Error(`Missing artifact: ${artifactPath}`);
      }
    }

    console.log("Connector index and artifacts are up to date.");
    return;
  }

  for (const file of walkFiles(artifactsDir)) {
    const repoRelativePath = `artifacts/${file.relativePath}`;
    if (!expectedArtifactPaths.has(repoRelativePath)) {
      unlinkSync(file.path);
    }
  }

  writeFileSync(indexPath, nextText);
  console.log(
    `Generated connector-index.json with ${Object.keys(normalizedIndex.connectors).length} connector entries.`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

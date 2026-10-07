#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Builds the release copy of `connector-index.json` for the legacy artifact
// lane: the index that `publish-connector-release-index.yml` signs and
// publishes to the `connectors-<sha12>` and `connectors-latest` GitHub
// releases, which the Vana Desktop installer and its in-app updater verify.
//
// The committed `connector-index.json` is a frozen public contract and is
// never rewritten here. For every entry whose tarball is committed under
// `artifacts/`, the release copy points `artifactUrl` at the release asset,
// stamps `releaseId`, and declares the sigstore bundle that will sit next to
// the asset. The tarball's digest must match the committed entry, or the
// build stops: a release never republishes bytes the index does not describe.
// Entries without a committed tarball (historical versions) are kept as
// committed, so consumers that pin them see the same record as before.
//
// Pure function first (`buildReleaseIndex`), thin CLI below it. The CLI reads
// the repository, writes `<output>/connector-index.json` and
// `<output>/published.json` (the assets this release carries, for the signer
// and the upload step), and prints what it kept verbatim.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "..");
export const INDEX_BUNDLE_PATH = "connector-index.json.sigstore.json";
const RELEASE_TAG = /^connectors-[a-f0-9]{12}$/;
const RELEASE_ID = /^github-[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

/**
 * Returns `{ doc, published, retained }`.
 *
 * - `doc`: the release index.
 * - `published`: `[{ connectorId, version, artifactPath, assetName }]` for
 *   every entry whose tarball exists under `artifactsRoot`; these are signed
 *   and uploaded.
 * - `retained`: `[{ connectorId, version, artifactPath }]` for entries kept
 *   verbatim because their tarball is not committed.
 *
 * `readArtifact(artifactPath)` returns the tarball bytes or `null`; it is
 * injectable for tests.
 */
export function buildReleaseIndex({
  index,
  releaseTag,
  releaseId,
  repository,
  generatedAt = new Date().toISOString(),
  readArtifact,
}) {
  if (!RELEASE_TAG.test(releaseTag ?? "")) throw new Error(`release tag must be connectors-<sha12>, got ${JSON.stringify(releaseTag)}`);
  if (!RELEASE_ID.test(releaseId ?? "")) throw new Error(`release id must be github-<sha40>, got ${JSON.stringify(releaseId)}`);
  if (!REPOSITORY.test(repository ?? "")) throw new Error(`repository must be owner/name, got ${JSON.stringify(repository)}`);
  if (!index || typeof index.connectors !== "object" || Array.isArray(index.connectors)) {
    throw new Error("connector-index.json: connectors must be an object keyed by connector id");
  }
  if (typeof readArtifact !== "function") throw new Error("readArtifact is required");

  const assetBase = `https://github.com/${repository}/releases/download/${releaseTag}`;
  const published = [];
  const retained = [];
  const connectors = {};

  for (const connectorId of Object.keys(index.connectors).sort((a, b) => a.localeCompare(b))) {
    const entries = index.connectors[connectorId];
    if (!Array.isArray(entries)) throw new Error(`${connectorId}: versions must be an array`);
    connectors[connectorId] = entries
      .map((entry) => {
        if (entry.connectorId !== connectorId) {
          throw new Error(`${connectorId}: entry declares connectorId ${JSON.stringify(entry.connectorId)}`);
        }
        const artifactPath = entry.artifactPath;
        const bytes = artifactPath ? readArtifact(artifactPath) : null;
        if (!bytes) {
          retained.push({ connectorId, version: entry.version, artifactPath: artifactPath ?? null });
          return { ...entry };
        }
        const digest = sha256(bytes);
        if (digest !== entry.artifactSha256) {
          throw new Error(
            `${connectorId}@${entry.version}: ${artifactPath} is ${digest}, connector-index.json says ${entry.artifactSha256}`,
          );
        }
        const assetName = basename(artifactPath);
        if (published.some((candidate) => candidate.assetName === assetName)) {
          throw new Error(`${connectorId}@${entry.version}: asset name ${assetName} is not unique in this release`);
        }
        published.push({ connectorId, version: entry.version, artifactPath, assetName });
        const artifactUrl = `${assetBase}/${assetName}`;
        return {
          ...entry,
          releaseId,
          artifactUrl,
          artifactSignature: {
            type: "sigstoreBundle",
            bundlePath: `${assetName}.sigstore.json`,
            bundleUrl: `${artifactUrl}.sigstore.json`,
          },
        };
      })
      .sort((a, b) => compareVersions(a.version, b.version));
  }

  const doc = {
    indexVersion: index.indexVersion ?? "2.0",
    sourceRepo: index.sourceRepo ?? `https://github.com/${repository}`,
    generatedAt,
    brandIcons: index.brandIcons ?? {},
    // The index is served from two releases (`connectors-<sha12>` and
    // `connectors-latest`), which the workflow updates one after the other.
    // An absolute bundleUrl into the immutable release keeps a reader that
    // spans the two uploads, or sees a half-finished one, on one generation.
    signature: {
      type: "sigstoreBundle",
      bundlePath: INDEX_BUNDLE_PATH,
      bundleUrl: `${assetBase}/${INDEX_BUNDLE_PATH}`,
    },
    connectors,
  };
  return { doc, published, retained };
}

export function repositoryArtifactReader(root = repositoryRoot) {
  return (artifactPath) => {
    if (artifactPath.startsWith("/") || artifactPath.split("/").includes("..")) {
      throw new Error(`refusing artifact path outside the repository: ${artifactPath}`);
    }
    const path = join(root, artifactPath);
    return existsSync(path) ? readFileSync(path) : null;
  };
}

function main() {
  const sha = process.env.CONNECTOR_SOURCE_COMMIT?.trim() || process.env.GITHUB_SHA?.trim();
  if (!sha) throw new Error("CONNECTOR_SOURCE_COMMIT or GITHUB_SHA is required");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("source commit must be an exact 40-character git SHA");
  // Same-SHA retries must sign identical index bytes, independent of run time.
  const commitTime = execFileSync("git", ["show", "-s", "--format=%ct", sha], { cwd: repositoryRoot, encoding: "utf8" }).trim();
  const generatedAt = new Date(Number(commitTime) * 1000).toISOString();
  const releaseTag = process.env.CONNECTOR_RELEASE_TAG?.trim() || `connectors-${sha.slice(0, 12)}`;
  const releaseId = process.env.CONNECTOR_RELEASE_ID?.trim() || `github-${sha}`;
  const repository = process.env.GITHUB_REPOSITORY?.trim() || "PDP-Connect/data-connectors";
  const output = resolve(process.env.CONNECTOR_RELEASE_OUTPUT?.trim() || join(repositoryRoot, "release"));

  const index = JSON.parse(readFileSync(join(repositoryRoot, "connector-index.json"), "utf8"));
  const { doc, published, retained } = buildReleaseIndex({
    index,
    releaseTag,
    releaseId,
    repository,
    generatedAt,
    readArtifact: repositoryArtifactReader(),
  });

  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "connector-index.json"), `${JSON.stringify(doc, null, 2)}\n`);
  writeFileSync(join(output, "published.json"), `${JSON.stringify({ releaseTag, releaseId, published }, null, 2)}\n`);
  console.log(`[build-connector-release-index] ${releaseTag}: ${published.length} artifact(s) published, ${retained.length} entr(y|ies) retained as committed.`);
  for (const entry of retained) {
    console.log(`  retained ${entry.connectorId}@${entry.version} (${entry.artifactPath ?? "no artifactPath"})`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[build-connector-release-index] ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

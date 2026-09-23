#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Select connectors whose shipped content changed in a push to main, then
 * keep only versions whose GHCR reference is definitely absent.
 *
 * The source-side decision is deliberately based on both version-bearing
 * representations. A manifest is the authoring source, while the generated
 * package connector-index.json is the file consumers install from. If they do
 * not agree at either endpoint, this script refuses instead of publishing a
 * version whose source and generated index disagree.
 *
 * The registry-side decision reuses lookup-manifest.mjs. Its `unknown` result
 * is a refusal to decide, not evidence of absence, so only `absent` reaches the
 * output matrix. This script never publishes; it only emits the matrix that a
 * later, main-ref-gated job may publish.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { artifactInputHash, ArtifactInputError } from "./connector-artifact-inputs.mjs";
import { PUBLISHABLE_CONNECTORS } from "./connector-publish-allowlist.mjs";
import { lookupManifest } from "./lookup-manifest.mjs";

const MANIFEST_ROOT = "connectors";
const INDEX_PATH = "connector-implementation-index.json";
const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/i;

export class PublishSelectionError extends Error {}

function readJsonAtCommit(commit, relativePath, { cwd = process.cwd() } = {}) {
  if (commit === null || ZERO_SHA.test(commit)) return null;
  if (!SHA.test(commit)) {
    throw new PublishSelectionError(`invalid commit '${commit}'`);
  }

  let text;
  try {
    text = execFileSync("git", ["show", `${commit}:${relativePath}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr?.trim() || error.message;
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
    throw new PublishSelectionError(`cannot read ${relativePath} at ${commit}: ${stderr}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new PublishSelectionError(
      `${relativePath} at ${commit} is not valid JSON: ${error.message}`,
    );
  }
}

function versionFromManifest(manifest, label) {
  if (manifest === null) return null;
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new PublishSelectionError(`${label} declares no version string`);
  }
  return manifest.version;
}

function versionFromIndex(index, connectorKey, label) {
  if (index === null) return null;
  if (!Array.isArray(index.connectors)) {
    throw new PublishSelectionError(`${label} has no connectors array`);
  }

  const matches = index.connectors.filter(
    (entry) => entry?.manifest?.connector_key === connectorKey,
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new PublishSelectionError(
      `${label} has multiple entries for connector '${connectorKey}'`,
    );
  }

  const version = matches[0].manifest?.version;
  if (typeof version !== "string" || version === "") {
    throw new PublishSelectionError(
      `${label} entry for '${connectorKey}' declares no version string`,
    );
  }
  return version;
}

function readCommitVersions(commit, connectors, { cwd = process.cwd() } = {}) {
  const index = readJsonAtCommit(commit, INDEX_PATH, { cwd });
  return new Map(
    connectors.map(({ manifest, connectorKey }) => {
      const manifestPath = `${MANIFEST_ROOT}/${manifest}/manifest.json`;
      const manifestDoc = readJsonAtCommit(commit, manifestPath, { cwd });
      const manifestVersion = versionFromManifest(manifestDoc, `${manifestPath} at ${commit}`);
      const indexVersion = versionFromIndex(
        index,
        connectorKey,
        `${INDEX_PATH} at ${commit}`,
      );
      if (manifestVersion !== indexVersion) {
        throw new PublishSelectionError(
          `${connectorKey} at ${commit} has manifest version ${JSON.stringify(manifestVersion)} ` +
            `but connector-index.json version ${JSON.stringify(indexVersion)}`,
        );
      }
      return [connectorKey, manifestVersion];
    }),
  );
}

/**
 * Return connectors with changed shipped content after refusing a content
 * change that would overwrite an existing version. The index is still a
 * consistency gate, not an artifact input.
 */
function isFirstRootLayoutTransition(before, after, cwd) {
  return Boolean(before && before !== after &&
    readJsonAtCommit(before, "packages/polyfill-connectors/connector-index.json", { cwd }) !== null &&
    readJsonAtCommit(after, INDEX_PATH, { cwd }) !== null);
}

export function selectChangedConnectors({
  before,
  after,
  cwd = process.cwd(),
  connectors = PUBLISHABLE_CONNECTORS,
}) {
  if (!after) throw new PublishSelectionError("after commit is not set");
  if (isFirstRootLayoutTransition(before, after, cwd)) {
    // Exactly one main transition can satisfy this: subsequent commits have
    // no old package index at `before`. Keep the layout move green without
    // silently publishing every moved connector as a new release.
    return [];
  }
  const beforeVersions = readCommitVersions(before ?? null, connectors, { cwd });
  const afterVersions = readCommitVersions(after, connectors, { cwd });

  return connectors.flatMap(({ manifest, connectorKey }) => {
    const beforeVersion = beforeVersions.get(connectorKey);
    const afterVersion = afterVersions.get(connectorKey);
    if (afterVersion === null) return [];

    if (beforeVersion === afterVersion) {
      let beforeHash;
      let afterHash;
      try {
        beforeHash = artifactInputHash({ commit: before, manifest, cwd });
        afterHash = artifactInputHash({ commit: after, manifest, cwd });
      } catch (error) {
        if (error instanceof ArtifactInputError) {
          throw new PublishSelectionError(error.message);
        }
        throw error;
      }
      if (beforeHash !== afterHash) {
        throw new PublishSelectionError(
          `${connectorKey} shipped artifact content changed without a version bump; bump the manifest and connector-index.json version before publishing`,
        );
      }
      return [];
    }
    return [{ connector: connectorKey, manifest, version: afterVersion }];
  });
}

function connectorReference(owner, connector, version) {
  return {
    registry: "ghcr.io",
    name: `${owner}/connector/${connector}`,
    tag: version,
  };
}

/**
 * Keep only candidates whose exact version reference is definitely absent.
 * `lookup` is injectable so the selection policy can be tested without a
 * registry or credentials.
 */
export async function filterAbsentVersions(
  candidates,
  {
    owner,
    credential,
    lookup = lookupManifest,
    notice = (message) => console.log(`::notice::${message}`),
  } = {},
) {
  if (typeof owner !== "string" || owner === "") {
    throw new PublishSelectionError("repository owner is not set");
  }

  const selected = [];
  for (const candidate of candidates) {
    const reference = connectorReference(owner, candidate.connector, candidate.version);
    const result = await lookup({ ...reference, credential });
    if (result?.outcome === "absent") {
      selected.push(candidate);
      continue;
    }

    if (result?.outcome === "present") {
      notice(
        `Skipping ${candidate.connector}@${candidate.version}: ` +
          `${reference.registry}/${reference.name}:${reference.tag} is already present in GHCR` +
          `${result.digest ? ` as ${result.digest}` : ""}.`,
      );
      continue;
    }

    notice(
      `Skipping ${candidate.connector}@${candidate.version}: GHCR lookup is unknown` +
        `${result?.reason ? ` (${result.reason})` : ""}; it will not be published blindly.`,
    );
  }
  return selected;
}

function emit(outputs) {
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  } else {
    process.stdout.write(text);
  }
}

function notice(message) {
  const line = `::notice::${message}`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `> ${message}\n`);
  }
}

async function main() {
  const firstLayoutTransition = isFirstRootLayoutTransition(
    process.env.BEFORE_SHA ?? null,
    process.env.AFTER_SHA,
    process.cwd(),
  );
  const candidates = selectChangedConnectors({
    before: process.env.BEFORE_SHA ?? null,
    after: process.env.AFTER_SHA,
  });
  if (candidates.length === 0) {
    notice(firstLayoutTransition
      ? "First root-layout move: automatic connector publication is skipped. Release individual versioned connectors explicitly after consumer activation review."
      : `No connector version changed and no shipped connector content changed between ${process.env.BEFORE_SHA} and ${process.env.AFTER_SHA}; nothing to publish.`);
    emit({
      matrix: JSON.stringify({ include: [] }),
      "has-version-changes": "false",
      "has-publishable-changes": "false",
    });
    return;
  }

  const username = process.env.LOOKUP_USERNAME ?? "";
  const password = process.env.LOOKUP_PASSWORD ?? "";
  const credential = password
    ? Buffer.from(`${username}:${password}`).toString("base64")
    : undefined;
  const selected = await filterAbsentVersions(candidates, {
    owner: (process.env.GITHUB_REPOSITORY_OWNER ?? "").toLowerCase(),
    credential,
    notice,
  });
  if (selected.length === 0) {
    notice("No changed connector version has a definite GHCR absence; nothing to publish.");
  } else {
    notice(`Selected ${selected.length} changed connector version${selected.length === 1 ? "" : "s"} for publication.`);
  }
  emit({
    matrix: JSON.stringify({ include: selected }),
    "has-version-changes": "true",
    "has-publishable-changes": selected.length > 0 ? "true" : "false",
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    console.error(`publish selection refused: ${error.message}`);
    process.exit(1);
  });
}

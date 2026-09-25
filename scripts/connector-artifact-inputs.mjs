// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_ROOT = "packages/polyfill-connectors";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const SHARED_ARTIFACT_INPUTS = [
	"LICENSE",
	"NOTICE",
	"package.json",
	"package-lock.json",
	`${PACKAGE_ROOT}/package.json`,
	`${PACKAGE_ROOT}/package-lock.json`,
	"scripts/build-connector-oci-artifact.mjs",
	"scripts/connector-host-runtime-contract.mjs",
	// The source declaration: its builder and validator, the pinned contract they
	// check against, and the allowlist that decides which manifests share it.
	"packages/connector-installer-core/package.json",
	"packages/connector-installer-core/source-declaration.mjs",
	"packages/connector-installer-core/pdpp-source-contract.mjs",
	"scripts/connector-publish-allowlist.mjs",
	"scripts/source-declaration-members.mjs",
	"vendor/pdpp-reference-contract/source.ts",
];
const STATIC_LOCAL_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^\n]*\n)*?[^\n]*?\sfrom\s*(["'])(\.{1,2}\/[^"]*?)\1/gm;
const SIDE_EFFECT_LOCAL_IMPORT = /^\s*import\s*(["'])(\.{1,2}\/[^"]*?)\1/gm;
const DYNAMIC_LOCAL_IMPORT = /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"]*?)\1/g;

export class ArtifactInputError extends Error {}

function readFileAtCommit(commit, path, { cwd }) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim() || error.message;
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
    throw new ArtifactInputError(`cannot read ${path} at ${commit}: ${stderr}`);
  }
}

function localImportSpecifiers(source) {
  const text = source.toString();
  return [
    ...text.matchAll(STATIC_LOCAL_IMPORT),
    ...text.matchAll(SIDE_EFFECT_LOCAL_IMPORT),
    ...text.matchAll(DYNAMIC_LOCAL_IMPORT),
  ].map((match) => match[2]);
}

function candidatePaths(from, specifier) {
  const resolved = posix.normalize(posix.join(posix.dirname(from), specifier));
  const extension = posix.extname(resolved);
  if (!extension) {
    return [
      ...SOURCE_EXTENSIONS.map((suffix) => `${resolved}${suffix}`),
      ...SOURCE_EXTENSIONS.map((suffix) => `${resolved}/index${suffix}`),
    ];
  }
  const sourceExtension = extension === ".js" ? ".ts" : extension === ".mjs" ? ".mts" : extension;
  return [resolved, `${resolved.slice(0, -extension.length)}${sourceExtension}`];
}

function resolveLocalImport(commit, from, specifier, options) {
  for (const path of candidatePaths(from, specifier)) {
    if (readFileAtCommit(commit, path, options) !== null) return path;
  }
  throw new ArtifactInputError(
    `cannot resolve local import ${JSON.stringify(specifier)} from ${from} at ${commit}; refusing to compare incomplete artifact inputs`,
  );
}

function addLocalImportClosure(commit, entryPath, files, options) {
  const pending = [entryPath];
  while (pending.length) {
    const path = pending.pop();
    if (files.has(path)) continue;
    const source = readFileAtCommit(commit, path, options);
    if (source === null) {
      throw new ArtifactInputError(`cannot read local artifact input ${path} at ${commit}`);
    }
    files.set(path, source);
    for (const specifier of localImportSpecifiers(source)) {
      pending.push(resolveLocalImport(commit, path, specifier, options));
    }
  }
}

async function publishInventoryAtCommit(commit, options) {
  const path = "scripts/connector-publish-allowlist.mjs";
  const allowlist = readFileAtCommit(commit, path, options);
  if (allowlist === null) throw new ArtifactInputError(`cannot read ${path} at ${commit}`);
  const dir = mkdtempSync(join(tmpdir(), "connector-publish-allowlist-"));
  try {
    const file = join(dir, "connector-publish-allowlist.mjs");
    writeFileSync(file, allowlist);
    return (await import(pathToFileURL(file).href)).CONNECTOR_PUBLISH_INVENTORY;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The other manifests at `commit` that share `profile`'s source declaration,
 * with the same membership rule as source-declaration-members.mjs, read from
 * the allowlist at that commit. A change to any member changes the
 * declaration every member ships, so it must select every member. A sibling's
 * `version` is not declaration content, so it is left out: a sibling's release
 * does not force this artifact to release.
 */
async function declarationSiblingInputs(commit, profile, options) {
  const inventory = await publishInventoryAtCommit(commit, options);
  const own = inventory.find(({ connectorKey }) => connectorKey === profile.connector_key);
  if (!own || own.exclusionReason !== null) return [];
  const inputs = [];
  for (const { manifest, connectorKey, exclusionReason } of inventory) {
    if (exclusionReason !== null || connectorKey === profile.connector_key) continue;
    const path = `connectors/${manifest}/manifest.json`;
    const bytes = readFileAtCommit(commit, path, options);
    if (bytes === null) throw new ArtifactInputError(`cannot read member manifest ${path} at ${commit}`);
    let member;
    try {
      member = JSON.parse(bytes);
    } catch (error) {
      throw new ArtifactInputError(`cannot parse manifest ${path} at ${commit}: ${error.message}`);
    }
    if (member.source?.id !== profile.source?.id) continue;
    const { version: _version, ...declared } = member;
    inputs.push([`${path}#declaration-member`, Buffer.from(JSON.stringify(declared))]);
  }
  return inputs;
}

/**
 * Hash the repository inputs that affect one connector artifact. Commit
 * metadata is intentionally excluded: it is provenance, not authored content,
 * and would make every unrelated commit select every connector.
 */
export async function artifactInputHash({ commit, manifest, cwd = process.cwd() }) {
  const options = { cwd };
  const files = new Map();
  for (const path of SHARED_ARTIFACT_INPUTS) {
    const content = readFileAtCommit(commit, path, options);
    if (content === null) {
      throw new ArtifactInputError(`cannot read shared artifact input ${path} at ${commit}`);
    }
    files.set(path, content);
  }

  const manifestPath = `connectors/${manifest}/manifest.json`;
  const manifestBytes = readFileAtCommit(commit, manifestPath, options);
  if (manifestBytes === null) {
    throw new ArtifactInputError(`cannot read manifest ${manifestPath} at ${commit}`);
  }
  files.set(manifestPath, manifestBytes);
  let profile;
  try {
    profile = JSON.parse(manifestBytes);
  } catch (error) {
    throw new ArtifactInputError(`cannot parse manifest ${manifestPath} at ${commit}: ${error.message}`);
  }
  if (profile.brand?.icon) {
    const iconPath = `connectors/${manifest}/${profile.brand.icon}`;
    const iconBytes = readFileAtCommit(commit, iconPath, options);
    if (iconBytes === null) {
      throw new ArtifactInputError(`cannot read manifest-declared icon ${iconPath} at ${commit}`);
    }
    files.set(iconPath, iconBytes);
  }
  for (const [path, bytes] of await declarationSiblingInputs(commit, profile, options)) {
    files.set(path, bytes);
  }
  addLocalImportClosure(commit, `connectors/${manifest}/index.ts`, files, options);

  const hash = createHash("sha256");
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

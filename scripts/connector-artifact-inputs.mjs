// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { posix } from "node:path";

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

/**
 * Hash the repository inputs that affect one connector artifact. Commit
 * metadata is intentionally excluded: it is provenance, not authored content,
 * and would make every unrelated commit select every connector.
 */
export function artifactInputHash({ commit, manifest, cwd = process.cwd() }) {
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
  addLocalImportClosure(commit, `connectors/${manifest}/index.ts`, files, options);

  const hash = createHash("sha256");
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

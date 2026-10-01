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
	// check against. The allowlist that decides which manifests share it is
	// hashed per source; see sourceSliceInputs.
	"packages/connector-installer-core/package.json",
	"packages/connector-installer-core/source-declaration.mjs",
	"packages/connector-installer-core/pdpp-source-contract.mjs",
	"scripts/source-declaration-members.mjs",
	"vendor/pdpp-reference-contract/source.ts",
];
// Inputs added with the source declaration layer. A commit before that layer
// lacks them, and comparing against it must still work.
const OPTIONAL_SHARED_ARTIFACT_INPUTS = new Set([
	"packages/connector-installer-core/source-declaration.mjs",
	"packages/connector-installer-core/pdpp-source-contract.mjs",
	"scripts/source-declaration-members.mjs",
	"vendor/pdpp-reference-contract/source.ts",
]);
const PAGE_SHIM_SHARED_INPUTS = [
	"scripts/pageshim/attach-to-artifact.mjs",
	"scripts/pageshim/build.mjs",
	"scripts/pageshim/runtime.ts",
	"scripts/pageshim/shims/anthropic-export.ts",
	"scripts/pageshim/shims/buffer.js",
	"scripts/pageshim/shims/path.js",
	"scripts/pageshim/shims/process.js",
	"scripts/pageshim/shims/url.js",
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

function artifactInputContent(path, content) {
  if (path !== "package.json" || content === null) return content;
  const packageMetadata = JSON.parse(content.toString("utf8"));
  delete packageMetadata.scripts;
  return Buffer.from(JSON.stringify(packageMetadata));
}

function pageShimBuilderInput(content, connectorKey) {
  if (connectorKey === "chatgpt" || connectorKey === "anthropic") return content;
  const source = content
    .toString("utf8")
    .replace(/^\tsinceDays = 0,\r?\n/gm, "")
    .replace(/^\tif \(!Number\.isSafeInteger\(sinceDays\) \|\| sinceDays < 0\) \{\r?\n\t\tthrow new Error\("sinceDays must be a non-negative integer"\);\r?\n\t\}\r?\n/gm, "")
    .replace(/^\t\t\tPAGESHIM_SINCE_DAYS: String\(sinceDays\),\r?\n/gm, "")
    .replace(/^\t\t\t"since-days": \{ type: "string" \},\r?\n/gm, "")
    .replace(/^\t\tsinceDays: values\["since-days"\] \? Number\(values\["since-days"\]\) : 0,\r?\n/gm, "");
  return Buffer.from(source);
}

function pageShimRuntimeInput(content, connectorKey) {
  if (connectorKey === "chatgpt" || connectorKey === "anthropic") return content;
  const source = content
    .toString("utf8")
    .replace("\t/** Fixed, opt-in lookback window embedded in this bundle. */\n\tsinceDays?: number;\n", "")
    .replace(/\tconst windowSince =\n\t\tconnector\.sinceDays && connector\.sinceDays > 0\n\t\t\t\? new Date\(Date\.now\(\) - connector\.sinceDays \* 86_400_000\)\.toISOString\(\)\n\t\t\t: undefined;\n/, "")
    .replace("\t\t\t\t\t...(windowSince ? { time_range: { since: windowSince } } : {}),\n", "")
    .replace(/\t\tif \(windowSince\) \{\n\t\t\tconst hasRecords = Object\.values\(streamCounts\)\.some\(\(count\) => count > 0\);\n\t\t\terrors\.push\(\{\n\t\t\t\terrorClass: "partial",\n\t\t\t\treason: "time_window",\n\t\t\t\tdisposition: hasRecords \? "degraded" : "omitted",\n\t\t\t\tphase: "collect",\n\t\t\t\}\);\n\t\t\}\n/, "")
    .replace(/\t{4}const metadata = \{\n[\s\S]*?\n\t{4}\};\n/, "")
    .replaceAll("exportSummary: metadata,", "exportSummary,")
    .replaceAll("metadata.count", "exportSummary.count")
    .replaceAll("metadata.label", "exportSummary.label")
    .replace(/\t{2}if \(windowSince\) \{\n[\s\S]*?\n\t{2}\}\n/, "");
  return Buffer.from(source);
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

function addLocalImportClosure(commit, entryPath, files, options, excluded = new Set()) {
  const pending = [entryPath];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path) || excluded.has(path)) continue;
    visited.add(path);
    let source = files.get(path);
    if (source === undefined) {
      source = readFileAtCommit(commit, path, options);
      if (source === null) {
        throw new ArtifactInputError(`cannot read local artifact input ${path} at ${commit}`);
      }
      files.set(path, source);
    }
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

async function pageShimEligibilityAtCommit(commit, profile, options) {
	const path = "scripts/pageshim/capabilities.mjs";
	const source = readFileAtCommit(commit, path, options);
	if (source === null) return Buffer.from("\0absent");
	const dir = mkdtempSync(join(tmpdir(), "pageshim-capabilities-"));
	try {
		const modulePath = join(dir, "capabilities.mjs");
		writeFileSync(modulePath, source);
		const { isPageShimCapable } = await import(
			`${pathToFileURL(modulePath).href}?commit=${encodeURIComponent(commit)}`
		);
		if (typeof isPageShimCapable !== "function") {
			throw new ArtifactInputError(`${path} at ${commit} does not export isPageShimCapable`);
		}
		return Buffer.from(isPageShimCapable(profile) ? "eligible" : "ineligible");
	} catch (error) {
		if (error instanceof ArtifactInputError) throw error;
		throw new ArtifactInputError(`cannot determine PageShim eligibility at ${commit}: ${error.message}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function readManifestAtCommit(commit, path, options) {
  const bytes = readFileAtCommit(commit, path, options);
  if (bytes === null) throw new ArtifactInputError(`cannot read manifest ${path} at ${commit}`);
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new ArtifactInputError(`cannot parse manifest ${path} at ${commit}: ${error.message}`);
  }
}

function sourceDeclarationMember(member) {
  return {
    source: {
      id: member.source?.id,
      display: { name: member.source?.display?.name },
    },
    streams: (member.streams ?? []).map((stream) => ({
      ...(stream.description !== undefined ? { description: stream.description } : {}),
      ...(stream.display !== undefined ? { display: stream.display } : {}),
      ...(stream.cursor_field !== undefined ? { cursor_field: stream.cursor_field } : {}),
      ...(stream.consent_time_field !== undefined ? { consent_time_field: stream.consent_time_field } : {}),
      name: stream.name,
      primary_key: stream.primary_key,
      ...(stream.query !== undefined ? { query: stream.query } : {}),
      ...(stream.relationships !== undefined ? { relationships: stream.relationships } : {}),
      schema: stream.schema,
      selection: stream.selection,
      semantics: stream.semantics,
      ...(stream.views !== undefined ? { views: stream.views } : {}),
    })),
  };
}

/**
 * The allowlist data at `commit` that can affect `profile`'s artifact: the
 * rows of every connector with the same `source.id`, and the manifests of the
 * publishable ones. Membership follows source-declaration-members.mjs. A
 * change to a member changes the declaration every member ships, so it must
 * select every member. Rows for other sources, and the allowlist's comments
 * and formatting, are not inputs: adding a connector for a new source does not
 * change any existing artifact. A sibling's `version` is not declaration
 * content, so it is left out: a sibling's release does not force this
 * artifact to release.
 */
async function sourceSliceInputs(commit, profile, options) {
  const inventory = await publishInventoryAtCommit(commit, options);
  const ownRow = inventory.find(({ connectorKey }) => connectorKey === profile.connector_key);
  // An unlisted or excluded artifact declares its source alone.
  const declaresAlone = !ownRow || ownRow.exclusionReason !== null;
  const rows = [];
  const inputs = [];
  for (const { manifest, connectorKey, exclusionReason } of inventory) {
    const own = connectorKey === profile.connector_key;
    const path = `connectors/${manifest}/manifest.json`;
    const member = own ? profile : readManifestAtCommit(commit, path, options);
    if (member.source?.id !== profile.source?.id) continue;
    rows.push({ connectorKey, manifest, exclusionReason });
    if (own || declaresAlone || exclusionReason !== null) continue;
    inputs.push([
      `${path}#declaration-member`,
      Buffer.from(JSON.stringify(sourceDeclarationMember(member))),
    ]);
  }
  rows.sort((a, b) => a.connectorKey.localeCompare(b.connectorKey));
  inputs.push(["scripts/connector-publish-allowlist.mjs#source-slice", Buffer.from(JSON.stringify(rows))]);
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
    if (content === null && !OPTIONAL_SHARED_ARTIFACT_INPUTS.has(path)) {
      throw new ArtifactInputError(`cannot read shared artifact input ${path} at ${commit}`);
    }
    // An absent declaration input is a real prior state (before artifacts
    // carried a declaration); it hashes differently from any present file.
    // Root npm scripts are developer commands. They do not affect the bytes
    // shipped in a connector artifact, so they must not force every connector
    // to take a version bump when a convenience command is added.
    files.set(path, content === null ? Buffer.from("\0absent") : artifactInputContent(path, content));
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
  for (const [path, bytes] of await sourceSliceInputs(commit, profile, options)) {
    files.set(path, bytes);
  }
  addLocalImportClosure(commit, `connectors/${manifest}/index.ts`, files, options);

  // A PageShim bundle is a connector-specific artifact input. Detect it from
  // the entry file at the commit being compared so enabling a new target, and
  // edits to its entry/runtime/shims, select only the affected connector.
  const pageShimEntry = `scripts/pageshim/entries/${manifest}.ts`;
  const pageShimEntryBytes = readFileAtCommit(commit, pageShimEntry, options);
  if (pageShimEntryBytes !== null || profile.mobile?.pageshim) {
    // Capability policy is not shipped code. Hash only whether this profile
    // qualifies: expanding the host set must not look like a bundle change for
    // connectors that were already eligible, while a newly eligible profile
    // still changes identity because publish would add its first bundle.
    files.set(
      "scripts/pageshim/capabilities.mjs#eligibility",
      await pageShimEligibilityAtCommit(commit, profile, options),
    );
    for (const path of PAGE_SHIM_SHARED_INPUTS) {
      const content = readFileAtCommit(commit, path, options);
      // Older commits can contain PageShim entries without this OCI
      // packaging step; encode that prior state so it compares as a real
      // change when the first packaged bundle is introduced.
      if (content === null) files.set(path, Buffer.from("\0absent"));
      else addLocalImportClosure(commit, path, files, options, new Set(["scripts/pageshim/capabilities.mjs"]));
      if (path === "scripts/pageshim/build.mjs" && content !== null)
        files.set(path, pageShimBuilderInput(content, profile.connector_key));
      if (path === "scripts/pageshim/runtime.ts" && content !== null)
        files.set(path, pageShimRuntimeInput(content, profile.connector_key));
    }
    if (pageShimEntryBytes !== null) addLocalImportClosure(commit, pageShimEntry, files, options);
  }

  const hash = createHash("sha256");
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { build as buildEsbuild } from "esbuild";
import {
  CONSENT_AGGREGATE,
  CONSENT_RESOLUTION_MODULE,
  consentSlicePath,
  consentSliceProblem,
} from "./consent-slice-resolution.mjs";

// execFileSync defaults to a 1 MiB output buffer; connector-implementation-index.json
// alone passed that in October 2026, and git show then fails with ENOBUFS.
const GIT_SHOW_MAX_BUFFER = 64 * 1024 * 1024;

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
// Rendering policy for the consent slices, as it exists at the commit being
// compared. It decides whether a slice is current; it is not itself shipped,
// so the PageShim builder's import of it is not an artifact input. The slice
// bytes are what an artifact carries.
const CONSENT_SLICE_DIRECTORY = "packages/polyfill-connectors/src/generated/consent-time-fields";
const CONSENT_RUNTIME = "packages/polyfill-connectors/src/connector-runtime.ts";
const CONSENT_BUILDERS = ["scripts/build-connector-oci-artifact.mjs", "scripts/pageshim/build.mjs"];
const CONSENT_RENDERER = "packages/polyfill-connectors/scripts/consent-time-fields-render.mjs";
const STATIC_LOCAL_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^\n]*\n)*?[^\n]*?\sfrom\s*(["'])(\.{1,2}\/[^"]*?)\1/gm;
const SIDE_EFFECT_LOCAL_IMPORT = /^\s*import\s*(["'])(\.{1,2}\/[^"]*?)\1/gm;
const DYNAMIC_LOCAL_IMPORT = /\bimport\s*\(\s*(["'])(\.{1,2}\/[^"]*?)\1/g;

export class ArtifactInputError extends Error {}

const PORT_RESOLVER = "scripts/pageshim/port-profile.mjs";
const PORT_DIRECTORY = "scripts/pageshim/ports";
const CONNECTOR_PORT_INPUTS = new Set([
  "scripts/pageshim/shims/anthropic-export.ts",
  "scripts/pageshim/shims/buffer.js",
]);
async function selectedPortAtCommit(commit, connector, options) {
  const source = readPageShimFileAtCommit(commit, PORT_RESOLVER, options);
  if (source === null) {
    const profiles = execFileSync(
      "git",
      ["ls-tree", "-r", "--name-only", commit, "--", PORT_DIRECTORY],
      { cwd: options.cwd, encoding: "utf8", maxBuffer: GIT_SHOW_MAX_BUFFER },
    ).trim();
    if (profiles)
      throw new ArtifactInputError(
        "incomplete PageShim port layout: profiles exist without resolver at " +
          commit,
      );
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "pageshim-port-resolver-"));
  try {
    const path = join(dir, "port-profile.mjs");
    writeFileSync(path, source);
    const module = await import(pathToFileURL(path).href);
    if (typeof module.resolvePageShimPortProfile !== "function")
      throw new Error("missing resolver export");
    const selected = module.resolvePageShimPortProfile(connector, (path) =>
      readPageShimFileAtCommit(commit, path, options),
    );
    return { selected, source };
  } catch (error) {
    throw new ArtifactInputError(
      "invalid PageShim port profile at " + commit + ": " + error.message,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Physical port inputs must match the builder's regular-file policy. Keep this
// separate from the historical reader so legacy artifact identities stay stable.
function readPageShimFileAtCommit(commit, path, options) {
  let entry;
  try {
    entry = execFileSync(
      "git",
      [
        "--literal-pathspecs",
        "ls-tree",
        "--full-tree",
        "-z",
        commit,
        "--",
        path,
      ],
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: GIT_SHOW_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    throw new ArtifactInputError(
      `cannot inspect PageShim input ${path} at ${commit}: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
  if (!entry) return null;
  const match = /^(100644|100755) blob [0-9a-f]+\t([^\0]+)\0$/.exec(entry);
  if (!match || match[2] !== path) {
    throw new ArtifactInputError(
      `PageShim input ${path} at ${commit} is not a regular file (Git mode ${entry.slice(0, 6)})`,
    );
  }
  return readFileAtCommit(commit, path, options);
}

function readFileAtCommit(commit, path, { cwd }) {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd,
      encoding: "buffer",
      maxBuffer: GIT_SHOW_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr?.toString().trim() || error.message;
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
    throw new ArtifactInputError(`cannot read ${path} at ${commit}: ${stderr}`);
  }
}

// npm scripts in either package.json are developer and test commands. The
// artifact builder reads only dependencies and engines from them, so a new or
// changed script must not force every connector to take a version bump.
const SCRIPT_FREE_INPUTS = new Set(["package.json", `${PACKAGE_ROOT}/package.json`]);

function artifactInputContent(path, content) {
  const installerMetadata = path === "packages/connector-installer-core/package.json";
  if ((!SCRIPT_FREE_INPUTS.has(path) && !installerMetadata) || content === null) return content;
  const packageMetadata = JSON.parse(content.toString("utf8"));
  if (SCRIPT_FREE_INPUTS.has(path)) delete packageMetadata.scripts;
  // The polyfill package's exports map is its npm surface for hosts. Connectors
  // import its sources by relative path, so the bundler never resolves it.
  if (path === `${PACKAGE_ROOT}/package.json`) delete packageMetadata.exports;
  // npm's pack allowlist controls the installer tools package, not the OCI
  // connector builder. Retiring a tool-only file must not release every connector.
  if (path === "package.json" || installerMetadata) delete packageMetadata.files;
  return Buffer.from(JSON.stringify(packageMetadata));
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

function resolveLocalImport(commit, from, specifier, options, readFile = readFileAtCommit) {
  for (const path of candidatePaths(from, specifier)) {
    if (readFile(commit, path, options) !== null) return path;
  }
  throw new ArtifactInputError(
    `cannot resolve local import ${JSON.stringify(specifier)} from ${from} at ${commit}; refusing to compare incomplete artifact inputs`,
  );
}

function addLocalImportClosure(commit, entryPath, files, options, excluded = new Set(), remap = (path) => path, readFile = readFileAtCommit) {
  const pending = [remap(entryPath)];
  const visited = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (visited.has(path) || excluded.has(path)) continue;
    visited.add(path);
    let source = files.get(path);
    if (source === undefined) {
      source = readFile(commit, path, options);
      if (source === null) {
        throw new ArtifactInputError(`cannot read local artifact input ${path} at ${commit}`);
      }
      files.set(path, source);
    }
    for (const specifier of localImportSpecifiers(source)) {
      pending.push(remap(resolveLocalImport(commit, path, specifier, options, readFile)));
    }
  }
}

async function addEsbuildImportClosure(commit, entryPath, files, options, excluded = new Set(), remap = (path) => path) {
  const root = remap(entryPath);
  const repositoryRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: options.cwd,
    encoding: "utf8",
  }).trim();
  const loaderFor = (path) => {
    const extension = posix.extname(path);
    if ([".ts", ".mts", ".cts"].includes(extension)) return "ts";
    if (extension === ".tsx") return "tsx";
    if (extension === ".jsx") return "jsx";
    if (extension === ".json") return "json";
    return "js";
  };
  const plugin = {
    name: "commit-artifact-input-closure",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point")
          return { path: root, namespace: "commit-artifact-input" };
        if (args.namespace !== "commit-artifact-input") return undefined;
        if (!args.path.startsWith("./") && !args.path.startsWith("../"))
          return { path: args.path, external: true };
        const from = args.importer || root;
        const resolved = remap(resolveLocalImport(commit, from, args.path, options, readPageShimFileAtCommit));
        if (excluded.has(resolved)) return { path: args.path, external: true };
        return { path: resolved, namespace: "commit-artifact-input" };
      });
      build.onLoad({ filter: /.*/, namespace: "commit-artifact-input" }, (args) => {
        const content = readPageShimFileAtCommit(commit, args.path, options);
        if (content === null)
          return { errors: [{ text: `cannot read local artifact input ${args.path} at ${commit}` }] };
        files.set(args.path, content);
        return { contents: content, loader: loaderFor(args.path) };
      });
    },
  };
  await buildEsbuild({
    absWorkingDir: repositoryRoot,
    entryPoints: [root],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    logLevel: "silent",
    plugins: [plugin],
  });
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

async function consentRendererAtCommit(commit, options) {
  const source = readFileAtCommit(commit, CONSENT_RENDERER, options);
  if (source === null) {
    throw new ArtifactInputError(
      `cannot read ${CONSENT_RENDERER} at ${commit}; cannot tell whether the consent-time-field slice is current`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "consent-time-fields-render-"));
  try {
    const file = join(dir, "consent-time-fields-render.mjs");
    writeFileSync(file, source);
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A tree is either coherent legacy (no part of the slice layout) or the slice
 * layout. Without the resolution policy file, any other layout part (the
 * renderer, a slice, the bound identity in the runtime or aggregate, or a
 * builder that imports the policy or renderer) means a broken
 * checkout; hashing it as legacy would bundle the aggregate where the builders
 * cannot, so it is refused.
 */
function rejectPartialSliceLayout(commit, options) {
  const found = [];
  if (readFileAtCommit(commit, CONSENT_RENDERER, options) !== null) found.push(CONSENT_RENDERER);
  const slices = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "--", CONSENT_SLICE_DIRECTORY], {
    cwd: options.cwd,
    encoding: "utf8",
  }).trim();
  if (slices) found.push(`${slices.split("\n").length} file(s) under ${CONSENT_SLICE_DIRECTORY}`);
  for (const builder of CONSENT_BUILDERS) {
    const source = readFileAtCommit(commit, builder, options)?.toString() ?? "";
    if (source.includes("consent-slice-resolution") || source.includes("consent-time-fields-render")) {
      found.push(`${builder} imports the slice policy or renderer`);
    }
  }
  // The runtime and the aggregate carry the bound identity only in the slice layout.
  for (const path of [CONSENT_RUNTIME, CONSENT_AGGREGATE]) {
    if (readFileAtCommit(commit, path, options)?.toString().includes("CONSENT_BOUND_CONNECTOR")) {
      found.push(`${path} carries the bound identity`);
    }
  }
  if (found.length) {
    throw new ArtifactInputError(
      `incomplete consent-time-field slice layout at ${commit}: ${CONSENT_RESOLUTION_MODULE} is missing but ${found.join(", ")} present; restore the layout or remove all of it`,
    );
  }
}

/**
 * How a connector's import of the consent-time-field aggregate resolves at
 * `commit`, or null before the slice layout existed. The Core and PageShim
 * builders bundle the connector's own slice in its place
 * (scripts/consent-slice-resolution.mjs), so the hash covers that slice and
 * not the aggregate. A checkout that has the layout but lacks or has a stale
 * slice fails here; it never falls back to hashing the aggregate. A commit
 * before the layout still bundled the aggregate, so it keeps hashing it.
 */
async function consentSliceRemap(commit, manifest, profile, options) {
  if (readFileAtCommit(commit, CONSENT_RESOLUTION_MODULE, options) === null) {
    rejectPartialSliceLayout(commit, options);
    return null;
  }
  const slice = consentSlicePath(manifest);
  const { renderSlice } = await consentRendererAtCommit(commit, options);
  const expected = renderSlice(manifest, profile);
  let checked = false;
  return (path) => {
    if (path !== CONSENT_AGGREGATE) return path;
    if (!checked) {
      const problem = consentSliceProblem(slice, readFileAtCommit(commit, slice, options), expected);
      if (problem) throw new ArtifactInputError(`${problem} (at ${commit})`);
      checked = true;
    }
    return slice;
  };
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
  // Policy files exist only in the slice layout; absent, nothing is hashed for
  // them so a commit from before the layout keeps its identity.
  const consentRemap = await consentSliceRemap(commit, manifest, profile, options);
  if (consentRemap) {
    files.set(CONSENT_RESOLUTION_MODULE, readFileAtCommit(commit, CONSENT_RESOLUTION_MODULE, options));
  }
  addLocalImportClosure(commit, `connectors/${manifest}/index.ts`, files, options, new Set(), consentRemap ?? undefined);

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
    const physical = await selectedPortAtCommit(commit, manifest, options);
    const sharedInputs = physical
      ? PAGE_SHIM_SHARED_INPUTS.filter((path) => !CONNECTOR_PORT_INPUTS.has(path))
      : PAGE_SHIM_SHARED_INPUTS;
    if (physical) {
      files.set(PORT_RESOLVER, physical.source);
      files.set(
        physical.selected.path,
        readPageShimFileAtCommit(commit, physical.selected.path, options),
      );
      // Audited createHash resolution is dynamic in the builder, so its bytes
      // must remain shared even when no connector-specific export shim imports it.
      const portFiles = new Map();
      addLocalImportClosure(
        commit,
        "scripts/pageshim/shims/crypto.js",
        portFiles,
        options,
        new Set(),
        consentRemap ?? undefined,
        readPageShimFileAtCommit,
      );
      if (!physical.selected.empty) {
        for (const path of [
          physical.selected.shim,
          ...physical.selected.inject,
        ]) {
          await addEsbuildImportClosure(
            commit,
            path,
            portFiles,
            options,
            new Set(["scripts/pageshim/capabilities.mjs", CONSENT_RENDERER]),
            consentRemap ?? undefined,
          );
        }
      }
      for (const [path, content] of portFiles) files.set(path, content);
    }
    for (const path of sharedInputs) {
      const content = readFileAtCommit(commit, path, options);
      // Older commits can contain PageShim entries without this OCI
      // packaging step; encode that prior state so it compares as a real
      // change when the first packaged bundle is introduced.
      if (content === null) files.set(path, Buffer.from("\0absent"));
      else addLocalImportClosure(commit, path, files, options, new Set(["scripts/pageshim/capabilities.mjs", CONSENT_RENDERER]), consentRemap ?? undefined);
    }
    if (pageShimEntryBytes !== null) addLocalImportClosure(commit, pageShimEntry, files, options, new Set(), consentRemap ?? undefined);
  }

  const hash = createHash("sha256");
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(path).update("\0").update(content).update("\0");
  }
  return hash.digest("hex");
}

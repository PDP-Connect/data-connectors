#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { inventoryBundledDependencies } from "./pdpp-bundled-dependencies.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function inventory(root, files) {
  return files.map((file) => {
    const path = join(root, file);
    if (!existsSync(path)) throw new Error(`Missing input ${path}`);
    return { path: file, sha256: sha256(readFileSync(path)) };
  });
}

function inventoryAbsolute(root, files) {
  return files.map((file) => resolve(file)).sort().map((file) => {
    if (!file.startsWith(`${root}/`)) throw new Error(`Input ${file} is outside ${root}`);
    return { path: relative(root, file), sha256: sha256(readFileSync(file)) };
  });
}

async function main() {
  const artifactId = requiredArgument("--artifact");
  const pdppRoot = requiredArgument("--pdpp-root");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(artifactId)) {
    throw new Error(`Invalid artifact id ${artifactId}`);
  }
  const connectorRoot = join(repoRoot, "connectors", artifactId);
  const specification = JSON.parse(readFileSync(join(connectorRoot, "artifact.json"), "utf8"));
  const { upstream, build } = specification;
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pdppRoot, encoding: "utf8" }).trim();
  if (actualCommit !== upstream.commit) throw new Error(`PDPP HEAD must be ${upstream.commit}, got ${actualCommit}`);

  const pinnedRoot = join(connectorRoot, ".pinned-source");
  rmSync(pinnedRoot, { recursive: true, force: true });
  mkdirSync(pinnedRoot, { recursive: true });
  try {
    const archive = execFileSync("git", ["archive", "--format=tar", upstream.commit, ...upstream.connector_files, upstream.runtime_root], {
      cwd: pdppRoot,
      maxBuffer: 128 * 1024 * 1024,
    });
    execFileSync("tar", ["-xf", "-", "-C", pinnedRoot], { input: archive, maxBuffer: 128 * 1024 * 1024 });

    const manifestSource = join(pinnedRoot, upstream.manifest);
    const manifest = readFileSync(manifestSource);
    const manifestPath = join(connectorRoot, "collection-profile.json");
    writeFileSync(manifestPath, manifest);

    const runtimeRoot = join(pinnedRoot, upstream.runtime_root);
    const distDir = join(connectorRoot, "dist");
    mkdirSync(distDir, { recursive: true });
    const output = join(distDir, "collection-profile.mjs");
    const externalPackages = new Map((build.external_packages ?? []).map((dependency) =>
      typeof dependency === "string" ? [dependency, null] : [dependency.name, dependency.version ?? null],
    ));
    const result = await esbuild.build({
      absWorkingDir: repoRoot,
      banner: { js: `/* GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-pdpp-artifact.mjs --artifact ${artifactId}. */` },
      bundle: true,
      entryPoints: [join(pinnedRoot, upstream.entrypoint)],
      external: [...externalPackages.keys()],
      format: build.format,
      metafile: true,
      minifyWhitespace: true,
      outfile: output,
      platform: build.platform,
      sourcemap: false,
      target: build.target,
    });
    const externalImports = [...new Set(Object.values(result.metafile.outputs).flatMap((entry) => entry.imports)
      .filter((entry) => entry.external && !entry.path.startsWith("node:"))
      .map((entry) => entry.path))].sort();
    const undeclaredImports = externalImports.filter((name) => !externalPackages.has(name));
    if (undeclaredImports.length) throw new Error(`Undeclared external imports remain: ${undeclaredImports.join(", ")}`);
    const runtimeInputs = Object.keys(result.metafile.inputs)
      .map((file) => isAbsolute(file) ? file : resolve(repoRoot, file))
      .filter((file) => file.startsWith(`${runtimeRoot}/`));
    const bundledDependencies = inventoryBundledDependencies({
      repoRoot,
      metafileInputs: Object.keys(result.metafile.inputs),
    });
    const provenance = {
      generated_file_notice: "GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-pdpp-artifact.mjs.",
      artifact_id: artifactId,
      artifact_kind: specification.artifact_kind,
      upstream: { repository: upstream.repository, commit: upstream.commit },
      source_inventory: {
        upstream_connector: inventory(pinnedRoot, upstream.connector_files),
        upstream_runtime: inventoryAbsolute(pinnedRoot, runtimeInputs),
        bundled_dependencies: bundledDependencies,
        maintained_local: inventory(connectorRoot, ["artifact.json"]),
      },
      build: { esbuild_version: esbuild.version, options: { bundle: true, format: build.format, minifyWhitespace: true, platform: build.platform, target: build.target } },
      runtime_requirements: JSON.parse(manifest).runtime_requirements,
      external_runtime_packages: externalImports.map((name) => ({ name, version: externalPackages.get(name) })),
      outputs: {
        "profile/collection-profile.json": sha256(manifest),
        "dist/collection-profile.mjs": sha256(readFileSync(output)),
        undeclared_external_imports: undeclaredImports,
      },
    };
    writeFileSync(join(connectorRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    console.log(`Built ${relative(repoRoot, output)} from ${artifactId} pinned to ${upstream.commit}`);
  } finally {
    rmSync(pinnedRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });

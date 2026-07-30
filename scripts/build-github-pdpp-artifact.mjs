#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";

const EXPECTED_COMMIT = "597cc012611df90d07edbed187ba3e3212dbf258";
const UPSTREAM_REPOSITORY = "https://github.com/PDP-Connect/pdpp";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const connectorRoot = join(repoRoot, "connectors", "github-pdpp");
const require = createRequire(import.meta.url);
const upstreamConnectorFiles = [
  "packages/polyfill-connectors/manifests/github.json",
  "packages/polyfill-connectors/connectors/github/index.ts",
  "packages/polyfill-connectors/connectors/github/parsers.ts",
  "packages/polyfill-connectors/connectors/github/schemas.ts",
  "packages/polyfill-connectors/connectors/github/types.ts",
];
const localSourceFiles = [
  "src/connector/index.ts", "src/connector/parsers.ts", "src/connector/schemas.ts",
  "src/connector/types.ts", "collection-profile.json",
];
const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

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
  return files
    .map((file) => resolve(file))
    .sort((left, right) => left.localeCompare(right))
    .map((file) => {
      if (!file.startsWith(`${root}/`)) throw new Error(`Input ${file} is outside ${root}`);
      return { path: relative(root, file), sha256: sha256(readFileSync(file)) };
    });
}

async function main() {
  const pdppRoot = requiredArgument("--pdpp-root");
  const actualCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: pdppRoot, encoding: "utf8" }).trim();
  if (actualCommit !== EXPECTED_COMMIT) throw new Error(`PDPP HEAD must be ${EXPECTED_COMMIT}, got ${actualCommit}`);
  const upstreamManifest = join(pdppRoot, upstreamConnectorFiles[0]);
  const localManifest = join(connectorRoot, "collection-profile.json");
  if (!readFileSync(upstreamManifest).equals(readFileSync(localManifest))) {
    throw new Error("collection-profile.json differs from the pinned canonical PDPP manifest");
  }
  const distDir = join(connectorRoot, "dist");
  mkdirSync(distDir, { recursive: true });
  const output = join(distDir, "collection-profile.mjs");
  const upstreamRuntimeRoot = join(pdppRoot, "packages", "polyfill-connectors", "src");
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    banner: { js: "/* GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-github-pdpp-artifact.mjs. */" },
    bundle: true,
    entryPoints: [join(connectorRoot, "src", "connector", "index.ts")],
    format: "esm",
    metafile: true,
    minifyWhitespace: true,
    outfile: output,
    platform: "node",
    sourcemap: false,
    target: "node22",
    plugins: [{
      name: "github-pdpp-pinned-runtime",
      setup(build) {
        build.onResolve({ filter: /^\.\.\/runtime\/[^/]+\.ts$/ }, (args) => ({
          path: join(upstreamRuntimeRoot, args.path.slice("../runtime/".length)),
        }));
        build.onResolve({ filter: /^(ajv|zod)$/ }, (args) => ({ path: require.resolve(args.path) }));
        build.onResolve({ filter: /^(patchright|playwright|chromium-bidi)$/ }, () => ({
          path: "browser-runtime-unavailable",
          namespace: "github-pdpp-browser-stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "github-pdpp-browser-stub" }, () => ({
          loader: "js",
          contents: [
            "const unavailable=()=>{throw new Error('Browser runtime is unavailable: github-pdpp declares only the network binding')};",
            "const browser=new Proxy({}, {get:()=>unavailable});",
            "export const chromium=browser;export const firefox=browser;export const webkit=browser;",
          ].join("\n"),
        }));
      },
    }],
  });
  const unresolvedNonNodeImports = Object.values(result.metafile.outputs)
    .flatMap((entry) => entry.imports)
    .filter((entry) => entry.external && !entry.path.startsWith("node:"));
  if (unresolvedNonNodeImports.length > 0) throw new Error(`Non-Node imports remain: ${unresolvedNonNodeImports.map((entry) => entry.path).join(", ")}`);
  const runtimeInputs = Object.keys(result.metafile.inputs)
    .map((file) => isAbsolute(file) ? file : resolve(repoRoot, file))
    .filter((file) => file.startsWith(`${upstreamRuntimeRoot}/`));
  const provenance = {
    generated_file_notice: "GENERATED FILE — DO NOT HAND-EDIT. Rebuild with scripts/build-github-pdpp-artifact.mjs.",
    artifact_id: "github-pdpp",
    artifact_kind: "pdpp-collection-profile",
    upstream: { repository: UPSTREAM_REPOSITORY, commit: EXPECTED_COMMIT },
    source_inventory: {
      upstream_connector: inventory(pdppRoot, upstreamConnectorFiles),
      upstream_runtime: inventoryAbsolute(pdppRoot, runtimeInputs),
      maintained_local: inventory(connectorRoot, localSourceFiles),
    },
    build: { esbuild_version: esbuild.version, options: { bundle: true, format: "esm", minifyWhitespace: true, platform: "node", target: "node22" } },
    outputs: {
      "profile/collection-profile.json": sha256(readFileSync(localManifest)),
      "dist/collection-profile.mjs": sha256(readFileSync(output)),
      unresolved_non_node_imports: unresolvedNonNodeImports,
    },
  };
  writeFileSync(join(connectorRoot, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`Built ${relative(repoRoot, output)} from maintained GitHub source pinned to ${EXPECTED_COMMIT}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });

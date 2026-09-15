// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function exportTargets(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") {
    assert.ok(!value.includes("*"), "expand wildcard exports before checking pack coverage");
    return [value];
  }
  return Object.values(value).flatMap(exportTargets);
}

function packedFiles(packageRoot) {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: packageRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(output);
  const packages = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.equal(packages.length, 1);
  return new Set(packages[0].files.map((file) => file.path));
}

for (const directory of [".", "packages/connector-installer-core"]) {
  test(`${directory}: extracted package exports fetchCatalog with its schema`, (t) => {
    const temporaryRoot = join(homedir(), ".tmp");
    mkdirSync(temporaryRoot, { recursive: true });
    const fixture = mkdtempSync(join(temporaryRoot, "catalog-package-"));
    t.after(() => rmSync(fixture, { recursive: true, force: true }));
    const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", fixture], {
      cwd: resolve(repoRoot, directory), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(output);
    const [packed] = Array.isArray(parsed) ? parsed : Object.values(parsed);
    execFileSync("tar", ["-xzf", join(fixture, packed.filename), "-C", fixture]);
    // Use installed dependencies, but resolve all package files from the tarball.
    // The graph test below separately requires every import to be a production dependency.
    symlinkSync(join(repoRoot, "node_modules"), join(fixture, "node_modules"), "dir");
    const entry = directory === "." ? "./packages/connector-installer-core/index.mjs" : "./index.mjs";
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { fetchCatalog } from ${JSON.stringify(entry)};
      assert.equal(typeof fetchCatalog, "function");
      await assert.rejects(fetchCatalog({ lastAcceptedGeneratedAt: "invalid" }), /Invalid lastAcceptedGeneratedAt/);
    `], { cwd: join(fixture, "package"), stdio: ["ignore", "pipe", "pipe"] });
  });

  test(`${directory}: packed entrypoints contain their runtime import graph`, async () => {
    const packageRoot = resolve(repoRoot, directory);
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const entryPoints = [...new Set([
      ...exportTargets(manifest.exports ?? manifest.main),
      ...exportTargets(manifest.bin),
    ])];
    assert.ok(entryPoints.length > 0);
    const packed = packedFiles(packageRoot);
    // Parse the graph instead of matching import text: this covers re-exports,
    // side-effect imports, require(), and literal dynamic imports as well.
    const result = await build({
      absWorkingDir: packageRoot,
      entryPoints,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      outdir: "pack-coverage-unused",
      write: false,
      metafile: true,
      logLevel: "silent",
      logOverride: { "unsupported-dynamic-import": "error", "unsupported-require-call": "error" },
    });
    assert.deepEqual(result.warnings, [], "the runtime graph must be statically checkable");
    for (const [file, input] of Object.entries(result.metafile.inputs)) {
      assert.ok(packed.has(file), `${manifest.name}: ${file} is missing from npm pack`);
      for (const dependency of input.imports.filter((item) => item.external)) {
        if (isBuiltin(dependency.path)) continue;
        const name = dependency.path.startsWith("@")
          ? dependency.path.split("/").slice(0, 2).join("/")
          : dependency.path.split("/")[0];
        assert.ok(Object.hasOwn(manifest.dependencies ?? {}, name),
          `${manifest.name}: ${file} imports undeclared runtime dependency ${name}`);
      }
    }
    for (const dependency of Object.values(manifest.dependencies ?? {})) {
      if (!dependency.startsWith("file:")) continue;
      const nestedManifest = relative(packageRoot, resolve(packageRoot, dependency.slice(5), "package.json"));
      assert.ok(packed.has(nestedManifest), `${manifest.name}: file dependency manifest ${nestedManifest} is missing`);
    }
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Does the published tarball contain everything the entrypoint imports?
//
// The `files` list in package.json is a hand-maintained allowlist, and the
// installer entrypoint is no longer one file. When `index.mjs` grew imports of
// `oci-registry.mjs` and `oci-verify.mjs`, the list still named only
// `index.mjs`, so `npm pack` produced a tarball that resolved its own first
// relative import to a file that was not in it. Nothing in this repository
// noticed: every test here runs from the checkout, where those files exist.
// A consumer installing the git-pinned package got ERR_MODULE_NOT_FOUND.
//
// So this test does not restate the list — restating it would drift the same
// way. It walks the real import graph from each published entrypoint and
// asserts that every local module it reaches is in the tarball `npm pack`
// actually produces.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Every local module reachable from `entry`, as repo-relative POSIX paths.
// Only relative specifiers are followed: a bare specifier is a dependency npm
// installs, not a file this package ships.
function localImportsFrom(entry) {
  const seen = new Set();
  const queue = [resolve(repoRoot, entry)];

  while (queue.length > 0) {
    const file = queue.pop();
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (seen.has(rel)) continue;
    seen.add(rel);

    const source = readFileSync(file, "utf8");
    // A braced import list spans lines, so the clause between `import` and
    // `from` must be allowed to contain newlines.
    for (const match of source.matchAll(/\b(?:import|export)\b[\s\S]*?\bfrom\s*["'](\.[^"']+)["']/g)) {
      queue.push(resolve(dirname(file), match[1]));
    }
    for (const match of source.matchAll(/\bimport\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      queue.push(resolve(dirname(file), match[1]));
    }
  }

  return seen;
}

function packedFiles() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  // npm has reported this as an array of packages and, in later versions, as an
  // object keyed by package name. Read whichever shape this npm produced rather
  // than pinning one and failing obscurely on the other.
  const parsed = JSON.parse(output);
  const packages = Array.isArray(parsed) ? parsed : Object.values(parsed);
  return new Set(packages.flatMap((pkg) => pkg.files).map((file) => file.path));
}

test("the published tarball carries every module the installer entrypoints import", () => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const entrypoints = [
    ...Object.values(manifest.exports ?? {}),
    "./packages/connector-installer-cli/index.mjs",
  ].map((specifier) => specifier.replace(/^\.\//, ""));

  const packed = packedFiles();
  const missing = [];
  for (const entry of entrypoints) {
    for (const module of localImportsFrom(entry)) {
      // Test files are imported by nothing shipped; they are not published.
      if (module.endsWith(".test.mjs")) continue;
      if (!packed.has(module)) missing.push(module);
    }
  }

  assert.deepEqual(
    [...new Set(missing)].sort(),
    [],
    "these modules are imported by a published entrypoint but absent from the tarball; " +
      'add them to "files" in package.json',
  );
});

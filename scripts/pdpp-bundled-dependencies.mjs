// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const sha256 = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
const isInside = (root, path) => path === root || path.startsWith(`${root}${sep}`);

function packageRootForInput(repoRoot, input) {
  let directory = dirname(input);
  while (isInside(repoRoot, directory)) {
    const packageJson = join(directory, "package.json");
    if (existsSync(packageJson) && relative(repoRoot, directory).split(sep).includes("node_modules")) {
      const metadata = JSON.parse(readFileSync(packageJson, "utf8"));
      if (typeof metadata.name === "string" && typeof metadata.version === "string") {
        return directory;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function closureSha256(files) {
  return sha256(Buffer.from(JSON.stringify(files)));
}

export function inventoryBundledDependencies({ repoRoot, metafileInputs }) {
  const packages = new Map();
  for (const input of metafileInputs) {
    const path = resolve(repoRoot, input);
    const packageRoot = packageRootForInput(repoRoot, path);
    if (!packageRoot) continue;
    const packagePath = relative(repoRoot, packageRoot);
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const filePath = relative(packageRoot, path);
    const entry = packages.get(packagePath) ?? {
      name: packageJson.name,
      version: packageJson.version,
      package_path: packagePath,
      package_json_sha256: sha256(readFileSync(join(packageRoot, "package.json"))),
      files: [],
    };
    entry.files.push({ path: filePath, sha256: sha256(readFileSync(path)) });
    packages.set(packagePath, entry);
  }
  return [...packages.values()]
    .map((entry) => {
      entry.files.sort((left, right) => left.path.localeCompare(right.path));
      return { ...entry, closure_sha256: closureSha256(entry.files) };
    })
    .sort((left, right) => left.package_path.localeCompare(right.package_path));
}

export function assertBundledDependenciesMatch({ repoRoot, dependencies, artifactLabel }) {
  for (const dependency of dependencies ?? []) {
    if (!dependency?.package_path || !dependency?.name || !dependency?.version) {
      throw new Error(`${artifactLabel} provenance has an invalid bundled dependency entry`);
    }
    const packageRoot = resolve(repoRoot, dependency.package_path);
    if (!isInside(repoRoot, packageRoot) || !existsSync(join(packageRoot, "package.json"))) {
      throw new Error(`${artifactLabel} bundled dependency is missing: ${dependency.package_path}`);
    }
    const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (packageJson.name !== dependency.name || packageJson.version !== dependency.version) {
      throw new Error(`${artifactLabel} bundled dependency changed without a version bump: ${dependency.package_path}`);
    }
    if (sha256(readFileSync(join(packageRoot, "package.json"))) !== dependency.package_json_sha256) {
      throw new Error(`${artifactLabel} bundled dependency changed without a version bump: ${dependency.package_path}/package.json`);
    }
    const files = [];
    for (const file of dependency.files ?? []) {
      const path = resolve(packageRoot, file.path);
      if (!isInside(packageRoot, path) || !existsSync(path) || sha256(readFileSync(path)) !== file.sha256) {
        throw new Error(`${artifactLabel} bundled dependency changed without a version bump: ${dependency.name}/${file.path}`);
      }
      files.push({ path: file.path, sha256: file.sha256 });
    }
    files.sort((left, right) => left.path.localeCompare(right.path));
    if (closureSha256(files) !== dependency.closure_sha256) {
      throw new Error(`${artifactLabel} bundled dependency closure changed without a version bump: ${dependency.name}`);
    }
  }
}

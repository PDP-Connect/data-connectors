// The manager's advertised engine range must be supported by its COMPLETE
// production dependency closure, not just by the manager's own code.
//
// A package can declare any range it likes; npm checks each installed package
// separately. Advertising a floor one dependency rejects produces an install
// that npm refuses (or, under --omit=dev on an older runtime, one that fails at
// import). So the range is derived from the lockfile rather than chosen.
//
// This walks the closure from the manager's lock stanza using node's resolution
// order, then checks every declared engine range with npm's own checkEngine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER_LOCK_KEY = "packages/connector-installer-core";

// npm ships checkEngine and semver; use npm's own copies so this test agrees
// with the tool that will actually reject an install.
const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const npmRequire = createRequire(join(npmRoot, "npm", "package.json"));
const { checkEngine } = npmRequire("npm-install-checks");
const semver = npmRequire("semver");

const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
const packages = lock.packages;

function resolveFrom(fromKey, name) {
  const parts = fromKey === "" ? [] : fromKey.split("/");
  for (let i = parts.length; i >= 0; i -= 1) {
    const base = parts.slice(0, i).join("/");
    const candidate = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (packages[candidate]) return candidate;
  }
  return null;
}

function productionClosure() {
  const root = packages[MANAGER_LOCK_KEY];
  assert.ok(root, `no lockfile stanza for ${MANAGER_LOCK_KEY}`);

  const seen = new Set([MANAGER_LOCK_KEY]);
  const stack = [[MANAGER_LOCK_KEY, root]];
  const closure = [MANAGER_LOCK_KEY];
  const unresolved = [];

  while (stack.length > 0) {
    const [key, entry] = stack.pop();
    const deps = { ...(entry.dependencies ?? {}), ...(entry.optionalDependencies ?? {}) };
    for (const name of Object.keys(deps)) {
      const resolved = resolveFrom(key, name);
      if (!resolved) {
        unresolved.push(`${name} (from ${key})`);
        continue;
      }
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      closure.push(resolved);
      stack.push([resolved, packages[resolved]]);
    }
  }

  assert.deepEqual(unresolved, [], "every production dependency must resolve in the lockfile");
  return closure;
}

function constrainedPackages() {
  return productionClosure()
    .filter((key) => packages[key].engines?.node)
    .map((key) => ({
      name: key.startsWith("packages/") ? "@pdpp/connector-manager" : key.replace(/^.*node_modules\//, ""),
      version: packages[key].version,
      range: packages[key].engines.node,
    }));
}

// npm's real gate: true when npm would allow this package on this runtime.
function npmAccepts(nodeVersion, pkg) {
  try {
    checkEngine({ name: pkg.name, version: pkg.version, engines: { node: pkg.range } }, "12.0.2", nodeVersion, false);
    return true;
  } catch (error) {
    if (error.code === "EBADENGINE") return false;
    throw error;
  }
}

const declaredRange = JSON.parse(
  readFileSync(join(repoRoot, MANAGER_LOCK_KEY, "package.json"), "utf8"),
).engines.node;

test("the closure is actually constrained, so this test can fail", () => {
  const constrained = constrainedPackages();
  assert.ok(constrained.length > 1, "expected dependencies with engine ranges");
  // Guards against a lockfile edit that silently empties the narrow set and
  // would let every assertion below pass vacuously.
  const narrow = constrained.filter((pkg) => pkg.range === "^22.22.2 || ^24.15.0 || >=26.0.0");
  assert.ok(narrow.length > 0, "expected the Sigstore/npm packages to still declare a narrow range");
});

test("no runtime the manager advertises is rejected by any production dependency", () => {
  const constrained = constrainedPackages();
  // Sample the advertised range densely, including each major's boundary.
  const probes = [];
  for (const major of [22, 24, 26, 28]) {
    for (let minor = 0; minor < 40; minor += 1) {
      for (const patch of [0, 1, 2, 5, 15, 22]) probes.push(`${major}.${minor}.${patch}`);
    }
  }
  const advertised = probes.filter((version) => semver.satisfies(version, declaredRange));
  assert.ok(advertised.length > 0, "declared range must match some concrete versions");

  const broken = advertised.flatMap((version) => {
    const rejecting = constrained.filter((pkg) => !npmAccepts(version, pkg));
    return rejecting.length === 0 ? [] : [`node ${version} rejected by ${rejecting.map((p) => p.name).join(", ")}`];
  });
  assert.deepEqual(broken, [], "advertised runtimes must satisfy the whole closure");
});

test("the declared range does not exclude a runtime the closure supports", () => {
  const constrained = constrainedPackages();
  const probes = [];
  for (const major of [18, 20, 21, 22, 23, 24, 25, 26, 27, 28]) {
    for (let minor = 0; minor < 40; minor += 1) {
      for (const patch of [0, 1, 2, 5, 15, 22]) probes.push(`${major}.${minor}.${patch}`);
    }
  }
  const supportedByClosure = probes.filter((version) => constrained.every((pkg) => npmAccepts(version, pkg)));
  const understated = supportedByClosure.filter((version) => !semver.satisfies(version, declaredRange));
  assert.deepEqual(understated, [], "declared range must not understate supported runtimes");
});

test("runtimes the reviewed range wrongly claimed are rejected by the closure", () => {
  const constrained = constrainedPackages();
  // The previously advertised floor (>=20.11) named these as supported; the
  // closure refuses them. This is the regression that must not come back.
  for (const version of ["20.11.0", "22.16.0", "22.22.1", "24.14.0"]) {
    const rejecting = constrained.filter((pkg) => !npmAccepts(version, pkg));
    assert.ok(rejecting.length > 0, `expected the closure to reject node ${version}`);
    assert.ok(!semver.satisfies(version, declaredRange), `declared range must not claim node ${version}`);
  }
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const root = join(schemaDir, "..");
const schema = JSON.parse(readFileSync(join(schemaDir, "connector-manifest.schema.json"), "utf8"));
const profile = readFileSync(join(root, "docs/spec/collection-profile.md"), "utf8");
const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);

function manifestWith(bindings) {
  return { runtime_requirements: { bindings } };
}

function connectorManifests() {
  const connectorsDir = join(root, "connectors");
  return readdirSync(connectorsDir)
    .map((name) => join(connectorsDir, name, "manifest.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }));
}

/**
 * Returns the first-cell values of the first table under `heading`. Every body
 * row is read, and a first cell that is not exactly one code span fails the
 * test instead of being skipped, so a row written in another spelling cannot
 * escape the exact-set comparison.
 */
function tableRowKeys(heading) {
  const section = profile.split(new RegExp(`^${heading}$`, "m"))[1];
  assert.ok(section, `profile must contain ${heading}`);
  const table = section.match(/\n\| *[A-Za-z`][^\n]*\|\n\| *-[^\n]*\|\n((?:\|[^\n]*\|\n)+)/);
  assert.ok(table, `${heading} must contain a table`);
  return table[1]
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .map((row) => {
      const firstCell = row.replace(/^\s*\|/, "").split("|")[0].trim();
      const key = firstCell.match(/^`([^`]+)`$/);
      assert.ok(key, `${heading} row must name its value in one code span, got ${JSON.stringify(firstCell)}`);
      return key[1];
    });
}

test("the profile binding table matches the schema registry exactly", () => {
  assert.deepEqual(tableRowKeys("### 3.3 Bindings").sort(), [...schema.$defs.registryBinding.enum].sort());
});

test("the profile feature table matches the schema feature enum exactly", () => {
  assert.deepEqual(
    tableRowKeys("#### 3.3.1 Binding features").sort(),
    [...schema.$defs.bindingFeature.enum].sort(),
  );
});

test("every connector manifest validates against the manifest schema", () => {
  const manifests = connectorManifests();
  assert.ok(manifests.length > 0, "connector manifests must be present");
  for (const { path, manifest } of manifests) {
    assert.equal(validate(manifest), true, `${path}: ${JSON.stringify(validate.errors)}`);
  }
});

test("registry and namespaced extension binding names are accepted", () => {
  for (const name of ["browser", "desktop_session", "filesystem", "network", "example.com/scanner", "nvidia.com/gpu"]) {
    assert.equal(validate(manifestWith({ [name]: { required: true } })), true, name);
  }
});

test("unregistered unqualified binding names are rejected", () => {
  for (const name of [
    "browser_automation",
    "browser_profile",
    "loopback_listen",
    "interactive",
    "local_device",
    "Browser",
    "example/scanner",
    "example.com/",
  ]) {
    assert.equal(validate(manifestWith({ [name]: { required: false } })), false, name);
  }
});

test("binding declarations keep binding-specific fields and require the required flag", () => {
  const rationale = "The key unwraps only through the session keyring.";
  assert.equal(validate(manifestWith({ desktop_session: { required: true, rationale } })), true);
  assert.equal(validate(manifestWith({ network: {} })), false);
  assert.equal(validate(manifestWith({ browser: { required: true, features: ["goto"] } })), false);
});

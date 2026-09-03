// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import test from "node:test";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const manifestsDir = join(repoRoot, "packages", "polyfill-connectors", "manifests");
const indexPath = join(repoRoot, "connector-index.json");
const expectedUrlPrefix = "https://raw.githubusercontent.com/PDP-Connect/data-connectors/";

function readManifest(filename) {
  const path = join(manifestsDir, filename);
  return { path, manifest: JSON.parse(readFileSync(path, "utf8")) };
}

function assertLocalAsset(manifestPath, assetPath, field) {
  assert.equal(typeof assetPath, "string", `${manifestPath}: brand.${field} must be a string`);
  assert.notEqual(assetPath.trim(), "", `${manifestPath}: brand.${field} must not be empty`);
  assert.equal(assetPath.startsWith("/"), false, `${manifestPath}: brand.${field} must be relative`);
  assert.equal(assetPath.includes("\\"), false, `${manifestPath}: brand.${field} must use POSIX separators`);
  const normalized = normalize(assetPath);
  assert.equal(normalized.startsWith(".."), false, `${manifestPath}: brand.${field} must stay local`);
  const resolved = join(dirname(manifestPath), normalized);
  assert.equal(existsSync(resolved) && statSync(resolved).isFile(), true, `${manifestPath}: brand.${field} asset is missing`);
  return assetPath;
}

test("every shipped polyfill manifest declares a local brand icon", () => {
  const files = readdirSync(manifestsDir).filter((file) => file.endsWith(".json")).sort();
  assert.ok(files.length > 0, "expected shipped polyfill manifests");
  for (const filename of files) {
    const { path, manifest } = readManifest(filename);
    assert.equal(typeof manifest.connector_id, "string", `${filename}: connector_id is required`);
    assert.ok(manifest.brand && typeof manifest.brand === "object" && !Array.isArray(manifest.brand), `${filename}: brand is required`);
    assertLocalAsset(path, manifest.brand.icon, "icon");
    if (manifest.brand.dark_icon !== undefined) assertLocalAsset(path, manifest.brand.dark_icon, "dark_icon");
  }
});

test("connector index resolves every shipped polyfill brand icon", () => {
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  for (const filename of readdirSync(manifestsDir).filter((file) => file.endsWith(".json"))) {
    const { manifest } = readManifest(filename);
    const icon = index.brandIcons?.[manifest.connector_id];
    assert.ok(icon, `${filename}: connector-index.json is missing brandIcons.${manifest.connector_id}`);
    assert.match(
      icon.url,
      new RegExp(`^${expectedUrlPrefix}[0-9a-f]{40}/packages/polyfill-connectors/manifests/${manifest.brand.icon}$`),
      `${filename}: resolved icon URL`,
    );
    if (manifest.brand.dark_icon !== undefined) {
      assert.match(
        icon.darkUrl,
        new RegExp(`^${expectedUrlPrefix}[0-9a-f]{40}/packages/polyfill-connectors/manifests/${manifest.brand.dark_icon}$`),
        `${filename}: resolved dark icon URL`,
      );
    }
    assert.equal(icon.backgroundColor, manifest.brand.background_color, `${filename}: background color`);
  }
});

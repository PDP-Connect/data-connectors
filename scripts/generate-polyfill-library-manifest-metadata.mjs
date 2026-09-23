#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Package-only projection for library APIs that read option and reason copy.
// Root manifests remain the sole authored source of connector metadata.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const connectors = new URL("connectors/", root);
const output = new URL("packages/polyfill-connectors/src/manifest-library-metadata.json", root);
const entries = readdirSync(connectors, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((entry) => {
    const path = new URL(`${entry.name}/manifest.json`, connectors);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const projected = { connector_key: manifest.connector_key };
    if (manifest.options_schema !== undefined) projected.options_schema = manifest.options_schema;
    if (manifest.reason_display_messages !== undefined) projected.reason_display_messages = manifest.reason_display_messages;
    if (Object.keys(projected).length === 1) return [];
    return [{ file: `${entry.name}.json`, manifest: projected }];
  });
const rendered = execFileSync(
  new URL("../node_modules/.bin/biome", import.meta.url).pathname,
  ["format", "--stdin-file-path", "src/manifest-library-metadata.json"],
  {
    cwd: new URL("../packages/polyfill-connectors/", import.meta.url),
    encoding: "utf8",
    input: `${JSON.stringify(entries)}\n`,
  },
);
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== rendered) {
    console.error("Package manifest library metadata is stale; run npm run polyfill-library-metadata:generate");
    process.exitCode = 1;
  }
} else {
  writeFileSync(output, rendered);
}

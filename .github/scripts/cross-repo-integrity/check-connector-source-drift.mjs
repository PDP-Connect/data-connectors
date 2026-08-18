#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (b): vendored connector sources in data-connect vs this repo's canonical
 * connector files, for the six connectors data-connect's local-collector bundle currently
 * duplicates (see LOCAL_COLLECTOR_DEFINITIONS in
 * packages/polyfill-connectors/src/collector-registry.ts): claude_code, codex,
 * google_takeout, imessage, apple_photos, google_messages.
 *
 * data-connect carries a transitional copy of each connector's non-test source files at
 * packages/polyfill-connectors/connectors/<id>/ (finding S1's "transitional selected
 * connector-content copy"). This compares every such file byte-for-byte (SHA-256) against
 * this repo's canonical copy at the same relative path.
 *
 * Deliberately excluded from comparison: `*.test.ts` (data-connect does not carry this
 * repo's test suite) and anything under a `fixtures/` or `__fixtures__/` directory (test
 * fixture trees, not connector logic — data-connect vendors only what its local-collector
 * bundle executes).
 *
 * Usage:
 *   node check-connector-source-drift.mjs <data-connect-checkout> <data-connectors-checkout>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BUNDLED_CONNECTORS = ["claude_code", "codex", "google_takeout", "imessage", "apple_photos", "google_messages"];

const [, , dataConnectDir, dataConnectorsDir] = process.argv;

if (!dataConnectDir || !dataConnectorsDir) {
  console.error("usage: check-connector-source-drift.mjs <data-connect-checkout> <data-connectors-checkout>");
  process.exit(1);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Recursively list files under `dir`, skipping fixtures dirs and *.test.ts, returned as paths relative to `dir`. */
function listComparableFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "fixtures" || entry.name === "__fixtures__") continue;
        stack.push(full);
        continue;
      }
      if (entry.name.endsWith(".test.ts")) continue;
      out.push(relative(dir, full));
    }
  }
  return out.sort();
}

let failed = false;
const results = [];

for (const connectorId of BUNDLED_CONNECTORS) {
  const vendoredDir = join(dataConnectDir, "packages/polyfill-connectors/connectors", connectorId);
  const canonicalDir = join(dataConnectorsDir, "packages/polyfill-connectors/connectors", connectorId);

  if (!existsSync(vendoredDir)) {
    console.error(`FAIL: ${connectorId} — vendored directory not found at ${vendoredDir}`);
    failed = true;
    continue;
  }
  if (!existsSync(canonicalDir)) {
    console.error(`FAIL: ${connectorId} — canonical directory not found at ${canonicalDir}`);
    failed = true;
    continue;
  }

  const vendoredFiles = new Set(listComparableFiles(vendoredDir));
  const canonicalFiles = new Set(listComparableFiles(canonicalDir));

  const onlyInVendored = [...vendoredFiles].filter((f) => !canonicalFiles.has(f));
  const onlyInCanonical = [...canonicalFiles].filter((f) => !vendoredFiles.has(f));

  for (const f of onlyInVendored) {
    console.error(`FAIL: ${connectorId}/${f} — present in data-connect's vendored copy but not in the canonical repo`);
    failed = true;
  }
  for (const f of onlyInCanonical) {
    console.error(`FAIL: ${connectorId}/${f} — present in the canonical repo but missing from data-connect's vendored copy`);
    failed = true;
  }

  for (const f of [...vendoredFiles].filter((x) => canonicalFiles.has(x))) {
    const vendoredHash = sha256(join(vendoredDir, f));
    const canonicalHash = sha256(join(canonicalDir, f));
    if (vendoredHash !== canonicalHash) {
      console.error(`FAIL: ${connectorId}/${f} — byte mismatch`);
      console.error(`  vendored (data-connect):  ${vendoredHash}`);
      console.error(`  canonical (data-connectors): ${canonicalHash}`);
      failed = true;
    } else {
      results.push(`${connectorId}/${f}`);
    }
  }
}

if (failed) {
  console.error(`FAIL: connector source drift detected across the ${BUNDLED_CONNECTORS.length} bundled connectors.`);
  process.exit(1);
}

console.log(`OK: ${results.length} vendored connector source files across ${BUNDLED_CONNECTORS.length} connectors are byte-identical to canonical.`);

#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (b): vendored connector sources in data-connect vs this repo's canonical
 * connector files, for whichever connectors data-connect's local-collector bundle currently
 * duplicates.
 *
 * The bundled-connector set is derived from this repo's own canonical registry
 * (packages/polyfill-connectors/src/collector-registry.ts's LOCAL_COLLECTOR_DEFINITIONS),
 * not hard-coded here: per the reviewer's "derive connector coverage instead of hard-coding
 * six IDs" hardening finding (2026-08-18 final-v2 red-team), a hard-coded list can silently
 * fall out of sync with a registry change that adds or removes a bundled connector, leaving
 * newly-bundled source outside byte-drift checking. That set is then asserted equal to the
 * product bundle actually present under data-connect's vendored connectors directory —
 * a mismatch (registry added/removed a connector but the vendored bundle didn't follow, or
 * vice versa) is itself a drift failure, not silently ignored.
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
 *   node --experimental-strip-types check-connector-source-drift.mjs <data-connect-checkout> <data-connectors-checkout>
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , dataConnectDir, dataConnectorsDir] = process.argv;

if (!dataConnectDir || !dataConnectorsDir) {
  console.error("usage: check-connector-source-drift.mjs <data-connect-checkout> <data-connectors-checkout>");
  process.exit(1);
}

const registryPath = resolve(dataConnectorsDir, "packages/polyfill-connectors/src/collector-registry.ts");
if (!existsSync(registryPath)) {
  console.error(`FAIL: canonical collector-registry.ts not found at ${registryPath}`);
  process.exit(1);
}

// The registry module's own relative imports (../connectors/<id>/collector-definition.ts)
// resolve correctly as long as we import it from its real on-disk location, so no scratch
// tree is needed here (unlike check-collector-definitions-drift.mjs, which must run
// data-connect's generator against a synthetic sibling layout). Every value these modules
// import from @pdpp/connector-protocol is `import type` only, so
// --experimental-strip-types erases it without needing that package installed.
const registryModule = await import(pathToFileURL(registryPath).href);
const BUNDLED_CONNECTORS = registryModule.LOCAL_COLLECTOR_DEFINITIONS.map((d) => d.connector_id);

if (BUNDLED_CONNECTORS.length === 0) {
  console.error(`FAIL: canonical collector-registry.ts's LOCAL_COLLECTOR_DEFINITIONS is empty at ${registryPath}`);
  process.exit(1);
}

const vendoredConnectorsRoot = join(dataConnectDir, "packages/polyfill-connectors/connectors");
const vendoredConnectorDirs = existsSync(vendoredConnectorsRoot)
  ? readdirSync(vendoredConnectorsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  : [];
const registryConnectorSet = new Set(BUNDLED_CONNECTORS);
const vendoredConnectorSet = new Set(vendoredConnectorDirs);
const missingFromVendored = BUNDLED_CONNECTORS.filter((id) => !vendoredConnectorSet.has(id));
const extraInVendored = vendoredConnectorDirs.filter((id) => !registryConnectorSet.has(id));

if (missingFromVendored.length > 0 || extraInVendored.length > 0) {
  console.error("FAIL: the canonical registry's bundled-connector set does not match data-connect's vendored connectors directory.");
  if (missingFromVendored.length > 0) {
    console.error(`  in canonical registry but not vendored in data-connect: ${missingFromVendored.join(", ")}`);
  }
  if (extraInVendored.length > 0) {
    console.error(`  vendored in data-connect but not in canonical registry: ${extraInVendored.join(", ")}`);
  }
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

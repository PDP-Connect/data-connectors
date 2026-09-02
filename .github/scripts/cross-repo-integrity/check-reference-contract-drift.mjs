#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (d): the reference-contract vendor tarball, byte-compared against pdpp's canonical
 * source at the pinned SHA.
 *
 * This repo carries a documented, minimal vendored stand-in for a package that otherwise lives
 * in `PDP-Connect/pdpp` (see finding S5 — "a de facto compatibility surface" that "must not
 * silently become an independent contract implementation"):
 *
 *   `packages/polyfill-connectors/vendor/pdpp-reference-contract-0.0.1.tgz` — a vendored
 *   tarball carrying THREE copied source files (`common/index.ts`, `evidence/coherence.ts`,
 *   `evidence/collection-scope.ts`) plus one hand-written barrel (`evidence/index.ts`,
 *   NOT copied from pdpp — deliberately excluded from this comparison, per `vendor/README.md`).
 *   `packages/reference-contract` stays in `PDP-Connect/pdpp` (pdpp#284, decision D-22), so
 *   this half of the check still has a live canonical source to compare against.
 *
 * The README documents an exact source path + source commit per file. This script re-reads
 * that documented mapping, extracts the actual bytes at the pinned pdpp SHA, and fails if the
 * stand-in has drifted from its documented canonical source — i.e. it turns the README's
 * provenance table into an enforced contract, not prose.
 *
 * NOTE: this script used to also byte-compare
 * `src/reference-implementation-stand-in/runtime/recovery-reason-codes.ts` against
 * `reference-implementation/runtime/recovery-reason-codes.ts` in pdpp. pdpp#284 deleted
 * `reference-implementation/` entirely, so that canonical source no longer exists at any pdpp
 * SHA — the comparison's premise (a live canonical file to track) is gone, not merely stale.
 * Per `src/reference-implementation-stand-in/README.md`'s own "Removal trigger" ("delete this
 * directory once reference-implementation's own repository move lands"), that stand-in is now
 * a permanent local copy, not a pinned mirror — removed from this script accordingly.
 *
 * Usage:
 *   node check-reference-contract-drift.mjs <pdpp-checkout> <data-connectors-checkout>
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , pdppDir, dataConnectorsDir] = process.argv;

if (!pdppDir || !dataConnectorsDir) {
  console.error("usage: check-reference-contract-drift.mjs <pdpp-checkout> <data-connectors-checkout>");
  process.exit(1);
}

const polyfillConnectorsDir = join(dataConnectorsDir, "packages/polyfill-connectors");

// Documented provenance: stand-in file path (relative to what's being compared) -> canonical
// source path (relative to the pdpp checkout root). Mirrors vendor/README.md's and
// src/reference-implementation-stand-in/README.md's provenance tables exactly. If a stand-in
// file is added/changed without updating BOTH the README and this list, this check cannot
// protect it — see the workflow's "keep these in sync" note.
const VENDOR_TARBALL_MAPPINGS = [
  { standIn: "common/index.ts", canonical: "packages/reference-contract/src/common/terminal-run-commit.ts" },
  { standIn: "evidence/coherence.ts", canonical: "packages/reference-contract/src/evidence/coherence.ts" },
  { standIn: "evidence/collection-scope.ts", canonical: "packages/reference-contract/src/evidence/collection-scope.ts" },
  // evidence/index.ts is deliberately hand-written, not copied — excluded per vendor/README.md.
];

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

let failed = false;

// --- Vendored tarball (extract, then compare each documented file) ---
const tarballPath = join(polyfillConnectorsDir, "vendor/pdpp-reference-contract-0.0.1.tgz");
if (!existsSync(tarballPath)) {
  console.error(`FAIL: vendored reference-contract tarball not found: ${tarballPath}`);
  failed = true;
} else {
  const extractDir = mkdtempSync(join(tmpdir(), "reference-contract-extract-"));
  try {
    execFileSync("tar", ["xzf", tarballPath, "-C", extractDir], { stdio: "inherit" });

    for (const { standIn, canonical } of VENDOR_TARBALL_MAPPINGS) {
      const standInPath = join(extractDir, "package", standIn);
      const canonicalPath = join(pdppDir, canonical);

      if (!existsSync(standInPath)) {
        console.error(`FAIL: tarball is missing documented file: package/${standIn}`);
        failed = true;
        continue;
      }
      if (!existsSync(canonicalPath)) {
        console.error(`FAIL: documented canonical source missing at pinned pdpp SHA: ${canonicalPath}`);
        failed = true;
        continue;
      }

      const standInHash = sha256(readFileSync(standInPath));
      const canonicalHash = sha256(readFileSync(canonicalPath));
      if (standInHash !== canonicalHash) {
        console.error(`FAIL: vendor tarball's ${standIn} has drifted from its documented canonical source ${canonical}`);
        console.error(`  stand-in:  ${standInHash}`);
        console.error(`  canonical: ${canonicalHash}`);
        failed = true;
      } else {
        console.log(`OK: vendor tarball's ${standIn} matches ${canonical} at the pinned pdpp SHA.`);
      }
    }
  } finally {
    rmSync(extractDir, { recursive: true, force: true });
  }
}

if (failed) {
  console.error("FAIL: reference-contract stand-in drift detected.");
  process.exit(1);
}

console.log("OK: all documented reference-contract stand-in modules match their canonical pdpp source.");

#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared SPDX header configuration.
 *
 * Single source of truth for which first-party source files are exempt from
 * the Apache-2.0 SPDX header requirement, and why. Both the header sweep and
 * scripts/check-spdx-headers.mjs import this list rather than maintaining
 * their own copies — see PR #9 and tracking issue #42 for the rationale
 * behind each exclusion class.
 */

// Extensions considered "first-party source" for header purposes.
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".sh"];

// Path segments that, if present anywhere in a file's repo-relative path,
// exclude it from the header requirement (generated output, vendored code,
// dependency trees). Matched as path segments, not substrings.
export const EXCLUDED_PATH_SEGMENTS = ["node_modules", "dist", "build"];

/**
 * Exact repo-relative paths excluded from the header requirement, with the
 * reason each is excluded. These are individually enumerated (not glob
 * patterns) because each exclusion is a deliberate, reviewed decision, not a
 * structural category.
 */
export const EXCLUDED_FILES = new Map([
  // Same hash-pinning reason, for the github-pdpp connector (PR #9's second commit).
  ["connectors/github-pdpp/src/connector/index.ts", "hash-locked versioned connector source (#42)"],
  ["connectors/github-pdpp/src/connector/parsers.ts", "hash-locked versioned connector source (#42)"],
  ["connectors/github-pdpp/src/connector/schemas.ts", "hash-locked versioned connector source (#42)"],
  ["connectors/github-pdpp/src/connector/types.ts", "hash-locked versioned connector source (#42)"],

  // Captured/synthetic fixture data — not first-party logic.
  [
    "packages/polyfill-connectors/fixtures/codex/source-home/deviceA/codex-home/shell-snapshots/snapshot-1.sh",
    "captured/synthetic fixture data, not first-party source",
  ],
]);

export function isExcludedPath(repoRelativePath) {
  const segments = repoRelativePath.split("/");
  if (segments.some((segment) => EXCLUDED_PATH_SEGMENTS.includes(segment))) {
    return true;
  }
  return EXCLUDED_FILES.has(repoRelativePath);
}

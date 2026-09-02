#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Check that every first-party source file carries the Apache-2.0 SPDX
 * header added in PR #9. Exclusions (hash-locked versioned connector
 * scripts, captured fixtures, generated output, etc.) live in
 * scripts/spdx-header-config.mjs — the single source of truth shared with
 * any future sweep tooling.
 *
 * Usage: node scripts/check-spdx-headers.mjs
 *   (there is only one mode; --check is accepted for convention parity with
 *   the other scripts/*.mjs checkers and is a no-op)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SOURCE_EXTENSIONS, isExcludedPath } from "./spdx-header-config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const SPDX_MARKER = "SPDX-License-Identifier: Apache-2.0";

function listTrackedSourceFiles() {
  const output = execFileSync("git", ["ls-files", "--", ...SOURCE_EXTENSIONS.map((ext) => `*${ext}`)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

function hasHeader(repoRelativePath) {
  const text = readFileSync(join(repoRoot, repoRelativePath), "utf8");
  return text.includes(SPDX_MARKER);
}

function main() {
  const files = listTrackedSourceFiles();
  const violations = [];

  for (const path of files) {
    if (isExcludedPath(path)) continue;
    if (!hasHeader(path)) {
      violations.push(path);
    }
  }

  if (violations.length > 0) {
    console.error("Missing SPDX Apache-2.0 header:");
    for (const path of violations) {
      console.error(`  ${path}`);
    }
    console.error(
      `\n${violations.length} file(s) missing the header. Add:\n` +
        `  // Copyright The PDP-Connect Contributors\n` +
        `  // SPDX-License-Identifier: Apache-2.0\n` +
        `(or the "#"-comment equivalent after the shebang for shell scripts), ` +
        `or add the file to scripts/spdx-header-config.mjs if it's genuinely exempt.`,
    );
    process.exit(1);
  }

  console.log(`SPDX header check passed: ${files.length - violations.length} file(s) checked, all headered.`);
}

main();

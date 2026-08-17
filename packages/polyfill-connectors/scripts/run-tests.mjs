// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// node --test has no "exclude this glob" flag, and --test-skip-pattern matches
// test *names*, not file paths. This resolves the test file list explicitly so
// the @pdpp/reference-contract-dependent files (out of scope for Move A — see
// tsconfig.json's exclude comment) can be left out by path.
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";

const EXCLUDED = new Set([
  "connectors/_conformance/coverage-conformance.test.ts",
  "connectors/github/index.test.ts",
  "connectors/groupme/attachment-detail-coverage.test.ts",
  "connectors/ynab/collect-terminal-coverage.test.ts",
  "connectors/amazon/proof-ingest-records.test.ts",
  "src/collector-bounded-horizon.test.ts",
  "src/collector-scope-contract.test.ts",
  // imports ../../../reference-implementation/runtime/recovery-reason-codes.ts
  // (monorepo-only; see tsconfig.json's exclude comment)
  "src/reason-display-messages.test.ts",
]);

const patterns = ["bin/**/*.test.ts", "connectors/**/*.test.ts", "src/**/*.test.ts"];
const files = [];
for (const pattern of patterns) {
  for await (const entry of glob(pattern)) {
    if (!EXCLUDED.has(entry)) {
      files.push(entry);
    }
  }
}

const child = spawn(
  process.execPath,
  ["--test", "--import", "tsx", "--test-concurrency=2", "--test-timeout=120000", ...files],
  { stdio: "inherit" }
);
child.on("exit", (code) => process.exit(code ?? 1));

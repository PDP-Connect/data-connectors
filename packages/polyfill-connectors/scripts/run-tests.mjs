// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// node --test has no "exclude this glob" flag, and --test-skip-pattern matches
// test *names*, not file paths. This resolves the test file list explicitly so
// files still out of scope for this repo (see tsconfig.json's exclude comment)
// can be left out by path.
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";

// Gate B finding B2 restored the other 7 previously-excluded semantic/
// conformance tests (vendored @pdpp/reference-contract now carries an
// `evidence` subpath, and a local reference-implementation-stand-in carries
// RUNTIME_GENERIC_REASON_CODES — see vendor/README.md and
// src/reference-implementation-stand-in/README.md for exact provenance).
// connectors/github/index.test.ts remains excluded: it drives GitHub
// connector collection against a REAL in-memory instance of the reference
// implementation's own ingest pipeline (server/db.ts, server/records.ts —
// thousands of lines each, not a narrow leaf contract), so it cannot be
// bridged with a minimal stand-in without misrepresenting what it tests. Its
// closure is the required cross-repository semantic CI job (Gate B findings
// B2/B5), not a local vendor addition.
const EXCLUDED = new Set(["connectors/github/index.test.ts"]);

const patterns = [
	"bin/**/*.test.ts",
	"connectors/**/*.test.ts",
	"src/**/*.test.ts",
];
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
	[
		"--test",
		"--import",
		"tsx",
		"--test-concurrency=2",
		"--test-timeout=120000",
		...files,
	],
	{ stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));

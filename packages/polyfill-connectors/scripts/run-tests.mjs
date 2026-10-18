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
const EXCLUDED = new Set(["../../connectors/github/index.test.ts"]);

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const rawConcurrency = process.env.TEST_CONCURRENCY ?? "2";
if (!POSITIVE_INTEGER.test(rawConcurrency)) {
	console.error(
		`TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(rawConcurrency)}`,
	);
	process.exit(2);
}

const patterns = [
	"bin/**/*.test.ts",
	"../../connectors/**/*.test.ts",
	"scripts/related-tests/*.test.ts",
	"scripts/**/*.test.mjs",
	"src/**/*.test.ts",
];

// Tests that create their own bwrap/unshare namespaces. The test-sandbox's
// bwrap blocks nested namespaces, so these run in the `namespaces` lane
// (`test-sandbox --isolate cgroup`) and every other file runs in `sandboxed`.
// src/test-runner-contract.test.ts reads this list by scanning this file.
// Package-relative paths. The lane runs one file at a time: these files share
// the repository root as global state (isolation-mechanism plants sockets
// under it that scenario-verify-strict's isolation scan then refuses).
const NAMESPACE_TESTS = new Set([
	"bin/scenario-cli.test.ts",
	"bin/scenario-fidelity.test.ts",
	"bin/scenario-verify-strict.test.ts",
	"src/scenario/filesystem-input.test.ts",
	"src/scenario/isolation-mechanism.test.ts",
]);

const args = process.argv.slice(2);
const laneIndex = args.indexOf("--lane");
const lane = laneIndex === -1 ? undefined : args[laneIndex + 1];
if (lane !== undefined && lane !== "sandboxed" && lane !== "namespaces") {
	console.error(`--lane must be "sandboxed" or "namespaces", got ${JSON.stringify(lane)}`);
	process.exit(2);
}

const files = [];
for (const pattern of patterns) {
	for await (const entry of glob(pattern)) {
		const inLane =
			lane === undefined || NAMESPACE_TESTS.has(entry) === (lane === "namespaces");
		if (!EXCLUDED.has(entry) && inLane) {
			files.push(entry);
		}
	}
}

if (args.includes("--list")) {
	console.log(files.join("\n"));
	process.exit(0);
}

const child = spawn(
	process.execPath,
	[
		"--test",
		"--import",
		"tsx",
		`--test-concurrency=${lane === "namespaces" ? "1" : rawConcurrency}`,
		"--test-timeout=120000",
		...files,
	],
	{
		stdio: "inherit",
		env: lane === undefined ? process.env : { ...process.env, TEST_LANE: lane },
	},
);
child.on("exit", (code) => process.exit(code ?? 1));

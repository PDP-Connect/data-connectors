// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// node --test has no "exclude this glob" flag, and --test-skip-pattern matches
// test *names*, not file paths. This resolves the test file list explicitly so
// files still out of scope for this repo (see tsconfig.json's exclude comment)
// can be left out by path.
import { spawn } from "node:child_process";
import { glob } from "node:fs/promises";
import { EXCLUDED_TESTS, NAMESPACE_TESTS } from "./test-lanes.mjs";

// Gate B finding B2 restored the other 7 previously-excluded semantic/
// conformance tests (vendored @pdpp/reference-contract now carries an
// `evidence` subpath, and a local reference-implementation-stand-in carries
// RUNTIME_GENERIC_REASON_CODES — see vendor/README.md and
// src/reference-implementation-stand-in/README.md for exact provenance).
// Files no lane can run are listed in EXCLUDED_TESTS (scripts/test-lanes.mjs).
// connectors/github/index.test.ts drives the connector against the reference
// implementation's own ingest pipeline, which is not in this repository. The
// cross-repository job that once ran it was retired (pdpp#284; see
// .github/workflows/cross-repo-integrity.yml), so today it runs nowhere.
const EXCLUDED = new Set(
	[...EXCLUDED_TESTS].map((file) =>
		file.startsWith("connectors/") ? `../../${file}` : file,
	),
);

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
// Four files at a time halves the suite's wall time against two for about the
// same CPU (measured in TESTING.md); six adds little and about 500 MB more.
const rawConcurrency = process.env.TEST_CONCURRENCY ?? "4";
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

const args = process.argv.slice(2);
const laneIndex = args.indexOf("--lane");
const lane = laneIndex === -1 ? undefined : args[laneIndex + 1];
if (lane !== undefined && lane !== "sandboxed" && lane !== "namespaces") {
	console.error(
		`--lane must be "sandboxed" or "namespaces", got ${JSON.stringify(lane)}`,
	);
	process.exit(2);
}

const files = [];
for (const pattern of patterns) {
	for await (const entry of glob(pattern)) {
		const inLane =
			lane === undefined ||
			NAMESPACE_TESTS.has(entry) === (lane === "namespaces");
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

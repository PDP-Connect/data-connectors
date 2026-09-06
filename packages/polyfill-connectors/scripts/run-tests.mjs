// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// node --test has no "exclude this glob" flag, and --test-skip-pattern matches
// test *names*, not file paths. This resolves the test file list explicitly so
// files still out of scope for this repo (see tsconfig.json's exclude comment)
// can be left out by path.
import { spawn } from "node:child_process";
import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
	"scripts/related-tests/*.test.ts",
	"scripts/**/*.test.mjs",
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

files.sort();
const args = process.argv.slice(2);
let issued;
let receipt;
let diagnosticsPath;
const root = resolve(process.cwd(), "../..");
if (args.length > 0) {
	if (args.length !== 2 || args[0] !== "--accounting-authority")
		throw new Error("expected --accounting-authority <issued record>");
	issued = JSON.parse(await readFile(args[1], "utf8"));
	const selected = files.map((file) => `packages/polyfill-connectors/${file}`);
	if (
		issued.schema !== "pdpp.test-run-authority/v1" ||
		issued.suite !== "polyfill-connectors" ||
		issued.profile !== "default" ||
		issued.cwd !== "packages/polyfill-connectors" ||
		typeof issued.run_id !== "string" ||
		typeof issued.nonce !== "string" ||
		selected.length === 0 ||
		JSON.stringify(issued.files) !== JSON.stringify(selected)
	) {
		throw new Error(
			"accounting authority does not match complete ordered selection",
		);
	}
	receipt = await import(
		pathToFileURL(resolve(root, "scripts/test-accounting/receipt.ts")).href
	);
	diagnosticsPath = `${args[1]}.diagnostics.jsonl`;
}
if (files.length === 0) throw new Error("test selection is empty");
const nodeArgs = [
	"--test",
	"--import",
	"tsx",
	"--test-concurrency=2",
	"--test-timeout=120000",
];
if (issued) {
	nodeArgs.push(
		"--test-reporter",
		resolve(root, "scripts/test-accounting/node-reporter.ts"),
		"--test-reporter-destination",
		"stdout",
		"--test-reporter",
		resolve(
			root,
			"packages/polyfill-connectors/scripts/test-diagnostics-reporter.mjs",
		),
		"--test-reporter-destination",
		diagnosticsPath,
	);
}
nodeArgs.push(...files);
const child = spawn(process.execPath, nodeArgs, {
	stdio: issued ? ["ignore", "pipe", "pipe"] : "inherit",
	env: issued ? { ...process.env, TEST_DIAGNOSTICS_ROOT: root } : process.env,
});
let stdout = "";
if (issued) {
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
		process.stdout.write(chunk);
	});
	child.stderr.on("data", (chunk) => process.stderr.write(chunk));
}
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		interrupted = true;
		child.kill(signal);
	});
child.on("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
});
child.on("close", async (code, signal) => {
	let status = interrupted || signal ? 1 : (code ?? 1);
	if (issued && receipt) {
		try {
			const summary = receipt.structuredNodeSummary(stdout);
			receipt.assertNamedSkipMappingsFullyConsumed(
				summary.consumed_mapping_identities,
				receipt.configuredNamedSkipMappingIdentities(
					issued.suite,
					issued.profile,
				),
			);
			if (summary.assertions === 0)
				throw new Error("runner emitted zero assertions");
			const diagnostics = (await readFile(diagnosticsPath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			const completed = diagnostics
				.filter((row) => row.event === "summary" && row.file !== null)
				.map((row) => row.file);
			if (
				new Set(completed).size !== completed.length ||
				completed.some((file) => !issued.files.includes(file))
			) {
				throw new Error(
					"diagnostic file completion identities are duplicate or unknown",
				);
			}
			if (status === 0 && completed.length !== files.length)
				throw new Error("diagnostics omit file completions");
			const { consumed_mapping_identities, ...counts } = summary;
			process.stdout.write(
				`${receipt.accountingResultLine({
					run_id: issued.run_id,
					nonce: issued.nonce,
					suite: issued.suite,
					profile: issued.profile,
					files: issued.files,
					counts: {
						...counts,
						planned_files: files.length,
						completed_files: completed.length,
					},
				})}\n`,
			);
			if (summary.failed > 0) status = status || 1;
		} catch (error) {
			process.stderr.write(`${error.message}\n`);
			status = status || 1;
		}
	}
	process.exitCode = status;
});

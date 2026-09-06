// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Each closure probe uses an independent, no-hardlink clone of committed HEAD.
// Mutations commit only inside that disposable clone. Rejection must happen on
// runAuthority itself before any test leaf starts; selection-only probes also
// demonstrate the partial-rename gap without claiming a literal code reversion.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAuthority } from "./authority.ts";
import {
	contentDigest,
	gitPath,
	type Manifest,
	planFor,
	readManifest,
	selectedRuns,
	trackedFiles,
} from "./inventory.ts";

const MULTI_GLOB_PARTIAL_RENAME_PATTERN = /unaccounted executable tests/;
const EMPTY_INCLUDE_LIST_PATTERN = /include list matches no tracked file/;
const HELPER_OR_FIXTURE_MATCH_PATTERN = /non-executable-classified file/;
const RECEIPT_BINDING_FIXTURE_DID_NOT_PASS_PATTERN =
	/receipt-binding-fixture\/default did not pass/;

function repoRoot(): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], {
		encoding: "utf8",
	}).trim();
}

// Commit identity overrides apply only to disposable fixtures, never source Git config.
const FIXTURE_COMMIT_CONFIG = [
	"-c",
	"commit.gpgsign=false",
	"-c",
	"core.hooksPath=/dev/null",
	"-c",
	"user.email=fixture@example.test",
	"-c",
	"user.name=fixture",
];

async function withRealClone(
	run: (root: string) => Promise<void> | void,
): Promise<void> {
	mkdirSync(join(homedir(), ".tmp"), { recursive: true });
	const root = mkdtempSync(join(homedir(), ".tmp", "accounting-closure-"));
	rmSync(root, { recursive: true, force: true });
	execFileSync("git", ["clone", "--no-hardlinks", "--quiet", repoRoot(), root]);
	try {
		await run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
function commitAll(root: string, message: string): void {
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync(
		"git",
		[...FIXTURE_COMMIT_CONFIG, "commit", "-q", "-s", "-m", message],
		{ cwd: root },
	);
}
function readManifestFile(root: string): Manifest {
	return JSON.parse(
		readFileSync(join(root, "test-accounting.manifest.json"), "utf8"),
	);
}
function writeManifestFile(root: string, manifestValue: Manifest): void {
	writeFileSync(
		join(root, "test-accounting.manifest.json"),
		`${JSON.stringify(manifestValue, null, 2)}\n`,
	);
}

test("e2e: a real polyfill-connectors cli.test.ts renamed to .test.js (N->N-1, sibling glob still matches) fails closed on the runAuthority path", async () => {
	await withRealClone(async (root) => {
		const beforeManifest = await readManifest(
			join(root, "test-accounting.manifest.json"),
			{ root },
		);
		const before =
			planFor(beforeManifest, trackedFiles(root), [
				"polyfill-connectors",
			]).plans.get("polyfill-connectors") ?? [];
		assert.ok(before.length > 1);

		execFileSync(
			"git",
			[
				"mv",
				"packages/polyfill-connectors/scripts/related-tests/cli.test.ts",
				"packages/polyfill-connectors/scripts/related-tests/cli.test.js",
			],
			{ cwd: root },
		);
		commitAll(
			root,
			"fixture: rename one polyfill-connectors test off its executable suffix",
		);

		const files = trackedFiles(root);
		assert.ok(
			files.includes(
				"packages/polyfill-connectors/scripts/related-tests/cli.test.js",
			),
			"the renamed path must be a real tracked file after the commit",
		);

		// Lower-level confirmation of the exact pre-wiring gap R1 found: with the
		// real mutated manifest/files, `selectedRuns`/`planFor` alone — what
		// `runAuthority` called BEFORE this fix — silently drop the plan from N
		// to N - 1 files and do not throw. This is not the assertion under test; it
		// documents why a bare `selectedRuns` call is not a sufficient gate.
		const manifestValue = await readManifest(
			join(root, "test-accounting.manifest.json"),
			{ root },
		);
		const silentPlan = planFor(manifestValue, files, ["polyfill-connectors"]);
		assert.equal(
			silentPlan.plans.get("polyfill-connectors")?.length,
			before.length - 1,
		);
		assert.doesNotThrow(() =>
			selectedRuns(manifestValue, files, { suites: ["polyfill-connectors"] }),
		);

		// The actual assertion: the real authority entry point now fails closed.
		await assert.rejects(
			runAuthority({ root, suites: ["polyfill-connectors"] }),
			MULTI_GLOB_PARTIAL_RENAME_PATTERN,
		);
	});
});

test("e2e: a suite's entire include list emptied fails closed on the runAuthority path", async () => {
	await withRealClone(async (root) => {
		const manifestValue = readManifestFile(root);
		const suite = manifestValue.suites.find(
			(entry) => entry.id === "polyfill-connectors",
		);
		assert.ok(suite, "polyfill-connectors must exist in the real manifest");
		suite.include = [
			"packages/polyfill-connectors/scripts/related-tests/does-not-exist-*.test.ts",
		];
		writeManifestFile(root, manifestValue);
		commitAll(root, "fixture: empty polyfill-connectors's include list");

		await assert.rejects(
			runAuthority({ root, suites: ["polyfill-connectors"] }),
			EMPTY_INCLUDE_LIST_PATTERN,
		);
	});
});

test("e2e: an include-matched file that classifies helper-or-fixture fails closed on the runAuthority path", async () => {
	await withRealClone(async (root) => {
		const manifestValue = readManifestFile(root);
		const suite = manifestValue.suites.find(
			(entry) => entry.id === "polyfill-connectors",
		);
		assert.ok(suite, "polyfill-connectors must exist in the real manifest");
		// Reproduces the exact real defect shape mcp-server's smoke-stdio.ts
		// originally hit (before that package moved to data-connect): a probe
		// file under a test/ directory with no .test./.spec. suffix, matched by
		// a widened include glob.
		writeFileSync(
			join(
				root,
				"packages/polyfill-connectors/scripts/related-tests/smoke-probe.ts",
			),
			"export const probe = true;\n",
		);
		suite.include = [
			...suite.include,
			"packages/polyfill-connectors/scripts/related-tests/smoke-probe.ts",
		];
		writeManifestFile(root, manifestValue);
		commitAll(
			root,
			"fixture: widen polyfill-connectors's include glob onto a helper-or-fixture file",
		);

		const files = trackedFiles(root);
		assert.ok(
			files.includes(
				"packages/polyfill-connectors/scripts/related-tests/smoke-probe.ts",
			),
		);

		await assert.rejects(
			runAuthority({ root, suites: ["polyfill-connectors"] }),
			HELPER_OR_FIXTURE_MATCH_PATTERN,
		);
	});
});

test("e2e: a suite that exits 0 but emits no structured node-test events no longer produces a receipt/transcript exit_code split", async () => {
	// Reproduces the exact defect the 0902 gate-speed report flagged:
	// `polyfill-connectors transcript does not bind the receipt`, identical on
	// both a cap=2 and cap=8 pristine origin/main run of the required-all leg
	// — a genuine pre-existing bug in the accounting harness, not a
	// concurrency artifact. Root cause: `runAuthority` wrote the transcript's
	// `end` event from `observed.exit_code` BEFORE `observedCounts` ran its
	// protocol-error coercion (`observed.exit_code ||= 1`), so a leaf process
	// that exits 0 but produces output `structuredNodeSummary` cannot parse
	// (e.g. no `PDPP_TEST_ACCOUNTING_EVENT` lines at all) left the transcript
	// recording exit_code:0 while the receipt built after the coercion
	// recorded exit_code:1 — an unrecoverable split once the transcript is
	// digest-verified and closed. This fixture reproduces that exact shape
	// without any privileged sandbox capability: a `node -e "process.exit(0)"`
	// leaf that always exits 0 and always emits zero structured events.
	await withRealClone(async (root) => {
		const manifestValue = readManifestFile(root);
		manifestValue.suites.push({
			id: "receipt-binding-fixture",
			cwd: ".",
			loader: "node-test",
			authority_argument: null,
			execution: "direct",
			profiles: [{ id: "default", required: true, skip_reasons: {} }],
			command: ["node", "-e", "process.exit(0)"],
			include: [
				"scripts/test-accounting/fixtures/receipt-binding-fixture/*.test.ts",
			],
		});
		writeManifestFile(root, manifestValue);
		mkdirSync(
			join(root, "scripts/test-accounting/fixtures/receipt-binding-fixture"),
			{ recursive: true },
		);
		writeFileSync(
			join(
				root,
				"scripts/test-accounting/fixtures/receipt-binding-fixture/noop.test.ts",
			),
			"// fixture: never actually executed by node-test; the manifest command exits 0 without running it.\n",
		);
		commitAll(
			root,
			"fixture: add a suite whose leaf exits 0 with no structured node-test events",
		);

		// Before the fix, this rejected with `receipt-binding-fixture/default
		// transcript does not bind the receipt` because the transcript recorded
		// exit_code:0 while the receipt (built after the protocol-error
		// coercion) recorded exit_code:1. After the fix, both agree, so
		// `verifyTranscript` passes and the run instead fails on the real,
		// downstream problem — the coerced exit_code is genuinely non-zero.
		await assert.rejects(
			runAuthority({ root, suites: ["receipt-binding-fixture"] }),
			RECEIPT_BINDING_FIXTURE_DID_NOT_PASS_PATTERN,
		);
		const directory = join(gitPath("test-accounting", root), "runs");
		const receiptPath = readdirSync(directory).find((path) =>
			path.endsWith(".receipt.json"),
		);
		assert.ok(receiptPath);
		const receipt = JSON.parse(
			readFileSync(join(directory, receiptPath), "utf8"),
		);
		const completion = JSON.parse(
			readFileSync(
				join(directory, `${receipt.run_id}.completion.json`),
				"utf8",
			),
		);
		const transcript = readFileSync(join(directory, receipt.transcript), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		const terminal = transcript.findLast((row) => row.event === "end");
		assert.ok(terminal);
		assert.notEqual(receipt.exit_code, 0);
		assert.equal(terminal.exit_code, receipt.exit_code);
		assert.equal(completion.observed.exit_code, receipt.exit_code);
		assert.match(receipt.counts.protocol_error, /no structured node events/);
	});
});

test("e2e: selection alone silently loses the renamed test, but authority rejects it", async () => {
	// This test does not touch authority.ts's wiring itself (that would defeat
	// the point of an independent regression test). Instead it proves the
	// CONTRAPOSITIVE directly against the real data: the exact call sequence
	// `runAuthority` used to make before this fix (`readManifest` + `trackedFiles`
	// + `selectedRuns`, with no closure check in between) does NOT throw on the
	// mutated file list, while the current, fixed sequence (closure check
	// first) DOES. Together with the test above (which exercises the real
	// `runAuthority` export), this shows the assertion is load-bearing on
	// item 1's wiring specifically, not on some other unrelated guard.
	await withRealClone(async (root) => {
		execFileSync(
			"git",
			[
				"mv",
				"packages/polyfill-connectors/scripts/related-tests/cli.test.ts",
				"packages/polyfill-connectors/scripts/related-tests/cli.test.js",
			],
			{ cwd: root },
		);
		commitAll(
			root,
			"fixture: rename one polyfill-connectors test off its executable suffix",
		);

		const manifestValue = await readManifest(
			join(root, "test-accounting.manifest.json"),
			{ root },
		);
		const files = trackedFiles(root);

		// Pre-fix behavior (no closure check): selection alone silently succeeds.
		assert.doesNotThrow(() =>
			selectedRuns(manifestValue, files, { suites: ["polyfill-connectors"] }),
		);

		// Post-fix behavior (this lane's change): the real runAuthority throws.
		await assert.rejects(
			runAuthority({ root, suites: ["polyfill-connectors"] }),
			MULTI_GLOB_PARTIAL_RENAME_PATTERN,
		);
	});
});

test("a real direct child produces a digest-bound retained authority quartet and failure cannot verify", async () => {
	await withRealClone(async (root) => {
		const value = readManifestFile(root);
		const fixtureDirectory = "scripts/test-accounting/fixtures/real-child";
		mkdirSync(join(root, fixtureDirectory), { recursive: true });
		writeFileSync(
			join(root, fixtureDirectory, "leaf.test.mjs"),
			"import test from 'node:test';import assert from 'node:assert/strict';test('real assertion',()=>assert.equal(2+2,4));\n",
		);
		value.suites.push({
			id: "direct-fixture",
			cwd: ".",
			loader: "node-test",
			execution: "direct",
			authority_argument: null,
			command: [
				process.execPath,
				"--test",
				"--test-reporter",
				join(repoRoot(), "scripts/test-accounting/node-reporter.ts"),
			],
			include: [`${fixtureDirectory}/*.test.mjs`],
			profiles: [{ id: "default", required: true, skip_reasons: {} }],
		});
		writeManifestFile(root, value);
		commitAll(root, "fixture: add an actual direct test leaf");
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const observed = await runAuthority({
			root,
			suites: ["direct-fixture"],
			env,
		});
		assert.deepEqual(observed.result.verified, ["direct-fixture/default"]);
		const receiptPath = readdirSync(observed.directory).find((path) =>
			path.endsWith(".receipt.json"),
		);
		assert.ok(receiptPath);
		const receipt = JSON.parse(
			readFileSync(join(observed.directory, receiptPath), "utf8"),
		);
		assert.equal(receipt.counts.assertions, 1);
		assert.equal(receipt.counts.passed, 1);
		assert.equal(receipt.exit_code, 0);
		assert.equal(
			contentDigest(
				readFileSync(
					join(observed.directory, `${receipt.run_id}.authority.json`),
				),
			),
			receipt.authority_sha256,
		);
		assert.equal(
			contentDigest(
				readFileSync(
					join(observed.directory, `${receipt.run_id}.completion.json`),
				),
			),
			receipt.completion_sha256,
		);
		assert.equal(
			contentDigest(readFileSync(join(observed.directory, receipt.transcript))),
			receipt.transcript_sha256,
		);
		writeFileSync(
			join(root, fixtureDirectory, "leaf.test.mjs"),
			"throw new Error('owning real-child failure');\n",
		);
		commitAll(root, "fixture: introduce an owning real child failure");
		await assert.rejects(
			runAuthority({ root, suites: ["direct-fixture"], env }),
			/direct-fixture\/default did not pass/,
		);
	});
});

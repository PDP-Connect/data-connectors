// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildReportManifest,
	hasExpectedCanaryFailure,
	parseTap,
} from "./report-integrity.mjs";

const fixture = (name) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function canary(status = "Killed") {
	const source = `${"\n".repeat(1490)}curr.created_at < prev.created_at`;
	return {
		file: "connectors/groupme/index.ts",
		location: {
			start: { line: 1491, column: 1 },
			end: { line: 1491, column: 36 },
		},
		mutatorName: "EqualityOperator",
		replacement: "curr.created_at >= prev.created_at",
		status,
		source,
	};
}

test("the exact canary assertion failure passes the report gate", () => {
	assert.equal(
		hasExpectedCanaryFailure(canary(), fixture("canary-killed.tap"), 4),
		true,
	);
});

test("a passing owner plus an unrelated import failure is rejected", () => {
	const output = fixture("unrelated-failure.tap");
	assert.equal(parseTap(output).leaves.length, 2);
	assert.equal(hasExpectedCanaryFailure(canary(), output, 2), false);
});

test("setup-only and no-test output are not TAP canary evidence", () => {
	assert.equal(
		hasExpectedCanaryFailure(
			canary(),
			"Error [ERR_MODULE_NOT_FOUND]: Cannot find package './index.ts'",
			2,
		),
		false,
	);
	assert.equal(
		hasExpectedCanaryFailure(
			canary(),
			"TAP version 13\n1..0 # SKIP no tests\n# tests 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
			2,
		),
		false,
	);
});

test("a skipped or cancelled owner test cannot establish a canary kill", () => {
	const skippedOwner = `TAP version 13\n1..3\nok 1 - ${
		"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError"
	} # SKIP unavailable\nok 2 - independent skip # SKIP unavailable\nnot ok 3 - unrelated failure\n  ---\n  code: ERR_ASSERTION\n  ...\n# tests 3\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 2\n# todo 0\n`;
	assert.equal(hasExpectedCanaryFailure(canary(), skippedOwner, 3), false);
	const cancelledOwner = `TAP version 13\n1..2\nnot ok 1 - ${
		"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError"
	}\n  ---\n  failureType: cancelledByParent\n  code: ERR_TEST_FAILURE\n  ...\nnot ok 2 - unrelated failure\n  ---\n  code: ERR_ASSERTION\n  ...\n# tests 2\n# pass 0\n# fail 1\n# cancelled 1\n# skipped 0\n# todo 0\n`;
	assert.equal(hasExpectedCanaryFailure(canary(), cancelledOwner, 2), false);
});

test("remapped command-runner id 0 stays synthetic, not leaf attribution", () => {
	const report = JSON.parse(fixture("command-all-killed.report.json"));
	const result = buildReportManifest(report);
	assert.equal(result.counts.Killed, 1);
	assert.equal(result.syntheticCommandMutants, 1);
	assert.equal(result.leafTestAttributionSupported, false);
	assert.equal(result.leafTestAttributionCount, 0);
	assert.equal(result.testsCompletedSum, 1);
	assert.equal(result.manifest[0].statusReason, "synthetic command result");
});

test("unknown statuses cannot pass as a complete mutation report", () => {
	const report = JSON.parse(fixture("command-all-killed.report.json"));
	report.files["src/example.ts"].mutants[0].status = "Pending";
	assert.throws(() => buildReportManifest(report), /Unknown or uncompleted/);
});

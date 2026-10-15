// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	buildReportManifest,
	canonicalPopulationSha256,
	classifyFailureCause,
	hasExpectedCanaryFailure,
	mutationPopulationKind,
	parseTap,
	resourceAccounting,
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

test("malformed plans and contradictory Node summaries fail closed", () => {
	const tap = fixture("canary-killed.tap");
	assert.equal(parseTap(tap.replace("1..4", "1..3")).valid, false);
	assert.equal(parseTap(tap.replace("# pass 1", "# pass 2")).valid, false);
	assert.equal(parseTap(tap.replace("1..4\n", "1..4\n1..4\n")).valid, false);
	assert.equal(parseTap(`${tap}Bail out! after the plan\n`).valid, false);
	assert.equal(parseTap(`${tap}not ok 5 - trailing assertion\n`).valid, false);
});

test("reason-bearing skip and todo directives cannot pass the canary gate", () => {
	const tap = fixture("canary-killed.tap");
	const ownerLine =
		"not ok 2 - repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
	const skipped = tap
		.replace(ownerLine, `${ownerLine} # SKIP reason`)
		.replace("# fail 1", "# fail 0")
		.replace("# skipped 2", "# skipped 3");
	const todo = tap
		.replace(ownerLine, `${ownerLine} # TODO reason`)
		.replace("# fail 1", "# fail 0")
		.replace("# todo 0", "# todo 1");
	assert.equal(parseTap(skipped).valid, true);
	assert.equal(parseTap(todo).valid, true);
	assert.equal(hasExpectedCanaryFailure(canary(), skipped, 4), false);
	assert.equal(hasExpectedCanaryFailure(canary(), todo, 4), false);
});

test("generic failure classification treats reason-bearing skip and todo as waived", () => {
	const original = fixture("canary-killed.tap");
	const ownerLine =
		"not ok 2 - repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
	for (const directive of ["SKIP reason", "TODO reason"]) {
		const isSkip = directive.startsWith("SKIP");
		const statusReason = original
			.replace(ownerLine, `${ownerLine} # ${directive}`)
			.replace("# fail 1", "# fail 0")
			.replace(
				isSkip ? "# skipped 2" : "# todo 0",
				isSkip ? "# skipped 3" : "# todo 1",
			);
		assert.equal(parseTap(statusReason).valid, true);
		assert.equal(
			classifyFailureCause({ status: "Killed", statusReason }),
			"unclassified-command-exit",
		);
	}
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
	const skippedOwner = `TAP version 13\n1..3\nok 1 - ${"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError"} # SKIP unavailable\nok 2 - independent skip # SKIP unavailable\nnot ok 3 - unrelated failure\n  ---\n  code: ERR_ASSERTION\n  ...\n# tests 3\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 2\n# todo 0\n`;
	assert.equal(hasExpectedCanaryFailure(canary(), skippedOwner, 3), false);
	const cancelledOwner = `TAP version 13\n1..2\nnot ok 1 - ${"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError"}\n  ---\n  failureType: cancelledByParent\n  code: ERR_TEST_FAILURE\n  ...\nnot ok 2 - unrelated failure\n  ---\n  code: ERR_ASSERTION\n  ...\n# tests 2\n# pass 0\n# fail 1\n# cancelled 1\n# skipped 0\n# todo 0\n`;
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

test("canonical population hash ignores Stryker mutant IDs", () => {
	const mutants = [
		{ mutantId: "old-id", canonicalIdentity: "a" },
		{ mutantId: "other", canonicalIdentity: "b" },
	];
	const renumbered = [
		{ mutantId: "9", canonicalIdentity: "b" },
		{ mutantId: "4", canonicalIdentity: "a" },
	];
	assert.equal(
		canonicalPopulationSha256(mutants),
		canonicalPopulationSha256(renumbered),
	);
});

test("population label comes from exact report ranges and rejects unknown ranges", () => {
	assert.equal(
		mutationPopulationKind(["connectors/groupme/index.ts:1491-1491"]),
		"bounded canary-only control",
	);
	assert.throws(
		() => mutationPopulationKind(["connectors/groupme/index.ts:1490-1492"]),
		/Unknown mutation ranges/,
	);
});

test("GNU time CPU is comparable only for a complete status report without subtree errors", () => {
	const receipt =
		"elapsedSeconds=12.5,userSeconds=8.25,systemSeconds=1.5,maxRssKiB=2048";
	const counts = {
		Killed: 11,
		Survived: 5,
		Timeout: 0,
		CompileError: 0,
		RuntimeError: 0,
		NoCoverage: 0,
		Ignored: 0,
	};
	const complete = resourceAccounting({
		gnuTimeOutput: receipt,
		statusCounts: counts,
		exitCode: 0,
		signal: null,
		terminationSignal: null,
	});
	assert.equal(complete.wallSeconds, 12.5);
	assert.equal(complete.cpuAccounting.status, "comparable");
	assert.equal(complete.cpuAccounting.totalSeconds, 9.75);
	assert.equal(complete.maxRssKiB, 2048);

	for (const errorStatus of ["Timeout", "CompileError", "RuntimeError"]) {
		const incomplete = resourceAccounting({
			gnuTimeOutput: receipt,
			statusCounts: { ...counts, [errorStatus]: 1 },
			exitCode: 0,
			signal: null,
			terminationSignal: null,
		});
		assert.equal(incomplete.wallSeconds, 12.5);
		assert.equal(incomplete.cpuAccounting.status, "incomplete");
		assert.equal(incomplete.cpuAccounting.comparable, false);
		assert.equal(incomplete.cpuAccounting.totalSeconds, null);
		assert.match(incomplete.cpuAccounting.reason, new RegExp(errorStatus));
	}
});

test("missing or malformed GNU time and status receipts keep CPU not comparable", () => {
	for (const [gnuTimeOutput, reportedUserSeconds] of [
		[null, null],
		["elapsedSeconds=12,userSeconds=bad", null],
		[
			"elapsedSeconds=12,userSeconds=8,systemSeconds=1,maxRssKiB=2048,userSeconds=9",
			9,
		],
	]) {
		const result = resourceAccounting({
			gnuTimeOutput,
			statusCounts: { Killed: 1 },
			exitCode: 0,
			signal: null,
			terminationSignal: null,
		});
		assert.equal(result.cpuAccounting.status, "incomplete");
		assert.equal(result.cpuAccounting.comparable, false);
		assert.equal(result.cpuAccounting.totalSeconds, null);
		assert.equal(result.cpuAccounting.reportedUserSeconds, reportedUserSeconds);
	}
	const noStatusReport = resourceAccounting({
		gnuTimeOutput:
			"elapsedSeconds=12,userSeconds=8,systemSeconds=1,maxRssKiB=2048",
		statusCounts: null,
		exitCode: 0,
		signal: null,
		terminationSignal: null,
	});
	assert.equal(noStatusReport.wallSeconds, 12);
	assert.equal(noStatusReport.cpuAccounting.status, "incomplete");
	assert.match(noStatusReport.cpuAccounting.reason, /status report missing/);
	const emptyStatusReport = resourceAccounting({
		gnuTimeOutput:
			"elapsedSeconds=12,userSeconds=8,systemSeconds=1,maxRssKiB=2048",
		statusCounts: { Killed: 0 },
		exitCode: 0,
		signal: null,
		terminationSignal: null,
	});
	assert.equal(emptyStatusReport.cpuAccounting.status, "incomplete");
});

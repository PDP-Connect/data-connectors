// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const evidence = "reports/mutation/evidence";
const ownerName =
	"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
const expectedMessage =
	"a non-ascending forward page must fail, not be silently trusted";
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) =>
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const source = readFileSync("connectors/groupme/index.ts", "utf8").replace(
	/\r\n/g,
	"\n",
);
const lines = source.split("\n");
const offset = (line, column) =>
	lines.slice(0, line - 1).reduce((n, text) => n + text.length + 1, 0) +
	column -
	1;
const baseline = readJson(`${evidence}/vitest-baseline.json`);
const instrumented = readJson(
	`${evidence}/vitest-instrumented-unactivated.json`,
);
const ownerBaseline = readJson(`${evidence}/vitest-owner-baseline.json`);
const report = readJson("reports/mutation/groupme-vitest-mutation.json");
const ownerReport = readJson(
	"reports/mutation/groupme-owner-canary-command.json",
);
const mutants = Object.entries(report.files).flatMap(([file, result]) =>
	result.mutants.map((mutant) => ({ file, ...mutant })),
);
const ownerMutants = Object.entries(ownerReport.files).flatMap(
	([file, result]) => result.mutants.map((mutant) => ({ file, ...mutant })),
);
const statuses = [
	"Killed",
	"Survived",
	"Timeout",
	"CompileError",
	"RuntimeError",
	"NoCoverage",
	"Ignored",
];
const counts = Object.fromEntries(
	statuses.map((status) => [
		status,
		mutants.filter((mutant) => mutant.status === status).length,
	]),
);
const unknownStatuses = mutants.filter(
	(mutant) => !statuses.includes(mutant.status),
);
const tests = new Map(
	Object.entries(report.testFiles).flatMap(([file, result]) =>
		result.tests.map((test) => [test.id, { file, name: test.name }]),
	),
);
const normalizeStatus = (status) =>
	({ 0: "passed", 1: "failed", 2: "pending", skipped: "pending" })[status] ??
	status;
const testKey = (file, name) =>
	`${path.basename(file).replace(".vitest.ts", ".test.ts")}#${name}`;
const reportTests = (result) =>
	new Map(
		result.testResults.flatMap((file) =>
			file.assertionResults.map((test) => [
				testKey(file.name, test.fullName),
				normalizeStatus(test.status),
			]),
		),
	);
function canonicalIdentity(mutant) {
	const file = mutant.file ?? mutant.fileName;
	const relativeFile = (
		path.isAbsolute(file) ? path.relative(process.cwd(), file) : file
	).replaceAll("\\", "/");
	const { start, end } = mutant.location;
	const original = source.slice(
		offset(start.line, start.column),
		offset(end.line, end.column),
	);
	return createHash("sha256")
		.update(
			JSON.stringify([
				relativeFile,
				start.line,
				start.column,
				end.line,
				end.column,
				mutant.mutatorName,
				original,
				mutant.replacement.replace(/\r\n/g, "\n"),
			]),
		)
		.digest("hex");
}
function event(suffix) {
	const files = readdirSync("reports/mutation/events").filter((file) =>
		file.endsWith(`${suffix}.json`),
	);
	assert.equal(files.length, 1, `expected one ${suffix} event`);
	return readJson(`reports/mutation/events/${files[0]}`);
}

// Write complete raw-status manifests before gates so a rejected run stays diagnosable.
const manifest = mutants
	.map((mutant) => ({
		id: mutant.id,
		canonicalIdentity: canonicalIdentity(mutant),
		file: mutant.file.replaceAll("\\", "/"),
		location: mutant.location,
		mutatorName: mutant.mutatorName,
		original: source.slice(
			offset(mutant.location.start.line, mutant.location.start.column),
			offset(mutant.location.end.line, mutant.location.end.column),
		),
		replacement: mutant.replacement.replace(/\r\n/g, "\n"),
		status: mutant.status,
		static: mutant.static ?? null,
		coveredBy: mutant.coveredBy ?? [],
		testsCompleted: mutant.testsCompleted ?? null,
		killedBy: mutant.killedBy ?? [],
	}))
	.sort((a, b) => a.canonicalIdentity.localeCompare(b.canonicalIdentity));
const population = manifest.map(
	({
		id,
		canonicalIdentity,
		file,
		location,
		mutatorName,
		original,
		replacement,
	}) => ({
		mutantId: id,
		canonicalIdentity,
		file,
		location,
		mutatorName,
		originalText: original,
		replacement,
	}),
);
const populationJson = `${JSON.stringify(population, null, 2)}\n`;
const populationSha256 = createHash("sha256")
	.update(populationJson)
	.digest("hex");
const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = createHash("sha256").update(manifestJson).digest("hex");
writeFileSync(`${evidence}/canonical-population.json`, populationJson);
writeFileSync(
	`${evidence}/canonical-population.sha256`,
	`${populationSha256}  canonical-population.json\n`,
);
writeFileSync(`${evidence}/canonical-mutants.json`, manifestJson);
writeFileSync(
	`${evidence}/canonical-mutants.sha256`,
	`${manifestSha256}  canonical-mutants.json\n`,
);
writeJson(`${evidence}/mutation-summary.json`, {
	generated: mutants.length,
	counts,
	unknownStatuses: unknownStatuses.map(({ id, status }) => ({ id, status })),
	canonicalPopulationSha256: populationSha256,
	canonicalManifestSha256: manifestSha256,
	validation: "pending",
});

assert.deepEqual(report.config.mutate, [
	"connectors/groupme/index.ts:1487-1495",
	"connectors/groupme/index.ts:1528-1529",
]);
assert.equal(report.config.coverageAnalysis, "perTest");
assert.equal(report.config.concurrency, 2);
assert.equal(report.config.timeoutMS, 120000);
assert.equal(report.config.timeoutFactor, 1.5);
assert.equal(report.config.disableBail, true);
assert.deepEqual(report.config.mutator.excludedMutations, []);
assert.equal(unknownStatuses.length, 0);
assert.equal(
	Object.values(counts).reduce((sum, count) => sum + count, 0),
	mutants.length,
);
assert.ok(mutants.length > 0);
assert.equal(
	new Set(manifest.map((mutant) => mutant.canonicalIdentity)).size,
	mutants.length,
);

assert.equal(baseline.numTotalTests, 221);
assert.equal(baseline.numPassedTests, 219);
assert.equal(baseline.numFailedTests, 0);
assert.equal(baseline.numPendingTests, 2);
assert.equal(baseline.testResults.length, 14);
assert.equal(instrumented.numTotalTests, 221);
assert.equal(instrumented.numPassedTests, 219);
assert.equal(instrumented.numFailedTests, 0);
assert.equal(instrumented.numPendingTests, 2);
assert.equal(instrumented.testResults.length, 14);
const oracleTests = reportTests(baseline);
const instrumentedTests = reportTests(instrumented);
assert.deepEqual(
	[...instrumentedTests].sort(),
	[...oracleTests].sort(),
	"native Vitest JSON under Stryker instrumentation must match all 221 oracle identities/statuses",
);
const dryRun = event("onDryRunCompleted");
assert.equal(dryRun.result.status, "complete");
const executed = new Map(
	dryRun.result.tests.map((test) => [
		testKey(test.fileName ?? test.id.split("#")[0], test.name),
		normalizeStatus(test.status),
	]),
);
const expectedExecuted = new Map(
	[...oracleTests].filter(([, status]) => status === "passed"),
);
assert.deepEqual(
	[...executed].sort(),
	[...expectedExecuted].sort(),
	"Stryker events identify 219 executed leaves; its Vitest runner omits skipped tasks with no result",
);
writeJson(
	`${evidence}/instrumented-baseline-identities.json`,
	[...instrumentedTests].map(([id, status]) => ({ id, status })),
);
writeJson(
	`${evidence}/stryker-dry-run-executed-identities.json`,
	dryRun.result.tests,
);
const ownerBaselineTests = ownerBaseline.testResults
	.flatMap((file) => file.assertionResults)
	.filter((test) => test.fullName === ownerName);
assert.equal(ownerBaseline.numPassedTests, 1);
assert.equal(ownerBaseline.numFailedTests, 0);
assert.equal(ownerBaselineTests.length, 1);
assert.equal(ownerBaselineTests[0].status, "passed");

const activationRisk = mutants.filter((mutant) => mutant.static !== false);
assert.equal(
	activationRisk.length,
	0,
	"static/unknown-static mutants are untrusted under core 10.0.0 #6145",
);
assert.equal(counts.NoCoverage, 0);
assert.equal(counts.Ignored, 0);
assert.equal(counts.CompileError, 0);
assert.equal(counts.RuntimeError, 0);
for (const mutant of mutants) {
	assert.ok(
		(mutant.coveredBy ?? []).every((id) => tests.has(id)),
		`unmapped selected test for mutant ${mutant.id}`,
	);
	if (["Killed", "Survived", "Timeout"].includes(mutant.status))
		assert.ok(
			mutant.testsCompleted > 0,
			`zero completed tests for mutant ${mutant.id}`,
		);
	if (["Killed", "Survived"].includes(mutant.status)) {
		const expectedCount = mutant.coveredBy.filter((id) => {
			const test = tests.get(id);
			return (
				test && oracleTests.get(testKey(test.file, test.name)) !== "pending"
			);
		}).length;
		assert.equal(
			mutant.testsCompleted,
			expectedCount,
			`selected identity/count mismatch for mutant ${mutant.id}`,
		);
	}
}

const canary = mutants.filter(
	(mutant) =>
		mutant.file === "connectors/groupme/index.ts" &&
		mutant.location.start.line === 1491 &&
		mutant.mutatorName === "EqualityOperator" &&
		mutant.replacement === "curr.created_at >= prev.created_at",
);
assert.equal(canary.length, 1);
assert.equal(canary[0].status, "Killed");
const owner = [...tests.entries()].find(
	([, test]) =>
		test.file.endsWith("/incremental-frontier.vitest.ts") &&
		test.name === ownerName,
);
assert.ok(owner);
assert.ok(canary[0].coveredBy.includes(owner[0]));
assert.ok(canary[0].killedBy.includes(owner[0]));
const plan = event("onMutationTestingPlanReady").mutantPlans.find(
	(item) => item.mutant.id === canary[0].id,
);
assert.ok(plan);
assert.equal(plan.plan, "Run");
assert.equal(plan.runOptions.mutantActivation, "runtime");
assert.equal(plan.runOptions.reloadEnvironment, false);
assert.ok(
	plan.runOptions.testFilter.some(
		(id) =>
			id.endsWith(`#${ownerName}`) &&
			id.includes("incremental-frontier.vitest.ts"),
	),
);
const ownerCanary = ownerMutants.filter(
	(mutant) =>
		mutant.file === "connectors/groupme/index.ts" &&
		mutant.location.start.line === 1491 &&
		mutant.mutatorName === "EqualityOperator" &&
		mutant.replacement === canary[0].replacement,
);
assert.equal(ownerCanary.length, 1);
assert.equal(canonicalIdentity(ownerCanary[0]), canonicalIdentity(canary[0]));
assert.equal(ownerCanary[0].status, "Killed");
assert.ok(ownerCanary[0].statusReason.includes(ownerName));
assert.ok(ownerCanary[0].statusReason.includes(expectedMessage));
assert.ok(ownerCanary[0].statusReason.includes("false !== true"));

writeJson(`${evidence}/mutation-summary.json`, {
	generated: mutants.length,
	counts,
	validation: "passed",
	canonicalPopulationSha256: populationSha256,
	canonicalPopulationHashInput:
		"SHA-256 of pretty JSON plus LF; sorted records match A's canonical-population format",
	canonicalManifestSha256: manifestSha256,
	canary: {
		id: canary[0].id,
		canonicalIdentity: canonicalIdentity(canary[0]),
		status: canary[0].status,
		coveredBy: canary[0].coveredBy,
		killedBy: canary[0].killedBy,
		activation: plan.runOptions.mutantActivation,
	},
	ownerOnlyInstrumentedCanary: {
		canonicalIdentity: canonicalIdentity(ownerCanary[0]),
		status: ownerCanary[0].status,
		statusReason: ownerCanary[0].statusReason,
		activationMode:
			"built-in command runner sets ACTIVE_MUTANT in a fresh Vitest CLI process selected by anchored owner title",
	},
	selectedAndCompletionCounts:
		"coveredBy lists selected identities; testsCompleted is only an aggregate count, not completed identity evidence.",
	instrumentedBaseline: {
		exact221IdentityStatusParity: true,
		eventExecutedLeaves: executed.size,
		eventOmittedSkippedLeaves: 2,
	},
	ranges: {
		first: "ascending-order predicate, 1487-1495",
		second:
			"helper/progress-message-literal only, 1528-1529; no loop-entry/page-cap claim",
	},
});

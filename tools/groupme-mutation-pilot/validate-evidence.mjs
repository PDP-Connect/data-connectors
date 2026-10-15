// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertOwnerCanaryProof } from "./owner-canary-proof.mjs";

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
const testIdentityForRunnerId = (id) => {
	const test = tests.get(id);
	return test ? testKey(test.file, test.name) : `unresolved:${id}`;
};
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
	// Stryker reporter events expose zero-based source ranges, while its JSON
	// report uses one-based coordinates. Normalize events before hashing.
	const eventCoordinates = mutant.fileName !== undefined;
	const coordinate = (point) => ({
		line: point.line + Number(eventCoordinates),
		column: point.column + Number(eventCoordinates),
	});
	const normalizedStart = coordinate(start);
	const normalizedEnd = coordinate(end);
	const original = source.slice(
		offset(normalizedStart.line, normalizedStart.column),
		offset(normalizedEnd.line, normalizedEnd.column),
	);
	return createHash("sha256")
		.update(
			JSON.stringify([
				relativeFile,
				normalizedStart.line,
				normalizedStart.column,
				normalizedEnd.line,
				normalizedEnd.column,
				mutant.mutatorName,
				original,
				mutant.replacement.replace(/\r\n/g, "\n"),
			]),
		)
		.digest("hex");
}
function events(suffix, subdirectory = "") {
	const directory = path.join("reports/mutation/events", subdirectory);
	return readdirSync(directory)
		.filter((file) => file.endsWith(`${suffix}.json`))
		.map((file) => readJson(path.join(directory, file)));
}
function event(suffix, subdirectory = "") {
	const matches = events(suffix, subdirectory);
	assert.equal(matches.length, 1, `expected one ${suffix} event`);
	return matches[0];
}

// Write complete raw-status manifests before gates so a rejected run stays diagnosable.
const manifest = mutants
	.map((mutant) => ({
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
		coveredBy: (mutant.coveredBy ?? []).map(testIdentityForRunnerId).sort(),
		testsCompleted: mutant.testsCompleted ?? null,
		killedBy: (mutant.killedBy ?? []).map(testIdentityForRunnerId).sort(),
	}))
	.sort((a, b) => a.canonicalIdentity.localeCompare(b.canonicalIdentity));
const population = manifest.map(
	({
		canonicalIdentity,
		file,
		location,
		mutatorName,
		original,
		replacement,
	}) => ({
		canonicalIdentity,
		file,
		location,
		mutatorName,
		originalText: original,
		replacement,
	}),
);
const runnerIdMap = mutants
	.map((mutant) => ({
		canonicalIdentity: canonicalIdentity(mutant),
		runnerId: mutant.id,
	}))
	.sort((a, b) => a.canonicalIdentity.localeCompare(b.canonicalIdentity));
const testRunnerIdMap = [...tests.entries()]
	.map(([runnerId, test]) => ({
		runnerId,
		testIdentity: testKey(test.file, test.name),
	}))
	.sort((a, b) => a.testIdentity.localeCompare(b.testIdentity));
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
writeJson(`${evidence}/mutant-runner-id-map.json`, runnerIdMap);
writeJson(`${evidence}/test-runner-id-map.json`, testRunnerIdMap);
writeJson(`${evidence}/mutation-summary.json`, {
	generated: mutants.length,
	counts,
	populationKind: report.config.mutate,
	unknownStatuses: unknownStatuses.map((mutant) => ({
		canonicalIdentity: canonicalIdentity(mutant),
		status: mutant.status,
	})),
	canonicalPopulationSha256: populationSha256,
	canonicalManifestSha256: manifestSha256,
	validation: "pending",
});

assert.deepEqual(report.config.mutate, [
	"connectors/groupme/index.ts:1487-1495",
	"connectors/groupme/index.ts:1528-1529",
]);
assert.deepEqual(ownerReport.config.mutate, [
	"connectors/groupme/index.ts:1491-1491",
]);
assert.deepEqual(ownerReport.config.mutator.excludedMutations, [
	"ConditionalExpression",
	"LogicalOperator",
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
assert.equal(oracleTests.size, 221);
assert.equal(instrumentedTests.size, 221);
assert.equal(
	[...instrumentedTests.values()].filter((status) => status === "passed")
		.length,
	219,
);
assert.equal(
	[...instrumentedTests.values()].filter((status) => status === "pending")
		.length,
	2,
);
assert.deepEqual(
	[...instrumentedTests].sort(),
	[...oracleTests].sort(),
	"native Vitest JSON under Stryker instrumentation must match all 221 oracle identities/statuses",
);
const dryRun = event("onDryRunCompleted", "main");
assert.equal(dryRun.result.status, "complete");
assert.deepEqual(dryRun.result.tests, [
	{ id: "all", name: "All tests", status: 0 },
]);
// Stryker's command-runner event reports one aggregate command result. The
// native Vitest JSON written by that instrumented command carries leaf IDs
// and statuses, so use it for parity and retain the event as phase evidence.
writeJson(
	`${evidence}/instrumented-baseline-identities.json`,
	[...instrumentedTests].map(([id, status]) => ({ id, status })),
);
const ownerBaselineTests = ownerBaseline.testResults
	.flatMap((file) => file.assertionResults)
	.filter((test) => test.fullName === ownerName);
assert.equal(ownerBaseline.numPassedTests, 1);
assert.equal(ownerBaseline.numFailedTests, 0);
assert.equal(ownerBaselineTests.length, 1);
assert.equal(ownerBaselineTests[0].status, "passed");
assert.equal(
	instrumentedTests.get(
		testKey("connectors/groupme/incremental-frontier.vitest.ts", ownerName),
	),
	"passed",
	"the full unactivated instrumented baseline must pass the owner test",
);

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
		mutant.location.start.column === 23 &&
		mutant.location.end.line === 1491 &&
		mutant.location.end.column === 56 &&
		mutant.mutatorName === "EqualityOperator" &&
		source.slice(
			offset(mutant.location.start.line, mutant.location.start.column),
			offset(mutant.location.end.line, mutant.location.end.column),
		) === "curr.created_at < prev.created_at" &&
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
const plan = event("onMutationTestingPlanReady", "main").mutantPlans.find(
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
		mutant.location.start.column === 23 &&
		mutant.location.end.line === 1491 &&
		mutant.location.end.column === 56 &&
		mutant.mutatorName === "EqualityOperator" &&
		source.slice(
			offset(mutant.location.start.line, mutant.location.start.column),
			offset(mutant.location.end.line, mutant.location.end.column),
		) === "curr.created_at < prev.created_at" &&
		mutant.replacement === canary[0].replacement,
);
const ownerSelectedMutants = ownerMutants.filter(
	(mutant) => mutant.status !== "Ignored",
);
assert.equal(ownerSelectedMutants.length, 2);
assert.ok(
	ownerSelectedMutants.every(
		(mutant) => mutant.mutatorName === "EqualityOperator",
	),
	"owner-only Stryker run selected an unrelated mutation kind",
);
assert.equal(ownerCanary.length, 1);
const ownerCanaryPlan = event(
	"onMutationTestingPlanReady",
	"owner-canary",
).mutantPlans.find((item) => item.mutant.id === ownerCanary[0].id);
assert.ok(ownerCanaryPlan, "native Stryker plan omitted the owner canary");
assert.equal(ownerCanaryPlan.plan, "Run");
assert.equal(
	canonicalIdentity(ownerCanaryPlan.runOptions.activeMutant),
	canonicalIdentity(ownerCanary[0]),
	"native Stryker plan must activate this exact canonical mutant",
);
const ownerCanaryResult = events("onMutantTested", "owner-canary").find(
	(result) => result.id === ownerCanary[0].id,
);
assert.ok(
	ownerCanaryResult,
	"native Stryker event omitted the active owner canary result",
);
assertOwnerCanaryProof({
	expectedIdentity: canonicalIdentity(canary[0]),
	actualIdentity: canonicalIdentity(ownerCanary[0]),
	activeIdentity: canonicalIdentity(ownerCanaryPlan.runOptions.activeMutant),
	mutation: ownerCanary[0],
	plan: ownerCanaryPlan,
	result: ownerCanaryResult,
	ownerName,
	expectedMessage,
	failureLocation: "incremental-frontier.vitest.ts:654",
});

writeJson(`${evidence}/mutation-summary.json`, {
	generated: mutants.length,
	counts,
	validation: "passed",
	populationKind: report.config.mutate,
	canonicalPopulationSha256: populationSha256,
	canonicalPopulationHashInput:
		"SHA-256 of pretty JSON plus LF over sorted canonical tuples, without runner IDs",
	canonicalManifestSha256: manifestSha256,
	canary: {
		id: canary[0].id,
		canonicalIdentity: canonicalIdentity(canary[0]),
		file: canary[0].file,
		location: canary[0].location,
		mutatorName: canary[0].mutatorName,
		original: source.slice(
			offset(canary[0].location.start.line, canary[0].location.start.column),
			offset(canary[0].location.end.line, canary[0].location.end.column),
		),
		replacement: canary[0].replacement,
		status: canary[0].status,
		coveredBy: canary[0].coveredBy.map(testIdentityForRunnerId).sort(),
		killedBy: canary[0].killedBy.map(testIdentityForRunnerId).sort(),
		activation: plan.runOptions.mutantActivation,
	},
	ownerOnlyInstrumentedCanary: {
		populationKind: ownerReport.config.mutate,
		canonicalIdentity: canonicalIdentity(ownerCanary[0]),
		file: ownerCanary[0].file,
		location: ownerCanary[0].location,
		mutatorName: ownerCanary[0].mutatorName,
		original: source.slice(
			offset(
				ownerCanary[0].location.start.line,
				ownerCanary[0].location.start.column,
			),
			offset(
				ownerCanary[0].location.end.line,
				ownerCanary[0].location.end.column,
			),
		),
		replacement: ownerCanary[0].replacement,
		status: ownerCanary[0].status,
		statusReason: ownerCanary[0].statusReason,
		activation: ownerCanaryPlan.runOptions.mutantActivation,
		activeMutantId: ownerCanaryPlan.runOptions.activeMutant.id,
		activationMode:
			"Stryker applies the active mutation in its sandbox; the anchored Vitest title pattern selects the owner test",
	},
	selectedAndCompletionCounts:
		"coveredBy lists selected identities; testsCompleted is only an aggregate count, not completed identity evidence.",
	instrumentedBaseline: {
		exact221IdentityStatusParity: true,
		strykerDryRunCommandStatus: dryRun.result.status,
		strykerDryRunCommandResults: dryRun.result.tests.length,
		leafIdentitiesFrom:
			"native Vitest JSON emitted by the instrumented command",
	},
	ranges: {
		first: "ascending-order predicate, 1487-1495",
		second:
			"helper/progress-message-literal only, 1528-1529; no loop-entry/page-cap claim",
	},
});

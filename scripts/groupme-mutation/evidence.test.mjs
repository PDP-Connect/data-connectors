// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canary, canaryReplacementText, locateCanary } from "./canary.mjs";
import { verifyInvocation } from "./evidence.mjs";

const anchor = { line: 1491, column: 23 };
const owner = canary.owner;
const nativeOther = "connectors/groupme/index.test.ts";

function location(line, column, endColumn) {
	return {
		start: { line, column },
		end: { line, column: endColumn },
	};
}

// A Stryker-shaped invocation: one canary killed by its owner, one survivor, one timeout.
function invocation(overrides = {}) {
	const mutants = [
		{
			id: "6",
			mutatorName: "EqualityOperator",
			replacement: canaryReplacementText,
			location: location(anchor.line, anchor.column, 56),
			status: "Killed",
			testsCompleted: 7,
			killedBy: ["owner-test-id"],
		},
		{
			id: "0",
			mutatorName: "ConditionalExpression",
			replacement: "true",
			location: location(1491, 7, 56),
			status: "Survived",
			testsCompleted: 7,
			killedBy: [],
		},
		{
			id: "9",
			mutatorName: "ConditionalExpression",
			replacement: "false",
			location: location(1488, 18, 37),
			status: "Timeout",
			testsCompleted: 0,
			killedBy: [],
		},
	];
	const report = {
		files: {
			"connectors/groupme/index.ts": { language: "ts", source: "", mutants },
		},
		testFiles: {
			[owner.file]: { tests: [{ id: "owner-test-id", name: owner.name }] },
			[nativeOther]: { tests: [] },
		},
	};
	const plan = (id, activation = "runtime") => ({
		plan: "Run",
		mutant: {
			...structuredClone(mutants.find((m) => m.id === id)),
			location: Object.fromEntries(
				Object.entries(mutants.find((m) => m.id === id).location)
					.map(([edge, point]) => [edge, {
						line: point.line - 1,
						column: point.column - 1,
					}]),
			),
		},
		runOptions: { activeMutant: { id }, mutantActivation: activation },
	});
	const receipt = {
		activeMutantId: "6",
		file: owner.file,
		name: owner.name,
		state: "fail",
		errors: [
			{
				// The shape Vitest records: the custom message plus the assertion diff.
				message: `${owner.message}\n\ntrue !== false\n`,
				actual: "true",
				expected: "false",
				stack: `AssertionError: ${owner.message}\n    at ${owner.file}:370:9`,
			},
		],
	};
	const events = [
		{ name: "onDryRunCompleted", data: {} },
		{
			name: "onMutationTestingPlanReady",
			data: { mutantPlans: mutants.map((m) => plan(m.id)) },
		},
		...mutants.map((m) => ({
			name: "onMutantTested",
			data: structuredClone(m),
		})),
	];
	return {
		events,
		report,
		receipts: [receipt],
		selectedRanges: [
			{ path: "connectors/groupme/index.ts", ranges: [[1487, 1495]] },
		],
		anchor,
		...structuredClone(overrides),
	};
}

function verify(overrides) {
	return verifyInvocation(invocation(overrides));
}

test("real Stryker plan locations are zero-based while tested/report locations are one-based", () => {
	const input = invocation();
	const plans = input.events.find((e) => e.name === "onMutationTestingPlanReady").data.mutantPlans;
	for (const plan of plans) {
		const report = input.report.files[canary.file].mutants.find((m) => m.id === plan.mutant.id);
		const tested = input.events.find((e) => e.name === "onMutantTested" && e.data.id === report.id).data;
		for (const edge of ["start", "end"]) {
			assert.equal(plan.mutant.location[edge].line, report.location[edge].line - 1);
			assert.equal(plan.mutant.location[edge].column, report.location[edge].column - 1);
		}
		assert.deepEqual(tested.location, report.location);
	}
	assert.equal(verifyInvocation(input).canary.id, "6");
});

for (const origin of ["planned", "tested"]) {
	for (const edge of ["start", "end"]) {
		for (const axis of ["line", "column"]) {
			test(origin + " location rejects a one-unit mismatch in " + edge + "." + axis, () => {
				const input = invocation();
				const data = origin === "planned"
					? input.events.find((e) => e.name === "onMutationTestingPlanReady").data.mutantPlans[1].mutant
					: input.events.find((e) => e.name === "onMutantTested" && e.data.id === "0").data;
				data.location[edge][axis] += 1;
				assert.throws(() => verifyInvocation(input), new RegExp(origin + " identity location differs for mutant 0"));
			});
		}
	}
}

test("a complete invocation proves the canary and reports changed-code statuses", () => {
	const proof = verify();
	assert.equal(proof.canary.id, "6");
	assert.equal(proof.canary.activation, "runtime");
	assert.deepEqual(
		proof.canary.killedBy.map((test) => test.name),
		[owner.name],
	);
	assert.deepEqual(proof.population, {
		planned: 3,
		tested: 3,
		reported: 3,
		changed: 3,
		counts: { Killed: 1, Survived: 1, Timeout: 1 },
	});
	assert.deepEqual(
		proof.survivors.map((m) => m.id),
		["0"],
	);
	assert.deepEqual(
		proof.timeouts.map((m) => m.id),
		["9"],
	);
});

test("a canary that survives, times out or is not killed is never a proof", () => {
	const survived = invocation();
	survived.report.files["connectors/groupme/index.ts"].mutants[0].status =
		"Survived";
	survived.events.find((e) => e.name === "onMutantTested").data.status =
		"Survived";
	assert.throws(
		() => verifyInvocation(survived),
		/canary status is Survived, not Killed/,
	);
	const timedOut = invocation();
	timedOut.report.files["connectors/groupme/index.ts"].mutants[0].status =
		"Timeout";
	timedOut.events.find((e) => e.name === "onMutantTested").data.status =
		"Timeout";
	assert.throws(
		() => verifyInvocation(timedOut),
		/canary status is Timeout, not Killed/,
	);
});

test("zero completed tests, a compile failure or an import-style failure is not a kill", () => {
	const zero = invocation();
	zero.report.files["connectors/groupme/index.ts"].mutants[0].testsCompleted =
		0;
	assert.throws(() => verifyInvocation(zero), /completed no tests/);
	for (const status of ["CompileError", "RuntimeError"]) {
		const broken = invocation();
		broken.report.files["connectors/groupme/index.ts"].mutants[0].status =
			status;
		broken.events.find((e) => e.name === "onMutantTested").data.status = status;
		assert.throws(
			() => verifyInvocation(broken),
			new RegExp("canary status is " + status),
		);
	}
});

test("a canary killed only by a test outside the owner or native files fails", () => {
	const wrongOwner = invocation();
	wrongOwner.report.testFiles[owner.file].tests[0].name = "some other test";
	assert.throws(
		() => verifyInvocation(wrongOwner),
		/not killed by its owner test/,
	);
	const foreign = invocation();
	foreign.report.testFiles["scripts/groupme-mutation/tools.test.mjs"] = {
		tests: [{ id: "foreign", name: owner.name }],
	};
	foreign.report.files["connectors/groupme/index.ts"].mutants[0].killedBy = [
		"foreign",
	];
	assert.throws(
		() => verifyInvocation(foreign),
		/unreported test|outside native GroupMe files|not killed by its owner test/,
	);
	const unknown = invocation();
	unknown.report.files["connectors/groupme/index.ts"].mutants[0].killedBy = [
		"command-runner-id",
	];
	assert.throws(() => verifyInvocation(unknown), /unreported test/);
});

test("the owner receipt must come from this run and fail the custom assertion", () => {
	const missing = invocation({ receipts: [] });
	assert.throws(() => verifyInvocation(missing), /no owner receipt/);
	const otherRun = invocation();
	otherRun.receipts[0].activeMutantId = "0";
	assert.throws(() => verifyInvocation(otherRun), /no owner receipt/);
	const importFailure = invocation();
	importFailure.receipts[0].errors = [
		{ message: "Cannot find module", actual: undefined, expected: undefined },
	];
	assert.throws(
		() => verifyInvocation(importFailure),
		/did not fail its custom assertion/,
	);
	// Vitest appends the assertion diff to the message; the prefix is the owner's text.
	assert.match(
		invocation().receipts[0].errors[0].message,
		/must not fail the forward walk\n\ntrue !== false\n$/,
	);
	const passing = invocation();
	passing.receipts[0].state = "pass";
	assert.throws(() => verifyInvocation(passing), /receipt state is pass/);
});

test("static activation and early results cannot prove the canary", () => {
	const staticRun = invocation();
	staticRun.events.find(
		(e) => e.name === "onMutationTestingPlanReady",
	).data.mutantPlans[0].runOptions.mutantActivation = "static";
	assert.throws(
		() => verifyInvocation(staticRun),
		/planned for runtime activation/,
	);
	const early = invocation();
	early.events.find(
		(e) => e.name === "onMutationTestingPlanReady",
	).data.mutantPlans[1] = { plan: "EarlyResult", mutant: { id: "0" } };
	assert.throws(() => verifyInvocation(early), /early result planned/);
});

test("planned, tested and reported populations must be the same complete set", () => {
	const missingTest = invocation();
	missingTest.events = missingTest.events.filter(
		(e) => !(e.name === "onMutantTested" && e.data.id === "9"),
	);
	assert.throws(() => verifyInvocation(missingTest), /populations disagree/);
	const extraReport = invocation();
	extraReport.report.files["connectors/groupme/index.ts"].mutants.push({
		id: "42",
		mutatorName: "BlockStatement",
		replacement: "{}",
		location: location(1500, 1, 2),
		status: "Survived",
		testsCompleted: 0,
		killedBy: [],
	});
	assert.throws(() => verifyInvocation(extraReport), /populations disagree/);
	const mismatch = invocation();
	mismatch.events.find(
		(e) => e.name === "onMutantTested" && e.data.id === "0",
	).data.status = "Killed";
	assert.throws(() => verifyInvocation(mismatch), /status differ/);
	const unknownStatus = invocation();
	unknownStatus.report.files["connectors/groupme/index.ts"].mutants[1].status =
		"Mystery";
	assert.throws(
		() => verifyInvocation(unknownStatus),
		/unknown status Mystery/,
	);
});

test("missing or duplicate Stryker lifecycle events fail closed", () => {
	const noDryRun = invocation();
	noDryRun.events = noDryRun.events.filter(
		(e) => e.name !== "onDryRunCompleted",
	);
	assert.throws(
		() => verifyInvocation(noDryRun),
		/expected one onDryRunCompleted/,
	);
	const twoPlans = invocation();
	twoPlans.events.push(structuredClone(twoPlans.events[1]));
	assert.throws(
		() => verifyInvocation(twoPlans),
		/expected one onMutationTestingPlanReady/,
	);
});

test("the canary must still name exactly one operator in the production source", () => {
	const wrongLine = invocation({ anchor: { line: 1492, column: 23 } });
	assert.throws(
		() => verifyInvocation(wrongLine),
		/canary identity matched 0 mutants/,
	);
});

test("the canary anchor occurs exactly once in the real production source", () => {
	const source = readFileSync(
		fileURLToPath(
			new URL("../../connectors/groupme/index.ts", import.meta.url),
		),
		"utf8",
	);
	assert.deepEqual(locateCanary(source), { line: 1491, column: 23 });
	assert.throws(
		() => locateCanary(source + "\n" + source.split("\n")[1490]),
		/exactly once/,
	);
});

for (const [label, alter] of [
	["zero completed tests", (m) => { m.testsCompleted = 0; }],
	["empty killedBy", (m) => { m.killedBy = []; }],
	["missing killedBy", (m) => { delete m.killedBy; }],
	["unknown killedBy", (m) => { m.killedBy = ["missing-test"]; }],
]) {
	test("non-canary kill rejects " + label, () => {
		const input = invocation();
		const mutant = input.report.files[canary.file].mutants[1];
		mutant.status = "Killed";
		mutant.testsCompleted = 1;
		mutant.killedBy = ["owner-test-id"];
		input.events.find((e) => e.name === "onMutantTested" && e.data.id === mutant.id).data.status = "Killed";
		alter(mutant);
		assert.throws(() => verifyInvocation(input), /tests|kill|Killed/i);
	});
}

for (const field of ["replacement", "location", "mutatorName"]) {
	for (const origin of ["plan", "tested"]) {
		test("non-canary rejects contradictory " + origin + " " + field, () => {
			const input = invocation();
			const original = input.report.files[canary.file].mutants[1];
			const data = origin === "plan"
				? input.events.find((e) => e.name === "onMutationTestingPlanReady").data.mutantPlans[1].mutant
				: input.events.find((e) => e.name === "onMutantTested" && e.data.id === original.id).data;
			data[field] = field === "location" ? location(999, 1, 2) : "contradiction";
			assert.throws(() => verifyInvocation(input), /identity|replacement|location|mutator/i);
		});
	}
}

test("non-canary complete killed evidence is accepted", () => {
	const input = invocation();
	const mutant = input.report.files[canary.file].mutants[1];
	mutant.status = "Killed";
	mutant.testsCompleted = 1;
	mutant.killedBy = ["owner-test-id"];
	input.events.find((e) => e.name === "onMutantTested" && e.data.id === mutant.id).data.status = "Killed";
	assert.equal(verifyInvocation(input).population.counts.Killed, 2);
});

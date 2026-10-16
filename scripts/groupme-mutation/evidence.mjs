// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// Decides whether one Stryker invocation proves the canary. Inputs are Stryker's own
// artifacts from that invocation: event-recorder files, the JSON report, and the owner
// receipt lines written during the same run. Nothing here reruns or re-derives mutants.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canary, canaryReplacementText } from "./canary.mjs";

const knownStatuses = new Set([
	"Killed",
	"Survived",
	"NoCoverage",
	"Timeout",
	"CompileError",
	"RuntimeError",
	"Ignored",
]);
const nativeTestFile = /^connectors\/groupme\/[^/]+\.test\.ts$/;

export function readInvocation(runDir) {
	const eventsDir = join(runDir, "events");
	const events = readdirSync(eventsDir)
		.sort()
		.map((name) => ({
			name: name.replace(/^\d+-/, "").replace(/\.json$/, ""),
			data: JSON.parse(readFileSync(join(eventsDir, name), "utf8")),
		}));
	const receiptPath = join(runDir, "owner-receipt.jsonl");
	const receipts = existsSync(receiptPath)
		? readFileSync(receiptPath, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
		: [];
	return {
		events,
		report: JSON.parse(readFileSync(join(runDir, "mutation.json"), "utf8")),
		receipts,
	};
}

// `selectedRanges` is [{ path, ranges: [[start, end], ...] }] from the selector.
export function verifyInvocation({
	events,
	report,
	receipts,
	selectedRanges,
	anchor,
}) {
	const single = (name) => {
		const found = events.filter((event) => event.name === name);
		if (found.length !== 1)
			throw new Error(
				`expected one ${name} event, found ${String(found.length)}`,
			);
		return found[0].data;
	};
	single("onDryRunCompleted");
	const plans = single("onMutationTestingPlanReady").mutantPlans;
	const planned = new Map();
	for (const plan of plans) {
		if (plan.plan !== "Run")
			throw new Error("early result planned for mutant " + plan.mutant.id);
		if (planned.has(plan.mutant.id))
			throw new Error("duplicate planned mutant " + plan.mutant.id);
		planned.set(plan.mutant.id, plan);
	}

	const tested = new Map();
	for (const { name, data } of events) {
		if (name !== "onMutantTested") continue;
		if (tested.has(data.id))
			throw new Error("duplicate tested mutant " + data.id);
		tested.set(data.id, data);
	}
	const byId = new Map();
	for (const [file, { mutants }] of Object.entries(report.files)) {
		for (const mutant of mutants) {
			if (byId.has(mutant.id))
				throw new Error("duplicate reported mutant " + mutant.id);
			if (!knownStatuses.has(mutant.status))
				throw new Error(
					`unknown status ${mutant.status} for mutant ${mutant.id}`,
				);
			byId.set(mutant.id, { ...mutant, file });
		}
	}
	// Planned, tested, and reported identities must be the same set, with agreeing statuses.
	const sameSet = (map) =>
		map.size === planned.size && [...planned.keys()].every((id) => map.has(id));
	if (!sameSet(tested) || !sameSet(byId))
		throw new Error(
			`mutant populations disagree: planned ${String(planned.size)}, tested ${String(tested.size)}, reported ${String(byId.size)}`,
		);
	for (const [id, event] of tested)
		if (event.status !== byId.get(id).status)
			throw new Error("tested and reported status differ for mutant " + id);

	// ID-only lifecycle events remain valid; supplied identities must agree.
	const point = (p, offset = 0) => [p?.line + offset, p?.column + offset];
	// Actions run 38945513812: plan locations are 0-based; tested/report are 1-based.
	const checkIdentity = (actual, expected, label) => {
		const offset = label === "planned" ? 1 : 0;
		for (const key of ["mutatorName", "replacement"]) {
			if (Object.hasOwn(actual, key) && actual[key] !== expected[key])
				throw new Error(label + " identity " + key + " differs for mutant " + expected.id);
		}
		if (Object.hasOwn(actual, "location") &&
			JSON.stringify([point(actual.location?.start, offset), point(actual.location?.end, offset)]) !==
			JSON.stringify([point(expected.location?.start), point(expected.location?.end)]))
			throw new Error(label + " identity location differs for mutant " + expected.id);
	};
	for (const [id, mutant] of byId) {
		checkIdentity(planned.get(id).mutant, mutant, "planned");
		checkIdentity(tested.get(id), mutant, "tested");
	}

	const canaryMatches = [...byId.values()].filter(
		(mutant) =>
			mutant.file === canary.file &&
			mutant.location.start.line === anchor.line &&
			mutant.location.start.column === anchor.column &&
			mutant.mutatorName === "EqualityOperator" &&
			mutant.replacement === canaryReplacementText,
	);
	if (canaryMatches.length !== 1)
		throw new Error(
			`canary identity matched ${String(canaryMatches.length)} mutants`,
		);
	const canaryMutant = canaryMatches[0];
	const runOptions = planned.get(canaryMutant.id).runOptions;
	if (
		runOptions.activeMutant.id !== canaryMutant.id ||
		runOptions.mutantActivation !== "runtime"
	)
		throw new Error("canary was not planned for runtime activation of itself");
	if (canaryMutant.status !== "Killed")
		throw new Error(`canary status is ${canaryMutant.status}, not Killed`);
	if (!(canaryMutant.testsCompleted > 0))
		throw new Error("canary completed no tests");

	const testById = new Map();
	for (const [file, { tests }] of Object.entries(report.testFiles)) {
		for (const test of tests) {
			if (testById.has(test.id)) throw new Error("duplicate reported killer test " + test.id);
			testById.set(test.id, { file, name: test.name });
		}
	}
	for (const mutant of byId.values()) {
		if (mutant.status !== "Killed") continue;
		if (!Number.isInteger(mutant.testsCompleted) || mutant.testsCompleted <= 0)
			throw new Error("Killed mutant completed no valid tests: " + mutant.id);
		if (!Array.isArray(mutant.killedBy) || mutant.killedBy.length === 0)
			throw new Error("Killed mutant has no killedBy tests: " + mutant.id);
		for (const id of mutant.killedBy) {
			if (!testById.has(id)) throw new Error("Killed mutant names an unreported test: " + mutant.id);
		}
	}
	const killers = (canaryMutant.killedBy ?? []).map((id) => {
		const test = testById.get(id);
		if (!test) throw new Error("canary killedBy names an unreported test");
		if (!nativeTestFile.test(test.file))
			throw new Error(
				"canary killed outside native GroupMe files: " + test.file,
			);
		return test;
	});
	if (
		!killers.some(
			(test) =>
				test.file === canary.owner.file && test.name === canary.owner.name,
		)
	)
		throw new Error("canary was not killed by its owner test");

	const receipt = receipts.find(
		(entry) =>
			entry.activeMutantId === canaryMutant.id &&
			entry.file === canary.owner.file &&
			entry.name === canary.owner.name,
	);
	if (!receipt) throw new Error("no owner receipt for the active canary");
	if (receipt.state !== "fail")
		throw new Error("owner receipt state is " + receipt.state);
	const assertionFailed = receipt.errors.some(
		(error) =>
			String(error.message).startsWith(canary.owner.message) &&
			error.actual === "true" &&
			error.expected === "false" &&
			String(error.stack).includes(canary.owner.file),
	);
	if (!assertionFailed)
		throw new Error("owner did not fail its custom assertion for the canary");

	const inChangedRanges = (mutant) =>
		selectedRanges.some(
			({ path, ranges }) =>
				path === mutant.file &&
				ranges.some(
					([start, end]) =>
						mutant.location.start.line >= start &&
						mutant.location.start.line <= end,
				),
		);
	const changed = [...byId.values()].filter(inChangedRanges);
	const counts = {};
	for (const mutant of changed)
		counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
	const describe = ({
		id,
		file,
		location,
		mutatorName,
		replacement,
		status,
	}) => ({
		id,
		file,
		line: location.start.line,
		column: location.start.column,
		mutatorName,
		replacement,
		status,
	});

	return {
		canary: {
			id: canaryMutant.id,
			activation: "runtime",
			killedBy: killers,
			owner: canary.owner.name,
			receiptAssertion: canary.owner.message,
		},
		population: {
			planned: planned.size,
			tested: tested.size,
			reported: byId.size,
			changed: changed.length,
			counts,
		},
		survivors: changed.filter((m) => m.status === "Survived").map(describe),
		timeouts: changed.filter((m) => m.status === "Timeout").map(describe),
	};
}

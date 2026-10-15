// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	buildReportManifest,
	classifyFailureCause,
	expectedCanary,
	hasExpectedCanaryFailure,
	isExpectedCanary,
	validateBaselineTap,
} from "./report-integrity.mjs";

const [mode] = process.argv.slice(2);
if (!new Set(["a1", "a2"]).has(mode) || process.argv.length !== 3) {
	throw new Error("Usage: node summarize.mjs a1|a2");
}

const reportsPath = resolve(process.env.PILOT_REPORT_DIR ?? "reports");
const reportPath = resolve(reportsPath, `groupme-${mode}.json`);
const baselinePath = resolve(reportsPath, `${mode}.instrumented-baseline.tap`);
const timingPath = resolve(reportsPath, "timing.jsonl");
const report = JSON.parse(readFileSync(reportPath, "utf8"));
const manifestData = buildReportManifest(report);
const baselineTap = readFileSync(baselinePath, "utf8");
const manifest = manifestData.manifest;
const canary = Object.entries(report.files ?? {}).flatMap(([file, result]) =>
	(result.mutants ?? [])
		.filter((mutant) => isExpectedCanary({ ...mutant, file, source: result.source }))
		.map((mutant) => ({
			canonicalIdentity: manifest.find((entry) => entry.mutantId === mutant.id)
				?.canonicalIdentity,
			mutantId: mutant.id,
			status: mutant.status,
			failureCause: classifyFailureCause(mutant),
			testsCompleted: mutant.testsCompleted ?? null,
			statusReason: mutant.statusReason ?? null,
			expectedAssertionFailure: hasExpectedCanaryFailure(
				{ ...mutant, file, source: result.source },
				String(mutant.statusReason ?? ""),
			),
		})),
);
const baseline = validateBaselineTap(baselineTap);
const timingEvents = readFileSync(timingPath, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((line) => JSON.parse(line));
const buildEvents = timingEvents.filter(
	(event) => event.event === "emitted-graph-build" && event.mode === mode,
);
const buildValid =
	mode === "a1" ||
	(buildEvents.length === 1 &&
		buildEvents[0].buildCommandInvocations === 1 &&
		buildEvents[0].instrumentationHeaderPresent === true &&
		buildEvents[0].runtimeTypeScriptImportCount === 0);
const generated = manifest.length;
const statusCountSum = Object.values(manifestData.counts).reduce(
	(sum, value) => sum + value,
	0,
);
const killedFailureCauses = Object.groupBy(
	manifest.filter((mutant) => mutant.status === "Killed"),
	(mutant) => mutant.failureCause,
);
const survivorSample = [];
const sampledMutators = new Set();
for (const mutant of manifest.filter((entry) => entry.status === "Survived")) {
	if (sampledMutators.has(mutant.mutatorName)) continue;
	sampledMutators.add(mutant.mutatorName);
	survivorSample.push({
		canonicalIdentity: mutant.canonicalIdentity,
		file: mutant.file,
		location: mutant.location,
		mutatorName: mutant.mutatorName,
		originalText: mutant.originalText,
		replacement: mutant.replacement,
		testsCompleted: mutant.testsCompleted,
		triage: "review equivalence, reachability and oracle strength",
	});
	if (survivorSample.length === 12) break;
}
const range2Mutants = manifest.filter(
	(entry) =>
		entry.file.endsWith("connectors/groupme/index.ts") &&
		entry.location.start.line >= 1528 &&
		entry.location.end.line <= 1529,
);
const runValid =
	generated > 0 &&
	generated === statusCountSum &&
	baseline.valid &&
	buildValid &&
	canary.length === 1 &&
	canary[0].status === "Killed" &&
	canary[0].expectedAssertionFailure;
const reportSha256 = createHash("sha256")
	.update(readFileSync(reportPath))
	.digest("hex");
const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
const canonicalMutants = manifest.map(
	({
		mutantId,
		canonicalIdentity,
		file,
		location,
		mutatorName,
		originalText,
		replacement,
	}) => ({
		mutantId,
		canonicalIdentity,
		file,
		location,
		mutatorName,
		originalText,
		replacement,
	}),
);
const canonicalMutantsText = `${JSON.stringify(canonicalMutants, null, 2)}\n`;
const canonicalPopulationSha256 = createHash("sha256")
	.update(canonicalMutantsText)
	.digest("hex");
const summary = {
	mode,
	valid: runValid,
	reportSha256,
	generated,
	statusCountSum,
	counts: manifestData.counts,
	killedFailureCauseCounts: Object.fromEntries(
		Object.entries(killedFailureCauses).map(([cause, mutants]) => [
			cause,
			mutants.length,
		]),
	),
	manifestSha256,
	manifestPath: `reports/groupme-${mode}.mutants.json`,
	canonicalPopulationSha256,
	canonicalPopulationPath: `reports/groupme-${mode}.canonical-mutants.json`,
	mutantPopulation: {
		kind:
			process.env.MUTATION_CANARY_CONTROL === "1"
				? "bounded canary-only local control"
				: "fixed full pilot ranges",
		ranges: report.config?.mutate ?? null,
		operators: "Stryker default operators; no exclusions or sampling",
		seed: null,
		range2Interpretation:
			"helper/progress-message-literal mutants only; no loop-entry or page-cap fault claim",
		range2Mutants,
		cursorOrderInterpretation:
			"the exact descending-fixture mutant is a fixture-specific negative-page kill, not an equivalent always-true helper",
		pageCap:
			"neither: this default-operator population does not insert a numeric page cap",
	},
	baseline: {
		...baseline,
		sha256: createHash("sha256").update(baselineTap).digest("hex"),
		path: `reports/${mode}.instrumented-baseline.tap`,
	},
	testsCompletedSum: manifestData.testsCompletedSum,
	testsCompletedSumLabel: "synthetic command-runner results; not leaf tests",
	commandRunnerSyntheticAllAttributionCount:
		manifestData.syntheticCommandMutants,
	unmappedAttributions: manifestData.unmappedAttributions,
	leafTestAttributionSupported: false,
	leafTestAttributionCount: 0,
	canaryContract: {
		file: expectedCanary.file,
		line: expectedCanary.line,
		mutatorName: expectedCanary.mutatorName,
		originalText: expectedCanary.originalText,
		replacement: expectedCanary.replacement,
		ownerName: expectedCanary.ownerName,
		assertionMessage: expectedCanary.assertionMessage,
	},
	canary,
	buildCommand: { valid: buildValid, events: buildEvents },
	survivorSample,
	survivorSampleRule:
		"up to twelve survivors, first sorted canonical identity per distinct mutator; concrete patch retained for human equivalence/reachability/oracle triage",
	manifestStatusComplete: generated === statusCountSum,
};

writeFileSync(resolve(reportsPath, `groupme-${mode}.mutants.json`), manifestText, {
	mode: 0o600,
});
writeFileSync(
	resolve(reportsPath, `groupme-${mode}.canonical-mutants.json`),
	canonicalMutantsText,
	{ mode: 0o600 },
);
writeFileSync(
	resolve(reportsPath, `summary-${mode}.json`),
	`${JSON.stringify(summary, null, 2)}\n`,
	{ mode: 0o600 },
);
console.log(
	`${mode}: valid=${runValid}, generated=${generated}, counts=${JSON.stringify(manifestData.counts)}, canaryExpectedAssertionFailure=${canary[0]?.expectedAssertionFailure ?? false}, manifestSha256=${manifestSha256}, reportSha256=${reportSha256}`,
);
if (!runValid) process.exitCode = 1;

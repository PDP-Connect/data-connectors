import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const modes = process.argv.slice(2);
if (!modes.length || modes.some((mode) => !["a1", "a2"].includes(mode))) {
	throw new Error("Usage: node summarize.mjs a1|a2");
}

const summaries = [];
const canaryOwnerName =
	"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
for (const mode of modes) {
	const reportPath = resolve(`reports/groupme-${mode}.json`);
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	const counts = Object.create(null);
	const mutants = [];
	for (const [file, result] of Object.entries(report.files ?? {})) {
		for (const mutant of result.mutants ?? []) {
			counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
			const { start, end } = mutant.location;
			const source = result.source.replaceAll("\r\n", "\n");
			const lines = source.split("\n");
			const lineOffset = (line, column) =>
				lines
					.slice(0, line - 1)
					.reduce((total, part) => total + part.length + 1, 0) + column;
			const originalText = source.slice(
				lineOffset(start.line, start.column - 1),
				lineOffset(end.line, end.column - 1),
			);
			const canonicalIdentity = createHash("sha256")
				.update(
					JSON.stringify([
						file.replaceAll("\\", "/"),
						start.line,
						start.column,
						end.line,
						end.column,
						mutant.mutatorName,
						originalText,
						mutant.replacement ?? "",
					]),
				)
				.digest("hex");
			mutants.push({
				id: mutant.id,
				canonicalIdentity,
				file,
				location: mutant.location,
				mutatorName: mutant.mutatorName,
				description: mutant.description,
				originalText,
				replacement: mutant.replacement,
				status: mutant.status,
				testsCompleted: mutant.testsCompleted ?? null,
				attribution: mutant.killedBy ?? mutant.coveredBy ?? null,
				canaryOwnerNameInFailureOutput:
					mutant.statusReason?.includes(canaryOwnerName) ?? false,
			});
		}
	}
	const canary = mutants.filter(
		(mutant) =>
			mutant.file.endsWith("connectors/groupme/index.ts") &&
			mutant.location.start.line === 1491 &&
			mutant.mutatorName === "EqualityOperator" &&
			mutant.originalText.includes(" < ") &&
			mutant.replacement.includes(" >= "),
	);
	const leafTestAttributionCount = mutants.filter((mutant) => {
		const ids = mutant.attribution;
		return Array.isArray(ids) && ids.some((id) => id !== "all");
	}).length;
	summaries.push({
		mode,
		reportSha256: createHash("sha256")
			.update(readFileSync(reportPath))
			.digest("hex"),
		generated: mutants.length,
		counts,
		testsCompletedSum: mutants.reduce(
			(sum, mutant) => sum + (mutant.testsCompleted ?? 0),
			0,
		),
		commandRunnerSyntheticAllAttributionCount: mutants.filter((mutant) =>
			(mutant.attribution ?? []).includes?.("all"),
		).length,
		leafTestAttributionCount,
		canaryOwnerName,
		canary,
		survivorSample: mutants
			.filter((mutant) => mutant.status === "Survived")
			.slice(0, 12),
	});
}

writeFileSync(
	resolve(`reports/summary-${modes.join("-")}.json`),
	`${JSON.stringify({ modes: summaries }, null, 2)}\n`,
	{ mode: 0o600 },
);
for (const summary of summaries) {
	const expectedCanary = summary.canary.some(
		(mutant) =>
			mutant.status === "Killed" &&
			(mutant.testsCompleted ?? 0) > 0 &&
			mutant.canaryOwnerNameInFailureOutput,
	);
	console.log(
		`${summary.mode}: generated=${summary.generated}, statuses=${JSON.stringify(summary.counts)}, canaryKilledByExpectedTAPFailure=${expectedCanary}, leafTestAttribution=${summary.leafTestAttributionCount}, reportSha256=${summary.reportSha256}`,
	);
	if (!expectedCanary) {
		process.exitCode = 1;
	}
}

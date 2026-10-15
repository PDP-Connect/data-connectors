// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { Parser } from "tap-parser";

export const expectedCanary = Object.freeze({
	file: "connectors/groupme/index.ts",
	line: 1491,
	mutatorName: "EqualityOperator",
	originalText: "curr.created_at < prev.created_at",
	replacement: "curr.created_at >= prev.created_at",
	ownerName:
		"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError",
	assertionMessage:
		"a non-ascending forward page must fail, not be silently trusted",
	assertionLineStart: 653,
	assertionLineEnd: 659,
});

export const mutantStatuses = Object.freeze([
	"Killed",
	"Survived",
	"Timeout",
	"CompileError",
	"RuntimeError",
	"NoCoverage",
	"Ignored",
]);

const tapFields = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

export function parseTap(text) {
	const versionStart = text.search(/^TAP version \d+\r?$/m);
	if (versionStart < 0) {
		return { valid: false, reason: "TAP version line absent", leaves: [] };
	}

	const tapText = text.slice(versionStart);
	const events = Parser.parse(tapText, { passes: true });
	const summaries = Object.fromEntries(
		tapFields.map((field) => {
			const match = tapText.match(new RegExp(`^# ${field} (\\d+)$`, "m"));
			return [field, match ? Number(match[1]) : null];
		}),
	);
	const leaves = [];
	let hasVersion = false;
	let hasRootPlan = false;
	let hasRootComplete = false;

	const collect = (eventList, isRoot = false) => {
		for (const [type, value] of eventList) {
			if (isRoot && type === "version") hasVersion = true;
			if (isRoot && type === "plan") hasRootPlan = true;
			if (isRoot && type === "complete") hasRootComplete = true;
			if (type === "child") {
				collect(value);
			} else if (type === "assert" && value.closingTestPoint !== true) {
				leaves.push(value);
			}
		}
	};
	collect(events, true);

	const valid =
		hasVersion &&
		hasRootPlan &&
		hasRootComplete &&
		summaries.tests !== null &&
		summaries.pass !== null &&
		summaries.fail !== null &&
		summaries.cancelled !== null &&
		summaries.skipped !== null &&
		summaries.todo !== null &&
		leaves.length > 0;

	return {
		valid,
		reason: valid ? null : "incomplete TAP stream or no leaf tests",
		summaries,
		leaves,
	};
}

export function validateBaselineTap(text, expectedTests = 221) {
	const parsed = parseTap(text);
	const summary = parsed.summaries;
	const ownerSeen = parsed.leaves.some(
		(leaf) => leaf.name === expectedCanary.ownerName,
	);
	const valid =
		parsed.valid &&
		summary.tests === expectedTests &&
		parsed.leaves.length === expectedTests &&
		summary.pass === 219 &&
		summary.fail === 0 &&
		summary.cancelled === 0 &&
		summary.skipped === 2 &&
		summary.todo === 0 &&
		ownerSeen;
	return {
		valid,
		reason: valid ? null : "baseline is not the pinned 221/219/0/2 leaf population",
		...summary,
		ownerSeen,
		parsedLeafCount: parsed.leaves.length,
	};
}

function canonicalIdentity(mutant) {
	const file = mutant.file.replaceAll("\\", "/");
	const { start, end } = mutant.location;
	const lines = mutant.source.replaceAll("\r\n", "\n").split("\n");
	const lineOffset = (line, column) =>
		lines
			.slice(0, line - 1)
			.reduce((total, part) => total + part.length + 1, 0) +
		column;
	const originalText = mutant.source
		.replaceAll("\r\n", "\n")
		.slice(
			lineOffset(start.line, start.column - 1),
			lineOffset(end.line, end.column - 1),
		);
	const replacement = mutant.replacement ?? "";
	const identity = createHash("sha256")
		.update(
			JSON.stringify([
				file,
				start.line,
				start.column,
				end.line,
				end.column,
				mutant.mutatorName,
				originalText,
				replacement,
			]),
		)
		.digest("hex");
	return { file, originalText, replacement, identity };
}

export function isExpectedCanary(mutant) {
	const canonical = canonicalIdentity(mutant);
	return (
		canonical.file === expectedCanary.file &&
		mutant.location.start.line === expectedCanary.line &&
		mutant.mutatorName === expectedCanary.mutatorName &&
		canonical.originalText === expectedCanary.originalText &&
		canonical.replacement === expectedCanary.replacement
	);
}

export function hasExpectedCanaryFailure(mutant, tapOutput, expectedTests = 221) {
	if (!isExpectedCanary(mutant) || mutant.status !== "Killed") return false;
	const parsed = parseTap(tapOutput);
	if (
		!parsed.valid ||
		parsed.summaries.tests !== expectedTests ||
		parsed.summaries.cancelled !== 0 ||
		parsed.summaries.skipped !== 2 ||
		parsed.summaries.todo !== 0 ||
		parsed.leaves.length !== expectedTests
	)
		return false;
	const ownerResults = parsed.leaves.filter(
		(leaf) => leaf.name === expectedCanary.ownerName,
	);
	if (ownerResults.length !== 1) return false;
	const owner = ownerResults[0];
	const diag = owner.diag ?? {};
	const location = String(diag.location ?? "");
	const stack = String(diag.stack ?? "");
	const filePattern = /(?:^|[/\\])connectors[/\\]groupme[/\\]incremental-frontier\.test\.(?:ts|js):/;
	const assertionSite = new RegExp(
		`incremental-frontier\\.test\\.(?:ts|js):(?:${expectedCanary.assertionLineStart}|${Array.from(
			{ length: expectedCanary.assertionLineEnd - expectedCanary.assertionLineStart },
			(_, index) => expectedCanary.assertionLineStart + index + 1,
		).join("|")}):`,
	);
	return (
		owner.ok === false &&
		owner.skip !== true &&
		owner.todo !== true &&
		diag.code === "ERR_ASSERTION" &&
		diag.operator === "strictEqual" &&
		diag.expected === true &&
		diag.actual === false &&
		String(diag.error ?? "").includes(expectedCanary.assertionMessage) &&
		filePattern.test(location) &&
		filePattern.test(stack) &&
		assertionSite.test(stack)
	);
}

export function classifyFailureCause(mutant) {
	if (mutant.status !== "Killed") return mutant.status;
	const reason = String(mutant.statusReason ?? "");
	const parsed = parseTap(reason);
	if (parsed.valid) {
		const failedLeaves = parsed.leaves.filter(
			(leaf) => leaf.ok === false && leaf.skip !== true && leaf.todo !== true,
		);
		if (
			failedLeaves.length > 0 &&
			failedLeaves.every((leaf) => leaf.diag?.code === "ERR_ASSERTION")
		) {
			return "assertion-failure";
		}
		if (failedLeaves.length > 0) return "non-assertion-test-failure";
	}
	if (
		/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING|Cannot find (?:module|package)|SyntaxError|TypeError: Cannot|Error: Cannot load/i.test(
			reason,
		)
	) {
		return "load-or-setup-error";
	}
	return "unclassified-command-exit";
}

function definitionMap(testFiles = {}) {
	const map = new Map();
	for (const [file, definition] of Object.entries(testFiles)) {
		for (const test of definition.tests ?? []) {
			map.set(test.id, { file, name: test.name });
		}
	}
	return map;
}

export function buildReportManifest(report) {
	const counts = Object.fromEntries(mutantStatuses.map((status) => [status, 0]));
	const definitions = definitionMap(report.testFiles);
	const manifest = [];
	let syntheticCommandMutants = 0;
	let unmappedAttributions = 0;

	for (const [file, result] of Object.entries(report.files ?? {})) {
		for (const mutant of result.mutants ?? []) {
			const canonical = canonicalIdentity({ ...mutant, file, source: result.source });
			if (!Object.hasOwn(counts, mutant.status)) {
				throw new Error(`Unknown or uncompleted mutant status: ${mutant.status}`);
			}
			counts[mutant.status] += 1;
			const attribution = mutant.killedBy ?? mutant.coveredBy ?? [];
			for (const id of Array.isArray(attribution) ? attribution : []) {
				const definition = definitions.get(id);
				if (id === "all" || definition?.name === "All tests") {
					syntheticCommandMutants += 1;
				} else if (!definition) {
					unmappedAttributions += 1;
				}
			}
			manifest.push({
				mutantId: mutant.id,
				canonicalIdentity: canonical.identity,
				file: canonical.file,
				location: mutant.location,
				mutatorName: mutant.mutatorName,
				description: mutant.description,
				originalText: canonical.originalText,
				replacement: canonical.replacement,
				status: mutant.status,
				failureCause: classifyFailureCause(mutant),
				testsCompleted: mutant.testsCompleted ?? null,
				attribution,
				statusReason: mutant.statusReason ?? null,
			});
		}
	}
	manifest.sort((left, right) =>
		left.canonicalIdentity.localeCompare(right.canonicalIdentity),
	);
	const statusCountSum = Object.values(counts).reduce((sum, value) => sum + value, 0);
	if (statusCountSum !== manifest.length) {
		throw new Error("Mutant status counts do not reconcile with the complete manifest");
	}
	return {
		manifest,
		counts,
		syntheticCommandMutants,
		unmappedAttributions,
		leafTestAttributionSupported: false,
		leafTestAttributionCount: 0,
		testsCompletedSum: manifest.reduce(
			(sum, mutant) => sum + (mutant.testsCompleted ?? 0),
			0,
		),
	};
}

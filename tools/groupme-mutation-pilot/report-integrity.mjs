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

const pilotRanges = Object.freeze([
	"connectors/groupme/index.ts:1487-1495",
	"connectors/groupme/index.ts:1528-1529",
]);
const canaryRanges = Object.freeze(["connectors/groupme/index.ts:1491-1491"]);

export function mutationPopulationKind(ranges) {
	const normalized = Array.isArray(ranges) ? [...ranges].sort() : [];
	if (JSON.stringify(normalized) === JSON.stringify([...canaryRanges])) {
		return "bounded canary-only control";
	}
	if (JSON.stringify(normalized) === JSON.stringify([...pilotRanges].sort())) {
		return "fixed full pilot ranges";
	}
	throw new Error(`Unknown mutation ranges: ${JSON.stringify(ranges)}`);
}

export function canonicalPopulationSha256(manifest) {
	const identities = manifest.map((mutant) => mutant.canonicalIdentity).sort();
	return createHash("sha256")
		.update(`${JSON.stringify(identities)}\n`)
		.digest("hex");
}

const tapFields = ["tests", "pass", "fail", "cancelled", "skipped", "todo"];

function inspectParserEvents(events, leaves, errors) {
	const plans = events
		.filter(([type]) => type === "plan")
		.map(([, value]) => value);
	const completions = events
		.filter(([type]) => type === "complete")
		.map(([, value]) => value);
	const assertions = events
		.filter(([type]) => type === "assert")
		.map(([, value]) => value);
	if (
		plans.length !== 1 ||
		completions.length !== 1 ||
		events.some(
			([type, value, enabled]) =>
				type === "tapError" ||
				type === "bailout" ||
				(type === "pragma" && value === "strict" && enabled === false) ||
				(type === "extra" && String(value).trim() !== ""),
		)
	) {
		errors.push(
			"TAP parser scope must have one plan and completion without errors, bailout, strict downgrade or extra output",
		);
	}
	for (const assertion of assertions) {
		if (assertion.tapError)
			errors.push("TAP assertion contains a parser error");
		if (assertion.closingTestPoint !== true) leaves.push(assertion);
	}
	const plan = plans[0];
	const complete = completions[0];
	if (plan && complete) {
		if (
			!Number.isInteger(plan.start) ||
			!Number.isInteger(plan.end) ||
			plan.start !== 1 ||
			plan.end !== assertions.length ||
			complete.count !== assertions.length ||
			complete.plan?.start !== plan.start ||
			complete.plan?.end !== plan.end ||
			complete.bailout ||
			complete.failures?.some((failure) => failure.tapError)
		) {
			errors.push(
				"TAP plan and completion counts do not match parsed assertions",
			);
		}
		const parsedCounts = {
			pass: assertions.filter((assertion) => assertion.ok).length,
			fail: assertions.filter((assertion) => !assertion.ok).length,
			skipped: assertions.filter((assertion) => Boolean(assertion.skip)).length,
			todo: assertions.filter((assertion) => Boolean(assertion.todo)).length,
		};
		if (
			complete.pass !== parsedCounts.pass ||
			complete.fail !== parsedCounts.fail ||
			complete.skip !== parsedCounts.skipped ||
			complete.todo !== parsedCounts.todo
		) {
			errors.push("TAP completion totals do not match parsed assertions");
		}
	}
	for (const [, childEvents] of events.filter(([type]) => type === "child")) {
		inspectParserEvents(childEvents, leaves, errors);
	}
}

export function parseTap(text) {
	const versionStart = text.search(/^TAP version \d+\r?$/m);
	if (versionStart < 0) {
		return { valid: false, reason: "TAP version line absent", leaves: [] };
	}

	const tapText = text.slice(versionStart);
	const events = Parser.parse(tapText, { passes: true, strict: true });
	const summaries = Object.fromEntries(tapFields.map((field) => [field, null]));
	const leaves = [];
	const errors = [];
	const comments = events
		.filter(([type]) => type === "comment")
		.map(([, value]) => String(value).trim());
	for (const field of tapFields) {
		const matches = comments
			.map((comment) => comment.match(new RegExp(`^# ${field} (\\d+)$`)))
			.filter(Boolean);
		if (matches.length === 1) summaries[field] = Number(matches[0][1]);
		else errors.push(`TAP summary must contain exactly one ${field} total`);
	}
	const hasVersion = events.filter(([type]) => type === "version").length === 1;
	inspectParserEvents(events, leaves, errors);
	const computed = {
		tests: leaves.length,
		pass: leaves.filter((leaf) => leaf.ok && !leaf.skip && !leaf.todo).length,
		fail: leaves.filter((leaf) => !leaf.ok && !leaf.skip && !leaf.todo).length,
		cancelled: leaves.filter((leaf) =>
			/cancel/i.test(String(leaf.diag?.failureType ?? "")),
		).length,
		skipped: leaves.filter((leaf) => Boolean(leaf.skip)).length,
		todo: leaves.filter((leaf) => Boolean(leaf.todo)).length,
	};
	if (tapFields.some((field) => summaries[field] !== computed[field])) {
		errors.push("Node TAP summary totals do not match computed leaf outcomes");
	}

	const valid = hasVersion && leaves.length > 0 && errors.length === 0;

	return {
		valid,
		reason: valid
			? null
			: (errors[0] ?? "incomplete TAP stream or no leaf tests"),
		summaries,
		computed,
		leaves,
		errors,
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
		reason: valid
			? null
			: "baseline is not the pinned 221/219/0/2 leaf population",
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
			.reduce((total, part) => total + part.length + 1, 0) + column;
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

export function hasExpectedCanaryFailure(
	mutant,
	tapOutput,
	expectedTests = 221,
) {
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
	const filePattern =
		/(?:^|[/\\])connectors[/\\]groupme[/\\]incremental-frontier\.test\.(?:ts|js):/;
	const assertionSite = new RegExp(
		`incremental-frontier\\.test\\.(?:ts|js):(?:${expectedCanary.assertionLineStart}|${Array.from(
			{
				length:
					expectedCanary.assertionLineEnd - expectedCanary.assertionLineStart,
			},
			(_, index) => expectedCanary.assertionLineStart + index + 1,
		).join("|")}):`,
	);
	return (
		owner.ok === false &&
		!owner.skip &&
		!owner.todo &&
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
			(leaf) => leaf.ok === false && !leaf.skip && !leaf.todo,
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

export function resourceAccounting({
	gnuTimeOutput,
	statusCounts,
	exitCode,
	signal,
	terminationSignal,
}) {
	const entries = String(gnuTimeOutput ?? "")
		.trim()
		.split(",")
		.filter(Boolean)
		.map((field) => {
			const separator = field.indexOf("=");
			return separator < 0
				? [field, null]
				: [field.slice(0, separator), field.slice(separator + 1)];
		});
	const fields = Object.fromEntries(entries);
	const required = [
		"elapsedSeconds",
		"userSeconds",
		"systemSeconds",
		"maxRssKiB",
	];
	const parsed = Object.fromEntries(
		required.map((field) => {
			const value = fields[field];
			const number =
				typeof value === "string" && value.trim() !== ""
					? Number(value)
					: NaN;
			return [field, Number.isFinite(number) && number >= 0 ? number : null];
		}),
	);
	const malformedFields = required.filter((field) => parsed[field] === null);
	const duplicateFields = entries
		.map(([field]) => field)
		.filter((field, index, all) => all.indexOf(field) !== index);
	const unexpectedFields = entries
		.map(([field]) => field)
		.filter((field) => !required.includes(field));
	const statusCountsValid =
		statusCounts &&
		mutantStatuses.every(
			(status) =>
				Number.isInteger(statusCounts[status]) && statusCounts[status] >= 0,
		) &&
		Object.values(statusCounts).reduce((sum, count) => sum + count, 0) > 0;
	const errors = statusCountsValid
		? ["Timeout", "CompileError", "RuntimeError"].filter(
				(status) => statusCounts[status] > 0,
			)
		: [];
	const reasons = [];
	if (malformedFields.length > 0) {
		reasons.push(
			`missing or unparseable GNU time fields: ${malformedFields.join(", ")}`,
		);
	}
	if (
		duplicateFields.length > 0 ||
		unexpectedFields.length > 0 ||
		entries.length !== required.length
	) {
		reasons.push("GNU time receipt fields are duplicated or unexpected");
	}
	if (!statusCountsValid)
		reasons.push("mutation status report missing, empty or unparseable");
	if (errors.length > 0) {
		reasons.push(
			`mutant statuses may terminate child trees: ${errors.join(", ")}`,
		);
	}
	if (terminationSignal || signal || exitCode !== 0) {
		reasons.push(
			`arm process did not exit normally (exitCode=${exitCode}, signal=${signal ?? "none"}, terminationSignal=${terminationSignal ?? "none"})`,
		);
	}
	const comparable = reasons.length === 0;
	const userSeconds = parsed.userSeconds;
	const systemSeconds = parsed.systemSeconds;
	return {
		wallSeconds: parsed.elapsedSeconds,
		cpuAccounting: {
			status: comparable ? "comparable" : "incomplete",
			comparable,
			reason: reasons.length > 0 ? reasons.join("; ") : null,
			userSeconds: comparable ? userSeconds : null,
			systemSeconds: comparable ? systemSeconds : null,
			totalSeconds: comparable ? userSeconds + systemSeconds : null,
			reportedUserSeconds: userSeconds,
			reportedSystemSeconds: systemSeconds,
		},
		maxRssKiB: parsed.maxRssKiB,
		maxRssDefinition:
			"GNU %M high-water maximum resident set size in KiB; maximum process, not aggregate process-tree RSS",
	};
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
	const counts = Object.fromEntries(
		mutantStatuses.map((status) => [status, 0]),
	);
	const definitions = definitionMap(report.testFiles);
	const manifest = [];
	let syntheticCommandMutants = 0;
	let unmappedAttributions = 0;

	for (const [file, result] of Object.entries(report.files ?? {})) {
		for (const mutant of result.mutants ?? []) {
			const canonical = canonicalIdentity({
				...mutant,
				file,
				source: result.source,
			});
			if (!Object.hasOwn(counts, mutant.status)) {
				throw new Error(
					`Unknown or uncompleted mutant status: ${mutant.status}`,
				);
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
	const statusCountSum = Object.values(counts).reduce(
		(sum, value) => sum + value,
		0,
	);
	if (statusCountSum !== manifest.length) {
		throw new Error(
			"Mutant status counts do not reconcile with the complete manifest",
		);
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

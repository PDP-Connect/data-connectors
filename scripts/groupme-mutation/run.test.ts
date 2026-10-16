// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { GROUPME_FAULTS } from "./faults.ts";
import {
	changedSourceInterval,
	faultAttemptOutcome,
	mostSpecificCoverageCountAtOffset,
	nodeVersionSupported,
	parseChangedHeadLines,
	parseNameStatus,
	parseReporterOutput,
	replaceExactly,
	restoreFile,
	sameMutantPopulation,
	samePopulation,
	selectOrdinaryFaults,
	verifyOwnerFailure,
	verifyReachability,
} from "./run.ts";

const focused = "connectors/groupme/incremental-frontier.test.ts";

if (process.env.GROUPME_MUTATION_COLD_HOME_CHILD === "1") {
	assert.equal(
		existsSync(path.join(os.homedir(), ".tmp")),
		false,
		"cold selftest subprocess must start without ~/.tmp",
	);
}

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

async function gitFixture(t: TestContext, files: Record<string, string> = {}) {
	const repo = await mkdtemp(
		path.join(os.tmpdir(), "groupme-selector-fixture-"),
	);
	t.after(() => rm(repo, { recursive: true, force: true }));
	git(repo, "init", "-q");
	git(repo, "config", "user.email", "fixture@example.invalid");
	git(repo, "config", "user.name", "Fixture");
	for (const [name, contents] of Object.entries(files)) {
		const file = path.join(repo, name);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, contents);
	}
	git(repo, "add", "--all");
	git(repo, "commit", "-qm", "base");
	const base = git(repo, "rev-parse", "HEAD");
	return { repo, base };
}

function selectorReport() {
	return {
		changedPaths: [],
		unsupportedChangedPaths: [],
		deletedHeadTargets: [],
		addedRegisteredPaths: [],
		eligibleZeroApplicableSites: [],
	} as Record<string, unknown>;
}

async function selectFixture(
	repo: string,
	base: string,
	report = selectorReport(),
) {
	const selected = await selectOrdinaryFaults(
		repo,
		git(repo, "rev-parse", "HEAD"),
		base,
		process.env,
		report,
	);
	return { selected, report };
}

function event(
	status: "passed" | "failed" | "skipped" | "todo" | "cancelled",
	id = "owner",
	error?: object,
) {
	return {
		kind: "test" as const,
		eventId: `${focused}#${id}`,
		identity: {
			file: focused,
			hierarchy: ["suite", id === "owner" ? GROUPME_FAULTS[0]!.ownerTest : id],
			line: 20,
			column: 1,
		},
		status,
		durationMs: 1,
		...(error ? { error } : {}),
	};
}

function reporter(events: object[], failed: number, exitCode: number) {
	return parseReporterOutput(
		[
			...events.map((entry) => JSON.stringify(entry)),
			JSON.stringify({
				kind: "complete",
				completionEvents: events.length,
				counts: {
					tests: events.length,
					passed: events.length - failed,
					failed,
					skipped: 0,
					todo: 0,
					cancelled: 0,
				},
			}),
		].join("\n"),
		exitCode,
		null,
		false,
	);
}

test("accepts only a complete, consistent node:test leaf stream", () => {
	assert.equal(reporter([event("passed")], 0, 0).status, "passed");
	assert.equal(
		parseReporterOutput("", 0, null, false).status,
		"reporter_incomplete",
	);
	assert.equal(
		parseReporterOutput("{broken", 1, null, false).status,
		"reporter_malformed",
	);
	assert.equal(
		reporter([event("passed"), event("passed")], 0, 0).status,
		"reporter_malformed",
	);
	assert.equal(
		reporter([event("failed")], 1, 0).status,
		"event_exit_disagreement",
	);
	assert.equal(
		reporter([{ ...event("passed"), status: "unknown" }], 0, 0).status,
		"reporter_malformed",
	);
	assert.equal(parseReporterOutput("", null, "SIGINT", false).status, "signal");
	assert.equal(
		parseReporterOutput("", 0, null, true).status,
		"output_truncated",
	);
});

test("requires the sole expected owning assertion", () => {
	const fault = GROUPME_FAULTS[0]!;
	assert.equal(
		verifyOwnerFailure(
			[
				event("failed", "owner", {
					name: "AssertionError",
					code: "ERR_ASSERTION",
					message: fault.ownerAssertion,
				}),
			],
			fault,
		).ok,
		true,
	);
	assert.equal(
		verifyOwnerFailure([], fault).reason,
		"missing_or_skipped_owner",
	);
	assert.equal(
		verifyOwnerFailure(
			[
				event("failed", "owner", {
					code: "ERR_ASSERTION",
					message: fault.ownerAssertion,
				}),
				{
					...event("failed", "owner", {
						code: "ERR_ASSERTION",
						message: fault.ownerAssertion,
					}),
					eventId: "duplicate-owner",
				},
			],
			fault,
		).reason,
		"missing_or_skipped_owner",
	);
	assert.equal(
		verifyOwnerFailure(
			[
				event("failed", "owner", {
					code: "ERR_ASSERTION",
					message: "different assertion",
				}),
			],
			fault,
		).ok,
		false,
	);
	assert.equal(
		verifyOwnerFailure(
			[
				event("failed", "owner", {
					code: "ERR_ASSERTION",
					message: fault.ownerAssertion,
				}),
				{
					...event("failed", "other", {
						code: "ERR_ASSERTION",
						message: "another assertion",
					}),
					eventId: "other",
				},
			],
			fault,
		).reason,
		"non_sole_assertion_failure",
	);
});

test("rejects stale and duplicate mutation preimages", () => {
	assert.throws(
		() => replaceExactly(Buffer.from("changed"), "expected", "replacement"),
		/preimage count 0/,
	);
	assert.throws(
		() => replaceExactly(Buffer.from("x x"), "x", "y"),
		/preimage count 2/,
	);
	assert.throws(() => parseNameStatus("M\0file\0R100\0old\0"), /path list/);
});

test("parses rename and delete records and changed HEAD lines", () => {
	assert.deepEqual(parseNameStatus("R100\0old.ts\0new.ts\0D\0gone.ts\0"), [
		{ status: "R100", paths: ["old.ts", "new.ts"] },
		{ status: "D", paths: ["gone.ts"] },
	]);
	assert.throws(() => parseNameStatus("M\0file\0".slice(0, -1)), /malformed/);
	assert.deepEqual(
		[
			...parseChangedHeadLines(
				"diff --git a/a b/a\n+++ b/a\n@@ -3,0 +4,2 @@\n+x\n+y\n",
			),
		],
		[4, 5],
	);
	assert.throws(
		() => parseChangedHeadLines("+++ b/a\n@@ malformed @@"),
		/malformed/,
	);
});

test("restores only the snapshot file after interruption and detects restore failure", async () => {
	const root = await mkdtemp(
		path.join(os.tmpdir(), "groupme-mutation-selftest-"),
	);
	try {
		const snapshot = path.join(root, "snapshot");
		const caller = path.join(root, "caller.ts");
		await mkdir(snapshot);
		const file = path.join(snapshot, "target.ts");
		const before = Buffer.from("baseline");
		const callerBytes = Buffer.from("caller-owned");
		await writeFile(file, before);
		await writeFile(caller, callerBytes);
		await writeFile(file, replaceExactly(before, "base", "mutated"));
		assert.equal(
			parseReporterOutput("", null, "SIGTERM", false).status,
			"signal",
		);
		const expected = createHash("sha256").update(before).digest("hex");
		await assert.rejects(
			restoreFile(file, before, "wrong-hash"),
			/restore hash mismatch/,
		);
		assert.equal(await restoreFile(file, before, expected), expected);
		assert.deepEqual(await readFile(caller), callerBytes);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("accepts the supported Node 24 range", () => {
	assert.equal(nodeVersionSupported("v24.15.0"), true);
	assert.equal(nodeVersionSupported("v24.21.0"), true);
	assert.equal(nodeVersionSupported("v25.0.0"), false);
	assert.equal(nodeVersionSupported("v24.14.9"), false);
});

test("baseline execution identity preserves status and restores the owner", () => {
	const baseline = [event("passed")];
	assert.equal(
		samePopulation(baseline, [{ ...event("passed"), status: "skipped" }]),
		false,
	);
	assert.equal(
		samePopulation(baseline, [{ ...event("passed"), status: "todo" }]),
		false,
	);
	assert.equal(
		samePopulation(baseline, [{ ...event("passed"), status: "failed" }]),
		false,
	);
	assert.equal(
		sameMutantPopulation(
			baseline,
			[{ ...event("passed"), status: "failed" }],
			GROUPME_FAULTS[0]!.ownerTest,
		),
		true,
	);
	assert.equal(
		samePopulation(
			[{ ...event("passed"), status: "skipped" }],
			[{ ...event("passed"), status: "skipped" }],
		),
		true,
	);
	const duplicateBaseline = [
		event("passed"),
		{ ...event("passed"), eventId: "duplicate" },
	];
	assert.equal(samePopulation(duplicateBaseline, duplicateBaseline), true);
	assert.equal(samePopulation(duplicateBaseline, [event("passed")]), false);
});

test("ordinary required faults reject survival and disagreement while equality control is exempt", () => {
	assert.equal(
		faultAttemptOutcome(["survived", "survived"]),
		"required-fault-survived",
	);
	assert.equal(
		faultAttemptOutcome(["killed", "survived"]),
		"required-fault-unconfirmed",
	);
	assert.equal(
		faultAttemptOutcome(["reachability_unknown", "killed"]),
		"required-fault-unconfirmed",
	);
	assert.equal(faultAttemptOutcome(["killed", "killed"]), "killed");
	assert.equal(
		faultAttemptOutcome(["survived", "survived"], "survive"),
		"calibration-control-survived",
	);
});

test("changed-source interval contains mutation bytes only and assigns insertions to the following line", () => {
	const source =
		"before\n  keep();\n  cursor += page.length;\n  nextFunction();\n";
	const interval = changedSourceInterval(
		source,
		"cursor += page.length;",
		"let pages = 0;\n  cursor += page.length;",
	);
	assert.deepEqual(
		[interval.startLine, interval.endLine, interval.insertion],
		[3, 3, true],
	);
	assert.equal(source.slice(0, interval.startByte).endsWith("  "), true);
	const insertion = changedSourceInterval(
		source,
		"cursor += page.length;",
		"cursor += page.length;\n  pages += 1;",
	);
	assert.deepEqual(
		[insertion.startLine, insertion.endLine, insertion.insertion],
		[3, 3, true],
	);
	assert.throws(
		() =>
			changedSourceInterval(
				source,
				"cursor += page.length;",
				"cursor += page.length;",
			),
		/no changed bytes/,
	);
});

test("nested V8 ranges override positive function coverage and ambiguous ranges fail closed", () => {
	const ranges = [
		{ startOffset: 0, endOffset: 100, count: 12 },
		{ startOffset: 40, endOffset: 60, count: 12 },
		{ startOffset: 48, endOffset: 52, count: 0 },
	];
	assert.equal(mostSpecificCoverageCountAtOffset(ranges, 49), 0);
	assert.equal(mostSpecificCoverageCountAtOffset(ranges, 45), 12);
	assert.equal(mostSpecificCoverageCountAtOffset(ranges, 120), null);
	assert.equal(
		mostSpecificCoverageCountAtOffset(
			[
				{ startOffset: 0, endOffset: 10, count: 2 },
				{ startOffset: 0, endOffset: 10, count: 0 },
			],
			5,
		),
		null,
	);
});

test("tsx and V8 distinguish a called production function from its unentered nested comparison", async (t) => {
	const temp = await mkdtemp(path.join(os.tmpdir(), "groupme-v8-probe-"));
	t.after(() => rm(temp, { recursive: true, force: true }));
	const source = await readFile(
		path.join(process.cwd(), GROUPME_FAULTS[1]!.target),
		"utf8",
	);
	const start = source.indexOf("function isAscendingByCreatedAt(");
	const end = source.indexOf("\n}\n", start);
	assert.ok(start >= 0 && end > start);
	const probe = path.join(temp, "actual-ascending-function.ts");
	await writeFile(
		probe,
		`${source.slice(start, end + 2)}\nconst messages = process.argv[2] === "single" ? [{ created_at: 1 }] : [{ created_at: 2 }, { created_at: 1 }];\nisAscendingByCreatedAt(messages as unknown as GroupMeMessage[]);\n`,
	);
	for (const [mode, expected] of [
		["single", "not-executed"],
		["pair", "executed"],
	] as const) {
		const label = `probe-${mode}`;
		const coverage = path.join(temp, `coverage-${label}`);
		await mkdir(coverage, { recursive: true });
		const result = spawnSync(
			process.execPath,
			["--import", "tsx", probe, mode],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					NODE_V8_COVERAGE: coverage,
					TMPDIR: temp,
				},
				timeout: 120_000,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const reachability = await verifyReachability(
			temp,
			temp,
			label,
			"curr.created_at < prev.created_at",
			"isAscendingByCreatedAt",
			probe,
		);
		assert.equal(
			reachability.functionCalled,
			true,
			JSON.stringify(reachability),
		);
		assert.equal(
			reachability.siteState,
			expected,
			JSON.stringify(reachability),
		);
		const match = (
			reachability.coverageMatches as Array<{
				functionCallCount: number;
				effectiveCounts: Array<{ count: number | null }>;
			}>
		)[0];
		assert.ok(match.functionCallCount > 0, JSON.stringify(reachability));
		assert.ok(match.effectiveCounts.length > 0, JSON.stringify(reachability));
		assert.equal(
			match.effectiveCounts.every(({ count }) => count === 0),
			mode === "single",
			JSON.stringify(reachability),
		);
	}
});

test("ordinary selection checks a new registered target and pure and edited renames", async (t) => {
	const source = await readFile(
		path.join(process.cwd(), GROUPME_FAULTS[0]!.target),
		"utf8",
	);
	const added = await gitFixture(t, { README: "base\n" });
	await mkdir(path.join(added.repo, "connectors/groupme"), { recursive: true });
	await writeFile(path.join(added.repo, GROUPME_FAULTS[0]!.target), source);
	git(added.repo, "add", "--all");
	git(added.repo, "commit", "-qm", "add registered source");
	assert.deepEqual(
		(await selectFixture(added.repo, added.base)).selected.map(
			(fault) => fault.id,
		),
		GROUPME_FAULTS.map((fault) => fault.id),
	);

	const pure = await gitFixture(t, { "moved.ts": source });
	await mkdir(path.dirname(path.join(pure.repo, GROUPME_FAULTS[0]!.target)), {
		recursive: true,
	});
	git(pure.repo, "mv", "moved.ts", GROUPME_FAULTS[0]!.target);
	git(pure.repo, "commit", "-qm", "pure rename into registered source");
	assert.deepEqual((await selectFixture(pure.repo, pure.base)).selected, []);

	const previous = source.replace(
		"curr.created_at < prev.created_at",
		"curr.created_at < prev.created_at /* old */",
	);
	const editedIn = await gitFixture(t, { "moved.ts": previous });
	await mkdir(
		path.dirname(path.join(editedIn.repo, GROUPME_FAULTS[0]!.target)),
		{ recursive: true },
	);
	git(editedIn.repo, "mv", "moved.ts", GROUPME_FAULTS[0]!.target);
	await writeFile(path.join(editedIn.repo, GROUPME_FAULTS[0]!.target), source);
	git(editedIn.repo, "add", "--all");
	git(editedIn.repo, "commit", "-qm", "edited rename into registered source");
	assert.ok(
		(await selectFixture(editedIn.repo, editedIn.base)).selected.some(
			(fault) => fault.id === "ascending-order-weakening",
		),
	);
});

test("ordinary selection excludes later-function changes and reports rename-out removal", async (t) => {
	const target = GROUPME_FAULTS[0]!.target;
	const source = await readFile(path.join(process.cwd(), target), "utf8");
	const laterSite = "if (!isAscendingByCreatedAt(messages)) {";
	const laterChanged = source.replace(
		laterSite,
		`${laterSite} // changed later walker behavior`,
	);
	assert.notEqual(laterChanged, source);
	const later = await gitFixture(t, { [target]: source });
	await writeFile(path.join(later.repo, target), laterChanged);
	git(later.repo, "add", "--all");
	git(later.repo, "commit", "-qm", "change later in walker");
	assert.deepEqual((await selectFixture(later.repo, later.base)).selected, []);

	const renamedOut = await gitFixture(t, { [target]: source });
	const editedSource = source.replace(
		"return true;\n}",
		"return true; // edited before rename\n}",
	);
	assert.notEqual(editedSource, source);
	await writeFile(path.join(renamedOut.repo, target), editedSource);
	git(renamedOut.repo, "mv", target, "connectors/groupme/moved.ts");
	git(renamedOut.repo, "commit", "-qm", "rename registered source out");
	const report = selectorReport();
	await assert.rejects(
		selectFixture(renamedOut.repo, renamedOut.base, report),
		/registered production target removed or renamed out/,
	);
	assert.deepEqual(report.deletedHeadTargets, [target]);

	const deleted = await gitFixture(t, { [target]: source });
	await rm(path.join(deleted.repo, target));
	git(deleted.repo, "add", "--all");
	git(deleted.repo, "commit", "-qm", "delete registered source");
	const deletedReport = selectorReport();
	await assert.rejects(
		selectFixture(deleted.repo, deleted.base, deletedReport),
		/registered production target removed or renamed out/,
	);
	assert.deepEqual(deletedReport.deletedHeadTargets, [target]);
});

test("CI admission uses the full push range, both rename paths, and fails closed without before", async (t) => {
	const fixture = await gitFixture(t, { README: "base\n" });
	const base = fixture.base;
	await mkdir(path.join(fixture.repo, "scripts/groupme-mutation"), {
		recursive: true,
	});
	await writeFile(
		path.join(fixture.repo, "scripts/groupme-mutation/run.ts"),
		"// harness\n",
	);
	git(fixture.repo, "add", "--all");
	git(fixture.repo, "commit", "-qm", "commit A: harness change");
	await writeFile(path.join(fixture.repo, "README"), "base plus docs\n");
	git(fixture.repo, "add", "--all");
	git(fixture.repo, "commit", "-qm", "commit B: docs only");
	const head = git(fixture.repo, "rev-parse", "HEAD");
	const admissionPath = path.resolve(
		".github/scripts/groupme-mutation-admission.mjs",
	);
	const runAdmission = (beforeSha: string | undefined) => {
		const result = spawnSync(process.execPath, [admissionPath], {
			cwd: fixture.repo,
			encoding: "utf8",
			env: {
				...process.env,
				EVENT_NAME: "push",
				BEFORE_SHA: beforeSha,
				HEAD_SHA: head,
				GITHUB_WORKSPACE: fixture.repo,
			},
		});
		return {
			result,
			output: result.stdout
				? (JSON.parse(result.stdout) as Record<string, unknown>)
				: null,
		};
	};
	assert.equal(runAdmission(base).output?.mutationRequired, true);
	assert.notEqual(runAdmission(undefined).result.status, 0);

	const rename = await gitFixture(t, {
		[GROUPME_FAULTS[0]!.target]: "registered\n",
	});
	git(
		rename.repo,
		"mv",
		GROUPME_FAULTS[0]!.target,
		"connectors/groupme/moved.ts",
	);
	git(rename.repo, "commit", "-qm", "rename out");
	const renameHead = git(rename.repo, "rev-parse", "HEAD");
	const renameResult = spawnSync(process.execPath, [admissionPath], {
		cwd: rename.repo,
		encoding: "utf8",
		env: {
			...process.env,
			EVENT_NAME: "push",
			BEFORE_SHA: rename.base,
			HEAD_SHA: renameHead,
			GITHUB_WORKSPACE: rename.repo,
		},
	});
	assert.equal(
		(JSON.parse(renameResult.stdout) as { mutationRequired: boolean })
			.mutationRequired,
		true,
	);

	const deletion = await gitFixture(t, {
		[GROUPME_FAULTS[0]!.target]: "registered\n",
	});
	await rm(path.join(deletion.repo, GROUPME_FAULTS[0]!.target));
	git(deletion.repo, "add", "--all");
	git(deletion.repo, "commit", "-qm", "delete registered target");
	const deleteResult = spawnSync(process.execPath, [admissionPath], {
		cwd: deletion.repo,
		encoding: "utf8",
		env: {
			...process.env,
			EVENT_NAME: "push",
			BEFORE_SHA: deletion.base,
			HEAD_SHA: git(deletion.repo, "rev-parse", "HEAD"),
			GITHUB_WORKSPACE: deletion.repo,
		},
	});
	assert.equal(
		(JSON.parse(deleteResult.stdout) as { mutationRequired: boolean })
			.mutationRequired,
		true,
	);

	const gate = (required: boolean, mutationResult: string) =>
		spawnSync(process.execPath, [admissionPath, "--gate"], {
			cwd: fixture.repo,
			encoding: "utf8",
			env: {
				...process.env,
				MUTATION_REQUIRED: String(required),
				MUTATION_RESULT: mutationResult,
			},
		});
	assert.equal(gate(true, "success").status, 0);
	assert.notEqual(gate(true, "skipped").status, 0);
	assert.equal(gate(false, "skipped").status, 0);
	assert.notEqual(gate(false, "failure").status, 0);
});

test("helper, config and isolated-lock changes admit ordinary verification; docs-only does not", async (t) => {
	const admit = async (name: string) => {
		const fixture = await gitFixture(t, { README: "base\n" });
		await mkdir(path.dirname(path.join(fixture.repo, name)), {
			recursive: true,
		});
		await writeFile(path.join(fixture.repo, name), "changed\n");
		git(fixture.repo, "add", "--all");
		git(fixture.repo, "commit", "-qm", `change ${name}`);
		const result = spawnSync(
			process.execPath,
			[path.resolve(".github/scripts/groupme-mutation-admission.mjs")],
			{
				cwd: fixture.repo,
				encoding: "utf8",
				env: {
					...process.env,
					EVENT_NAME: "push",
					BEFORE_SHA: fixture.base,
					HEAD_SHA: git(fixture.repo, "rev-parse", "HEAD"),
					GITHUB_WORKSPACE: fixture.repo,
				},
			},
		);
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout) as {
			relevant: boolean;
			harness: boolean;
			mutationRequired: boolean;
		};
	};
	for (const name of [
		"scripts/groupme-mutation/tools/package-lock.json",
		"scripts/groupme-mutation/vitest.config.mjs",
		".github/scripts/groupme-mutation-admission.mjs",
		"package.json",
	]) {
		const admitted = await admit(name);
		assert.equal(admitted.harness, true, name);
		assert.equal(admitted.relevant, true, name);
		assert.equal(admitted.mutationRequired, true, name);
	}
	const docsOnly = await admit("docs/notes.md");
	assert.equal(docsOnly.relevant, false);
	assert.equal(docsOnly.mutationRequired, false);
});

if (process.env.GROUPME_MUTATION_COLD_HOME_CHILD !== "1") {
	test("package entrypoint reaches the runner with a fresh home and no .tmp", async (t) => {
		const freshHome = await mkdtemp(
			path.join(os.tmpdir(), "groupme-empty-home-"),
		);
		t.after(() => rm(freshHome, { recursive: true, force: true }));
		const preload = path.join(freshHome, "homedir-preload.mjs");
		await writeFile(
			preload,
			"import os from 'node:os'; os.homedir = () => process.env.GROUPME_TEST_HOME;\n",
		);
		assert.equal(existsSync(path.join(freshHome, ".tmp")), false);
		const childEnv = {
			...process.env,
			GROUPME_TEST_HOME: freshHome,
			GROUPME_MUTATION_COLD_HOME_CHILD: "1",
			NODE_OPTIONS:
				`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
		};
		const homeProbe = spawnSync(
			process.execPath,
			["-e", "console.log(require('node:os').homedir())"],
			{ encoding: "utf8", env: childEnv },
		);
		assert.equal(homeProbe.stdout.trim(), freshHome, homeProbe.stderr);
		const child = spawnSync(
			"npm",
			["run", "groupme-mutation", "--", "--mode", "diff"],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: childEnv,
				timeout: 120_000,
			},
		);
		assert.notEqual(child.status, 0);
		assert.match(
			`${child.stdout}\n${child.stderr}`,
			/--base, --head, and --merge-base full SHAs are required/,
		);
	});
}

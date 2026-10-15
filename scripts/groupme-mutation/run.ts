// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { SourceMap } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	EQUALITY_CONTROL,
	GROUPME_FAULTS,
	type GroupMeFault,
} from "./faults.ts";

const FOCUSED_TEST = "connectors/groupme/incremental-frontier.test.ts";
const TARGET = "connectors/groupme/index.ts";
const CHILD_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const BATCH_LIMIT_MS = 10 * 60_000;
const ASSERTION_CODE = "ERR_ASSERTION";

type Identity = {
	file: string;
	hierarchy: string[];
	line: number;
	column: number;
};
type TestEvent = {
	kind: "test";
	eventId: string;
	identity: Identity;
	status: "passed" | "failed" | "skipped" | "todo" | "cancelled";
	durationMs: number;
	error?: SerializedError;
};
type SerializedError = {
	name?: string;
	code?: string;
	message?: string;
	stack?: string;
	cause?: SerializedError;
};
type ReporterRun = {
	events: TestEvent[];
	counts: Record<string, number>;
	raw: string;
};
type ProcessResult = {
	argv: string[];
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	stderrBytes: number;
	stderrSha256: string;
	timedOut: boolean;
	outputTruncated: boolean;
	spawnError?: string;
};
type FaultResult = {
	id: string;
	status: string;
	attempts: unknown[];
};

export function parseNameStatus(
	raw: string,
): Array<{ status: string; paths: string[] }> {
	const fields = raw.split("\0");
	if (fields.at(-1) !== "") throw new Error("malformed NUL name-status output");
	fields.pop();
	const changes: Array<{ status: string; paths: string[] }> = [];
	for (let i = 0; i < fields.length; ) {
		const status = fields[i++];
		if (!status || !/^(?:A|M|T|D|R\d{1,3}|C\d{1,3})$/.test(status)) {
			throw new Error("malformed NUL name-status status");
		}
		const pathCount = status[0] === "R" || status[0] === "C" ? 2 : 1;
		const paths = fields.slice(i, i + pathCount);
		if (paths.length !== pathCount || paths.some((entry) => !entry)) {
			throw new Error("malformed NUL name-status path list");
		}
		i += pathCount;
		changes.push({ status, paths });
	}
	return changes;
}

export function parseChangedHeadLines(diff: string): Set<number> {
	const changed = new Set<number>();
	let inFile = false;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) inFile = false;
		if (line.startsWith("+++ b/")) inFile = true;
		if (line.startsWith("+++ /dev/null")) inFile = false;
		if (!inFile || !line.startsWith("@@")) continue;
		const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!match) throw new Error("malformed zero-context diff hunk");
		const start = Number(match[1]);
		const count = match[2] === undefined ? 1 : Number(match[2]);
		for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) {
			changed.add(lineNumber);
		}
	}
	return changed;
}

function causeHasCode(
	error: SerializedError | undefined,
	code: string,
): boolean {
	for (let current = error; current; current = current.cause) {
		if (current.code === code) return true;
	}
	return false;
}

export function parseReporterOutput(
	stdout: string,
	exitCode: number | null,
	signal: NodeJS.Signals | null,
	truncated: boolean,
): { status: string; run?: ReporterRun; reason?: string } {
	if (truncated)
		return {
			status: "output_truncated",
			reason: "reporter output limit reached",
		};
	if (signal) return { status: "signal", reason: signal };
	if (exitCode === null)
		return { status: "process_unknown", reason: "missing exit code" };
	const lines = stdout.split(/\r?\n/).filter(Boolean);
	const tests: TestEvent[] = [];
	let completion:
		| { completionEvents: number; counts: Record<string, number> }
		| undefined;
	const ids = new Set<string>();
	try {
		for (const line of lines) {
			const event = JSON.parse(line) as
				| TestEvent
				| {
						kind: "complete";
						completionEvents: number;
						counts: Record<string, number>;
				  };
			if (completion) throw new Error("event after completion");
			if (event.kind === "test") {
				if (
					!new Set(["passed", "failed", "skipped", "todo", "cancelled"]).has(
						event.status,
					)
				) {
					throw new Error("unknown test status");
				}
				if (!event.eventId || ids.has(event.eventId))
					throw new Error("duplicate test event id");
				ids.add(event.eventId);
				if (
					!event.identity?.file ||
					!Array.isArray(event.identity.hierarchy) ||
					!Number.isInteger(event.identity.line) ||
					event.identity.line < 1 ||
					!Number.isInteger(event.identity.column) ||
					event.identity.column < 1 ||
					!event.identity.hierarchy.length
				)
					throw new Error("malformed test identity");
				if (!Number.isFinite(event.durationMs) || event.durationMs < 0)
					throw new Error("malformed test duration");
				tests.push(event);
			} else if (
				event.kind === "complete" &&
				Number.isInteger(event.completionEvents) &&
				event.counts
			) {
				completion = event;
			} else {
				throw new Error("unknown reporter event");
			}
		}
	} catch (error) {
		return {
			status: "reporter_malformed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
	if (!completion)
		return {
			status: "reporter_incomplete",
			reason: "missing completion event",
		};
	if (
		completion.completionEvents < tests.length ||
		completion.counts.tests !== tests.length
	) {
		return {
			status: "reporter_incomplete",
			reason: "completion counts do not match test events",
		};
	}
	const observed = {
		passed: tests.filter((event) => event.status === "passed").length,
		failed: tests.filter((event) => event.status === "failed").length,
		cancelled: tests.filter((event) => event.status === "cancelled").length,
		skipped: tests.filter((event) => event.status === "skipped").length,
		todo: tests.filter((event) => event.status === "todo").length,
	};
	for (const [key, value] of Object.entries(observed)) {
		if (completion.counts[key] !== value) {
			return {
				status: "event_exit_disagreement",
				reason: `summary ${key} count mismatch`,
			};
		}
	}
	if (completion.counts.failed > 0 && exitCode === 0) {
		return {
			status: "event_exit_disagreement",
			reason: "failed test events with zero process exit",
		};
	}
	if (completion.counts.failed === 0 && exitCode !== 0) {
		return {
			status: "event_exit_disagreement",
			reason: "nonzero process exit without failed test events",
		};
	}
	return {
		status: exitCode === 0 ? "passed" : "tests_failed",
		run: { events: tests, counts: completion.counts, raw: stdout },
	};
}

function identityKey(identity: Identity): string {
	return JSON.stringify([
		identity.file,
		identity.hierarchy,
		identity.line,
		identity.column,
	]);
}

export function samePopulation(
	baseline: TestEvent[],
	actual: TestEvent[],
): boolean {
	const statuses = new Map<string, TestEvent["status"][]>();
	for (const event of baseline) {
		const key = identityKey(event.identity);
		statuses.set(key, [...(statuses.get(key) ?? []), event.status]);
	}
	for (const event of actual) {
		const key = identityKey(event.identity);
		const expected = statuses.get(key);
		if (!expected || expected.shift() !== event.status) return false;
		if (!expected.length) statuses.delete(key);
	}
	return statuses.size === 0;
}

export function sameMutantPopulation(
	baseline: TestEvent[],
	actual: TestEvent[],
	ownerTest: string,
): boolean {
	const expected = new Map<string, TestEvent["status"][]>();
	for (const event of baseline) {
		const key = identityKey(event.identity);
		expected.set(key, [...(expected.get(key) ?? []), event.status]);
	}
	for (const event of actual) {
		const key = identityKey(event.identity);
		const statuses = expected.get(key);
		if (!statuses) return false;
		const baselineStatus = statuses.shift();
		const ownerMayFail =
			event.identity.file === FOCUSED_TEST &&
			event.identity.hierarchy.at(-1) === ownerTest &&
			baselineStatus === "passed" &&
			event.status === "failed";
		if (baselineStatus !== event.status && !ownerMayFail) return false;
		if (!statuses.length) expected.delete(key);
	}
	return expected.size === 0;
}

export function faultAttemptOutcome(
	statuses: string[],
	expected: "kill" | "survive" = "kill",
): string {
	if (statuses.length !== 2) return "required-fault-unconfirmed";
	if (
		expected === "survive" &&
		statuses.every((status) => status === "survived")
	)
		return "calibration-control-survived";
	if (expected === "kill" && statuses.every((status) => status === "killed"))
		return "killed";
	if (expected === "kill" && statuses.every((status) => status === "survived"))
		return "required-fault-survived";
	return "required-fault-unconfirmed";
}

function locateOwner(
	events: TestEvent[],
	fault: Pick<GroupMeFault, "ownerTest" | "ownerAssertion">,
): TestEvent | undefined {
	return events.find(
		(event) =>
			event.identity.file === FOCUSED_TEST &&
			event.identity.hierarchy.at(-1) === fault.ownerTest &&
			event.status === "failed" &&
			causeHasCode(event.error, ASSERTION_CODE) &&
			errorMessages(event.error).some((message) =>
				message.includes(fault.ownerAssertion),
			),
	);
}

function errorMessages(error: SerializedError | undefined): string[] {
	const messages: string[] = [];
	for (let current = error; current; current = current.cause)
		if (current.message) messages.push(current.message);
	return messages;
}

function getOwner(
	events: TestEvent[],
	fault: Pick<GroupMeFault, "ownerTest">,
): TestEvent | undefined {
	const owners = events.filter(
		(event) =>
			event.identity.file === FOCUSED_TEST &&
			event.identity.hierarchy.at(-1) === fault.ownerTest,
	);
	return owners.length === 1 ? owners[0] : undefined;
}

export function verifyOwnerFailure(
	events: TestEvent[],
	fault: Pick<GroupMeFault, "id" | "ownerTest" | "ownerAssertion">,
): { ok: boolean; reason: string } {
	const owner = getOwner(events, fault);
	if (!owner || owner.status === "skipped" || owner.status === "todo")
		return { ok: false, reason: "missing_or_skipped_owner" };
	const failures = events.filter((event) => event.status === "failed");
	if (failures.length !== 1)
		return { ok: false, reason: "non_sole_assertion_failure" };
	if (!locateOwner(events, fault))
		return { ok: false, reason: "owner_failed_without_expected_assertion" };
	return { ok: true, reason: "owner_assertion" };
}

function quoteArgs(args: string[]): string {
	return args.map((arg) => JSON.stringify(arg)).join(" ");
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function replaceExactly(
	source: Buffer,
	preimage: string,
	replacement: string,
): Buffer {
	const text = source.toString("utf8");
	const count = text.split(preimage).length - 1;
	if (count !== 1) throw new Error(`preimage count ${count}`);
	const changed = Buffer.from(text.replace(preimage, replacement), "utf8");
	if (changed.equals(source))
		throw new Error("mutation produced no byte change");
	return changed;
}

export async function restoreFile(
	file: string,
	before: Buffer,
	expectedHash: string,
): Promise<string> {
	await writeFile(file, before, {
		mode:
			constants.S_IRUSR |
			constants.S_IWUSR |
			constants.S_IRGRP |
			constants.S_IROTH,
	});
	const restoredHash = sha256(await readFile(file));
	if (restoredHash !== expectedHash) throw new Error("restore hash mismatch");
	return restoredHash;
}

function parseNodeVersion(
	version: string,
): [number, number, number] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
	return match
		? [Number(match[1]), Number(match[2]), Number(match[3])]
		: undefined;
}

export function nodeVersionSupported(version: string): boolean {
	const parts = parseNodeVersion(version);
	return !!parts && parts[0] === 24 && parts[1] >= 15 && parts[0] < 25;
}

const ownedChildren = new Set<ChildProcess>();
let requestedSignal: NodeJS.Signals | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		requestedSignal = signal;
		for (const child of ownedChildren) child.kill("SIGTERM");
	});
}

async function runProcess(
	command: string,
	args: string[],
	options: {
		cwd: string;
		env: NodeJS.ProcessEnv;
		timeoutMs?: number;
		maxOutputBytes?: number;
	},
): Promise<ProcessResult> {
	const started = Date.now();
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let outputBytes = 0;
	let stderrOutputBytes = 0;
	let timedOut = false;
	let outputTruncated = false;
	let spawnError: string | undefined;
	let exitCode: number | null = null;
	let signal: NodeJS.Signals | null = null;
	const maxOutput = options.maxOutputBytes ?? OUTPUT_LIMIT_BYTES;
	const child = spawn(command, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	ownedChildren.add(child);
	const timeout = setTimeout(() => {
		timedOut = true;
		child.kill("SIGTERM");
		setTimeout(() => child.kill("SIGKILL"), 1500).unref();
	}, options.timeoutMs ?? CHILD_TIMEOUT_MS);
	child.stdout.on("data", (chunk: Buffer) => {
		outputBytes += chunk.length;
		if (outputBytes > maxOutput) {
			outputTruncated = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1500).unref();
			return;
		}
		stdout.push(Buffer.from(chunk));
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderrOutputBytes += chunk.length;
		if (stderrOutputBytes > maxOutput) {
			outputTruncated = true;
			const remaining = Math.max(
				0,
				maxOutput - (stderrOutputBytes - chunk.length),
			);
			if (remaining) stderr.push(Buffer.from(chunk.subarray(0, remaining)));
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 1500).unref();
			return;
		}
		stderr.push(Buffer.from(chunk));
	});
	child.on("error", (error) => {
		spawnError = error.message;
	});
	await new Promise<void>((resolve) => {
		child.on("close", (code, childSignal) => {
			exitCode = code;
			signal = childSignal;
			resolve();
		});
	});
	clearTimeout(timeout);
	ownedChildren.delete(child);
	const stderrBytes = Buffer.concat(stderr);
	return {
		argv: [command, ...args],
		exitCode,
		signal,
		durationMs: Date.now() - started,
		stdout: Buffer.concat(stdout).toString("utf8"),
		stderr: stderrBytes.toString("utf8"),
		stderrBytes: stderrOutputBytes,
		stderrSha256: sha256(stderrBytes),
		timedOut,
		outputTruncated,
		...(spawnError ? { spawnError } : {}),
	};
}

function childEnvironment(
	home: string,
	temp: string,
	coverage?: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: home,
		TMPDIR: temp,
		XDG_CACHE_HOME: path.join(home, ".cache"),
		npm_config_cache: path.join(home, ".npm"),
	};
	if (process.platform === "win32") {
		for (const key of ["SystemRoot", "ComSpec", "PATHEXT"])
			if (process.env[key]) env[key] = process.env[key];
	}
	if (coverage) env.NODE_V8_COVERAGE = coverage;
	return env;
}

async function git(
	repo: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs = CHILD_TIMEOUT_MS,
): Promise<ProcessResult> {
	const result = await runProcess("git", args, { cwd: repo, env, timeoutMs });
	if (
		result.exitCode !== 0 ||
		result.signal ||
		result.timedOut ||
		result.outputTruncated
	) {
		throw new Error(
			`git ${quoteArgs(args)} failed (exit=${result.exitCode}, signal=${result.signal})`,
		);
	}
	return result;
}

async function requiredSha(
	repo: string,
	value: string,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	if (!/^[0-9a-f]{40}$/i.test(value))
		throw new Error("base, head, and merge-base must be full commit SHAs");
	const actual = (
		await git(repo, ["rev-parse", "--verify", `${value}^{commit}`], env)
	).stdout.trim();
	if (actual.toLowerCase() !== value.toLowerCase())
		throw new Error(`commit SHA did not resolve exactly: ${value}`);
	return actual;
}

async function testFiles(snapshot: string): Promise<string[]> {
	const dir = path.join(snapshot, "connectors/groupme");
	const entries = await (await import("node:fs/promises")).readdir(dir, {
		withFileTypes: true,
	});
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
		.map((entry) => `connectors/groupme/${entry.name}`)
		.sort();
}

async function assertWorkspaceLinksInSnapshot(snapshot: string): Promise<void> {
	const root = JSON.parse(
		await readFile(path.join(snapshot, "package.json"), "utf8"),
	) as { workspaces?: string[] };
	for (const directory of root.workspaces ?? []) {
		if (!directory || directory.includes("*") || path.isAbsolute(directory))
			throw new Error(`unsupported workspace path: ${directory}`);
		const workspace = JSON.parse(
			await readFile(path.join(snapshot, directory, "package.json"), "utf8"),
		) as { name?: string };
		if (!workspace.name)
			throw new Error(`workspace has no package name: ${directory}`);
		const linkedPath = await realpath(
			path.join(snapshot, "node_modules", workspace.name),
		);
		if (
			linkedPath !== snapshot &&
			!linkedPath.startsWith(`${snapshot}${path.sep}`)
		) {
			throw new Error(`workspace link escaped the snapshot: ${workspace.name}`);
		}
	}
}

async function fileHashes(
	snapshot: string,
	files: string[],
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const file of files) {
		const full = path.join(snapshot, file);
		const stat = await lstat(full);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
			throw new Error(
				`unsafe source/test path (expected regular unlinked file): ${file}`,
			);
		}
		result[file] = sha256(await readFile(full));
	}
	return result;
}

async function assertOnlyTargetChanged(snapshot: string): Promise<void> {
	const result = await runProcess(
		"git",
		["status", "--porcelain=v1", "--untracked-files=all"],
		{
			cwd: snapshot,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		},
	);
	if (result.exitCode !== 0)
		throw new Error("cannot inspect snapshot source state");
	const lines = result.stdout.split(/\r?\n/).filter(Boolean);
	if (lines.some((line) => line.slice(3) !== TARGET) || lines.length > 1) {
		throw new Error(
			`unexpected snapshot source delta: ${lines.join(", ") || "unknown"}`,
		);
	}
}

async function assertCleanSnapshot(snapshot: string): Promise<void> {
	const result = await runProcess(
		"git",
		["status", "--porcelain=v1", "--untracked-files=all"],
		{
			cwd: snapshot,
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
		},
	);
	if (result.exitCode !== 0 || result.stdout.trim()) {
		throw new Error(
			`snapshot was not pristine: ${result.stdout.trim() || result.exitCode}`,
		);
	}
}

function validateBaseline(run: ReporterRun, kind: string): void {
	if (
		run.counts.failed !== 0 ||
		run.events.some((event) => event.status === "failed")
	) {
		throw new Error(`${kind} baseline failed`);
	}
	if (run.events.length === 0)
		throw new Error(`${kind} baseline reported no tests`);
	if (run.events.some((event) => event.status === "cancelled"))
		throw new Error(`${kind} baseline contains cancelled tests`);
}

async function reportRun(
	args: string[],
	snapshot: string,
	home: string,
	temp: string,
	report: Record<string, unknown>,
	label: string,
): Promise<{
	parsed: ReturnType<typeof parseReporterOutput>;
	process: ProcessResult;
}> {
	const coverage = path.join(temp, `coverage-${label}`);
	await mkdir(coverage, { recursive: true });
	const env = childEnvironment(home, temp, coverage);
	const result = await runProcess(process.execPath, args, {
		cwd: snapshot,
		env,
	});
	const parsed = parseReporterOutput(
		result.stdout,
		result.exitCode,
		result.signal,
		result.outputTruncated,
	);
	const entry = {
		label,
		argv: result.argv,
		cwd: snapshot,
		exitCode: result.exitCode,
		signal: result.signal,
		durationMs: result.durationMs,
		timedOut: result.timedOut,
		outputTruncated: result.outputTruncated,
		stderrBytes: result.stderrBytes,
		stderrSha256: result.stderrSha256,
		parseStatus: parsed.status,
		reason: parsed.reason,
		...(parsed.run
			? {
					counts: parsed.run.counts,
					events: parsed.run.events,
					rawEvents: parsed.run.raw,
				}
			: {}),
	};
	(report.runs as unknown[]).push(entry);
	if (result.timedOut) throw new Error(`${label}: timeout`);
	if (result.signal) throw new Error(`${label}: signal ${result.signal}`);
	if (result.spawnError)
		throw new Error(`${label}: spawn failure ${result.spawnError}`);
	if (parsed.status !== "passed" && parsed.status !== "tests_failed") {
		throw new Error(
			`${label}: ${parsed.status}: ${parsed.reason ?? "no reason"}`,
		);
	}
	return { parsed, process: result };
}

function makeTestArgs(snapshot: string, testFiles: string[]): string[] {
	return [
		"--test",
		"--import",
		"tsx",
		"--test-reporter",
		path.join(snapshot, "scripts/groupme-mutation/node-reporter.mjs"),
		...testFiles,
	];
}

function ownerStatus(
	events: TestEvent[],
	ownerTest: string,
): string | undefined {
	const owners = events.filter(
		(event) =>
			event.identity.file === FOCUSED_TEST &&
			event.identity.hierarchy.at(-1) === ownerTest,
	);
	return owners.length === 1 ? owners[0]!.status : undefined;
}

function ownersPassed(
	events: TestEvent[],
	faults: readonly Pick<GroupMeFault, "ownerTest">[],
): boolean {
	return faults.every(
		(fault) => ownerStatus(events, fault.ownerTest) === "passed",
	);
}

function functionForSite(fault: { id: string }): string {
	return fault.id === "page-ceiling"
		? "collectGroupMessagesForwardFromCursor"
		: "isAscendingByCreatedAt";
}

export function mostSpecificCoverageCountAtOffset(
	ranges: Array<{ startOffset: number; endOffset: number; count: number }>,
	offset: number,
): number | null {
	const containing = ranges.filter(
		(range) => range.startOffset <= offset && offset < range.endOffset,
	);
	if (!containing.length) return null;
	const minimumSpan = Math.min(
		...containing.map((range) => range.endOffset - range.startOffset),
	);
	const specific = containing.filter(
		(range) => range.endOffset - range.startOffset === minimumSpan,
	);
	const counts = new Set(specific.map((range) => range.count));
	return counts.size === 1 ? specific[0]!.count : null;
}

export async function verifyReachability(
	snapshot: string,
	temp: string,
	label: string,
	siteNeedle: string,
	functionName: string,
	sourceFilePath = path.join(snapshot, TARGET),
): Promise<Record<string, unknown>> {
	const source = await readFile(sourceFilePath, "utf8");
	const functionStart = Math.max(
		source.indexOf(`function ${functionName}(`),
		source.indexOf(`async function ${functionName}(`),
	);
	const functionEnd = source.indexOf("\n}\n", functionStart);
	const site = source.indexOf(siteNeedle, functionStart);
	const nextSite = source.indexOf(siteNeedle, site + 1);
	if (
		functionStart < 0 ||
		functionEnd < 0 ||
		site < 0 ||
		site > functionEnd ||
		(nextSite >= 0 && nextSite < functionEnd)
	) {
		throw new Error(
			"mutated source site is missing or ambiguous inside its function",
		);
	}
	const before = source.slice(0, site);
	const sourceLine = before.split("\n").length;
	const sourceColumn = site - before.lastIndexOf("\n") - 1;
	const targetPath = path.resolve(sourceFilePath);
	const coverageFiles = (
		await (
			await import("node:fs/promises")
		).readdir(path.join(temp, `coverage-${label}`))
	).filter((file) => file.endsWith(".json"));
	const matches: Array<Record<string, unknown>> = [];
	for (const coverageFile of coverageFiles) {
		const coverage = JSON.parse(
			await readFile(
				path.join(temp, `coverage-${label}`, coverageFile),
				"utf8",
			),
		) as {
			result?: Array<{
				url?: string;
				functions?: Array<{
					functionName?: string;
					ranges: Array<{
						startOffset: number;
						endOffset: number;
						count: number;
					}>;
				}>;
			}>;
			"source-map-cache"?: Record<
				string,
				{ lineLengths?: number[]; data?: object }
			>;
		};
		for (const script of coverage.result ?? []) {
			if (!script.url) continue;
			let scriptPath: string;
			try {
				scriptPath = fileURLToPath(script.url);
			} catch {
				continue;
			}
			if (path.resolve(scriptPath) !== targetPath) continue;
			const mapEntries = Object.entries(
				coverage["source-map-cache"] ?? {},
			).filter(([url]) => url === script.url);
			if (mapEntries.length !== 1) continue;
			const cache = mapEntries[0]![1];
			if (!cache.data || !cache.lineLengths) continue;
			const sourceMap = new SourceMap(
				cache.data as ConstructorParameters<typeof SourceMap>[0],
			);
			const offsetsByLine: number[] = [];
			let generatedOffset = 0;
			for (
				let lineIndex = 0;
				lineIndex < cache.lineLengths.length;
				lineIndex += 1
			) {
				offsetsByLine.push(generatedOffset);
				generatedOffset += cache.lineLengths[lineIndex]! + 1;
			}
			const mappedOffsets = new Set<number>();
			for (
				let generatedLine = 1;
				generatedLine <= cache.lineLengths.length;
				generatedLine += 1
			) {
				for (
					let generatedColumn = 0;
					generatedColumn <= cache.lineLengths[generatedLine - 1]!;
					generatedColumn += 1
				) {
					const origin = sourceMap.findOrigin(generatedLine, generatedColumn);
					if (
						!origin ||
						!("lineNumber" in origin) ||
						!("columnNumber" in origin)
					)
						continue;
					const originFile =
						"fileName" in origin && typeof origin.fileName === "string"
							? origin.fileName
							: "file" in origin && typeof origin.file === "string"
								? origin.file
								: "";
					let originPath: string;
					try {
						originPath = originFile.startsWith("file:")
							? fileURLToPath(originFile)
							: path.resolve(path.dirname(scriptPath), originFile);
					} catch {
						continue;
					}
					if (path.resolve(originPath) !== targetPath) continue;
					const originColumn = origin.columnNumber - 1;
					if (
						origin.lineNumber === sourceLine &&
						originColumn >= sourceColumn &&
						originColumn < sourceColumn + siteNeedle.length
					) {
						mappedOffsets.add(
							offsetsByLine[generatedLine - 1]! + generatedColumn,
						);
					}
				}
			}
			const functions = (script.functions ?? []).filter(
				(fn) => fn.functionName === functionName,
			);
			if (functions.length !== 1) continue;
			const fn = functions[0]!;
			const effectiveCounts = [...mappedOffsets].map((offset) => ({
				offset,
				count: mostSpecificCoverageCountAtOffset(fn.ranges, offset),
			}));
			const functionCallCount = fn.ranges[0]?.count ?? 0;
			const counts = effectiveCounts.map((entry) => entry.count);
			const siteState =
				counts.length && counts.every((count) => count !== null && count > 0)
					? "executed"
					: counts.length && counts.every((count) => count === 0)
						? "not-executed"
						: "reachability-unknown";
			if (mappedOffsets.size)
				matches.push({
					coverageFile,
					script: script.url,
					functionName,
					functionCallCount,
					mappedOffsets: [...mappedOffsets],
					effectiveCounts,
					siteState,
				});
		}
	}
	const siteStates = new Set(matches.map((entry) => entry.siteState));
	const uniqueState =
		siteStates.size === 1 ? [...siteStates][0] : "reachability-unknown";
	return {
		label,
		method: "NODE_V8_COVERAGE source-map-cache offset mapping",
		sourceFile:
			path.relative(snapshot, sourceFilePath) || path.basename(sourceFilePath),
		sourceLine,
		sourceColumn,
		mappedOffsetCount: matches.reduce(
			(sum, entry) =>
				sum + ((entry.mappedOffsets as number[] | undefined)?.length ?? 0),
			0,
		),
		functionName,
		coverageMatches: matches,
		functionCalled: matches.some(
			(entry) => Number(entry.functionCallCount) > 0,
		),
		siteState: uniqueState,
		executed: uniqueState === "executed",
		reason: matches.length
			? undefined
			: "no unique source-map/script/function binding for target span",
	};
}

async function qualifyNestedReachability(
	snapshot: string,
	home: string,
	temp: string,
	testFiles: string[],
): Promise<Record<string, unknown>> {
	const target = path.join(snapshot, TARGET);
	const original = await readFile(target);
	const beforeHash = sha256(original);
	const manifestFiles = [TARGET, ...testFiles];
	const manifestBefore = await fileHashes(snapshot, manifestFiles);
	const exportLine =
		"\nexport { isAscendingByCreatedAt as __mutationReachabilityProbe };\n";
	if (original.includes(Buffer.from("__mutationReachabilityProbe")))
		throw new Error("reachability probe export already exists");
	const instrumented = Buffer.concat([original, Buffer.from(exportLine)]);
	const probeFile = path.join(temp, "groupme-reachability-probe.mjs");
	const importUrl = pathToFileURL(target).href;
	await writeFile(target, instrumented);
	const attempts: Record<string, unknown>[] = [];
	try {
		await assertOnlyTargetChanged(snapshot);
		await writeFile(
			probeFile,
			`import { __mutationReachabilityProbe } from ${JSON.stringify(importUrl)};\nconst messages = process.argv[2] === "single" ? [{ created_at: 1 }] : [{ created_at: 2 }, { created_at: 1 }];\n__mutationReachabilityProbe(messages);\n`,
		);
		for (const [mode, expected] of [
			["single", "not-executed"],
			["pair", "executed"],
		] as const) {
			const label = `nested-site-${mode}`;
			const coverage = path.join(temp, `coverage-${label}`);
			await mkdir(coverage, { recursive: true });
			const result = await runProcess(
				process.execPath,
				["--import", "tsx", probeFile, mode],
				{
					cwd: snapshot,
					env: childEnvironment(home, temp, coverage),
				},
			);
			const reachability = await verifyReachability(
				snapshot,
				temp,
				label,
				"curr.created_at < prev.created_at",
				"isAscendingByCreatedAt",
			);
			const entry = {
				label,
				argv: result.argv,
				exitCode: result.exitCode,
				signal: result.signal,
				durationMs: result.durationMs,
				stderrBytes: result.stderrBytes,
				stderrSha256: result.stderrSha256,
				expected,
				reachability,
			};
			attempts.push(entry);
			if (
				result.exitCode !== 0 ||
				result.signal ||
				result.timedOut ||
				reachability.siteState !== expected
			) {
				throw new Error(
					`${label}: expected ${expected}, got ${String(reachability.siteState)} (exit=${result.exitCode}, signal=${result.signal})`,
				);
			}
			if (reachability.functionCalled !== true)
				throw new Error(`${label}: production function call was not observed`);
		}
		return { status: "qualified", attempts };
	} finally {
		const restoredHash = await restoreFile(target, original, beforeHash);
		await assertCleanSnapshot(snapshot);
		const manifestAfter = await fileHashes(snapshot, manifestFiles);
		if (
			restoredHash !== beforeHash ||
			JSON.stringify(manifestBefore) !== JSON.stringify(manifestAfter)
		) {
			throw new Error(
				"nested-site probe did not restore target and test manifest hashes",
			);
		}
	}
}

async function applyFault(
	snapshot: string,
	fault: { preimage: string; replacement: string },
): Promise<{ before: Buffer; beforeHash: string; mutatedHash: string }> {
	const file = path.join(snapshot, TARGET);
	const before = await readFile(file);
	const changed = replaceExactly(before, fault.preimage, fault.replacement);
	const beforeHash = sha256(before);
	try {
		await writeFile(file, changed, {
			mode:
				constants.S_IRUSR |
				constants.S_IWUSR |
				constants.S_IRGRP |
				constants.S_IROTH,
		});
	} catch (error) {
		await restoreFile(file, before, beforeHash);
		throw error;
	}
	return { before, beforeHash, mutatedHash: sha256(changed) };
}

async function restoreSource(
	snapshot: string,
	before: Buffer,
	expectedHash: string,
): Promise<string> {
	const restoredHash = await restoreFile(
		path.join(snapshot, TARGET),
		before,
		expectedHash,
	);
	await assertCleanSnapshot(snapshot);
	return restoredHash;
}

async function runAndRecord(
	snapshot: string,
	files: string[],
	home: string,
	temp: string,
	report: Record<string, unknown>,
	label: string,
): Promise<ReporterRun> {
	const { parsed } = await reportRun(
		makeTestArgs(snapshot, files),
		snapshot,
		home,
		temp,
		report,
		label,
	);
	if (!parsed.run) throw new Error(`${label}: reporter stream missing`);
	return parsed.run;
}

async function runMutationAttempt(
	snapshot: string,
	files: string[],
	baseline: ReporterRun,
	home: string,
	temp: string,
	report: Record<string, unknown>,
	label: string,
	mutation: {
		id: string;
		preimage: string;
		replacement: string;
		ownerTest?: string;
		ownerAssertion?: string;
		siteNeedle: string;
	},
): Promise<{ status: string; ownerReason?: string }> {
	if (Date.now() - Number(report.startedAtMs) > BATCH_LIMIT_MS)
		throw new Error("batch time limit exceeded");
	await assertCleanSnapshot(snapshot);
	const manifest = await fileHashes(snapshot, [TARGET, ...files]);
	let injected: Awaited<ReturnType<typeof applyFault>> | undefined;
	let restored = false;
	try {
		injected = await applyFault(snapshot, mutation);
		const mutationRecord: Record<string, unknown> = {
			label,
			id: mutation.id,
			target: TARGET,
			siteNeedle: mutation.siteNeedle,
			beforeSha256: injected.beforeHash,
			mutatedSha256: injected.mutatedHash,
			restoredSha256: null,
		};
		(report.mutations as Record<string, unknown>[]).push(mutationRecord);
		await assertOnlyTargetChanged(snapshot);
		const diff = await runProcess(
			"git",
			["diff", "--no-ext-diff", "--unified=0", "--", TARGET],
			{
				cwd: snapshot,
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
			},
		);
		if (diff.exitCode !== 0 || !diff.stdout)
			throw new Error("injected source diff missing");
		mutationRecord.injectedDiff = diff.stdout;
		const testRunResult = await reportRun(
			makeTestArgs(snapshot, [FOCUSED_TEST]),
			snapshot,
			home,
			temp,
			report,
			label,
		);
		const parsed = testRunResult.parsed;
		if (!parsed.run) return { status: parsed.status };
		if (
			!sameMutantPopulation(
				baseline.events,
				parsed.run.events,
				mutation.ownerTest ?? "",
			)
		)
			return { status: "selection_miss_population" };
		const mutantOwnerStatus = ownerStatus(
			parsed.run.events,
			mutation.ownerTest ?? "",
		);
		if (mutantOwnerStatus !== "passed" && mutantOwnerStatus !== "failed")
			return { status: "missing_or_skipped_owner" };
		const reachable = await verifyReachability(
			snapshot,
			temp,
			label,
			mutation.siteNeedle,
			functionForSite({ id: mutation.id }),
		);
		(report.reachability as unknown[]).push(reachable);
		if (parsed.status === "tests_failed") {
			if (!mutation.ownerTest || !mutation.ownerAssertion)
				return { status: "unexpected_failure" };
			const owner = verifyOwnerFailure(parsed.run.events, {
				id: mutation.id as GroupMeFault["id"],
				ownerTest: mutation.ownerTest,
				ownerAssertion: mutation.ownerAssertion,
			});
			if (reachable.executed !== true)
				return { status: "reachability_unknown", ownerReason: owner.reason };
			return owner.ok
				? { status: "killed", ownerReason: owner.reason }
				: { status: "selection_miss", ownerReason: owner.reason };
		}
		if (reachable.executed !== true) return { status: "reachability_unknown" };
		const backstop = await runAndRecord(
			snapshot,
			files,
			home,
			temp,
			report,
			`${label}-GroupMe-backstop`,
		);
		if (!samePopulation(backstop.events, baselineBackstop(report).events))
			return { status: "selection_miss_backstop_population" };
		if (!ownersPassed(backstop.events, GROUPME_FAULTS))
			return { status: "selection_miss_backstop_owner" };
		if (backstop.counts.failed)
			return { status: "selection_miss_backstop_failure" };
		return { status: "survived" };
	} finally {
		if (injected && !restored) {
			const restoredHash = await restoreSource(
				snapshot,
				injected.before,
				injected.beforeHash,
			);
			const mutationRecord = (
				report.mutations as Array<Record<string, unknown>>
			).findLast((entry) => entry.label === label);
			if (mutationRecord) mutationRecord.restoredSha256 = restoredHash;
			restored = true;
		}
		const after = await fileHashes(snapshot, [TARGET, ...files]);
		if (JSON.stringify(after) !== JSON.stringify(manifest))
			throw new Error("focused source/test manifest changed during attempt");
		const restoredRun = await runAndRecord(
			snapshot,
			[FOCUSED_TEST],
			home,
			temp,
			report,
			`${label}-restored-focused`,
		);
		validateBaseline(restoredRun, `${label} restored focused`);
		if (
			!samePopulation(baseline.events, restoredRun.events) ||
			!ownersPassed(restoredRun.events, GROUPME_FAULTS)
		) {
			throw new Error(
				`${label}: restored focused identity/status or owner state differs from baseline`,
			);
		}
	}
}

function baselineBackstop(report: Record<string, unknown>): ReporterRun {
	const run = (report.runs as Array<Record<string, unknown>>).find(
		(entry) => entry.label === "baseline-GroupMe-backstop",
	);
	if (!run?.events || !run.counts)
		throw new Error("GroupMe backstop baseline missing");
	return {
		events: run.events as TestEvent[],
		counts: run.counts as Record<string, number>,
		raw: String(run.rawEvents ?? ""),
	};
}

async function baselineFocused(
	snapshot: string,
	home: string,
	temp: string,
	report: Record<string, unknown>,
): Promise<ReporterRun> {
	const run = await runAndRecord(
		snapshot,
		[FOCUSED_TEST],
		home,
		temp,
		report,
		"baseline-focused",
	);
	validateBaseline(run, "focused");
	for (const fault of GROUPME_FAULTS) {
		if (ownerStatus(run.events, fault.ownerTest) !== "passed")
			throw new Error(`required owner test missing or unskipped: ${fault.id}`);
	}
	return run;
}

async function runBackstop(
	snapshot: string,
	files: string[],
	home: string,
	temp: string,
	report: Record<string, unknown>,
): Promise<ReporterRun> {
	const run = await runAndRecord(
		snapshot,
		files,
		home,
		temp,
		report,
		"baseline-GroupMe-backstop",
	);
	validateBaseline(run, "GroupMe backstop");
	return run;
}

export function changedSourceInterval(
	source: string,
	preimage: string,
	replacement: string,
): {
	startByte: number;
	endByte: number;
	startLine: number;
	endLine: number;
	insertion: boolean;
} {
	const start = source.indexOf(preimage);
	if (start < 0 || source.indexOf(preimage, start + preimage.length) >= 0)
		throw new Error("mutation preimage must be unique in HEAD source");
	let prefix = 0;
	while (
		prefix < preimage.length &&
		prefix < replacement.length &&
		preimage[prefix] === replacement[prefix]
	)
		prefix += 1;
	let suffix = 0;
	while (
		suffix < preimage.length - prefix &&
		suffix < replacement.length - prefix &&
		preimage[preimage.length - suffix - 1] ===
			replacement[replacement.length - suffix - 1]
	)
		suffix += 1;
	const startIndex = start + prefix;
	const endIndex = start + preimage.length - suffix;
	if (startIndex === endIndex && preimage.length === replacement.length)
		throw new Error("mutation preimage and replacement have no changed bytes");
	const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
	const endForLine = startIndex === endIndex ? startIndex : endIndex - 1;
	return {
		startByte: Buffer.byteLength(source.slice(0, startIndex)),
		endByte: Buffer.byteLength(source.slice(0, endIndex)),
		startLine: lineAt(startIndex),
		endLine: lineAt(endForLine),
		insertion: startIndex === endIndex,
	};
}

export async function selectOrdinaryFaults(
	repo: string,
	head: string,
	mergeBase: string,
	env: NodeJS.ProcessEnv,
	report: Record<string, unknown>,
): Promise<GroupMeFault[]> {
	const rawNames = await git(
		repo,
		["diff", "--name-status", "-z", "--find-renames", mergeBase, head],
		env,
	);
	const changes = parseNameStatus(rawNames.stdout);
	const applicable: GroupMeFault[] = [];
	const changedPaths = new Set<string>();
	let targetChanged = false;
	for (const change of changes) {
		for (const changedPath of change.paths) changedPaths.add(changedPath);
		const newPath = change.paths.at(-1)!;
		const oldPath = change.paths[0]!;
		if (change.status === "D") {
			if (oldPath === TARGET)
				(report.deletedHeadTargets as string[]).push(oldPath);
			else (report.unsupportedChangedPaths as string[]).push(oldPath);
			continue;
		}
		if (change.status === "R100") {
			(report as Record<string, unknown>).pureRenames ??= [];
			((report as Record<string, unknown>).pureRenames as string[]).push(
				change.paths.join(" -> "),
			);
			if (oldPath === TARGET && newPath !== TARGET)
				(report.deletedHeadTargets as string[]).push(oldPath);
			continue;
		}
		if (
			change.status.startsWith("R") &&
			oldPath === TARGET &&
			newPath !== TARGET
		) {
			(report.deletedHeadTargets as string[]).push(oldPath);
			(report.unsupportedChangedPaths as string[]).push(newPath);
			continue;
		}
		if (newPath !== TARGET) {
			if (!newPath.endsWith(".test.ts") && !newPath.includes("/generated/"))
				(report.unsupportedChangedPaths as string[]).push(newPath);
			continue;
		}
		if (change.status === "A")
			(report.addedRegisteredPaths as string[]).push(newPath);
		const pathspec = change.status.startsWith("R")
			? [oldPath, newPath]
			: [newPath];
		const diff = await git(
			repo,
			[
				"diff",
				"--no-ext-diff",
				"--no-color",
				"--find-renames",
				"--unified=0",
				mergeBase,
				head,
				"--",
				...pathspec,
			],
			env,
		);
		if (!diff.stdout.trim()) {
			if (change.status.startsWith("R")) continue;
			throw new Error(`changed path has no diff hunks: ${newPath}`);
		}
		const changedLines = parseChangedHeadLines(diff.stdout);
		targetChanged = true;
		const headFile = (await git(repo, ["show", `${head}:${TARGET}`], env))
			.stdout;
		for (const fault of GROUPME_FAULTS) {
			const interval = changedSourceInterval(
				headFile,
				fault.preimage,
				fault.replacement,
			);
			if (
				[...changedLines].some(
					(line) => line >= interval.startLine && line <= interval.endLine,
				)
			) {
				applicable.push(fault);
				const sites = (report as Record<string, unknown>)
					.selectedMutationSites as unknown[] | undefined;
				(report as Record<string, unknown>).selectedMutationSites = [
					...(sites ?? []),
					{ id: fault.id, ...interval },
				];
			}
		}
	}
	(report.changedPaths as string[]).push(...changedPaths);
	if (targetChanged && applicable.length === 0)
		(report.eligibleZeroApplicableSites as string[]).push(TARGET);
	if ((report.deletedHeadTargets as string[]).includes(TARGET))
		throw new Error(
			`registered production target removed or renamed out: ${TARGET}`,
		);
	return [...new Map(applicable.map((fault) => [fault.id, fault])).values()];
}

async function runGroupMeLane(options: {
	repo: string;
	base: string;
	head: string;
	mergeBase: string;
	mode: "diff" | "qualify";
	reportPath?: string;
}): Promise<Record<string, unknown>> {
	const startedAtMs = Date.now();
	const repo = path.resolve(options.repo);
	const baseDir = path.join(os.homedir(), ".tmp");
	await mkdir(baseDir, { recursive: true });
	const temp = await mkdtemp(path.join(baseDir, "groupme-mutation-"));
	const home = path.join(temp, "home");
	const snapshot = path.join(temp, "snapshot");
	await mkdir(home, { recursive: true });
	const env = childEnvironment(home, temp);
	const report: Record<string, unknown> = {
		format: 1,
		mode: options.mode,
		baseSha: options.base,
		headSha: options.head,
		mergeBaseSha: options.mergeBase,
		nodeVersion: process.version,
		npmVersion: "unknown",
		startedAt: new Date(startedAtMs).toISOString(),
		startedAtMs,
		tempRoot: temp,
		runs: [],
		faultResults: [],
		reachability: [],
		changedPaths: [],
		unsupportedChangedPaths: [],
		deletedHeadTargets: [],
		addedRegisteredPaths: [],
		mutations: [],
		eligibleZeroApplicableSites: [],
		cleanup: { status: "pending" },
	};
	let worktreeAdded = false;
	let cleanupError: string | undefined;
	let primaryError: string | undefined;
	let requiredFaultError: string | undefined;
	const allTestFiles: string[] = [];
	let callerFiles: string[] | undefined;
	let callerHeadBefore: string | undefined;
	let callerHashesBefore: Record<string, string> | undefined;
	try {
		const baseSha = await requiredSha(repo, options.base, env);
		const headSha = await requiredSha(repo, options.head, env);
		const mergeBaseSha = await requiredSha(repo, options.mergeBase, env);
		const actualMergeBase = (
			await git(repo, ["merge-base", baseSha, headSha], env)
		).stdout.trim();
		if (actualMergeBase !== mergeBaseSha)
			throw new Error("provided merge-base does not match git merge-base");
		report.baseSha = baseSha;
		report.headSha = headSha;
		report.mergeBaseSha = mergeBaseSha;
		callerHeadBefore = (
			await git(repo, ["rev-parse", "HEAD"], env)
		).stdout.trim();
		callerFiles = await testFiles(repo);
		callerHashesBefore = await fileHashes(repo, [TARGET, ...callerFiles]);
		if (!nodeVersionSupported(process.version))
			throw new Error(
				`Node ${process.version} is outside supported range >=24.15.0 <25`,
			);
		const npmVersion = await runProcess("npm", ["--version"], {
			cwd: repo,
			env,
		});
		if (npmVersion.exitCode !== 0 || npmVersion.signal)
			throw new Error("cannot read npm version");
		report.npmVersion = npmVersion.stdout.trim();
		const worktree = await git(
			repo,
			["worktree", "add", "--detach", snapshot, headSha],
			env,
		);
		worktreeAdded = true;
		(report as Record<string, unknown>).snapshotAdd = worktree.stdout.trim();
		const actualHead = (
			await git(snapshot, ["rev-parse", "HEAD"], env)
		).stdout.trim();
		if (actualHead !== headSha)
			throw new Error("snapshot HEAD does not match requested head");
		await assertCleanSnapshot(snapshot);
		const install = await runProcess(
			"npm",
			["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
			{
				cwd: snapshot,
				env: childEnvironment(home, temp),
				timeoutMs: CHILD_TIMEOUT_MS,
			},
		);
		(report as Record<string, unknown>).install = {
			argv: install.argv,
			exitCode: install.exitCode,
			signal: install.signal,
			durationMs: install.durationMs,
			stderrBytes: install.stderrBytes,
			stderrSha256: install.stderrSha256,
		};
		if (
			install.exitCode !== 0 ||
			install.signal ||
			install.timedOut ||
			install.outputTruncated
		)
			throw new Error("snapshot dependency install failed");
		await assertWorkspaceLinksInSnapshot(snapshot);
		allTestFiles.push(...(await testFiles(snapshot)));
		if (!allTestFiles.includes(FOCUSED_TEST) || !allTestFiles.length)
			throw new Error(
				"GroupMe test manifest is empty or focused oracle missing",
			);
		const manifestFiles = [TARGET, ...allTestFiles];
		const cleanHashes = await fileHashes(snapshot, manifestFiles);
		await assertCleanSnapshot(snapshot);
		const focused = await baselineFocused(snapshot, home, temp, report);
		const full = await runBackstop(snapshot, allTestFiles, home, temp, report);
		if (!ownersPassed(full.events, GROUPME_FAULTS))
			throw new Error("GroupMe backstop owner test missing or not passed");
		report.baseline = {
			focusedCounts: focused.counts,
			GroupMeCounts: full.counts,
			testFiles: allTestFiles,
			sourceAndTestsSha256: cleanHashes,
		};
		if (options.mode === "qualify")
			report.nestedReachabilityProbe = await qualifyNestedReachability(
				snapshot,
				home,
				temp,
				allTestFiles,
			);
		let selected: GroupMeFault[];
		if (options.mode === "qualify") selected = [...GROUPME_FAULTS];
		else
			selected = await selectOrdinaryFaults(
				repo,
				headSha,
				mergeBaseSha,
				env,
				report,
			);
		if (!selected.length && options.mode === "diff")
			report.result = "no-mutation-proof";
		const faultResults = report.faultResults as FaultResult[];
		for (const fault of selected) {
			const attempts: unknown[] = [];
			const killStatuses: string[] = [];
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				const id = `${fault.id}-${attempt}`;
				const result = await runMutationAttempt(
					snapshot,
					allTestFiles,
					focused,
					home,
					temp,
					report,
					id,
					{
						...fault,
						siteNeedle:
							fault.id === "page-ceiling"
								? "mutationPageCount > 200"
								: "return true;",
					},
				);
				attempts.push(result);
				killStatuses.push(result.status);
			}
			const outcome = faultAttemptOutcome(killStatuses);
			faultResults.push({ id: fault.id, status: outcome, attempts });
			if (outcome !== "killed") {
				report.result = outcome;
				requiredFaultError ??= `required fault outcome ${outcome}: ${fault.id} (${killStatuses.join(",")})`;
				break;
			}
		}
		if (options.mode === "qualify" && !requiredFaultError) {
			const controlStatuses: string[] = [];
			for (let attempt = 1; attempt <= 2; attempt += 1) {
				const result = await runMutationAttempt(
					snapshot,
					allTestFiles,
					focused,
					home,
					temp,
					report,
					`timestamp-equality-control-${attempt}`,
					{
						id: "timestamp-equality-control",
						preimage: EQUALITY_CONTROL.preimage,
						replacement: EQUALITY_CONTROL.replacement,
						ownerTest: EQUALITY_CONTROL.ownerTest,
						ownerAssertion: "",
						siteNeedle: EQUALITY_CONTROL.replacement,
					},
				);
				controlStatuses.push(result.status);
			}
			const controlOutcome = faultAttemptOutcome(controlStatuses, "survive");
			if (controlOutcome !== "calibration-control-survived") {
				report.result = "calibration-control-failed";
				requiredFaultError = `calibration control did not survive twice with reachability: ${controlStatuses.join(",")}`;
			}
			report.calibrationControl = {
				id: "timestamp-equality-control",
				attempts: controlStatuses,
				classification: controlOutcome,
			};
		}
		await assertCleanSnapshot(snapshot);
		const finalBackstop = await runAndRecord(
			snapshot,
			allTestFiles,
			home,
			temp,
			report,
			"final-restored-GroupMe-backstop",
		);
		validateBaseline(finalBackstop, "final restored GroupMe");
		if (
			!samePopulation(baselineBackstop(report).events, finalBackstop.events) ||
			!ownersPassed(finalBackstop.events, GROUPME_FAULTS)
		) {
			report.result = "restored-backstop-mismatch";
			throw new Error(
				"final restored GroupMe identity/status or owner state differs from baseline",
			);
		}
		if (requiredFaultError) throw new Error(requiredFaultError);
		report.result =
			options.mode === "qualify"
				? "qualification-passed"
				: (report.result ?? "mutation-run-complete");
	} catch (error) {
		primaryError = error instanceof Error ? error.message : String(error);
		report.error = primaryError;
		if ((report.deletedHeadTargets as string[]).includes(TARGET))
			report.result = "registered-target-removed";
	} finally {
		for (const child of ownedChildren) child.kill("SIGTERM");
		if (worktreeAdded) {
			try {
				const removal = await runProcess(
					"git",
					["worktree", "remove", "--force", snapshot],
					{
						cwd: repo,
						env,
						timeoutMs: CHILD_TIMEOUT_MS,
					},
				);
				if (removal.exitCode !== 0 || removal.signal || removal.timedOut)
					throw new Error(
						`git worktree remove failed (${removal.exitCode}/${removal.signal})`,
					);
				await rm(temp, { recursive: true, force: true });
				(report.cleanup as Record<string, unknown>).status = "removed";
			} catch (error) {
				cleanupError = error instanceof Error ? error.message : String(error);
				(report.cleanup as Record<string, unknown>).status = "failed";
				(report.cleanup as Record<string, unknown>).error = cleanupError;
			}
		} else {
			await rm(temp, { recursive: true, force: true }).catch((error) => {
				cleanupError = String(error);
			});
			(report.cleanup as Record<string, unknown>).status = cleanupError
				? "failed"
				: "removed";
		}
		if (callerFiles && callerHashesBefore && callerHeadBefore) {
			try {
				const callerHashesAfter = await fileHashes(repo, [
					TARGET,
					...callerFiles,
				]);
				const callerHeadAfter = (
					await git(repo, ["rev-parse", "HEAD"], env)
				).stdout.trim();
				const unchanged =
					callerHeadAfter === callerHeadBefore &&
					JSON.stringify(callerHashesAfter) ===
						JSON.stringify(callerHashesBefore);
				report.callerTree = {
					headBefore: callerHeadBefore,
					headAfter: callerHeadAfter,
					sourceAndTestsBeforeSha256: callerHashesBefore,
					sourceAndTestsAfterSha256: callerHashesAfter,
					unchanged,
				};
				if (!unchanged)
					throw new Error(
						"caller HEAD/source/test hashes changed during the run",
					);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				primaryError = [
					primaryError,
					`caller tree verification failed: ${message}`,
				]
					.filter(Boolean)
					.join("; ");
				report.error = primaryError;
				report.result = "caller-tree-verification-failure";
			}
		}
	}
	if (requestedSignal) report.signal = requestedSignal;
	if (cleanupError)
		report.error = [report.error, `cleanup failure: ${cleanupError}`]
			.filter(Boolean)
			.join("; ");
	if (cleanupError) report.result = "cleanup-failure";
	report.finishedAt = new Date().toISOString();
	report.durationMs = Date.now() - startedAtMs;
	delete report.startedAtMs;
	const defaultReport = path.join(
		os.homedir(),
		".tmp",
		`groupme-mutation-${String(report.headSha).slice(0, 12)}-${randomUUID()}.json`,
	);
	const destination = path.resolve(options.reportPath ?? defaultReport);
	report.reportPath = destination;
	await mkdir(path.dirname(destination), { recursive: true });
	await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		JSON.stringify({
			result: report.result ?? "failed",
			report: destination,
			error: report.error ?? null,
		}),
	);
	if (cleanupError || primaryError || report.result === "cleanup-failure")
		process.exitCode = 1;
	return report;
}

function parseArgs(args: string[]): {
	base?: string;
	head?: string;
	mergeBase?: string;
	mode: "diff" | "qualify";
	report?: string;
	repo: string;
} {
	const parsed: {
		base?: string;
		head?: string;
		mergeBase?: string;
		mode: "diff" | "qualify";
		report?: string;
		repo: string;
	} = {
		mode: "diff",
		repo: process.cwd(),
	};
	for (let i = 0; i < args.length; i += 1) {
		const [key, inline] = args[i].split("=", 2);
		const value = inline ?? args[++i];
		if (key === "--base") parsed.base = value;
		else if (key === "--head") parsed.head = value;
		else if (key === "--merge-base") parsed.mergeBase = value;
		else if (key === "--mode" && (value === "diff" || value === "qualify"))
			parsed.mode = value;
		else if (key === "--report") parsed.report = value;
		else if (key === "--repo") parsed.repo = value;
		else throw new Error(`unknown argument: ${args[i]}`);
	}
	return parsed;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (!args.base || !args.head || !args.mergeBase)
			throw new Error(
				"--base, --head, and --merge-base full SHAs are required",
			);
		await runGroupMeLane({
			repo: args.repo,
			base: args.base,
			head: args.head,
			mergeBase: args.mergeBase,
			mode: args.mode,
			reportPath: args.report,
		});
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

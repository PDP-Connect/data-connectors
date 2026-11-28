#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock mutation check — proves whether a connector's request-path mocks
 * would actually catch a wrong path, or just ratify whatever the
 * implementation happens to send.
 *
 * The failure mode this targets: Jellyfin shipped with every test green
 * while every request 404'd in production, because its test server
 * matched on the SAME `/api/...` literal the implementation used to build
 * the request. Mock and code shared an author and therefore shared the
 * mistake — no assertion in the suite could ever have failed. A mock that
 * still passes when its path literal is corrupted proves nothing; it is
 * worse than no mock, because it manufactures false confidence.
 *
 * Method: for each connector test file, statically find string literals
 * used as request-path matchers (`path === "/foo"`, `.startsWith("/foo")`,
 * `.includes("/foo")` — the shapes real fake-HTTP-server routing and
 * request-path assertions use in this repo). For each literal found,
 * write a scratch copy of the test file with that ONE literal corrupted
 * (a leading slash replaced by a fragment marker), and
 * run the scratch file with `node --test`. The unmodified file must pass
 * first. The mutation is load-bearing only if a previously passing test
 * fails with an assertion. A passing mutation is decorative. A failed
 * baseline, timeout, or other error leaves the trial inconclusive.
 *
 * Honesty contract:
 *   - A connector with zero detected path-literal matchers reports
 *     UNKNOWN, never PASS. Most of this repo's 42 connectors have no
 *     HTTP-path-matching mock at all (some have no HTTP test coverage
 *     whatsoever) — that is a DIFFERENT, and often worse, gap than a weak
 *     mock, and this script must not blur the two by inventing a passing
 *     grade for "nothing to check."
 *   - A connector only reaches PASS when EVERY detected literal in EVERY
 *     one of its test files is load-bearing under mutation. One decorative
 *     literal among ten real ones still means the suite has a soft spot.
 *
 * REPORT-ONLY by design (see meta.reportOnly below): 34 of 42 connectors
 * are `unproven` and most have zero mutable mock surface, so a hard gate
 * here would fail CI for nearly the whole roster on day one. The ratchet
 * is manual — this script's test entry point
 * (`src/mock-mutation-check.test.ts`, following the
 * `check-no-await-in-loops-conformance.ts`/`src/*-self-check.test.ts`
 * precedent for scripts that need to import a helper `scripts/**` isn't
 * in the package's `test` glob) is where a future PR pins a known-good
 * connector set and turns individual connectors from advisory to blocking
 * as they're proven, the same shape as `no-await-in-loops-allowlist.ts`.
 *
 * Usage:
 *   node --import tsx scripts/mock-mutation-check.ts             # table
 *   node --import tsx scripts/mock-mutation-check.ts --json      # machine-readable
 *   node --import tsx scripts/mock-mutation-check.ts --connector=jellyfin
 */

import { spawnSync } from "node:child_process";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import { z } from "zod";
import {
	connectorDir,
	packageRoot as PACKAGE_ROOT,
	repoRoot,
} from "../src/connector-paths.ts";

const TEST_TIMEOUT_MS = 20_000;
const REPORTER = join(PACKAGE_ROOT, "scripts", "mock-mutation-reporter.ts");

// Matches the request-path-matcher shapes actually used across this repo's
// connector tests: `identifier === "/foo"`, `identifier.startsWith("/foo")`,
// `identifier.includes("/foo")`. Deliberately narrow — a general string
// literal isn't a path matcher, and a false-positive match would waste a
// mutation run on a literal that was never load-bearing to begin with.
const PATH_MATCHER_RE =
	/(?:\.(?:startsWith|includes)\("(\/[^"]*)"\)|===\s*"(\/[^"]*)")/g;

export interface PathLiteralSite {
	readonly file: string;
	readonly line: number;
	readonly literal: string;
}

export interface ConnectorMutationResult {
	readonly connector: string;
	readonly decorative: readonly PathLiteralSite[];
	readonly detail: string;
	readonly inconclusive: readonly InconclusiveTrial[];
	readonly loadBearing: number;
	readonly sites: readonly PathLiteralSite[];
	readonly verdict: "PASS" | "WEAK" | "UNKNOWN";
}

interface InconclusiveTrial {
	readonly site: PathLiteralSite;
	readonly reason: string;
}

function listConnectors(): string[] {
	return readdirSync(connectorDir("."), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort();
}

const SCRATCH_PREFIX = "__mutation_scratch_";

/**
 * Delete any scratch copies left behind by an interrupted run.
 *
 * The trial writes its scratch alongside the original (relative imports must
 * resolve) and removes it in a `finally`. A hard kill — Ctrl-C, an OOM, a CI
 * timeout — skips that `finally`, and the orphan then looks like a real test
 * file to every later run AND to `npx tsx --test connectors/<c>/*.test.ts`,
 * where it fails as a duplicate of the test it was copied from. Sweeping at
 * startup makes an interrupted run self-healing instead of poisoning the next
 * one.
 */
function sweepOrphanedScratchFiles(): number {
	let removed = 0;
	for (const connector of listConnectors()) {
		const dir = connectorDir(connector);
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith(SCRATCH_PREFIX)) {
				rmSync(join(dir, entry), { force: true });
				removed += 1;
			}
		}
	}
	return removed;
}

function listTestFiles(connector: string): string[] {
	const dir = connectorDir(connector);
	if (!existsSync(dir)) {
		return [];
	}
	return (
		readdirSync(dir)
			.filter((f) => f.endsWith(".test.ts"))
			// Scratch copies are written alongside the original (relative imports must
			// resolve) and therefore also end in `.test.ts`. Without this filter a
			// leftover scratch from an interrupted run is collected as a real test
			// file, and the next trial reads a path that its own `finally` already
			// deleted — the run dies with ENOENT on a filename it invented itself.
			.filter((f) => !f.startsWith(SCRATCH_PREFIX))
			.map((f) => join(dir, f))
			.sort()
	);
}

/** Find every path-literal matcher site in a test file's source text. */
export function findPathLiteralSites(
	filePath: string,
	source: string,
): PathLiteralSite[] {
	const sites: PathLiteralSite[] = [];
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		// Skip comment lines: a regression-guard comment quoting a path (jellyfin's
		// "Jellyfin serves its REST API at the root, NOT under /api/" style notes)
		// is documentation, not a matcher — mutating it would corrupt the scratch
		// file's prose without changing any executable behavior, producing a
		// meaningless mutation run.
		const trimmed = line.trim();
		if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
			continue;
		}
		PATH_MATCHER_RE.lastIndex = 0;
		let match = PATH_MATCHER_RE.exec(line);
		while (match) {
			const literal = match[1] ?? match[2];
			if (literal) {
				sites.push({ file: filePath, line: i + 1, literal });
			}
			match = PATH_MATCHER_RE.exec(line);
		}
	}
	return sites;
}

/**
 * Corrupt EVERY occurrence of `literal` in the source, not just the one at
 * the detected site. A path literal is one logical fact about the real
 * API; the same string routinely appears twice in one file — once where a
 * fake server (or request builder) matches on it, once where an assertion
 * counts/asserts against it (e.g. chatgpt's
 * `fetches.filter((p) => p === "/conversation/c-exhaust-2").length`
 * alongside the router branch that tests the same literal). Mutating only
 * the first occurrence left the second, unmutated occurrence free to keep
 * proving the ORIGINAL fact by coincidence — a real false "decorative"
 * verdict this fixed. Mutating every occurrence together tests whether the
 * fact is checked ANYWHERE, which is the actual question this gate exists
 * to answer.
 */
function mutateSource(source: string, literal: string): string {
	const quoted = `"${literal}"`;
	// Keep columns stable for tests registered on the same line as a matcher.
	const mutated = `"#${literal.slice(1)}"`;
	if (!source.includes(quoted)) {
		throw new Error(
			`literal ${quoted} not found for mutation (source may have changed since detection)`,
		);
	}
	return source.split(quoted).join(mutated);
}

const testReceipt = z.object({
	success: z.boolean(),
	passedTests: z.array(z.string()),
	failedAssertions: z.array(z.string()),
	problem: z.string().optional(),
});

type TestRun =
	| { readonly receipt: z.infer<typeof testReceipt> }
	| { readonly problem: string };

function runTestFile(filePath: string): TestRun {
	let entryFile: string;
	try {
		// The source map resolves aliases such as /var to /private/var on macOS.
		entryFile = realpathSync(filePath);
	} catch {
		return { problem: "could not resolve the test file" };
	}
	const result = spawnSync(
		process.execPath,
		[
			"--enable-source-maps",
			"--test",
			"--import",
			"tsx",
			`--test-timeout=${TEST_TIMEOUT_MS}`,
			"--test-reporter",
			REPORTER,
			entryFile,
		],
		{
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				NODE_TEST_CONTEXT: undefined,
				NODE_TEST_WORKER_ID: undefined,
			},
			timeout: TEST_TIMEOUT_MS * 4,
		},
	);
	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		return {
			problem:
				code === "ETIMEDOUT"
					? "test process timed out"
					: `test process error: ${result.error.message}`,
		};
	}
	if (result.signal) {
		return { problem: `test process stopped by ${result.signal}` };
	}
	try {
		const receipt = testReceipt.parse(JSON.parse(result.stdout));
		if (result.status !== (receipt.success ? 0 : 1)) {
			return {
				problem: `test process exited unexpectedly with status ${result.status}`,
			};
		}
		if (receipt.problem) {
			return { problem: receipt.problem };
		}
		return { receipt };
	} catch {
		return { problem: "test process did not produce a complete result" };
	}
}

/**
 * Run one mutation trial: write a scratch copy of `originalFile` with
 * `site.literal` corrupted, run it, delete the scratch copy, and report
 * whether the mutation caused a failure (load-bearing) or not (decorative).
 * The scratch file is written ALONGSIDE the original (not in system tmp)
 * because the connector's relative imports (`../../src/...`) must resolve.
 */
function runMutationTrial(site: PathLiteralSite): TestRun {
	const original = readFileSync(site.file, "utf8");
	const mutated = mutateSource(original, site.literal);
	const dir = dirname(site.file);
	const scratchPath = join(
		dir,
		`${SCRATCH_PREFIX}${process.pid}_${Date.now()}.test.ts`,
	);
	writeFileSync(scratchPath, mutated);
	try {
		return runTestFile(scratchPath);
	} finally {
		rmSync(scratchPath, { force: true });
	}
}

function runBaseline(file: string): TestRun {
	const run = runTestFile(file);
	if ("problem" in run) return run;
	if (!run.receipt.success) {
		return { problem: "unmodified test file failed" };
	}
	if (run.receipt.passedTests.length === 0) {
		return { problem: "no tests ran and passed" };
	}
	return run;
}

function describeSite(site: PathLiteralSite): string {
	return `${relative(repoRoot, site.file)}:${site.line} "${site.literal}"`;
}

function hasUniqueCase(cases: readonly string[], key: string): boolean {
	const first = cases.indexOf(key);
	return first !== -1 && first === cases.lastIndexOf(key);
}

function checkConnector(connector: string): ConnectorMutationResult {
	const testFiles = listTestFiles(connector);
	const sites: PathLiteralSite[] = [];
	for (const file of testFiles) {
		const source = readFileSync(file, "utf8");
		sites.push(...findPathLiteralSites(file, source));
	}

	// Dedupe identical (file, literal) pairs — the same route matcher can
	// legitimately appear more than once in one file (e.g. a shared fake
	// server class instantiated by several tests); mutating it once proves
	// the same fact every additional occurrence would.
	const seen = new Set<string>();
	const uniqueSites = sites.filter((s) => {
		const key = `${s.file}::${s.literal}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});

	if (uniqueSites.length === 0) {
		return {
			connector,
			verdict: "UNKNOWN",
			sites: [],
			loadBearing: 0,
			decorative: [],
			inconclusive: [],
			detail:
				testFiles.length === 0
					? "no test files found"
					: "no request-path-matching literal detected in test source — this connector's HTTP surface (if any) is not covered by a path-asserting mock; cannot be checked, not the same as passing",
		};
	}

	const baselines = new Map<string, TestRun>();
	const decorative: PathLiteralSite[] = [];
	const inconclusive: InconclusiveTrial[] = [];
	let loadBearing = 0;
	for (const site of uniqueSites) {
		const baseline = baselines.get(site.file) ?? runBaseline(site.file);
		baselines.set(site.file, baseline);
		if ("problem" in baseline) {
			inconclusive.push({ site, reason: `baseline: ${baseline.problem}` });
			continue;
		}
		const result = runMutationTrial(site);
		if ("problem" in result) {
			inconclusive.push({ site, reason: result.problem });
			continue;
		}
		const { receipt } = result;
		if (receipt.success) {
			if (receipt.passedTests.length > 0) {
				decorative.push(site);
			} else {
				inconclusive.push({
					site,
					reason: "no tests ran and passed after mutation",
				});
			}
			continue;
		}
		const assertions = receipt.failedAssertions;
		if (
			assertions.length > 0 &&
			assertions.every(
				(key) =>
					hasUniqueCase(baseline.receipt.passedTests, key) &&
					hasUniqueCase(assertions, key) &&
					!receipt.passedTests.includes(key),
			)
		) {
			loadBearing += 1;
			continue;
		}
		inconclusive.push({
			site,
			reason: "no failing assertion from a test that passed the baseline",
		});
	}

	let verdict: ConnectorMutationResult["verdict"] = "PASS";
	let detail = `${loadBearing}/${uniqueSites.length} path literal(s) are load-bearing — each mutation failed a previously passing assertion`;
	if (inconclusive.length > 0) {
		verdict = "UNKNOWN";
		detail = `${inconclusive.length}/${uniqueSites.length} path literal(s) are inconclusive: ${inconclusive
			.map(({ site, reason }) => `${describeSite(site)} (${reason})`)
			.join("; ")}`;
	} else if (decorative.length > 0) {
		verdict = "WEAK";
		detail = `${decorative.length}/${uniqueSites.length} path literal(s) are decorative — the suite still passes when they're corrupted, at ${decorative
			.map(describeSite)
			.join("; ")}`;
	}

	return {
		connector,
		verdict,
		sites: uniqueSites,
		loadBearing,
		decorative,
		inconclusive,
		detail,
	};
}

export function runAllConnectors(only?: string): ConnectorMutationResult[] {
	const connectors = only ? [only] : listConnectors();
	return connectors.map(checkConnector);
}

function printTable(results: ConnectorMutationResult[]): void {
	const width = Math.max(...results.map((r) => r.connector.length));
	for (const r of results) {
		console.log(
			`${r.verdict.padEnd(8)} ${r.connector.padEnd(width)} ${r.detail}`,
		);
	}
	const pass = results.filter((r) => r.verdict === "PASS").length;
	const weak = results.filter((r) => r.verdict === "WEAK").length;
	const unknown = results.filter((r) => r.verdict === "UNKNOWN").length;
	console.log(
		`\n${pass} PASS, ${weak} WEAK, ${unknown} UNKNOWN (of ${results.length} connectors)`,
	);
	console.log(
		"REPORT-ONLY: this gate does not fail CI. See src/mock-mutation-check.test.ts for the ratchet.",
	);
}

function main(): void {
	const args = process.argv.slice(2);
	const jsonOut = args.includes("--json");
	const connectorArg = args
		.find((a) => a.startsWith("--connector="))
		?.split("=")[1];

	const swept = sweepOrphanedScratchFiles();
	if (swept > 0 && !jsonOut) {
		console.log(
			`swept ${swept} orphaned scratch file(s) from an interrupted run\n`,
		);
	}

	const results = runAllConnectors(connectorArg);

	if (jsonOut) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		printTable(results);
	}
}

if (isMainModule(import.meta.url)) {
	main();
}

#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pnpm test:related <base-ref>` — runs `node --test` against the related
 * selection for local iteration only. See cli.ts's module comment for the
 * fail-closed contract and why this is not a merge gate.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	connectorsDir as CONNECTORS_ROOT,
	packageRoot as PACKAGE_ROOT,
} from "../../src/connector-paths.ts";
import { EXCLUDED_TESTS, NAMESPACE_TESTS } from "../test-lanes.mjs";

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const CLI_PATH = join(PACKAGE_ROOT, "scripts", "related-tests", "cli.ts");
const TEST_SANDBOX = join(
	PACKAGE_ROOT,
	"..",
	"..",
	"scripts",
	"test-sandbox",
	"test-sandbox",
);
const NODE_TEST = ["--test", "--import", "tsx", "--test-timeout=120000"];

type Lane = "sandboxed" | "namespaces";

/**
 * Runs `node <args>` in its own test-sandbox: `sandboxed` with no network,
 * `namespaces` without bwrap so its tests can create their own namespaces.
 * Returns false if the run failed.
 */
function runInLane(lane: Lane, nodeArgs: readonly string[]): boolean {
	const sandboxArgs =
		lane === "namespaces" ? ["--isolate", "cgroup", "--net", "host"] : [];
	try {
		execFileSync(TEST_SANDBOX, [...sandboxArgs, "--", "node", ...nodeArgs], {
			cwd: PACKAGE_ROOT,
			env: { ...process.env, TEST_LANE: lane },
			stdio: "inherit",
		});
		return true;
	} catch {
		return false;
	}
}

export function testFileArgument(testFile: string): string {
	if (testFile.startsWith("connectors/")) {
		return join(CONNECTORS_ROOT, testFile.slice("connectors/".length));
	}
	return testFile;
}

const FAST_BASE_CANDIDATES = [
	["merge-base", "HEAD", "origin/main"],
	["rev-parse", "--verify", "main"],
] as const;

/** `--fast` default base: merge-base with origin/main, else main, else HEAD. */
function resolveFastBase(): string {
	for (const args of FAST_BASE_CANDIDATES) {
		try {
			const ref = execFileSync("git", [...args], {
				cwd: PACKAGE_ROOT,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			if (ref) {
				console.error(
					`[test:fast] base ${ref.slice(0, 12)} (from ${args.join(" ")})`,
				);
				return ref;
			}
		} catch {
			// try the next candidate
		}
	}
	console.error("[test:fast] base HEAD (no origin/main or main found)");
	return "HEAD";
}

function main(): void {
	const rawArgs = process.argv.slice(2);
	const fast = rawArgs.includes("--fast");
	const baseRef =
		rawArgs.find((arg) => arg !== "--fast") ??
		(fast ? resolveFastBase() : undefined);
	if (!baseRef) {
		console.error("usage: pnpm test:related <base-ref>");
		process.exit(1);
	}

	const selectionOutput = execFileSync(
		"node",
		["--import", "tsx", CLI_PATH, baseRef, "--json"],
		{
			cwd: PACKAGE_ROOT,
			encoding: "utf8",
		},
	);
	const selection = JSON.parse(selectionOutput) as {
		kind: string;
		testFiles?: string[];
		reason: string;
	};

	console.error(`[test:related] ${selection.reason}`);
	const rawConcurrency = process.env.TEST_CONCURRENCY ?? (fast ? "4" : "2");
	if (!POSITIVE_INTEGER.test(rawConcurrency)) {
		console.error(
			`TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(rawConcurrency)}`,
		);
		process.exit(2);
	}
	process.env.TEST_CONCURRENCY = rawConcurrency;

	let ok = true;
	if (selection.kind === "FULL_SUITE") {
		if (fast) {
			console.error(
				`[test:fast] FULL_SUITE: ${selection.reason}. Running the full sandboxed lane (about 9 minutes at concurrency 4).`,
			);
		}
		ok = runInLane("sandboxed", [
			"scripts/run-tests.mjs",
			"--lane",
			"sandboxed",
		]);
		// The fast tier leaves the namespaces lane to `npm test`.
		if (!fast) {
			ok =
				runInLane("namespaces", [
					"scripts/run-tests.mjs",
					"--lane",
					"namespaces",
				]) && ok;
		}
		process.exit(ok ? 0 : 1);
	}

	const targets = (selection.testFiles ?? []).filter(
		(file) => !EXCLUDED_TESTS.has(file),
	);
	if (targets.length === 0) {
		console.error("[test:related] no related test files; nothing to run.");
		return;
	}

	const namespaceTargets = targets.filter((file) => NAMESPACE_TESTS.has(file));
	const sandboxedTargets = targets.filter((file) => !NAMESPACE_TESTS.has(file));
	if (sandboxedTargets.length > 0) {
		ok = runInLane("sandboxed", [
			...NODE_TEST,
			`--test-concurrency=${rawConcurrency}`,
			...sandboxedTargets.map(testFileArgument),
		]);
	}
	if (namespaceTargets.length > 0) {
		ok =
			runInLane("namespaces", [
				...NODE_TEST,
				"--test-concurrency=1",
				...namespaceTargets,
			]) && ok;
	}
	process.exit(ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
	main();
}

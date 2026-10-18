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

const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const CLI_PATH = join(PACKAGE_ROOT, "scripts", "related-tests", "cli.ts");

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
	if (selection.kind === "FULL_SUITE") {
		if (fast) {
			console.error(
				`[test:fast] FULL_SUITE: ${selection.reason}. Running the full sandboxed lane (about 9 minutes at concurrency 4).`,
			);
			execFileSync("node", ["scripts/run-tests.mjs", "--lane", "sandboxed"], {
				cwd: PACKAGE_ROOT,
				stdio: "inherit",
				env: { ...process.env, TEST_CONCURRENCY: rawConcurrency },
			});
			return;
		}
		execFileSync("node", ["scripts/run-tests.mjs"], {
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
		});
		return;
	}

	if (!POSITIVE_INTEGER.test(rawConcurrency)) {
		console.error(
			`TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(rawConcurrency)}`,
		);
		process.exit(2);
	}

	const targets = selection.testFiles ?? [];
	if (targets.length === 0) {
		console.error("[test:related] no related test files; nothing to run.");
		return;
	}

	execFileSync(
		"node",
		[
			"--test",
			"--import",
			"tsx",
			`--test-concurrency=${rawConcurrency}`,
			"--test-timeout=120000",
			...targets.map(testFileArgument),
		],
		{
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
		},
	);
}

if (isMainModule(import.meta.url)) {
	main();
}

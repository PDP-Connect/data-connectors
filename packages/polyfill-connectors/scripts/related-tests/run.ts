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

function main(): void {
	const [baseRef] = process.argv.slice(2);
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
	if (selection.kind === "FULL_SUITE") {
		execFileSync("node", ["scripts/run-tests.mjs"], {
			cwd: PACKAGE_ROOT,
			stdio: "inherit",
		});
		return;
	}

	const rawConcurrency = process.env.TEST_CONCURRENCY ?? "2";
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

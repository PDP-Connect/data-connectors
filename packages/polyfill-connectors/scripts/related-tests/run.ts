#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `pnpm test:related <base-ref>` — runs `node --test` against the related
 * selection for local iteration only. See cli.ts's module comment for the
 * fail-closed contract and why this is not a merge gate.
 */

import { execFileSync, type SpawnOptions } from "node:child_process";
import { join } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	commandsFor,
	keyOf,
	partitionTests,
	runCommands,
} from "../../../../scripts/groupme-mutation/dispatch.mjs";
import { nativeFiles } from "../../../../scripts/groupme-mutation/vitest-files.mjs";
import {
	connectorsDir as CONNECTORS_ROOT,
	packageRoot as PACKAGE_ROOT,
} from "../../src/connector-paths.ts";

const CLI_PATH = join(PACKAGE_ROOT, "scripts", "related-tests", "cli.ts");

export function testFileArgument(testFile: string): string {
	if (testFile.startsWith("connectors/")) {
		return join(CONNECTORS_ROOT, testFile.slice("connectors/".length));
	}
	return testFile;
}

// Same dispatcher as the full suite: native GroupMe files run under Vitest once,
// every other selected file under node:test. A selection may omit native roster
// entries, so only the roster entries it actually selects are validated.
export async function relatedCommands(testFiles: string[]) {
	const selected = testFiles.map(testFileArgument);
	// Empty selection keeps its existing no-op policy; it is not ordinary discovery.
	if (selected.length === 0) return [];
	const selectedKeys = new Set(
		selected.map((file) => keyOf(file, PACKAGE_ROOT)),
	);
	const roster = nativeFiles.filter((key) => selectedKeys.has(key));
	return commandsFor(
		partitionTests(selected, roster, PACKAGE_ROOT),
		PACKAGE_ROOT,
	);
}

export async function runRelatedTests(
	testFiles: string[],
	options: SpawnOptions = {},
) {
	return runCommands(await relatedCommands(testFiles), options);
}

async function main(): Promise<void> {
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

	const targets = selection.testFiles ?? [];
	if (targets.length === 0) {
		console.error("[test:related] no related test files; nothing to run.");
		return;
	}

	const result = await runRelatedTests(targets);
	if (result.error) {
		console.error(result.error);
	}
	if (result.signal) {
		process.kill(process.pid, result.signal);
	} else {
		process.exitCode = result.code ?? 1;
	}
}

if (isMainModule(import.meta.url)) {
	main().catch((error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	});
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Full-inventory completion must come from `fullInventoryCoverage` with an
 * `enumerated(...)` proof: on a full-inventory stream, rows the source no
 * longer lists are read as deleted, and an array alone does not show the
 * list was whole. `buildFullScanCoverageMessage` claims full coverage from a
 * bare count, so new callers are refused. The connectors below called it
 * before this guard existed; each is known debt and leaves the list when it
 * moves to `fullInventoryCoverage`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { connectorsDir } from "./connector-paths.ts";

const KNOWN_UNPROVEN_CALLERS = new Set([
	"anthropic",
	"anthropic_live",
	"apple_contacts",
	"chase",
	"chatgpt",
	"gmail",
	"google_maps",
	"groupme",
	"jellyfin",
	"linkedin",
	"slack",
]);

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory())
			return name === "node_modules" || name === "fixtures"
				? []
				: sourceFiles(path);
		return name.endsWith(".ts") && !name.includes(".test.") ? [path] : [];
	});
}

test("no new connector claims full coverage without an enumeration proof", () => {
	const callers = new Set<string>();
	for (const connector of readdirSync(connectorsDir)) {
		const dir = join(connectorsDir, connector);
		if (!statSync(dir).isDirectory()) continue;
		for (const file of sourceFiles(dir))
			if (readFileSync(file, "utf8").includes("buildFullScanCoverageMessage("))
				callers.add(connector);
	}
	const unexpected = [...callers].filter(
		(connector) => !KNOWN_UNPROVEN_CALLERS.has(connector),
	);
	assert.deepEqual(
		unexpected,
		[],
		"use fullInventoryCoverage(stream, enumerated(items, evidence)) instead",
	);
	const retired = [...KNOWN_UNPROVEN_CALLERS].filter(
		(connector) => !callers.has(connector),
	);
	assert.deepEqual(
		retired,
		[],
		"remove connectors that no longer call buildFullScanCoverageMessage",
	);
});

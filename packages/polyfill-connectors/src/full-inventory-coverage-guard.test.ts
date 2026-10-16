// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Full-inventory completion must come from `fullInventoryCoverage` with an
 * `enumerated(...)` proof: on a full-inventory stream, rows the source no
 * longer lists are read as deleted, and an array alone does not show the
 * list was whole. The other ways to claim it — `buildFullScanCoverageMessage`
 * (under any alias) and a hand-built self DETAIL_COVERAGE — are frozen here
 * per file and per kind, counted by a syntax-aware scan
 * (`full-inventory-claim-scan.ts`). The baseline may only shrink: a new call
 * site fails, and a removed one must be removed from the baseline too.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { connectorsDir, repoRoot } from "./connector-paths.ts";
import {
	type ClaimCounts,
	scanFullInventoryClaims,
} from "./full-inventory-claim-scan.ts";

const BASELINE: Readonly<Record<string, ClaimCounts>> = {
	"connectors/amazon/index.ts": { full_scan: 0, self_coverage: 3 },
	"connectors/anthropic/index.ts": { full_scan: 4, self_coverage: 0 },
	"connectors/anthropic_live/index.ts": { full_scan: 2, self_coverage: 0 },
	"connectors/apple_contacts/index.ts": { full_scan: 1, self_coverage: 2 },
	"connectors/chase/index.ts": { full_scan: 1, self_coverage: 2 },
	"connectors/chatgpt/index.ts": { full_scan: 3, self_coverage: 2 },
	"connectors/doordash/index.ts": { full_scan: 0, self_coverage: 2 },
	"connectors/github/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/gmail/index.ts": { full_scan: 1, self_coverage: 2 },
	"connectors/google_calendar/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/google_contacts/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/google_maps/index.ts": { full_scan: 1, self_coverage: 2 },
	"connectors/google_maps_data_portability/index.ts": {
		full_scan: 0,
		self_coverage: 2,
	},
	"connectors/google_messages/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/groupme/index.ts": { full_scan: 4, self_coverage: 0 },
	"connectors/heb/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/jellyfin/index.ts": { full_scan: 1, self_coverage: 1 },
	"connectors/linkedin/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/meta/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/signal/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/slack/index.ts": { full_scan: 6, self_coverage: 2 },
	"connectors/spotify/index.ts": { full_scan: 0, self_coverage: 2 },
	"connectors/steam/index.ts": { full_scan: 0, self_coverage: 6 },
	"connectors/uber/index.ts": { full_scan: 0, self_coverage: 1 },
	"connectors/usaa/index.ts": { full_scan: 0, self_coverage: 5 },
	"connectors/venmo/index.ts": { full_scan: 0, self_coverage: 3 },
	"connectors/whatsapp/index.ts": { full_scan: 0, self_coverage: 3 },
	"connectors/ynab/index.ts": { full_scan: 0, self_coverage: 2 },
};

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

test("full-inventory claims outside fullInventoryCoverage only shrink", () => {
	const grown: string[] = [];
	const shrunk: string[] = [];
	const seen = new Set<string>();
	for (const file of sourceFiles(connectorsDir)) {
		const counts = scanFullInventoryClaims(readFileSync(file, "utf8"));
		if (counts.full_scan === 0 && counts.self_coverage === 0) continue;
		const path = relative(repoRoot, file);
		seen.add(path);
		const base = BASELINE[path] ?? { full_scan: 0, self_coverage: 0 };
		for (const kind of ["full_scan", "self_coverage"] as const) {
			if (counts[kind] > base[kind])
				grown.push(
					`${path} ${kind}: ${String(base[kind])} → ${String(counts[kind])}`,
				);
			else if (counts[kind] < base[kind])
				shrunk.push(
					`${path} ${kind}: ${String(base[kind])} → ${String(counts[kind])}`,
				);
		}
	}
	for (const path of Object.keys(BASELINE))
		if (!seen.has(path)) shrunk.push(`${path}: no claims left`);
	assert.deepEqual(
		grown,
		[],
		"use fullInventoryCoverage(stream, enumerated(items, evidence)) instead",
	);
	assert.deepEqual(shrunk, [], "lower the BASELINE to match (it only shrinks)");
});

const COUNT = (full_scan: number, self_coverage: number): ClaimCounts => ({
	full_scan,
	self_coverage,
});

const SCAN_CASES: ReadonlyArray<[string, string, ClaimCounts]> = [
	[
		"a plain call",
		'import { buildFullScanCoverageMessage } from "x";\nbuildFullScanCoverageMessage("a", 1);',
		COUNT(1, 0),
	],
	[
		"an import alias",
		'import { buildFullScanCoverageMessage as fullScan } from "x";\nfullScan("a", 1);',
		COUNT(1, 0),
	],
	[
		"whitespace and a newline before the parenthesis",
		'import { buildFullScanCoverageMessage } from "x";\nbuildFullScanCoverageMessage \n ("a", 1);',
		COUNT(1, 0),
	],
	[
		"a namespace member",
		'import * as runtime from "x";\nruntime.buildFullScanCoverageMessage("a", 1);',
		COUNT(1, 0),
	],
	[
		"a const re-binding",
		'import { buildFullScanCoverageMessage } from "x";\nconst claim = buildFullScanCoverageMessage;\nclaim("a", 1);',
		COUNT(1, 0),
	],
	[
		"a self coverage built with buildDetailCoverageMessage",
		'import { buildDetailCoverageMessage as d } from "x";\nd({ stream: s, stateStream: s, requiredKeys: [], hydratedKeys: [], considered: 1, covered: 1 });',
		COUNT(0, 1),
	],
	[
		"a self DETAIL_COVERAGE literal",
		'emit({ type: "DETAIL_COVERAGE", reference_only: true, stream: "a", state_stream: "a", required_keys: [], hydrated_keys: [] });',
		COUNT(0, 1),
	],
	[
		"a detail coverage for another checkpoint is not a self claim",
		'emit({ type: "DETAIL_COVERAGE", reference_only: true, stream: "details", state_stream: "parents", required_keys: [], hydrated_keys: [] });',
		COUNT(0, 0),
	],
	[
		"the name in a string or comment is not a call",
		'// buildFullScanCoverageMessage("a", 1)\nconst text = "buildFullScanCoverageMessage(";',
		COUNT(0, 0),
	],
	// review b360011 core#2: ordinary claims the first scanner missed.
	[
		"review b360011 core#2: a single-quoted self DETAIL_COVERAGE literal",
		"emit({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'items', state_stream: 'items', required_keys: [], hydrated_keys: [], considered: 1, covered: 1 });",
		COUNT(0, 1),
	],
	[
		"review b360011 core#2: a self claim through emitDetailCoverage",
		'import { emitDetailCoverage } from "x";\nemitDetailCoverage(ctx, { stream: s, stateStream: s, requiredKeys: [], hydratedKeys: [], considered: n, covered: n });',
		COUNT(0, 1),
	],
	[
		"review b360011 core#2: a namespace member re-bound to a const",
		'import * as runtime from "x";\nconst claim = runtime.buildFullScanCoverageMessage;\nclaim("a", 1);',
		COUNT(1, 0),
	],
	[
		"review b360011 core#2: a namespace emitDetailCoverage self claim",
		'import * as runtime from "x";\nruntime.emitDetailCoverage(ctx, { stream: "a", stateStream: "a", requiredKeys: [], hydratedKeys: [] });',
		COUNT(0, 1),
	],
];

test("review b360011 core#2: unparseable production source fails the scan instead of counting part of it", () => {
	assert.throws(
		() =>
			scanFullInventoryClaims(
				"const x = {\nbuildDetailCoverageMessage({ stream: s, stateStream: s",
			),
		/could not be parsed/,
	);
});

for (const [name, source, expected] of SCAN_CASES) {
	test(`full-inventory claim scan: ${name}`, () => {
		assert.deepEqual(scanFullInventoryClaims(source), expected);
	});
}

/** A synchronous scanner loop must not wedge the node:test process itself. */
function boundedScan(source: string): ReturnType<typeof spawnSync> {
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`import { scanFullInventoryClaims } from ${JSON.stringify(new URL("./full-inventory-claim-scan.ts", import.meta.url).href)};
try {
	console.log(JSON.stringify({ counts: scanFullInventoryClaims(${JSON.stringify(source)}) }));
} catch (error) {
	console.log(JSON.stringify({ error: String(error) }));
}`,
		],
		{ cwd: repoRoot, encoding: "utf8", timeout: 3000, killSignal: "SIGKILL" },
	);
}

test("review r4: cross-scope alias oscillation terminates with lexical counts", () => {
	const result = boundedScan(`
		import { buildFullScanCoverageMessage as full, buildDetailCoverageMessage as detail } from "x";
		const claim = full;
		function inner() {
			const claim = detail;
			claim({ stream: "items", stateStream: "items" });
		}
		claim("items", 1);
	`);
	assert.equal(result.error, undefined, "scanner must terminate within the subprocess deadline");
	assert.equal(result.status, 0, String(result.stderr));
	assert.deepEqual(JSON.parse(String(result.stdout)), { counts: COUNT(1, 1) });
});

test("review r4: a shadowed alias cycle fails closed within a bounded subprocess", () => {
	const result = boundedScan(`
		import { buildFullScanCoverageMessage as left, buildDetailCoverageMessage as right } from "x";
		function inner() {
			const left = right;
			const right = left;
			left("items", 1);
		}
	`);
	assert.equal(result.error, undefined, "cycle detection must terminate within the subprocess deadline");
	assert.equal(result.status, 0, String(result.stderr));
	assert.match(JSON.parse(String(result.stdout)).error ?? "", /alias cycle/);
});

test("review r4: alias chains resolve in their declaration scope", () => {
	assert.deepEqual(scanFullInventoryClaims(`
		import { buildFullScanCoverageMessage as full } from "x";
		const first = full;
		const second = first;
		function inner() {
			const full = () => {};
			second("items", 1);
		}
	`), COUNT(1, 0));
});

test("review r4: parameters and local namespace bindings shadow imported helpers", () => {
	assert.deepEqual(scanFullInventoryClaims(`
		import { buildFullScanCoverageMessage as claim } from "x";
		import * as runtime from "x";
		function inner(claim: unknown, runtime: unknown) {
			claim("items", 1);
			runtime.buildFullScanCoverageMessage("items", 1);
		}
		claim("items", 1);
		runtime.buildFullScanCoverageMessage("items", 1);
	`), COUNT(2, 0));
});

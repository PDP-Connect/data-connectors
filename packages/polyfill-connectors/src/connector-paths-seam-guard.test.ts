// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fleet-wide build-time guardrail: no file outside `connector-paths.ts`
 * computes a `manifests/` or `connectors/` filesystem path itself.
 *
 * `connector-paths.ts` is the one sanctioned place that knows this
 * package's connector/manifest layout during the parallel-layout phase of
 * the connector cutover (see docs/migration/connector-cutover/CONTRACTS.md
 * — "Layout during the parallel phase"). A file that re-derives
 * `import.meta.url`/`__dirname` math instead of importing from the seam
 * defeats the point: the later layout move (to root `connectors/<key>/`)
 * would need to hand-edit every such file instead of the one module.
 *
 * This is a static source scan, not a lint rule, because the pattern is a
 * handful of distinct syntactic shapes (`PACKAGE_ROOT = dirname(...)`,
 * `join(PACKAGE_ROOT, "connectors", ...)`, `new URL("../manifests/x.json",
 * import.meta.url)`, `resolve(__dirname, "..", "..")`, etc.) rather than one
 * AST pattern a lint rule could target cheaply.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { connectorsDir, packageRoot, repoRoot } from "./connector-paths.ts";

/**
 * Files allowed to contain a manifests/connectors path literal without
 * routing through the seam, each with a reviewed reason:
 *
 *   - connector-paths.ts itself: it IS the seam.
 *   - local-source-bounded-read-guard.ts: its `root` parameter is a real
 *     testability seam (findUnapprovedBoundedReads({ root })), not a
 *     hardcoded package path; only its DEFAULT resolves through
 *     connector-paths.ts's packageRoot.
 *   - scripts/related-tests/graph.ts and select.test.ts: the matched text is
 *     a STRING LITERAL inside a comment/test fixture describing the exact
 *     `new URL("../../manifests/x.json", import.meta.url)` shape the
 *     import-scanner must recognize and reject as a non-dependency-edge —
 *     it is not a real path computation.
 *   - connector-options-schema.test.ts: the matched text is the env var name
 *     `PDPP_POLYFILL_MANIFESTS_DIR` (an override manifest-registry.ts
 *     reads), not a `MANIFESTS_DIR` path constant.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
	"src/connector-paths.ts",
	"src/local-source-bounded-read-guard.ts",
	"scripts/related-tests/graph.ts",
	"scripts/related-tests/select.test.ts",
	"src/connector-options-schema.test.ts",
]);

/** Declaration-shape patterns: a local PACKAGE_ROOT/CONNECTORS_DIR/etc constant computed from this file's own location. */
const DECLARATION_PATTERNS: readonly RegExp[] = [
	/\b(PACKAGE_ROOT|PKG_ROOT|CONNECTORS_DIR|MANIFESTS?_DIR)\s*=\s*(dirname|join|resolve|fileURLToPath)\(/,
];

/** `new URL("../manifests/x.json"|"../connectors/x", import.meta.url)` — the URL-relative shape. */
const NEW_URL_PATTERN = /new URL\([^)]*["'](\.\.\/)+(?:manifests|connectors)\//;

function findViolations(filePath: string, source: string): string[] {
	const violations: string[] = [];
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();
		if (
			trimmed.startsWith("//") ||
			trimmed.startsWith("*") ||
			trimmed.startsWith("/**")
		) {
			continue;
		}
		for (const pattern of DECLARATION_PATTERNS) {
			if (pattern.test(line)) {
				violations.push(`${filePath}:${i + 1}: ${trimmed}`);
			}
		}
		if (NEW_URL_PATTERN.test(line)) {
			violations.push(`${filePath}:${i + 1}: ${trimmed}`);
		}
	}
	return violations;
}

function listTsFiles(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = statSync(full);
		if (stat.isDirectory()) {
			if (entry === "node_modules" || entry === "generated") {
				continue;
			}
			listTsFiles(full, out);
			continue;
		}
		if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			out.push(full);
		}
	}
}

test("no file outside connector-paths.ts computes a manifests/ or connectors/ path itself", () => {
	const roots = ["bin", "connectors", "scripts", "src"].map((r) =>
		join(packageRoot, r),
	);
	const files: string[] = [];
	for (const root of roots) {
		listTsFiles(root, files);
	}

	const violations: string[] = [];
	for (const file of files) {
		const relPath = relative(packageRoot, file);
		if (ALLOWLIST.has(relPath)) {
			continue;
		}
		const source = readFileSync(file, "utf8");
		violations.push(...findViolations(relPath, source));
	}

	assert.deepEqual(
		violations,
		[],
		`file(s) compute a manifests/connectors path outside connector-paths.ts:\n${violations.join("\n")}\n` +
			"Route through connectorDir/connectorEntrypoint/manifestPath/manifestsDir/connectorsDir " +
			"from ./connector-paths.ts instead, or add a reviewed entry to this test's ALLOWLIST.",
	);
});

test("the seam module itself resolves the real, current-layout directories", () => {
	assert.ok(connectorsDir.startsWith(packageRoot));
	assert.ok(packageRoot.startsWith(repoRoot));
});

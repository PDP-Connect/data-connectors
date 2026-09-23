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
 * import.meta.url)`, `resolve(__dirname, "..", "..")`, `path.resolve(...)`,
 * etc.) rather than one AST pattern a lint rule could target cheaply. The
 * scan runs over each file's full text (not line-by-line) so a call spread
 * across multiple lines — e.g.
 *   const MANIFEST_PATH = join(
 *       HERE, "..", "..", "manifests", "strava.json",
 *   );
 * — is still caught; an earlier line-oriented version of this guard missed
 * exactly this shape in three real files (manifest-registry.ts,
 * connectors/strava/schemas.test.ts, connectors/chase/integration.test.ts)
 * before it was widened.
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
 *   - scripts/related-tests/cli.test.ts: `repoRoot` there is a function
 *     parameter naming a throwaway `mkdtemp`'d scratch git repository this
 *     test creates and tears down (`initRepo(repoRoot)` /
 *     `git(repoRoot, ...)`), and the `connectors/acme/...` paths under it are
 *     synthetic fixture content for that scratch repo — not this package's
 *     real `connectors/` directory. It shadows the seam's own `repoRoot`
 *     export by name only.
 *   - connector-paths-seam-guard.test.ts (this file): its own docstring and
 *     ALLOWLIST-comment prose describe the patterns being matched, and its
 *     second test asserts the seam's real exports resolve under the real
 *     root — both are expected to contain the literal words this guard
 *     looks for.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([
	"src/connector-paths.ts",
	"src/local-source-bounded-read-guard.ts",
	"scripts/related-tests/graph.ts",
	"scripts/related-tests/select.test.ts",
	"src/connector-options-schema.test.ts",
	"scripts/related-tests/cli.test.ts",
	"src/connector-paths-seam-guard.test.ts",
]);

/** Strip `//` and `/* ... *‍/` comments so allowlisted prose describing these shapes doesn't self-trip the scan. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => {
			const idx = line.indexOf("//");
			return idx === -1 ? line : line.slice(0, idx);
		})
		.join("\n");
}

/**
 * A `join(...)`/`resolve(...)` (bare or `path.`-qualified) call, possibly
 * spanning multiple lines, whose arguments contain a `"manifests"` or
 * `"connectors"` string segment together with a path-origin token
 * (`__dirname`, `import.meta.dirname`/`.url`, `packageDir`, `packageRoot`,
 * `PACKAGE_ROOT`, `PKG_ROOT`, `repoRoot`, or a `HERE`-named local).
 */
const CALL_RE = /\b(?:path\.)?(join|resolve)\(([^;]*?)\)/gs;
// A quoted string whose path segments include `manifests` or `connectors`:
// the bare word ("manifests") and relative strings ("../../manifests/x.json").
const CALL_HAS_LAYOUT_SEGMENT =
	/["'`](?:[^"'`\n]*\/)?(manifests|connectors)(?:\/[^"'`\n]*)?["'`]/;
const CALL_HAS_PATH_ORIGIN =
	/__dirname|import\.meta\.(dirname|url)|packageDir|packageRoot|PACKAGE_ROOT|PKG_ROOT|repoRoot|\bHERE\b/;

/** A local `PACKAGE_ROOT`/`CONNECTORS_DIR`/etc constant computed from this file's own location. */
const DECLARATION_PATTERN =
	/\b(PACKAGE_ROOT|PKG_ROOT|CONNECTORS_DIR|MANIFESTS?_DIR)\s*=\s*(?:path\.)?(dirname|join|resolve|fileURLToPath)\(/;

/** `new URL("../manifests/x.json"|"../connectors/x", import.meta.url)`, on one line or spread across several. */
const NEW_URL_PATTERN =
	/new URL\([^)]*?["'](?:\.\.\/)+(?:manifests|connectors)\//s;

function findViolations(filePath: string, rawSource: string): string[] {
	const source = stripComments(rawSource);
	const violations: string[] = [];
	const seenIndices = new Set<number>();

	const record = (index: number, label: string): void => {
		if (seenIndices.has(index)) {
			return;
		}
		seenIndices.add(index);
		const lineNo = source.slice(0, index).split("\n").length;
		const line = source.split("\n")[lineNo - 1]?.trim() ?? "";
		violations.push(`${filePath}:${lineNo}: [${label}] ${line}`);
	};

	CALL_RE.lastIndex = 0;
	for (
		let match = CALL_RE.exec(source);
		match !== null;
		match = CALL_RE.exec(source)
	) {
		const args = match[2] ?? "";
		if (CALL_HAS_LAYOUT_SEGMENT.test(args) && CALL_HAS_PATH_ORIGIN.test(args)) {
			record(match.index, "join/resolve+manifests-or-connectors");
		}
	}

	for (const line of source.split("\n")) {
		if (DECLARATION_PATTERN.test(line)) {
			const index = source.indexOf(line);
			record(index, "declaration");
		}
	}

	NEW_URL_PATTERN.lastIndex = 0;
	const newUrlMatch = NEW_URL_PATTERN.exec(source);
	if (newUrlMatch) {
		record(newUrlMatch.index, "new-url-relative");
	}

	violations.sort();
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
	const roots = [
		...["bin", "scripts", "src"].map((r) => join(packageRoot, r)),
		connectorsDir,
	];
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
	assert.equal(connectorsDir, join(repoRoot, "connectors"));
	assert.ok(packageRoot.startsWith(repoRoot));
});

test("the guard detects relative layout strings joined to a file-location origin", () => {
	const singleLine =
		'const p = join(import.meta.dirname, "../../manifests/codex.json");\n';
	const multiLine =
		'const p = join(\n\timport.meta.dirname,\n\t"../../manifests/claude_code.json",\n);\n';
	const bareWord = 'const p = join(packageRoot, "connectors", key);\n';
	const seamCall = 'const p = manifestPath("codex");\n';
	assert.ok(
		findViolations("synthetic-single.ts", singleLine).length > 0,
		"single-line relative string",
	);
	assert.ok(
		findViolations("synthetic-multi.ts", multiLine).length > 0,
		"multi-line relative string",
	);
	assert.ok(
		findViolations("synthetic-bare.ts", bareWord).length > 0,
		"bare layout segment",
	);
	assert.deepEqual(
		findViolations("synthetic-seam.ts", seamCall),
		[],
		"a seam call is not a violation",
	);
});

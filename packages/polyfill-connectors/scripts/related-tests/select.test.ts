// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the acceptance criteria for the related-test selector directly
 * against real fixture package trees and a real graph build — not mocked
 * graphs — because the entire point of this selector is that a mocked graph
 * cannot demonstrate what a REAL import scan actually sees (or fails to
 * see). Each fixture tree under `src/test-fixtures/related-tests/` is a
 * minimal, self-contained package shape built to exercise exactly one
 * acceptance scenario.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	containsDynamicImportOrRequire,
	isFixturePath,
} from "./fallback-inventory.ts";
import {
	assertGraphIsTrustworthy,
	buildDependencyGraph,
	scanImports,
	UntrustworthyGraphError,
} from "./graph.ts";
import { FULL_SUITE, selectRelatedTests } from "./select.ts";
import { writeFixtureTree } from "./test/write-fixture-tree.ts";

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = join(THIS_DIR, "test", "fixture-trees");

describe("selectRelatedTests: direct connector edit selects only its related tests", () => {
	let packageRoot: string;

	before(() => {
		packageRoot = mkdtempSync(join(tmpdir(), "related-tests-direct-"));
		writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "direct-edit"));
	});

	after(() => {
		rmSync(packageRoot, { recursive: true, force: true });
	});

	test("changing connectors/alpha/index.ts selects only alpha's own test, not beta's", async () => {
		const allPaths = [
			"connectors/alpha/index.ts",
			"connectors/alpha/index.test.ts",
			"connectors/beta/index.ts",
			"connectors/beta/index.test.ts",
		];
		const graph = await buildDependencyGraph(packageRoot);
		const result = selectRelatedTests({
			packageRoot,
			graph,
			allRelativePaths: allPaths,
			changedRelativePaths: ["connectors/alpha/index.ts"],
			deletedRelativePaths: [],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, "related");
		assert.deepEqual(result.testFiles, ["connectors/alpha/index.test.ts"]);
	});
});

describe("selectRelatedTests: shared runtime edit expands to every dependent connector's tests", () => {
	let packageRoot: string;

	before(() => {
		packageRoot = mkdtempSync(join(tmpdir(), "related-tests-shared-"));
		writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "shared-runtime"));
	});

	after(() => {
		rmSync(packageRoot, { recursive: true, force: true });
	});

	test("changing src/shared-runtime.ts selects both alpha's and beta's tests", async () => {
		const allPaths = [
			"src/shared-runtime.ts",
			"connectors/alpha/index.ts",
			"connectors/alpha/index.test.ts",
			"connectors/beta/index.ts",
			"connectors/beta/index.test.ts",
		];
		const graph = await buildDependencyGraph(packageRoot);
		const result = selectRelatedTests({
			packageRoot,
			graph,
			allRelativePaths: allPaths,
			changedRelativePaths: ["src/shared-runtime.ts"],
			deletedRelativePaths: [],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, "related");
		assert.deepEqual([...(result.testFiles ?? [])].sort(), [
			"connectors/alpha/index.test.ts",
			"connectors/beta/index.test.ts",
		]);
	});
});

describe("selectRelatedTests: fixture-only change forces the full suite", () => {
	test("a change under fixtures/ never resolves to a narrow selection, even if no source imports the changed path", () => {
		const packageRoot = mkdtempSync(
			join(tmpdir(), "related-tests-fixture-gate-"),
		);
		try {
			writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "direct-edit"));
			const allPaths = [
				"fixtures/alpha/sample.json",
				"connectors/alpha/index.ts",
				"connectors/alpha/index.test.ts",
			];
			// No graph needed for this assertion: isFixturePath must gate BEFORE any
			// graph lookup happens, so an empty graph proves the gate is unconditional.
			const result = selectRelatedTests({
				packageRoot,
				graph: { modules: new Map() },
				allRelativePaths: allPaths,
				changedRelativePaths: ["fixtures/alpha/sample.json"],
				deletedRelativePaths: [],
				unmergedRelativePaths: [],
			});

			assert.equal(result.kind, FULL_SUITE);
			assert.match(result.reason, /fixtures directory/);
		} finally {
			rmSync(packageRoot, { recursive: true, force: true });
		}
	});

	test("isFixturePath recognizes both fixtures/ and __fixtures__/ path segments", () => {
		assert.equal(isFixturePath("fixtures/alpha/sample.json"), true);
		assert.equal(isFixturePath("connectors/x/__fixtures__/data.js"), true);
		assert.equal(
			isFixturePath("connectors/x/fixtures.ts"),
			false,
			"a file literally named fixtures.ts is not itself under a fixtures/ directory",
		);
		assert.equal(isFixturePath("src/normal-file.ts"), false);
	});
});

describe("selectRelatedTests: a file containing a dynamic import forces the full suite", () => {
	test("changing a file whose own source contains await import(...) forces FULL_SUITE even if the graph resolves it as a leaf", async () => {
		const packageRoot = mkdtempSync(join(tmpdir(), "related-tests-dynamic-"));
		try {
			writeFixtureTree(packageRoot, join(FIXTURES_ROOT, "dynamic-import"));
			const allPaths = ["src/dynamic-loader.ts", "src/dynamic-loader.test.ts"];
			const graph = await buildDependencyGraph(packageRoot);

			const result = selectRelatedTests({
				packageRoot,
				graph,
				allRelativePaths: allPaths,
				changedRelativePaths: ["src/dynamic-loader.ts"],
				deletedRelativePaths: [],
				unmergedRelativePaths: [],
			});

			assert.equal(result.kind, FULL_SUITE);
			assert.match(result.reason, /dynamic import/);
		} finally {
			rmSync(packageRoot, { recursive: true, force: true });
		}
	});

	test("containsDynamicImportOrRequire catches await import(, require(, and a computed-specifier call the graph itself cannot resolve", () => {
		assert.equal(
			containsDynamicImportOrRequire('const x = await import("./mod.ts");'),
			true,
		);
		assert.equal(
			containsDynamicImportOrRequire('const x = require("node:fs");'),
			true,
		);
		assert.equal(
			containsDynamicImportOrRequire(
				'const x = await import(moduleSpecifier(dir, "server/index.ts"));',
			),
			true,
		);
		assert.equal(
			containsDynamicImportOrRequire('import { readFileSync } from "node:fs";'),
			false,
			"a static ES import must not trip the dynamic-import fallback",
		);
	});
});

describe("selectRelatedTests: unknown/unparseable dependency shapes force the full suite", () => {
	test("a changed .ts file absent from the dependency graph (e.g. a source the scan could not read) forces FULL_SUITE", () => {
		const packageRoot = mkdtempSync(
			join(tmpdir(), "related-tests-unparseable-"),
		);
		try {
			mkdirSync(join(packageRoot, "src"), { recursive: true });
			writeFileSync(
				join(packageRoot, "src", "unparseable.ts"),
				"export function ok(): string { return 'ok'; }\n",
			);
			const allPaths = ["src/unparseable.ts"];
			const result = selectRelatedTests({
				packageRoot,
				graph: { modules: new Map() },
				allRelativePaths: allPaths,
				changedRelativePaths: ["src/unparseable.ts"],
				deletedRelativePaths: [],
				unmergedRelativePaths: [],
			});

			assert.equal(result.kind, FULL_SUITE);
			assert.match(result.reason, /absent from the dependency graph/);
		} finally {
			rmSync(packageRoot, { recursive: true, force: true });
		}
	});

	test("a non-.ts changed file (e.g. package.json, tsconfig.json) forces FULL_SUITE rather than being silently ignored", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: ["package.json"],
			deletedRelativePaths: [],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, FULL_SUITE);
		assert.match(result.reason, /not a \.ts source file/);
	});
});

describe("selectRelatedTests: deletions and renames force the full suite", () => {
	test("a deleted source file forces FULL_SUITE even though it can no longer appear in changedRelativePaths", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: [],
			deletedRelativePaths: ["src/manifest-registry.ts"],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, FULL_SUITE);
		assert.match(result.reason, /deleted path/);
	});

	test("a deleted test file forces FULL_SUITE, not a silent empty selection", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: [],
			deletedRelativePaths: ["connectors/alpha/index.test.ts"],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, FULL_SUITE);
		assert.match(result.reason, /deleted path/);
	});

	test("a deleted fixture file forces FULL_SUITE via the same deletion gate, not the fixture-path gate", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: [],
			deletedRelativePaths: ["fixtures/alpha/sample.json"],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, FULL_SUITE);
		assert.match(result.reason, /deleted path/);
	});

	test("a rename (git-reported as delete-of-old-path plus add-of-new-path) forces FULL_SUITE via the deletion gate", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: ["connectors/alpha/index-renamed.ts"],
			deletedRelativePaths: ["connectors/alpha/index.ts"],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, FULL_SUITE);
		assert.match(result.reason, /deleted path/);
	});

	test("a truly empty diff (no changes, no deletions) still selects an empty related set, not FULL_SUITE", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: [],
			deletedRelativePaths: [],
			unmergedRelativePaths: [],
		});

		assert.equal(result.kind, "related");
		assert.deepEqual(result.testFiles, []);
		assert.match(result.reason, /no changed files/);
	});

	test("an unresolved index/worktree entry forces FULL_SUITE before empty selection", () => {
		const result = selectRelatedTests({
			packageRoot: "/unused",
			graph: { modules: new Map() },
			allRelativePaths: [],
			changedRelativePaths: [],
			deletedRelativePaths: [],
			unmergedRelativePaths: ["connectors/alpha/index.ts"],
		});

		assert.equal(result.kind, FULL_SUITE);
		assert.match(result.reason, /unmerged path/);
	});
});

describe("scanImports: the token scan reads real specifiers and nothing else", () => {
	test("reads every static import/export form, and only the specifier", () => {
		const scanned = scanImports(
			[
				'import { a } from "./alpha.ts";',
				'import type { T } from "./types.ts";',
				'export { b } from "./beta.ts";',
				'export * from "./gamma.ts";',
				'import "./side-effect.ts";',
				'import def from "some-package";',
				'const notAnImport = "./just-a-string.ts";',
			].join("\n"),
		);

		assert.deepEqual(
			scanned?.map((entry) => entry.specifier),
			[
				"./alpha.ts",
				"./types.ts",
				"./beta.ts",
				"./gamma.ts",
				"./side-effect.ts",
				"some-package",
			],
			"a bare string literal in value position must never be read as a specifier",
		);
	});

	test("only import()/require() calls produce a dynamic edge, not every one-string call", () => {
		// The concrete false positive this pins: `new URL("../../x.json",
		// import.meta.url)` in connectors/github/setup-scopes.test.ts resolves to
		// a real file, so treating any `("...")` as a module load fabricated an
		// edge that made an unrelated test look related to parsers.ts.
		const scanned = scanImports(
			[
				'const dynamic = await import("./dyn.ts");',
				'const required = require("./req.ts");',
				'const url = new URL("../../manifests/github.json", import.meta.url);',
				'const read = readFileSync("./data.json");',
			].join("\n"),
		);

		assert.deepEqual(
			scanned?.filter((entry) => entry.dynamic).map((e) => e.specifier),
			["./dyn.ts", "./req.ts"],
		);
		assert.equal(
			scanned?.some((entry) => entry.specifier.endsWith("github.json")),
			false,
			"new URL(...) must not be read as a module load",
		);
	});

	test("a regex literal containing '/' and '@' does not derail the scan", () => {
		// Verified against src/scrub-defaults.ts: without reScanSlashToken the
		// scanner wedges inside this pattern and silently loses later imports.
		const scanned = scanImports(
			[
				'import { first } from "./first.ts";',
				"const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;",
				'import { second } from "./second.ts";',
			].join("\n"),
		);

		assert.deepEqual(
			scanned?.map((entry) => entry.specifier),
			["./first.ts", "./second.ts"],
		);
	});

	test("a template literal containing '#' does not derail the scan", () => {
		// Verified against bin/reconcile-manifests.ts and
		// connectors/amazon/parsers.test.ts: without reScanTemplateToken the
		// scanner wedges on the '#' and loses every later import.
		const scanned = scanImports(
			[
				'import { first } from "./first.ts";',
				"const heading = `# ${name} — manifest`;",
				'const html = `<span class="a-text-caps">Order #</span>`;',
				'import { second } from "./second.ts";',
			].join("\n"),
		);

		assert.deepEqual(
			scanned?.map((entry) => entry.specifier),
			["./first.ts", "./second.ts"],
		);
	});
});

describe("buildDependencyGraph: fails closed when the TypeScript resolution is untrustworthy", () => {
	test("assertGraphIsTrustworthy rejects a graph whose environment reports .ts as unavailable, rather than returning a truncated graph silently", () => {
		// The graph must fail closed rather than return a silently truncated
		// module set, because under-selection is invisible: the suite goes
		// green having skipped the tests that mattered. The historical case
		// was dependency-cruiser 18.2.0 dropping from 751 modules to 5, with
		// no thrown error and no stderr, whenever the only resolvable
		// `typescript` was outside its supported range. That dependency is
		// gone, but the fail-closed contract it forced is kept: an empty scan
		// of a non-empty package still throws. The trustworthy path is
		// exercised for real by every other describe block above, each of
		// which builds a real graph from a real fixture tree.
		assert.throws(
			() =>
				assertGraphIsTrustworthy({
					extensionsFound: [{ extension: ".ts", available: false }],
				}),
			UntrustworthyGraphError,
		);
		assert.throws(
			() =>
				assertGraphIsTrustworthy({
					extensionsFound: [{ extension: ".ts", available: true }],
					issues: [{ severity: "warn", name: "missing-typescript-transpiler" }],
				}),
			UntrustworthyGraphError,
		);
		assert.doesNotThrow(() =>
			assertGraphIsTrustworthy({
				extensionsFound: [{ extension: ".ts", available: true }],
			}),
		);
	});
});

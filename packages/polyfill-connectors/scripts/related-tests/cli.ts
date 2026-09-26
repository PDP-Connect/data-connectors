#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `related-tests <base-ref>` — a fast LOCAL probe that narrows `node --test`
 * to the test files related to what changed since `<base-ref>`, or prints
 * the full-suite sentinel when it cannot trust a narrower answer.
 *
 * This is additive tooling layered on top of the existing accounted suite
 * (`test-accounting.manifest.json`'s `polyfill-connectors` entry), not a
 * replacement for it. Per docs/reference/testing-policy.md: "An
 * affected-test selector may become the fast PR lane only after it runs in
 * shadow against complete suites and demonstrates an acceptable miss rate."
 * This script has not run that shadow period — it is for local iteration
 * only. The accounted full suite remains the merge-required gate.
 *
 * Usage:
 *   node --import tsx scripts/related-tests/cli.ts <base-ref> [--json]
 *
 * Exit code is always 0 on a successful classification (including
 * FULL_SUITE) — FULL_SUITE is not a script failure, it is the honest
 * fail-closed answer. Exit code 1 means the script itself could not
 * complete (git failure, graph build failure surfaced as an error the
 * caller must notice, etc.) — callers MUST treat exit 1 the same as
 * FULL_SUITE (run everything), never as "skip tests".
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isMainModule } from "@pdpp/connector-protocol";
import {
	connectorsDir as CONNECTORS_ROOT,
	packageRoot as PACKAGE_ROOT,
} from "../../src/connector-paths.ts";
import { buildDependencyGraph, UntrustworthyGraphError } from "./graph.ts";
import { FULL_SUITE, selectRelatedTests } from "./select.ts";

const PACKAGE_SOURCE_ROOTS = ["bin", "src"];
const CONNECTORS_LABEL = "connectors";

function listAllTsFiles(
	root: string,
	dir: string,
	labelRoot: string,
	out: string[],
): void {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules") {
			continue;
		}
		const fullPath = join(dir, entry);
		const stat = statSync(fullPath);
		if (stat.isDirectory()) {
			listAllTsFiles(root, fullPath, labelRoot, out);
		} else if (entry.endsWith(".ts")) {
			out.push(join(labelRoot, relative(root, fullPath)));
		}
	}
}

/**
 * Package-relative paths reported by a git diff filtered to a single set of
 * `--diff-filter` letters, restricted to this package's own subtree.
 *
 * `args` must request NUL-terminated output (git's `-z` flag) rather than
 * newline-terminated output: by default git quotes and escapes any path
 * containing non-ASCII bytes or other "unusual" characters (e.g.
 * `café.ts` becomes `"caf\303\251.ts"`), and a plain line-based split would
 * silently fail to match such a quoted line against the raw `packagePrefix`
 * string, dropping the file from the result entirely — an add/modify that
 * disappears is exactly the kind of silent under-reporting this selector
 * must never produce. `-z` disables path quoting unconditionally regardless
 * of `core.quotepath`.
 */
function diffPathsInPackage(
	packageRoot: string,
	args: readonly string[],
	{ cwd = packageRoot }: { readonly cwd?: string } = {},
): string[] {
	const repoRoot = gitRoot(packageRoot);
	const output = execFileSync("git", [...args], {
		cwd,
		encoding: "utf8",
	});
	const packagePrefix = relative(repoRoot, packageRoot);
	const requiredPrefix = packagePrefix === "" ? "" : `${packagePrefix}/`;
	const paths = new Set<string>();
	for (const entry of output.split("\0")) {
		if (entry.length > 0 && entry.startsWith(requiredPrefix)) {
			paths.add(relative(packagePrefix, entry));
		} else if (entry.length > 0 && entry.startsWith(`${CONNECTORS_LABEL}/`)) {
			paths.add(entry);
		}
	}
	return [...paths];
}

export interface ChangedAndDeleted {
	readonly changedRelativePaths: string[];
	readonly deletedRelativePaths: string[];
	/** Package-relative paths reported by Git's cached or working-tree U diff. */
	readonly unmergedRelativePaths: string[];
}

/**
 * Changed files = committed divergence from `baseRef` (merge-base diff, so a
 * feature branch's own history is compared against where it forked, not
 * against wherever `baseRef` has since moved) UNION uncommitted working-tree
 * changes (staged + unstaged). The union matters for local iteration: a
 * developer editing a file has not committed it yet, and this selector's
 * whole purpose is fast local feedback on exactly that in-progress edit.
 *
 * Deletions are tracked separately from `--diff-filter=ACMT` changes: `D`
 * (Deleted) is deliberately excluded from that filter because a deleted path
 * can never be looked up in the dependency graph. Every diff query below
 * passes `--no-renames`: git's own rename detection (`-M`, unconditional,
 * NOT controlled by the `diff.renames` config key — that key only affects
 * `log`/`show`-family rename *following*) would otherwise collapse a rename
 * into a single `R`-classified entry naming only the new path, silently
 * dropping the old path from both this query and the deletion query below.
 * `--no-renames` forces git to always report a rename as a plain
 * delete-of-old-path + add-of-new-path pair, so it is covered by the
 * deleted-paths query with no separate handling.
 */
export function getChangedFiles(
	packageRoot: string,
	baseRef: string,
): ChangedAndDeleted {
	const repoRoot = gitRoot(packageRoot);
	const changedRelativePaths = new Set<string>();
	for (const path of [
		...diffPathsInPackage(packageRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--diff-filter=ACMT",
			`${baseRef}...HEAD`,
		]),
		...diffPathsInPackage(packageRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--diff-filter=ACMT",
			"HEAD",
		]),
		...diffPathsInPackage(
			packageRoot,
			["ls-files", "-z", "--others", "--exclude-standard"],
			{ cwd: repoRoot },
		),
	]) {
		changedRelativePaths.add(path);
	}

	const deletedRelativePaths = new Set<string>();
	for (const path of [
		...diffPathsInPackage(packageRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--diff-filter=D",
			`${baseRef}...HEAD`,
		]),
		...diffPathsInPackage(packageRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--diff-filter=D",
			"HEAD",
		]),
	]) {
		deletedRelativePaths.add(path);
	}

	const unmergedRelativePaths = new Set<string>();
	for (const path of [
		...diffPathsInPackage(packageRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--diff-filter=U",
			"--cached",
		]),
		...diffPathsInPackage(packageRoot, [
			"diff",
			"--no-renames",
			"--name-only",
			"-z",
			"--diff-filter=U",
		]),
	]) {
		unmergedRelativePaths.add(path);
	}

	return {
		changedRelativePaths: [...changedRelativePaths],
		deletedRelativePaths: [...deletedRelativePaths],
		unmergedRelativePaths: [...unmergedRelativePaths],
	};
}

function gitRoot(packageRoot: string): string {
	return execFileSync("git", ["rev-parse", "--show-toplevel"], {
		cwd: packageRoot,
		encoding: "utf8",
	}).trim();
}

function main(): void {
	const [baseRef, ...rest] = process.argv.slice(2);
	const asJson = rest.includes("--json");

	if (!baseRef) {
		console.error(
			"usage: node --import tsx scripts/related-tests/cli.ts <base-ref> [--json]",
		);
		process.exit(1);
	}

	let changedRelativePaths: string[];
	let deletedRelativePaths: string[];
	let unmergedRelativePaths: string[];
	try {
		({ changedRelativePaths, deletedRelativePaths, unmergedRelativePaths } =
			getChangedFiles(PACKAGE_ROOT, baseRef));
	} catch (error) {
		console.error(
			`[related-tests] failed to compute changed files via git: ${(error as Error).message}`,
		);
		console.error(
			"[related-tests] treat this as FULL_SUITE — do not skip tests.",
		);
		process.exit(1);
	}

	const allRelativePaths: string[] = [];
	for (const root of PACKAGE_SOURCE_ROOTS) {
		const sourceRoot = join(PACKAGE_ROOT, root);
		listAllTsFiles(sourceRoot, sourceRoot, root, allRelativePaths);
	}
	if (existsSync(CONNECTORS_ROOT)) {
		listAllTsFiles(
			CONNECTORS_ROOT,
			CONNECTORS_ROOT,
			CONNECTORS_LABEL,
			allRelativePaths,
		);
	}

	buildDependencyGraph(PACKAGE_ROOT)
		.then((graph) => {
			const result = selectRelatedTests({
				packageRoot: PACKAGE_ROOT,
				graph,
				allRelativePaths,
				changedRelativePaths,
				deletedRelativePaths,
				unmergedRelativePaths,
			});
			emit(result, asJson);
		})
		.catch((error: unknown) => {
			if (error instanceof UntrustworthyGraphError) {
				emit({ kind: FULL_SUITE, reason: error.message }, asJson);
				return;
			}
			console.error(
				`[related-tests] unexpected failure building the dependency graph: ${(error as Error).message}`,
			);
			console.error(
				"[related-tests] treat this as FULL_SUITE — do not skip tests.",
			);
			process.exit(1);
		});
}

function emit(
	result: { kind: string; testFiles?: readonly string[]; reason: string },
	asJson: boolean,
): void {
	if (asJson) {
		console.log(JSON.stringify(result));
		return;
	}
	if (result.kind === FULL_SUITE) {
		console.error(`[related-tests] FULL_SUITE: ${result.reason}`);
		console.log(FULL_SUITE);
		return;
	}
	console.error(`[related-tests] related: ${result.reason}`);
	for (const testFile of result.testFiles ?? []) {
		console.log(testFile);
	}
}

if (isMainModule(import.meta.url)) {
	main();
}

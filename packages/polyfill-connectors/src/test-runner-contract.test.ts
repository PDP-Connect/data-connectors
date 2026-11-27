// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import { testCommands } from "../scripts/test-dispatch.mjs";
import { NAMESPACE_TESTS, VITEST_TESTS } from "../scripts/test-lanes.mjs";
import { selectTestShard } from "../scripts/test-shards.mjs";

const skipVitestFixture =
	process.env.CI === undefined &&
	!existsSync(
		new URL("../test-tools/node_modules/vitest/vitest.mjs", import.meta.url),
	)
		? "Install Vitest test tools with npm ci --prefix packages/polyfill-connectors/test-tools"
		: false;

function importsVitestValue(source: string): boolean {
	const isVitest = (value: unknown): boolean =>
		typeof value === "string" &&
		(value === "vitest" || value.startsWith("vitest/"));
	const ast = parse(source, {
		sourceType: "unambiguous",
		plugins: ["typescript"],
	});
	for (const statement of ast.program.body) {
		if (
			statement.type === "ImportDeclaration" &&
			isVitest(statement.source.value) &&
			statement.importKind !== "type" &&
			(statement.specifiers.length === 0 ||
				statement.specifiers.some(
					(specifier) =>
						specifier.type !== "ImportSpecifier" ||
						specifier.importKind !== "type",
				))
		) {
			return true;
		}
	}
	const pending: unknown[] = [ast.program];
	while (pending.length > 0) {
		const node = pending.pop();
		if (!node || typeof node !== "object") continue;
		if (Array.isArray(node)) {
			pending.push(...node);
			continue;
		}
		const record = node as Record<string, unknown>;
		if (record.type === "ImportExpression") {
			const sourceNode = record.source as { value?: unknown } | undefined;
			if (isVitest(sourceNode?.value)) return true;
		}
		if (record.type === "CallExpression") {
			const callee = record.callee as
				| { type?: unknown; name?: unknown }
				| undefined;
			const args = record.arguments;
			if (
				(callee?.type === "Import" ||
					(callee?.type === "Identifier" && callee.name === "require")) &&
				Array.isArray(args) &&
				isVitest((args[0] as { value?: unknown } | undefined)?.value)
			) {
				return true;
			}
		}
		for (const [key, value] of Object.entries(record)) {
			if (key !== "loc" && key !== "comments" && key !== "extra")
				pending.push(value);
		}
	}
	return false;
}

test("Vitest import detection uses value imports and includes subpaths", () => {
	for (const [source, expected] of [
		["// import { it } from 'vitest'", false],
		["const example = \"import { it } from 'vitest'\";", false],
		["import type { Mock } from 'vitest'", false],
		["import { type Mock } from 'vitest/utils'", false],
		["import { it } from 'vitest'", true],
		["import { type Mock, it } from 'vitest'", true],
		["import { expect } from 'vitest/expect'", true],
		["await import('vitest')", true],
		["await import('vitest/utils')", true],
		["require('vitest/expect')", true],
	] as const) {
		assert.equal(importsVitestValue(source), expected, source);
	}
});

test("package test runner bounds file concurrency and retains a finite hang guard", async () => {
	// "npm test" runs scripts/run-tests.mjs (not a literal `node --test ...` in
	// package.json) so the @pdpp/reference-contract-dependent and
	// monorepo-only files can be excluded by path; see that script's header
	// comment. The concurrency/timeout invariants this test guards live in its
	// spawn() call now, not in package.json's scripts.test string.
	// TEST_CONCURRENCY overrides the file concurrency; its default is 4.
	const ordinary = await readFile(
		new URL("../scripts/run-tests.mjs", import.meta.url),
		"utf8",
	);
	const related = await readFile(
		new URL("../scripts/related-tests/run.ts", import.meta.url),
		"utf8",
	);
	assert.match(ordinary, /process\.env\.TEST_CONCURRENCY \?\? "4"/);
	assert.match(
		ordinary,
		/testCommands\(\s*shardFiles,\s*lane === "namespaces" \? "1" : rawConcurrency/,
	);
	assert.match(related, /process\.env\.TEST_CONCURRENCY \?\? "4"/);
	assert.match(related, /scripts\/test-dispatch\.mjs/);
	assert.match(related, /"1",\s*\.\.\.namespaceTargets/);
	const commands = testCommands(
		["src/node.test.ts", "src/vitest.test.ts"],
		"4",
		new Set(["src/vitest.test.ts"]),
	);
	assert.equal(commands.length, 2);
	assert.deepEqual(commands[0]?.args.slice(0, 5), [
		"--test",
		"--import",
		"tsx",
		"--test-concurrency=4",
		"--test-timeout=120000",
	]);
	assert.deepEqual(commands[1]?.args.slice(1, 6), [
		"run",
		"--config",
		commands[1]?.args[3],
		"--pool=forks",
		"--maxWorkers=4",
	]);
	assert.ok(commands[1]?.args.includes("--testTimeout=120000"));
	assert.equal(testCommands(["src/node.test.ts"], "1").length, 1);
	assert.ok(
		testCommands(
			["src/vitest.test.ts"],
			"1",
			new Set(["src/vitest.test.ts"]),
		)[0]?.args.includes("--maxWorkers=1"),
	);
});

test("test shards are deterministic, disjoint, and cover the full file list", () => {
	const files = [
		"c.test.ts",
		"a.test.ts",
		"b.test.ts",
		"d.test.ts",
		"e.test.ts",
	];
	const shards = [1, 2, 3].map((index) => selectTestShard(files, `${index}/3`));
	assert.deepEqual(shards.flat().sort(), files.sort());
	assert.equal(new Set(shards.flat()).size, files.length);
	assert.deepEqual(
		selectTestShard(files, "1/3"),
		selectTestShard([...files].reverse(), "1/3"),
	);
	assert.throws(() => selectTestShard(files, "0/3"), /positive index\/count/);
	assert.throws(() => selectTestShard(files, "4/3"), /between 1 and its count/);
});

test("Vitest registration matches every imported Vitest test in runner globs", async () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const detected = new Set<string>();
	for (const pattern of [
		"bin/**/*.test.ts",
		"../../connectors/**/*.test.ts",
		"scripts/related-tests/*.test.ts",
		"scripts/**/*.test.mjs",
		"src/**/*.test.ts",
	]) {
		for await (const entry of glob(pattern, { cwd: packageRoot })) {
			const text = await readFile(join(packageRoot, entry), "utf8");
			if (importsVitestValue(text))
				detected.add(
					entry.startsWith("../../connectors/")
						? entry.slice("../../".length)
						: entry,
				);
		}
	}
	assert.deepEqual(
		[...detected].sort(),
		[...VITEST_TESTS].sort(),
		"register each imported Vitest test in VITEST_TESTS; remove stale entries",
	);
	for (const entry of VITEST_TESTS) {
		const file = entry.startsWith("connectors/")
			? join(packageRoot, "../..", entry)
			: join(packageRoot, entry);
		assert.ok(existsSync(file), `VITEST_TESTS entry does not exist: ${entry}`);
		assert.ok(importsVitestValue(await readFile(file, "utf8")), entry);
	}
});

test("real dispatch runs both kinds and reports a failing Vitest fixture", {
	skip: skipVitestFixture,
}, () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const markers = mkdtempSync(join(tmpdir(), "test-dispatch-"));
	const markerFile = join(markers, "ran.txt");
	const nodeFixture = "scripts/test-fixtures/node.fixture.ts";
	const vitestFixture = "../../scripts/test-fixtures/vitest.fixture.ts";
	const script = `import { runTestCommands, testCommands } from './scripts/test-dispatch.mjs'; const ok = await runTestCommands(testCommands(${JSON.stringify([nodeFixture, vitestFixture])}, '2', new Set([${JSON.stringify(vitestFixture)}]))); process.exit(ok ? 0 : 1);`;
	try {
		for (const fail of [false, true]) {
			const result = spawnSync(
				process.execPath,
				["--input-type=module", "-e", script],
				{
					cwd: packageRoot,
					env: {
						...process.env,
						NODE_TEST_CONTEXT: undefined,
						TEST_DISPATCH_MARKERS: markerFile,
						FAIL_VITEST_FIXTURE: fail ? "1" : "0",
					},
					encoding: "utf8",
					timeout: 60_000,
				},
			);
			assert.equal(result.status, fail ? 1 : 0, result.stderr);
			assert.deepEqual(
				readFileSync(markerFile, "utf8").trim().split("\n").slice(-2),
				["node", "vitest"],
			);
		}
	} finally {
		rmSync(markers, { recursive: true, force: true });
	}
});

test("NAMESPACE_TESTS lists exactly the files that need their own namespaces", async () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const listed: ReadonlySet<string> = NAMESPACE_TESTS;

	for (const entry of listed) {
		assert.ok(
			existsSync(`${packageRoot}${entry}`),
			`NAMESPACE_TESTS entry does not exist: ${entry}`,
		);
	}

	// The patterns run-tests.mjs globs; this file and the runner are not in them.
	const needsNamespaces =
		/namespaceSkip|bwrapUsable|unshareUsable|bindMountCapable|spawn(?:Sync)?\(\s*["'`](?:bwrap|unshare)["'`]/;
	const missing: string[] = [];
	for (const pattern of [
		"bin/**/*.test.ts",
		"../../connectors/**/*.test.ts",
		"scripts/related-tests/*.test.ts",
		"scripts/**/*.test.mjs",
		"src/**/*.test.ts",
	]) {
		for await (const entry of glob(pattern, { cwd: packageRoot })) {
			if (entry === "src/test-runner-contract.test.ts") {
				continue;
			}
			const text = await readFile(`${packageRoot}${entry}`, "utf8");
			if (needsNamespaces.test(text) && !listed.has(entry)) {
				missing.push(entry);
			}
		}
	}
	assert.deepEqual(
		missing,
		[],
		"these files need their own namespaces; add them to NAMESPACE_TESTS in scripts/test-lanes.mjs",
	);
});

test("connector registration routes a repo-relative path to Vitest", () => {
	const file = "../../connectors/groupme/example.test.ts";
	const commands = testCommands(
		[file],
		"1",
		new Set(["connectors/groupme/example.test.ts"]),
	);
	assert.equal(commands.length, 1);
	assert.ok(
		commands[0]?.args.includes(
			resolve(fileURLToPath(new URL("..", import.meta.url)), file),
		),
	);
	assert.ok(commands[0]?.args.includes("--maxWorkers=1"));
});

test("a signalled child stops the dispatcher with the same signal", () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const script =
		"import { runTestCommands } from './scripts/test-dispatch.mjs'; await runTestCommands([{ command: process.execPath, args: ['-e', 'process.kill(process.pid, \"SIGTERM\")'] }]);";
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{
			cwd: packageRoot,
			env: { ...process.env, NODE_TEST_CONTEXT: undefined },
			encoding: "utf8",
			timeout: 10_000,
		},
	);
	assert.equal(result.signal, "SIGTERM", result.stderr);
});

test("isolated Vitest tools are pinned and outside connector artifact inputs", async () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const tools = JSON.parse(
		await readFile(join(packageRoot, "test-tools/package.json"), "utf8"),
	);
	const lock = JSON.parse(
		await readFile(join(packageRoot, "test-tools/package-lock.json"), "utf8"),
	);
	assert.equal(tools.devDependencies.vitest, "4.1.12");
	assert.equal(
		testCommands(
			["src/registered.test.ts"],
			"1",
			new Set(["src/registered.test.ts"]),
		)[0]?.args[0],
		join(packageRoot, "test-tools/node_modules/vitest/vitest.mjs"),
	);
	assert.deepEqual(
		Object.entries(lock.packages)
			.filter(
				([path]) =>
					path === "node_modules/vitest" ||
					path.endsWith("/node_modules/vitest"),
			)
			.map(([, entry]) => (entry as { version: string }).version),
		["4.1.12"],
	);
	const artifactInputs = await readFile(
		join(packageRoot, "../../scripts/connector-artifact-inputs.mjs"),
		"utf8",
	);
	assert.doesNotMatch(artifactInputs, /test-tools/);
});

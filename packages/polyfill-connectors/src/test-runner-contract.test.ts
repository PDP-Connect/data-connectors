// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { glob, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testCommands } from "../scripts/test-dispatch.mjs";
import { NAMESPACE_TESTS, VITEST_TESTS } from "../scripts/test-lanes.mjs";

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
		/testCommands\(\s*files,\s*lane === "namespaces" \? "1" : rawConcurrency/,
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

test("Vitest registration matches every imported Vitest test in runner globs", async () => {
	const packageRoot = fileURLToPath(new URL("..", import.meta.url));
	const importsVitest = /\bfrom\s*["']vitest["']|\bimport\s*["']vitest["']/;
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
			if (importsVitest.test(text))
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
		assert.match(await readFile(file, "utf8"), importsVitest, entry);
	}
});

test("real dispatch runs both kinds and reports a failing Vitest fixture", () => {
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
	assert.ok(commands[0]?.args.includes(file));
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

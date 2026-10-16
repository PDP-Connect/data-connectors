// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	commandsFor,
	partitionTests,
	patterns,
	repoRoot,
	runCommands,
} from "./dispatch.mjs";

const cwd = join(repoRoot, "packages/polyfill-connectors");
const discovered = [
	"bin/a.test.ts",
	"../../connectors/groupme/collection.test.ts",
	"../../connectors/groupme/other.test.ts",
	"../../connectors/github/index.test.ts",
	"scripts/related-tests/a.test.ts",
	"scripts/a.test.mjs",
	"src/a.test.ts",
];
test("empty migration preserves categories and GitHub exclusion, with no Vitest command", async () => {
	const emptyRoster = [];
	assert.deepEqual(patterns, [
		"bin/**/*.test.ts",
		"../../connectors/**/*.test.ts",
		"scripts/related-tests/*.test.ts",
		"scripts/**/*.test.mjs",
		"src/**/*.test.ts",
	]);
	const parts = partitionTests(discovered, emptyRoster, cwd);
	assert.deepEqual(
		parts.node,
		discovered.filter((x) => !x.includes("/github/")),
	);
	assert.deepEqual(parts.native, []);
	const commands = await commandsFor(parts, cwd);
	assert.equal(commands.length, 1);
	assert.equal(commands[0].command, process.execPath);
	assert.deepEqual(commands[0].args, [
		"--test",
		"--import",
		"tsx",
		"--test-concurrency=2",
		"--test-timeout=120000",
		...parts.node,
	]);
	assert.deepEqual(await commandsFor({ node: [], native: [] }, cwd), []);
});
test("native roster forms an exact disjoint union and uses isolated explicit filters", async () => {
	const roster = ["connectors/groupme/collection.test.ts"];
	const parts = partitionTests(discovered, roster, cwd);
	assert.equal(parts.node.length + parts.native.length, discovered.length - 1);
	assert.ok(!parts.node.includes(discovered[1]));
	assert.deepEqual(parts.native, [join(repoRoot, roster[0])]);
	const commands = await commandsFor(parts, cwd);
	assert.equal(commands.length, 2);
	assert.equal(commands[1].cwd, repoRoot);
	assert.deepEqual(commands[1].args, [
		join(
			repoRoot,
			"scripts/groupme-mutation/tools/node_modules/vitest/vitest.mjs",
		),
		"run",
		"--config",
		join(repoRoot, "scripts/groupme-mutation/vitest.config.mjs"),
		"--exclude",
		"connectors/groupme/other.test.ts",
		...parts.native,
	]);
});
test("duplicate, missing, unknown and excluded entries fail instead of dropping tests", () => {
	const good = "connectors/groupme/collection.test.ts";
	assert.throws(
		() => partitionTests([...discovered, discovered[0]], [], cwd),
		/Duplicate discovered/,
	);
	assert.throws(
		() => partitionTests(discovered, [good, good], cwd),
		/Duplicate native/,
	);
	assert.throws(
		() =>
			partitionTests(discovered, ["connectors/groupme/missing.test.ts"], cwd),
		/Missing discovered/,
	);
	for (const entry of [
		"connectors/github/index.test.ts",
		"src/a.test.ts",
		"../escape",
		null,
	])
		assert.throws(
			() => partitionTests(discovered, [entry], cwd),
			/Unknown native/,
		);
});
test("real subprocess nonzero and signal failures propagate from either lane", async () => {
	const command = (code) => ({
		command: process.execPath,
		args: ["-e", code],
		cwd,
	});
	const pass = command("process.exit(0)");
	for (const index of [0, 1]) {
		const prefix = index ? [pass] : [];
		assert.deepEqual(
			await runCommands([...prefix, command("process.exit(7)")], {
				stdio: "ignore",
			}),
			{ code: 7, signal: null },
		);
		assert.deepEqual(
			await runCommands(
				[...prefix, command("process.kill(process.pid, 'SIGTERM')")],
				{ stdio: "ignore" },
			),
			{ code: null, signal: "SIGTERM" },
		);
	}
	const failed = await runCommands(
		[{ command: join(cwd, "nonexistent-command"), args: [], cwd }],
		{ stdio: "ignore" },
	);
	assert.equal(failed.code, 1);
	assert.ok(failed.error);
});
test("native file filter excludes an adjacent unported sentinel", () => {
	const base = fileURLToPath(new URL(".", import.meta.url));
	const temp = mkdtempSync(join(base, ".dispatch-fixture-"));
	try {
		const dir = join(temp, "connectors/groupme");
		mkdirSync(dir, { recursive: true });
		const selected = join(dir, "selected.test.ts");
		writeFileSync(
			selected,
			"import {test,expect} from 'vitest'; test('migrated-only',()=>expect(2+2).toBe(4));\n",
		);
		writeFileSync(
			join(dir, "selected.test.ts.unported.test.ts"),
			"throw new Error('UNPORTED_SENTINEL_EXECUTED');\n",
		);
		const cfg = join(temp, "vitest.config.mjs");
		writeFileSync(
			cfg,
			"import base from " +
				JSON.stringify(pathToFileURL(join(base, "vitest.config.mjs")).href) +
				"; export default {...base, root:" +
				JSON.stringify(temp) +
				"};\n",
		);
		const result = spawnSync(
			process.execPath,
			[
				join(base, "tools/node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				cfg,
				"--exclude",
				"connectors/groupme/selected.test.ts.unported.test.ts",
				selected,
			],
			{ cwd: repoRoot, encoding: "utf8", timeout: 120000 },
		);
		assert.equal(result.error, undefined);
		assert.equal(result.signal, null);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /1 passed/);
		assert.doesNotMatch(
			result.stdout + result.stderr,
			/UNPORTED_SENTINEL_EXECUTED/,
		);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
test("CI installs isolated tools before verification without changing mutation gate", () => {
	const ci = readFileSync(
		join(repoRoot, ".github/workflows/polyfill-connectors.yml"),
		"utf8",
	);
	const install = ci.indexOf(
		"npm ci --prefix scripts/groupme-mutation/tools --ignore-scripts --no-audit --no-fund",
	);
	assert.ok(install > 0 && install < ci.indexOf("run: npm run verify"));
	assert.ok(install < ci.indexOf("run: npm run test"));
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { connectorsDir } from "../../src/connector-paths.ts";
import { relatedCommands, runRelatedTests, testFileArgument } from "./run.ts";

test("root connector test labels run from their real repo-root path", () => {
	assert.equal(
		testFileArgument("connectors/shopify/parsers.test.ts"),
		join(connectorsDir, "shopify", "parsers.test.ts"),
	);
});

test("package-local test labels stay relative to the package cwd", () => {
	assert.equal(testFileArgument("src/runtime.test.ts"), "src/runtime.test.ts");
});

test("a selected native file runs once under Vitest and never under node:test", async () => {
	const commands = await relatedCommands([
		"connectors/groupme/schemas.test.ts",
	]);
	assert.equal(commands.length, 1);
	assert.match(
		commands[0].args[0],
		/tools\/node_modules\/vitest\/vitest\.mjs$/,
	);
	assert.equal(
		commands[0].args.filter((arg: string) =>
			arg.endsWith("connectors/groupme/schemas.test.ts"),
		).length,
		1,
	);
	assert.equal(commands[0].args.includes("--test"), false);
});

test("a node-only selection launches node:test and never Vitest", async () => {
	const commands = await relatedCommands(["src/runtime.test.ts"]);
	assert.equal(commands.length, 1);
	assert.equal(commands[0].args.includes("--test"), true);
	assert.equal(commands[0].args.at(-1), "src/runtime.test.ts");
});

test("a mixed selection accounts for each file once across both lanes", async () => {
	const commands = await relatedCommands([
		"connectors/groupme/schemas.test.ts",
		"src/runtime.test.ts",
	]);
	assert.equal(commands.length, 2);
	const [node, vitest] = commands;
	assert.equal(node.args.at(-1), "src/runtime.test.ts");
	assert.equal(
		node.args.some((arg: string) => arg.endsWith("schemas.test.ts")),
		false,
	);
	assert.equal(
		vitest.args.filter((arg: string) => arg.endsWith("schemas.test.ts")).length,
		1,
	);
});

test("an empty selection stays a no-op and never reaches discovery validation", async () => {
	assert.deepEqual(await relatedCommands([]), []);
	assert.equal((await runRelatedTests([])).code, 0);
});

// When this file runs under node --test, children inherit NODE_TEST_CONTEXT; a
// nested node --test then reports through that channel and exits 0 even for a
// failing file. Strip it so the real subprocess exit codes are what is asserted.
const standalone = {
	stdio: "ignore" as const,
	env: Object.fromEntries(
		Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
	),
};

test("a real selected native file exits zero through Vitest", async () => {
	const result = await runRelatedTests(
		["connectors/groupme/schemas.test.ts"],
		standalone,
	);
	assert.equal(result.code, 0);
});

test("a real failing selected test propagates its nonzero exit code", async () => {
	const dir = await mkdtemp(
		join(fileURLToPath(new URL(".", import.meta.url)), ".related-fixture-"),
	);
	try {
		const fixture = join(dir, "fails.test.ts");
		await writeFile(
			fixture,
			"import test from 'node:test';\ntest('fails', () => { throw new Error('expected'); });\n",
		);
		const result = await runRelatedTests([fixture], standalone);
		assert.equal(result.code, 1);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

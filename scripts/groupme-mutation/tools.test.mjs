// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import stryker from "./stryker.config.mjs";
import config, { pins, resolveTool, toolsRoot } from "./vitest.config.mjs";

const base = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
function child(args, cwd) {
	const result = spawnSync(process.execPath, args, {
		cwd,
		encoding: "utf8",
		timeout: 150000,
		env: { ...process.env, CI: "true", NO_COLOR: "1" },
	});
	assert.equal(result.error, undefined, String(result.error));
	assert.equal(result.signal, null, result.stderr);
	return result;
}
test("exact isolated pins and conservative native configuration", () => {
	const pkg = JSON.parse(readFileSync(join(toolsRoot, "package.json"), "utf8"));
	assert.deepEqual(pkg.dependencies, pins);
	assert.equal(pkg.private, true);
	assert.equal(stryker.testRunner, "vitest");
	assert.equal(stryker.coverageAnalysis, "perTest");
	assert.deepEqual(stryker.mutate, []);
	assert.equal(stryker.mutator, undefined); // official default operators
	assert.equal(stryker.disableBail, true);
	assert.equal(stryker.vitest.related, false);
	assert.deepEqual(stryker.thresholds, { break: 0 });
	assert.deepEqual(stryker.reporters, ["json", "clear-text", "html"]);
	assert.equal(config.test.pool, "forks");
	assert.equal(config.test.isolate, true);
	assert.equal(config.test.sequence.concurrent, false);
	assert.equal(config.test.testTimeout, 120000);
	assert.equal(config.test.bail, 0);
	assert.equal(config.test.passWithNoTests, false);
	assert.ok(config.test.maxWorkers <= 2);
	assert.deepEqual(config.test.include, ["connectors/groupme/*.test.ts"]);
	assert.deepEqual(stryker.plugins, [
		resolveTool("@stryker-mutator/vitest-runner"),
	]);
});
test("both configs resolve from repository and isolated tool working directories", () => {
	const urls = ["vitest.config.mjs", "stryker.config.mjs"].map(
		(name) => pathToFileURL(join(base, name)).href,
	);
	for (const cwd of [repo, toolsRoot]) {
		const result = child(
			[
				"--input-type=module",
				"-e",
				"for (const url of " +
					JSON.stringify(urls) +
					") await import(url); console.log('CONFIG_OK');",
			],
			cwd,
		);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /CONFIG_OK/);
	}
});
test("missing and wrong isolated versions cannot fall back to root dependencies", () => {
	const temp = mkdtempSync(join(base, ".tools-negative-"));
	try {
		copyFileSync(
			join(base, "vitest.config.mjs"),
			join(temp, "vitest.config.mjs"),
		);
		const url = pathToFileURL(join(temp, "vitest.config.mjs")).href;
		let result = child(
			[
				"--input-type=module",
				"-e",
				"await import(" + JSON.stringify(url) + ")",
			],
			repo,
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /ENOENT/);
		const dir = join(temp, "tools/node_modules/@stryker-mutator/core");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "@stryker-mutator/core", version: "0.0.0" }),
		);
		result = child(
			[
				"--input-type=module",
				"-e",
				"await import(" + JSON.stringify(url) + ")",
			],
			toolsRoot,
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Unexpected isolated tool version/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
test("native Vitest executes a passing assertion and propagates a real failure", () => {
	const temp = mkdtempSync(join(base, ".tools-smoke-"));
	try {
		const cfg = join(temp, "vitest.config.mjs");
		writeFileSync(
			cfg,
			"import base from " +
				JSON.stringify(pathToFileURL(join(base, "vitest.config.mjs")).href) +
				";\n" +
				"export default {...base, root: " +
				JSON.stringify(temp) +
				", test: {...base.test, include: ['smoke.test.mjs']}};\n",
		);
		const fixture = join(temp, "smoke.test.mjs");
		const cli = join(toolsRoot, "node_modules/vitest/vitest.mjs");
		writeFileSync(
			fixture,
			"import {test,expect} from 'vitest'; test('native-smoke-owner',()=>expect(2+2).toBe(4));\n",
		);
		for (const cwd of [repo, toolsRoot]) {
			const pass = child([cli, "run", "--config", cfg], cwd);
			assert.equal(pass.status, 0, pass.stdout + pass.stderr);
			assert.match(pass.stdout, /1 passed/);
		}
		writeFileSync(
			fixture,
			"import {test,expect} from 'vitest'; test('native-smoke-owner',()=>expect(2+2).toBe(5));\n",
		);
		const fail = child([cli, "run", "--config", cfg], repo);
		assert.notEqual(fail.status, 0);
		assert.match(fail.stdout + fail.stderr, /native-smoke-owner/);
		assert.match(fail.stdout + fail.stderr, /expected 4 to be 5/);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyLocalNodeTestConcurrency,
	assertIssuedArgvMatchesCommand,
} from "./authority.ts";

const ARGV_MISMATCH_PATTERN = /differs from the argv bound/;

test("local direct Node test leaves run at most two files concurrently", () => {
	assert.deepEqual(
		applyLocalNodeTestConcurrency(["node", "--test", "--import", "tsx"], false),
		["node", "--test", "--test-concurrency=2", "--import", "tsx"],
	);
});

test("CI and explicitly bounded commands preserve their declared concurrency", () => {
	const command = ["node", "--test", "--import", "tsx"];
	assert.deepEqual(applyLocalNodeTestConcurrency(command, true), command);
	assert.deepEqual(
		applyLocalNodeTestConcurrency(
			["node", "--test", "--test-concurrency=1"],
			false,
		),
		["node", "--test", "--test-concurrency=1"],
	);
});

test("non-test Node commands are unchanged", () => {
	const command = ["node", "--import", "tsx", "scripts/run-tests.ts"];
	assert.deepEqual(applyLocalNodeTestConcurrency(command, false), command);
});

test("executed commands must retain the argv bound into authority transcripts and receipts", () => {
	const issued = ["node", "--test", "--test-concurrency=2", "--import", "tsx"];
	assert.doesNotThrow(() =>
		assertIssuedArgvMatchesCommand(issued, [...issued, "example.test.ts"]),
	);
	assert.throws(
		() =>
			assertIssuedArgvMatchesCommand(issued, [
				"node",
				"--test",
				"--import",
				"tsx",
				"example.test.ts",
			]),
		ARGV_MISMATCH_PATTERN,
	);
});

test("the effective local command bounds real simultaneous test file children to two", () => {
	const root = mkdtempSync(join(tmpdir(), "accounting-concurrency-"));
	try {
		const files = [0, 1, 2, 3].map((index) => join(root, `${index}.test.mjs`));
		const log = join(root, "events.jsonl");
		for (const [index, file] of files.entries())
			writeFileSync(
				file,
				`import test from 'node:test';import {appendFileSync} from 'node:fs';test('real child',async()=>{appendFileSync(${JSON.stringify(log)},'${index}:start\\n');await new Promise(r=>setTimeout(r,80));appendFileSync(${JSON.stringify(log)},'${index}:end\\n');});`,
			);
		const command = applyLocalNodeTestConcurrency(["node", "--test"], false);
		// The manifest declares the literal node command; execute that exact bounded command.
		const env = { ...process.env };
		delete env.NODE_TEST_CONTEXT;
		const child = spawnSync(
			command[0] ?? process.execPath,
			[...command.slice(1), ...files],
			{ cwd: root, env, encoding: "utf8" },
		);
		assert.equal(child.status, 0, child.stderr);
		let active = 0;
		let maximum = 0;
		for (const line of readFileSync(log, "utf8").trim().split("\n")) {
			active += line.endsWith(":start") ? 1 : -1;
			maximum = Math.max(maximum, active);
		}
		assert.equal(active, 0);
		assert.equal(maximum, 2);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

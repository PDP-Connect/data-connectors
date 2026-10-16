// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./run.ts";

if (process.env.GROUPME_MUTATION_COLD_HOME_CHILD === "1") {
	assert.equal(
		existsSync(path.join(os.homedir(), ".tmp")),
		false,
		"cold entrypoint subprocess must start without ~/.tmp",
	);
}

const sha = "a".repeat(40);
const flags = [
	"--mode",
	"diff",
	"--base",
	sha,
	"--head",
	"b".repeat(40),
	"--merge-base",
	sha,
];

test("accepts only the diff mode and requires all three full SHAs", () => {
	assert.deepEqual(parseArgs(flags), {
		base: sha,
		head: "b".repeat(40),
		mergeBase: sha,
		report: undefined,
	});
	assert.deepEqual(parseArgs([...flags, "--report", "/x"]).report, "/x");
	assert.throws(() => parseArgs(["--mode", "diff"]), /full SHAs are required/);
	assert.throws(
		() => parseArgs(["--mode", "qualify", ...flags.slice(2)]),
		/only --mode diff is supported/,
	);
});

test("rejects unknown, valueless and value-looking flags instead of ignoring them", () => {
	assert.throws(
		() => parseArgs([...flags, "--qualify"]),
		/unknown or incomplete/,
	);
	assert.throws(
		() => parseArgs([...flags, "--report"]),
		/unknown or incomplete/,
	);
	assert.throws(
		() => parseArgs(["--base", "--head", "--merge-base", sha]),
		/unknown or incomplete/,
	);
});

if (process.env.GROUPME_MUTATION_COLD_HOME_CHILD !== "1") {
	test("package entrypoint reaches the runner with a fresh home and no .tmp", async (t) => {
		const freshHome = await mkdtemp(
			path.join(os.tmpdir(), "groupme-empty-home-"),
		);
		t.after(() => rm(freshHome, { recursive: true, force: true }));
		const preload = path.join(freshHome, "homedir-preload.mjs");
		await writeFile(
			preload,
			"import os from 'node:os'; os.homedir = () => process.env.GROUPME_TEST_HOME;\n",
		);
		assert.equal(existsSync(path.join(freshHome, ".tmp")), false);
		const childEnv = {
			...process.env,
			GROUPME_TEST_HOME: freshHome,
			GROUPME_MUTATION_COLD_HOME_CHILD: "1",
			NODE_OPTIONS:
				`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim(),
		};
		const homeProbe = spawnSync(
			process.execPath,
			["-e", "console.log(require('node:os').homedir())"],
			{ encoding: "utf8", env: childEnv },
		);
		assert.equal(homeProbe.stdout.trim(), freshHome, homeProbe.stderr);
		const child = spawnSync(
			"npm",
			["run", "groupme-mutation", "--", "--mode", "diff"],
			{
				cwd: process.cwd(),
				encoding: "utf8",
				env: childEnv,
				timeout: 120_000,
			},
		);
		assert.notEqual(child.status, 0);
		assert.match(
			`${child.stdout}\n${child.stderr}`,
			/--base, --head, and --merge-base full SHAs are required/,
		);
		// Validation failed before any report directory was created in the fresh home.
		assert.equal(existsSync(path.join(freshHome, ".tmp")), false);
	});
}

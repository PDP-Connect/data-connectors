#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { repoRoot } from "../../../packages/polyfill-connectors/src/connector-paths.ts";

const owner =
	"scenario-record + scenario-verify: record against a stub connector's loopback upstream, verify PASS offline, then a tampered scenario fails verify non-zero";
const ownerFile = "packages/polyfill-connectors/bin/scenario-cli.test.ts";
const ownerPattern = owner.replace(/[.*+?^$\u007b\u007d()|[\]\\]/g, "\\$&");

function doctor() {
	const [major, minor] = process.versions.node.split(".").map(Number);
	assert.ok(major === 24 && minor >= 15, "Use Node 24.15 or later 24.x.");
	for (const file of [
		".env.local",
		"packages/polyfill-connectors/.env.local",
	]) {
		assert.ok(
			!existsSync(join(repoRoot, file)),
			`Use a disposable checkout with no ${file}. The scenario tools load local credentials.`,
		);
	}
	assert.ok(
		existsSync(join(repoRoot, ownerFile)),
		`Missing scenario owner: ${ownerFile}`,
	);
	for (const dependency of [
		"tsx",
		"@pdpp/collector-runtime",
		"@pdpp/connector-protocol",
	]) {
		try {
			import.meta.resolve(dependency);
		} catch {
			throw new Error(
				`Install the locked offline dependencies. Missing ${dependency}.`,
			);
		}
	}
}

function evidenceDirectory(argument) {
	const requested = resolve(argument);
	const directory = join(realpathSync(dirname(requested)), basename(requested));
	const path = relative(realpathSync(repoRoot), directory);
	assert.ok(
		path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path),
		"Choose a fresh machine-local evidence directory outside the checkout.",
	);
	mkdirSync(directory, { mode: 0o700 });
	return directory;
}

function diagnostic(tap, name) {
	const prefix = `# ${name}:`;
	const line = tap.split("\n").find((row) => row.startsWith(prefix));
	assert.ok(line, `Missing ${name} diagnostic.`);
	// Node's TAP reporter escapes embedded line endings in a diagnostic.
	return line.slice(prefix.length).replaceAll(/\\+n/g, "\n");
}

function checkReplay(tap) {
	assert.ok(
		new RegExp(`^ok \\d+ - ${ownerPattern}$`, "m").test(tap),
		"The required test did not pass.",
	);
	const capture = diagnostic(tap, "record stdout");
	const replay = diagnostic(tap, "verify stdout");
	const tamper = diagnostic(tap, "tampered verify stdout");
	assert.ok(
		/^runs captured: 2$/m.test(capture),
		"The fixture did not record both runs.",
	);
	assert.ok(
		/^provider_contact:.*\bloopback_only=true\b/m.test(capture),
		"The fixture did not report loopback-only contact.",
	);
	assert.ok(
		/^ {2}run 0: PASS$/m.test(replay) && /^ {2}run 1: PASS$/m.test(replay),
		"Both original runs must pass replay.",
	);
	assert.ok(
		/^ {2}interactions replayed: 3$/m.test(replay),
		"The replay must account for all three interactions.",
	);
	assert.ok(
		/^diagnostic_replay: PASS/m.test(replay) &&
			/^recorded_replay: WITHHELD/m.test(replay),
		"The replay did not report its diagnostic claim boundary.",
	);
	assert.ok(
		/^ {2}run 0: FAIL$/m.test(tamper) && /\brecord_hash\b/.test(tamper),
		"The tampered record must fail with a hash mismatch.",
	);
	const isolation = replay.match(/^ *network isolation: (.+)$/m);
	assert.ok(isolation, "The owner did not report its replay isolation.");
	return {
		recordedRuns: 2,
		replayedRuns: 2,
		replayedInteractions: 3,
		mutationRejectedAt: "record_hash",
		isolation: isolation[1].trim(),
	};
}

function run(directory) {
	const git = (...args) =>
		execFileSync("git", ["--no-optional-locks", ...args], {
			cwd: repoRoot,
			encoding: "utf8",
		}).trim();
	const revision = git("rev-parse", "--verify", "HEAD");
	const worktreeDirty = Boolean(git("status", "--porcelain=v1"));
	const evidence = evidenceDirectory(directory);
	const scratch = mkdtempSync(join(tmpdir(), "connectors-offline-"));
	const result = {
		owner: ownerFile,
		test: owner,
		node: process.version,
		revision,
		worktreeDirty,
		status: "failed",
	};
	try {
		const env = Object.fromEntries(
			["PATH", "SystemRoot", "PATHEXT", "ComSpec", "WINDIR"]
				.filter((key) => process.env[key])
				.map((key) => [key, process.env[key]]),
		);
		const runResult = spawnSync(
			process.execPath,
			[
				"--test",
				"--import",
				"tsx",
				"--test-reporter=tap",
				"--test-timeout=90000",
				`--test-name-pattern=^${ownerPattern}$`,
				ownerFile,
			],
			{
				cwd: repoRoot,
				env: { ...env, TMPDIR: scratch, TMP: scratch, TEMP: scratch },
				encoding: "utf8",
			},
		);
		writeFileSync(join(evidence, "scenario.tap"), runResult.stdout ?? "", {
			mode: 0o600,
		});
		writeFileSync(join(evidence, "scenario.stderr"), runResult.stderr ?? "", {
			mode: 0o600,
		});
		assert.equal(runResult.error, undefined, runResult.error?.message);
		assert.equal(
			runResult.status,
			0,
			"The scenario test failed. Read scenario.tap and scenario.stderr.",
		);
		Object.assign(result, checkReplay(runResult.stdout));
	} catch (error) {
		result.reason = error.message;
	} finally {
		try {
			rmSync(scratch, { recursive: true, force: true });
			result.scratchRemoved = !existsSync(scratch);
		} catch (error) {
			result.reason ??= `Scratch cleanup failed: ${error.message}`;
		}
		if (!result.reason && result.scratchRemoved) result.status = "passed";
		writeFileSync(
			join(evidence, "result.json"),
			`${JSON.stringify(result, null, 2)}\n`,
			{ mode: 0o600 },
		);
	}
	console.log(
		`${result.status.toUpperCase()}: ${join(evidence, "result.json")}`,
	);
	if (result.reason) console.error(result.reason);
	process.exitCode = result.status === "passed" ? 0 : 1;
}

try {
	const [argument, extra] = process.argv.slice(2);
	assert.ok(
		argument && !extra,
		"Usage: node run.mjs --doctor | <new evidence directory>",
	);
	doctor();
	if (argument === "--doctor") {
		console.log(
			`Ready: Node ${process.version}, locked dependencies, no local credential file.`,
		);
	} else {
		run(argument);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}

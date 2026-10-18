// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Every tracked test file must run in some lane, or be listed in MANUAL with a
// reason. A test that no script, workflow, or runner glob names runs nowhere,
// so a regression in it goes unseen.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tracked test files that intentionally run in no automatic lane.
const MANUAL = new Map([
	[
		"scripts/pageshim/claude-real-size.test.mjs",
		"needs real Claude exports under ~/Downloads; run by hand",
	],
	[
		"packages/connector-installer-core/oci-live-registry.test.mjs",
		"talks to a live registry; run by hand",
	],
	[
		"connectors/github/index.test.ts",
		"imports the absent reference implementation; runs nowhere",
	],
]);

const norm = (p) => p.replace(/^\.\//, "");

function trackedTests() {
	return execFileSync("git", ["ls-files", "*.test.mjs", "*.test.ts"], {
		cwd: root,
		encoding: "utf8",
	})
		.split("\n")
		.filter(Boolean)
		.filter(
			(f) => !f.split("/").some((s) => s === "node_modules" || s === "vendor"),
		);
}

const TEST_FILE = /\.test\.(?:mjs|ts)$/;

// Test files that a shell command actually passes to `node --test`. Only a
// command segment that starts with node (after env assignments and an optional
// test-sandbox wrapper) counts, so a path in an echo, a comment or an argument
// to another program is not mistaken for a run.
export function nodeTestFiles(command) {
	const files = new Set();
	for (const rawSegment of command.split(/&&|\|\||[;|\n]/)) {
		const segment = rawSegment.replace(/(^|\s)#.*$/, "");
		const words = segment.trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
		if (words[i]?.endsWith("test-sandbox")) {
			const end = words.indexOf("--", i);
			if (end === -1) continue;
			i = end + 1;
		}
		if (words[i] !== "node" || !words.slice(i + 1).includes("--test")) continue;
		for (const word of words.slice(i + 1)) {
			const file = norm(word.replace(/^["']|["']$/g, ""));
			if (!file.startsWith("-") && TEST_FILE.test(file)) files.add(file);
		}
	}
	return files;
}

function packageScriptFiles() {
	const { scripts } = JSON.parse(
		readFileSync(path.join(root, "package.json"), "utf8"),
	);
	return new Set(Object.values(scripts).flatMap((c) => [...nodeTestFiles(c)]));
}

// The shell text of every `run:` step: an inline value, or a `|`/`>` block.
export function workflowRunCommands(yaml) {
	const commands = [];
	const lines = yaml.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
		if (!match) continue;
		const value = match[2].trim();
		if (!/^[|>][-+]?$/.test(value)) {
			commands.push(value);
			continue;
		}
		const block = [];
		const indent = match[1].length;
		while (i + 1 < lines.length) {
			const next = lines[i + 1];
			if (next.trim() !== "" && next.length - next.trimStart().length <= indent)
				break;
			block.push(next);
			i++;
		}
		commands.push(block.join("\n"));
	}
	return commands;
}

function workflowFiles() {
	const dir = path.join(root, ".github/workflows");
	return new Set(
		readdirSync(dir)
			.filter((f) => /\.ya?ml$/.test(f))
			.flatMap((f) =>
				workflowRunCommands(readFileSync(path.join(dir, f), "utf8")),
			)
			.flatMap((c) => [...nodeTestFiles(c)]),
	);
}

function polyfillRunnerFiles() {
	const cwd = path.join(root, "packages/polyfill-connectors");
	const out = execFileSync("node", ["scripts/run-tests.mjs", "--list"], {
		cwd,
		encoding: "utf8",
	});
	return new Set(
		out
			.split("\n")
			.filter(Boolean)
			.map((f) =>
				path.relative(root, path.resolve(cwd, f)).split(path.sep).join("/"),
			),
	);
}

function coverage() {
	const scripts = packageScriptFiles();
	const workflows = workflowFiles();
	const runner = polyfillRunnerFiles();
	return (file) => scripts.has(file) || workflows.has(file) || runner.has(file);
}

test("every tracked test file runs in a lane or is listed as manual", () => {
	const covered = coverage();
	const orphans = trackedTests().filter((f) => !covered(f) && !MANUAL.has(f));
	assert.deepEqual(
		orphans,
		[],
		`${orphans.length} test file(s) run in no lane. Add each to a package.json script ` +
			`or workflow step, or to MANUAL in scripts/test-lanes-coverage.test.mjs with a reason:\n  ` +
			orphans.join("\n  "),
	);
});

test("MANUAL entries exist and are not covered by any lane", () => {
	const covered = coverage();
	const stale = [];
	for (const file of MANUAL.keys()) {
		if (!existsSync(path.join(root, file)))
			stale.push(`${file}: no longer exists`);
		else if (covered(file))
			stale.push(`${file}: is covered by a lane; remove it from MANUAL`);
	}
	assert.deepEqual(stale, [], `stale MANUAL entries:\n  ${stale.join("\n  ")}`);
});

test("only real node --test arguments count as coverage", () => {
	const run = (c) => [...nodeTestFiles(c)];
	assert.deepEqual(run("node --test ./a.test.mjs b.test.ts"), [
		"a.test.mjs",
		"b.test.ts",
	]);
	assert.deepEqual(
		run(
			"npm run x && scripts/test-sandbox/test-sandbox --net host -- node --test c.test.mjs",
		),
		["c.test.mjs"],
	);
	assert.deepEqual(run("FOO=1 node --import tsx --test d.test.ts"), [
		"d.test.ts",
	]);
	assert.deepEqual(run("node --test e.test.mjs # f.test.mjs"), ["e.test.mjs"]);
	assert.deepEqual(run("echo node --test g.test.mjs"), []);
	assert.deepEqual(run("node scripts/build.mjs h.test.mjs"), []);
	assert.deepEqual(run("cat i.test.mjs"), []);
	const yaml = [
		"jobs:",
		"  x:",
		"    name: j.test.mjs",
		"    steps:",
		"      - name: Test k.test.mjs",
		"        env:",
		"          FILE: l.test.mjs",
		"        run: node --test m.test.mjs",
		"      - run: |",
		"          echo n.test.mjs",
		"          node --test o.test.mjs",
		"      - run: node p.test.mjs",
	].join("\n");
	assert.deepEqual(
		workflowRunCommands(yaml).flatMap((c) => [...nodeTestFiles(c)]),
		["m.test.mjs", "o.test.mjs"],
	);
});

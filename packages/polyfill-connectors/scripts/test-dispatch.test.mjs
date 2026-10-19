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
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { partitionTests } from "./test-dispatch.mjs";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

test("nested connectors path retains its full registration", () => {
	const file = resolve(
		packageRoot,
		"../../connectors/groupme/connectors/nested.test.ts",
	);
	assert.deepEqual(
		partitionTests(
			[file],
			new Set(["connectors/groupme/connectors/nested.test.ts"]),
		).vitestTests,
		[file],
	);
});

test("Vitest runs only the selected file, not a same-suffix file", () => {
	const directory = mkdtempSync(join(tmpdir(), "vitest-exact-file-"));
	const markerFile = join(directory, "ran.txt");
	const file = "../../scripts/test-fixtures/vitest.fixture.ts";
	const script = `import { runTestCommands, testCommands } from './scripts/test-dispatch.mjs'; process.exit((await runTestCommands(testCommands([${JSON.stringify(file)}], '1', new Set([${JSON.stringify(file)}])))) ? 0 : 1);`;
	try {
		const result = spawnSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				cwd: packageRoot,
				env: {
					...process.env,
					NODE_TEST_CONTEXT: undefined,
					TEST_DISPATCH_MARKERS: markerFile,
				},
				encoding: "utf8",
				timeout: 30_000,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(readFileSync(markerFile, "utf8").trim().split("\n"), [
			"vitest",
		]);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test("node:test commands work when Vitest is absent", () => {
	const directory = mkdtempSync(join(tmpdir(), "dispatch-no-vitest-"));
	const scripts = join(directory, "scripts");
	mkdirSync(scripts);
	copyFileSync(
		new URL("./test-dispatch.mjs", import.meta.url),
		join(scripts, "test-dispatch.mjs"),
	);
	copyFileSync(
		new URL("./test-lanes.mjs", import.meta.url),
		join(scripts, "test-lanes.mjs"),
	);
	const moduleUrl = pathToFileURL(join(scripts, "test-dispatch.mjs")).href;
	try {
		const result = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { testCommands } from ${JSON.stringify(moduleUrl)}; if (testCommands(['src/node.test.ts'], '1').length !== 1) process.exit(1);`,
			],
			{
				cwd: directory,
				env: { ...process.env, NODE_TEST_CONTEXT: undefined },
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		assert.equal(result.status, 0, result.stderr);
		const missing = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { testCommands } from ${JSON.stringify(moduleUrl)}; testCommands(['src/vitest.test.ts'], '1', new Set(['src/vitest.test.ts']));`,
			],
			{
				cwd: directory,
				env: { ...process.env, NODE_TEST_CONTEXT: undefined },
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		assert.equal(missing.status, 1);
		assert.match(
			missing.stderr,
			/npm ci --prefix packages\/polyfill-connectors\/test-tools/,
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

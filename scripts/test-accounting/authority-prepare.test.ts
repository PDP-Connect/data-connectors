// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runPrepareForTest } from "./authority.ts";
import type { Suite } from "./inventory.ts";

test("a suite's declared prepare materializes the actual generated module its child imports", async () => {
	const root = mkdtempSync(join(tmpdir(), "accounting-prepare-"));
	try {
		writeFileSync(join(root, ".gitignore"), "generated.mjs\n");
		writeFileSync(
			join(root, "consumer.mjs"),
			'import { value } from "./generated.mjs"; if(value !== "fixture") process.exit(2);\n',
		);
		execFileSync("git", ["init", "-q"], { cwd: root });
		const suite: Suite = {
			id: "generated-fixture",
			cwd: ".",
			loader: "node-test",
			authority_argument: null,
			command: [process.execPath, "consumer.mjs"],
			include: ["consumer.test.mjs"],
			profiles: ["default"],
			environment: { FIXTURE_GENERATED_VALUE: "fixture" },
			prepare: [
				process.execPath,
				"--input-type=module",
				"-e",
				'import {writeFileSync} from "node:fs"; writeFileSync("generated.mjs", `export const value = ${JSON.stringify(process.env.FIXTURE_GENERATED_VALUE)};`);',
			],
		};
		const execute = () =>
			spawnSync(process.execPath, ["consumer.mjs"], {
				cwd: root,
				encoding: "utf8",
			});
		const before = execute();
		assert.notEqual(before.status, 0);
		assert.match(before.stderr, /ERR_MODULE_NOT_FOUND/);
		const status = () =>
			execFileSync("git", ["status", "--porcelain=v1"], {
				cwd: root,
				encoding: "utf8",
			});
		const initialStatus = status();
		await runPrepareForTest(suite, root);
		assert.ok(existsSync(join(root, "generated.mjs")));
		assert.equal(execute().status, 0);
		assert.equal(status(), initialStatus);
		await assert.rejects(
			runPrepareForTest(
				{ ...suite, prepare: [process.execPath, "-e", "process.exit(3)"] },
				root,
			),
			/generated-fixture prepare failed \(exit 3/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

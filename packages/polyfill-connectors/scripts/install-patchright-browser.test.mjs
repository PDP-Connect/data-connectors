// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
	isTruthyEnv,
	needsShellForPatchrightSpawn,
} from "./install-patchright-browser.mjs";

test("needsShellForPatchrightSpawn enables shell on win32 so the .cmd PATH shim resolves", () => {
	assert.equal(needsShellForPatchrightSpawn("win32"), true);
});

test("needsShellForPatchrightSpawn leaves shell off on posix platforms", () => {
	assert.equal(needsShellForPatchrightSpawn("linux"), false);
	assert.equal(needsShellForPatchrightSpawn("darwin"), false);
});

test("isTruthyEnv treats undefined and falsy strings as false", () => {
	assert.equal(isTruthyEnv(undefined), false);
	for (const value of ["", "0", "false", "off", "FALSE", "OFF"]) {
		assert.equal(isTruthyEnv(value), false, `expected ${value} to be falsy`);
	}
});

test("isTruthyEnv treats any other string as true", () => {
	for (const value of ["1", "true", "yes", "on"]) {
		assert.equal(isTruthyEnv(value), true, `expected ${value} to be truthy`);
	}
});

for (const skip of [
	null,
	"PATCHRIGHT_SKIP_BROWSER_DOWNLOAD",
	"PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD",
]) {
	test(
		skip
			? skip + " still skips the browser download"
			: "Ubuntu 26.04 x64 follows the normal Patchright install path",
		() => {
			const script = fileURLToPath(
				new URL("./install-patchright-browser.mjs", import.meta.url),
			);
			const result = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`
      import childProcess from "node:child_process";
      import fs from "node:fs";
      import { syncBuiltinESMExports } from "node:module";
      Object.defineProperty(process, "platform", { value: "linux" });
      Object.defineProperty(process, "arch", { value: "x64" });
      const originalRead = fs.readFileSync;
      fs.readFileSync = function(path, ...args) {
        return path === "/etc/os-release" ? 'ID=ubuntu\\nVERSION_ID="26.04"\\n' : originalRead.call(this, path, ...args);
      };
      childProcess.spawnSync = (command, args, options) => {
        console.log(JSON.stringify({ command, args, options }));
        return { status: 0 };
      };
      syncBuiltinESMExports();
      delete process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD;
      delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
      delete process.env.PDPP_REQUIRE_PATCHRIGHT_BROWSER_DOWNLOAD;
      if (${JSON.stringify(skip)}) process.env[${JSON.stringify(skip)}] = "1";
      process.argv[1] = ${JSON.stringify(script)};
      await import(${JSON.stringify(new URL("./install-patchright-browser.mjs", import.meta.url).href)});
    `,
				],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
			if (skip) {
				assert.match(result.stdout, /skip env variable/);
				assert.doesNotMatch(result.stdout, /"command"/);
			} else {
				assert.deepEqual(JSON.parse(result.stdout), {
					command: "patchright",
					args: ["install", "chromium"],
					options: { shell: false, stdio: "inherit" },
				});
			}
		},
	);
}

test("macOS dependency installation skips bundled Chromium without needing a skip flag", () => {
	const script = fileURLToPath(
		new URL("./install-patchright-browser.mjs", import.meta.url),
	);
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"--eval",
			`
		Object.defineProperty(process, "platform", { value: "darwin" });
		delete process.env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD;
		delete process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD;
		process.env.PATH = "";
		process.argv[1] = ${JSON.stringify(script)};
		await import(${JSON.stringify(new URL("./install-patchright-browser.mjs", import.meta.url).href)});
	`,
		],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	// copy-assertion-ok: skipped bundled download must explain the required macOS system-Chrome installation.
	assert.match(result.stdout, /Chrome.*Applications/);
});

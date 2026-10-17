// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
	installArguments,
	packEnvironment,
	packPackage,
} from "./pack-test-support.mjs";

test("concurrent packs preserve root tarballs and use distinct destinations", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pack-support-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sentinel = path.join(root, "keep-me.tgz");
	await writeFile(sentinel, "sentinel");
	const run = async (command, args, options) => {
		assert.equal(command, "npm");
		assert.equal(options.cwd, root);
		assert.deepEqual(args.slice(0, 3), [
			"pack",
			"--foreground-scripts=false",
			"--pack-destination",
		]);
		await writeFile(path.join(args[3], "same-name.tgz"), args[3]);
	};
	const [a, b] = await Promise.all([
		packPackage(root, path.join(root, "a"), run),
		packPackage(root, path.join(root, "b"), run),
	]);
	assert.notEqual(a, b);
	assert.equal(await readFile(a, "utf8"), path.dirname(a));
	assert.equal(await readFile(b, "utf8"), path.dirname(b));
	assert.equal(await readFile(sentinel, "utf8"), "sentinel");
	assert.deepEqual(
		(await readdir(root)).filter((name) => name.endsWith(".tgz")),
		["keep-me.tgz"],
	);
	await assert.rejects(packPackage(root, path.dirname(a), run), {
		code: "EEXIST",
	});
});

test("failed or ambiguous packs fail without deleting other artifacts", async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), "pack-support-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(path.join(root, "keep.tgz"), "keep");
	await assert.rejects(
		packPackage(root, path.join(root, "failed"), async () => {
			throw new Error("synthetic prepack failure");
		}),
		/synthetic prepack failure/,
	);
	await assert.rejects(
		packPackage(root, path.join(root, "empty"), async () => {}),
		/expected exactly one/,
	);
	await assert.rejects(
		packPackage(root, path.join(root, "multiple"), async (_, args) => {
			await Promise.all(
				["a.tgz", "b.tgz"].map((name) =>
					writeFile(path.join(args[3], name), ""),
				),
			);
		}),
		/expected exactly one/,
	);
	assert.equal(await readFile(path.join(root, "keep.tgz"), "utf8"), "keep");
});

test("pack subprocess environment is allowlisted and run-local", () => {
	const env = packEnvironment("/run/example", {
		PATH: "/usr/bin",
		NODE_OPTIONS: "--require=/foreign.js",
		SECRET_CANARY: "not-for-children",
		npm_config_userconfig: "/foreign/npmrc",
		PLAYWRIGHT_BROWSERS_PATH: "/shared/browser-cache",
	});
	assert.equal(env.PATH, "/usr/bin");
	for (const name of [
		"NODE_OPTIONS",
		"SECRET_CANARY",
		"npm_config_userconfig",
		"PLAYWRIGHT_BROWSERS_PATH",
	])
		assert.equal(env[name], undefined);
	assert.equal(env.HOME, path.join("/run/example", "home"));
	assert.equal(env.TMPDIR, path.join("/run/example", "tmp"));
	assert.equal(env.npm_config_cache, path.join("/run/example", "npm-cache"));
	assert.equal(env.PATCHRIGHT_SKIP_BROWSER_DOWNLOAD, "");
	assert.equal(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD, "");
});

test("the install command forces the install hook to run", () => {
	const args = installArguments("/run/example/pack/pdpp.tgz");
	assert.ok(
		args.includes("--ignore-scripts=false"),
		"a global ignore-scripts must not skip the hook",
	);
	assert.ok(
		args.includes("--dangerously-allow-all-scripts"),
		"npm 11 and later must not hold the hook back for approval",
	);
	assert.equal(args.at(-1), "/run/example/pack/pdpp.tgz");
});

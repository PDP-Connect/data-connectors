// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";

// Deliberately omit arbitrary application secrets, NODE_OPTIONS, and npm
// configuration inherited from the invoking shell. Private-registry tests
// need an explicitly reviewed environment contract, not process.env spread.
export function packEnvironment(root, inherited = process.env) {
	const env = {};
	for (const name of [
		"PATH",
		"Path",
		"SystemRoot",
		"SYSTEMROOT",
		"COMSPEC",
		"PATHEXT",
		"LANG",
		"LC_ALL",
		"TZ",
	]) {
		if (inherited[name] !== undefined) env[name] = inherited[name];
	}
	return {
		...env,
		HOME: path.join(root, "home"),
		USERPROFILE: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TEMP: path.join(root, "tmp"),
		npm_config_cache: path.join(root, "npm-cache"),
		// Exercise the real postinstall, including its browser-install path.
		PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "",
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "",
	};
}

export async function packPackage(cwd, destination, run) {
	// Exclusive mkdir: never reuse a directory belonging to another run.
	await mkdir(destination);
	await run(
		"npm",
		["pack", "--foreground-scripts=false", "--pack-destination", destination],
		{ cwd },
	);
	const produced = (await readdir(destination)).filter((name) =>
		name.endsWith(".tgz"),
	);
	assert.equal(
		produced.length,
		1,
		`expected exactly one .tgz in ${destination}, found ${produced.length}`,
	);
	return path.join(destination, produced[0]);
}

/**
 * The arguments of the plain install of the packed tarball. The check exists
 * to run the package's install hook, so both flags are explicit: npm 11 and
 * later skip hooks that are not approved, and a global npm config can set
 * ignore-scripts. A command-line flag outranks that config.
 */
export function installArguments(tarball) {
	return [
		"install",
		"--no-audit",
		"--no-fund",
		"--ignore-scripts=false",
		"--dangerously-allow-all-scripts",
		tarball,
	];
}

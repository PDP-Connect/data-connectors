#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildPageshim } from "./build.mjs";
import { isPageShimCapable } from "./capabilities.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const connector = process.argv[2];
if (!connector || process.argv.length !== 3) {
	console.error("usage: npm run mobile:bundle -- <connector>");
	process.exit(2);
}
const manifestPath = join(REPO, "connectors", connector, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (!isPageShimCapable(manifest)) {
	console.error(`${connector} does not declare only PageShim-supported runtime bindings`);
	process.exit(2);
}

const output = join(REPO, ".tmp", "mobile-connectors", `${connector}.js`);
mkdirSync(dirname(output), { recursive: true });
await buildPageshim({ connector, outfile: output });
const harness = spawnSync(
	process.execPath,
	[
		"--test",
		`--test-name-pattern=${connector}`,
		"scripts/pageshim/pageshim.test.mjs",
	],
	{
		cwd: REPO,
		stdio: "inherit",
		env: { ...process.env, PAGESHIM_CONNECTOR: connector, PAGESHIM_BUNDLE: output },
	},
);
if (harness.error) throw harness.error;
if (harness.status !== 0) process.exit(harness.status ?? 1);
const digest = createHash("sha256").update(readFileSync(output)).digest("hex");
const size = statSync(output).size;
console.log(`file: ${output}`);
console.log(`size: ${size} bytes`);
console.log(`sha256: ${digest}`);

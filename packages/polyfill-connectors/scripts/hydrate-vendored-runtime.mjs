// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);

const vendoredPackages = [
	{
		name: "@pdpp/collector-runtime",
		tarball: "vendor/pdpp-collector-runtime-0.0.1.tgz",
	},
	{
		name: "@pdpp/connector-protocol",
		tarball: "vendor/pdpp-connector-protocol-0.0.1.tgz",
	},
];

await Promise.all(
	vendoredPackages.map(async ({ name, tarball }) => {
		const destination = path.join(
			packageRoot,
			"node_modules",
			...name.split("/"),
		);
		const tarballPath = path.join(packageRoot, tarball);
		const contents = execFileSync("tar", ["-tzf", tarballPath], {
			encoding: "utf8",
		});
		assert.match(
			contents,
			/package\/dist\/.*\.js/m,
			`${tarball} must contain runtime JavaScript`,
		);
		await rm(destination, { recursive: true, force: true });
		await mkdir(destination, { recursive: true });
		execFileSync("tar", [
			"-xzf",
			tarballPath,
			"-C",
			destination,
			"--strip-components=1",
		]);
		const packageJson = JSON.parse(
			await readFile(path.join(destination, "package.json"), "utf8"),
		);
		assert.equal(packageJson.name, name, `${tarball} must unpack ${name}`);
	}),
);

console.log(
	"PASS vendored runtime hydration: packed JavaScript restored before bundling.",
);

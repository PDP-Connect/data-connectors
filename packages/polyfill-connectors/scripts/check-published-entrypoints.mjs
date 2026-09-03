// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const packageJson = JSON.parse(
	await readFile(path.join(packageRoot, "package.json"), "utf8"),
);

const publishedEntrypoints = [
	...Object.entries(packageJson.bin ?? {}).map(([name, target]) => [
		`bin.${name}`,
		target,
	]),
	...Object.entries(packageJson.exports ?? {}),
];

await Promise.all(
	publishedEntrypoints.map(async ([name, target]) => {
		assert.equal(typeof target, "string", `${name} must resolve to one file`);
		assert.match(
			target,
			/\.js$/,
			`${name} must not publish a raw TypeScript target`,
		);
		await access(path.join(packageRoot, target));
	}),
);

await Promise.all(
	[
		"bin/local-device-exporter.js",
		"bin/test-fixture-capture.js",
		"src/local-device-runtime.js",
	].map(async (target) => {
		const source = await readFile(path.join(packageRoot, target), "utf8");
		assert.doesNotMatch(
			source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""),
			/(["'])[^"']+\.ts\1/,
			`${target} must not spawn or import a raw TypeScript file in the published package`,
		);
	}),
);

const staticSecretGenerator = await readFile(
	path.join(packageRoot, "scripts/generate-static-secret-registry.js"),
	"utf8",
);
assert.doesNotMatch(
	staticSecretGenerator,
	/manifest-registry\.ts/,
	"the static-secret generator must import the published manifest registry JavaScript",
);

console.log(
	`PASS published entrypoints: ${publishedEntrypoints.length} package targets and every known subprocess target resolve to JavaScript.`,
);

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const packageJson = JSON.parse(
	await readFile(path.join(packageRoot, "package.json"), "utf8"),
);
const execFileAsync = promisify(execFile);

const publishedEntrypoints = [
	...Object.entries(packageJson.bin ?? {}).map(([name, target]) => [
		`bin.${name}`,
		{ default: target },
	]),
	...Object.entries(packageJson.exports ?? {}),
];

await Promise.all(
	publishedEntrypoints.map(async ([name, entrypoint]) => {
		assert.equal(
			typeof entrypoint,
			"object",
			`${name} must resolve to one export condition object`,
		);
		assert.equal(
			typeof entrypoint.default,
			"string",
			`${name} must resolve to one JavaScript file`,
		);
		assert.match(
			entrypoint.default,
			/\.js$/,
			`${name} must not publish a raw TypeScript target`,
		);
		await access(path.join(packageRoot, entrypoint.default));

		if (name.startsWith("bin.")) {
			return;
		}

		assert.equal(
			typeof entrypoint.types,
			"string",
			`${name} must publish a TypeScript declaration target`,
		);
		assert.match(
			entrypoint.types,
			/\.d\.ts$/,
			`${name} types target must resolve to a declaration file`,
		);
		assert.equal(
			entrypoint.types,
			entrypoint.default.replace(/\.js$/, ".d.ts"),
			`${name} types target must describe its JavaScript target`,
		);
		await access(path.join(packageRoot, entrypoint.types));
		await access(path.join(packageRoot, `${entrypoint.types}.map`));
	}),
);

const packed = JSON.parse(
	(
		await execFileAsync(
			"npm",
			["pack", "--dry-run", "--json", "--ignore-scripts"],
			{ cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 },
		)
	).stdout,
);
const packManifest = Array.isArray(packed)
	? packed[0]
	: Object.values(packed)[0];
assert.ok(packManifest, "npm pack --dry-run must return one package manifest");
const packedPaths = new Set(packManifest.files?.map((file) => file.path));

for (const [name, entrypoint] of Object.entries(packageJson.exports ?? {})) {
	assert.equal(
		packedPaths.has(entrypoint.types.slice(2)),
		true,
		`${name} declaration must be included in npm pack output`,
	);
	assert.equal(
		packedPaths.has(`${entrypoint.types.slice(2)}.map`),
		true,
		`${name} declaration map must be included in npm pack output`,
	);
}

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
	`PASS published entrypoints: ${publishedEntrypoints.length} package targets resolve to JavaScript and every export declaration resolves from the packed tarball.`,
);

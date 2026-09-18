// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const manifestsDirectory = path.join(packageRoot, "manifests");
const indexPath = path.join(packageRoot, "connector-index.json");

async function buildIndex() {
	const manifestFiles = (await readdir(manifestsDirectory))
		.filter((file) => file.endsWith(".json"))
		.sort();
	const connectors = await Promise.all(
		manifestFiles.map(async (file) => {
			const manifest = JSON.parse(
				await readFile(path.join(manifestsDirectory, file), "utf8"),
			);
			assert.equal(
				typeof manifest.connector_id,
				"string",
				`${file} must declare connector_id`,
			);
			// brand is optional: a connector with no legitimately available brand mark
			// declares no brand object at all and falls back to the console's
			// deterministic monogram, rather than shipping an invented or hand-drawn
			// logo. See NOTICE and /home/tnunamak/code/pdpp/local/ICON-ART-0918.md.
			if (manifest.brand !== undefined) {
				assert.equal(
					typeof manifest.brand.icon,
					"string",
					`${file} must declare brand.icon when brand is present`,
				);
			}
			const connectorDirectory = file.slice(0, -".json".length);
			const entry = `./connectors/${connectorDirectory}/index.js`;
			const brandIcon =
				manifest.brand !== undefined
					? `./manifests/${manifest.brand.icon}`
					: undefined;
			await access(
				path.join(packageRoot, `./connectors/${connectorDirectory}/index.ts`),
			);
			if (brandIcon !== undefined) {
				await access(path.join(packageRoot, brandIcon));
			}
			return { brandIcon, connectorId: manifest.connector_id, entry, manifest };
		}),
	);
	return formatJson(`${JSON.stringify({ connectors, version: 1 }, null, 2)}\n`);
}

function formatJson(source) {
	return new Promise((resolve, reject) => {
		const biome = spawn(
			path.join(packageRoot, "node_modules", ".bin", "biome"),
			["format", "--stdin-file-path", indexPath],
		);
		let output = "";
		let error = "";
		biome.stdout.on("data", (chunk) => {
			output += chunk;
		});
		biome.stderr.on("data", (chunk) => {
			error += chunk;
		});
		biome.on("error", reject);
		biome.on("exit", (code) => {
			if (code === 0) {
				resolve(output);
			} else {
				reject(
					new Error(`Biome failed to format connector-index.json: ${error}`),
				);
			}
		});
		biome.stdin.end(source);
	});
}

const expected = await buildIndex();
if (process.argv.includes("--check")) {
	assert.equal(
		await readFile(indexPath, "utf8"),
		expected,
		"connector-index.json is stale; run npm run generate:connector-index",
	);
	process.stdout.write("PASS connector implementation index is current.\n");
} else {
	await writeFile(indexPath, expected);
	process.stdout.write("Wrote connector-index.json.\n");
}

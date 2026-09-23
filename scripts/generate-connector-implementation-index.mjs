// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const connectorsDirectory = path.join(repoRoot, "connectors");
const indexPath = path.join(repoRoot, "connector-implementation-index.json");

async function buildIndex() {
	const manifestFiles = (await readdir(connectorsDirectory))
		.filter((key) => existsSync(path.join(connectorsDirectory, key, "manifest.json")))
		.sort();
	const connectors = await Promise.all(
		manifestFiles.map(async (key) => {
			const manifest = JSON.parse(
				await readFile(path.join(connectorsDirectory, key, "manifest.json"), "utf8"),
			);
			assert.equal(
				typeof manifest.connector_id,
				"string",
				`${key} must declare connector_id`,
			);
			// brand is optional: a connector with no legitimately available brand mark
			// declares no brand object at all and falls back to the console's
			// deterministic monogram, rather than shipping an invented or hand-drawn
			// logo. See NOTICE and /home/tnunamak/code/pdpp/local/ICON-ART-0918.md.
			if (manifest.brand !== undefined) {
				assert.equal(
					typeof manifest.brand.icon,
					"string",
					`${key} must declare brand.icon when brand is present`,
				);
			}
			const entry = `./connectors/${key}/index.ts`;
			const brandIcon =
				manifest.brand !== undefined
					? `./connectors/${key}/${manifest.brand.icon}`
					: undefined;
			await access(
				path.join(repoRoot, entry),
			);
			if (brandIcon !== undefined) {
				await access(path.join(repoRoot, brandIcon));
			}
			return { brandIcon, connectorId: manifest.connector_id, entry, manifest };
		}),
	);
	return formatJson(`${JSON.stringify({ connectors, version: 1 }, null, 2)}\n`);
}

function formatJson(source) {
	return new Promise((resolve, reject) => {
		const biome = spawn(
			path.join(repoRoot, "node_modules", ".bin", "biome"),
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
					new Error(`Biome failed to format connector-implementation-index.json: ${error}`),
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
		"connector-implementation-index.json is stale; run npm run connector-implementation-index:generate",
	);
	process.stdout.write("PASS connector implementation index is current.\n");
} else {
	await writeFile(indexPath, expected);
	process.stdout.write("Wrote connector-implementation-index.json.\n");
}

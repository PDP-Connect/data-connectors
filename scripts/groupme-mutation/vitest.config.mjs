// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const toolsRoot = fileURLToPath(new URL("./tools/", import.meta.url));
const requireTool = createRequire(
	new URL("./tools/package.json", import.meta.url),
);
export const pins = {
	"@stryker-mutator/core": "10.0.0",
	"@stryker-mutator/vitest-runner": "10.0.0",
	vitest: "4.1.12",
	vite: "8.3.2",
};
const installCommand =
	"npm ci --prefix scripts/groupme-mutation/tools --ignore-scripts --no-audit --no-fund";
for (const [name, version] of Object.entries(pins)) {
	const manifest = join(toolsRoot, "node_modules", name, "package.json");
	if (!existsSync(manifest))
		throw new Error(
			`Isolated GroupMe mutation tool ${name} is not installed. Run from the repository root: ${installCommand}`,
		);
	const installed = JSON.parse(readFileSync(manifest, "utf8"));
	if (installed.name !== name || installed.version !== version) {
		throw new Error("Unexpected isolated tool version: " + name);
	}
}
export function resolveTool(specifier, packageName = specifier) {
	const root = realpathSync(join(toolsRoot, "node_modules", packageName));
	// Vitest's require entry intentionally rejects loading; tests need its ESM entry.
	const entry = realpathSync(
		specifier === "vitest"
			? join(root, "dist/index.js")
			: requireTool.resolve(specifier),
	);
	if (!entry.startsWith(root + sep))
		throw new Error("Tool escaped isolated package: " + specifier);
	return entry;
}
const { defineConfig } = await import(
	pathToFileURL(resolveTool("vitest/config", "vitest")).href
);
export default defineConfig({
	root: fileURLToPath(new URL("../../", import.meta.url)),
	resolve: {
		alias: [{ find: /^vitest$/, replacement: resolveTool("vitest") }],
	},
	test: {
		// Migrated native files are listed in vitest-files.mjs and passed explicitly.
		include: ["connectors/groupme/*.test.ts"],
		pool: "forks",
		isolate: true,
		minWorkers: 1,
		maxWorkers: 2,
		sequence: { concurrent: false },
		testTimeout: 120000,
		bail: 0,
		passWithNoTests: false,
	},
});

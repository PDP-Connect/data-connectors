// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const excluded = new Set(["connectors/github/index.test.ts"]);
export const patterns = [
	"bin/**/*.test.ts",
	"../../connectors/**/*.test.ts",
	"scripts/related-tests/*.test.ts",
	"scripts/**/*.test.mjs",
	"src/**/*.test.ts",
];

export function keyOf(file, cwd, root = repoRoot) {
	return relative(root, resolve(cwd, file)).split(sep).join("/");
}

export function partitionTests(discovered, roster, cwd, root = repoRoot) {
	// An empty ordinary discovery would otherwise pass with zero commands.
	if (discovered.length === 0)
		throw new Error(
			"No ordinary test files discovered; refusing to report success with zero tests",
		);
	const byPath = new Map();
	for (const file of discovered) {
		const key = keyOf(file, cwd, root);
		if (key.startsWith("../") || key === "..")
			throw new Error("Test outside repository: " + file);
		if (excluded.has(key)) continue;
		if (byPath.has(key)) throw new Error("Duplicate discovered test: " + key);
		byPath.set(key, file);
	}
	// A selection made only of excluded files would otherwise run zero commands and pass.
	if (byPath.size === 0)
		throw new Error(
			"Selected test files are all excluded; refusing to report success with zero tests",
		);
	const native = new Set();
	for (const key of roster) {
		if (
			typeof key !== "string" ||
			!/^connectors\/groupme\/[^/]+\.test\.ts$/.test(key)
		)
			throw new Error("Unknown native roster entry: " + key);
		if (native.has(key))
			throw new Error("Duplicate native roster entry: " + key);
		if (!byPath.has(key))
			throw new Error("Missing discovered native test: " + key);
		native.add(key);
	}
	return {
		node: [...byPath]
			.filter(([key]) => !native.has(key))
			.map(([, file]) => file),
		native: [...native].map((key) => resolve(root, key)),
	};
}

export async function commandsFor(parts, cwd) {
	const commands = [];
	if (parts.node.length)
		commands.push({
			command: process.execPath,
			args: [
				"--test",
				"--import",
				"tsx",
				"--test-concurrency=2",
				"--test-timeout=120000",
				...parts.node,
			],
			cwd,
		});
	if (parts.native.length) {
		// Import validates the isolated pins; an empty roster never loads or invokes Vitest.
		const { toolsRoot } = await import("./vitest.config.mjs");
		commands.push({
			command: process.execPath,
			args: [
				join(toolsRoot, "node_modules/vitest/vitest.mjs"),
				"run",
				"--config",
				fileURLToPath(new URL("./vitest.config.mjs", import.meta.url)),
				...parts.node
					.map((file) =>
						relative(repoRoot, resolve(cwd, file)).split(sep).join("/"),
					)
					.filter((file) => file.startsWith("connectors/groupme/"))
					.flatMap((file) => ["--exclude", file]),
				...parts.native,
			],
			cwd: repoRoot,
		});
	}
	return commands;
}

export async function runCommands(commands, options = {}) {
	const [current, ...rest] = commands;
	if (!current) return { code: 0, signal: null };
	const { command, args, cwd } = current;
	const result = await new Promise((resolveResult) => {
		const child = spawn(command, args, { cwd, stdio: "inherit", ...options });
		child.once("error", (error) =>
			resolveResult({ code: 1, signal: null, error: error.message }),
		);
		child.once("exit", (code, signal) => resolveResult({ code, signal }));
	});
	if (result.signal || result.code !== 0) return result;
	return runCommands(rest, options);
}

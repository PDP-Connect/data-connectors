// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VITEST_TESTS } from "./test-lanes.mjs";

const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vitestBin = join(
	dirname(require.resolve("vitest/package.json")),
	"vitest.mjs",
);
const vitestConfig = join(packageRoot, "vitest.config.mjs");

export function partitionTests(files, vitestFiles = VITEST_TESTS) {
	const nodeTests = [];
	const vitestTests = [];
	for (const file of files) {
		const registeredPath = file.startsWith("../../connectors/")
			? file.slice("../../".length)
			: file.startsWith("/") && file.includes("/connectors/")
				? file.slice(file.lastIndexOf("/connectors/") + 1)
				: file;
		(vitestFiles.has(registeredPath) ? vitestTests : nodeTests).push(file);
	}
	return { nodeTests, vitestTests };
}

export function testCommands(files, concurrency, vitestFiles = VITEST_TESTS) {
	const { nodeTests, vitestTests } = partitionTests(files, vitestFiles);
	const commands = [];
	if (nodeTests.length > 0) {
		commands.push({
			command: process.execPath,
			args: [
				"--test",
				"--import",
				"tsx",
				`--test-concurrency=${concurrency}`,
				"--test-timeout=120000",
				...nodeTests,
			],
		});
	}
	if (vitestTests.length > 0) {
		commands.push({
			command: process.execPath,
			args: [
				vitestBin,
				"run",
				"--config",
				vitestConfig,
				"--pool=forks",
				`--maxWorkers=${concurrency}`,
				"--testTimeout=120000",
				...vitestTests,
			],
		});
	}
	return commands;
}

export async function runTestCommands(commands, env = process.env) {
	let ok = true;
	for (const { command, args } of commands) {
		const result = await new Promise((done) => {
			const child = spawn(command, args, {
				cwd: packageRoot,
				env,
				stdio: "inherit",
			});
			child.on("error", (error) => done({ error }));
			child.on("exit", (code, signal) => done({ code, signal }));
		});
		if (result.signal) {
			process.kill(process.pid, result.signal);
			return false;
		}
		if (result.error) {
			console.error(result.error);
		}
		ok = result.code === 0 && ok;
	}
	return ok;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [, concurrency, ...files] = process.argv.slice(2);
	if (!/^[1-9][0-9]*$/.test(concurrency ?? "")) {
		console.error(
			"usage: node scripts/test-dispatch.mjs <concurrency> <test-files...>",
		);
		process.exit(2);
	}
	process.exit(
		(await runTestCommands(testCommands(files, concurrency))) ? 0 : 1,
	);
}

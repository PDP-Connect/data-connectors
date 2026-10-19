// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { VITEST_TESTS } from "./test-lanes.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const requireTestTools = createRequire(
	join(packageRoot, "test-tools", "package.json"),
);
const repositoryRoot = resolve(packageRoot, "../..");
const connectorsRoot = join(repositoryRoot, "connectors");
const vitestConfig = join(packageRoot, "vitest.config.mjs");
const vitestBin = join(
	packageRoot,
	"test-tools",
	"node_modules",
	"vitest",
	"vitest.mjs",
);

function requireInstalledVitest() {
	try {
		requireTestTools.resolve("./node_modules/vitest/package.json");
	} catch (error) {
		if (error?.code !== "MODULE_NOT_FOUND") throw error;
		throw new Error(
			"Vitest test tools are missing; run npm ci --prefix packages/polyfill-connectors/test-tools",
			{ cause: error },
		);
	}
}

export function partitionTests(files, vitestFiles = VITEST_TESTS) {
	const nodeTests = [];
	const vitestTests = [];
	for (const file of files) {
		const absoluteFile = resolve(packageRoot, file);
		let registeredPath = file;
		if (absoluteFile.startsWith(`${connectorsRoot}${sep}`)) {
			registeredPath = `connectors/${relative(connectorsRoot, absoluteFile).split(sep).join("/")}`;
		} else if (absoluteFile.startsWith(`${packageRoot}${sep}`)) {
			registeredPath = relative(packageRoot, absoluteFile).split(sep).join("/");
		}
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
		const exactFiles = vitestTests.map((file) =>
			relative(repositoryRoot, resolve(packageRoot, file)).split(sep).join("/"),
		);
		commands.push({
			kind: "vitest",
			command: process.execPath,
			env: { PDPP_VITEST_EXACT_FILES: JSON.stringify(exactFiles) },
			args: [
				vitestBin,
				"run",
				"--config",
				vitestConfig,
				"--pool=forks",
				`--maxWorkers=${concurrency}`,
				"--testTimeout=120000",
				...vitestTests.map((file) => resolve(packageRoot, file)),
			],
		});
	}
	return commands;
}

export async function runTestCommands(commands, env = process.env) {
	if (commands.some(({ kind }) => kind === "vitest")) requireInstalledVitest();
	let ok = true;
	for (const { command, args, env: commandEnv } of commands) {
		const result = await new Promise((done) => {
			const child = spawn(command, args, {
				cwd: packageRoot,
				env: commandEnv ? { ...env, ...commandEnv } : env,
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

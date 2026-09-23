// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Packs @pdpp/polyfill-connectors exactly as `npm pack` would for a real
// publish, then installs the resulting tarball into a scratch npm project
// with a PLAIN `npm install` — no `--ignore-scripts`, matching what `npm ci`
// does in a consuming repo's CI. This is the regression test for a real bug:
// this package's postinstall hook used to be a raw .ts file, and Node
// refuses to strip TypeScript types from any file under node_modules by
// policy (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — so every consumer's
// plain `npm ci` crashed at the install step, before any of that consumer's
// own code ever ran. Converting the hook to plain .mjs fixed it; this test
// exists so a future .ts postinstall (or any other install-time script this
// package adds) fails CI immediately instead of only surfacing downstream,
// in a different repo, at install time.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");

function log(message) {
	process.stdout.write(`${message}\n`);
}

async function run(command, args, options = {}) {
	try {
		return await execFileAsync(command, args, {
			maxBuffer: 10 * 1024 * 1024,
			...options,
		});
	} catch (error) {
		error.message += `\nCommand failed: ${command} ${args.join(" ")}`;
		if (error.stdout) {
			error.message += `\nstdout:\n${error.stdout}`;
		}
		if (error.stderr) {
			error.message += `\nstderr:\n${error.stderr}`;
		}
		throw error;
	}
}

async function packPackage(cwd) {
	const preExisting = (await readdir(cwd)).filter((name) =>
		name.endsWith(".tgz"),
	);
	await Promise.all(
		preExisting.map((name) => rm(path.join(cwd, name), { force: true })),
	);
	await run("npm", ["pack", "--foreground-scripts=false"], { cwd });
	const produced = (await readdir(cwd)).filter((name) => name.endsWith(".tgz"));
	assert.equal(
		produced.length,
		1,
		`expected exactly one .tgz in ${cwd}, found ${produced.length}`,
	);
	return path.join(cwd, produced[0]);
}

async function typecheckEveryExport(projectDir, installedPackage) {
	const installedPackageJson = JSON.parse(
		await readFile(path.join(installedPackage, "package.json"), "utf8"),
	);
	const imports = Object.keys(installedPackageJson.exports)
		.map((subpath) => `import "@pdpp/polyfill-connectors/${subpath.slice(2)}";`)
		.join("\n");
	const resolverUse = "";
	await writeFile(
		path.join(projectDir, "imports.ts"),
		`${imports}${resolverUse}\n`,
	);

	await Promise.all(
		[
			["NodeNext", { module: "NodeNext", moduleResolution: "NodeNext" }],
			["bundler", { module: "ESNext", moduleResolution: "Bundler" }],
		].map(async ([label, compilerOptions]) => {
			const configPath = path.join(projectDir, `tsconfig.${label}.json`);
			await writeFile(
				configPath,
				JSON.stringify(
					{
						compilerOptions: {
							strict: true,
							noEmit: true,
							target: "ES2023",
							skipLibCheck: true,
							...compilerOptions,
						},
						files: ["imports.ts"],
					},
					null,
					2,
				),
			);
			await run(
				path.join(projectDir, "node_modules", ".bin", "tsc"),
				["--project", configPath, "--noEmit"],
				{ cwd: projectDir },
			);
			log(
				`PASS TypeScript ${label}: all ${Object.keys(installedPackageJson.exports).length} export subpaths resolve.`,
			);
		}),
	);
}

async function main() {
	log("Packing @pdpp/polyfill-connectors...");
	const tarball = await packPackage(packageRoot);

	const tempRoot = await mkdtemp(
		path.join(tmpdir(), "pdpp-polyfill-connectors-pack-"),
	);
	const projectDir = path.join(tempRoot, "project");
	const env = {
		...process.env,
		HOME: path.join(tempRoot, "home"),
		npm_config_cache: path.join(tempRoot, "npm-cache"),
		// Deliberately UNSET, not "1": this is the exact condition a real
		// consumer's plain `npm ci` runs under, and the condition that
		// crashed before this file existed as .mjs. Setting the skip
		// var here would only prove the fast-exit branch loads, not that
		// the whole postinstall script is a loadable, executable .mjs file.
		PATCHRIGHT_SKIP_BROWSER_DOWNLOAD: "",
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "",
	};

	try {
		await mkdir(projectDir, { recursive: true });
		await run("npm", ["init", "-y"], { cwd: projectDir, env });

		// --dangerously-allow-all-scripts: npm >=11's "install scripts blocked
		// by default unless approved" safety net (see `npm help
		// install-scripts`) would otherwise silently SKIP the postinstall hook
		// here instead of running it — turning this into a false-pass test that
		// never actually exercises the hook. Real consumers running an older
		// npm (this repo's own CI matrix included, at the time this test was
		// written) have no such gate and run the hook unconditionally; this
		// flag makes the test behave the same way regardless of which npm
		// happens to be running it.
		log(
			"Installing the packed tarball with a plain `npm install` (postinstall forced to run)...",
		);
		const install = await run(
			"npm",
			[
				"install",
				"--no-audit",
				"--no-fund",
				"--dangerously-allow-all-scripts",
				tarball,
			],
			{ cwd: projectDir, env },
		);

		assert.doesNotMatch(
			`${install.stdout}\n${install.stderr}`,
			/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
			"postinstall must not crash trying to type-strip a .ts file under node_modules",
		);

		const installedPackage = path.join(
			projectDir,
			"node_modules",
			"@pdpp",
			"polyfill-connectors",
		);
		await run(
			"npm",
			[
				"install",
				"--no-audit",
				"--no-fund",
				"--save-dev",
				"typescript",
				"@types/node",
			],
			{ cwd: projectDir, env },
		);
		await typecheckEveryExport(projectDir, installedPackage);
		const installedMetadata = JSON.parse(
			await readFile(path.join(installedPackage, "package.json"), "utf8"),
		);
		const runtimeImports = Object.keys(installedMetadata.exports).map(
			(subpath) =>
				`await import("@pdpp/polyfill-connectors/${subpath.slice(2)}");`,
		);
		await writeFile(
			path.join(projectDir, "runtime-imports.mjs"),
			`import assert from "node:assert/strict";\n${runtimeImports.join("\n")}\n` +
				`const options = await import("@pdpp/polyfill-connectors/connector-options-schema");\n` +
				`const reasons = await import("@pdpp/polyfill-connectors/reason-display-messages");\n` +
				`assert.ok(options.connectorOptionsSchema("claude-code")?.options.length);\n` +
				`assert.ok(reasons.connectorReasonDisplayMessage("chatgpt", "http_error"));\n` +
				`console.log("runtime-imported");\n`,
		);
		const consumerEntrypoints = [
			{
				args: [path.join(projectDir, "runtime-imports.mjs")],
				label: "all runtime exports",
				output: "runtime-imported",
			},
		];

		await Promise.all(
			consumerEntrypoints.map(async (entrypoint) => {
				const result = await run(process.execPath, entrypoint.args, {
					cwd: projectDir,
					env,
				});
				const output = `${result.stdout}\n${result.stderr}`;
				assert.doesNotMatch(
					output,
					/ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/,
					`${entrypoint.label} must not execute raw TypeScript from node_modules`,
				);
				assert.match(output, new RegExp(entrypoint.output));
			}),
		);

		log(
			"PASS pack-install-run: plain npm install and every public consumer entrypoint succeeded.",
		);
	} finally {
		await rm(tarball, { force: true });
		await rm(tempRoot, { recursive: true, force: true });
	}
}

await main();

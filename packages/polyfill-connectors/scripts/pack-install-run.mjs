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
	stat,
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

async function resolveEveryPackedConnector(projectDir) {
	const scriptPath = path.join(projectDir, "resolve-every-connector.mjs");
	await writeFile(
		scriptPath,
		`import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConnectorImplementationNotFoundError,
  resolveConnectorImplementation,
} from "@pdpp/polyfill-connectors/resolve";

const resolverPath = fileURLToPath(import.meta.resolve("@pdpp/polyfill-connectors/resolve"));
const packageRoot = dirname(dirname(resolverPath));
const manifestsDirectory = join(packageRoot, "manifests");
const manifestFiles = (await readdir(manifestsDirectory))
  .filter((file) => file.endsWith(".json"))
  .sort();

for (const file of manifestFiles) {
  const manifest = JSON.parse(await readFile(join(manifestsDirectory, file), "utf8"));
  const implementation = resolveConnectorImplementation(manifest.connector_id);
  assert.equal(implementation.manifest.connector_id, manifest.connector_id);
  assert.match(implementation.entry, /^file:\\/\\//);
  assert.match(implementation.brandIcon, /^file:\\/\\//);
  await access(fileURLToPath(implementation.entry));
  await access(fileURLToPath(implementation.brandIcon));
}

await access(join(packageRoot, "config", "slackdump-api-config.toml"));

const directlyImportable = resolveConnectorImplementation(
  "https://registry.pdpp.dev/connectors/ynab",
);
await import(directlyImportable.entry);

assert.throws(
  () => resolveConnectorImplementation("https://registry.pdpp.dev/connectors/missing"),
  (error) =>
    error instanceof ConnectorImplementationNotFoundError &&
    error.code === "ERR_PDPP_CONNECTOR_IMPLEMENTATION_NOT_FOUND",
);
console.log(\`PASS resolver: \${manifestFiles.length} packed manifest connector IDs resolve to built entries.\`);
`,
	);
	const result = await run(process.execPath, [scriptPath], { cwd: projectDir });
	assert.match(
		`${result.stdout}\n${result.stderr}`,
		/PASS resolver: 45 packed manifest connector IDs resolve to built entries\./,
	);
	log(result.stdout.trim());
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
	const resolverUse = `
import { resolveConnectorImplementation } from "@pdpp/polyfill-connectors/resolve";
const resolvedConnector = resolveConnectorImplementation("https://registry.pdpp.dev/connectors/ynab");
const resolvedEntry: string = resolvedConnector.entry;
const resolvedBrandIcon: string = resolvedConnector.brandIcon;
const resolvedManifest: Record<string, unknown> = resolvedConnector.manifest;
void resolvedEntry;
void resolvedBrandIcon;
void resolvedManifest;`;
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
		await resolveEveryPackedConnector(projectDir);
		const generatedRegistry = path.join(tempRoot, "static-secret-registry.ts");
		const consumerEntrypoints = [
			{
				args: [
					path.join(
						projectDir,
						"node_modules",
						".bin",
						"pdpp-local-device-exporter",
					),
					"--help",
				],
				label: "pdpp-local-device-exporter",
				output: "usage: local-device-exporter",
			},
			{
				args: [
					path.join(
						installedPackage,
						"scripts",
						"generate-static-secret-registry.js",
					),
					generatedRegistry,
				],
				label: "generate-static-secret-registry",
				output: "wrote ",
			},
			{
				args: [
					"--input-type=module",
					"--eval",
					'import "@pdpp/polyfill-connectors/manifests"; console.log("manifests-imported")',
				],
				label: "manifests export",
				output: "manifests-imported",
			},
			{
				args: [
					"--input-type=module",
					"--eval",
					'import "@pdpp/polyfill-connectors/collectors"; console.log("collectors-imported")',
				],
				label: "collectors export",
				output: "collectors-imported",
			},
			{
				args: [
					"--input-type=module",
					"--eval",
					'import { readSampleRecord } from "@pdpp/polyfill-connectors/fixture-samples"; readSampleRecord("gmail", "messages"); console.log("fixture-samples-imported")',
				],
				label:
					"fixture-samples export (reads a real shipped fixture, not just imports)",
				output: "fixture-samples-imported",
			},
			{
				args: [
					"--input-type=module",
					"--eval",
					'import "@pdpp/polyfill-connectors/connectors/github"; console.log("github-connector-imported")',
				],
				label: "connectors/github export",
				output: "github-connector-imported",
			},
			{
				args: [
					"--input-type=module",
					"--eval",
					'import "@pdpp/polyfill-connectors/connectors/github/schemas"; console.log("github-schemas-imported")',
				],
				label: "connectors/github/schemas export",
				output: "github-schemas-imported",
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
		assert.equal((await stat(generatedRegistry)).isFile(), true);

		log(
			"PASS pack-install-run: plain npm install and every public consumer entrypoint succeeded.",
		);
	} finally {
		await rm(tarball, { force: true });
		await rm(tempRoot, { recursive: true, force: true });
	}
}

await main();

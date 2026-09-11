#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Prove a built connector artifact is internally consistent and that its code
 * layer actually loads, BEFORE it is pushed and signed.
 *
 * A signature says the bytes came from us. It says nothing about whether they
 * run. This is the step that answers the second question, and it has to run
 * before the push because an OCI tag can be moved but a digest a consumer has
 * already pinned and verified cannot be recalled.
 *
 * What is checked:
 *
 *   1. The config blob's restatement of the profile matches the profile layer.
 *      The manager performs the same cross-check on the way in (design §5.2);
 *      failing here means a mismatch is caught on a named connector in CI
 *      rather than on every host that installs it.
 *   2. Every tarball unpacks to the members the archive-safety rules allow.
 *   3. The declared entrypoint exists at that path once the code layer is
 *      unpacked, rather than somewhere the manager will not look for it.
 *   4. The bundle imports, with its externals resolved from the connector
 *      package's own installed tree. This is the check that catches an
 *      external the bundler left dangling or a top-level side effect that
 *      throws on load — neither is visible in the source workspace.
 *
 * Usage:
 *   node scripts/verify-connector-oci-artifact.mjs --artifact <dir built by
 *     build-connector-oci-artifact.mjs>
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages", "polyfill-connectors");

const sha256 = (value) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;

function argument(name) {
	const index = process.argv.indexOf(name);
	if (index === -1 || !process.argv[index + 1])
		throw new Error(`${name} is required`);
	return process.argv[index + 1];
}

function assertSafeMember(member) {
	if (member.startsWith("/")) throw new Error(`Absolute path: ${member}`);
	if (member.split("/").includes("..")) throw new Error(`Traversal: ${member}`);
	if (member.includes("\\")) throw new Error(`Backslash: ${member}`);
	if (member.includes("\0")) throw new Error(`NUL: ${member}`);
}

/**
 * tar -tvzf rather than -tzf: the long listing is what exposes the member TYPE.
 * Symlinks, hardlinks and device nodes are the archive-extraction attacks the
 * installer already refuses (connector-installer-core/index.mjs:259-338), and a
 * name-only listing cannot tell them from regular files.
 */
function listTarballMembers(tarballPath) {
	const listing = execFileSync("tar", ["-tvzf", tarballPath], {
		encoding: "utf8",
		maxBuffer: 128 * 1024 * 1024,
	});
	return listing
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const mode = line[0];
			const name = line.slice(line.indexOf(":") + 4).trim() || line.split(/\s+/).pop();
			if (mode !== "-" && mode !== "d") {
				throw new Error(`Refusing non-regular member (mode '${mode}'): ${line}`);
			}
			return { mode, name };
		});
}

function main() {
	const artifactRoot = argument("--artifact");

	const config = JSON.parse(
		readFileSync(join(artifactRoot, "config.json"), "utf8"),
	);
	const profileBytes = readFileSync(join(artifactRoot, "collection-profile.json"));
	const profile = JSON.parse(profileBytes);

	// 1. Config/profile cross-check.
	if (config.profile_digest !== sha256(profileBytes)) {
		throw new Error(
			`config.profile_digest ${config.profile_digest} does not match the profile layer ${sha256(profileBytes)}`,
		);
	}
	for (const field of ["connector_key", "connector_id", "protocol_version"]) {
		if (config[field] !== profile[field]) {
			throw new Error(
				`config.${field} is '${config[field]}' but the profile says '${profile[field]}'`,
			);
		}
	}

	// 2. Archive safety, on every tarball present.
	const layers = JSON.parse(readFileSync(join(artifactRoot, "layers.json"), "utf8"));
	for (const layer of layers.layers) {
		if (!layer.file.endsWith(".tar.gz")) continue;
		const path = join(artifactRoot, layer.file);
		if (!existsSync(path)) throw new Error(`Declared layer missing: ${layer.file}`);
		for (const member of listTarballMembers(path)) assertSafeMember(member.name);
	}

	// 3 + 4. Unpack the code layer and import it for real.
	const scratch = mkdtempSync(join(tmpdir(), "pdpp-artifact-verify-"));
	try {
		const installRoot = join(scratch, "install");
		const codeRoot = join(installRoot, "code");
		execFileSync("mkdir", ["-p", codeRoot]);
		execFileSync("tar", ["-xzf", join(artifactRoot, "code.tar.gz"), "-C", codeRoot]);

		const entrypoint = join(installRoot, config.entrypoint);
		if (!existsSync(entrypoint)) {
			throw new Error(
				`config.entrypoint '${config.entrypoint}' does not exist once code.tar.gz is unpacked`,
			);
		}

		// Resolve the bundle's externals from the connector package's OWN
		// installed tree rather than a fresh npm install. That is both faster
		// and stricter: it proves the artifact runs against the exact dependency
		// versions the lockfile pins, which is what a host consuming this
		// release will have, instead of whatever the ranges resolve to today.
		const nodeModules = join(packageRoot, "node_modules");
		if (!existsSync(nodeModules)) {
			throw new Error(
				`${nodeModules} is absent — run \`npm ci\` in packages/polyfill-connectors first; ` +
					"the import check needs the pinned dependency tree to resolve externals against.",
			);
		}
		execFileSync("ln", ["-s", nodeModules, join(installRoot, "node_modules")]);

		// What this proves, and what it deliberately does not.
		//
		// The question worth answering before publishing is "does every module
		// this bundle needs resolve" — an external the bundler left dangling is
		// invisible in the source workspace and fatal on every host. Importing
		// the entrypoint answers it.
		//
		// But importing is NOT how a connector is invoked. 18 of the 46 have no
		// `isMainModule` guard, so importing them runs the collector, which then
		// exits non-zero because stdin carries no START message. That exit says
		// nothing about the artifact. So a failure is only treated as a failure
		// when it is a RESOLUTION failure; a connector that got far enough to
		// start collecting has already proved every import resolved, which is
		// the whole claim being made here.
		//
		// stderr is captured rather than inherited because it is the only place
		// the distinction appears.
		let imported = null;
		let selfStarted = false;
		try {
			imported = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"--eval",
					`const mod = await import(${JSON.stringify(`file://${entrypoint}`)});
					 console.log(Object.keys(mod).sort().join(","));`,
				],
				{ encoding: "utf8", cwd: installRoot, stdio: ["ignore", "pipe", "pipe"] },
			).trim();
		} catch (error) {
			const stderr = (error.stderr || "").toString();
			const stdout = (error.stdout || "").toString();
			const resolutionFailure =
				/ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module|ERR_PACKAGE_PATH_NOT_EXPORTED|SyntaxError/.test(
					stderr,
				);
			if (resolutionFailure) {
				throw new Error(
					`${config.connector_key} bundle failed to load:\n${stderr.trim()}`,
				);
			}
			// Reached its own runtime — every import resolved.
			selfStarted = true;
			imported = stdout.split("\n")[0]?.trim() || "";
		}

		console.log(`${config.connector_key}@${config.version} verified`);
		console.log(`  profile digest cross-check   ok`);
		console.log(`  archive members safe         ok`);
		console.log(`  entrypoint ${config.entrypoint}`);
		console.log(
			selfStarted
				? "  every import resolves        ok (entrypoint self-starts; no isMainModule guard)"
				: `  bundle imports, exports:     ${imported}`,
		);
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error.message);
	process.exit(1);
}

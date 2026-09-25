// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { test } from "node:test";

const ROOT = new URL("..", import.meta.url);

function run(command, args) {
	return execFileSync(command, args, {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

test("runtime-support export builds, imports, and packs only its maintained artifact", async () => {
	const builtArtifacts = [
		"dist/runtime-support.mjs",
		"dist/runtime-support.d.ts",
	];
	const checkedInArtifacts = builtArtifacts.map((path) => {
		assert.equal(
			run("git", ["ls-files", "--error-unmatch", path]).trim(),
			path,
			`${path} is checked in so installs with ignored scripts can use it`,
		);
		return readFileSync(new URL(`../${path}`, import.meta.url));
	});

	run("npm", ["run", "runtime-support:build"]);

	for (const [index, path] of builtArtifacts.entries()) {
		assert.deepEqual(
			readFileSync(new URL(`../${path}`, import.meta.url)),
			checkedInArtifacts[index],
			`${path} matches the output rebuilt from source`,
		);
	}

	const buildInfo = JSON.parse(
		readFileSync(
			new URL("../dist/runtime-support.buildinfo.json", import.meta.url),
			"utf8",
		),
	);
	assert.ok(
		buildInfo.inputs.includes("packages/runtime-support/index.ts"),
		"runtime-support build input contract includes the public entry",
	);
	assert.ok(
		buildInfo.inputs.includes(
			"packages/polyfill-connectors/src/manual-upload-validation.ts",
		),
		"runtime-support build input contract includes manual-upload dispatch",
	);
	assert.ok(
		buildInfo.inputs.includes(
			"packages/polyfill-connectors/src/provider-auth-adapters.ts",
		),
		"runtime-support build input contract includes provider-auth dispatch",
	);
	assert.ok(
		buildInfo.inputs.some((input) => input.startsWith("connectors/")),
		"runtime-support build input contract tracks transitively bundled connector-owned validators/adapters",
	);
	assert.deepEqual(
		Object.keys(buildInfo.inputHashes).sort(),
		buildInfo.inputs,
		"runtime-support build hashes every esbuild metafile input",
	);
	for (const input of buildInfo.inputs) {
		assert.equal(
			buildInfo.inputHashes[input],
			sha256(new URL(`../${input}`, import.meta.url)),
			`runtime-support build input hash is current for ${input}`,
		);
	}

	const sourceMtime = Math.max(
		...buildInfo.inputs.map(
			(input) => statSync(new URL(`../${input}`, import.meta.url)).mtimeMs,
		),
	);
	const outputMtime = Math.min(
		statSync(new URL("../dist/runtime-support.mjs", import.meta.url)).mtimeMs,
		statSync(new URL("../dist/runtime-support.d.ts", import.meta.url)).mtimeMs,
		statSync(
			new URL("../dist/runtime-support.buildinfo.json", import.meta.url),
		).mtimeMs,
	);
	assert.ok(
		outputMtime >= sourceMtime,
		"runtime-support build output is fresh relative to every esbuild metafile input",
	);

	const support = await import(
		"@opendatalabs/data-connectors-tools/runtime-support"
	);
	assert.equal(typeof support.validateManualUploadArtifactByKind, "function");
	assert.equal(
		typeof support.validateManualUploadArtifactFromFileByKind,
		"function",
	);
	assert.equal(typeof support.resolveProviderAuthAdapter, "function");
	assert.equal(
		support.validateManualUploadArtifactByKind("unknown_kind", "payload"),
		null,
	);
	assert.ok(await support.resolveProviderAuthAdapter("oauth2_generic"));
	assert.ok(
		await support.resolveProviderAuthAdapter(
			"oauth2_access_type_resource_groups",
		),
	);

	const installerCore = await import(
		"@opendatalabs/data-connectors-tools/installer-core"
	);
	assert.ok(Object.keys(installerCore).length > 0);

	const packResult = JSON.parse(
		run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]),
	);
	// npm 12 returns an object keyed by package name; older npm versions return
	// an array. Keep the pack contract check usable across the supported npm
	// versions without weakening the file assertions below.
	const packed = Array.isArray(packResult)
		? packResult[0]
		: packResult["@opendatalabs/data-connectors-tools"];
	assert.ok(packed, "npm pack reports this package");
	const { files } = packed;
	const names = files.map((file) => file.path).sort();
	assert.ok(names.includes("dist/runtime-support.mjs"));
	assert.ok(names.includes("dist/runtime-support.d.ts"));
	assert.ok(
		names.includes("packages/connector-installer-core/index.mjs"),
		"existing installer-core API remains packed",
	);
	assert.deepEqual(
		names.filter((name) => name.startsWith("connectors/")),
		[],
		"runtime-support package must not publish the connector source tree",
	);
	assert.deepEqual(
		names.filter(
			(name) =>
				name.startsWith("packages/polyfill-connectors/") ||
				name.startsWith("packages/runtime-support/"),
		),
		[],
		"runtime-support package must publish only built artifacts, not source trees",
	);
});

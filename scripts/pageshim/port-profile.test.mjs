// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	readFileSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
	symlinkSync,
	renameSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import test from "node:test";
import { PUBLISHABLE_CONNECTORS } from "../connector-publish-allowlist.mjs";
import { isPageShimCapable } from "./capabilities.mjs";
import {
	PageShimPortProfileError,
	resolvePageShimPortProfile,
} from "./port-profile.mjs";

const repoFile = (path) => {
	try {
		return readFileSync(new URL(`../../${path}`, import.meta.url));
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
};

function profileReader(overrides = {}) {
	return (path) => {
		if (Object.hasOwn(overrides, path)) return overrides[path];
		return repoFile(path);
	};
}

function jsonProfile(connector, update = {}) {
	return Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			connector,
			importer: null,
			shim: null,
			modules: [],
			inject: [],
			...update,
		}),
	);
}

test("every publishable manifest with an eligible PageShim target has an associated port profile", () => {
	const connectors = PUBLISHABLE_CONNECTORS.flatMap(({ manifest }) => {
		const profile = JSON.parse(
			repoFile(`connectors/${manifest}/manifest.json`),
		);
		return profile.mobile?.pageshim && isPageShimCapable(profile)
			? [manifest]
			: [];
	});
	for (const connector of connectors) {
		const port = resolvePageShimPortProfile(connector, profileReader());
		assert.equal(port.connector, connector);
	}
	const anthropic = resolvePageShimPortProfile("anthropic", profileReader());
	assert.deepEqual(anthropic.modules, [
		"fs",
		"fs/promises",
		"os",
		"../../packages/polyfill-connectors/src/bounded-zip-archive.ts",
		"../../packages/polyfill-connectors/src/download-queue.ts",
		"../../packages/polyfill-connectors/src/playwright-download.ts",
	]);
	for (const connector of connectors.filter((name) => name !== "anthropic")) {
		assert.equal(
			resolvePageShimPortProfile(connector, profileReader()).empty,
			true,
		);
	}
});

test("a selected connector with no physical profile fails closed", () => {
	assert.throws(
		() =>
			resolvePageShimPortProfile("anthropic", (path) =>
				path === "scripts/pageshim/ports/anthropic.json"
					? null
					: repoFile(path),
			),
		(error) =>
			error instanceof PageShimPortProfileError &&
			/cannot read PageShim port profile/.test(error.message),
	);
});

test("a profile cannot route another connector or importer", () => {
	const path = "scripts/pageshim/ports/anthropic.json";
	assert.throws(
		() =>
			resolvePageShimPortProfile(
				"anthropic",
				profileReader({ [path]: jsonProfile("chatgpt") }),
			),
		/wrong connector/,
	);
	assert.throws(
		() =>
			resolvePageShimPortProfile(
				"anthropic",
				profileReader({
					[path]: jsonProfile("anthropic", {
						importer: "connectors/chatgpt/index.ts",
						shim: "scripts/pageshim/shims/anthropic-export.ts",
						modules: ["fs"],
					}),
				}),
			),
		/wrong importer/,
	);
});

test("missing or invalid selected shim and inject paths fail with the selected profile", () => {
	const path = "scripts/pageshim/ports/anthropic.json";
	const config = {
		importer: "connectors/anthropic/index.ts",
		shim: "scripts/pageshim/shims/missing.ts",
		modules: ["fs"],
	};
	assert.throws(
		() =>
			resolvePageShimPortProfile(
				"anthropic",
				profileReader({ [path]: jsonProfile("anthropic", config) }),
			),
		(error) =>
			error instanceof PageShimPortProfileError &&
			/cannot read PageShim port shim/.test(error.message),
	);
	assert.throws(
		() =>
			resolvePageShimPortProfile(
				"anthropic",
				profileReader({
					[path]: jsonProfile("anthropic", {
						...config,
						shim: "scripts/pageshim/shims/anthropic-export.ts",
						inject: ["../outside.js"],
					}),
				}),
			),
		/invalid inject path/,
	);
});

test("structural resolution defers stale mappings to the build boundary and rejects unresolved paths", () => {
	const path = "scripts/pageshim/ports/anthropic.json";
	const config = {
		importer: "connectors/anthropic/index.ts",
		shim: "scripts/pageshim/shims/anthropic-export.ts",
		modules: ["crypto"],
	};
	assert.doesNotThrow(() =>
		resolvePageShimPortProfile(
			"anthropic",
			profileReader({ [path]: jsonProfile("anthropic", config) }),
		),
	);
	assert.throws(
		() =>
			resolvePageShimPortProfile(
				"anthropic",
				profileReader({
					[path]: jsonProfile("anthropic", {
						...config,
						modules: ["../../packages/polyfill-connectors/src/missing.ts"],
					}),
					"connectors/anthropic/index.ts": Buffer.from(
						'import "../../packages/polyfill-connectors/src/missing.ts";\n',
					),
				}),
			),
		/cannot resolve module/,
	);
});

test("builtin profiles canonicalize node spellings and reject normalized duplicates", () => {
	const path = "scripts/pageshim/ports/anthropic.json";
	const config = {
		importer: "connectors/anthropic/index.ts",
		shim: "scripts/pageshim/shims/anthropic-export.ts",
	};
	assert.deepEqual(
		resolvePageShimPortProfile(
			"anthropic",
			profileReader({
				[path]: jsonProfile("anthropic", { ...config, modules: ["node:fs"] }),
			}),
		).modules,
		["fs"],
	);
	assert.throws(
		() =>
			resolvePageShimPortProfile(
				"anthropic",
				profileReader({
					[path]: jsonProfile("anthropic", {
						...config,
						modules: ["fs", "node:fs"],
					}),
				}),
			),
		/duplicate/,
	);
});

test("real esbuild port seam routes bare and node imports and rejects comment-only stale mappings", async (t) => {
	const { stubPlugin } = await import("./build.mjs");
	assert.equal(typeof stubPlugin, "function");
	const root = mkdtempSync(join(tmpdir(), "port-seam-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const importer = join(root, "index.js"),
		shim = join(root, "shim.js");
	writeFileSync(shim, 'export const marker = "physical-port";');
	for (const name of ["fs", "node:fs"]) {
		writeFileSync(
			importer,
			"import {marker} from " +
				JSON.stringify(name) +
				";globalThis.result=marker;",
		);
		const result = await esbuild.build({
			entryPoints: [importer],
			bundle: true,
			write: false,
			platform: "browser",
			plugins: [
				stubPlugin(
					new Set(),
					{ importer, shim, modules: ["fs"], inject: [], path: "fixture.json" },
					true,
				),
			],
		});
		assert.match(result.outputFiles[0].text, /physical-port/);
	}
	for (const source of [
		'// import "fs";\n globalThis.result=1;',
		'globalThis.result="fs";',
	]) {
		writeFileSync(importer, source);
		await assert.rejects(
			esbuild.build({
				entryPoints: [importer],
				bundle: true,
				write: false,
				logLevel: "silent",
				plugins: [
					stubPlugin(
						new Set(),
						{
							importer,
							shim,
							modules: ["fs"],
							inject: [],
							path: "fixture.json",
						},
						true,
					),
				],
			}),
			/stale module/,
		);
	}
});

test("two connector smoke bundles retain scope and state wiring", async (t) => {
	const { buildPageshim } = await import("./build.mjs");
	const root = mkdtempSync(join(tmpdir(), "port-smoke-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	for (const connector of ["anthropic", "youtube"]) {
		const outfile = join(root, connector + ".js");
		const result = await buildPageshim({ connector, outfile, minify: false });
		assert.ok(result.bytes > 0);
		const bundle = readFileSync(outfile, "utf8");
		assert.match(bundle, /supportsState/);
		assert.match(bundle, /initialState/);
		assert.match(bundle, /requestedScopeEntries/);
	}
});

function physicalBuilderFixture(t) {
	const root = mkdtempSync(join(tmpdir(), "port-physical-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	const put = (path, content) => {
		const target = join(repo, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
		return target;
	};
	// Relocate the actual builder and resolver, not a replacement reader. Only
	// unrelated consent rendering is stubbed; esbuild and capability checks are real.
	const builder = readFileSync(new URL("./build.mjs", import.meta.url), "utf8")
		.replace('"esbuild"', JSON.stringify(import.meta.resolve("esbuild")))
		.replace(
			'"./capabilities.mjs"',
			JSON.stringify(new URL("./capabilities.mjs", import.meta.url).href),
		);
	put("scripts/pageshim/build.mjs", builder);
	put(
		"scripts/pageshim/port-profile.mjs",
		readFileSync(new URL("./port-profile.mjs", import.meta.url)),
	);
	put(
		"scripts/consent-slice-resolution.mjs",
		'export const consentSlicePlugin = () => ({name: "fixture-consent", setup() {}});',
	);
	put(
		"packages/polyfill-connectors/scripts/consent-time-fields-render.mjs",
		"export const renderSlice = () => ({});",
	);
	const profile = "scripts/pageshim/ports/anthropic.json";
	const shim = "scripts/pageshim/shims/selected.js";
	const inject = "scripts/pageshim/inject/buffer.js";
	put(
		profile,
		jsonProfile("anthropic", {
			importer: "connectors/anthropic/index.ts",
			shim,
			modules: ["fs"],
			inject: [inject],
		}),
	);
	put(
		"connectors/anthropic/manifest.json",
		JSON.stringify({
			version: "1.0.0",
			streams: [{ name: "records" }],
			mobile: { pageshim: { entry: "../../../connectors/anthropic/index.ts" } },
		}),
	);
	put(
		"connectors/anthropic/index.ts",
		'import {marker} from "fs"; globalThis.fixtureResult = marker;',
	);
	put(shim, 'export const marker = "synthetic-regular-port";');
	put(inject, 'globalThis.syntheticInjection = "synthetic-external-bytes";');
	put("scripts/pageshim/shims/process.js", "export const process = {env: {}};");
	const run = () =>
		spawnSync(
			process.execPath,
			[
				join(repo, "scripts/pageshim/build.mjs"),
				"--connector",
				"anthropic",
				"--out",
				join(root, "bundle.js"),
			],
			{ encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
		);
	return { root, repo, put, profile, shim, inject, run };
}

test("public builder accepts regular physical port inputs", (t) => {
	const fixture = physicalBuilderFixture(t);
	const result = fixture.run();
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		readFileSync(join(fixture.root, "bundle.js"), "utf8"),
		/synthetic-external-bytes/,
	);
});

for (const selected of ["profile", "shim", "inject"]) {
	test(`public builder rejects selected ${selected} link escape after regular control`, (t) => {
		const fixture = physicalBuilderFixture(t);
		const target = join(fixture.repo, fixture[selected]);
		const outside = join(fixture.root, "outside");
		writeFileSync(outside, readFileSync(target));
		rmSync(target);
		symlinkSync(outside, target);
		const result = fixture.run();
		assert.notEqual(
			result.status,
			0,
			`Unsafe selected ${selected} link was accepted by the actual builder: ${result.stdout}`,
		);
		assert.match(result.stderr, /symbolic link/);
	});
}

test("public builder rejects a selected input's linked ancestor", (t) => {
	const fixture = physicalBuilderFixture(t);
	const ancestor = join(fixture.repo, "scripts/pageshim/inject");
	const outside = join(fixture.root, "outside-directory");
	renameSync(ancestor, outside);
	symlinkSync(outside, ancestor, "dir");
	const result = fixture.run();
	assert.notEqual(
		result.status,
		0,
		`Unsafe ancestor link was accepted: ${result.stdout}`,
	);
	assert.match(result.stderr, /symbolic link/);
});

test("public builder rejects a transitive selected input link escape", (t) => {
	const fixture = physicalBuilderFixture(t);
	fixture.put(fixture.inject, 'import "./child.js"; globalThis.portChild = true;');
	const outside = join(fixture.root, "outside-child.js");
	writeFileSync(outside, "globalThis.portChild = false;");
	symlinkSync(outside, join(fixture.repo, "scripts/pageshim/inject/child.js"));
	const result = fixture.run();
	assert.notEqual(
		result.status,
		0,
		`Unsafe transitive selected input link was accepted: ${result.stdout}`,
	);
	assert.match(result.stderr, /symbolic link|outside trusted repository/);
});

test("public builder rejects a transitive selected input linked ancestor", (t) => {
	const fixture = physicalBuilderFixture(t);
	fixture.put(fixture.inject, 'import "./nested/child.js";');
	const outside = join(fixture.root, "outside-nested");
	mkdirSync(outside);
	writeFileSync(join(outside, "child.js"), "globalThis.portChild = true;");
	symlinkSync(outside, join(fixture.repo, "scripts/pageshim/inject/nested"), "dir");
	const result = fixture.run();
	assert.notEqual(
		result.status,
		0,
		`Unsafe transitive selected input ancestor was accepted: ${result.stdout}`,
	);
	assert.match(result.stderr, /symbolic link|outside trusted repository/);
});

test("public builder checks static require descendants at esbuild resolution", (t) => {
	const fixture = physicalBuilderFixture(t);
	fixture.put(fixture.inject, 'globalThis.portChild = require("./child.cjs");');
	const child = join(fixture.repo, "scripts/pageshim/inject/child.cjs");
	fixture.put("scripts/pageshim/inject/child.cjs", 'module.exports = "regular";');
	const regular = fixture.run();
	assert.equal(regular.status, 0, regular.stderr);
	const outside = join(fixture.root, "outside-child.cjs");
	writeFileSync(outside, 'module.exports = "outside";');
	rmSync(child);
	symlinkSync(outside, child);
	const result = fixture.run();
	assert.notEqual(
		result.status,
		0,
		`Unsafe static require descendant was accepted: ${result.stdout}`,
	);
	assert.match(result.stderr, /symbolic link|escapes repository/);
});

test("public builder rejects a transitive FIFO before esbuild reads it", (t) => {
	const fixture = physicalBuilderFixture(t);
	fixture.put(fixture.inject, 'globalThis.portChild = require("./child.cjs");');
	const target = join(fixture.repo, "scripts/pageshim/inject/child.cjs");
	const fifo = spawnSync("mkfifo", [target], {
		encoding: "utf8",
		timeout: 1000,
	});
	assert.equal(fifo.status, 0, fifo.stderr);
	const result = fixture.run();
	assert.equal(
		result.error,
		undefined,
		"transitive FIFO must be refused before a native read can block",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not a regular file/);
});

test("public builder rejects directory and FIFO inputs without blocking", (t) => {
	const fixture = physicalBuilderFixture(t);
	const target = join(fixture.repo, fixture.inject);
	rmSync(target);
	mkdirSync(target);
	const directory = fixture.run();
	assert.notEqual(directory.status, 0);
	assert.match(directory.stderr, /not a regular file/);
	rmSync(target, { recursive: true });
	const fifo = spawnSync("mkfifo", [target], {
		encoding: "utf8",
		timeout: 1000,
	});
	assert.equal(fifo.status, 0, fifo.stderr);
	const result = fixture.run();
	assert.equal(
		result.error,
		undefined,
		"FIFO must be rejected before read, not killed by timeout",
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /not a regular file/);
});

test("public builder rejects non-directory ancestors", (t) => {
	const fixture = physicalBuilderFixture(t);
	const ancestor = join(fixture.repo, "scripts/pageshim/inject");
	rmSync(ancestor, { recursive: true });
	writeFileSync(ancestor, "not a directory");
	const result = fixture.run();
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /ancestor is not a directory/);
});

test("relative module candidates do not hide unsafe input errors", (t) => {
	const fixture = physicalBuilderFixture(t);
	const target = "connectors/anthropic/candidate.ts";
	fixture.put(target, "export {};");
	fixture.put(
		fixture.profile,
		jsonProfile("anthropic", {
			importer: "connectors/anthropic/index.ts",
			shim: fixture.shim,
			modules: ["./candidate"],
			inject: [fixture.inject],
		}),
	);
	fixture.put("connectors/anthropic/index.ts", 'import "./candidate";');
	fixture.put("connectors/anthropic/candidate.js", "export {};");
	rmSync(join(fixture.repo, target));
	mkdirSync(join(fixture.repo, target));
	const result = fixture.run();
	assert.notEqual(
		result.status,
		0,
		"Unsafe .ts candidate must not fall through to regular .js",
	);
	assert.match(result.stderr, /not a regular file/);
});

test("physical reader loads with pure Node and validates normalized paths below its canonical root", (t) => {
	const fixture = physicalBuilderFixture(t);
	const script = [
		'import assert from "node:assert/strict";',
		"import {createPageShimPortFileReader} from " +
			JSON.stringify(
				pathToFileURL(join(fixture.repo, "scripts/pageshim/port-profile.mjs"))
					.href,
			) +
			";",
		"const read = createPageShimPortFileReader(" +
			JSON.stringify(fixture.repo + "/scripts/..") +
			");",
		"assert.ok(Buffer.isBuffer(read(" + JSON.stringify(fixture.inject) + ")));",
		'assert.equal(read("missing/file.js"), null);',
		"for (const path of " +
			JSON.stringify([
				"../escape",
				"/absolute",
				"./relative",
				"a//b",
				"a/../b",
				"C:/escape",
				"a\\b",
				"a\0b",
			]) +
			") assert.throws(() => read(path), /invalid physical input path/);",
	].join("\n");
	const result = spawnSync(
		process.execPath,
		["--input-type=module", "-e", script],
		{ encoding: "utf8", timeout: 5000 },
	);
	assert.equal(result.status, 0, result.stderr);
});

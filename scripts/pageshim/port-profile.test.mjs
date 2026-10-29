// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	readFileSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

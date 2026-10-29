// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
	return Buffer.from(JSON.stringify({
		schemaVersion: 1,
		connector,
		importer: null,
		shim: null,
		modules: [],
		inject: [],
		...update,
	}));
}

test("every publishable manifest with an eligible PageShim target has an associated port profile", () => {
	const connectors = PUBLISHABLE_CONNECTORS.flatMap(({ manifest }) => {
		const profile = JSON.parse(repoFile(`connectors/${manifest}/manifest.json`));
		return profile.mobile?.pageshim && isPageShimCapable(profile) ? [manifest] : [];
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
		assert.equal(resolvePageShimPortProfile(connector, profileReader()).empty, true);
	}
});

test("a selected connector with no physical profile fails closed", () => {
	assert.throws(
		() => resolvePageShimPortProfile("anthropic", (path) => path === "scripts/pageshim/ports/anthropic.json" ? null : repoFile(path)),
		(error) => error instanceof PageShimPortProfileError && /cannot read PageShim port profile/.test(error.message),
	);
});

test("a profile cannot route another connector or importer", () => {
	const path = "scripts/pageshim/ports/anthropic.json";
	assert.throws(
		() => resolvePageShimPortProfile("anthropic", profileReader({ [path]: jsonProfile("chatgpt") })),
		/wrong connector/,
	);
	assert.throws(
		() => resolvePageShimPortProfile("anthropic", profileReader({ [path]: jsonProfile("anthropic", {
			importer: "connectors/chatgpt/index.ts",
			shim: "scripts/pageshim/shims/anthropic-export.ts",
			modules: ["fs"],
		}) })),
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
		() => resolvePageShimPortProfile("anthropic", profileReader({ [path]: jsonProfile("anthropic", config) })),
		(error) => error instanceof PageShimPortProfileError && /cannot read PageShim port shim/.test(error.message),
	);
	assert.throws(
		() => resolvePageShimPortProfile("anthropic", profileReader({ [path]: jsonProfile("anthropic", {
			...config,
			shim: "scripts/pageshim/shims/anthropic-export.ts",
			inject: ["../outside.js"],
		}) })),
		/invalid inject path/,
	);
});

test("stale module mappings and unresolved source imports are rejected", () => {
	const path = "scripts/pageshim/ports/anthropic.json";
	const config = {
		importer: "connectors/anthropic/index.ts",
		shim: "scripts/pageshim/shims/anthropic-export.ts",
		modules: ["crypto"],
	};
	assert.throws(
		() => resolvePageShimPortProfile("anthropic", profileReader({ [path]: jsonProfile("anthropic", config) })),
		/stale module/,
	);
	assert.throws(
		() => resolvePageShimPortProfile("anthropic", profileReader({
			[path]: jsonProfile("anthropic", {
				...config,
				modules: ["../../packages/polyfill-connectors/src/missing.ts"],
			}),
			"connectors/anthropic/index.ts": Buffer.from(
				'import "../../packages/polyfill-connectors/src/missing.ts";\n',
			),
		})),
		/cannot resolve module/,
	);
});

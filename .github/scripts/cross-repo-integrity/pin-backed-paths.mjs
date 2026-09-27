#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Decide whether a data-connectors diff changes the consumer-side inputs backed by a
 * cross-repository pin. The pin-freshness workflow uses this only for pull requests:
 * a stale producer pin is actionable on this PR when the PR changes the bytes that the
 * corresponding drift job compares.
 */

import { isComparedConnectorFile } from "./compared-connector-file.mjs";

const PIN_FILE = ".github/cross-repo-pins.json";

// The bundled set comes from the canonical registry, the same source
// check-connector-source-drift.mjs uses. Node 24 strips the registry's types on import.
const registryUrl = new URL("../../../packages/polyfill-connectors/src/collector-registry.ts", import.meta.url);
const { LOCAL_COLLECTOR_DEFINITIONS } = await import(registryUrl.href);
const BUNDLED_CONNECTOR_DIRS = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => `connectors/${definition.connector_id}`);

const PIN_BACKED_ARTIFACTS = {
	"data-connect": new Set([
		"packages/polyfill-connectors/vendor/SHA256SUMS",
		"packages/polyfill-connectors/vendor/pdpp-collector-runtime-0.0.1.tgz",
		"packages/polyfill-connectors/vendor/pdpp-connector-protocol-0.0.1.tgz",
	]),
	pdpp: new Set([
		"packages/polyfill-connectors/vendor/SHA256SUMS",
		"packages/polyfill-connectors/vendor/pdpp-reference-contract-0.0.1.tgz",
	]),
};

function isComparedConnectorPath(path) {
	const directory = BUNDLED_CONNECTOR_DIRS.find((candidate) => path.startsWith(`${candidate}/`));
	return directory !== undefined && isComparedConnectorFile(path.slice(directory.length + 1));
}

export function isPinBackedPath(path, repo) {
	if (path === PIN_FILE) return true;
	if (!Object.hasOwn(PIN_BACKED_ARTIFACTS, repo)) {
		throw new Error(`unknown pin repository: ${repo}`);
	}

	if (repo === "data-connect") {
		return path === "packages/polyfill-connectors/src/collector-registry.ts" || isComparedConnectorPath(path) || PIN_BACKED_ARTIFACTS[repo].has(path);
	}

	return PIN_BACKED_ARTIFACTS[repo].has(path);
}

export function touchesPinBackedPaths(changedPaths, repo) {
	return changedPaths.some((path) => isPinBackedPath(path, repo));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const repo = process.argv[2];
	if (!repo) {
		console.error("usage: pin-backed-paths.mjs <data-connect|pdpp>");
		process.exit(1);
	}

	const input = await new Promise((resolve) => {
		let value = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (value += chunk));
		process.stdin.on("end", () => resolve(value));
	});
	const changedPaths = input.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);

	process.stdout.write(`${touchesPinBackedPaths(changedPaths, repo)}\n`);
}

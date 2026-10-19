#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Decide whether a data-connectors diff changes the consumer-side inputs backed by a
 * cross-repository pin. The pin-freshness workflow uses this only for pull requests:
 * a stale producer pin is actionable on this PR when the PR changes the bytes that the
 * corresponding drift job compares.
 */

const PIN_FILE = ".github/cross-repo-pins.json";

// collector-registry.ts imports every connectors/<id>/collector-definition.ts, and the
// collection-profile-pins job loads that registry, so each one is an input to that job.
const COLLECTOR_DEFINITION = /^connectors\/[^/]+\/collector-definition\.ts$/;

const PIN_BACKED_ARTIFACTS = {
	"data-connect": new Set([
		// Read by the collection-profile-pins drift job.
		"packages/polyfill-connectors/src/collector-registry.ts",
		// Read by the collection-profile-pins drift job: the publish inventory.
		"scripts/connector-publish-allowlist.mjs",
		"packages/polyfill-connectors/vendor/SHA256SUMS",
		"packages/polyfill-connectors/vendor/pdpp-collector-runtime-0.0.1.tgz",
		"packages/polyfill-connectors/vendor/pdpp-connector-protocol-0.0.1.tgz",
	]),
	pdpp: new Set([
		"packages/polyfill-connectors/vendor/SHA256SUMS",
		"packages/polyfill-connectors/vendor/pdpp-reference-contract-0.0.1.tgz",
	]),
};

export function isPinBackedPath(path, repo) {
	if (path === PIN_FILE) return true;
	if (!Object.hasOwn(PIN_BACKED_ARTIFACTS, repo)) {
		throw new Error(`unknown pin repository: ${repo}`);
	}

	if (repo === "data-connect" && COLLECTOR_DEFINITION.test(path)) return true;
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

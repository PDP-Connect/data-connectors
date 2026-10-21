#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Permanent old-data identities and shapes. Executable release metadata and
// fixture proofs belong to the temporary F10 lane, not this reference set.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function checkFrozenLegacyShapes(directory = root) {
	const read = (path) =>
		JSON.parse(readFileSync(join(directory, path), "utf8"));
	const pinned = read("scripts/frozen-legacy-contracts.sha256.json");
	const shapes = read("legacy-shapes.json");
	assert.deepEqual(Object.keys(shapes).sort(), ["schemaVersion", "scopes"]);
	assert.equal(shapes.schemaVersion, 1);
	assert.equal(
		shapes.scopes.length,
		pinned.scopeCount,
		"frozen scope count changed",
	);
	const ids = new Set();
	const referenced = new Set(["legacy-shapes.json"]);
	for (const scope of shapes.scopes) {
		assert.deepEqual(Object.keys(scope).sort(), ["id", "schemaPath"]);
		assert.equal(typeof scope.id, "string");
		assert.ok(
			scope.id.length > 0 && !ids.has(scope.id),
			"duplicate or empty frozen scope ID",
		);
		ids.add(scope.id);
		assert.match(scope.schemaPath, /^connectors\/[^/]+\/schemas\/[^/]+\.json$/);
		referenced.add(scope.schemaPath);
	}
	assert.deepEqual(
		[...referenced].sort(),
		Object.keys(pinned.sha256).sort(),
		"permanent shape reference set changed",
	);
	for (const [path, expected] of Object.entries(pinned.sha256)) {
		const actual = createHash("sha256")
			.update(readFileSync(join(directory, path)))
			.digest("hex");
		assert.equal(actual, expected, `${path} changed from its frozen bytes`);
	}
	return { files: referenced.size, scopes: ids.size };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const result = checkFrozenLegacyShapes();
	console.log(
		`PASS frozen legacy shapes: ${result.files} files, ${result.scopes} scope IDs`,
	);
}

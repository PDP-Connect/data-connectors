#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Temporary release metadata and fixture proofs: remove with F10. This does not
// build, sign, publish, or require retired executable artifacts in the tree.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const retention = "artifacts/legacy-retention";

export function checkLegacyRetention(directory = root) {
	const read = (path) =>
		JSON.parse(readFileSync(join(directory, path), "utf8"));
	const pinned = read(`${retention}/sha256.json`);
	// Hash metadata before interpreting it, so a broken snapshot fails as such.
	for (const path of [
		`${retention}/connector-index.json`,
		`${retention}/fixture-index.json`,
	]) {
		assert.ok(
			path in pinned.sha256,
			"temporary retention reference set changed",
		);
		const actual = createHash("sha256")
			.update(readFileSync(join(directory, path)))
			.digest("hex");
		assert.equal(
			actual,
			pinned.sha256[path],
			`${path} changed from its frozen bytes`,
		);
	}
	const fixtures = read(`${retention}/fixture-index.json`).fixtures;
	assert.equal(
		fixtures.length,
		pinned.fixtureCount,
		"frozen fixture count changed",
	);
	const shapes = new Map(
		read("legacy-shapes.json").scopes.map((scope) => [
			scope.id,
			scope.schemaPath,
		]),
	);
	const referenced = new Set([
		`${retention}/connector-index.json`,
		`${retention}/fixture-index.json`,
	]);
	const ids = new Set();
	for (const fixture of fixtures) {
		assert.ok(!ids.has(fixture.id), "duplicate frozen fixture ID");
		ids.add(fixture.id);
		assert.match(fixture.path, /^connectors\/[^/]+\/fixtures\/[^/]+\.json$/);
		assert.ok(
			shapes.has(fixture.scope),
			`${fixture.path} must reference a permanent scope`,
		);
		assert.equal(
			fixture.schemaPath,
			shapes.get(fixture.scope),
			`${fixture.path} must reference its permanent schema`,
		);
		referenced.add(fixture.path);
	}
	assert.deepEqual(
		[...referenced].sort(),
		Object.keys(pinned.sha256).sort(),
		"temporary retention reference set changed",
	);
	for (const [path, expected] of Object.entries(pinned.sha256)) {
		const actual = createHash("sha256")
			.update(readFileSync(join(directory, path)))
			.digest("hex");
		assert.equal(actual, expected, `${path} changed from its frozen bytes`);
	}
	for (const fixture of fixtures) {
		assert.equal(
			fixture.sha256,
			`sha256:${pinned.sha256[fixture.path]}`,
			`${fixture.path} index digest changed`,
		);
		assert.equal(
			fixture.sizeBytes,
			readFileSync(join(directory, fixture.path)).length,
			`${fixture.path} index size changed`,
		);
	}
	return { files: referenced.size, fixtures: fixtures.length };
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const result = checkLegacyRetention();
	console.log(
		`PASS temporary legacy retention (F10): ${result.files} files, ${result.fixtures} fixtures`,
	);
}

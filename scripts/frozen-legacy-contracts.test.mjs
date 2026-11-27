// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkFrozenLegacyShapes } from "./check-frozen-legacy-contracts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const permanentPins = "scripts/frozen-legacy-contracts.sha256.json";
const temporaryPins = "artifacts/legacy-retention/sha256.json";
const mapping = "legacy-shapes.json";
const release = "artifacts/legacy-retention/connector-index.json";
const fixtures = "artifacts/legacy-retention/fixture-index.json";
const read = (dir, path) => JSON.parse(readFileSync(join(dir, path), "utf8"));
const write = (dir, path, data) =>
	writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`);

function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), "legacy-contracts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const paths = new Set([permanentPins, "SCOPES.md"]);
	for (const pins of [permanentPins]) {
		for (const path of Object.keys(read(root, pins).sha256)) paths.add(path);
	}
	for (const path of paths) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		cpSync(join(root, path), join(dir, path));
	}
	return dir;
}

test("all 54 permanent frozen scope shapes pass without temporary files", (t) => {
	const dir = sandbox(t);
	assert.equal(read(dir, mapping).scopes.length, 54);
	checkFrozenLegacyShapes(dir);
});

for (const change of ["id", "schema"]) {
	test(`permanent check rejects changed ${change}`, (t) => {
		const dir = sandbox(t);
		if (change === "id") {
			const shapes = read(dir, mapping);
			shapes.scopes[0].id += ".changed";
			write(dir, mapping, shapes);
		} else {
			writeFileSync(join(dir, read(dir, mapping).scopes[0].schemaPath), "{}\n");
		}
		assert.throws(() => checkFrozenLegacyShapes(dir), /frozen bytes/);
	});
}

test("permanent check is independent of temporary metadata and its pins", (t) => {
	const dir = sandbox(t);
	for (const path of [release, fixtures, temporaryPins]) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), "invalid temporary metadata");
	}
	checkFrozenLegacyShapes(dir);
});

for (const pins of [permanentPins]) {
	for (const change of ["extra", "missing"]) {
		test(`${pins} rejects ${change} pinned references`, (t) => {
			const dir = sandbox(t);
			const data = read(dir, pins);
			if (change === "extra") data.sha256["unrelated.json"] = "0".repeat(64);
			else delete data.sha256[Object.keys(data.sha256)[0]];
			write(dir, pins, data);
			assert.throws(() => checkFrozenLegacyShapes(dir), /reference set/);
		});
	}
}

test("permanent lane rejects drifted generated scope documentation", (t) => {
	const dir = sandbox(t);
	writeFileSync(join(dir, "SCOPES.md"), "# Drifted scope documentation\n");
	assert.throws(() => checkFrozenLegacyShapes(dir), /SCOPES\.md is stale/);
});

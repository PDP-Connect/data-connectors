// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { checkLegacyRetention } from "./check-legacy-retention.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const permanentPins = "scripts/frozen-legacy-contracts.sha256.json";
const temporaryPins = "artifacts/legacy-retention/sha256.json";
const mapping = "legacy-shapes.json";
const release = "artifacts/legacy-retention/connector-index.json";
const fixtures = "artifacts/legacy-retention/fixture-index.json";
const read = (dir, path) => JSON.parse(readFileSync(join(dir, path), "utf8"));
const write = (dir, path, data) =>
	writeFileSync(join(dir, path), `${JSON.stringify(data, null, 2)}\n`);
const digest = (dir, path) =>
	createHash("sha256")
		.update(readFileSync(join(dir, path)))
		.digest("hex");

function sandbox(t) {
	const dir = mkdtempSync(join(tmpdir(), "legacy-contracts-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const paths = new Set([permanentPins, temporaryPins]);
	for (const pins of [permanentPins, temporaryPins]) {
		for (const path of Object.keys(read(root, pins).sha256)) paths.add(path);
	}
	for (const path of paths) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		cpSync(join(root, path), join(dir, path));
	}
	return dir;
}

function repin(dir, pinPath, path) {
	const pins = read(dir, pinPath);
	pins.sha256[path] = digest(dir, path);
	write(dir, pinPath, pins);
}

test("permanent shapes and temporary retention pass with disjoint owned references", (t) => {
	const dir = sandbox(t);
	checkFrozenLegacyShapes(dir);
	checkLegacyRetention(dir);
	const permanent = Object.keys(read(dir, permanentPins).sha256);
	const temporary = Object.keys(read(dir, temporaryPins).sha256);
	assert.equal(read(dir, mapping).scopes.length, 54);
	assert.deepEqual(
		permanent.filter((path) => temporary.includes(path)),
		[],
	);
});

for (const path of [release, fixtures]) {
	test(`temporary check rejects changed metadata: ${path}`, (t) => {
		const dir = sandbox(t);
		writeFileSync(join(dir, path), "{}\n");
		assert.throws(() => checkLegacyRetention(dir), /frozen bytes/);
	});
}

test("temporary check rejects changed fixture bytes and index digest even when metadata is repinned", (t) => {
	const dir = sandbox(t);
	const index = read(dir, fixtures);
	const path = index.fixtures[0].path;
	writeFileSync(join(dir, path), "{}\n");
	assert.throws(() => checkLegacyRetention(dir), /frozen bytes/);
	cpSync(join(root, path), join(dir, path));
	index.fixtures[0].sha256 = `sha256:${"0".repeat(64)}`;
	write(dir, fixtures, index);
	repin(dir, temporaryPins, fixtures);
	assert.throws(() => checkLegacyRetention(dir), /index digest/);
});

for (const pins of [temporaryPins]) {
	for (const change of ["extra", "missing"]) {
		test(`${pins} rejects ${change} pinned references`, (t) => {
			const dir = sandbox(t);
			const data = read(dir, pins);
			if (change === "extra") data.sha256["unrelated.json"] = "0".repeat(64);
			else delete data.sha256[Object.keys(data.sha256)[0]];
			write(dir, pins, data);
			assert.throws(() => checkLegacyRetention(dir), /reference set/);
		});
	}
}

test("temporary fixture schema refs must belong to permanent shapes", (t) => {
	const dir = sandbox(t);
	const index = read(dir, fixtures);
	index.fixtures[0].schemaPath = "connectors/unknown/schemas/unknown.json";
	write(dir, fixtures, index);
	repin(dir, temporaryPins, fixtures);
	assert.throws(() => checkLegacyRetention(dir), /permanent schema/);
});

for (const label of ["release", "fixture"]) {
	test(`temporary check rejects changed ${label} digest pin`, (t) => {
		const dir = sandbox(t);
		const pins = read(dir, temporaryPins);
		const path =
			label === "release" ? release : read(dir, fixtures).fixtures[0].path;
		pins.sha256[path] = "0".repeat(64);
		write(dir, temporaryPins, pins);
		assert.throws(() => checkLegacyRetention(dir), /frozen bytes/);
	});
}

test("schema bytes are owned by the permanent check only", (t) => {
	const dir = sandbox(t);
	const path = read(dir, fixtures).fixtures[0].schemaPath;
	writeFileSync(join(dir, path), "{}\n");
	checkLegacyRetention(dir);
	assert.throws(() => checkFrozenLegacyShapes(dir), /frozen bytes/);
});

#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Historical Desktop scope IDs and signed artifact references remain pinned
// until their consumers are explicitly migrated. The Playwright registry and
// source generators were retired with the root connector cut, so this check
// guards their last published bytes and every schema/fixture they reference.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pinned = JSON.parse(readFileSync(join(root, "scripts/frozen-legacy-contracts.sha256.json"), "utf8"));
const catalog = JSON.parse(readFileSync(join(root, "scope-catalog.json"), "utf8"));
const fixtureIndex = JSON.parse(readFileSync(join(root, "fixture-index.json"), "utf8"));

assert.equal(catalog.scopes.length, pinned.scopeCount, "historical scope count changed");
assert.equal(fixtureIndex.fixtures.length, pinned.fixtureCount, "historical fixture count changed");

const referenced = new Set([
	"SCOPES.md",
	"scope-catalog.json",
	"fixture-index.json",
	"connector-index.json",
]);
for (const scope of catalog.scopes) {
	assert.match(scope.schema?.path ?? "", /^connectors\/[^/]+\/schemas\/[^/]+\.json$/);
	referenced.add(scope.schema.path);
}
for (const fixture of fixtureIndex.fixtures) {
	assert.match(fixture.path ?? "", /^connectors\/[^/]+\/fixtures\/[^/]+\.json$/);
	assert.match(fixture.schemaPath ?? "", /^connectors\/[^/]+\/schemas\/[^/]+\.json$/);
	referenced.add(fixture.path);
	referenced.add(fixture.schemaPath);
}

assert.deepEqual(
	[...referenced].sort(),
	Object.keys(pinned.sha256).sort(),
	"frozen public contract reference set changed",
);

for (const [path, expected] of Object.entries(pinned.sha256)) {
	const actual = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
	assert.equal(actual, expected, `${path} changed from its frozen bytes`);
}
for (const fixture of fixtureIndex.fixtures) {
	assert.equal(fixture.sha256, `sha256:${pinned.sha256[fixture.path]}`, `${fixture.path} index digest changed`);
}

console.log(`PASS frozen legacy contracts: ${referenced.size} files, ${catalog.scopes.length} scope IDs, ${fixtureIndex.fixtures.length} fixtures`);

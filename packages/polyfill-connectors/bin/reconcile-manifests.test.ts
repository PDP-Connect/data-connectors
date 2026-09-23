// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Fleet-coverage test for the manifest-vs-schema-vs-emit reconciler.
 * Iterates every connector that ships a `schemas.ts` and asserts the
 * manifest, schema registry, and emitted-stream literals all align.
 *
 * Why this lives in `bin/` next to the CLI: the CLI version exits
 * nonzero on drift (suitable for an operator running it locally or in
 * CI). This test version surfaces the same drift through the regular
 * test runner so a regressing PR fails the test suite. The two share
 * the same `reconcileFromDisk` engine.
 *
 * Connectors without `schemas.ts` are intentionally skipped — schema
 * coverage for those is tracked separately as a connector-by-connector
 * effort. We don't want the reconciler test to fail on every
 * not-yet-schemed connector and create noise that masks actual drift
 * regressions.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	connectorsDir as CONNECTORS_DIR,
	manifestPath as MANIFEST_DIR,
} from "../src/connector-paths.ts";
import { reconcileFromDisk } from "../src/manifest-reconcile.ts";

function listSchemaConnectors(): string[] {
	return readdirSync(CONNECTORS_DIR)
		.filter((name) => existsSync(join(CONNECTORS_DIR, name, "schemas.ts")))
		.sort();
}

function emitSourcePathsFor(name: string): string[] {
	return ["index.ts", "parsers.ts"]
		.map((f) => join(CONNECTORS_DIR, name, f))
		.filter(existsSync);
}

const connectors = listSchemaConnectors();

assert.ok(
	connectors.length > 0,
	"expected at least one connector with schemas.ts; reconciler regression net is meaningless without coverage",
);

for (const name of connectors) {
	test(`reconcile/${name}: manifest, schema, and emit literals align`, () => {
		const manifestPath = MANIFEST_DIR(name);
		assert.ok(
			existsSync(manifestPath),
			`${name}: schemas.ts exists but no matching manifest`,
		);
		const r = reconcileFromDisk({
			connector: name,
			manifestPath,
			schemaPath: join(CONNECTORS_DIR, name, "schemas.ts"),
			emitSourcePaths: emitSourcePathsFor(name),
		});
		if (!r.ok) {
			const detail = JSON.stringify(
				{
					missing_manifest: r.missing_manifest,
					missing_schema: r.missing_schema,
					missing_emit: r.missing_emit,
					declared: r.declared,
					registered: r.registered,
					emitted: r.emitted,
				},
				null,
				2,
			);
			assert.fail(`${name} reconciliation drift:\n${detail}`);
		}
	});
}

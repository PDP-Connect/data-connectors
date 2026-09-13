#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (e): the local-collector PACKAGING manifest, cross-repository form.
 *
 * This is the cross-repo form of data-connect's skipped
 * `packages/local-collector/test/runner.test.ts` test "tsconfig packaging manifest bundles
 * exactly the connectors in the definitions registry" (`test.skip`, runner.test.ts:161). That
 * test is skipped there because it imports
 * `packages/polyfill-connectors/src/collector-registry.ts` — Move A content that lives in THIS
 * repository, not in data-connect. Its own skip comment names Phase 0 evidence row A25's
 * cross-repo-CI mechanism as where it is reinstated; this script is that reinstatement.
 *
 * The invariant it guards is a shipped-artifact defect class, not a style rule. The generic
 * `@pdpp/local-collector` runtime names no connector: the bin injects the connectors' own
 * LOCAL_COLLECTOR_DEFINITIONS. But the collector BUILD still has to compile each bundled
 * connector into `dist/` so the runtime can spawn it from the tarball. That packaging list
 * lives in data-connect's `packages/local-collector/tsconfig.build.json` `include` array. The
 * two lists are separately edited in SEPARATE REPOSITORIES, so they can drift in both
 * directions and each direction ships broken:
 *
 *   - in the registry, absent from tsconfig  -> the connector is advertised as bundled and
 *     the runtime tries to spawn it, but it was never compiled into dist/ — a runtime spawn
 *     failure for the user, on the published tarball.
 *   - in tsconfig, absent from the registry  -> dead compiled weight shipped in the published
 *     package that nothing can ever spawn.
 *
 * Comparison is on the registry's `entry` field (the on-disk connector directory name), which
 * is what tsconfig's `../polyfill-connectors/connectors/<entry>/**` globs name — NOT
 * `connector_id`. They happen to coincide for all six bundled connectors today; the protocol
 * keeps them distinct fields, so this compares the one that is actually structurally
 * meaningful to the packaging glob.
 *
 * KNOWN BLIND SPOT: this reads tsconfig's `include` array only, as the original test did, with
 * the identical regex. A connector that is listed in `include` AND knocked out by an `exclude`
 * glob is NOT detected — this check stays green while the tarball ships without it. That is not
 * hypothetical: tsconfig.build.json already excludes a connector path today
 * (`../polyfill-connectors/connectors/imessage/fixtures.ts`), so widening such an entry to
 * `imessage/**` would silently defeat this guard. Reading `exclude` here would not close it
 * either — the honest fix is asserting membership of the packed tarball itself (build + pack +
 * enumerate), which is deliberately larger scope than restoring the original assertion. Treat
 * this check as proving COMPILE-LIST membership, not tarball membership.
 *
 * Usage:
 *   node check-collector-packaging-manifest-drift.mjs <data-connect-checkout> <data-connectors-checkout>
 *
 * Exit 0: tsconfig.build.json compiles exactly the connectors the canonical registry declares.
 * Exit 1: drift detected, or a structural precondition failed.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , dataConnectDir, dataConnectorsDir] = process.argv;

if (!dataConnectDir || !dataConnectorsDir) {
	console.error(
		"usage: check-collector-packaging-manifest-drift.mjs <data-connect-checkout> <data-connectors-checkout>",
	);
	process.exit(1);
}

const tsconfigPath = join(dataConnectDir, "packages/local-collector/tsconfig.build.json");
const canonicalRegistryPath = join(dataConnectorsDir, "packages/polyfill-connectors/src/collector-registry.ts");

for (const [label, path] of [
	["data-connect local-collector tsconfig.build.json", tsconfigPath],
	["data-connectors canonical collector-registry.ts", canonicalRegistryPath],
]) {
	if (!existsSync(path)) {
		console.error(`FAIL: ${label} not found at ${path}`);
		process.exit(1);
	}
}

// The canonical registry is TypeScript whose import graph reaches every connector's
// collector-definition.ts. Rather than build that graph, import it directly under
// --experimental-strip-types: collector-registry.ts imports @pdpp/connector-protocol ONLY as
// `import type` (erased without module resolution), and its other imports are relative paths
// inside this same checkout, so it loads with no install step. This is the same
// no-node_modules property check-collector-definitions-drift.mjs relies on.
// pathToFileURL (not a `file://` template literal): the checkout paths arrive as CLI
// arguments and may be relative, which would otherwise be misparsed as a URL *host*.
const { LOCAL_COLLECTOR_DEFINITIONS } = await import(pathToFileURL(resolve(canonicalRegistryPath)).href);

if (!Array.isArray(LOCAL_COLLECTOR_DEFINITIONS) || LOCAL_COLLECTOR_DEFINITIONS.length === 0) {
	console.error(`FAIL: ${canonicalRegistryPath} exported no LOCAL_COLLECTOR_DEFINITIONS entries.`);
	process.exit(1);
}

// tsconfig.build.json is JSONC (tsc allows comments) and the real file is heavily commented.
// Strip `//` line comments before JSON.parse so this guard reads the same file tsc compiles —
// the same treatment the original data-connect test applied.
const tsconfigText = readFileSync(tsconfigPath, "utf8");
let tsconfig;
try {
	tsconfig = JSON.parse(tsconfigText.replace(/^\s*\/\/.*$/gm, ""));
} catch (error) {
	console.error(`FAIL: could not parse ${tsconfigPath} as JSONC: ${error.message}`);
	process.exit(1);
}

if (!Array.isArray(tsconfig.include)) {
	console.error(`FAIL: ${tsconfigPath} has no "include" array — cannot read the packaging manifest.`);
	process.exit(1);
}

const compiledConnectors = tsconfig.include
	.map((entry) => /connectors\/([^/]+)\/\*\*/.exec(entry)?.[1])
	.filter(Boolean)
	.sort();

const declaredEntries = LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definition.entry).sort();

const missingFromTsconfig = declaredEntries.filter((entry) => !compiledConnectors.includes(entry));
const missingFromRegistry = compiledConnectors.filter((entry) => !declaredEntries.includes(entry));

if (missingFromTsconfig.length > 0 || missingFromRegistry.length > 0) {
	console.error("FAIL: local-collector packaging manifest drift detected.");
	console.error(`  data-connectors canonical registry: ${canonicalRegistryPath}`);
	console.error(`  data-connect packaging manifest:    ${tsconfigPath}`);
	if (missingFromTsconfig.length > 0) {
		console.error(
			`  declared in the registry but NOT compiled into the artifact: ${missingFromTsconfig.join(", ")}`,
		);
		console.error("    -> the published tarball would advertise these connectors but fail to spawn them.");
	}
	if (missingFromRegistry.length > 0) {
		console.error(`  compiled into the artifact but NOT declared in the registry: ${missingFromRegistry.join(", ")}`);
		console.error("    -> the published tarball would ship dead connector code nothing can spawn.");
	}
	console.error(
		"  Fix: bring data-connect's tsconfig.build.json `include` globs into lockstep with this repo's LOCAL_COLLECTOR_DEFINITIONS.",
	);
	process.exit(1);
}

console.log(
	`OK: tsconfig.build.json compiles exactly the ${declaredEntries.length} connectors the canonical registry declares (${declaredEntries.join(", ")}).`,
);

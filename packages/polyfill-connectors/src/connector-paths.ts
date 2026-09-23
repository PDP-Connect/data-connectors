// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place that knows where connector code, manifests, icons, and
 * fixtures live on disk, per docs/migration/connector-cutover/CONTRACTS.md's
 * "End state": root `connectors/<key>/` is the only home of a PDPP
 * Collection Profile implementation — its code, `manifest.json`, icon,
 * tests, and reviewed scrubbed fixtures all live together in that one
 * directory. `packages/polyfill-connectors` holds only the reusable
 * runtime, libraries, and dev tools.
 *
 * Every other file — tests, bin/, src/, connectors/*, root scripts — must
 * compute these paths by calling into this module, never by re-deriving
 * `import.meta.url` math, a `PACKAGE_ROOT`/`../..` chain, or a
 * `new URL("../manifests/...", import.meta.url)` of its own. That keeps a
 * future layout change a change to this one file instead of a repo-wide
 * sweep (as it already did for the root `connectors/<key>/` move itself).
 *
 * This is a *filesystem-layout* primitive, not a manifest reader: it does not
 * parse manifests or know about `PDPP_POLYFILL_MANIFESTS_DIR` test overrides.
 * `manifest-registry.ts` layers that behavior on top for production manifest
 * discovery; call this module directly only when you need a real, on-disk
 * path (a fixture path, a subprocess entrypoint, a build script input).
 *
 * `PDPP_CONNECTOR_PATHS_TEST_ROOT` (test-only; unset in normal use) is an
 * alternate root a test can point `connectorDir`, `connectorEntrypoint`,
 * `manifestPath`, and `iconPath` at instead of the real root `connectors/`
 * directory, so a test can prove the seam (and everything routed through
 * it — manifest discovery, scrub-rule loading, connector-entrypoint
 * resolution) still resolves correctly under a different on-disk layout,
 * without touching production defaults. It is read live (not cached at
 * import time), each call, so a test can set it right before the call it
 * affects.
 *
 * `connectorsDir`/`packageRoot`/`repoRoot`/`fixturesRootDir` are NOT
 * affected by this override — they always describe the real location on
 * disk. Only the per-key/per-file derivation functions below honor it.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/polyfill-connectors/`, this package's own root. */
export const packageRoot: string = join(here, "..");

/** The repository root, two levels above this package. */
export const repoRoot: string = join(packageRoot, "..", "..");

/** Root `connectors/`, the only home of a PDPP Collection Profile implementation. */
export const connectorsDir: string = join(repoRoot, "connectors");

/** `connectorsDir`, or `PDPP_CONNECTOR_PATHS_TEST_ROOT/connectors` under the test-only override (see module docstring). */
function resolvedConnectorsDir(): string {
	const testRoot = process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
	return testRoot ? join(testRoot, "connectors") : connectorsDir;
}

/** `connectors/<key>/` (or the test-only relocation root, see module docstring). */
export function connectorDir(key: string): string {
	return join(resolvedConnectorsDir(), key);
}

/** `connectors/<key>/index.ts` (or the test-only relocation root, see module docstring). */
export function connectorEntrypoint(key: string): string {
	return join(connectorDir(key), "index.ts");
}

/** `connectors/<key>/manifest.json` (or the test-only relocation root, see module docstring). */
export function manifestPath(key: string): string {
	return join(connectorDir(key), "manifest.json");
}

/** File labels for shipped manifests, retaining the existing `<key>.json` diagnostic names. */
export function manifestFileNames(): string[] {
	return readdirSync(resolvedConnectorsDir(), { withFileTypes: true })
		.filter(
			(entry) => entry.isDirectory() && existsSync(manifestPath(entry.name)),
		)
		.map((entry) => `${entry.name}.json`)
		.sort();
}

/**
 * `connectors/<key>/icon.<ext>` (or the test-only relocation root, see
 * module docstring).
 *
 * Pass the manifest's own `brand.icon` value — a bare filename living
 * beside `manifest.json` (for example `"icon.svg"`) — and the connector key
 * it belongs to.
 */
export function iconPath(key: string, iconFile: string): string {
	return join(connectorDir(key), iconFile);
}

/** `connectors/<key>/fixtures/`. */
export function fixturesDir(key: string): string {
	return join(connectorDir(key), "fixtures");
}

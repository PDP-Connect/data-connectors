// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place that knows where connector code, manifests, icons, and
 * fixtures live on disk, during the parallel-layout phase of the connector
 * cutover (see docs/migration/connector-cutover/CONTRACTS.md).
 *
 * Every other file — tests, bin/, src/, connectors/*, root scripts — must
 * compute these paths by calling into this module, never by re-deriving
 * `import.meta.url` math, a `PACKAGE_ROOT`/`../..` chain, or a
 * `new URL("../manifests/...", import.meta.url)` of its own. That keeps the
 * layout move to root `connectors/<key>/` (owned by a separate lane, see
 * CONTRACTS.md "Layout during the parallel phase") a change to this one file
 * instead of a repo-wide sweep.
 *
 * This is a *filesystem-layout* primitive, not a manifest reader: it does not
 * know about `PDPP_POLYFILL_MANIFESTS_DIR` test overrides. `manifest-registry.ts`
 * layers that behavior on top for production manifest discovery; call this
 * module directly only when you need a real, on-disk path (a fixture path, a
 * subprocess entrypoint, a build script input).
 *
 * `PDPP_CONNECTOR_PATHS_TEST_ROOT` (test-only; unset in normal use) is an
 * alternate root a test can point `connectorDir`, `connectorEntrypoint`,
 * `manifestPath`, and `iconPath` at instead of this package's real
 * `manifests/`/`connectors/` directories, so a test can prove the seam (and
 * everything routed through it — manifest discovery, scrub-rule loading,
 * connector-entrypoint resolution) still resolves correctly under a
 * different on-disk layout — e.g. the eventual root `connectors/<key>/`
 * move — without touching production defaults. It is read live (not cached
 * at import time), each call, so a test can set it right before the call it
 * affects.
 *
 * `manifestsDir`/`connectorsDir`/`iconsDir`/`packageRoot`/`repoRoot`/
 * `fixturesRootDir` are NOT affected by this override — they always
 * describe this package's real location on disk. Only the per-key/per-file
 * derivation functions below honor it.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** `packages/polyfill-connectors/`, this package's own root. */
export const packageRoot: string = join(here, "..");

/** The repository root, two levels above this package. */
export const repoRoot: string = join(packageRoot, "..", "..");

/** `packages/polyfill-connectors/manifests/`. */
export const manifestsDir: string = join(packageRoot, "manifests");

/** `packages/polyfill-connectors/manifests/icons/`. */
export const iconsDir: string = join(manifestsDir, "icons");

/** `packages/polyfill-connectors/connectors/`. */
export const connectorsDir: string = join(packageRoot, "connectors");

/** `manifestsDir`, or `PDPP_CONNECTOR_PATHS_TEST_ROOT/manifests` under the test-only override (see module docstring). */
export function resolvedManifestsDir(): string {
	const testRoot = process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
	return testRoot ? join(testRoot, "manifests") : manifestsDir;
}

/** `connectorsDir`, or `PDPP_CONNECTOR_PATHS_TEST_ROOT/connectors` under the test-only override (see module docstring). */
function resolvedConnectorsDir(): string {
	const testRoot = process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
	return testRoot ? join(testRoot, "connectors") : connectorsDir;
}

/** `packages/polyfill-connectors/connectors/<key>/` (or the test-only relocation root, see module docstring). */
export function connectorDir(key: string): string {
	return join(resolvedConnectorsDir(), key);
}

/** `packages/polyfill-connectors/connectors/<key>/index.ts` (or the test-only relocation root, see module docstring). */
export function connectorEntrypoint(key: string): string {
	return join(connectorDir(key), "index.ts");
}

/** `packages/polyfill-connectors/manifests/<key>.json` (or the test-only relocation root, see module docstring). */
export function manifestPath(key: string): string {
	return join(resolvedManifestsDir(), `${key}.json`);
}

/**
 * `packages/polyfill-connectors/manifests/icons/<iconFile>` (or the
 * test-only relocation root, see module docstring).
 *
 * Pass the manifest's own `brand.icon` value (for example `"icons/foo.svg"`)
 * or a bare filename (`"foo.svg"`) — both resolve under `iconsDir`.
 */
export function iconPath(iconFileOrRelativePath: string): string {
	const fileName = iconFileOrRelativePath.startsWith("icons/")
		? iconFileOrRelativePath.slice("icons/".length)
		: iconFileOrRelativePath;
	return join(resolvedManifestsDir(), "icons", fileName);
}

/** `packages/polyfill-connectors/fixtures/`. */
export const fixturesRootDir: string = join(packageRoot, "fixtures");

/** `packages/polyfill-connectors/fixtures/<key>/`. */
export function fixturesDir(key: string): string {
	return join(fixturesRootDir, key);
}

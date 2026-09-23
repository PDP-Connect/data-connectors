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

/** `packages/polyfill-connectors/connectors/<key>/`. */
export function connectorDir(key: string): string {
	return join(connectorsDir, key);
}

/** `packages/polyfill-connectors/connectors/<key>/index.ts`. */
export function connectorEntrypoint(key: string): string {
	return join(connectorDir(key), "index.ts");
}

/** `packages/polyfill-connectors/manifests/<key>.json`. */
export function manifestPath(key: string): string {
	return join(manifestsDir, `${key}.json`);
}

/**
 * `packages/polyfill-connectors/manifests/icons/<iconFile>`.
 *
 * Pass the manifest's own `brand.icon` value (for example `"icons/foo.svg"`)
 * or a bare filename (`"foo.svg"`) — both resolve under `iconsDir`.
 */
export function iconPath(iconFileOrRelativePath: string): string {
	const fileName = iconFileOrRelativePath.startsWith("icons/")
		? iconFileOrRelativePath.slice("icons/".length)
		: iconFileOrRelativePath;
	return join(iconsDir, fileName);
}

/** `packages/polyfill-connectors/fixtures/`. */
export const fixturesRootDir: string = join(packageRoot, "fixtures");

/** `packages/polyfill-connectors/fixtures/<key>/`. */
export function fixturesDir(key: string): string {
	return join(fixturesRootDir, key);
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reads every shipped connector manifest, one per root `connectors/<key>/
 * manifest.json` (see docs/migration/connector-cutover/CONTRACTS.md's "End
 * state").
 *
 * This package owns connector/provider knowledge — the manifests here ARE
 * that knowledge, declared as data. The reference implementation must not
 * independently walk this directory itself (filesystem discovery of
 * connector manifests is connector-package knowledge, not RI knowledge), so
 * this is the one sanctioned place that enumerates and parses them; RI-side
 * consumers (the connector-registry generator, the seed command) import
 * `readPolyfillManifests` instead of touching `node:fs` against this
 * directory directly.
 *
 * Each entry's `file` is `<key>.json` (matching the pre-move flat-directory
 * filename), even though the manifest's real on-disk name is now
 * `manifest.json` — this keeps every existing caller's `<key>.json` display
 * and lookup logic unchanged across the layout move.
 *
 * `PDPP_POLYFILL_MANIFESTS_DIR` overrides the read with a FLAT directory of
 * `<key>.json` files, for tests that need to inject a synthetic/probe
 * manifest without writing into the real per-connector layout. Unset in
 * normal use. Checked before `connector-paths.ts`'s own
 * `PDPP_CONNECTOR_PATHS_TEST_ROOT` (a full connectors+manifests layout
 * relocation for seam-relocation tests); the two overrides serve different
 * tests and are not expected to be set together.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	connectorsDir,
	manifestFileNames,
	manifestPath,
} from "./connector-paths.ts";

export interface PolyfillManifestEntry {
	file: string;
	manifest: unknown;
}

function readManifestFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Every connector directory's `manifest.json` under the real, shipped root `connectors/` directory, parsed. */
function readRealPolyfillManifests(): PolyfillManifestEntry[] {
	const out: PolyfillManifestEntry[] = [];
	for (const file of manifestFileNames()) {
		const key = file.replace(/\.json$/, "");
		const path = manifestPath(key);
		try {
			out.push({ file, manifest: readManifestFile(path) });
		} catch (error) {
			if (
				error instanceof Error &&
				"code" in error &&
				error.code === "ENOENT"
			) {
				continue;
			}
			throw error;
		}
	}
	return out;
}

/** Every `*.json` file directly under an env-var-selected override directory (tests only), parsed. */
function readOverridePolyfillManifests(
	overrideDir: string,
): PolyfillManifestEntry[] {
	const out: PolyfillManifestEntry[] = [];
	for (const file of readdirSync(overrideDir)) {
		if (!file.endsWith(".json")) {
			continue;
		}
		out.push({ file, manifest: readManifestFile(join(overrideDir, file)) });
	}
	return out;
}

/** Every shipped connector manifest under root `connectors/` (or the test override), parsed. */
export function readPolyfillManifests(): PolyfillManifestEntry[] {
	return process.env.PDPP_POLYFILL_MANIFESTS_DIR
		? readOverridePolyfillManifests(process.env.PDPP_POLYFILL_MANIFESTS_DIR)
		: readRealPolyfillManifests();
}

/** Option and reason metadata for library consumers installed outside this repository. */
export function readPolyfillLibraryMetadata(): PolyfillManifestEntry[] {
	if (process.env.PDPP_POLYFILL_MANIFESTS_DIR || existsSync(connectorsDir)) {
		return readPolyfillManifests();
	}
	return JSON.parse(
		readFileSync(
			new URL("./manifest-library-metadata.json", import.meta.url),
			"utf8",
		),
	) as PolyfillManifestEntry[];
}

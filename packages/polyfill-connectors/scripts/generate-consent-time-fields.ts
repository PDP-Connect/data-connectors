// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates the consent-time-field modules under `src/generated/` from every
 * shipped connector manifest's per-stream `consent_time_field`:
 *
 * - `consent-time-fields.generated.ts`: the aggregate, every connector.
 * - `consent-time-fields/<connector>.generated.ts`: one slice per connector,
 *   the same table with a single key plus the connector it is bound to.
 *
 * Why this exists: Collection Profile §5.1 applies `scope.time_range` to each
 * stream's declared `consent_time_field`. The runtime used to filter on a
 * connector-supplied `timeRangeField` that defaulted to `date`, so a
 * connector whose manifest named another field returned an empty, successful
 * bounded run. The manifest is now the one authority: this generator reads it
 * at build/CI time and bakes a plain data literal into the runtime, because a
 * published connector is a single-file bundle with no manifest beside it.
 * `consent-time-fields-drift.test.ts` fails CI if these files drift.
 *
 * Why slices: the runtime imports the table, so a built artifact would bundle
 * (and its input hash would cover) every connector's consent fields, and one
 * connector's edit would republish all of them. The artifact builders resolve
 * the aggregate import to the connector's own slice instead. The aggregate
 * stays for unbundled use (tests and scenario runs name several connectors).
 *
 * What a stream maps to, and why (date policy, nulls), lives in
 * consent-time-fields-render.mjs, which the builders and the artifact input
 * hash also use to decide whether a slice is current.
 *
 * Keys are connector directory names. The runtime normalizes a connector's
 * `name` (`youtube-takeout`) to that form (`youtube_takeout`).
 *
 * Takes one optional CLI arg: an output directory to write to instead of
 * `src/generated` (used by the drift test).
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPolyfillManifests } from "../src/manifest-registry.ts";
import {
	AGGREGATE_FILE,
	renderAggregate,
	renderSlice,
	SLICE_DIRECTORY,
	sliceFileName,
} from "./consent-time-fields-render.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const outputRoot = process.argv[2]
	? resolve(process.argv[2])
	: resolve(packageDir, "src/generated");

const connectors = readPolyfillManifests()
	.map(
		({ file, manifest }) =>
			[file.replace(/\.json$/u, ""), manifest as object] as const,
	)
	.sort(([a], [b]) => a.localeCompare(b));

writeFileSync(join(outputRoot, AGGREGATE_FILE), renderAggregate(connectors));

const sliceDir = join(outputRoot, SLICE_DIRECTORY);
mkdirSync(sliceDir, { recursive: true });
const expected = new Set<string>();
for (const [connector, manifest] of connectors) {
	const name = sliceFileName(connector) as string;
	expected.add(name);
	writeFileSync(join(sliceDir, name), renderSlice(connector, manifest));
}
// A removed connector leaves no slice behind to be mistaken for current.
for (const name of readdirSync(sliceDir)) {
	if (!expected.has(name)) rmSync(join(sliceDir, name));
}

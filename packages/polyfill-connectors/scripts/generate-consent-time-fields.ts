// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regenerates `src/generated/consent-time-fields.generated.ts` from every
 * shipped connector manifest's per-stream `consent_time_field`.
 *
 * Why this exists: Collection Profile §5.1 applies `scope.time_range` to each
 * stream's declared `consent_time_field`. The runtime used to filter on a
 * connector-supplied `timeRangeField` that defaulted to `date`, so a
 * connector whose manifest named another field returned an empty, successful
 * bounded run. The manifest is now the one authority: this generator reads it
 * at build/CI time and bakes a plain data literal into the runtime, because a
 * published connector is a single-file bundle with no manifest beside it.
 * `consent-time-fields-drift.test.ts` fails CI if this file drifts.
 *
 * Each stream maps to its consent field when the manifest schema declares that
 * field as a timestamp string (no `format`, or `format: "date-time"`). A stream
 * maps to `null` when the manifest declares no consent field, or declares one
 * whose values are calendar dates or integers: the pinned profile defines no
 * rule for comparing those with timestamp bounds, so a bounded run must
 * report `scope_not_supported` for that stream.
 *
 * Keys are connector directory names. The runtime normalizes a connector's
 * `name` (`youtube-takeout`) to that form (`youtube_takeout`).
 *
 * Takes one optional CLI arg: an output path to write to instead of the
 * tracked file (used by the drift test).
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPolyfillManifests } from "../src/manifest-registry.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const targetPath = process.argv[2]
	? resolve(process.argv[2])
	: resolve(packageDir, "src/generated/consent-time-fields.generated.ts");

interface StreamLike {
	consent_time_field?: unknown;
	name?: unknown;
	schema?: {
		properties?: Record<string, { format?: unknown; type?: unknown }>;
	};
}

function timestampField(stream: StreamLike): string | null {
	const field = stream.consent_time_field;
	if (typeof field !== "string" || !field) return null;
	const property = stream.schema?.properties?.[field];
	const types = Array.isArray(property?.type)
		? property.type
		: [property?.type];
	if (!types.includes("string")) return null;
	if (property?.format !== undefined && property.format !== "date-time") {
		return null;
	}
	return field;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const key = (name: string): string =>
	IDENTIFIER.test(name) ? name : JSON.stringify(name);

const connectors = readPolyfillManifests()
	.map(({ file, manifest }) => {
		const streams = (manifest as { streams?: StreamLike[] }).streams ?? [];
		const entries = streams
			.filter((stream) => typeof stream.name === "string")
			.map((stream) => [stream.name as string, timestampField(stream)] as const)
			.sort(([a], [b]) => a.localeCompare(b));
		return [file.replace(/\.json$/u, ""), entries] as const;
	})
	.sort(([a], [b]) => a.localeCompare(b));

const body = connectors
	.map(([connector, entries]) => {
		const lines = entries.map(
			([stream, field]) =>
				`\t\t${key(stream)}: ${field === null ? "null" : JSON.stringify(field)},`,
		);
		return `\t${key(connector)}: {\n${lines.join("\n")}\n\t},`;
	})
	.join("\n");

writeFileSync(
	targetPath,
	`// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from every shipped connector
// manifest's per-stream consent_time_field. A stream maps to null when its
// manifest declares no timestamp consent field (absent, calendar date, or
// integer), so a bounded run reports scope_not_supported for it.
// Regenerate with \`node --experimental-strip-types
// scripts/generate-consent-time-fields.ts\` from packages/polyfill-connectors.

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, string | null>>>
> = {
${body}
};
`,
);

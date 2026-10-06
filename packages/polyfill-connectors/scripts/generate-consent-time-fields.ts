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
 * Each stream maps to its consent field and that field's declared format when
 * the runtime can compare bounds with it (Collection Profile §5.1):
 *
 * - `format: "date-time"`: always.
 * - `format: "date"`: only for the streams in DATE_BOUND_STREAMS. A date
 *   stream is listed once its connector's own range handling compares
 *   full-date bounds as calendar dates.
 *
 * Every other stream maps to `null`: no consent field, a string with no
 * format, an integer, or an unlisted date field. A bounded run reports
 * `scope_not_supported` for it.
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

/** `<connector>.<stream>` whose `format: "date"` consent field is compared. */
const DATE_BOUND_STREAMS = new Set([
	"strava.activities",
	"strava_browser.activities",
]);

type ConsentTimeField = { field: string; format: "date" | "date-time" };

function consentTimeField(
	connector: string,
	stream: StreamLike,
): ConsentTimeField | null {
	const field = stream.consent_time_field;
	if (typeof field !== "string" || !field) return null;
	const property = stream.schema?.properties?.[field];
	const types = Array.isArray(property?.type)
		? property.type
		: [property?.type];
	if (!types.includes("string")) return null;
	if (property?.format === "date-time") return { field, format: "date-time" };
	if (
		property?.format === "date" &&
		DATE_BOUND_STREAMS.has(`${connector}.${String(stream.name)}`)
	) {
		return { field, format: "date" };
	}
	return null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
const key = (name: string): string =>
	IDENTIFIER.test(name) ? name : JSON.stringify(name);

const connectors = readPolyfillManifests()
	.map(({ file, manifest }) => {
		const connector = file.replace(/\.json$/u, "");
		const streams = (manifest as { streams?: StreamLike[] }).streams ?? [];
		const entries = streams
			.filter((stream) => typeof stream.name === "string")
			.map(
				(stream) =>
					[stream.name as string, consentTimeField(connector, stream)] as const,
			)
			.sort(([a], [b]) => a.localeCompare(b));
		return [connector, entries] as const;
	})
	.sort(([a], [b]) => a.localeCompare(b));

const body = connectors
	.map(([connector, entries]) => {
		const lines = entries.map(
			([stream, consent]) =>
				`\t\t${key(stream)}: ${consent === null ? "null" : `{ field: ${JSON.stringify(consent.field)}, format: ${JSON.stringify(consent.format)} }`},`,
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
// manifest's per-stream consent_time_field and its declared format. A stream
// maps to null when the runtime cannot compare bounds with its consent field
// (absent, a string with no format, an integer, or a date field not yet
// enabled), so a bounded run reports scope_not_supported for it.
// Regenerate with \`node --experimental-strip-types
// scripts/generate-consent-time-fields.ts\` from packages/polyfill-connectors.

import type { ConsentTimeField } from "../time-range.ts";

export const CONSENT_TIME_FIELDS: Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
> = {
${body}
};
`,
);

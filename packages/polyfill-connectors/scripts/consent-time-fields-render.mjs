// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure rendering of the generated consent-time-field modules, with no imports
 * and no I/O. One module renders both the aggregate and the per-connector
 * slices, so the generator, the artifact builders and the artifact input hash
 * all agree on what a slice must contain.
 *
 * The artifact input hash imports this file as it exists at the commit being
 * compared (the same way it loads the publish allowlist). That is why it must
 * stay self-contained. It is deliberately not itself a hashed artifact input:
 * it only decides whether a slice is current, and the slice bytes are what a
 * connector ships.
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
 */

/** `<connector>.<stream>` whose `format: "date"` consent field is compared. */
export const DATE_BOUND_STREAMS = new Set([
	"fitbit.daily_summaries",
	"fitbit.sleep",
	"garmin_browser.daily_summaries",
	"garmin_browser.hrv",
	"garmin_browser.training_status",
	"strava.activities",
	"strava_browser.activities",
]);

export const AGGREGATE_FILE = "consent-time-fields.generated.ts";
export const SLICE_DIRECTORY = "consent-time-fields";

export function sliceFileName(connector) {
	return `${connector}.generated.ts`;
}

function consentTimeField(connector, stream) {
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
const key = (name) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

function renderConnector(connector, manifest) {
	const entries = (manifest.streams ?? [])
		.filter((stream) => typeof stream.name === "string")
		.map((stream) => [stream.name, consentTimeField(connector, stream)])
		.sort(([a], [b]) => a.localeCompare(b));
	const lines = entries.map(
		([stream, consent]) =>
			`\t\t${key(stream)}: ${consent === null ? "null" : `{ field: ${JSON.stringify(consent.field)}, format: ${JSON.stringify(consent.format)} }`},`,
	);
	return `\t${key(connector)}: {\n${lines.join("\n")}\n\t},`;
}

const HEADER = `// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
`;

const TYPE_IMPORT = (depth) =>
	`import type { ConsentTimeField } from "${depth}time-range.ts";`;

const TABLE_TYPE = `Readonly<
	Record<string, Readonly<Record<string, ConsentTimeField | null>>>
>`;

/**
 * The aggregate: every connector's table, for unbundled use (tests, scenario
 * runs). `CONSENT_BOUND_CONNECTOR` is null: no identity is bound, so any
 * connector name may be looked up.
 */
export function renderAggregate(connectors) {
	const body = [...connectors]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([connector, manifest]) => renderConnector(connector, manifest))
		.join("\n");
	return `${HEADER}
// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from every shipped connector
// manifest's per-stream consent_time_field and its declared format. A stream
// maps to null when the runtime cannot compare bounds with its consent field
// (absent, a string with no format, an integer, or a date field not yet
// enabled), so a bounded run reports scope_not_supported for it.
// Built connector artifacts never import this file: the builders resolve it to
// the connector's own slice under ./${SLICE_DIRECTORY}/.
// Regenerate with \`node --experimental-strip-types
// scripts/generate-consent-time-fields.ts\` from packages/polyfill-connectors.

${TYPE_IMPORT("../")}

export const CONSENT_BOUND_CONNECTOR: string | null = null;

export const CONSENT_TIME_FIELDS: ${TABLE_TYPE} = {
${body}
};
`;
}

/**
 * One connector's slice: the same table shape with a single key. The connector
 * directory name is also the bound identity a built artifact checks its
 * runtime \`name\` against.
 */
/** One line when it fits Biome's line width, else wrapped as Biome wraps it. */
function boundConnectorDeclaration(connector) {
	const line = `export const CONSENT_BOUND_CONNECTOR: string | null = ${JSON.stringify(connector)};`;
	return line.length <= 80
		? line
		: `export const CONSENT_BOUND_CONNECTOR: string | null =\n\t${JSON.stringify(connector)};`;
}

export function renderSlice(connector, manifest) {
	return `${HEADER}
// GENERATED FILE — do not hand-edit. Produced by
// scripts/generate-consent-time-fields.ts from connectors/${connector}/manifest.json
// alone. A built ${connector} artifact resolves the consent-time-field table to
// this file, so editing another connector's consent fields never changes it.
// Regenerate with \`node --experimental-strip-types
// scripts/generate-consent-time-fields.ts\` from packages/polyfill-connectors.

${TYPE_IMPORT("../../")}

${boundConnectorDeclaration(connector)}

export const CONSENT_TIME_FIELDS: ${TABLE_TYPE} = {
${renderConnector(connector, manifest)}
};
`;
}

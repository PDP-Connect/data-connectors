// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Apple Health stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: `buildHealthRecord` (every health-area stream) and
 * `buildWorkoutRecord` (workouts) in parsers.ts — the only things index.ts
 * passes to
 * `emitRecord(...)`. Schemas mirror the *emitted* shape. A parity test
 * (schemas.test.ts) holds them to the manifest's published JSON Schema,
 * because nothing in the toolchain syncs the two and the manifest is the
 * contract a reading application integrates against.
 *
 *   - `id` is `hashId(...)` → a 24-char lowercase hex digest (sha256 sliced).
 *   - `start_date` / `end_date` come from `isoDate`, which is
 *     `new Date(v).toISOString()` → always `...T..:..:...sssZ`. The schema
 *     accepts that via an ISO-prefix regex.
 *   - `type` (health-area streams) is `healthTypeShort(...)` — the HK identifier with its
 *     `HKQuantityTypeIdentifier` / `HKCategoryTypeIdentifier` / `HKDataType`
 *     prefix stripped (e.g. `StepCount`, `HeartRate`). Defaults to the raw type
 *     or `"Unknown"` when absent, so it is always a non-empty structural token.
 *   - `unit` is the export's OWN unit attribute, carried through verbatim. It is
 *     never inferred and never defaulted: Apple states units per record and they
 *     vary by locale, so a value without its stated unit is not interpretable.
 *   - `value` is `Number(attrs.value)` only when finite; otherwise null. It is
 *     FLOAT-CAPABLE (heart rate, body mass, etc. are non-integers) and is
 *     `z.number().nullable()`, NOT `.int()`. `value_raw` carries the original
 *     non-numeric string (e.g. a category value like `HKCategoryValueSleep...`)
 *     when `value` could not be parsed — a structural HK token, bounded string.
 *
 * WHAT THIS CONNECTOR DELIBERATELY DOES NOT PUBLISH, AND WHY
 *
 * Privacy here is enforced by absence from the schema, not by convention. A
 * field that is never in the schema cannot be requested by mistake, cannot be
 * rendered by a reading application, and cannot be restored by someone who did
 * not know why it went. Each exclusion is recorded with its reason so that a
 * later reader can re-open the decision rather than assume nobody considered it.
 *
 *   - `sourceName` / `sourceVersion`. Apple sets `sourceName` to the device or
 *     application that wrote the record, and people name their devices after
 *     themselves — "Ada's Apple Watch", "Sam's iPhone". On streams that
 *     together cover every health record, that places a human name on EVERY
 *     row. It is a name, not safe device or application provenance.
 *     `sourceName` is not read at all: record identity is a hash of published
 *     fields only (see buildHealthRecord), since a hash over a withheld name
 *     would let a reader test candidate names against the id. `sourceVersion`
 *     goes with it: an application version detached from the
 *     application it versions is uninterpretable, and it still fingerprints.
 *
 *   - Free-form `metadata`. Apple lets any third-party application write
 *     arbitrary keys and values there, so its contents cannot be audited in
 *     advance, and an unbounded bag on a published stream would be a leak by
 *     construction. The single key worth keeping is extracted as a typed field
 *     instead: `was_user_entered`, from `HKWasUserEntered`, which separates a
 *     measurement from an assertion. Further keys may be added individually
 *     once there is evidence of what exports carry — adding a property is a
 *     non-breaking change, which is the right asymmetry.
 *
 *   - A workout's weather block, and any GPS route. Stripping coordinates while
 *     keeping weather does not protect location: sunrise and sunset on a known
 *     date give latitude, solar noon gives longitude, and a year of workouts
 *     converges on where the owner sleeps. The whole block goes. `workout-routes/`
 *     GPS files in the archive are counted, never parsed.
 *
 *   - The `<Me>` element: date of birth, blood type, biological sex. Never
 *     parsed, never emitted, no stream carries it.
 *
 * RESIDUAL, STATED RATHER THAN IMPLIED. `device` keeps the hardware fields
 * of Apple's device description (manufacturer, model, hardware, firmware and
 * software; see normaliseDevice in parsers.ts), because a reader needs to know
 * whether a heart rate came from a watch or a chest strap. The description's
 * `name`, which the writing app chooses and which may be a name a person gave
 * the device, its local and UDI device identifiers, and the in-memory address
 * Apple prints in it are all dropped. What remains is not innocent: it says
 * which hardware the owner has, and combined with the set of record types
 * present it narrows down a person's device estate. It is kept because that
 * cost is smaller than losing measurement provenance entirely, not because it
 * is harmless.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const APPLE_HEALTH_ID_RE = /^[0-9a-f]{24}$/; // hashId: 24-char sha256 hex slice
// isoDate => new Date(v).toISOString() => always ...T..:..:...sssZ.
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const appleHealthIdSchema = z
	.string()
	.regex(APPLE_HEALTH_ID_RE, "must be a 24-char hex Apple Health record id");
const isoDateTimeSchema = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/** The longest type token, and the longest unit, any published record carries. */
export const MAX_TYPE_LENGTH = 200;
export const MAX_UNIT_LENGTH = 100;
/** The widest offset from UTC published, in minutes: 18 hours either side. */
export const MAX_UTC_OFFSET_MINUTES = 1080;

/**
 * Payload provenance, on every emitted record of every stream. A reader holds
 * records, not a manifest, so the age of the data has to travel with it.
 * `exported_at` is the export's own ExportDate — when the OWNER took the dump —
 * and is not the time collection ran.
 */
const freshnessSchema = z.literal("snapshot");
const exportedAtSchema = isoDateTimeSchema.nullable();

/**
 * Every health-area stream (activity, sleep, other and the rest; see
 * areas.ts): one record per HKRecord element with a parseable startDate, on
 * the stream of its type's area. One shape for all of them; the streams
 * differ in which records they carry. No cursor: every import re-sends every
 * record (see index.ts).
 */
export const healthRecordSchema = z.object({
	id: appleHealthIdSchema,
	type: z.string().min(1).max(MAX_TYPE_LENGTH),
	// The hardware fields of the HKDevice description, as `key:value` pairs in a
	// fixed order; never its name or identifiers (normaliseDevice in
	// parsers.ts). Null too when a description cannot be read unambiguously,
	// which the receipt names. Retained deliberately; see the residual note in
	// this file's header.
	device: z.string().min(1).max(1000).nullable(),
	// The export's own unit attribute, verbatim. Never inferred — Apple states
	// units per record and they differ by locale.
	unit: z.string().min(1).max(MAX_UNIT_LENGTH).nullable(),
	// float-capable (heart rate, body mass, etc.) — not .int(). zod's z.number()
	// already rejects NaN/Infinity, matching the builder's `Number.isFinite` gate.
	value: z.number().nullable(),
	value_raw: z.string().min(1).max(500).nullable(),
	// From the HKWasUserEntered metadata entry: did a person type this in, or did
	// a sensor record it? The one metadata key worth publishing.
	was_user_entered: z.boolean().nullable(),
	start_date: isoDateTimeSchema,
	// Minutes east of UTC at the moment recorded. isoDate normalises to UTC,
	// which keeps the instant right but loses the wall clock the owner lived in
	// — and for health data that is the fact, not a detail.
	start_utc_offset_minutes: z
		.number()
		.int()
		.min(-MAX_UTC_OFFSET_MINUTES)
		.max(MAX_UTC_OFFSET_MINUTES)
		.nullable(),
	end_date: isoDateTimeSchema.nullable(),
	creation_date: isoDateTimeSchema.nullable(),
	freshness: freshnessSchema,
	exported_at: exportedAtSchema,
});

/**
 * workouts stream: one record per HKWorkout element with a parseable startDate.
 * No cursor: every import re-sends every workout (see index.ts).
 */
// A WorkoutEvent child: HK event-type token (Pause/Resume/Segment/...), ISO
// date, and optional duration. Structural, not free text.
const workoutEventSchema = z.object({
	type: z.string().min(1).max(MAX_TYPE_LENGTH).nullable(),
	date: isoDateTimeSchema.nullable(),
	duration_minutes: z.number().nullable(),
});

/**
 * A WorkoutStatistics child, bounded to the typed quantity Apple records. An
 * open attribute bag on a published stream would carry whatever a third-party
 * application chose to write, so unknown attributes are dropped at parse time
 * rather than forwarded.
 */
const workoutStatisticsSchema = z.object({
	type: z.string().min(1).max(MAX_TYPE_LENGTH).nullable(),
	unit: z.string().min(1).max(MAX_UNIT_LENGTH).nullable(),
	sum: z.number().nullable(),
	average: z.number().nullable(),
	minimum: z.number().nullable(),
	maximum: z.number().nullable(),
});

export const workoutsSchema = z.object({
	id: appleHealthIdSchema,
	workout_activity_type: z.string().min(1).max(200).nullable(),
	duration_minutes: z.number().min(0).nullable(),
	total_energy_burned_kcal: z.number().min(0).nullable(),
	total_distance_km: z.number().min(0).nullable(),
	device: z.string().min(1).max(1000).nullable(),
	events: z.array(workoutEventSchema).nullable(),
	statistics: z.array(workoutStatisticsSchema).nullable(),
	start_date: isoDateTimeSchema,
	// Minutes east of UTC at the moment recorded. isoDate normalises to UTC,
	// which keeps the instant right but loses the wall clock the owner lived in
	// — and for health data that is the fact, not a detail.
	start_utc_offset_minutes: z
		.number()
		.int()
		.min(-MAX_UTC_OFFSET_MINUTES)
		.max(MAX_UTC_OFFSET_MINUTES)
		.nullable(),
	end_date: isoDateTimeSchema.nullable(),
	freshness: freshnessSchema,
	exported_at: exportedAtSchema,
});

/**
 * coverage_diagnostics stream: one receipt per stream per import.
 *
 * Exists as a separate stream because when an import collects nothing there are
 * no records, and therefore nowhere for a per-record diagnostic to live — which
 * is precisely when the owner most needs to know whether "nothing in range" or
 * "the import broke part way" happened. Those two have opposite next actions.
 *
 * `reason` is a closed enum and is ALWAYS populated, including on success. A
 * nullable reason invites `if (reason)` as the failure test, which renders "no
 * health data last week" as something going wrong.
 */
const coverageReasonSchema = z.enum([
	"covered_in_full",
	"nothing_in_range",
	"awaiting_upload",
	"source_unreadable",
	"export_extraction_failed",
	"collection_interrupted",
	"records_unreadable",
	"window_unavailable",
	"newer_upload_too_large",
]);

export const coverageDiagnosticsSchema = z.object({
	id: z.string().min(1).max(200),
	stream: z.string().min(1).max(200).nullable(),
	status: z.enum(["complete", "partial", "empty"]),
	reason: coverageReasonSchema,
	record_count: z.number().int().min(0).nullable(),
	// Published because the deduplication rule cannot be audited from the records
	// themselves once device names are excluded.
	duplicates_discarded: z.number().int().min(0).nullable(),
	records_skipped_unreadable: z.number().int().min(0).nullable(),
	// Records delivered on this stream whose type no area claims (areas.ts).
	// They go to `other` rather than being dropped; this makes them visible.
	records_type_unrecognized: z.number().int().min(0).nullable(),
	fields_unavailable: z.array(z.string().min(1).max(200)),
	window_requested_from: isoDateTimeSchema.nullable(),
	window_requested_to: isoDateTimeSchema.nullable(),
	window_covered_from: isoDateTimeSchema.nullable(),
	window_covered_to: isoDateTimeSchema.nullable(),
	freshness: freshnessSchema,
	exported_at: exportedAtSchema,
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 *
 * Every stream is named literally, one per line, even though the thirteen
 * health-area streams share a schema: the manifest reconciler
 * (packages/polyfill-connectors/bin/reconcile-manifests.test.ts) reads these
 * keys from the source text, and a key built at run time would be invisible
 * to it. schemas.test.ts holds the list to areas.ts.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	activity: healthRecordSchema,
	body_measurements: healthRecordSchema,
	reproductive_health: healthRecordSchema,
	hearing: healthRecordSchema,
	vital_signs: healthRecordSchema,
	lab_results: healthRecordSchema,
	sleep: healthRecordSchema,
	mindfulness: healthRecordSchema,
	nutrition: healthRecordSchema,
	alcohol_consumption: healthRecordSchema,
	mobility: healthRecordSchema,
	symptoms: healthRecordSchema,
	other: healthRecordSchema,
	workouts: workoutsSchema,
	coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

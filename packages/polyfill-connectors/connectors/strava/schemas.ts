// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Strava stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth is the record builder in parsers.ts, and these schemas mirror
 * the emitted shape field for field. They must also reconcile with the
 * hand-written JSON Schema in manifests/strava.json — nothing keeps the two in
 * sync automatically, so schemas.test.ts asserts the parity.
 *
 * What is deliberately ABSENT, and why absence is the enforcement:
 *
 *   - Location. `start_latlng`, `end_latlng` and `map_polyline` are in the
 *     export and are not here. The whole weather block is also excluded, and
 *     that is the same rule rather than a second one: sunrise and sunset on a
 *     known date give latitude, and the clock time of solar noon gives
 *     longitude, so weather is a coordinate in another notation. Over a year of
 *     activities it converges on where the owner sleeps.
 *   - Identity and free text. `Activity Name`, `Activity Description` and
 *     `Activity Private Note` are all owner-written, and the first is the one
 *     owners actually fill in — "Parkrun with Dad" is a third party's name in a
 *     record about someone else. `Athlete Weight` and `Bike Weight` are body
 *     measurements rather than facts about an activity. `profile.csv` is never
 *     opened at all.
 *
 * A field that is never in the schema cannot be requested by mistake, which is
 * why this is done here rather than by asking readers not to ask.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const NUMERIC_ID_RE = /^\d{1,30}$/; // String(numeric Strava activity id)
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Every numeric in this export is absent far more often than it is zero — a
 * ride with no strap has no heart rate, most activities have no calories. The
 * builder maps an empty cell to null and never to 0, so a missing reading can
 * never be mistaken for a measured one.
 */
const metricSchema = z.number().nullable();

const isoDateTime = z.string().regex(ISO_DT_RE, "must be an ISO-8601 datetime");

/**
 * `start_time` carries a UTC offset ONLY when the archive stated one. Strava's
 * own rendering does not, so a naked local-form timestamp is the normal case
 * and `start_time_basis` is what says whether an instant can be derived from
 * it. This is why the published schema does not claim `format: "date-time"` on
 * that field: RFC-3339 requires an offset, and declaring the format while
 * emitting a zoneless value would hand readers a false instant — the same
 * class of defect as reading miles as metres.
 */

/**
 * Which clock `start_time` is on. The archive carries a single date column and
 * does not state its basis anywhere, so this records what was determined from
 * the file rather than what was assumed about it. `unknown` is an honest and
 * expected value: a reader seeing it must not make time-of-day claims, because
 * an evening ride in one timezone is an afternoon one in another.
 */
export const START_TIME_BASES = ["utc", "local", "unknown"] as const;

/** How a reading was collected. An export is always a snapshot. */
export const FRESHNESS_VALUES = ["live", "snapshot"] as const;

/**
 * Why a covered window ends where it does. Closed, and always populated —
 * including on success, via `covered_in_full`. A nullable reason would invite
 * `if (reason)` as the failure test, which would classify "no activities last
 * week" as something going wrong.
 *
 * The values are next-action shaped rather than cause shaped: each one ends in
 * a different sentence to the owner, and each has a `reason_display_messages`
 * entry in the manifest carrying that sentence. `nothing_in_range` and
 * `collection_interrupted` are the pair that matters most — both can produce an
 * empty result, and they have opposite next actions.
 */
export const COVERAGE_REASONS = [
	"covered_in_full",
	"nothing_in_range",
	"awaiting_upload",
	"source_unreadable",
	"source_limit_reached",
	"collection_interrupted",
	"records_unreadable",
	"sign_in_required",
	"window_unavailable",
] as const;

export const COVERAGE_STATUSES = ["complete", "partial", "empty"] as const;

/**
 * activities stream: one record per workout in the owner's export.
 * Cursor: start_time. Primary key: id, which is Strava's own activity id and
 * is stable across separate exports — two archives a month apart overlap
 * almost entirely, and this is what lets the overlap collapse instead of
 * double-counting.
 */
export const activitiesSchema = z.object({
	id: z
		.string()
		.regex(NUMERIC_ID_RE, "id must be a numeric Strava activity id"),
	activity_type: z.string().min(1).max(64).nullable(),
	start_date: z.string().regex(ISO_DATE_RE, "start_date must be YYYY-MM-DD"),
	start_time: isoDateTime,
	start_time_basis: z.enum(START_TIME_BASES),
	distance_m: metricSchema,
	moving_time_s: metricSchema,
	elapsed_time_s: metricSchema,
	total_elevation_gain_m: metricSchema,
	average_heartrate: metricSchema,
	max_heartrate: metricSchema,
	calories_kcal: metricSchema,
	gear: pdppSafeText.max(200).nullable(),
	freshness: z.enum(FRESHNESS_VALUES),
	exported_at: isoDateTime.nullable(),
});

/**
 * coverage_diagnostics stream: one record per stream per import, stating what
 * was covered and why it stops there.
 *
 * This is a separate stream rather than fields on each activity for a reason
 * that decides it on correctness, not taste: when nothing is collected there
 * are no activity records, so there would be nowhere for the diagnostic to
 * live — and "nothing in range" and "collection interrupted" are exactly the
 * two cases that produce an empty result and need telling apart.
 */
export const coverageDiagnosticsSchema = z.object({
	id: z.string().min(1).max(200),
	stream: z.string().min(1).max(64).nullable(),
	status: z.enum(COVERAGE_STATUSES),
	reason: z.enum(COVERAGE_REASONS),
	record_count: z.number().int().min(0).nullable(),
	fields_unavailable: z.array(z.string().min(1).max(64)).max(32),
	window_requested_from: isoDateTime.nullable(),
	window_requested_to: isoDateTime.nullable(),
	window_covered_from: isoDateTime.nullable(),
	window_covered_to: isoDateTime.nullable(),
	freshness: z.enum(FRESHNESS_VALUES),
	exported_at: isoDateTime.nullable(),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	activities: activitiesSchema,
	coverage_diagnostics: coverageDiagnosticsSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

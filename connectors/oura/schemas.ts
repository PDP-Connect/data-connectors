// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Oura stream records. Shape-check-before-emit per
 * docs/reference/connector-authoring-guide.md §3.
 *
 * Ground truth: the `sleepRecord` / `readinessRecord` / `activityRecord`
 * builders in index.ts. Schemas mirror the *emitted* shape:
 *
 *   - `id` is the Oura document id — a UUID returned by the v2 API. Required
 *     (the builder reads `s.id` unconditionally).
 *   - `day` is the calendar date the document belongs to (`YYYY-MM-DD`); it is
 *     the cursor field, always present.
 *   - `bedtime_start` / `bedtime_end` are ISO-8601 datetimes (with offset) or
 *     null.
 *   - All physiological metrics are nullable numbers. They are NOT constrained
 *     to integers: Oura returns floats for HRV, efficiency, temperature deltas,
 *     and walking-equivalent distance, and the builder passes them through
 *     unchanged. Durations/steps/calories happen to arrive as integers but are
 *     left as `z.number()` to follow the passthrough rather than over-constrain.
 *   - `contributors` (readiness, activity, sleep) is the raw Oura contributors
 *     object, an opaque provider map the builder forwards verbatim
 *     (`r.contributors ?? {}`). It is genuinely opaque key→score data, so it
 *     is typed as a record of numbers/nulls rather than enumerated — see note
 *     on the schema. On `sleep` it is joined in from the separate
 *     /usercollection/daily_sleep resource by day (see index.ts collectSleep),
 *     not the /usercollection/sleep session document itself.
 *   - `sleep.type` is Oura's v2 session-type string (e.g. long_sleep, sleep,
 *     late_nap, rest); bounded free text, not an enumerated union, since Oura
 *     documents this as an evolving provider-defined set.
 *
 * No free-form human text fields exist on any Oura stream, so this module has
 * no `pdppSafeText` usage; every string is structurally constrained (UUID /
 * date / datetime / bounded session-type string).
 *
 * No live Oura token is available in this environment; the sleep/activity
 * additions below are typed per the documented v2 API field names
 * (average_breath, restless_periods, time_in_bed, type, high/medium/low_
 * activity_time, sedentary_time, resting_time, inactivity_alerts) and are
 * NOT yet confirmed against a real captured response — see
 * legacy-derivability.json (oura.activity, oura.sleep) for the live-proof-
 * pending caveat. Synthetic-but-shape-calibrated fixtures only.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

// Module-scoped regexes (Biome useTopLevelRegex).
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const ouraIdSchema = z
	.string()
	.regex(UUID_RE, "id must be an Oura document UUID");
const daySchema = z.string().regex(DAY_RE, "day must be YYYY-MM-DD");
const isoDateTimeNullable = z
	.string()
	.regex(ISO_DT_RE, "must be an ISO-8601 datetime")
	.nullable();
// Physiological metrics: nullable floats. Oura returns floats for HRV /
// efficiency / temperature; do not force .int() (would reject real records).
const metricSchema = z.number().nullable();

/**
 * sleep stream: one record per nightly sleep session.
 * Cursor: day.
 */
export const sleepSchema = z.object({
	id: ouraIdSchema,
	day: daySchema,
	bedtime_start: isoDateTimeNullable,
	bedtime_end: isoDateTimeNullable,
	total_sleep_duration: metricSchema,
	rem_sleep_duration: metricSchema,
	deep_sleep_duration: metricSchema,
	light_sleep_duration: metricSchema,
	efficiency: metricSchema,
	latency: metricSchema,
	average_heart_rate: metricSchema,
	lowest_heart_rate: metricSchema,
	average_hrv: metricSchema,
	temperature_delta: metricSchema,
	sleep_score: metricSchema,
	average_breath: metricSchema,
	restless_periods: metricSchema,
	time_in_bed: metricSchema,
	// Oura's v2 sleep `type` enum (long_sleep / sleep / late_nap / rest, etc.).
	// Not enumerated here since Oura documents it as an evolving set of
	// provider-defined session-type strings; bounded free text, not a fixed
	// enum, same posture as readiness/activity's opaque `contributors` keys.
	type: z.string().min(1).max(64).nullable(),
	// The daily_sleep contributors map (same opaque key -> 0-100 sub-score
	// shape as readiness.contributors); empty object when the joined
	// daily_sleep document was absent or had none.
	contributors: z.record(z.string(), z.number().nullable()),
});

/**
 * readiness stream: one record per daily readiness document.
 * `contributors` is Oura's opaque contributors map (key → 0-100 sub-score).
 * The builder forwards it verbatim; we constrain values to nullable numbers
 * (their documented shape) without enumerating keys, since Oura adds/renames
 * contributors across firmware versions.
 */
export const readinessSchema = z.object({
	id: ouraIdSchema,
	day: daySchema,
	score: metricSchema,
	temperature_deviation: metricSchema,
	temperature_trend_deviation: metricSchema,
	contributors: z.record(z.string(), z.number().nullable()),
});

/**
 * activity stream: one record per daily activity document.
 * Cursor: day.
 */
export const activitySchema = z.object({
	id: ouraIdSchema,
	day: daySchema,
	score: metricSchema,
	active_calories: metricSchema,
	total_calories: metricSchema,
	steps: metricSchema,
	target_calories: metricSchema,
	equivalent_walking_distance: metricSchema,
	high_activity_time: metricSchema,
	medium_activity_time: metricSchema,
	low_activity_time: metricSchema,
	sedentary_time: metricSchema,
	resting_time: metricSchema,
	inactivity_alerts: metricSchema,
	contributors: z.record(z.string(), z.number().nullable()),
});

/**
 * Stream → schema registry. Single source of truth for emitted streams.
 */
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	sleep: sleepSchema,
	readiness: readinessSchema,
	activity: activitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

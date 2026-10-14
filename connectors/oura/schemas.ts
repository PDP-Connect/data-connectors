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
 *   - Fractional source metrics (HRV, efficiency, temperature, walking distance)
 *     stay numbers. Legacy integer fields and scores use integer validators.
 *   - `contributors` (readiness, activity, sleep) is the raw Oura contributors
 *     object, an opaque provider map the builder forwards verbatim
 *     (`r.contributors ?? {}`). It is genuinely opaque key→score data, so it
 *     is typed as a record of numbers/nulls rather than enumerated — see note
 *     on the schema. On `sleep` it is joined in from the separate
 *     /usercollection/daily_sleep resource by day (see index.ts collectSleep),
 *     not the /usercollection/sleep session document itself.
 *   - `sleep.type` remains bounded source text. The frozen legacy enum is
 *     narrower; an unrecognized source value is retained for cutover review.
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

const ouraIdSchema = z
	.string()
	.regex(UUID_RE, "id must be an Oura document UUID");
const daySchema = z.iso.date();
const isoDateTimeNullable = z.iso.datetime({ offset: true }).nullable();
// Source floats remain exact; do not round them to satisfy the frozen legacy schema.
const metricSchema = z.number().nullable();
const integerSchema = z.int().nullable();
const scoreSchema = z.int().min(0).max(100).nullable();

/**
 * sleep stream: session and daily score records with independent source IDs.
 * Cursor: day.
 */
export const sleepSessionSchema = z.object({
	record_type: z.literal("sleep_session"),
	id: ouraIdSchema,
	day: daySchema,
	daily_sleep_id: ouraIdSchema.nullable(),
	daily_sleep_timestamp: isoDateTimeNullable,
	bedtime_start: isoDateTimeNullable,
	bedtime_end: isoDateTimeNullable,
	total_sleep_duration: integerSchema,
	rem_sleep_duration: integerSchema,
	deep_sleep_duration: integerSchema,
	light_sleep_duration: integerSchema,
	efficiency: metricSchema,
	latency: integerSchema,
	average_heart_rate: metricSchema,
	lowest_heart_rate: integerSchema,
	average_hrv: metricSchema,
	temperature_delta: metricSchema,
	sleep_score: scoreSchema,
	average_breath: metricSchema,
	restless_periods: integerSchema,
	time_in_bed: integerSchema,
	awake_time: integerSchema,
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

const dailyScoreSchema = z.object({
	record_type: z.literal("daily_score"),
	id: ouraIdSchema,
	day: daySchema,
	daily_sleep_id: ouraIdSchema,
	daily_sleep_timestamp: isoDateTimeNullable,
	sleep_score: scoreSchema,
	contributors: z.record(z.string(), z.number().nullable()),
});

export const sleepSchema = z.discriminatedUnion("record_type", [
	sleepSessionSchema,
	dailyScoreSchema,
]);

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
	timestamp: isoDateTimeNullable,
	score: scoreSchema,
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
	timestamp: isoDateTimeNullable,
	score: scoreSchema,
	active_calories: integerSchema,
	total_calories: integerSchema,
	steps: integerSchema,
	target_calories: integerSchema,
	equivalent_walking_distance: metricSchema,
	high_activity_time: integerSchema,
	medium_activity_time: integerSchema,
	low_activity_time: integerSchema,
	sedentary_time: integerSchema,
	resting_time: integerSchema,
	inactivity_alerts: integerSchema,
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

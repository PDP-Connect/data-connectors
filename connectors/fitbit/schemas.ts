// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Fitbit export records. Ground truth is the record builders
 * in parsers.ts and the day book in days.ts; these mirror the emitted shape
 * field for field and must reconcile with the hand-written JSON Schema in
 * manifest.json, which schemas.test.ts asserts.
 *
 * Every schema is strict. The runtime emits the builder's own object, not
 * Zod's parsed copy, so a key the schema does not declare would otherwise
 * reach a reader unannounced. A strict schema turns that key into a failed
 * validation, and collect.ts validates before it emits, so a failing record
 * is counted and never handed to the runtime.
 *
 * What is deliberately ABSENT, and why absence is the enforcement:
 *
 *   - Location and its proxies. GPS files are never opened. The exercise
 *     route-file link and GPS flag, and the profile's country, state and
 *     city, are never read. The profile's time zone is read only to place
 *     step and distance minutes on local days, then dropped. No local time
 *     of day is kept: Fitbit's sleep start and end times and stage timelines
 *     are local wall-clock, and the sleep score file's timestamp is local
 *     time marked as UTC. Beside a UTC instant, a local time gives the
 *     owner's UTC offset, and a series of offsets is a travel history.
 *   - Identity. Every other profile cell, the avatar, paired devices, the
 *     exercise's device source (name, id, url), and every account, security
 *     and audit file. Fitbit's own exercise and sleep log ids are kept; the
 *     manifest states that Fitbit assigns them in time order.
 *   - Free text. Exercise names the owner typed (only a name on a fixed list
 *     of Fitbit's exercise types becomes activity_type), the profile's
 *     about-me text, journals and notes.
 *   - Audit clocks. When a log was last modified, and its original start
 *     time and duration.
 *   - Readings out of scope. Calories, floors and altitude, sedentary
 *     minutes, heart rate through the day and its zones, active zone
 *     minutes, HRV, SpO2, temperature, stress, readiness, VO2 max and weight.
 *   - Paths. Member names, the upload's name, the import folder and scratch
 *     paths.
 *
 * A field that is never in the schema cannot be requested by mistake, which is
 * why this is done here rather than by asking readers not to ask.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

/**
 * The data streams, in collection order. Lives here rather than in
 * collect.ts so archive.ts and parsers.ts can key their tables by it without
 * importing the collector.
 */
export const DATA_STREAMS = ["activities", "daily_summaries", "sleep"] as const;
export type DataStream = (typeof DATA_STREAMS)[number];

// Module-scoped regexes (Biome useTopLevelRegex). Builders derive every string
// to match them, so a bad value makes the row unreadable instead of producing
// a record the schema then refuses.
/** String(logId): Fitbit's exercise and sleep log id, a positive safe integer. */
export const LOG_ID_RE = /^[1-9]\d{0,15}$/;
/** The shape every code on this import's list of Fitbit exercise types has; the list itself decides which names become codes. */
export const ACTIVITY_TYPE_RE = /^[a-z][a-z0-9_]{0,63}$/;
export const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** A UTC instant to the second. No `format` in the manifest, as Strava's. */
const START_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** The date-time prefix every date-time field starts with; a year past 9999 fails it. */
export const ISO_DT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

/**
 * Which clock `start_time` is on. Only `utc` is declared because only `utc`
 * is emitted: no local start time is read. The field is kept so a reader of
 * several activity sources branches on it the same way.
 */
export const START_TIME_BASES = ["utc"] as const;

/** How a reading was collected. An export is always a snapshot. */
export const FRESHNESS_VALUES = ["live", "snapshot"] as const;

/** The daily summary's reading fields. */
export const DAILY_FIELDS = [
	"steps",
	"distance_m",
	"lightly_active_minutes",
	"moderately_active_minutes",
	"very_active_minutes",
	"resting_heart_rate_bpm",
] as const;
export type DailyField = (typeof DAILY_FIELDS)[number];

/**
 * Each stream's nullable reading fields: the ones its coverage line's
 * `fields_unavailable` may name, when no row of the whole export carried
 * them. That tells a device without a feature, or an export without a file,
 * apart from a run of absent readings.
 */
export const OPTIONAL_READING_FIELDS: Readonly<
	Record<DataStream, readonly string[]>
> = {
	activities: ["activity_type", "distance_m", "elapsed_time_s"],
	daily_summaries: DAILY_FIELDS,
	sleep: [
		"is_main_sleep",
		"sleep_score",
		"asleep_duration_s",
		"awake_duration_s",
		"deep_sleep_duration_s",
		"light_sleep_duration_s",
		"rem_sleep_duration_s",
	],
};

/**
 * Null means Fitbit recorded nothing, or held a value that could not be read
 * (the coverage line then names the field in `fields_unreadable`). Never 0
 * for an absent reading. Zod 4's number already refuses NaN and Infinity.
 */
const amount = z.number().min(0).nullable();
const whole = z.number().int().min(0).nullable();
const day = z.string().regex(CALENDAR_DATE_RE);
const isoDateTime = z.string().regex(ISO_DT_RE);
const freshness = z.enum(FRESHNESS_VALUES);
/** Present on every record; null only when neither the Takeout stamp nor the upload's modification time could be read. */
const exportedAt = isoDateTime.nullable();

/**
 * activities: one record per exercise log. `id` is Fitbit's logId, stable
 * across exports, so a later export replaces the earlier record.
 * `start_date` is the UTC day of `start_time`, never the owner's local day.
 */
export const activitiesSchema = z.strictObject({
	id: z.string().regex(LOG_ID_RE),
	activity_type: z.string().regex(ACTIVITY_TYPE_RE).nullable(),
	start_date: day,
	start_time: z.string().regex(START_TIME_RE),
	start_time_basis: z.enum(START_TIME_BASES),
	distance_m: amount,
	elapsed_time_s: amount,
	freshness,
	exported_at: exportedAt,
});

/**
 * daily_summaries: one record per local day with a reading; `id` is the date.
 * Steps and distance are sums of UTC minutes placed on the profile zone's
 * local days; the other four are Fitbit's own values for its local day.
 */
export const dailySummariesSchema = z.strictObject({
	id: day,
	date: day,
	steps: whole,
	distance_m: amount,
	lightly_active_minutes: whole,
	moderately_active_minutes: whole,
	very_active_minutes: whole,
	resting_heart_rate_bpm: z.number().positive().nullable(),
	freshness,
	exported_at: exportedAt,
});

/**
 * sleep: one record per sleep log, naps included, dated by the local day the
 * sleep ended. `id` is Fitbit's logId, so a date can have several records.
 */
export const sleepSchema = z.strictObject({
	id: z.string().regex(LOG_ID_RE),
	date: day,
	is_main_sleep: z.boolean().nullable(),
	sleep_score: amount,
	asleep_duration_s: amount,
	awake_duration_s: amount,
	deep_sleep_duration_s: amount,
	light_sleep_duration_s: amount,
	rem_sleep_duration_s: amount,
	freshness,
	exported_at: exportedAt,
});

export type ActivityRecord = z.infer<typeof activitiesSchema>;
export type DailySummaryRecord = z.infer<typeof dailySummariesSchema>;
export type SleepRecord = z.infer<typeof sleepSchema>;
/** A record of any data stream: what a builder returns. */
export type FitbitRecord = ActivityRecord | DailySummaryRecord | SleepRecord;

// Stream → schema registry. Keep it a flat literal with no braces inside:
// the manifest reconciler (src/manifest-reconcile.ts) reads it with a regex.
export const SCHEMAS: Record<string, z.ZodTypeAny> = {
	activities: activitiesSchema,
	daily_summaries: dailySummariesSchema,
	sleep: sleepSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

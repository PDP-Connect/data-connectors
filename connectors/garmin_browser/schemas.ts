// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record schemas for the five streams. Strict objects, so a stray key fails validation instead of
 * shipping. Garmin's vocabularies (sleep rating, HRV status, training status, activity type) are
 * plain strings: an enum would turn Garmin's next new value into a lost record. The ranges double
 * as unit guards: a value outside them means Garmin changed a unit, and the record is counted
 * unreadable rather than emitted wrong.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

export const STREAMS = [
	"daily_summaries",
	"sleep",
	"hrv",
	"training_status",
	"activities",
] as const;
export type Stream = (typeof STREAMS)[number];

const DAY_S = 86_400;

/** A calendar day, YYYY-MM-DD. */
const day = z.iso.date();
/** RFC 3339 in UTC with milliseconds, as `Date#toISOString` writes it. */
const instant = z.iso.datetime({ precision: 3 });
const vocabulary = z.string().min(1).nullable();
const heartRate = z.int().min(1).max(300).nullable();
const zeroTo100 = z.int().min(0).max(100).nullable();
const sleepSeconds = z.int().min(0).max(DAY_S).nullable();
/** Milliseconds; a thousand or more would mean Garmin changed the unit. */
const hrvMs = z.int().gt(0).lt(1000).nullable();
const nonNegative = z.number().min(0).nullable();
/** Activities: Garmin sends heart rate as an integer or a float such as 142.0. */
const activityHeartRate = z.number().min(1).max(300).nullable();

const dailySummarySchema = z.strictObject({
	id: day,
	date: day,
	steps: z.int().min(0).nullable(),
	resting_heart_rate_bpm: heartRate,
	min_heart_rate_bpm: heartRate,
	average_stress_level: zeroTo100,
	body_battery_high: zeroTo100,
	body_battery_low: zeroTo100,
});

const sleepSchema = z.strictObject({
	id: day,
	date: day,
	start_at: instant,
	end_at: instant.nullable(),
	total_sleep_duration_s: sleepSeconds,
	deep_sleep_duration_s: sleepSeconds,
	light_sleep_duration_s: sleepSeconds,
	rem_sleep_duration_s: sleepSeconds,
	awake_duration_s: sleepSeconds,
	sleep_score: zeroTo100,
	sleep_quality: vocabulary,
	respiratory_rate_rpm: z.number().gt(0).lt(100).nullable(),
	blood_oxygen_pct: z.number().min(50).max(100).nullable(),
});

const hrvSchema = z.strictObject({
	id: day,
	date: day,
	last_night_average_ms: hrvMs,
	weekly_average_ms: hrvMs,
	status: vocabulary,
});

const trainingStatusSchema = z.strictObject({
	id: day,
	date: day,
	training_status: vocabulary,
	training_status_code: z.int().nullable(),
	weekly_training_load: nonNegative,
	training_paused: z.boolean().nullable(),
});

const activitySchema = z.strictObject({
	id: z.string().regex(/^[1-9]\d*$/),
	activity_type: vocabulary,
	start_at: instant,
	start_date: day,
	elapsed_time_s: nonNegative,
	moving_time_s: nonNegative,
	distance_m: nonNegative,
	calories_kcal: nonNegative,
	average_heart_rate_bpm: activityHeartRate,
	max_heart_rate_bpm: activityHeartRate,
});

export const SCHEMAS: Record<Stream, z.ZodType> = {
	daily_summaries: dailySummarySchema,
	sleep: sleepSchema,
	hrv: hrvSchema,
	training_status: trainingStatusSchema,
	activities: activitySchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

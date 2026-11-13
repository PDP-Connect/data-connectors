// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record schemas for the four streams. Strict objects, so a stray key fails validation instead of
 * shipping. COROS's sport names are plain strings: an enum would turn COROS's next new sport into
 * a lost record. The ranges double as unit guards: a value outside them means COROS changed a
 * unit, and the record is counted unreadable rather than emitted wrong.
 */

import { pdppSafeText } from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

export const STREAMS = [
	"profile",
	"activities",
	"daily_metrics",
	"planned_workouts",
] as const;
export type Stream = (typeof STREAMS)[number];

/** A calendar day, YYYY-MM-DD. */
const day = z.iso.date();
/** RFC 3339 in UTC with milliseconds, as `Date#toISOString` writes it. */
const instant = z.iso.datetime({ precision: 3 });
const sportName = z
	.string()
	.regex(/^[A-Za-z][A-Za-z0-9_]*$/)
	.nullable();
const heartRate = z.number().min(1).max(300).nullable();
const nonNegative = z.number().min(0).nullable();
/** Milliseconds; a thousand or more would mean COROS changed the unit. */
const hrvMs = z.number().gt(0).lt(1000).nullable();
/** COROS ids are digits, sometimes long enough to need a string. */
const corosId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);

const profileSchema = z.strictObject({
	id: corosId,
	nickname: pdppSafeText.max(200).nullable(),
	region: z.enum(["us", "cn", "eu", "sg"]),
	unit_system: z.enum(["metric", "imperial"]).nullable(),
	activity_count: z.int().min(0).nullable(),
	resting_heart_rate_bpm: heartRate,
	threshold_heart_rate_bpm: heartRate,
	max_heart_rate_bpm: heartRate,
});

const activitySchema = z.strictObject({
	id: corosId,
	sport_type: z.int(),
	sport: sportName,
	start_at: instant,
	end_at: instant.nullable(),
	start_date: day.nullable(),
	utc_offset_minutes: z
		.int()
		.min(-16 * 60)
		.max(16 * 60)
		.nullable(),
	total_time_s: nonNegative,
	workout_time_s: nonNegative,
	distance_m: nonNegative,
	calories_kcal: nonNegative,
	average_heart_rate_bpm: heartRate,
	training_load: nonNegative,
	ascent_m: nonNegative,
	descent_m: nonNegative,
	average_power_w: z.number().gt(0).lt(5000).nullable(),
	average_cadence: z.number().gt(0).lt(1000).nullable(),
	steps: z.int().min(0).nullable(),
	device: pdppSafeText.max(200).nullable(),
});

const dailyMetricsSchema = z.strictObject({
	id: day,
	date: day,
	resting_heart_rate_bpm: heartRate,
	hrv_ms: hrvMs,
	hrv_normal_low_ms: hrvMs,
	hrv_normal_high_ms: hrvMs,
	training_load: nonNegative,
	acute_load: nonNegative,
	chronic_load: nonNegative,
	fatigue: z.number().nullable(),
	load_ratio: nonNegative,
	vo2max: z.number().gt(0).lt(100).nullable(),
	threshold_heart_rate_bpm: heartRate,
	threshold_pace_s_per_km: z.number().gt(0).lt(3600).nullable(),
	stamina_level: z.number().nullable(),
	stamina_level_7d: z.number().nullable(),
});

const plannedWorkoutSchema = z.strictObject({
	id: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}:[0-9A-Za-z_-]{0,64}:[0-9A-Za-z_-]{1,64}$/),
	date: day,
	name: pdppSafeText.max(500).nullable(),
	sport_type: z.int().nullable(),
	sport: sportName,
	planned_training_load: nonNegative,
	completion_rate: nonNegative,
	completed_activity_id: corosId.nullable(),
});

export const SCHEMAS: Record<Stream, z.ZodType> = {
	profile: profileSchema,
	activities: activitySchema,
	daily_metrics: dailyMetricsSchema,
	planned_workouts: plannedWorkoutSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

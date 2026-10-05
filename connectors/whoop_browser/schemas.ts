// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record schemas for the four streams. Strict objects, so a stray key fails validation instead of
 * shipping. The ranges double as unit guards: a value outside them means WHOOP changed a unit,
 * and the record is counted unreadable rather than emitted wrong.
 */

import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

export const STREAMS = ["cycles", "recoveries", "sleeps", "workouts"] as const;
export type Stream = (typeof STREAMS)[number];

const DAY_MS = 86_400_000;

/** RFC 3339 in UTC with milliseconds, as `Date#toISOString` writes it. */
const instant = z.iso.datetime({ precision: 3 });
const offset = z
	.string()
	.regex(/^[+-]\d{2}:\d{2}$/)
	.nullable();
const cycleId = z.string().regex(/^[1-9]\d*$/);
const heartRate = z.int().min(1).max(300).nullable();
const strain = z.number().min(0).max(21).nullable();
const kilojoules = z.number().min(0).nullable();
const percentage = z.number().min(0).max(100).nullable();
const sleepMs = z.int().min(0).max(DAY_MS).nullable();

const cycleSchema = z.strictObject({
	id: cycleId,
	start_at: instant,
	end_at: instant.nullable(),
	day: z.iso.date().nullable(),
	timezone_offset: offset,
	strain,
	kilojoules,
	average_heart_rate: heartRate,
	max_heart_rate: heartRate,
});

const recoverySchema = z.strictObject({
	id: cycleId,
	start_at: instant,
	sleep_id: z.string().min(1).nullable(),
	recovery_score: percentage,
	// WHOOP sends seconds; one second or more would mean it switched to milliseconds.
	hrv_rmssd_ms: z.number().gt(0).lt(1000).nullable(),
	resting_heart_rate: heartRate,
	spo2_percentage: percentage,
	skin_temp_celsius: z.number().nullable(),
});

const sleepSchema = z.strictObject({
	id: z.string().min(1),
	cycle_id: cycleId,
	start_at: instant,
	end_at: instant.nullable(),
	timezone_offset: offset,
	is_nap: z.boolean().nullable(),
	performance_percentage: percentage,
	respiratory_rate: z.number().gt(0).lt(100).nullable(),
	in_bed_ms: sleepMs,
	awake_ms: sleepMs,
	light_ms: sleepMs,
	slow_wave_ms: sleepMs,
	rem_ms: sleepMs,
});

const workoutSchema = z.strictObject({
	id: z.string().min(1),
	cycle_id: cycleId,
	start_at: instant,
	end_at: instant.nullable(),
	timezone_offset: offset,
	sport_id: z.int().nullable(),
	strain,
	kilojoules,
	average_heart_rate: heartRate,
	max_heart_rate: heartRate,
});

export const SCHEMAS: Record<Stream, z.ZodType> = {
	cycles: cycleSchema,
	recoveries: recoverySchema,
	sleeps: sleepSchema,
	workouts: workoutSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

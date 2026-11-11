// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Zod schemas for Polar Flow, at both ends:
 *
 * - API responses (the boundary): the JSON flow.polar.com and sleep-api.flow.polar.com answer the
 *   signed-in web app with. Loose objects, so a field Polar adds is ignored, but every field a
 *   record is built from is typed: a value of another JSON type fails the parse, and the row is
 *   unreadable instead of guessed. Shapes follow the web app's own bundle and public recorded
 *   responses (see fixtures/README.md); they are not yet confirmed against a populated account.
 * - Records: strict objects, so a stray key fails validation instead of shipping. Ranges double as
 *   unit guards: a value outside them means Polar changed a unit, and the record is unreadable.
 *   Polar's vocabularies (sport names, sleep rating, training background) stay plain strings: an
 *   enum would turn Polar's next value into a lost record.
 */

import {
	nullablePdppSafeText,
	pdppSafeText,
} from "@pdpp/connector-protocol/pdpp-safe-text";
import { z } from "zod";
import { makeValidateRecord } from "../../packages/polyfill-connectors/src/schema-registry.ts";

export const STREAMS = [
	"profile",
	"training_sessions",
	"daily_activity",
	"sleep",
	"nightly_recharge",
] as const;
export type Stream = (typeof STREAMS)[number];

// ─── API responses (boundary) ────────────────────────────────────────────

/** A JSON number that may be absent or null; both read as null. */
const num = z.number().nullish();
const int = z.int().nullish();
const str = z.string().nullish();

/** GET /api/account/users/current/user */
export const currentUserResponse = z.looseObject({
	user: z.looseObject({
		id: z.int().positive(),
		firstName: str,
		lastName: str,
		country: str,
	}),
	localizationInfo: z
		.looseObject({
			timeZone: str,
			measurementUnit: str,
			flowLanguage: str,
		})
		.nullish(),
	physicalInfo: z
		.looseObject({
			birthday: z.array(z.int()).nullish(),
			sex: str,
			trainingBackground: str,
			weight: num,
			height: num,
			maximumHeartRate: int,
			restingHeartRate: int,
			aerobicThreshold: int,
			anaerobicThreshold: int,
			vo2Max: int,
			functionalThresholdPower: int,
			sleepGoal: num,
		})
		.nullish(),
});
export type CurrentUserResponse = z.infer<typeof currentUserResponse>;

/** One row of POST /api/training/history. `duration` is milliseconds. */
export const trainingHistoryRow = z.looseObject({
	id: z.int().positive(),
	duration: z.number(),
	distance: num,
	hrAvg: num,
	calories: num,
	note: str,
	sportName: str,
	sportId: z.int(),
	startDate: z.string(),
	isTest: z.boolean().nullish(),
	hasTrainingTarget: z.boolean().nullish(),
});
export type TrainingHistoryRow = z.infer<typeof trainingHistoryRow>;
export const trainingHistoryResponse = z.array(z.unknown());

/** GET /api/training/analysis/{id}/summary, the fields read from it. */
export const trainingSummaryResponse = z.looseObject({
	id: z.int().positive(),
	startDate: str,
	stopTime: str,
	hrMax: num,
	hrAverage: num,
	kiloCalories: num,
	trainingLoad: num,
	timezoneOffset: int,
	deviceName: str,
	trainingSessionName: str,
});
export type TrainingSummaryResponse = z.infer<typeof trainingSummaryResponse>;

/** One day of GET /api/activity-timeline/loadFour, keyed by YYYY-MM-DD in the answer. */
export const activityDay = z.looseObject({
	dataPanelData: z
		.looseObject({
			dailyActivityGoal: num,
			activeTime: num,
			distanceFromSteps: num,
			stepCount: num,
			kiloCalories: num,
			sleepDuration: num,
			inactivityAlertCount: num,
		})
		.nullish(),
	activityGraphData: z
		.looseObject({
			lastSync: num,
			heartRateSummary: z
				.looseObject({
					dayMinimum: num,
					dayMaximum: num,
					nightMinimum: num,
				})
				.nullish(),
		})
		.nullish(),
	activityScoreData: z
		.looseObject({
			sedentaryDuration: num,
			lightDuration: num,
			moderateDuration: num,
			vigorousDuration: num,
		})
		.nullish(),
});
export type ActivityDay = z.infer<typeof activityDay>;
export const activityTimelineResponse = z.record(z.string(), z.unknown());

/** One night of GET sleep-api.flow.polar.com/api/sleep/report. */
export const sleepNight = z.looseObject({
	date: z.string(),
	sleepStartTime: z.string(),
	sleepEndTime: z.string(),
	sleepStartOffset: int,
	sleepEndOffset: int,
	sleepScore: num,
	continuityIndex: num,
	continuityClass: int,
	sleepCycles: int,
	sleepRating: str,
});
export type SleepNight = z.infer<typeof sleepNight>;
export const sleepReportResponse = z.array(z.unknown());

/** One night of GET /api/nightly-recovery/{start}/{end}. Intervals are milliseconds. */
export const nightlyRecovery = z.looseObject({
	date: z.string(),
	recoveryIndicator: num,
	ansStatus: num,
	ansRate: num,
	rri: num,
	rri28dayAverage: num,
	rmssd: num,
	rmssd28dayAverage: num,
	respirationInterval: num,
	respirationInterval28dayAverage: num,
});
export type NightlyRecovery = z.infer<typeof nightlyRecovery>;
export const nightlyRecoveryResponse = z.array(z.unknown());

// ─── Records ─────────────────────────────────────────────────────────────

/** A calendar day, YYYY-MM-DD. */
const day = z.iso.date();
/** A wall-clock time Polar gives without a zone, YYYY-MM-DDTHH:MM:SS. */
const localTime = z.iso.datetime({ local: true, precision: 0 });
/** RFC 3339 in UTC with milliseconds, as `Date#toISOString` writes it. */
const instant = z.iso.datetime({ precision: 3 });
const vocabulary = pdppSafeText.min(1).max(200).nullable();
const heartRate = z.int().min(1).max(300).nullable();
const nonNegative = z.number().min(0).nullable();
const minutesOfDay = z.int().min(0).max(1440).nullable();

const profileSchema = z.strictObject({
	id: z.string().regex(/^[1-9]\d*$/),
	first_name: nullablePdppSafeText,
	last_name: nullablePdppSafeText,
	country: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.nullable(),
	birthday: day.nullable(),
	sex: vocabulary,
	training_background: vocabulary,
	weight_kg: z.number().gt(0).lt(700).nullable(),
	height_cm: z.number().gt(0).lt(300).nullable(),
	max_heart_rate_bpm: heartRate,
	resting_heart_rate_bpm: heartRate,
	aerobic_threshold_bpm: heartRate,
	anaerobic_threshold_bpm: heartRate,
	vo2max: z.int().min(1).max(120).nullable(),
	functional_threshold_power_w: z.int().min(1).max(3000).nullable(),
	sleep_goal_hours: z.number().gt(0).max(24).nullable(),
	utc_offset: z
		.string()
		.regex(/^[+-]\d{2}:\d{2}$/)
		.nullable(),
	measurement_unit: vocabulary,
	language: vocabulary,
});

const trainingSessionSchema = z.strictObject({
	id: z.string().regex(/^[1-9]\d*$/),
	sport_id: z.int(),
	sport_name: vocabulary,
	name: pdppSafeText.max(500).nullable(),
	start_date: day,
	start_time_local: localTime,
	end_time_local: localTime.nullable(),
	duration_s: z
		.number()
		.min(0)
		.max(14 * 86_400),
	distance_m: nonNegative,
	calories_kcal: nonNegative,
	average_heart_rate_bpm: heartRate,
	max_heart_rate_bpm: heartRate,
	training_load: nonNegative,
	device_name: pdppSafeText.max(200).nullable(),
	note: pdppSafeText.max(10_000).nullable(),
	is_test: z.boolean().nullable(),
	has_training_target: z.boolean().nullable(),
});

const dailyActivitySchema = z.strictObject({
	id: day,
	date: day,
	steps: z.int().min(0).nullable(),
	active_time_min: minutesOfDay,
	distance_from_steps_m: nonNegative,
	calories_kcal: z.int().min(0).nullable(),
	daily_goal_pct: z.number().min(0).max(10_000).nullable(),
	sleep_duration_min: minutesOfDay,
	inactivity_alert_count: z.int().min(0).nullable(),
	sedentary_min: minutesOfDay,
	light_activity_min: minutesOfDay,
	moderate_activity_min: minutesOfDay,
	vigorous_activity_min: minutesOfDay,
	day_min_heart_rate_bpm: heartRate,
	day_max_heart_rate_bpm: heartRate,
	night_min_heart_rate_bpm: heartRate,
	last_sync_at: instant.nullable(),
});

const sleepSchema = z.strictObject({
	id: day,
	date: day,
	sleep_start_local: localTime,
	sleep_end_local: localTime,
	fell_asleep_offset_s: z.int().min(0).max(86_400).nullable(),
	woke_up_offset_s: z.int().min(-86_400).max(86_400).nullable(),
	time_in_bed_s: z
		.int()
		.min(0)
		.max(2 * 86_400),
	sleep_score: z.number().gt(0).max(100).nullable(),
	continuity_index: z.number().min(0).max(5).nullable(),
	continuity_class: z.int().min(0).max(10).nullable(),
	sleep_cycles: z.int().min(0).max(50).nullable(),
	sleep_rating: vocabulary,
});

/** Milliseconds between beats or breaths; a value outside means Polar changed the unit. */
const intervalMs = z.number().gt(0).lt(20_000).nullable();

const nightlyRechargeSchema = z.strictObject({
	id: day,
	date: day,
	nightly_recharge_status: z.int().min(1).max(6).nullable(),
	ans_charge: z.number().min(-10).max(10).nullable(),
	ans_charge_status: z.int().min(1).max(5).nullable(),
	beat_to_beat_interval_ms: intervalMs,
	beat_to_beat_interval_28d_avg_ms: intervalMs,
	hrv_rmssd_ms: z.number().min(0).lt(1000).nullable(),
	hrv_rmssd_28d_avg_ms: z.number().min(0).lt(1000).nullable(),
	breathing_interval_ms: intervalMs,
	breathing_interval_28d_avg_ms: intervalMs,
});

export const SCHEMAS: Record<Stream, z.ZodType> = {
	profile: profileSchema,
	training_sessions: trainingSessionSchema,
	daily_activity: dailyActivitySchema,
	sleep: sleepSchema,
	nightly_recharge: nightlyRechargeSchema,
};

export const validateRecord = makeValidateRecord(SCHEMAS);

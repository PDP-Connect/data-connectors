// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builders from the JSON Polar Flow's web app loads to the five streams' records. Each answer
 * row is parsed at the boundary (schemas.ts); every record field is then set by hand, because the
 * runtime ships the object passed to emitRecord, not Zod's parsed copy.
 *
 * Tolerant of what Polar leaves out (an absent metric reads as null, and a day or night it holds
 * nothing for builds no record); strict about what it changes: a row of the wrong shape, or a day
 * or time that does not parse, is unreadable instead of a guess. Ranges and units are the record
 * schemas' to check.
 *
 * Never read: the login e-mail (`userName`), the profile picture, GPS coordinates, routes, a
 * session's samples other than heart rate (speed, power, altitude, cadence and the rest), coach
 * notes, club or team data.
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	type ActivityDay,
	activityDay,
	activityTimelineResponse,
	currentUserResponse,
	MAX_HEART_RATE_INTERVAL_S,
	MAX_HEART_RATE_SAMPLES,
	MAX_HEART_RATE_SERIES,
	type NightlyRecovery,
	nightlyRecovery,
	nightlyRecoveryResponse,
	type SleepNight,
	sleepNight,
	sleepReportResponse,
	type TrainingHistoryRow,
	type TrainingSummaryResponse,
	trainingDetailsResponse,
	trainingHistoryResponse,
	trainingHistoryRow,
	trainingSummaryResponse,
} from "./schemas.ts";

/**
 * A row's outcome. `empty` is Polar's answer for nothing to record, never counted; `unreadable`
 * is a row this connector could not build a record from.
 */
export type Built =
	| { kind: "record"; record: RecordData }
	| { kind: "empty" }
	| { kind: "unreadable" };

/** Owner-local days a request asked for, both inclusive. */
export interface Window {
	from: string;
	to: string;
}

const EMPTY: Built = { kind: "empty" };
const UNREADABLE: Built = { kind: "unreadable" };
const record = (data: Record<string, unknown>): Built => ({
	kind: "record",
	record: data as RecordData,
});

/** A calendar day the calendar has, YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value);
}

const LOCAL_TIME =
	/^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?$/;

/**
 * A wall-clock time Polar writes without a zone, as `YYYY-MM-DD HH:MM:SS.fff` (training history)
 * or `YYYY-MM-DDTHH:MM:SS` (analysis, sleep): normalised to `YYYY-MM-DDTHH:MM:SS`. Anything else,
 * a zone suffix included, is null: a time with a zone is not the wall clock this field promises.
 */
export function localTime(value: unknown): string | null {
	const match = typeof value === "string" ? LOCAL_TIME.exec(value) : null;
	if (!match?.[1] || !isDay(match[1])) return null;
	return `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
}

/** A metric Polar reports as 0 when it was not measured (heart rate, sleep score). */
const measured = (value: number | null | undefined): number | null =>
	typeof value === "number" && value > 0 ? value : null;

const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

/**
 * A session's distance in metres: the list's, else the summary's, else the sum of its exercises'.
 * A manual entry carries it only on its exercise, and a manual entry without one says 0 there.
 */
function sessionDistance(
	row: TrainingHistoryRow,
	summary: TrainingSummaryResponse | null,
): number | null {
	const listed = row.distance ?? summary?.distance;
	if (typeof listed === "number") return listed;
	const total = Object.values(summary?.exercises ?? {}).reduce(
		(sum, exercise) => sum + (exercise.distance ?? 0),
		0,
	);
	return total > 0 ? total : null;
}

/** A whole number, as the day's calories are shown; Polar may send a fraction. */
const roundOrNull = (value: number | null | undefined): number | null =>
	typeof value === "number" ? Math.round(value) : null;

/** An ISO 3166 alpha-2 code, or nothing: a country in another form does not cost the profile. */
function countryCode(value: string | null | undefined): string | null {
	const code = typeof value === "string" ? value.trim().toUpperCase() : "";
	return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Text that is empty or blank says nothing (Polar stores a blank note as " "). */
function text(value: string | null | undefined): string | null {
	if (typeof value !== "string") return null;
	return value.trim() === "" ? null : value;
}

// ── Profile ────────────────────────────────────────────────────────────────
const OFFSET = /^[+-]\d{2}:\d{2}$/;

/** The owner's UTC offset as Polar holds it (`+02:00`); anything else is null. */
export function utcOffset(json: unknown): string | null {
	const parsed = currentUserResponse.safeParse(json);
	const zone = parsed.success ? parsed.data.localizationInfo?.timeZone : null;
	return typeof zone === "string" && OFFSET.test(zone) ? zone : null;
}

function birthday(parts: number[] | null | undefined): string | null {
	const [y, m, d] = parts ?? [];
	if (
		parts?.length !== 3 ||
		y === undefined ||
		m === undefined ||
		d === undefined
	)
		return null;
	const day = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
	return isDay(day) ? day : null;
}

/** The owner's numeric user id, which the training history request needs. */
export function userId(json: unknown): number | null {
	const parsed = currentUserResponse.safeParse(json);
	return parsed.success ? parsed.data.user.id : null;
}

/**
 * Polar answers the sleep goal in seconds (28800 for 8 hours), seen on a live account on 20 Nov
 * 2026. Rounded to a hundredth of an hour.
 */
function sleepGoalHours(seconds: number | null | undefined): number | null {
	const value = measured(seconds);
	return value === null ? null : Math.round((value / 3600) * 100) / 100;
}

export function profileRecord(json: unknown): Built {
	const parsed = currentUserResponse.safeParse(json);
	if (!parsed.success) return UNREADABLE;
	const { user, localizationInfo: loc, physicalInfo: phys } = parsed.data;
	return record({
		id: String(user.id),
		first_name: text(user.firstName),
		last_name: text(user.lastName),
		country: countryCode(user.country),
		birthday: birthday(phys?.birthday),
		sex: text(phys?.sex),
		training_background: text(phys?.trainingBackground),
		weight_kg: measured(phys?.weight),
		height_cm: measured(phys?.height),
		max_heart_rate_bpm: measured(phys?.maximumHeartRate),
		resting_heart_rate_bpm: measured(phys?.restingHeartRate),
		aerobic_threshold_bpm: measured(phys?.aerobicThreshold),
		anaerobic_threshold_bpm: measured(phys?.anaerobicThreshold),
		vo2max: measured(phys?.vo2Max),
		functional_threshold_power_w: measured(phys?.functionalThresholdPower),
		sleep_goal_hours: sleepGoalHours(phys?.sleepGoal),
		utc_offset: utcOffset(json),
		measurement_unit: text(loc?.measurementUnit),
		language: text(loc?.flowLanguage),
	});
}

// ── Training sessions ──────────────────────────────────────────────────────
/** The rows of one training history answer, or null when the answer is not a list. */
export function trainingHistoryRows(json: unknown): unknown[] | null {
	const parsed = trainingHistoryResponse.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/** A history row parsed at the boundary, or null when it is not one. */
export function parseTrainingRow(row: unknown): TrainingHistoryRow | null {
	const parsed = trainingHistoryRow.safeParse(row);
	return parsed.success ? parsed.data : null;
}

/** A session's analysis summary parsed at the boundary, or null when it is not one. */
export function parseTrainingSummary(
	json: unknown,
): TrainingSummaryResponse | null {
	const parsed = trainingSummaryResponse.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/**
 * Whether a session recorded heart rate, by its list row or its summary. A manual entry, or a
 * session recorded without a sensor, says 0 in both, and its details hold no heart rate series.
 */
export function recordedHeartRate(
	row: TrainingHistoryRow,
	summary: TrainingSummaryResponse | null,
): boolean {
	return (
		measured(row.hrAvg) !== null ||
		measured(summary?.hrAverage) !== null ||
		measured(summary?.hrMax) !== null
	);
}

/** One exercise's heart rate series, as the session record carries it. */
export interface HeartRateSeries {
	exercise_id: string;
	start_time_local: string | null;
	interval_s: number;
	bpm: Array<number | null>;
}

const ISO_DURATION = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;

/** An ISO 8601 time duration (`PT1S`, `PT30S`, `PT1M`) in seconds; null when it is not one or is 0. */
export function durationSeconds(value: string): number | null {
	const match = ISO_DURATION.exec(value);
	if (!match || value === "PT") return null;
	const total =
		Number(match[1] ?? 0) * 3600 +
		Number(match[2] ?? 0) * 60 +
		Number(match[3] ?? 0);
	return Number.isFinite(total) && total > 0 ? total : null;
}

/** A sample in bpm, rounded; 0 (Polar's no reading) and values no heart beats at read as null. */
function bpm(value: number | null): number | null {
	if (value === null) return null;
	const rounded = Math.round(value);
	return rounded >= 1 && rounded <= 300 ? rounded : null;
}

/**
 * A session's heart rate series from its analysis details, one per exercise that recorded heart
 * rate, oldest first. Null when no exercise did (a manual entry, a session without a sensor);
 * "unreadable" when the answer is not in the shape expected, is about another session, or a
 * series' interval does not parse.
 *
 * Every sample Polar holds is kept, at its own interval (1 s on a recorded session), up to
 * MAX_HEART_RATE_SAMPLES across the session. A longer session is thinned evenly instead of cut:
 * every k-th sample is kept and the interval grows k times, so the record still spans the whole
 * session. Samples are not averaged, so each value kept is one Polar recorded.
 */
export function heartRateSamples(
	json: unknown,
	sessionId: number,
): HeartRateSeries[] | null | "unreadable" {
	const parsed = trainingDetailsResponse.safeParse(json);
	if (!parsed.success || parsed.data.id !== sessionId) return "unreadable";
	const { exercises, samples } = parsed.data;
	const series: HeartRateSeries[] = [];
	for (const [exerciseId, block] of Object.entries(samples ?? {})) {
		const hr = block?.HEART_RATE?.samples;
		if (!hr) continue;
		if (!/^[1-9]\d*$/.test(exerciseId)) return "unreadable";
		const interval = durationSeconds(hr.interval);
		if (interval === null) return "unreadable";
		const values = hr.values.map(bpm);
		// Trailing gaps say nothing; a series with no reading at all is not one.
		let end = values.length;
		while (end > 0 && values[end - 1] === null) end -= 1;
		if (end === 0) continue;
		series.push({
			exercise_id: exerciseId,
			start_time_local: localTime(exercises?.[exerciseId]?.startTime),
			interval_s: interval,
			bpm: values.slice(0, end),
		});
	}
	if (series.length === 0) return null;
	// More series than a record holds is not a session the connector knows how to read.
	if (series.length > MAX_HEART_RATE_SERIES) return "unreadable";
	// By start time, then by exercise id (numeric order: the ids have no leading zeros).
	const order = (s: HeartRateSeries): string =>
		`${s.start_time_local ?? ""}|${s.exercise_id.padStart(20, "0")}`;
	series.sort((a, b) => (order(a) < order(b) ? -1 : 1));
	const total = series.reduce((sum, s) => sum + s.bpm.length, 0);
	const step = Math.ceil(total / MAX_HEART_RATE_SAMPLES);
	const thinned =
		step <= 1
			? series
			: series.map((s) => ({
					...s,
					interval_s: s.interval_s * step,
					bpm: s.bpm.filter((_, i) => i % step === 0),
				}));
	// An interval past an hour is not heart rate the record can hold: the session ships without it.
	return thinned.some((s) => s.interval_s > MAX_HEART_RATE_INTERVAL_S)
		? "unreadable"
		: thinned;
}

/**
 * One training session: the history row, and its analysis summary when that read (max heart rate,
 * end time, training load, device, the session's name). Without a summary those fields are null.
 * A summary about another session is not used. `samples` is the session's heart rate series from
 * its analysis details, null when it recorded none or they were not read.
 */
export function trainingSessionRecord(
	row: TrainingHistoryRow,
	summary: TrainingSummaryResponse | null,
	samples: HeartRateSeries[] | null = null,
): Built {
	const start = localTime(row.startDate);
	if (start === null) return UNREADABLE;
	const s = summary && summary.id === row.id ? summary : null;
	return record({
		id: String(row.id),
		sport_id: row.sportId,
		sport_name: text(row.sportName),
		name: text(s?.trainingSessionName),
		start_date: start.slice(0, 10),
		start_time_local: start,
		end_time_local: s ? localTime(s.stopTime) : null,
		duration_s: row.duration / 1000,
		distance_m: sessionDistance(row, s),
		calories_kcal: orNull(row.calories),
		average_heart_rate_bpm: measured(row.hrAvg ?? s?.hrAverage),
		max_heart_rate_bpm: measured(s?.hrMax),
		training_load: s ? orNull(s.trainingLoad) : null,
		device_name: text(s?.deviceName),
		note: text(row.note),
		is_test: orNull(row.isTest),
		has_training_target: orNull(row.hasTrainingTarget),
		heart_rate_samples: samples,
	});
}

// ── Daily activity ─────────────────────────────────────────────────────────
/** The days of one activity timeline answer, keyed YYYY-MM-DD, or null when it is not a map. */
export function activityDays(json: unknown): Record<string, unknown> | null {
	const parsed = activityTimelineResponse.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/** The last instant RFC 3339 can write, the end of year 9999. */
const MAX_EPOCH_MS = 253_402_300_799_999;

function epochInstant(value: number | null | undefined): string | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= MAX_EPOCH_MS
		? new Date(value).toISOString()
		: null;
}

/**
 * One day's activity. A day past the last sync (`dataPanelData` null) and a day with nothing on it
 * (every metric zero and no sync, Polar's answer for a day no device recorded) build no record.
 */
export function dailyActivityRecord(day: string, json: unknown): Built {
	const parsed = activityDay.safeParse(json);
	if (!parsed.success) return UNREADABLE;
	const d: ActivityDay = parsed.data;
	const panel = d.dataPanelData;
	if (panel === null || panel === undefined) return EMPTY;
	const graph = d.activityGraphData;
	const hr = graph?.heartRateSummary;
	const score = d.activityScoreData;
	const metrics = {
		steps: orNull(panel.stepCount),
		active_time_min: orNull(panel.activeTime),
		distance_from_steps_m: orNull(panel.distanceFromSteps),
		calories_kcal: roundOrNull(panel.kiloCalories),
		daily_goal_pct: orNull(panel.dailyActivityGoal),
		sleep_duration_min: orNull(panel.sleepDuration),
		inactivity_alert_count: orNull(panel.inactivityAlertCount),
		sedentary_min: orNull(score?.sedentaryDuration),
		light_activity_min: orNull(score?.lightDuration),
		moderate_activity_min: orNull(score?.moderateDuration),
		vigorous_activity_min: orNull(score?.vigorousDuration),
		day_min_heart_rate_bpm: measured(hr?.dayMinimum),
		day_max_heart_rate_bpm: measured(hr?.dayMaximum),
		night_min_heart_rate_bpm: measured(hr?.nightMinimum),
		last_sync_at: epochInstant(graph?.lastSync),
	};
	const anything = Object.values(metrics).some(
		(value) => value !== null && value !== 0,
	);
	if (!anything) return EMPTY;
	return record({ id: day, date: day, ...metrics });
}

// ── Sleep ──────────────────────────────────────────────────────────────────
export function sleepRows(json: unknown): unknown[] | null {
	const parsed = sleepReportResponse.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/** The night's wake-up day, read before the rest so a row outside the window can be left out. */
export function rowDate(row: unknown): string | null {
	if (typeof row !== "object" || row === null) return null;
	const date = (row as { date?: unknown }).date;
	return isDay(date) ? date : null;
}

const seconds = (a: string, b: string): number =>
	(Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / 1000;

/** One night, dated by the day the owner woke (Polar's convention). */
export function sleepRecord(row: unknown): Built {
	const parsed = sleepNight.safeParse(row);
	if (!parsed.success) return UNREADABLE;
	const n: SleepNight = parsed.data;
	const start = localTime(n.sleepStartTime);
	const end = localTime(n.sleepEndTime);
	if (!isDay(n.date) || start === null || end === null) return UNREADABLE;
	return record({
		id: n.date,
		date: n.date,
		sleep_start_local: start,
		sleep_end_local: end,
		fell_asleep_offset_s: orNull(n.sleepStartOffset),
		woke_up_offset_s: orNull(n.sleepEndOffset),
		time_in_bed_s: seconds(start, end),
		sleep_score: measured(n.sleepScore),
		continuity_index: orNull(n.continuityIndex),
		continuity_class: orNull(n.continuityClass),
		sleep_cycles: orNull(n.sleepCycles),
		sleep_rating: text(n.sleepRating),
	});
}

// ── Nightly Recharge ───────────────────────────────────────────────────────
export function nightlyRows(json: unknown): unknown[] | null {
	const parsed = nightlyRecoveryResponse.safeParse(json);
	return parsed.success ? parsed.data : null;
}

/**
 * One night's Nightly Recharge. As the web app does, an ANS charge rating outside 1 to 5 drops the
 * rating and the ANS charge, and a Nightly Recharge status outside 1 to 6 reads as none. A night
 * with no value at all builds no record.
 */
export function nightlyRechargeRecord(row: unknown): Built {
	const parsed = nightlyRecovery.safeParse(row);
	if (!parsed.success) return UNREADABLE;
	const n: NightlyRecovery = parsed.data;
	if (!isDay(n.date)) return UNREADABLE;
	const rate = n.ansRate;
	const rateValid =
		typeof rate === "number" &&
		Number.isInteger(rate) &&
		rate >= 1 &&
		rate <= 5;
	const status = n.recoveryIndicator;
	const metrics = {
		nightly_recharge_status:
			typeof status === "number" &&
			Number.isInteger(status) &&
			status >= 1 &&
			status <= 6
				? status
				: null,
		ans_charge:
			typeof rate === "number" && !rateValid ? null : orNull(n.ansStatus),
		ans_charge_status: rateValid ? rate : null,
		beat_to_beat_interval_ms: measured(n.rri),
		beat_to_beat_interval_28d_avg_ms: measured(n.rri28dayAverage),
		hrv_rmssd_ms: orNull(n.rmssd),
		hrv_rmssd_28d_avg_ms: orNull(n.rmssd28dayAverage),
		breathing_interval_ms: measured(n.respirationInterval),
		breathing_interval_28d_avg_ms: measured(n.respirationInterval28dayAverage),
	};
	if (Object.values(metrics).every((value) => value === null)) return EMPTY;
	return record({ id: n.date, date: n.date, ...metrics });
}

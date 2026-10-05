// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure builders from the JSON connect.garmin.com loads to the five streams' records. Every field
 * is set by hand: the runtime ships the object passed to emitRecord, not Zod's parsed copy.
 *
 * Tolerant of what Garmin leaves out (it omits a key rather than send null, so an absent metric
 * reads as null, and a day or night it holds nothing for builds no record); strict about what it
 * changes: a value of the wrong JSON type, or a day or instant that does not parse, makes the
 * record unreadable instead of a guess. Ranges and units are the schemas' to check.
 *
 * Never read: displayName, userProfileId, userProfilePk, deviceId, deviceName, activityName,
 * coordinates, locationName or any owner* field.
 */

import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import type { Stream } from "./schemas.ts";

type Obj = Record<string, unknown>;

/**
 * A day's or a row's outcome. `empty` is Garmin's answer for nothing to record, never counted;
 * `unreadable` keeps its start when that much parsed, so a stream consented by instant counts it
 * only within its grant.
 */
export type Built =
	| { kind: "record"; record: RecordData }
	| { kind: "empty" }
	| { kind: "unreadable"; startAt?: string };

/** Owner-local days a range request asked for, both inclusive. */
export interface Window {
	from: string;
	to: string;
}

export type DayStream = Extract<Stream, "daily_summaries" | "training_status">;
export type RangeStream = Extract<Stream, "sleep" | "hrv" | "activities">;

const EMPTY: Built = { kind: "empty" };
const UNREADABLE: Built = { kind: "unreadable" };

const isObj = (value: unknown): value is Obj =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Marks a field that came in a shape this parser does not know; a record holding one is unreadable. */
const DRIFT = Symbol("drift");
type Field<T> = T | null | typeof DRIFT;

function built(record: Record<string, unknown>): Built {
	if (!Object.values(record).includes(DRIFT)) {
		return { kind: "record", record: record as RecordData };
	}
	return typeof record.start_at === "string"
		? { kind: "unreadable", startAt: record.start_at }
		: UNREADABLE;
}

const unreadableFrom = (startAt: string | null): Built =>
	startAt === null ? UNREADABLE : { kind: "unreadable", startAt };

/** Absent or null is null: Garmin leaves a key out rather than send null. */
function number(value: unknown): Field<number> {
	if (value === null || value === undefined) return null;
	return typeof value === "number" && Number.isFinite(value) ? value : DRIFT;
}

/** A negative value is Garmin's "not measured". */
function measured(value: unknown): Field<number> {
	const n = number(value);
	return typeof n === "number" && n < 0 ? null : n;
}

/** A vendor vocabulary value, kept as Garmin wrote it; an empty one says nothing. */
function text(value: unknown): Field<string> {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string") return DRIFT;
	return value === "" ? null : value;
}

function flag(value: unknown): Field<boolean> {
	if (value === null || value === undefined) return null;
	return typeof value === "boolean" ? value : DRIFT;
}

/** A calendar day the calendar has, YYYY-MM-DD. */
export function isDay(value: unknown): value is string {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		return false;
	}
	const ms = Date.parse(`${value}T00:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value);
}

/** The latest instant `Date` can hold. */
const MAX_EPOCH_MS = 8_640_000_000_000_000;

/** Epoch milliseconds as RFC 3339 UTC with milliseconds; absent is null. */
function epochInstant(value: unknown): Field<string> {
	if (value === null || value === undefined) return null;
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= MAX_EPOCH_MS
		? new Date(value).toISOString()
		: DRIFT;
}

const WALL_CLOCK = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

/** Garmin's `YYYY-MM-DD HH:MM:SS`, which carries no zone: its day and time, or null when it is not one. */
function wallClock(value: unknown): { day: string; time: string } | null {
	const match = typeof value === "string" ? WALL_CLOCK.exec(value) : null;
	if (!match?.[1] || !isDay(match[1])) return null;
	return { day: match[1], time: `${match[2]}:${match[3]}:${match[4]}` };
}

// ── Settings ───────────────────────────────────────────────────────────────
/** The owner's time zone as Garmin holds it (an IANA name). The handle beside it is never read. */
export function siteTimeZone(json: unknown): string | undefined {
	if (!isObj(json)) return undefined;
	const zone = json.timeZone;
	return typeof zone === "string" && zone.trim() !== "" ? zone : undefined;
}

// ── One request per day ────────────────────────────────────────────────────
/** One day's summary. All six metrics absent or null is a day Garmin holds nothing for. */
export function dailySummary(day: string, json: unknown): Built {
	if (!isObj(json)) return UNREADABLE;
	const metrics = {
		steps: number(json.totalSteps),
		resting_heart_rate_bpm: number(json.restingHeartRate),
		min_heart_rate_bpm: number(json.minHeartRate),
		average_stress_level: measured(json.averageStressLevel),
		body_battery_high: measured(json.bodyBatteryHighestValue),
		body_battery_low: measured(json.bodyBatteryLowestValue),
	};
	if (Object.values(metrics).every((value) => value === null)) return EMPTY;
	// Another day's summary under this day's date would be data placed wrong.
	if (json.calendarDate !== day) return UNREADABLE;
	return built({ id: day, date: day, ...metrics });
}

const stamp = (entry: Obj): number =>
	typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
		? entry.timestamp
		: Number.NEGATIVE_INFINITY;

/** The device entry that speaks for the day: the primary training device's, else the latest. */
function chooseEntry(entries: Obj[]): Obj | undefined {
	const primary = entries.filter(
		(entry) => entry.primaryTrainingDevice === true,
	);
	const pool = primary.length > 0 ? primary : entries;
	return pool.reduce<Obj | undefined>(
		(best, entry) => (best && stamp(best) >= stamp(entry) ? best : entry),
		undefined,
	);
}

/**
 * One day's training status, from the entry of the device that speaks for it. An entry dated
 * another day is that day's status, carried forward: this day has none of its own.
 */
export function trainingStatus(day: string, json: unknown): Built {
	if (!isObj(json)) return UNREADABLE;
	const data = json.latestTrainingStatusData;
	if (data === null || data === undefined) return EMPTY;
	if (!isObj(data)) return UNREADABLE;
	// Keyed by device id, which is never read; a device's entry may be null.
	const present = Object.values(data).filter(
		(entry) => entry !== null && entry !== undefined,
	);
	if (!present.every(isObj)) return UNREADABLE;
	const entry = chooseEntry(present);
	if (!entry) return EMPTY;
	if (!isDay(entry.calendarDate)) return UNREADABLE;
	if (entry.calendarDate !== day) return EMPTY;
	const record = {
		id: day,
		date: day,
		training_status: text(entry.trainingStatusFeedbackPhrase),
		training_status_code: number(entry.trainingStatus),
		weekly_training_load: number(entry.weeklyTrainingLoad),
		training_paused: flag(entry.trainingPaused),
	};
	if (record.training_status === null && record.training_status_code === null)
		return EMPTY;
	return built(record);
}

export function dayRecord(
	stream: DayStream,
	day: string,
	json: unknown,
): Built {
	return stream === "daily_summaries"
		? dailySummary(day, json)
		: trainingStatus(day, json);
}

// ── One request per window ─────────────────────────────────────────────────
const inWindow = (date: string, window: Window): boolean =>
	date >= window.from && date <= window.to;

/** A window's nights: `individualStats` is null for none. Null when the envelope is not Garmin's. */
export function sleepRows(json: unknown): unknown[] | null {
	if (json === null) return [];
	if (!isObj(json)) return null;
	const rows = json.individualStats;
	return rows === null ? [] : Array.isArray(rows) ? rows : null;
}

/** One night, keyed by the day the owner woke, as Garmin dates it. */
export function sleepRow(row: unknown, window: Window): Built {
	if (!isObj(row)) return UNREADABLE;
	const values = row.values;
	if (!isObj(values)) return UNREADABLE;
	const startAt = epochInstant(values.gmtSleepStartTimeInMillis);
	const start = typeof startAt === "string" ? startAt : null;
	const date = row.calendarDate;
	if (start === null || !isDay(date) || !inWindow(date, window)) {
		return unreadableFrom(start);
	}
	return built({
		id: date,
		date,
		start_at: start,
		end_at: epochInstant(values.gmtSleepEndTimeInMillis),
		total_sleep_duration_s: number(values.totalSleepTimeInSeconds),
		deep_sleep_duration_s: number(values.deepTime),
		light_sleep_duration_s: number(values.lightTime),
		rem_sleep_duration_s: number(values.remTime),
		awake_duration_s: number(values.awakeTime),
		sleep_score: number(values.sleepScore),
		sleep_quality: text(values.sleepScoreQuality),
		respiratory_rate_rpm: number(values.respiration),
		blood_oxygen_pct: number(values.spO2),
	});
}

/** A window's nights. A 204, which never reaches here as JSON, is none. Null when the envelope is not Garmin's. */
export function hrvRows(json: unknown): unknown[] | null {
	if (json === null) return [];
	return isObj(json) && Array.isArray(json.hrvSummaries)
		? json.hrvSummaries
		: null;
}

/** One night's HRV. A row with no average and no status beyond NONE says nothing, whatever its date. */
export function hrvRow(row: unknown, window: Window): Built {
	if (row === null) return EMPTY;
	if (!isObj(row)) return UNREADABLE;
	const metrics = {
		last_night_average_ms: number(row.lastNightAvg),
		weekly_average_ms: number(row.weeklyAvg),
		status: text(row.status),
	};
	if (
		metrics.last_night_average_ms === null &&
		metrics.weekly_average_ms === null &&
		(metrics.status === null || metrics.status === "NONE")
	) {
		return EMPTY;
	}
	const date = row.calendarDate;
	if (!isDay(date) || !inWindow(date, window)) return UNREADABLE;
	return built({ id: date, date, ...metrics });
}

/** One answer's activities, a window's or a piece of one. Null when the envelope is not a list. */
export function activityRows(json: unknown): unknown[] | null {
	if (json === null) return [];
	return Array.isArray(json) ? json : null;
}

/** Garmin's activity id: a positive integer. */
function activityId(value: unknown): string | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? String(value)
		: null;
}

/** One activity, dated by its start: the instant in UTC and the owner's local day. */
export function activityRow(row: unknown, window: Window): Built {
	if (!isObj(row)) return UNREADABLE;
	const gmt = wallClock(row.startTimeGMT);
	const startAt = gmt ? `${gmt.day}T${gmt.time}.000Z` : null;
	const id = activityId(row.activityId);
	const local = wallClock(row.startTimeLocal);
	if (
		startAt === null ||
		id === null ||
		!local ||
		!inWindow(local.day, window)
	) {
		return unreadableFrom(startAt);
	}
	const type = row.activityType;
	return built({
		id,
		activity_type:
			type === null || type === undefined
				? null
				: isObj(type)
					? text(type.typeKey)
					: DRIFT,
		start_at: startAt,
		start_date: local.day,
		elapsed_time_s: number(row.elapsedDuration),
		moving_time_s: number(row.movingDuration),
		distance_m: number(row.distance),
		calories_kcal: number(row.calories),
		average_heart_rate_bpm: number(row.averageHR),
		max_heart_rate_bpm: number(row.maxHR),
	});
}

/** A window's rows for a range stream, or null when the envelope is not the one Garmin sends. */
export function windowRows(
	stream: RangeStream,
	json: unknown,
): unknown[] | null {
	if (stream === "sleep") return sleepRows(json);
	if (stream === "hrv") return hrvRows(json);
	return activityRows(json);
}

export function rowRecord(
	stream: RangeStream,
	row: unknown,
	window: Window,
): Built {
	if (stream === "sleep") return sleepRow(row, window);
	if (stream === "hrv") return hrvRow(row, window);
	return activityRow(row, window);
}

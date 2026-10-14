// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Value readers, date helpers and record builders for the Fitbit export
 * families this connector reads.
 *
 * Every function here is pure. A builder takes one parsed JSON object, or one
 * CSV row, and says what it is: a record, a keyed row for days.ts to place,
 * or a row that cannot be read. It never throws on bad data and never touches
 * the protocol; collect.ts decides what to emit and what to count.
 *
 * THE TRAPS THIS FILE EXISTS TO AVOID. Each yields a value that is plausible
 * and wrong, so each is handled by name rather than by a general rule:
 *
 *   - Two-digit years. The legacy files write `MM/DD/YY`, and YY means 20YY.
 *     There is no pivot and no `Date.parse`, which reads a zoneless text as
 *     local time.
 *   - Clocks. An exercise's `startTime` and a step or distance minute's
 *     `dateTime` are UTC. An active-minutes or resting-heart-rate `dateTime`
 *     names Fitbit's local day, always at midnight. A sleep log's
 *     `dateOfSleep` is the local day the sleep ended. Sleep start and end
 *     times are local wall-clock and are never read.
 *   - Numbers written as strings. Minute and daily values are JSON strings
 *     (`"1440"`), so the *Text readers accept digits only; nothing is coerced
 *     with `Number()`, which would read `"1e3"` as 1000 and `" 3"` as 3.
 *   - Units. An exercise's `distance` is in its `distanceUnit` (kilometres or
 *     miles); a distance minute is in centimetres; durations are
 *     milliseconds.
 *   - Wall time. `elapsed_time_s` is `duration`, the wall time. The log's
 *     `activeDuration` leaves out pauses and `originalDuration` is the time
 *     first logged, so both are wrong on an exercise that was paused or
 *     edited.
 *   - Padding. Resting heart rate is padded with a value of 0 on days
 *     without one. 0 is "not measured", never a reading.
 *   - Free text. `activityName` can be a name the owner typed. Only a name
 *     on ACTIVITY_TYPES becomes `activity_type`; any other is withheld.
 *
 * WHAT FAILS CLOSED, AND WHAT DOES NOT. Only `activity_type` is a closed
 * vocabulary, and a name outside it becomes null, never a refused row.
 * Unknown keys are ignored. A value of the wrong type or range is never
 * coerced: its field is null and named as unreadable, so the coverage line
 * can say so.
 */

import {
	type ActivityRecord,
	CALENDAR_DATE_RE,
	type FitbitRecord,
	LOG_ID_RE,
	type SleepRecord,
} from "./schemas.ts";

/** One parsed JSON object from an export member. */
export type SourceObject = Readonly<Record<string, unknown>>;

/**
 * What one source object, or one day, is. `timeKey` is the value of the
 * stream's time-range field (`start_time`, or `date`) and its first ten
 * characters are the day the covered window counts; null when it could not
 * be read. `present` names the output fields whose source value the object
 * carried, whatever the variant. Each builder narrows `R` to its own record.
 */
export type Built<R extends FitbitRecord = FitbitRecord> =
	| {
			kind: "record";
			record: R;
			timeKey: string;
			/** Output fields emitted as null because their value could not be read. */
			unreadable: readonly string[];
			present: readonly string[];
			/** activities only: `activityName` was a name not on ACTIVITY_TYPES. */
			withheld?: boolean;
	  }
	| {
			/** A day whose readings were all zeros or padding: nothing about it is wrong. */
			kind: "no_reading";
			timeKey: string;
			present: readonly string[];
	  }
	| {
			kind: "unreadable";
			/** The record id when it was readable. */
			id: string | null;
			timeKey: string | null;
			present: readonly string[];
	  };

/**
 * A daily, minute or score row: its key (a date, a UTC minute or a log id)
 * and its value, or nothing, when the key could not be read.
 */
export type KeyedRow<K> =
	| { kind: "value"; key: K; reading: Reading }
	| { kind: "unplaceable" };

/** One source value, read. */
export interface Reading<T = number> {
	/** What to emit: null when the source was absent, a sentinel or unreadable. */
	readonly value: T | null;
	/** The source held a value of the wrong type or range. */
	readonly unreadable: boolean;
	/** The source value was neither undefined nor null. Feeds `fields_unavailable`. */
	readonly present: boolean;
}

export type Reader = (value: unknown) => Reading;

const ABSENT: Reading<never> = {
	value: null,
	unreadable: false,
	present: false,
};
const UNREADABLE: Reading<never> = {
	value: null,
	unreadable: true,
	present: true,
};
/** Fitbit wrote a sentinel: the key is there, the measurement is not. */
const NOT_MEASURED: Reading<never> = {
	value: null,
	unreadable: false,
	present: true,
};
/** A sleep log with no joined score, when the score file was not read in full: its score may have been lost. */
const SCORE_UNREAD: Reading<never> = {
	value: null,
	unreadable: true,
	present: false,
};
const UNPLACEABLE: KeyedRow<never> = { kind: "unplaceable" };

const MS_PER_S = 1000;
const S_PER_MIN = 60;
const METRES_PER_KILOMETRE = 1000;
const METRES_PER_MILE = 1609.344;

// Module-scoped regexes (Biome useTopLevelRegex).
const COUNT_TEXT_RE = /^\d{1,15}$/;
// No cap on the decimals: Google's writer prints full double precision.
const MEASURE_TEXT_RE = /^\d{1,15}(?:\.\d+)?$/;
const FITBIT_DAY_RE = /^(\d{2})\/(\d{2})\/(\d{2}) 00:00:00$/;
const FITBIT_INSTANT_RE = /^(\d{2})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const TAKEOUT_STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const WHITESPACE_RUN_RE = /\s+/g;

/** A null is tolerated as absent. */
function isAbsent(value: unknown): value is null | undefined {
	return value === undefined || value === null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function measured<T>(value: T): Reading<T> {
	return { value, unreadable: false, present: true };
}

/** A JSON object: not an array, not null, not a class instance. */
export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const prototype: unknown = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** Orders text by UTF-16 code unit, as `<` does, so no machine's locale changes an order. */
export function compareText(a: string, b: string): number {
	if (a < b) {
		return -1;
	}
	return a > b ? 1 : 0;
}

// Value readers. Absent is null; a value of the wrong type is unreadable.
// They differ only in what they accept and what a value outside their range
// means.

/** A tally such as sleep minutes: a whole JSON number, 0 included. */
export function count(value: unknown): Reading {
	if (isAbsent(value)) {
		return ABSENT;
	}
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? measured(value)
		: UNREADABLE;
}

/** A tally written as digits (`"1440"`), or as a whole JSON number. */
export function countText(value: unknown): Reading {
	if (typeof value === "string") {
		return COUNT_TEXT_RE.test(value) ? measured(Number(value)) : UNREADABLE;
	}
	return count(value);
}

/** A quantity where 0 is real, such as a distance. A negative is unreadable. */
export function measure(value: unknown): Reading {
	if (isAbsent(value)) {
		return ABSENT;
	}
	return isFiniteNumber(value) && value >= 0 ? measured(value) : UNREADABLE;
}

/**
 * A quantity written as digits with an optional fraction (`"12.5"`), or as a
 * JSON number. An empty string is absent: a CSV writes an empty cell for a
 * value it does not have.
 */
export function measureText(value: unknown): Reading {
	if (typeof value === "string") {
		if (value === "") {
			return ABSENT;
		}
		return MEASURE_TEXT_RE.test(value) ? measured(Number(value)) : UNREADABLE;
	}
	return measure(value);
}

/**
 * A physiological sensor reading such as resting heart rate. Fitbit writes 0
 * for "not measured", so 0 and below are null, not unreadable.
 */
export function sensor(value: unknown): Reading {
	if (isAbsent(value)) {
		return ABSENT;
	}
	if (!isFiniteNumber(value)) {
		return UNREADABLE;
	}
	return value > 0 ? measured(value) : NOT_MEASURED;
}

/** A JSON boolean. The string `"true"` is unreadable, not true. */
export function flag(value: unknown): Reading<boolean> {
	if (isAbsent(value)) {
		return ABSENT;
	}
	return typeof value === "boolean" ? measured(value) : UNREADABLE;
}

/** `container[key]`, read; a container of the wrong shape is unreadable. */
function readNested(container: unknown, key: string, read: Reader): Reading {
	if (isAbsent(container)) {
		return ABSENT;
	}
	return isPlainObject(container) ? read(container[key]) : UNREADABLE;
}

/** Whole milliseconds to seconds; rounding first keeps a double's noise out. */
function msToSeconds(reading: Reading): Reading {
	return reading.value === null
		? reading
		: { ...reading, value: Math.round(reading.value) / MS_PER_S };
}

function minutesToSeconds(reading: Reading): Reading {
	return reading.value === null
		? reading
		: { ...reading, value: reading.value * S_PER_MIN };
}

interface Tally {
	/** Output names, in schema order. */
	readonly present: readonly string[];
	readonly unreadable: readonly string[];
}

/** Sums up a record's readings, keyed by output name in schema order. */
function tally(readings: Readonly<Record<string, Reading<unknown>>>): Tally {
	const present: string[] = [];
	const unreadable: string[] = [];
	for (const [name, reading] of Object.entries(readings)) {
		if (reading.present) {
			present.push(name);
		}
		if (reading.unreadable) {
			unreadable.push(name);
		}
	}
	return { present, unreadable };
}

// Time. Every function works in UTC: a local-zone Date method would make the
// output depend on the machine the import runs on.

/**
 * Epoch ms for these UTC fields, or null when they name no real instant.
 * `Date.UTC` rolls 30 February over into March rather than refusing it, so
 * every field must survive the round trip.
 */
function utcInstant(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
): number | null {
	const ms = Date.UTC(year, month - 1, day, hour, minute, second);
	const back = new Date(ms);
	return back.getUTCFullYear() === year &&
		back.getUTCMonth() === month - 1 &&
		back.getUTCDate() === day &&
		back.getUTCHours() === hour &&
		back.getUTCMinutes() === minute &&
		back.getUTCSeconds() === second
		? ms
		: null;
}

/** The capture groups of a match of digits, as numbers. */
function numbers(match: RegExpExecArray): number[] {
	return match.slice(1).map(Number);
}

/** Epoch ms of the start of a `YYYY-MM-DD` day in UTC, or null if it names no real day. */
export function utcDayStart(value: string): number | null {
	if (!CALENDAR_DATE_RE.test(value)) {
		return null;
	}
	const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = value
		.split("-")
		.map(Number);
	return utcInstant(year, month, day, 0, 0, 0);
}

/** A `YYYY-MM-DD` string naming a real day, used verbatim as a date key; else null. */
export function calendarDate(value: unknown): string | null {
	return typeof value === "string" && utcDayStart(value) !== null
		? value
		: null;
}

/**
 * A legacy daily row's `dateTime` (`MM/DD/YY 00:00:00`), Fitbit's local
 * day, as `20YY-MM-DD`; null if it names no real day. Any time part other
 * than midnight is null: its meaning is unknown.
 */
export function fitbitDay(value: unknown): string | null {
	const match = typeof value === "string" ? FITBIT_DAY_RE.exec(value) : null;
	if (match === null) {
		return null;
	}
	const [month = Number.NaN, day = Number.NaN, yy = Number.NaN] =
		numbers(match);
	const ms = utcInstant(2000 + yy, month, day, 0, 0, 0);
	return ms === null ? null : new Date(ms).toISOString().slice(0, 10);
}

/**
 * A legacy UTC timestamp (`MM/DD/YY HH:MM:SS`: an exercise start, or a step
 * or distance minute) as epoch ms; null if it names no real instant.
 */
export function fitbitInstant(value: unknown): number | null {
	const match =
		typeof value === "string" ? FITBIT_INSTANT_RE.exec(value) : null;
	if (match === null) {
		return null;
	}
	const [
		month = Number.NaN,
		day = Number.NaN,
		yy = Number.NaN,
		hour = Number.NaN,
		minute = Number.NaN,
		second = Number.NaN,
	] = numbers(match);
	return utcInstant(2000 + yy, month, day, hour, minute, second);
}

/**
 * A Takeout file name's stamp (`20260920T081500Z`) as an ISO instant
 * (`2026-09-20T08:15:00.000Z`); null if it names no real instant.
 */
export function takeoutStamp(value: string): string | null {
	const match = TAKEOUT_STAMP_RE.exec(value);
	if (match === null) {
		return null;
	}
	const [
		year = Number.NaN,
		month = Number.NaN,
		day = Number.NaN,
		hour = Number.NaN,
		minute = Number.NaN,
		second = Number.NaN,
	] = numbers(match);
	const ms = utcInstant(year, month, day, hour, minute, second);
	return ms === null ? null : new Date(ms).toISOString();
}

/** `String(logId)` for a positive safe integer; anything else cannot identify a record. */
export function logId(value: unknown): string | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
		? String(value)
		: null;
}

// activity_type

/**
 * Common Fitbit exercise names, keyed by their normal form
 * ({@link activityNameKey}), each mapped to its code: the key with every run
 * of characters outside a–z and 0–9 replaced by `_`. The names come from
 * Fitbit's Device API exercise list
 * (https://dev.fitbit.com/build/reference/device-api/exercise/), Google's
 * list of tracked activities (https://support.google.com/fitbit/answer/14236510)
 * and the Pixel Watch's exercise list. A name not listed here, which may be
 * one the owner typed, never becomes a code. Adding a name is not a schema
 * change.
 */
export const ACTIVITY_TYPES: Readonly<Record<string, string>> = {
	walk: "walk",
	run: "run",
	"outdoor bike": "outdoor_bike",
	sport: "sport",
	elliptical: "elliptical",
	"aerobic workout": "aerobic_workout",
	aerobics: "aerobics",
	workout: "workout",
	kickboxing: "kickboxing",
	"martial arts": "martial_arts",
	"core training": "core_training",
	powerlifting: "powerlifting",
	bike: "bike",
	bootcamp: "bootcamp",
	canoeing: "canoeing",
	"circuit training": "circuit_training",
	"cross-country skiing": "cross_country_skiing",
	crossfit: "crossfit",
	dancing: "dancing",
	golf: "golf",
	hiit: "hiit",
	hike: "hike",
	"indoor climbing": "indoor_climbing",
	"interval workout": "interval_workout",
	kayaking: "kayaking",
	"mountain biking": "mountain_biking",
	"outdoor workout": "outdoor_workout",
	paddleboarding: "paddleboarding",
	pilates: "pilates",
	rollerblading: "rollerblading",
	rowing: "rowing",
	"rowing machine": "rowing_machine",
	skating: "skating",
	skiing: "skiing",
	snowboarding: "snowboarding",
	spinning: "spinning",
	"stair climber": "stair_climber",
	"stationary bike": "stationary_bike",
	"strength training": "strength_training",
	surfing: "surfing",
	swim: "swim",
	tennis: "tennis",
	treadmill: "treadmill",
	weightlifting: "weightlifting",
	weights: "weights",
	yoga: "yoga",
};

/** A name's normal form: NFC, trimmed, inner white space collapsed to one space, lower case. */
export function activityNameKey(value: string): string {
	return value
		.normalize("NFC")
		.trim()
		.replace(WHITESPACE_RUN_RE, " ")
		.toLowerCase();
}

/** An `activity_type` reading. Never unreadable: a name that is not listed is withheld. */
interface TypeReading extends Reading<string> {
	/** The source held a name, or a value, that is not on ACTIVITY_TYPES. */
	readonly withheld: boolean;
}

/**
 * `activityName` through the allowlist. Matching a normal form discloses
 * nothing: a typed name equal to a standard exercise word is that word.
 * `Object.hasOwn` keeps a name such as `constructor` from finding a
 * property every object inherits.
 */
export function activityType(value: unknown): TypeReading {
	if (isAbsent(value)) {
		return { ...ABSENT, withheld: false };
	}
	const key = typeof value === "string" ? activityNameKey(value) : null;
	const code =
		key !== null && Object.hasOwn(ACTIVITY_TYPES, key)
			? ACTIVITY_TYPES[key]
			: undefined;
	return code === undefined
		? { ...NOT_MEASURED, withheld: true }
		: { ...measured(code), withheld: false };
}

// activities

function metresPer(unit: unknown): number | null {
	if (unit === "Kilometer") {
		return METRES_PER_KILOMETRE;
	}
	if (unit === "Mile") {
		return METRES_PER_MILE;
	}
	return null;
}

/**
 * An exercise's distance in metres, to the centimetre. Absent is absent,
 * whatever the unit says; a distance whose unit is absent or unknown cannot
 * be converted, so it is unreadable rather than guessed.
 */
function exerciseDistance(distance: unknown, unit: unknown): Reading {
	const reading = measure(distance);
	if (reading.value === null) {
		return reading;
	}
	const factor = metresPer(unit);
	if (factor === null) {
		return UNREADABLE;
	}
	const metres = Math.round(reading.value * factor * 100) / 100;
	return Number.isFinite(metres) ? measured(metres) : UNREADABLE;
}

/**
 * An exercise's `startTime` as a UTC instant `YYYY-MM-DDTHH:MM:SSZ`, or null.
 * A legacy instant is in 2000–2099 to the second, so it always has that form.
 */
function exerciseStart(value: unknown): string | null {
	const ms = fitbitInstant(value);
	return ms === null ? null : `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/**
 * activities: a record whenever the log id and the UTC start are readable.
 * `startTime` is UTC; `originalStartTime` and `lastModified` are audit
 * clocks and never read, not even as a fallback. `start_date` is the UTC
 * day, never the owner's local day.
 */
export function buildExercise(
	obj: SourceObject,
	exportedAt: string | null,
): Built<ActivityRecord> {
	const type = activityType(obj.activityName);
	const readings = {
		activity_type: type,
		distance_m: exerciseDistance(obj.distance, obj.distanceUnit),
		elapsed_time_s: msToSeconds(measure(obj.duration)),
	};
	const { present, unreadable } = tally(readings);
	const id = logId(obj.logId);
	const start = exerciseStart(obj.startTime);
	if (id === null || start === null) {
		return { kind: "unreadable", id, timeKey: start, present };
	}
	const record: ActivityRecord = {
		id,
		activity_type: type.value,
		start_date: start.slice(0, 10),
		start_time: start,
		start_time_basis: "utc",
		distance_m: readings.distance_m.value,
		elapsed_time_s: readings.elapsed_time_s.value,
		freshness: "snapshot",
		exported_at: exportedAt,
	};
	return {
		kind: "record",
		record,
		timeKey: start,
		unreadable,
		present,
		withheld: type.withheld,
	};
}

// sleep

/**
 * A stages log's minutes in one stage, `levels.summary.<stage>.minutes`. A
 * classic log has no deep, light or REM summary, so its stages are absent.
 */
function stageMinutes(
	levels: unknown,
	stage: "deep" | "light" | "rem",
): Reading {
	return readNested(levels, "summary", (summary) =>
		readNested(summary, stage, (level) => readNested(level, "minutes", count)),
	);
}

/**
 * The log's score from the score file. With no joined row the score is
 * absent; but when the score file was not read in full, the row may be
 * among those that were not read, so the value is unreadable.
 */
function joinedScore(
	id: string | null,
	scores: ReadonlyMap<string, Reading>,
	scoresReadInFull: boolean,
): Reading {
	const joined = id === null ? undefined : scores.get(id);
	if (joined !== undefined) {
		return joined;
	}
	return scoresReadInFull ? ABSENT : SCORE_UNREAD;
}

/**
 * sleep: one record per sleep log, naps included, whenever the log id and
 * `dateOfSleep` are readable. Durations only: the log's start and end are
 * local wall-clock and never read. `minutesAwake` is Fitbit's own figure,
 * never derived from the stage summaries.
 */
export function buildSleepLog(
	obj: SourceObject,
	exportedAt: string | null,
	scores: ReadonlyMap<string, Reading>,
	scoresReadInFull: boolean,
): Built<SleepRecord> {
	const id = logId(obj.logId);
	const date = calendarDate(obj.dateOfSleep);
	const readings = {
		is_main_sleep: flag(obj.mainSleep),
		sleep_score: joinedScore(id, scores, scoresReadInFull),
		asleep_duration_s: minutesToSeconds(count(obj.minutesAsleep)),
		awake_duration_s: minutesToSeconds(count(obj.minutesAwake)),
		deep_sleep_duration_s: minutesToSeconds(stageMinutes(obj.levels, "deep")),
		light_sleep_duration_s: minutesToSeconds(stageMinutes(obj.levels, "light")),
		rem_sleep_duration_s: minutesToSeconds(stageMinutes(obj.levels, "rem")),
	};
	const { present, unreadable } = tally(readings);
	if (id === null || date === null) {
		return { kind: "unreadable", id, timeKey: date, present };
	}
	const record: SleepRecord = {
		id,
		date,
		is_main_sleep: readings.is_main_sleep.value,
		sleep_score: readings.sleep_score.value,
		asleep_duration_s: readings.asleep_duration_s.value,
		awake_duration_s: readings.awake_duration_s.value,
		deep_sleep_duration_s: readings.deep_sleep_duration_s.value,
		light_sleep_duration_s: readings.light_sleep_duration_s.value,
		rem_sleep_duration_s: readings.rem_sleep_duration_s.value,
		freshness: "snapshot",
		exported_at: exportedAt,
	};
	return { kind: "record", record, timeKey: date, unreadable, present };
}

// daily rows

/** An active-minutes row: Fitbit's local day, and its minutes as digits. */
export function readDailyRow(obj: SourceObject): KeyedRow<string> {
	const key = fitbitDay(obj.dateTime);
	return key === null
		? UNPLACEABLE
		: { kind: "value", key, reading: countText(obj.value) };
}

/**
 * A resting-heart-rate row, keyed by its outer `dateTime`. The inner `date`
 * is null on padding rows and equal to the outer one elsewhere, so it is
 * never read, nor is `error`.
 */
export function readRestingHeartRateRow(obj: SourceObject): KeyedRow<string> {
	const key = fitbitDay(obj.dateTime);
	return key === null
		? UNPLACEABLE
		: { kind: "value", key, reading: readNested(obj.value, "value", sensor) };
}

/**
 * A step or distance minute: its UTC instant, and its value read by `read`
 * (countText for steps, measureText for centimetres). A minute that cannot
 * be placed is unplaceable whatever its value, a zero included.
 */
export function readMinuteRow(
	obj: SourceObject,
	read: Reader,
): KeyedRow<number> {
	const key = fitbitInstant(obj.dateTime);
	return key === null
		? UNPLACEABLE
		: { kind: "value", key, reading: read(obj.value) };
}

// CSV rows

/** Where the two columns the score join reads sit, and how many cells a row has. */
export interface ScoreColumns {
	readonly id: number;
	readonly score: number;
	readonly width: number;
}

/**
 * The index of the one header cell named `name`, or null when there is none
 * or more than one. Cells are trimmed first, which also removes a byte-order
 * mark: U+FEFF is white space to `String.prototype.trim`.
 */
function soleColumn(header: readonly string[], name: string): number | null {
	let found: number | null = null;
	for (const [index, cell] of header.entries()) {
		if (cell.trim() !== name) {
			continue;
		}
		if (found !== null) {
			return null;
		}
		found = index;
	}
	return found;
}

/**
 * The score file's header, resolved by name, never by position. Null when
 * `sleep_log_entry_id` or `overall_score` is missing or repeated: the file's
 * layout is not the one this import reads.
 */
export function resolveScoreColumns(
	header: readonly string[],
): ScoreColumns | null {
	const id = soleColumn(header, "sleep_log_entry_id");
	const score = soleColumn(header, "overall_score");
	return id === null || score === null
		? null
		: { id, score, width: header.length };
}

/**
 * One score row, keyed by its log id. Null for a blank line, which is not a
 * row. A row whose width differs from the header's, or whose id is not a log
 * id, cannot be joined to a log and is unplaceable. The row's `timestamp` is
 * local time marked as UTC and is never read, nor are the sub-scores.
 */
export function readScoreRow(
	cells: readonly string[],
	columns: ScoreColumns,
): KeyedRow<string> | null {
	if (cells.length === 1 && cells[0]?.trim() === "") {
		return null;
	}
	const id = cells[columns.id];
	if (
		cells.length !== columns.width ||
		id === undefined ||
		!LOG_ID_RE.test(id)
	) {
		return UNPLACEABLE;
	}
	return { kind: "value", key: id, reading: measureText(cells[columns.score]) };
}

/**
 * The `timezone` cell of Profile.csv's first data row, as written; whether it
 * names a usable zone is days.ts's question, and an empty cell is `""`. Null
 * when the header has no single `timezone` column, or there is no data row
 * that reaches it (a blank line included). Nothing else in the row is read,
 * and nothing is logged.
 */
export function profileZone(
	header: readonly string[],
	row: readonly string[] | null,
): string | null {
	const index = soleColumn(header, "timezone");
	if (index === null || row === null) {
		return null;
	}
	return row[index] ?? null;
}

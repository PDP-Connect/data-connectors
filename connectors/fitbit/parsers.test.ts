// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser tests for the Fitbit Takeout export.
 *
 * Most of what can go wrong here produces a value that is plausible and
 * wrong: a paused exercise's active time for its wall time, the first-logged
 * start for the real one, miles read as kilometres, a padding 0 as a resting
 * heart rate, a typed exercise name as its type. So the inputs are chosen to
 * DISCRIMINATE: every exercise carries a `duration`, an `activeDuration` and
 * an `originalDuration` that differ, a `startTime` and an `originalStartTime`
 * that differ, and every key the parser must never read holds a canary.
 *
 * The source objects are synthetic: the real export's shapes, with invented
 * values.
 *
 * The whole file runs on Chicago time. Every function under test must work
 * in UTC, and a local-zone Date method (`new Date(y, m, d)`, `getDate`,
 * `Date.parse` on a zoneless text) gives a different answer here than on a
 * UTC machine.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
	CANARIES,
	canonicalExercises,
	canonicalSleepLogs,
	exercise as exerciseSource,
	PROFILE_HEADER,
	PROFILE_ROW,
	SCORE_HEADER,
	SCORE_ROWS,
} from "./__fixtures__/synthetic-export.ts";
import {
	ACTIVITY_TYPES,
	activityNameKey,
	activityType,
	type Built,
	buildExercise,
	buildSleepLog,
	calendarDate,
	count,
	countText,
	fitbitDay,
	fitbitInstant,
	flag,
	logId,
	measure,
	measureText,
	profileZone,
	type Reading,
	readDailyRow,
	readMinuteRow,
	readRestingHeartRateRow,
	readScoreRow,
	resolveScoreColumns,
	type ScoreColumns,
	type SourceObject,
	sensor,
	takeoutStamp,
	utcDayStart,
} from "./parsers.ts";
import {
	ACTIVITY_TYPE_RE,
	type DataStream,
	type FitbitRecord,
	SCHEMAS,
	validateRecord,
} from "./schemas.ts";

process.env.TZ = "America/Chicago";

const EXPORTED_AT = "2026-09-20T08:15:00.000Z";
const ACTIVITY_FIELDS = ["activity_type", "distance_m", "elapsed_time_s"];
const SLEEP_FIELDS = [
	"is_main_sleep",
	"sleep_score",
	"asleep_duration_s",
	"awake_duration_s",
	"deep_sleep_duration_s",
	"light_sleep_duration_s",
	"rem_sleep_duration_s",
];
const VALUE = (value: number): Reading => ({
	value,
	unreadable: false,
	present: true,
});
const ABSENT: Reading = { value: null, unreadable: false, present: false };
const UNREADABLE: Reading = { value: null, unreadable: true, present: true };
const NOT_MEASURED: Reading = { value: null, unreadable: false, present: true };

type Json = Record<string, unknown>;
type BuiltRecord<R extends FitbitRecord = FitbitRecord> = Extract<
	Built<R>,
	{ kind: "record" }
>;

/** `value` as the parser sees it: written as the pretty-printed member text, then read back. */
function fromJson(value: Json): SourceObject {
	return JSON.parse(JSON.stringify(value, null, 2)) as SourceObject;
}

function without(obj: Json, ...keys: string[]): Json {
	const copy = { ...obj };
	for (const key of keys) {
		delete copy[key];
	}
	return copy;
}

function recordOf<R extends FitbitRecord>(built: Built<R>): BuiltRecord<R> {
	if (built.kind !== "record") {
		assert.fail(`expected a record, got ${built.kind}`);
	}
	return built;
}

// Source objects: the canonical export's, as the parser sees them.

/**
 * E1 with `overrides`: a tracked run whose three durations differ, and whose
 * start and first-logged start differ.
 */
function exercise(overrides: Json = {}): SourceObject {
	return fromJson({ ...exerciseSource(), ...overrides });
}

/** Item `index` of the canonical `values`, read as the parser sees it. */
function sourceAt(values: readonly Json[], index: number): SourceObject {
	const value = values[index];
	assert.ok(value !== undefined, "the fixture holds the object");
	return fromJson(value);
}

const E1 = sourceAt(canonicalExercises(), 0);
const E2 = sourceAt(canonicalExercises(), 1);
const E3 = sourceAt(canonicalExercises(), 2);
const E4 = sourceAt(canonicalExercises(), 3);
/** S1: a main stages sleep, with every key a legacy sleep log carries. */
const S1 = sourceAt(canonicalSleepLogs(), 0);
/** S2: a classic nap, which has no deep, light or REM summary. */
const S2 = sourceAt(canonicalSleepLogs(), 1);
const S3 = sourceAt(canonicalSleepLogs(), 2);

function scoreColumns(header: readonly string[] = SCORE_HEADER): ScoreColumns {
	const columns = resolveScoreColumns(header);
	assert.ok(columns !== null, "the header resolves");
	return columns;
}

/** The score map collect.ts builds from the canonical score file: first row for an id wins. */
function canonicalScores(): Map<string, Reading> {
	const columns = scoreColumns();
	const scores = new Map<string, Reading>();
	for (const cells of SCORE_ROWS) {
		const row = readScoreRow(cells, columns);
		assert.ok(row !== null && row.kind === "value");
		if (!scores.has(row.key)) {
			scores.set(row.key, row.reading);
		}
	}
	return scores;
}

const E1_RECORD = {
	id: "21000000001",
	activity_type: "run",
	start_date: "2026-03-13",
	start_time: "2026-03-13T23:00:00Z",
	start_time_basis: "utc",
	distance_m: 5200,
	elapsed_time_s: 1805,
	freshness: "snapshot",
	exported_at: EXPORTED_AT,
};

function schemaKeys(stream: DataStream): string[] {
	const schema = SCHEMAS[stream];
	assert.ok(schema instanceof z.ZodObject, `${stream}: an object schema`);
	return Object.keys(schema.shape);
}

// activities

test("E1 decodes to exactly its record: km to m, duration ms to s, the UTC start, and nothing else", () => {
	const built = recordOf(buildExercise(E1, EXPORTED_AT));
	// The UTC day. The owner's Sydney start is 10:00 on the 14th, and that day
	// must not appear.
	assert.deepEqual(built.record, E1_RECORD);
	assert.deepEqual(Object.keys(built.record), schemaKeys("activities"));
	assert.equal(built.timeKey, "2026-03-13T23:00:00Z");
	assert.deepEqual(built.unreadable, []);
	assert.deepEqual(built.present, ACTIVITY_FIELDS);
	assert.equal(built.withheld, false);
});

test("E2 to E4 decode to exactly their records", () => {
	assert.deepEqual(recordOf(buildExercise(E2, EXPORTED_AT)).record, {
		id: "21000000002",
		activity_type: "outdoor_bike",
		start_date: "2026-03-15",
		start_time: "2026-03-15T06:10:00Z",
		start_time_basis: "utc",
		distance_m: 24140.16,
		elapsed_time_s: 3720,
		freshness: "snapshot",
		exported_at: EXPORTED_AT,
	});
	const weights = recordOf(buildExercise(E3, EXPORTED_AT));
	assert.deepEqual(weights.record, {
		id: "21000000003",
		activity_type: "weights",
		start_date: "2026-03-16",
		start_time: "2026-03-16T08:00:00Z",
		start_time_basis: "utc",
		distance_m: null,
		elapsed_time_s: 2400,
		freshness: "snapshot",
		exported_at: EXPORTED_AT,
	});
	assert.deepEqual(weights.present, ["activity_type", "elapsed_time_s"]);
	assert.deepEqual(weights.unreadable, []);
	const typed = recordOf(buildExercise(E4, null));
	assert.deepEqual(typed.record, {
		id: "21000000004",
		activity_type: null,
		start_date: "2026-03-17",
		start_time: "2026-03-17T21:30:00Z",
		start_time_basis: "utc",
		distance_m: 3000,
		elapsed_time_s: 1500,
		freshness: "snapshot",
		exported_at: null,
	});
	// A typed name not on the list is withheld: present, never unreadable, never passed through.
	assert.equal(typed.withheld, true);
	assert.deepEqual(typed.unreadable, []);
	assert.deepEqual(typed.present, ACTIVITY_FIELDS);
});

test("elapsed_time_s is duration, the wall time; activeDuration and originalDuration are never read", () => {
	assert.notEqual(
		E1.duration,
		E1.activeDuration,
		"the fixture tells them apart",
	);
	assert.notEqual(E1.duration, E1.originalDuration);
	const built = recordOf(buildExercise(without(E1, "duration"), null));
	assert.equal(built.record.elapsed_time_s, null, "not 1790.5 nor 1800");
	assert.deepEqual(built.present, ["activity_type", "distance_m"]);
	for (const duration of [-1, "1805000"]) {
		const bad = recordOf(buildExercise(exercise({ duration }), null));
		assert.equal(bad.record.elapsed_time_s, null);
		assert.deepEqual(bad.unreadable, ["elapsed_time_s"]);
	}
	// Rounded to a whole ms before scaling.
	assert.equal(
		recordOf(buildExercise(exercise({ duration: 1805000.4 }), null)).record
			.elapsed_time_s,
		1805,
	);
});

test("startTime is read and originalStartTime never: E1 with only originalStartTime is unreadable", () => {
	assert.notEqual(E1.startTime, E1.originalStartTime);
	assert.deepEqual(buildExercise(without(E1, "startTime"), null), {
		kind: "unreadable",
		id: "21000000001",
		timeKey: null,
		present: ACTIVITY_FIELDS,
	});
	for (const startTime of ["2026-03-13T23:00:00Z", "03/13/2026 23:00:00", 12]) {
		assert.deepEqual(
			buildExercise(exercise({ startTime }), null),
			{
				kind: "unreadable",
				id: "21000000001",
				timeKey: null,
				present: ACTIVITY_FIELDS,
			},
			String(startTime),
		);
	}
});

test("fitbitInstant reads MM/DD/YY HH:MM:SS as UTC, and nothing else", () => {
	assert.equal(fitbitInstant("03/13/26 23:00:00"), Date.UTC(2026, 2, 13, 23));
	assert.equal(
		fitbitInstant("04/04/26 15:59:30"),
		Date.UTC(2026, 3, 4, 15, 59, 30),
	);
	for (const bad of [
		"02/30/26 00:00:00",
		"13/01/26 00:00:00",
		"03/13/2026 23:00:00",
		"2026-03-13T23:00:00Z",
		"03/13/26 24:00:00",
		"03/13/26 23:00",
		" 03/13/26 23:00:00",
		12,
		null,
		undefined,
	]) {
		assert.equal(fitbitInstant(bad), null, String(bad));
	}
});

test("a two-digit year YY is 20YY, with no pivot", () => {
	assert.equal(fitbitInstant("01/01/00 00:00:00"), Date.UTC(2000, 0, 1));
	assert.equal(
		fitbitInstant("12/31/99 23:59:00"),
		Date.UTC(2099, 11, 31, 23, 59),
	);
	assert.equal(fitbitDay("01/01/00 00:00:00"), "2000-01-01");
	assert.equal(fitbitDay("12/31/99 00:00:00"), "2099-12-31");
	assert.equal(fitbitDay("02/29/24 00:00:00"), "2024-02-29");
	assert.equal(fitbitDay("02/29/26 00:00:00"), null);
});

test("fitbitDay reads a local date written at midnight; any other time part is null", () => {
	assert.equal(fitbitDay("04/05/26 00:00:00"), "2026-04-05");
	for (const bad of [
		"04/05/26 13:00:00",
		"04/05/26 00:00:01",
		"04/05/26",
		"2026-04-05",
		"04/31/26 00:00:00",
		20260405,
		null,
	]) {
		assert.equal(fitbitDay(bad), null, String(bad));
	}
});

test("calendarDate accepts only a real YYYY-MM-DD day, verbatim", () => {
	assert.equal(calendarDate("2026-03-14"), "2026-03-14");
	assert.equal(calendarDate("2024-02-29"), "2024-02-29");
	for (const bad of [
		"2026-02-29",
		"2026-02-30",
		"2026-13-01",
		"2026-3-14",
		"03/14/26",
		"2026-03-14T00:00:00",
		20260314,
		null,
	]) {
		assert.equal(calendarDate(bad), null, String(bad));
	}
	assert.equal(utcDayStart("2024-03-01"), Date.UTC(2024, 2, 1));
	assert.equal(utcDayStart("2026-02-30"), null);
});

test("distance follows distanceUnit; a distance without a known unit is unreadable, never guessed", () => {
	assert.equal(
		recordOf(buildExercise(E2, null)).record.distance_m,
		24140.16,
		"15 miles",
	);
	assert.equal(recordOf(buildExercise(E1, null)).record.distance_m, 5200);
	for (const unit of [undefined, "Yard", "kilometer", 1]) {
		const source =
			unit === undefined
				? without(E1, "distanceUnit")
				: exercise({ distanceUnit: unit });
		const built = recordOf(buildExercise(source, null));
		assert.equal(built.record.distance_m, null, String(unit));
		assert.deepEqual(built.unreadable, ["distance_m"]);
		assert.deepEqual(built.present, ACTIVITY_FIELDS);
	}
	// No distance and a unit: nothing to convert, and nothing wrong.
	const noDistance = recordOf(buildExercise(without(E1, "distance"), null));
	assert.equal(noDistance.record.distance_m, null);
	assert.deepEqual(noDistance.unreadable, []);
	assert.deepEqual(noDistance.present, ["activity_type", "elapsed_time_s"]);
	for (const distance of [-1, "5.2"]) {
		const bad = recordOf(buildExercise(exercise({ distance }), null));
		assert.equal(bad.record.distance_m, null);
		assert.deepEqual(bad.unreadable, ["distance_m"]);
	}
	assert.equal(
		recordOf(buildExercise(exercise({ distance: 0 }), null)).record.distance_m,
		0,
	);
	assert.equal(
		recordOf(buildExercise(exercise({ distance: 1.23456 }), null)).record
			.distance_m,
		1234.56,
		"to the centimetre",
	);
});

test("logId is a positive safe integer; anything else is unreadable, still placed by its start", () => {
	assert.equal(logId(21000000001), "21000000001");
	assert.equal(logId(JSON.parse("2.1000000001E10")), "21000000001");
	for (const bad of [0, -1, 1.5, "21000000001", 2 ** 53, null, undefined]) {
		assert.equal(logId(bad), null, String(bad));
		assert.deepEqual(
			buildExercise(exercise({ logId: bad }), null),
			{
				kind: "unreadable",
				id: null,
				// The start is kept so collect.ts can tell whether the lost row
				// could fall inside the requested window.
				timeKey: "2026-03-13T23:00:00Z",
				present: ACTIVITY_FIELDS,
			},
			String(bad),
		);
	}
});

// activity_type

/** Every name the allowlist holds, as Fitbit displays it, with its code. */
const DISPLAY_NAMES: readonly (readonly [string, string])[] = [
	["Walk", "walk"],
	["Run", "run"],
	["Outdoor Bike", "outdoor_bike"],
	["Sport", "sport"],
	["Elliptical", "elliptical"],
	["Aerobic Workout", "aerobic_workout"],
	["Aerobics", "aerobics"],
	["Workout", "workout"],
	["Kickboxing", "kickboxing"],
	["Martial Arts", "martial_arts"],
	["Core training", "core_training"],
	["Powerlifting", "powerlifting"],
	["Bike", "bike"],
	["Bootcamp", "bootcamp"],
	["Canoeing", "canoeing"],
	["Circuit training", "circuit_training"],
	["Cross-country skiing", "cross_country_skiing"],
	["CrossFit", "crossfit"],
	["Dancing", "dancing"],
	["Golf", "golf"],
	["HIIT", "hiit"],
	["Hike", "hike"],
	["Indoor climbing", "indoor_climbing"],
	["Interval Workout", "interval_workout"],
	["Kayaking", "kayaking"],
	["Mountain biking", "mountain_biking"],
	["Outdoor workout", "outdoor_workout"],
	["Paddleboarding", "paddleboarding"],
	["Pilates", "pilates"],
	["Rollerblading", "rollerblading"],
	["Rowing", "rowing"],
	["Rowing machine", "rowing_machine"],
	["Skating", "skating"],
	["Skiing", "skiing"],
	["Snowboarding", "snowboarding"],
	["Spinning", "spinning"],
	["Stair climber", "stair_climber"],
	["Stationary bike", "stationary_bike"],
	["Strength training", "strength_training"],
	["Surfing", "surfing"],
	["Swim", "swim"],
	["Tennis", "tennis"],
	["Treadmill", "treadmill"],
	["Weightlifting", "weightlifting"],
	["Weights", "weights"],
	["Yoga", "yoga"],
];

const NON_CODE_RUN_RE = /[^a-z0-9]+/g;
const EDGE_UNDERSCORE_RE = /^_+|_+$/g;

test("ACTIVITY_TYPES: 46 entries, each key its own normal form and each code its key's snake form", () => {
	const entries = Object.entries(ACTIVITY_TYPES);
	assert.equal(entries.length, 46);
	for (const [key, code] of entries) {
		assert.equal(activityNameKey(key), key, `key not normal: ${key}`);
		assert.match(code, ACTIVITY_TYPE_RE, key);
		assert.equal(
			code,
			key.replace(NON_CODE_RUN_RE, "_").replace(EDGE_UNDERSCORE_RE, ""),
			key,
		);
	}
	assert.equal(DISPLAY_NAMES.length, 46);
	for (const [name, code] of DISPLAY_NAMES) {
		assert.deepEqual(
			activityType(name),
			{ value: code, unreadable: false, present: true, withheld: false },
			name,
		);
	}
});

test("activityType maps a listed name by its normal form; anything else is withheld, never unreadable", () => {
	for (const key of Object.keys(ACTIVITY_TYPES)) {
		assert.equal(activityType(key).value, ACTIVITY_TYPES[key], key);
	}
	assert.equal(activityType("  core   Training ").value, "core_training");
	assert.equal(activityType("RUN").value, "run");
	assert.equal(
		activityType("Cross-Country\tSkiing").value,
		"cross_country_skiing",
	);
	for (const other of [
		"Parkrun with Dad",
		"",
		"   ",
		"Outdoor-Bike",
		"constructor",
		"__proto__",
		"toString",
		7,
		true,
		{ name: "Run" },
		["Run"],
	]) {
		assert.deepEqual(
			activityType(other),
			{ value: null, unreadable: false, present: true, withheld: true },
			JSON.stringify(other),
		);
	}
	for (const absent of [undefined, null]) {
		assert.deepEqual(activityType(absent), {
			value: null,
			unreadable: false,
			present: false,
			withheld: false,
		});
	}
	const custom = recordOf(
		buildExercise(exercise({ activityName: "Parkrun with Dad" }), null),
	);
	assert.equal(custom.record.activity_type, null);
	assert.deepEqual(custom.unreadable, []);
	assert.equal(custom.withheld, true);
	const untyped = recordOf(buildExercise(without(E1, "activityName"), null));
	assert.deepEqual(untyped.present, ["distance_m", "elapsed_time_s"]);
	assert.equal(untyped.withheld, false);
});

// Value readers

test("count: a whole JSON number from 0 up; anything else is unreadable", () => {
	assert.deepEqual(count(402), VALUE(402));
	assert.deepEqual(count(0), VALUE(0));
	assert.deepEqual(count(null), ABSENT);
	for (const bad of [-1, 1.5, 2 ** 53, "402", true]) {
		assert.deepEqual(count(bad), UNREADABLE, String(bad));
	}
});

test("countText: digits or a whole JSON number; nothing is coerced", () => {
	assert.deepEqual(countText("0"), VALUE(0));
	assert.deepEqual(countText("1440"), VALUE(1440));
	assert.deepEqual(countText(12), VALUE(12));
	assert.deepEqual(countText(undefined), ABSENT);
	assert.deepEqual(countText(null), ABSENT);
	for (const bad of [
		"1.5",
		"-1",
		" 3",
		"3 ",
		"1e3",
		"x",
		"",
		"1234567890123456",
		true,
		-1,
		{},
	]) {
		assert.deepEqual(countText(bad), UNREADABLE, JSON.stringify(bad));
	}
});

test("measureText: digits with an optional fraction of any length; an empty cell is absent", () => {
	assert.deepEqual(measureText("3050"), VALUE(3050));
	assert.deepEqual(measureText("12.5"), VALUE(12.5));
	assert.deepEqual(measureText("87.12345678901234"), VALUE(87.12345678901234));
	assert.deepEqual(measureText(0), VALUE(0));
	assert.deepEqual(measureText(""), ABSENT);
	assert.deepEqual(measureText(null), ABSENT);
	for (const bad of ["-1", "1,5", "NaN", "1e3", ".5", "5.", " 5", -1, false]) {
		assert.deepEqual(measureText(bad), UNREADABLE, JSON.stringify(bad));
	}
});

test("measure: 0 is a real value; a negative or a non-number is unreadable", () => {
	assert.deepEqual(measure(0), VALUE(0));
	assert.deepEqual(measure(5.2), VALUE(5.2));
	assert.deepEqual(measure(undefined), ABSENT);
	for (const bad of [-1, "5.2", Number.POSITIVE_INFINITY]) {
		assert.deepEqual(measure(bad), UNREADABLE, String(bad));
	}
});

test("sensor on resting heart rate: 0 is not measured, so null; a string is unreadable", () => {
	assert.deepEqual(sensor(58.43210987), VALUE(58.43210987));
	assert.deepEqual(sensor(0), NOT_MEASURED);
	assert.deepEqual(sensor(null), ABSENT);
	assert.deepEqual(sensor("58"), UNREADABLE);
});

test("flag: a JSON boolean only", () => {
	assert.deepEqual(flag(true), {
		value: true,
		unreadable: false,
		present: true,
	});
	assert.deepEqual(flag(false), {
		value: false,
		unreadable: false,
		present: true,
	});
	assert.deepEqual(flag(undefined), ABSENT);
	for (const bad of ["true", 1, 0]) {
		assert.deepEqual(flag(bad), UNREADABLE, String(bad));
	}
});

// Daily and minute rows

test("readDailyRow: keyed by its local date, the value read as digits", () => {
	assert.deepEqual(
		readDailyRow(fromJson({ dateTime: "04/04/26 00:00:00", value: "45" })),
		{ kind: "value", key: "2026-04-04", reading: VALUE(45) },
	);
	assert.deepEqual(
		readDailyRow(fromJson({ dateTime: "04/04/26 00:00:00", value: "x" })),
		{ kind: "value", key: "2026-04-04", reading: UNREADABLE },
	);
	for (const dateTime of ["garbage", "04/04/26 13:00:00", undefined]) {
		assert.deepEqual(readDailyRow(fromJson({ dateTime, value: "0" })), {
			kind: "unplaceable",
		});
	}
});

test("readRestingHeartRateRow: keyed by the outer dateTime, so padding rows still place", () => {
	assert.deepEqual(
		readRestingHeartRateRow(
			fromJson({
				dateTime: "04/04/26 00:00:00",
				value: { date: "04/04/26", value: 58.43210987, error: 6.123456789 },
			}),
		),
		{ kind: "value", key: "2026-04-04", reading: VALUE(58.43210987) },
	);
	// Padding: the inner date is null and the value 0. Keyed by the inner
	// date, this row would be unplaceable.
	assert.deepEqual(
		readRestingHeartRateRow(
			fromJson({
				dateTime: "04/03/26 00:00:00",
				value: { date: null, value: 0.0, error: 0.0 },
			}),
		),
		{ kind: "value", key: "2026-04-03", reading: NOT_MEASURED },
	);
	// The inner date is never read: a disagreeing one changes nothing.
	assert.deepEqual(
		readRestingHeartRateRow(
			fromJson({
				dateTime: "04/05/26 00:00:00",
				value: { date: "01/01/20", value: 57.9, error: 5.5 },
			}),
		),
		{ kind: "value", key: "2026-04-05", reading: VALUE(57.9) },
	);
	for (const value of ["58", 58, [58]]) {
		assert.deepEqual(
			readRestingHeartRateRow(
				fromJson({ dateTime: "04/05/26 00:00:00", value }),
			),
			{ kind: "value", key: "2026-04-05", reading: UNREADABLE },
			JSON.stringify(value),
		);
	}
	assert.deepEqual(
		readRestingHeartRateRow(
			fromJson({
				dateTime: "04/31/26 00:00:00",
				value: { date: "04/30/26", value: 57.9, error: 5.5 },
			}),
		),
		{ kind: "unplaceable" },
	);
});

test("readMinuteRow: the UTC minute and its value; an unplaceable minute is unplaceable even when it is zero", () => {
	assert.deepEqual(
		readMinuteRow(
			fromJson({ dateTime: "04/04/26 16:00:00", value: "40" }),
			countText,
		),
		{ kind: "value", key: Date.UTC(2026, 3, 4, 16), reading: VALUE(40) },
	);
	assert.deepEqual(
		readMinuteRow(
			fromJson({ dateTime: "04/04/26 16:00:00", value: "3050.5" }),
			measureText,
		),
		{ kind: "value", key: Date.UTC(2026, 3, 4, 16), reading: VALUE(3050.5) },
	);
	assert.deepEqual(
		readMinuteRow(
			fromJson({ dateTime: "04/04/26 16:00:00", value: "x" }),
			countText,
		).kind,
		"value",
	);
	for (const dateTime of ["04/31/26 10:00:00", "garbage", null]) {
		assert.deepEqual(
			readMinuteRow(fromJson({ dateTime, value: "0" }), countText),
			{ kind: "unplaceable" },
			String(dateTime),
		);
	}
});

// sleep

const S1_RECORD = {
	id: "31000000001",
	date: "2026-03-14",
	is_main_sleep: true,
	sleep_score: 81,
	asleep_duration_s: 24120,
	awake_duration_s: 3720,
	deep_sleep_duration_s: 5220,
	light_sleep_duration_s: 14160,
	rem_sleep_duration_s: 4740,
	freshness: "snapshot",
	exported_at: EXPORTED_AT,
};

test("S1, S2 and S3 decode to exactly their records, joined to the canonical scores", () => {
	const scores = canonicalScores();
	const s1 = recordOf(buildSleepLog(S1, EXPORTED_AT, scores, true));
	assert.deepEqual(s1.record, S1_RECORD);
	assert.equal(s1.timeKey, "2026-03-14");
	assert.deepEqual(s1.present, SLEEP_FIELDS);
	assert.deepEqual(s1.unreadable, []);

	const s2 = recordOf(buildSleepLog(S2, EXPORTED_AT, scores, true));
	assert.deepEqual(s2.record, {
		id: "31000000002",
		date: "2026-03-14",
		is_main_sleep: false,
		sleep_score: null,
		asleep_duration_s: 2280,
		awake_duration_s: 60,
		deep_sleep_duration_s: null,
		light_sleep_duration_s: null,
		rem_sleep_duration_s: null,
		freshness: "snapshot",
		exported_at: EXPORTED_AT,
	});
	// A classic log has no stage summary: the stages are absent, not unreadable.
	assert.deepEqual(s2.present, [
		"is_main_sleep",
		"asleep_duration_s",
		"awake_duration_s",
	]);
	assert.deepEqual(s2.unreadable, []);

	assert.deepEqual(
		recordOf(buildSleepLog(S3, EXPORTED_AT, scores, true)).record,
		{
			id: "31000000003",
			date: "2026-03-15",
			is_main_sleep: true,
			sleep_score: 77,
			asleep_duration_s: 22260,
			awake_duration_s: 2880,
			deep_sleep_duration_s: 4200,
			light_sleep_duration_s: 13500,
			rem_sleep_duration_s: 4560,
			freshness: "snapshot",
			exported_at: EXPORTED_AT,
		},
	);
});

test("a log's stages come from its summaries, whatever its type says; minutesAwake is the log's own", () => {
	const scores = canonicalScores();
	for (const type of [undefined, "classic", "unknown"]) {
		const source = type === undefined ? without(S1, "type") : { ...S1, type };
		assert.deepEqual(
			recordOf(buildSleepLog(source, EXPORTED_AT, scores, true)).record,
			S1_RECORD,
			String(type),
		);
	}
	const awake = recordOf(
		buildSleepLog({ ...S1, minutesAwake: 55 }, EXPORTED_AT, scores, true),
	);
	assert.equal(awake.record.awake_duration_s, 3300, "not the wake stage's 62");
});

test("buildSleepLog: a score file not read in full flags only the logs without a joined score", () => {
	const scores = canonicalScores();
	const s1 = recordOf(buildSleepLog(S1, null, scores, false));
	assert.equal(s1.record.sleep_score, 81);
	assert.deepEqual(s1.unreadable, []);

	const s2 = recordOf(buildSleepLog(S2, null, scores, false));
	assert.equal(s2.record.sleep_score, null);
	assert.deepEqual(s2.unreadable, ["sleep_score"]);
	// The score may have been lost; it was never seen, so it is not present.
	assert.ok(!s2.present.includes("sleep_score"));

	const complete = recordOf(buildSleepLog(S2, null, scores, true));
	assert.equal(complete.record.sleep_score, null);
	assert.deepEqual(complete.unreadable, []);

	// An unreadable joined score stays unreadable either way.
	const bad = new Map<string, Reading>([["31000000001", UNREADABLE]]);
	for (const readInFull of [true, false]) {
		const built = recordOf(buildSleepLog(S1, null, bad, readInFull));
		assert.equal(built.record.sleep_score, null);
		assert.deepEqual(built.unreadable, ["sleep_score"]);
	}
});

test("a stage level present but not an object is unreadable; an absent one is absent", () => {
	const scores = canonicalScores();
	const levels = S1.levels as Json;
	const summary = levels.summary as Json;
	const deepNumber = recordOf(
		buildSleepLog(
			{ ...S1, levels: { ...levels, summary: { ...summary, deep: 87 } } },
			null,
			scores,
			true,
		),
	);
	assert.equal(deepNumber.record.deep_sleep_duration_s, null);
	assert.deepEqual(deepNumber.unreadable, ["deep_sleep_duration_s"]);
	assert.equal(deepNumber.record.light_sleep_duration_s, 14160);

	const noDeep = recordOf(
		buildSleepLog(
			{ ...S1, levels: { ...levels, summary: without(summary, "deep") } },
			null,
			scores,
			true,
		),
	);
	assert.equal(noDeep.record.deep_sleep_duration_s, null);
	assert.deepEqual(noDeep.unreadable, []);
	assert.ok(!noDeep.present.includes("deep_sleep_duration_s"));

	for (const shape of [
		{ ...S1, levels: "stages" },
		{ ...S1, levels: { summary: [] } },
	]) {
		const built = recordOf(buildSleepLog(shape, null, scores, true));
		assert.deepEqual(built.unreadable, [
			"deep_sleep_duration_s",
			"light_sleep_duration_s",
			"rem_sleep_duration_s",
		]);
	}
	for (const minutesAsleep of [-1, "402", 402.5]) {
		const built = recordOf(
			buildSleepLog({ ...S1, minutesAsleep }, null, scores, true),
		);
		assert.equal(built.record.asleep_duration_s, null);
		assert.deepEqual(built.unreadable, ["asleep_duration_s"]);
	}
});

test("mainSleep must be a boolean: a string is unreadable, absent is absent", () => {
	const scores = canonicalScores();
	const text = recordOf(
		buildSleepLog({ ...S1, mainSleep: "true" }, null, scores, true),
	);
	assert.equal(text.record.is_main_sleep, null);
	assert.deepEqual(text.unreadable, ["is_main_sleep"]);
	const absent = recordOf(
		buildSleepLog(without(S1, "mainSleep"), null, scores, true),
	);
	assert.equal(absent.record.is_main_sleep, null);
	assert.deepEqual(absent.unreadable, []);
	assert.ok(!absent.present.includes("is_main_sleep"));
});

test("a sleep log without a readable id or dateOfSleep is unreadable; a US-form date is never guessed", () => {
	const scores = canonicalScores();
	for (const dateOfSleep of ["03/14/26", "2026-02-30", undefined]) {
		assert.deepEqual(
			buildSleepLog({ ...S1, dateOfSleep }, null, scores, true),
			{
				kind: "unreadable",
				id: "31000000001",
				timeKey: null,
				present: SLEEP_FIELDS,
			},
			String(dateOfSleep),
		);
	}
	const noId = buildSleepLog(
		{ ...S1, logId: "31000000001" },
		null,
		scores,
		true,
	);
	assert.equal(noId.kind, "unreadable");
	assert.equal(noId.timeKey, "2026-03-14");
});

// CSV rows

test("resolveScoreColumns finds the two columns by name, once each", () => {
	assert.deepEqual(resolveScoreColumns(SCORE_HEADER), {
		id: 0,
		score: 2,
		width: 9,
	});
	const reordered = [
		"timestamp",
		"restlessness",
		" overall_score ",
		"composition_score",
		"\uFEFFsleep_log_entry_id",
	];
	assert.deepEqual(resolveScoreColumns(reordered), {
		id: 4,
		score: 2,
		width: 5,
	});
	assert.deepEqual(
		resolveScoreColumns(["\uFEFFsleep_log_entry_id", "overall_score"]),
		{
			id: 0,
			score: 1,
			width: 2,
		},
	);
	for (const bad of [
		SCORE_HEADER.filter((cell) => cell !== "overall_score"),
		[...SCORE_HEADER, "sleep_log_entry_id"],
		SCORE_HEADER.map((cell) => (cell === "overall_score" ? "overall" : cell)),
		[],
	]) {
		assert.equal(resolveScoreColumns(bad), null, bad.join(","));
	}
});

test("readScoreRow: a short row or a bad id is unplaceable; a bad score keeps its key; a blank line is not a row", () => {
	const columns = scoreColumns();
	const [first] = SCORE_ROWS;
	assert.ok(first !== undefined);
	assert.deepEqual(readScoreRow(first, columns), {
		kind: "value",
		key: "31000000001",
		reading: VALUE(81),
	});
	assert.deepEqual(readScoreRow(first.slice(0, 8), columns), {
		kind: "unplaceable",
	});
	assert.deepEqual(readScoreRow([...first, "extra"], columns), {
		kind: "unplaceable",
	});
	for (const id of ["", "0", "01", "abc", "-31000000001", "3.1e10"]) {
		assert.deepEqual(
			readScoreRow([id, ...first.slice(1)], columns),
			{ kind: "unplaceable" },
			id,
		);
	}
	const score = (value: string) =>
		readScoreRow(["31000000001", "", value, "", "", "", "", "", ""], columns);
	assert.deepEqual(score("n/a"), {
		kind: "value",
		key: "31000000001",
		reading: UNREADABLE,
	});
	assert.deepEqual(score(""), {
		kind: "value",
		key: "31000000001",
		reading: ABSENT,
	});
	assert.deepEqual(score("78.5"), {
		kind: "value",
		key: "31000000001",
		reading: VALUE(78.5),
	});
	assert.equal(readScoreRow([""], columns), null);
	assert.equal(readScoreRow(["  "], columns), null);
});

test("profileZone: the timezone cell of the first data row, found by name; null only without a column or a row", () => {
	assert.equal(profileZone(PROFILE_HEADER, PROFILE_ROW), "Australia/Sydney");
	// Found by name, not by position 13.
	const moved = [...PROFILE_HEADER.slice(0, 5), "timezone"];
	assert.equal(
		profileZone(moved, [...PROFILE_ROW.slice(0, 5), "Asia/Colombo"]),
		"Asia/Colombo",
	);
	const noColumn = PROFILE_HEADER.map((cell) =>
		cell === "timezone" ? "time_zone" : cell,
	);
	assert.equal(profileZone(noColumn, PROFILE_ROW), null);
	assert.equal(profileZone([...PROFILE_HEADER, "timezone"], PROFILE_ROW), null);
	assert.equal(profileZone(PROFILE_HEADER, null), null);
	assert.equal(profileZone(PROFILE_HEADER, [""]), null, "a blank line");
	assert.equal(profileZone(PROFILE_HEADER, PROFILE_ROW.slice(0, 13)), null);
	// An empty cell is the cell, "": whether it is usable is for days.ts.
	const empty = PROFILE_ROW.map((cell, index) => (index === 13 ? "" : cell));
	assert.equal(profileZone(PROFILE_HEADER, empty), "");
	const literal = PROFILE_ROW.map((cell, index) =>
		index === 13 ? "null" : cell,
	);
	assert.equal(profileZone(PROFILE_HEADER, literal), "null");
});

test("takeoutStamp: a real UTC instant as ISO text, else null", () => {
	assert.equal(takeoutStamp("20260920T081500Z"), "2026-09-20T08:15:00.000Z");
	for (const bad of [
		"20261320T081500Z",
		"20260230T081500Z",
		"20260920T246000Z",
		"20260920T081500",
		"2026-09-20T08:15:00Z",
		"00500920T081500Z",
	]) {
		assert.equal(takeoutStamp(bad), null, bad);
	}
});

// Every builder

test("every builder output passes validateRecord with no anomalies, and carries exactly its schema's keys", () => {
	const scores = canonicalScores();
	const cases: [DataStream, Built][] = [
		...[E1, E2, E3, E4].map((source): [DataStream, Built] => [
			"activities",
			buildExercise(source, EXPORTED_AT),
		]),
		[
			"activities",
			buildExercise(without(E1, "distanceUnit", "duration"), null),
		],
		...[S1, S2, S3].map((source): [DataStream, Built] => [
			"sleep",
			buildSleepLog(source, EXPORTED_AT, scores, true),
		]),
		["sleep", buildSleepLog(S2, null, scores, false)],
		[
			"sleep",
			buildSleepLog({ ...S1, mainSleep: "yes", levels: 3 }, null, scores, true),
		],
	];
	for (const [stream, built] of cases) {
		const { record } = recordOf(built);
		const result = validateRecord(stream, record);
		assert.ok(result.ok, `${stream}: ${JSON.stringify(result)}`);
		assert.equal(result.anomalies, undefined, stream);
		assert.deepEqual(Object.keys(record), schemaKeys(stream), stream);
	}
});

test("no excluded source value reaches a record", () => {
	const scores = canonicalScores();
	const text = JSON.stringify([
		...[E1, E2, E3, E4].map((source) => buildExercise(source, EXPORTED_AT)),
		...[S1, S2, S3].map((source) =>
			buildSleepLog(source, EXPORTED_AT, scores, true),
		),
		readRestingHeartRateRow(
			fromJson({
				dateTime: "04/04/26 00:00:00",
				value: { date: "04/04/26", value: 58.43210987, error: 6.123456789 },
			}),
		),
		...SCORE_ROWS.map((cells) => readScoreRow(cells, scoreColumns())),
	]);
	for (const canary of CANARIES) {
		assert.ok(!text.includes(canary), `leaked: ${canary}`);
	}
});

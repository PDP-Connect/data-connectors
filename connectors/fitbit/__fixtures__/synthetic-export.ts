// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SYNTHETIC Fitbit exports from Google Takeout. Every value here is invented;
 * none comes from a real account.
 *
 * The SHAPE follows what Takeout's Fitbit exports contain:
 *   - parts named `takeout-<stamp>-<n>-<part>.zip`, members under
 *     `Takeout/Fitbit/`;
 *   - legacy family members in `Global Export Data/`, each a JSON array
 *     pretty-printed across many lines (`"key" : value`, two-space indents,
 *     array elements joined `},{`), which `fitbitJson` reproduces, with daily
 *     and minute values written as strings and some numbers as doubles
 *     (`0.0`);
 *   - `Your Profile/Profile.csv` with CRLF line ends and
 *     `Sleep Score/sleep_score.csv` with LF, each ending with a line break;
 *   - beside them, many files this connector never opens, including the
 *     Google-era `*_GoogleData` folders.
 *
 * The owner's profile zone is Australia/Sydney, whose clock goes back an hour
 * at 16:00 UTC on 4 April 2026, inside the canonical steps files. Every key
 * the connector must never publish carries a canary value, and every canary
 * is in CANARIES, so a test can prove that none reaches stdout or stderr.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeZip, type ZipMember } from "./zip.ts";

export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| JsonObject;
export interface JsonObject {
	[key: string]: JsonValue;
}

/** When the canonical export was made, as its part names write it. */
const STAMP = "20260920T081500Z";
/** STAMP as the records' `exported_at`. */
export const EXPORTED_AT = "2026-09-20T08:15:00.000Z";
/** Everything above `Global Export Data/` in the canonical export. */
export const ROOT = "Takeout/Fitbit/";
/** The `timezone` cell of the canonical Profile.csv. */
const PROFILE_ZONE = "Australia/Sydney";

/** The file name of part `part` of the canonical export, in middle-number group `middle`. */
export function partName(part: number, middle = 1, stamp = STAMP): string {
	return `takeout-${stamp}-${String(middle)}-${String(part).padStart(3, "0")}.zip`;
}

/** A member of `Global Export Data/`. */
export function legacyMember(base: string, root = ROOT): string {
	return `${root}Global Export Data/${base}`;
}

export function sleepScoreMember(root = ROOT): string {
	return `${root}Sleep Score/sleep_score.csv`;
}

export function profileMember(root = ROOT): string {
	return `${root}Your Profile/Profile.csv`;
}

// Encoders

/** A cell holding any of these must be quoted. */
const CSV_QUOTED_RE = /[",\r\n]/;

/** Keys whose numbers Fitbit writes as doubles, with at least one fractional digit. */
const DOUBLE_KEYS: ReadonlySet<string> = new Set([
	"value",
	"error",
	"distance",
	"elevationGain",
	"speed",
	"pace",
	"caloriesOut",
	"vo2Max",
]);

/** `value` as the legacy export writes a member. */
export function fitbitJson(value: JsonValue): Buffer {
	return Buffer.from(encode(value, "", ""), "utf8");
}

/** A legacy JSON member of `Global Export Data/`. */
export function jsonMember(
	base: string,
	values: readonly JsonValue[],
	root = ROOT,
): ZipMember {
	return { name: legacyMember(base, root), data: fitbitJson([...values]) };
}

/**
 * A bare-array member cut off in the middle of `values[whole]`, after `whole`
 * complete values: a download that ended early.
 */
export function truncatedJson(
	values: readonly JsonValue[],
	whole: number,
): Buffer {
	const cut = values[whole];
	if (cut === undefined) {
		throw new RangeError(
			"truncatedJson needs a value after the whole ones to cut through",
		);
	}
	const text = encode(values.slice(0, whole + 1), "", "");
	// Drop the closing "]" and the back half of the last value.
	return Buffer.from(
		text.slice(0, text.length - 1 - Math.ceil(encode(cut, "", "").length / 2)),
		"utf8",
	);
}

/** CSV rows, each cell quoted when it must be, every row ended by `eol`. */
export function csv(
	rows: readonly (readonly string[])[],
	eol: "\r\n" | "\n",
): Buffer {
	return Buffer.from(
		rows.map((row) => `${row.map(csvCell).join(",")}${eol}`).join(""),
		"utf8",
	);
}

/** `text` cut just after the first `marker` in it: a download that ended early. */
export function truncatedCsv(text: Buffer, marker: string): Buffer {
	const at = text.indexOf(marker);
	if (at < 0) {
		throw new RangeError("truncatedCsv: the marker is not in the text");
	}
	return text.subarray(0, at + Buffer.byteLength(marker));
}

/** `value` without `keys`. */
export function without(
	value: JsonObject,
	...keys: readonly string[]
): JsonObject {
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !keys.includes(key)),
	);
}

function csvCell(cell: string): string {
	return CSV_QUOTED_RE.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

function encode(value: JsonValue, key: string, indent: string): string {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new RangeError("JSON has no non-finite numbers");
		}
		return DOUBLE_KEYS.has(key) ? javaDouble(value) : String(value);
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((item) => encode(item, key, indent)).join(",")}]`;
	}
	const inner = `${indent}  `;
	const entries = Object.entries(value).map(
		([name, item]) =>
			`${inner}${JSON.stringify(name)} : ${encode(item, name, inner)}`,
	);
	return entries.length === 0 ? "{ }" : `{\n${entries.join(",\n")}\n${indent}}`;
}

/** Java's `Double.toString`: at least one fractional digit, and E-notation outside [10^-3, 10^7). */
function javaDouble(value: number): string {
	const magnitude = Math.abs(value);
	if (magnitude !== 0 && (magnitude < 1e-3 || magnitude >= 1e7)) {
		const [mantissa = "", exponent = ""] = value.toExponential().split("e");
		return `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}E${String(Number(exponent))}`;
	}
	return Number.isInteger(value) ? `${String(value)}.0` : String(value);
}

// Rows

/** A steps or distance minute: `dateTime` is UTC, the value a string. */
export function minute(dateTime: string, value: string): JsonObject {
	return { dateTime, value };
}

/** An active-minutes row: `dateTime` is Fitbit's local day at midnight, the value a string. */
export function dailyRow(dateTime: string, value: string): JsonObject {
	return { dateTime, value };
}

/**
 * A resting-heart-rate row for the local day in `dateTime`. Without a
 * reading, it is Fitbit's padding: no inner date, and 0 for the value.
 */
export function restingRow(
	dateTime: string,
	reading: { readonly value: number; readonly error: number } | null = null,
): JsonObject {
	if (reading === null) {
		return { dateTime, value: { date: null, value: 0, error: 0 } };
	}
	return {
		dateTime,
		value: {
			date: dateTime.slice(0, 8),
			value: reading.value,
			error: reading.error,
		},
	};
}

/** Active-minute rows for 04/03/26 to 04/10/26, one value a day. */
function activeWeek(values: readonly string[]): JsonObject[] {
	return values.map((value, index) =>
		dailyRow(`04/${String(3 + index).padStart(2, "0")}/26 00:00:00`, value),
	);
}

/**
 * E1: a tracked run, with every key a legacy exercise log carries. Its three
 * durations differ (paused 14.5 s; first logged as 30 min), and so do its
 * start and its first-logged start. Every key the connector never reads
 * holds a canary, or a value no record carries.
 */
export function exercise(overrides: JsonObject = {}): JsonObject {
	return {
		logId: 21_000_000_001,
		activityName: "Run",
		activityTypeId: 90_009,
		activityLevel: [
			{ minutes: 2, name: "sedentary" },
			{ minutes: 4, name: "lightly" },
			{ minutes: 7, name: "fairly" },
			{ minutes: 17, name: "very" },
		],
		averageHeartRate: 173,
		calories: 98_765,
		duration: 1_805_000,
		activeDuration: 1_790_500,
		steps: 54_321,
		logType: "tracker",
		manualValuesSpecified: { calories: false, distance: false, steps: false },
		heartRateZones: [
			{ name: "Out of Range", min: 30, max: 97, minutes: 1, caloriesOut: 3.5 },
			{ name: "Fat Burn", min: 97, max: 135, minutes: 4, caloriesOut: 31.25 },
			{ name: "Cardio", min: 135, max: 164, minutes: 9, caloriesOut: 99.75 },
			{ name: "Peak", min: 164, max: 220, minutes: 86_421, caloriesOut: 170.5 },
		],
		activeZoneMinutes: {
			totalMinutes: 31,
			minutesInHeartRateZones: [
				{
					minutes: 9,
					zoneName: "Cardio",
					order: 2,
					type: "CARDIO",
					minuteMultiplier: 2,
				},
			],
		},
		lastModified: "03/14/26 07:31:07",
		startTime: "03/13/26 23:00:00",
		originalStartTime: "03/13/26 22:58:00",
		originalDuration: 1_800_000,
		hasGps: true,
		shouldFetchDetails: true,
		hasActiveZoneMinutes: true,
		elevationGain: 12.345_678_901_2,
		distance: 5.2,
		distanceUnit: "Kilometer",
		speed: 10.3693,
		pace: 347.115_384_6,
		vo2Max: { vo2Max: 48.25 },
		source: {
			type: "tracker",
			name: "CANARY_DEVICE",
			id: "CANARY_SERIAL_123",
			url: "https://canary.example.invalid/device",
			trackerFeatures: ["GPS"],
		},
		tcxLink: "https://canary.example.invalid/tcx/21000000001",
		...overrides,
	};
}

/**
 * The canonical exercise page, in the order the member holds it:
 * E1 run (5.2 km); E2 outdoor bike (15 mi); E3 weights (no distance);
 * E4 a name the owner typed, which is withheld.
 */
export function canonicalExercises(): JsonObject[] {
	return [
		exercise(),
		exercise({
			logId: 21_000_000_002,
			activityName: "Outdoor Bike",
			startTime: "03/15/26 06:10:00",
			originalStartTime: "03/15/26 06:10:00",
			lastModified: "03/15/26 08:00:00",
			duration: 3_720_000,
			activeDuration: 3_600_000,
			originalDuration: 3_720_000,
			distance: 15,
			distanceUnit: "Mile",
			tcxLink: "https://canary.example.invalid/tcx/21000000002",
		}),
		without(
			exercise({
				logId: 21_000_000_003,
				activityName: "Weights",
				startTime: "03/16/26 08:00:00",
				originalStartTime: "03/16/26 08:00:00",
				lastModified: "03/16/26 09:00:00",
				duration: 2_400_000,
				activeDuration: 2_400_000,
				originalDuration: 2_400_000,
				tcxLink: "https://canary.example.invalid/tcx/21000000003",
			}),
			"distance",
			"distanceUnit",
			"speed",
			"pace",
		),
		exercise({
			logId: 21_000_000_004,
			activityName: "CANARY_TITLE Parkrun with Dad",
			startTime: "03/17/26 21:30:00",
			originalStartTime: "03/17/26 21:30:00",
			lastModified: "03/17/26 22:00:00",
			duration: 1_500_000,
			activeDuration: 1_500_000,
			originalDuration: 1_500_000,
			distance: 3,
			distanceUnit: "Kilometer",
			tcxLink: "https://canary.example.invalid/tcx/21000000004",
		}),
	];
}

function stagesSummary(
	deep: number,
	light: number,
	rem: number,
	wake: number,
): JsonObject {
	return {
		deep: { count: 4, minutes: deep, thirtyDayAvgMinutes: deep + 3 },
		light: { count: 28, minutes: light, thirtyDayAvgMinutes: light - 5 },
		rem: { count: 6, minutes: rem, thirtyDayAvgMinutes: rem + 2 },
		wake: { count: 27, minutes: wake, thirtyDayAvgMinutes: wake - 1 },
	};
}

/**
 * The canonical sleep member's logs, with every key a legacy sleep log
 * carries: S1 a main stages sleep ending on 14 March; S2 a classic nap the
 * same day, which has no deep, light or REM summary; S3 a main stages sleep
 * ending on 15 March.
 */
export function canonicalSleepLogs(): JsonObject[] {
	return [
		{
			logId: 31_000_000_001,
			dateOfSleep: "2026-03-14",
			startTime: "2026-03-13T22:47:30.000",
			endTime: "2026-03-14T06:31:30.000",
			duration: 27_840_000,
			minutesToFallAsleep: 0,
			minutesAsleep: 402,
			minutesAwake: 62,
			minutesAfterWakeup: 0,
			timeInBed: 464,
			efficiency: 93,
			type: "stages",
			infoCode: 0,
			logType: "auto_detected",
			levels: {
				summary: stagesSummary(87, 236, 79, 62),
				data: [
					{ dateTime: "2026-03-13T22:47:30.000", level: "wake", seconds: 390 },
					{
						dateTime: "2026-03-13T22:54:00.000",
						level: "light",
						seconds: 1620,
					},
				],
				shortData: [
					{ dateTime: "2026-03-14T01:12:30.000", level: "wake", seconds: 60 },
				],
			},
			mainSleep: true,
		},
		{
			logId: 31_000_000_002,
			dateOfSleep: "2026-03-14",
			startTime: "2026-03-14T14:05:00.000",
			endTime: "2026-03-14T14:47:00.000",
			duration: 2_520_000,
			minutesToFallAsleep: 0,
			minutesAsleep: 38,
			minutesAwake: 1,
			minutesAfterWakeup: 3,
			timeInBed: 42,
			efficiency: 90,
			type: "classic",
			infoCode: 2,
			logType: "auto_detected",
			levels: {
				summary: {
					asleep: { count: 0, minutes: 38 },
					restless: { count: 2, minutes: 3 },
					awake: { count: 1, minutes: 1 },
				},
				data: [
					{
						dateTime: "2026-03-14T14:05:00.000",
						level: "asleep",
						seconds: 2280,
					},
				],
			},
			mainSleep: false,
		},
		{
			logId: 31_000_000_003,
			dateOfSleep: "2026-03-15",
			startTime: "2026-03-14T23:10:00.000",
			endTime: "2026-03-15T06:09:00.000",
			duration: 25_140_000,
			minutesToFallAsleep: 0,
			minutesAsleep: 371,
			minutesAwake: 48,
			minutesAfterWakeup: 0,
			timeInBed: 419,
			efficiency: 95,
			type: "stages",
			infoCode: 0,
			logType: "auto_detected",
			levels: {
				summary: stagesSummary(70, 225, 76, 48),
				data: [
					{ dateTime: "2026-03-14T23:10:00.000", level: "light", seconds: 900 },
				],
				shortData: [],
			},
			mainSleep: true,
		},
	];
}

/** The score file's header, which has been the same since 2022. */
export const SCORE_HEADER: readonly string[] = [
	"sleep_log_entry_id",
	"timestamp",
	"overall_score",
	"composition_score",
	"revitalization_score",
	"duration_score",
	"deep_sleep_in_minutes",
	"resting_heart_rate",
	"restlessness",
];

/** A score for a log the export does not hold. */
export const UNJOINED_SCORE_ROW: readonly string[] = [
	"31999999999",
	"2025-01-01T06:00:00Z",
	"70",
	"",
	"",
	"",
	"",
	"",
	"",
];

/** S1's and S3's scores, then one for a log the export does not hold. */
export const SCORE_ROWS: readonly (readonly string[])[] = [
	[
		"31000000001",
		"2026-03-14T06:31:30Z",
		"81",
		"",
		"24",
		"",
		"87",
		"58",
		"0.0712345678",
	],
	[
		"31000000003",
		"2026-03-15T06:09:00Z",
		"77",
		"19",
		"22",
		"38",
		"70",
		"57",
		"0.0611111111",
	],
	UNJOINED_SCORE_ROW,
];

/** `Sleep Score/sleep_score.csv` as Takeout writes it: LF, ending with a line break. */
export function scoreCsv(
	rows: readonly (readonly string[])[] = SCORE_ROWS,
	header: readonly string[] = SCORE_HEADER,
): Buffer {
	return csv([header, ...rows], "\n");
}

export const PROFILE_HEADER: readonly string[] = [
	"id",
	"full_name",
	"first_name",
	"last_name",
	"display_name_setting",
	"display_name",
	"username",
	"email_address",
	"date_of_birth",
	"child",
	"country",
	"state",
	"city",
	"timezone",
	"locale",
	"member_since",
	"about_me",
	"start_of_week",
	"sleep_tracking",
	"time_display_format",
	"gender",
	"height",
	"weight",
	"stride_length_walking",
	"stride_length_running",
	"weight_unit",
	"distance_unit",
	"height_unit",
	"water_unit",
	"glucose_unit",
	"swim_unit",
];

/** The one data row: a canary in every identity cell; `about_me` holds a comma and a line break. */
export const PROFILE_ROW: readonly string[] = [
	"CANARY1D",
	"CANARY_OWNER_NAME",
	"CANARY_FIRST_NAME",
	"CANARY_LAST_NAME",
	"CANARY_DISPLAY_NAME_SETTING",
	"CANARY_DISPLAY_NAME",
	"canary_owner_1",
	"canary.owner_1@example.invalid",
	"1961-07-04",
	"false",
	"CANARY_COUNTRY",
	"CANARY_STATE",
	"CANARY_CITY",
	PROFILE_ZONE,
	"en_AU",
	"2011-05-17",
	"CANARY_ABOUT, with a comma\r\nand a line break",
	"MONDAY",
	"Normal",
	"24hour",
	"CANARY_GENDER",
	"181.37",
	"77.73",
	"78.91",
	"112.34",
	"METRIC",
	"METRIC",
	"METRIC",
	"METRIC",
	"null",
	"null",
];

/** `Your Profile/Profile.csv` as Takeout writes it: CRLF, ending with a line break. */
export function profileCsv(
	rows: readonly (readonly string[])[] = [PROFILE_ROW],
	header: readonly string[] = PROFILE_HEADER,
): Buffer {
	return csv([header, ...rows], "\r\n");
}

/**
 * The canonical rows of each JSON member, fresh on every call so a test may
 * change them.
 *
 * Steps and distance are UTC minutes. Bucketed by the Sydney day they give
 * steps 7 on 3 April, 150 on the 4th, 95 on the 5th (the 25-hour day, whose
 * 15:59 UTC minute both steps members hold) and 60 on the 6th, and distance
 * 80 m, 30.5 m and 45 m on the 4th to the 6th. The daily families run to
 * 10 April, the days after the 6th only padding.
 */
export function canonicalRows(): {
	readonly exercise: JsonObject[];
	readonly sleep: JsonObject[];
	/** steps-2026-04-04.json */
	readonly stepsFirst: JsonObject[];
	/** steps-2026-04-05.json */
	readonly stepsSecond: JsonObject[];
	readonly distance: JsonObject[];
	readonly lightly: JsonObject[];
	readonly moderately: JsonObject[];
	readonly very: JsonObject[];
	readonly restingHeartRate: JsonObject[];
} {
	return {
		exercise: canonicalExercises(),
		sleep: canonicalSleepLogs(),
		stepsFirst: [
			minute("04/03/26 12:59:00", "7"),
			minute("04/03/26 13:00:00", "100"),
			minute("04/04/26 12:59:00", "50"),
			minute("04/04/26 13:00:00", "20"),
			minute("04/04/26 15:59:00", "30"),
		],
		stepsSecond: [
			minute("04/04/26 15:59:00", "30"),
			minute("04/04/26 16:00:00", "40"),
			minute("04/05/26 13:59:00", "5"),
			minute("04/05/26 14:00:00", "60"),
			minute("04/05/26 20:00:00", "0"),
		],
		distance: [
			minute("04/03/26 13:00:00", "8000"),
			minute("04/04/26 16:00:00", "3050"),
			minute("04/05/26 14:00:00", "4500"),
		],
		lightly: activeWeek(["0", "45", "30", "20", "0", "0", "0", "0"]),
		moderately: activeWeek(["0", "10", "0", "5", "0", "0", "0", "0"]),
		very: activeWeek(["0", "22", "0", "0", "0", "0", "0", "0"]),
		restingHeartRate: [
			restingRow("04/03/26 00:00:00"),
			restingRow("04/04/26 00:00:00", {
				value: 58.432_109_87,
				error: 6.123_456_789,
			}),
			restingRow("04/05/26 00:00:00", { value: 57.9, error: 5.5 }),
			...["06", "07", "08", "09", "10"].map((day) =>
				restingRow(`04/${day}/26 00:00:00`),
			),
		],
	};
}

/** What `canonicalMembers` can swap out: each family, the two CSV files, and the never-read members. */
type MemberGroup =
	| "exercise"
	| "sleep"
	| "steps"
	| "distance"
	| "lightly_active_minutes"
	| "moderately_active_minutes"
	| "very_active_minutes"
	| "resting_heart_rate"
	| "sleep_score"
	| "profile"
	| "never_read";

const APPLE_DOUBLE_HEAD = Buffer.concat([
	Buffer.from([0, 5, 22, 7, 0, 2, 0, 0]),
	Buffer.from("Mac OS X        ", "latin1"),
]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Members a real export holds that the connector must never open, each
 * carrying a canary or a value no record may show: identity and device files,
 * families out of scope, names that look like family members but fail one
 * selection rule, the Google-era folders, macOS metadata, and files outside
 * the Fitbit folder.
 */
export function neverReadMembers(): ZipMember[] {
	const text = (name: string, body: string): ZipMember => ({
		name,
		data: Buffer.from(body, "utf8"),
	});
	return [
		{
			name: `${ROOT}Your Profile/Media_Avatar Photo.png`,
			data: Buffer.concat([PNG_HEAD, Buffer.from("CANARY_AVATAR", "latin1")]),
			method: "store",
		},
		text(
			`${ROOT}Paired Devices/Devices.csv`,
			"wire_id,device_type,serial_number,enabled,fw_version\nCANARY_WIRE,TRACKER,CANARY_SERIAL_999,true,1.2.3\n",
		),
		jsonMember("heart_rate-2026-04-04.json", [
			{
				dateTime: "04/04/26 13:00:05",
				value: { bpm: "CANARY_HEART_RATE", confidence: 2 },
			},
		]),
		jsonMember("sedentary_minutes-2026-04-03.json", [
			dailyRow("04/03/26 00:00:00", "CANARY_SEDENTARY"),
		]),
		jsonMember("time_in_heart_rate_zones-2026-04-04.json", [
			{
				dateTime: "04/04/26 00:00:00",
				value: { valuesInZones: { IN_DEFAULT_ZONE_1: "CANARY_ZONES" } },
			},
		]),
		jsonMember("calories-2026-04-04.json", [
			minute("04/04/26 13:00:00", "CANARY_CALORIES"),
		]),
		jsonMember("altitude-2026-04-04.json", [
			minute("04/04/26 13:00:00", "CANARY_ALTITUDE"),
		]),
		jsonMember("badge.json", [
			{ encodedId: "CANARY_BADGE", badgeType: "DAILY_STEPS", timesAchieved: 3 },
		]),
		jsonMember("weight-2026-03-14.json", [
			{
				logId: 1_773_446_400_000,
				weight: 171.25,
				bmi: 23.41,
				date: "03/14/26",
				time: "06:40:00",
				source: "CANARY_WEIGHT_SOURCE",
			},
		]),
		// A family basename not directly in Global Export Data/.
		jsonMember("archive/steps-2026-04-04.json", [
			minute("04/04/26 13:00:00", "99999"),
		]),
		text(
			`${ROOT}Physical Activity_GoogleData/steps_2026-04-01.csv`,
			"timestamp,steps,data source\n2026-04-01T00:00:00Z,12,CANARY_G_STEPS\n",
		),
		text(
			`${ROOT}Physical Activity_GoogleData/steps_readme.txt`,
			"CANARY_G_README\n",
		),
		text(
			`${ROOT}Physical Activity_GoogleData/calories_in_heart_rate_zone_2026-04-01.csv`,
			"timestamp,calories,data source\n2026-04-01T00:00:00Z,1.5,CANARY_G_CALORIES\n",
		),
		text(
			`${ROOT}Health Fitness Data_GoogleData/UserSleeps_2025-10-01.csv`,
			"sleep_id,sleep_type,data_source\n1,STAGES,CANARY_G_SLEEP\n",
		),
		text(
			`${ROOT}Health Fitness Data_GoogleData/UserExercises_2025-10-01.csv`,
			"exercise_id,activity_name\n1,CANARY_G_EXERCISE\n",
		),
		text(`${ROOT}Stress Journal/entries.json`, '[{"note":"CANARY_JOURNAL"}]'),
		// A macOS resource fork: under __MACOSX/, and its basename starts with "._".
		{
			name: `__MACOSX/${ROOT}Global Export Data/._steps-2026-04-04.json`,
			data: APPLE_DOUBLE_HEAD,
		},
		// Google Fit's own folder, and Takeout's index page: outside the Fitbit folder.
		text(
			"Takeout/Fit/Activities/2026-03-13T23_00_00Z_Running.tcx",
			"<TrainingCenterDatabase>CANARY_ROUTE</TrainingCenterDatabase>\n",
		),
		text(
			"Takeout/archive_browser.html",
			"<html>CANARY_ARCHIVE_BROWSER</html>\n",
		),
	];
}

/**
 * The complete canonical export: every family's members, the score file and
 * the profile, then every never-read member. `replace` swaps a group's
 * members for a test's own; `[]` drops them.
 */
export function canonicalMembers(
	replace: Partial<Record<MemberGroup, readonly ZipMember[]>> = {},
): ZipMember[] {
	const rows = canonicalRows();
	const groups: readonly (readonly [MemberGroup, readonly ZipMember[]])[] = [
		["exercise", [jsonMember("exercise-0.json", rows.exercise)]],
		["sleep", [jsonMember("sleep-2026-03-14.json", rows.sleep)]],
		[
			"steps",
			[
				jsonMember("steps-2026-04-04.json", rows.stepsFirst),
				jsonMember("steps-2026-04-05.json", rows.stepsSecond),
			],
		],
		["distance", [jsonMember("distance-2026-04-04.json", rows.distance)]],
		[
			"lightly_active_minutes",
			[jsonMember("lightly_active_minutes-2026-04-03.json", rows.lightly)],
		],
		[
			"moderately_active_minutes",
			[
				jsonMember(
					"moderately_active_minutes-2026-04-03.json",
					rows.moderately,
				),
			],
		],
		[
			"very_active_minutes",
			[jsonMember("very_active_minutes-2026-04-03.json", rows.very)],
		],
		[
			"resting_heart_rate",
			[jsonMember("resting_heart_rate-2026-04-03.json", rows.restingHeartRate)],
		],
		["sleep_score", [{ name: sleepScoreMember(), data: scoreCsv() }]],
		["profile", [{ name: profileMember(), data: profileCsv() }]],
		["never_read", neverReadMembers()],
	];
	return groups.flatMap(([group, members]) => [...(replace[group] ?? members)]);
}

/** Writes one ZIP, the first part of the canonical export by default, into `dir`; returns its path. */
export function canonicalZip(
	dir: string,
	name = partName(1),
	members: readonly ZipMember[] = canonicalMembers(),
): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeZip(path, members);
	return path;
}

/**
 * Writes one export as several parts: `parts[i]` becomes part i + 1, named by
 * `nameOf`. Returns the paths in part order.
 */
export function writeParts(
	dir: string,
	parts: readonly (readonly ZipMember[])[],
	nameOf: (part: number) => string = (part) => partName(part),
): string[] {
	mkdirSync(dir, { recursive: true });
	return parts.map((members, index) => {
		const path = join(dir, nameOf(index + 1));
		writeZip(path, members);
		return path;
	});
}

/**
 * The canonical export as `k` parts, members dealt round-robin by their
 * index, so a family's members straddle parts. Returns the paths in part
 * order.
 */
export function canonicalParts(
	dir: string,
	k: number,
	members: readonly ZipMember[] = canonicalMembers(),
): string[] {
	const parts = Array.from({ length: k }, (_, part) =>
		members.filter((_member, index) => index % k === part),
	);
	return writeParts(dir, parts);
}

/** Strings that must never appear in the connector's stdout or stderr. */
export const CANARIES: readonly string[] = [
	"CANARY_",
	"CANARY1D",
	"canary_owner_1",
	"canary.owner_1@example.invalid",
	"canary.example.invalid",
	"1961-07-04",
	PROFILE_ZONE,
	"Sydney",
	"98765",
	"54321",
	"86421",
	"12.3456789012",
	"347.1153846",
	"6.123456789",
	"0.0712345678",
	"181.37",
	"77.73",
	"78.91",
	"112.34",
	"2011-05-17",
	// The audit clock and the first-logged start, as written and as ISO text.
	"03/13/26 22:58:00",
	"2026-03-13T22:58:00",
	"03/14/26 07:31:07",
	"2026-03-14T07:31:07",
	// E1's start on the owner's Sydney clock.
	"2026-03-14T10:00:00",
	// Every sleep start and end: local wall-clock times.
	"2026-03-13T22:47:30",
	"2026-03-14T06:31:30",
	"2026-03-14T14:05:00",
	"2026-03-14T14:47:00",
	"2026-03-14T23:10:00",
	"2026-03-15T06:09:00",
];

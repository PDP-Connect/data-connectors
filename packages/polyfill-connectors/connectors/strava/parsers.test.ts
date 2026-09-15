// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser tests for the Strava account export.
 *
 * The first block is the one that matters. `activities.csv` repeats `Distance`
 * and `Elapsed Time`, first in the athlete's display units and then in
 * canonical metres and seconds. Reading the wrong occurrence yields a number
 * that is unlabelled, plausible and wrong — a five-mile run recorded as `5`.
 * These tests pin the resolution by index so a layout change fails here rather
 * than in someone's activity history.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildActivityRecord,
	type ColumnError,
	type ColumnIndex,
	numberOrNull,
	parseActivityDate,
	parseCsvRows,
	resolveColumns,
} from "./parsers.ts";

/**
 * A reduced header, kept because it makes the index assertions below readable.
 * It is NOT the real export layout — {@link REAL_HEADER} is, and the gap
 * between them is what let a real archive fail to parse: this one repeats two
 * headers and the export repeats five.
 */
const HEADER = [
	"Activity ID",
	"Activity Date",
	"Activity Name",
	"Activity Type",
	"Activity Description",
	"Elapsed Time", // display units
	"Distance", // display units — may be miles
	"Max Heart Rate",
	"Relative Effort",
	"Activity Gear",
	"Filename",
	"Athlete Weight",
	"Bike Weight",
	"Elapsed Time", // canonical seconds
	"Moving Time",
	"Distance", // canonical metres
	"Average Heart Rate",
	"Elevation Gain",
	"Calories",
];

function columns(): ColumnIndex {
	const resolved = resolveColumns(HEADER);
	assert.ok(!("missing" in resolved), "header should resolve");
	return resolved as ColumnIndex;
}

test("repeated Distance and Elapsed Time resolve to the LAST occurrence", () => {
	const cols = columns();
	assert.equal(
		cols.distanceM,
		15,
		"Distance must be the canonical metres column",
	);
	assert.equal(
		cols.elapsedTimeS,
		13,
		"Elapsed Time must be the canonical seconds column",
	);
	// Guard the inverse explicitly: reading index 6 would be miles.
	assert.notEqual(cols.distanceM, 6);
	assert.notEqual(cols.elapsedTimeS, 5);
});

test("both occurrences of a repeated header are recorded for diagnostics", () => {
	const cols = columns();
	assert.deepEqual(cols.occurrences.get("Distance"), [6, 15]);
	assert.deepEqual(cols.occurrences.get("Elapsed Time"), [5, 13]);
});

test("the miles/metres distinction survives a real row", () => {
	const cols = columns();
	const row = new Array<string>(HEADER.length).fill("");
	row[0] = "11385479490";
	row[1] = "2024-05-20T13:05:32Z";
	row[3] = "Run";
	row[6] = "5.04"; // miles, as displayed
	row[15] = "8111.2"; // metres, canonical
	const record = buildActivityRecord(row, cols, null);
	assert.ok(record);
	assert.equal(
		record.distance_m,
		8111.2,
		"must take metres, not the display value",
	);
});

test("an unexpectedly repeated header is refused, not guessed at", () => {
	const resolved = resolveColumns([...HEADER, "Calories"]);
	assert.ok("missing" in resolved);
	assert.match((resolved as { message: string }).message, /Calories/);
	assert.match((resolved as { message: string }).message, /refusing to guess/);
});

test("a missing required header names what is missing", () => {
	const resolved = resolveColumns(["Activity Date", "Activity Type"]);
	assert.ok("missing" in resolved);
	assert.deepEqual((resolved as ColumnError).missing, [
		"Activity ID",
		"Distance",
		"Elapsed Time",
	]);
});

test("an empty cell is null, never zero", () => {
	assert.equal(numberOrNull(""), null);
	assert.equal(numberOrNull("   "), null);
	assert.equal(numberOrNull(undefined), null);
	assert.equal(numberOrNull("not a number"), null);
	// A real zero is preserved — absence and zero are different facts.
	assert.equal(numberOrNull("0"), 0);
});

test("a ride with no heart-rate strap yields null heart rates, not zeros", () => {
	const cols = columns();
	const row = new Array<string>(HEADER.length).fill("");
	row[0] = "999";
	row[1] = "2024-05-20T13:05:32Z";
	row[3] = "Ride";
	const record = buildActivityRecord(row, cols, null);
	assert.ok(record);
	assert.equal(record.average_heartrate, null);
	assert.equal(record.max_heartrate, null);
	assert.equal(record.calories_kcal, null);
});

test("start_time_basis is utc only when the source states a zone", () => {
	assert.deepEqual(parseActivityDate("2024-05-20T13:05:32Z"), {
		iso: "2024-05-20T13:05:32Z",
		basis: "utc",
	});
	assert.deepEqual(parseActivityDate("2024-05-20T13:05:32+10:00"), {
		iso: "2024-05-20T13:05:32+10:00",
		basis: "utc",
	});
});

test("start_time_basis is unknown when the source states no zone", () => {
	// Strava's own rendering carries no zone marker. Asserting UTC here would be
	// silently right for anyone who never travels and wrong by up to twelve
	// hours for anyone who does.
	assert.deepEqual(parseActivityDate("Aug 12, 2020, 7:30:00 AM"), {
		iso: "2020-08-12T07:30:00",
		basis: "unknown",
	});
	assert.deepEqual(parseActivityDate("2024-05-20 13:05:32"), {
		iso: "2024-05-20T13:05:32",
		basis: "unknown",
	});
});

test("12-hour clock converts correctly at both noon and midnight", () => {
	assert.equal(
		parseActivityDate("Aug 12, 2020, 12:30:00 AM")?.iso,
		"2020-08-12T00:30:00",
	);
	assert.equal(
		parseActivityDate("Aug 12, 2020, 12:30:00 PM")?.iso,
		"2020-08-12T12:30:00",
	);
	assert.equal(
		parseActivityDate("Aug 12, 2020, 1:05:00 PM")?.iso,
		"2020-08-12T13:05:00",
	);
});

test("an unparseable or empty date yields null so the row is counted, not guessed", () => {
	assert.equal(parseActivityDate(""), null);
	assert.equal(parseActivityDate(undefined), null);
	assert.equal(parseActivityDate("last Tuesday"), null);
});

test("a row with no usable id is rejected rather than emitted with a fake one", () => {
	const cols = columns();
	const row = new Array<string>(HEADER.length).fill("");
	row[0] = "not-an-id";
	row[1] = "2024-05-20T13:05:32Z";
	assert.equal(buildActivityRecord(row, cols, null), null);
});

test("CSV reader handles quoted fields containing commas and quotes", () => {
	const { rows, error } = parseCsvRows('a,b\n"x, y","he said ""hi"""\n');
	assert.equal(error, undefined);
	assert.deepEqual(rows[1], ["x, y", 'he said "hi"']);
});

test("CSV reader reports a truncated quoted field rather than silently closing it", () => {
	const { error } = parseCsvRows('a,b\n"unterminated,2\n');
	assert.match(String(error), /inside a quoted field/);
});

test("a UTF-8 BOM does not corrupt the first header name", () => {
	const { rows } = parseCsvRows("﻿Activity ID,Activity Date\n1,2\n");
	assert.equal(rows[0]?.[0], "Activity ID");
});

test("excluded fields are absent from the built record, not merely unread", () => {
	const cols = columns();
	const row = new Array<string>(HEADER.length).fill("");
	row[0] = "1";
	row[1] = "2024-05-20T13:05:32Z";
	row[2] = "Parkrun with Dad"; // Activity Name — a third party's name
	row[4] = "felt great"; // Activity Description
	row[11] = "72.5"; // Athlete Weight
	const record = buildActivityRecord(row, cols, null);
	assert.ok(record);
	const keys = Object.keys(record);
	for (const forbidden of [
		"name",
		"activity_name",
		"description",
		"athlete_weight",
		"bike_weight",
	]) {
		assert.ok(!keys.includes(forbidden), `${forbidden} must never be emitted`);
	}
	// And no location, by any spelling.
	for (const forbidden of [
		"start_latlng",
		"end_latlng",
		"map_polyline",
		"sunrise",
		"sunset",
	]) {
		assert.ok(!keys.includes(forbidden), `${forbidden} must never be emitted`);
	}
});

test("freshness is stamped on every record so a reading is self-describing", () => {
	const cols = columns();
	const row = new Array<string>(HEADER.length).fill("");
	row[0] = "1";
	row[1] = "2024-05-20T13:05:32Z";
	const record = buildActivityRecord(row, cols, "2026-09-12T00:00:00.000Z");
	assert.ok(record);
	assert.equal(record.freshness, "snapshot");
	assert.equal(record.exported_at, "2026-09-12T00:00:00.000Z");
});

/**
 * The header of a real Strava account export, captured verbatim in September
 * 2026. All 103 columns, in export order.
 *
 * This exists because the reduced header above did not: it repeats `Distance`
 * and `Elapsed Time` only, so it agreed with a connector that knew about two
 * repeated headers, while the real export repeats five and was refused outright
 * with `strava_export_columns_unexpected`. A fixture that cannot fail the way
 * production failed is not a test of the thing that broke.
 *
 * Column names carry no personal data — every Strava export has these headers.
 */
const REAL_HEADER = [
	"Activity ID",
	"Activity Date",
	"Activity Name",
	"Activity Type",
	"Activity Description",
	"Elapsed Time",
	"Distance",
	"Max Heart Rate",
	"Relative Effort",
	"Commute",
	"Activity Private Note",
	"Activity Gear",
	"Filename",
	"Athlete Weight",
	"Bike Weight",
	"Elapsed Time",
	"Moving Time",
	"Distance",
	"Max Speed",
	"Average Speed",
	"Elevation Gain",
	"Elevation Loss",
	"Elevation Low",
	"Elevation High",
	"Max Grade",
	"Average Grade",
	"Average Positive Grade",
	"Average Negative Grade",
	"Max Cadence",
	"Average Cadence",
	"Max Heart Rate",
	"Average Heart Rate",
	"Max Watts",
	"Average Watts",
	"Calories",
	"Max Temperature",
	"Average Temperature",
	"Relative Effort",
	"Total Work",
	"Number of Runs",
	"Uphill Time",
	"Downhill Time",
	"Other Time",
	"Perceived Exertion",
	"Type",
	"Start Time",
	"Weighted Average Power",
	"Power Count",
	"Prefer Perceived Exertion",
	"Perceived Relative Effort",
	"Commute",
	"Total Weight Lifted",
	"From Upload",
	"Grade Adjusted Distance",
	"Weather Observation Time",
	"Weather Condition",
	"Weather Temperature",
	"Apparent Temperature",
	"Dewpoint",
	"Humidity",
	"Weather Pressure",
	"Wind Speed",
	"Wind Gust",
	"Wind Bearing",
	"Precipitation Intensity",
	"Sunrise Time",
	"Sunset Time",
	"Moon Phase",
	"Bike",
	"Gear",
	"Precipitation Probability",
	"Precipitation Type",
	"Cloud Cover",
	"Weather Visibility",
	"UV Index",
	"Weather Ozone",
	"Jump Count",
	"Total Grit",
	"Average Flow",
	"Flagged",
	"Average Elapsed Speed",
	"Dirt Distance",
	"Newly Explored Distance",
	"Newly Explored Dirt Distance",
	"Activity Count",
	"Total Steps",
	"Carbon Saved",
	"Pool Length",
	"Training Load",
	"Intensity",
	"Average Grade Adjusted Pace",
	"Timer Time",
	"Total Cycles",
	"Recovery",
	"With Pet",
	"Competition",
	"Long Run",
	"For a Cause",
	"With Kid",
	"Downhill Distance",
	"Total Sets",
	"Total Reps",
	"Media",
];

function realColumns(): ColumnIndex {
	const resolved = resolveColumns(REAL_HEADER);
	assert.ok(
		!("missing" in resolved),
		`the real export header must resolve, got: ${(resolved as ColumnError).message}`,
	);
	return resolved as ColumnIndex;
}

test("the real export header resolves every field to its captured index", () => {
	const cols = realColumns();
	assert.deepEqual(
		{
			activityDate: cols.activityDate,
			activityType: cols.activityType,
			averageHeartRate: cols.averageHeartRate,
			calories: cols.calories,
			distanceM: cols.distanceM,
			elapsedTimeS: cols.elapsedTimeS,
			elevationGainM: cols.elevationGainM,
			gear: cols.gear,
			id: cols.id,
			maxHeartRate: cols.maxHeartRate,
			movingTimeS: cols.movingTimeS,
		},
		{
			activityDate: 1,
			activityType: 3,
			averageHeartRate: 31,
			calories: 34,
			// The LAST Distance: metres. The first, at 6, is kilometres here.
			distanceM: 17,
			// The LAST Elapsed Time: canonical seconds.
			elapsedTimeS: 15,
			elevationGainM: 20,
			gear: 11,
			id: 0,
			// The FIRST Max Heart Rate. The second, at 30, is a strict subset:
			// every row carrying both agreed, and many carried only this one.
			maxHeartRate: 7,
			movingTimeS: 16,
		},
	);
});

test("the real export repeats exactly the five headers we have accounted for", () => {
	const cols = realColumns();
	const repeated = [...cols.occurrences.entries()]
		.filter(([, at]) => at.length > 1)
		.map(([name, at]) => [name, [...at]] as const)
		.sort(([a], [b]) => a.localeCompare(b));
	assert.deepEqual(repeated, [
		["Commute", [9, 50]],
		["Distance", [6, 17]],
		["Elapsed Time", [5, 15]],
		["Max Heart Rate", [7, 30]],
		["Relative Effort", [8, 37]],
	]);
});

test("a sixth repeated header is refused rather than guessed at", () => {
	// The point of naming repeats one by one: Strava repeating something new
	// must stop the import, not be absorbed by a rule written for other columns.
	const withNewRepeat = [...REAL_HEADER, "Calories"];
	const resolved = resolveColumns(withNewRepeat);
	assert.ok("missing" in resolved, "an unaccounted repeat must not resolve");
	assert.match((resolved as ColumnError).message, /Calories/);
	assert.match((resolved as ColumnError).message, /refusing to guess/);
});

test("elapsed time falls back to the display column only when it is a bare number", () => {
	const cols = realColumns();
	const row = new Array<string>(REAL_HEADER.length).fill("");
	row[0] = "1234567890";
	row[1] = "Jan 2, 2020, 7:30:00 AM";
	row[3] = "Run";
	row[17] = "5000";

	// The canonical column empty, the display column seconds: recovered. A few
	// rows in the captured export were exactly this shape.
	row[5] = "1800";
	row[15] = "";
	assert.equal(buildActivityRecord(row, cols, null)?.elapsed_time_s, 1800);

	// The canonical column empty, the display column a MM:SS rendering: left
	// null. Reading it would report a 30-minute run as 30 seconds.
	row[5] = "30:00";
	assert.equal(buildActivityRecord(row, cols, null)?.elapsed_time_s, null);

	// The canonical column present always wins, whatever the display column says.
	row[5] = "30:00";
	row[15] = "1795";
	assert.equal(buildActivityRecord(row, cols, null)?.elapsed_time_s, 1795);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Day tests: the profile zone's local day for a UTC minute, the bounded
 * minute dedupe, the day cells and their rules, and the taint that keeps a
 * partly read daily file from delivering a partial total.
 *
 * The zones are chosen to break the easy shortcuts: Australia/Sydney has a
 * 25-hour and a 23-hour day, Asia/Colombo's midnight falls inside a UTC hour,
 * and Australia/Lord_Howe changes its offset by half an hour at half past a
 * UTC hour.
 *
 * The whole file runs on Chicago time, and one test re-runs every answer
 * under zones either side of UTC. Every function under test must be
 * independent of the process zone.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	DayBook,
	type DayTaint,
	familyTaint,
	LocalDayClock,
	type MemberTaint,
	type MinuteField,
	MinuteWindow,
	WHOLE_HISTORY,
} from "./days.ts";
import {
	type Built,
	countText,
	fitbitInstant,
	measureText,
	type Reader,
	type Reading,
	readDailyRow,
	readMinuteRow,
	readRestingHeartRateRow,
} from "./parsers.ts";
import {
	type DailyField,
	type DailySummaryRecord,
	validateRecord,
} from "./schemas.ts";

process.env.TZ = "America/Chicago";

const EXPORTED_AT = "2026-09-20T08:15:00.000Z";
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const VALUE = (value: number): Reading => ({
	value,
	unreadable: false,
	present: true,
});
const UNREADABLE: Reading = { value: null, unreadable: true, present: true };
const NOT_MEASURED: Reading = { value: null, unreadable: false, present: true };
const NO_TAINT: ReadonlyMap<DailyField, DayTaint> = new Map();

/** A UTC instant written with its `Z`. */
function utc(iso: string): number {
	assert.ok(iso.endsWith("Z"), iso);
	const ms = Date.parse(iso);
	assert.ok(Number.isFinite(ms), iso);
	return ms;
}

/** A legacy minute's `dateTime`, as the parser reads it. */
function minute(dateTime: string): number {
	const ms = fitbitInstant(dateTime);
	assert.ok(ms !== null, dateTime);
	return ms;
}

function clockFor(zone: string): LocalDayClock {
	const clock = LocalDayClock.fromZone(zone);
	assert.ok(clock !== null, zone);
	return clock;
}

function span(from: string | null, to: string | null) {
	return { from, to };
}

function taintOf(
	field: DailyField,
	taint: DayTaint,
): ReadonlyMap<DailyField, DayTaint> {
	return new Map([[field, taint]]);
}

type DayRecord = Extract<Built<DailySummaryRecord>, { kind: "record" }>;

function recordsOf(
	built: Iterable<Built<DailySummaryRecord>>,
): Map<string, DayRecord> {
	const records = new Map<string, DayRecord>();
	for (const day of built) {
		if (day.kind === "record") {
			records.set(day.record.date, day);
		}
	}
	return records;
}

function dayOf(records: Map<string, DayRecord>, date: string): DayRecord {
	const day = records.get(date);
	assert.ok(day !== undefined, `a record for ${date}`);
	return day;
}

// The canonical daily members, as the synthetic export writes them. The
// profile zone is Australia/Sydney, whose DST ends at 16:00Z on 4 April.

const STEPS_MEMBERS: readonly (readonly (readonly [string, string])[])[] = [
	[
		["04/03/26 12:59:00", "7"],
		["04/03/26 13:00:00", "100"],
		["04/04/26 12:59:00", "50"],
		["04/04/26 13:00:00", "20"],
		["04/04/26 15:59:00", "30"],
	],
	[
		// Repeats the previous member's last minute.
		["04/04/26 15:59:00", "30"],
		["04/04/26 16:00:00", "40"],
		["04/05/26 13:59:00", "5"],
		["04/05/26 14:00:00", "60"],
		["04/05/26 20:00:00", "0"],
	],
];
const DISTANCE_MEMBERS: readonly (readonly (readonly [string, string])[])[] = [
	[
		["04/03/26 13:00:00", "8000"],
		["04/04/26 16:00:00", "3050"],
		["04/05/26 14:00:00", "4500"],
	],
];
const ACTIVE_MINUTES: readonly (readonly [DailyField, readonly string[]])[] = [
	["lightly_active_minutes", ["0", "45", "30", "20", "0", "0", "0", "0"]],
	["moderately_active_minutes", ["0", "10", "0", "5", "0", "0", "0", "0"]],
	["very_active_minutes", ["0", "22", "0", "0", "0", "0", "0", "0"]],
];
const PADDING = { date: null, value: 0.0, error: 0.0 };
const RESTING_HEART_RATE: readonly unknown[] = [
	PADDING,
	{ date: "04/04/26", value: 58.43210987, error: 6.123456789 },
	{ date: "04/05/26", value: 57.9, error: 5.5 },
	PADDING,
	PADDING,
	PADDING,
	PADDING,
	PADDING,
];

interface Merge {
	readonly book: DayBook;
	readonly duplicates: number;
	/** Per minute field, per member: the local days it placed a minute on. */
	readonly placed: ReadonlyMap<MinuteField, readonly ReadonlySet<string>[]>;
}

/**
 * The daily merge as collect.ts runs it: each minute family through its own
 * MinuteWindow, rotated between members, onto Sydney days; then each daily
 * family's rows, first row for a date winning.
 */
function merge(
	steps: readonly (readonly (readonly [string, string])[])[] = STEPS_MEMBERS,
): Merge {
	const clock = clockFor("Australia/Sydney");
	const book = new DayBook();
	let duplicates = 0;
	const placed = new Map<MinuteField, ReadonlySet<string>[]>();
	const families: readonly (readonly [
		MinuteField,
		Reader,
		readonly (readonly (readonly [string, string])[])[],
	])[] = [
		["steps", countText, steps],
		["distance_m", measureText, DISTANCE_MEMBERS],
	];
	for (const [field, read, members] of families) {
		const window = new MinuteWindow();
		const days: Set<string>[] = [];
		for (const member of members) {
			const memberDays = new Set<string>();
			for (const [dateTime, value] of member) {
				const row = readMinuteRow({ dateTime, value }, read);
				assert.equal(row.kind, "value", dateTime);
				if (row.kind !== "value") {
					continue;
				}
				if (window.admit(row.key) === "duplicate") {
					duplicates += 1;
					continue;
				}
				const day = clock.localDate(row.key);
				book.addMinute(day, field, row.reading);
				memberDays.add(day);
			}
			days.push(memberDays);
			window.nextMember();
		}
		placed.set(field, days);
	}
	for (const [field, values] of ACTIVE_MINUTES) {
		for (const [index, value] of values.entries()) {
			const row = readDailyRow({
				dateTime: `04/${pad(index + 3)}/26 00:00:00`,
				value,
			});
			assert.ok(row.kind === "value");
			assert.equal(book.setDaily(row.key, field, row.reading), "set");
		}
	}
	for (const [index, value] of RESTING_HEART_RATE.entries()) {
		const row = readRestingHeartRateRow({
			dateTime: `04/${pad(index + 3)}/26 00:00:00`,
			value,
		});
		assert.ok(row.kind === "value");
		book.setDaily(row.key, "resting_heart_rate_bpm", row.reading);
	}
	return { book, duplicates, placed };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function daily(
	date: string,
	values: readonly (number | null)[],
): DailySummaryRecord {
	const [
		steps = null,
		distance_m = null,
		lightly_active_minutes = null,
		moderately_active_minutes = null,
		very_active_minutes = null,
		resting_heart_rate_bpm = null,
	] = values;
	return {
		id: date,
		date,
		steps,
		distance_m,
		lightly_active_minutes,
		moderately_active_minutes,
		very_active_minutes,
		resting_heart_rate_bpm,
		freshness: "snapshot",
		exported_at: EXPORTED_AT,
	};
}

/** The canonical records, written out by hand: steps, distance_m, lightly, moderately, very, resting HR. */
const CANONICAL_DAYS: readonly DailySummaryRecord[] = [
	daily("2026-04-03", [7, null, 0, 0, 0, null]),
	daily("2026-04-04", [150, 80, 45, 10, 22, 58.43210987]),
	daily("2026-04-05", [95, 30.5, 30, 0, 0, 57.9]),
	daily("2026-04-06", [60, 45, 20, 5, 0, null]),
];

// LocalDayClock

test("LocalDayClock.fromZone takes an IANA zone name and refuses anything else", () => {
	for (const zone of [
		"Australia/Sydney",
		"UTC",
		"Etc/GMT-10",
		"America/Argentina/Buenos_Aires",
		"Asia/Colombo",
	]) {
		assert.ok(LocalDayClock.fromZone(zone) !== null, zone);
	}
	for (const zone of [
		null,
		"null",
		"",
		"Mars/Olympus",
		"+05:30",
		"GMT+5",
		"Australia/Sydney ",
		" Australia/Sydney",
		"Australia//Sydney",
		"/Australia/Sydney",
		`Etc/${"A".repeat(61)}`,
	]) {
		assert.equal(LocalDayClock.fromZone(zone), null, String(zone));
	}
});

test("Sydney offsets follow both DST changes of 2026", () => {
	const sydney = clockFor("Australia/Sydney");
	assert.equal(sydney.offsetMs(utc("2026-04-04T15:59:00Z")), 11 * HOUR_MS);
	assert.equal(sydney.offsetMs(utc("2026-04-04T16:00:00Z")), 10 * HOUR_MS);
	assert.equal(sydney.offsetMs(utc("2026-10-03T15:59:00Z")), 10 * HOUR_MS);
	assert.equal(sydney.offsetMs(utc("2026-10-03T16:00:00Z")), 11 * HOUR_MS);
	// Back again, out of order: the cache follows the instant asked about.
	assert.equal(sydney.offsetMs(utc("2026-04-04T15:59:00Z")), 11 * HOUR_MS);
});

test("Sydney local days: the 25-hour day of 5 April and the 23-hour day of 4 October", () => {
	const sydney = clockFor("Australia/Sydney");
	const cases: readonly (readonly [string, string])[] = [
		["04/04/26 12:59:00", "2026-04-04"],
		["04/04/26 13:00:00", "2026-04-05"],
		// 02:59 daylight time, then 02:00 standard time: both 5 April.
		["04/04/26 15:59:00", "2026-04-05"],
		["04/04/26 16:00:00", "2026-04-05"],
		["04/05/26 13:59:00", "2026-04-05"],
		["04/05/26 14:00:00", "2026-04-06"],
		["10/03/26 13:59:00", "2026-10-03"],
		["10/03/26 14:00:00", "2026-10-04"],
		["10/04/26 12:59:00", "2026-10-04"],
		["10/04/26 13:00:00", "2026-10-05"],
	];
	for (const [dateTime, expected] of cases) {
		assert.equal(sydney.localDate(minute(dateTime)), expected, dateTime);
	}
});

test("Colombo: a local midnight inside a UTC hour", () => {
	const colombo = clockFor("Asia/Colombo");
	assert.equal(colombo.localDate(utc("2026-01-15T18:29:00Z")), "2026-01-15");
	assert.equal(colombo.localDate(utc("2026-01-15T18:30:00Z")), "2026-01-16");
	// The same hour, asked the other way round.
	const fresh = clockFor("Asia/Colombo");
	assert.equal(fresh.localDate(utc("2026-01-15T18:30:00Z")), "2026-01-16");
	assert.equal(fresh.localDate(utc("2026-01-15T18:29:59.999Z")), "2026-01-15");
});

test("Lord Howe: an offset change at half past a UTC hour, with the cache cold or warm", () => {
	const early = utc("2026-10-03T15:29:00Z");
	const late = utc("2026-10-03T15:30:00Z");
	const warm = clockFor("Australia/Lord_Howe");
	assert.equal(warm.offsetMs(early), 630 * MINUTE_MS);
	assert.equal(warm.offsetMs(late), 660 * MINUTE_MS);
	const lateFirst = clockFor("Australia/Lord_Howe");
	assert.equal(lateFirst.offsetMs(late), 660 * MINUTE_MS);
	assert.equal(lateFirst.offsetMs(early), 630 * MINUTE_MS);
	// Either side of that hour, a whole hour on one offset.
	assert.equal(warm.offsetMs(utc("2026-10-03T14:59:00Z")), 630 * MINUTE_MS);
	assert.equal(warm.offsetMs(utc("2026-10-03T16:00:00Z")), 660 * MINUTE_MS);
});

// MinuteWindow

test("MinuteWindow drops a repeat in this member or the previous one, and not two members back", () => {
	const window = new MinuteWindow();
	const a = minute("04/04/26 15:59:00");
	const b = minute("04/04/26 16:00:00");
	assert.equal(window.admit(a), "new");
	assert.equal(window.admit(a), "duplicate", "the same member");
	window.nextMember();
	assert.equal(window.admit(a), "duplicate", "the previous member");
	assert.equal(window.admit(b), "new");
	window.nextMember();
	// `a` was repeated in the member just read, so it is still seen.
	assert.equal(window.admit(a), "duplicate");
	window.nextMember();
	window.nextMember();
	// Two members back: the documented bound.
	assert.equal(window.admit(b), "new");
});

// DayBook

test("DayBook: the first daily row for a date wins", () => {
	const book = new DayBook();
	assert.equal(
		book.setDaily("2026-04-04", "lightly_active_minutes", VALUE(45)),
		"set",
	);
	assert.equal(
		book.setDaily("2026-04-04", "lightly_active_minutes", VALUE(99)),
		"duplicate",
	);
	// A padding row is a row: a later value for its date is a duplicate.
	assert.equal(
		book.setDaily("2026-04-03", "resting_heart_rate_bpm", NOT_MEASURED),
		"set",
	);
	assert.equal(
		book.setDaily("2026-04-03", "resting_heart_rate_bpm", VALUE(60)),
		"duplicate",
	);
	const records = recordsOf(book.days(EXPORTED_AT, NO_TAINT));
	assert.equal(dayOf(records, "2026-04-04").record.lightly_active_minutes, 45);
	assert.equal(records.has("2026-04-03"), false, "padding alone is no reading");
});

test("DayBook: an unreadable minute blanks and flags its day's sum, never a partial total", () => {
	const book = new DayBook();
	book.addMinute("2026-04-05", "steps", VALUE(10));
	book.addMinute("2026-04-05", "steps", UNREADABLE);
	book.addMinute("2026-04-05", "steps", VALUE(5));
	book.addMinute("2026-04-05", "distance_m", VALUE(300));
	book.addMinute("2026-04-06", "steps", VALUE(12));
	const records = recordsOf(book.days(EXPORTED_AT, NO_TAINT));
	const fifth = dayOf(records, "2026-04-05");
	assert.equal(fifth.record.steps, null);
	assert.equal(fifth.record.distance_m, 3);
	assert.deepEqual(fifth.unreadable, ["steps"]);
	assert.deepEqual(fifth.present, ["steps", "distance_m"]);
	assert.equal(dayOf(records, "2026-04-06").record.steps, 12);
	assert.deepEqual(dayOf(records, "2026-04-06").unreadable, []);
});

test("DayBook: distance sums centimetres, then rounds once to the centimetre and converts", () => {
	const book = new DayBook();
	book.addMinute("2026-04-05", "distance_m", VALUE(3050));
	book.addMinute("2026-04-05", "distance_m", VALUE(1));
	book.addMinute("2026-04-06", "distance_m", VALUE(3050.4));
	book.addMinute("2026-04-06", "distance_m", VALUE(0.4));
	const records = recordsOf(book.days(null, NO_TAINT));
	assert.equal(dayOf(records, "2026-04-05").record.distance_m, 30.51);
	// Rounded per minute, this day would read 30.5.
	assert.equal(dayOf(records, "2026-04-06").record.distance_m, 30.51);
});

test("DayBook.days: zero-only days are no reading; a day with one non-zero reading is a record", () => {
	const { book } = merge();
	const days = [...book.days(EXPORTED_AT, NO_TAINT)];
	assert.deepEqual(
		days.map((day) => [day.kind, day.timeKey]),
		[
			["record", "2026-04-03"],
			["record", "2026-04-04"],
			["record", "2026-04-05"],
			["record", "2026-04-06"],
			["no_reading", "2026-04-07"],
			["no_reading", "2026-04-08"],
			["no_reading", "2026-04-09"],
			["no_reading", "2026-04-10"],
		],
	);
	const padded = days[4];
	assert.deepEqual(padded, {
		kind: "no_reading",
		timeKey: "2026-04-07",
		// The rows were read, zeros and padding: each family is present.
		present: [
			"lightly_active_minutes",
			"moderately_active_minutes",
			"very_active_minutes",
			"resting_heart_rate_bpm",
		],
	});
	// 3 April's only non-zero reading is 7 steps; the others are as set.
	assert.deepEqual(
		dayOf(recordsOf(days), "2026-04-03").record,
		CANONICAL_DAYS[0],
	);

	// A day of zero minutes only is no reading too.
	const zeros = new DayBook();
	zeros.addMinute("2026-04-06", "steps", VALUE(0));
	zeros.addMinute("2026-04-06", "distance_m", VALUE(0));
	assert.deepEqual(
		[...zeros.days(EXPORTED_AT, NO_TAINT)],
		[
			{
				kind: "no_reading",
				timeKey: "2026-04-06",
				present: ["steps", "distance_m"],
			},
		],
	);
});

test("the canonical daily members merge to exactly the canonical records on Sydney days", () => {
	const { book, duplicates } = merge();
	assert.equal(duplicates, 1, "the repeated 15:59Z minute");
	const days = [...book.days(EXPORTED_AT, NO_TAINT)];
	const records = days.flatMap((day) => (day.kind === "record" ? [day] : []));
	assert.deepEqual(
		records.map((day) => day.record),
		CANONICAL_DAYS,
	);
	for (const day of records) {
		assert.deepEqual(day.unreadable, []);
		assert.equal(day.timeKey, day.record.date);
		const result = validateRecord("daily_summaries", day.record);
		assert.ok(result.ok, JSON.stringify(result));
		assert.equal(result.anomalies, undefined);
	}
	assert.equal(days.filter((day) => day.kind === "no_reading").length, 4);
});

// After the export

test("DayBook.days after the export: an unreadable padding value is no reading; a readable one is kept", () => {
	const book = new DayBook();
	book.setDaily("2026-09-21", "resting_heart_rate_bpm", UNREADABLE);
	book.setDaily("2026-09-22", "resting_heart_rate_bpm", UNREADABLE);
	book.setDaily("2026-09-22", "lightly_active_minutes", VALUE(0));
	book.addMinute("2026-09-23", "steps", VALUE(5));
	book.setDaily("2099-12-31", "resting_heart_rate_bpm", UNREADABLE);
	const bounded = [...book.days(EXPORTED_AT, NO_TAINT)];
	assert.deepEqual(
		bounded.map((day) => [day.kind, day.timeKey]),
		[
			// Inside the day of slack past the export's UTC date (20 Sep).
			["record", "2026-09-21"],
			["no_reading", "2026-09-22"],
			// A readable non-zero value is never dropped.
			["record", "2026-09-23"],
			["no_reading", "2099-12-31"],
		],
	);
	const records = recordsOf(bounded);
	assert.deepEqual(dayOf(records, "2026-09-21").unreadable, [
		"resting_heart_rate_bpm",
	]);
	assert.equal(dayOf(records, "2026-09-23").record.steps, 5);

	// Without an export time there is no bound.
	const unbounded = [...book.days(null, NO_TAINT)];
	assert.deepEqual(
		unbounded.map((day) => day.kind),
		["record", "record", "record", "record"],
	);
	assert.equal(
		dayOf(recordsOf(unbounded), "2099-12-31").record.exported_at,
		null,
	);
});

// Taint: a daily file not read in full

test("a steps taint blanks and flags the sums on its days only, even a complete one", () => {
	const { book } = merge();
	const spanned = recordsOf(
		book.days(
			EXPORTED_AT,
			taintOf("steps", {
				days: new Set(),
				spans: [span("2026-04-04", "2026-04-05")],
			}),
		),
	);
	for (const date of ["2026-04-04", "2026-04-05"]) {
		const day = dayOf(spanned, date);
		assert.equal(day.record.steps, null, date);
		assert.deepEqual(day.unreadable, ["steps"], date);
		// Only its own family's field: distance keeps its sum.
		assert.notEqual(day.record.distance_m, null, date);
	}
	assert.equal(dayOf(spanned, "2026-04-03").record.steps, 7);
	assert.deepEqual(dayOf(spanned, "2026-04-03").unreadable, []);
	assert.equal(dayOf(spanned, "2026-04-06").record.steps, 60);
	assert.deepEqual(dayOf(spanned, "2026-04-06").unreadable, []);

	const placed = recordsOf(
		book.days(
			EXPORTED_AT,
			taintOf("steps", { days: new Set(["2026-04-06"]), spans: [] }),
		),
	);
	assert.equal(dayOf(placed, "2026-04-06").record.steps, null);
	assert.deepEqual(dayOf(placed, "2026-04-06").unreadable, ["steps"]);
	assert.equal(dayOf(placed, "2026-04-05").record.steps, 95);
});

test("WHOLE_HISTORY blanks and flags a sum on every record, and never makes a zero-only day a record", () => {
	const { book } = merge();
	const days = [...book.days(EXPORTED_AT, taintOf("steps", WHOLE_HISTORY))];
	const records = days.flatMap((day) => (day.kind === "record" ? [day] : []));
	assert.deepEqual(
		records.map((day) => day.record),
		CANONICAL_DAYS.map((record) => ({ ...record, steps: null })),
	);
	for (const day of records) {
		assert.deepEqual(day.unreadable, ["steps"]);
	}
	assert.equal(days.filter((day) => day.kind === "no_reading").length, 4);

	const both = recordsOf(
		book.days(
			EXPORTED_AT,
			new Map([
				["steps", WHOLE_HISTORY],
				["distance_m", WHOLE_HISTORY],
			]),
		),
	);
	assert.deepEqual(dayOf(both, "2026-04-04").unreadable, [
		"steps",
		"distance_m",
	]);
});

test("a one-row field's taint keeps the rows read, and flags only the days no row reached", () => {
	const book = new DayBook();
	const steps: readonly (readonly [string, number])[] = [
		["2026-04-02", 12],
		["2026-04-03", 7],
		["2026-04-04", 150],
		["2026-04-05", 95],
		["2026-04-06", 60],
		["2026-04-07", 0],
		["2026-04-09", 5],
	];
	for (const [date, value] of steps) {
		book.addMinute(date, "steps", VALUE(value));
	}
	book.setDaily("2026-04-03", "resting_heart_rate_bpm", NOT_MEASURED);
	book.setDaily("2026-04-04", "resting_heart_rate_bpm", VALUE(58.43210987));
	book.setDaily("2026-04-06", "resting_heart_rate_bpm", UNREADABLE);
	book.setDaily("2026-04-07", "resting_heart_rate_bpm", NOT_MEASURED);
	const days = [
		...book.days(
			EXPORTED_AT,
			taintOf("resting_heart_rate_bpm", {
				days: new Set(),
				spans: [span("2026-04-03", "2026-04-08")],
			}),
		),
	];
	const records = recordsOf(days);
	const rhr = (date: string) => {
		const day = dayOf(records, date);
		return [day.record.resting_heart_rate_bpm, day.unreadable];
	};
	assert.deepEqual(rhr("2026-04-02"), [null, []], "outside the span");
	assert.deepEqual(rhr("2026-04-03"), [null, []], "a padding row was read");
	assert.deepEqual(rhr("2026-04-04"), [58.43210987, []], "a value was read");
	assert.deepEqual(
		rhr("2026-04-05"),
		[null, ["resting_heart_rate_bpm"]],
		"no row reached it",
	);
	assert.deepEqual(
		rhr("2026-04-06"),
		[null, ["resting_heart_rate_bpm"]],
		"an unreadable row stays flagged",
	);
	assert.deepEqual(rhr("2026-04-09"), [null, []], "outside the span");
	// Zero-only inside the span: still no reading.
	assert.deepEqual(
		days.find((day) => day.timeKey === "2026-04-07")?.kind,
		"no_reading",
	);
});

test("a steps member cut after three minutes: its days and name span lose their sums, the next member's day keeps its own", () => {
	const first = STEPS_MEMBERS[0] ?? [];
	const second = STEPS_MEMBERS[1] ?? [];
	const { book, placed } = merge([first.slice(0, 3), second]);
	const [cut, whole] = placed.get("steps") ?? [];
	assert.deepEqual(cut, new Set(["2026-04-03", "2026-04-04"]));
	const taint = familyTaint(
		[
			{ nameDate: "2026-04-04", tainted: true, days: cut ?? new Set() },
			{ nameDate: "2026-04-05", tainted: false, days: whole ?? new Set() },
		],
		EXPORTED_AT,
	);
	const records = recordsOf(book.days(EXPORTED_AT, taintOf("steps", taint)));
	assert.deepEqual(
		["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"].map(
			(date) => dayOf(records, date).record.steps,
		),
		// Kept partial, 5 April would read 75 (the true total is 95).
		[null, null, null, 60],
	);
	assert.deepEqual(dayOf(records, "2026-04-06").unreadable, []);
});

test("a later steps member never read: days before its span keep their sums", () => {
	const { book, placed } = merge([STEPS_MEMBERS[0] ?? []]);
	const taint = familyTaint(
		[
			{
				nameDate: "2026-04-04",
				tainted: false,
				days: placed.get("steps")?.[0] ?? new Set(),
			},
			// Duplicated across parts: tainted, and it placed nothing.
			{ nameDate: "2026-04-05", tainted: true, days: new Set() },
		],
		EXPORTED_AT,
	);
	assert.deepEqual(taint.spans, [span("2026-04-04", "2026-09-21")]);
	const records = recordsOf(book.days(EXPORTED_AT, taintOf("steps", taint)));
	assert.deepEqual(
		["2026-04-03", "2026-04-04", "2026-04-05", "2026-04-06"].map(
			(date) => dayOf(records, date).record.steps,
		),
		// Kept partial, 5 April would read 50.
		[7, null, null, null],
	);
});

// familyTaint

function member(
	nameDate: string,
	tainted: boolean,
	days: readonly string[] = [],
): MemberTaint {
	return { nameDate, tainted, days: new Set(days) };
}

test("familyTaint: a tainted member's placed days, and its span from its name date − 1 to the next member's", () => {
	assert.deepEqual(
		familyTaint(
			[
				member("2026-04-04", true, ["2026-04-03", "2026-04-04"]),
				member("2026-04-05", false, ["2026-04-05", "2026-04-06"]),
			],
			EXPORTED_AT,
		),
		{
			days: new Set(["2026-04-03", "2026-04-04"]),
			spans: [span("2026-04-03", "2026-04-05")],
		},
	);
});

test("familyTaint: the last member's span ends a day after the export's UTC date, or never", () => {
	const members = [
		member("2026-04-04", false, ["2026-04-04"]),
		member("2026-04-05", true),
	];
	assert.deepEqual(familyTaint(members, EXPORTED_AT), {
		days: new Set(),
		spans: [span("2026-04-04", "2026-09-21")],
	});
	assert.deepEqual(familyTaint(members, null), {
		days: new Set(),
		spans: [span("2026-04-04", null)],
	});
});

test("familyTaint: members in any order, a duplicated one among them, are placed by name date", () => {
	const members = [
		member("2026-04-05", false, ["2026-04-05"]),
		member("2026-05-05", true),
		member("2026-06-04", false, ["2026-06-04"]),
	];
	const orders = [
		[0, 1, 2],
		[2, 1, 0],
		[1, 2, 0],
		[1, 0, 2],
	];
	for (const order of orders) {
		const shuffled = order.map((index) => members[index] ?? member("", false));
		assert.deepEqual(
			familyTaint(shuffled, EXPORTED_AT),
			{ days: new Set(), spans: [span("2026-05-04", "2026-06-04")] },
			order.join(","),
		);
	}
	// A cut member followed by a duplicated one: the cut member's span ends at
	// the duplicated member's name date, where its own rows end.
	assert.deepEqual(
		familyTaint(
			[
				member("2026-06-04", false, ["2026-06-04"]),
				member("2026-04-05", true),
				member("2026-04-04", true, ["2026-04-03", "2026-04-04"]),
			],
			EXPORTED_AT,
		),
		{
			days: new Set(["2026-04-03", "2026-04-04"]),
			spans: [
				span("2026-04-03", "2026-04-05"),
				span("2026-04-04", "2026-06-04"),
			],
		},
	);
});

test("familyTaint: a span that needs a date that is not a real day is the whole history", () => {
	assert.deepEqual(
		familyTaint(
			[member("2026-02-30", true), member("2026-03-30", false)],
			EXPORTED_AT,
		).spans,
		[span(null, null)],
	);
	assert.deepEqual(
		familyTaint(
			[member("2026-02-01", true), member("2026-02-30", false)],
			EXPORTED_AT,
		).spans,
		[span(null, null)],
	);
	// An untainted member with an unreal name date harms no one else.
	assert.deepEqual(
		familyTaint([member("2026-02-30", false), member("2026-03-30", true)], null)
			.spans,
		[span("2026-03-29", null)],
	);
});

test("familyTaint: day arithmetic across a leap day, a year end and the export's year end", () => {
	assert.deepEqual(
		familyTaint([member("2024-03-01", true)], "2026-12-31T23:00:00.000Z").spans,
		[span("2024-02-29", "2027-01-01")],
	);
	assert.deepEqual(
		familyTaint(
			[member("2026-01-01", true), member("2026-01-31", false)],
			EXPORTED_AT,
		).spans,
		[span("2025-12-31", "2026-01-31")],
	);
	// Each first day after a US clock change, the process zone's.
	assert.deepEqual(
		familyTaint(
			[
				member("2026-03-09", true),
				member("2026-11-02", true),
				member("2026-11-30", false),
			],
			EXPORTED_AT,
		).spans,
		[span("2026-03-08", "2026-11-02"), span("2026-11-01", "2026-11-30")],
	);
});

test("familyTaint: no tainted member, no taint", () => {
	assert.deepEqual(
		familyTaint(
			[
				member("2026-04-04", false, ["2026-04-04"]),
				member("2026-04-05", false),
			],
			EXPORTED_AT,
		),
		{ days: new Set(), spans: [] },
	);
	assert.deepEqual(familyTaint([], null), { days: new Set(), spans: [] });
});

// The process zone

/** Every zone-dependent answer in this file, as plain data. */
function zoneFreeAnswers(): unknown {
	const sydney = clockFor("Australia/Sydney");
	const colombo = clockFor("Asia/Colombo");
	const lordHowe = clockFor("Australia/Lord_Howe");
	const sydneyMinutes = [
		"04/03/26 12:59:00",
		"04/03/26 13:00:00",
		"04/04/26 15:59:00",
		"04/04/26 16:00:00",
		"04/05/26 13:59:00",
		"04/05/26 14:00:00",
		"10/03/26 13:59:00",
		"10/03/26 14:00:00",
		"10/04/26 12:59:00",
		"10/04/26 13:00:00",
	];
	const bounded = new DayBook();
	bounded.setDaily("2026-09-21", "resting_heart_rate_bpm", UNREADABLE);
	bounded.setDaily("2026-09-22", "resting_heart_rate_bpm", UNREADABLE);
	return {
		sydney: sydneyMinutes.map((dateTime) => [
			sydney.localDate(minute(dateTime)),
			sydney.offsetMs(minute(dateTime)),
		]),
		colombo: ["2026-01-15T18:29:00Z", "2026-01-15T18:30:00Z"].map((iso) =>
			colombo.localDate(utc(iso)),
		),
		lordHowe: ["2026-10-03T15:29:00Z", "2026-10-03T15:30:00Z"].map((iso) =>
			lordHowe.offsetMs(utc(iso)),
		),
		canonical: [...merge().book.days(EXPORTED_AT, NO_TAINT)],
		bounded: [...bounded.days(EXPORTED_AT, NO_TAINT)].map((day) => day.kind),
		taint: familyTaint(
			[member("2024-03-01", true), member("2026-01-01", true)],
			"2026-12-31T23:00:00.000Z",
		),
	};
}

test("no answer depends on the process zone, east or west of UTC", () => {
	const expected = zoneFreeAnswers();
	const hours = new Set<number>();
	try {
		for (const zone of [
			"UTC",
			"Australia/Sydney",
			"Asia/Kolkata",
			"Pacific/Kiritimati",
			"Pacific/Pago_Pago",
			"Australia/Lord_Howe",
			"America/Chicago",
		]) {
			process.env.TZ = zone;
			hours.add(new Date(Date.UTC(2026, 0, 1)).getHours());
			assert.deepEqual(zoneFreeAnswers(), expected, zone);
		}
	} finally {
		process.env.TZ = "America/Chicago";
	}
	// The zone switch took effect, so the comparison proves something.
	assert.ok(hours.size >= 5, `local hours seen: ${[...hours].join(",")}`);
	assert.deepEqual((expected as { taint: unknown }).taint, {
		days: new Set(),
		spans: [span("2024-02-29", "2026-01-01"), span("2025-12-31", "2027-01-01")],
	});
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure builders, against the synthetic fixtures and edits of them, and the Zod schemas beside
 * the manifest's JSON Schema. Expected values are written out here from the fixtures, not computed
 * by the code under test.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { z } from "zod";
import type { RecordData } from "../../packages/polyfill-connectors/src/connector-runtime.ts";
import {
	activityRow,
	activityRows,
	type Built,
	dailySummary,
	dayRecord,
	hrvRow,
	hrvRows,
	isDay,
	rowRecord,
	siteTimeZone,
	sleepRow,
	sleepRows,
	trainingStatus,
	type Window,
	windowRows,
} from "./parsers.ts";
import { SCHEMAS, STREAMS, type Stream, validateRecord } from "./schemas.ts";

type Obj = Record<string, unknown>;

const read = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./${name}`, import.meta.url), "utf8"),
	) as unknown;
/** A fresh copy of a fixture, safe to edit. */
const fixture = <T = Obj>(name: string): T => read(`fixtures/${name}`) as T;

const SUMMARY_DAY = "2026-09-16";
/** The window every fixture row sits in. */
const WINDOW: Window = { from: "2026-08-25", to: "2026-09-21" };

const nightRows = (): Obj[] =>
	fixture<{ individualStats: Obj[] }>("sleep-stats.json").individualStats;
const hrvFixtureRows = (): Obj[] =>
	fixture<{ hrvSummaries: Obj[] }>("hrv-daily.json").hrvSummaries;
const activities = (): Obj[] => fixture<Obj[]>("activities.json");
const nth = <T>(items: readonly T[], index: number): T => {
	const item = items[index];
	assert.ok(item !== undefined, `item ${index}`);
	return item;
};
/** `base` with `changes` laid over it; a change to `undefined` removes the key. */
const merged = (base: Obj, changes: Obj): Obj =>
	Object.fromEntries(
		Object.entries({ ...base, ...changes }).filter(
			([, value]) => value !== undefined,
		),
	);

function recordOf(built: Built): RecordData {
	if (built.kind !== "record") assert.fail(`not a record: ${built.kind}`);
	return built.record;
}
const kindOf = (built: Built): string => built.kind;

// ── The manifest's JSON Schema beside Zod ──────────────────────────────────
interface JsonSchema {
	type?: string | string[];
	format?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
}
interface ManifestStream {
	name: string;
	schema: JsonSchema;
}
const manifest = read("manifest.json") as { streams: ManifestStream[] };
function manifestSchema(stream: Stream): JsonSchema {
	const spec = manifest.streams.find(({ name }) => name === stream);
	assert.ok(spec, `${stream} in manifest`);
	return spec.schema;
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const manifestCheck = new Map(
	STREAMS.map(
		(stream) => [stream, ajv.compile(manifestSchema(stream))] as const,
	),
);

/** Whether Zod (cleanly, with no anomaly) and the manifest's JSON Schema each accept a record. */
function verdicts(
	stream: Stream,
	record: RecordData,
): { zod: boolean; manifest: boolean } {
	const check = validateRecord(stream, record);
	const compiled = manifestCheck.get(stream);
	assert.ok(compiled);
	return {
		zod: check.ok && !check.anomalies?.length,
		manifest: compiled(record),
	};
}
const BOTH = { zod: true, manifest: true };
const NEITHER = { zod: false, manifest: false };

// ── Days ───────────────────────────────────────────────────────────────────
test("isDay takes a calendar day the calendar has, and nothing else", () => {
	for (const day of ["2026-09-16", "2028-02-29", "2026-12-31"]) {
		assert.equal(isDay(day), true, day);
	}
	for (const value of [
		"2026-02-29",
		"2026-09-31",
		"2026-13-01",
		"2026-9-16",
		"2026-09-16T00:00:00Z",
		" 2026-09-16",
		20_260_916,
		null,
		undefined,
	]) {
		assert.equal(isDay(value), false, String(value));
	}
});

// ── Settings ───────────────────────────────────────────────────────────────
test("siteTimeZone reads the settings' time zone and nothing else from them", () => {
	assert.equal(siteTimeZone(fixture("settings.json")), "Pacific/Auckland");
	for (const value of [
		{ displayName: "fixture-owner" },
		{ timeZone: "" },
		{ timeZone: "  " },
		{ timeZone: 10 },
		[{ timeZone: "UTC" }],
		null,
		"Pacific/Auckland",
	]) {
		assert.equal(siteTimeZone(value), undefined, JSON.stringify(value));
	}
});

// ── daily_summaries ────────────────────────────────────────────────────────
test("dailySummary sets every field by hand from its source, and reads no handle or account id", () => {
	const built = dailySummary(SUMMARY_DAY, fixture("daily-summary.json"));
	assert.deepEqual(recordOf(built), {
		id: SUMMARY_DAY,
		date: SUMMARY_DAY,
		steps: 8432,
		resting_heart_rate_bpm: 52,
		min_heart_rate_bpm: 47,
		average_stress_level: 31,
		body_battery_high: 88,
		body_battery_low: 24,
	});
	assert.deepEqual(
		dayRecord("daily_summaries", SUMMARY_DAY, fixture("daily-summary.json")),
		built,
	);
});

test("dailySummary: a day with every metric null or absent is empty, whatever date it carries", () => {
	const empty = fixture("daily-summary-empty.json");
	assert.equal(kindOf(dailySummary("2026-09-17", empty)), "empty");
	assert.equal(kindOf(dailySummary("2026-09-01", empty)), "empty");
	// Garmin leaves a null key out.
	assert.equal(
		kindOf(
			dailySummary("2026-09-17", {
				calendarDate: "2026-09-17",
				userProfileId: 41001,
			}),
		),
		"empty",
	);
	assert.equal(kindOf(dailySummary("2026-09-17", {})), "empty");
});

test("dailySummary: an absent metric is null, not unreadable", () => {
	const summary = merged(fixture("daily-summary.json"), {
		restingHeartRate: undefined,
		bodyBatteryHighestValue: undefined,
	});
	const record = recordOf(dailySummary(SUMMARY_DAY, summary));
	assert.equal(record.resting_heart_rate_bpm, null);
	assert.equal(record.body_battery_high, null);
	assert.equal(record.steps, 8432);
});

test("dailySummary: a negative stress or Body Battery is Garmin's not-measured, and reads as null", () => {
	const record = recordOf(
		dailySummary(
			SUMMARY_DAY,
			merged(fixture("daily-summary.json"), {
				averageStressLevel: -1,
				bodyBatteryHighestValue: -2,
				bodyBatteryLowestValue: -1,
			}),
		),
	);
	assert.equal(record.average_stress_level, null);
	assert.equal(record.body_battery_high, null);
	assert.equal(record.body_battery_low, null);
	// Only sentinels: nothing measured, so nothing to record.
	assert.equal(
		kindOf(
			dailySummary(SUMMARY_DAY, {
				calendarDate: SUMMARY_DAY,
				averageStressLevel: -1,
				bodyBatteryHighestValue: -2,
			}),
		),
		"empty",
	);
});

test("dailySummary: another day's summary, a metric of the wrong type, or a body that is not an object is unreadable", () => {
	const summary = fixture("daily-summary.json");
	assert.equal(kindOf(dailySummary("2026-09-15", summary)), "unreadable");
	assert.equal(
		kindOf(
			dailySummary(SUMMARY_DAY, merged(summary, { calendarDate: undefined })),
		),
		"unreadable",
	);
	for (const change of [
		{ totalSteps: "8432" },
		{ restingHeartRate: true },
		{ minHeartRate: {} },
		{ averageStressLevel: "31" },
		{ bodyBatteryLowestValue: [24] },
		{ totalSteps: Number.NaN },
	]) {
		assert.deepEqual(
			dailySummary(SUMMARY_DAY, merged(summary, change)),
			{ kind: "unreadable" },
			JSON.stringify(change),
		);
	}
	for (const body of [null, [], "summary", 0]) {
		assert.deepEqual(dailySummary(SUMMARY_DAY, body), { kind: "unreadable" });
	}
});

test("dailySummary: a fractional count builds, and the schema refuses it, so it is counted unreadable", () => {
	const record = recordOf(
		dailySummary(
			SUMMARY_DAY,
			merged(fixture("daily-summary.json"), { totalSteps: 8432.5 }),
		),
	);
	assert.deepEqual(verdicts("daily_summaries", record), NEITHER);
});

// ── training_status ────────────────────────────────────────────────────────
const statusDay = "2026-09-16";
type StatusBody = {
	latestTrainingStatusData: Record<string, Obj | null> | null;
} & Obj;
const statusBody = (): StatusBody =>
	fixture<StatusBody>("training-status.json");
const statusEntry = (): Obj => {
	const data = statusBody().latestTrainingStatusData;
	assert.ok(data);
	return nth(Object.values(data), 0) as Obj;
};
const withEntries = (entries: Record<string, unknown>): StatusBody => ({
	...statusBody(),
	latestTrainingStatusData: entries as Record<string, Obj | null>,
});

test("trainingStatus sets every field by hand, and reads no device id or device name", () => {
	const built = trainingStatus(statusDay, statusBody());
	assert.deepEqual(recordOf(built), {
		id: statusDay,
		date: statusDay,
		training_status: "PRODUCTIVE_AER_HIGH_SHORT",
		training_status_code: 7,
		weekly_training_load: 412,
		training_paused: false,
	});
	assert.deepEqual(
		dayRecord("training_status", statusDay, statusBody()),
		built,
	);
	assert.doesNotMatch(JSON.stringify(built), /41002|Fixture Watch/);
});

test("trainingStatus: no data, no entries, or only null entries is empty", () => {
	assert.equal(
		kindOf(trainingStatus(statusDay, fixture("training-status-empty.json"))),
		"empty",
	);
	assert.equal(kindOf(trainingStatus(statusDay, { userId: 41001 })), "empty");
	assert.equal(kindOf(trainingStatus(statusDay, withEntries({}))), "empty");
	assert.equal(
		kindOf(trainingStatus(statusDay, withEntries({ "41002": null }))),
		"empty",
	);
});

test("trainingStatus: a null device entry beside a real one is passed over", () => {
	const record = recordOf(
		trainingStatus(
			statusDay,
			withEntries({ "41003": null, "41002": statusEntry() }),
		),
	);
	assert.equal(record.training_status_code, 7);
});

test("trainingStatus: an entry dated another day is that day's status carried forward, so this day has none", () => {
	assert.equal(kindOf(trainingStatus("2026-09-17", statusBody())), "empty");
	assert.equal(kindOf(trainingStatus("2026-09-15", statusBody())), "empty");
});

test("trainingStatus: an entry whose date does not parse is unreadable, not quietly empty", () => {
	for (const calendarDate of [undefined, null, "16/09/2026", 20_260_916]) {
		assert.deepEqual(
			trainingStatus(
				statusDay,
				withEntries({ "41002": merged(statusEntry(), { calendarDate }) }),
			),
			{ kind: "unreadable" },
			String(calendarDate),
		);
	}
});

test("trainingStatus: an entry with neither a phrase nor a code is empty; with either, a record", () => {
	const neither = merged(statusEntry(), {
		trainingStatusFeedbackPhrase: undefined,
		trainingStatus: null,
	});
	assert.equal(
		kindOf(trainingStatus(statusDay, withEntries({ a: neither }))),
		"empty",
	);
	const codeOnly = recordOf(
		trainingStatus(
			statusDay,
			withEntries({ a: merged(neither, { trainingStatus: 0 }) }),
		),
	);
	assert.equal(codeOnly.training_status_code, 0);
	assert.equal(codeOnly.training_status, null);
	const phraseOnly = recordOf(
		trainingStatus(
			statusDay,
			withEntries({
				a: merged(neither, { trainingStatusFeedbackPhrase: "NO_STATUS" }),
			}),
		),
	);
	assert.equal(phraseOnly.training_status, "NO_STATUS");
	assert.equal(phraseOnly.training_status_code, null);
});

test("trainingStatus: a watch that sends no load reads it as null", () => {
	const record = recordOf(
		trainingStatus(
			statusDay,
			withEntries({
				a: merged(statusEntry(), {
					weeklyTrainingLoad: null,
					loadTunnelMin: null,
					loadTunnelMax: null,
					trainingPaused: undefined,
					acuteTrainingLoadDTO: { dailyTrainingLoadAcute: 400 },
				}),
			}),
		),
	);
	assert.equal(record.weekly_training_load, null);
	assert.equal(record.training_paused, null);
});

test("trainingStatus: the primary training device speaks for the day, else the latest entry", () => {
	const at = (code: number, timestamp: number, primary: boolean): Obj =>
		merged(statusEntry(), {
			trainingStatus: code,
			timestamp,
			primaryTrainingDevice: primary,
		});
	const codeOf = (entries: Record<string, Obj>): unknown =>
		recordOf(trainingStatus(statusDay, withEntries(entries)))
			.training_status_code;
	assert.equal(
		codeOf({ a: at(4, 2, false), b: at(5, 1, true) }),
		5,
		"primary wins over later",
	);
	assert.equal(
		codeOf({ a: at(4, 1, false), b: at(5, 3, false), c: at(6, 2, false) }),
		5,
		"latest",
	);
	assert.equal(
		codeOf({ a: at(4, 1, true), b: at(6, 3, true), c: at(7, 9, false) }),
		6,
		"latest primary",
	);
	assert.equal(
		codeOf({
			a: merged(at(4, 1, false), { timestamp: "late" }),
			b: at(5, 0, false),
		}),
		5,
		"an unreadable timestamp is the earliest",
	);
});

test("trainingStatus: a field of the wrong type, an entry that is not an object, or a body that is not one is unreadable", () => {
	for (const change of [
		{ trainingStatus: "7" },
		{ trainingStatusFeedbackPhrase: 7 },
		{ weeklyTrainingLoad: "412" },
		{ trainingPaused: "false" },
	]) {
		assert.deepEqual(
			trainingStatus(
				statusDay,
				withEntries({ a: merged(statusEntry(), change) }),
			),
			{ kind: "unreadable" },
			JSON.stringify(change),
		);
	}
	assert.equal(
		kindOf(trainingStatus(statusDay, withEntries({ a: "entry" }))),
		"unreadable",
	);
	assert.equal(
		kindOf(
			trainingStatus(statusDay, { latestTrainingStatusData: [statusEntry()] }),
		),
		"unreadable",
	);
	for (const body of [null, [], "status"]) {
		assert.equal(kindOf(trainingStatus(statusDay, body)), "unreadable");
	}
});

// ── sleep ──────────────────────────────────────────────────────────────────
test("sleepRows takes individualStats, null as none, and refuses any other envelope", () => {
	assert.deepEqual(sleepRows(null), []);
	assert.deepEqual(sleepRows(fixture("sleep-stats-empty.json")), []);
	assert.equal(sleepRows(fixture("sleep-stats.json"))?.length, 2);
	assert.deepEqual(windowRows("sleep", fixture("sleep-stats-empty.json")), []);
	for (const body of [
		{ overallStats: null },
		{ individualStats: {} },
		{ individualStats: "none" },
		[],
		"stats",
	]) {
		assert.equal(sleepRows(body), null, JSON.stringify(body));
	}
});

test("sleepRow sets every field from the night's values, its instants from Garmin's UTC milliseconds", () => {
	const [first, second] = nightRows().map((row) =>
		recordOf(sleepRow(row, WINDOW)),
	);
	assert.deepEqual(first, {
		id: "2026-09-15",
		date: "2026-09-15",
		start_at: "2026-09-14T12:40:00.000Z",
		end_at: "2026-09-14T20:40:00.000Z",
		total_sleep_duration_s: 27000,
		deep_sleep_duration_s: 5400,
		light_sleep_duration_s: 15300,
		rem_sleep_duration_s: 6300,
		awake_duration_s: 1800,
		sleep_score: 81,
		sleep_quality: "GOOD",
		respiratory_rate_rpm: 14,
		// Absent from the night's values: a watch without Pulse Ox.
		blood_oxygen_pct: null,
	});
	assert.equal(second?.blood_oxygen_pct, 95);
	assert.equal(second?.sleep_quality, "FAIR");
	assert.deepEqual(
		rowRecord("sleep", nth(nightRows(), 1), WINDOW),
		sleepRow(nth(nightRows(), 1), WINDOW),
	);
});

test("sleepRow never reads Garmin's local-as-UTC times", () => {
	const row = nth(nightRows(), 0);
	const values = row.values as Obj;
	values.localSleepStartTimeInMillis = 1;
	values.localSleepEndTimeInMillis = "never";
	assert.equal(
		recordOf(sleepRow(row, WINDOW)).start_at,
		"2026-09-14T12:40:00.000Z",
	);
});

test("sleepRow: an absent metric is null; the end may be absent too", () => {
	const row = nth(nightRows(), 1);
	row.values = merged(row.values as Obj, {
		sleepScore: undefined,
		sleepScoreQuality: undefined,
		gmtSleepEndTimeInMillis: undefined,
		remTime: null,
	});
	const record = recordOf(sleepRow(row, WINDOW));
	assert.equal(record.sleep_score, null);
	assert.equal(record.sleep_quality, null);
	assert.equal(record.end_at, null);
	assert.equal(record.rem_sleep_duration_s, null);
});

test("sleepRow: no start instant is unreadable with nothing to place it by", () => {
	for (const start of [
		undefined,
		null,
		"1789389600000",
		1.5,
		-1,
		0,
		Number.MAX_SAFE_INTEGER,
	]) {
		const row = nth(nightRows(), 0);
		(row.values as Obj).gmtSleepStartTimeInMillis = start;
		assert.deepEqual(
			sleepRow(row, WINDOW),
			{ kind: "unreadable" },
			String(start),
		);
	}
	assert.deepEqual(sleepRow({ calendarDate: "2026-09-15" }, WINDOW), {
		kind: "unreadable",
	});
	assert.deepEqual(
		sleepRow({ calendarDate: "2026-09-15", values: [] }, WINDOW),
		{ kind: "unreadable" },
	);
	for (const row of [null, "night", []]) {
		assert.deepEqual(sleepRow(row, WINDOW), { kind: "unreadable" });
	}
});

test("sleepRow: a night with a start but no usable date, or dated outside the window asked, is unreadable and keeps its start", () => {
	const start = "2026-09-14T12:40:00.000Z";
	for (const calendarDate of [undefined, null, "2026-02-30", "15/09/2026"]) {
		assert.deepEqual(
			sleepRow(merged(nth(nightRows(), 0), { calendarDate }), WINDOW),
			{ kind: "unreadable", startAt: start },
			String(calendarDate),
		);
	}
	for (const window of [
		{ from: "2026-09-16", to: "2026-09-21" },
		{ from: "2026-08-19", to: "2026-09-14" },
	]) {
		assert.deepEqual(sleepRow(nth(nightRows(), 0), window), {
			kind: "unreadable",
			startAt: start,
		});
	}
	// The window's edges are both inside it.
	assert.equal(
		kindOf(
			sleepRow(nth(nightRows(), 0), { from: "2026-09-15", to: "2026-09-15" }),
		),
		"record",
	);
});

test("sleepRow: a value of the wrong type is unreadable, keeping the start", () => {
	for (const change of [
		{ deepTime: "5400" },
		{ sleepScore: true },
		{ sleepScoreQuality: 3 },
		{ respiration: "14" },
		{ spO2: {} },
		{ gmtSleepEndTimeInMillis: "1789418400000" },
	]) {
		const row = nth(nightRows(), 0);
		row.values = merged(row.values as Obj, change);
		assert.deepEqual(
			sleepRow(row, WINDOW),
			{ kind: "unreadable", startAt: "2026-09-14T12:40:00.000Z" },
			JSON.stringify(change),
		);
	}
});

// ── hrv ────────────────────────────────────────────────────────────────────
test("hrvRows takes hrvSummaries, a 204's null as none, and refuses any other envelope", () => {
	assert.deepEqual(hrvRows(null), []);
	assert.equal(hrvRows(fixture("hrv-daily.json"))?.length, 3);
	assert.deepEqual(windowRows("hrv", null), []);
	for (const body of [
		{},
		{ hrvSummaries: null },
		{ hrvSummaries: {} },
		[],
		"hrv",
	]) {
		assert.equal(hrvRows(body), null, JSON.stringify(body));
	}
});

test("hrvRow reads last night's and the weekly average and the status, and never the account id or baseline", () => {
	const records = hrvFixtureRows().map((row) => recordOf(hrvRow(row, WINDOW)));
	assert.deepEqual(records, [
		// Onboarding: a reading, but no baseline or weekly average yet.
		{
			id: "2026-09-14",
			date: "2026-09-14",
			last_night_average_ms: 41,
			weekly_average_ms: null,
			status: "NONE",
		},
		{
			id: "2026-09-15",
			date: "2026-09-15",
			last_night_average_ms: 47,
			weekly_average_ms: 44,
			status: "BALANCED",
		},
		// No overnight reading; status and weekly average carry forward.
		{
			id: "2026-09-16",
			date: "2026-09-16",
			last_night_average_ms: null,
			weekly_average_ms: 45,
			status: "BALANCED",
		},
	]);
	assert.doesNotMatch(
		JSON.stringify(records),
		/41001|baseline|HRV_BALANCED|ONBOARDING/,
	);
});

test("hrvRow: a night without a reading, a weekly average or a status beyond NONE is empty, sent as nulls or as a null row", () => {
	const nulls = {
		calendarDate: "2026-09-17",
		weeklyAvg: null,
		lastNightAvg: null,
		lastNight5MinHigh: null,
		baseline: null,
		status: null,
		feedbackPhrase: null,
		createTimeStamp: null,
	};
	assert.equal(kindOf(hrvRow(nulls, WINDOW)), "empty");
	assert.equal(kindOf(hrvRow({ ...nulls, status: "NONE" }, WINDOW)), "empty");
	assert.equal(kindOf(hrvRow({ calendarDate: "2026-09-17" }, WINDOW)), "empty");
	// A row of nulls, date included, says nothing, and a null row says less.
	assert.equal(
		kindOf(hrvRow({ ...nulls, calendarDate: null }, WINDOW)),
		"empty",
	);
	assert.equal(kindOf(hrvRow(null, WINDOW)), "empty");
	assert.equal(
		kindOf(hrvRow({ ...nulls, status: "BALANCED" }, WINDOW)),
		"record",
	);
});

test("hrvRow: a reading with no usable date, or one outside the window, is unreadable", () => {
	for (const calendarDate of [undefined, null, "2026-09-31", 20_260_915]) {
		assert.deepEqual(
			hrvRow(merged(nth(hrvFixtureRows(), 1), { calendarDate }), WINDOW),
			{ kind: "unreadable" },
			String(calendarDate),
		);
	}
	assert.equal(
		kindOf(
			hrvRow(nth(hrvFixtureRows(), 1), {
				from: "2026-09-16",
				to: "2026-09-21",
			}),
		),
		"unreadable",
	);
	for (const row of ["night", 3, []]) {
		assert.deepEqual(hrvRow(row, WINDOW), { kind: "unreadable" });
	}
});

test("hrvRow: a value of the wrong type is unreadable; a fraction builds and the schema refuses it", () => {
	for (const change of [
		{ lastNightAvg: "47" },
		{ weeklyAvg: true },
		{ status: 1 },
	]) {
		assert.deepEqual(
			hrvRow(merged(nth(hrvFixtureRows(), 1), change), WINDOW),
			{ kind: "unreadable" },
			JSON.stringify(change),
		);
	}
	const fraction = recordOf(
		hrvRow(merged(nth(hrvFixtureRows(), 1), { lastNightAvg: 47.5 }), WINDOW),
	);
	assert.deepEqual(verdicts("hrv", fraction), NEITHER);
});

// ── activities ─────────────────────────────────────────────────────────────
test("activityRows takes a list, a 204's null as none, and refuses anything else", () => {
	assert.deepEqual(activityRows(null), []);
	assert.equal(activityRows(activities())?.length, 2);
	for (const body of [{}, { activities: [] }, "list"]) {
		assert.equal(activityRows(body), null, JSON.stringify(body));
	}
	assert.deepEqual(windowRows("activities", []), []);
});

test("activityRow sets every field by hand: the start in UTC, the local day, metres and seconds as sent", () => {
	const [ride, run] = activities().map((row) =>
		recordOf(activityRow(row, WINDOW)),
	);
	assert.deepEqual(ride, {
		id: "41000102",
		activity_type: "cycling",
		start_at: "2026-09-15T19:15:00.000Z",
		// Local start: the next calendar day.
		start_date: "2026-09-16",
		elapsed_time_s: 3720.5,
		moving_time_s: 3480.2,
		distance_m: 25012.4,
		calories_kcal: 610,
		average_heart_rate_bpm: 128,
		max_heart_rate_bpm: 161,
	});
	assert.deepEqual(run, {
		id: "41000101",
		activity_type: "running",
		start_at: "2026-09-14T06:30:00.000Z",
		start_date: "2026-09-14",
		elapsed_time_s: 2895,
		moving_time_s: 2860,
		distance_m: 8040,
		calories_kcal: 540,
		average_heart_rate_bpm: 148,
		max_heart_rate_bpm: 172,
	});
	assert.deepEqual(
		rowRecord("activities", nth(activities(), 0), WINDOW),
		activityRow(nth(activities(), 0), WINDOW),
	);
});

test("activityRow never reads a name, a place, coordinates, an owner field, a device or a UUID", () => {
	const shipped = JSON.stringify(
		activities().map((row) => activityRow(row, WINDOW)),
	);
	for (const value of [
		"Fixture",
		"fixture-owner",
		"12.3456",
		"23.4567",
		"41001",
		"41002",
		"00000000-",
	]) {
		assert.ok(!shipped.includes(value), value);
	}
});

test("activityRow: an absent metric or type is null; heart rate may come as a float", () => {
	const record = recordOf(
		activityRow(
			merged(nth(activities(), 0), {
				distance: undefined,
				calories: undefined,
				activityType: undefined,
				averageHR: 142.0,
			}),
			WINDOW,
		),
	);
	assert.equal(record.distance_m, null);
	assert.equal(record.calories_kcal, null);
	assert.equal(record.activity_type, null);
	assert.equal(record.average_heart_rate_bpm, 142);
	assert.equal(
		recordOf(
			activityRow(
				merged(nth(activities(), 0), { activityType: { typeId: 2 } }),
				WINDOW,
			),
		).activity_type,
		null,
	);
});

test("activityRow: no usable start is unreadable with nothing to place it by", () => {
	for (const startTimeGMT of [
		undefined,
		null,
		"2026-09-15T19:15:00",
		"2026-09-15 19:15:00Z",
		"2026-09-15 19:15",
		"2026-09-15 19:15:00.5",
		"2026-09-31 19:15:00",
		"2026-09-15 24:00:00",
		1_789_499_700_000,
	]) {
		assert.deepEqual(
			activityRow(merged(nth(activities(), 0), { startTimeGMT }), WINDOW),
			{ kind: "unreadable" },
			String(startTimeGMT),
		);
	}
	for (const row of [null, "activity", []]) {
		assert.deepEqual(activityRow(row, WINDOW), { kind: "unreadable" });
	}
});

test("activityRow: a bad id, no local start, or a local day outside the window is unreadable, keeping the start", () => {
	const start = "2026-09-15T19:15:00.000Z";
	for (const change of [
		{ activityId: undefined },
		{ activityId: "41000102" },
		{ activityId: 0 },
		{ activityId: -5 },
		{ activityId: 41000102.5 },
		{ startTimeLocal: undefined },
		{ startTimeLocal: "2026-09-16T07:15:00" },
	]) {
		assert.deepEqual(
			activityRow(merged(nth(activities(), 0), change), WINDOW),
			{ kind: "unreadable", startAt: start },
			JSON.stringify(change),
		);
	}
	assert.deepEqual(
		activityRow(nth(activities(), 0), { from: "2026-09-17", to: "2026-09-21" }),
		{
			kind: "unreadable",
			startAt: start,
		},
	);
	// The window holds the local day, not the UTC one.
	assert.equal(
		kindOf(
			activityRow(nth(activities(), 0), {
				from: "2026-09-16",
				to: "2026-09-16",
			}),
		),
		"record",
	);
	assert.equal(
		kindOf(
			activityRow(nth(activities(), 0), {
				from: "2026-09-15",
				to: "2026-09-15",
			}),
		),
		"unreadable",
	);
});

test("activityRow: a value of the wrong type is unreadable, keeping the start", () => {
	for (const change of [
		{ distance: "25012.4" },
		{ elapsedDuration: true },
		{ calories: [610] },
		{ maxHR: "161" },
		{ activityType: "cycling" },
		{ activityType: { typeKey: 2 } },
	]) {
		assert.deepEqual(
			activityRow(merged(nth(activities(), 0), change), WINDOW),
			{ kind: "unreadable", startAt: "2026-09-15T19:15:00.000Z" },
			JSON.stringify(change),
		);
	}
});

// ── Schemas and the manifest ───────────────────────────────────────────────
/** Every record the fixtures build. */
function fixtureRecords(): Array<[Stream, RecordData]> {
	return [
		[
			"daily_summaries",
			recordOf(dailySummary(SUMMARY_DAY, fixture("daily-summary.json"))),
		],
		["training_status", recordOf(trainingStatus(statusDay, statusBody()))],
		...nightRows().map((row): [Stream, RecordData] => [
			"sleep",
			recordOf(sleepRow(row, WINDOW)),
		]),
		...hrvFixtureRows().map((row): [Stream, RecordData] => [
			"hrv",
			recordOf(hrvRow(row, WINDOW)),
		]),
		...activities().map((row): [Stream, RecordData] => [
			"activities",
			recordOf(activityRow(row, WINDOW)),
		]),
	];
}

test("every record the fixtures build passes Zod cleanly and the manifest schema, with exactly the manifest's keys", () => {
	const records = fixtureRecords();
	assert.equal(records.length, 9);
	assert.deepEqual(
		new Set(records.map(([stream]) => stream)),
		new Set(STREAMS),
	);
	for (const [stream, record] of records) {
		assert.deepEqual(
			verdicts(stream, record),
			BOTH,
			`${stream} ${String(record.id)}`,
		);
		assert.deepEqual(
			Object.keys(record).toSorted(),
			Object.keys(manifestSchema(stream).properties ?? {}).toSorted(),
			stream,
		);
		assert.deepEqual(
			JSON.parse(JSON.stringify(record)),
			record,
			`${stream}: survives JSON`,
		);
	}
});

test("unit guards: a value out of range fails Zod and the manifest alike, and the range's edge passes both", () => {
	const base = new Map(
		fixtureRecords().map(([stream, record]) => [stream, record]),
	);
	const cases: Array<[Stream, string, unknown, boolean]> = [
		["daily_summaries", "steps", 0, true],
		["daily_summaries", "steps", -1, false],
		["daily_summaries", "resting_heart_rate_bpm", 1, true],
		["daily_summaries", "resting_heart_rate_bpm", 0, false],
		["daily_summaries", "min_heart_rate_bpm", 300, true],
		["daily_summaries", "min_heart_rate_bpm", 301, false],
		["daily_summaries", "average_stress_level", 100, true],
		["daily_summaries", "average_stress_level", 101, false],
		["daily_summaries", "body_battery_low", 0, true],
		["daily_summaries", "body_battery_high", 100.5, false],
		["sleep", "total_sleep_duration_s", 86_400, true],
		["sleep", "deep_sleep_duration_s", 86_401, false],
		["sleep", "awake_duration_s", -1, false],
		["sleep", "rem_sleep_duration_s", 6300.5, false],
		["sleep", "sleep_score", 100, true],
		["sleep", "sleep_score", 101, false],
		["sleep", "respiratory_rate_rpm", 0, false],
		["sleep", "respiratory_rate_rpm", 99.9, true],
		["sleep", "respiratory_rate_rpm", 100, false],
		["sleep", "blood_oxygen_pct", 50, true],
		["sleep", "blood_oxygen_pct", 49.9, false],
		["sleep", "blood_oxygen_pct", 100.1, false],
		["hrv", "last_night_average_ms", 1, true],
		["hrv", "last_night_average_ms", 0, false],
		["hrv", "weekly_average_ms", 999, true],
		["hrv", "weekly_average_ms", 1000, false],
		["training_status", "weekly_training_load", 0, true],
		["training_status", "weekly_training_load", -0.5, false],
		["training_status", "training_status_code", -1, true],
		["training_status", "training_status_code", 1.5, false],
		["activities", "distance_m", 0, true],
		["activities", "distance_m", -0.1, false],
		["activities", "elapsed_time_s", -1, false],
		["activities", "moving_time_s", 0.5, true],
		["activities", "calories_kcal", -1, false],
		["activities", "average_heart_rate_bpm", 1, true],
		["activities", "max_heart_rate_bpm", 300.5, false],
		["activities", "average_heart_rate_bpm", 0, false],
	];
	for (const [stream, key, value, ok] of cases) {
		const record = { ...base.get(stream), [key]: value } as RecordData;
		assert.deepEqual(
			verdicts(stream, record),
			ok ? BOTH : NEITHER,
			`${stream}.${key} = ${String(value)}`,
		);
	}
});

test("Zod and the manifest agree on each field's type and nullability", () => {
	const base = new Map(
		fixtureRecords().map(([stream, record]) => [stream, record]),
	);
	const probes: unknown[] = [null, 1, 1.5, true, "x", {}, []];
	for (const stream of STREAMS) {
		const record = base.get(stream);
		assert.ok(record);
		for (const key of Object.keys(record)) {
			for (const probe of probes) {
				const edited = { ...record, [key]: probe } as RecordData;
				const { zod, manifest: json } = verdicts(stream, edited);
				// Zod holds strings to their form (a day, an instant, an id), which the manifest
				// states only in prose; for any other probe the two must agree.
				if (typeof probe === "string" && zod !== json) {
					assert.equal(
						zod,
						false,
						`${stream}.${key}: Zod looser than the manifest`,
					);
					continue;
				}
				assert.equal(zod, json, `${stream}.${key} = ${JSON.stringify(probe)}`);
			}
		}
	}
});

test("Zod also holds what the manifest leaves to prose: every key present, days and instants in form, ids canonical", () => {
	const base = new Map(
		fixtureRecords().map(([stream, record]) => [stream, record]),
	);
	const zodOnly = (stream: Stream, change: Obj): boolean => {
		const record = { ...base.get(stream), ...change } as RecordData;
		const check = validateRecord(stream, record);
		return check.ok;
	};
	assert.equal(
		zodOnly("sleep", { start_at: "2026-09-14T12:40:00Z" }),
		false,
		"milliseconds",
	);
	assert.equal(
		zodOnly("sleep", { start_at: "2026-09-15T00:40:00.000+12:00" }),
		false,
		"UTC",
	);
	assert.equal(
		zodOnly("activities", { id: "041000102" }),
		false,
		"canonical id",
	);
	assert.equal(zodOnly("hrv", { id: "2026-9-15" }), false, "a day");
	assert.equal(
		zodOnly("training_status", { training_status: "" }),
		false,
		"no empty vocabulary",
	);
	for (const stream of STREAMS) {
		const record = { ...base.get(stream) } as RecordData;
		for (const key of Object.keys(record)) {
			const { [key]: _dropped, ...rest } = record;
			assert.equal(
				validateRecord(stream, rest as RecordData).ok,
				false,
				`${stream} without ${key}`,
			);
		}
		assert.equal(
			validateRecord(stream, { ...record, extra: 1 }).ok,
			false,
			`${stream}: a stray key`,
		);
	}
});

test("the Zod schemas and the manifest name the same streams and keys, every key required and none extra", () => {
	assert.deepEqual(Object.keys(SCHEMAS).toSorted(), [...STREAMS].toSorted());
	for (const stream of STREAMS) {
		const shape = (SCHEMAS[stream] as z.ZodObject).shape;
		const schema = manifestSchema(stream);
		const keys = Object.keys(schema.properties ?? {}).toSorted();
		assert.deepEqual(Object.keys(shape).toSorted(), keys, stream);
		assert.deepEqual(
			[...(schema.required ?? [])].toSorted(),
			keys,
			`${stream}: required`,
		);
		assert.equal(
			(schema as Obj).additionalProperties,
			false,
			`${stream}: closed`,
		);
	}
});

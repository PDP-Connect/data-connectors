// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	activityPage,
	activityRecord,
	corosDay,
	dailyRecord,
	dayList,
	plannedRecords,
	planSportName,
	profileRecord,
	queryDay,
	readEnvelope,
	regionKey,
	schedule,
	sportName,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	) as unknown;
const at = (value: unknown, index: number): unknown =>
	(value as unknown[])[index];
const dataOf = (value: unknown): unknown => (value as { data: unknown }).data;

test("readEnvelope: 0000 is data, any other code is that code, no envelope is unreadable", () => {
	assert.deepEqual(readEnvelope({ result: "0000", data: { a: 1 } }), {
		kind: "ok",
		data: { a: 1 },
	});
	assert.deepEqual(readEnvelope({ result: "1019", message: "E1019" }), {
		kind: "error",
		result: "1019",
	});
	assert.deepEqual(readEnvelope({ data: {} }), { kind: "unreadable" });
	assert.deepEqual(readEnvelope("<html>"), { kind: "unreadable" });
	assert.deepEqual(readEnvelope(undefined), { kind: "unreadable" });
});

test("corosDay reads YYYYMMDD numbers and strings and refuses impossible days", () => {
	assert.equal(corosDay(20261108), "2026-11-08");
	assert.equal(corosDay("20260229"), null);
	assert.equal(corosDay("20240229"), "2024-02-29");
	assert.equal(corosDay(2026118), null);
	assert.equal(corosDay(null), null);
	assert.equal(queryDay("2026-11-08"), "20261108");
});

test("sport names follow Training Hub's tables; workouts read categories first", () => {
	assert.equal(sportName(100), "Run");
	assert.equal(sportName(402), "Strength");
	assert.equal(sportName(9850), "Custom_Sport");
	assert.equal(sportName(12345), null);
	assert.equal(planSportName(1), "Run");
	assert.equal(planSportName(4), "Strength");
	assert.equal(planSportName(100), "Run");
	assert.equal(planSportName(null), null);
	assert.equal(regionKey(3), "eu");
	assert.equal(regionKey(101), null);
});

test("profileRecord: account and dashboard into one validated profile, no email", () => {
	const record = profileRecord(
		dataOf(fixture("account.json")),
		dataOf(fixture("dashboard.json")),
		"us",
	);
	assert.deepEqual(record, {
		id: "472000000000000101",
		nickname: "Canary Runner",
		region: "us",
		unit_system: "metric",
		activity_count: 3,
		resting_heart_rate_bpm: 51,
		threshold_heart_rate_bpm: 168,
		max_heart_rate_bpm: 189,
	});
	assert.equal(validateRecord("profile", record ?? {}).ok, true);
	assert.equal(profileRecord({ nickname: "x" }, {}, "us"), null);
	// A dashboard without thresholds leaves them null rather than zero.
	const bare = profileRecord(
		{ userId: 7, unit: 1 },
		{ summaryInfo: { rhr: 0 } },
		"eu",
	);
	assert.equal(bare?.unit_system, "imperial");
	assert.equal(bare?.resting_heart_rate_bpm, null);
});

test("activityRecord: units, local day from the quarter-hour zone, zero readings as null", () => {
	const rows = fixture("activities.json");
	const ride = activityRecord(at(rows, 0));
	// 01:10Z on the 9th at UTC-8 is the evening of the 8th.
	assert.equal(ride?.start_at, "2026-11-09T01:10:00.000Z");
	assert.equal(ride?.start_date, "2026-11-08");
	assert.equal(ride?.utc_offset_minutes, -480);
	assert.equal(ride?.end_at, "2026-11-09T02:20:00.000Z");
	assert.equal(ride?.sport, "Bike");
	assert.equal(ride?.calories_kcal, 712);
	assert.equal(ride?.distance_m, 28450.3);
	assert.equal(ride?.steps, null);
	const strength = activityRecord(at(rows, 2));
	assert.equal(strength?.average_heart_rate_bpm, null);
	assert.equal(strength?.average_power_w, null);
	// The strength session reports distance 0: no distance, so null.
	assert.equal(strength?.distance_m, null);
	assert.equal(strength?.start_date, "2026-10-20");
	for (const row of rows as unknown[]) {
		const record = activityRecord(row);
		assert.ok(record);
		const check = validateRecord("activities", record);
		assert.equal(check.ok, true, JSON.stringify(check));
		assert.equal("name" in record, false, "activity titles are never read");
	}
});

test("activityRecord: without a zone the row's own date is the local day; without an id or start, nothing", () => {
	const base = at(fixture("activities.json"), 1) as Record<string, unknown>;
	assert.equal(
		activityRecord({ ...base, startTimezone: undefined })?.start_date,
		"2026-11-08",
	);
	assert.equal(
		activityRecord({ ...base, startTimezone: undefined, date: undefined })
			?.start_date,
		null,
	);
	assert.equal(activityRecord({ ...base, labelId: undefined }), null);
	assert.equal(activityRecord({ ...base, startTime: 0 }), null);
	assert.equal(
		activityRecord({ ...base, labelId: 476000000000 })?.id,
		"476000000000",
	);
});

test("activityPage and dayList and schedule refuse a shape that is not theirs", () => {
	assert.deepEqual(activityPage({ count: 0, totalPage: 0 }), {
		rows: [],
		totalPage: null,
	});
	// A page count COROS did not give, or gave as nonsense, is unknown rather than zero.
	assert.equal(activityPage({ dataList: [] })?.totalPage, null);
	assert.equal(activityPage({ dataList: [], totalPage: -2 })?.totalPage, null);
	assert.equal(activityPage({ dataList: [], totalPage: 3 })?.totalPage, 3);
	assert.equal(activityPage({ dataList: "nope" }), null);
	assert.deepEqual(dayList({}), []);
	assert.equal(dayList({ dayList: {} }), null);
	assert.equal(schedule({ entities: 3 }), null);
});

test("dailyRecord: HRV's normal range and zero readings", () => {
	const days = fixture("day-detail.json");
	const first = dailyRecord(at(days, 0));
	assert.equal(first?.date, "2026-11-07");
	assert.equal(first?.hrv_ms, 61);
	assert.equal(first?.hrv_normal_low_ms, 55);
	assert.equal(first?.hrv_normal_high_ms, 72);
	assert.equal(first?.fatigue, -3.5);
	const last = dailyRecord(at(days, 2));
	assert.equal(last?.resting_heart_rate_bpm, null);
	assert.equal(last?.hrv_ms, null);
	assert.equal(last?.hrv_normal_low_ms, null);
	assert.equal(last?.training_load, 0);
	for (const row of days as unknown[]) {
		const record = dailyRecord(row);
		assert.ok(record);
		assert.equal(validateRecord("daily_metrics", record).ok, true);
	}
	assert.equal(dailyRecord({ rhr: 50 }), null);
});

test("plannedRecords joins entries to workouts by place in plan and plan id", () => {
	const value = schedule(fixture("schedule.json"));
	assert.ok(value);
	const built = plannedRecords(value);
	assert.equal(built.length, 2);
	const [done, ahead] = built.map((b) => (b.ok ? b.record : null));
	assert.deepEqual(done, {
		id: "2026-11-08::3",
		date: "2026-11-08",
		name: "Easy 8k",
		sport_type: 1,
		sport: "Run",
		planned_training_load: 70,
		completion_rate: 0.96,
		completed_activity_id: "476000000000000202",
	});
	assert.equal(ahead?.completed_activity_id, null);
	// COROS writes "-1.00" for a workout it has not rated yet (live, 2026-11-12).
	assert.equal(ahead?.completion_rate, null);
	for (const record of [done, ahead]) {
		assert.ok(record);
		assert.equal(validateRecord("planned_workouts", record).ok, true);
	}
	const orphan = plannedRecords({
		entities: [{ happenDay: 20261101, idInPlan: "9", planId: "77" }, "junk"],
		programs: [],
	});
	assert.equal(orphan[0]?.ok && orphan[0].record.name, null);
	assert.equal(orphan[0]?.ok && orphan[0].record.id, "2026-11-01:77:9");
	assert.equal(orphan[1]?.ok, false);
});

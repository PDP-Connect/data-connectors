// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pure builders over the synthetic fixtures and the edge cases around them. Every record built
 * is also run through the stream's schema, as the collector does before it emits.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fixtureData } from "./fake-polar.ts";
import {
	type Built,
	dailyActivityRecord,
	localTime,
	nightlyRechargeRecord,
	parseTrainingRow,
	parseTrainingSummary,
	profileRecord,
	sleepRecord,
	trainingSessionRecord,
	userId,
	utcOffset,
} from "./parsers.ts";
import { type Stream, validateRecord } from "./schemas.ts";

function valid(stream: Stream, built: Built): Record<string, unknown> {
	assert.equal(built.kind, "record");
	if (built.kind !== "record") throw new Error("unreachable");
	const check = validateRecord(stream, built.record);
	assert.ok(check.ok, JSON.stringify(check));
	return built.record;
}

test("localTime normalises Polar's zoneless times and refuses anything else", () => {
	assert.equal(localTime("2026-11-03 07:12:09.000"), "2026-11-03T07:12:09");
	assert.equal(localTime("2026-11-03T07:12:09"), "2026-11-03T07:12:09");
	assert.equal(localTime("2026-11-03T07:12"), "2026-11-03T07:12:00");
	assert.equal(localTime("2026-11-03T07:12:09Z"), null);
	assert.equal(localTime("2026-11-03T07:12:09+02:00"), null);
	assert.equal(localTime("2026-02-30 07:12:09.000"), null);
	assert.equal(localTime("2026-11-03 24:00:00"), null);
	assert.equal(localTime(1793776329000), null);
});

test("profile: identity, body and zone settings, never the e-mail", () => {
	const { user } = fixtureData();
	const record = valid("profile", profileRecord(user));
	assert.deepEqual(record, {
		id: "11111111",
		first_name: "Alex",
		last_name: "Example",
		country: "FI",
		birthday: "1990-04-07",
		sex: "FEMALE",
		training_background: "REGULAR",
		weight_kg: 62.5,
		height_cm: 168,
		max_heart_rate_bpm: 188,
		resting_heart_rate_bpm: 52,
		aerobic_threshold_bpm: 141,
		anaerobic_threshold_bpm: 169,
		vo2max: 47,
		functional_threshold_power_w: null,
		sleep_goal_hours: 8,
		utc_offset: "+02:00",
		measurement_unit: "METRIC",
		language: "en",
	});
	assert.equal(JSON.stringify(record).includes("athlete@example.com"), false);
	assert.equal(userId(user), 11111111);
	assert.equal(utcOffset(user), "+02:00");
});

test("profile: a country not in ISO alpha-2 form is null, not a lost profile", () => {
	for (const [country, expected] of [
		["Finland", null],
		["fi", "FI"],
		["", null],
	] as const) {
		const { user } = fixtureData() as {
			user: { user: Record<string, unknown> };
		};
		user.user.country = country;
		assert.equal(valid("profile", profileRecord(user)).country, expected);
	}
});

test("daily activity: fractional calories are rounded, not a lost day", () => {
	const { activity } = fixtureData();
	const day = structuredClone(activity["2026-11-03"]) as {
		dataPanelData: Record<string, unknown>;
	};
	day.dataPanelData.kiloCalories = 1987.6;
	assert.equal(
		valid("daily_activity", dailyActivityRecord("2026-11-03", day))
			.calories_kcal,
		1988,
	);
});

test("profile: a missing id is unreadable; a zone name instead of an offset is null", () => {
	assert.deepEqual(profileRecord({ user: { firstName: "A" } }), {
		kind: "unreadable",
	});
	const record = valid(
		"profile",
		profileRecord({
			user: { id: 5 },
			localizationInfo: { timeZone: "Europe/Helsinki" },
			physicalInfo: { birthday: [1990, 2, 30] },
		}),
	);
	assert.equal(record.utc_offset, null);
	assert.equal(record.birthday, null);
});

test("training session: list fields plus the analysis summary's", () => {
	const data = fixtureData();
	const row = parseTrainingRow(data.training[0]);
	assert.ok(row);
	const summary = parseTrainingSummary(data.summaries["8349588454"]);
	const record = valid(
		"training_sessions",
		trainingSessionRecord(row, summary),
	);
	assert.deepEqual(record, {
		id: "8349588454",
		sport_id: 1,
		sport_name: "Running",
		name: "Morning run",
		start_date: "2026-11-03",
		start_time_local: "2026-11-03T07:12:09",
		end_time_local: "2026-11-03T07:57:44",
		duration_s: 2735,
		distance_m: 7012.4,
		calories_kcal: 498,
		average_heart_rate_bpm: 151,
		max_heart_rate_bpm: 176,
		training_load: 64.2,
		device_name: "Polar Pacer Pro",
		note: null,
		is_test: false,
		has_training_target: false,
	});
});

test("training session: a manual entry's zero heart rate and empty device read as null", () => {
	const data = fixtureData();
	const row = parseTrainingRow(data.training[1]);
	assert.ok(row);
	const record = valid(
		"training_sessions",
		trainingSessionRecord(
			row,
			parseTrainingSummary(data.summaries["8351200017"]),
		),
	);
	assert.equal(record.average_heart_rate_bpm, null);
	assert.equal(record.max_heart_rate_bpm, null);
	assert.equal(record.device_name, null);
	assert.equal(record.name, null);
	assert.equal(record.distance_m, null);
	assert.equal(record.note, "Easy mobility session");
});

test("training session: a manual entry's distance comes from its exercises", () => {
	const data = fixtureData();
	const row = parseTrainingRow(data.training[1]);
	assert.ok(row);
	const summary = structuredClone(data.summaries["8351200017"]) as {
		exercises: Record<string, { distance: number | null }>;
	};
	for (const exercise of Object.values(summary.exercises)) {
		exercise.distance = 7500;
	}
	const record = valid(
		"training_sessions",
		trainingSessionRecord(row, parseTrainingSummary(summary)),
	);
	assert.equal(record.distance_m, 7500);
	assert.equal(
		parseTrainingSummary({ ...summary, exercises: { 1: { distance: "7.5" } } }),
		null,
	);
});

test("training session: a summary about another session is not used", () => {
	const data = fixtureData();
	const row = parseTrainingRow(data.training[1]);
	assert.ok(row);
	const other = parseTrainingSummary(data.summaries["8349588454"]);
	const record = valid("training_sessions", trainingSessionRecord(row, other));
	assert.equal(record.device_name, null);
	assert.equal(record.end_time_local, null);
});

test("training session: a row of the wrong shape does not parse", () => {
	assert.equal(parseTrainingRow({ id: "8349588454" }), null);
	assert.equal(
		parseTrainingRow({ id: 1, duration: "PT30M", sportId: 1, startDate: "x" }),
		null,
	);
});

test("training session: a duration over two weeks fails the unit guard", () => {
	const data = fixtureData();
	const raw = { ...data.training[0], duration: 2735000 * 1000 };
	const row = parseTrainingRow(raw);
	assert.ok(row);
	const built = trainingSessionRecord(row, null);
	assert.ok(built.kind === "record");
	assert.equal(validateRecord("training_sessions", built.record).ok, false);
});

test("daily activity: a recorded day, a day nothing recorded and a day past the last sync", () => {
	const { activity } = fixtureData();
	const record = valid(
		"daily_activity",
		dailyActivityRecord("2026-11-03", activity["2026-11-03"]),
	);
	assert.deepEqual(record, {
		id: "2026-11-03",
		date: "2026-11-03",
		steps: 12408,
		active_time_min: 214,
		distance_from_steps_m: 9312.7,
		calories_kcal: 2486,
		daily_goal_pct: 132.5,
		sleep_duration_min: 452,
		inactivity_alert_count: 1,
		sedentary_min: 561,
		light_activity_min: 162,
		moderate_activity_min: 38,
		vigorous_activity_min: 14,
		day_min_heart_rate_bpm: 54,
		day_max_heart_rate_bpm: 176,
		night_min_heart_rate_bpm: 47,
		last_sync_at: "2026-11-03T07:16:00.000Z",
	});
	const noHr = valid(
		"daily_activity",
		dailyActivityRecord("2026-11-04", activity["2026-11-04"]),
	);
	assert.equal(noHr.day_min_heart_rate_bpm, null);
	assert.deepEqual(dailyActivityRecord("2026-11-05", activity["2026-11-05"]), {
		kind: "empty",
	});
	assert.deepEqual(dailyActivityRecord("2026-11-06", activity["2026-11-06"]), {
		kind: "empty",
	});
	assert.deepEqual(dailyActivityRecord("2026-11-06", { dataPanelData: 5 }), {
		kind: "unreadable",
	});
});

test("sleep: a scored night and an unscored one, dated by the wake-up day", () => {
	const { sleep } = fixtureData();
	const scored = valid("sleep", sleepRecord(sleep[0]));
	assert.deepEqual(scored, {
		id: "2026-11-03",
		date: "2026-11-03",
		sleep_start_local: "2026-11-02T23:14:00",
		sleep_end_local: "2026-11-03T06:52:30",
		fell_asleep_offset_s: 540,
		woke_up_offset_s: -120,
		time_in_bed_s: 27_510,
		sleep_score: 78.4213,
		continuity_index: 3.9,
		continuity_class: 4,
		sleep_cycles: 5,
		sleep_rating: "SLEPT_WELL",
	});
	const unscored = valid("sleep", sleepRecord(sleep[1]));
	assert.equal(unscored.sleep_score, null);
	assert.equal(unscored.sleep_rating, null);
});

test("sleep: a time with a zone is not the wall clock promised, so the night is unreadable", () => {
	const { sleep } = fixtureData();
	assert.deepEqual(
		sleepRecord({ ...sleep[0], sleepStartTime: "2026-11-02T21:14:00Z" }),
		{ kind: "unreadable" },
	);
	assert.deepEqual(sleepRecord({ ...sleep[0], sleepScore: "78" }), {
		kind: "unreadable",
	});
});

test("Nightly Recharge: an ANS rating outside 1 to 5 drops it and the ANS charge, as the web app does", () => {
	const { nightly } = fixtureData();
	const night = valid("nightly_recharge", nightlyRechargeRecord(nightly[0]));
	assert.deepEqual(night, {
		id: "2026-11-03",
		date: "2026-11-03",
		nightly_recharge_status: 4,
		ans_charge: 2.7,
		ans_charge_status: 3,
		beat_to_beat_interval_ms: 1034.6,
		beat_to_beat_interval_28d_avg_ms: 1012.1,
		hrv_rmssd_ms: 48.2,
		hrv_rmssd_28d_avg_ms: 44.9,
		breathing_interval_ms: 3820.5,
		breathing_interval_28d_avg_ms: 3755,
	});
	const unrated = valid("nightly_recharge", nightlyRechargeRecord(nightly[1]));
	assert.equal(unrated.ans_charge, null);
	assert.equal(unrated.ans_charge_status, null);
	assert.equal(unrated.nightly_recharge_status, 2);
});

test("Nightly Recharge: a night with no value is empty, a status out of range is none", () => {
	assert.deepEqual(nightlyRechargeRecord({ date: "2026-11-05" }), {
		kind: "empty",
	});
	const record = valid(
		"nightly_recharge",
		nightlyRechargeRecord({
			date: "2026-11-05",
			recoveryIndicator: 9,
			rmssd: 40,
		}),
	);
	assert.equal(record.nightly_recharge_status, null);
	assert.deepEqual(nightlyRechargeRecord({ date: "05.11.2026", rmssd: 40 }), {
		kind: "unreadable",
	});
});

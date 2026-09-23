// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema tests for the Oura connector. Parsing is inline in index.ts (no
 * parsers.ts), so these assert the schema against literal records shaped
 * exactly as the `sleepRecord` / `readinessRecord` / `activityRecord` builders
 * emit them — the authoritative emitted shape.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	activitySchema,
	readinessSchema,
	sleepSchema,
	validateRecord,
} from "./schemas.ts";

// A sleep record exactly as sleepRecord emits it. Float HRV/efficiency are the
// real Oura shape — the schema must NOT require integers here.
const SLEEP_RECORD = {
	id: "8f9d6e1a-3b2c-4d5e-9f8a-1b2c3d4e5f60",
	day: "2024-05-20",
	bedtime_start: "2024-05-20T23:14:05-07:00",
	bedtime_end: "2024-05-21T07:02:11-07:00",
	total_sleep_duration: 26_400,
	rem_sleep_duration: 5400,
	deep_sleep_duration: 4800,
	light_sleep_duration: 16_200,
	efficiency: 91.5,
	latency: 720,
	average_heart_rate: 54.3,
	lowest_heart_rate: 48,
	average_hrv: 62.7,
	temperature_delta: -0.12,
	sleep_score: 78,
	average_breath: 14.2,
	restless_periods: 12,
	time_in_bed: 27_600,
	type: "long_sleep",
	contributors: {
		deep_sleep: 80,
		efficiency: 90,
		latency: 70,
		rem_sleep: 60,
		restfulness: 75,
		timing: 85,
		total_sleep: 88,
	},
};

const READINESS_RECORD = {
	id: "11112222-3333-4444-5555-666677778888",
	day: "2024-05-20",
	score: 82,
	temperature_deviation: 0.05,
	temperature_trend_deviation: -0.1,
	contributors: {
		activity_balance: 90,
		hrv_balance: 75,
		resting_heart_rate: null,
	},
};

const ACTIVITY_RECORD = {
	id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
	day: "2024-05-20",
	score: 88,
	active_calories: 540,
	total_calories: 2710,
	steps: 11_204,
	target_calories: 500,
	equivalent_walking_distance: 8123.4,
	high_activity_time: 900,
	medium_activity_time: 2700,
	low_activity_time: 5400,
	sedentary_time: 32_400,
	resting_time: 21_600,
	inactivity_alerts: 2,
	contributors: {
		meet_daily_targets: 70,
		move_every_hour: 90,
		recovery_time: 80,
		stay_active: 75,
		training_frequency: 60,
		training_volume: 65,
	},
};

test("sleep schema accepts a representative emitted record (float HRV/efficiency)", () => {
	const result = sleepSchema.safeParse(SLEEP_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("sleep schema accepts a record with all optional metrics null", () => {
	const result = sleepSchema.safeParse({
		...SLEEP_RECORD,
		bedtime_start: null,
		bedtime_end: null,
		total_sleep_duration: null,
		rem_sleep_duration: null,
		deep_sleep_duration: null,
		light_sleep_duration: null,
		efficiency: null,
		latency: null,
		average_heart_rate: null,
		lowest_heart_rate: null,
		average_hrv: null,
		temperature_delta: null,
		sleep_score: null,
		average_breath: null,
		restless_periods: null,
		time_in_bed: null,
		type: null,
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("sleep schema accepts an empty contributors map (no matching daily_sleep document)", () => {
	const result = sleepSchema.safeParse({ ...SLEEP_RECORD, contributors: {} });
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("sleep schema rejects a non-numeric contributor value (API map drift)", () => {
	assert.equal(
		sleepSchema.safeParse({
			...SLEEP_RECORD,
			contributors: { deep_sleep: "high" },
		}).success,
		false,
	);
});

test("readiness schema accepts a representative emitted record", () => {
	const result = readinessSchema.safeParse(READINESS_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("readiness schema accepts an empty contributors map", () => {
	const result = readinessSchema.safeParse({
		...READINESS_RECORD,
		contributors: {},
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activity schema accepts a representative emitted record", () => {
	const result = activitySchema.safeParse(ACTIVITY_RECORD);
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activity schema accepts a record with all optional metrics null and an empty contributors map", () => {
	const result = activitySchema.safeParse({
		...ACTIVITY_RECORD,
		high_activity_time: null,
		medium_activity_time: null,
		low_activity_time: null,
		sedentary_time: null,
		resting_time: null,
		inactivity_alerts: null,
		contributors: {},
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("activity schema rejects a non-numeric contributor value (API map drift)", () => {
	assert.equal(
		activitySchema.safeParse({
			...ACTIVITY_RECORD,
			contributors: { move_every_hour: "high" },
		}).success,
		false,
	);
});

test("sleep schema rejects a non-UUID id (wrong document captured)", () => {
	assert.equal(
		sleepSchema.safeParse({ ...SLEEP_RECORD, id: "sleep-1" }).success,
		false,
	);
});

test("activity schema rejects a malformed day (datetime where a date is expected)", () => {
	assert.equal(
		activitySchema.safeParse({
			...ACTIVITY_RECORD,
			day: "2024-05-20T00:00:00Z",
		}).success,
		false,
	);
});

test("readiness schema rejects a non-numeric contributor value (API map drift)", () => {
	assert.equal(
		readinessSchema.safeParse({
			...READINESS_RECORD,
			contributors: { activity_balance: "high" },
		}).success,
		false,
	);
});

test("validateRecord routes by stream and passes unknown streams through", () => {
	assert.equal(validateRecord("sleep", SLEEP_RECORD).ok, true);
	assert.equal(validateRecord("readiness", READINESS_RECORD).ok, true);
	assert.equal(validateRecord("activity", ACTIVITY_RECORD).ok, true);
	assert.equal(validateRecord("heart_rate", { id: "x" }).ok, true);
});

// Non-regression: every pre-existing field on the two touched streams
// (sleep, activity) keeps its exact prior name, type, and nullability — the
// additive fields above must not have displaced any of them.
test("sleep schema: pre-existing fields are unchanged by the additive fields", () => {
	const preExisting = {
		id: "8f9d6e1a-3b2c-4d5e-9f8a-1b2c3d4e5f60",
		day: "2024-05-20",
		bedtime_start: "2024-05-20T23:14:05-07:00",
		bedtime_end: "2024-05-21T07:02:11-07:00",
		total_sleep_duration: 26_400,
		rem_sleep_duration: 5400,
		deep_sleep_duration: 4800,
		light_sleep_duration: 16_200,
		efficiency: 91.5,
		latency: 720,
		average_heart_rate: 54.3,
		lowest_heart_rate: 48,
		average_hrv: 62.7,
		temperature_delta: -0.12,
		sleep_score: 78,
	};
	// The new fields (average_breath, restless_periods, time_in_bed, type,
	// contributors) are required keys on the schema (see collectSleep, which
	// always supplies contributors: {} at minimum), so this checks the
	// pre-existing subset still parses once those are added back, not that it
	// validates alone.
	const result = sleepSchema.safeParse({
		...preExisting,
		average_breath: null,
		restless_periods: null,
		time_in_bed: null,
		type: null,
		contributors: {},
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal(
		sleepSchema.safeParse({
			...preExisting,
			average_breath: null,
			restless_periods: null,
			time_in_bed: null,
			type: null,
			contributors: {},
			id: "sleep-1",
		}).success,
		false,
		"id keeps its prior Oura-UUID constraint",
	);
});

test("activity schema: pre-existing fields are unchanged by the additive fields", () => {
	const preExisting = {
		id: "aaaabbbb-cccc-dddd-eeee-ffff00001111",
		day: "2024-05-20",
		score: 88,
		active_calories: 540,
		total_calories: 2710,
		steps: 11_204,
		target_calories: 500,
		equivalent_walking_distance: 8123.4,
	};
	const result = activitySchema.safeParse({
		...preExisting,
		high_activity_time: null,
		medium_activity_time: null,
		low_activity_time: null,
		sedentary_time: null,
		resting_time: null,
		inactivity_alerts: null,
		contributors: {},
	});
	assert.ok(result.success, JSON.stringify(result.error?.issues));
	assert.equal(
		activitySchema.safeParse({
			...preExisting,
			high_activity_time: null,
			medium_activity_time: null,
			low_activity_time: null,
			sedentary_time: null,
			resting_time: null,
			inactivity_alerts: null,
			contributors: {},
			day: "2024-05-20T00:00:00Z",
		}).success,
		false,
		"day keeps its prior YYYY-MM-DD constraint",
	);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	buildActivityRecord,
	normalizeStartTime,
	parseTrainingActivitiesPage,
} from "./parsers.ts";

test("start times normalise to a UTC instant, and a zoneless one is refused", () => {
	assert.equal(
		normalizeStartTime("2026-09-20T06:30:00Z"),
		"2026-09-20T06:30:00Z",
	);
	assert.equal(
		normalizeStartTime("2026-09-20T06:30:00+0000"),
		"2026-09-20T06:30:00Z",
	);
	assert.equal(
		normalizeStartTime("2026-09-20T01:30:00-05:00"),
		"2026-09-20T06:30:00Z",
	);
	assert.equal(
		normalizeStartTime("2026-09-20T06:30:00.123Z"),
		"2026-09-20T06:30:00Z",
	);
	assert.equal(normalizeStartTime("2026-09-20T06:30:00"), null);
	assert.equal(normalizeStartTime("Mon, 9/20/2026"), null);
	assert.equal(normalizeStartTime(1789885800), null);
});

test("the envelope must carry models, total and perPage", () => {
	assert.equal(parseTrainingActivitiesPage("<html>").ok, false);
	assert.equal(parseTrainingActivitiesPage("[]").ok, false);
	assert.equal(parseTrainingActivitiesPage('{"models":[]}').ok, false);
	assert.equal(
		parseTrainingActivitiesPage('{"models":[],"perPage":0,"total":0}').ok,
		false,
	);
	assert.deepEqual(
		parseTrainingActivitiesPage(
			'{"models":[],"page":1,"perPage":20,"total":0}',
		),
		{ ok: true, models: [], perPage: 20, total: 0 },
	);
});

test("activity type prefers the legacy type, then folds sport_type to its coarse type", () => {
	const at = (m: Record<string, unknown>) =>
		buildActivityRecord({ id: 1, start_time: "2026-01-01T00:00:00Z", ...m })
			?.activity_type;
	assert.equal(at({ type: "Ride", sport_type: "GravelRide" }), "Ride");
	assert.equal(at({ type: null, sport_type: "GravelRide" }), "Ride");
	assert.equal(at({ type: null, sport_type: "TrailRun" }), "Run");
	assert.equal(at({ sport_type: "MountainBikeRide" }), "Ride");
	// A legacy type wins even when it is itself a fine-grained sport name.
	for (const type of ["GravelRide", "MountainBikeRide", "TrailRun", "EMountainBikeRide"]) {
		assert.equal(at({ type, sport_type: "Swim" }), type);
	}
	assert.equal(
		at({ type: null, sport_type: "EMountainBikeRide" }),
		"EBikeRide",
	);
	assert.equal(at({ type: null, sport_type: "Pickleball" }), "Pickleball");
	assert.equal(at({}), null);
});

test("start_date_local is the local calendar day when the UTC day differs", () => {
	// 23:45 UTC on 15 September is 00:45 on 16 September at +01:00.
	const record = buildActivityRecord({
		id: 3,
		start_time: "2026-09-15T23:45:00+0000",
		start_date_local_raw: Date.parse("2026-09-16T00:45:00Z") / 1000,
	});
	assert.equal(record?.start_date_local, "2026-09-16");
	assert.equal(record?.start_time, "2026-09-16T00:45:00+01:00");
	assert.equal(record?.start_date, "2026-09-16");
	assert.equal(record?.start_date_local, record?.start_date);
	assert.equal(record?.start_time_basis, "local");
	// One second short of midnight is not a real offset: no local day.
	const rounded = buildActivityRecord({
		id: 4,
		start_time: "2026-09-16T00:00:00Z",
		start_date_local_raw: Date.parse("2026-09-15T23:59:59Z") / 1000,
	});
	assert.equal(rounded?.start_date_local, null);
	assert.equal(rounded?.start_time, "2026-09-15T23:59:59+00:00");
	assert.equal(rounded?.start_time_basis, "local");
	assert.equal(rounded?.start_date, "2026-09-15");
});

test("a model without a numeric id or zoned start is unreadable", () => {
	assert.equal(
		buildActivityRecord({ start_time: "2026-01-01T00:00:00Z" }),
		null,
	);
	assert.equal(
		buildActivityRecord({ id: "abc", start_time: "2026-01-01T00:00:00Z" }),
		null,
	);
	assert.equal(
		buildActivityRecord({ id: -4, start_time: "2026-01-01T00:00:00Z" }),
		null,
	);
	assert.equal(buildActivityRecord({ id: 7, start_time: "2026-01-01" }), null);
	assert.equal(buildActivityRecord(null), null);
	assert.equal(
		buildActivityRecord({ id: "7", start_time: "2026-01-01T00:00:00Z" })?.id,
		"7",
	);
});

test("display strings are never read as metrics", () => {
	const record = buildActivityRecord({
		id: 1,
		start_time: "2026-01-01T00:00:00Z",
		distance: "6.21",
		distance_raw: "10000",
		moving_time: "50:00",
	});
	assert.equal(record?.distance_m, null);
	assert.equal(record?.moving_time_s, null);
});

test("start_date_local_raw puts the start on the local clock with its offset", () => {
	const utc = "2026-09-20T13:30:00+0000";
	const at = (localRaw: unknown) =>
		buildActivityRecord({
			id: 1,
			start_time: utc,
			start_date_local_raw: localRaw,
		});
	const local = at(Date.parse("2026-09-20T06:30:00Z") / 1000);
	assert.equal(local?.start_time, "2026-09-20T06:30:00-07:00");
	assert.equal(local?.start_time_basis, "local");
	assert.equal(local?.start_date, "2026-09-20");
	assert.equal(local?.start_date_local, "2026-09-20");
	const india = at(Date.parse("2026-09-20T19:00:00Z") / 1000);
	assert.equal(india?.start_time, "2026-09-20T19:00:00+05:30");
	// Absent, or not a real offset: fall back to UTC and say so.
	for (const bad of [
		undefined,
		"1789900000",
		1.5,
		Date.parse("2026-09-20T13:37:00Z") / 1000,
		Date.parse("2026-09-22T13:30:00Z") / 1000,
	]) {
		const record = at(bad);
		assert.equal(record?.start_time, "2026-09-20T13:30:00Z", String(bad));
		assert.equal(record?.start_time_basis, "utc");
		// The UTC day is not the local day, so the consent field stays null.
		assert.equal(record?.start_date_local, null, String(bad));
	}
});

test("summary heart rates stay null until detail collection", () => {
	const record = buildActivityRecord({
		id: 1,
		start_time: "2026-01-01T00:00:00Z",
		average_heartrate: 120,
		max_heartrate: 180,
	});
	assert.ok(record);
	assert.equal(record.average_heartrate, null);
	assert.equal(record.max_heartrate, null);
});

test("the UTC fallback date follows the normalized instant across midnight", () => {
	const record = buildActivityRecord({
		id: 1,
		start_time: "2026-09-16T00:30:00+05:00",
	});
	assert.ok(record);
	assert.equal(record.start_time, "2026-09-15T19:30:00Z");
	assert.equal(record.start_date, "2026-09-15");
	assert.equal(record.start_date, record.start_time.slice(0, 10));
	assert.equal(record.start_date_local, null);
	assert.equal(record.start_time_basis, "utc");
});

test("an exact zero local offset still establishes the local day", () => {
	const record = buildActivityRecord({
		id: 1,
		start_time: "2026-09-16T00:30:00Z",
		start_date_local_raw: Date.parse("2026-09-16T00:30:00Z") / 1000,
	});
	assert.ok(record);
	assert.equal(record.start_time, "2026-09-16T00:30:00+00:00");
	assert.equal(record.start_time_basis, "local");
	assert.equal(record.start_date_local, "2026-09-16");
	assert.equal(record.start_date_local, record.start_date);
});

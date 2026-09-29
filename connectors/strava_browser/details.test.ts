// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	activityGearId,
	parseActivityCalories,
	parseGearNames,
	parseHeartRateStream,
} from "./details.ts";

const fixture = (name: string) =>
	readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("parses calories from the activity detail HTML shape", () => {
	assert.equal(
		parseActivityCalories(fixture("activity-detail-synthetic.html")),
		42,
	);
	assert.equal(parseActivityCalories("<html></html>"), null);
});

test("summarizes the activity page's heartrate stream samples", () => {
	assert.deepEqual(
		parseHeartRateStream(fixture("activity-heartrate-stream-synthetic.json")),
		{ average: 81.2, maximum: 90 },
	);
	assert.deepEqual(parseHeartRateStream('{"distance":[]}'), {
		average: null,
		maximum: null,
	});
	assert.equal(parseHeartRateStream("not json"), null);
});

test("reads an activity's exposed gear identifier and preserves absence", () => {
	assert.equal(activityGearId({ athlete_gear_id: 123 }), "123");
	assert.equal(activityGearId({ bike_id: "456" }), "456");
	assert.equal(activityGearId({ athlete_gear_id: null, bike_id: null }), null);
	assert.equal(activityGearId({ athlete_gear_id: "bike-456" }), null);
});

test("maps only valid ids to displayed owner gear names", () => {
	assert.deepEqual(
		parseGearNames(fixture("gear-bikes-synthetic.json")),
		new Map([["987654", "Synthetic Test Bike"]]),
	);
	assert.equal(parseGearNames('{"bikes":[]}'), null);
	assert.equal(parseGearNames("not json"), null);
});

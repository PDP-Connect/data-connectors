// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	activityGear,
	parseActivityCalories,
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

test("uses an activity's exposed gear id, then bike id, and preserves absence", () => {
	assert.equal(activityGear({ athlete_gear_id: 123 }), "123");
	assert.equal(activityGear({ bike_id: "456" }), "456");
	assert.equal(activityGear({ athlete_gear_id: null, bike_id: null }), null);
});

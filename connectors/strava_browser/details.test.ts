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

test("calorie detail preserves a grouped fractional reading", () => {
	assert.equal(
		parseActivityCalories(
			'<div class="spans5">Calories</div><div class="spans3"><strong> 1,234.5 </strong></div>',
		),
		1234.5,
	);
});

test("calorie detail ignores the numeric value next to a different metric label", () => {
	const html =
		'<div class="spans5">Distance</div><div class="spans3"><strong>99</strong></div>';
	assert.equal(parseActivityCalories(html), null);
	assert.equal(
		parseActivityCalories(
			html +
				'<div class="spans5">Calories</div><div class="spans3"><strong>42</strong></div>',
		),
		42,
	);
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

test("malformed heart-rate response is not a valid stream with no samples", () => {
	for (const body of ["{", "null", "[]", "42"]) {
		assert.equal(parseHeartRateStream(body), null);
	}
	assert.deepEqual(parseHeartRateStream('{"heartrate":{"data":[]}}'), {
		average: null,
		maximum: null,
	});
});

test("malformed gear rows do not hide a valid localized label", () => {
	const body = JSON.stringify([
		null,
		{ id: 7, display_name: "   " },
		{ id: 8, display_name: "  Vélo fictif  " },
		{ id: 9, display_name: 123 },
	]);
	assert.deepEqual(parseGearNames(body), new Map([["8", "Vélo fictif"]]));
});

test("heart-rate statistics use only valid samples, including recorded zero", () => {
	const samples = [0, 90, { value: 150 }, null, -1, "180", {}, { value: -2 }];
	for (const heartrate of [samples, { data: samples }]) {
		assert.deepEqual(parseHeartRateStream(JSON.stringify({ heartrate })), {
			average: 80,
			maximum: 150,
		});
	}
});

test("empty or wholly invalid heart-rate streams have null statistics", () => {
	for (const heartrate of [[], [null, -1, "120", {}, { value: null }]]) {
		assert.deepEqual(parseHeartRateStream(JSON.stringify({ heartrate })), {
			average: null,
			maximum: null,
		});
	}
});

test("reports a present unreadable heart-rate container separately from no samples", () => {
	for (const heartrate of [null, 90, {}, { data: "unreadable" }]) {
		assert.equal(parseHeartRateStream(JSON.stringify({ heartrate })), null);
	}
	for (const payload of [{}, { heartrate: [] }, { heartrate: { data: [] } }]) {
		assert.deepEqual(parseHeartRateStream(JSON.stringify(payload)), {
			average: null,
			maximum: null,
		});
	}
});

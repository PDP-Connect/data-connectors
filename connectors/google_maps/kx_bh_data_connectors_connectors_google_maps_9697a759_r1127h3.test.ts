// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	parseGoogleMapsExport,
	parseGoogleMapsExportElement,
} from "./parsers.ts";

test("an unusable legacy date is omitted without discarding a valid neighbor", () => {
	const unrepresentable = {
		timestampMs: "8640000000000001",
		latitudeE7: 10000000,
		longitudeE7: 20000000,
	};
	const ordinary = {
		timestampMs: "1700000000000",
		latitudeE7: 30000000,
		longitudeE7: 40000000,
	};
	assert.deepEqual(
		parseGoogleMapsExportElement("legacy_records", unrepresentable),
		{ points: [], segments: [] },
	);
	const parsed = parseGoogleMapsExport({
		locations: [unrepresentable, ordinary],
	});
	assert.deepEqual(
		parsed.points.map((point) => point.timestamp),
		["2023-11-14T22:13:20.000Z"],
	);
	assert.deepEqual(parsed.segments, []);
});

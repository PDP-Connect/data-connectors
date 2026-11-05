// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { chaseMobileQfxWindow } from "./index.ts";

// Chase's download form offers at most 24 months of card activity.
const RUN = "2026-11-05T12:00:00.000Z";
const EARLIEST = "2024-11-06";

test("Mobile QFX window: 'all' asks for the full 24 months", () => {
	assert.deepEqual(chaseMobileQfxWindow({ activity: "all" }, undefined, RUN), {
		activity: "all",
		from: EARLIEST,
		to: "2026-11-05",
	});
});

test("Mobile QFX window: since the last statement starts at the cursor", () => {
	assert.deepEqual(
		chaseMobileQfxWindow(
			{ activity: "since_last_statement" },
			"2026-10-01T00:00:00Z",
			RUN,
		),
		{ activity: "date_range", from: "2026-10-01", to: "2026-11-05" },
	);
	assert.deepEqual(
		chaseMobileQfxWindow({ activity: "since_last_statement" }, undefined, RUN),
		{ activity: "all", from: EARLIEST, to: "2026-11-05" },
	);
});

test("Mobile QFX window: a requested range is clamped to 24 months", () => {
	assert.deepEqual(
		chaseMobileQfxWindow(
			{
				activity: "date_range",
				dateRange: { from: "2020-01-01", to: "2026-06-30" },
			},
			undefined,
			RUN,
		),
		{ activity: "date_range", from: EARLIEST, to: "2026-06-30" },
	);
	assert.deepEqual(
		chaseMobileQfxWindow(
			{ activity: "date_range", dateRange: { from: "2026-03-01" } },
			undefined,
			RUN,
		),
		{ activity: "date_range", from: "2026-03-01", to: "2026-11-05" },
	);
});

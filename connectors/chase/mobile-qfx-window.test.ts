// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { chaseMobileQfxWindow, shorterChaseQfxWindowFrom } from "./index.ts";

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

test("Mobile QFX window: an empty response halves the window down to 30 days", () => {
	const to = "2026-11-05";
	const froms: string[] = [];
	let from: string | null = EARLIEST;
	while (from !== null) {
		froms.push(from);
		from = shorterChaseQfxWindowFrom(from, to);
	}
	// 729, 364, 182, 91 and 45 days; 22 would be under the floor.
	assert.deepEqual(froms, [
		EARLIEST,
		"2025-11-06",
		"2026-05-07",
		"2026-08-06",
		"2026-09-21",
	]);
	assert.equal(shorterChaseQfxWindowFrom("2026-10-06", to), null);
});

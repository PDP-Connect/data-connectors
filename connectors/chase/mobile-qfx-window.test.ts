// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	chaseMobileQfxWindow,
	chaseQfxRequestWindows,
	joinChaseQfxWindows,
	splitChaseQfxWindow,
} from "./index.ts";

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

test("Mobile QFX requests: 24 months are two consecutive windows, newest first", () => {
	// A device answered 729 days with 204 but each of these with activity.
	assert.deepEqual(chaseQfxRequestWindows(EARLIEST, "2026-11-05"), [
		{ from: "2025-11-06", to: "2026-11-05" },
		{ from: EARLIEST, to: "2025-11-05" },
	]);
});

test("Mobile QFX requests: a range within one window is one request", () => {
	assert.deepEqual(chaseQfxRequestWindows("2026-10-01", "2026-11-05"), [
		{ from: "2026-10-01", to: "2026-11-05" },
	]);
	assert.deepEqual(chaseQfxRequestWindows("2025-11-06", "2026-11-05"), [
		{ from: "2025-11-06", to: "2026-11-05" },
	]);
	assert.deepEqual(chaseQfxRequestWindows("2025-11-05", "2026-11-05"), [
		{ from: "2025-11-06", to: "2026-11-05" },
		{ from: "2025-11-05", to: "2025-11-05" },
	]);
});

test("Mobile QFX requests: an empty window splits in halves down to 30 days", () => {
	const lengths: number[] = [];
	let window: { from: string; to: string } | null = {
		from: "2025-11-06",
		to: "2026-11-05",
	};
	while (window) {
		const halves = splitChaseQfxWindow(window);
		if (!halves) break;
		const [later, earlier] = halves;
		// The halves cover the window exactly, with no overlap.
		assert.equal(later.to, window.to);
		assert.equal(earlier.from, window.from);
		assert.ok(earlier.to < later.from);
		assert.deepEqual(joinChaseQfxWindows([later, earlier]), [window]);
		lengths.push((Date.parse(later.to) - Date.parse(later.from)) / 86_400_000);
		window = later;
	}
	// 364 days, then halves of 182, 91 and 45; 22 would be under the floor.
	assert.deepEqual(lengths, [182, 91, 45]);
	assert.equal(
		splitChaseQfxWindow({ from: "2026-10-06", to: "2026-11-05" }),
		null,
	);
});

test("Mobile QFX requests: unread windows join into ranges", () => {
	assert.deepEqual(
		joinChaseQfxWindows([
			{ from: "2025-05-01", to: "2025-11-05" },
			{ from: "2024-11-06", to: "2025-04-30" },
			{ from: "2026-01-01", to: "2026-01-31" },
		]),
		[
			{ from: "2024-11-06", to: "2025-11-05" },
			{ from: "2026-01-01", to: "2026-01-31" },
		],
	);
});

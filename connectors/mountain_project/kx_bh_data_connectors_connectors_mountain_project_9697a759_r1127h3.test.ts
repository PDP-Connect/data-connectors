import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTickRecords } from "./parsers.ts";

test("an unrepresentable stars field does not invalidate a usable exported tick", () => {
	const { records, unreadable } = buildTickRecords([
		{
			URL: "https://www.mountainproject.com/route/12345/fixture",
			Route: "Synthetic",
			Date: "2026-01-01",
			"Avg Stars": "9".repeat(400),
			"Your Stars": "3.5",
		},
	]);
	assert.equal(unreadable, 0);
	assert.equal(records[0]?.avg_stars, null);
	assert.equal(records[0]?.your_stars, 3.5);
});

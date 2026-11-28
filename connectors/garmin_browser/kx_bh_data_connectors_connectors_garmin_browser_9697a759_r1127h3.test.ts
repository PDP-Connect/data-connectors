import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryRangeDays } from "./parsers.ts";

test("duplicate days in a range cannot bypass the shape gate by putting the non-wellness entry first", () => {
	const day = "2026-09-20",
		window = { from: day, to: day };
	const blank = { calendarDate: day, includesWellnessData: false };
	const populated = {
		calendarDate: day,
		includesWellnessData: true,
		movement: { steps: { value: 123 } },
	};
	assert.equal(summaryRangeDays({ data: [blank, populated] }, window), null);
	assert.equal(summaryRangeDays({ data: [populated, blank] }, window), null);
	assert.equal(summaryRangeDays({ data: [populated] }, window)?.size, 1);
});

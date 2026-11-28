import assert from "node:assert/strict";
import { test } from "node:test";
import { durationTextToSeconds } from "./parsers.ts";

test("invalid playlist duration components do not turn into plausible seconds", () => {
	assert.equal(durationTextToSeconds("1:99"), null);
	assert.equal(durationTextToSeconds("1:60:00"), null);
	assert.equal(durationTextToSeconds("9".repeat(400) + ":00"), null);
	assert.equal(durationTextToSeconds("120:45"), 7245);
	assert.equal(durationTextToSeconds("1:20:45"), 4845);
});

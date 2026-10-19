import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { it } from "vitest";

it("vitest fixture ran", () => {
	assert.ok(process.env.TEST_DISPATCH_MARKERS);
	appendFileSync(process.env.TEST_DISPATCH_MARKERS, "vitest\n");
	assert.notEqual(process.env.FAIL_VITEST_FIXTURE, "1");
});

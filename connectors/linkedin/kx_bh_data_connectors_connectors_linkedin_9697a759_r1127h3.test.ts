import assert from "node:assert/strict";
import test from "node:test";
import { epochMillis } from "./field-read.ts";

test("fractional connection timestamps are not rounded into different milliseconds", () => {
	assert.deepEqual(epochMillis(0.5), {
		kind: "unavailable",
		reason: "malformed",
	});
	assert.deepEqual(epochMillis(1_700_000_000_000.75), {
		kind: "unavailable",
		reason: "malformed",
	});
	assert.deepEqual(epochMillis(0), { kind: "empty" });
	assert.deepEqual(epochMillis(1_700_000_000_000), {
		kind: "read",
		value: "2023-11-14T22:13:20.000Z",
	});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { toIso } from "./parsers.ts";

test("chat timestamps outside the RFC 3339 year range do not become sortable cursors", () => {
	assert.equal(toIso(253402300800000), null);
	assert.equal(toIso("253402300800000"), null);
	assert.equal(toIso(253402300799999), "9999-12-31T23:59:59.999Z");
	assert.equal(toIso(1700000000), "2023-11-14T22:13:20.000Z");
});

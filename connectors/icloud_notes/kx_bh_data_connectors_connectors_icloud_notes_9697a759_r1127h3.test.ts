import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeBase64Text } from "./parsers.ts";

test("malformed padding does not alias a valid CloudKit text field", () => {
	assert.equal(decodeBase64Text("YQ="), null);
	assert.equal(decodeBase64Text("YWJj="), null);
	assert.equal(decodeBase64Text("YQ=="), "a");
	assert.equal(decodeBase64Text("YQ"), "a");
	assert.equal(decodeBase64Text("YWJj"), "abc");
});

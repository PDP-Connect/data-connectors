// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { readSampleRecord } from "./fixture-samples.ts";

test("readSampleRecord reads a real gmail messages sample record", () => {
	const record = readSampleRecord("gmail", "messages");
	assert.equal(typeof record.id, "string");
	assert.ok(record.id);
});

test("readSampleRecord reads a real codex messages sample record", () => {
	const record = readSampleRecord("codex", "messages");
	assert.equal(typeof record.id, "string");
	assert.ok(record.id);
});

test("readSampleRecord throws a clear error for an unknown connector/stream pair", () => {
	assert.throws(
		() => readSampleRecord("does-not-exist", "does-not-exist"),
		/ENOENT|no such file/,
	);
});

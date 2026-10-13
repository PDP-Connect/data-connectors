// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityTable } from "./identity-table.ts";

/** The id whose leading bytes are `bytes` and whose other bytes are 0. */
function idOf(...bytes: number[]): string {
	const key = Buffer.alloc(12);
	key.set(bytes);
	return key.toString("hex");
}

/** Weights that give every id the same home slot. */
const COLLIDING = [0, 0, 0, 0, 0, 0];

test("an id is found once added, and an id never added is not", () => {
	const table = new IdentityTable(10);
	const id = "0123456789abcdef01234567";
	assert.equal(table.has(1, id), false);
	assert.equal(table.add(1, id), true);
	assert.equal(table.has(1, id), true);
	assert.equal(table.has(1, idOf(1)), false);
});

test("each stream remembers its own ids, even in the same slot", () => {
	const table = new IdentityTable(10, COLLIDING);
	const id = idOf(7);
	table.add(1, id);
	assert.equal(table.has(2, id), false);
	assert.equal(table.add(2, id), true);
	assert.equal(table.has(1, id), true);
	assert.equal(table.has(2, id), true);
	assert.equal(table.has(3, id), false);
});

test("ids sharing a home slot are all found, past the table's end and back to its start", () => {
	// Weighing the first word alone makes it the home slot: 7, the last of
	// the eight slots, so the walk wraps to slot 0.
	const table = new IdentityTable(4, [1, 0, 0, 0, 0, 0]);
	const ids = [1, 2, 3, 4].map((n) => idOf(7, 0, n));
	for (const id of ids) {
		assert.equal(table.add(1, id), true);
	}
	for (const id of ids) {
		assert.equal(table.has(1, id), true, id);
	}
	assert.equal(table.has(1, idOf(7, 0, 5)), false);
});

test("once the budget is spent, no stream sharing it remembers a new id", () => {
	const table = new IdentityTable(2);
	assert.equal(table.add(1, idOf(1)), true);
	assert.equal(table.add(2, idOf(2)), true);
	assert.equal(table.add(1, idOf(3)), false);
	assert.equal(table.has(1, idOf(3)), false);
	assert.equal(table.add(2, idOf(1)), false, "new to this stream");
	assert.equal(table.has(1, idOf(1)), true);
	assert.equal(table.add(1, idOf(1)), true, "already remembered");
});

test("ids differing in any one byte are different ids", () => {
	const same = Array.from({ length: 12 }, () => 0xaa);
	for (let byte = 0; byte < 12; byte += 1) {
		const table = new IdentityTable(4, COLLIDING);
		const other = [...same];
		other[byte] = 0xab;
		table.add(1, idOf(...same));
		assert.equal(table.has(1, idOf(...other)), false, `byte ${byte}`);
		assert.equal(table.has(1, idOf(...same)), true);
	}
});

test("an id that is not 24 hex characters is refused", () => {
	const table = new IdentityTable(4);
	assert.throws(() => table.has(1, "abc"), RangeError);
	assert.throws(() => table.add(1, `${"0".repeat(22)}zz`), RangeError);
	assert.throws(() => table.add(1, "0".repeat(26)), RangeError);
});

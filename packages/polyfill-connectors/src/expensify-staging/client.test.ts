// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createRequestPacer, retryAfterDelay } from "./client.ts";

test("pacer enforces both rolling limits for concurrent requests", async () => {
	let clock = 0;
	const starts: number[] = [];
	const pacer = createRequestPacer({
		now: () => clock,
		sleep: async (milliseconds) => { clock += milliseconds; },
	});
	await Promise.all(Array.from({ length: 25 }, () =>
		pacer.run(async () => { starts.push(clock); }),
	));
	assert.equal(starts[5], 10_000);
	assert.equal(starts[20], 60_000);
	for (const end of starts) {
		assert.ok(starts.filter((at) => at > end - 10_000 && at <= end).length <= 5);
		assert.ok(starts.filter((at) => at > end - 60_000 && at <= end).length <= 20);
	}
});

test("failed requests consume quota without blocking later queued requests", async () => {
	let clock = 0;
	const starts: number[] = [];
	const pacer = createRequestPacer({
		now: () => clock,
		sleep: async (milliseconds) => { clock += milliseconds; },
	});
	await assert.rejects(pacer.run(async () => {
		starts.push(clock);
		throw new Error("synthetic transport failure");
	}), /synthetic transport failure/);
	for (let i = 0; i < 5; i++) {
		await pacer.run(async () => { starts.push(clock); });
	}
	assert.deepEqual(starts, [0, 0, 0, 0, 0, 10_000]);
});

test("Retry-After handles delay, HTTP date, elapsed date and fallback", () => {
	const clock = Date.UTC(2026, 0, 1);
	assert.equal(retryAfterDelay("2", clock), 2000);
	assert.equal(retryAfterDelay("0", clock), 0);
	assert.equal(retryAfterDelay(new Date(clock + 3000).toUTCString(), clock), 3000);
	assert.equal(retryAfterDelay(new Date(clock - 3000).toUTCString(), clock), 0);
	for (const value of [null, "", "not-a-date"]) {
		assert.equal(retryAfterDelay(value, clock), 10_000);
	}
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "./connector-runtime.ts";

async function emitted(
	timeRange: { since?: string; until?: string },
	value: unknown,
): Promise<boolean> {
	const emitted: EmittedMessage[] = [];
	const gate = makeEmitRecord({
		requested: new Map([["events", { name: "events", time_range: timeRange }]]),
		emit: async (message) => {
			emitted.push(message);
		},
		emittedAt: "2026-05-03T00:00:00.000Z",
		validateRecord: undefined,
		isTombstone: undefined,
		timeRangeFieldFor: () => "occurred_at",
	});

	await gate.emit("events", { id: "event-1", occurred_at: value });
	return emitted.length === 1;
}

test("shared time_range compares timestamp instants inside a day", async () => {
	assert.equal(
		await emitted({ since: "2026-05-02T23:59:59Z" }, "2026-05-02T00:00:01Z"),
		false,
		"a same-day record before since must be excluded",
	);
	assert.equal(
		await emitted({ since: "2026-05-02T23:59:59Z" }, "2026-05-02T23:59:59Z"),
		true,
		"since is inclusive",
	);
	assert.equal(
		await emitted({ until: "2026-05-03T00:00:01Z" }, "2026-05-02T23:59:59Z"),
		true,
		"a same-window record before until must be included",
	);
	assert.equal(
		await emitted({ until: "2026-05-03T00:00:01Z" }, "2026-05-03T00:00:01Z"),
		false,
		"until is exclusive",
	);
});

test("shared time_range compares records immediately across a day boundary", async () => {
	assert.equal(
		await emitted({ since: "2026-05-03T00:00:00Z" }, "2026-05-02T23:59:59Z"),
		false,
		"the final second before since is excluded",
	);
	assert.equal(
		await emitted({ since: "2026-05-03T00:00:00Z" }, "2026-05-03T00:00:01Z"),
		true,
		"a record after since is included",
	);
	assert.equal(
		await emitted({ until: "2026-05-03T00:00:00Z" }, "2026-05-02T23:59:59Z"),
		true,
		"the final second before until is included",
	);
	assert.equal(
		await emitted({ until: "2026-05-03T00:00:00Z" }, "2026-05-03T00:00:01Z"),
		false,
		"a record after until is excluded",
	);
});

test("shared time_range compares offset timestamps by instant", async () => {
	assert.equal(
		await emitted(
			{ since: "2026-05-03T05:30:00+05:30" },
			"2026-05-02T23:59:59Z",
		),
		false,
	);
	assert.equal(
		await emitted(
			{ since: "2026-05-03T05:30:00+05:30" },
			"2026-05-03T00:00:00Z",
		),
		true,
	);
	assert.equal(
		await emitted(
			{ until: "2026-05-02T17:00:00-07:00" },
			"2026-05-02T23:59:59Z",
		),
		true,
	);
	assert.equal(
		await emitted(
			{ until: "2026-05-02T17:00:00-07:00" },
			"2026-05-03T00:00:00Z",
		),
		false,
	);
});

test("shared time_range requires exact ISO instants, not date-only overlap", async () => {
	assert.equal(
		await emitted({ since: "2026-05-02T12:00:00Z" }, "2026-05-02"),
		false,
	);
	assert.equal(
		await emitted({ since: "2026-05-03T00:00:00Z" }, "2026-05-02"),
		false,
	);
	assert.equal(
		await emitted({ until: "2026-05-02T12:00:00Z" }, "2026-05-02"),
		false,
	);
	assert.equal(
		await emitted({ until: "2026-05-02T00:00:00Z" }, "2026-05-02"),
		false,
	);
});

test("shared time_range fails closed for invalid bounds and consent-time values", async () => {
	assert.equal(
		await emitted({ since: "2026-05-02T00:00:00Z" }, "not-a-timestamp"),
		false,
	);
	assert.deepEqual(
		await Promise.all(
			[undefined, null, "", 123, "May 2, 2026"].map((value) =>
				emitted({ since: "2026-05-02T00:00:00Z" }, value),
			),
		),
		[false, false, false, false, false],
	);
	assert.equal(
		await emitted({ since: "not-a-timestamp" }, "2026-05-02T00:00:00Z"),
		false,
	);
	assert.equal(
		await emitted({ until: "2026-02-30T12:00:00Z" }, "2026-05-02T00:00:00Z"),
		false,
	);
});

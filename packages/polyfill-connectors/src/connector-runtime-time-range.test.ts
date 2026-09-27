// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "./connector-runtime.ts";

function selected(
	timeRange: { since?: string; until?: string },
	value: unknown,
): boolean {
	const emitted: EmittedMessage[] = [];
	const gate = makeEmitRecord({
		requested: new Map([["events", { time_range: timeRange }]]),
		emit: async (message) => {
			emitted.push(message);
		},
		emittedAt: "2026-05-03T00:00:00.000Z",
		validateRecord: undefined,
		isTombstone: undefined,
		timeRangeFieldFor: () => "occurred_at",
	});

	return gate.isSelected("events", { id: "event-1", occurred_at: value });
}

test("shared time_range compares timestamp instants inside a day", () => {
	assert.equal(
		selected(
			{ since: "2026-05-02T23:59:59Z" },
			"2026-05-02T00:00:01Z",
		),
		false,
		"a same-day record before since must be excluded",
	);
	assert.equal(
		selected(
			{ since: "2026-05-02T23:59:59Z" },
			"2026-05-02T23:59:59Z",
		),
		true,
		"since is inclusive",
	);
	assert.equal(
		selected(
			{ until: "2026-05-03T00:00:01Z" },
			"2026-05-02T23:59:59Z",
		),
		true,
		"a same-window record before until must be included",
	);
	assert.equal(
		selected(
			{ until: "2026-05-03T00:00:01Z" },
			"2026-05-03T00:00:01Z",
		),
		false,
		"until is exclusive",
	);
});

test("shared time_range compares records immediately across a day boundary", () => {
	assert.equal(
		selected(
			{ since: "2026-05-03T00:00:00Z" },
			"2026-05-02T23:59:59Z",
		),
		false,
		"the final second before since is excluded",
	);
	assert.equal(
		selected(
			{ since: "2026-05-03T00:00:00Z" },
			"2026-05-03T00:00:01Z",
		),
		true,
		"a record after since is included",
	);
	assert.equal(
		selected(
			{ until: "2026-05-03T00:00:00Z" },
			"2026-05-02T23:59:59Z",
		),
		true,
		"the final second before until is included",
	);
	assert.equal(
		selected(
			{ until: "2026-05-03T00:00:00Z" },
			"2026-05-03T00:00:01Z",
		),
		false,
		"a record after until is excluded",
	);
});

test("shared time_range compares offset timestamps by instant", () => {
	assert.equal(
		selected(
			{ since: "2026-05-03T05:30:00+05:30" },
			"2026-05-02T23:59:59Z",
		),
		false,
	);
	assert.equal(
		selected(
			{ since: "2026-05-03T05:30:00+05:30" },
			"2026-05-03T00:00:00Z",
		),
		true,
	);
	assert.equal(
		selected(
			{ until: "2026-05-02T17:00:00-07:00" },
			"2026-05-02T23:59:59Z",
		),
		true,
	);
	assert.equal(
		selected(
			{ until: "2026-05-02T17:00:00-07:00" },
			"2026-05-03T00:00:00Z",
		),
		false,
	);
});

test("shared time_range keeps date-only records when their UTC day overlaps", () => {
	assert.equal(
		selected({ since: "2026-05-02T12:00:00Z" }, "2026-05-02"),
		true,
	);
	assert.equal(
		selected({ since: "2026-05-03T00:00:00Z" }, "2026-05-02"),
		false,
	);
	assert.equal(
		selected({ until: "2026-05-02T12:00:00Z" }, "2026-05-02"),
		true,
	);
	assert.equal(
		selected({ until: "2026-05-02T00:00:00Z" }, "2026-05-02"),
		false,
	);
});

test("shared time_range excludes invalid non-empty consent-time values", () => {
	assert.equal(
		selected({ since: "2026-05-02T00:00:00Z" }, "not-a-timestamp"),
		false,
	);
});

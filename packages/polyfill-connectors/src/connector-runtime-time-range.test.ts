// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "@pdpp/connector-protocol";
import { makeEmitRecord } from "./connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

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

async function emittedTombstone(
	timeRange: { since?: string; until?: string },
	value: unknown,
): Promise<EmittedMessage[]> {
	const messages: EmittedMessage[] = [];
	const gate = makeEmitRecord({
		requested: new Map([["events", { name: "events", time_range: timeRange }]]),
		emit: async (message) => {
			messages.push(message);
		},
		emittedAt: "2026-05-03T00:00:00.000Z",
		validateRecord: undefined,
		isTombstone: () => true,
		timeRangeFieldFor: () => "occurred_at",
	});
	await gate.emit("events", { id: "event-1", occurred_at: value });
	return messages;
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

test("date-precision consent values fail a bounded emission explicitly", async () => {
	await assert.rejects(
		emitted({ since: "2026-05-02T12:00:00Z" }, "2026-05-02"),
		/time_range.*date-precision|date-precision.*time_range/,
	);
});

test("declared date-precision streams refuse bounds before an empty collection", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: fileURLToPath(new URL("../../..", import.meta.url)),
		entrypoint: fileURLToPath(
			new URL("./__fixtures__/date-precision-preflight.ts", import.meta.url),
		),
		start: {
			type: "START",
			scope: {
				streams: [
					{
						name: "events",
						time_range: { since: "2026-05-02T00:00:00Z" },
					},
				],
			},
		},
	});
	assert.equal(
		result.messages.some((message) => message.type === "RECORD"),
		false,
	);
	const done = result.messages.find((message) => message.type === "DONE");
	assert.equal(done?.type, "DONE");
	if (done?.type === "DONE") {
		assert.equal(done.status, "failed");
		assert.match(done.error?.message ?? "", /time_range.*events.*unsupported/);
	}
});

test("Chase and YNAB date-precision streams refuse bounded runs before collection", async () => {
	const cases = [
		...(["transactions", "current_activity", "statements"] as const).map(
			(stream) => ({ connector: "chase", stream }),
		),
		...(
			[
				"account_stats",
				"transactions",
				"scheduled_transactions",
				"months",
				"month_categories",
			] as const
		).map((stream) => ({ connector: "ynab", stream })),
	];
	const results = await Promise.all(
		cases.map(({ connector, stream }) =>
			runConnectorProtocolSubprocess({
				allowFailedDone: true,
				cwd: fileURLToPath(new URL("../../..", import.meta.url)),
				entrypoint: fileURLToPath(
					new URL(`../../../connectors/${connector}/index.ts`, import.meta.url),
				),
				start: {
					type: "START",
					scope: {
						streams: [
							{
								name: stream,
								time_range: { since: "2026-05-02T00:00:00Z" },
							},
						],
					},
				},
			}),
		),
	);
	for (const [index, result] of results.entries()) {
		assert.equal(
			result.messages.some((message) => message.type === "RECORD"),
			false,
		);
		const done = result.messages.find((message) => message.type === "DONE");
		assert.equal(
			done?.type,
			"DONE",
			cases[index]?.connector ?? "unknown connector",
		);
		if (done?.type === "DONE") {
			assert.equal(done.status, "failed");
			assert.equal(done.error?.code, "scope_not_supported");
		}
	}
});

test("tombstones pass the same consent-time check as upserts", async () => {
	assert.deepEqual(
		await Promise.all(
			[undefined, "2026-05-01T23:59:59Z"].map((value) =>
				emittedTombstone({ since: "2026-05-02T00:00:00Z" }, value),
			),
		),
		[[], []],
	);
	const messages = await emittedTombstone(
		{ since: "2026-05-02T00:00:00Z" },
		"2026-05-02T00:00:00Z",
	);
	assert.equal(messages.length, 1);
	assert.equal(messages[0]?.type, "RECORD");
	if (messages[0]?.type === "RECORD") assert.equal(messages[0].op, "delete");
});

test("sub-millisecond instants keep their full precision", async () => {
	assert.equal(
		await emitted(
			{ since: "2026-05-02T12:00:00.1235Z" },
			"2026-05-02T12:00:00.1234Z",
		),
		false,
	);
	assert.equal(
		await emitted(
			{ until: "2026-05-02T12:00:00.1235Z" },
			"2026-05-02T12:00:00.1234Z",
		),
		true,
	);
	assert.equal(
		await emitted(
			{ since: "2026-05-03T05:30:00.1234567891+05:30" },
			"2026-05-03T00:00:00.1234567890Z",
		),
		false,
	);
	assert.equal(
		await emitted(
			{ until: "2026-05-03T05:30:00.1234567891+05:30" },
			"2026-05-03T00:00:00.1234567890Z",
		),
		true,
	);
});

test("present empty time bounds fail closed", async () => {
	assert.equal(await emitted({ since: "" }, "2026-05-02T12:00:00Z"), false);
	assert.equal(await emitted({ until: "" }, "2026-05-02T12:00:00Z"), false);
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

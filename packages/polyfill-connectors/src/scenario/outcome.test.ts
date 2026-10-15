// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeRunOutcome } from "./outcome.ts";

test("summarizeRunOutcome: records failed DONE and per-stream reason codes only", () => {
	const outcome = summarizeRunOutcome([
		{
			type: "DETAIL_GAP",
			stream: "messages",
			reason: "surface_unreachable",
			record_key: "synthetic-personal-value",
			detail_locator: { thread: "synthetic-private-text" },
		},
		{
			type: "DONE",
			status: "failed",
			error: { code: "collection_failed", message: "synthetic-private-text" },
		},
	]);
	assert.deepEqual(outcome, {
		error_code: "collection_failed",
		status: "failed",
		stream_outcomes: [
			{
				outcome: "detail_gap",
				reason_code: "surface_unreachable",
				stream: "messages",
			},
		],
	});
	assert.doesNotMatch(
		JSON.stringify(outcome),
		/synthetic-private-text|synthetic-personal-value/,
	);
});

test("summarizeRunOutcome: recognizes skip results even when DONE succeeds", () => {
	assert.deepEqual(
		summarizeRunOutcome([
			{
				type: "SKIP_RESULT",
				stream: "events",
				reason: "stream_capped",
				message: "private detail",
			},
			{ type: "DONE", status: "succeeded" },
		]),
		{
			status: "succeeded",
			stream_outcomes: [
				{
					outcome: "skip_result",
					reason_code: "stream_capped",
					stream: "events",
				},
			],
		},
	);
});

test("summarizeRunOutcome: excludes crashes, missing DONE, and DONE without declared reason", () => {
	assert.equal(
		summarizeRunOutcome([{ type: "DONE", status: "failed" }]),
		undefined,
	);
	assert.equal(
		summarizeRunOutcome([{ type: "RECORD", stream: "events" }]),
		undefined,
	);
	assert.equal(
		summarizeRunOutcome([{ type: "DONE", status: "succeeded" }]),
		undefined,
	);
});

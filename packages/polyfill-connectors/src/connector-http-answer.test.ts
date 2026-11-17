// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { RetryExhaustedError } from "@pdpp/connector-protocol/http-retry";
import {
	type ConnectorHttpGovernor,
	ConnectorRateLimitedError,
	type GovernedHttpAnswer,
	requestGovernedAnswer,
} from "./connector-http-governor.ts";

test("governed answers preserve identity, forwarding and per-attempt observer order", async () => {
	const answers = [
		{ status: 503, retryAfter: null, payload: { first: true } },
		{ status: 200, retryAfter: " 7 ", payload: { first: false } },
	];
	const events: unknown[] = [];
	let sends = 0;
	const governor: Pick<ConnectorHttpGovernor, "request"> = {
		async request(send, classify) {
			events.push("request");
			const first = await send();
			const a = classify(first);
			assert.equal(first, answers[0]);
			assert.equal(a.value, first);
			assert.equal(a.status, 503);
			assert.deepEqual(a.headers, {});
			const second = await send();
			const b = classify(second);
			assert.equal(second, answers[1]);
			assert.equal(b.value, second);
			assert.equal(b.status, 200);
			assert.deepEqual(b.headers, { "retry-after": " 7 " });
			return b;
		},
	};
	const outcome = await requestGovernedAnswer(
		{
			governor,
			retryBudget: {
				noteAttempt() {
					events.push("attempt");
				},
				noteAnswer(value) {
					events.push(["answer", value]);
				},
			},
		},
		async () => {
			events.push(["send", sends]);
			return answers[sends++]!;
		},
	);
	assert.deepEqual(events, [
		"request",
		"attempt",
		["send", 0],
		["answer", null],
		"attempt",
		["send", 1],
		["answer", " 7 "],
	]);
	assert.equal(outcome.ok, true);
	if (!outcome.ok) {
		assert.fail("expected success");
	}
	assert.equal(outcome.value, answers[1]);
});

function throwing(error: unknown) {
	const governor: Pick<ConnectorHttpGovernor, "request"> = {
		async request() {
			throw error;
		},
	};
	return {
		governor,
		retryBudget: {
			noteAttempt() {
				assert.fail("no transport callback invoked");
			},
			noteAnswer() {
				assert.fail("no answer classified");
			},
		},
	};
}

const unusedSend = async (): Promise<GovernedHttpAnswer> =>
	assert.fail("the rejecting fake governor does not send");

test("governed answers map an actual rate-limit error", async () => {
	assert.deepEqual(
		await requestGovernedAnswer(
			throwing(new ConnectorRateLimitedError("fixture")),
			unusedSend,
		),
		{
			ok: false,
			rateLimited: true,
		},
	);
});

test("governed answers map only numeric exhausted statuses", async () => {
	const causes: Array<{ status?: unknown } | null | undefined> = [
		{ status: 503 },
		{},
		undefined,
		null,
		{ status: "503" },
	];
	for (const cause of causes) {
		// Real prototype branch, without assuming an uninspected constructor.
		const error = Object.assign(Object.create(RetryExhaustedError.prototype), {
			originalCause: cause,
		});
		assert.deepEqual(await requestGovernedAnswer(throwing(error), unusedSend), {
			ok: false,
			rateLimited: false,
			status: typeof cause?.status === "number" ? cause.status : null,
		});
	}
});

test("governed answers rethrow unknown and name-lookalike errors by identity", async () => {
	for (const error of [
		new Error("transport failed"),
		{ name: "ConnectorRateLimitedError", status: 429 },
		{ name: "RetryExhaustedError", originalCause: { status: 503 } },
	]) {
		await assert.rejects(
			requestGovernedAnswer(throwing(error), unusedSend),
			(actual: unknown) => actual === error,
		);
	}
});

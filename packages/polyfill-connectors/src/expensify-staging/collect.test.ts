// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { collectExpensify, type ExpensifyCollectDeps } from "./collect.ts";

const fixture = [
	JSON.stringify({
		kind: "expense",
		transactionID: "expense-1",
		reportID: "report-1",
		merchant: "Fixture",
		created: "2025-01-01",
		amount: 1234,
		currency: "USD",
	}),
	JSON.stringify({
		kind: "report",
		reportID: "report-1",
		reportName: "Fixture report",
		status: "Reimbursed",
		reimbursed: "2025-01-02",
		entryID: "payment-1",
		total: 1234,
		currency: "USD",
		isACHReimbursed: true,
	}),
].join("\n");
const streams = ["expenses", "reports", "reimbursements"];

function harness(text = fixture, requested = streams) {
	const records: {
		stream: string;
		data: Parameters<ExpensifyCollectDeps["emitRecord"]>[1];
	}[] = [];
	const messages: Parameters<ExpensifyCollectDeps["emit"]>[0][] = [];
	const progress: string[] = [];
	const ranges: { from: string; to: string }[] = [];
	const deps: ExpensifyCollectDeps = {
		client: {
			async exportRange(range) {
				ranges.push(range);
				return text;
			},
		},
		requested: new Set(requested),
		now: () => new Date("2026-11-15T23:59:59Z"),
		emitRecord: async (stream, data) => {
			records.push({ stream, data });
		},
		emit: async (message) => {
			messages.push(message);
		},
		progress: async (message) => {
			progress.push(message);
		},
	};
	const coverage = () =>
		messages.filter((message) => message.type === "DETAIL_COVERAGE");
	return { deps, records, messages, progress, ranges, coverage };
}

test("exports once, parses all streams and covers only the default three-year window", async () => {
	const h = harness();
	await collectExpensify(h.deps);
	assert.deepEqual(h.ranges, [{ from: "2023-11-15", to: "2026-11-15" }]);
	assert.deepEqual(
		h.records.map(({ stream, data }) => [stream, data.id]),
		[
			["expenses", "expense-1"],
			["reports", "report-1"],
			["reimbursements", "payment-1"],
		],
	);
	assert.equal(h.records[1]!.data.status_normalized, "reimbursed");
	assert.equal(h.records[2]!.data.amount_source, "report_total");
	assert.deepEqual(
		h.coverage(),
		streams.map((stream) => ({
			type: "DETAIL_COVERAGE",
			reference_only: true,
			stream,
			state_stream: stream,
			required_keys: [],
			hydrated_keys: [],
			considered: 1,
			covered: 1,
		})),
	);
	assert.match(
		h.progress[0]!,
		/2023-11-15 through 2026-11-15; not all-time coverage/,
	);
	assert.equal(
		h.messages.some((message) => message.type === "STATE"),
		false,
	);
});

test("a requested Map containing reports emits no other records or coverage", async () => {
	const h = harness();
	h.deps.requested = new Map([["reports", {}]]);
	await collectExpensify(h.deps);
	assert.deepEqual(
		h.records.map(({ stream, data }) => [stream, data.id]),
		[["reports", "report-1"]],
	);
	assert.deepEqual(
		h.coverage().map((message) => message.stream),
		["reports"],
	);
});

test("invalid JSON leaves all requested coverage incomplete without leaking source", async () => {
	const bad = "PRIVATE_INVALID_LINE";
	const h = harness(fixture + "\n" + bad);
	await collectExpensify(h.deps);
	assert.equal(h.coverage().length, 3);
	for (const coverage of h.coverage()) {
		assert.equal(coverage.considered, 2);
		assert.equal(coverage.covered, 1);
	}
	const skips = h.messages.filter((message) => message.type === "SKIP_RESULT");
	assert.equal(skips.length, 3);
	for (const skip of skips) {
		const diagnostics = skip.diagnostics as {
			window: { from: string; to: string };
			reasons: Record<string, number>;
		};
		assert.equal(diagnostics.reasons.invalid_json, 1);
		assert.deepEqual(diagnostics.window, h.ranges[0]);
		assert.ok(Object.keys(diagnostics.reasons).length <= 5);
	}
	assert.equal(
		JSON.stringify([h.records, h.messages, h.progress]).includes(bad),
		false,
	);
});

test("expense-only rejection does not damage reports or reimbursements", async () => {
	const h = harness(
		fixture + "\n" + JSON.stringify({ kind: "expense", reportID: "report-1" }),
	);
	await collectExpensify(h.deps);
	assert.deepEqual(
		h
			.coverage()
			.map((message) => [message.stream, message.considered, message.covered]),
		[
			["expenses", 2, 1],
			["reports", 1, 1],
			["reimbursements", 1, 1],
		],
	);
});

test("invalid report record also marks derived reimbursements incomplete", async () => {
	const h = harness(
		fixture +
			"\n" +
			JSON.stringify({
				kind: "report",
				reportID: "bad-report",
				reimbursed: "not-a-date",
			}),
	);
	await collectExpensify(h.deps);
	assert.deepEqual(
		h
			.coverage()
			.map((message) => [message.stream, message.considered, message.covered]),
		[
			["expenses", 1, 1],
			["reports", 2, 1],
			["reimbursements", 2, 1],
		],
	);
});

test("credentials rejection preserves identity, code and non-retryable metadata", async () => {
	const h = harness();
	const failure = Object.assign(new Error("credentials rejected"), {
		code: "expensify_credentials_rejected",
		retryable: false,
	});
	h.deps.client.exportRange = async () => {
		throw failure;
	};
	await assert.rejects(collectExpensify(h.deps), (error) => {
		assert.equal(error, failure);
		assert.equal(failure.code, "expensify_credentials_rejected");
		assert.equal(failure.retryable, false);
		return true;
	});
	assert.deepEqual([h.records, h.messages, h.progress], [[], [], []]);
});

test("subtracting a year from UTC leap day clamps to February 28", async () => {
	const h = harness();
	let calls = 0;
	h.deps.now = () => {
		calls += 1;
		return new Date("2024-02-29T04:30:00Z");
	};
	h.deps.years = 1;
	await collectExpensify(h.deps);
	assert.equal(calls, 1);
	assert.deepEqual(h.ranges, [{ from: "2023-02-28", to: "2024-02-29" }]);
});

test("rejects invalid years before fetching or emitting", async () => {
	for (const years of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
		const h = harness();
		h.deps.years = years;
		await assert.rejects(collectExpensify(h.deps), /positive safe integer/);
		assert.deepEqual(
			[h.ranges, h.records, h.messages, h.progress],
			[[], [], [], []],
		);
	}
});

test("a successfully empty export has measured zero coverage and no cursor", async () => {
	const h = harness("");
	await collectExpensify(h.deps);
	assert.equal(h.records.length, 0);
	assert.equal(h.coverage().length, 3);
	assert.ok(
		h
			.coverage()
			.every((message) => message.considered === 0 && message.covered === 0),
	);
	assert.equal(
		h.messages.some((message) => message.type === "STATE"),
		false,
	);
});

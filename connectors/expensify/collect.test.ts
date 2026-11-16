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
const policies = [
	{
		id: "p1",
		name: "Workspace one",
		type: "corporate",
		role: "admin",
		outputCurrency: "USD",
	},
	{
		id: "p2",
		name: "Workspace two",
		type: null,
		role: "user",
		outputCurrency: null,
	},
];

function harness(text = fixture, requested = streams) {
	const records: {
		stream: string;
		data: Parameters<ExpensifyCollectDeps["emitRecord"]>[1];
	}[] = [];
	const messages: Parameters<ExpensifyCollectDeps["emit"]>[0][] = [];
	const progress: string[] = [];
	const ranges: { from: string; to: string }[] = [];
	let policyCalls = 0;
	const deps: ExpensifyCollectDeps = {
		client: {
			async listPolicies() {
				policyCalls++;
				return policies;
			},
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
	return {
		deps,
		records,
		messages,
		progress,
		ranges,
		coverage,
		policyCalls: () => policyCalls,
	};
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
		await assert.rejects(collectExpensify(h.deps), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.name, "TerminalError");
			assert.equal("code" in error && error.code, "expensify_invalid_window");
			assert.equal("retryable" in error && error.retryable, false);
			assert.deepEqual("recoveryHint" in error && error.recoveryHint, {
				action: "manual_action_required",
				retryable: false,
			});
			return true;
		});
		assert.equal(h.policyCalls(), 0);
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

test("workspace and account profile streams contain exact selected-window facts", async () => {
	const h = harness(fixture, ["workspaces", "account_profile"]);
	await collectExpensify(h.deps);
	assert.equal(h.policyCalls(), 1);
	assert.deepEqual(h.ranges, [{ from: "2023-11-15", to: "2026-11-15" }]);
	assert.deepEqual(h.records, [
		{
			stream: "workspaces",
			data: {
				id: "p1",
				name: "Workspace one",
				type: "corporate",
				role: "admin",
				output_currency: "USD",
			},
		},
		{
			stream: "workspaces",
			data: {
				id: "p2",
				name: "Workspace two",
				type: null,
				role: "user",
				output_currency: null,
			},
		},
		{
			stream: "account_profile",
			data: {
				id: "account_profile",
				workspace_count: 2,
				admin_workspace_count: 1,
				export_window_from: "2023-11-15",
				export_window_to: "2026-11-15",
				expense_count: 1,
				report_count: 1,
				reimbursement_count: 1,
				earliest_expense_date: "2025-01-01",
				latest_expense_date: "2025-01-01",
			},
		},
	]);
	assert.deepEqual(
		h.coverage().map((row) => [row.stream, row.considered, row.covered]),
		[
			["workspaces", 2, 2],
			["account_profile", 1, 1],
		],
	);
});

test("export-only streams never request policies", async () => {
	const h = harness();
	h.deps.client.listPolicies = async () => {
		throw new Error("unrequested policies");
	};
	await collectExpensify(h.deps);
	assert.equal(h.ranges.length, 1);
});

test("workspaces alone never requests an export", async () => {
	const h = harness(fixture, ["workspaces"]);
	h.deps.client.exportRange = async () => {
		throw new Error("unrequested export");
	};
	await collectExpensify(h.deps);
	assert.equal(h.policyCalls(), 1);
	assert.deepEqual(
		h.records.map((row) => row.stream),
		["workspaces", "workspaces"],
	);
	assert.deepEqual(h.ranges, []);
});

test("policy-list failure is rethrown unchanged before any success evidence", async () => {
	const h = harness(fixture, ["workspaces", "account_profile"]);
	const failure = Object.assign(new Error("policy failed"), {
		code: "expensify_request_failed",
		retryable: true,
	});
	h.deps.client.listPolicies = async () => {
		throw failure;
	};
	await assert.rejects(collectExpensify(h.deps), (error) => error === failure);
	assert.deepEqual([h.records, h.messages, h.progress], [[], [], []]);
});

test("an empty profile is a singleton with zero counts and null expense dates", async () => {
	const h = harness("", ["account_profile"]);
	h.deps.client.listPolicies = async () => [];
	await collectExpensify(h.deps);
	assert.deepEqual(h.records, [
		{
			stream: "account_profile",
			data: {
				id: "account_profile",
				workspace_count: 0,
				admin_workspace_count: 0,
				export_window_from: "2023-11-15",
				export_window_to: "2026-11-15",
				expense_count: 0,
				report_count: 0,
				reimbursement_count: 0,
				earliest_expense_date: null,
				latest_expense_date: null,
			},
		},
	]);
	assert.deepEqual(
		h.coverage().map((row) => [row.considered, row.covered]),
		[[1, 1]],
	);
});

test("partial exports do not claim a complete profile and carry retry recovery", async () => {
	const h = harness(fixture + "\nINVALID", ["account_profile", "expenses"]);
	await collectExpensify(h.deps);
	const profile = h.coverage().find((row) => row.stream === "account_profile");
	assert.equal(profile?.considered, 1);
	assert.equal(profile?.covered, 0);
	for (const message of h.messages.filter(
		(row) => row.type === "SKIP_RESULT",
	)) {
		assert.deepEqual(message.recovery_hint, {
			action: "retry_by_runtime",
			retryable: true,
		});
	}
	assert.equal(
		h.messages.filter((row) => row.type === "SKIP_RESULT").length,
		2,
	);
});

test("no requested streams makes neither client call", async () => {
	const h = harness(fixture, []);
	await collectExpensify(h.deps);
	assert.equal(h.policyCalls(), 0);
	assert.deepEqual([h.ranges, h.records, h.messages], [[], [], []]);
});

test("profile expense dates are extrema of accepted rows, ignoring missing dates", async () => {
	const text = [
		{
			kind: "expense",
			transactionID: "late",
			reportID: "r",
			created: "2025-05-03",
		},
		{ kind: "expense", transactionID: "missing", reportID: "r" },
		{
			kind: "expense",
			transactionID: "early",
			reportID: "r",
			created: "2024-02-01",
		},
	]
		.map((row) => JSON.stringify(row))
		.join("\n");
	const h = harness(text, ["account_profile"]);
	await collectExpensify(h.deps);
	assert.equal(h.records[0]!.data.expense_count, 3);
	assert.equal(h.records[0]!.data.earliest_expense_date, "2024-02-01");
	assert.equal(h.records[0]!.data.latest_expense_date, "2025-05-03");
	assert.equal(h.policyCalls(), 1);
});

test("out-of-range UTC window is classified before fetching or emitting", async () => {
	const h = harness(fixture, ["expenses", "workspaces", "account_profile"]);
	h.deps.now = () => new Date("9999-12-31T00:00:00Z");
	h.deps.years = 10000;
	await assert.rejects(collectExpensify(h.deps), (error: unknown) => {
		assert.ok(error instanceof Error);
		assert.equal(error.name, "TerminalError");
		assert.equal("code" in error && error.code, "expensify_invalid_window");
		assert.equal("retryable" in error && error.retryable, false);
		assert.deepEqual("recoveryHint" in error && error.recoveryHint, {
			action: "manual_action_required",
			retryable: false,
		});
		return true;
	});
	assert.equal(h.policyCalls(), 0);
	assert.deepEqual(
		[h.ranges, h.records, h.messages, h.progress],
		[[], [], [], []],
	);
});

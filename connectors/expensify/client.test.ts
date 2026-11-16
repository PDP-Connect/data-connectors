// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
	createExpensifyClient,
	createRequestPacer,
	retryAfterDelay,
} from "./client.ts";
import { EXPORT_TEMPLATE } from "./template.ts";

test("pacer enforces both rolling limits for concurrent requests", async () => {
	let clock = 0;
	const starts: number[] = [];
	const pacer = createRequestPacer({
		now: () => clock,
		sleep: async (milliseconds) => {
			clock += milliseconds;
		},
	});
	await Promise.all(
		Array.from({ length: 25 }, () =>
			pacer.run(async () => {
				starts.push(clock);
			}),
		),
	);
	assert.equal(starts[5], 10_000);
	assert.equal(starts[20], 60_000);
	for (const end of starts) {
		assert.ok(
			starts.filter((at) => at > end - 10_000 && at <= end).length <= 5,
		);
		assert.ok(
			starts.filter((at) => at > end - 60_000 && at <= end).length <= 20,
		);
	}
});

test("failed requests consume quota without blocking later queued requests", async () => {
	let clock = 0;
	const starts: number[] = [];
	const pacer = createRequestPacer({
		now: () => clock,
		sleep: async (milliseconds) => {
			clock += milliseconds;
		},
	});
	await assert.rejects(
		pacer.run(async () => {
			starts.push(clock);
			throw new Error("synthetic transport failure");
		}),
		/synthetic transport failure/,
	);
	for (let i = 0; i < 5; i++) {
		await pacer.run(async () => {
			starts.push(clock);
		});
	}
	assert.deepEqual(starts, [0, 0, 0, 0, 0, 10_000]);
});

test("Retry-After handles delay, HTTP date, elapsed date and fallback", () => {
	const clock = Date.UTC(2026, 0, 1);
	assert.equal(retryAfterDelay("2", clock), 2000);
	assert.equal(retryAfterDelay("0", clock), 0);
	assert.equal(
		retryAfterDelay(new Date(clock + 3000).toUTCString(), clock),
		3000,
	);
	assert.equal(retryAfterDelay(new Date(clock - 3000).toUTCString(), clock), 0);
	for (const value of [null, "", "not-a-date"]) {
		assert.equal(retryAfterDelay(value, clock), 10_000);
	}
});

const SYNTHETIC_SECRET = "fixture-only-not-a-real-credential";
const credentials = {
	partnerUserID: "fixture-user",
	partnerUserSecret: SYNTHETIC_SECRET,
};
const dates = { startDate: "2026-01-01", endDate: "2026-01-02" };

function fixture(
	replies: Array<{ status: number; body: string; retryAfter?: string } | Error>,
) {
	let clock = 0;
	const calls: Array<{ url: string; init: RequestInit; at: number }> = [];
	const sleeps: number[] = [];
	const client = createExpensifyClient({
		...credentials,
		now: () => clock,
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
		fetch: async (url, init) => {
			calls.push({ url, init, at: clock });
			const reply = replies.shift();
			assert.ok(reply, "unexpected request");
			if (reply instanceof Error) throw reply;
			return {
				status: reply.status,
				headers: new Headers(
					reply.retryAfter === undefined
						? {}
						: { "Retry-After": reply.retryAfter },
				),
				text: async () => reply.body,
			};
		},
	});
	return { client, calls, sleeps };
}
function form(call: { init: RequestInit }) {
	return new URLSearchParams(String(call.init.body));
}
function job(call: { init: RequestInit }) {
	return JSON.parse(form(call).get("requestJobDescription")!);
}
function safeError(
	error: unknown,
	code: string,
	status: string,
	retryable: boolean,
) {
	assert.ok(error instanceof Error);
	assert.equal(error.name, "TerminalError");
	assert.equal("code" in error && error.code, code);
	assert.equal("retryable" in error && error.retryable, retryable);
	assert.deepEqual("recoveryHint" in error && error.recoveryHint, {
		action: retryable ? "retry_by_runtime" : "manual_action_required",
		retryable,
	});
	assert.ok(error.message.includes(status));
	assert.ok(!error.message.includes(SYNTHETIC_SECRET));
	return true;
}

test("file and download use exact form jobs and return rendered text", async () => {
	const f = fixture([
		{ status: 200, body: " random.txt\n" },
		{ status: 200, body: '{"kind":"report"}\n' },
	]);
	assert.equal(await f.client.exportReports(dates), '{"kind":"report"}\n');
	assert.equal(f.calls.length, 2);
	for (const call of f.calls) {
		assert.equal(
			call.url,
			"https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations",
		);
		assert.equal(call.init.method, "POST");
		assert.deepEqual(call.init.headers, {
			"Content-Type": "application/x-www-form-urlencoded",
		});
		assert.equal(call.init.redirect, "error");
	}
	assert.deepEqual([...form(f.calls[0]!).keys()].sort(), [
		"requestJobDescription",
		"template",
	]);
	assert.equal(form(f.calls[0]!).get("template"), EXPORT_TEMPLATE);
	assert.deepEqual(job(f.calls[0]!), {
		type: "file",
		credentials,
		onReceive: { immediateResponse: ["returnRandomFileName"] },
		inputSettings: { type: "combinedReportData", filters: dates },
		outputSettings: { fileExtension: "txt" },
	});
	assert.deepEqual([...form(f.calls[1]!).keys()], ["requestJobDescription"]);
	assert.deepEqual(job(f.calls[1]!), {
		type: "download",
		credentials,
		fileName: "random.txt",
		fileSystem: "integrationServer",
	});
});

test("400 inclusive days split into 365 and 35 days without overlap", async () => {
	const f = fixture([
		{ status: 200, body: "first.txt" },
		{ status: 200, body: "first" },
		{ status: 200, body: "second.txt" },
		{ status: 200, body: "second" },
	]);
	assert.equal(
		await f.client.exportRange({ from: "2025-01-01", to: "2026-02-04" }),
		"first\nsecond",
	);
	assert.equal(f.calls.length, 4);
	assert.deepEqual(job(f.calls[0]!).inputSettings.filters, {
		startDate: "2025-01-01",
		endDate: "2025-12-31",
	});
	assert.deepEqual(job(f.calls[2]!).inputSettings.filters, {
		startDate: "2026-01-01",
		endDate: "2026-02-04",
	});
});

test("429 waits Retry-After and retries the identical job", async () => {
	const f = fixture([
		{ status: 429, body: SYNTHETIC_SECRET, retryAfter: "2" },
		{ status: 200, body: "file" },
		{ status: 200, body: "export" },
	]);
	assert.equal(await f.client.exportReports(dates), "export");
	assert.deepEqual(f.sleeps, [2000]);
	assert.deepEqual(
		f.calls.map((c) => c.at),
		[0, 2000, 2000],
	);
	assert.equal(f.calls[0]!.init.body, f.calls[1]!.init.body);
});

test("four 429 responses exhaust three retries with safe error", async () => {
	const f = fixture(
		Array.from({ length: 4 }, () => ({ status: 429, body: SYNTHETIC_SECRET })),
	);
	await assert.rejects(f.client.exportReports(dates), (e) =>
		safeError(e, "expensify_request_failed", "429", true),
	);
	assert.equal(f.calls.length, 4);
	assert.deepEqual(f.sleeps, [10_000, 10_000, 10_000]);
});

for (const [status, responseCode] of [
	[401, undefined],
	[407, undefined],
	[200, 401],
	[200, 407],
	[200, 500],
	[500, undefined],
	[403, undefined],
] as const) {
	test(`classifies HTTP ${status} responseCode ${responseCode} without echoing a secret`, async () => {
		const rejected =
			status === 401 ||
			status === 407 ||
			responseCode === 401 ||
			responseCode === 407;
		const f = fixture([
			{
				status,
				body: JSON.stringify({
					responseCode,
					responseMessage: SYNTHETIC_SECRET,
				}),
			},
		]);
		await assert.rejects(f.client.exportReports(dates), (e) =>
			safeError(
				e,
				rejected
					? "expensify_credentials_rejected"
					: "expensify_request_failed",
				String(responseCode ?? status),
				!rejected && (status === 500 || responseCode === 500),
			),
		);
		assert.equal(f.calls.length, 1);
		assert.deepEqual(f.sleeps, []);
	});
}

test("transport exceptions are replaced rather than leaked", async () => {
	const f = fixture([new Error(SYNTHETIC_SECRET)]);
	await assert.rejects(f.client.exportReports(dates), (e) =>
		safeError(e, "expensify_request_failed", "HTTP unavailable", true),
	);
});

test("file, download and concurrent exports share the same pacing quota", async () => {
	const f = fixture(
		Array.from({ length: 6 }, () => ({ status: 200, body: "fixture" })),
	);
	await Promise.all(
		Array.from({ length: 3 }, () => f.client.exportReports(dates)),
	);
	assert.equal(f.calls.length, 6);
	assert.deepEqual(
		f.calls.map((c) => c.at),
		[0, 0, 0, 0, 0, 10_000],
	);
});

test("invalid and reversed date ranges never dispatch", async () => {
	const f = fixture([]);
	for (const range of [
		{ from: "2026-02-30", to: "2026-03-01" },
		{ from: "2026-01-02", to: "2026-01-01" },
	]) {
		await assert.rejects(f.client.exportRange(range), /HTTP unavailable/);
	}
	assert.deepEqual(f.calls, []);
});

test("policy list uses the exact get job and drops owner", async () => {
	const policies = [
		{
			id: "p1",
			name: "First",
			type: "team",
			role: "admin",
			outputCurrency: "USD",
			owner: "synthetic@example.invalid",
		},
		{
			id: "p2",
			name: "Second",
			type: null,
			role: null,
			outputCurrency: null,
			owner: "other@example.invalid",
		},
	];
	const f = fixture([
		{
			status: 200,
			body: JSON.stringify({ responseCode: 200, policyList: policies }),
		},
	]);
	assert.deepEqual(await f.client.listPolicies(), [
		{
			id: "p1",
			name: "First",
			type: "team",
			role: "admin",
			outputCurrency: "USD",
		},
		{ id: "p2", name: "Second", type: null, role: null, outputCurrency: null },
	]);
	assert.equal(f.calls.length, 1);
	const call = f.calls[0]!;
	assert.equal(
		call.url,
		"https://integrations.expensify.com/Integration-Server/ExpensifyIntegrations",
	);
	assert.equal(call.init.method, "POST");
	assert.equal(call.init.redirect, "error");
	assert.deepEqual(call.init.headers, {
		"Content-Type": "application/x-www-form-urlencoded",
	});
	assert.equal(
		call.init.body,
		new URLSearchParams({
			requestJobDescription: JSON.stringify({
				type: "get",
				inputSettings: { type: "policyList" },
				credentials,
			}),
		}).toString(),
	);
});

test("empty policy list is valid and 429 retries the identical job once", async () => {
	const f = fixture([
		{ status: 429, body: "synthetic rate limit", retryAfter: "2" },
		{
			status: 200,
			body: JSON.stringify({ responseCode: 200, policyList: [] }),
		},
	]);
	assert.deepEqual(await f.client.listPolicies(), []);
	assert.equal(f.calls.length, 2);
	assert.deepEqual(f.sleeps, [2000]);
	assert.deepEqual(
		f.calls.map((call) => call.at),
		[0, 2000],
	);
	assert.equal(f.calls[0]!.init.body, f.calls[1]!.init.body);
});

test("malformed policies fail typed without exposing the response", async () => {
	const valid = {
		id: "p",
		name: "Policy",
		type: null,
		role: null,
		outputCurrency: null,
	};
	const malformed: unknown[] = [
		null,
		[],
		{},
		{ policyList: [] },
		{ responseCode: "200", policyList: [] },
		{ responseCode: 200, policyList: {} },
	];
	for (const bad of [
		null,
		[],
		"bad",
		{ ...valid, id: "" },
		{ ...valid, name: "" },
		{ ...valid, id: 4 },
		{ ...valid, name: false },
		{ ...valid, type: 7 },
		{ ...valid, role: {} },
		{ ...valid, outputCurrency: [] },
		{ id: "p", name: "Policy" },
	]) {
		malformed.push({
			responseCode: 200,
			policyList: [valid, bad],
			marker: "POLICY_BODY_MARKER",
		});
	}
	const bodies = [
		"POLICY_BODY_MARKER",
		...malformed.map((value) => JSON.stringify(value)),
	];
	// Each body gets its own fixture, so the cases are independent.
	await Promise.all(
		bodies.map(async (body) => {
			const f = fixture([{ status: 200, body }]);
			await assert.rejects(f.client.listPolicies(), (error) => {
				safeError(error, "expensify_request_failed", "200", false);
				assert.ok(
					error instanceof Error &&
						!error.message.includes("POLICY_BODY_MARKER"),
				);
				return true;
			});
			assert.equal(f.calls.length, 1);
		}),
	);
});

test("policy requests consume the same pacer as exports", async () => {
	const f = fixture([
		...Array.from({ length: 4 }, () => ({
			status: 200,
			body: '{"responseCode":200,"policyList":[]}',
		})),
		{ status: 200, body: "file" },
		{ status: 200, body: "export" },
	]);
	// In order on purpose: the pacer quota is what this test observes.
	await f.client.listPolicies();
	await f.client.listPolicies();
	await f.client.listPolicies();
	await f.client.listPolicies();
	assert.equal(await f.client.exportReports(dates), "export");
	assert.deepEqual(
		f.calls.map((call) => call.at),
		[0, 0, 0, 0, 0, 10_000],
	);
});

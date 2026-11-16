// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { StreamScope } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { collect, connectorConfig } from "./index.ts";
import {
	accountProfileSchema,
	expensesSchema,
	reimbursementsSchema,
	reportsSchema,
	workspacesSchema,
} from "./schemas.ts";

const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);
const streams = ["expenses", "reports", "reimbursements"];
const allStreams = [...streams, "workspaces", "account_profile"];
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
const now = () => new Date("2026-11-15T23:59:59Z");
type Context = Parameters<typeof collect>[0];
function harness(requested = streams, failure?: Error) {
	const records: {
		stream: string;
		data: Parameters<Context["emitRecord"]>[1];
	}[] = [];
	const messages: Parameters<Context["emit"]>[0][] = [];
	const ranges: { from: string; to: string }[] = [];
	const progress: string[] = [];
	const factoryOptions: Parameters<
		NonNullable<Parameters<typeof collect>[1]>
	>[0][] = [];
	const ctx: Context = {
		credentials: {
			EXPENSIFY_PARTNER_USER_ID: "fixture-user",
			EXPENSIFY_PARTNER_USER_SECRET: "fixture-only-not-a-real-credential",
		},
		requested: new Map(
			requested.map((stream): [string, StreamScope] => [
				stream,
				{ name: stream },
			]),
		),
		emitRecord: async (stream, data) => {
			records.push({ stream, data });
		},
		emit: async (message) => {
			messages.push(message);
		},
		progress: async (line) => {
			progress.push(line);
		},
	};
	const factory: NonNullable<Parameters<typeof collect>[1]> = (options) => {
		factoryOptions.push(options);
		return {
			async exportRange(range) {
				ranges.push(range);
				if (failure) throw failure;
				return fixture;
			},
			// One synthetic policy, so a request for workspaces or account_profile
			// emits records the manifest checks below can inspect.
			async listPolicies() {
				return [
					{
						id: "POLICY0001",
						name: "Sample Workspace",
						type: "corporate",
						role: "admin",
						outputCurrency: "USD",
					},
				];
			},
		};
	};
	return { ctx, factory, records, messages, ranges, progress, factoryOptions };
}
async function withHistory(value: string | undefined, fn: () => Promise<void>) {
	const saved = process.env.EXPENSIFY_HISTORY_YEARS;
	try {
		if (value === undefined) delete process.env.EXPENSIFY_HISTORY_YEARS;
		else process.env.EXPENSIFY_HISTORY_YEARS = value;
		await fn();
	} finally {
		if (saved === undefined) delete process.env.EXPENSIFY_HISTORY_YEARS;
		else process.env.EXPENSIFY_HISTORY_YEARS = saved;
	}
}

test("expensify registration identity matches entrypoint", async () => {
	assert.equal(manifest.connector_key, connectorConfig.name);
	assert.equal(connectorConfig.collect, collect);
	assert.deepEqual(
		manifest.streams.map((stream: { name: string }) => stream.name),
		allStreams,
	);
	assert.deepEqual(connectorConfig.auth.required, [
		["EXPENSIFY_PARTNER_USER_ID"],
		["EXPENSIFY_PARTNER_USER_SECRET"],
	]);
	await withHistory(undefined, async () => {
		const h = harness();
		await connectorConfig.collect(h.ctx, h.factory, now);
		assert.deepEqual(
			h.records.map(({ stream }) => stream),
			streams,
		);
		assert.deepEqual(h.ranges, [{ from: "2023-11-15", to: "2026-11-15" }]);
	});
});

test("expensify requested streams stay isolated", async () => {
	await withHistory(undefined, async () => {
		const h = harness(["reports"]);
		await collect(h.ctx, h.factory, now);
		assert.deepEqual(
			h.records.map(({ stream, data }) => [stream, data.id]),
			[["reports", "report-1"]],
		);
		assert.deepEqual(
			h.messages
				.filter((message) => message.type === "DETAIL_COVERAGE")
				.map((message) => message.stream),
			["reports"],
		);
	});
});

test("expensify invalid history fails before transport", async () => {
	for (const value of [
		"0",
		"-1",
		"2.5",
		"not-a-number",
		"2027",
		"9007199254740992",
	]) {
		await withHistory(value, async () => {
			const h = harness();
			await assert.rejects(
				collect(h.ctx, h.factory, now),
				/positive safe integer|fit UTC years/,
			);
			assert.deepEqual(h.ranges, []);
			assert.deepEqual(h.records, []);
			assert.deepEqual(h.messages, []);
			assert.deepEqual(h.progress, []);
		});
	}
});

test("expensify client failure never reports successful full scan", async () => {
	await withHistory(undefined, async () => {
		const failure = Object.assign(new Error("credentials rejected"), {
			code: "credentials_rejected",
			retryable: false,
		});
		const h = harness(streams, failure);
		await assert.rejects(
			collect(h.ctx, h.factory, now),
			(error: unknown) => error === failure,
		);
		assert.equal(h.ranges.length, 1);
		assert.deepEqual(h.records, []);
		assert.deepEqual(h.messages, []);
	});
});

test("expensify manifest schemas match emitted records", async () => {
	await withHistory(undefined, async () => {
		const h = harness(allStreams);
		await collect(h.ctx, h.factory, now);
		assert.deepEqual(h.records.map(({ stream }) => stream).sort(), [
			"account_profile",
			"expenses",
			"reimbursements",
			"reports",
			"workspaces",
		]);
		const schemas = {
			expenses: expensesSchema,
			reports: reportsSchema,
			reimbursements: reimbursementsSchema,
			workspaces: workspacesSchema,
			account_profile: accountProfileSchema,
		};
		for (const { stream, data } of h.records) {
			const declared = manifest.streams.find(
				(item: { name: string }) => item.name === stream,
			);
			assert.ok(declared);
			assert.deepEqual(
				Object.keys(data).sort(),
				Object.keys(declared.schema.properties).sort(),
			);
			assert.deepEqual(
				declared.schema.required.slice().sort(),
				Object.keys(data).sort(),
			);
			schemas[stream as keyof typeof schemas].parse(data);
			for (const [key, value] of Object.entries(data)) {
				const property = declared.schema.properties[key];
				const types = Array.isArray(property.type)
					? property.type
					: [property.type];
				const actual =
					value === null
						? "null"
						: typeof value === "number" && Number.isInteger(value)
							? "integer"
							: typeof value;
				assert.ok(types.includes(actual), stream + "." + key);
				if (property.enum) assert.ok(property.enum.includes(value));
				if (property.const !== undefined) assert.equal(value, property.const);
				if (typeof value === "string" && property.pattern)
					assert.match(value, new RegExp(property.pattern));
			}
		}
		assert.equal(
			h.records.find(({ stream }) => stream === "reimbursements")?.data
				.amount_source,
			"report_total",
		);
		assert.deepEqual(
			Object.fromEntries(
				manifest.streams.map(
					(stream: { name: string; consent_time_field: string }) => [
						stream.name,
						stream.consent_time_field,
					],
				),
			),
			{
				expenses: "expense_date",
				reports: "created_at",
				reimbursements: "reimbursed_at",
				// Current-state streams carry no consent-time field.
				workspaces: undefined,
				account_profile: undefined,
			},
		);
		for (const stream of manifest.streams) {
			assert.deepEqual(stream.primary_key, ["id"]);
			if (stream.consent_time_field !== undefined)
				assert.ok(stream.schema.properties[stream.consent_time_field]);
			for (const property of Object.values(stream.schema.properties) as {
				format?: string;
			}[]) {
				assert.notEqual(property.format, "date-time");
			}
		}
	});
});

test("expensify missing credentials fail before client construction", async () => {
	for (const key of [
		"EXPENSIFY_PARTNER_USER_ID",
		"EXPENSIFY_PARTNER_USER_SECRET",
	]) {
		for (const value of [undefined, "", " ", "\t"]) {
			const h = harness();
			h.ctx.credentials.EXPENSIFY_PARTNER_USER_ID = "synthetic-partner-id-7";
			h.ctx.credentials.EXPENSIFY_PARTNER_USER_SECRET = "synthetic-secret-9";
			if (value === undefined) delete h.ctx.credentials[key];
			else h.ctx.credentials[key] = value;
			let thrown = "";
			await assert.rejects(collect(h.ctx, h.factory, now), (error: unknown) => {
				thrown = String(error);
				assert.ok(error instanceof Error);
				assert.deepEqual("recoveryHint" in error && error.recoveryHint, {
					action: "manual_action_required",
					retryable: false,
				});
				return (
					error instanceof Error &&
					error.name === "TerminalError" &&
					"code" in error &&
					error.code === "expensify_credentials_missing" &&
					"retryable" in error &&
					error.retryable === false &&
					error.message === "expensify_credentials_missing"
				);
			});
			assert.deepEqual(h.factoryOptions, []);
			assert.deepEqual(h.ranges, []);
			const output = JSON.stringify([h.messages, h.progress, thrown]);
			assert.equal(output.includes("synthetic-partner-id-7"), false);
			assert.equal(output.includes("synthetic-secret-9"), false);
		}
	}
});

test("expensify credentials reach the factory unchanged without disclosure", async () => {
	await withHistory(undefined, async () => {
		for (const failure of [undefined, new Error("credentials rejected")]) {
			const h = harness(streams, failure);
			const id = " synthetic-partner-id-7 ";
			const secret = "\tsynthetic-secret-9 ";
			h.ctx.credentials.EXPENSIFY_PARTNER_USER_ID = id;
			h.ctx.credentials.EXPENSIFY_PARTNER_USER_SECRET = secret;
			let thrown = "";
			if (failure) {
				await assert.rejects(
					collect(h.ctx, h.factory, now),
					(error: unknown) => {
						thrown = String(error);
						return error === failure;
					},
				);
			} else {
				await collect(h.ctx, h.factory, now);
			}
			assert.equal(h.factoryOptions.length, 1);
			assert.equal(h.factoryOptions[0]?.partnerUserID, id);
			assert.equal(h.factoryOptions[0]?.partnerUserSecret, secret);
			const output = JSON.stringify([h.messages, h.progress, thrown]);
			assert.equal(output.includes("synthetic-partner-id-7"), false);
			assert.equal(output.includes("synthetic-secret-9"), false);
		}
	});
});

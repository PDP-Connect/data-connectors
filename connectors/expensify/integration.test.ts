// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { StreamScope } from "@pdpp/connector-protocol/connector-runtime-protocol";
import { collect, connectorConfig } from "./index.ts";
import {
	expensesSchema,
	reimbursementsSchema,
	reportsSchema,
} from "./schemas.ts";

const manifest = JSON.parse(
	readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);
const streams = ["expenses", "reports", "reimbursements"];
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
		progress: async () => {},
	};
	const factory: NonNullable<Parameters<typeof collect>[1]> = () => ({
		async exportRange(range) {
			ranges.push(range);
			if (failure) throw failure;
			return fixture;
		},
	});
	return { ctx, factory, records, messages, ranges };
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
		streams,
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
	await withHistory("0", async () => {
		const h = harness();
		await assert.rejects(
			collect(h.ctx, h.factory, now),
			/positive safe integer/,
		);
		assert.deepEqual(h.ranges, []);
		assert.deepEqual(h.records, []);
		assert.deepEqual(h.messages, []);
	});
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
		const h = harness();
		await collect(h.ctx, h.factory, now);
		assert.equal(h.records.length, 3);
		const schemas = {
			expenses: expensesSchema,
			reports: reportsSchema,
			reimbursements: reimbursementsSchema,
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
		for (const stream of manifest.streams) {
			assert.deepEqual(stream.primary_key, ["id"]);
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
	const h = harness();
	for (const key of [
		"EXPENSIFY_PARTNER_USER_ID",
		"EXPENSIFY_PARTNER_USER_SECRET",
	]) {
		const original = h.ctx.credentials[key];
		h.ctx.credentials[key] = "";
		let built = false;
		await assert.rejects(
			collect(
				h.ctx,
				() => {
					built = true;
					return h.factory({} as never);
				},
				now,
			),
			/expensify_credentials_missing/,
		);
		assert.equal(built, false);
		h.ctx.credentials[key] = original ?? "";
	}
});

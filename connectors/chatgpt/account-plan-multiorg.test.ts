// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { runAccountPlanStream } from "./index.ts";
const personal = {
	account: { account_id: "personal", plan_type: "plus", structure: "personal" },
};
const workspace = {
	account: {
		account_id: "workspace",
		plan_type: "team",
		structure: "workspace",
	},
};
test("account_plan enumerates personal plus workspace, deduplicating the session alias", async () => {
	const records: Record<string, unknown>[] = [],
		events: Record<string, unknown>[] = [];
	const deps = {
		api: {
			fetch: async () => ({
				status: 200,
				json: {
					accounts: { default: personal, personal, workspace },
					account_ordering: ["workspace", "personal"],
				},
			}),
		},
		emitRecord: async (_s: string, r: Record<string, unknown>) => {
			records.push(r);
		},
		emit: (e: Record<string, unknown>) => events.push(e),
	};
	await runAccountPlanStream(
		deps as unknown as Parameters<typeof runAccountPlanStream>[0],
	);
	assert.deepEqual(
		records.map((r) => [r.id, r.account_id, r.is_default]),
		[
			["account_plan", "personal", true],
			["account_plan:workspace", "workspace", false],
		],
	);
	const cursor = events.find((e) => e.type === "STATE")?.cursor;
	records.length = 0;
	await runAccountPlanStream(
		deps as unknown as Parameters<typeof runAccountPlanStream>[0],
		{ account_plan: cursor },
	);
	assert.deepEqual(records, []);
});
test("a malformed secondary account skips the stream without claiming coverage", async () => {
	const records: Record<string, unknown>[] = [],
		events: Record<string, unknown>[] = [];
	await runAccountPlanStream({
		api: {
			fetch: async () => ({
				status: 200,
				json: {
					accounts: {
						default: { account: { account_id: "p", plan_type: "plus" } },
						w: { account: {} },
					},
				},
			}),
		},
		emitRecord: async (_s: string, r: Record<string, unknown>) => {
			records.push(r);
		},
		emit: (e: Record<string, unknown>) => events.push(e),
	} as unknown as Parameters<typeof runAccountPlanStream>[0]);
	assert.deepEqual(records, []);
	const skip = events.find((e) => e.type === "SKIP_RESULT") as
		| { reason?: string; recovery_hint?: { retryable?: boolean } }
		| undefined;
	assert.equal(skip?.reason, "parse_error");
	assert.equal(skip?.recovery_hint?.retryable, true);
	assert.ok(
		events.every((e) => e.type !== "DETAIL_COVERAGE" && e.type !== "STATE"),
	);
});

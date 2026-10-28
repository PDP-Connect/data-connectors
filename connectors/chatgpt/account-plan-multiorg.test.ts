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

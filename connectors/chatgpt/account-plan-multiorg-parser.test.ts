// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import test from "node:test";
import { buildAccountPlanRecords } from "./parsers.ts";
import { accountPlanSchema } from "./schemas.ts";
test("all usable account plans retain session default and deduplicate aliases", () => {
	const personal = {
		account: { account_id: "p", plan_type: "plus", structure: "personal" },
	};
	const team = {
		account: { account_id: "t", plan_type: "team", structure: "workspace" },
	};
	const records = buildAccountPlanRecords({
		accounts: {
			default: personal,
			p: personal,
			t: team,
			t_alias: team,
			broken: null,
		},
		account_ordering: ["t", "p"],
	});
	assert.deepEqual(
		records.map((r) => [r.id, r.account_id, r.is_default]),
		[
			["account_plan", "p", true],
			["account_plan:t", "t", false],
		],
	);
	assert.ok(records.every((r) => accountPlanSchema.safeParse(r).success));
});
test("malformed present default never silently changes account identity", () => {
	assert.deepEqual(
		buildAccountPlanRecords({
			accounts: { default: null, t: { account: { account_id: "t" } } },
		}),
		[],
	);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../../workflows/cross-repo-integrity.yml", import.meta.url), "utf8");

test("runs freshness on every main push and daily", () => {
	assert.match(workflow, /  push:\n    branches: \[main\]\n  schedule:\n/);
	assert.doesNotMatch(workflow, /  push:\n    branches: \[main\]\n    paths:/);
	assert.match(workflow, /- cron: "0 6 \* \* \*"/);
});

test("computes consumer-side pin relevance from the PR diff", () => {
	assert.match(workflow, /data_connect_pin_backed=/);
	assert.match(workflow, /pdpp_pin_backed=/);
	assert.match(workflow, /PR_TOUCHES_PIN_BACKED_PATHS:/);
	assert.match(workflow, /GITHUB_EVENT_NAME.*pull_request.*PR_TOUCHES_PIN_BACKED_PATHS.*true/s);
});

test("neutralizes unrelated stale pins but fails actionable stale pins", () => {
	assert.match(workflow, /::notice::.*pin is stale/);
	assert.match(workflow, /requires_failure=false/);
	assert.match(workflow, /requires_failure=true/);
	assert.match(workflow, /name: Enforce freshness semantics/);
});

test("repin automation is write-scoped and idempotent", () => {
	assert.match(workflow, /pin-freshness:[\s\S]*?permissions:\n      contents: write\n      pull-requests: write/);
	assert.match(workflow, /chore\/repin-\$\{REPO_ID\}-\$\{SHORT_SHA\}/);
	assert.match(workflow, /update-pin\.mjs/);
	assert.match(workflow, /gh pr list --state open --head/);
	assert.match(workflow, /gh pr edit/);
	assert.match(workflow, /gh pr create/);
	assert.match(workflow, /gh label create repin/);
	assert.match(workflow, /Signed-off-by: github-actions\[bot\]/);
});

test("the aggregate gate requires a successful freshness job", () => {
	assert.match(workflow, /needs: \[changes, read-pins, drift-checks, pin-freshness\]/);
	assert.match(workflow, /PIN_FRESHNESS_RESULT/);
	assert.match(workflow, /for result_name in \"READ_PINS_RESULT:\$READ_PINS_RESULT\" \"PIN_FRESHNESS_RESULT:\$PIN_FRESHNESS_RESULT\"/);
	assert.match(workflow, /\$name reported '\$result'/);
});

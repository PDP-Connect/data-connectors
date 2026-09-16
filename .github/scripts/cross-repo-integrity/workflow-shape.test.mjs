// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const workflow = readFileSync(new URL("../../workflows/cross-repo-integrity.yml", import.meta.url), "utf8");
const parsedWorkflow = parse(workflow);
const freshnessSteps = parsedWorkflow.jobs["pin-freshness"].steps;

function checkoutProvidesComparator(step) {
	if (!step.uses?.startsWith("actions/checkout@")) {
		return false;
	}

	const sparsePaths = step.with?.["sparse-checkout"];
	return sparsePaths?.includes(".github/scripts/cross-repo-integrity") ||
		(step.with?.ref === "main" && !sparsePaths);
}

function checkoutCoversTrigger(step, trigger) {
	if (!checkoutProvidesComparator(step)) {
		return false;
	}

	if (step.if === "github.event_name != 'push' && github.event_name != 'schedule'") {
		return trigger !== "push" && trigger !== "schedule";
	}

	return step.if === "github.event_name == 'push' || github.event_name == 'schedule'" &&
		(trigger === "push" || trigger === "schedule");
}

test("runs freshness on every main push and daily", () => {
	assert.match(workflow, /  push:\n    branches: \[main\]\n  schedule:\n/);
	assert.doesNotMatch(workflow, /  push:\n    branches: \[main\]\n    paths:/);
	assert.match(workflow, /- cron: "0 6 \* \* \*"/);
});

test("computes consumer-side pin relevance from the PR diff", () => {
	assert.match(workflow, /data_connect_pin_backed=/);
	assert.match(workflow, /pdpp_pin_backed=/);
	assert.match(workflow, /PR_TOUCHES_PIN_BACKED_PATHS:/);
	assert.match(workflow, /check-pin-freshness\.mjs/);
});

test("neutralizes unrelated stale pins but fails actionable stale pins", () => {
	assert.match(workflow, /check-pin-freshness\.mjs/);
	assert.match(workflow, /name: Enforce freshness semantics/);
	assert.match(workflow, /requires_failure/);
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
	assert.doesNotMatch(workflow, /merge it with the required vendored or registry changes/);
	assert.match(workflow, /repin-branch-policy\.mjs/);
	assert.match(workflow, /gh pr comment/);
	assert.match(workflow, /do not add vendored or registry repairs here/);
	assert.match(workflow, /gh pr close/);
	assert.match(workflow, /Superseded by the newer automated repin PR/);
});

test("every workflow trigger checks out the comparator", () => {
	const triggers = Object.keys(parsedWorkflow.on);
	assert.deepEqual(triggers.sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);

	for (const trigger of triggers) {
		assert.ok(
			freshnessSteps.some((step) => checkoutCoversTrigger(step, trigger)),
			`${trigger} must have a pin-freshness checkout containing the comparator`,
		);
	}
});

test("remote lookup failures stop refresh and older-candidate closure", () => {
	const repinRun = freshnessSteps.find((step) => step.name.startsWith("Open or update"))?.run;
	assert.ok(repinRun);
	assert.match(repinRun, /remote_ref_exists\(\)/);
	assert.match(repinRun, /BRANCH_LOOKUP_STATUS/);
	assert.match(repinRun, /OLD_BRANCH_LOOKUP_STATUS/);
	assert.match(repinRun, /could not determine whether \$BRANCH exists/);
	assert.match(repinRun, /could not determine whether older branch \$OLD_BRANCH exists/);
});

test("freshness comparison delegates its four outcomes to the tested comparator", () => {
	assert.match(workflow, /check-pin-freshness\.mjs/);
	assert.match(workflow, /steps\.compare\.outputs\.repin == 'true'/);
});

test("the aggregate gate requires a successful freshness job", () => {
	assert.match(workflow, /needs: \[changes, read-pins, drift-checks, pin-freshness\]/);
	assert.match(workflow, /PIN_FRESHNESS_RESULT/);
	assert.match(workflow, /for result_name in \"READ_PINS_RESULT:\$READ_PINS_RESULT\" \"PIN_FRESHNESS_RESULT:\$PIN_FRESHNESS_RESULT\"/);
	assert.match(workflow, /\$name reported '\$result'/);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

export function assertOwnerCanaryProof({
	expectedIdentity,
	actualIdentity,
	activeIdentity,
	mutation,
	plan,
	selectedTestIdentities,
	result,
	receipt,
	ownerIdentity,
	ownerRunnerId,
	expectedMessage,
}) {
	assert.equal(
		actualIdentity,
		expectedIdentity,
		"canary canonical mutation mismatch",
	);
	assert.equal(
		activeIdentity,
		expectedIdentity,
		"Stryker did not activate the canonical canary",
	);
	assert.equal(plan.plan, "Run");
	assert.equal(plan.runOptions.mutantActivation, "runtime");
	assert.equal(plan.runOptions.activeMutant.id, mutation.id);
	assert.ok(
		selectedTestIdentities.includes(ownerIdentity),
		"native Stryker plan did not select the owner test",
	);
	assert.equal(mutation.status, "Killed");
	assert.ok(mutation.testsCompleted > 0);
	assert.ok(mutation.killedBy.includes(ownerRunnerId));
	assert.equal(result.id, mutation.id);
	assert.equal(result.status, "Killed");
	assert.ok(result.testsCompleted > 0);
	assert.equal(receipt.activeMutantId, mutation.id);
	assert.equal(
		receipt.file,
		"connectors/groupme/incremental-frontier.vitest.ts",
	);
	assert.equal(receipt.name, ownerIdentity.split("#").at(-1));
	assert.equal(receipt.state, "fail");
	assert.ok(receipt.errors.length > 0);
	assert.ok(
		receipt.errors.some(
			({ message, actual, expected, stack }) =>
				message.includes(expectedMessage) &&
				message.includes("false !== true") &&
				String(actual) === "false" &&
				String(expected) === "true" &&
				/incremental-frontier\.vitest\.ts:65[3-7]\b/.test(stack ?? ""),
		),
		"native owner result lacks the failed custom assertion, false !== true, or source location",
	);
}

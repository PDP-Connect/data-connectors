// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

export function assertOwnerCanaryProof({
	expectedIdentity,
	actualIdentity,
	activeIdentity,
	mutation,
	plan,
	result,
	ownerName,
	expectedMessage,
	failureLocation,
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
	assert.equal(plan.runOptions.mutantActivation, "static");
	assert.equal(plan.mutant.id, mutation.id);
	assert.equal(plan.runOptions.activeMutant.id, mutation.id);
	assert.equal(mutation.status, "Killed");
	assert.equal(mutation.testsCompleted, 1);
	assert.equal(result.id, mutation.id);
	assert.equal(result.status, "Killed");
	assert.equal(result.testsCompleted, 1);

	for (const witness of [
		ownerName,
		expectedMessage,
		"false !== true",
		failureLocation,
	]) {
		assert.ok(
			mutation.statusReason.includes(witness),
			`Stryker mutation report lacks owner assertion witness: ${witness}`,
		);
		assert.ok(
			result.statusReason.includes(witness),
			`Stryker event lacks owner assertion witness: ${witness}`,
		);
	}
}

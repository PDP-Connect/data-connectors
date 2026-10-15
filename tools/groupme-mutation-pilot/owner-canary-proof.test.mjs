// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { assertOwnerCanaryProof } from "./owner-canary-proof.mjs";

const ownerName =
	"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
const expectedMessage =
	"a non-ascending forward page must fail, not be silently trusted";
const identity = "canonical-equality-mutant";
const valid = {
	expectedIdentity: identity,
	actualIdentity: identity,
	activeIdentity: identity,
	mutation: {
		id: "mutant-1",
		status: "Killed",
		testsCompleted: 1,
		statusReason: `${ownerName}\n${expectedMessage}\nfalse !== true\n❯ connectors/groupme/incremental-frontier.vitest.ts:654:11`,
	},
	plan: {
		plan: "Run",
		mutant: { id: "mutant-1" },
		runOptions: {
			activeMutant: { id: "mutant-1" },
			mutantActivation: "static",
		},
	},
	result: {
		id: "mutant-1",
		status: "Killed",
		testsCompleted: 1,
		statusReason: `${ownerName}\n${expectedMessage}\nfalse !== true\n❯ connectors/groupme/incremental-frontier.vitest.ts:654:11`,
	},
	ownerName,
	expectedMessage,
	failureLocation: "incremental-frontier.vitest.ts:654",
};

test("accepts the exact active mutation killed by the owner's failed assertion", () => {
	assertOwnerCanaryProof(valid);
});

test("rejects the owner title followed by an unrelated failure", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			result: { ...valid.result, statusReason: `${ownerName}\nother failure` },
		}),
	);
});

test("rejects a failure from another test", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			mutation: {
				...valid.mutation,
				statusReason: "unrelated setup test failed",
			},
		}),
	);
});

test("rejects setup errors", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			result: {
				...valid.result,
				status: "Error",
				statusReason: "setup failed",
			},
		}),
	);
});

test("rejects a zero-test result", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			mutation: { ...valid.mutation, testsCompleted: 0 },
		}),
	);
});

test("rejects a canonical mutation mismatch", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({ ...valid, activeIdentity: "different-mutant" }),
	);
});

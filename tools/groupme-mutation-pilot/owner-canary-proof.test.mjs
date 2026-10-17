// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { assertOwnerCanaryProof } from "./owner-canary-proof.mjs";

const ownerName =
	"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError";
const ownerIdentity = `connectors/groupme/incremental-frontier.test.ts#${ownerName}`;
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
		testsCompleted: 6,
		killedBy: ["owner-id"],
	},
	plan: {
		plan: "Run",
		runOptions: {
			activeMutant: { id: "mutant-1" },
			mutantActivation: "runtime",
			testFilter: ["owner-id"],
		},
	},
	selectedTestIdentities: [ownerIdentity],
	result: { id: "mutant-1", status: "Killed", testsCompleted: 6 },
	receipt: {
		activeMutantId: "mutant-1",
		file: "connectors/groupme/incremental-frontier.vitest.ts",
		name: ownerName,
		state: "fail",
		errors: [
			{
				message: `${expectedMessage}\n\nfalse !== true`,
				actual: "false",
				expected: "true",
				stack: "at incremental-frontier.vitest.ts:654:11",
			},
		],
	},
	ownerIdentity,
	ownerRunnerId: "owner-id",
	expectedMessage,
};

test("accepts the native active-mutant owner failure receipt", () => {
	assertOwnerCanaryProof(valid);
});

test("rejects a title-only receipt followed by an unrelated assertion", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			receipt: {
				...valid.receipt,
				errors: [{ message: "different assertion failed" }],
			},
		}),
	);
});

test("rejects an owner that passed under the active mutation", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			receipt: { ...valid.receipt, state: "pass" },
		}),
	);
});

test("rejects a failure from setup or a different test", () => {
	for (const receipt of [
		{ ...valid.receipt, file: "setup.ts" },
		{ ...valid.receipt, name: "unrelated test" },
	]) {
		assert.throws(() => assertOwnerCanaryProof({ ...valid, receipt }));
	}
});

test("rejects an unselected owner test", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			selectedTestIdentities: ["other.ts#other"],
		}),
	);
});

test("rejects setup errors and zero completed tests", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			receipt: { ...valid.receipt, state: "fail", errors: [] },
		}),
	);
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			result: { ...valid.result, testsCompleted: 0 },
		}),
	);
});

test("rejects an active mutant identity mismatch", () => {
	assert.throws(() =>
		assertOwnerCanaryProof({ ...valid, activeIdentity: "different-mutant" }),
	);
	assert.throws(() =>
		assertOwnerCanaryProof({
			...valid,
			receipt: { ...valid.receipt, activeMutantId: "different-mutant" },
		}),
	);
});

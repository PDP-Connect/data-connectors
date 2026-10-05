// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the derivation and hint-gate rules in
 * `failure-diagnosis.ts`. The design note's named incidents are replayed as
 * whole run summaries through `bin/diagnose.ts` in `bin/diagnose.test.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { type DiagnosisInput, diagnoseRun } from "./failure-diagnosis.ts";
import type { RunRecord, RunRecordFact } from "./observation.ts";

const DESCRIPTORS = {
	steps: [{ id: "sign_in" }],
	expectations: [{ id: "email_input", step: "sign_in" }],
	rules: [{ id: "password_rejected", kind: "auth" as const }],
};

function record(
	facts: RunRecordFact[],
	overrides: Partial<RunRecord> = {},
): RunRecord {
	return {
		protocol_capabilities: ["OBSERVATION"],
		diagnostic_descriptors: DESCRIPTORS,
		facts,
		truncated: false,
		process_exit: { code: 1, signal: null },
		...overrides,
	};
}

function failed(
	runRecord: RunRecord | undefined,
	error: Partial<NonNullable<DiagnosisInput["done"]["error"]>> = {},
): DiagnosisInput {
	return {
		connector: "example",
		done: {
			status: "failed",
			error: { message: "example failure", retryable: false, ...error },
		},
		run_record: runRecord,
	};
}

const HIDDEN: RunRecordFact = {
	source: "connector",
	id: "o1",
	fact: "element_expectation",
	step: "sign_in",
	attrs: {
		expectation: "email_input",
		states_seen: ["hidden"],
		final: "hidden",
	},
};
const AUTH_CLAIM: RunRecordFact = {
	source: "connector",
	id: "o2",
	fact: "provider_message",
	step: "sign_in",
	attrs: { kind: "auth_failure" },
};
const REJECTED: RunRecordFact = {
	source: "runtime",
	id: "r1",
	fact: "credential_submission",
	step: "sign_in",
	attrs: {
		attempt: "a1",
		account: "acct",
		outcome: "rejected",
		rule: "password_rejected",
	},
};

test("a connector-only auth_failure claim is the connector's report and unlocks nothing", () => {
	const diagnosis = diagnoseRun(
		failed(record([AUTH_CLAIM]), {
			basis: ["o2"],
			recovery_hint: "refresh_credentials",
		}),
	);
	assert.equal(diagnosis.cause?.category, "auth_rejected");
	assert.equal(diagnosis.cause?.attribution, "connector");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.deepEqual(
		diagnosis.gate_records.map((r) => r.attrs),
		[{ class: "hint_unsupported" }],
	);
});

test("a runtime rejection under an undeclared rule supports nothing and unlocks nothing", () => {
	const undeclared: RunRecordFact = {
		...REJECTED,
		attrs: { ...REJECTED.attrs, rule: "not_declared" },
	};
	const diagnosis = diagnoseRun(
		failed(record([undeclared]), { recovery_hint: "refresh_credentials" }),
	);
	assert.deepEqual(diagnosis.terminal_event, {
		fact: "r1",
		kind: "credential_submission",
	});
	assert.equal(diagnosis.cause?.category, "unknown");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
});

test("a later succeeded submission on the same account retires the rejection", () => {
	const succeeded: RunRecordFact = {
		...REJECTED,
		id: "r2",
		attrs: { attempt: "a2", account: "acct", outcome: "succeeded" },
	};
	const diagnosis = diagnoseRun(
		failed(record([REJECTED, succeeded]), {
			recovery_hint: "refresh_credentials",
		}),
	);
	assert.deepEqual(diagnosis.terminal_event, { kind: "failed_done" });
	assert.equal(diagnosis.facts[0]?.retired, true);
	assert.equal(diagnosis.cause?.category, "unknown");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
});

test("truncated evidence never authorizes an instruction", () => {
	const diagnosis = diagnoseRun(
		failed(record([REJECTED], { truncated: true }), {
			recovery_hint: "refresh_credentials",
		}),
	);
	assert.equal(diagnosis.cause?.category, "auth_rejected");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.match(diagnosis.hint?.why ?? "", /truncated/u);
});

test("a fact the failure does not cite is visible but out of scope", () => {
	// The owner finished sign-in by hand after the miss, and the run later
	// failed for another reason: the early mismatch must not become the cause.
	const diagnosis = diagnoseRun(failed(record([HIDDEN])));
	assert.equal(diagnosis.cause?.category, "unknown");
	assert.equal(diagnosis.facts[0]?.in_scope, false);
	assert.equal(diagnosis.facts.length, 1);
});

test("a connector fact retired by resolves is out of scope even when cited", () => {
	const resolves: RunRecordFact = {
		source: "connector",
		id: "o3",
		fact: "provider_message",
		attrs: { kind: "other" },
		resolves: ["o1"],
	};
	const diagnosis = diagnoseRun(
		failed(record([HIDDEN, resolves]), { basis: ["o1"] }),
	);
	assert.equal(diagnosis.facts[0]?.retired, true);
	assert.equal(diagnosis.cause?.category, "unknown");
});

test("an undeclared expectation or step supports no category", () => {
	const undeclared: RunRecordFact = {
		...HIDDEN,
		attrs: { ...HIDDEN.attrs, expectation: "password_input" },
	};
	const otherStep: RunRecordFact = { ...HIDDEN, id: "o2", step: "checkout" };
	const diagnosis = diagnoseRun(
		failed(record([undeclared, otherStep]), { basis: ["o1", "o2"] }),
	);
	assert.equal(diagnosis.cause?.category, "unknown");
});

test("a specific provider signal outranks expectation_mismatch, which contributes", () => {
	const diagnosis = diagnoseRun(
		failed(record([HIDDEN, AUTH_CLAIM]), { basis: ["o1", "o2"] }),
	);
	assert.equal(diagnosis.cause?.category, "auth_rejected");
	assert.deepEqual(diagnosis.contributing, [
		{
			attribution: "connector",
			basis: ["o1"],
			category: "expectation_mismatch",
			step: "sign_in",
		},
	]);
});

test("a protocol violation stays visible and the cause comes from the remaining facts", () => {
	const defect: RunRecordFact = {
		source: "runtime",
		id: "r1",
		fact: "connector_defect",
		attrs: {
			class: "protocol_violation",
			reason: "runtime_fact_type",
			count: 1,
		},
	};
	const diagnosis = diagnoseRun(
		failed(record([HIDDEN, defect]), { basis: ["o1"] }),
	);
	assert.equal(diagnosis.cause?.category, "expectation_mismatch");
	assert.equal(diagnosis.facts[1]?.fact.fact, "connector_defect");
});

test("not_retriable and unknown need no evidence; a non-portable action is rejected", () => {
	assert.equal(
		diagnoseRun(failed(record([]), { recovery_hint: "not_retriable" })).hint
			?.verdict,
		"instruction",
	);
	const invalid = diagnoseRun(
		failed(record([]), { recovery_hint: { action: "reinstall_app" } }),
	);
	assert.equal(invalid.hint?.verdict, "invalid");
	assert.deepEqual(invalid.gate_records, []);
});

test("every other portable hint is a suggestion in this profile version", () => {
	for (const action of [
		"manual_action_required",
		"update_selector",
		"retry_on_connector_upgrade",
		"upstream_unblock",
		"retry_by_runtime",
	]) {
		const diagnosis = diagnoseRun(
			failed(record([REJECTED]), {
				recovery_hint: { action, retryable: true },
			}),
		);
		assert.equal(diagnosis.hint?.verdict, "connector_suggestion", action);
		assert.equal(diagnosis.hint?.retryable, true);
	}
});

test("a connector without OBSERVATION is never recorded as defective for its hint", () => {
	const diagnosis = diagnoseRun(
		failed(record([], { protocol_capabilities: [] }), {
			recovery_hint: "manual_action_required",
		}),
	);
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.deepEqual(diagnosis.gate_records, []);
});

test("a succeeded run has no terminal event and no cause", () => {
	const diagnosis = diagnoseRun({
		connector: "example",
		done: { status: "succeeded" },
		run_record: record([HIDDEN]),
	});
	assert.equal(diagnosis.terminal_event, undefined);
	assert.equal(diagnosis.cause, undefined);
	assert.equal(diagnosis.facts[0]?.in_scope, false);
});

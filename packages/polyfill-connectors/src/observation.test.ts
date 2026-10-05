// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	createObservationIngest,
	createWireObservationSink,
	OBSERVATION_LIMITS,
	type ObservationMessage,
	observationBasisOf,
	observationMessageSchema,
	observe,
	runRecordFactSchema,
	setObservationSink,
	withObservationBasis,
} from "./observation.ts";

afterEach(() => {
	setObservationSink(undefined);
});

const HIDDEN_EMAIL: ObservationMessage = {
	type: "OBSERVATION",
	id: "o1",
	fact: "element_expectation",
	step: "sign_in",
	attrs: {
		expectation: "email_input",
		states_seen: ["absent", "hidden"],
		final: "hidden",
	},
	evidence_ref: "trace:step-3",
};

const lineBytes = (value: unknown): number =>
	Buffer.byteLength(JSON.stringify(value));

test("the schema accepts the core connector facts", () => {
	assert.equal(observationMessageSchema.safeParse(HIDDEN_EMAIL).success, true);
	for (const message of [
		{
			type: "OBSERVATION",
			id: "o2",
			fact: "wait_expired",
			step: "sign_in",
			attrs: { awaited: "email_input", budget_ms: 10_000 },
		},
		{
			type: "OBSERVATION",
			id: "o3",
			fact: "provider_message",
			attrs: { kind: "other" },
			evidence_ref: "artifact:provider-text-1",
		},
	]) {
		assert.equal(
			observationMessageSchema.safeParse(message).success,
			true,
			JSON.stringify(message),
		);
	}
});

test("the schema rejects free text, URLs, unknown states and runtime-only facts", () => {
	const rejects = [
		{ ...HIDDEN_EMAIL, attrs: { ...HIDDEN_EMAIL.attrs, note: "free text" } },
		{ ...HIDDEN_EMAIL, evidence_ref: "https://example.com/trace" },
		{ ...HIDDEN_EMAIL, attrs: { ...HIDDEN_EMAIL.attrs, final: "visible" } },
		{ ...HIDDEN_EMAIL, attrs: { ...HIDDEN_EMAIL.attrs, final: "disabled" } },
		{ ...HIDDEN_EMAIL, step: "Sign In" },
		{ ...HIDDEN_EMAIL, source: "runtime" },
		{
			type: "OBSERVATION",
			id: "o9",
			fact: "credential_submission",
			attrs: { attempt: "a1", account: "acct", outcome: "rejected" },
		},
		{
			type: "OBSERVATION",
			id: "o9",
			fact: "provider_message",
			attrs: { kind: "auth_failure", text: "Wrong password" },
		},
	];
	for (const message of rejects) {
		assert.equal(
			observationMessageSchema.safeParse(message).success,
			false,
			JSON.stringify(message),
		);
	}
});

test("the transport sets provenance: accepted facts are connector claims", () => {
	const ingest = createObservationIngest({ declared: true });
	ingest.accept(HIDDEN_EMAIL, lineBytes(HIDDEN_EMAIL));
	const { facts, truncated } = ingest.snapshot();
	assert.equal(truncated, false);
	assert.deepEqual(facts, [
		{
			source: "connector",
			id: "o1",
			fact: "element_expectation",
			step: "sign_in",
			attrs: HIDDEN_EMAIL.attrs,
			evidence_ref: "trace:step-3",
		},
	]);
	for (const fact of facts) {
		assert.equal(runRecordFactSchema.safeParse(fact).success, true);
	}
});

test("a runtime-only fact from the connector is discarded and recorded as a protocol violation", () => {
	const ingest = createObservationIngest({ declared: true });
	const forged = {
		type: "OBSERVATION",
		id: "o1",
		fact: "credential_submission",
		attrs: { attempt: "a1", account: "acct", outcome: "rejected" },
	};
	ingest.accept(forged, lineBytes(forged));
	ingest.accept(forged, lineBytes(forged));
	assert.deepEqual(ingest.snapshot().facts, [
		{
			source: "runtime",
			id: "r1",
			fact: "connector_defect",
			attrs: {
				class: "protocol_violation",
				reason: "runtime_only_fact",
				count: 2,
			},
		},
	]);
});

test("an OBSERVATION from a connector that did not declare the capability is a violation", () => {
	const ingest = createObservationIngest({ declared: false });
	ingest.accept(HIDDEN_EMAIL, lineBytes(HIDDEN_EMAIL));
	const [defect] = ingest.snapshot().facts;
	assert.equal(defect?.source, "runtime");
	assert.deepEqual(defect?.attrs, {
		class: "protocol_violation",
		reason: "capability_not_declared",
		count: 1,
	});
});

test("duplicate ids, oversize lines and invalid shapes are violations", () => {
	const ingest = createObservationIngest({ declared: true });
	ingest.accept(HIDDEN_EMAIL, lineBytes(HIDDEN_EMAIL));
	ingest.accept(HIDDEN_EMAIL, lineBytes(HIDDEN_EMAIL));
	ingest.accept(HIDDEN_EMAIL, OBSERVATION_LIMITS.maxLineBytes + 1);
	ingest.accept({ type: "OBSERVATION", id: "o5" }, 30);
	const reasons = ingest
		.snapshot()
		.facts.flatMap((fact) =>
			fact.fact === "connector_defect" ? [fact.attrs.reason] : [],
		);
	assert.deepEqual(reasons, [
		"duplicate_id",
		"oversize",
		"invalid_observation",
	]);
});

test("past the per-run limit the record is truncated", () => {
	const ingest = createObservationIngest({ declared: true });
	for (let index = 0; index <= OBSERVATION_LIMITS.maxPerRun; index += 1) {
		const message = { ...HIDDEN_EMAIL, id: `o${index + 1}` };
		ingest.accept(message, lineBytes(message));
	}
	const snapshot = ingest.snapshot();
	assert.equal(snapshot.truncated, true);
	assert.equal(snapshot.facts.length, OBSERVATION_LIMITS.maxPerRun);
});

test("the wire sink assigns ids and stops at the per-run limit", () => {
	const wire: ObservationMessage[] = [];
	setObservationSink(createWireObservationSink((m) => wire.push(m)));
	const ids = Array.from({ length: OBSERVATION_LIMITS.maxPerRun + 3 }, () =>
		observe({
			fact: "provider_message",
			attrs: { kind: "other" },
		}),
	);
	assert.equal(ids[0], "o1");
	assert.equal(wire.length, OBSERVATION_LIMITS.maxPerRun);
	assert.equal(ids.at(-1), undefined);
});

test("basis ids travel through an error's cause chain", () => {
	const inner = withObservationBasis(new Error("inner"), ["o1", undefined]);
	const outer = new Error("outer", { cause: inner });
	assert.deepEqual(observationBasisOf(outer), ["o1"]);
	assert.deepEqual(observationBasisOf(new Error("plain")), []);
	assert.deepEqual(observationBasisOf("not an error"), []);
});

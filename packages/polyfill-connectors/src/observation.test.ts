// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
	packageRoot as PACKAGE_ROOT,
	repoRoot as REPO_ROOT,
} from "./connector-paths.ts";
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
import { runConnectorProtocolSubprocess } from "./test-harness.ts";

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

test("the runtime schema agrees with the JSON schema's shared corpus", () => {
	// schemas/observation.schema.test.mjs checks the JSON schema against the
	// same corpus, so the spec's machine-readable half and this projection
	// cannot drift apart.
	const corpus = JSON.parse(
		readFileSync(
			join(REPO_ROOT, "schemas", "fixtures", "observation-corpus.json"),
			"utf8",
		),
	) as { invalid: { message: unknown; rule: string }[]; valid: unknown[] };
	for (const message of corpus.valid) {
		assert.equal(
			observationMessageSchema.safeParse(message).success,
			true,
			JSON.stringify(message),
		);
	}
	for (const { message, rule } of corpus.invalid) {
		assert.equal(
			observationMessageSchema.safeParse(message).success,
			false,
			rule,
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

const FIXTURE = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"observation-hidden-element-fixture.ts",
);
const startMessage = () => ({
	type: "START" as const,
	scope: { streams: [{ name: "items" }] },
});

test("a connector that declares OBSERVATION sends the facts and cites them in DONE.error.basis", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: PACKAGE_ROOT,
		entrypoint: FIXTURE,
		env: { FIXTURE_DECLARE_OBSERVATION: "1" },
		start: startMessage(),
	});
	const lines = result.rawStdout
		.split("\n")
		.filter((line) => line.trim())
		.map((line): unknown => JSON.parse(line));
	const observations = lines.filter(
		(line) => observationMessageSchema.safeParse(line).success,
	);
	assert.deepEqual(
		observations.map((o) => Reflect.get(Object(o), "fact")),
		["element_expectation", "wait_expired"],
	);
	const done = result.messages.findLast((m) => m.type === "DONE");
	assert.equal(done?.type, "DONE");
	assert.deepEqual(Reflect.get(Object(done?.error), "basis"), ["o1", "o2"]);
});

test("without the capability no OBSERVATION reaches the wire and DONE has no basis", async () => {
	const result = await runConnectorProtocolSubprocess({
		allowFailedDone: true,
		cwd: PACKAGE_ROOT,
		entrypoint: FIXTURE,
		env: { FIXTURE_DECLARE_OBSERVATION: "0" },
		start: startMessage(),
	});
	assert.doesNotMatch(result.rawStdout, /"OBSERVATION"/u);
	const done = result.messages.findLast((m) => m.type === "DONE");
	assert.equal(Reflect.get(Object(done?.error), "basis"), undefined);
	assert.match(
		result.stderr,
		/\[runtime-diagnostic\] observation \{"fact":"element_expectation","step":"sign_in","expectation":"email_input","states_seen":"hidden","final":"hidden"\}/u,
	);
});

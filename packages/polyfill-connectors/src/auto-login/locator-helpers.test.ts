// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Locator } from "playwright";
import { setConnectorDiagnosticSink } from "../connector-diagnostic.ts";
import {
	type ConnectorFact,
	createWireObservationSink,
	type ObservationMessage,
	observationMessageSchema,
	setObservationSink,
} from "../observation.ts";
import { waitForElementExpectation } from "./locator-helpers.ts";

interface FakeElement {
	readonly enabled: boolean;
	readonly visible: boolean;
}

type FakeLocator = Pick<
	Locator,
	"count" | "isEnabled" | "isVisible" | "nth" | "fill"
>;

/**
 * A locator whose matches change per poll: `frames[i]` is what poll `i`
 * sees (the last frame repeats). `fills` records which element was filled.
 */
function fakeLocator(
	frames: readonly (readonly FakeElement[])[],
	fills: number[] = [],
): Locator {
	let poll = -1;
	const frame = (): readonly FakeElement[] =>
		frames[Math.min(poll, frames.length - 1)] ?? [];
	const element = (index: number): FakeLocator => ({
		count: (): Promise<number> => Promise.resolve(1),
		fill: (): Promise<void> => {
			fills.push(index);
			return Promise.resolve();
		},
		isEnabled: (): Promise<boolean> =>
			Promise.resolve(frame()[index]?.enabled ?? false),
		isVisible: (): Promise<boolean> =>
			Promise.resolve(frame()[index]?.visible ?? false),
		nth: (): Locator => element(index) as Locator,
	});
	const root: FakeLocator = {
		count: (): Promise<number> => {
			poll += 1;
			return Promise.resolve(frame().length);
		},
		fill: (): Promise<void> => Promise.reject(new Error("use nth")),
		isEnabled: (): Promise<boolean> => Promise.reject(new Error("use nth")),
		isVisible: (): Promise<boolean> => Promise.reject(new Error("use nth")),
		nth: (index: number): Locator => element(index) as Locator,
	};
	return root as Locator;
}

const HIDDEN: FakeElement = { enabled: true, visible: false };
const VISIBLE: FakeElement = { enabled: true, visible: true };
const DISABLED: FakeElement = { enabled: false, visible: true };
const noSleep = (): Promise<void> => Promise.resolve();

function captureFacts(): ConnectorFact[] {
	const facts: ConnectorFact[] = [];
	setObservationSink((fact) => {
		facts.push(fact);
		return `o${facts.length}`;
	});
	return facts;
}

afterEach(() => {
	setObservationSink(undefined);
	setConnectorDiagnosticSink(undefined);
});

const BASE = {
	expectation: "email_input",
	pollIntervalMs: 250,
	sleep: noSleep,
	step: "sign_in",
	timeoutMs: 1000,
} as const;

test("a present but hidden element is recorded as hidden at the deadline", async () => {
	const facts = captureFacts();
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[HIDDEN]]),
	});

	assert.equal(result.final, "hidden");
	assert.equal(result.match, undefined);
	assert.deepEqual(result.statesSeen, ["hidden"]);
	assert.deepEqual(result.observationIds, ["o1", "o2"]);
	assert.deepEqual(facts, [
		{
			fact: "element_expectation",
			step: "sign_in",
			attrs: {
				expectation: "email_input",
				states_seen: ["hidden"],
				final: "hidden",
			},
		},
		{
			fact: "wait_expired",
			step: "sign_in",
			attrs: { awaited: "email_input", budget_ms: 1000 },
		},
	]);
});

test("states are kept in order of first sighting: absent, then hidden", async () => {
	const facts = captureFacts();
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[], [], [HIDDEN]]),
	});
	assert.equal(result.final, "hidden");
	assert.deepEqual(result.statesSeen, ["absent", "hidden"]);
	assert.equal(facts.length, 2);
});

test("a missing element is absent and a visible but disabled one is disabled", async () => {
	captureFacts();
	const absent = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[]]),
	});
	assert.equal(absent.final, "absent");

	const disabled = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[DISABLED]]),
	});
	assert.equal(disabled.final, "disabled");

	const visibleIsEnough = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[DISABLED]]),
		require: "visible",
	});
	assert.equal(visibleIsEnough.final, "matched");
});

test("an element that appears before the deadline matches and records nothing", async () => {
	const facts = captureFacts();
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[], [HIDDEN], [VISIBLE]]),
	});
	assert.equal(result.final, "matched");
	assert.ok(result.match);
	assert.deepEqual(result.observationIds, []);
	assert.deepEqual(facts, []);
});

test("a hidden first match does not mask a visible second match", async () => {
	captureFacts();
	const fills: number[] = [];
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[HIDDEN, VISIBLE]], fills),
	});
	assert.equal(result.final, "matched");
	await result.match?.fill("x");
	assert.deepEqual(fills, [1]);
});

test("two acceptable matches are ambiguous when the expectation is unique", async () => {
	captureFacts();
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[VISIBLE, VISIBLE]]),
		unique: true,
	});
	assert.equal(result.final, "ambiguous");
	assert.equal(result.match, undefined);
});

test("the poll count bounds the wait even when sleep returns at once", async () => {
	let polls = 0;
	const locator = fakeLocator([[HIDDEN]]);
	const counting: Pick<Locator, "count"> = {
		count: (): Promise<number> => {
			polls += 1;
			return locator.count();
		},
	};
	captureFacts();
	await waitForElementExpectation({
		...BASE,
		locator: Object.assign(Object.create(locator) as Locator, counting),
	});
	assert.equal(polls, 5, "1000 ms / 250 ms + the first read");
});

test("without a declared capability the fact goes to a diagnostic line, not the wire", async () => {
	const lines: string[] = [];
	setConnectorDiagnosticSink((line) => lines.push(line));
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[HIDDEN]]),
	});
	assert.deepEqual(result.observationIds, []);
	assert.equal(lines.length, 2);
	assert.match(
		lines[0] ?? "",
		/^\[runtime-diagnostic\] observation \{"fact":"element_expectation","step":"sign_in","expectation":"email_input","states_seen":"hidden","final":"hidden"\}$/u,
	);
});

test("with the wire sink the facts are valid OBSERVATION messages", async () => {
	const wire: ObservationMessage[] = [];
	setObservationSink(createWireObservationSink((m) => wire.push(m)));
	const result = await waitForElementExpectation({
		...BASE,
		locator: fakeLocator([[], [DISABLED]]),
	});
	assert.deepEqual(result.observationIds, ["o1", "o2"]);
	for (const message of wire) {
		assert.equal(observationMessageSchema.safeParse(message).success, true);
	}
	assert.deepEqual(wire[0], {
		type: "OBSERVATION",
		id: "o1",
		fact: "element_expectation",
		step: "sign_in",
		attrs: {
			expectation: "email_input",
			states_seen: ["absent", "disabled"],
			final: "disabled",
		},
	});
});

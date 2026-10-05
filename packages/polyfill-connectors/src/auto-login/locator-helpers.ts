// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Provider-neutral Playwright locator helpers shared across auto-login modules. */

import type { Locator } from "playwright";
import { type ElementState, observe } from "../observation.ts";

/** `true` iff the first match becomes visible within 1s; never throws. */
export async function locatorIsVisible(locator: Locator): Promise<boolean> {
	return await locator
		.first()
		.isVisible({ timeout: 1000 })
		.catch((): boolean => false);
}

/**
 * `true` iff the first match is visible AND enabled; never throws.
 *
 * Visibility alone is not usability. Playwright reports a `disabled` control
 * as visible, so `locatorIsVisible` accepts rendered-but-inert elements — the
 * root cause behind Venmo's fabricated code prompt. Prefer this helper
 * wherever a `true` answer authorizes an irreversible act: clicking a control
 * that makes a provider dispatch a one-time code, or asking the owner for a
 * secret. A disabled control means the page is not ready for that act, and
 * treating it as ready spends the owner's real OTP budget.
 *
 * Deliberately a separate export rather than a change to `locatorIsVisible`:
 * the existing callers (reddit, github) ask a genuine visibility question and
 * must keep their current answers.
 */
export async function locatorIsUsable(locator: Locator): Promise<boolean> {
	const first = locator.first();
	const visible = await first
		.isVisible({ timeout: 1000 })
		.catch((): boolean => false);
	if (!visible) {
		return false;
	}
	return await first.isEnabled({ timeout: 1000 }).catch((): boolean => false);
}

const DEFAULT_EXPECTATION_POLL_MS = 250;
/** Candidates read per poll; a selector that matches more is still bounded. */
const MAX_EXPECTATION_CANDIDATES = 8;

export interface ElementExpectationWait {
	/** Declared expectation id (manifest `diagnostic_descriptors`). */
	readonly expectation: string;
	readonly locator: Locator;
	readonly pollIntervalMs?: number;
	/**
	 * `usable` (default): visible and enabled, which is what a fill or a click
	 * needs. `visible`: visible is enough.
	 */
	readonly require?: "usable" | "visible";
	/**
	 * Pause between polls. Pass `(ms) => page.waitForTimeout(ms)` so a test
	 * that fakes the page does not wait in real time.
	 */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Declared step id the expectation belongs to. */
	readonly step: string;
	readonly timeoutMs: number;
	/** When set, more than one acceptable match is `ambiguous`. */
	readonly unique?: boolean;
}

export interface ElementExpectationResult {
	/** The state at the deadline, or `matched`. */
	readonly final: ElementState;
	/** The first acceptable element; set only when `final` is `matched`. */
	readonly match: Locator | undefined;
	/** `OBSERVATION` ids for the recorded facts; empty when not on the wire. */
	readonly observationIds: readonly string[];
	/** Each state seen during the wait, in order of first sighting. */
	readonly statesSeen: readonly ElementState[];
}

interface ElementStateRead {
	readonly match?: Locator;
	readonly state: ElementState;
}

async function readCandidateState(
	candidate: Locator,
	require: "usable" | "visible",
): Promise<ElementState> {
	const visible = await candidate.isVisible().catch((): boolean => false);
	if (!visible) {
		return "hidden";
	}
	if (require === "visible") {
		return "matched";
	}
	const enabled = await candidate
		.isEnabled({ timeout: 1000 })
		.catch((): boolean => false);
	return enabled ? "matched" : "disabled";
}

async function readElementState(
	locator: Locator,
	require: "usable" | "visible",
	unique: boolean,
): Promise<ElementStateRead> {
	const count = await locator.count().catch((): number => 0);
	if (count === 0) {
		return { state: "absent" };
	}
	const candidates = Array.from(
		{ length: Math.min(count, MAX_EXPECTATION_CANDIDATES) },
		(_, index) => locator.nth(index),
	);
	const states = await Promise.all(
		candidates.map((candidate) => readCandidateState(candidate, require)),
	);
	const matches = candidates.filter((_, index) => states[index] === "matched");
	const [first] = matches;
	if (first && !(unique && matches.length > 1)) {
		return { match: first, state: "matched" };
	}
	if (first) {
		return { state: "ambiguous" };
	}
	return { state: states.includes("disabled") ? "disabled" : "hidden" };
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a declared element expectation, and when the deadline passes,
 * record what the page showed instead (Collection Profile Section 5.10, D9).
 *
 * A timeout alone says nothing about the cause. "The email input existed but
 * was hidden" does: it is an expectation mismatch, never an authentication
 * failure. So at the deadline this helper reports two facts through
 * `observe`: `element_expectation` with the states seen and the final state
 * (`absent`, `hidden`, `disabled` or `ambiguous`), and `wait_expired`. The
 * caller decides what to do next; this helper never throws for a missed
 * expectation. Cite `observationIds` as the failure's basis
 * (`withObservationBasis`) when the miss ends the run.
 *
 * Every candidate the selector matches is read (up to a bound), so a hidden
 * first match does not mask a visible second one.
 */
export async function waitForElementExpectation(
	wait: ElementExpectationWait,
): Promise<ElementExpectationResult> {
	const pollIntervalMs = Math.max(
		1,
		wait.pollIntervalMs ?? DEFAULT_EXPECTATION_POLL_MS,
	);
	const require = wait.require ?? "usable";
	const unique = wait.unique ?? false;
	const sleep = wait.sleep ?? defaultSleep;
	const deadline = Date.now() + wait.timeoutMs;
	const statesSeen: ElementState[] = [];

	// Recursion, not a loop: each poll depends on the previous one, and the
	// poll count bounds the depth even when `sleep` returns immediately.
	const poll = async (remaining: number): Promise<ElementStateRead> => {
		const read = await readElementState(wait.locator, require, unique);
		if (!statesSeen.includes(read.state)) {
			statesSeen.push(read.state);
		}
		if (read.state === "matched" || remaining <= 1 || Date.now() >= deadline) {
			return read;
		}
		await sleep(pollIntervalMs);
		return await poll(remaining - 1);
	};
	const last = await poll(Math.ceil(wait.timeoutMs / pollIntervalMs) + 1);
	if (last.state === "matched") {
		return {
			final: "matched",
			match: last.match,
			observationIds: [],
			statesSeen,
		};
	}

	const ids = [
		observe({
			fact: "element_expectation",
			step: wait.step,
			attrs: {
				expectation: wait.expectation,
				states_seen: statesSeen,
				final: last.state,
			},
		}),
		observe({
			fact: "wait_expired",
			step: wait.step,
			attrs: { awaited: wait.expectation, budget_ms: wait.timeoutMs },
		}),
	];
	return {
		final: last.state,
		match: undefined,
		observationIds: ids.filter((id): id is string => id !== undefined),
		statesSeen,
	};
}

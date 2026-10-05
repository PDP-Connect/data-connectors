// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Replay fixtures for `bin/diagnose.ts`, one per real case in the failure
 * diagnosis design note's test-case table. Each fixture is a run summary as
 * `bin/connector-dev.ts` writes it; each test runs the CLI as a subprocess
 * and asserts the primary cause, the contributing list and the hint verdict.
 *
 *   (a) ChatGPT 2026-10-02: email input present but hidden at the deadline.
 *   (b) A genuine authentication rejection, and the same page seen only by
 *       the connector.
 *   (c) A timeout with no corroborating evidence.
 *   (d) Strava 2026-10-02: failure right after a fresh one-time-code sign-in.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	CHATGPT_EMAIL_INPUT_EXPECTATION,
	CHATGPT_SIGN_IN_STEP,
} from "../src/auto-login/chatgpt.ts";
import { packageRoot as PACKAGE_ROOT } from "../src/connector-paths.ts";
import type { Diagnosis } from "../src/failure-diagnosis.ts";
import { defaultSummaryPath, runIdFor } from "./connector-dev.ts";
import { summaryPathForRunId } from "./diagnose.ts";

const CLI_PATH = join(PACKAGE_ROOT, "bin", "diagnose.ts");
const fixture = (name: string): string =>
	join(
		PACKAGE_ROOT,
		"src",
		"test-fixtures",
		"failure-diagnosis",
		`${name}.summary.json`,
	);

function runDiagnose(args: readonly string[]): {
	code: number | null;
	stderr: string;
	stdout: string;
} {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", CLI_PATH, ...args],
		{ cwd: PACKAGE_ROOT, encoding: "utf8", timeout: 30_000 },
	);
	return { code: result.status, stderr: result.stderr, stdout: result.stdout };
}

function diagnose(name: string): { diagnosis: Diagnosis; text: string } {
	const json = runDiagnose([fixture(name), "--json"]);
	assert.equal(json.code, 0, json.stderr);
	const text = runDiagnose([fixture(name)]);
	assert.equal(text.code, 0, text.stderr);
	return {
		diagnosis: JSON.parse(json.stdout) as Diagnosis,
		text: text.stdout,
	};
}

const INSTRUCTION = /may be presented as an instruction/u;

test("(a) ChatGPT: a hidden email input is an expectation mismatch at sign_in, and refresh_credentials stays a suggestion", () => {
	const { diagnosis, text } = diagnose("a-chatgpt-hidden-email");

	assert.deepEqual(diagnosis.cause, {
		attribution: "connector",
		basis: ["o1"],
		category: "expectation_mismatch",
		step: "sign_in",
	});
	assert.deepEqual(diagnosis.contributing, []);
	assert.equal(diagnosis.hint?.action, "refresh_credentials");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.deepEqual(
		diagnosis.gate_records.map((record) => record.attrs),
		[{ class: "hint_unsupported" }],
	);
	assert.doesNotMatch(text, INSTRUCTION);
	assert.match(
		text,
		/The connector reports that the page did not match what the connector expected/u,
	);
	assert.match(
		text,
		/connector's recovery hint \(refresh_credentials\): shown as the connector's suggestion, not as an instruction/u,
	);
});

test("(a) the fixture uses the step and expectation ids the ChatGPT sign-in code reports", () => {
	const summary = JSON.parse(
		readFileSync(fixture("a-chatgpt-hidden-email"), "utf8"),
	) as {
		run_record: { facts: { attrs: { expectation?: string }; step: string }[] };
	};
	const [hidden] = summary.run_record.facts;
	assert.equal(hidden?.step, CHATGPT_SIGN_IN_STEP);
	assert.equal(hidden?.attrs.expectation, CHATGPT_EMAIL_INPUT_EXPECTATION);
});

test("(a) today's ChatGPT, which sends no facts: cause unknown, hint a suggestion, connector not marked defective", () => {
	const { diagnosis, text } = diagnose("a-chatgpt-hidden-email-legacy");

	assert.equal(diagnosis.cause?.category, "unknown");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.deepEqual(diagnosis.gate_records, []);
	assert.doesNotMatch(text, INSTRUCTION);
	assert.match(
		text,
		/connector's own error text: chatgpt_preprogress_failure: refresh_credentials: chatgpt_session_failed: locator\.fill: Timeout 30000ms exceeded\./u,
	);
});

test("(b) a runtime-recorded rejection under a declared auth rule allows refresh_credentials as an instruction", () => {
	const { diagnosis, text } = diagnose("b-auth-rejected-runtime");

	assert.deepEqual(diagnosis.terminal_event, {
		fact: "r1",
		kind: "credential_submission",
	});
	assert.deepEqual(diagnosis.cause, {
		attribution: "runtime",
		basis: ["r1", "r2", "o1"],
		category: "auth_rejected",
		step: "sign_in",
	});
	assert.deepEqual(diagnosis.contributing, []);
	assert.equal(diagnosis.hint?.verdict, "instruction");
	assert.deepEqual(diagnosis.gate_records, []);
	assert.match(
		text,
		/The runtime recorded that the provider rejected the sign-in\./u,
	);
	assert.match(
		text,
		/connector's recovery hint \(refresh_credentials\) \(the connector claims retryable=false\): may be presented as an instruction/u,
	);
});

test("(b) the same login error page seen only by the connector is its report, not an instruction", () => {
	const { diagnosis, text } = diagnose("b-auth-rejected-connector-claim");

	assert.equal(diagnosis.cause?.category, "auth_rejected");
	assert.equal(diagnosis.cause?.attribution, "connector");
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.doesNotMatch(text, INSTRUCTION);
	assert.match(
		text,
		/The connector reports that the provider rejected the sign-in\. The runtime did not verify this\./u,
	);
});

test("(c) a timeout with no corroborating evidence is unknown, with no credential instruction", () => {
	const { diagnosis, text } = diagnose("c-timeout-no-evidence");

	assert.deepEqual(diagnosis.cause, {
		attribution: "none",
		basis: [],
		category: "unknown",
	});
	assert.deepEqual(diagnosis.contributing, []);
	// The cited wait_expired is in scope and visible; it supports nothing.
	assert.deepEqual(
		diagnosis.facts.map(({ fact, in_scope }) => [fact.fact, in_scope]),
		[["wait_expired", true]],
	);
	assert.equal(diagnosis.hint?.verdict, "connector_suggestion");
	assert.doesNotMatch(text, INSTRUCTION);
	assert.match(text, /The recorded evidence does not establish a cause\./u);
});

test("(d) Strava today: the connector's own error text is shown verbatim and the cause stays unknown", () => {
	const { diagnosis, text } = diagnose("d-strava-after-otp-legacy");

	assert.equal(diagnosis.cause?.category, "unknown");
	assert.equal(diagnosis.hint, undefined);
	assert.deepEqual(diagnosis.connector_error, {
		code: "strava_session_dead",
		message: "strava_browser_session_failed: strava_session_dead",
		retryable: false,
	});
	assert.match(
		text,
		/connector's own error text \(code strava_session_dead\): strava_browser_session_failed: strava_session_dead/u,
	);
});

test("(d) Strava without DONE: unknown, with the step and the local provider-text artifact shown", () => {
	const { diagnosis, text } = diagnose("d-strava-after-otp");

	assert.equal(diagnosis.outcome, "no_done");
	assert.deepEqual(diagnosis.terminal_event, {
		code: 1,
		kind: "process_exit",
		signal: null,
	});
	assert.equal(diagnosis.cause?.category, "unknown");
	assert.deepEqual(diagnosis.local_evidence, [
		"artifact:strava/provider-message-1.txt",
	]);
	assert.match(text, /provider_message at step sign_in: kind other/u);
	assert.match(
		text,
		/local evidence \(stays on this device\): artifact:strava\/provider-message-1\.txt/u,
	);
});

test("a run id names the summary connector-dev wrote for that run", () => {
	const startedAt = "2026-10-02T09:14:03.000Z";
	assert.equal(
		summaryPathForRunId(runIdFor("chatgpt", startedAt)),
		defaultSummaryPath("chatgpt", startedAt),
	);
	assert.equal(summaryPathForRunId("../etc/passwd"), undefined);
});

test("an unknown run id or a non-summary file is a usage error", () => {
	assert.equal(runDiagnose(["chatgpt/2000-01-01T00-00-00.000Z"]).code, 2);
	const notSummary = runDiagnose([join(PACKAGE_ROOT, "package.json")]);
	assert.equal(notSummary.code, 2);
	assert.match(notSummary.stderr, /not a run summary diagnosis can read/u);
});

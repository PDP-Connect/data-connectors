// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hashCanonicalJson } from "@pdpp/collector-runtime";
import {
	appendScenarioTranscript,
	assertPrivateCaptureDestination,
	computeProtocolViolation,
	defaultOutPath,
	isRunCaptureComplete,
	prepareScenarioTranscript,
	WatchdogTimeoutError as RecordWatchdogTimeoutError,
} from "../../bin/scenario-record.ts";
import {
	assertNoUnsupportedApiRequests,
	isReplayExitAccepted,
	WatchdogTimeoutError as ReplayWatchdogTimeoutError,
	writeMismatchDumps,
} from "../../bin/scenario-verify.ts";
import { summarizeRunOutcome } from "./outcome.ts";

test("summarizeRunOutcome: records failed DONE and per-stream reason codes only", () => {
	const outcome = summarizeRunOutcome([
		{
			type: "DETAIL_GAP",
			stream: "messages",
			reason: "surface_unreachable",
			record_key: "synthetic-personal-value",
			detail_locator: { thread: "synthetic-private-text" },
		},
		{
			type: "DONE",
			status: "failed",
			error: { code: "collection_failed", message: "synthetic-private-text" },
		},
	]);
	assert.deepEqual(outcome, {
		error_code: "collection_failed",
		status: "failed",
		stream_outcomes: [
			{
				outcome: "detail_gap",
				reason_code: "surface_unreachable",
				stream: "messages",
			},
		],
	});
	assert.doesNotMatch(
		JSON.stringify(outcome),
		/synthetic-private-text|synthetic-personal-value/,
	);
});

test("summarizeRunOutcome: recognizes skip results even when DONE succeeds", () => {
	assert.deepEqual(
		summarizeRunOutcome([
			{
				type: "SKIP_RESULT",
				stream: "events",
				reason: "stream_capped",
				message: "private detail",
			},
			{ type: "DONE", status: "succeeded" },
		]),
		{
			status: "succeeded",
			stream_outcomes: [
				{
					outcome: "skip_result",
					reason_code: "stream_capped",
					stream: "events",
				},
			],
		},
	);
});

test("summarizeRunOutcome: excludes crashes, missing DONE, and DONE without declared reason", () => {
	assert.equal(
		summarizeRunOutcome([{ type: "DONE", status: "failed" }]),
		undefined,
	);
	assert.equal(
		summarizeRunOutcome([{ type: "RECORD", stream: "events" }]),
		undefined,
	);
	assert.equal(
		summarizeRunOutcome([{ type: "DONE", status: "succeeded" }]),
		undefined,
	);
});

// Expected outcomes never certify independently broken capture/process integrity.
test("capture integrity failures cannot be masked by expected outcomes", () => {
	for (const kind of [
		"storage",
		"protocol_corrupt",
		"protocol_violation",
		"har_scrub",
	]) {
		for (const status of ["failed", "succeeded"] as const) {
			const protocolTrace = [
				{
					kind: "skip_result" as const,
					stream: "events",
					reason: "stream_capped" as const,
					message: "synthetic skip",
				},
				{
					kind: "done" as const,
					status,
					records_emitted: 0,
					...(status === "failed" ? { error_code: "collection_failed" } : {}),
				},
			];
			assert.equal(
				isRunCaptureComplete({ ok: false, protocolTrace }),
				false,
				kind,
			);
		}
	}
});

test("failed DONE cannot excuse a new process crash or signal", () => {
	for (const code of [1, 2, null]) {
		assert.equal(isReplayExitAccepted(code, null, true, "failed"), false);
		assert.equal(
			computeProtocolViolation({
				code,
				signal: null,
				doneCount: 1,
				messageAfterDone: false,
				messages: [{ type: "DONE", status: "failed" }],
			}),
			"nonzero_exit_after_done",
		);
	}
	assert.equal(isReplayExitAccepted(0, "SIGTERM", true, "failed"), false);
	assert.equal(isReplayExitAccepted(0, null, true, "failed"), true);
});

test("diagnostic transcripts never persist protocol payloads", () => {
	const dir = mkdtempSync(join(tmpdir(), "scenario-transcript-private-"));
	try {
		const path = prepareScenarioTranscript(
			{ PDPP_SCENARIO_TRANSCRIPT_DIR: dir },
			1,
		);
		assert.ok(path);
		const message = {
			type: "RECORD",
			data: { token: "SYNTHETIC_TRANSCRIPT_SECRET" },
		};
		appendScenarioTranscript(path, message, 123);
		const text = readFileSync(path, "utf8");
		assert.doesNotMatch(text, /SYNTHETIC_TRANSCRIPT_SECRET/);
		assert.deepEqual(JSON.parse(text), {
			at: 123,
			type: "RECORD",
			message_digest: hashCanonicalJson(message),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("default capture location is private and outside the checkout", () => {
	assert.equal(
		defaultOutPath("../synthetic", "2026-10-16T00:00:00Z"),
		join(
			homedir(),
			".pdpp",
			"scenarios-___synthetic",
			"2026-10-16T00-00-00Z-scenario.json",
		),
	);
});

test("private capture destination rejects repository paths and permits a sibling", () => {
	const root = mkdtempSync(join(tmpdir(), "scenario-private-destination-"));
	try {
		assert.throws(
			() => assertPrivateCaptureDestination(join(root, "capture.json"), root),
			/outside the repository/,
		);
		assert.doesNotThrow(() =>
			assertPrivateCaptureDestination(`${root}-sibling/capture.json`, root),
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("watchdog diagnostics hash untrusted protocol labels and stream names", () => {
	for (const ErrorClass of [
		RecordWatchdogTimeoutError,
		ReplayWatchdogTimeoutError,
	]) {
		const error = new ErrorClass(1, {
			messages: [
				{ type: "RECORD", stream: "SYNTHETIC_PRIVATE_WATCHDOG", data: {} },
			] as never,
			lastMessageSeenAt: {
				at: Date.now(),
				type: "SYNTHETIC_PRIVATE_WATCHDOG",
				label: "SYNTHETIC_PRIVATE_WATCHDOG",
			},
		});
		assert.doesNotMatch(
			error.message + JSON.stringify(error.evidence),
			/SYNTHETIC_PRIVATE_WATCHDOG/,
		);
		assert.match(error.message, /sha256:/);
	}
});

test("diagnostic record dumps never export projected payloads or raw identifiers", () => {
	const dir = mkdtempSync(join(tmpdir(), "scenario-dump-privacy-"));
	try {
		writeMismatchDumps(dir, true, [
			{
				runIndex: 0,
				stream: "SYNTHETIC_PRIVATE_DUMP",
				comparisons: [
					{
						id: "SYNTHETIC_PRIVATE_DUMP",
						op: "upsert",
						expected_sha256: "0".repeat(64),
						actual_sha256: "1".repeat(64),
						projected: { value: "SYNTHETIC_PRIVATE_DUMP" },
					},
				],
			},
		] as never);
		const files = readdirSync(dir);
		assert.equal(files.length, 1);
		assert.doesNotMatch(
			files[0]! + readFileSync(join(dir, files[0]!), "utf8"),
			/SYNTHETIC_PRIVATE_DUMP/,
		);
		assert.equal(
			JSON.parse(readFileSync(join(dir, files[0]!), "utf8"))[0].projected,
			undefined,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("caught unsupported API requests still fail replay integrity", () => {
	assert.throws(() => assertNoUnsupportedApiRequests(1), /unsupported API/);
	assert.doesNotThrow(() => assertNoUnsupportedApiRequests(0));
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { writeSync } from "node:fs";

export const SCENARIO_CLI_JSON_SCHEMA =
	"pdpp.connector-scenario-cli-result/1" as const;

export type CliFailureCode =
	| "invalid_arguments"
	| "invalid_scenario"
	| "recording_failed"
	| "replay_mismatch"
	| "verification_failed";

export type CliStatus = "success" | "failure" | "usage_error";

interface CliEnvelopeBase {
	exit_code: 0 | 1 | 2;
	schema: typeof SCENARIO_CLI_JSON_SCHEMA;
	status: CliStatus;
}

export interface RecordCliEnvelope extends CliEnvelopeBase {
	command: "scenario-record";
	result: {
		kind: "record";
		outcome: "complete" | "incomplete" | "failed" | "help";
		failure_code: CliFailureCode | null;
		runs: number | null;
		scenario_path: string | null;
		capture_complete: boolean | null;
	};
}

export interface VerifyCliEnvelope extends CliEnvelopeBase {
	command: "scenario-verify";
	result: {
		kind: "verify";
		outcome: "passed" | "mismatch" | "rejected" | "failed" | "help";
		failure_code: CliFailureCode | null;
		runs: number | null;
		failure_count: number | null;
		claim: "recorded_replay" | "diagnostic_replay" | null;
		claim_artifact_written: boolean | null;
	};
}

export type ScenarioCliEnvelope = RecordCliEnvelope | VerifyCliEnvelope;

export function writeCliText(text: string, jsonMode: boolean): void {
	(jsonMode ? process.stderr : process.stdout).write(text);
}

export function writeCliJsonResult(result: ScenarioCliEnvelope): void {
	writeSync(1, `${JSON.stringify(result)}\n`);
}

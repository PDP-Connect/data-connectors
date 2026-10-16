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

export interface CliArgumentScan {
	args: string[];
	help: boolean;
	jsonMode: boolean;
}

export function normalizeCliValueOptions(
	argv: readonly string[],
	valueOptions: ReadonlySet<string>,
): string[] {
	const normalized: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] ?? "";
		// A separated value belongs to its option before any equals expansion.
		if (valueOptions.has(arg) && i + 1 < argv.length) {
			normalized.push(arg, argv[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (arg?.startsWith("--")) {
			const equalsIndex = arg.indexOf("=");
			if (equalsIndex > 2) {
				const name = arg.slice(0, equalsIndex);
				if (valueOptions.has(name)) {
					normalized.push(name, arg.slice(equalsIndex + 1));
					continue;
				}
			}
		}
		normalized.push(arg);
	}
	return normalized;
}

export function scanCliArguments(
	argv: readonly string[],
	options: {
		valueOptions: ReadonlySet<string>;
		numericValueOptions: ReadonlySet<string>;
		jsonOptionConsumesValue?: boolean;
	},
): CliArgumentScan {
	// Scan raw tokens: inline values and consumed strings cannot become flags.
	// Keep argv raw for parseArgs, which performs the only equals expansion.
	const args = [...argv];
	let help = false;
	let jsonMode = false;
	for (let i = 0; i < args.length; i += 1) {
		const token = args[i] ?? "";
		const equalsIndex = token.indexOf("=");
		const hasInlineValue =
			equalsIndex > 2 && options.valueOptions.has(token.slice(0, equalsIndex));
		const arg = hasInlineValue ? token.slice(0, equalsIndex) : token;
		if (arg === "--help") {
			help = true;
			continue;
		}
		if (arg === "--json") {
			jsonMode = true;
			if (
				options.jsonOptionConsumesValue &&
				!hasInlineValue &&
				i + 1 < args.length
			) {
				i += 1;
			}
			continue;
		}
		if (hasInlineValue || !options.valueOptions.has(arg)) {
			continue;
		}
		const value = args[i + 1];
		if (options.numericValueOptions.has(arg)) {
			if (value === "--help" || (value !== undefined && /^\d+$/.test(value))) {
				i += 1;
			}
			continue;
		}
		if (value !== undefined) {
			i += 1;
		}
	}
	return { args, help, jsonMode };
}

export function writeCliText(text: string, jsonMode: boolean): void {
	(jsonMode ? process.stderr : process.stdout).write(text);
}

export function writeCliJsonResult(result: ScenarioCliEnvelope): void {
	writeSync(1, `${JSON.stringify(result)}\n`);
}

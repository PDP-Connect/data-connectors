// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageRoot as PACKAGE_ROOT } from "../src/connector-paths.ts";
import type { ConnectorScenario } from "../src/scenario/format.ts";

const RECORD_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-record.ts");
const VERIFY_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-verify.ts");
const STUB_CONNECTOR_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"scenario-cli-stub-connector.ts",
);
const RESULT_SCHEMA = "pdpp.connector-scenario-cli-result/1";
const TEMP_ROOT = join(homedir(), ".tmp");

interface CliRun {
	code: number | null;
	stderr: string;
	stdout: string;
}

interface JsonEnvelope {
	command: "scenario-record" | "scenario-verify";
	exit_code: number;
	result: Record<string, unknown>;
	schema: string;
	status: "success" | "failure" | "usage_error";
}

interface StubSite {
	close: () => Promise<void>;
	url: string;
}

function createTempDir(): string {
	mkdirSync(TEMP_ROOT, { recursive: true });
	return mkdtempSync(join(TEMP_ROOT, "scenario-cli-json-"));
}

function startStubSite(tempDir: string): Promise<StubSite> {
	const scriptPath = join(tempDir, "site.mjs");
	writeFileSync(
		scriptPath,
		`import { createServer } from "node:http";
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ items: [{ id: "item-1", value: "alpha" }], next_cursor: null }));
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`,
	);
	const child = spawn(process.execPath, [scriptPath], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	let closePromise: Promise<void> | undefined;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill();
			reject(new Error(`local fixture site did not start: ${stderr}`));
		}, 10_000);
		child.stdout.on("data", () => {
			const port = /PORT (\d+)/.exec(stdout)?.[1];
			if (port) {
				clearTimeout(timeout);
				resolve({
					url: `http://127.0.0.1:${port}`,
					close: () => {
						closePromise ??= (async () => {
							child.kill();
							await once(child, "close");
						})();
						return closePromise;
					},
				});
			}
		});
		child.once("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.once("exit", (code) => {
			if (!stdout.includes("PORT ")) {
				clearTimeout(timeout);
				reject(
					new Error(
						`local fixture site exited before binding (${String(code)}): ${stderr}`,
					),
				);
			}
		});
	});
}

function runCli(
	cliPath: string,
	args: readonly string[],
	extraEnv: Record<string, string> = {},
): CliRun {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", cliPath, ...args],
		{
			cwd: PACKAGE_ROOT,
			env: { ...process.env, ...extraEnv },
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function readEnvelope(run: CliRun): JsonEnvelope {
	assert.notEqual(run.code, null, "CLI must exit before timeout");
	assert.equal(
		run.stdout.endsWith("\n"),
		true,
		"JSON result ends with a newline",
	);
	assert.equal(
		run.stdout.split("\n").filter((line) => line.length > 0).length,
		1,
		`stdout must contain one JSON result only: ${run.stdout}`,
	);
	const result: unknown = JSON.parse(run.stdout);
	assert.equal(typeof result, "object");
	assert.notEqual(result, null);
	const envelope = result as JsonEnvelope;
	assert.equal(envelope.schema, RESULT_SCHEMA);
	assert.ok(["scenario-record", "scenario-verify"].includes(envelope.command));
	assert.ok(["success", "failure", "usage_error"].includes(envelope.status));
	assert.equal(typeof envelope.exit_code, "number");
	assert.equal(envelope.exit_code, run.code);
	assert.equal(typeof envelope.result, "object");
	return envelope;
}

function assertRecordEnvelope(envelope: JsonEnvelope): void {
	for (const key of ["command", "exit_code", "result", "schema", "status"]) {
		assert.ok(Object.hasOwn(envelope, key), `envelope includes ${key}`);
	}
	for (const key of [
		"capture_complete",
		"failure_code",
		"kind",
		"outcome",
		"runs",
		"scenario_path",
	]) {
		assert.ok(
			Object.hasOwn(envelope.result, key),
			`record result includes ${key}`,
		);
	}
	assert.equal(envelope.result.kind, "record");
	assert.equal(typeof envelope.result.outcome, "string");
	assert.ok(
		envelope.result.runs === null || typeof envelope.result.runs === "number",
	);
	assert.ok(
		envelope.result.scenario_path === null ||
			typeof envelope.result.scenario_path === "string",
	);
	assert.ok(
		envelope.result.capture_complete === null ||
			typeof envelope.result.capture_complete === "boolean",
	);
}

function assertVerifyEnvelope(envelope: JsonEnvelope): void {
	for (const key of ["command", "exit_code", "result", "schema", "status"]) {
		assert.ok(Object.hasOwn(envelope, key), `envelope includes ${key}`);
	}
	for (const key of [
		"claim",
		"claim_artifact_written",
		"failure_code",
		"failure_count",
		"kind",
		"outcome",
		"runs",
	]) {
		assert.ok(
			Object.hasOwn(envelope.result, key),
			`verify result includes ${key}`,
		);
	}
	assert.equal(envelope.result.kind, "verify");
	assert.equal(typeof envelope.result.outcome, "string");
	assert.ok(
		envelope.result.runs === null || typeof envelope.result.runs === "number",
	);
	assert.ok(
		envelope.result.failure_count === null ||
			typeof envelope.result.failure_count === "number",
	);
	assert.ok(
		envelope.result.claim === null || typeof envelope.result.claim === "string",
	);
	assert.ok(
		envelope.result.claim_artifact_written === null ||
			typeof envelope.result.claim_artifact_written === "boolean",
	);
}

test("scenario CLIs --help documents every flag and JSON output behavior", () => {
	const recordHelp = runCli(RECORD_CLI_PATH, ["--json", "--help"]);
	const recordHelpEnvelope = readEnvelope(recordHelp);
	assertRecordEnvelope(recordHelpEnvelope);
	assert.equal(recordHelpEnvelope.status, "success");
	assert.equal(recordHelpEnvelope.result.outcome, "help");
	for (const flag of [
		"--json",
		"--runs",
		"--out",
		"--entrypoint",
		"--answer",
		"--answers",
		"--persist-otp",
		"--streams",
		"--timeout",
		"--record-har",
	]) {
		assert.ok(recordHelp.stderr.includes(flag), `record help lists ${flag}`);
	}
	assert.match(recordHelp.stderr, /Exit codes: 0 .*1 .*2 /);

	const verifyHelp = runCli(VERIFY_CLI_PATH, [
		"--json",
		"ignored-claim.json",
		"--help",
	]);
	const verifyEnvelope = readEnvelope(verifyHelp);
	assertVerifyEnvelope(verifyEnvelope);
	assert.equal(verifyEnvelope.status, "success");
	assert.equal(verifyEnvelope.result.outcome, "help");
	for (const flag of [
		"--entrypoint",
		"--require-capture-source",
		"--json",
		"--timeout",
		"--dump-records",
		"--dump-all-records",
	]) {
		assert.ok(verifyHelp.stderr.includes(flag), `verify help lists ${flag}`);
	}
	assert.match(verifyHelp.stderr, /one versioned JSON result/);
});

test("scenario-record --json reports capture completion and routes human output to stderr", async (t) => {
	const tempDir = createTempDir();
	const site = await startStubSite(tempDir);
	t.after(async () => {
		await site.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
	const scenarioPath = join(tempDir, "scenario.json");
	const recordRun = runCli(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			"--runs",
			"1",
			"--out",
			scenarioPath,
			"--json",
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: site.url },
	);
	const recordEnvelope = readEnvelope(recordRun);
	assertRecordEnvelope(recordEnvelope);
	assert.equal(recordEnvelope.status, "success");
	assert.equal(recordEnvelope.result.outcome, "complete");
	assert.equal(recordEnvelope.result.runs, 1);
	assert.equal(recordEnvelope.result.capture_complete, true);
	assert.equal(recordEnvelope.result.scenario_path, scenarioPath);
	assert.match(recordRun.stderr, /recording network: live/);
	assert.doesNotMatch(recordRun.stdout, /wrote scenario to:/);
	assert.equal(
		(JSON.parse(readFileSync(scenarioPath, "utf8")) as ConnectorScenario)
			.format,
		"pdpp.connector-scenario/1",
	);

	const recordingFailure = runCli(RECORD_CLI_PATH, [
		"scenario-cli-stub-connector",
		"--entrypoint",
		STUB_CONNECTOR_PATH,
		"--streams",
		"unknown-stream",
		"--json",
	]);
	const failureEnvelope = readEnvelope(recordingFailure);
	assertRecordEnvelope(failureEnvelope);
	assert.equal(failureEnvelope.status, "failure");
	assert.equal(failureEnvelope.result.failure_code, "recording_failed");
	assert.equal(recordingFailure.code, 1);
});

test("scenario-verify --json preserves the claim file and reports pass, mismatch, invalid scenario, and usage errors", async (t) => {
	const tempDir = createTempDir();
	const site = await startStubSite(tempDir);
	t.after(async () => {
		await site.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
	const scenarioPath = join(tempDir, "scenario.json");
	const recordRun = runCli(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			"--runs",
			"1",
			"--out",
			scenarioPath,
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: site.url },
	);
	assert.equal(recordRun.code, 0, recordRun.stderr);
	assert.match(recordRun.stdout, /recording network: live/);
	const record = JSON.parse(
		readFileSync(scenarioPath, "utf8"),
	) as ConnectorScenario;
	await site.close();
	const humanVerifyRun = runCli(
		VERIFY_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			scenarioPath,
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: site.url },
	);
	assert.equal(humanVerifyRun.code, 0, humanVerifyRun.stderr);
	assert.match(humanVerifyRun.stdout, /VERIFYING scenario-cli-stub-connector/);
	assert.match(humanVerifyRun.stdout, /diagnostic_replay: PASS/);

	const claimPath = join(tempDir, "claim.json");
	const verifyArgs = [
		"scenario-cli-stub-connector",
		"--entrypoint",
		STUB_CONNECTOR_PATH,
		scenarioPath,
		"--json",
		claimPath,
	];
	const verifyRun = runCli(VERIFY_CLI_PATH, verifyArgs, {
		PDPP_SCENARIO_STUB_BASE_URL: site.url,
	});
	const verifyEnvelope = readEnvelope(verifyRun);
	assertVerifyEnvelope(verifyEnvelope);
	assert.equal(
		verifyEnvelope.status,
		"success",
		`verify failed: stdout=${verifyRun.stdout} stderr=${verifyRun.stderr}`,
	);
	assert.equal(verifyEnvelope.result.outcome, "passed");
	assert.equal(verifyEnvelope.result.runs, 1);
	assert.equal(verifyEnvelope.result.failure_count, 0);
	assert.equal(verifyEnvelope.result.claim, "diagnostic_replay");
	assert.equal(verifyEnvelope.result.claim_artifact_written, true);
	assert.equal(
		(JSON.parse(readFileSync(claimPath, "utf8")) as { schema: string }).schema,
		"pdpp.connector-claim/1",
	);
	assert.match(verifyRun.stderr, /VERIFYING scenario-cli-stub-connector/);

	const mismatchPath = join(tempDir, "mismatch.json");
	const mismatch: ConnectorScenario = JSON.parse(
		JSON.stringify(record),
	) as ConnectorScenario;
	const body = mismatch.runs[0]?.interactions[0]?.response.body;
	assert.equal(typeof body, "object");
	assert.notEqual(body, null);
	const { items } = body as { items: Array<{ value: string }> };
	const [firstItem] = items;
	assert.ok(firstItem);
	firstItem.value = "changed";
	writeFileSync(mismatchPath, JSON.stringify(mismatch));
	const mismatchRun = runCli(
		VERIFY_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			mismatchPath,
			"--json",
			join(tempDir, "mismatch-claim.json"),
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: site.url },
	);
	const mismatchEnvelope = readEnvelope(mismatchRun);
	assertVerifyEnvelope(mismatchEnvelope);
	assert.equal(mismatchEnvelope.status, "failure");
	assert.equal(mismatchEnvelope.result.outcome, "mismatch");
	assert.equal(mismatchEnvelope.result.failure_code, "replay_mismatch");
	assert.ok(Number(mismatchEnvelope.result.failure_count) > 0);
	assert.equal(mismatchRun.code, 1);
	assert.doesNotMatch(mismatchRun.stdout, /alpha|api_token|stub-token/);

	const invalidScenarioPath = join(tempDir, "invalid.json");
	writeFileSync(invalidScenarioPath, "{");
	const invalidRun = runCli(VERIFY_CLI_PATH, [
		"scenario-cli-stub-connector",
		"--entrypoint",
		STUB_CONNECTOR_PATH,
		invalidScenarioPath,
		"--json",
		join(tempDir, "invalid-claim.json"),
	]);
	const invalidEnvelope = readEnvelope(invalidRun);
	assertVerifyEnvelope(invalidEnvelope);
	assert.equal(invalidEnvelope.status, "failure");
	assert.equal(invalidEnvelope.result.outcome, "rejected");
	assert.equal(invalidEnvelope.result.failure_code, "invalid_scenario");
	assert.equal(invalidRun.code, 1);

	const usageRun = runCli(RECORD_CLI_PATH, ["--json", "--unknown"]);
	const usageEnvelope = readEnvelope(usageRun);
	assertRecordEnvelope(usageEnvelope);
	assert.equal(usageEnvelope.status, "usage_error");
	assert.equal(usageEnvelope.result.failure_code, "invalid_arguments");
	assert.equal(usageRun.code, 2);

	const verifyUsageRun = runCli(VERIFY_CLI_PATH, [
		"scenario-cli-stub-connector",
		"missing-scenario.json",
		"--json",
	]);
	const verifyUsageEnvelope = readEnvelope(verifyUsageRun);
	assertVerifyEnvelope(verifyUsageEnvelope);
	assert.equal(verifyUsageEnvelope.status, "usage_error");
	assert.equal(verifyUsageEnvelope.result.failure_code, "invalid_arguments");
	assert.equal(verifyUsageRun.code, 2);

	const verifyUnknownFlagRun = runCli(VERIFY_CLI_PATH, [
		"scenario-cli-stub-connector",
		"missing-scenario.json",
		"--unknown",
		"--json",
		join(tempDir, "unknown-flag-claim.json"),
	]);
	const verifyUnknownFlagEnvelope = readEnvelope(verifyUnknownFlagRun);
	assertVerifyEnvelope(verifyUnknownFlagEnvelope);
	assert.equal(verifyUnknownFlagEnvelope.status, "usage_error");
	assert.equal(
		verifyUnknownFlagEnvelope.result.failure_code,
		"invalid_arguments",
	);
	assert.equal(verifyUnknownFlagRun.code, 2);
});

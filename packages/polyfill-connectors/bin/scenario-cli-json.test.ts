// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { packageRoot as PACKAGE_ROOT } from "../src/connector-paths.ts";
import type { ConnectorScenario } from "../src/scenario/format.ts";

const RECORD_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-record.ts");
const VERIFY_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-verify.ts");
const CLI_BIN_DIR = dirname(RECORD_CLI_PATH);
const CLI_MARKER_PATH = join(CLI_BIN_DIR, "scenario-cli-contract.json");
const RESULT_SCHEMA_PATH = join(CLI_BIN_DIR, "scenario-cli-result.schema.json");
const REQUIRE = createRequire(import.meta.url);
const TSX_IMPORT_PATH = REQUIRE.resolve("tsx");
const STUB_CONNECTOR_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"scenario-cli-stub-connector.ts",
);
const RESULT_SCHEMA = "pdpp.connector-scenario-cli-result/1";
const TEMP_ROOT = join(homedir(), ".tmp");
const INTERACTION_PROMPT_SENTINEL = "private-interaction-prompt-sentinel";

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

function writeInteractionConnector(path: string, requestId = "prompt-1"): void {
	writeFileSync(
		path,
		`import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "START") {
    process.stdout.write(JSON.stringify({
      type: "INTERACTION",
      request_id: ${JSON.stringify(requestId)},
      kind: "otp",
      message: ${JSON.stringify(INTERACTION_PROMPT_SENTINEL)},
      timeout_seconds: 1,
    }) + "\\n");
  } else if (message.type === "INTERACTION_RESPONSE") {
    process.stdout.write(JSON.stringify({ type: "DONE", status: "succeeded", records_emitted: 0 }) + "\\n", () => {
      input.close();
      process.exit(0);
    });
  }
});
`,
	);
}

function writeCleanupFailurePreload(path: string): void {
	writeFileSync(
		path,
		`const fs = require("node:fs");
const originalRmSync = fs.rmSync;
fs.rmSync = function (target, ...args) {
  if (String(target).includes("pdpp-scenario-evidence-")) {
    fs.writeFileSync(process.env.PDPP_TEST_CLEANUP_PATH, String(target));
    throw new Error("controlled evidence cleanup failure");
  }
  return originalRmSync.call(this, target, ...args);
};
require("node:module").syncBuiltinESMExports();
`,
	);
}

function runCli(
	cliPath: string,
	args: readonly string[],
	extraEnv: Record<string, string> = {},
	cwd?: string,
): CliRun {
	const isolatedCwd = cwd ?? createTempDir();
	const result = spawnSync(
		process.execPath,
		["--import", TSX_IMPORT_PATH, cliPath, ...args],
		{
			cwd: isolatedCwd,
			env: { ...process.env, ...extraEnv },
			encoding: "utf8",
			timeout: 60_000,
		},
	);
	if (cwd === undefined) {
		rmSync(isolatedCwd, { recursive: true, force: true });
	}
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function runCliWithTtyStdin(
	cliPath: string,
	args: readonly string[],
	tempDir: string,
): CliRun {
	const stdoutPath = join(tempDir, "tty-cli.stdout");
	const stderrPath = join(tempDir, "tty-cli.stderr");
	const command = `exec ${[
		process.execPath,
		"--import",
		TSX_IMPORT_PATH,
		cliPath,
		...args,
	]
		.map(shellQuote)
		.join(" ")} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`;
	const result = spawnSync("script", ["-qefc", command, "/dev/null"], {
		cwd: tempDir,
		encoding: "utf8",
		timeout: 60_000,
	});
	return {
		code: result.status,
		stdout: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
		stderr: existsSync(stderrPath)
			? readFileSync(stderrPath, "utf8")
			: result.stderr,
	};
}

function readCliContractMarker(invokedBinPath: string): string | null {
	const markerPath = join(
		dirname(invokedBinPath),
		"scenario-cli-contract.json",
	);
	if (!existsSync(markerPath)) {
		return null;
	}
	return (
		(JSON.parse(readFileSync(markerPath, "utf8")) as { contract?: string })
			.contract ?? null
	);
}

// This test checker supports only the published schema's small keyword subset.
// Check all schema branches, including absent properties and unmatched oneOfs.
function assertSupportedSchema(schema: unknown, path: string): void {
	assert.ok(
		schema !== null && typeof schema === "object" && !Array.isArray(schema),
		`${path}: schema object`,
	);
	const rule = schema as Record<string, unknown>;
	const supported = new Set([
		"$schema",
		"$id",
		"title",
		"description",
		"type",
		"const",
		"enum",
		"minimum",
		"required",
		"properties",
		"additionalProperties",
		"oneOf",
	]);
	for (const key of Object.keys(rule)) {
		assert.ok(supported.has(key), `${path}: unsupported schema keyword ${key}`);
	}
	assert.ok(
		rule.additionalProperties === undefined ||
			typeof rule.additionalProperties === "boolean",
		`${path}: schema-valued additionalProperties is unsupported`,
	);
	if (Array.isArray(rule.oneOf)) {
		for (const child of rule.oneOf) {
			assertSupportedSchema(child, path);
		}
	}
	if (rule.properties && typeof rule.properties === "object") {
		for (const [key, child] of Object.entries(rule.properties)) {
			assertSupportedSchema(child, `${path}.${key}`);
		}
	}
}

function validateJsonSchema(schema: unknown, value: unknown, path = "$"): void {
	assertSupportedSchema(schema, path);
	assert.equal(typeof schema, "object", `${path}: schema object`);
	assert.notEqual(schema, null, `${path}: schema object`);
	const rule = schema as Record<string, unknown>;
	if (Array.isArray(rule.oneOf)) {
		const failures: string[] = [];
		const matches = rule.oneOf.filter((alternative) => {
			try {
				validateJsonSchema(alternative, value, path);
				return true;
			} catch (error) {
				failures.push(error instanceof Error ? error.message : String(error));
				return false;
			}
		});
		assert.equal(
			matches.length,
			1,
			`${path}: matches exactly one oneOf schema; ${failures.join("; ")}`,
		);
	}
	if (rule.const !== undefined) {
		assert.deepEqual(value, rule.const, `${path}: const`);
	}
	if (Array.isArray(rule.enum)) {
		assert.ok(
			rule.enum.some((item) => Object.is(item, value)),
			`${path}: enum`,
		);
	}
	if (rule.type !== undefined) {
		const types = Array.isArray(rule.type) ? rule.type : [rule.type];
		const actualType =
			value === null
				? "null"
				: Array.isArray(value)
					? "array"
					: Number.isInteger(value)
						? "integer"
						: typeof value;
		assert.ok(
			types.includes(actualType) ||
				(actualType === "integer" && types.includes("number")),
			`${path}: expected ${types.join(" or ")}, got ${actualType}`,
		);
	}
	if (typeof rule.minimum === "number") {
		if (typeof value === "number") {
			assert.ok(value >= rule.minimum, `${path}: minimum`);
		}
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return;
	}
	const objectValue = value as Record<string, unknown>;
	if (Array.isArray(rule.required)) {
		for (const required of rule.required) {
			assert.ok(
				Object.hasOwn(objectValue, String(required)),
				`${path}.${String(required)}: required`,
			);
		}
	}
	if (
		rule.additionalProperties === false &&
		rule.properties &&
		typeof rule.properties === "object"
	) {
		for (const key of Object.keys(objectValue)) {
			assert.ok(
				Object.hasOwn(rule.properties, key),
				`${path}.${key}: additional property`,
			);
		}
	}
	if (rule.properties && typeof rule.properties === "object") {
		for (const [key, childSchema] of Object.entries(rule.properties)) {
			if (Object.hasOwn(objectValue, key)) {
				validateJsonSchema(childSchema, objectValue[key], `${path}.${key}`);
			}
		}
	}
}

function assertResultStatus(envelope: JsonEnvelope, code: number): void {
	assert.equal(envelope.exit_code, code);
	assert.equal(
		envelope.status,
		code === 0 ? "success" : code === 2 ? "usage_error" : "failure",
	);
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function assertOptionDefaults(help: string): void {
	const optionLines = help
		.split("\n")
		.filter((line) => /^\s{2}--\S/.test(line) && !line.includes("--help"));
	assert.ok(optionLines.length > 0, "help lists options");
	for (const line of optionLines) {
		assert.match(line, /default:/, `option documents a default: ${line}`);
	}
}

function readEnvelope(run: CliRun): JsonEnvelope {
	assert.notEqual(run.code, null, "CLI must exit before timeout");
	assert.equal(
		run.stdout.endsWith("\n"),
		true,
		"JSON result ends with a newline",
	);
	assert.equal(
		run.stdout.split("\n").length,
		2,
		`stdout must contain one JSON result only: ${run.stdout}`,
	);
	const result: unknown = JSON.parse(run.stdout);
	assert.equal(typeof result, "object");
	assert.notEqual(result, null);
	const envelope = result as JsonEnvelope;
	const resultSchema = JSON.parse(
		readFileSync(RESULT_SCHEMA_PATH, "utf8"),
	) as unknown;
	validateJsonSchema(resultSchema, envelope);
	assert.equal(envelope.schema, RESULT_SCHEMA);
	assert.ok(["scenario-record", "scenario-verify"].includes(envelope.command));
	assert.ok(["success", "failure", "usage_error"].includes(envelope.status));
	assert.equal(typeof envelope.exit_code, "number");
	assert.equal(envelope.exit_code, run.code);
	assert.equal(typeof envelope.result, "object");
	assert.equal(
		envelope.status,
		envelope.exit_code === 0
			? "success"
			: envelope.exit_code === 2
				? "usage_error"
				: "failure",
	);
	return envelope;
}

test("schema checker rejects malformed shapes and permits additive result fields", () => {
	const envelope = readEnvelope(runCli(RECORD_CLI_PATH, ["--json", "--help"]));
	const schema: unknown = JSON.parse(readFileSync(RESULT_SCHEMA_PATH, "utf8"));
	assert.doesNotThrow(() =>
		validateJsonSchema(schema, {
			...envelope,
			result: { ...envelope.result, future_detail: { count: 1 } },
		}),
	);
	const missing = { ...envelope.result };
	delete missing.capture_complete;
	for (const invalid of [
		{ ...envelope, schema: "pdpp.connector-scenario-cli/1" },
		{ ...envelope, status: "unknown" },
		{ ...envelope, exit_code: 3 },
		{ ...envelope, result: [] },
		{ ...envelope, result: missing },
		{ ...envelope, result: { ...envelope.result, kind: "verify" } },
		{ ...envelope, result: { ...envelope.result, runs: -1 } },
		{ ...envelope, result: { ...envelope.result, capture_complete: "true" } },
	]) {
		assert.throws(() => validateJsonSchema(schema, invalid));
	}
	assert.throws(() => validateJsonSchema({ oneOf: [{}, {}] }, envelope),
		/matches exactly one/);
	assert.throws(() => validateJsonSchema({
		oneOf: [{ const: "match" }, { const: "other", pattern: "^other$" }],
	}, "match"), /unsupported schema keyword pattern/);
	assert.throws(() => validateJsonSchema({
		properties: { absent: { maxLength: 1 } },
	}, {}), /unsupported schema keyword maxLength/);
});

test("literal option-looking claim paths remain owned by --json", async (t) => {
	const tempDir = createTempDir();
	let site: StubSite | undefined;
	t.after(async () => {
		await site?.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
	site = await startStubSite(tempDir);
	const scenarioPath = join(tempDir, "scenario.json");
	const env = { PDPP_SCENARIO_STUB_BASE_URL: site.url };
	const recorded = runCli(RECORD_CLI_PATH, [
		"scenario-cli-stub-connector", "--entrypoint", STUB_CONNECTOR_PATH,
		"--runs=1", "--out", scenarioPath, "--json",
	], env);
	assert.equal(recorded.code, 0, recorded.stderr);
	await site.close();
	for (const literal of ["--timeout=1", "--timeout=--help"]) {
		for (const equals of [false, true]) {
			await t.test(JSON.stringify({ literal, equals }), () => {
				const claimPath = join(tempDir, literal);
				rmSync(claimPath, { force: true });
				const run = runCli(VERIFY_CLI_PATH, [
					"scenario-cli-stub-connector", scenarioPath,
					"--entrypoint", STUB_CONNECTOR_PATH,
					...(equals ? [`--json=${literal}`] : ["--json", literal]),
				], env, tempDir);
				const envelope = readEnvelope(run);
				assertVerifyEnvelope(envelope);
				assertResultStatus(envelope, 0);
				assert.equal(envelope.result.outcome, "passed", run.stderr);
				assert.equal(envelope.result.claim_artifact_written, true);
				assert.equal(
					JSON.parse(readFileSync(claimPath, "utf8")).schema,
					"pdpp.connector-claim/1",
				);
				assert.equal(existsSync(join(tempDir, "--timeout")), false);
			});
		}
	}

	await t.test("identity rejection retains verification_failed", () => {
		const claimPath = join(tempDir, "identity-claim.json");
		const run = runCli(VERIFY_CLI_PATH, [
			"different-connector", scenarioPath, "--entrypoint", STUB_CONNECTOR_PATH,
			"--json", claimPath,
		]);
		const envelope = readEnvelope(run);
		assertVerifyEnvelope(envelope);
		assertResultStatus(envelope, 1);
		assert.equal(envelope.result.outcome, "rejected");
		assert.equal(envelope.result.failure_code, "verification_failed");
		assert.equal(envelope.result.runs, 1);
		assert.match(run.stderr, /does not match scenario.connector.id/);
		assert.equal(existsSync(claimPath), false);
	});

	await t.test("controlled verifier cleanup failure is a terminal failure", () => {
		const preloadPath = join(tempDir, "verify-cleanup-failure.cjs");
		const cleanupPathFile = join(tempDir, "verify-cleanup-path.txt");
		const claimPath = join(tempDir, "failed-claim.json");
		writeCleanupFailurePreload(preloadPath);
		const oldClaim = "stale claim must remain untouched\n";
		writeFileSync(claimPath, oldClaim);
		const run = runCli(VERIFY_CLI_PATH, [
			"scenario-cli-stub-connector", scenarioPath,
			"--entrypoint", STUB_CONNECTOR_PATH, "--json", claimPath,
		], {
			...env,
			NODE_OPTIONS: `--require=${preloadPath}`,
			PDPP_TEST_CLEANUP_PATH: cleanupPathFile,
			TMPDIR: tempDir,
		});
		const leakedWorkspace = readFileSync(cleanupPathFile, "utf8");
		rmSync(leakedWorkspace, { recursive: true, force: true });
		const envelope = readEnvelope(run);
		assertVerifyEnvelope(envelope);
		assertResultStatus(envelope, 1);
		assert.equal(envelope.result.outcome, "failed");
		assert.equal(envelope.result.failure_code, "verification_failed");
		assert.match(run.stderr, /controlled evidence cleanup failure/);
		assert.equal(readFileSync(claimPath, "utf8"), oldClaim);
	});
});

test("recorder preserves literal option-looking output and answer values", async (t) => {
	for (const option of ["--out", "--answer", "--answers"]) {
		for (const equals of [false, true]) {
			await t.test(JSON.stringify({ option, equals }), () => {
				const tempDir = createTempDir();
				try {
					const entrypointPath = join(tempDir, "interaction.mjs");
					const requestId = option === "--answer" ? "--timeout" : "prompt-1";
					writeInteractionConnector(entrypointPath, requestId);
					const answer = "approved=literal";
					const literal =
						option === "--out"
							? "--timeout=--help"
							: option === "--answer"
								? `--timeout=${answer}`
								: "--timeout=1";
					const out = option === "--out" ? literal : "scenario.json";
					if (option === "--answers") {
						writeFileSync(
							join(tempDir, literal),
							JSON.stringify({ [requestId]: answer }),
						);
					}
					const run = runCli(RECORD_CLI_PATH, [
						"scenario-cli-stub-connector", "--entrypoint", entrypointPath,
						"--runs=1", "--json", "--persist-otp",
						...(option === "--out" ? [] : ["--out", out]),
						...(option === "--out" ? ["--answer", `${requestId}=${answer}`] : []),
						...(equals ? [`${option}=${literal}`] : [option, literal]),
					], {}, tempDir);
					const envelope = readEnvelope(run);
					assertRecordEnvelope(envelope);
					assertResultStatus(envelope, 0);
					assert.equal(envelope.result.outcome, "complete", run.stderr);
					assert.equal(envelope.result.scenario_path, join(tempDir, out));
					const scenario = JSON.parse(
						readFileSync(join(tempDir, out), "utf8"),
					);
					assert.equal(
						scenario.runs[0].user_interactions[0].response.value,
						answer,
					);
					assert.equal(existsSync(join(tempDir, "--timeout")), false);
				} finally {
					rmSync(tempDir, { recursive: true, force: true });
				}
			});
		}
	}
});

test("version metadata and result schema resolve beside the invoked bins from another cwd", (t) => {
	const tempDir = createTempDir();
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	assert.deepEqual(JSON.parse(readFileSync(CLI_MARKER_PATH, "utf8")), {
		contract: "pdpp.connector-scenario-cli/1",
	});
	for (const cli of [RECORD_CLI_PATH, VERIFY_CLI_PATH]) {
		assert.equal(readCliContractMarker(cli), "pdpp.connector-scenario-cli/1");
	}
	assert.equal(
		readCliContractMarker(join(tempDir, "scenario-record.ts")),
		null,
	);
	assert.equal(
		JSON.parse(readFileSync(RESULT_SCHEMA_PATH, "utf8")).$id,
		RESULT_SCHEMA,
	);
	assert.equal(existsSync(join(tempDir, "scenario-cli-contract.json")), false);
	const result = runCli(RECORD_CLI_PATH, ["--json", "--help"], {}, tempDir);
	assert.equal(result.code, 0);
	assertRecordEnvelope(readEnvelope(result));
});

test("JSON mode survives malformed numeric values and value tokens are not mistaken for help", () => {
	for (const [cli, args, command] of [
		[
			RECORD_CLI_PATH,
			["scenario-cli-stub-connector", "--runs=--help", "--json"],
			"scenario-record",
		],
		[
			VERIFY_CLI_PATH,
			[
				"scenario-cli-stub-connector",
				"missing.json",
				"--timeout",
				"--json=claim.json",
			],
			"scenario-verify",
		],
		[
			VERIFY_CLI_PATH,
			[
				"scenario-cli-stub-connector",
				"missing.json",
				"--timeout=--help",
				"--json=claim.json",
			],
			"scenario-verify",
		],
		[
			RECORD_CLI_PATH,
			["scenario-cli-stub-connector", "--runs", "--json"],
			"scenario-record",
		],
		[
			RECORD_CLI_PATH,
			["scenario-cli-stub-connector", "--json", "--runs"],
			"scenario-record",
		],
		[
			RECORD_CLI_PATH,
			["scenario-cli-stub-connector", "--runs", "--help", "--json"],
			"scenario-record",
		],
		[
			VERIFY_CLI_PATH,
			[
				"scenario-cli-stub-connector",
				"missing.json",
				"--timeout",
				"--json",
				"claim.json",
			],
			"scenario-verify",
		],
		[
			VERIFY_CLI_PATH,
			[
				"scenario-cli-stub-connector",
				"missing.json",
				"--timeout",
				"--help",
				"--json",
				"claim.json",
			],
			"scenario-verify",
		],
	] as const) {
		const result = runCli(cli, args);
		assert.equal(result.code, 2);
		const envelope = readEnvelope(result);
		assert.equal(envelope.command, command);
		assert.equal(envelope.status, "usage_error");
		assert.equal(envelope.exit_code, 2);
	}

	const recordLiteral = runCli(RECORD_CLI_PATH, ["--out", "--help", "--json"]);
	assert.equal(recordLiteral.code, 2);
	assert.equal(readEnvelope(recordLiteral).result.outcome, "failed");
	const verifyLiteral = runCli(VERIFY_CLI_PATH, [
		"scenario-cli-stub-connector",
		"--entrypoint",
		STUB_CONNECTOR_PATH,
		"missing.json",
		"--json",
		"--help",
	]);
	assert.equal(verifyLiteral.code, 1);
	assert.notEqual(readEnvelope(verifyLiteral).result.outcome, "help");
});

test("TTY JSON recording skips terminal prompts and accepts scripted answers", (t) => {
	const tempDir = createTempDir();
	const entrypointPath = join(tempDir, "interaction-connector.mjs");
	writeInteractionConnector(entrypointPath);
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	const unansweredPath = join(tempDir, "unanswered.json");
	const unanswered = runCliWithTtyStdin(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			entrypointPath,
			"--runs",
			"1",
			"--out",
			unansweredPath,
			"--json",
		],
		tempDir,
	);
	assert.equal(unanswered.code, 1, unanswered.stderr);
	const unansweredEnvelope = readEnvelope(unanswered);
	assert.equal(unansweredEnvelope.result.outcome, "incomplete");
	assert.equal(unansweredEnvelope.result.failure_code, "recording_failed");
	assert.equal(unansweredEnvelope.result.capture_complete, false);
	assert.doesNotMatch(
		unanswered.stdout,
		new RegExp(INTERACTION_PROMPT_SENTINEL),
	);

	const answeredPath = join(tempDir, "answered.json");
	const answered = runCliWithTtyStdin(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			entrypointPath,
			"--runs",
			"1",
			"--out",
			answeredPath,
			"--answer",
			"prompt-1=approved",
			"--json",
		],
		tempDir,
	);
	assert.equal(answered.code, 0, answered.stderr);
	const answeredEnvelope = readEnvelope(answered);
	assert.equal(answeredEnvelope.result.outcome, "complete");
	assert.equal(answeredEnvelope.result.capture_complete, true);
	assert.doesNotMatch(answered.stdout, new RegExp(INTERACTION_PROMPT_SENTINEL));
});

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
	const outcome = envelope.result.outcome;
	assert.ok(typeof outcome === "string");
	assert.ok(["complete", "incomplete", "failed", "help"].includes(outcome));
	assert.ok(
		envelope.result.failure_code === null ||
			(typeof envelope.result.failure_code === "string" &&
				["invalid_arguments", "recording_failed"].includes(
					envelope.result.failure_code,
				)),
	);
	assert.ok(
		envelope.result.runs === null || isNonNegativeInteger(envelope.result.runs),
	);
	assert.ok(
		envelope.result.scenario_path === null ||
			typeof envelope.result.scenario_path === "string",
	);
	assert.ok(
		envelope.result.capture_complete === null ||
			typeof envelope.result.capture_complete === "boolean",
	);
	if (envelope.result.outcome === "complete") {
		assertResultStatus(envelope, 0);
		assert.equal(envelope.result.failure_code, null);
		assert.equal(envelope.result.capture_complete, true);
		assert.ok(
			typeof envelope.result.runs === "number" && envelope.result.runs > 0,
		);
	} else if (envelope.result.outcome === "incomplete") {
		assertResultStatus(envelope, 1);
		assert.equal(envelope.result.failure_code, "recording_failed");
		assert.equal(envelope.result.capture_complete, false);
	} else if (envelope.result.outcome === "help") {
		assertResultStatus(envelope, 0);
		assert.equal(envelope.result.failure_code, null);
	} else if (envelope.status === "usage_error") {
		assertResultStatus(envelope, 2);
		assert.equal(envelope.result.failure_code, "invalid_arguments");
	} else {
		assertResultStatus(envelope, 1);
		assert.equal(envelope.result.failure_code, "recording_failed");
	}
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
	const outcome = envelope.result.outcome;
	assert.ok(typeof outcome === "string");
	assert.ok(
		["passed", "mismatch", "rejected", "failed", "help"].includes(outcome),
	);
	assert.ok(
		envelope.result.runs === null || isNonNegativeInteger(envelope.result.runs),
	);
	assert.ok(
		envelope.result.failure_count === null ||
			isNonNegativeInteger(envelope.result.failure_count),
	);
	assert.ok(
		envelope.result.claim === null || typeof envelope.result.claim === "string",
	);
	assert.ok(
		envelope.result.claim_artifact_written === null ||
			typeof envelope.result.claim_artifact_written === "boolean",
	);
	if (envelope.status === "usage_error") {
		assertResultStatus(envelope, 2);
		assert.equal(envelope.result.failure_code, "invalid_arguments");
	} else if (envelope.result.outcome === "passed") {
		assertResultStatus(envelope, 0);
		assert.equal(envelope.result.failure_code, null);
		assert.equal(envelope.result.failure_count, 0);
		assert.ok(
			typeof envelope.result.runs === "number" && envelope.result.runs > 0,
		);
		assert.ok(
			envelope.result.claim === "diagnostic_replay" ||
				envelope.result.claim === "recorded_replay",
		);
	} else if (envelope.result.outcome === "help") {
		assertResultStatus(envelope, 0);
		assert.equal(envelope.result.failure_code, null);
	} else if (envelope.result.outcome === "mismatch") {
		assertResultStatus(envelope, 1);
		assert.equal(envelope.result.failure_code, "replay_mismatch");
		assert.ok(
			typeof envelope.result.failure_count === "number" &&
				envelope.result.failure_count > 0,
		);
	} else if (envelope.result.outcome === "rejected") {
		assertResultStatus(envelope, 1);
		assert.ok(
			envelope.result.failure_code === "invalid_scenario" ||
				envelope.result.failure_code === "verification_failed",
		);
	} else {
		assertResultStatus(envelope, 1);
		assert.equal(envelope.result.failure_code, "verification_failed");
	}
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
	assertOptionDefaults(recordHelp.stderr);

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
	assertOptionDefaults(verifyHelp.stderr);
});

test("scenario-record --json reports capture completion and routes human output to stderr", async (t) => {
	const tempDir = createTempDir();
	let site: StubSite | undefined;
	t.after(async () => {
		await site?.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
	site = await startStubSite(tempDir);
	const scenarioPath = join(tempDir, "scenario.json");
	const recordRun = runCli(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			"--runs=2",
			"--runs=1",
			`--out=${scenarioPath}`,
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
	assert.equal(recordEnvelope.exit_code, 0);
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
		"--out",
		join(tempDir, "unknown-stream.json"),
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

test("scenario-record --json turns malformed answer data and bad URLs into result failures", (t) => {
	const tempDir = createTempDir();
	const answersPath = join(tempDir, "answers.json");
	writeFileSync(answersPath, "{ malformed");
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	const malformedAnswers = runCli(RECORD_CLI_PATH, [
		"scenario-cli-stub-connector",
		"--entrypoint",
		STUB_CONNECTOR_PATH,
		"--answers",
		answersPath,
		"--out",
		join(tempDir, "malformed-answers-scenario.json"),
		"--json",
	]);
	const answerEnvelope = readEnvelope(malformedAnswers);
	assertRecordEnvelope(answerEnvelope);
	assertResultStatus(answerEnvelope, 1);
	assert.equal(answerEnvelope.result.failure_code, "recording_failed");
	assert.doesNotMatch(malformedAnswers.stdout, /malformed|answers\.json/);

	const invalidUrl = runCli(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			"--runs",
			"1",
			"--out",
			join(tempDir, "invalid-url-scenario.json"),
			"--json",
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: "not a URL" },
	);
	const urlEnvelope = readEnvelope(invalidUrl);
	assertRecordEnvelope(urlEnvelope);
	assertResultStatus(urlEnvelope, 1);
	assert.equal(urlEnvelope.result.failure_code, "recording_failed");
});

test("scenario-record --json reports cleanup failures as terminal failures with artifact facts", async (t) => {
	const tempDir = createTempDir();
	const preloadPath = join(tempDir, "cleanup-failure.cjs");
	const cleanupPathFile = join(tempDir, "cleanup-path.txt");
	const scenarioPath = join(tempDir, "cleanup-scenario.json");
	let site: StubSite | undefined;
	let leakedWorkspace: string | undefined;
	t.after(async () => {
		await site?.close();
		if (leakedWorkspace) {
			rmSync(leakedWorkspace, { recursive: true, force: true });
		}
		rmSync(tempDir, { recursive: true, force: true });
	});
	writeCleanupFailurePreload(preloadPath);
	site = await startStubSite(tempDir);
	const cleanupFailure = runCli(
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
		{
			NODE_OPTIONS: `--require=${preloadPath}`,
			PDPP_SCENARIO_STUB_BASE_URL: site.url,
			PDPP_TEST_CLEANUP_PATH: cleanupPathFile,
			TMPDIR: tempDir,
		},
	);
	const envelope = readEnvelope(cleanupFailure);
	assertRecordEnvelope(envelope);
	assertResultStatus(envelope, 1);
	assert.equal(envelope.result.outcome, "failed");
	assert.equal(envelope.result.failure_code, "recording_failed");
	assert.equal(envelope.result.capture_complete, true);
	assert.equal(envelope.result.scenario_path, scenarioPath);
	assert.equal(existsSync(scenarioPath), true);
	leakedWorkspace = readFileSync(cleanupPathFile, "utf8");
	assert.match(leakedWorkspace, /pdpp-scenario-evidence-/);
});

test("scenario-verify --json preserves the claim file and reports pass, mismatch, invalid scenario, and usage errors", async (t) => {
	const tempDir = createTempDir();
	let site: StubSite | undefined;
	t.after(async () => {
		await site?.close();
		rmSync(tempDir, { recursive: true, force: true });
	});
	site = await startStubSite(tempDir);
	const scenarioPath = join(tempDir, "scenario.json");
	const recordRun = runCli(
		RECORD_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			"--runs",
			"2",
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
	const legacyScenarioPath = join(tempDir, "legacy-scenario.json");
	const legacyScenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
		capture: Record<string, unknown>;
	};
	delete legacyScenario.capture.captured_at;
	writeFileSync(legacyScenarioPath, JSON.stringify(legacyScenario));
	const legacyClaimPath = join(tempDir, "legacy-claim.json");
	const legacyVerify = runCli(
		VERIFY_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			legacyScenarioPath,
			"--json",
			legacyClaimPath,
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: site.url },
	);
	const legacyEnvelope = readEnvelope(legacyVerify);
	assertVerifyEnvelope(legacyEnvelope);
	assertResultStatus(legacyEnvelope, 0);
	assert.equal(legacyEnvelope.result.outcome, "passed");
	const legacyClaim = JSON.parse(
		readFileSync(legacyClaimPath, "utf8"),
	) as Record<string, unknown>;
	assert.equal(Object.hasOwn(legacyClaim, "captured_at"), false);
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
	assert.equal(
		humanVerifyRun.code,
		0,
		`stdout=${humanVerifyRun.stdout} stderr=${humanVerifyRun.stderr}`,
	);
	assert.match(humanVerifyRun.stdout, /VERIFYING scenario-cli-stub-connector/);
	assert.match(humanVerifyRun.stdout, /diagnostic_replay: PASS/);

	const claimPath = join(tempDir, "claim.json");
	const verifyArgs = [
		"scenario-cli-stub-connector",
		"--entrypoint",
		STUB_CONNECTOR_PATH,
		scenarioPath,
		`--json=${join(tempDir, "ignored-claim.json")}`,
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
	assert.equal(verifyEnvelope.result.runs, 2);
	assert.equal(verifyEnvelope.result.failure_count, 0);
	assert.equal(verifyEnvelope.result.claim, "diagnostic_replay");
	assert.equal(verifyEnvelope.result.claim_artifact_written, true);
	assert.equal(
		(JSON.parse(readFileSync(claimPath, "utf8")) as { schema: string }).schema,
		"pdpp.connector-claim/1",
	);
	const claim = JSON.parse(readFileSync(claimPath, "utf8")) as Record<
		string,
		unknown
	>;
	assert.equal(claim.claim, "diagnostic_replay");
	assert.equal(claim.runs, 2);
	assert.equal(typeof claim.captured_at, "string");
	assert.equal(typeof claim.verified_at, "string");
	assert.deepEqual(claim.drivers, ["recorded-http"]);
	assert.deepEqual(claim.coverage, [
		"empty_state_run",
		"state_seeded_second_run_with_changed_requests",
	]);
	assert.deepEqual(claim.captured_with, {
		source_digest: null,
		declaration_digest: null,
	});
	assert.deepEqual(claim.verified_subject, {
		source_digest: null,
		declaration_digest: null,
	});
	assert.equal(Object.hasOwn(claim, "entrypoint_digest"), false);
	assert.equal(existsSync(join(tempDir, "ignored-claim.json")), false);
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
	const mismatchClaimPath = join(tempDir, "mismatch-claim.json");
	const oldClaimBytes = "previous claim must remain untouched\n";
	writeFileSync(mismatchClaimPath, oldClaimBytes);
	const mismatchRun = runCli(
		VERIFY_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			mismatchPath,
			"--json",
			mismatchClaimPath,
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
	assert.equal(readFileSync(mismatchClaimPath, "utf8"), oldClaimBytes);
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
	assert.equal(existsSync(join(tempDir, "invalid-claim.json")), false);

	const failedClaimPath = join(tempDir, "claim-directory");
	mkdirSync(failedClaimPath);
	const claimWriteFailure = runCli(
		VERIFY_CLI_PATH,
		[
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
			scenarioPath,
			"--json",
			failedClaimPath,
		],
		{ PDPP_SCENARIO_STUB_BASE_URL: site.url },
	);
	const claimWriteEnvelope = readEnvelope(claimWriteFailure);
	assertVerifyEnvelope(claimWriteEnvelope);
	assertResultStatus(claimWriteEnvelope, 0);
	assert.equal(claimWriteEnvelope.result.outcome, "passed");
	assert.equal(claimWriteEnvelope.result.claim_artifact_written, false);

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

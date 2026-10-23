// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end proof for `bin/scenario-record.ts` and `bin/scenario-verify.ts`
 * — the developer capture→verify loop for the connector-verification
 * scenario harness (src/scenario/*.ts) — driven as REAL subprocesses (not
 * in-process imports), with NO live network anywhere in this test.
 *
 * Mirrors bin/connector-dev.test.ts's shape (spawnSync the CLI, assert on
 * stdout/exit code/written artifacts) but proves the two-CLI capture→verify
 * loop instead of the single run-and-summarize command, using the
 * `--entrypoint` dev/test-only override (same flag both CLIs mirror from
 * bin/connector-dev.ts) to point at `src/test-fixtures/scenario-cli-stub-
 * connector.ts` instead of a registered production connector.
 *
 * "No live network" here means: the stub connector's `fetch` calls target
 * `PDPP_SCENARIO_STUB_BASE_URL`, a synthetic HTTP provider this test starts
 * on 127.0.0.1 — recording passes through to that loopback server, never
 * the public internet. Verify then replays strictly offline against the
 * scenario file, with no dependency on the synthetic provider being up at
 * all (proven below by closing it before the verify step).
 *
 * FINDING that shapes this file's provider setup: the synthetic provider
 * MUST run as its own separate `node` process, not an in-process
 * `http.createServer` inside this `node --test` test file. Confirmed by
 * direct reproduction: an HTTP server bound inside a `node --test`-run
 * process is unreachable over loopback from any external process in this
 * environment (even plain `curl 127.0.0.1:<port>` hangs to timeout) —
 * `node --test`'s process isolation (this repo runs with
 * `--test-isolation=process`) evidently sandboxes that process's network
 * surface from external processes, while a server bound by a plain `node`
 * process (no `--test`) is reachable exactly as expected. Since
 * bin/scenario-record.ts's whole point is driving the connector as a REAL
 * OS subprocess, the provider it talks to has to be reachable from outside
 * this test's own process — so it's spawned here as a standalone `node`
 * script, the same "write a temp module, spawn it, capture its bound port"
 * shape src/scenario/subprocess-fetch-preloads.ts already uses for preloads.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { hashCanonicalJson } from "@pdpp/collector-runtime";
import { packageRoot as PACKAGE_ROOT } from "../src/connector-paths.ts";
import { getConnectorPaths } from "../src/orchestrator.ts";
import type { ConnectorScenario } from "../src/scenario/format.ts";
import { namespaceSkip } from "../src/scenario/namespace-skip.ts";
import {
	computeDeclarationDigest,
	computeSourceDigest,
} from "../src/scenario/validate.ts";
import { assertValidInteractionMessage } from "../src/scenario/wire-registry.ts";
import {
	createInactivityWatchdog as createRecordInactivityWatchdog,
	MAX_SELECTION_CONTEXT_LENGTH,
	selectionContextKey,
} from "./scenario-record.ts";
import {
	assertNoPostRunSourceMutation,
	createInactivityWatchdog as createVerifyInactivityWatchdog,
	parseArgs as parseVerifyArgs,
	resolveDumpRecordsDir,
} from "./scenario-verify.ts";

const RECORD_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-record.ts");
const VERIFY_CLI_PATH = join(PACKAGE_ROOT, "bin", "scenario-verify.ts");
const STUB_CONNECTOR_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"scenario-cli-stub-connector.ts",
);
const WATCHDOG_STUB_CONNECTOR_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"scenario-watchdog-paced-connector.ts",
);
const TIMER_ORDER_CONNECTOR_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"scenario-timer-ordering-connector.ts",
);

/**
 * Generated fixture connectors that import `src/connector-runtime.ts` (which
 * in turn imports "@pdpp/connector-protocol") must be written INSIDE this
 * package tree, not under `os.tmpdir()`. Node's package-exports resolution
 * walks up from a module's own path looking for the nearest `node_modules`;
 * from `/tmp` (or any path outside this workspace) that walk never finds
 * this package's `node_modules/@pdpp/connector-protocol`, so the spawned
 * subprocess dies with ERR_PACKAGE_PATH_NOT_EXPORTED before the test's real
 * assertion ever runs. Proven by direct reproduction: the identical fixture
 * file resolves fine from inside the package tree and fails the same way
 * from `/tmp`.
 *
 * `tmp/` (this package's own scratch dir, not `os.tmpdir()`) is used
 * instead — it's already covered by the repo-root `.gitignore`'s bare
 * `tmp/` pattern, so nothing generated here is ever committable. Pure
 * fixtures that only import `node:*` builtins (e.g. the stub HTTP providers
 * below) don't hit this resolution problem and stay under `os.tmpdir()`.
 */
const PACKAGE_TMP_DIR = join(PACKAGE_ROOT, "tmp");

function packageScratchDir(): string {
	mkdirSync(PACKAGE_TMP_DIR, { recursive: true });
	return PACKAGE_TMP_DIR;
}

// ─── Synthetic HTTP provider (the stub connector's "real" upstream), run as
// a standalone `node` subprocess — see the module docstring FINDING above
// for why this can't be an in-process http.createServer. ──────────────────

interface StubItem {
	id: string;
	value: string;
}

interface StubProvider {
	close: () => Promise<void>;
	url: string;
}

const RUN1_PAGE1: StubItem[] = [
	{ id: "item-1", value: "alpha" },
	{ id: "item-2", value: "bravo" },
];
const RUN1_PAGE2: StubItem[] = [{ id: "item-3", value: "charlie" }];
const RUN2_TAIL: StubItem[] = [{ id: "item-4", value: "delta" }];

/**
 * Spawns a standalone `node` process serving GET /items with cursor
 * pagination for run 1 (state:null; two pages) and a single incremental
 * page for run 2 (state carries `since` from run 1's committed state) — the
 * same full-refresh/incremental split connectors/oura/scenario.spike.test.ts
 * proves against the real oura connector, reused here for the stub so the
 * CLI proof covers both a paginated run and a state-seeded incremental run.
 * The child prints `PORT <n>` on stdout once bound; this function resolves
 * once that line is observed.
 */
function startStubProvider(): Promise<StubProvider> {
	const scriptPath = join(
		tmpdir(),
		`pdpp-scenario-cli-test-stub-provider-${String(process.pid)}-${String(Date.now())}.mjs`,
	);
	const src = `
import { createServer } from "node:http";
const RUN1_PAGE1 = ${JSON.stringify(RUN1_PAGE1)};
const RUN1_PAGE2 = ${JSON.stringify(RUN1_PAGE2)};
const RUN2_TAIL = ${JSON.stringify(RUN2_TAIL)};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/items") {
    res.writeHead(404);
    res.end();
    return;
  }
  const since = url.searchParams.get("since");
  const cursor = url.searchParams.get("cursor");
  let body;
  if (since) {
    body = { items: RUN2_TAIL, next_cursor: null };
  } else if (cursor === "page2") {
    body = { items: RUN1_PAGE2, next_cursor: null };
  } else {
    body = { items: RUN1_PAGE1, next_cursor: "page2" };
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT " + server.address().port);
});
`;
	writeFileSync(scriptPath, src);

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let closed = false;
		// `close()` is called twice in the happy path (once deliberately before
		// verify, once in the test's `finally`) — MUST be idempotent. A second
		// `child.kill()` on an already-exited process is a no-op that never
		// fires another "close" event, which left an earlier version of this
		// helper's Promise permanently unresolved on the second call (the whole
		// test hung past its timeout waiting on that second `await
		// stubProvider.close()` even though every assertion had already run and
		// passed).
		const closePromise = (): Promise<void> =>
			new Promise((closeResolve) => {
				if (closed) {
					closeResolve();
					return;
				}
				closed = true;
				child.once("close", () => closeResolve());
				child.kill();
			});
		const onData = (chunk: Buffer): void => {
			stdoutBuffer += chunk.toString();
			const match = /PORT (\d+)/.exec(stdoutBuffer);
			if (match?.[1]) {
				child.stdout.off("data", onData);
				resolve({
					url: `http://127.0.0.1:${match[1]}`,
					close: closePromise,
				});
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (!stdoutBuffer.includes("PORT")) {
				reject(
					new Error(
						`stub provider exited before binding (code=${String(code)}): ${stderrBuffer}`,
					),
				);
			}
		});
	});
}

// ─── CLI drivers ────────────────────────────────────────────────────────

function runRecordCli(
	args: readonly string[],
	extraEnv: Record<string, string>,
): { code: number | null; stderr: string; stdout: string } {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", RECORD_CLI_PATH, ...args],
		{
			cwd: PACKAGE_ROOT,
			env: { ...process.env, ...extraEnv },
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runVerifyCli(
	args: readonly string[],
	extraEnv: Record<string, string> = {},
): { code: number | null; stderr: string; stdout: string } {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", VERIFY_CLI_PATH, ...args],
		{
			cwd: PACKAGE_ROOT,
			env: { ...process.env, ...extraEnv },
			encoding: "utf8",
			timeout: 30_000,
		},
	);
	return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

// ─── The end-to-end proof ───────────────────────────────────────────────

test("scenario-record + scenario-verify: record against a stub connector's loopback upstream, verify PASS offline, then a tampered scenario fails verify non-zero", async (t) => {
	const stubProvider = await startStubProvider();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-test-"));
	const scenarioPath = join(tmpDir, "stub.scenario.json");

	try {
		// ── RECORD: two runs (default --runs 2) against the stub's loopback upstream ──
		const recordResult = runRecordCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				"--out",
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url },
		);

		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.match(
			recordResult.stdout,
			/RECORDING scenario-cli-stub-connector — run 1/,
		);
		assert.match(
			recordResult.stdout,
			/RECORDING scenario-cli-stub-connector — run 2/,
		);
		assert.match(
			recordResult.stdout,
			new RegExp(`wrote scenario to: ${scenarioPath}`),
		);
		assert.match(recordResult.stdout, /runs captured: 2/);
		assert.match(recordResult.stdout, /interactions recorded: 3/); // run1: 2 pages, run2: 1 page
		assert.match(recordResult.stdout, /normalizers: api_token/);
		assert.match(recordResult.stdout, /complete: true/);
		assert.match(
			recordResult.stdout,
			/recorded_replay candidate scenario captured .+ \(candidate oracle - see docs\/reference\/connector-evidence-claims\.md\)/,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(scenario.format, "pdpp.connector-scenario/1");
		assert.equal(scenario.connector.id, "scenario-cli-stub-connector");
		// Synthetic evidence must never wear a real-derived label (expert
		// review, FIX 4; reaffirmed by the third independent review's P1-2 — "a
		// disclaimer beside an overstrong enum does not make the label safe",
		// which is why the positive label itself is now the honest
		// "non_loopback_contact_observed" rather than "derived-from-real"): this
		// capture's ENTIRE observed provider contact is the stub HTTP server on
		// 127.0.0.1 — loopback, not the connector's real upstream — so
		// `evidence_class` must be mechanically assigned "synthetic-spike",
		// never a real-contact label, regardless of how realistic the capture
		// otherwise looks (real pagination, real incremental-state seeding, a
		// real recorded credential normalizer).
		assert.equal(scenario.capture.evidence_class, "synthetic-spike");
		assert.equal(scenario.capture.provider_contact?.loopback_only, true);
		assert.equal(scenario.capture.privacy_class, "local-only");
		assert.equal(scenario.capture.complete, true);
		assert.equal(scenario.runs.length, 2);
		assert.equal(scenario.runs[0]?.interactions.length, 2, "run 1: 2 pages");
		assert.equal(
			scenario.runs[1]?.interactions.length,
			1,
			"run 2: 1 incremental page",
		);
		assert.deepEqual(scenario.runs[0]?.expected.records.items?.ids, [
			"item-1",
			"item-2",
			"item-3",
		]);
		assert.deepEqual(scenario.runs[1]?.expected.records.items?.ids, ["item-4"]);
		assert.equal(scenario.runs[1]?.start.state_from_run, 0);

		// No credential value anywhere in the captured file.
		assert.doesNotMatch(
			readFileSync(scenarioPath, "utf8"),
			/stub-token-never-persisted/,
		);

		// ── Close the stub provider BEFORE verifying: proves replay is strictly
		// offline and does not depend on the recording upstream being reachable.
		// PDPP_SCENARIO_STUB_BASE_URL is still passed through — the stub
		// connector needs SOME base URL to construct request URLs from (the
		// replay matcher matches on the full method+origin+path+query), but
		// that origin is never actually dialed: the NODE_OPTIONS replay preload
		// intercepts `fetch` before any request reaches the network, bridging
		// it to this test process's in-memory replay matcher instead. The
		// closed server proves that redirection, not a live round-trip. ──
		await stubProvider.close();

		// ── VERIFY: must PASS both runs, strictly offline ──
		const verifyResult = runVerifyCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				scenarioPath,
			],
			{
				PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url,
			},
		);

		assert.equal(
			verifyResult.code,
			0,
			`scenario-verify failed: stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(verifyResult.stdout, /run 0: PASS/);
		assert.match(verifyResult.stdout, /run 1: PASS/);
		assert.match(verifyResult.stdout, /interactions replayed: 3/);
		// FIX 1 (P1-1, repair wave 3A; declaration-binding split repair wave 4):
		// a --entrypoint replay is an "unbound entrypoint replay" and also has no
		// captured_with identity on EITHER half (no bound manifest/connector
		// directory to compute a current digest against) —
		// evaluateClaimEligibility (src/scenario/claims.ts) withholds the
		// stronger recorded_replay claim for all of these reasons and prints
		// diagnostic_replay: PASS instead. This is the same passing verification
		// as before FIX 1 — only the printed claim strength changed, not the
		// pass/fail outcome.
		assert.match(
			verifyResult.stdout,
			/diagnostic_replay: PASS \(captured .+\)/,
		);
		assert.match(verifyResult.stdout, /recorded_replay: WITHHELD/);
		assert.match(verifyResult.stdout, /limitations:/);
		assert.match(verifyResult.stdout, / {2}- unbound entrypoint replay/);
		assert.match(
			verifyResult.stdout,
			/ {2}- no capture-time declaration digest/,
		);
		assert.match(verifyResult.stdout, / {2}- no capture-time source digest/);
		assert.match(
			verifyResult.stdout,
			/ {2}- current manifest missing - declaration digest not computed/,
		);
		assert.match(
			verifyResult.stdout,
			/ {2}- current connector source missing - source digest not computed/,
		);
		assert.match(verifyResult.stdout, /claim: diagnostic_replay/);
		assert.match(verifyResult.stdout, /scenario status: candidate oracle/);
		assert.match(
			verifyResult.stdout,
			/coverage: empty_state_run, state_seeded_second_run_with_changed_requests/,
		);

		t.diagnostic(`record stdout:\n${recordResult.stdout}`);
		t.diagnostic(`verify stdout:\n${verifyResult.stdout}`);

		// ── NEGATIVE CONTROL: tamper the scenario file, verify must fail non-zero ──
		const tamperedPath = join(tmpDir, "stub.tampered.scenario.json");
		const tampered: ConnectorScenario = JSON.parse(
			JSON.stringify(scenario),
		) as ConnectorScenario;
		const firstInteraction = tampered.runs[0]?.interactions[0];
		if (
			!(
				firstInteraction &&
				typeof firstInteraction.response.body === "object" &&
				firstInteraction.response.body
			)
		) {
			throw new Error(
				"test setup: expected run 0 interaction 0 to have an object body",
			);
		}
		const tamperedBody = firstInteraction.response.body as {
			items: StubItem[];
		};
		const [firstItem] = tamperedBody.items;
		if (!firstItem) {
			throw new Error(
				"test setup: expected at least one item in the tampered page",
			);
		}
		firstItem.value = "TAMPERED";
		writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2));

		const tamperedVerifyResult = runVerifyCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				tamperedPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url },
		);

		assert.notEqual(
			tamperedVerifyResult.code,
			0,
			"a tampered scenario must fail verification non-zero",
		);
		assert.match(tamperedVerifyResult.stdout, /run 0: FAIL/);
		assert.match(tamperedVerifyResult.stdout, /record_hash/);
		assert.match(tamperedVerifyResult.stdout, /FAIL — \d+ failure\(s\)/);
		assert.doesNotMatch(tamperedVerifyResult.stdout, /recorded_replay: PASS/);

		t.diagnostic(`tampered verify stdout:\n${tamperedVerifyResult.stdout}`);
	} finally {
		await stubProvider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── --dump-records: a failed replay's mismatched records, written for a
// maintainer to actually look at (the motivating case: a real 1-in-41
// intermittent reddit replay mismatch whose printed detail line named only
// two hashes, with no way to see what had changed). ─────────────────────────

test("scenario-verify --dump-records: dumps exactly the mismatched record(s) on failure (hash round-trips from `projected`), honors flag-over-env precedence, enforces 0700/0600 modes, writes nothing on a pass, and leaves the no-flag path unchanged", async (t) => {
	const stubProvider = await startStubProvider();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-dump-test-"));
	const scenarioPath = join(tmpDir, "stub.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				"--out",
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url },
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		await stubProvider.close();

		const verifyBaseArgs = [
			"scenario-cli-stub-connector",
			"--entrypoint",
			STUB_CONNECTOR_PATH,
		];
		const verifyEnv = { PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url };

		// ── Regression anchor: a passing verify with no dump flag/env present,
		// run twice, to prove the feature is a no-op when unused — no new
		// "dumped"/"WARNING" lines leak into the default path's stdout. ──
		const baselineVerify = runVerifyCli(
			[...verifyBaseArgs, scenarioPath],
			verifyEnv,
		);
		assert.equal(baselineVerify.code, 0);
		assert.doesNotMatch(baselineVerify.stdout, /dumped \d+ mismatched record/);
		assert.doesNotMatch(
			baselineVerify.stdout,
			/WARNING: dump directory contains collected personal data/,
		);
		const regressionVerify = runVerifyCli(
			[...verifyBaseArgs, scenarioPath],
			verifyEnv,
		);
		assert.equal(
			regressionVerify.stdout,
			baselineVerify.stdout,
			"verify output without --dump-records must be byte-identical run to run",
		);
		assert.equal(regressionVerify.code, baselineVerify.code);

		// ── A passing verify WITH --dump-records must still write nothing —
		// not even the directory. ──
		const noMismatchDumpDir = join(tmpDir, "dump-no-mismatch");
		const passWithDump = runVerifyCli(
			[...verifyBaseArgs, scenarioPath, "--dump-records", noMismatchDumpDir],
			verifyEnv,
		);
		assert.equal(passWithDump.code, 0);
		assert.equal(
			existsSync(noMismatchDumpDir),
			false,
			"a passing verify must not create the dump directory at all",
		);

		// ── Tamper run 0's first item (same mechanism as the record_hash
		// regression test above) so `items` fails record_hash on replay. ──
		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const tamperedPath = join(tmpDir, "stub.tampered.scenario.json");
		const tampered: ConnectorScenario = JSON.parse(
			JSON.stringify(scenario),
		) as ConnectorScenario;
		const firstInteraction = tampered.runs[0]?.interactions[0];
		if (
			!(
				firstInteraction &&
				typeof firstInteraction.response.body === "object" &&
				firstInteraction.response.body
			)
		) {
			throw new Error(
				"test setup: expected run 0 interaction 0 to have an object body",
			);
		}
		const tamperedBody = firstInteraction.response.body as {
			items: StubItem[];
		};
		const [firstItem] = tamperedBody.items;
		if (!firstItem) {
			throw new Error(
				"test setup: expected at least one item in the tampered page",
			);
		}
		firstItem.value = "TAMPERED-FOR-DUMP";
		writeFileSync(tamperedPath, JSON.stringify(tampered, null, 2));

		// ── --dump-records on a mismatch: writes exactly the mismatched
		// record(s), the directory/file modes are 0700/0600, and the hash
		// round-trips from the dumped `projected` value. ──
		const flagDumpDir = join(tmpDir, "dump-flag");
		const flagVerify = runVerifyCli(
			[...verifyBaseArgs, tamperedPath, "--dump-records", flagDumpDir],
			verifyEnv,
		);
		assert.notEqual(flagVerify.code, 0);
		assert.match(flagVerify.stdout, /run 0: FAIL/);
		assert.match(flagVerify.stdout, /dumped \d+ mismatched record\(s\) to /);
		assert.match(
			flagVerify.stdout,
			/WARNING: dump directory contains collected personal data/,
		);

		const dirMode = statSync(flagDumpDir).mode & 0o777;
		assert.equal(
			dirMode,
			0o700,
			`dump dir mode expected 0700, got ${dirMode.toString(8)}`,
		);
		const dumpFilePath = join(flagDumpDir, "run0-items.json");
		assert.equal(existsSync(dumpFilePath), true);
		const fileMode = statSync(dumpFilePath).mode & 0o777;
		assert.equal(
			fileMode,
			0o600,
			`dump file mode expected 0600, got ${fileMode.toString(8)}`,
		);

		const dumped = JSON.parse(readFileSync(dumpFilePath, "utf8")) as Array<{
			actual_sha256: string;
			expected_sha256: string | null;
			id: string;
			op: string;
			projected: unknown;
		}>;
		assert.equal(
			dumped.length,
			1,
			"exactly one record (item-1) actually mismatched by content",
		);
		assert.equal(dumped[0]?.id, "item-1");
		assert.equal(dumped[0]?.op, "upsert");
		assert.notEqual(dumped[0]?.expected_sha256, dumped[0]?.actual_sha256);
		assert.equal(
			hashCanonicalJson(dumped[0]?.projected),
			dumped[0]?.actual_sha256,
			"hashing the dumped `projected` value must reproduce the dumped actual_sha256 exactly",
		);

		// ── PDPP_SCENARIO_DUMP_DIR alone also enables dumping. ──
		const envDumpDir = join(tmpDir, "dump-env");
		const envVerify = runVerifyCli([...verifyBaseArgs, tamperedPath], {
			...verifyEnv,
			PDPP_SCENARIO_DUMP_DIR: envDumpDir,
		});
		assert.notEqual(envVerify.code, 0);
		assert.equal(
			existsSync(join(envDumpDir, "run0-items.json")),
			true,
			"PDPP_SCENARIO_DUMP_DIR alone must enable dumping",
		);

		// ── The --dump-records flag wins over the env var when both are set. ──
		const flagWinsDir = join(tmpDir, "dump-flag-wins");
		const envLosesDir = join(tmpDir, "dump-env-loses");
		const precedenceVerify = runVerifyCli(
			[...verifyBaseArgs, tamperedPath, "--dump-records", flagWinsDir],
			{
				...verifyEnv,
				PDPP_SCENARIO_DUMP_DIR: envLosesDir,
			},
		);
		assert.notEqual(precedenceVerify.code, 0);
		assert.equal(
			existsSync(join(flagWinsDir, "run0-items.json")),
			true,
			"the --dump-records flag's directory must receive the dump",
		);
		assert.equal(
			existsSync(envLosesDir),
			false,
			"the env var's directory must not be used when --dump-records is also passed",
		);

		// ── --dump-all-records: every record of the mismatching stream, not
		// just the mismatched one. ──
		const dumpAllDir = join(tmpDir, "dump-all");
		const dumpAllVerify = runVerifyCli(
			[
				...verifyBaseArgs,
				tamperedPath,
				"--dump-records",
				dumpAllDir,
				"--dump-all-records",
			],
			verifyEnv,
		);
		assert.notEqual(dumpAllVerify.code, 0);
		const dumpAllRecords = JSON.parse(
			readFileSync(join(dumpAllDir, "run0-items.json"), "utf8"),
		) as Array<{
			id: string;
		}>;
		assert.deepEqual(
			dumpAllRecords.map((r) => r.id),
			["item-1", "item-2", "item-3"],
			"--dump-all-records must dump every record of the stream, not just the mismatched one",
		);

		t.diagnostic(`flag verify stdout:\n${flagVerify.stdout}`);
	} finally {
		await stubProvider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── evidence_class: a loopback-only capture can NEVER be
// non_loopback_contact_observed (expert review, FIX 4/FIX 1; label renamed
// from derived-from-real per the third independent review's P1-2 — "a
// disclaimer beside an overstrong enum does not make the label safe") — a
// standalone, narrowly-scoped regression independent of the larger combined
// test above, so this specific invariant stays pinned even if that test's
// other assertions change. ──────────────────────────────────────────────

test("scenario-record: a capture whose ENTIRE provider contact is loopback is always evidence_class synthetic-spike, never non_loopback_contact_observed", async () => {
	const stubProvider = await startStubProvider();
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-loopback-evidence-test-"),
	);
	const scenarioPath = join(tmpDir, "loopback.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url },
		);

		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.match(recordResult.stdout, /evidence_class: synthetic-spike/);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		// Sanity check the setup: this capture DID observe real requests (not
		// the zero-requests case) — it's specifically loopback_only that must
		// drive the classification here, proving condition (b) on its own.
		assert.ok(
			(scenario.capture.provider_contact?.completed_requests ?? 0) > 0,
			"test setup: expected at least one observed request",
		);
		assert.equal(scenario.capture.provider_contact?.loopback_only, true);
		assert.equal(scenario.capture.evidence_class, "synthetic-spike");
		assert.notEqual(
			scenario.capture.evidence_class,
			"non_loopback_contact_observed",
		);
		assert.notEqual(scenario.capture.evidence_class, "derived-from-real");
	} finally {
		await stubProvider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── state_seeded_second_run_with_changed_requests must not be claimed from
// a vacuous seed (this coverage flag was renamed from incremental_two_run —
// see bin/scenario-verify.ts's printCoverageReport doc comment) ──────────

/**
 * A minimal connector purpose-built to construct a scenario that satisfies
 * the OLD (pre-fix) incremental_two_run test — state_from_run set, run 1's
 * requests differ from run 0's — while run 0's OWN committed final_state is
 * genuinely, legitimately `{}` (it never emits a STATE message at all).
 * Every run PASSES on its own terms (the recorded interactions really do
 * match what this connector does), so the scenario reaches
 * scenario-verify's coverage computation instead of failing before it —
 * unlike tampering an existing recording's expected.final_state, which
 * would make that run's own final_state assertion fail and short-circuit
 * before coverage is ever computed.
 *
 * The connector-runtime defaults an omitted START.state to `{}`
 * (connector-runtime.ts: `startMsg.state ?? {}`), so run 0 (truly
 * unseeded) and run 1 (seeded from run 0's vacuous `{}`) are literally
 * indistinguishable from the connector's OWN point of view — both see
 * `state = {}`. That is realistic and exactly why the bug this fixture
 * proves matters: a connector can't self-detect a vacuous seed, so the
 * "requests differ" heuristic alone is not proof of real incremental
 * narrowing. To still get run 1's request to differ from run 0's (for a
 * reason that has NOTHING to do with incremental narrowing — e.g. it might
 * just be retry jitter or an unrelated code path), this fixture reads a
 * counter file, one integer per invocation, and bakes the count into the
 * query string. Each recorded/replayed run's request is still fully
 * deterministic (fixed per that run's own single invocation during
 * recording), so replay matching is unaffected.
 *
 * The counter file's path is resolved from `os.tmpdir()` INSIDE the
 * connector subprocess at runtime, not baked in as an absolute path by this
 * test process — `scenario-record` runs unisolated (real host `tmpdir()`),
 * but `scenario-verify` runs the connector under default-deny filesystem
 * isolation with `TMPDIR` redirected to a sandbox-local scratch dir inside
 * that run's `filesystemBindPath` (isolation.ts's `sandboxScratchEnv`) — the
 * one path guaranteed writable there. A path captured by baking in this
 * test's own `os.tmpdir()` (the host's, e.g. `/tmp/...`) is invisible under
 * that isolation (confirmed by direct reproduction: `ENOENT` opening it from
 * inside the sandboxed child), because it lies outside the one directory the
 * isolation closure binds read-write. Calling `tmpdir()` fresh inside the
 * connector process instead resolves correctly in both contexts: the real
 * host tmp during record, the sandbox-local tmp during verify. Verify
 * creates ONE evidence workspace shared across every run in that single CLI
 * invocation (bin/scenario-verify.ts's `main`), so the counter still
 * persists across run 0 → run 1 within one verify call, same as it does
 * across record's two runs. `COUNTER_FILENAME` only needs to be unique
 * enough not to collide with a concurrent test process — it is not a full
 * path.
 */
function writeVacuousSeedConnector(counterFilename: string): string {
	const connectorRuntimePath = join(
		PACKAGE_ROOT,
		"src",
		"connector-runtime.ts",
	);
	const scriptPath = join(
		packageScratchDir(),
		`pdpp-vacuous-seed-connector-${String(process.pid)}-${String(Date.now())}.ts`,
	);
	const src = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecordData, ValidateRecord } from ${JSON.stringify(connectorRuntimePath)};
import { runConnector } from ${JSON.stringify(connectorRuntimePath)};

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });
const COUNTER_FILENAME = ${JSON.stringify(counterFilename)};

runConnector({
  name: "vacuous-seed-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const baseUrl = process.env.PDPP_SCENARIO_STUB_BASE_URL;
    if (!baseUrl) {
      throw new Error("vacuous-seed-connector: PDPP_SCENARIO_STUB_BASE_URL is not set");
    }
    await emit({ type: "PROGRESS", stream: "items", message: "collecting" });
    const counterPath = join(tmpdir(), COUNTER_FILENAME);
    const invocation = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
    writeFileSync(counterPath, String(invocation));
    const url = new URL("/items", baseUrl);
    url.searchParams.set("invocation", String(invocation));
    const res = await fetch(url);
    const body = (await res.json()) as { id: string; value: string };
    await emitRecord("items", { id: body.id, value: body.value });
    // Deliberately NO STATE message — this run's committed final_state is
    // always {} (mergeStateMessages with zero STATE messages), regardless
    // of what it was seeded with.
  },
});
`;
	writeFileSync(scriptPath, src);
	return scriptPath;
}

function startVacuousSeedProvider(): Promise<StubProvider> {
	const scriptPath = join(
		tmpdir(),
		`pdpp-vacuous-seed-provider-${String(process.pid)}-${String(Date.now())}.mjs`,
	);
	const src = `
import { createServer } from "node:http";
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/items") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "item-1", value: "alpha" }));
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT " + server.address().port);
});
`;
	writeFileSync(scriptPath, src);
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let closed = false;
		const closePromise = (): Promise<void> =>
			new Promise((closeResolve) => {
				if (closed) {
					closeResolve();
					return;
				}
				closed = true;
				child.once("close", () => closeResolve());
				child.kill();
			});
		const onData = (chunk: Buffer): void => {
			stdoutBuffer += chunk.toString();
			const match = /PORT (\d+)/.exec(stdoutBuffer);
			if (match?.[1]) {
				child.stdout.off("data", onData);
				resolve({ url: `http://127.0.0.1:${match[1]}`, close: closePromise });
			}
		};
		child.stdout.on("data", onData);
		child.on("error", reject);
	});
}

test("scenario-verify: state_seeded_second_run_with_changed_requests is not claimed when the seeding run's expected.final_state is vacuous ({})", async (t) => {
	const provider = await startVacuousSeedProvider();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-vacuous-seed-test-"));
	const counterFilename = `pdpp-vacuous-seed-counter-${String(process.pid)}-${String(Date.now())}.txt`;
	// Record runs unisolated, so the connector's own `tmpdir()` resolves to
	// the real host tmp — this is the SAME file the connector will read/write
	// during record, computed the identical way, purely so the test can reset
	// it before verify (see below).
	const recordCounterPath = join(tmpdir(), counterFilename);
	const connectorPath = writeVacuousSeedConnector(counterFilename);
	const scenarioPath = join(tmpDir, "vacuous-seed.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"vacuous-seed-connector",
				"--entrypoint",
				connectorPath,
				"--out",
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: provider.url },
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(scenario.runs.length, 2, "expected the default --runs 2");
		// Confirm the setup actually produced a vacuous seed and genuinely
		// differing requests — otherwise this test wouldn't be exercising what
		// it claims to.
		assert.deepEqual(
			scenario.runs[0]?.expected.final_state,
			{},
			"run 0's committed state must be vacuous ({})",
		);
		assert.equal(scenario.runs[1]?.start.state_from_run, 0);
		assert.notDeepEqual(
			scenario.runs[1]?.interactions.map((i) => i.request),
			scenario.runs[0]?.interactions.map((i) => i.request),
			"run 1's requests must genuinely differ from run 0's (the invocation counter param)",
		);

		await provider.close();

		// Reset the invocation counter before verify. This only needs to clean
		// up RECORD's counter file (real host tmp, since record is unisolated):
		// verify's own connector invocations run isolated with a fresh
		// evidence workspace/sandbox-local tmp created by that scenario-verify
		// process (bin/scenario-verify.ts's `main` calls
		// `createScenarioEvidenceWorkspace()` once per CLI invocation), so
		// there is no stale counter file for verify to inherit there in the
		// first place — but this SAME filename would otherwise still resolve
		// to the leftover host-tmp file if isolation weren't available (the
		// process-local-only fallback shares the real `tmpdir()` with record),
		// so the reset must still happen unconditionally here.
		rmSync(recordCounterPath, { force: true });

		const verifyResult = runVerifyCli(
			["vacuous-seed-connector", "--entrypoint", connectorPath, scenarioPath],
			{
				PDPP_SCENARIO_STUB_BASE_URL: provider.url,
			},
		);

		assert.equal(
			verifyResult.code,
			0,
			`scenario-verify failed: stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(verifyResult.stdout, /run 0: PASS/);
		assert.match(verifyResult.stdout, /run 1: PASS/);
		// FIX 1 (P1-1): --entrypoint mode is an unbound entrypoint replay with no
		// capture-time identity — the stronger recorded_replay claim is withheld
		// (see the matching comment on the combined record+verify test above).
		assert.match(verifyResult.stdout, /diagnostic_replay: PASS/);
		assert.match(verifyResult.stdout, /recorded_replay: WITHHELD/);
		// The crux: despite state_from_run being set AND requests genuinely
		// differing (the two OLD conditions), a vacuous seeding final_state must
		// suppress the state_seeded_second_run_with_changed_requests claim.
		assert.doesNotMatch(
			verifyResult.stdout,
			/coverage:.*state_seeded_second_run_with_changed_requests/,
			`state_seeded_second_run_with_changed_requests must not be claimed from a vacuous ({}) seed; stdout=${verifyResult.stdout}`,
		);
		assert.match(verifyResult.stdout, /coverage: empty_state_run\s*$/m);
		// The printed note must name the actual reason (vacuous seed), not the
		// generic "requests are identical" text — this scenario's requests
		// genuinely DO differ (the invocation counter), so that text would be
		// false here.
		assert.match(
			verifyResult.stdout,
			/note: a later run is marked state_from_run but the seeding run's committed final_state is vacuous/,
		);

		t.diagnostic(`record stdout:\n${recordResult.stdout}`);
		t.diagnostic(`verify stdout:\n${verifyResult.stdout}`);
	} finally {
		await provider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(connectorPath, { force: true });
		rmSync(recordCounterPath, { force: true });
	}
});

// ─── Egress-denial regression: a connector escaping fetch via raw node:http/
// node:net must fail replay loudly, never reach a real server ────────────

/**
 * Writes a throwaway connector entrypoint that bypasses `fetch` entirely and
 * calls the given raw Node network API directly against `targetUrl`. Used to
 * prove `writeReplayBridgePreload`'s egress denial (subprocess-fetch-
 * preloads.ts) actually stops a connector that tries to escape the replay
 * sandbox via `node:http`/`node:https`/`node:net`, rather than only patching
 * `fetch` and leaving those APIs as an open door.
 */
function writeEgressEscapeConnector(
	kind: "http-get" | "https-request" | "net-connect",
	targetUrl: string,
): string {
	const scriptPath = join(
		packageScratchDir(),
		`pdpp-egress-escape-connector-${kind}-${String(process.pid)}-${String(Date.now())}.ts`,
	);
	const target = new URL(targetUrl);
	const escapeCode: Record<typeof kind, string> = {
		"http-get": `
      const http = await import("node:http");
      await new Promise((resolve, reject) => {
        http.get(${JSON.stringify(targetUrl)}, (res) => { res.resume(); res.on("end", resolve); }).on("error", reject);
      });
    `,
		"https-request": `
      const https = await import("node:https");
      await new Promise((resolve, reject) => {
        const req = https.request(${JSON.stringify(targetUrl)}, (res) => { res.resume(); res.on("end", resolve); });
        req.on("error", reject);
        req.end();
      });
    `,
		"net-connect": `
      const net = await import("node:net");
      await new Promise((resolve, reject) => {
        const socket = net.connect(${Number(target.port)}, ${JSON.stringify(target.hostname)}, () => { socket.end(); resolve(undefined); });
        socket.on("error", reject);
      });
    `,
	};
	const connectorRuntimePath = join(
		PACKAGE_ROOT,
		"src",
		"connector-runtime.ts",
	);
	const src = `
import type { RecordData, ValidateRecord } from ${JSON.stringify(connectorRuntimePath)};
import { runConnector } from ${JSON.stringify(connectorRuntimePath)};

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "egress-escape-connector-${kind}",
  validateRecord,
  async collect({ emit }) {
    await emit({ type: "PROGRESS", stream: "items", message: "attempting raw ${kind} egress" });
    ${escapeCode[kind]}
    throw new Error("egress-escape-connector: raw ${kind} call unexpectedly succeeded without throwing");
  },
});
`;
	writeFileSync(scriptPath, src);
	return scriptPath;
}

/**
 * Minimal one-run scenario with zero recorded interactions: any request the
 * collector issues (through fetch or otherwise) has nothing to match, so
 * this isolates "did the connector even reach an egress API" from normal
 * replay-matching behavior. `expected.records` declares one never-emitted
 * record so the run is NOT vacuous per verify.ts's vacuous_run guard (zero
 * interactions AND zero expected records) — this scenario has zero
 * interactions but ONE expected record, so `verifyScenario` still actually
 * invokes `runCollector` (driving the real subprocess) instead of
 * short-circuiting before the collector ever runs, which would make this
 * test assert nothing about the egress guard at all.
 */
function emptyScenarioFor(connectorId: string): ConnectorScenario {
	return {
		format: "pdpp.connector-scenario/1",
		connector: { id: connectorId },
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [{ name: "items" }] }, state: null },
				interactions: [],
				expected: {
					records: {
						items: {
							count: 1,
							ids: ["never-emitted"],
							ops: ["upsert"],
							record_sha256s: ["never-emitted"],
						},
					},
					final_state: {},
				},
			},
		],
	};
}

for (const kind of ["http-get", "https-request", "net-connect"] as const) {
	test(`scenario-verify: a connector escaping fetch via raw ${kind} fails replay loudly and never reaches a real server`, async (t) => {
		// A real loopback server the connector must NEVER reach — if the egress
		// guard has a hole, this server observes a request and the test fails
		// that assertion even if the CLI's exit code looked fine.
		let serverHit = false;
		const canaryServer = createServer((_req, res) => {
			serverHit = true;
			res.writeHead(200);
			res.end("should never be reached");
		});
		await new Promise<void>((resolve) =>
			canaryServer.listen(0, "127.0.0.1", () => resolve()),
		);
		const address = canaryServer.address();
		if (address === null || typeof address === "string") {
			throw new Error("test setup: expected a bound TCP address");
		}
		const targetUrl = `http${kind === "https-request" ? "s" : ""}://127.0.0.1:${String(address.port)}/canary`;

		const connectorPath = writeEgressEscapeConnector(kind, targetUrl);
		const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-egress-test-"));
		const scenarioPath = join(tmpDir, "empty.scenario.json");
		writeFileSync(
			scenarioPath,
			JSON.stringify(emptyScenarioFor(`egress-escape-connector-${kind}`)),
		);

		try {
			const verifyResult = runVerifyCli([
				`egress-escape-connector-${kind}`,
				"--entrypoint",
				connectorPath,
				scenarioPath,
			]);

			assert.notEqual(
				verifyResult.code,
				0,
				"replay of an egress-escaping connector must fail non-zero",
			);
			assert.equal(
				serverHit,
				false,
				"the canary server must never receive a request — egress must be denied, not merely unmatched",
			);
			// The failure must name the specific escape, not just "something went wrong" —
			// proves the ScenarioEgressDeniedError-style message reaches the CLI's output.
			assert.match(verifyResult.stdout + verifyResult.stderr, /egress denied/i);
			t.diagnostic(
				`verify stdout:\n${verifyResult.stdout}\nstderr:\n${verifyResult.stderr}`,
			);
		} finally {
			await new Promise<void>((resolve) => canaryServer.close(() => resolve()));
			rmSync(tmpDir, { recursive: true, force: true });
			rmSync(connectorPath, { force: true });
		}
	});
}

// ─── Vacuous-run regression: an empty scenario must not pass trivially ────

test("scenario-verify: a scenario with zero interactions and zero expected records exits non-zero with a clear vacuous_run message", (t) => {
	// A scenario file this empty (no recorded interactions, nothing expected)
	// proves nothing about the connector — the CLI must refuse to report it
	// as a passing verification. The connector entrypoint used here doesn't
	// even matter (it's never invoked, per verify.ts's vacuous_run
	// short-circuit) so this reuses the http-get egress connector fixture
	// purely as a syntactically valid --entrypoint target.
	const connectorPath = writeEgressEscapeConnector(
		"http-get",
		"http://127.0.0.1:1/unused",
	);
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-vacuous-run-test-"));
	const scenarioPath = join(tmpDir, "vacuous.scenario.json");
	const vacuousScenario: ConnectorScenario = {
		format: "pdpp.connector-scenario/1",
		connector: { id: "vacuous-scenario-connector" },
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [] }, state: null },
				interactions: [],
				expected: { records: {}, final_state: {} },
			},
		],
	};
	writeFileSync(scenarioPath, JSON.stringify(vacuousScenario));

	try {
		const verifyResult = runVerifyCli([
			"vacuous-scenario-connector",
			"--entrypoint",
			connectorPath,
			scenarioPath,
		]);

		assert.notEqual(
			verifyResult.code,
			0,
			"a vacuous scenario must fail verification non-zero, not pass trivially",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /vacuous_run/);
		assert.match(
			verifyResult.stdout,
			/zero recorded interactions and zero expected records/,
			"the message must clearly explain WHY this run failed, not just that it did",
		);
		assert.match(verifyResult.stdout, /FAIL — \d+ failure\(s\)/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);

		t.diagnostic(`verify stdout:\n${verifyResult.stdout}`);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(connectorPath, { force: true });
	}
});

// ─── user_interactions: scripted Collection Profile INTERACTION replay ────
//
// src/test-fixtures/connector-dev-interaction-fixture.ts emits ONE `otp`
// INTERACTION mid-run, then a record whose `otp_value` field is exactly the
// INTERACTION_RESPONSE's value — so a wrong/missing scripted answer changes
// that record's content hash and replay would catch it (see that fixture's
// doc comment). No HTTP interactions at all, so `interactions` stays empty
// throughout — these tests isolate `user_interactions` specifically.
//
// P2-1 (repair wave 3A, third independent review): OTP responses are now
// redacted BY DEFAULT, exactly like credentials — see
// bin/scenario-record.ts's `--persist-otp` flag and format.ts's
// `ScenarioUserInteraction` doc comment. Every test below that needs the
// OLD verbatim-round-trip behavior now passes `--persist-otp` explicitly
// (this is what "keeping the old round-trip green" means per the repair
// task); the new default-redacted behavior gets its own dedicated test
// further down.

const INTERACTION_FIXTURE_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"connector-dev-interaction-fixture.ts",
);

test("scenario-record --answer --persist-otp captures the INTERACTION prompt/response pair into user_interactions verbatim", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-record-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
				"--persist-otp",
			],
			{},
		);

		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.match(
			recordResult.stdout,
			/persisting OTP verbatim: caller asserts single-use\/expired semantics/,
		);
		assert.match(recordResult.stdout, /user_interactions recorded: 1/);
		assert.match(recordResult.stdout, /complete: true/);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(scenario.runs.length, 1);
		const [run] = scenario.runs;
		assert.ok(run, "expected run 0 to exist");
		assert.equal(
			run.interactions.length,
			0,
			"this fixture makes no HTTP calls",
		);
		assert.equal(run.user_interactions?.length, 1);
		const userInteraction = run.user_interactions?.[0];
		assert.ok(userInteraction);
		assert.equal(userInteraction.seq, 1);
		assert.equal(userInteraction.prompt.kind, "otp");
		assert.match(userInteraction.prompt.message, /Enter the verification code/);
		assert.equal(userInteraction.response.status, "success");
		assert.equal(
			userInteraction.response.redacted,
			undefined,
			"--persist-otp must not redact",
		);
		assert.equal(userInteraction.response.value, "555111");
		assert.deepEqual(userInteraction.response.data, { code: "555111" });
		assert.deepEqual(run.expected.records.items?.ids, [
			"item-before-prompt",
			"item-after-prompt",
		]);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: without --persist-otp, an OTP response is redacted by default — no value/data persisted", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-otp-default-redact-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
			],
			{},
		);

		// The live connector run still gets the real answer (555111) over
		// stdin and completes successfully — only the PERSISTED scenario entry
		// is redacted; recording itself must not fail.
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.doesNotMatch(
			recordResult.stdout,
			/persisting OTP verbatim/,
			"the justification line must only print when --persist-otp is actually passed",
		);

		const rawScenarioText = readFileSync(scenarioPath, "utf8");
		assert.doesNotMatch(
			rawScenarioText,
			/555111/,
			"the real OTP value must never appear anywhere in the persisted scenario file by default",
		);

		const scenario = JSON.parse(rawScenarioText) as ConnectorScenario;
		const userInteraction = scenario.runs[0]?.user_interactions?.[0];
		assert.ok(userInteraction, "expected one recorded user_interactions entry");
		assert.equal(userInteraction?.prompt.kind, "otp");
		assert.equal(userInteraction?.response.status, "success");
		assert.equal(userInteraction?.response.redacted, true);
		assert.equal(
			userInteraction?.response.value,
			undefined,
			"redacted OTP response must have no value",
		);
		assert.equal(
			userInteraction?.response.data,
			undefined,
			"redacted OTP response must have no data",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: replaying a default-redacted OTP user_interactions entry fails with a clear named error", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-otp-default-redact-verify-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		const verifyResult = runVerifyCli([
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			scenarioPath,
		]);

		assert.notEqual(
			verifyResult.code,
			0,
			"replaying a default-redacted OTP entry must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(
			verifyResult.stdout,
			/recorded without --persist-otp and is redacted; re-record with --persist-otp or supply live/,
			`expected the P2-1 named error text; stdout=${verifyResult.stdout}`,
		);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify replays a recorded --persist-otp user_interactions entry scripted, with no --answer flags, and PASSes", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-verify-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
				"--persist-otp",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		// No --answer/--answers here at all: verify must replay the recorded
		// response scripted, unattended.
		const verifyResult = runVerifyCli([
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			scenarioPath,
		]);

		assert.equal(
			verifyResult.code,
			0,
			`scenario-verify failed: stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(verifyResult.stdout, /run 0: PASS/);
		assert.match(verifyResult.stdout, /user_interactions replayed: 1/);
		assert.match(
			verifyResult.stdout,
			/(recorded_replay: PASS|diagnostic_replay: PASS)/,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: tampering the recorded --persist-otp user_interactions response value makes verify FAIL (record mismatch)", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-tamper-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");
	const tamperedPath = join(tmpDir, "interaction.tampered.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
				"--persist-otp",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const userInteraction = scenario.runs[0]?.user_interactions?.[0];
		if (!userInteraction) {
			throw new Error(
				"test setup: expected run 0 to have a recorded user_interactions entry",
			);
		}
		userInteraction.response.value = "000000";
		if (userInteraction.response.data) {
			userInteraction.response.data.code = "000000";
		}
		writeFileSync(tamperedPath, JSON.stringify(scenario, null, 2));

		const verifyResult = runVerifyCli([
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			tamperedPath,
		]);

		assert.notEqual(
			verifyResult.code,
			0,
			"a tampered recorded answer must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /record_hash/);
		assert.match(verifyResult.stdout, /FAIL — \d+ failure\(s\)/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: removing the recorded --persist-otp user_interactions response makes verify FAIL (unanswered prompt)", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-missing-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");
	const strippedPath = join(tmpDir, "interaction.stripped.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
				"--persist-otp",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const [run] = scenario.runs;
		if (!run) {
			throw new Error("test setup: expected run 0 to exist");
		}
		// Remove the recorded interaction entirely — the replaying subprocess
		// will still emit its INTERACTION, but the script has nothing left to
		// answer it with.
		run.user_interactions = [];
		writeFileSync(strippedPath, JSON.stringify(scenario, null, 2));

		const verifyResult = runVerifyCli([
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			strippedPath,
		]);

		assert.notEqual(
			verifyResult.code,
			0,
			"an unscripted INTERACTION during replay must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(
			verifyResult.stdout,
			/no next recorded user_interactions entry left to answer it/,
		);
		assert.match(verifyResult.stdout, /FAIL — \d+ failure\(s\)/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: a leftover unconsumed recorded --persist-otp user_interactions entry makes verify FAIL", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-leftover-test-"),
	);
	const scenarioPath = join(tmpDir, "interaction.scenario.json");
	const paddedPath = join(tmpDir, "interaction.padded.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
				"--persist-otp",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const [run] = scenario.runs;
		const existingInteractions = run?.user_interactions;
		const [originalInteraction] = existingInteractions ?? [];
		if (!(run && existingInteractions && originalInteraction)) {
			throw new Error(
				"test setup: expected run 0 to have a recorded user_interactions entry",
			);
		}
		// Append a second, never-consumed interaction — the fixture only ever
		// emits ONE INTERACTION, so this entry can never be answered.
		run.user_interactions = [
			...existingInteractions,
			{ ...originalInteraction, seq: 2 },
		];
		writeFileSync(paddedPath, JSON.stringify(scenario, null, 2));

		const verifyResult = runVerifyCli([
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			paddedPath,
		]);

		assert.notEqual(
			verifyResult.code,
			0,
			"a leftover unconsumed recorded interaction must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(verifyResult.stdout, /never consumed/);
		assert.match(verifyResult.stdout, /FAIL — \d+ failure\(s\)/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── P1-2 (seventh review): INTERACTION prompt comparison ─────────────────
//
// bin/scenario-verify.ts's scripted-answer path now compares the ACTUAL
// live INTERACTION prompt against the recorded one (kind, message, schema,
// timeout_seconds — request_id excluded, volatile) BEFORE sending the
// scripted response. Every test below records a real (untampered) scenario
// against connector-dev-interaction-fixture.ts, then MUTATES the recorded
// run's `user_interactions[0].prompt` before replay — the live connector
// still emits its real, unchanged prompt, so the mismatch is exactly the
// tampered field, proving the comparison actually gates on that field
// rather than passing vacuously.

/** Records one real (untampered) interaction scenario against the fixture,
 *  returning its path and the parsed scenario for the caller to mutate. */
function recordInteractionScenario(tmpDir: string): {
	scenario: ConnectorScenario;
	scenarioPath: string;
} {
	const scenarioPath = join(tmpDir, "interaction.scenario.json");
	const recordResult = runRecordCli(
		[
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			"--runs",
			"1",
			"--out",
			scenarioPath,
			"--answer",
			"0=555111",
			"--persist-otp",
		],
		{},
	);
	assert.equal(
		recordResult.code,
		0,
		`scenario-record failed: stderr=${recordResult.stderr}`,
	);
	const scenario = JSON.parse(
		readFileSync(scenarioPath, "utf8"),
	) as ConnectorScenario;
	return { scenario, scenarioPath };
}

/** Writes `scenario` (already mutated by the caller) to a fresh path in
 *  `tmpDir` and runs scenario-verify against the SAME fixture connector, so
 *  the live prompt is always the fixture's real, unmutated one — any
 *  mismatch reported is exactly what the caller tampered. */
function verifyMutatedInteractionScenario(
	tmpDir: string,
	fileName: string,
	scenario: ConnectorScenario,
): { code: number | null; stderr: string; stdout: string } {
	const mutatedPath = join(tmpDir, fileName);
	writeFileSync(mutatedPath, JSON.stringify(scenario, null, 2));
	return runVerifyCli([
		"connector-dev-interaction-fixture",
		"--entrypoint",
		INTERACTION_FIXTURE_PATH,
		mutatedPath,
	]);
}

test("scenario-verify: INTERACTION prompt mismatch (kind changed) fails verification naming the kind field", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-prompt-kind-test-"),
	);
	try {
		const { scenario } = recordInteractionScenario(tmpDir);
		const prompt = scenario.runs[0]?.user_interactions?.[0]?.prompt;
		if (!prompt) {
			throw new Error(
				"test setup: expected run 0 to have a recorded user_interactions prompt",
			);
		}
		prompt.kind = "manual_action";
		const verifyResult = verifyMutatedInteractionScenario(
			tmpDir,
			"kind-tampered.scenario.json",
			scenario,
		);

		assert.notEqual(
			verifyResult.code,
			0,
			"a kind mismatch must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(verifyResult.stdout, /INTERACTION prompt mismatch/);
		assert.match(verifyResult.stdout, /field=kind/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: INTERACTION prompt mismatch (message changed) fails verification naming the message field", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-prompt-message-test-"),
	);
	try {
		const { scenario } = recordInteractionScenario(tmpDir);
		const prompt = scenario.runs[0]?.user_interactions?.[0]?.prompt;
		if (!prompt) {
			throw new Error(
				"test setup: expected run 0 to have a recorded user_interactions prompt",
			);
		}
		prompt.message =
			"A completely different prompt message than what the connector actually sent.";
		const verifyResult = verifyMutatedInteractionScenario(
			tmpDir,
			"message-tampered.scenario.json",
			scenario,
		);

		assert.notEqual(
			verifyResult.code,
			0,
			"a message mismatch must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(verifyResult.stdout, /INTERACTION prompt mismatch/);
		assert.match(verifyResult.stdout, /field=message/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: INTERACTION prompt mismatch (schema added where the live prompt has none) fails verification naming the schema field", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-prompt-schema-add-test-"),
	);
	try {
		const { scenario } = recordInteractionScenario(tmpDir);
		const prompt = scenario.runs[0]?.user_interactions?.[0]?.prompt;
		if (!prompt) {
			throw new Error(
				"test setup: expected run 0 to have a recorded user_interactions prompt",
			);
		}
		assert.equal(
			prompt.schema,
			undefined,
			"test assumption: the fixture's real prompt carries no schema",
		);
		prompt.schema = {
			type: "object",
			properties: { code: { type: "string" } },
		};
		const verifyResult = verifyMutatedInteractionScenario(
			tmpDir,
			"schema-added.scenario.json",
			scenario,
		);

		assert.notEqual(
			verifyResult.code,
			0,
			"a schema presence-vs-absence mismatch must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(verifyResult.stdout, /INTERACTION prompt mismatch/);
		assert.match(verifyResult.stdout, /field=schema/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: INTERACTION prompt mismatch (timeout_seconds changed) fails verification naming the timeout_seconds field", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-prompt-timeout-test-"),
	);
	try {
		const { scenario } = recordInteractionScenario(tmpDir);
		const prompt = scenario.runs[0]?.user_interactions?.[0]?.prompt;
		if (!prompt) {
			throw new Error(
				"test setup: expected run 0 to have a recorded user_interactions prompt",
			);
		}
		assert.equal(
			prompt.timeout_seconds,
			60,
			"test assumption: the fixture's real prompt sets timeout_seconds: 60",
		);
		prompt.timeout_seconds = 5;
		const verifyResult = verifyMutatedInteractionScenario(
			tmpDir,
			"timeout-tampered.scenario.json",
			scenario,
		);

		assert.notEqual(
			verifyResult.code,
			0,
			"a timeout_seconds mismatch must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(verifyResult.stdout, /INTERACTION prompt mismatch/);
		assert.match(verifyResult.stdout, /field=timeout_seconds/);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: an untampered recorded scenario (request_id necessarily differs between record and replay) still PASSes — request_id is excluded from the prompt comparison", () => {
	// Every OTHER test in this section proves a specific field DOES gate the
	// comparison; this is the request_id-only-change control: record and
	// replay mint DIFFERENT request_ids for the same logical run (a fresh id
	// per subprocess launch — see format.ts's ScenarioUserInteraction doc
	// comment), yet an otherwise-untampered scenario still passes, proving
	// request_id is excluded from firstInteractionPromptMismatch's comparison
	// exactly as documented.
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-interaction-prompt-request-id-test-"),
	);
	try {
		const { scenarioPath } = recordInteractionScenario(tmpDir);
		const verifyResult = runVerifyCli([
			"connector-dev-interaction-fixture",
			"--entrypoint",
			INTERACTION_FIXTURE_PATH,
			scenarioPath,
		]);

		assert.equal(
			verifyResult.code,
			0,
			`expected PASS despite request_id necessarily differing between record and replay; stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(verifyResult.stdout, /run 0: PASS/);
		assert.match(
			verifyResult.stdout,
			/(recorded_replay: PASS|diagnostic_replay: PASS)/,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// Extra/missing interaction sequencing (an INTERACTION with no next
// recorded entry left, or a leftover unconsumed recorded entry) is already
// covered by the two tests immediately above this section ("scenario-verify:
// removing the recorded --persist-otp user_interactions response makes
// verify FAIL (unanswered prompt)" and "scenario-verify: a leftover
// unconsumed recorded --persist-otp user_interactions entry makes verify
// FAIL") — both still pass unchanged (they fail via the pre-existing
// exhausted-script / unconsumed-entry checks, which run before this P1-2
// prompt comparison is ever reached for those cases).

// ─── Repair wave (re-review): FIX A (isolation wiring), FIX B (workspace
// wiring), FIX C (credentials redaction), FIX D (digest report/require),
// FIX E (protocol-corrupt recording) ────────────────────────────────────

// ─── FIX A: descendant network isolation wired into scenario-verify ───────

test("scenario-verify: prints the achieved network isolation level, and coverage-block claims agree", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-isolation-line-test-"),
	);
	const scenarioPath = join(tmpDir, "vacuous.scenario.json");
	// Reuses the vacuous-run-shaped-but-nonvacuous scenario pattern from the
	// FIX 4 coverage tests above: one real HTTP interaction plus >=1 expected
	// record, against the hardcoded-record-connector fixture (no
	// PDPP_SCENARIO_STUB_BASE_URL dependency, so this test is self-contained).
	const recordHash =
		"0000000000000000000000000000000000000000000000000000000000000000".slice(
			0,
			64,
		);
	const scenario: ConnectorScenario = {
		format: "pdpp.connector-scenario/1",
		connector: { id: "hardcoded-record-connector" },
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [{ name: "widgets" }] }, state: null },
				interactions: [
					{
						seq: 1,
						request: {
							method: "GET",
							origin: "https://toy.example",
							path: "/widgets",
							query: [],
						},
						response: {
							status: 200,
							content_type: "application/json",
							body: { id: "w1", name: "Widget w1" },
						},
					},
				],
				expected: {
					records: {
						widgets: {
							count: 1,
							ids: ["w1"],
							ops: ["upsert"],
							record_sha256s: [recordHash],
						},
					},
					final_state: { widgets: { last_id: "w1" } },
				},
			},
		],
	};
	writeFileSync(scenarioPath, JSON.stringify(scenario));

	try {
		const verifyResult = runVerifyCli([
			"hardcoded-record-connector",
			"--entrypoint",
			join(
				PACKAGE_ROOT,
				"src",
				"test-fixtures",
				"scenario-verify-hardcoded-record-connector.ts",
			),
			scenarioPath,
		]);

		// record_sha256s deliberately wrong above (placeholder) — this test only
		// cares about the isolation line appearing consistently, not about a
		// PASS. Whether it's PASS or FAIL, both the early "network isolation:"
		// line and (if it reaches the coverage block) the claims-block line must
		// agree on the same value and must be one of the two honest strings.
		const isolationLines = [
			...(verifyResult.stdout.match(/network isolation: .+$/gm) ?? []),
		];
		assert.ok(
			isolationLines.length >= 1,
			`expected at least one isolation line; stdout=${verifyResult.stdout}`,
		);
		for (const line of isolationLines) {
			assert.match(
				line,
				/^network isolation: (os-namespace|process-local only \(.+\))$/,
				`unexpected isolation line shape: ${line}`,
			);
		}
		const distinctLines = new Set(
			isolationLines.map((l) => l.replace(/^\s+/, "")),
		);
		assert.equal(
			distinctLines.size,
			1,
			`expected every isolation line to agree, got ${JSON.stringify([...distinctLines])}`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: under namespace isolation, a fixture connector's spawned child cannot reach a parent canary (skip if unavailable)", async (t) => {
	// Reuses isolation.ts's own capability probe directly (this test owns
	// bin/scenario-verify.ts and can import isolation.ts's exported API
	// without touching that module) — the same skip-if-unavailable discipline
	// bin/scenario-fidelity.test.ts uses for its own isolation canary test.
	const { isNamespaceIsolationAvailable } = await import(
		"../src/scenario/isolation.ts"
	);
	const capability = isNamespaceIsolationAvailable();
	if (!capability.available) {
		namespaceSkip(true);
		t.skip(`network isolation unavailable on this host: ${capability.reason}`);
		return;
	}

	let canaryHits = 0;
	const canaryServer = createServer((_req, res) => {
		canaryHits += 1;
		res.writeHead(200);
		res.end("should never be reached");
	});
	await new Promise<void>((resolve) =>
		canaryServer.listen(0, "127.0.0.1", () => resolve()),
	);
	const canaryAddress = canaryServer.address();
	if (canaryAddress === null || typeof canaryAddress === "string") {
		throw new Error(
			"test setup: expected a bound TCP address for the canary server",
		);
	}
	const canaryUrl = `http://127.0.0.1:${String(canaryAddress.port)}/canary`;

	const connectorPath = join(
		PACKAGE_ROOT,
		"src",
		"test-fixtures",
		"scenario-fidelity-isolation-canary-connector.ts",
	);
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-verify-isolation-wired-test-"),
	);
	const scenarioPath = join(tmpDir, "isolation.scenario.json");
	// Zero recorded HTTP interactions is fine here: the fixture's own /ping
	// fetch call is intercepted by the replay bridge and fails to match
	// (nothing recorded for it), which fails the RUN — but that failure
	// happens strictly AFTER the curl-escape attempt this test cares about,
	// and this test's authoritative proof is the canary server's own hit
	// counter (observed from a DIFFERENT process/namespace than the isolated
	// child), not the CLI's exit code.
	const scenario: ConnectorScenario = {
		format: "pdpp.connector-scenario/1",
		connector: { id: "scenario-fidelity-isolation-canary-connector" },
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [{ name: "items" }] }, state: null },
				interactions: [],
				expected: {
					records: {
						items: {
							count: 1,
							ids: ["never-matched"],
							ops: ["upsert"],
							record_sha256s: ["never-matched"],
						},
					},
					final_state: {},
				},
			},
		],
	};
	writeFileSync(scenarioPath, JSON.stringify(scenario));

	try {
		const verifyResult = runVerifyCli(
			[
				"scenario-fidelity-isolation-canary-connector",
				"--entrypoint",
				connectorPath,
				scenarioPath,
			],
			{
				PDPP_SCENARIO_FIDELITY_BASE_URL: "http://127.0.0.1:1", // unused; /ping fetch will fail to match anyway
				PDPP_SCENARIO_FIDELITY_CANARY_URL: canaryUrl,
			},
		);

		assert.equal(
			canaryHits,
			0,
			"the canary server must observe zero hits — the fixture's curl escape must fail to connect under isolation",
		);
		assert.match(
			verifyResult.stdout,
			/network isolation: os-namespace/,
			`expected the os-namespace isolation line; stdout=${verifyResult.stdout}`,
		);
		t.diagnostic(
			`verify stdout:\n${verifyResult.stdout}\nstderr:\n${verifyResult.stderr}`,
		);
	} finally {
		await new Promise<void>((resolve) => canaryServer.close(() => resolve()));
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── FIX B: private evidence workspace wired into scenario-record ─────────

test("scenario-record leaves no pdpp-scenario-* files in its private temp directory and writes mode 0600", async () => {
	const stubProvider = await startStubProvider();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-workspace-test-"));
	const recorderTmpDir = join(tmpDir, "recorder-tmp");
	mkdirSync(recorderTmpDir);
	const scenarioPath = join(tmpDir, "workspace.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{
				PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url,
				TMPDIR: recorderTmpDir,
				TMP: recorderTmpDir,
				TEMP: recorderTmpDir,
			},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);

		const leftover = readdirSync(recorderTmpDir).filter((name) =>
			name.startsWith("pdpp-scenario"),
		);
		assert.deepEqual(
			leftover,
			[],
			`expected no leftover pdpp-scenario-* files in recorder temp dir, found: ${leftover.join(", ")}`,
		);

		const { mode } = statSync(scenarioPath);
		const permissionOctal = mode.toString(8).slice(-3);
		assert.equal(
			permissionOctal,
			"600",
			`expected scenario file mode 0600, got 0${permissionOctal}`,
		);
	} finally {
		await stubProvider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: PDPP_SCENARIO_TRANSCRIPT_DIR writes each run's protocol messages to run<N>.jsonl (dir 0700, files 0600); unset writes nothing", async () => {
	const stubProvider = await startStubProvider();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-transcript-test-"));
	const transcriptDir = join(tmpDir, "transcript");
	try {
		const recordResult = runRecordCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				"--out",
				join(tmpDir, "with.scenario.json"),
			],
			{
				PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url,
				PDPP_SCENARIO_TRANSCRIPT_DIR: transcriptDir,
			},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.deepEqual(readdirSync(transcriptDir).sort(), [
			"run1.jsonl",
			"run2.jsonl",
		]);
		assert.equal(statSync(transcriptDir).mode.toString(8).slice(-3), "700");
		for (const name of ["run1.jsonl", "run2.jsonl"]) {
			const path = join(transcriptDir, name);
			assert.equal(statSync(path).mode.toString(8).slice(-3), "600");
			const lines = readFileSync(path, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map(
					(line) =>
						JSON.parse(line) as { at: number; message: { type: string } },
				);
			assert.ok(lines.length > 0, `${name} is empty`);
			assert.ok(lines.every((line) => typeof line.at === "number"));
			assert.ok(lines.some((line) => line.message.type === "RECORD"));
			assert.equal(lines.at(-1)?.message.type, "DONE");
		}

		const sizesBefore = ["run1.jsonl", "run2.jsonl"].map(
			(name) => statSync(join(transcriptDir, name)).size,
		);
		const plain = runRecordCli(
			[
				"scenario-cli-stub-connector",
				"--entrypoint",
				STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				join(tmpDir, "without.scenario.json"),
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: stubProvider.url },
		);
		assert.equal(plain.code, 0, plain.stderr);
		// Unset: the earlier transcript is left exactly as it was.
		assert.deepEqual(
			["run1.jsonl", "run2.jsonl"].map(
				(name) => statSync(join(transcriptDir, name)).size,
			),
			sizesBefore,
		);
	} finally {
		await stubProvider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: raw observation advisory compares two synthetic runs and keeps one-run captures insufficient", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-raw-observations-test-"));
	const fixturePath = join(
		packageScratchDir(),
		`scenario-raw-observations-${String(process.pid)}.ts`,
	);
	const firstClockCanary = "CLOCK_FIRST_PRIVATE_CANARY";
	const secondClockCanary = "CLOCK_SECOND_PRIVATE_CANARY";
	const idCanary = "RECORD_ID_PRIVATE_CANARY";
	const dynamicKeyCanary = "DYNAMIC_KEY_PRIVATE_CANARY";
	writeFileSync(
		fixturePath,
		`import { runConnector } from "../src/connector-runtime.ts";
runConnector({
  name: "raw-observation-smoke",
  validateRecord: (_stream, data) => ({ ok: true, data }),
  async collect({ emit, emitRecord, state }) {
    const repeated = Object.hasOwn(state, "items");
    await emitRecord("items", {
      id: ${JSON.stringify(idCanary)},
      clock: repeated ? ${JSON.stringify(secondClockCanary)} : ${JSON.stringify(firstClockCanary)},
      stable: "business-field-canary",
      [${JSON.stringify(dynamicKeyCanary)}]: "dynamic-value-canary",
    });
    await emit({ type: "STATE", stream: "items", cursor: { marker: "local" } });
  },
});

`,
	);
	try {
		const twoRun = runRecordCli(
			[
				"raw-observation-smoke",
				"--entrypoint",
				fixturePath,
				"--out",
				join(tmpDir, "two-runs.scenario.json"),
			],
			{},
		);
		assert.equal(twoRun.code, 0, twoRun.stderr);
		assert.match(
			twoRun.stdout,
			/\(undeclared stream\): differences-observed \(1 repeated identities; sample limit 50, retained 1, truncated false\)/,
		);
		assert.match(
			twoRun.stdout,
			/raw changes in unnamed or undeclared fields: 1/,
		);
		assert.match(twoRun.stdout, /Manifest\/schema metadata was unavailable/);
		for (const canary of [
			firstClockCanary,
			secondClockCanary,
			idCanary,
			dynamicKeyCanary,
			"business-field-canary",
			"dynamic-value-canary",
		]) {
			assert.equal(twoRun.stdout.includes(canary), false);
			assert.equal(twoRun.stderr.includes(canary), false);
		}

		const oneRun = runRecordCli(
			[
				"raw-observation-smoke",
				"--entrypoint",
				fixturePath,
				"--runs",
				"1",
				"--out",
				join(tmpDir, "one-run.scenario.json"),
			],
			{},
		);
		assert.equal(oneRun.code, 0, oneRun.stderr);
		assert.match(
			oneRun.stdout,
			/\(undeclared stream\): insufficient-repeat-observations \(0 repeated identities; sample limit 50, retained 1, truncated false\)/,
		);
		assert.match(
			oneRun.stdout,
			/total identity limit: 250; generic unknown-stream bucket limit: 50; truncation: false/,
		);
		assert.equal(oneRun.stdout.includes(firstClockCanary), false);
		assert.equal(oneRun.stdout.includes(idCanary), false);
	} finally {
		rmSync(fixturePath, { force: true });
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: bound synthetic manifest reports declared changes and hides record data", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-bound-raw-observation-"),
	);
	const connectorKey = "bound_raw_observation_fixture";
	const connectorDir = join(tmpDir, "connectors", connectorKey);
	const connectorPath = join(connectorDir, "index.ts");
	const manifestPath = join(connectorDir, "manifest.json");
	const firstCanary = "BOUND_FIRST_VALUE_PRIVATE_CANARY";
	const secondCanary = "BOUND_SECOND_VALUE_PRIVATE_CANARY";
	const firstClockCanary = "BOUND_FIRST_CLOCK_PRIVATE_CANARY";
	const secondClockCanary = "BOUND_SECOND_CLOCK_PRIVATE_CANARY";
	const idCanary = "BOUND_ID_PRIVATE_CANARY";
	const dynamicKey = "dynamic_BOUND_PRIVATE_KEY";
	mkdirSync(connectorDir, { recursive: true });
	writeFileSync(
		connectorPath,
		`import { runConnector } from "../../../../src/connector-runtime.ts";
runConnector({
  name: ${JSON.stringify(connectorKey)},
  validateRecord: (_stream, data) => ({ ok: true, data }),
  async collect({ emit, emitRecord, state }) {
    const repeated = Object.hasOwn(state, "items");
    await emitRecord("items", {
      id: ${JSON.stringify(idCanary)},
      created_at: repeated ? ${JSON.stringify(secondCanary)} : ${JSON.stringify(firstCanary)},
      clock: repeated ? ${JSON.stringify(secondClockCanary)} : ${JSON.stringify(firstClockCanary)},
      [${JSON.stringify(dynamicKey)}]: "dynamic_PRIVATE_VALUE",
    });
    await emit({ type: "STATE", stream: "items", cursor: { marker: "local" } });
  },
});
`,
	);
	writeFileSync(
		manifestPath,
		JSON.stringify({
			connector_id:
				"https://registry.pdpp.dev/connectors/bound-raw-observation-fixture",
			connector_key: connectorKey,
			protocol_version: "0.1.0",
			version: "0.0.0-test",
			streams: [
				{
					name: "items",
					primary_key: ["id"],
					compaction_fingerprint: { exclude_keys: ["clock"] },
					schema: {
						type: "object",
						properties: {
							id: { type: "string" },
							created_at: { type: "string" },
							clock: { type: "string" },
							stable: { type: "string" },
						},
					},
				},
			],
		}),
	);
	try {
		const result = runRecordCli(
			[connectorKey, "--out", join(tmpDir, "bound.scenario.json")],
			{
				PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir,
			},
		);
		assert.equal(result.code, 0, result.stderr);
		assert.match(
			result.stdout,
			/items: differences-observed \(1 repeated identities; sample limit 200, retained 1, truncated false\)/,
		);
		assert.match(
			result.stdout,
			/raw changed fields: \/clock \(1\), \/created_at \(1\)/,
		);
		assert.match(result.stdout, /raw changed fields: [^\n]*\/created_at \(1\)/);
		assert.match(result.stdout, /raw changed fields: [^\n]*\/clock \(1\)/);
		assert.match(
			result.stdout,
			/changed after declared comparison exclusions: \/created_at \(1\)/,
		);
		assert.doesNotMatch(
			result.stdout,
			/changed after declared comparison exclusions: [^\n]*clock/,
		);
		for (const canary of [
			firstCanary,
			secondCanary,
			firstClockCanary,
			secondClockCanary,
			idCanary,
			dynamicKey,
			"dynamic_PRIVATE_VALUE",
		]) {
			assert.equal(result.stdout.includes(canary), false);
			assert.equal(result.stderr.includes(canary), false);
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: PDPP_SCENARIO_TRANSCRIPT_DIR tightens a pre-existing dir to 0700, truncates an old run file to 0600, and records INTERACTION prompts", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-transcript-interaction-"),
	);
	const transcriptDir = join(tmpDir, "transcript");
	try {
		mkdirSync(transcriptDir, { mode: 0o755 });
		chmodSync(transcriptDir, 0o755);
		const oldRun = join(transcriptDir, "run1.jsonl");
		writeFileSync(oldRun, '{"stale":true}\n', { mode: 0o644 });
		chmodSync(oldRun, 0o644);

		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				join(tmpDir, "interaction.scenario.json"),
				"--answer",
				"0=555111",
			],
			{ PDPP_SCENARIO_TRANSCRIPT_DIR: transcriptDir },
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.equal(statSync(transcriptDir).mode.toString(8).slice(-3), "700");
		assert.equal(statSync(oldRun).mode.toString(8).slice(-3), "600");
		const text = readFileSync(oldRun, "utf8");
		assert.equal(
			text.includes("stale"),
			false,
			"the old run file was truncated",
		);
		const types = text
			.split("\n")
			.filter((line) => line.length > 0)
			.map(
				(line) =>
					(JSON.parse(line) as { message: { type: string } }).message.type,
			);
		assert.ok(types.includes("INTERACTION"), `types: ${types.join(",")}`);
		assert.equal(types.at(-1), "DONE");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── FIX C: credentials interactions are never persisted ──────────────────

const CREDENTIALS_FIXTURE_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"connector-dev-credentials-fixture.ts",
);

test("scenario-record: a credentials-kind INTERACTION response is redacted — no value/data persisted, redacted:true recorded", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-credentials-record-test-"),
	);
	const scenarioPath = join(tmpDir, "credentials.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-credentials-fixture",
				"--entrypoint",
				CREDENTIALS_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=super-secret-password-never-persisted",
			],
			{},
		);

		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.match(recordResult.stdout, /user_interactions recorded: 1/);
		assert.match(recordResult.stdout, /complete: true/);

		const rawScenarioText = readFileSync(scenarioPath, "utf8");
		assert.doesNotMatch(
			rawScenarioText,
			/super-secret-password-never-persisted/,
			"the real credentials value must never appear anywhere in the persisted scenario file",
		);

		const scenario = JSON.parse(rawScenarioText) as ConnectorScenario;
		const userInteraction = scenario.runs[0]?.user_interactions?.[0];
		assert.ok(userInteraction, "expected one recorded user_interactions entry");
		assert.equal(userInteraction?.prompt.kind, "credentials");
		assert.equal(userInteraction?.response.redacted, true);
		assert.equal(userInteraction?.response.status, "success");
		assert.equal(
			userInteraction?.response.value,
			undefined,
			"redacted response must have no value",
		);
		assert.equal(
			userInteraction?.response.data,
			undefined,
			"redacted response must have no data",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: replaying a redacted (credentials) user_interactions entry fails with a clear named error", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-credentials-verify-test-"),
	);
	const scenarioPath = join(tmpDir, "credentials.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-credentials-fixture",
				"--entrypoint",
				CREDENTIALS_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=super-secret-password-never-persisted",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		// No --answer here: verify must refuse the redacted entry outright,
		// never fall back to answering with an absent value/data.
		const verifyResult = runVerifyCli([
			"connector-dev-credentials-fixture",
			"--entrypoint",
			CREDENTIALS_FIXTURE_PATH,
			scenarioPath,
		]);

		assert.notEqual(
			verifyResult.code,
			0,
			"replaying a redacted interaction must fail verification non-zero",
		);
		assert.match(verifyResult.stdout, /run 0: FAIL/);
		assert.match(verifyResult.stdout, /replay_mismatch/);
		assert.match(
			verifyResult.stdout,
			/credentials interactions are never persisted; re-record or supply live/,
			`expected the FIX C named error text; stdout=${verifyResult.stdout}`,
		);
		assert.doesNotMatch(verifyResult.stdout, /recorded_replay: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// P2-1 (repair wave 3A): this test used to assert OTP is "still persisted
// verbatim (documented exception unaffected by FIX C)" — that is exactly
// the overbroad default the third independent review's P2-1 finding
// withdrew (see format.ts's `ScenarioUserInteraction` doc comment). It is
// renamed/rewritten to assert the CURRENT contract instead: `--persist-otp`
// is what makes an OTP-kind interaction behave like the old "verbatim,
// unaffected by credentials redaction" exception; credentials stays
// unconditionally redacted regardless of that flag (the flag has no effect
// on credentials at all — see `toScenarioUserInteraction`'s doc comment).
test("scenario-record: --persist-otp makes an OTP-kind interaction persist verbatim, credentials unaffected", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-otp-persist-flag-test-"),
	);
	const scenarioPath = join(tmpDir, "otp.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"connector-dev-interaction-fixture",
				"--entrypoint",
				INTERACTION_FIXTURE_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
				"--answer",
				"0=555111",
				"--persist-otp",
			],
			{},
		);
		assert.equal(
			recordResult.code,
			0,
			`scenario-record failed: stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const userInteraction = scenario.runs[0]?.user_interactions?.[0];
		assert.ok(userInteraction);
		assert.equal(userInteraction?.prompt.kind, "otp");
		assert.equal(
			userInteraction?.response.redacted,
			undefined,
			"OTP responses under --persist-otp must not be redacted",
		);
		assert.equal(userInteraction?.response.value, "555111");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── FIX D: digest model split — captured_with reported, --require-capture-source strict ──

test("scenario-record: writes connector.captured_with alongside the deprecated top-level digest fields", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-captured-with-test-"),
	);
	const scenarioPath = join(tmpDir, "captured-with.scenario.json");

	try {
		// A registered connector (not --entrypoint) is required for digests to
		// be computed at all — orchestrate.ts's KNOWN_CONNECTOR_NAMES lists real
		// connectors; imessage has no live-network dependency for a --runs 1
		// capture attempt (this test only cares about the digest fields on the
		// WRITTEN scenario, not about a successful/complete run).
		const recordResult = runRecordCli(
			["imessage", "--runs", "1", "--out", scenarioPath],
			{},
		);
		// The run itself may fail (imessage likely isn't collectible in this
		// sandboxed test environment) — that's fine, scenario-record still
		// writes the scenario file with complete:false and the digest fields
		// are computed independent of whether the connector run succeeded. Only
		// assert the CLI actually produced SOME exit code (proving it ran at
		// all — that's the only use this test has for `recordResult` beyond the
		// scenario file it wrote).
		assert.ok(
			recordResult.code === 0 || recordResult.code === 1,
			`unexpected exit code ${String(recordResult.code)}`,
		);
		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		if (
			scenario.connector.declaration_digest ||
			scenario.connector.source_digest
		) {
			assert.ok(
				scenario.connector.captured_with,
				"expected captured_with alongside the deprecated digest fields",
			);
			assert.equal(
				scenario.connector.captured_with?.declaration_digest,
				scenario.connector.declaration_digest,
			);
			assert.equal(
				scenario.connector.captured_with?.source_digest,
				scenario.connector.source_digest,
			);
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: reports (never fails) a differing captured_with source by default, and --require-capture-source turns it into a failure", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-verify-digest-report-test-"),
	);
	const scenarioPath = join(tmpDir, "digest.scenario.json");
	const recordHash =
		"0000000000000000000000000000000000000000000000000000000000000000".slice(
			0,
			64,
		);
	const scenarioWithFakeCapturedWith = (): ConnectorScenario => ({
		format: "pdpp.connector-scenario/1",
		connector: {
			id: "hardcoded-record-connector",
			captured_with: {
				declaration_digest:
					"deadbeef00000000000000000000000000000000000000000000000000000000",
				source_digest:
					"00000000deadbeef0000000000000000000000000000000000000000000000000",
			},
		},
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [{ name: "widgets" }] }, state: null },
				interactions: [
					{
						seq: 1,
						request: {
							method: "GET",
							origin: "https://toy.example",
							path: "/widgets",
							query: [],
						},
						response: {
							status: 200,
							content_type: "application/json",
							body: { id: "w1", name: "Widget w1" },
						},
					},
				],
				expected: {
					records: {
						widgets: {
							count: 1,
							ids: ["w1"],
							ops: ["upsert"],
							record_sha256s: [recordHash],
						},
					},
					final_state: { widgets: { last_id: "w1" } },
				},
			},
		],
	});

	try {
		// NOTE: hardcoded-record-connector has no real manifests/connectors/
		// entry (it's only ever driven via --entrypoint elsewhere in this repo),
		// so this test drives the REAL "oura" connector id instead, whose
		// manifest/source DO exist on disk — required for reportCaptureSourceDigests
		// to have a real "current" digest to compare the fabricated captured_with
		// against and actually observe a "differs" report.
		const scenario = scenarioWithFakeCapturedWith();
		scenario.connector.id = "oura";
		writeFileSync(scenarioPath, JSON.stringify(scenario));

		const reportResult = runVerifyCli(["oura", scenarioPath]);
		assert.match(
			reportResult.stdout,
			/captured_with source: [0-9a-f]{8}, verified subject source: [0-9a-f]{8}, differs - replaying against changed code/,
			`expected a reported (not failed) source digest mismatch; stdout=${reportResult.stdout} stderr=${reportResult.stderr}`,
		);
		assert.match(
			reportResult.stdout,
			/captured_with declaration: [0-9a-f]{8}, verified subject declaration: [0-9a-f]{8}, differs - manifest changed since capture/,
			`expected a reported declaration digest mismatch too; stdout=${reportResult.stdout}`,
		);
		// The report must NOT by itself fail the CLI pre-flight (it may still
		// fail later for unrelated reasons — the oura connector isn't actually
		// run against these fabricated interactions — but the digest report
		// line itself is informational).
		assert.doesNotMatch(reportResult.stderr, /--require-capture-source/);

		const strictResult = runVerifyCli([
			"oura",
			scenarioPath,
			"--require-capture-source",
		]);
		assert.notEqual(
			strictResult.code,
			0,
			"--require-capture-source must fail on a captured_with mismatch",
		);
		assert.match(
			strictResult.stderr,
			/--require-capture-source: (manifest declaration|source) drift since capture/,
			`expected a --require-capture-source FATAL naming the drift; stderr=${strictResult.stderr}`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── P1-2 (ninth review): post-run source-mutation integrity check ────────
//
// `assertNoPostRunSourceMutation` (scenario-verify.ts) closes the digest
// TOCTOU: `reportCaptureSourceDigests` hashes the connector's manifest/source
// BEFORE any subprocess spawns; before this fix, that same pre-flight
// observation was fed straight into `evaluateClaimEligibility` with no
// re-check, so a connector (or anything with write access to REPO_ROOT
// before P1-2's read-only fix) could mutate its own source between the hash
// and the claim being printed and still receive `recorded_replay: PASS`.
// This test proves the function's own comparison logic directly — not a full
// CLI round trip, since building a real, passing scenario fixture for a live
// connector (oura) with actual matching request/response shapes is a large
// undertaking unrelated to what's under test here; `main()`'s wiring of this
// function (forcing `current*DigestComputed` false and calling it before
// `printCoverageReport`) is simple, typechecked glue, not novel logic.
//
// Uses the REAL "oura" connector's directory as the subject (a registered
// connector `getConnectorPaths`/`assertNoPostRunSourceMutation` can actually
// resolve) — adds ONE throwaway, uniquely-named scratch file inside it
// (never an EXISTING file) to simulate a post-hash mutation, always removed
// in `finally` regardless of assertion outcome, so this test never leaves
// the real oura connector directory altered.
test("assertNoPostRunSourceMutation: detects a source mutation between the pre-flight hash and the post-run check, and reports no mutation when nothing changed", () => {
	const ouraPaths = getConnectorPaths("oura");
	const connectorDir = dirname(ouraPaths.connectorPath);
	const manifestPath = ouraPaths.manifestPath;
	const preflightSourceDigest = computeSourceDigest(connectorDir);
	const preflightDeclarationDigest = computeDeclarationDigest(manifestPath);
	const baseArgs = {
		connector: "oura",
		dumpAllRecords: false,
		requireCaptureSource: false,
		scenarioPath: "unused",
		timeoutSeconds: 300,
	};
	const baseObservation = {
		capturedDeclarationDigestPresent: true,
		capturedSourceDigestPresent: true,
		currentDeclarationDigestComputed: true,
		currentSourceDigestComputed: true,
		preflightDeclarationDigest,
		preflightSourceDigest,
		capturedDeclarationDigest: preflightDeclarationDigest,
		capturedSourceDigest: preflightSourceDigest,
	};

	// No mutation: the connector directory is untouched between "pre-flight"
	// and "post-run" — must report false (no withhold).
	const noMutation = assertNoPostRunSourceMutation(baseArgs, baseObservation);
	assert.equal(
		noMutation,
		false,
		"an unmutated connector directory must not be reported as mutated",
	);

	// Mutation: add a throwaway file — computeSourceDigest hashes every file
	// in the directory (excluding .test.ts and fixtures/), so a NEW file
	// changes the digest exactly like a real edit would.
	const scratchFileName = `.pdpp-post-run-mutation-probe-${String(process.pid)}-${String(Date.now())}.ts`;
	const scratchFilePath = join(connectorDir, scratchFileName);
	assert.ok(
		!existsSync(scratchFilePath),
		"sanity: the scratch probe file must not already exist",
	);
	try {
		writeFileSync(
			scratchFilePath,
			"// P1-2 post-run-mutation test probe — removed in test finally\n",
		);
		const mutated = assertNoPostRunSourceMutation(baseArgs, baseObservation);
		assert.equal(
			mutated,
			true,
			"a source directory that changed between the pre-flight hash and the post-run check must be reported as mutated",
		);
	} finally {
		rmSync(scratchFilePath, { force: true });
	}

	// Restore proof: with the scratch file removed, the digest matches the
	// pre-flight value again — confirms the mutation detection isn't a false
	// positive baked into this test's own setup.
	const afterCleanup = assertNoPostRunSourceMutation(baseArgs, baseObservation);
	assert.equal(
		afterCleanup,
		false,
		"after removing the scratch probe, the directory must report as unmutated again",
	);
});

test("scenario-verify: --entrypoint mode prints 'unbound diagnostic replay (no digests)' instead of a digest report", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-verify-unbound-digest-test-"),
	);
	const scenarioPath = join(tmpDir, "unbound.scenario.json");
	const recordHash =
		"0000000000000000000000000000000000000000000000000000000000000000".slice(
			0,
			64,
		);
	const scenario: ConnectorScenario = {
		format: "pdpp.connector-scenario/1",
		connector: { id: "hardcoded-record-connector" },
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [{ name: "widgets" }] }, state: null },
				interactions: [
					{
						seq: 1,
						request: {
							method: "GET",
							origin: "https://toy.example",
							path: "/widgets",
							query: [],
						},
						response: {
							status: 200,
							content_type: "application/json",
							body: { id: "w1", name: "Widget w1" },
						},
					},
				],
				expected: {
					records: {
						widgets: {
							count: 1,
							ids: ["w1"],
							ops: ["upsert"],
							record_sha256s: [recordHash],
						},
					},
					final_state: { widgets: { last_id: "w1" } },
				},
			},
		],
	};
	writeFileSync(scenarioPath, JSON.stringify(scenario));

	try {
		const verifyResult = runVerifyCli([
			"hardcoded-record-connector",
			"--entrypoint",
			join(
				PACKAGE_ROOT,
				"src",
				"test-fixtures",
				"scenario-verify-hardcoded-record-connector.ts",
			),
			scenarioPath,
		]);
		assert.match(
			verifyResult.stdout,
			/unbound diagnostic replay \(no digests\)/,
		);
		assert.doesNotMatch(verifyResult.stdout, /captured_with source:/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── FIX E: recording rejects protocol-corrupt stdout ──────────────────────

test("scenario-record: a nonempty non-JSON stdout line from the connector marks the capture incomplete and exits nonzero, quoting the offending line", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-record-garbage-stdout-test-"),
	);
	const scenarioPath = join(tmpDir, "garbage.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-verify-garbage-stdout-line",
				"--entrypoint",
				join(
					PACKAGE_ROOT,
					"src",
					"test-fixtures",
					"scenario-verify-garbage-stdout-line.ts",
				),
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{},
		);

		assert.notEqual(
			recordResult.code,
			0,
			"protocol-corrupt stdout during recording must exit nonzero",
		);
		assert.match(
			recordResult.stderr + recordResult.stdout,
			/RECORDING INCOMPLETE/,
		);
		assert.match(
			recordResult.stderr + recordResult.stdout,
			/protocol-corrupt stdout/,
			`expected the FIX E reason string; stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(
			scenario.capture.complete,
			false,
			"a protocol-corrupt capture must be marked complete:false",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── scenario-record --streams (src/test-fixtures/scenario-cli-multi-
// stream-stub-connector.ts declares two streams, `items` and `extras`, each
// hitting its own loopback endpoint ONLY when present in ctx.requested — see
// that fixture's doc comment) — proves the flag actually narrows what the
// recorder asks the connector to touch, that the resulting scenario's
// `expected.records` only has entries for the scoped stream(s), and that
// `scenario-verify` PASSes replaying that scoped capture — the composition
// bin/scenario-record.ts's module docstring claims: replay reads
// `run.start.scope` verbatim (streamNamesFromScenario in
// bin/scenario-verify.ts), so the expected and actual stream sets being
// compared by verify.ts's stream-set-equality check are both already scoped
// to the same subset. ──────────────────────────────────────────────────────

const MULTI_STREAM_CONNECTOR_PATH = join(
	PACKAGE_ROOT,
	"src",
	"test-fixtures",
	"scenario-cli-multi-stream-stub-connector.ts",
);

interface MultiStreamProvider {
	close: () => Promise<void>;
	url: string;
}

/** Same shape/lifecycle as `startStubProvider` above (standalone `node`
 *  subprocess — see that function's doc comment for why an in-process
 *  `http.createServer` is unreachable from this test's real-subprocess
 *  CLIs), serving `/items` and `/extras` each with one fixed page — this
 *  test only needs to prove which stream(s) were REQUESTED, not exercise
 *  pagination (already covered by the other tests in this file). */
function startMultiStreamProvider(): Promise<MultiStreamProvider> {
	const scriptPath = join(
		tmpdir(),
		`pdpp-scenario-cli-test-multi-stream-provider-${String(process.pid)}-${String(Date.now())}.mjs`,
	);
	const src = `
import { createServer } from "node:http";
const PAGES = {
  "/items": { items: [{ id: "items-1", value: "alpha" }] },
  "/extras": { items: [{ id: "extras-1", value: "zulu" }] },
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const body = PAGES[url.pathname];
  if (!body) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
server.listen(0, "127.0.0.1", () => {
  console.log("PORT " + server.address().port);
});
`;
	writeFileSync(scriptPath, src);

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [scriptPath], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdoutBuffer = "";
		let stderrBuffer = "";
		let closed = false;
		const closePromise = (): Promise<void> =>
			new Promise((closeResolve) => {
				if (closed) {
					closeResolve();
					return;
				}
				closed = true;
				child.once("close", () => closeResolve());
				child.kill();
			});
		const onData = (chunk: Buffer): void => {
			stdoutBuffer += chunk.toString();
			const match = /PORT (\d+)/.exec(stdoutBuffer);
			if (match?.[1]) {
				child.stdout.off("data", onData);
				resolve({ url: `http://127.0.0.1:${match[1]}`, close: closePromise });
			}
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString();
		});
		child.on("error", reject);
		child.on("exit", (code) => {
			if (!stdoutBuffer.includes("PORT")) {
				reject(
					new Error(
						`multi-stream stub provider exited before binding (code=${String(code)}): ${stderrBuffer}`,
					),
				);
			}
		});
	});
}

test("scenario-record --streams: scopes the capture to the named stream, and scenario-verify PASSes replaying it (stream-set equality composes)", async (t) => {
	const provider = await startMultiStreamProvider();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-streams-test-"));
	const scenarioPath = join(tmpDir, "scoped.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-cli-multi-stream-stub-connector",
				"--entrypoint",
				MULTI_STREAM_CONNECTOR_PATH,
				"--runs",
				"1",
				"--streams",
				"items",
				"--out",
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: provider.url },
		);

		assert.equal(
			recordResult.code,
			0,
			`scenario-record --streams items failed: stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		// Exactly ONE HTTP interaction was captured — the fixture only fetches a
		// stream present in ctx.requested (see that fixture's doc comment), so
		// "extras" never being fetched proves the scope actually reached the
		// connector, not just a cosmetic CLI-level filter. Two streams would
		// have produced 2 interactions.
		assert.match(recordResult.stdout, /interactions recorded: 1\b/);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const [run0] = scenario.runs;
		assert.ok(run0, "expected run 0 to exist");
		// START.scope recorded on the scenario itself is the scoped subset —
		// this is exactly what scenario-verify's streamNamesFromScenario reads
		// back verbatim for replay (bin/scenario-verify.ts), never rebuilding
		// scope from the manifest/entrypoint's full stream list.
		assert.deepEqual(run0.start.scope, { streams: [{ name: "items" }] });
		// expected.records naturally has an entry ONLY for the scoped stream —
		// no "extras" key at all, not an empty/zero-count one.
		assert.deepEqual(Object.keys(run0.expected.records), ["items"]);
		assert.deepEqual(run0.expected.records.items?.ids, ["items-1"]);

		// ── VERIFY the scoped capture, strictly offline (close the provider
		// first — same "replay must not depend on the recording upstream"
		// proof the other tests in this file make). ──
		await provider.close();

		const verifyResult = runVerifyCli(
			[
				"scenario-cli-multi-stream-stub-connector",
				"--entrypoint",
				MULTI_STREAM_CONNECTOR_PATH,
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: provider.url },
		);

		assert.equal(
			verifyResult.code,
			0,
			`scenario-verify of the --streams-scoped capture failed: stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(verifyResult.stdout, /run 0: PASS/);
		// No stream_set_mismatch failure kind anywhere — the actual replayed
		// stream set (just "items", since replay sends the SAME recorded scope)
		// equals the expected set, apples to apples.
		assert.doesNotMatch(verifyResult.stdout, /stream_set_mismatch/);

		t.diagnostic(`record stdout:\n${recordResult.stdout}`);
		t.diagnostic(`verify stdout:\n${verifyResult.stdout}`);
	} finally {
		await provider.close().catch(() => undefined);
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record --streams: an unknown stream name fails before any subprocess spawns, listing the fixture's actual stream names", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-cli-streams-unknown-test-"),
	);
	const scenarioPath = join(tmpDir, "unused.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-cli-multi-stream-stub-connector",
				"--entrypoint",
				MULTI_STREAM_CONNECTOR_PATH,
				"--runs",
				"1",
				"--streams",
				"items,bogus",
				"--out",
				scenarioPath,
			],
			{ PDPP_SCENARIO_STUB_BASE_URL: "http://127.0.0.1:1" }, // unused: fails before any fetch
		);

		assert.notEqual(
			recordResult.code,
			0,
			"an unknown --streams name must fail non-zero",
		);
		assert.match(
			recordResult.stderr,
			/--streams named unknown stream\(s\): bogus\. Available streams: items, extras/,
		);
		assert.doesNotMatch(
			recordResult.stdout,
			/RECORDING/,
			"must fail before spawning the connector",
		);
		assert.ok(
			!existsSync(scenarioPath),
			"no scenario file should be written for a pre-flight arg failure",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// `type` is not one of `wire-registry.ts`'s `KNOWN_MESSAGE_TYPES` also marks
// the capture incomplete and exits nonzero, distinct from the non-JSON-line
// FIX E test above (this line parses fine, only its `type` is unrecognized)
// — folded into the SAME "protocol-corrupt stdout" reporting path, with an
// honest "unrecognized type" wording rather than "non-JSON line".
test("scenario-record: a well-formed JSON stdout line with an unrecognized message type marks the capture incomplete and exits nonzero", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-record-unknown-type-test-"),
	);
	const scenarioPath = join(tmpDir, "unknown-type.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-verify-unknown-message-type",
				"--entrypoint",
				join(
					PACKAGE_ROOT,
					"src",
					"test-fixtures",
					"scenario-verify-unknown-message-type.ts",
				),
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{},
		);

		assert.notEqual(
			recordResult.code,
			0,
			"an unrecognized message type during recording must exit nonzero",
		);
		assert.match(
			recordResult.stderr + recordResult.stdout,
			/RECORDING INCOMPLETE/,
		);
		assert.match(
			recordResult.stderr + recordResult.stdout,
			/protocol-corrupt stdout.*unrecognized type/,
			`expected the honest "unrecognized type" reason string; stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);

		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(
			scenario.capture.complete,
			false,
			"a protocol-corrupt capture must be marked complete:false",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── Inactivity watchdog (LIVE INCIDENT: a real ynab capture's lawfully
// paced incremental run was SIGKILLed by the old fixed 300s TOTAL-DURATION
// timeout even though it was making steady progress) ──────────────────────
//
// `src/test-fixtures/scenario-watchdog-paced-connector.ts` sleeps a
// controllable number of ms between each of a controllable number of
// records, and can hang forever after a chosen record index — driven here
// purely by env vars, no network involved, so it exercises both
// bin/scenario-record.ts's live-subprocess watchdog and
// bin/scenario-verify.ts's replay-subprocess watchdog (replay is ALSO
// paced: a connector's own self-pacing sleeps run in real time during
// replay too, since the replaying subprocess is the exact same connector
// code).

test("scenario-record --timeout: the watchdog does NOT fire across an inter-record gap shorter than the window, even though total run time exceeds it", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-watchdog-paced-record-test-"),
	);
	const scenarioPath = join(tmpDir, "paced.scenario.json");

	try {
		// 3 records * 1s sleep = ~3s total run time, comfortably OVER a 2s
		// window — but each individual gap (1s) stays well under 2s, so a
		// correct INACTIVITY watchdog must never fire.
		const recordResult = runRecordCli(
			[
				"scenario-watchdog-paced-connector",
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--timeout",
				"2",
				"--out",
				scenarioPath,
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: "3",
				PDPP_WATCHDOG_TEST_SLEEP_MS: "1000",
			},
		);

		assert.equal(
			recordResult.code,
			0,
			`a paced run with gaps under the watchdog window must succeed; stdout=${recordResult.stdout} stderr=${recordResult.stderr}`,
		);
		assert.doesNotMatch(
			recordResult.stderr,
			/subprocess inactive for/,
			"the watchdog must not have fired",
		);
		assert.ok(
			existsSync(scenarioPath),
			"a complete scenario file should be written",
		);
		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(scenario.capture.complete, true);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record --timeout: the watchdog DOES fire on a genuine hang, printing a plain verdict with partial evidence (no stack trace)", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-watchdog-hang-record-test-"),
	);
	const scenarioPath = join(tmpDir, "hung.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-watchdog-paced-connector",
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--timeout",
				"2",
				"--out",
				scenarioPath,
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: "3",
				PDPP_WATCHDOG_TEST_SLEEP_MS: "100",
				// Hangs forever right after emitting record index 0 — a genuine
				// stall, not pacing.
				PDPP_WATCHDOG_TEST_HANG_AFTER: "0",
			},
		);

		assert.notEqual(recordResult.code, 0, "a genuine hang must exit nonzero");
		assert.match(
			recordResult.stderr,
			/^\[scenario-record\] subprocess inactive for 2s - killed \(window: --timeout 2\)$/m,
			`expected the plain verdict line; stderr=${recordResult.stderr}`,
		);
		assert.doesNotMatch(
			recordResult.stderr,
			/at .*scenario-record\.ts/,
			"a watchdog verdict must never print a stack trace",
		);
		// Partial evidence: this run emitted exactly one `items` record before
		// hanging.
		assert.match(recordResult.stderr, /observed so far: items=1 record\(s\)/);
		assert.match(
			recordResult.stderr,
			/last message seen: RECORD stream=items \(\d+s ago\)/,
		);
		assert.match(recordResult.stderr, /incomplete by rule \(killed mid-run\)/);
		assert.ok(
			!existsSync(scenarioPath),
			"no scenario file should be written when the watchdog kills the run",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record --timeout: rejects a non-positive-integer value before spawning anything", () => {
	for (const bad of ["-5", "0", "abc", "1.5"]) {
		const recordResult = runRecordCli(
			[
				"scenario-watchdog-paced-connector",
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--timeout",
				bad,
			],
			{},
		);
		assert.notEqual(recordResult.code, 0, `--timeout ${bad} must be rejected`);
		assert.match(recordResult.stderr, /--timeout must be a positive integer/);
		assert.doesNotMatch(
			recordResult.stdout,
			/RECORDING/,
			"must fail before spawning the connector",
		);
	}
});

test("scenario-verify --timeout: the watchdog does NOT fire across an inter-record gap shorter than the window during a paced replay", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-watchdog-paced-verify-test-"),
	);
	const scenarioPath = join(tmpDir, "paced.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-watchdog-paced-connector",
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: "2",
				PDPP_WATCHDOG_TEST_SLEEP_MS: "50",
			},
		);
		assert.equal(
			recordResult.code,
			0,
			`setup recording must succeed; stderr=${recordResult.stderr}`,
		);

		// Replay re-runs the same connector code, so it re-sleeps between
		// records too — 2 records * 1s sleep = ~2s total, over a 3s window but
		// each gap (1s) is well under it.
		const verifyResult = runVerifyCli(
			[
				"scenario-watchdog-paced-connector",
				scenarioPath,
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--timeout",
				"3",
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: "2",
				PDPP_WATCHDOG_TEST_SLEEP_MS: "1000",
			},
		);

		assert.equal(
			verifyResult.code,
			0,
			`a paced replay with gaps under the watchdog window must PASS; stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.doesNotMatch(
			verifyResult.stderr,
			/subprocess inactive for/,
			"the watchdog must not have fired",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify --timeout: the watchdog DOES fire on a genuine hang during replay, printing a plain verdict with partial evidence (no stack trace)", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-watchdog-hang-verify-test-"),
	);
	const scenarioPath = join(tmpDir, "paced.scenario.json");

	try {
		const recordResult = runRecordCli(
			[
				"scenario-watchdog-paced-connector",
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: "2",
				PDPP_WATCHDOG_TEST_SLEEP_MS: "50",
			},
		);
		assert.equal(
			recordResult.code,
			0,
			`setup recording must succeed; stderr=${recordResult.stderr}`,
		);

		const verifyResult = runVerifyCli(
			[
				"scenario-watchdog-paced-connector",
				scenarioPath,
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--timeout",
				"2",
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: "2",
				PDPP_WATCHDOG_TEST_SLEEP_MS: "100",
				PDPP_WATCHDOG_TEST_HANG_AFTER: "0",
			},
		);

		assert.notEqual(
			verifyResult.code,
			0,
			"a genuine hang during replay must exit nonzero",
		);
		assert.match(
			verifyResult.stderr,
			/^\[scenario-verify\] subprocess inactive for 2s - killed \(window: --timeout 2\)$/m,
			`expected the plain verdict line, NOT folded into the ordinary per-run FAIL report; stderr=${verifyResult.stderr}`,
		);
		assert.doesNotMatch(
			verifyResult.stderr,
			/at .*scenario-verify\.ts/,
			"a watchdog verdict must never print a stack trace",
		);
		assert.match(verifyResult.stderr, /observed so far: items=1 record\(s\)/);
		assert.match(
			verifyResult.stderr,
			/last message seen: RECORD stream=items \(\d+s ago\)/,
		);
		assert.match(verifyResult.stderr, /incomplete by rule \(killed mid-run\)/);
		// Watchdog kills are diagnosed verdicts, not ordinary replay mismatches
		// — must NOT be reported through the normal per-run FAIL listing.
		assert.doesNotMatch(verifyResult.stderr, /replay_mismatch/);
		assert.doesNotMatch(verifyResult.stdout, /run 0: FAIL/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify --timeout: rejects a non-positive-integer value before spawning anything", () => {
	for (const bad of ["-5", "0", "abc", "1.5"]) {
		const verifyResult = runVerifyCli([
			"scenario-watchdog-paced-connector",
			"/nonexistent/does-not-matter.json",
			"--timeout",
			bad,
		]);
		assert.notEqual(verifyResult.code, 0, `--timeout ${bad} must be rejected`);
		assert.match(verifyResult.stderr, /--timeout must be a positive integer/);
		assert.doesNotMatch(
			verifyResult.stdout,
			/VERIFYING/,
			"must fail before even attempting to load the scenario",
		);
	}
});

// ─── Replay time scaling (src/scenario/subprocess-fetch-preloads.ts's
// writeReplayBridgePreload REPLAY TIME SCALING patch) ──────────────────────
//
// Every response a replaying connector sees comes from the recording — there
// is no live provider to protect — so the replay preload SCALES (not skips)
// every setTimeout/setInterval delay a connector schedules by
// REPLAY_TIME_SCALE, preserving relative ordering while collapsing
// wall-clock cost to roughly 1%. Two properties matter and are proven
// end-to-end here (the generated preload source itself can't be unit-tested
// in-process — see src/scenario/subprocess-fetch-preloads.test.ts for the
// pure-arithmetic unit coverage of scaleReplayDelayMs/REPLAY_TIME_SCALE):
//   1. SPEED: reusing the SAME paced watchdog fixture the inactivity-watchdog
//      tests above already drive (src/test-fixtures/scenario-watchdog-paced-
//      connector.ts), the replay's own paced section (its sleeps, timed inside
//      the connector, so process startup is excluded) must stay well under the
//      recorded pacing total. The check lives in the fixture, not here: a
//      replay runs the connector isolated, and a passing run reports nothing
//      back to this test.
//   2. ORDERING: src/test-fixtures/scenario-timer-ordering-connector.ts
//      schedules a LONG timer before a SHORT one but expects the SHORT one to
//      fire (and be recorded) first. Scaling both delays by the same
//      constant factor preserves that "short still shorter than long"
//      relationship; a broken scaling implementation (e.g. collapsing every
//      delay toward zero, or firing timers in registration order) could flip
//      it — and `scenario-verify`'s per-stream oracle (`expected.records.ids`,
//      compared as an ORDERED array — see src/scenario/verify.ts's
//      `verifyStream`) would then fail the replay outright.

test("scenario-verify: a replay of the paced watchdog fixture completes well under its recorded real-time pacing total (REPLAY TIME SCALING)", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-replay-time-scaling-speed-test-"),
	);
	const scenarioPath = join(tmpDir, "paced.scenario.json");
	// 3 records * 800ms real sleep = ~2.4s of real inter-record pacing this
	// run's live capture actually paid.
	const recordCount = "3";
	const sleepMs = "800";
	const recordedPacingTotalMs = 3 * 800;
	// Half the recorded pacing total. The fixture fails the replay if its
	// paced section runs longer (see its header for why it checks itself).
	const maxPacedMs = recordedPacingTotalMs / 2;

	try {
		const recordResult = runRecordCli(
			[
				"scenario-watchdog-paced-connector",
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: recordCount,
				PDPP_WATCHDOG_TEST_SLEEP_MS: sleepMs,
			},
		);
		assert.equal(
			recordResult.code,
			0,
			`setup recording must succeed; stderr=${recordResult.stderr}`,
		);

		const verifyResult = runVerifyCli(
			[
				"scenario-watchdog-paced-connector",
				scenarioPath,
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--timeout",
				"30",
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: recordCount,
				PDPP_WATCHDOG_TEST_SLEEP_MS: sleepMs,
				PDPP_WATCHDOG_TEST_MAX_PACED_MS: String(maxPacedMs),
			},
		);

		assert.equal(
			verifyResult.code,
			0,
			`replay must PASS with its paced section under ${String(maxPacedMs)}ms; stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(
			verifyResult.stdout,
			/replay time: scaled 100x \(pacing\/backoff compressed; recorded responses need no provider protection\)/,
			`expected the time-scaling line on stdout; stdout=${verifyResult.stdout}`,
		);

		// Control: a 1 ms bound must fail the same replay, which proves the bound
		// reached the replayed connector rather than silently not being checked.
		const controlResult = runVerifyCli(
			[
				"scenario-watchdog-paced-connector",
				scenarioPath,
				"--entrypoint",
				WATCHDOG_STUB_CONNECTOR_PATH,
				"--timeout",
				"30",
			],
			{
				PDPP_WATCHDOG_TEST_RECORD_COUNT: recordCount,
				PDPP_WATCHDOG_TEST_SLEEP_MS: sleepMs,
				PDPP_WATCHDOG_TEST_MAX_PACED_MS: "1",
			},
		);
		assert.notEqual(
			controlResult.code,
			0,
			"a 1 ms paced bound must fail the replay",
		);
		assert.match(
			`${controlResult.stdout}${controlResult.stderr}`,
			/over the 1ms bound \(PDPP_WATCHDOG_TEST_MAX_PACED_MS\)/,
			`the control must fail on the paced bound; stdout=${controlResult.stdout}`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: replay preserves relative timer ordering under scaling (short-before-long survives)", () => {
	const tmpDir = mkdtempSync(
		join(tmpdir(), "scenario-replay-time-scaling-order-test-"),
	);
	const scenarioPath = join(tmpDir, "ordering.scenario.json");
	const shortMs = "1000";
	const longMs = "3000";

	try {
		const recordResult = runRecordCli(
			[
				"scenario-timer-ordering-connector",
				"--entrypoint",
				TIMER_ORDER_CONNECTOR_PATH,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{ PDPP_TIMER_ORDER_SHORT_MS: shortMs, PDPP_TIMER_ORDER_LONG_MS: longMs },
		);
		assert.equal(
			recordResult.code,
			0,
			`setup recording must succeed; stderr=${recordResult.stderr}`,
		);

		// Sanity: the LIVE capture really did observe "short" firing (and being
		// recorded) before "long" — otherwise a passing replay below would prove
		// nothing about ordering.
		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		const recordedIds = scenario.runs[0]?.expected.records.items?.ids;
		assert.deepEqual(
			recordedIds,
			["short", "long"],
			`precondition: the live capture must record "short" before "long"; got ${JSON.stringify(recordedIds)}`,
		);

		const verifyResult = runVerifyCli(
			[
				"scenario-timer-ordering-connector",
				scenarioPath,
				"--entrypoint",
				TIMER_ORDER_CONNECTOR_PATH,
				"--timeout",
				"30",
			],
			{ PDPP_TIMER_ORDER_SHORT_MS: shortMs, PDPP_TIMER_ORDER_LONG_MS: longMs },
		);
		assert.equal(
			verifyResult.code,
			0,
			`replay must PASS — the per-stream oracle compares expected.records.ids as an ORDERED array, so a replay that fired "long" before "short" (relative ordering broken by scaling) would fail here; stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ─── Suspend/resume unit coverage ──────────────────────────────────────────
//
// CRITICAL requirement: while an INTERACTION is pending (between the child
// emitting an INTERACTION line and the response being written back to its
// stdin), the watchdog must be SUSPENDED — an operator thinking at a TTY
// prompt is not a hang. Driving a REAL TTY prompt inside an automated
// `node --test` run isn't practical (no controllable TTY exists in this
// harness), so this is proven directly against
// `createInactivityWatchdog`'s exported suspend/resume/touch/dispose
// contract instead — the same pure core `runRecordSubprocess` (record) and
// `runReplaySubprocess` (verify) both wire into their child's
// stdout/stdin/close handlers. This is an honest substitute, not a workaround:
// the end-to-end tests above already prove the watchdog fires/doesn't fire
// around real subprocess activity: what ISN'T covered end-to-end is
// specifically the suspend-while-waiting-on-a-human case, which is exactly
// what's unit-tested here with an injected fake clock.

function fakeClock(): {
	cancel: (handle: NodeJS.Timeout) => void;
	fire: () => void;
	schedule: (fn: () => void, ms: number) => NodeJS.Timeout;
} {
	let nextHandle = 1;
	let pending: { fn: () => void; handle: NodeJS.Timeout } | undefined;
	return {
		schedule: (fn: () => void, _ms: number): NodeJS.Timeout => {
			const handle = nextHandle as unknown as NodeJS.Timeout;
			nextHandle += 1;
			pending = { fn, handle };
			return handle;
		},
		cancel: (handle: NodeJS.Timeout): void => {
			if (pending?.handle === handle) {
				pending = undefined;
			}
		},
		// Fires the currently-armed timer, if any (a no-op when suspended/disposed
		// — matching a real timer that was never scheduled).
		fire: (): void => {
			pending?.fn();
		},
	};
}

for (const [label, createInactivityWatchdog] of [
	["scenario-record", createRecordInactivityWatchdog],
	["scenario-verify", createVerifyInactivityWatchdog],
] as const) {
	test(`${label} createInactivityWatchdog: touch() does not prevent onTimeout from firing once armed and left untouched`, () => {
		const clock = fakeClock();
		let fired = 0;
		createInactivityWatchdog(
			1000,
			() => {
				fired += 1;
			},
			clock,
		);
		clock.fire();
		assert.equal(fired, 1);
	});

	test(`${label} createInactivityWatchdog: suspend() prevents onTimeout from firing even past the window`, () => {
		const clock = fakeClock();
		let fired = 0;
		const watchdog = createInactivityWatchdog(
			1000,
			() => {
				fired += 1;
			},
			clock,
		);
		watchdog.suspend();
		// Nothing is armed while suspended — firing the (nonexistent) pending
		// timer must be a no-op.
		clock.fire();
		assert.equal(fired, 0, "onTimeout must never fire while suspended");
	});

	test(`${label} createInactivityWatchdog: touch() while suspended is a no-op — resume() is required to re-arm`, () => {
		const clock = fakeClock();
		let fired = 0;
		const watchdog = createInactivityWatchdog(
			1000,
			() => {
				fired += 1;
			},
			clock,
		);
		watchdog.suspend();
		watchdog.touch(); // must NOT re-arm while suspended
		clock.fire();
		assert.equal(fired, 0, "touch() must not resume a suspended watchdog");
	});

	test(`${label} createInactivityWatchdog: resume() re-arms a fresh full window after suspend()`, () => {
		const clock = fakeClock();
		let fired = 0;
		const watchdog = createInactivityWatchdog(
			1000,
			() => {
				fired += 1;
			},
			clock,
		);
		watchdog.suspend();
		clock.fire(); // no-op: suspended
		watchdog.resume();
		clock.fire(); // now armed again: fires
		assert.equal(
			fired,
			1,
			"resume() must re-arm the watchdog so a later timeout still fires",
		);
	});

	test(`${label} createInactivityWatchdog: dispose() permanently cancels — no further touch()/resume() can make it fire`, () => {
		const clock = fakeClock();
		let fired = 0;
		const watchdog = createInactivityWatchdog(
			1000,
			() => {
				fired += 1;
			},
			clock,
		);
		watchdog.dispose();
		clock.fire();
		assert.equal(
			fired,
			0,
			"dispose() must prevent the armed timer from firing",
		);
		// Mirrors the real usage: dispose() is called once, at child "close"/
		// "error" — nothing calls touch()/resume() afterward in practice, but
		// proving they don't resurrect a disposed watchdog guards against a
		// future ordering bug.
		watchdog.touch();
		clock.fire();
		assert.equal(fired, 0, "touch() after dispose() must not re-arm");
	});
}

test("scenario-verify --json is opt-in and carries a path", () => {
	// Absent by default: the claim record is a side channel for CI, never
	// something a plain local verify run writes to disk unasked.
	assert.equal(parseVerifyArgs(["reddit", "/tmp/s.json"]).jsonPath, undefined);
	assert.equal(
		parseVerifyArgs(["reddit", "/tmp/s.json", "--json", "/tmp/claim.json"])
			.jsonPath,
		"/tmp/claim.json",
	);
	// Positional args still bind in order with the flag interleaved.
	const mixed = parseVerifyArgs([
		"reddit",
		"--json",
		"/tmp/claim.json",
		"/tmp/s.json",
	]);
	assert.equal(mixed.connector, "reddit");
	assert.equal(mixed.scenarioPath, "/tmp/s.json");
	assert.equal(mixed.jsonPath, "/tmp/claim.json");
});

test("scenario-verify --dump-records / --dump-all-records: parsed, and default to unset/false", () => {
	const bare = parseVerifyArgs(["reddit", "/tmp/s.json"]);
	assert.equal(bare.dumpRecordsDir, undefined);
	assert.equal(bare.dumpAllRecords, false);

	const withDump = parseVerifyArgs([
		"reddit",
		"/tmp/s.json",
		"--dump-records",
		"/tmp/dumps",
		"--dump-all-records",
	]);
	assert.equal(withDump.dumpRecordsDir, "/tmp/dumps");
	assert.equal(withDump.dumpAllRecords, true);
});

test("resolveDumpRecordsDir: the --dump-records flag wins over PDPP_SCENARIO_DUMP_DIR, and either alone is sufficient", () => {
	assert.equal(
		resolveDumpRecordsDir(
			{ dumpRecordsDir: "/flag" },
			{ PDPP_SCENARIO_DUMP_DIR: "/env" },
		),
		"/flag",
		"the flag must win when both are set",
	);
	assert.equal(
		resolveDumpRecordsDir({}, { PDPP_SCENARIO_DUMP_DIR: "/env" }),
		"/env",
		"the env var alone must be sufficient",
	);
	assert.equal(
		resolveDumpRecordsDir({ dumpRecordsDir: "/flag" }, {}),
		"/flag",
		"the flag alone must be sufficient",
	);
	assert.equal(
		resolveDumpRecordsDir({}, {}),
		undefined,
		"neither set means dumping is off",
	);
});

// ─── Replay subprocess env: Playwright cache path forced, headless forced,
// DISPLAY/WAYLAND_DISPLAY dropped (live reddit recording, 2026-10-02) ──────
//
// A real recorded-browser replay failed two ways when run from an
// interactive session with DISPLAY set and no PLAYWRIGHT_BROWSERS_PATH
// exported:
//   1. "Executable doesn't exist" — isolation.ts's sandboxScratchEnv
//      redirects the child's XDG_CACHE_HOME into sandbox-local scratch
//      space, so Playwright/Patchright computed its default browser-cache
//      location under that EMPTY scratch directory instead of the real,
//      bound-read-only cache (`requiredFilesystemBinds`'s
//      `resolvedPlaywrightBrowsersPath()` entry).
//   2. "launchPersistentContext: Target page, context or browser has been
//      closed" — the replay child inherited the caller's DISPLAY, so
//      Playwright attempted a headed launch inside a sandbox that
//      (correctly) provides no display socket.
//
// Both are fixed by `runReplaySubprocess` (bin/scenario-verify.ts) always
// setting PLAYWRIGHT_BROWSERS_PATH to the exact bound path and
// PDPP_BROWSER_HEADLESS=1, and dropping DISPLAY/WAYLAND_DISPLAY, regardless
// of driver — this is proved below WITHOUT a real browser or HAR: any
// replay subprocess (recorded-http included) goes through the same env
// construction, so a plain --entrypoint connector that echoes back what it
// observed is sufficient, and faster/more hermetic than a real
// recorded-browser round trip. The scenario is hand-authored (not recorded)
// specifically so its one expected record hash is computed from the
// FORCED/EXPECTED replay-time env, not whatever this test process's own
// ambient env happens to be at record time — a mismatch there would itself
// prove the fix is working (the two environments differ on purpose).

function writeEnvEchoConnector(): string {
	const connectorRuntimePath = join(
		PACKAGE_ROOT,
		"src",
		"connector-runtime.ts",
	);
	const scriptPath = join(
		packageScratchDir(),
		`pdpp-env-echo-connector-${String(process.pid)}-${String(Date.now())}.ts`,
	);
	const src = `
import type { RecordData, ValidateRecord } from ${JSON.stringify(connectorRuntimePath)};
import { runConnector } from ${JSON.stringify(connectorRuntimePath)};

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "env-echo-connector",
  validateRecord,
  async collect({ emitRecord }) {
    await emitRecord("env", {
      id: "env",
      playwrightBrowsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
      display: process.env.DISPLAY ?? null,
      waylandDisplay: process.env.WAYLAND_DISPLAY ?? null,
      headless: process.env.PDPP_BROWSER_HEADLESS ?? null,
    });
  },
});
`;
	writeFileSync(scriptPath, src);
	return scriptPath;
}

test("scenario-verify: replay subprocess forces PLAYWRIGHT_BROWSERS_PATH and PDPP_BROWSER_HEADLESS=1, and drops DISPLAY/WAYLAND_DISPLAY, even though the caller's own env sets all three differently", () => {
	const connectorPath = writeEnvEchoConnector();
	const tmpDir = mkdtempSync(join(tmpdir(), "scenario-cli-replay-env-test-"));
	const scenarioPath = join(tmpDir, "env-echo.scenario.json");
	const fakePlaywrightPath = "/fake/playwright/cache/for/test";

	// The exact record the replay MUST produce once the fix forces these
	// three env vars — computed here, not copied from a real recording, so
	// this assertion is independent of whatever DISPLAY/WAYLAND_DISPLAY this
	// test process happens to have.
	const expectedData = {
		id: "env",
		playwrightBrowsersPath: fakePlaywrightPath,
		display: null,
		waylandDisplay: null,
		headless: "1",
	};
	const scenario: ConnectorScenario = {
		format: "pdpp.connector-scenario/1",
		connector: { id: "env-echo-connector" },
		capture: {
			captured_at: "2026-08-01T00:00:00.000Z",
			evidence_class: "synthetic-spike",
			privacy_class: "local-only",
			recorder_version: "test",
			complete: true,
		},
		runs: [
			{
				start: { scope: { streams: [{ name: "env" }] }, state: null },
				interactions: [],
				expected: {
					records: {
						env: {
							count: 1,
							ids: ["env"],
							ops: ["upsert"],
							record_sha256s: [hashCanonicalJson(expectedData)],
						},
					},
					final_state: {},
				},
			},
		],
	};
	writeFileSync(scenarioPath, JSON.stringify(scenario));

	try {
		// The caller's own env deliberately sets all three differently from what
		// the replay subprocess must observe — proving the fix actively
		// overrides them rather than merely happening to agree by default.
		const verifyResult = runVerifyCli(
			["env-echo-connector", "--entrypoint", connectorPath, scenarioPath],
			{
				DISPLAY: ":99",
				WAYLAND_DISPLAY: "wayland-99",
				PLAYWRIGHT_BROWSERS_PATH: fakePlaywrightPath,
				PDPP_BROWSER_HEADLESS: "0",
			},
		);
		assert.equal(
			verifyResult.code,
			0,
			`expected success (record hash match proves the forced env); stdout=${verifyResult.stdout} stderr=${verifyResult.stderr}`,
		);
		assert.match(verifyResult.stdout, /run 0: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
		rmSync(connectorPath, { force: true });
	}
});

// ─── raw observation advisory: selection context, typed wire keys, deep schemas ───

function writeBoundObservationFixture(options: {
	collectBody: string;
	connectorKey: string;
	schemaJson: string;
	tmpDir: string;
}): void {
	const connectorDir = join(options.tmpDir, "connectors", options.connectorKey);
	mkdirSync(connectorDir, { recursive: true });
	writeFileSync(
		join(connectorDir, "index.ts"),
		`import { runConnector } from "../../../../src/connector-runtime.ts";
runConnector({
  name: ${JSON.stringify(options.connectorKey)},
  validateRecord: (_stream, data) => ({ ok: true, data }),
  async collect({ emit, emitRecord, sendInteraction, state }) {
    const repeated = Object.hasOwn(state, "items");
${options.collectBody}
    await emit({ type: "STATE", stream: "items", cursor: { marker: "local" } });
  },
});
`,
	);
	writeFileSync(
		join(connectorDir, "manifest.json"),
		`{"connector_id":"https://registry.pdpp.dev/connectors/${options.connectorKey.replaceAll("_", "-")}","connector_key":${JSON.stringify(options.connectorKey)},"protocol_version":"0.1.0","version":"0.0.0-test","streams":[{"name":"items","primary_key":["id"],"schema":${options.schemaJson}}]}`,
	);
}

/** Reads every INTERACTION the connector actually put on the wire (from the
 *  recorder's transcript) and runs the repo's own wire validator over it, so
 *  a fixture that drifts outside the closed kind enum fails here instead of
 *  silently passing a recorder that does not validate. Returns the count. */
function assertTranscriptInteractionsContractValid(
	transcriptDir: string,
): number {
	let count = 0;
	for (const file of readdirSync(transcriptDir)) {
		for (const line of readFileSync(join(transcriptDir, file), "utf8").split(
			"\n",
		)) {
			if (line.length === 0) {
				continue;
			}
			const { message } = JSON.parse(line) as {
				message: Parameters<typeof assertValidInteractionMessage>[0];
			};
			if (message.type === "INTERACTION") {
				assertValidInteractionMessage(message);
				count += 1;
			}
		}
	}
	return count;
}

const SELECTION_FIXTURE_BODY = `    const selection = await sendInteraction({
      kind: "manual_action",
      message: "SELECTION_PROMPT_PRIVATE_CANARY",
      request_id: process.env.SELECTION_FIXTURE_SAME === "1" ? "pick" : repeated ? "pick-second" : "pick-first",
    });
    if (selection.status !== "success") throw new Error("selection not answered");
    await emitRecord("items", { id: "same-stream-local-id", label: repeated ? "second" : "first" });`;

const SIMPLE_SCHEMA = JSON.stringify({
	type: "object",
	properties: { id: { type: "string" }, label: { type: "string" } },
});

test("scenario-record: advisory omits repeated-key comparisons when the runs answered different selections", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-selection-context-"),
	);
	const connectorKey = "selection_context_fixture";
	writeBoundObservationFixture({
		collectBody: SELECTION_FIXTURE_BODY,
		connectorKey,
		schemaJson: SIMPLE_SCHEMA,
		tmpDir,
	});
	try {
		const differentTranscript = join(tmpDir, "transcript-different");
		const sameTranscript = join(tmpDir, "transcript-same");
		const differentSelections = runRecordCli(
			[
				connectorKey,
				"--out",
				join(tmpDir, "different.scenario.json"),
				"--answer",
				"pick-first=SELECTION_ACCOUNT_A_CANARY",
				"--answer",
				"pick-second=SELECTION_ACCOUNT_B_CANARY",
			],
			{
				PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir,
				PDPP_SCENARIO_TRANSCRIPT_DIR: differentTranscript,
			},
		);
		assert.equal(differentSelections.code, 0, differentSelections.stderr);
		assert.equal(
			assertTranscriptInteractionsContractValid(differentTranscript),
			2,
		);
		assert.match(
			differentSelections.stdout,
			/items: insufficient-repeat-observations \(0 repeated identities;/,
		);
		assert.match(
			differentSelections.stdout,
			/limitation: [^\n]*scope or selection context/,
		);

		const sameSelection = runRecordCli(
			[
				connectorKey,
				"--out",
				join(tmpDir, "same.scenario.json"),
				"--answer",
				"pick=SELECTION_ACCOUNT_A_CANARY",
			],
			{
				PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir,
				PDPP_SCENARIO_TRANSCRIPT_DIR: sameTranscript,
				SELECTION_FIXTURE_SAME: "1",
			},
		);
		assert.equal(sameSelection.code, 0, sameSelection.stderr);
		assert.equal(assertTranscriptInteractionsContractValid(sameTranscript), 2);
		assert.match(
			sameSelection.stdout,
			/items: differences-observed \(1 repeated identities;/,
		);
		for (const output of [differentSelections, sameSelection]) {
			for (const canary of [
				"SELECTION_PROMPT_PRIVATE_CANARY",
				"SELECTION_ACCOUNT_A_CANARY",
				"SELECTION_ACCOUNT_B_CANARY",
				"same-stream-local-id",
			]) {
				assert.equal(output.stdout.includes(canary), false);
				assert.equal(output.stderr.includes(canary), false);
			}
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

/**
 * Same kind/message/request_id and the same wire answer ("0") in both runs,
 * but the prompt schema says option 0 is a different account each run. The
 * schema is selection-relevant: dropping it pairs the runs and blames the
 * stream for the label change. The variants below cover canonical key order,
 * selection-relevant array order and types, the serialized-context bound,
 * legacy prompts with no schema, and a schema nested past the canonical bound.
 */
const SELECTION_SCHEMA_FIXTURE_BODY = `    const mode = process.env.SELECTION_SCHEMA_FIXTURE_MODE ?? "account";
    const label = repeated ? "SELECTION_ACCOUNT_B_CANARY" : "SELECTION_ACCOUNT_A_CANARY";
    const sharedLabel = "SELECTION_ACCOUNT_A_CANARY";
    let schema;
    if (mode === "legacy") {
      schema = undefined;
    } else if (mode === "same") {
      schema = { type: "object", properties: { account: { type: "string", const: sharedLabel } }, required: ["account"] };
    } else if (mode === "reordered") {
      schema = repeated
        ? { required: ["account"], properties: { account: { const: sharedLabel, type: "string" } }, type: "object" }
        : { type: "object", properties: { account: { type: "string", const: sharedLabel } }, required: ["account"] };
    } else if (mode === "array-order") {
      schema = { type: "object", properties: { account: { type: "string", enum: repeated ? ["b", "a"] : ["a", "b"] } } };
    } else if (mode === "type-change") {
      schema = { type: "object", properties: { account: { type: repeated ? "number" : "string" } } };
    } else if (mode === "bound") {
      schema = { type: "object", description: "x".repeat(60_000), properties: { account: { type: "string" } } };
    } else if (mode === "overbound") {
      schema = { type: "object", description: "y".repeat(70_000), properties: { account: { type: "string" } } };
    } else if (mode === "proto-type-change") {
      schema = JSON.parse(repeated ? '{"type":"object","properties":{"__proto__":{"type":"number"}}}' : '{"type":"object","properties":{"__proto__":{"type":"string"}}}');
    } else if (mode === "proto-same") {
      schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}');
    } else if (mode === "unsupported") {
      schema = { type: "string" };
      for (let depth = 0; depth < 100; depth += 1) {
        schema = { type: "object", properties: { step: schema } };
      }
    } else {
      schema = { type: "object", properties: { account: { type: "string", enum: [label] } }, required: ["account"] };
    }
    const selection = await sendInteraction({
      kind: "manual_action",
      message: "SELECTION_SCHEMA_PROMPT_CANARY",
      request_id: "pick",
      ...(schema === undefined ? {} : { schema }),
    });
    if (selection.status !== "success") throw new Error("selection not answered");
    await emitRecord("items", { id: "same-stream-local-id", label: repeated ? "second" : "first" });`;

test("scenario-record: selection schema distinguishes account options across runs", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-selection-schema-"),
	);
	const connectorKey = "selection_schema_fixture";
	writeBoundObservationFixture({
		collectBody: SELECTION_SCHEMA_FIXTURE_BODY,
		connectorKey,
		schemaJson: SIMPLE_SCHEMA,
		tmpDir,
	});
	const cases = [
		{
			mode: "account",
			expected: "insufficient-repeat-observations (0 repeated identities;",
			why: "different account options must not be paired",
		},
		{
			mode: "same",
			expected: "differences-observed (1 repeated identities;",
			why: "an identical schema stays comparable",
		},
		{
			mode: "reordered",
			expected: "differences-observed (1 repeated identities;",
			why: "object key order is not selection-relevant",
		},
		{
			mode: "array-order",
			expected: "insufficient-repeat-observations (0 repeated identities;",
			why: "array order is selection-relevant",
		},
		{
			mode: "type-change",
			expected: "insufficient-repeat-observations (0 repeated identities;",
			why: "a JSON type change is selection-relevant",
		},
		{
			mode: "bound",
			expected: "differences-observed (1 repeated identities;",
			why: "a schema inside the serialized bound still compares",
		},
		{
			mode: "overbound",
			expected: "insufficient-repeat-observations (0 repeated identities;",
			why: "a schema past the serialized bound makes the context unknown",
		},
		{
			mode: "legacy",
			expected: "differences-observed (1 repeated identities;",
			why: "a missing legacy schema preserves the old comparison",
		},
		{
			mode: "unsupported",
			expected: "insufficient-repeat-observations (0 repeated identities;",
			why: "a schema past the canonical depth bound is unsupported",
		},
		{
			mode: "proto-same",
			expected: "differences-observed (1 repeated identities;",
			why: "an identical own __proto__ schema key stays comparable",
		},
		{
			mode: "proto-type-change",
			expected: "insufficient-repeat-observations (0 repeated identities;",
			why: "an own __proto__ schema key is data, so schemas that differ in its type must not pair",
		},
	];
	try {
		for (const { mode, expected, why } of cases) {
			const transcriptDir = join(tmpDir, `transcript-${mode}`);
			const result = runRecordCli(
				[
					connectorKey,
					"--out",
					join(tmpDir, `${mode}.scenario.json`),
					"--answer",
					"pick=0",
				],
				{
					PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir,
					PDPP_SCENARIO_TRANSCRIPT_DIR: transcriptDir,
					SELECTION_SCHEMA_FIXTURE_MODE: mode,
				},
			);
			assert.equal(result.code, 0, `${mode}: ${result.stderr}`);
			assert.match(result.stdout, /complete: true/, mode);
			assert.equal(
				assertTranscriptInteractionsContractValid(transcriptDir),
				2,
				mode,
			);
			assert.equal(
				result.stdout.includes(`items: ${expected}`),
				true,
				`${mode}: ${why}; stdout=${result.stdout}`,
			);
			if (expected.startsWith("insufficient")) {
				assert.equal(
					result.stdout.includes("/label (1)"),
					false,
					`${mode} must not claim a label change`,
				);
				assert.equal(
					result.stdout.includes("raw changed fields:"),
					false,
					`${mode} must not name changed fields from unpaired runs`,
				);
				assert.match(
					result.stdout,
					/limitation: [^\n]*scope or selection context/,
					mode,
				);
			} else {
				assert.equal(
					result.stdout.includes("/label (1)"),
					true,
					`${mode} should pair the runs and report the label change`,
				);
			}
			for (const canary of [
				"SELECTION_SCHEMA_PROMPT_CANARY",
				"SELECTION_ACCOUNT_A_CANARY",
				"SELECTION_ACCOUNT_B_CANARY",
				"same-stream-local-id",
			]) {
				assert.equal(result.stdout.includes(canary), false, mode);
				assert.equal(result.stderr.includes(canary), false, mode);
			}
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: advisory keeps wire key [x] distinct from the scalar string whose text is [x]", () => {
	const tmpDir = mkdtempSync(join(packageScratchDir(), "scenario-wire-key-"));
	const fixturePath = join(tmpDir, "wire-key-fixture.ts");
	writeFileSync(
		fixturePath,
		`import { runConnector } from "../../src/connector-runtime.ts";
runConnector({
  name: "wire-key-smoke",
  validateRecord: (_stream, data) => ({ ok: true, data }),
  async collect({ emit, state }) {
    const repeated = Object.hasOwn(state, "items");
    const same = process.env.WIRE_KEY_FIXTURE_SAME === "1";
    await emit({
      type: "RECORD",
      stream: "items",
      key: repeated && !same ? '["wire-key-canary"]' : ["wire-key-canary"],
      data: { id: "wire-key-canary", value: repeated ? "second" : "first" },
      emitted_at: new Date().toISOString(),
    });
    await emit({ type: "STATE", stream: "items", cursor: { marker: "local" } });
  },
});
`,
	);
	try {
		const distinct = runRecordCli(
			[
				"wire-key-smoke",
				"--entrypoint",
				fixturePath,
				"--out",
				join(tmpDir, "distinct.scenario.json"),
			],
			{},
		);
		assert.equal(distinct.code, 0, distinct.stderr);
		assert.match(
			distinct.stdout,
			/\(undeclared stream\): insufficient-repeat-observations \(0 repeated identities;/,
		);
		const same = runRecordCli(
			[
				"wire-key-smoke",
				"--entrypoint",
				fixturePath,
				"--out",
				join(tmpDir, "same.scenario.json"),
			],
			{ WIRE_KEY_FIXTURE_SAME: "1" },
		);
		assert.equal(same.code, 0, same.stderr);
		assert.match(
			same.stdout,
			/\(undeclared stream\): differences-observed \(1 repeated identities;/,
		);
		for (const output of [distinct, same]) {
			assert.equal(output.stdout.includes("wire-key-canary"), false);
			assert.equal(output.stderr.includes("wire-key-canary"), false);
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: a deeply nested declared schema cannot abort capture before run 1", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-deep-schema-"),
	);
	const connectorKey = "deep_schema_fixture";
	const depth = 20_000;
	const deepSchema = `{"type":"object","properties":{"id":{"type":"string"},"label":{"type":"string"},"deep":${'{"properties":{"a":'.repeat(depth)}{}${"}}".repeat(depth)}}}`;
	writeBoundObservationFixture({
		collectBody: `    await emitRecord("items", { id: "deep-schema-id", label: repeated ? "second" : "first" });`,
		connectorKey,
		schemaJson: deepSchema,
		tmpDir,
	});
	try {
		const result = runRecordCli(
			[connectorKey, "--out", join(tmpDir, "deep.scenario.json")],
			{
				PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir,
			},
		);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /RECORDING [^\n]* run 1/);
		assert.match(result.stdout, /complete: true/);
		assert.match(
			result.stdout,
			/limitation: [^\n]*(schema|metadata)[^\n]*(bounded|unavailable|omitted)/i,
		);
		assert.equal(result.stdout.includes("deep-schema-id"), false);
		assert.equal(result.stderr.includes("RangeError"), false);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-record: declared schema bounds wide allOf scheduling and discloses omitted children", () => {
	const tmpDir = mkdtempSync(join(packageScratchDir(), "scenario-wide-allof-"));
	const connectorKey = "wide_allof_fixture";
	// The tail is visited first by the old eager stack. A bounded scheduler
	// must omit it, not allocate a frame for every child before applying a cap.
	const allOf = Array.from({ length: 8192 }, () => ({}));
	allOf.push({ properties: { omitted: { type: "string" } } });
	writeBoundObservationFixture({
		collectBody: `    await emitRecord("items", { id: "wide-id-canary", safe: repeated ? "safe-second" : "safe-first", omitted: repeated ? "tail-second" : "tail-first" });`,
		connectorKey,
		schemaJson: JSON.stringify({
			type: "object",
			properties: { id: { type: "string" }, safe: { type: "string" } },
			allOf,
		}),
		tmpDir,
	});
	try {
		const result = runRecordCli(
			[connectorKey, "--out", join(tmpDir, "wide.scenario.json")],
			{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
		);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /complete: true/);
		assert.match(
			result.stdout,
			/items: differences-observed \(1 repeated identities;/,
		);
		assert.match(result.stdout, /Schema field metadata was bounded/);
		assert.match(result.stdout, /\/safe \(1\)/);
		assert.doesNotMatch(result.stdout, /\/omitted/);
		assert.match(result.stdout, /raw changes in unnamed or undeclared fields/);
		for (const canary of [
			"wide-id-canary",
			"safe-first",
			"safe-second",
			"tail-first",
			"tail-second",
		]) {
			assert.equal((result.stdout + result.stderr).includes(canary), false);
		}
		// This checks real metadata/output, not peak allocation or runtime.
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

for (const baseKeyword of ["$id", "id"]) {
	test(`scenario-record: declared schema rejects pointer ancestors with nested ${baseKeyword}`, () => {
		const tmpDir = mkdtempSync(
			join(packageScratchDir(), "scenario-ref-ancestor-"),
		);
		const connectorKey = "ref_ancestor_fixture";
		writeBoundObservationFixture({
			collectBody: `    await emitRecord("items", { id: "ancestor-id-canary", safe: repeated ? "safe-second" : "safe-first", alias: { wrong: repeated ? "wrong-second" : "wrong-first" } });`,
			connectorKey,
			schemaJson: JSON.stringify({
				$id: "urn:root",
				type: "object",
				properties: {
					id: { type: "string" },
					safe: { type: "string" },
					alias: { $ref: "#/$defs/nested/$defs/leaf" },
				},
				$defs: {
					target: { properties: { wrong: { type: "string" } } },
					nested: {
						[baseKeyword]: "urn:nested",
						$defs: {
							leaf: { $ref: "#/$defs/target" },
							target: { properties: { right: { type: "string" } } },
						},
					},
				},
			}),
			tmpDir,
		});
		try {
			const result = runRecordCli(
				[connectorKey, "--out", join(tmpDir, "ancestor.scenario.json")],
				{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
			);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /complete: true/);
			assert.match(
				result.stdout,
				/items: differences-observed \(1 repeated identities;/,
			);
			assert.doesNotMatch(result.stdout, /\/alias\/wrong/);
			assert.match(result.stdout, /Schema field metadata was bounded/);
			assert.match(result.stdout, /\/safe \(1\)/);
			assert.match(
				result.stdout,
				/raw changes in unnamed or undeclared fields/,
			);
			for (const canary of [
				"ancestor-id-canary",
				"safe-first",
				"safe-second",
				"wrong-first",
				"wrong-second",
			]) {
				assert.equal((result.stdout + result.stderr).includes(canary), false);
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
}

test("scenario-record: declared schema bounds pointer length before expansion", () => {
	const tmpDir = mkdtempSync(join(packageScratchDir(), "scenario-ref-length-"));
	try {
		for (const length of [65_536, 65_537]) {
			const connectorKey = "ref_length_fixture";
			const key = "x".repeat(length - "#/$defs/".length);
			writeBoundObservationFixture({
				collectBody:
					'    await emitRecord("items", { id: "pointer-id-canary", alias: { leaf: repeated ? "pointer-second" : "pointer-first" } });',
				connectorKey,
				schemaJson: JSON.stringify({
					properties: {
						id: { type: "string" },
						alias: { $ref: "#/$defs/" + key },
					},
					$defs: { [key]: { properties: { leaf: { type: "string" } } } },
				}),
				tmpDir,
			});
			const result = runRecordCli(
				[connectorKey, "--out", join(tmpDir, "pointer.scenario.json")],
				{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
			);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /complete: true/);
			assert.match(
				result.stdout,
				/items: differences-observed \(1 repeated identities;/,
			);
			assert.equal(
				result.stdout.includes("/alias/leaf (1)"),
				length === 65_536,
			);
			assert.equal(
				result.stdout.includes("Schema field metadata was bounded"),
				length > 65_536,
			);
			assert.equal(
				result.stdout.includes("raw changes in unnamed or undeclared fields"),
				length > 65_536,
			);
			for (const canary of [
				key,
				"pointer-id-canary",
				"pointer-first",
				"pointer-second",
			]) {
				assert.equal((result.stdout + result.stderr).includes(canary), false);
			}
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

for (const { label, ref, named, bounded } of [
	{
		label: "encoded separators",
		ref: "#/$defs/a%2F$defs%2Fb",
		named: "right",
		bounded: false,
	},
	{
		label: "literal slash key",
		ref: "#/$defs/a~1$defs~1b",
		named: "wrong",
		bounded: false,
	},
	{
		label: "encoded tilde",
		ref: "#/$defs/a%7E1$defs%7E1b",
		named: "wrong",
		bounded: false,
	},
	{
		label: "percent decoded once",
		ref: "#/$defs/a%252F$defs%252Fb",
		named: "once",
		bounded: false,
	},
	{
		label: "malformed percent",
		ref: "#/$defs/a%ZZ",
		named: undefined,
		bounded: true,
	},
	{
		label: "encoded initial separator",
		ref: "#%2F$defs%2Fa%2F$defs%2Fb",
		named: "right",
		bounded: false,
	},
]) {
	test(`scenario-record: declared schema fragment decoding: ${label}`, () => {
		const tmpDir = mkdtempSync(
			join(packageScratchDir(), "scenario-ref-fragment-"),
		);
		const connectorKey = "ref_fragment_fixture";
		writeBoundObservationFixture({
			collectBody: `    await emitRecord("items", { id: "fragment-id-canary", alias: { right: repeated ? "right-second" : "right-first", wrong: repeated ? "wrong-second" : "wrong-first", once: repeated ? "once-second" : "once-first" } });`,
			connectorKey,
			schemaJson: JSON.stringify({
				properties: { id: { type: "string" }, alias: { $ref: ref } },
				$defs: {
					a: { $defs: { b: { properties: { right: {} } } } },
					"a/$defs/b": { properties: { wrong: {} } },
					"a%2F$defs%2Fb": { properties: { once: {} } },
				},
			}),
			tmpDir,
		});
		try {
			const result = runRecordCli(
				[connectorKey, "--out", join(tmpDir, "fragment.scenario.json")],
				{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
			);
			assert.equal(result.code, 0, result.stderr);
			assert.match(result.stdout, /complete: true/);
			assert.match(
				result.stdout,
				/items: differences-observed \(1 repeated identities;/,
			);
			for (const field of ["right", "wrong", "once"]) {
				assert.equal(
					result.stdout.includes(`/alias/${field} (1)`),
					field === named,
					`${label}: only the independently expected target may be named; stdout=${result.stdout}`,
				);
			}
			assert.match(
				result.stdout,
				/raw changes in unnamed or undeclared fields/,
			);
			assert.equal(
				result.stdout.includes("Schema field metadata was bounded"),
				bounded,
			);
			for (const canary of [
				"fragment-id-canary",
				"right-first",
				"right-second",
				"wrong-first",
				"wrong-second",
				"once-first",
				"once-second",
			]) {
				assert.equal((result.stdout + result.stderr).includes(canary), false);
			}
		} finally {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
}

const ALL_OF_REF_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		id: { type: "string" },
		nested: { $ref: "#/$defs/a~1b~0c" },
	},
	allOf: [
		{ properties: { clock: { type: "string" } } },
		{ $ref: "#/$defs/shared" },
		{ $ref: "#/$defs/shared" },
	],
	$defs: {
		"a/b~c": { properties: { value: { type: "string" } } },
		shared: { properties: { status: { type: "string" } } },
	},
});

test("scenario-record: declared schema follows allOf and local $refs across runs", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-declared-schema-"),
	);
	const connectorKey = "declared_schema_fixture";
	writeBoundObservationFixture({
		collectBody: `    await emitRecord("items", {
      id: "same-stream-local-id",
      clock: repeated ? "second-clock" : "first-clock",
      nested: { value: repeated ? "second-value" : "first-value" },
      status: repeated ? "second-status" : "first-status",
    });`,
		connectorKey,
		schemaJson: ALL_OF_REF_SCHEMA,
		tmpDir,
	});
	try {
		const result = runRecordCli(
			[connectorKey, "--out", join(tmpDir, "declared.scenario.json")],
			{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
		);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /complete: true/);
		assert.match(
			result.stdout,
			/items: differences-observed \(1 repeated identities;/,
		);
		assert.equal(
			result.stdout.includes(
				"raw changed fields: /clock (1), /nested/value (1), /status (1)",
			),
			true,
			`allOf and local $ref field names must be declared; stdout=${result.stdout}`,
		);
		assert.equal(
			result.stdout.includes("raw changes in unnamed or undeclared fields"),
			false,
			"all changed fields are declared through allOf/$ref, so none is unnamed",
		);
		assert.equal(
			result.stdout.includes("Schema field metadata was bounded"),
			false,
			"resolvable local refs must not claim schema metadata was bounded",
		);
		for (const canary of [
			"first-clock",
			"second-clock",
			"first-value",
			"second-value",
			"first-status",
			"second-status",
			"same-stream-local-id",
		]) {
			assert.equal(result.stdout.includes(canary), false);
			assert.equal(result.stderr.includes(canary), false);
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

/** A chain of local refs long enough that traversing it twice would cross the
 *  node visit bound; one traversal stays under it. */
function chainedRefSchema(length: number): string {
	const defs: Record<string, unknown> = {};
	for (let index = 0; index < length; index += 1) {
		defs[`s${String(index)}`] =
			index === length - 1
				? { properties: { last: { type: "string" } } }
				: { $ref: `#/$defs/s${String(index + 1)}` };
	}
	return JSON.stringify({
		type: "object",
		properties: { id: { type: "string" } },
		allOf: [{ $ref: "#/$defs/s0" }, { $ref: "#/$defs/s0" }],
		$defs: defs,
	});
}

function chainedRefOverflowSchema(length: number): string {
	const defs: Record<string, unknown> = {};
	for (let index = 0; index < length; index += 1) {
		defs[`s${String(index)}`] =
			index === length - 1
				? { properties: { last: { type: "string" } } }
				: { $ref: `#/$defs/s${String(index + 1)}` };
	}
	return JSON.stringify({
		type: "object",
		properties: { id: { type: "string" } },
		allOf: [{ $ref: "#/$defs/s0" }],
		$defs: defs,
	});
}

test("scenario-record: declared schema cycles, unresolved refs, and node overflows stay bounded", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-schema-bounds-"),
	);
	const cases: Array<{
		bounded: boolean;
		collectBody?: string;
		key: string;
		namedField?: string;
		runs?: string;
		schema: string;
		why: string;
	}> = [
		{
			bounded: true,
			key: "schema_cycle_fixture",
			schema: JSON.stringify({
				type: "object",
				properties: { id: { type: "string" } },
				allOf: [{ $ref: "#/$defs/a" }],
				$defs: {
					a: { $ref: "#/$defs/b" },
					b: { $ref: "#/$defs/a" },
				},
			}),
			why: "a ref cycle must be reported as bounded",
		},
		{
			bounded: true,
			key: "schema_unresolved_fixture",
			schema: JSON.stringify({
				type: "object",
				properties: { id: { type: "string" } },
				allOf: [{ $ref: "#/$defs/missing" }],
			}),
			why: "an unresolved local ref must be reported as bounded",
		},
		{
			bounded: true,
			key: "schema_external_fixture",
			schema: JSON.stringify({
				type: "object",
				properties: { id: { type: "string" } },
				allOf: [{ $ref: "https://example.invalid/schema.json" }],
			}),
			why: "an external ref must be reported as bounded without fetching",
		},
		{
			bounded: true,
			key: "schema_unsupported_fixture",
			schema: JSON.stringify({
				type: "object",
				properties: { id: { type: "string" } },
				anyOf: [{ properties: { conditional: { type: "string" } } }],
			}),
			why: "an unsupported combinator must be reported as bounded",
		},
		{
			bounded: false,
			key: "schema_repeated_ref_fixture",
			schema: chainedRefSchema(2500),
			why: "the same ref twice is visited once, not counted twice",
		},
		{
			bounded: true,
			key: "schema_node_overflow_fixture",
			schema: chainedRefOverflowSchema(5000),
			why: "a ref chain past the node visit bound must stop honestly",
		},
		{
			bounded: true,
			collectBody: `    await emitRecord("items", { id: "same-stream-local-id", label: repeated ? "sibling-second" : "sibling-first" });`,
			key: "schema_ref_sibling_fixture",
			namedField: "/label (1)",
			runs: "2",
			schema: JSON.stringify({
				type: "object",
				properties: {
					id: { type: "string" },
					label: { type: "string" },
				},
				allOf: [{ $ref: "https://example.invalid/schema.json" }],
			}),
			why: "direct siblings stay named even when an external ref is bounded",
		},
	];
	try {
		for (const {
			bounded,
			collectBody = `    await emitRecord("items", { id: "same-stream-local-id" });`,
			key,
			namedField,
			runs = "1",
			schema,
			why,
		} of cases) {
			writeBoundObservationFixture({
				collectBody,
				connectorKey: key,
				schemaJson: schema,
				tmpDir,
			});
			const result = runRecordCli(
				[key, "--runs", runs, "--out", join(tmpDir, `${key}.scenario.json`)],
				{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
			);
			assert.equal(result.code, 0, `${key}: ${result.stderr}`);
			assert.match(result.stdout, /complete: true/, key);
			assert.equal(
				result.stdout.includes("RangeError"),
				false,
				`${key} must not overflow the stack`,
			);
			assert.equal(
				result.stdout.includes("Schema field metadata was bounded"),
				bounded,
				`${key}: ${why}; stdout=${result.stdout}`,
			);
			if (namedField !== undefined) {
				assert.equal(
					result.stdout.includes(namedField),
					true,
					`${key}: ${why}; stdout=${result.stdout}`,
				);
			}
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

/** A schema whose innermost node is `leaf`, `levels` property steps below the
 *  root. 32 (the traversal's depth bound) puts `leaf` at the first depth the
 *  traversal does not enter; 31 keeps it inside the traversal. */
function boundarySchema(levels: number, leaf: unknown): string {
	let schema: unknown = leaf;
	for (let index = 0; index < levels; index += 1) {
		schema = { properties: { [`n${String(index)}`]: schema } };
	}
	return JSON.stringify(schema);
}

test("scenario-record: declared schema unsupported keywords keep the metadata bounded, at the depth bound too", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-unsupported-keywords-"),
	);
	const base = { type: "object", properties: { id: { type: "string" } } };
	const cases: Array<{
		bounded: boolean;
		key: string;
		schema: string;
		why: string;
	}> = [
		{
			bounded: true,
			key: "dependencies_fixture",
			schema: JSON.stringify({
				...base,
				dependencies: { id: { properties: { extra: { type: "string" } } } },
			}),
			why: "a schema dependency can declare fields the collector cannot name",
		},
		{
			bounded: true,
			key: "unevaluated_fixture",
			schema: JSON.stringify({
				...base,
				unevaluatedProperties: { properties: { extra: { type: "string" } } },
			}),
			why: "an object unevaluatedProperties can declare fields",
		},
		{
			bounded: true,
			key: "dynamic_ref_fixture",
			schema: JSON.stringify({ ...base, $dynamicRef: "#meta" }),
			why: "a dynamic ref resolves to targets the collector does not follow",
		},
		{
			bounded: true,
			key: "recursive_ref_fixture",
			schema: JSON.stringify({ ...base, $recursiveRef: "#" }),
			why: "a recursive ref resolves to targets the collector does not follow",
		},
		{
			bounded: false,
			key: "unevaluated_boolean_fixture",
			schema: JSON.stringify({ ...base, unevaluatedProperties: false }),
			why: "a boolean unevaluatedProperties adds no named fields",
		},
		{
			bounded: true,
			key: "boundary_one_of_fixture",
			schema: boundarySchema(32, {
				oneOf: [{ properties: { hidden: { type: "string" } } }],
			}),
			why: "an unsupported keyword at the depth bound must still mark the metadata bounded",
		},
		{
			bounded: true,
			key: "boundary_dependencies_fixture",
			schema: boundarySchema(32, {
				dependencies: { n0: { properties: { hidden: { type: "string" } } } },
			}),
			why: "a schema dependency at the depth bound must still mark the metadata bounded",
		},
		{
			bounded: true,
			key: "boundary_unevaluated_fixture",
			schema: boundarySchema(32, {
				unevaluatedProperties: { properties: { hidden: { type: "string" } } },
			}),
			why: "an object unevaluatedProperties at the depth bound must still mark the metadata bounded",
		},
		{
			bounded: true,
			key: "one_below_boundary_fixture",
			schema: boundarySchema(31, {
				oneOf: [{ properties: { hidden: { type: "string" } } }],
			}),
			why: "the same keyword one level shallower is traversed and marks the metadata bounded",
		},
		{
			bounded: false,
			key: "boundary_plain_leaf_fixture",
			schema: boundarySchema(32, { type: "string" }),
			why: "a plain leaf at the depth bound hides no declared fields",
		},
	];
	const problems: string[] = [];
	try {
		for (const { bounded, key, schema, why } of cases) {
			writeBoundObservationFixture({
				collectBody: `    await emitRecord("items", { id: "same-stream-local-id" });`,
				connectorKey: key,
				schemaJson: schema,
				tmpDir,
			});
			const result = runRecordCli(
				[key, "--out", join(tmpDir, `${key}.scenario.json`)],
				{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
			);
			const isBounded = result.stdout.includes(
				"Schema field metadata was bounded",
			);
			if (
				result.code !== 0 ||
				!result.stdout.includes("complete: true") ||
				isBounded !== bounded
			) {
				problems.push(
					`${key} (bounded expected ${String(bounded)}, got ${String(isBounded)}; exit ${String(result.code)}): ${why}`,
				);
			}
		}
		assert.deepEqual(problems, []);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

const NESTED_BASE_URI_SCHEMA = JSON.stringify({
	type: "object",
	properties: {
		id: { type: "string" },
		safe: { type: "string" },
		a: {
			$id: "urn:nested-a",
			$defs: { d: { properties: { v: { type: "string" } } } },
			properties: { b: { $ref: "#/$defs/d" } },
		},
		legacy: { id: "urn:legacy", properties: { w: { type: "string" } } },
	},
	$defs: { d: { properties: { root: { type: "string" } } } },
});

test("scenario-record: declared schema nested base URI stops names beneath it and keeps safe siblings", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-nested-base-"),
	);
	const connectorKey = "nested_base_uri_fixture";
	writeBoundObservationFixture({
		collectBody: `    await emitRecord("items", {
      id: "same-stream-local-id",
      safe: repeated ? "safe-second" : "safe-first",
      a: { b: { root: repeated ? "root-second" : "root-first", v: repeated ? "v-second" : "v-first" } },
      legacy: { w: repeated ? "w-second" : "w-first" },
    });`,
		connectorKey,
		schemaJson: NESTED_BASE_URI_SCHEMA,
		tmpDir,
	});
	try {
		const result = runRecordCli(
			[
				connectorKey,
				"--runs",
				"2",
				"--out",
				join(tmpDir, "nested.scenario.json"),
			],
			{ PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir },
		);
		assert.equal(result.code, 0, result.stderr);
		assert.match(result.stdout, /complete: true/);
		assert.match(
			result.stdout,
			/items: differences-observed \(1 repeated identities;/,
		);
		assert.equal(
			result.stdout.includes("/safe (1)"),
			true,
			`a sibling outside the nested base must stay named; stdout=${result.stdout}`,
		);
		for (const hidden of ["/a/b/root", "/a/b/v", "/legacy/w"]) {
			assert.equal(
				result.stdout.includes(hidden),
				false,
				`${hidden} sits beneath a nested base URI and must not be named; stdout=${result.stdout}`,
			);
		}
		assert.equal(
			result.stdout.includes("Schema field metadata was bounded"),
			true,
			"a nested base URI must be disclosed as bounded metadata",
		);
		for (const canary of [
			"safe-first",
			"safe-second",
			"root-first",
			"root-second",
			"v-first",
			"v-second",
			"w-first",
			"w-second",
			"same-stream-local-id",
		]) {
			assert.equal(result.stdout.includes(canary), false);
			assert.equal(result.stderr.includes(canary), false);
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

const OTP_FIXTURE_BODY = `    const different = process.env.OTP_FIXTURE_IDENTICAL !== "1";
    const otp = await sendInteraction({
      kind: "otp",
      message: different
        ? repeated ? "OTP_ACCOUNT_B_PROMPT_CANARY" : "OTP_ACCOUNT_A_PROMPT_CANARY"
        : "OTP_SHARED_PROMPT_CANARY",
      request_id: different ? (repeated ? "otp-second" : "otp-first") : "otp",
    });
    if (otp.status !== "success") throw new Error("otp not answered");
    await emitRecord("items", { id: "same-stream-local-id", label: repeated ? "second" : "first" });`;

test("scenario-record: advisory treats any OTP exchange as unknown context and omits cross-run comparisons", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-otp-context-"),
	);
	const connectorKey = "otp_context_fixture";
	writeBoundObservationFixture({
		collectBody: OTP_FIXTURE_BODY,
		connectorKey,
		schemaJson: SIMPLE_SCHEMA,
		tmpDir,
	});
	try {
		const cases = [
			{
				name: "different",
				answers: [
					"otp-first=OTP_CODE_A_CANARY",
					"otp-second=OTP_CODE_B_CANARY",
				],
				env: {},
			},
			{
				name: "identical",
				answers: ["otp=OTP_CODE_A_CANARY"],
				env: { OTP_FIXTURE_IDENTICAL: "1" },
			},
		];
		for (const { name, answers, env } of cases) {
			const transcriptDir = join(tmpDir, `transcript-${name}`);
			const result = runRecordCli(
				[
					connectorKey,
					"--out",
					join(tmpDir, `${name}.scenario.json`),
					...answers.flatMap((answer) => ["--answer", answer]),
				],
				{
					PDPP_CONNECTOR_PATHS_TEST_ROOT: tmpDir,
					PDPP_SCENARIO_TRANSCRIPT_DIR: transcriptDir,
					...env,
				},
			);
			assert.equal(result.code, 0, result.stderr);
			assert.equal(assertTranscriptInteractionsContractValid(transcriptDir), 2);
			assert.match(result.stdout, /user_interactions recorded: 2/);
			assert.match(
				result.stdout,
				/items: insufficient-repeat-observations \(0 repeated identities;/,
				`${name} OTP inputs must stay unknown`,
			);
			assert.match(
				result.stdout,
				/limitation: [^\n]*scope or selection context/,
			);
			for (const canary of [
				"OTP_ACCOUNT_A_PROMPT_CANARY",
				"OTP_ACCOUNT_B_PROMPT_CANARY",
				"OTP_SHARED_PROMPT_CANARY",
				"OTP_CODE_A_CANARY",
				"OTP_CODE_B_CANARY",
				"same-stream-local-id",
			]) {
				assert.equal(result.stdout.includes(canary), false);
				assert.equal(result.stderr.includes(canary), false);
			}
		}
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("selection context is kept up to exactly 65,536 serialized characters and unknown beyond", () => {
	// JSON.stringify(["x"...]) adds 4 characters: [ " " ].
	const atLimit = "a".repeat(MAX_SELECTION_CONTEXT_LENGTH - 4);
	assert.equal(MAX_SELECTION_CONTEXT_LENGTH, 65_536);
	assert.equal(selectionContextKey([atLimit])?.length, 65_536);
	assert.equal(selectionContextKey([`${atLimit}a`]), undefined);
	assert.equal(selectionContextKey([]), "[]");
	// The prompt schema is part of the same serialized-character budget: no
	// hashing or separate allowance can hide an oversized selection context.
	const schemaKey = selectionContextKey([
		{ schema: { description: "a".repeat(60_000) } },
	]);
	assert.notEqual(schemaKey, undefined);
	assert.ok((schemaKey ?? "").length <= MAX_SELECTION_CONTEXT_LENGTH);
	assert.equal(
		selectionContextKey([
			{ schema: { description: "a".repeat(MAX_SELECTION_CONTEXT_LENGTH) } },
		]),
		undefined,
	);
});

function writeMultiByteConnector(directory: string): string {
	const entrypoint = join(directory, "connector.mjs");
	writeFileSync(
		entrypoint,
		`
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
await once(process.stdin, "data");
const emit = (message) => new Promise((resolve, reject) => {
  process.stdout.write(JSON.stringify(message) + "\\n", (error) => error ? reject(error) : resolve());
});
await emit({ type: "RECORD", stream: "items", key: "utf8", emitted_at: "2026-08-01T00:00:00.000Z", data: { id: "utf8", value: "fixture" } });
const bytes = Buffer.from(JSON.stringify({
  type: "STATE", stream: "items", cursor: { value: "€".repeat(100_001) }
}) + "\\n");
// The 64 KiB split lands inside a three-byte character. Waiting after the
// first write makes the split deterministic even when pipe reads coalesce.
const split = 65_536;
await new Promise((resolve, reject) => {
  process.stdout.write(bytes.subarray(0, split), (error) => error ? reject(error) : resolve());
});
await delay(40);
await new Promise((resolve, reject) => {
  process.stdout.write(bytes.subarray(split), (error) => error ? reject(error) : resolve());
});
await emit({ type: "DONE", status: "succeeded", records_emitted: 1 });
process.stdin.resume();
`,
	);
	return entrypoint;
}

test("scenario-record: preserves multi-byte STATE cursors across pipe chunks", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-record-utf8-"),
	);
	const scenarioPath = join(tmpDir, "utf8.scenario.json");
	try {
		const entrypoint = writeMultiByteConnector(tmpDir);
		const result = runRecordCli(
			[
				"scenario-utf8-fixture",
				"--entrypoint",
				entrypoint,
				"--runs",
				"1",
				"--out",
				scenarioPath,
			],
			{},
		);
		assert.equal(result.code, 0, result.stderr);
		const scenario = JSON.parse(
			readFileSync(scenarioPath, "utf8"),
		) as ConnectorScenario;
		assert.equal(scenario.capture.complete, true);
		const finalState = scenario.runs[0]?.expected.final_state as
			| { items?: { value?: string } }
			| undefined;
		assert.equal(
			finalState?.items?.value === "€".repeat(100_001),
			true,
			"recorded cursor must retain every multi-byte character exactly",
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("scenario-verify: preserves multi-byte STATE cursors across pipe chunks", () => {
	const tmpDir = mkdtempSync(
		join(packageScratchDir(), "scenario-verify-utf8-"),
	);
	const scenarioPath = join(tmpDir, "utf8.scenario.json");
	try {
		const entrypoint = writeMultiByteConnector(tmpDir);
		// Construct the oracle independently: a broken recorder must not hide
		// identical corruption in the verifier by supplying a corrupted cursor.
		const scenario: ConnectorScenario = {
			format: "pdpp.connector-scenario/1",
			connector: { id: "scenario-utf8-fixture" },
			capture: {
				captured_at: "2026-08-01T00:00:00.000Z",
				evidence_class: "synthetic-spike",
				privacy_class: "local-only",
				recorder_version: "test",
				complete: true,
			},
			runs: [
				{
					start: { scope: { streams: [{ name: "items" }] }, state: null },
					interactions: [],
					expected: {
						records: {
							items: {
								count: 1,
								ids: ["utf8"],
								ops: ["upsert"],
								record_sha256s: [
									hashCanonicalJson({ id: "utf8", value: "fixture" }),
								],
							},
						},
						final_state: { items: { value: "€".repeat(100_001) } },
					},
				},
			],
		};
		writeFileSync(scenarioPath, JSON.stringify(scenario));
		const result = runVerifyCli([
			"scenario-utf8-fixture",
			"--entrypoint",
			entrypoint,
			scenarioPath,
		]);
		assert.equal(
			result.code,
			0,
			`stdout=${result.stdout.slice(0, 2000)} stderr=${result.stderr}`,
		);
		assert.match(result.stdout, /run 0: PASS/);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

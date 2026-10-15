// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { SCENARIO_FORMAT } from "../src/scenario/format.ts";
import { ScenarioValidationError, validateScenario } from "../src/scenario/validate.ts";

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..");
const FIXTURE_DIR = join(PACKAGE_ROOT, "test-fixtures/scenario-consumer");
const BOOTSTRAP = "c0c6f1e4faa7015cf6447230b0c17a5f9769b09b";
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const FRESH_CLAIM_PATH_RE = /fresh claim path/;
const CAPTURE_NAMES = [
  "scenario-http.json",
  "scenario-browser.json",
  "scenario-browser.run1.har",
  "scenario-browser.run2.har",
  "scenario-browser.run1.storage-state.json",
  "scenario-browser.run2.storage-state.json",
];
const SOURCE_NAMES = ["data.ts", "site.ts", "http-connector.ts", "browser-connector.ts"];
const ALL_PINNED_NAMES = [...CAPTURE_NAMES, ...SOURCE_NAMES];
const expectedDigest = (value) => createHash("sha256").update(value).digest("hex");
const ownedTempRoots = [];
after(() => {
  for (const dir of ownedTempRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function omitCaptureTimestamp(scenario) {
  scenario.capture = Object.fromEntries(Object.entries(scenario.capture).filter(([key]) => key !== "captured_at"));
  return scenario;
}

function gitText(args) {
  return execFileSync("git", args, { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitBytes(revision, path) {
  return execFileSync("git", ["show", `${revision}:${path}`], { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
}

function hasTreePath(revision, path) {
  try {
    gitText(["cat-file", "-e", `${revision}:${path}`]);
    return true;
  } catch {
    return false;
  }
}

function loadBaseline() {
  const base = process.env.SCENARIO_COMPAT_BASE_SHA;
  assert.match(base ?? "", COMMIT_SHA_RE, "base commit must be supplied by the admission step");
  assert.equal(gitText(["cat-file", "-t", base]), "commit", "base ref must resolve to a commit");
  const basePresence = ALL_PINNED_NAMES.map((name) =>
    hasTreePath(base, `packages/polyfill-connectors/test-fixtures/scenario-consumer/${name}`)
  );
  const baselineCommit = basePresence.every(Boolean) ? base : BOOTSTRAP;
  assert.ok(
    basePresence.every(Boolean) || basePresence.every((present) => !present),
    "base has a partial capture corpus; refusing to skip or mix old files"
  );
  for (const name of ALL_PINNED_NAMES) {
    assert.ok(
      hasTreePath(baselineCommit, `packages/polyfill-connectors/test-fixtures/scenario-consumer/${name}`),
      `baseline is missing ${name}`
    );
  }
  const expectedPath =
    "packages/polyfill-connectors/test-fixtures/scenario-consumer/scenario-compatibility-baseline.json";
  const baseHasExpected = hasTreePath(base, expectedPath);
  const expectedBytes = readFileSync(join(FIXTURE_DIR, "scenario-compatibility-baseline.json"));
  const baselineExpectedBytes = baseHasExpected ? gitBytes(base, expectedPath) : expectedBytes;
  return {
    baselineCommit,
    expected: JSON.parse(expectedBytes.toString("utf8")),
    baselineExpected: JSON.parse(baselineExpectedBytes.toString("utf8")),
    baseHasExpected,
  };
}

function verifyPinnedBytes({ baselineCommit, expected, baselineExpected, baseHasExpected }) {
  assert.equal(expected.bootstrap_commit, BOOTSTRAP, "baseline must identify the reviewed capture bootstrap");
  for (const [category, names] of [
    ["captures", CAPTURE_NAMES],
    ["capture_sources", SOURCE_NAMES],
  ]) {
    for (const name of names) {
      const rel = `packages/polyfill-connectors/test-fixtures/scenario-consumer/${name}`;
      const baseline = gitBytes(baselineCommit, rel);
      const current = readFileSync(join(FIXTURE_DIR, name));
      assert.equal(
        expectedDigest(current),
        expectedDigest(baseline),
        `${name} differs from frozen baseline ${baselineCommit}`
      );
      assert.equal(
        expectedDigest(current),
        expected[category][name],
        `${name} digest differs from reviewed capture metadata`
      );
    }
  }
  if (baseHasExpected) {
    const withoutDisposition = ({ format_disposition: _disposition, format_migration: _migration, ...rest }) => rest;
    assert.deepEqual(
      withoutDisposition(expected),
      withoutDisposition(baselineExpected),
      "frozen corpus or expected outcomes changed from base"
    );
    if (expected.format_disposition !== baselineExpected.format_disposition) {
      assert.equal(
        expected.format_disposition,
        "dropped",
        "format-policy change must declare explicit support or drop"
      );
      assert.ok(
        typeof expected.format_migration === "string" && expected.format_migration.trim().length > 0,
        "format drop requires a migration statement"
      );
    }
  }
}

function isolatedEnv(tempRoot) {
  const allowed = ["PATH", "HOME", "SystemRoot", "WINDIR"];
  const env = Object.fromEntries(
    allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])
  );
  env.TMPDIR = tempRoot;
  env.PDPP_BROWSER_HEADLESS = "1";
  env.PDPP_SCENARIO_CONSUMER_BASE_URL = "http://127.0.0.1:41731";
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  return env;
}

function command(args, tempRoot) {
  return spawnSync(process.execPath, ["--import", "tsx", "bin/scenario-verify.ts", ...args], {
    cwd: PACKAGE_ROOT,
    env: isolatedEnv(tempRoot),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function newCaseRoot(root, label) {
  const dir = mkdtempSync(join(root, `${label}-`));
  for (const name of CAPTURE_NAMES.filter((n) => n.endsWith(".har") || n.endsWith("storage-state.json"))) {
    copyFileSync(join(FIXTURE_DIR, name), join(dir, name));
  }
  return dir;
}

function invokeVerify({ root, label, scenarioName, entrypointName, scenarioPath, claimPath }) {
  const caseRoot = newCaseRoot(root, label);
  const inputPath = scenarioPath ?? join(caseRoot, scenarioName);
  if (!scenarioPath) {
    copyFileSync(join(FIXTURE_DIR, scenarioName), inputPath);
  }
  const outputPath = claimPath ?? join(caseRoot, "fresh-claim.json");
  assert.equal(requirePathExists(outputPath), false, `${label} must begin with a fresh claim path`);
  const result = command(
    ["scenario-consumer", inputPath, "--entrypoint", join(FIXTURE_DIR, entrypointName), "--json", outputPath],
    process.env.SCENARIO_COMPAT_TMPDIR
  );
  return { result, caseRoot, outputPath, inputPath };
}

function requirePathExists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertClaim(path, scenario, expectation) {
  assert.ok(requirePathExists(path), "successful replay must create a fresh claim file");
  const claim = readJson(path);
  assert.equal(claim.schema, "pdpp.connector-claim/1");
  assert.equal(claim.connector, "scenario-consumer");
  assert.equal(claim.claim, expectation.claim);
  assert.equal(claim.runs, expectation.runs);
  assert.deepEqual(claim.drivers, [expectation.driver]);
  assert.deepEqual(claim.coverage, expectation.coverage);
  assert.equal(claim.scenario_status, expectation.scenario_status);
  assert.deepEqual(claim.captured_with, expectation.captured_with);
  assert.deepEqual(claim.verified_subject, expectation.verified_subject);
  assert.ok(Number.isFinite(Date.parse(claim.verified_at)), "claim must contain verified_at");
  assert.equal(claim.captured_at, scenario.capture.captured_at);
  assert.equal(Object.hasOwn(claim, "entrypoint_digest"), expectation.entrypoint_digest === "present");
  return claim;
}

function assertRejected(result, label) {
  assert.equal(result.error, undefined, `${label}: verifier process must start`);
  assert.equal(result.status, 1, `${label}: expected scenario rejection`);
}

function assertOfflineIsolation(result, label) {
  assert.ok(
    result.stdout.includes("network isolation: os-namespace"),
    `${label} must use the verifier's OS network namespace isolation`
  );
}

test("frozen scenario compatibility, replay outcomes, and privacy controls", () => {
  const baseline = loadBaseline();
  const { baselineCommit, expected } = baseline;
  verifyPinnedBytes(baseline);

  const taskRoot = process.env.SCENARIO_COMPAT_TMPDIR;
  assert.ok(taskRoot, "set SCENARIO_COMPAT_TMPDIR to an owned temporary directory");
  assert.ok(
    Buffer.byteLength(join(taskRoot, "pdpp-scenario-evidence-XXXXXX", "replay-bridge.sock")) < 108,
    "owned TMPDIR must leave room for the replay UDS path"
  );
  assert.equal(
    existsSync(join(REPO_ROOT, ".env.local")),
    false,
    "refusing replay when repository dotenv credentials may be present"
  );
  mkdirSync(taskRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(taskRoot, "scenario-compat-"));
  ownedTempRoots.push(root);
  const scanner = join(FIXTURE_DIR, "check-capture-privacy.py");
  execFileSync("python3", [scanner, "--self-test"], { cwd: PACKAGE_ROOT, stdio: "ignore" });
  execFileSync("python3", [scanner, ...CAPTURE_NAMES.map((name) => join(FIXTURE_DIR, name))], {
    cwd: PACKAGE_ROOT,
    stdio: "ignore",
  });

  const httpBytes = readFileSync(join(FIXTURE_DIR, "scenario-http.json"));
  const browserBytes = readFileSync(join(FIXTURE_DIR, "scenario-browser.json"));
  const httpScenario = JSON.parse(httpBytes.toString("utf8"));
  const browserScenario = JSON.parse(browserBytes.toString("utf8"));
  assert.equal(httpScenario.format, expected.format);
  assert.equal(browserScenario.format, expected.format);
  const oldInputs = [httpScenario, browserScenario];
  if (expected.format_disposition === "dropped") {
    assert.notEqual(SCENARIO_FORMAT, expected.format, "old-format drop requires a deliberate format version bump");
    assert.ok(
      typeof expected.format_migration === "string" && expected.format_migration.trim().length > 0,
      "old-format drop needs a migration statement"
    );
    for (const old of oldInputs) {
      assert.throws(
        () => validateScenario(old),
        (error) => error instanceof ScenarioValidationError && error.reason === "unsupported_format"
      );
    }
    const dropped = command(
      [
        "scenario-consumer",
        join(FIXTURE_DIR, "scenario-http.json"),
        "--entrypoint",
        join(FIXTURE_DIR, "http-connector.ts"),
      ],
      taskRoot
    );
    assertRejected(dropped, "explicit old-format drop");
    process.stdout.write(
      `scenario compatibility: baseline=${baselineCommit === BOOTSTRAP ? "bootstrap" : "base"}; old-format=explicitly-dropped; controls=pass\n`
    );
    return;
  }
  assert.equal(
    expected.format_disposition,
    "supported",
    "the frozen format must remain explicitly supported unless a reviewed bump drops it"
  );

  validateScenario(httpScenario);
  validateScenario(browserScenario);
  const withRootMetadata = structuredClone(httpScenario);
  withRootMetadata.compatibility_note = { revision: "informational" };
  assert.doesNotThrow(() => validateScenario(withRootMetadata), "informational root metadata remains accepted");
  const strictOverlay = (scenario) => {
    validateScenario(scenario);
    if (!Object.hasOwn(scenario, "compatibility_probe")) {
      throw new Error("strict same-version field required");
    }
  };
  const compatibilityAccepts = (validator) =>
    oldInputs.every((scenario) => {
      try {
        validator(scenario);
        return true;
      } catch {
        return false;
      }
    });
  assert.equal(compatibilityAccepts(validateScenario), true);
  assert.equal(
    compatibilityAccepts(strictOverlay),
    false,
    "strict same-version field overlay must turn historical compatibility RED"
  );
  const legacy = structuredClone(httpScenario);
  omitCaptureTimestamp(legacy);
  assert.doesNotThrow(() => validateScenario(legacy), "legacy scenario without capture.captured_at remains accepted");

  const http = invokeVerify({
    root,
    label: "http",
    scenarioName: "scenario-http.json",
    entrypointName: "http-connector.ts",
  });
  assert.equal(http.result.error, undefined, "HTTP verifier process must start");
  assert.equal(http.result.status, 0, "frozen HTTP replay must pass");
  assertOfflineIsolation(http.result, "HTTP replay");
  assertClaim(http.outputPath, httpScenario, expected.claims["scenario-http.json"]);

  const browser = invokeVerify({
    root,
    label: "browser",
    scenarioName: "scenario-browser.json",
    entrypointName: "browser-connector.ts",
  });
  assert.equal(browser.result.error, undefined, "browser verifier process must start");
  assert.equal(browser.result.status, 0, "frozen HAR replay must pass");
  assertOfflineIsolation(browser.result, "HAR replay");
  assertClaim(browser.outputPath, browserScenario, expected.claims["scenario-browser.json"]);

  const legacyCase = newCaseRoot(root, "legacy");
  omitCaptureTimestamp(legacy);
  const legacyPath = join(legacyCase, "scenario-http-legacy.json");
  writeFileSync(legacyPath, JSON.stringify(legacy));
  const legacyClaimPath = join(legacyCase, "fresh-claim.json");
  const legacyResult = command(
    [
      "scenario-consumer",
      legacyPath,
      "--entrypoint",
      join(FIXTURE_DIR, "http-connector.ts"),
      "--json",
      legacyClaimPath,
    ],
    taskRoot
  );
  assert.equal(legacyResult.status, 0, "legacy HTTP replay must pass");
  const legacyClaim = readJson(legacyClaimPath);
  assert.equal(
    Object.hasOwn(legacyClaim, "captured_at"),
    false,
    "missing legacy capture time must stay omitted from claim"
  );
  assert.ok(Number.isFinite(Date.parse(legacyClaim.verified_at)));

  const badOp = structuredClone(httpScenario);
  const [stream] = Object.keys(badOp.runs[0].expected.records);
  badOp.runs[0].expected.records[stream].ops[0] = "invalid-operation";
  assert.throws(() => validateScenario(badOp), ScenarioValidationError, "corrupt meaningful operation must reject");

  for (const [label, mutate] of [
    [
      "record-hash",
      (scenario) => {
        const [key] = Object.keys(scenario.runs[0].expected.records);
        scenario.runs[0].expected.records[key].record_sha256s[0] = "0".repeat(64);
      },
    ],
    [
      "final-state",
      (scenario) => {
        scenario.runs[0].expected.final_state = { corrupted: true };
      },
    ],
    [
      "protocol-trace",
      (scenario) => {
        const trace = scenario.runs[0].expected.protocol_trace;
        assert.ok(Array.isArray(trace) && trace.length > 0, "frozen capture must retain its protocol trace");
        const key = Object.keys(trace[0]).find((field) => typeof trace[0][field] === "string");
        assert.ok(key, "trace mutation target exists");
        trace[0][key] = "corrupted-trace-value";
      },
    ],
  ]) {
    const corrupted = structuredClone(httpScenario);
    mutate(corrupted);
    const caseRoot = newCaseRoot(root, label);
    const scenarioPath = join(caseRoot, "scenario-http.json");
    writeFileSync(scenarioPath, JSON.stringify(corrupted));
    const replay = invokeVerify({
      root,
      label: `${label}-replay`,
      scenarioName: "scenario-http.json",
      entrypointName: "http-connector.ts",
      scenarioPath,
    });
    assertRejected(replay.result, label);
  }

  const badHarRoot = newCaseRoot(root, "bad-har");
  const harPath = join(badHarRoot, "scenario-browser.run1.har");
  writeFileSync(harPath, "{");
  const badHarScenario = join(badHarRoot, "scenario-browser.json");
  copyFileSync(join(FIXTURE_DIR, "scenario-browser.json"), badHarScenario);
  const badHar = invokeVerify({
    root,
    label: "bad-har-replay",
    scenarioName: "scenario-browser.json",
    entrypointName: "browser-connector.ts",
    scenarioPath: badHarScenario,
  });
  assertRejected(badHar.result, "malformed HAR");

  const badStorageRoot = newCaseRoot(root, "bad-storage");
  writeFileSync(join(badStorageRoot, "scenario-browser.run1.storage-state.json"), "{");
  const badStorageScenario = join(badStorageRoot, "scenario-browser.json");
  copyFileSync(join(FIXTURE_DIR, "scenario-browser.json"), badStorageScenario);
  const badStorage = invokeVerify({
    root,
    label: "bad-storage-replay",
    scenarioName: "scenario-browser.json",
    entrypointName: "browser-connector.ts",
    scenarioPath: badStorageScenario,
  });
  assertRejected(badStorage.result, "malformed browser storage state");

  const usage = command(
    [
      "scenario-consumer",
      join(FIXTURE_DIR, "scenario-http.json"),
      "--entrypoint",
      join(FIXTURE_DIR, "http-connector.ts"),
      "--timeout",
      "0",
    ],
    taskRoot
  );
  assert.equal(usage.status, 2, "invalid CLI usage retains exit 2");

  const formatBad = structuredClone(httpScenario);
  formatBad.format = "pdpp.connector-scenario/999";
  const formatCase = newCaseRoot(root, "bad-format");
  const formatPath = join(formatCase, "bad-format.json");
  writeFileSync(formatPath, JSON.stringify(formatBad));
  const badFormat = command(
    ["scenario-consumer", formatPath, "--entrypoint", join(FIXTURE_DIR, "http-connector.ts")],
    taskRoot
  );
  assertRejected(badFormat, "unsupported format");

  const stalePath = join(root, "stale-claim.json");
  writeFileSync(stalePath, "stale");
  assert.throws(
    () =>
      invokeVerify({
        root,
        label: "stale",
        scenarioName: "scenario-http.json",
        entrypointName: "http-connector.ts",
        claimPath: stalePath,
      }),
    FRESH_CLAIM_PATH_RE
  );
  const writeFailureRoot = newCaseRoot(root, "claim-write-failure");
  const outputDirectory = join(writeFailureRoot, "claim-output");
  mkdirSync(outputDirectory);
  const writeFailureScenario = join(writeFailureRoot, "scenario-http.json");
  copyFileSync(join(FIXTURE_DIR, "scenario-http.json"), writeFailureScenario);
  const writeFailure = command(
    [
      "scenario-consumer",
      writeFailureScenario,
      "--entrypoint",
      join(FIXTURE_DIR, "http-connector.ts"),
      "--json",
      outputDirectory,
    ],
    taskRoot
  );
  assert.equal(writeFailure.status, 0, "CLI replay verdict remains independent of best-effort claim write");
  assert.ok(statSync(outputDirectory).isDirectory());
  assert.equal(
    requirePathExists(join(outputDirectory, "claim.json")),
    false,
    "exit 0 without a new parseable claim is not consumed as success"
  );

  const finalHashes = CAPTURE_NAMES.map((name) => expectedDigest(readFileSync(join(FIXTURE_DIR, name))));
  assert.deepEqual(
    finalHashes,
    CAPTURE_NAMES.map((name) => expected.captures[name]),
    "frozen capture bytes changed during compatibility checks"
  );
  process.stdout.write(
    `scenario compatibility: baseline=${baselineCommit === BOOTSTRAP ? "bootstrap" : "base"}; captures=${CAPTURE_NAMES.length}; replay=2 pass; controls=pass\n`
  );
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changedPaths, relevantPath } from "./scenario-compatibility-admission.mjs";
import { compatibilityGate } from "./scenario-compatibility-gate.mjs";

const dirs = [];
const ADMISSION_SCRIPT = join(import.meta.dirname, "scenario-compatibility-admission.mjs");
const GATE_SCRIPT = join(import.meta.dirname, "scenario-compatibility-gate.mjs");
const RUNNER_PATTERNS_RE = /const patterns = \[([\s\S]*?)\n\];/;
const RUNNER_PATTERN_RE = /"([^"]+)"/g;
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "scenario-admission-"));
  dirs.push(dir);
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q");
  run("config", "user.email", "scenario-check@example.invalid");
  run("config", "user.name", "Scenario check");
  return {
    dir,
    write(path, value) {
      const fullPath = join(dir, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, value);
    },
    commit() {
      run("add", "-A");
      run("commit", "-qm", "fixture");
      return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    },
    remove(path) {
      rmSync(join(dir, path), { force: true });
    },
    rename(from, to) {
      const destination = join(dir, to);
      mkdirSync(join(destination, ".."), { recursive: true });
      renameSync(join(dir, from), destination);
    },
  };
}

function invokeAdmission(r, { eventName = "push", baseSha, headSha }) {
  const result = spawnSync(process.execPath, [ADMISSION_SCRIPT], {
    cwd: r.dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_EVENT_NAME: eventName,
      BASE_SHA: baseSha ?? "",
      BEFORE_SHA: baseSha ?? "",
      HEAD_SHA: headSha,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function invokeGate({ changesResult, relevant, compatibilityResult }) {
  return spawnSync(process.execPath, [GATE_SCRIPT], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CHANGES_RESULT: changesResult,
      RELEVANT: relevant,
      COMPATIBILITY_RESULT: compatibilityResult,
    },
    encoding: "utf8",
  });
}

test("admission includes scenario changes and both sides of renames/deletions", () => {
  const r = repo();
  r.write("packages/polyfill-connectors/src/scenario/validate.ts", "a");
  r.write("packages/polyfill-connectors/src/scenario/format.ts", "a");
  r.write("unrelated.txt", "a");
  const before = r.commit();
  r.rename("packages/polyfill-connectors/src/scenario/validate.ts", "packages/polyfill-connectors/src/other.ts");
  r.remove("packages/polyfill-connectors/src/scenario/format.ts");
  r.remove("unrelated.txt");
  const afterSha = r.commit();
  const paths = changedPaths({ eventName: "push", baseSha: before, headSha: afterSha, cwd: r.dir });
  assert.ok(paths.includes("packages/polyfill-connectors/src/scenario/validate.ts"));
  assert.ok(paths.includes("packages/polyfill-connectors/src/other.ts"));
  assert.ok(paths.includes("packages/polyfill-connectors/src/scenario/format.ts"));
  assert.ok(paths.includes("unrelated.txt"));
});

test("main compatibility check edit and deletion remain admitted through the CLI and required gate", () => {
  const r = repo();
  const mainCheck = "packages/polyfill-connectors/scripts/scenario-compatibility.check.mjs";
  r.write(mainCheck, "base");
  const before = r.commit();
  r.write(mainCheck, "changed");
  const edited = r.commit();
  const editAdmission = invokeAdmission(r, { baseSha: before, headSha: edited });
  assert.equal(editAdmission.relevant, true);
  assert.equal(
    invokeGate({ changesResult: "success", relevant: String(editAdmission.relevant), compatibilityResult: "skipped" })
      .status,
    1
  );
  r.remove(mainCheck);
  const deleted = r.commit();
  const deleteAdmission = invokeAdmission(r, { baseSha: edited, headSha: deleted });
  assert.equal(deleteAdmission.relevant, true);
  assert.equal(
    invokeGate({ changesResult: "success", relevant: String(deleteAdmission.relevant), compatibilityResult: "skipped" })
      .status,
    1
  );
});

test("shared runtime, browser, path, and CLI helper edits are admitted through the CLI and gate", () => {
  const r = repo();
  const helpers = [
    "packages/polyfill-connectors/src/connector-runtime.ts",
    "packages/polyfill-connectors/src/browser-launch.ts",
    "packages/polyfill-connectors/src/connector-paths.ts",
    "packages/polyfill-connectors/bin/scenario-cli-json.ts",
  ];
  for (const helper of helpers) {
    r.write(helper, "base");
  }
  let before = r.commit();
  for (const [index, helper] of helpers.entries()) {
    r.write(helper, `changed-${index}`);
    const head = r.commit();
    const admission = invokeAdmission(r, { baseSha: before, headSha: head });
    assert.equal(admission.relevant, true, `${helper} is admitted`);
    assert.equal(
      invokeGate({ changesResult: "success", relevant: String(admission.relevant), compatibilityResult: "skipped" })
        .status,
      1
    );
    before = head;
  }
});

test("connector exit and orchestrator edits or deletions require the focused check", () => {
  const r = repo();
  const sharedFiles = [
    "packages/polyfill-connectors/src/connector-exit.ts",
    "packages/polyfill-connectors/src/orchestrator.ts",
  ];
  for (const path of sharedFiles) {
    r.write(path, "base");
  }
  const before = r.commit();

  r.write(sharedFiles[0], "edited connector exit");
  const edited = r.commit();
  const editAdmission = invokeAdmission(r, { baseSha: before, headSha: edited });
  assert.equal(editAdmission.relevant, true, "connector-exit-only edit must be admitted");
  assert.equal(
    invokeGate({ changesResult: "success", relevant: String(editAdmission.relevant), compatibilityResult: "skipped" })
      .status,
    1,
    "a skipped focused check must fail after a connector-exit-only edit"
  );

  r.remove(sharedFiles[0]);
  const deleted = r.commit();
  const deleteAdmission = invokeAdmission(r, { baseSha: edited, headSha: deleted });
  assert.equal(deleteAdmission.relevant, true, "connector-exit-only deletion must be admitted");
  assert.equal(
    invokeGate({ changesResult: "success", relevant: String(deleteAdmission.relevant), compatibilityResult: "skipped" })
      .status,
    1,
    "a skipped focused check must fail after a connector-exit-only deletion"
  );

  r.write(sharedFiles[1], "edited orchestrator");
  const helperEdited = r.commit();
  const helperAdmission = invokeAdmission(r, { baseSha: deleted, headSha: helperEdited });
  assert.equal(helperAdmission.relevant, true, "another shared src helper must be admitted");
  assert.equal(
    invokeGate({ changesResult: "success", relevant: String(helperAdmission.relevant), compatibilityResult: "skipped" })
      .status,
    1,
    "a skipped focused check must fail after another shared src helper edit"
  );
});

test("NUL-delimited admission handles renamed and deleted unusual scenario paths", () => {
  const r = repo();
  const unusual = "packages/polyfill-connectors/src/scenario/line\nbreak\tname.ts";
  const deleted = "packages/polyfill-connectors/src/scenario/delete\nme\tname.ts";
  r.write(unusual, "base");
  r.write(deleted, "delete");
  const before = r.commit();
  const moved = "packages/polyfill-connectors/src/other/line\nbreak\tname.ts";
  r.rename(unusual, moved);
  r.remove(deleted);
  const head = r.commit();
  const paths = changedPaths({ eventName: "push", baseSha: before, headSha: head, cwd: r.dir });
  assert.ok(paths.includes(unusual));
  assert.ok(paths.includes(moved));
  assert.ok(paths.includes(deleted));
  assert.equal(invokeAdmission(r, { baseSha: before, headSha: head }).relevant, true);
  assert.equal(invokeGate({ changesResult: "success", relevant: "true", compatibilityResult: "skipped" }).status, 1);
});

test("admission ignores unrelated edits but admits fixture and lockfile edits", () => {
  const r = repo();
  r.write("README.md", "base");
  const before = r.commit();
  r.write("README.md", "next");
  const unrelated = r.commit();
  assert.deepEqual(changedPaths({ eventName: "push", baseSha: before, headSha: unrelated, cwd: r.dir }), ["README.md"]);
  assert.equal(relevantPath("packages/polyfill-connectors/test-fixtures/scenario-consumer/scenario-http.json"), true);
  assert.equal(relevantPath("README.md"), false);
  r.write("packages/polyfill-connectors/package-lock.json", "lock");
  const relevant = r.commit();
  assert.deepEqual(changedPaths({ eventName: "push", baseSha: unrelated, headSha: relevant, cwd: r.dir }), [
    "packages/polyfill-connectors/package-lock.json",
  ]);
});

test("pull request comparison uses merge base and invalid refs fail closed", () => {
  const r = repo();
  r.write("README.md", "base");
  const base = r.commit();
  r.write("packages/polyfill-connectors/bin/scenario-verify.ts", "verify");
  const head = r.commit();
  assert.deepEqual(changedPaths({ eventName: "pull_request", baseSha: base, headSha: head, cwd: r.dir }), [
    "packages/polyfill-connectors/bin/scenario-verify.ts",
  ]);
  assert.throws(() => changedPaths({ eventName: "push", baseSha: "bad", headSha: head, cwd: r.dir }), {
    message: "invalid base commit",
  });
  assert.throws(() => changedPaths({ eventName: "push", baseSha: base, headSha: "bad", cwd: r.dir }), {
    message: "invalid head commit",
  });
});

test("new branch push conservatively admits the full focused check", () => {
  const r = repo();
  r.write("README.md", "first");
  const head = r.commit();
  assert.equal(changedPaths({ eventName: "push", baseSha: "0".repeat(40), headSha: head, cwd: r.dir }), null);
});

test("required gate rejects a skipped relevant check and failed admission", () => {
  assert.equal(
    compatibilityGate({ changesResult: "success", relevant: "true", compatibilityResult: "skipped" }),
    false
  );
  assert.equal(
    compatibilityGate({ changesResult: "failure", relevant: "false", compatibilityResult: "skipped" }),
    false
  );
  assert.equal(
    compatibilityGate({ changesResult: "success", relevant: "false", compatibilityResult: "skipped" }),
    true
  );
  assert.equal(compatibilityGate({ changesResult: "success", relevant: "true", compatibilityResult: "success" }), true);
  assert.equal(compatibilityGate({ changesResult: "success", relevant: "", compatibilityResult: "skipped" }), false);
});

test("ordinary package test discovery excludes the explicitly invoked compatibility checks", async () => {
  const runner = readFileSync(join(import.meta.dirname, "run-tests.mjs"), "utf8");
  const patternBlock = runner.match(RUNNER_PATTERNS_RE);
  assert.ok(patternBlock, "read the default test patterns from scripts/run-tests.mjs");
  const patterns = [...patternBlock[1].matchAll(RUNNER_PATTERN_RE)].map((match) => match[1]);
  const groups = await Promise.all(patterns.map((pattern) => Array.fromAsync(glob(pattern))));
  const discovered = new Set(groups.flat());
  assert.equal(discovered.has("scripts/scenario-compatibility-admission.check.mjs"), false);
  assert.equal(discovered.has("scripts/scenario-compatibility.check.mjs"), false);
});

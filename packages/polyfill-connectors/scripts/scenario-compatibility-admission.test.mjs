// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { changedPaths, relevantPath } from "./scenario-compatibility-admission.mjs";
import { compatibilityGate } from "./scenario-compatibility-gate.mjs";

const dirs = [];
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
      execFileSync("git", ["mv", from, to], { cwd: dir, stdio: "ignore" });
    },
  };
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

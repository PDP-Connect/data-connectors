// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const pages = parse(readFileSync(new URL("../../../.github/workflows/pages.yml", import.meta.url), "utf8"));
const release = parse(readFileSync(new URL("../../../.github/workflows/publish-polyfill-connectors.yml", import.meta.url), "utf8"));

test("release completion and site updates share the release queue and assemble the full current site", () => {
  assert.equal(release.name, "Publish Polyfill Connectors");
  assert.deepEqual(pages.on.workflow_run.workflows, [release.name]);
  assert.deepEqual(pages.on.workflow_run.types, ["completed"]);
  assert.deepEqual(pages.on.workflow_run.branches, ["main"]);
  assert.equal(pages.concurrency.group, release.concurrency.group);
  for (const workflow of [pages, release]) {
    assert.equal(workflow.concurrency["cancel-in-progress"], false);
    assert.equal(workflow.concurrency.queue, "max");
  }
  assert.match(pages.jobs["publication-gate"].if, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(pages.jobs["publication-gate"].if, /workflow_run\.head_branch == 'main'/);
  assert.equal(pages.jobs.build.needs, "publication-gate");
  assert.match(pages.jobs.build.if, /needs\.publication-gate\.outputs\.deploy == 'true'/);
  assert.match(pages.jobs["publication-gate"].steps.find((step) => step.id === "gate").run, /attempts\/\$\{RELEASE_RUN_ATTEMPT\}\/jobs/);
  const steps = pages.jobs.build.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "main");
  assert.match(steps.find((step) => step.id === "feed").run, /materialize-catalog\.sh registry-site\/catalog\/updates\.atom/);
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/upload-pages-artifact@")).with.path, "registry-site");
});

test("the event gate accepts the trusted workflow path forms and rejects other sources", () => {
  const expression = pages.jobs["publication-gate"].if.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  const evaluate = Function("github", `return (${expression});`);
  const github = {
    repository: "PDP-Connect/data-connectors", ref: "refs/heads/main", event_name: "workflow_run",
    event: { workflow_run: { path: "", head_repository: { full_name: "PDP-Connect/data-connectors" }, head_branch: "main" } },
  };
  const run = github.event.workflow_run;
  for (const suffix of ["", "@main", "@refs/heads/main"]) {
    run.path = `.github/workflows/publish-polyfill-connectors.yml${suffix}`;
    assert.equal(evaluate(github), true, suffix);
  }
  for (const suffix of ["@evil", ".other", "@refs/heads/feature"]) {
    run.path = `.github/workflows/publish-polyfill-connectors.yml${suffix}`;
    assert.equal(evaluate(github), false, suffix);
  }
  run.path = ".github/workflows/publish-polyfill-connectors.yml";
  run.head_repository.full_name = "someone/else";
  assert.equal(evaluate(github), false);
  run.head_repository.full_name = github.repository;
  run.head_branch = "feature";
  assert.equal(evaluate(github), false);
  assert.equal(evaluate({ ...github, event_name: "push", event: {} }), true);
});

test("the workflow gate fails rather than silently skipping when job evidence is invalid", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pages-publication-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  const script = pages.jobs["publication-gate"].steps.find((step) => step.id === "gate").run;
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const run = (jobs, overrides = {}) => {
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", `gh() { if [[ "\${MOCK_GH_FAIL:-}" == 1 ]]; then return 23; fi; printf '%s' "$MOCK_JOBS"; }\n${script}`], {
      cwd: repoRoot, encoding: "utf8", env: {
        ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: dir,
        GITHUB_REPOSITORY: "PDP-Connect/data-connectors", EVENT_NAME: "workflow_run",
        RELEASE_RUN_ID: "123", RELEASE_RUN_ATTEMPT: "1", MOCK_JOBS: JSON.stringify(jobs),
        ...overrides,
      },
    });
    return { result, output: readFileSync(output, "utf8") };
  };
  const skipped = [{ jobs: [{ name: "Publish and verify the connector catalog", status: "completed", conclusion: "skipped", steps: [] }] }];
  assert.equal(run(skipped).output, "deploy=false\n");
  const invalid = run({ bad: "response" });
  assert.notEqual(invalid.result.status, 0);
  assert.equal(invalid.output, "");
  const apiFailure = run(skipped, { MOCK_GH_FAIL: "1" });
  assert.notEqual(apiFailure.result.status, 0);
  assert.equal(apiFailure.output, "");
  const badRun = run(skipped, { RELEASE_RUN_ID: "bad" });
  assert.notEqual(badRun.result.status, 0);
  assert.equal(badRun.output, "");
  assert.equal(run(skipped, { EVENT_NAME: "push" }).output, "deploy=true\n");
});

test("a publish hint follows a successful full-site deploy and is disabled until enabled", () => {
  assert.equal(pages.jobs.deploy.needs, "build");
  assert.deepEqual(pages.jobs.notify.needs, ["build", "deploy"]);
  assert.match(pages.jobs.notify.if, /CATALOG_WEBSUB_NOTIFY_ENABLED == 'true'/);
  const steps = pages.jobs.notify.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "${{ needs.build.outputs.source_sha }}");
  assert.match(steps.find((step) => step.name === "Verify the public feed and notify the hub").run, /static-notify\.mjs --sha256/);
});

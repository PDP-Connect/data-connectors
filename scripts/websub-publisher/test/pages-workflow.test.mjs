// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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

test("a publish hint follows a successful full-site deploy and is disabled until enabled", () => {
  assert.equal(pages.jobs.deploy.needs, "build");
  assert.deepEqual(pages.jobs.notify.needs, ["build", "deploy"]);
  assert.match(pages.jobs.notify.if, /CATALOG_WEBSUB_NOTIFY_ENABLED == 'true'/);
  const steps = pages.jobs.notify.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "${{ needs.build.outputs.source_sha }}");
  assert.match(steps.find((step) => step.name === "Verify the public feed and notify the hub").run, /static-notify\.mjs --sha256/);
});

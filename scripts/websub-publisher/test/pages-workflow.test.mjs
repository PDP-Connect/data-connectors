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
  assert.match(pages.jobs.build.if, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(pages.jobs.build.if, /workflow_run\.head_branch == 'main'/);
  const steps = pages.jobs.build.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "main");
  assert.match(steps.find((step) => step.id === "feed").run, /materialize-catalog\.sh registry-site\/catalog\/updates\.atom/);
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/upload-pages-artifact@")).with.path, "registry-site");
});

test("a publish hint follows a successful full-site deploy and is disabled until enabled", () => {
  assert.equal(pages.jobs.deploy.needs, "build");
  assert.deepEqual(pages.jobs.notify.needs, ["build", "deploy"]);
  assert.match(pages.jobs.notify.if, /CATALOG_WEBSUB_NOTIFY_ENABLED == 'true'/);
  const steps = pages.jobs.notify.steps;
  assert.equal(steps.find((step) => step.uses?.startsWith("actions/checkout@")).with.ref, "${{ needs.build.outputs.source_sha }}");
  assert.match(steps.find((step) => step.name === "Verify the public feed and notify the hub").run, /static-notify\.mjs --sha256/);
});

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { publicationRan } from "../publication-ran.mjs";

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

const feed = "<feed>signed catalog hint</feed>";
const feedHash = createHash("sha256").update(feed).digest("hex");
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function compareFeed(t, { event = "workflow_run", live = feed, fail = false, metadata = "200 application/atom+xml" } = {}) {
  const compare = pages.jobs.build.steps.find((step) => step.id === "compare");
  assert.ok(compare, "the build must compare the live topic with its feed");
  assert.equal(compare.env.FEED_SHA256, "${{ steps.feed.outputs.sha256 }}");
  assert.equal(compare.env.EVENT_NAME, "${{ github.event_name }}");
  assert.equal(pages.jobs.build.outputs.deploy, "${{ steps.compare.outputs.deploy }}");
  const upload = pages.jobs.build.steps.find((step) => step.uses?.startsWith("actions/upload-pages-artifact@"));
  assert.match(upload.if, /steps\.compare\.outputs\.deploy == 'true'/);
  const dir = mkdtempSync(join(tmpdir(), "pages-feed-compare-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const output = join(dir, "output");
  writeFileSync(output, "");
  const stub = `curl() {
    if [[ "$MOCK_FAIL" == 1 ]]; then return 7; fi
    local output=""
    while (( $# )); do
      if [[ "$1" == --output ]]; then output="$2"; shift 2; else shift; fi
    done
    printf '%s' "$MOCK_FEED" > "$output"
    printf '%s' "$MOCK_METADATA"
  }\n`;
  const result = spawnSync("bash", ["-c", stub + compare.run], {
    cwd: repoRoot, encoding: "utf8", env: {
      ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: dir,
      FEED_SHA256: feedHash, EVENT_NAME: event, MOCK_FEED: live,
      MOCK_FAIL: fail ? "1" : "0", MOCK_METADATA: metadata,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const decision = readFileSync(output, "utf8").match(/^deploy=(true|false)$/m)?.[1];
  assert.ok(decision, "comparison must write its deployment decision");
  return { decision, stdout: result.stdout };
}

function downstream(decision) {
  assert.equal(pages.jobs.deploy.needs, "build");
  assert.deepEqual(pages.jobs.notify.needs, ["build", "deploy"]);
  const condition = pages.jobs.deploy.if?.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
  assert.ok(condition, "deployment must use the comparison result");
  const deploy = Function("needs", `return (${condition});`)({ build: { outputs: { deploy: decision } } });
  const notify = deploy && /CATALOG_WEBSUB_NOTIFY_ENABLED == 'true'/.test(pages.jobs.notify.if);
  return { deploy, notify };
}

test("a release with empty step metadata and changed feed deploys and notifies", (t) => {
  assert.equal(publicationRan([{ jobs: [{ name: "Publish and verify the connector catalog", status: "completed", conclusion: "success", steps: [] }] }]), true);
  assert.deepEqual(downstream(compareFeed(t, { live: "<feed>old</feed>" }).decision), { deploy: true, notify: true });
});

test("a release with an identical feed skips deploy and notification", (t) => {
  const result = compareFeed(t);
  assert.match(result.stdout, new RegExp(`feed already at ${feedHash}`));
  assert.deepEqual(downstream(result.decision), { deploy: false, notify: false });
  assert.deepEqual(downstream(compareFeed(t, { metadata: "200 Application/Atom+XML; charset=utf-8" }).decision), { deploy: false, notify: false });
});

test("an unavailable, non-200 or non-Atom feed triggers deploy and notification", (t) => {
  for (const options of [{ fail: true }, { metadata: "503 text/html" }, { metadata: "302 text/html" },
    { metadata: "200 text/plain" }, { metadata: "200 application/atom+xml-invalid" }]) {
    assert.deepEqual(downstream(compareFeed(t, options).decision), { deploy: true, notify: true });
  }
});

test("manual recovery and site pushes still deploy and notify when the feed is unchanged", (t) => {
  for (const event of ["workflow_dispatch", "push"]) {
    assert.deepEqual(downstream(compareFeed(t, { event }).decision), { deploy: true, notify: true });
    assert.deepEqual(downstream(compareFeed(t, { event, fail: true }).decision), { deploy: true, notify: true });
  }
});

test("a rejected hub hint fails the notification command", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pages-notify-failure-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preload = join(dir, "mock-fetch.mjs");
  writeFileSync(preload, `globalThis.fetch = async (url) => String(url).includes('registry.pdpp.dev')
    ? new Response(${JSON.stringify(feed)}, { headers: { 'content-type': 'application/atom+xml' } })
    : new Response(null, { status: 503 });\n`);
  const notify = pages.jobs.notify.steps.find((step) => step.name === "Verify the public feed and notify the hub");
  assert.notEqual(notify["continue-on-error"], true);
  assert.notEqual(pages.jobs.notify["continue-on-error"], true);
  const result = spawnSync("bash", ["-c", notify.run], {
    cwd: repoRoot, encoding: "utf8", env: {
      ...process.env, FEED_SHA256: feedHash, NODE_OPTIONS: `--import=${preload}`,
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hub rejected the publish hint \(HTTP 503\)/);
});

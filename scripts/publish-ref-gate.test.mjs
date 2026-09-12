// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the publish ref restriction. `packages: write` plus Sigstore keyless
// signing let any reachable ref mint a release under the org's identity, and
// neither tags nor workflow_dispatch are restricted to main here, so the
// workflow itself has to refuse anything that is not on main. Two things must
// hold, and both are checked here by execution rather than by reading:
//
//   1. scripts/assert-publish-ref.mjs admits a commit contained in main and
//      refuses one that is not — exercised against real throwaway git repos,
//      for a tag push, a branch dispatch, and the degenerate inputs.
//   2. .github/workflows/publish-polyfill-connectors.yml actually calls it,
//      before every step that can reach `oras push` or `cosign sign`. A correct
//      script that nothing invokes is the regression this half exists to catch.
//
// One non-security assertion rides along: that the workflow installs
// packages/polyfill-connectors before building. This is the only suite that
// reads that workflow, and no PR-time CI executes it.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "assert-publish-ref.mjs");
const workflowPath = join(repoRoot, ".github", "workflows", "publish-polyfill-connectors.yml");

/**
 * Build a throwaway repository shaped like a real checkout of this one: a
 * `main` with two commits, a remote-tracking `origin/main` pointing at its tip,
 * and a feature branch that forked before that tip. Returns the SHAs a publish
 * could plausibly run on.
 *
 * A real git repo rather than a mock, because the property under test IS git
 * ancestry — a stubbed `merge-base` would prove only that the stub agrees with
 * itself.
 */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "publish-ref-gate-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Publish Ref Gate Test");
  git("config", "commit.gpgsign", "false");

  writeFileSync(join(dir, "file.txt"), "one\n");
  git("add", "file.txt");
  git("commit", "--quiet", "-m", "one");
  const forkPoint = git("rev-parse", "HEAD");

  writeFileSync(join(dir, "file.txt"), "two\n");
  git("commit", "--quiet", "-am", "two");
  const mainTip = git("rev-parse", "HEAD");

  // The remote-tracking ref the gate resolves. Setting it directly rather than
  // cloning keeps the fixture to one repo while testing the same lookup.
  git("update-ref", "refs/remotes/origin/main", mainTip);

  git("checkout", "--quiet", "-b", "feature", forkPoint);
  writeFileSync(join(dir, "file.txt"), "side\n");
  git("commit", "--quiet", "-am", "side");
  const featureTip = git("rev-parse", "HEAD");

  git("checkout", "--quiet", "main");

  return { dir, mainTip, forkPoint, featureTip };
}

function runGate(repo, env) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: repo.dir,
    encoding: "utf8",
    // A bare env so a stray GITHUB_* from the ambient CI run cannot leak in and
    // answer the question for us.
    env: { PATH: process.env.PATH, HOME: repo.dir, ...env },
  });
}

test("a tag on a main commit is admitted", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.mainTip,
      GITHUB_REF: "refs/tags/polyfill-connectors-v1.0.0",
      GITHUB_EVENT_NAME: "push",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 0, `expected the gate to admit a main commit\n${result.stderr}`);
    assert.match(result.stdout, /publish ref OK/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a tag on a commit that is not on main is refused", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.featureTip,
      GITHUB_REF: "refs/tags/polyfill-connectors-v1.0.1",
      GITHUB_EVENT_NAME: "push",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 1, "a tag pushed to a feature commit must not publish");
    assert.match(result.stderr, /is not contained in origin\/main/);
    assert.match(result.stderr, /::error::/, "the refusal should annotate the Actions run");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a workflow_dispatch from main is admitted", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.mainTip,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 0, `expected a main dispatch to be admitted\n${result.stderr}`);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a workflow_dispatch from a feature branch is refused", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.featureTip,
      GITHUB_REF: "refs/heads/feature",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 1, "a manual dispatch from a feature branch must not publish");
    assert.match(result.stderr, /only allowed from refs\/heads\/main/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a dispatch from a stale branch is refused even though its tip is on main", () => {
  // The ancestry test alone would pass here: `forkPoint` really is contained in
  // main. What must refuse it is the branch-name check, and this is the case
  // that distinguishes the two — without it, any branch left pointing at an old
  // main commit could dispatch a publish of that old commit's version.
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.forkPoint,
      GITHUB_REF: "refs/heads/stale",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 1, "a dispatch is main-only regardless of ancestry");
    assert.match(result.stderr, /only allowed from refs\/heads\/main/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unset GITHUB_SHA refuses rather than passing vacuously", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_REF: "refs/tags/polyfill-connectors-v1.0.0",
      GITHUB_EVENT_NAME: "push",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 1, "a missing commit must refuse, not skip the check");
    assert.match(result.stderr, /GITHUB_SHA is not set/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("an unfetched default branch refuses rather than passing", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.mainTip,
      GITHUB_REF: "refs/tags/polyfill-connectors-v1.0.0",
      GITHUB_EVENT_NAME: "push",
      DEFAULT_BRANCH: "main",
      DEFAULT_BRANCH_REF: "origin/never-fetched",
    });

    assert.equal(result.status, 1, "an unresolvable default branch must refuse");
    assert.match(result.stderr, /cannot resolve 'origin\/never-fetched'/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("a trigger the workflow does not declare is refused", () => {
  const repo = makeRepo();
  try {
    const result = runGate(repo, {
      GITHUB_SHA: repo.mainTip,
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "schedule",
      DEFAULT_BRANCH: "main",
    });

    assert.equal(result.status, 1, "an undeclared trigger must not inherit publish rights");
    assert.match(result.stderr, /is not a publish trigger/);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

/**
 * The workflow as the runner sees it. Parsed rather than line-matched, because
 * the properties below are about step structure — whether a step is
 * conditional, whether it swallows its own failure — and those are invisible to
 * a text search.
 *
 * Parsed with a deliberately small YAML reader rather than a dependency: this
 * repo's root package.json carries no YAML parser, and the subset here (a list
 * of steps with scalar keys) does not justify adding one to the install.
 */
function parsePublishSteps() {
  const lines = readFileSync(workflowPath, "utf8").split("\n");

  // Steps are the 6-space-indented "- " entries under the publish job.
  const steps = [];
  let current = null;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;

    const stepStart = line.match(/^ {6}- (\S.*)$/);
    if (stepStart) {
      current = { keys: {}, lines: [] };
      steps.push(current);
      const [, rest] = stepStart;
      const kv = rest.match(/^([\w-]+):\s*(.*)$/);
      if (kv) current.keys[kv[1]] = kv[2];
      current.lines.push(line);
      continue;
    }

    const stepKey = line.match(/^ {8}([\w-]+):\s*(.*)$/);
    if (stepKey && current) {
      current.keys[stepKey[1]] = stepKey[2];
    }
    if (current) current.lines.push(line);
  }

  return steps;
}

test("the gate step is unconditional and cannot swallow its own failure", () => {
  // The two edits that silently disable the gate while leaving line-ordering
  // intact. Both fail OPEN on a GitHub runner, which is why they are worth a
  // dedicated assertion rather than trusting review to catch them:
  //
  //   `if:`  — every step carries an implicit `if: success()`, which asks
  //            whether a PRIOR step FAILED. A skipped step never runs and never
  //            fails, so the steps after it proceed exactly as if it had passed.
  //   `continue-on-error:` — the step's outcome is `failure` but its conclusion
  //            is `success`, so the job continues past a real refusal.
  const steps = parsePublishSteps();
  const gate = steps.find((step) => step.lines.some((line) => line.includes("assert-publish-ref.mjs")));
  assert.ok(gate, "expected a step that runs the ref gate");

  assert.equal(
    gate.keys.if,
    undefined,
    "the ref gate must not be conditional — a skipped step does not fail, so every later step would run as if it had passed",
  );
  assert.equal(
    gate.keys["continue-on-error"],
    undefined,
    "the ref gate must not set continue-on-error — that converts a refusal into a passing conclusion",
  );
});

test("a dry run cannot reach the push-and-sign step", () => {
  // Independent of the gate script, and a different claim from it. The gate
  // answers "is this commit on main"; this answers "did the operator ask for a
  // real publish". A dispatch defaults to dry-run precisely so that exercising
  // the workflow is safe, and dropping this condition would turn every such
  // exercise into a signed release.
  //
  // The ref restriction itself is NOT restated here the way the npm version of
  // this test restated it. Under OIDC there is no second lever to pull: the
  // gate is the only thing standing between a dispatch and a push, so a test
  // asserting a redundant `github.ref ==` clause would be asserting a comment.
  const steps = parsePublishSteps();
  const push = steps.find((step) => (step.keys.name || "") === "Push and sign");
  assert.ok(push, "expected a 'Push and sign' step");

  const condition = push.keys.if || "";
  assert.match(
    condition,
    /!inputs\.dry-run/,
    `the push step must not run on a dry run, got: ${condition}`,
  );
});

test("the workflow installs packages/polyfill-connectors before it builds", () => {
  // Not a security claim like the rest of this file — a can-it-run-at-all one,
  // kept here because this is the only suite that reads the publish workflow.
  //
  // The root `workspaces` list is `packages/connector-installer-core` alone and
  // the root manifest never names packages/polyfill-connectors, so a root
  // `npm ci` leaves that package with no node_modules.
  // scripts/verify-connector-oci-artifact.mjs resolves the built bundle's
  // externals against exactly that tree and refuses when it is absent, so
  // installing only the root makes the workflow fail its own verify step on
  // every trigger, dry runs included — the build exits 0 and the gate exits 1.
  // No PR-time CI runs this workflow, so nothing else would catch its removal.
  const steps = parsePublishSteps();

  const installIndex = steps.findIndex((step) =>
    step.lines.some((line) =>
      /npm ci\b.*--prefix packages\/polyfill-connectors/.test(line),
    ),
  );
  assert.notEqual(
    installIndex,
    -1,
    "the publish workflow must run `npm ci` for packages/polyfill-connectors — the verify step resolves the bundle's externals against that tree and refuses without it",
  );

  const buildIndex = steps.findIndex((step) =>
    step.lines.some((line) => /build-connector-oci-artifact\.mjs/.test(line)),
  );
  assert.notEqual(buildIndex, -1, "expected a step that builds the artifact layers");
  assert.ok(
    installIndex < buildIndex,
    "the polyfill-connectors install must precede the artifact build",
  );

  // --ignore-scripts on this install too, for the reason the root one carries
  // it: patchright's postinstall downloads a browser the bundle never uses.
  const installStep = steps[installIndex];
  assert.ok(
    installStep.lines.some((line) =>
      /npm ci\b.*--ignore-scripts.*--prefix packages\/polyfill-connectors/.test(line),
    ),
    "the polyfill-connectors install must pass --ignore-scripts, as the root install does",
  );
});

test("signing is restricted to refs/heads/main, and the advertised identity says so", () => {
  // P1-2. Two halves of one claim, asserted together because a mismatch between
  // them IS the defect: the old expression ended at `@` and constrained nothing
  // after it, so this same workflow file running on any unreviewed branch or
  // arbitrary tag satisfied the policy consumers were handed.
  //
  // This is the layer that does not live in the editable checkout. The ancestry
  // gate above is kept as an additional check, but an actor who can push a
  // branch can edit that gate on their branch; they cannot change what OIDC
  // claims about the ref their run is on.
  const steps = parsePublishSteps();
  const signing = steps.filter((step) =>
    ["Push and sign", "Verify the published signature"].includes(step.keys.name || ""),
  );
  assert.equal(signing.length, 2, "expected the push/sign and verify steps");

  for (const step of signing) {
    const condition = step.keys.if || "";
    assert.match(
      condition,
      /github\.ref\s*==\s*'refs\/heads\/main'/,
      `'${step.keys.name}' must only run on refs/heads/main, got: ${condition}`,
    );
  }

  // The identity must be EXACT and pinned to the same ref. A regexp ending at
  // `@`, or any expression not naming refs/heads/main, re-opens the hole.
  const workflow = readFileSync(workflowPath, "utf8");
  const isComment = (line) => /^\s*#/.test(line);
  const identityLines = workflow
    .split("\n")
    .filter((line) => !isComment(line) && /--certificate-identity/.test(line));
  assert.ok(identityLines.length >= 2, "expected a consumer instruction and a verify invocation");

  for (const line of identityLines) {
    assert.doesNotMatch(
      line,
      /--certificate-identity-regexp/,
      `identity must be exact, not a regexp that stops constraining: ${line.trim()}`,
    );
    assert.match(
      line,
      /publish-polyfill-connectors\.yml@refs\/heads\/main/,
      `identity must pin the trusted workflow ref: ${line.trim()}`,
    );
  }
});

test("the signed digest comes from the push, and the tag is never re-resolved", () => {
  // P1-3. The reproduced failure was `oras resolve` after the push: with the tag
  // repointed in between, the workflow pushed A, signed B, verified B and exited
  // 0. The fix is one value — read from the push's own structured output and
  // carried through signing, verification and the receipt.
  //
  // NOTE, because the PR's earlier prose had this backwards: moving a tag does
  // NOT invalidate a Cosign signature. Cosign checks the digest it signed. The
  // defect was choosing the wrong content to sign, not signatures losing their
  // binding.
  const workflow = readFileSync(workflowPath, "utf8").split("\n");
  const isComment = (line) => /^\s*#/.test(line);

  const resolves = workflow.filter((line) => !isComment(line) && /\boras resolve\b/.test(line));
  assert.deepEqual(
    resolves,
    [],
    `the workflow must not re-resolve the mutable tag — that is how it came to sign content it never pushed: ${resolves.join(" | ")}`,
  );

  assert.ok(
    workflow.some((line) => !isComment(line) && /oras push\b/.test(line)) &&
      workflow.some((line) => !isComment(line) && /--format json/.test(line)),
    "the push must request structured output so its digest can be captured",
  );

  // The verify step must consume the push step's output rather than deriving a
  // digest of its own.
  const steps = parsePublishSteps();
  const verify = steps.find((step) => (step.keys.name || "") === "Verify the published signature");
  assert.ok(verify, "expected a verify step");
  assert.ok(
    verify.lines.some((line) => /steps\.publish\.outputs\.digest/.test(line)),
    "the verify step must verify the digest the push reported",
  );
});

test("republishing different bytes under an existing version is refused", () => {
  // P1-3, second half. An identical-byte retry must still succeed — re-running a
  // release after a transient failure is legitimate — so the check compares
  // digests rather than merely testing whether the tag exists.
  const workflow = readFileSync(workflowPath, "utf8");
  assert.match(
    workflow,
    /oras manifest fetch --descriptor/,
    "the publish must look up the existing digest for this version before pushing",
  );
  assert.match(
    workflow,
    /LOCAL_DIGEST" \] && \[ "\$LOCAL_DIGEST" != "\$DIGEST" \]/,
    "the publish must refuse only when the existing digest DIFFERS — an identical retry is allowed",
  );
});

test("the concurrency group serializes tag runs against main dispatches", () => {
  // Keying on github.ref put a tag-triggered run and a main-branch dispatch in
  // different groups, so the two paths that reach the same connector repository
  // were never serialized against each other.
  const workflow = readFileSync(workflowPath, "utf8").split("\n");
  const group = workflow.find((line) => /^\s*group:/.test(line));
  assert.ok(group, "expected a concurrency group");
  assert.doesNotMatch(
    group,
    /github\.ref/,
    `the concurrency group must not be keyed on the ref — a tag run and a main dispatch would not serialize: ${group.trim()}`,
  );
});

test("the selection step passes its input as data, never as JavaScript source", () => {
  // P1-1. The reproduced hole was `node -p "require('…/${CONNECTOR}.json')…"`:
  // the dispatch input became part of a program, and the allowlist compared it
  // only afterward, so a rejected name had already executed. The step now runs a
  // fixed script that receives the name through the environment.
  const steps = parsePublishSteps();
  const select = steps.find((step) =>
    (step.keys.name || "").startsWith("Select the connector"),
  );
  assert.ok(select, "expected the selection step");

  const body = select.lines.filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(
    body,
    /node\s+-p\b/,
    "the selection step must not build a program — pass the connector as data",
  );
  assert.doesNotMatch(
    body,
    /\$\{?CONNECTOR\}?[^\n]*\.json/,
    "the selection step must not interpolate the connector name into a path or program",
  );
  assert.match(
    body,
    /node scripts\/select-publish-target\.mjs/,
    "the selection step must run the validated selection script",
  );
});

test("the publish workflow runs the gate before every step that can publish", () => {
  // The script being correct is worth nothing if the workflow stops calling it.
  // Compare line positions rather than parsing YAML: the ordering claim is
  // exactly a claim about where these strings sit in the file.
  const workflow = readFileSync(workflowPath, "utf8").split("\n");

  // Match the INVOCATION, not any mention of the path: the file's own header
  // comment names the script, so a looser match stays green after someone
  // deletes the step — which is precisely the regression under guard. A run
  // line is a shell command at the start of a line's content, never a `#`
  // comment.
  const isComment = (line) => /^\s*#/.test(line);
  const gateLine = workflow.findIndex(
    (line) => !isComment(line) && /(^|\s)node\s+scripts\/assert-publish-ref\.mjs\s*$/.test(line),
  );
  assert.notEqual(
    gateLine,
    -1,
    "the publish workflow must actually run `node scripts/assert-publish-ref.mjs`, not merely mention it",
  );

  // Under OCI there are TWO verbs that create a release, not one: `oras push`
  // writes the bytes and `cosign sign` attests to them. Both must sit after the
  // gate. Guarding only the push would leave a path where an unreviewed commit
  // cannot upload an artifact but can still put the org's signing identity
  // behind a digest — which is the more valuable half to steal.
  //
  // Matched inside `run:` blocks rather than on `run:` lines, because both
  // commands live in multi-line scripts here.
  const publishLines = workflow
    .map((line, index) => ({ line, index }))
    .filter(
      ({ line }) =>
        !isComment(line) && /^\s*(oras push|cosign sign)\b/.test(line),
    );
  assert.ok(
    publishLines.some(({ line }) => /oras push/.test(line)),
    "expected an `oras push` step to guard",
  );
  assert.ok(
    publishLines.some(({ line }) => /cosign sign/.test(line)),
    "expected a `cosign sign` step to guard",
  );

  for (const { line, index } of publishLines) {
    assert.ok(
      index > gateLine,
      `'${line.trim()}' at line ${index + 1} runs before the ref gate at line ${gateLine + 1}`,
    );
  }

  // fetch-depth: 0 is load-bearing — the gate cannot test ancestry in a shallow
  // clone, and the failure mode without it is a refusal on a legitimate release.
  // Checked as a real setting rather than anywhere in the text, for the same
  // reason as above.
  assert.ok(
    workflow.some((line) => !isComment(line) && /^\s*fetch-depth:\s*0\s*$/.test(line)),
    "the publish checkout must set fetch-depth: 0 so the gate can test ancestry",
  );
});

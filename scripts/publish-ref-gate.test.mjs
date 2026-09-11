// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the publish ref restriction. A trusted-publisher record — npm's, and
// the equivalent for a registry the connector manager publishes to — binds a
// repository and a workflow filename but cannot restrict which ref publishes,
// so the publishing workflow itself has to refuse anything that is not on main.
//
// scripts/assert-publish-ref.mjs admits a commit contained in main and refuses
// one that is not — exercised against real throwaway git repos, for a tag push,
// a branch dispatch, and the degenerate inputs. The gate is registry-neutral:
// it reads the commit, ref and event from the environment and knows nothing
// about what is being published.
//
// NOT covered here: that a workflow actually calls the gate before every step
// that can publish. That half was asserted against
// .github/workflows/publish-polyfill-connectors.yml, which published connector
// content to npm and was dropped under the OCI distribution decision
// (CONNECTOR-DISTRIBUTION-DECISION-0911). A correct script that nothing invokes
// is a real regression, so the wiring assertions must be restored against the
// GHCR publishing workflow when that lands.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repoRoot, "scripts", "assert-publish-ref.mjs");

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

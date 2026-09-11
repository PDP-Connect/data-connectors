#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Refuse to publish from any ref that is not the repository's default branch.
 *
 * A trusted-publisher record binds only a repository and a workflow FILENAME —
 * it cannot narrow which ref may publish. This holds for npm's trusted
 * publishing and equally for a workflow that pushes signed artifacts to a
 * container registry. So once a publishing workflow is registered as a trusted
 * publisher, every path through it that reaches a publish can mint a release
 * under the org's identity, with a provenance attestation naming whatever
 * commit it ran on. Two such paths exist by construction:
 *
 *   1. A release tag can be pushed to ANY commit. Tags are not
 *      branch-protected (this repo has no tag ruleset), so a tag on a
 *      feature branch triggers the workflow just as a tag on main does.
 *   2. `workflow_dispatch` can be run from ANY branch.
 *
 * The gate is registry-neutral by design: it reads the commit, ref and event
 * from the environment and knows nothing about what is being published, so the
 * connector-manager and OCI publish paths can both adopt it unchanged.
 *
 * This script is the enforcement point for both. It is a separate executable
 * rather than inline YAML for one reason: inline YAML cannot be run, and a
 * guarantee that cannot be run cannot be tested. scripts/publish-ref-gate.test.mjs
 * executes this file against both directions.
 *
 * The check is ancestry, not string equality on the ref name. A tag is not a
 * branch, so a release tag ref such as `refs/tags/v1.0.0` never equals
 * `refs/heads/main`; what we actually need to know is whether the commit being
 * published is contained in the default branch. `git merge-base --is-ancestor`
 * answers exactly that, and it holds for a tag placed on a main commit while
 * failing for a tag placed anywhere else.
 *
 * Usage — run from inside the checkout being published, with the default
 * branch already fetched as a remote-tracking ref:
 *   node scripts/assert-publish-ref.mjs
 *
 * Environment:
 *   GITHUB_SHA         commit being published (required)
 *   GITHUB_REF         full ref that triggered the run (required)
 *   GITHUB_EVENT_NAME  "push" | "workflow_dispatch" (required)
 *   DEFAULT_BRANCH     default branch name (optional, defaults to "main")
 *   DEFAULT_BRANCH_REF remote-tracking ref to test ancestry against
 *                      (optional, defaults to "origin/<DEFAULT_BRANCH>")
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) {
  // ::error:: renders as an annotation on the Actions run; the plain copy keeps
  // the message readable when this script is run outside CI.
  console.error(`::error::${message}`);
  console.error(`publish refused: ${message}`);
  process.exit(1);
}

// Runs against the CHECKOUT, i.e. the process's working directory — not the
// directory this file happens to sit in. Deriving the repo from the script's
// own path would silently answer the ancestry question about whatever tree the
// script was copied into, which is both wrong and untestable.
function git(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function assertPublishRef(env = process.env, { cwd = process.cwd() } = {}) {
  const sha = env.GITHUB_SHA;
  const ref = env.GITHUB_REF;
  const eventName = env.GITHUB_EVENT_NAME;
  const defaultBranch = env.DEFAULT_BRANCH || "main";
  const defaultBranchRef = env.DEFAULT_BRANCH_REF || `origin/${defaultBranch}`;

  // A missing variable must refuse, never pass. An unset GITHUB_SHA in a
  // reordered or copied workflow would otherwise make the ancestry test
  // vacuous, and this gate's whole value is that it cannot be no-opped by
  // accident.
  for (const [name, value] of [
    ["GITHUB_SHA", sha],
    ["GITHUB_REF", ref],
    ["GITHUB_EVENT_NAME", eventName],
  ]) {
    if (!value) {
      fail(`${name} is not set — cannot establish which commit is being published`);
    }
  }

  // Only the two triggers this workflow declares may reach a publish. Anything
  // else (a schedule, a repository_dispatch someone adds later) refuses by
  // default rather than inheriting a check written without it in mind.
  if (eventName !== "push" && eventName !== "workflow_dispatch") {
    fail(
      `event '${eventName}' is not a publish trigger — only a '${defaultBranch}' tag push or a ` +
        `workflow_dispatch from '${defaultBranch}' may publish`,
    );
  }

  // workflow_dispatch carries a branch ref, and the only branch allowed to
  // dispatch a publish is the default branch. Checking the ref name here (in
  // addition to the ancestry test below) rejects a dispatch from a stale branch
  // whose tip happens to still be an ancestor of main.
  if (eventName === "workflow_dispatch" && ref !== `refs/heads/${defaultBranch}`) {
    fail(
      `workflow_dispatch ran on '${ref}' — a manual publish is only allowed from ` +
        `refs/heads/${defaultBranch}`,
    );
  }

  const resolved = git(["rev-parse", "--verify", `${defaultBranchRef}^{commit}`], cwd);
  if (resolved.status !== 0) {
    fail(
      `cannot resolve '${defaultBranchRef}' — the default branch must be fetched before this ` +
        `check runs (use fetch-depth: 0). git said: ${(resolved.stderr || "").trim()}`,
    );
  }

  const ancestry = git(["merge-base", "--is-ancestor", sha, defaultBranchRef], cwd);

  // --is-ancestor exits 0 for yes and 1 for no; anything else (a bad SHA, a
  // broken repo) is an error we must not read as either answer.
  if (ancestry.status === 1) {
    fail(
      `commit ${sha} (ref ${ref}) is not contained in ${defaultBranchRef} — publishing is only ` +
        `allowed from the '${defaultBranch}' branch. Merge this commit to ${defaultBranch} and ` +
        `tag the merged commit.`,
    );
  }

  if (ancestry.status !== 0) {
    fail(
      `could not determine whether ${sha} is contained in ${defaultBranchRef} ` +
        `(git exit ${ancestry.status}): ${(ancestry.stderr || "").trim()}`,
    );
  }

  console.log(`publish ref OK: ${sha} (ref ${ref}, event ${eventName}) is contained in ${defaultBranchRef}`);
}

// Only run when executed directly, so the test can import this module without
// tripping process.exit.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  assertPublishRef();
}

#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PR-time dry run of the publish-selection refusal rule.
 *
 * The push-triggered publish workflow refuses to run
 * (scripts/select-publish-connectors.mjs) when a connector's shipped
 * artifact content changed without a version bump — but it only runs AFTER
 * a merge to main, so a PR that trips that rule merges green and blocks
 * every connector's publish on its own push. This script runs the identical
 * rule, via the same `selectChangedConnectors` function, at PR time: before
 * is the PR's merge-base with its target branch, after is the PR head. A PR
 * that reproduces that situation fails here instead of after merge.
 *
 * This deliberately stops at selection. It never calls
 * `filterAbsentVersions`: that half decides registry-publish eligibility
 * against GHCR, and a PR has no publishable tag yet for that question to be
 * about. Only the refusal rule needs to move earlier.
 */

import { selectChangedConnectors } from "./select-publish-connectors.mjs";

async function main() {
  // selectChangedConnectors treats a missing `before` as "no prior commit"
  // and silently compares against nothing, so it is checked here. A missing
  // `after` already fails loudly inside selectChangedConnectors itself.
  const before = process.env.BEFORE_SHA;
  if (!before) throw new Error("BEFORE_SHA is not set");
  const after = process.env.AFTER_SHA;

  const selected = await selectChangedConnectors({ before, after });
  if (selected.length === 0) {
    console.log(
      `No connector version changed and no shipped connector content changed between ${before} and ${after}.`,
    );
    return;
  }
  console.log(
    `${selected.length} connector version change${selected.length === 1 ? "" : "s"} detected between ${before} and ${after}, each with a version bump: ` +
      selected.map(({ connector, version }) => `${connector}@${version}`).join(", "),
  );
}

main().catch((error) => {
  console.error(`::error::${error.message}`);
  console.error(`publish selection dry run refused: ${error.message}`);
  process.exit(1);
});

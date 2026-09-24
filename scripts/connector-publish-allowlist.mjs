#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The complete Collection Profile manifest inventory and its publish policy.
 *
 * `manifest` names the source directory and manifest file. `connectorKey` is
 * the public OCI identity declared inside that manifest. They intentionally
 * differ for connectors whose source names use underscores.
 */
export const CONNECTOR_PUBLISH_INVENTORY = Object.freeze(
  [
    ["amazon", "amazon"],
    ["anthropic", "anthropic"],
    ["apple_contacts", "apple-contacts"],
    ["apple_health", "apple-health"],
    ["apple_photos", "apple-photos"],
    ["chase", "chase"],
    ["chatgpt", "chatgpt"],
    ["claude_code", "claude-code"],
    ["codex", "codex"],
    ["doordash", "doordash"],
    ["github", "github"],
    ["gmail", "gmail"],
    ["google_calendar", "google-calendar"],
    ["google_contacts", "google-contacts"],
    ["google_maps", "google-maps"],
    ["google_maps_data_portability", "google-maps-data-portability"],
    [
      "google_messages",
      "google-messages",
      "Requires gmcli from PATH or $GMCLI_BIN; the OCI builder does not implement a per-platform tool layer yet.",
    ],
    ["google_takeout", "google-takeout"],
    ["groupme", "groupme"],
    ["heb", "heb"],
    ["icloud_notes", "icloud-notes"],
    ["ical", "ical"],
    ["imessage", "imessage"],
    ["instinct", "instinct"],
    ["jellyfin", "jellyfin"],
    ["linkedin", "linkedin"],
    ["loom", "loom"],
    ["meta", "meta"],
    ["netflix_export", "netflix-export"],
    ["notion", "notion"],
    ["oura", "oura"],
    ["pocket", "pocket"],
    ["reddit", "reddit"],
    ["shopify", "shopify"],
    [
      "signal",
      "signal",
      "Requires sigtop from PATH or $SIGTOP_BIN; the OCI builder does not implement a per-platform tool layer yet.",
    ],
    [
      "slack",
      "slack",
      "Requires slackdump from PATH or $SLACKDUMP_BIN and a code-relative config asset; the OCI builder does not implement a per-platform tool layer or asset rewrite yet.",
    ],
    ["spotify", "spotify"],
    ["steam", "steam"],
    ["strava", "strava"],
    ["twitter_archive", "twitter-archive"],
    ["uber", "uber"],
    ["usaa", "usaa"],
    ["venmo", "venmo"],
    ["whatsapp", "whatsapp"],
    ["wholefoods", "wholefoods"],
    ["whoop", "whoop"],
    ["ynab", "ynab"],
    ["youtube", "youtube", "New connector on the hard-cut review branch; it publishes with the coordinated hard cut, not before, so Desktop auto-update does not receive it early."],
  ].map(([manifest, connectorKey, exclusionReason = null]) =>
    Object.freeze({ manifest, connectorKey, exclusionReason }),
  ),
);

export const PUBLISHABLE_CONNECTORS = Object.freeze(
  CONNECTOR_PUBLISH_INVENTORY.filter(({ exclusionReason }) => exclusionReason === null),
);

export const PUBLISH_EXCLUSIONS = Object.freeze(
  CONNECTOR_PUBLISH_INVENTORY.filter(({ exclusionReason }) => exclusionReason !== null),
);

export function getPublishShards(count = 6) {
  if (!Number.isSafeInteger(count) || count < 1 || count > PUBLISHABLE_CONNECTORS.length) {
    throw new TypeError(`shard count must be an integer from 1 to ${PUBLISHABLE_CONNECTORS.length}`);
  }

  const shards = Array.from({ length: count }, (_, index) => ({
    shard: index + 1,
    connectors: [],
  }));
  for (const [index, connector] of PUBLISHABLE_CONNECTORS.entries()) {
    shards[index % count].connectors.push(connector);
  }
  return shards;
}

function githubMatrix(rows) {
  return { include: rows };
}

function emitMatrix(matrix) {
  const value = JSON.stringify(matrix);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${value}\n`);
  } else {
    process.stdout.write(`${value}\n`);
  }
}

function validateInventory() {
  const manifests = new Set();
  const connectorKeys = new Set();
  for (const { manifest, connectorKey, exclusionReason } of CONNECTOR_PUBLISH_INVENTORY) {
    if (!/^[a-z0-9][a-z0-9_]*$/.test(manifest)) {
      throw new Error(`invalid manifest name '${manifest}' in connector publish inventory`);
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(connectorKey)) {
      throw new Error(`invalid connector key '${connectorKey}' in connector publish inventory`);
    }
    if (manifests.has(manifest) || connectorKeys.has(connectorKey)) {
      throw new Error(`duplicate connector identity in publish inventory: ${manifest}/${connectorKey}`);
    }
    if (exclusionReason !== null && exclusionReason.trim() === "") {
      throw new Error(`excluded connector '${connectorKey}' has no reason`);
    }
    manifests.add(manifest);
    connectorKeys.add(connectorKey);
  }
}

validateInventory();

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, count] = process.argv.slice(2);
  if (command === "--matrix" && count === undefined) {
    emitMatrix(
      githubMatrix(
        PUBLISHABLE_CONNECTORS.map(({ connectorKey, manifest }) => ({
          connector: connectorKey,
          manifest,
        })),
      ),
    );
  } else if (command === "--shard-matrix" && count !== undefined) {
    emitMatrix(githubMatrix(getPublishShards(Number(count))));
  } else {
    console.error(
      "usage: node scripts/connector-publish-allowlist.mjs --matrix | --shard-matrix <count>",
    );
    process.exitCode = 1;
  }
}

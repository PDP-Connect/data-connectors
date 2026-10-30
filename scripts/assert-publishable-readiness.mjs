#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { fileURLToPath } from "node:url";
import { KNOWN_SCAFFOLD_CONNECTORS } from "../packages/polyfill-connectors/src/connector-conformance-roster.ts";
import {
  CONNECTOR_PUBLISH_INVENTORY,
  PUBLISHABLE_CONNECTORS,
} from "./connector-publish-allowlist.mjs";

// Refuses a publish row before anything contacts a registry. The catalog
// generator checks every row it is given, including an override, and the
// publish workflow checks the full publishable set before it derives a matrix.
//
// Rows are judged against the canonical inventory, never against what a row
// says about itself. A known identity must match on both names. An excluded
// entry is refused whatever the row claims. Known scaffolds are checked later,
// against the tier in their published artifact metadata.

const DIRECTORY = /^[a-z0-9][a-z0-9_]*$/;
const PUBLIC_KEY = /^[a-z0-9][a-z0-9-]*$/;
const SCAFFOLD_DIRECTORIES = new Set(KNOWN_SCAFFOLD_CONNECTORS);
const SCAFFOLD_KEYS = new Set(
  CONNECTOR_PUBLISH_INVENTORY
    .filter(({ manifest }) => SCAFFOLD_DIRECTORIES.has(manifest))
    .map(({ connectorKey }) => connectorKey),
);

export function assertPublishableRow(row) {
  const { manifest, connectorKey, exclusionReason = null } = row ?? {};
  if (
    typeof manifest !== "string" || !DIRECTORY.test(manifest) ||
    typeof connectorKey !== "string" || !PUBLIC_KEY.test(connectorKey) ||
    (exclusionReason !== null && (typeof exclusionReason !== "string" || exclusionReason.trim() === ""))
  ) {
    throw new Error(`refusing to publish malformed connector row ${JSON.stringify(row ?? null)}`);
  }
  const byDirectory = CONNECTOR_PUBLISH_INVENTORY.find((entry) => entry.manifest === manifest);
  const byKey = CONNECTOR_PUBLISH_INVENTORY.find((entry) => entry.connectorKey === connectorKey);
  if (byDirectory !== byKey && (byDirectory || byKey)) {
    throw new Error(
      `refusing to publish connector '${connectorKey}' from '${manifest}': identity does not match the publish inventory`,
    );
  }

  const declared = byDirectory?.exclusionReason ?? exclusionReason;
  if (declared !== null) {
    throw new Error(`refusing to publish excluded connector '${connectorKey}': ${declared}`);
  }
}

export function assertScaffoldTier(row, metadata) {
  const { manifest, connectorKey } = row ?? {};
  if (
    !SCAFFOLD_DIRECTORIES.has(manifest) &&
    !SCAFFOLD_DIRECTORIES.has(connectorKey) &&
    !SCAFFOLD_KEYS.has(connectorKey)
  ) {
    return;
  }
  if (metadata?.tier !== "development") {
    throw new Error(
      `refusing to list known scaffold connector '${connectorKey}': published tier must remain at Development (got '${metadata?.tier ?? "unknown"}')`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    for (const row of PUBLISHABLE_CONNECTORS) assertPublishableRow(row);
    console.log(
      `publish inventory: ${PUBLISHABLE_CONNECTORS.length} connectors pass identity and exclusion checks`,
    );
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}

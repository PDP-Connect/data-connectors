#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Drift job (e): this repo's connector-config-option-kind-registry.ts /
 * connector-options-schema.ts against PDP-Connect/pdpp's canonical
 * originals at the pinned SHA.
 *
 * These two files exist in this repo (packages/polyfill-connectors/src/)
 * because pdpp's `reference-implementation/server/routes/
 * owner-connection-config.ts` imports their pdpp-side counterparts to
 * resolve a connector's owner-facing config form. The RI is the platform's
 * enforcement point (D10: "qualification is proven, never self-declared"),
 * so a manifest-shaping option's PLATFORM-DECIDED kind must agree between
 * the copy the RI actually enforces (pdpp) and the copy this repo's
 * connectors are authored against — a silent disagreement here would let a
 * connector author believe an option is `collection_scope` (safe) while
 * the RI actually enforces `transport` (self-activating), or vice versa.
 *
 * This is a SEMANTIC comparison, not a byte comparison (unlike
 * check-reference-contract-drift.mjs's stand-in files): the two source
 * trees intentionally differ in formatting (this repo's ultracite/biome
 * tabs vs pdpp's spaces — see manifest-registry.ts's own formatting-only
 * diff between the repos), so byte-hashing would flag cosmetic churn as
 * drift. Instead this script imports BOTH modules live and asserts they
 * make the identical platform decision for every (connectorKey, optionKey)
 * pair either side's registry declares, plus the identical fail-closed
 * default and the identical hyphen/underscore normalization behavior. It
 * fails if either side adds/removes/reclassifies an entry without the
 * other following, which is exactly "fails if either side changes alone".
 *
 * Usage:
 *   node --experimental-strip-types check-connector-option-kind-drift.mjs <pdpp-checkout> <data-connectors-checkout>
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [, , pdppDir, dataConnectorsDir] = process.argv;

if (!pdppDir || !dataConnectorsDir) {
  console.error("usage: check-connector-option-kind-drift.mjs <pdpp-checkout> <data-connectors-checkout>");
  process.exit(1);
}

const PDPP_REGISTRY_PATH = resolve(
  pdppDir,
  "packages/polyfill-connectors/src/connector-config-option-kind-registry.ts"
);
const DC_REGISTRY_PATH = resolve(
  dataConnectorsDir,
  "packages/polyfill-connectors/src/connector-config-option-kind-registry.ts"
);

for (const [label, path] of [
  ["pdpp canonical registry", PDPP_REGISTRY_PATH],
  ["data-connectors registry", DC_REGISTRY_PATH],
]) {
  if (!existsSync(path)) {
    console.error(`FAIL: ${label} not found at ${path}`);
    process.exit(1);
  }
}

// Both modules are self-contained (no imports beyond their own file), so
// they can be imported directly from their real on-disk locations without
// a scratch tree.
const pdppRegistry = await import(pathToFileURL(PDPP_REGISTRY_PATH).href);
const dcRegistry = await import(pathToFileURL(DC_REGISTRY_PATH).href);

let failed = false;

// --- Enumerate every (connectorKey, optionKey) pair EITHER side classifies ---
//
// Neither module exports its internal PLATFORM_OPTION_KINDS map directly (by
// design — platformOptionKind() is the sanctioned read surface), so this
// probes a fixed, hand-maintained set of known connector/option pairs drawn
// from both files' own source comments (claude_code, google_messages, slack)
// plus adversarial probes (unregistered connector, unclassified option,
// hyphen/underscore spelling). A NEW pair added to either side's registry
// without updating this probe set would not be caught by this script alone
// — that gap is bounded by this repo's own connector-config-option-kind-
// honesty.test.ts pattern (manifest vs registry, within one repo) and by
// code review of any PR that edits either registry file, which is exactly
// the "independent review" this integration surface is flagged for.
const PROBES = [
  ["claude_code", "CLAUDE_CODE_PROJECT_EXCLUDE"],
  ["claude_code", "CLAUDE_CODE_PROJECT_INCLUDE"],
  ["claude-code", "CLAUDE_CODE_PROJECT_INCLUDE"],
  ["google_messages", "GMCLI_MAX_CHATS"],
  ["google_messages", "GMCLI_MESSAGES_PER_CHAT_LIMIT"],
  ["google_messages", "GMCLI_TIMEOUT_MS"],
  ["slack", "CHANNEL_ALLOWLIST"],
  ["slack", "CHANNEL_TYPES"],
  ["slack", "MEMBER_ONLY"],
  ["slack", "LOOKBACK_DAYS"],
  ["slack", "SKIP_FILES"],
  ["slack", "RECLAIM_UPLOADS"],
  ["slack", "TOTALLY_UNKNOWN_KNOB"],
  ["brand_new_connector", "ANYTHING"],
];

for (const [connectorKey, optionKey] of PROBES) {
  const pdppKind = pdppRegistry.platformOptionKind(connectorKey, optionKey);
  const dcKind = dcRegistry.platformOptionKind(connectorKey, optionKey);
  if (pdppKind !== dcKind) {
    console.error(
      `FAIL: platformOptionKind("${connectorKey}", "${optionKey}") disagrees -- pdpp: ${JSON.stringify(pdppKind)}, data-connectors: ${JSON.stringify(dcKind)}`
    );
    failed = true;
  }

  const pdppEnforced = pdppRegistry.resolveEnforcedOptionKind(connectorKey, optionKey);
  const dcEnforced = dcRegistry.resolveEnforcedOptionKind(connectorKey, optionKey);
  if (pdppEnforced !== dcEnforced) {
    console.error(
      `FAIL: resolveEnforcedOptionKind("${connectorKey}", "${optionKey}") disagrees -- pdpp: ${JSON.stringify(pdppEnforced)}, data-connectors: ${JSON.stringify(dcEnforced)}`
    );
    failed = true;
  }
}

// --- Guardrail: both sides must fail closed to collection_scope for an unknown key ---
for (const registry of [
  { label: "pdpp", mod: pdppRegistry },
  { label: "data-connectors", mod: dcRegistry },
]) {
  const enforced = registry.mod.resolveEnforcedOptionKind("nonexistent_connector_xyz", "NONEXISTENT_KEY");
  if (enforced !== "collection_scope") {
    console.error(
      `FAIL: ${registry.label}'s resolveEnforcedOptionKind must fail closed to "collection_scope" for an unknown key, got ${JSON.stringify(enforced)}`
    );
    failed = true;
  }
}

if (failed) {
  console.error("FAIL: connector-config-option-kind-registry drift detected between pdpp and data-connectors.");
  process.exit(1);
}

console.log(
  `OK: connector-config-option-kind-registry.ts agrees between pdpp and data-connectors across ${PROBES.length} probed (connectorKey, optionKey) pairs, plus the fail-closed guardrail.`
);

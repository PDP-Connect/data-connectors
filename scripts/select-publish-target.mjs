#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Decide which connector and version a publish run targets, and refuse anything
 * outside the proven allowlist.
 *
 * This exists because the previous inline version built the answer by
 * interpolating the operator's input into JavaScript source:
 *
 *     VERSION="$(node -p "require('./…/manifests/${CONNECTOR}.json').version")"
 *
 * The input arrived safely in an environment variable and was then pasted into a
 * program, which is code injection with extra steps. The allowlist comparison
 * came AFTERWARD, so a name that the allowlist would reject had already run its
 * payload by the time it was rejected — the step reported `selected=false` and
 * exited 0 having executed attacker-chosen code inside a job holding
 * `packages: write` and `id-token: write`, on dry runs too.
 *
 * The ordering here is the fix, and it is deliberate:
 *
 *   1. Parse the trigger into a candidate name. No filesystem access yet.
 *   2. Check the name's SYNTAX against a strict pattern.
 *   3. Check the name's MEMBERSHIP in the repository publish allowlist.
 *   4. Only then build a path and read the manifest, with readFile/JSON.parse.
 *
 * Steps 2 and 3 happen before step 4 touches a path, so a rejected name never
 * reaches the filesystem at all. And because the manifest is read as DATA rather
 * than evaluated as a module, there is no program for a name to become part of
 * even if the ordering were wrong. Both properties are load-bearing; neither
 * alone is the whole guard.
 *
 * Environment:
 *   EVENT_NAME        "push" | "workflow_dispatch" (required)
 *   GIT_REF_NAME      tag name, or "main" for the automatic main-branch push path
 *   GIT_REF_TYPE      "tag" or "branch", for a push
 *   INPUT_CONNECTOR   connector key, for a dispatch
 *   MATRIX_CONNECTOR  this matrix leg's connector (the allowlist entry)
 *   MATRIX_VERSION    version selected by the main-branch change detector (optional)
 *   GITHUB_REPOSITORY_OWNER  owner segment of the GHCR repository
 *   GITHUB_OUTPUT     step output file (optional; stdout when absent)
 */

import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLISHABLE_CONNECTORS } from "./connector-publish-allowlist.mjs";

// A connector key is a lowercase npm-ish token. Anchored, no dots, no slashes,
// no quotes — so it can be neither a traversal nor a fragment of any syntax.
// Kept strict on purpose: widening this is a security decision, not a typo fix.
const CONNECTOR_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;

// `connector-<key>-v<version>`. The key is captured non-greedily up to the LAST
// `-v`, matching what the shell's `${REST%-v*}` / `${REST##*-v}` pair did.
const RELEASE_TAG = /^connector-(.+)-v(.+)$/;

const PUBLISHABLE_BY_KEY = new Map(
  PUBLISHABLE_CONNECTORS.map((connector) => [connector.connectorKey, connector]),
);

export class SelectionError extends Error {}

/**
 * Resolve the target from the trigger alone. Pure: no filesystem, no manifest.
 * Returns `{ connector, version }` where `version` may be null for a dispatch
 * (the manifest supplies it later, once the name has been cleared).
 */
export function parseTrigger(env) {
  const eventName = env.EVENT_NAME;

  if (eventName === "push") {
    const refName = env.GIT_REF_NAME || "";
    if (env.GIT_REF_TYPE === "branch") {
      if (refName !== "main") {
        throw new SelectionError(`branch '${refName}' is not the main publish branch`);
      }
      return { connector: env.MATRIX_CONNECTOR || "", version: null };
    }
    const match = RELEASE_TAG.exec(refName);
    if (!match) {
      throw new SelectionError(
        `tag '${refName}' is not a connector release tag — expected connector-<key>-v<version>`,
      );
    }
    return { connector: match[1], version: match[2] };
  }

  if (eventName === "workflow_dispatch") {
    return { connector: env.INPUT_CONNECTOR || "", version: null };
  }

  throw new SelectionError(`event '${eventName}' is not a publish trigger`);
}

/**
 * Read a manifest's version as DATA. Resolve the repository-owned manifest name
 * from the canonical connector key before joining a path. It still uses
 * readFile/JSON.parse, so no connector-controlled string is evaluated.
 */
export function readManifestVersion(connectorKey, { cwd = process.cwd() } = {}) {
  const connector = PUBLISHABLE_BY_KEY.get(connectorKey);
  if (!connector) {
    throw new SelectionError(`connector '${connectorKey}' is not in the publish allowlist`);
  }
  const path = join(
    cwd,
    "connectors",
    connector.manifest,
    "manifest.json",
  );
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SelectionError(
      `cannot read manifest for '${connector.connectorKey}' at '${connector.manifest}.json': ${error.message}`,
    );
  }
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new SelectionError(`manifest for '${connector.connectorKey}' declares no version string`);
  }
  if (parsed.connector_key !== undefined && parsed.connector_key !== connector.connectorKey) {
    throw new SelectionError(
      `manifest '${connector.manifest}.json' declares connector_key '${parsed.connector_key}', expected '${connector.connectorKey}'`,
    );
  }
  return parsed.version;
}

export function selectPublishTarget(env = process.env, { cwd = process.cwd() } = {}) {
  const matrixConnector = env.MATRIX_CONNECTOR || "";
  if (!CONNECTOR_KEY.test(matrixConnector)) {
    // The allowlist itself is repository-controlled, so a malformed entry is a
    // bug in this file's matrix rather than hostile input — but refusing keeps
    // the comparison below meaningful instead of vacuous.
    throw new SelectionError(`matrix connector '${matrixConnector}' is not a valid connector key`);
  }
  if (!PUBLISHABLE_BY_KEY.has(matrixConnector)) {
    throw new SelectionError(`matrix connector '${matrixConnector}' is not in the publish allowlist`);
  }

  const { connector, version: taggedVersion } = parseTrigger(env);

  // SYNTAX, before anything reads a path. A name that is not a plain key cannot
  // be a traversal, cannot leave the manifests directory, and — because nothing
  // downstream builds a program from it — cannot be code either.
  if (!CONNECTOR_KEY.test(connector)) {
    throw new SelectionError(
      `connector '${connector}' is not a valid connector key (expected ${CONNECTOR_KEY})`,
    );
  }

  const publishableConnector = PUBLISHABLE_BY_KEY.get(connector);
  if (!publishableConnector) {
    throw new SelectionError(`connector '${connector}' is not in the publish allowlist`);
  }

  // The global membership check above makes an excluded dispatch refuse rather
  // than silently skipping every matrix leg. A valid target outside this leg
  // skips without reading any manifest.
  if (connector !== matrixConnector) {
    return { selected: false, reason: `run targets '${connector}'; this leg is '${matrixConnector}'` };
  }

  // Only now is a path constructed, and only from a name that is both
  // well-formed and allowlisted.
  const manifestVersion = readManifestVersion(connector, { cwd });

  // A tag that disagrees with the manifest is the mistake that cannot be undone
  // after the fact: an OCI tag can technically be overwritten, but a digest that
  // consumers have already pinned and verified cannot be recalled.
  if (taggedVersion !== null && taggedVersion !== manifestVersion) {
    throw new SelectionError(
      `tag implies ${connector} version '${taggedVersion}' but the manifest declares '${manifestVersion}'`,
    );
  }
  if (env.MATRIX_VERSION && env.MATRIX_VERSION !== manifestVersion) {
    throw new SelectionError(
      `selected matrix version '${env.MATRIX_VERSION}' disagrees with the manifest '${manifestVersion}'`,
    );
  }

  const owner = (env.GITHUB_REPOSITORY_OWNER || "").toLowerCase();
  if (!owner) {
    throw new SelectionError("GITHUB_REPOSITORY_OWNER is not set — cannot build the GHCR repository");
  }

  return {
    selected: true,
    connector,
    manifest: publishableConnector.manifest,
    version: manifestVersion,
    repository: `ghcr.io/${owner}/connector/${connector}`,
  };
}

function emit(outputs) {
  const text = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, text);
  } else {
    process.stdout.write(text);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = selectPublishTarget();
    if (!result.selected) {
      emit({ selected: "false" });
      console.log(`${result.reason} — skipping.`);
    } else {
      emit({
        selected: "true",
        connector: result.connector,
        manifest: result.manifest,
        version: result.version,
        repository: result.repository,
      });
      console.log(`publishing ${result.connector} ${result.version} to ${result.repository}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    console.error(`publish selection refused: ${error.message}`);
    process.exit(1);
  }
}

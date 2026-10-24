// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_SCAFFOLD_CONNECTORS } from "../packages/polyfill-connectors/src/connector-conformance-roster.ts";
import { assertPublishableRow } from "./assert-publishable-readiness.mjs";
import { PUBLISH_EXCLUSIONS, PUBLISHABLE_CONNECTORS } from "./connector-publish-allowlist.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every publishable connector passes, and the CLI reports the same set", () => {
  for (const row of PUBLISHABLE_CONNECTORS) {
    assert.doesNotThrow(() => assertPublishableRow(row), row.connectorKey);
  }
  const result = spawnSync(process.execPath, ["scripts/assert-publishable-readiness.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${PUBLISHABLE_CONNECTORS.length} connectors pass`));
});

test("a known scaffold is refused by directory or by public key, whatever the other name claims", () => {
  for (const row of [
    { manifest: "loom", connectorKey: "loom", exclusionReason: null },
    { manifest: "loom", connectorKey: "amazon" },
    { manifest: "amazon", connectorKey: "loom" },
    { manifest: "loom", connectorKey: "loom-copy" },
  ]) {
    assert.throws(
      () => assertPublishableRow(row),
      /refusing to publish known scaffold connector/,
      JSON.stringify(row),
    );
  }
});

test("WholeFoods is refused on exclusion policy alone, because it is no longer a scaffold", () => {
  assert.equal(KNOWN_SCAFFOLD_CONNECTORS.includes("wholefoods"), false);
  assert.throws(
    () => assertPublishableRow({ manifest: "wholefoods", connectorKey: "wholefoods", exclusionReason: null }),
    /refusing to publish excluded connector 'wholefoods'/,
  );
});

test("every excluded inventory entry is refused even when the row claims it is publishable", () => {
  assert.ok(PUBLISH_EXCLUSIONS.length > 0);
  for (const { manifest, connectorKey } of PUBLISH_EXCLUSIONS) {
    assert.throws(
      () => assertPublishableRow({ manifest, connectorKey, exclusionReason: null }),
      /refusing to publish/,
      connectorKey,
    );
  }
});

test("a spoofed directory or key cannot borrow another connector's identity", () => {
  for (const row of [
    { manifest: "apple_photos", connectorKey: "photos" },
    { manifest: "photos", connectorKey: "apple-photos" },
    { manifest: "amazon", connectorKey: "apple-photos" },
  ]) {
    assert.throws(
      () => assertPublishableRow(row),
      /identity does not match the publish inventory/,
      JSON.stringify(row),
    );
  }
});

test("ordinary underscore-to-hyphen identities and unknown synthetic fixtures pass", () => {
  for (const row of [
    { manifest: "apple_photos", connectorKey: "apple-photos", exclusionReason: null },
    { manifest: "google_calendar", connectorKey: "google-calendar" },
    { manifest: "source_name", connectorKey: "public-name" },
  ]) {
    assert.doesNotThrow(() => assertPublishableRow(row), JSON.stringify(row));
  }
});

test("malformed rows and undeclared exclusions are refused", () => {
  for (const row of [
    undefined,
    { manifest: "Apple-Photos", connectorKey: "apple-photos" },
    { manifest: "apple_photos", connectorKey: "apple_photos" },
    { manifest: 7, connectorKey: "seven" },
    { manifest: "", connectorKey: "empty" },
    { manifest: "synthetic", connectorKey: "synthetic", exclusionReason: "" },
    { manifest: "synthetic", connectorKey: "synthetic", exclusionReason: "held pending evidence" },
  ]) {
    assert.throws(() => assertPublishableRow(row), /refusing to publish/, JSON.stringify(row));
  }
});

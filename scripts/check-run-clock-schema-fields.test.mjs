// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { checkRepository, findForbiddenProperties, inspectManifest, validateAllowlist } from "./check-run-clock-schema-fields.mjs";

const emptyAllowlist = new Map();
const manifestPath = "connectors/example/manifest.json";
const runClockSchema = (field) => ({ type: "object", properties: { [field]: { type: "string" } } });
const manifest = (schema, extras = {}) => ({
  streams: [{ name: "records", schema, ...extras }],
});

function fixtureRepo(t, contents = {}) {
  const root = mkdtempSync(join(tmpdir(), "run-clock-schema-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "connectors/example"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/allowlist.json"), JSON.stringify(contents.allowlist ?? []));
  writeFileSync(join(root, "connectors/example/manifest.json"), contents.manifest ?? JSON.stringify(manifest(runClockSchema("fetched_at"))));
  if (contents.evidencePath) {
    mkdirSync(join(root, "connectors/example"), { recursive: true });
    writeFileSync(join(root, contents.evidencePath), "// reviewed gate test\n");
  }
  return root;
}

function allowedEntry(overrides = {}) {
  return {
    connector: "example",
    stream: "records",
    propertyPath: "schema/properties/fetched_at",
    rationale: "The connector emits a provider-owned timestamp only after an explicit stable-value gate.",
    emitSideEvidence: {
      path: "connectors/example/record.test.ts",
      test: "run-clock field is stable across repeated emits",
      reviewedBy: "connector-maintainer",
    },
    ...overrides,
  };
}

test("rejects every exact forbidden name, even when compaction_fingerprint declares it", () => {
  for (const name of ["fetched_at", "synced_at", "scraped_at", "collected_at", "retrieved_at", "crawled_at"]) {
    const findings = inspectManifest(manifest(runClockSchema(name), {
      compaction_fingerprint: { exclude_keys: [name] },
    }), "example", manifestPath, emptyAllowlist);
    assert.equal(findings.length, 1, name);
    assert.equal(findings[0].propertyPath, `schema/properties/${name}`);
  }
});

test("accepts legitimate timestamps and metrics with similar meanings", () => {
  const schema = {
    type: "object",
    properties: Object.fromEntries(["created_at", "updated_at", "score", "observed_on"].map((key) => [key, { type: "string" }])),
  };
  assert.deepEqual(inspectManifest(manifest(schema), "example", manifestPath, new Map()), []);
});

test("finds nested array and composition properties with an actionable schema path", () => {
  const schema = {
    type: "object",
    properties: {
      events: { type: "array", items: { anyOf: [runClockSchema("retrieved_at")] } },
    },
  };
  const findings = findForbiddenProperties(schema, `${manifestPath}#/streams/0`);
  assert.deepEqual(findings, [{
    propertyPath: "properties/events/items/anyOf/0/properties/retrieved_at",
    schemaPath: "/properties/events/items/anyOf/0/properties/retrieved_at",
  }]);
});

test("follows local schema references", () => {
  const schema = {
    type: "object",
    properties: { data: { $ref: "#/$defs/payload" } },
    $defs: { payload: runClockSchema("crawled_at") },
  };
  const findings = findForbiddenProperties(schema, manifestPath);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].propertyPath, "$defs/payload/properties/crawled_at");
});

test("allowlist is exact, reviewed, and becomes stale when the matching field disappears", (t) => {
  const entry = allowedEntry();
  const root = fixtureRepo(t, { allowlist: [entry], evidencePath: entry.emitSideEvidence.path });
  assert.deepEqual(checkRepository(root, join(root, "scripts/allowlist.json")), []);
  const changed = manifest({ type: "object", properties: { synced_at: { type: "string" } } });
  writeFileSync(join(root, "connectors/example/manifest.json"), JSON.stringify(changed));
  assert.throws(() => checkRepository(root, join(root, "scripts/allowlist.json")), /stale exception/);
});

test("an exact exception cannot suppress a different stream or property", (t) => {
  const entry = allowedEntry();
  const root = fixtureRepo(t, { allowlist: [entry], evidencePath: entry.emitSideEvidence.path });
  writeFileSync(join(root, "connectors/example/manifest.json"), JSON.stringify({
    streams: [
      { name: "records", schema: runClockSchema("fetched_at") },
      { name: "other", schema: runClockSchema("synced_at") },
    ],
  }));
  assert.deepEqual(checkRepository(root, join(root, "scripts/allowlist.json")), [{
    connector: "example",
    stream: "other",
    propertyPath: "schema/properties/synced_at",
    manifestPath: "connectors/example/manifest.json",
    schemaPath: "/properties/synced_at",
  }]);
});

test("allowlist rejects wildcards, weak rationale, and incomplete emit evidence", () => {
  assert.throws(() => validateAllowlist([allowedEntry({ propertyPath: "schema/properties/*" })]), /exact schema path/);
  assert.throws(() => validateAllowlist([allowedEntry({ propertyPath: "schema\u002f$defs/payload/properties/created_at" })]), /exact schema path/);
  assert.throws(() => validateAllowlist([allowedEntry({ emitSideEvidence: {
    path: "connectors/example/../other.test.ts",
    test: "test",
    reviewedBy: "reviewer",
  } })]), /checked-in test/);
  assert.throws(() => validateAllowlist([allowedEntry({ rationale: "allow this" })]), /substantive context/);
  assert.throws(() => validateAllowlist([allowedEntry({ emitSideEvidence: { path: "connectors/example/record.test.ts" } })]), /path, test, and reviewedBy/);
  assert.throws(() => validateAllowlist([allowedEntry(), allowedEntry()]), /duplicate allowlist/);
});

test("malformed manifest JSON exits with input-error status and path", (t) => {
  const root = fixtureRepo(t, { manifest: "{ nope" });
  const script = new URL("./check-run-clock-schema-fields.mjs", import.meta.url).pathname;
  const cli = spawnSync(process.execPath, [script, "--root", root, "--allowlist", join(root, "scripts/allowlist.json")], { encoding: "utf8" });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /connectors\/example\/manifest\.json: cannot parse manifest JSON/);
  assert.throws(() => checkRepository(root, join(root, "scripts/allowlist.json")), /cannot parse manifest JSON/);
});

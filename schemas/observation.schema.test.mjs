// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const root = join(schemaDir, "..");
const schema = JSON.parse(readFileSync(join(schemaDir, "observation.schema.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(schemaDir, "fixtures/observation-corpus.json"), "utf8"));
const profile = readFileSync(join(root, "docs/spec/collection-profile.md"), "utf8");

const ajv = new Ajv({ strict: true, allErrors: true });
ajv.addSchema(schema);
const validateObservation = ajv.getSchema(schema.$id);
const validateDescriptors = ajv.compile({ $ref: `${schema.$id}#/$defs/diagnosticDescriptors` });

/** The text of one section, from its heading to the next heading of any level. */
function section(heading) {
  const start = profile.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `profile must contain ${heading}`);
  const rest = profile.slice(start + heading.length + 2);
  const end = rest.search(/^#{2,4} /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Rows of the first table in `text`, as arrays of trimmed cells. */
function tableRows(text) {
  const table = text.match(/\n\|[^\n]*\|\n\| *-[^\n]*\|\n((?:\|[^\n]*\|\n)+)/);
  assert.ok(table, "section must contain a table");
  return table[1]
    .split("\n")
    .filter((row) => row.trim().length > 0)
    .map((row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim()));
}

function firstJsonBlock(text) {
  const block = text.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(block, "section must contain a JSON example");
  return JSON.parse(block[1]);
}

test("the OBSERVATION schema compiles in strict mode", () => {
  assert.equal(typeof validateObservation, "function");
});

test("the shared corpus: every valid case passes and every schema-checkable invalid case fails", () => {
  for (const message of corpus.valid) {
    assert.equal(validateObservation(message), true, `${JSON.stringify(message)}: ${JSON.stringify(validateObservation.errors)}`);
  }
  for (const { rule, message, runtime_only: runtimeOnly } of corpus.invalid) {
    if (runtimeOnly) {
      continue;
    }
    assert.equal(validateObservation(message), false, `expected rejection (${rule}): ${JSON.stringify(message)}`);
  }
});

test("the spec's OBSERVATION and diagnostic_descriptors examples validate", () => {
  assert.equal(validateObservation(firstJsonBlock(section("### 5.10 `OBSERVATION`"))), true);
  const example = firstJsonBlock(section("### 3.8 Diagnostic descriptors"));
  assert.equal(validateDescriptors(example.diagnostic_descriptors), true, JSON.stringify(validateDescriptors.errors));
});

test("the connector facts in the spec's fact table are exactly the schema's fact types", () => {
  const rows = tableRows(section("#### 5.10.1 Facts in this version"));
  const bySource = (source) =>
    rows
      .filter((cells) => cells[1] === source)
      .map((cells) => {
        const key = cells[0].match(/^`([a-z_]+)`$/);
        assert.ok(key, `fact cell must be one code span: ${cells[0]}`);
        return key[1];
      })
      .sort();
  assert.equal(rows.length, bySource("connector").length + bySource("runtime").length, "every row is connector or runtime");
  assert.deepEqual(bySource("connector"), [...schema.$defs.observation.properties.fact.enum].sort());
  for (const runtimeFact of bySource("runtime")) {
    assert.equal(schema.$defs.observation.properties.fact.enum.includes(runtimeFact), false, runtimeFact);
  }
});

test("the spec's element states are exactly the schema's", () => {
  const states = [...section("#### 5.10.1 Facts in this version").matchAll(/^- `([a-z]+)`:/gm)].map((m) => m[1]);
  assert.deepEqual(states, schema.$defs.elementState.enum);
});

test("the profile's conformance cases preserve obligation and recovery debt rules", () => {
  const deletionRules = section("#### 5.8.1 Explicit deletes before a later failure").replace(/\s+/g, " ");
  assert.match(
    deletionRules,
    /A delete derived from absence MUST be based on the original\s+`kind:"inventory"` obligation for that exact parent and relationship,\s+and source\s+evidence that the full child enumeration for that obligation closed/,
  );
  assert.match(deletionRules, /A delta MUST NOT infer a delete from absence,\s+including omission from a closed or empty delta/);

  const debtRules = section("#### 5.6.2 Outcomes and durable debt").replace(/\s+/g, " ");
  assert.match(debtRules, /MUST retain the original debt until a fresh seal proves the full original\s+obligation under Section 5\.6\.6/);
  assert.match(debtRules, /partial recovery MUST NOT settle the original debt or replace it with residual\s+obligations/);

  const cases = section("### 6.3 Strict-accounting conformance cases");
  assert.match(cases, /\| Closed empty delta omits retained child C \| Keep C; do not infer a delete from delta absence\./);
  assert.match(
    cases,
    /\| Recovery fully reads a valid upsert, but the eligible checkpoint commit fails \| Keep the admitted upsert durable and preserve outstanding debt;/,
  );
  assert.match(
    cases,
    /\| Recovery covers only part of a time-range gap \| Retain the original debt; 0\.3\.0 defines no residual replacement or settlement\./,
  );
});

test("the profile preserves strict 0.3.0 accounting alongside elective store coverage", () => {
  const placement = section("### 3.4 Human interaction and protocol capabilities").replace(/\s+/g, " ");
  assert.match(placement, /DETAIL_GAP, DETAIL_COVERAGE and OBSERVATION are mandatory runtime features of 0\.3\.0/);
  assert.match(placement, /Strict accounting MUST NOT depend on a per-feature capability, advisory flag, START capability list, message-content opt-in, or connector-side fold/);
  assert.match(placement, /unsupported required capability before spawn, except for `RUN_COVERAGE_V1` when the runtime implements the elective exception in Section 7\.1/);
  assert.match(placement, /This exception MUST NOT weaken mandatory 0\.3\.0 accounting or diagnosis/);
  assert.doesNotMatch(placement, /A connector that does not declare `?OBSERVATION`?/);

  const extension = section("### 7.1 Store collection evidence (RUN_COVERAGE_V1)").replace(/\s+/g, " ");
  assert.match(extension, /protocol_version is 0\.1\.0, 0\.2\.0 or 0\.3\.0/);
  assert.match(extension, /It MUST omit `START\.run_coverage_version`, and the connector MUST omit `DONE\.coverage`/);
  const negotiation = section("#### 7.1.1 Declaration and negotiation").replace(/\s+/g, " ");
  assert.match(negotiation, /When `START` omits `run_coverage_version`, a connector MUST omit `DONE\.coverage`/);
  const evidence = section("#### 7.1.2 Optional terminal store collection evidence").replace(/\s+/g, " ");
  assert.match(evidence, /`DONE\.coverage` MUST NOT authorize STATE advancement, materialization receipts, debt settlement or absence-derived deletion/);
  assert.match(evidence, /under 0\.3\.0, debt settlement still requires Sections 5\.6\.2, 5\.6\.3 and 5\.6\.6/);
  assert.match(evidence, /pending seals remain debt until commit/);
  const accounting = section("#### 7.1.5 Accounting under the base profile").replace(/\s+/g, " ");
  assert.match(accounting, /Section 5\.6 of the applicable base profile/);
  assert.match(accounting, /same-obligation identity and range refer to Section 5\.6\.1; baseline validity and admission invalidation follow Section 5\.6\.3/);
  assert.match(accounting, /mandatory accounting and outcome checks of Sections 5\.6\.2 through 5\.6\.6, including portable recovery seals where applicable/);

  const runtimeExtensions = section("### 7.2 Runtime-specific extensions").replace(/\s+/g, " ");
  assert.match(runtimeExtensions, /Portable DETAIL_GAP_RECOVERED and START\.detail_debts are instead defined by Section 5\.6\.6/);
  assert.match(runtimeExtensions, /gap_id-only acknowledgments\) are not aliases for this typed seal/);
  const cases = section("### 6.3 Strict-accounting conformance cases");
  assert.match(cases, /\| Transient sub-resource failure, then recovery at the same epoch \|[^\n]*While a candidate remains partial, preserve the stored row\. A fully read valid record follows normal effect-admission rules;/);
});

function connectorManifests() {
  const connectorsDir = join(root, "connectors");
  return readdirSync(connectorsDir)
    .map((name) => join(connectorsDir, name, "manifest.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(path, "utf8")) }));
}

test("every manifest's diagnostic_descriptors validates and names only declared steps", () => {
  for (const { path, manifest } of connectorManifests()) {
    const descriptors = manifest.diagnostic_descriptors;
    if (descriptors === undefined) {
      continue;
    }
    assert.equal(validateDescriptors(descriptors), true, `${path}: ${JSON.stringify(validateDescriptors.errors)}`);
    const steps = new Set((descriptors.steps ?? []).map((step) => step.id));
    for (const member of ["steps", "expectations", "rules"]) {
      const ids = (descriptors[member] ?? []).map((entry) => entry.id);
      assert.equal(new Set(ids).size, ids.length, `${path}: duplicate ${member} id`);
    }
    for (const entry of [...(descriptors.expectations ?? []), ...(descriptors.rules ?? [])]) {
      assert.ok(entry.step === undefined || steps.has(entry.step), `${path}: ${entry.id} names an undeclared step`);
    }
  }
});

test("a manifest that uses the 0.2.0 diagnostic members declares protocol_version 0.2.0", () => {
  for (const { path, manifest } of connectorManifests()) {
    const usesObservation = (manifest.protocol_capabilities ?? []).includes("OBSERVATION");
    if (usesObservation || manifest.diagnostic_descriptors !== undefined) {
      assert.equal(manifest.protocol_version, "0.2.0", path);
    }
  }
});

test("the profile states its version as 0.3.0", () => {
  assert.match(profile, /^# PDPP Collection Profile v0\.3\.0$/m);
});

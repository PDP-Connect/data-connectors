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

test("the profile states its version as 0.2.0", () => {
  assert.match(profile, /^# PDPP Collection Profile v0\.2\.0$/m);
});

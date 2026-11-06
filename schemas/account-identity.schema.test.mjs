// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv from "ajv/dist/2020.js";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const root = join(schemaDir, "..");
const messageSchema = JSON.parse(readFileSync(join(schemaDir, "account-identity.schema.json"), "utf8"));
const manifestSchema = JSON.parse(readFileSync(join(schemaDir, "connector-manifest.schema.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(schemaDir, "fixtures/account-identity-corpus.json"), "utf8"));
const profile = readFileSync(join(root, "docs/spec/collection-profile.md"), "utf8");

const ajv = new Ajv({ strict: true, allErrors: true });
const validateMessage = ajv.compile(messageSchema);
const validateManifest = new Ajv({ strict: true, allErrors: true }).compile(manifestSchema);

function connectorManifests() {
  const connectorsDir = join(root, "connectors");
  return readdirSync(connectorsDir)
    .map((name) => ({ name, path: join(connectorsDir, name, "manifest.json") }))
    .filter(({ path }) => existsSync(path))
    .map(({ name, path }) => ({ name, manifest: JSON.parse(readFileSync(path, "utf8")) }));
}

test("the ACCOUNT_IDENTITY schema compiles in strict mode", () => {
  assert.equal(typeof validateMessage, "function");
});

test("the shared corpus: every valid case passes and every invalid case fails", () => {
  for (const message of corpus.valid) {
    assert.equal(validateMessage(message), true, `${JSON.stringify(message)}: ${JSON.stringify(validateMessage.errors)}`);
  }
  for (const { rule, message } of corpus.invalid) {
    assert.equal(validateMessage(message), false, `expected rejection (${rule}): ${JSON.stringify(message)}`);
  }
});

test("account_id is accepted at 256 characters and rejected at 257", () => {
  assert.equal(validateMessage({ type: "ACCOUNT_IDENTITY", account_id: "a".repeat(256) }), true);
  assert.equal(validateMessage({ type: "ACCOUNT_IDENTITY", account_id: "a".repeat(257) }), false);
});

test("the profile example message validates", () => {
  const section = profile.split(/^### 5\.14 `ACCOUNT_IDENTITY`$/m)[1]?.split(/^## 6\. /m)[0];
  assert.ok(section, "profile must contain Section 5.14");
  const example = section.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(example, "Section 5.14 must contain a JSON example");
  assert.equal(validateMessage(JSON.parse(example[1])), true);
});

test("the profile states the declaration, the host check and the single-message rule", () => {
  const section = profile.split(/^### 5\.14 `ACCOUNT_IDENTITY`$/m)[1]?.split(/^## 6\. /m)[0] ?? "";
  assert.match(section, /MUST NOT emit it unless its manifest declares\s+`account_identity: "required"`/);
  assert.match(section, /A runtime MUST fail a run for a connector that declares/);
  assert.match(section, /second\s+`ACCOUNT_IDENTITY` in one run as a protocol violation/);
  assert.match(section, /MUST NOT add a connector-specific prefix, hash the id/);
});

test("the manifest member accepts only the value required", () => {
  assert.equal(validateManifest({ account_identity: "required" }), true);
  assert.equal(validateManifest({}), true, "absence means no declaration");
  for (const value of ["optional", "Required", true, false, null, "", ["required"], { required: true }]) {
    assert.equal(validateManifest({ account_identity: value }), false, `expected rejection of ${JSON.stringify(value)}`);
  }
});

test("the profile lists account_identity among the manifest members", () => {
  assert.match(profile, /\| `account_identity` \| OPTIONAL\. The only value is `"required"`/);
});

test("every connector manifest that declares account_identity validates", () => {
  for (const { name, manifest } of connectorManifests()) {
    if (!Object.hasOwn(manifest, "account_identity")) {
      continue;
    }
    assert.equal(manifest.account_identity, "required", `${name}: account_identity must be "required" or omitted`);
    assert.equal(validateManifest(manifest), true, `${name}: ${JSON.stringify(validateManifest.errors)}`);
  }
});

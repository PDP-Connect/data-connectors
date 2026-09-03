// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(schemaDir, "connector-index.schema.json"), "utf8"));
const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
const digest = `sha256:${"a".repeat(64)}`;

function documentWith(entry) {
  return {
    indexVersion: "2.0",
    sourceRepo: "https://github.com/PDP-Connect/data-connectors",
    generatedAt: "2026-07-30T00:00:00.000Z",
    brandIcons: {},
    connectors: { synthetic: [entry] },
  };
}

function baseEntry(overrides = {}) {
  return {
    connectorId: "synthetic",
    company: "Synthetic",
    version: "1.0.0",
    name: "Synthetic",
    description: "Synthetic test entry",
    publishedAt: "2026-07-30T00:00:00.000Z",
    sourceTag: "main",
    sourceCommit: "a".repeat(40),
    releaseId: "test",
    manifestSha256: digest,
    artifactSha256: digest,
    artifactUrl: "https://example.test/synthetic.tgz",
    ...overrides,
  };
}

test("index schema accepts the PDPP shape and preserves legacy requirements", () => {
  const checkedInIndex = JSON.parse(
    readFileSync(join(schemaDir, "..", "connector-index.json"), "utf8"),
  );
  assert.equal(validate(checkedInIndex), true, JSON.stringify(validate.errors));

  const legacy = baseEntry({
    sourceFiles: { metadata: "synthetic.json", script: "synthetic.js" },
    scriptSha256: digest,
  });
  assert.equal(validate(documentWith(legacy)), true, JSON.stringify(validate.errors));

  const pdpp = baseEntry({
    artifactKind: "pdpp-collection-profile",
    manifestPath: "profile/collection-profile.json",
    entrypointPath: "dist/profile.cjs",
    entrypointSha256: digest,
    provenancePath: "provenance.json",
    provenanceSha256: digest,
  });
  assert.equal(validate(documentWith(pdpp)), true, JSON.stringify(validate.errors));

  const legacyWithoutScriptDigest = { ...legacy };
  delete legacyWithoutScriptDigest.scriptSha256;
  assert.equal(validate(documentWith(legacyWithoutScriptDigest)), false);

  const bundlePathCases = [
    ["profile/collection-profile.json", true],
    [".", false],
    ["profile/\0collection-profile.json", false],
    ["/outside.cjs", false],
    ["C:relative.cjs", false],
    ["C:/outside.cjs", false],
    ["dist\\outside.cjs", false],
    ["dist/../outside.cjs", false],
  ];
  for (const [path, accepted] of bundlePathCases) {
    for (const field of ["manifestPath", "entrypointPath", "provenancePath"]) {
      assert.equal(
        validate(documentWith({ ...pdpp, [field]: path })),
        accepted,
        `${field}=${JSON.stringify(path)} schema validity`,
      );
    }
  }
  assert.equal(
    validate(documentWith({ ...pdpp, artifactKind: "future-kind" })),
    false,
  );
});

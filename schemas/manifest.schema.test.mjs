// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";

const schemaDir = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(readFileSync(join(schemaDir, "manifest.schema.json"), "utf8"));
const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);

function manifestWith(brand) {
  return {
    manifest_version: "1.0",
    connector_id: "synthetic-playwright",
    source_id: "synthetic",
    version: "1.0.0",
    name: "Synthetic",
    company: "Synthetic",
    description: "Synthetic connector",
    runtime: "playwright",
    page_api_version: 1,
    connect_url: "https://example.test",
    connect_selector: "#signed-in",
    scopes: ["synthetic.records"],
    brand,
  };
}

test("manifest schema defines a relative brand icon with optional dark variant", () => {
  assert.equal(
    validate(manifestWith({
      icon: "icons/synthetic.svg",
      dark_icon: "icons/synthetic-dark.svg",
      background_color: "#112233",
    })),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(validate(manifestWith({})), false, "brand.icon is required");
  for (const icon of ["/icons/synthetic.svg", "icons\\synthetic.svg", "../synthetic.svg", "icons/synthetic.png"]) {
    assert.equal(validate(manifestWith({ icon })), false, `${icon} is not a local SVG asset path`);
  }
  assert.equal(
    validate(manifestWith({ icon: "icons/synthetic.svg", color: "blue" })),
    false,
    "brand rejects undeclared presentation fields",
  );
});

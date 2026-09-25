// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The normative-shape gate itself: schema + semantics for the PDPP
 * SourceDeclaration, and the manifest-to-declaration derivation both the
 * builder and both verifiers share.
 *
 * The negative case in "rejects the previously-shipped provenance-like
 * object" is not a hypothetical: it is the literal shape
 * scripts/build-connector-oci-artifact.mjs emitted before this fix
 * (connector_key/connector_id/version/source.repository/canonical_inputs
 * instead of a real SourceDeclaration), reproduced here so a regression back
 * to that shape fails a test rather than only a review.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { buildSourceDeclaration, validateSourceDeclaration } from "./source-declaration.mjs";

const validProfile = {
  connector_key: "oura",
  connector_id: "https://registry.pdpp.dev/connectors/oura",
  version: "0.1.3",
  display_name: "Oura",
  streams: [
    {
      name: "sleep",
      description: "Daily sleep sessions.",
      display: { label: "Your sleep sessions", detail: "Per-night sleep detail." },
      semantics: "mutable_state",
      schema: {
        type: "object",
        properties: { id: { type: "string" }, day: { type: "string", format: "date" } },
        required: ["id", "day"],
      },
      primary_key: ["id"],
      cursor_field: "day",
      consent_time_field: "day",
      selection: { fields: true, resources: true },
      // Collection-Profile-only members a real manifest carries alongside
      // the Core members above; the declaration must not inherit them.
      required: true,
      incremental: true,
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    },
  ],
};

describe("buildSourceDeclaration", () => {
  it("derives a schema- and semantics-valid SourceDeclaration from a Collection Profile manifest", () => {
    const declaration = buildSourceDeclaration(validProfile);
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  it("carries the manifest's own facts, not invented ones", () => {
    const declaration = buildSourceDeclaration(validProfile);
    assert.equal(declaration.source.kind, "connector");
    assert.equal(declaration.source.id, validProfile.connector_id);
    assert.equal(declaration.display.name, validProfile.display_name);
    assert.equal(declaration.declaration_version, validProfile.version);
    assert.equal(declaration.streams[0].name, "sleep");
    assert.deepEqual(declaration.streams[0].primary_key, ["id"]);
  });

  it("carries Core relationship and view members that query semantics depend on", () => {
    const profile = structuredClone(validProfile);
    profile.streams.push({
      name: "samples",
      semantics: "mutable_state",
      schema: {
        type: "object",
        properties: { id: { type: "string" }, sleep_id: { type: "string" } },
        required: ["id", "sleep_id"],
      },
      primary_key: ["id"],
      selection: { fields: true, resources: true },
    });
    profile.streams[0].relationships = [
      { cardinality: "has_many", foreign_key: "sleep_id", name: "samples", stream: "samples" },
    ];
    profile.streams[0].query = { expand: [{ name: "samples", default_limit: 10, max_limit: 50 }] };
    profile.streams[0].views = [{ fields: ["id", "day"], id: "summary", label: "Summary" }];
    const declaration = buildSourceDeclaration(profile);
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.deepEqual(declaration.streams[0].relationships, profile.streams[0].relationships);
    assert.deepEqual(declaration.streams[0].views, profile.streams[0].views);
  });

  it("drops Collection-Profile-only stream members the Core schema forbids", () => {
    const declaration = buildSourceDeclaration(validProfile);
    const stream = declaration.streams[0];
    for (const forbidden of ["required", "incremental", "coverage_strategy", "freshness_strategy"]) {
      assert.equal(Object.hasOwn(stream, forbidden), false, `stream must not carry '${forbidden}'`);
    }
  });

  it("is deterministic: the same manifest always derives the same declaration", () => {
    assert.deepEqual(buildSourceDeclaration(validProfile), buildSourceDeclaration(validProfile));
  });
});

describe("validateSourceDeclaration — positive", () => {
  it("accepts a minimal valid declaration with every optional member present", () => {
    const declaration = {
      declaration_version: "1",
      display: { name: "Example" },
      protocol_version: "0.1.0",
      publisher: { id: "https://github.com/PDP-Connect" },
      selection_presets: [{ id: "basic", label: "Basic", streams: [{ name: "issues" }] }],
      source: { kind: "connector", id: "https://registry.pdpp.dev/connectors/example" },
      streams: [
        {
          name: "issues",
          semantics: "mutable_state",
          schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          primary_key: ["id"],
          selection: { fields: true, resources: true },
        },
      ],
    };
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });
});

describe("validateSourceDeclaration — negative", () => {
  it("rejects the previously-shipped provenance-like object (the P0 regression this fix closes)", () => {
    // The exact shape scripts/build-connector-oci-artifact.mjs used to emit.
    const provenanceLookalike = {
      declaration_version: "1.0",
      connector_key: "oura",
      connector_id: "https://registry.pdpp.dev/connectors/oura",
      version: "0.1.3",
      source: {
        repository: "https://github.com/PDP-Connect/data-connectors",
        revision: "8f06ae60b60daf8b4ba74ca95dacbd5d96ef50c9",
        package: "connectors/oura",
      },
      canonical_inputs: {
        manifest: { path: "connectors/oura/manifest.json", sha256: "sha256:deadbeef" },
        source_inventory: [],
      },
    };
    const result = validateSourceDeclaration(provenanceLookalike);
    assert.equal(result.ok, false);
    // Missing every required Core member...
    for (const missing of ["protocol_version", "publisher", "display", "streams"]) {
      assert.ok(
        result.errors.some((error) => error.includes(missing)),
        `expected an error mentioning '${missing}', got: ${result.errors.join("; ")}`,
      );
    }
  });

  it("rejects a declaration missing protocol_version", () => {
    const declaration = buildSourceDeclaration(validProfile);
    delete declaration.protocol_version;
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects a declaration whose source is not {kind, id}", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.source = { repository: "https://github.com/PDP-Connect/data-connectors" };
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects a declaration with additional top-level properties", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.canonical_inputs = { manifest: { sha256: "sha256:x" } };
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects an empty streams array", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams = [];
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects a stream primary_key referencing a field the schema does not declare", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams[0].primary_key = ["not_a_real_field"];
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("source.declaration.unknown_schema_field")));
  });

  it("rejects duplicate stream names", () => {
    const declaration = buildSourceDeclaration(validProfile);
    // A distinct object (different schema) with the same `name`, so this
    // exercises the semantic duplicate-name check rather than the schema's
    // unrelated `uniqueItems` check on byte-identical stream objects.
    declaration.streams.push({
      ...declaration.streams[0],
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    });
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("source.declaration.duplicate_stream_name")));
  });

  it("rejects a wildcard stream name", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams[0].name = "*";
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects publisher.id that is not a URI", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.publisher = { id: "not-a-uri" };
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects a protocol_version other than 0.1.0", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.protocol_version = "0.2.0";
    assert.equal(validateSourceDeclaration(declaration).ok, false);
  });

  it("rejects nonlocal $ref and $dynamicRef values in embedded stream schemas", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams[0].schema.properties.remote = { $ref: "https://example.com/schema.json" };
    declaration.streams[0].schema.properties.dynamic = { $dynamicRef: "shared-schema" };
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("source.declaration.nonlocal_schema_reference")));
  });

  it("rejects query fields whose JSON Schema type does not support the requested capability", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams[0].schema.properties.score = { type: "number" };
    declaration.streams[0].schema.properties.label = { type: "string" };
    declaration.streams[0].query = {
      aggregations: { group_by_time: ["label"], sum: ["label"] },
      range_filters: { label: ["gte"] },
      search: { lexical_fields: ["score"] },
    };
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("source.declaration.invalid_query_field_type")));
  });

  it("rejects duplicate expand relationship names", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams.push({
      name: "samples",
      semantics: "mutable_state",
      schema: {
        type: "object",
        properties: { id: { type: "string" }, sleep_id: { type: "string" } },
        required: ["id", "sleep_id"],
      },
      primary_key: ["id"],
      selection: { fields: true, resources: true },
    });
    declaration.streams[0].relationships = [
      { cardinality: "has_many", foreign_key: "sleep_id", name: "samples", stream: "samples" },
    ];
    declaration.streams[0].query = { expand: [{ name: "samples" }, { name: "samples" }] };
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("source.declaration.duplicate_expand_name")));
  });

  it("rejects expand limits on has_one relationships", () => {
    const declaration = buildSourceDeclaration(validProfile);
    declaration.streams[0].schema.properties.profile_id = { type: "string" };
    declaration.streams.push({
      name: "profiles",
      semantics: "mutable_state",
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      primary_key: ["id"],
      selection: { fields: true, resources: true },
    });
    declaration.streams[0].relationships = [
      { cardinality: "has_one", foreign_key: "profile_id", name: "profile", stream: "profiles" },
    ];
    declaration.streams[0].query = { expand: [{ name: "profile", default_limit: 1 }] };
    const result = validateSourceDeclaration(declaration);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.includes("source.declaration.invalid_expand_limits")));
  });
});


describe("validateSourceDeclaration — connector fleet", () => {
  it("every connector manifest builds a valid SourceDeclaration", () => {
    const connectors = new URL("../../connectors/", import.meta.url);
    const invalid = [];
    for (const key of readdirSync(connectors).sort()) {
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(new URL(`${key}/manifest.json`, connectors), "utf8"));
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
        throw error;
      }
      const result = validateSourceDeclaration(buildSourceDeclaration(manifest));
      if (!result.ok) invalid.push(`${key}: ${result.errors.join("; ")}`);
    }
    assert.deepEqual(invalid, []);
  });
});

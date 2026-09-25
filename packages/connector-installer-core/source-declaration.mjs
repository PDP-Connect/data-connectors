// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate a PDPP `SourceDeclaration` (schema + semantics), so a builder and
 * an installer can refuse the same invalid shape rather than each holding
 * its own idea of what a SourceDeclaration is.
 *
 * The JSON Schema in ./source-declaration-schema-data.mjs is a byte-for-byte
 * copy of `SourceDeclarationSchema` in
 * pdpp/packages/reference-contract/src/public/source.ts (as of commit
 * a3b1902ff5, "spec(source): define declarations and resolved grants (#102)").
 * The semantic checks below port `validateSourceDeclarationSemantics` from
 * the same file. This repo has no package dependency on
 * `@pdpp/reference-contract` — it is a separate repository with no published
 * artifact this one can install — so the contract is vendored rather than
 * imported. Regenerate `source-declaration.schema.json` (and re-port the
 * semantics below) from that file if the normative schema changes; do not
 * hand-edit either into a shape the upstream source does not have.
 */

import Ajv2020 from "ajv/dist/2020.js";
import schema from "./source-declaration-schema-data.mjs";

// The identity this repository's connectors are published under. Not a
// per-connector value: `publisher.id` is a self-declared attribution claim
// (pdpp spec-discovery-and-trust.md: "non-authoritative claim ... not used
// for attribution, source acceptance, redirect approval, or any other trust
// decision" until an out-of-repo binding exists — none does yet, see
// local/captain-0924/w28-oci-declaration-fix.md), so this names the actual
// publishing organisation rather than inventing a per-connector value the
// schema does not ask for.
export const PUBLISHER_ID = "https://github.com/PDP-Connect";

/**
 * The normative PDPP SourceDeclaration for one connector, built only from its
 * Collection Profile manifest — the one canonical description of what a
 * connector collects and how. No field here is invented: every value is
 * either copied from the manifest or, for `publisher.id`, is this
 * repository's own already-established identity (used elsewhere as
 * `provenance.json`'s `source.repository` and pinned as the Sigstore
 * certificate identity below).
 *
 * Shared by the builder (which writes source-declaration.json) and both
 * verifiers (which recompute it independently from the profile they
 * received, to check the layer was not hand-edited or built by a different
 * deriver) — one function, so there is exactly one place that decides how a
 * manifest becomes a SourceDeclaration.
 *
 * Collection-Profile-only stream members (`required`, `incremental`,
 * `coverage_strategy`, `freshness_strategy`) are Collection execution
 * concerns the SourceDeclaration schema's `additionalProperties: false`
 * forbids at the stream level, and the PDPP OpenSpec delta keeps them out of
 * Core by design ("Connector acquisition and execution terms ... SHALL
 * remain outside these Core stream members"), so they are intentionally
 * dropped rather than smuggled in.
 */
export function buildSourceDeclaration(profile) {
  return {
    declaration_version: profile.version,
    display: { name: profile.display_name },
    protocol_version: "0.1.0",
    publisher: { id: PUBLISHER_ID },
    source: { kind: "connector", id: profile.connector_id },
    streams: profile.streams.map((stream) => ({
      ...(stream.description !== undefined ? { description: stream.description } : {}),
      ...(stream.display !== undefined ? { display: stream.display } : {}),
      ...(stream.cursor_field !== undefined ? { cursor_field: stream.cursor_field } : {}),
      ...(stream.consent_time_field !== undefined
        ? { consent_time_field: stream.consent_time_field }
        : {}),
      name: stream.name,
      primary_key: stream.primary_key,
      ...(stream.query !== undefined ? { query: stream.query } : {}),
      schema: stream.schema,
      selection: stream.selection,
      semantics: stream.semantics,
    })),
  };
}

function isUri(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1;
  } catch {
    return false;
  }
}

// `strictRequired: false` because the upstream schema's mutual-exclusion
// idiom — `allOf: [{ not: { required: ["fields", "view"] } }]` on the preset
// stream selection — trips ajv's strict-mode "required property not defined"
// check inside a `not`, which is a false positive for this valid pattern
// (both `fields` and `view` ARE defined as siblings; `not` just makes them
// mutually exclusive). Every other strict check stays on.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
ajv.addFormat("uri", { type: "string", validate: isUri });
const validateSchema = ajv.compile(schema);

function schemaFieldNames(stream) {
  const properties = stream?.schema?.properties;
  if (!(properties && typeof properties === "object" && !Array.isArray(properties))) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

function pushUnknownFields(errors, fields, knownFields, path) {
  for (const field of fields) {
    if (!knownFields.has(field)) {
      errors.push(`${path}: unknown schema field '${field}'`);
    }
  }
}

function validateStreamFieldReferences(stream, streamIndex, errors) {
  const basePath = `/streams/${streamIndex}`;
  const fields = schemaFieldNames(stream);
  pushUnknownFields(errors, stream.primary_key, fields, `${basePath}/primary_key`);
  for (const member of ["cursor_field", "consent_time_field"]) {
    const field = stream[member];
    if (field) pushUnknownFields(errors, [field], fields, `${basePath}/${member}`);
  }
  for (const [viewIndex, view] of (stream.views ?? []).entries()) {
    pushUnknownFields(errors, view.fields, fields, `${basePath}/views/${viewIndex}/fields`);
  }
  const query = stream.query;
  pushUnknownFields(errors, Object.keys(query?.range_filters ?? {}), fields, `${basePath}/query/range_filters`);
  pushUnknownFields(errors, query?.search?.lexical_fields ?? [], fields, `${basePath}/query/search/lexical_fields`);
  pushUnknownFields(errors, query?.search?.semantic_fields ?? [], fields, `${basePath}/query/search/semantic_fields`);
  for (const member of ["count_distinct", "group_by", "group_by_time", "max", "min", "sum"]) {
    pushUnknownFields(errors, query?.aggregations?.[member] ?? [], fields, `${basePath}/query/aggregations/${member}`);
  }
}

function validateUniqueStreamMembers(stream, streamIndex, errors) {
  const viewIds = new Set();
  for (const [viewIndex, view] of (stream.views ?? []).entries()) {
    if (viewIds.has(view.id)) {
      errors.push(`/streams/${streamIndex}/views/${viewIndex}/id: duplicate view id '${view.id}'`);
    }
    viewIds.add(view.id);
  }
  const relationshipNames = new Set();
  for (const [relationshipIndex, relationship] of (stream.relationships ?? []).entries()) {
    if (relationshipNames.has(relationship.name)) {
      errors.push(
        `/streams/${streamIndex}/relationships/${relationshipIndex}/name: duplicate relationship name '${relationship.name}'`,
      );
    }
    relationshipNames.add(relationship.name);
  }
}

function validateRelationships(declaration, streamsByName, errors) {
  for (const [streamIndex, stream] of declaration.streams.entries()) {
    for (const [relationshipIndex, relationship] of (stream.relationships ?? []).entries()) {
      const relatedStream = streamsByName.get(relationship.stream);
      const basePath = `/streams/${streamIndex}/relationships/${relationshipIndex}`;
      if (!relatedStream) {
        errors.push(`${basePath}/stream: unknown stream '${relationship.stream}'`);
        continue;
      }
      const foreignKeyStream = relationship.cardinality === "has_many" ? relatedStream : stream;
      pushUnknownFields(
        errors,
        [relationship.foreign_key],
        schemaFieldNames(foreignKeyStream),
        `${basePath}/foreign_key`,
      );
    }
  }
}

function validatePresets(declaration, streamsByName, errors) {
  const presetIds = new Set();
  for (const [presetIndex, preset] of (declaration.selection_presets ?? []).entries()) {
    if (presetIds.has(preset.id)) {
      errors.push(`/selection_presets/${presetIndex}/id: duplicate preset id '${preset.id}'`);
    }
    presetIds.add(preset.id);
    const presetStreamNames = new Set();
    for (const [selectionIndex, selection] of preset.streams.entries()) {
      const basePath = `/selection_presets/${presetIndex}/streams/${selectionIndex}`;
      if (presetStreamNames.has(selection.name)) {
        errors.push(`${basePath}/name: duplicate stream name '${selection.name}' in preset '${preset.id}'`);
      }
      presetStreamNames.add(selection.name);
      const stream = streamsByName.get(selection.name);
      if (!stream) {
        errors.push(`${basePath}/name: unknown stream '${selection.name}'`);
        continue;
      }
      if (selection.view && !(stream.views ?? []).some((view) => view.id === selection.view)) {
        errors.push(`${basePath}/view: unknown view '${selection.view}'`);
      }
      pushUnknownFields(errors, selection.fields ?? [], schemaFieldNames(stream), `${basePath}/fields`);
    }
  }
}

/** Invariants JSON Schema cannot express, ported from validateSourceDeclarationSemantics. */
function validateSemantics(declaration) {
  const errors = [];
  const streamsByName = new Map();
  for (const [streamIndex, stream] of declaration.streams.entries()) {
    if (streamsByName.has(stream.name)) {
      errors.push(`/streams/${streamIndex}/name: duplicate stream name '${stream.name}'`);
    } else {
      streamsByName.set(stream.name, stream);
    }
    validateUniqueStreamMembers(stream, streamIndex, errors);
    validateStreamFieldReferences(stream, streamIndex, errors);
  }
  validateRelationships(declaration, streamsByName, errors);
  validatePresets(declaration, streamsByName, errors);
  return errors;
}

/**
 * Validate a SourceDeclaration against the normative JSON Schema plus the
 * cross-field invariants the schema cannot express. Returns `{ ok, errors }`
 * rather than throwing, so both a builder (fail-the-build) and an installer
 * (fail-the-install) can decide their own error reporting.
 */
export function validateSourceDeclaration(declaration) {
  const errors = [];
  if (!validateSchema(declaration)) {
    errors.push(...ajv.errorsText(validateSchema.errors, { separator: "\n" }).split("\n"));
  }
  // Semantic checks assume the schema-required shape (streams is an array of
  // objects, etc.), so they only run once the schema itself is satisfied.
  if (errors.length === 0) {
    errors.push(...validateSemantics(declaration));
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

export function assertSourceDeclaration(declaration, { label = "source declaration" } = {}) {
  const result = validateSourceDeclaration(declaration);
  if (!result.ok) {
    throw new Error(`${label} is not a valid PDPP SourceDeclaration:\n  - ${result.errors.join("\n  - ")}`);
  }
  return declaration;
}

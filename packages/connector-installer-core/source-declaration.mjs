// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate a PDPP `SourceDeclaration` (schema + semantics), so a builder and
 * an installer can refuse the same invalid shape rather than each holding
 * its own idea of what a SourceDeclaration is.
 *
 * Both the JSON Schema and the semantic validator come from
 * ./pdpp-source-contract.mjs, which is generated from the PDPP reference
 * contract's own `source.ts` at a pinned commit (see
 * scripts/generate-pdpp-source-contract.mjs). Nothing here re-implements
 * them.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  SourceDeclarationSchema,
  validateSourceDeclarationSemantics,
} from "./pdpp-source-contract.mjs";

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
      ...(stream.relationships !== undefined ? { relationships: stream.relationships } : {}),
      schema: stream.schema,
      selection: stream.selection,
      semantics: stream.semantics,
      ...(stream.views !== undefined ? { views: stream.views } : {}),
    })),
  };
}

// Configured as the PDPP reference contract's own SourceDeclaration tests
// configure ajv (`reference-contract/test/source-contract.test.ts`): draft
// 2020-12, non-strict, standard formats.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateSchema = ajv.compile(SourceDeclarationSchema);

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
    const semantics = validateSourceDeclarationSemantics(declaration);
    if (!semantics.ok) {
      errors.push(
        ...semantics.failures.map(({ code, path, reference }) =>
          `${code} at ${path}${reference === undefined ? "" : ` (${reference})`}`,
        ),
      );
    }
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

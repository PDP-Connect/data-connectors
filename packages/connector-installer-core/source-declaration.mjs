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

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  SourceDeclarationSchema,
  validateSourceDeclarationSemantics,
} from "./pdpp-source-contract.mjs";

// The identity this repository's connectors are published under. Not a
// per-connector value: `publisher.id` is a self-declared, unauthenticated
// attribution claim (PDPP spec-core.md section 5), and no allocation rule
// exists yet, so this names the actual publishing organisation.
export const PUBLISHER_ID = "https://github.com/PDP-Connect";

// The Core stream members a manifest stream carries. Collection-Profile-only
// members (`required`, `incremental`, `coverage_strategy`, ...) are execution
// concerns the SourceDeclaration schema forbids, so they are dropped. The
// result is a copy, so editing a declaration never edits its manifest.
function projectStream(stream) {
  return structuredClone({
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
  });
}

// What a grant and the stored records depend on. Description and display
// are consent prose, which may differ per acquisition method.
function streamContract(stream) {
  const { description: _description, display: _display, ...contract } = projectStream(stream);
  return contract;
}

function lastPathSegment(uri) {
  return new URL(uri).pathname.split("/").filter(Boolean).at(-1);
}

// A content-derived `declaration_version`: Core treats the value as opaque
// and rejects different content under one (source.id, declaration_version)
// as equivocation, so deriving it from the content makes equivocation
// impossible by construction.
export function declarationVersion(declaration) {
  const { declaration_version: _version, ...content } = declaration;
  return `sha256:${createHash("sha256").update(JSON.stringify(content)).digest("hex")}`;
}

/**
 * The one PDPP SourceDeclaration for a source, built from the manifests of
 * every artifact that acquires it (`profiles`). Every such artifact carries
 * the same bytes, so one (source.id, declaration_version) names one
 * declaration.
 *
 * Each manifest names its source in `source: { id, display: { name } }`;
 * all members must agree on both. The declaration's streams are the union
 * of the members' streams. A stream several members collect must have the
 * same contract in each (streamContract); its prose comes from the
 * canonical member, the one whose connector key matches the last segment of
 * `source.id` (for example `oura`, not `oura-browser`). Each artifact's own
 * Collection Profile keeps its method-specific prose.
 */
export function buildSourceDeclaration(profiles) {
  const members = [...profiles].sort((a, b) => a.connector_key.localeCompare(b.connector_key));
  const [first] = members;
  if (!first?.source?.id || !first.source.display?.name) {
    throw new Error(`${first?.connector_key}: manifest must declare source.id and source.display.name`);
  }
  for (const member of members) {
    if (member.source?.id !== first.source.id || member.source?.display?.name !== first.source.display.name) {
      throw new Error(
        `${member.connector_key} and ${first.connector_key} disagree on source.id or source.display.name`,
      );
    }
  }
  const namespace = lastPathSegment(first.source.id);
  const canonical =
    members.length === 1
      ? first
      : members.find((member) => member.connector_key.replaceAll("-", "_") === namespace);
  if (!canonical) {
    throw new Error(`${first.source.id}: no member artifact's connector key matches "${namespace}"`);
  }

  const streams = new Map();
  for (const member of [canonical, ...members.filter((member) => member !== canonical)]) {
    for (const stream of member.streams) {
      const declared = streams.get(stream.name);
      if (!declared) {
        streams.set(stream.name, { owner: member.connector_key, stream: projectStream(stream) });
      } else if (!isDeepStrictEqual(streamContract(stream), streamContract(declared.stream))) {
        throw new Error(
          `${first.source.id}: stream "${stream.name}" differs between ${declared.owner} and ${member.connector_key}`,
        );
      }
    }
  }

  const declaration = {
    declaration_version: "",
    display: { name: first.source.display.name },
    protocol_version: "0.1.0",
    publisher: { id: PUBLISHER_ID },
    source: { kind: "connector", id: first.source.id },
    streams: [...streams.values()].map(({ stream }) => stream),
  };
  declaration.declaration_version = declarationVersion(declaration);
  return declaration;
}

/** The serialized layer: every artifact of one source carries these bytes. */
export function serializeSourceDeclaration(declaration) {
  return Buffer.from(`${JSON.stringify(declaration, null, 2)}\n`);
}

/**
 * Why `declaration` is not a declaration `profile` may ship with, or `[]`.
 * An installer holds only one artifact, so it checks membership rather than
 * recomputing the source's declaration: same source, a content-derived
 * version, and every profile stream declared with the same contract.
 */
export function profileDeclarationErrors(profile, declaration) {
  const errors = [];
  if (declaration.source?.id !== profile.source?.id) {
    errors.push(`source.id is "${declaration.source?.id}" but the profile says "${profile.source?.id}"`);
  }
  if (declaration.display?.name !== profile.source?.display?.name) {
    errors.push(
      `display.name is "${declaration.display?.name}" but the profile says "${profile.source?.display?.name}"`,
    );
  }
  if (declaration.declaration_version !== declarationVersion(declaration)) {
    errors.push("declaration_version is not the digest of the declaration content");
  }
  const declared = new Map((declaration.streams ?? []).map((stream) => [stream.name, stream]));
  for (const stream of profile.streams ?? []) {
    const match = declared.get(stream.name);
    if (!match) {
      errors.push(`stream "${stream.name}" is not declared`);
    } else if (!isDeepStrictEqual(streamContract(stream), streamContract(match))) {
      errors.push(`stream "${stream.name}" is declared with a different contract`);
    }
  }
  return errors;
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

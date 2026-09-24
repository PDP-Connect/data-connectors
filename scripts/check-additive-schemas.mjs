#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Detect breaking changes to public scope schemas between the base ref and
// HEAD. A breaking change is: a removed property, a removed required field,
// or a new required field.
//
// If a breaking change is present, the schema's `version` field must advance
// its major version, or its minor version while still in 0.x development.
//
// Acceptance target:
//   HC-COMPAT-ADDITIVE-SCHEMA-001 — public scope schemas evolve additively
//   unless a version bump is introduced.
//
// Usage:
//   node scripts/check-additive-schemas.mjs
//   BASE_REF=origin/main node scripts/check-additive-schemas.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

function schemaDocsFromPdppManifest(manifestPath, manifest) {
  const relManifestPath = manifestPath.replace(repoRoot + "/", "");
  return (manifest.streams ?? [])
    .filter((stream) => stream?.name && stream?.schema)
    .map((stream) => ({
      path: manifestPath,
      rel: `${relManifestPath}#streams.${stream.name}`,
      version: manifest.version,
      schema: stream.schema,
      baseSchemaAtRef(ref) {
        const connectorKey = relManifestPath.split("/")[1];
        const baseManifest = getJsonAtRef(ref, relManifestPath)
          ?? getJsonAtRef(ref, `packages/polyfill-connectors/manifests/${connectorKey}.json`);
        const baseStream = baseManifest?.streams?.find((entry) => entry?.name === stream.name);
        if (!baseStream?.schema) return null;
        return {
          version: baseManifest.version,
          schema: baseStream.schema,
        };
      },
    }));
}

function getJsonAtRef(ref, relPath) {
  const content = getFileAtRef(ref, relPath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function listSchemas() {
  const schemaDocs = [];
  const connectorsDir = join(repoRoot, "connectors");
  for (const entry of readdirSync(connectorsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(connectorsDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    schemaDocs.push(...schemaDocsFromPdppManifest(manifestPath, manifest));
  }

  return schemaDocs;
}

function getFileAtRef(ref, relPath) {
  try {
    return execFileSync("git", ["show", `${ref}:${relPath}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
}

function parseMajorMinor(version) {
  if (typeof version !== "string") return null;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

export function permitsBreakingChange(baseVersion, headVersion) {
  const base = parseMajorMinor(baseVersion);
  const head = parseMajorMinor(headVersion);
  if (!base || !head) return false;
  return head.major > base.major ||
    (base.major === 0 && head.major === 0 && head.minor > base.minor);
}

function collectProperties(schema, path = "") {
  const out = new Map();
  if (!schema || typeof schema !== "object") return out;
  if (schema.type === "object" && schema.properties) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    for (const [key, sub] of Object.entries(schema.properties)) {
      const subPath = path ? `${path}.${key}` : key;
      out.set(subPath, { required: required.has(key) });
      if (sub && typeof sub === "object") {
        for (const [k, v] of collectProperties(sub, subPath)) {
          out.set(k, v);
        }
        if (sub.type === "array" && sub.items) {
          for (const [k, v] of collectProperties(sub.items, `${subPath}[]`)) {
            out.set(k, v);
          }
        }
      }
    }
  }
  return out;
}

function diffSchemas(baseSchema, headSchema) {
  const baseProps = collectProperties(baseSchema);
  const headProps = collectProperties(headSchema);
  const removed = [];
  const newlyRequired = [];
  for (const [key] of baseProps) {
    if (!headProps.has(key)) removed.push(key);
  }
  for (const [key, meta] of headProps) {
    const baseMeta = baseProps.get(key);
    if (baseMeta && !baseMeta.required && meta.required) {
      newlyRequired.push(key);
    }
  }
  return { removed, newlyRequired };
}

function main() {
  const baseRef = process.env.BASE_REF || "origin/main";
  const schemaDocs = listSchemas();
  const errors = [];
  let checked = 0;

  for (const head of schemaDocs) {
    const base = head.baseSchemaAtRef(baseRef);
    if (!base) continue;

    checked++;
    const { removed, newlyRequired } = diffSchemas(base.schema, head.schema);
    const breaking = removed.length > 0 || newlyRequired.length > 0;
    if (breaking && !permitsBreakingChange(base.version, head.version)) {
      errors.push(
        `${head.rel}: breaking schema change without major (or 0.x minor) version bump (base v${base.version}, head v${head.version}). removed=${JSON.stringify(removed)} newly_required=${JSON.stringify(newlyRequired)}`,
      );
    }
  }

  if (errors.length > 0) {
    for (const e of errors) console.error(`error: ${e}`);
    console.error(
      `\nHC-COMPAT-ADDITIVE-SCHEMA-001 FAIL: ${errors.length} breaking schema change(s). Either revert the change or bump the schema's major version (minor in 0.x).`,
    );
    process.exit(1);
  }

  console.log(`Schemas additive: ${checked} schema(s) checked.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import { readFile, readdir } from "fs/promises";
import { dirname, join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(name) {
  return args.includes(name);
}

function getOption(name, fallback) {
  const idx = args.indexOf(name);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const jsonOutput = getFlag("--json");
const baseRef = getOption("--base-ref", "origin/main");

// ---------------------------------------------------------------------------
// Resolve repo root (script lives in scripts/ under the repo root)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw);
}

function extractScopeId(scopeEntry) {
  return typeof scopeEntry === "string" ? scopeEntry : scopeEntry?.scope;
}

async function listConnectorLocalSchemas(manifestPath, metadata) {
  const manifestDir = dirname(manifestPath);
  const results = new Map();
  for (const entry of metadata.scopes ?? []) {
    const scope = extractScopeId(entry);
    if (!scope) continue;
    const schemaPath = join(manifestDir, "schemas", `${scope}.json`);
    try {
      const schema = await readJson(schemaPath);
      results.set(scope, { schema, path: schemaPath });
    } catch {
      results.set(scope, { schema: null, path: schemaPath });
    }
  }
  return results;
}

async function walkJsonFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkJsonFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }

  return out;
}

async function listAllManifestScopes() {
  const manifestFiles = await walkJsonFiles(join(REPO_ROOT, "connectors"));
  const scopes = new Set();

  for (const filePath of manifestFiles) {
    if (!filePath.endsWith("-playwright.json")) continue;
    try {
      const manifest = await readJson(filePath);
      for (const entry of manifest.scopes ?? []) {
        const scope = extractScopeId(entry);
        if (scope) scopes.add(scope);
      }
    } catch {
      // Ignore invalid manifest JSON here.
    }
  }

  return scopes;
}

function readGitJson(ref, relativePath) {
  try {
    const raw = execSync(`git show ${ref}:${relativePath}`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discover base-branch scopes (for new-scope detection)
// ---------------------------------------------------------------------------

const baseScopeSet = new Set();
const baseRegistry = readGitJson(baseRef, "registry.json");
if (baseRegistry?.connectors) {
  for (const connector of baseRegistry.connectors) {
    const metadata = readGitJson(baseRef, `connectors/${connector.files.metadata}`);
    if (metadata?.scopes) {
      for (const entry of metadata.scopes) {
        const scope = extractScopeId(entry);
        if (scope) baseScopeSet.add(scope);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery (current branch)
// ---------------------------------------------------------------------------

// 1. Read registry.json
const registry = await readJson(join(REPO_ROOT, "registry.json"));
const connectors = registry.connectors;

// 2-4. Gather scopes from each connector's metadata
// Map: scope -> first connector id that declares it (for reporting)
const scopeToConnector = new Map();

for (const connector of connectors) {
  const metadataPath = join(REPO_ROOT, "connectors", connector.files.metadata);
  let metadata;
  try {
    metadata = await readJson(metadataPath);
  } catch (err) {
    process.stderr.write(
      `Warning: could not read metadata for ${connector.id}: ${err.message}\n`
    );
    continue;
  }

  if (!Array.isArray(metadata.scopes)) continue;

  for (const entry of metadata.scopes) {
    const scope = extractScopeId(entry);
    if (scope && !scopeToConnector.has(scope)) {
      scopeToConnector.set(scope, connector.id);
    }
  }
}

// Scopes declared by CI-only fixtures under connectors/_conformance/.
// These are not shipped connectors — they don't belong in registry.json —
// but their schemas are legitimately used by the cross-runtime conformance
// harness, so the orphan check should not flag them.
const fixtureScopes = new Set();
try {
  const conformanceDir = join(REPO_ROOT, "connectors", "_conformance");
  const entries = await readdir(conformanceDir);
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const metadata = await readJson(join(conformanceDir, entry));
      if (Array.isArray(metadata.scopes)) {
        for (const s of metadata.scopes) {
          const scope = extractScopeId(s);
          if (scope) fixtureScopes.add(scope);
        }
      }
    } catch {
      // Ignore unreadable fixture manifests.
    }
  }
} catch {
  // No _conformance directory — fine.
}

// 5. Collect connector-local schema files from registered connectors only.
const localSchemasByScope = new Map();
for (const connector of connectors) {
  const metadataPath = join(REPO_ROOT, "connectors", connector.files.metadata);
  try {
    const metadata = await readJson(metadataPath);
    const schemaEntries = await listConnectorLocalSchemas(metadataPath, metadata);
    for (const [scope, value] of schemaEntries) {
      localSchemasByScope.set(scope, value);
    }
  } catch {
    // Missing manifest/schema will be reported elsewhere.
  }
}

const declaredScopes = new Set(scopeToConnector.keys());
const allManifestScopes = await listAllManifestScopes();
const orphanedSchemas = [];
const seenSchemaPaths = new Set();
for (const value of localSchemasByScope.values()) {
  if (value?.path) {
    seenSchemaPaths.add(value.path);
  }
}

const connectorSchemaFiles = await walkJsonFiles(join(REPO_ROOT, "connectors"));
for (const schemaPath of connectorSchemaFiles) {
  if (!schemaPath.includes("/schemas/")) continue;
  if (schemaPath.endsWith("/manifest.schema.json")) continue;
  if (seenSchemaPaths.has(schemaPath)) continue;

  try {
    const schemaDoc = await readJson(schemaPath);
    const scope = schemaDoc?.scope;
    if (!scope) continue;
    if (
      !declaredScopes.has(scope) &&
      !allManifestScopes.has(scope) &&
      !fixtureScopes.has(scope)
    ) {
      orphanedSchemas.push(schemaPath.replace(`${REPO_ROOT}/`, ""));
    }
  } catch {
    // Ignore invalid JSON here; schema presence/validity is covered elsewhere.
  }
}

// ---------------------------------------------------------------------------
// Local schema/metadata checks
// ---------------------------------------------------------------------------

const scopeResults = [];

for (const [scope, connectorId] of scopeToConnector) {
  const localSchemaEntry = localSchemasByScope.get(scope);
  const schemaFileExists = Boolean(localSchemaEntry?.schema);
  const isNew = !baseScopeSet.has(scope);
  const consistent = schemaFileExists;

  scopeResults.push({
    scope,
    connector: connectorId,
    isNew,
    schemaFileExists,
    consistent,
  });
}

// ---------------------------------------------------------------------------
// Summarise
// ---------------------------------------------------------------------------

const missingSchemaFile = scopeResults.filter((r) => !r.schemaFileExists);
const fullyConsistent = scopeResults.filter((r) => r.consistent);

const summary = {
  total: scopeResults.length,
  fullyConsistent: fullyConsistent.length,
  missingSchemaFile: missingSchemaFile.length,
  orphanedSchemas: orphanedSchemas.length,
};

const issueCount = summary.missingSchemaFile + summary.orphanedSchemas;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

if (jsonOutput) {
  const report = {
    baseRef,
    timestamp: new Date().toISOString(),
    summary,
    scopes: scopeResults,
    orphanedSchemas,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

// Human-readable summary always goes to stderr
if (issueCount === 0) {
  process.stderr.write(
    `Schema health check PASSED: all ${summary.total} scopes are consistent.\n`
  );
} else {
  process.stderr.write(
    `Schema health check FAILED: ${issueCount} issue(s) found.\n\n`
  );

  if (missingSchemaFile.length > 0) {
    process.stderr.write("Missing local schema files:\n");
    for (const r of missingSchemaFile) {
      const tag = r.isNew ? " [added in this PR]" : "";
      process.stderr.write(`  - ${r.scope} (connector: ${r.connector})${tag}\n`);
    }
    process.stderr.write("\n");
  }

  if (orphanedSchemas.length > 0) {
    process.stderr.write(
      "Orphaned schema files (no connector declares this scope):\n"
    );
    for (const s of orphanedSchemas) {
      process.stderr.write(`  - ${s}\n`);
    }
    process.stderr.write("\n");
  }

  process.stderr.write(
    "These issues must be resolved before connectors can be considered schema-healthy.\n"
  );
}

process.exit(issueCount === 0 ? 0 : 1);

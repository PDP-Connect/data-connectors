#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const FORBIDDEN_NAMES = new Set([
  "fetched_at",
  "synced_at",
  "scraped_at",
  "collected_at",
  "retrieved_at",
  "crawled_at",
]);
const SCHEMA_CHILDREN = [
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "items",
  "contains",
  "not",
  "if",
  "then",
  "else",
];
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAPS = ["properties", "patternProperties", "dependentSchemas", "$defs", "definitions"];
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

// This deliberately supports only unencoded local JSON Pointers, not URI
// scopes/anchors or dynamic resolution. Keep schema-name policy separate from
// value semantics; unused definitions and negated/composed schemas are scanned.
const MAX_DEPTH = 32;
const MAX_WORK = 4096;
const MAX_REF_LENGTH = 65536;
const UNSUPPORTED_SCOPE = ["$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveAnchor", "$recursiveRef"];
const pointerToken = (part) => part.replaceAll("~", "~0").replaceAll("/", "~1");

function resolvePointer(root, ref, path) {
  if (ref.length > MAX_REF_LENGTH) fail(path, "schema reference exceeds 65536 characters");
  if (ref !== "#" && (!ref.startsWith("#/") || ref.includes("%"))) {
    fail(path, "unsupported schema $ref; only unencoded local JSON Pointers are supported");
  }
  if (ref === "#") return { node: root, schemaPath: "" };
  const parts = ref.slice(2).split("/");
  if (parts.length > MAX_DEPTH) fail(path, "schema pointer depth exceeds 32");
  const keys = parts.map((part) => {
    if (/~(?:[^01]|$)/.test(part)) fail(path, "invalid JSON pointer escape; use ~0 or ~1");
    return part.replaceAll("~1", "/").replaceAll("~0", "~");
  });
  let node = root;
  for (const key of keys) {
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, key)) {
      fail(path, `unresolved schema $ref ${JSON.stringify(ref)}`);
    }
    // This guard cannot interpret a target across an inherited URI scope.
    for (const keyword of UNSUPPORTED_SCOPE) {
      if (Object.hasOwn(node, keyword)) fail(path, "schema reference crosses an unsupported scope/anchor keyword");
    }
    node = node[key];
  }
  return { node, schemaPath: "/" + keys.map(pointerToken).join("/") };
}

export function findForbiddenProperties(schema, manifestPath) {
  const findings = [];
  const visited = new WeakSet();
  const foundPaths = new Set();
  let work = 0;
  function visit(node, schemaPath, depth = 0) {
    if (++work > MAX_WORK) fail(manifestPath, "schema work exceeds 4096 nodes/visits");
    if (depth > MAX_DEPTH) fail(`${manifestPath}#${schemaPath}`, "schema depth exceeds 32");
    if (node === true || node === false) return;
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      fail(`${manifestPath}#${schemaPath}`, "schema node must be an object or boolean");
    }
    // A reference target is attributed to its own pointer location. A shared
    // target or ref cycle is visited once, so exceptions are consumed once.
    if (visited.has(node)) return;
    visited.add(node);
    for (const keyword of UNSUPPORTED_SCOPE) {
      if (Object.hasOwn(node, keyword)) fail(`${manifestPath}#${schemaPath}/${keyword}`, "unsupported schema scope/anchor keyword");
    }
    if (Object.hasOwn(node, "$ref")) {
      if (typeof node.$ref !== "string") fail(`${manifestPath}#${schemaPath}/$ref`, "$ref must be a string");
      const target = resolvePointer(schema, node.$ref, `${manifestPath}#${schemaPath}/$ref`);
      visit(target.node, target.schemaPath, depth + 1);
    }

    for (const keyword of SCHEMA_MAPS) {
      if (!Object.hasOwn(node, keyword)) continue;
      if (!node[keyword] || typeof node[keyword] !== "object" || Array.isArray(node[keyword])) {
        fail(`${manifestPath}#${schemaPath}/${keyword}`, `${keyword} must be an object`);
      }
      for (const [name, child] of Object.entries(node[keyword])) {
        const childPath = `${schemaPath}/${keyword}/${pointerToken(name)}`;
        if (keyword === "properties" && FORBIDDEN_NAMES.has(name) && !foundPaths.has(childPath)) {
          foundPaths.add(childPath);
          findings.push({ propertyPath: childPath.slice(1), schemaPath: childPath });
        }
        visit(child, childPath, depth + 1);
      }
    }

    for (const keyword of SCHEMA_CHILDREN) {
      if (!Object.hasOwn(node, keyword)) continue;
      visit(node[keyword], `${schemaPath}/${keyword}`, depth + 1);
    }
    for (const keyword of SCHEMA_ARRAYS) {
      if (!Object.hasOwn(node, keyword)) continue;
      if (!Array.isArray(node[keyword])) fail(`${manifestPath}#${schemaPath}/${keyword}`, `${keyword} must be an array`);
      node[keyword].forEach((child, index) => visit(child, `${schemaPath}/${keyword}/${index}`, depth + 1));
    }
  }
  visit(schema, "");
  return findings;
}

export function validateAllowlist(allowlist) {
  if (!Array.isArray(allowlist)) fail("scripts/run-clock-schema-allowlist.json", "allowlist must be an array");
  const seen = new Set();
  for (const [index, entry] of allowlist.entries()) {
    const path = `scripts/run-clock-schema-allowlist.json#/${index}`;
    const keys = ["connector", "stream", "propertyPath", "rationale", "emitSideEvidence"];
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== keys.slice().sort().join(",")) {
      fail(path, `entry must contain exactly: ${keys.join(", ")}`);
    }
    for (const key of ["connector", "stream", "propertyPath", "rationale"]) {
      if (typeof entry[key] !== "string" || !entry[key].trim()) fail(`${path}/${key}`, `${key} must be a non-empty string`);
    }
    if (!/^[a-z0-9_]+$/.test(entry.connector) || !/^[a-z0-9_]+$/.test(entry.stream)) {
      fail(path, "connector and stream must be exact manifest keys");
    }
    if (!entry.propertyPath.startsWith("schema/") || entry.propertyPath.includes("*") || entry.propertyPath.includes("..") ||
      ![...FORBIDDEN_NAMES].some((name) => entry.propertyPath.endsWith(`/properties/${name}`))) {
      fail(`${path}/propertyPath`, "must be an exact schema path ending at a forbidden properties key, with no wildcard or traversal");
    }
    if (entry.rationale.length < 30) fail(`${path}/rationale`, "rationale must give substantive context (at least 30 characters)");
    const evidence = entry.emitSideEvidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
      Object.keys(evidence).sort().join(",") !== ["path", "reviewedBy", "test"].join(",")) {
      fail(`${path}/emitSideEvidence`, "must contain exactly path, test, and reviewedBy for reviewed emit-side evidence");
    }
    for (const key of ["path", "test", "reviewedBy"]) {
      if (typeof evidence[key] !== "string" || !evidence[key].trim()) fail(`${path}/emitSideEvidence/${key}`, `${key} must be a non-empty string`);
    }
    if (!evidence.path.startsWith(`connectors/${entry.connector}/`) || evidence.path.includes("..") || !/\.(test|spec)\.[cm]?[jt]sx?$/.test(evidence.path)) {
      fail(`${path}/emitSideEvidence/path`, "must name a checked-in test under this connector");
    }
    const key = `${entry.connector}/${entry.stream}/${entry.propertyPath}`;
    if (seen.has(key)) fail(path, `duplicate allowlist entry ${key}`);
    seen.add(key);
  }
  return new Map(allowlist.map((entry) => [`${entry.connector}/${entry.stream}/${entry.propertyPath}`, entry]));
}

export function inspectManifest(manifest, connector, manifestPath, allowlist) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) fail(manifestPath, "manifest must be an object");
  if (!Array.isArray(manifest.streams)) fail(manifestPath, "streams must be an array");
  const seenStreams = new Set();
  const findings = [];
  for (const [index, stream] of manifest.streams.entries()) {
    const streamPath = `${manifestPath}#/streams/${index}`;
    if (!stream || typeof stream !== "object" || Array.isArray(stream)) fail(streamPath, "stream must be an object");
    if (typeof stream.name !== "string" || !stream.name.trim()) fail(`${streamPath}/name`, "stream name must be a non-empty string");
    if (seenStreams.has(stream.name)) fail(`${streamPath}/name`, `duplicate stream name ${JSON.stringify(stream.name)}`);
    seenStreams.add(stream.name);
    if (!Object.hasOwn(stream, "schema") || stream.schema === null || (typeof stream.schema !== "object" && typeof stream.schema !== "boolean") || Array.isArray(stream.schema)) {
      fail(`${streamPath}/schema`, "schema must be an object or boolean");
    }
    for (const finding of findForbiddenProperties(stream.schema, `${manifestPath}#/streams/${index}`)) {
      const fullPath = `schema/${finding.propertyPath}`;
      const key = `${connector}/${stream.name}/${fullPath}`;
      if (allowlist.has(key)) {
        allowlist.delete(key);
      } else {
        findings.push({ connector, stream: stream.name, propertyPath: fullPath, manifestPath, schemaPath: finding.schemaPath });
      }
    }
  }
  return findings;
}

function loadManifests(root) {
  const connectorsDir = join(root, "connectors");
  let connectorDirs;
  try {
    connectorDirs = readdirSync(connectorsDir, { withFileTypes: true });
  } catch (error) {
    fail(connectorsDir, `cannot read connectors directory: ${error.message}`);
  }
  return connectorDirs.filter((entry) => entry.isDirectory()).sort((a, b) => compareText(a.name, b.name)).flatMap((entry) => {
    const manifestPath = join("connectors", entry.name, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      fail(manifestPath, `cannot parse manifest JSON: ${error.message}`);
    }
    return [{ connector: entry.name, manifestPath, manifest }];
  });
}

export function checkRepository(root = REPO_ROOT, allowlistFile = join(REPO_ROOT, "scripts/run-clock-schema-allowlist.json")) {
  let allowlistJson;
  try {
    allowlistJson = JSON.parse(readFileSync(allowlistFile, "utf8"));
  } catch (error) {
    fail(allowlistFile, `cannot parse allowlist JSON: ${error.message}`);
  }
  const allowed = validateAllowlist(allowlistJson);
  for (const entry of allowlistJson) {
    if (!existsSync(join(root, entry.emitSideEvidence.path))) {
      fail(allowlistFile, `emit-side evidence file does not exist: ${entry.emitSideEvidence.path}`);
    }
  }
  const findings = loadManifests(root).flatMap(({ connector, manifestPath, manifest }) =>
    inspectManifest(manifest, connector, manifestPath, allowed));
  if (allowed.size > 0) {
    fail(allowlistFile, `stale exception(s) no longer match a forbidden field: ${[...allowed.keys()].sort().join(", ")}`);
  }
  return findings.sort((a, b) => compareText(
    `${a.connector}/${a.stream}/${a.propertyPath}`,
    `${b.connector}/${b.stream}/${b.propertyPath}`,
  ));
}

function main(args = process.argv.slice(2)) {
  try {
    let root = REPO_ROOT;
    let allowlistFile = join(REPO_ROOT, "scripts/run-clock-schema-allowlist.json");
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg !== "--root" && arg !== "--allowlist") fail("arguments", `unknown option ${JSON.stringify(arg)}`);
      const value = args[++index];
      if (!value) fail("arguments", `${arg} requires a path`);
      if (arg === "--root") root = resolve(value);
      else allowlistFile = resolve(value);
    }
    const findings = checkRepository(root, allowlistFile);
    if (findings.length) {
      for (const finding of findings) console.log(JSON.stringify({ status: "error", ...finding }));
      console.error(`Run-clock schema guard FAIL: ${findings.length} forbidden stream property/properties. Remove run-generated fields from record schemas; compaction_fingerprint.exclude_keys does not suppress ingest versions.`);
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ status: "ok", forbiddenPropertyCount: 0 }));
  } catch (error) {
    console.error(`Run-clock schema guard INPUT ERROR: ${error.message}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PUBLISHABLE_CONNECTORS,
} from "./connector-publish-allowlist.mjs";
import {
  checkTokenRealm,
  lookupManifest,
  parseBearerChallenge,
  parseDistributionErrorCodes,
} from "./lookup-manifest.mjs";
import {
  assertCatalog,
  isCatalogTimestamp,
} from "../packages/connector-installer-core/catalog-schema.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = "ghcr.io";
const DEFAULT_NAMESPACE = "pdp-connect";
const PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (!match) return null;
  return {
    version,
    core: match.slice(1, 4).map(BigInt),
    prerelease: match[4]?.split(".") ?? null,
  };
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease === null && right.prerelease !== null) return 1;
  if (left.prerelease !== null && right.prerelease === null) return -1;
  if (left.prerelease !== null && right.prerelease !== null) {
    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
      const a = left.prerelease[index];
      const b = right.prerelease[index];
      if (a === undefined) return -1;
      if (b === undefined) return 1;
      if (a === b) continue;
      const aNumeric = /^\d+$/.test(a);
      const bNumeric = /^\d+$/.test(b);
      if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1;
      if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
      return a < b ? -1 : 1;
    }
  }
  return left.version < right.version ? -1 : left.version > right.version ? 1 : 0;
}

async function requestText(url, { headers = {}, timeoutMs = 30000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "pdpp-catalog-generator/1", ...headers },
      redirect: "manual",
      signal: controller.signal,
    });
    const chunks = [];
    let size = 0;
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          throw new Error(`response body exceeded ${MAX_RESPONSE_BYTES} bytes`);
        }
        chunks.push(chunk);
      }
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.concat(chunks).toString("utf8"),
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`request exceeded its ${timeoutMs}ms deadline`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function tokenFrom(response) {
  if (response.status !== 200) {
    throw new Error(`token endpoint returned HTTP ${response.status}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    throw new Error("token endpoint returned a body that is not JSON");
  }
  const token = parsed?.token ?? parsed?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("token endpoint returned no token");
  }
  return token;
}

async function requestTagsPage(url, context) {
  let response = await context.requestImpl(url, { timeoutMs: context.timeoutMs });
  if (response.status !== 401) return response;

  const challenge = parseBearerChallenge(response.headers?.["www-authenticate"]);
  if (!challenge) throw new Error("tags endpoint returned 401 without a usable Bearer challenge");

  let tokenUrl;
  try {
    tokenUrl = new URL(challenge.realm);
  } catch (error) {
    throw new Error(`tags endpoint named an unparseable token realm: ${error.message}`);
  }
  const refusal = checkTokenRealm(tokenUrl, context.registry, {
    allowInsecureLoopback: context.allowInsecureLoopback,
  });
  if (refusal) throw new Error(refusal);
  if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
  tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${context.name}:pull`);

  const token = tokenFrom(await context.requestImpl(tokenUrl.toString(), {
    timeoutMs: context.timeoutMs,
  }));
  response = await context.requestImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    timeoutMs: context.timeoutMs,
  });
  return response;
}

function nextTagsPage(linkHeader, currentUrl, expectedPath) {
  if (!linkHeader) return null;
  const nextLinks = linkHeader
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /;\s*rel=(?:"next"|next)(?:\s*;|\s*$)/i.test(part));
  if (nextLinks.length !== 1) {
    throw new Error(`tags pagination returned ${nextLinks.length} next links`);
  }
  const match = /^<([^>]+)>/.exec(nextLinks[0]);
  if (!match) throw new Error("tags pagination returned a malformed next link");
  const next = new URL(match[1], currentUrl);
  const current = new URL(currentUrl);
  if (next.origin !== current.origin || next.pathname !== expectedPath) {
    throw new Error(`tags pagination escaped the registry repository: ${next}`);
  }
  for (const key of next.searchParams.keys()) {
    if (key !== "n" && key !== "last") {
      throw new Error(`tags pagination returned an unexpected '${key}' parameter`);
    }
  }
  if (next.searchParams.getAll("n").length > 1 || next.searchParams.getAll("last").length !== 1) {
    throw new Error("tags pagination returned ambiguous page parameters");
  }
  return next.toString();
}

export async function listRepositoryTags({
  registry,
  name,
  scheme = "https",
  timeoutMs,
  allowInsecureLoopback = false,
  requestImpl = requestText,
}) {
  const path = `/v2/${name}/tags/list`;
  let url = `${scheme}://${registry}${path}?n=${PAGE_SIZE}`;
  const seenPages = new Set();
  const tags = new Set();

  while (url) {
    if (seenPages.has(url)) throw new Error(`tags pagination repeated ${url}`);
    seenPages.add(url);
    const response = await requestTagsPage(url, {
      registry,
      name,
      timeoutMs,
      allowInsecureLoopback,
      requestImpl,
    });
    if (response.status === 404 && seenPages.size === 1) {
      const codes = parseDistributionErrorCodes(response.body);
      if (codes?.length > 0 && codes.every((code) => code === "NAME_UNKNOWN")) {
        return [];
      }
    }
    if (response.status !== 200) {
      throw new Error(`tags endpoint returned HTTP ${response.status}`);
    }
    let page;
    try {
      page = JSON.parse(response.body);
    } catch {
      throw new Error("tags endpoint returned a body that is not JSON");
    }
    if (page?.name !== name || (page.tags !== null && !Array.isArray(page.tags))) {
      throw new Error("tags endpoint returned an unexpected repository or tags shape");
    }
    for (const tag of page.tags ?? []) {
      if (typeof tag !== "string" || tag.length === 0) {
        throw new Error("tags endpoint returned a non-string or empty tag");
      }
      tags.add(tag);
    }
    url = nextTagsPage(response.headers?.link, url, path);
  }
  return [...tags];
}

function readConnectorMetadata(manifestDirectory, connector) {
  const manifestPath = join(manifestDirectory, `${connector.manifest}.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.connector_key !== connector.connectorKey) {
    throw new Error(
      `${manifestPath}: connector_key '${manifest.connector_key}' does not match allowlist key '${connector.connectorKey}'`,
    );
  }
  const required = [
    ["connector_id", manifest.connector_id],
    ["display_name", manifest.display_name],
    ["capabilities.public_listing.tier", manifest.capabilities?.public_listing?.tier],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${manifestPath}: ${field} must be a non-empty string`);
    }
  }
  const bindings = manifest.runtime_requirements?.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error(`${manifestPath}: runtime_requirements.bindings must be an object`);
  }
  const modality = manifest.setup?.modality;
  if (modality !== undefined && (typeof modality !== "string" || modality.length === 0)) {
    throw new Error(`${manifestPath}: setup.modality must be a non-empty string when present`);
  }
  return {
    connector_key: connector.connectorKey,
    connector_id: manifest.connector_id,
    display_name: manifest.display_name,
    tier: manifest.capabilities.public_listing.tier,
    runtime_requirements: { bindings },
    // Older profiles predate setup metadata. Preserve that absence explicitly
    // instead of guessing how a host should acquire credentials for them.
    setup: { modality: modality ?? null },
  };
}

export async function generateConnectorCatalog({
  registry = DEFAULT_REGISTRY,
  namespace = DEFAULT_NAMESPACE,
  sourceCommit,
  generatedAt,
  previousCatalog = null,
  manifestDirectory = join(repoRoot, "packages", "polyfill-connectors", "manifests"),
  connectors = PUBLISHABLE_CONNECTORS,
  scheme = "https",
  timeoutMs,
  allowInsecureLoopback = false,
  requestImpl = requestText,
  lookupImpl = lookupManifest,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) {
    throw new Error("source commit must be a 40-character lowercase hexadecimal Git object ID");
  }
  if (!isCatalogTimestamp(generatedAt)) {
    throw new Error("generated at must be an RFC 3339 timestamp");
  }

  const inputs = [...connectors]
    .sort((a, b) => a.connectorKey < b.connectorKey ? -1 : a.connectorKey > b.connectorKey ? 1 : 0)
    .map((connector) => ({ connector, metadata: readConnectorMetadata(manifestDirectory, connector) }));
  const catalogConnectors = [];
  for (const { connector, metadata } of inputs) {
    const name = `${namespace}/connector/${connector.connectorKey}`;
    const tags = (await listRepositoryTags({
      registry,
      name,
      scheme,
      timeoutMs,
      allowInsecureLoopback,
      requestImpl,
    }))
      .map(parseSemver)
      .filter(Boolean)
      .sort(compareSemver);
    if (tags.length === 0) continue;

    const versions = [];
    for (const tag of tags) {
      const result = await lookupImpl({
        registry,
        name,
        tag: tag.version,
        scheme,
        timeoutMs,
        allowInsecureLoopback,
      });
      if (result.outcome !== "present") {
        throw new Error(
          `${registry}/${name}:${tag.version} was listed but manifest lookup returned ${result.outcome}` +
            (result.reason ? `: ${result.reason}` : ""),
        );
      }
      versions.push({ version: tag.version, digest: result.digest });
    }
    catalogConnectors.push({
      ...metadata,
      latest: { ...versions.at(-1) },
      versions,
    });
  }
  const catalog = {
    catalog_version: "1.0",
    generated_at: new Date(Date.parse(generatedAt)).toISOString(),
    source_commit: sourceCommit,
    connectors: catalogConnectors,
  };
  if (previousCatalog !== null) {
    assertCatalog(previousCatalog);
    const comparable = (value) => JSON.stringify(sortObjectKeys({
      source_commit: value.source_commit,
      connectors: value.connectors,
    }));
    if (comparable(catalog) === comparable(previousCatalog)) {
      catalog.generated_at = previousCatalog.generated_at;
    } else {
      const nextTimestamp = Math.max(
        Date.parse(catalog.generated_at),
        Date.parse(previousCatalog.generated_at) + 1,
      );
      catalog.generated_at = new Date(nextTimestamp).toISOString();
    }
  }
  return assertCatalog(catalog);
}

function sortObjectKeys(value) {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => [key, sortObjectKeys(value[key])]),
  );
}

export function serializeConnectorCatalog(catalog) {
  assertCatalog(catalog);
  return `${JSON.stringify(sortObjectKeys(catalog), null, 2)}\n`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`expected --name value arguments, received '${name ?? ""}'`);
    }
    args[name.slice(2)] = value;
  }
  return args;
}

function gitValue(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.out) throw new Error("--out is required");
    const sourceCommit = args["source-commit"] ?? gitValue(["rev-parse", "HEAD"]);
    const generatedAt = args["generated-at"] ?? gitValue([
      "show",
      "-s",
      "--format=%cI",
      sourceCommit,
    ]);
    const previousCatalog = args["previous-catalog"]
      ? JSON.parse(readFileSync(args["previous-catalog"], "utf8"))
      : null;
    const catalog = await generateConnectorCatalog({
      registry: args.registry ?? DEFAULT_REGISTRY,
      namespace: args.namespace ?? DEFAULT_NAMESPACE,
      sourceCommit,
      generatedAt,
      previousCatalog,
      scheme: process.env.CONNECTOR_CATALOG_SCHEME === "http" ? "http" : "https",
      timeoutMs: Number(process.env.CONNECTOR_CATALOG_TIMEOUT_MS) || undefined,
      allowInsecureLoopback:
        process.env.CONNECTOR_CATALOG_ALLOW_INSECURE_TOKEN_REALM === "1",
    });
    writeFileSync(args.out, serializeConnectorCatalog(catalog));
  } catch (error) {
    process.stderr.write(`connector catalog generation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

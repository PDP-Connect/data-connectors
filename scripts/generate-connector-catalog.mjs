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
import {
  fetchBlob,
  fetchManifestByDigest,
  isValidDigest,
} from "../packages/connector-installer-core/oci-registry.mjs";
import {
  assertConfigMatchesProfile,
  indexLayersByMediaType,
} from "../packages/connector-installer-core/oci-verify.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = "ghcr.io";
const DEFAULT_NAMESPACE = "pdp-connect";
const PAGE_SIZE = 100;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CONFIG_MEDIA_TYPE = "application/vnd.pdpp.connector.config.v1+json";
const PROFILE_MEDIA_TYPE = "application/vnd.pdpp.connector.profile.v1+json";
const ARTIFACT_MEDIA_TYPE = "application/vnd.pdpp.connector.v1+json";
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

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
}

// Every descriptor must carry a valid digest and a sane size. The 1 MiB ceiling
// applies only to the layers this generator downloads (config and profile);
// code and asset layers are never fetched here and are routinely larger.
function assertDescriptor(descriptor, label, { fetched = false } = {}) {
  if (
    !isValidDigest(descriptor?.digest) ||
    !Number.isSafeInteger(descriptor?.size) ||
    descriptor.size < 0 ||
    (fetched && descriptor.size > MAX_RESPONSE_BYTES)
  ) {
    throw new Error(`${label} layer has an invalid digest or size`);
  }
}

function assertSameArtifactField(config, profile, field, label) {
  if (config?.[field] !== profile?.[field]) {
    throw new Error(
      `${label} metadata disagrees: config.${field} is ${JSON.stringify(config?.[field])}, ` +
        `but profile.${field} is ${JSON.stringify(profile?.[field])}`,
    );
  }
}

async function readPublishedMetadata({
  registry,
  repository,
  connectorKey,
  version,
  digest,
  scheme,
  timeoutMs,
  fetchImpl,
}) {
  const transport = { registry, repository, scheme, timeoutMs, fetchImpl };
  const { manifest } = await fetchManifestByDigest({ ...transport, digest });
  if (
    manifest?.schemaVersion !== 2 ||
    manifest?.mediaType !== "application/vnd.oci.image.manifest.v1+json" ||
    manifest?.artifactType !== ARTIFACT_MEDIA_TYPE ||
    manifest?.config?.mediaType !== CONFIG_MEDIA_TYPE
  ) {
    throw new Error(`${registry}/${repository}@${digest} is not a Collection Profile artifact`);
  }

  const layers = indexLayersByMediaType(manifest, { repository: `${registry}/${repository}@${digest}` });
  for (const [kind, descriptor] of Object.entries(layers)) {
    assertDescriptor(descriptor, kind);
  }
  const configDescriptor = manifest.config;
  assertDescriptor(configDescriptor, "config", { fetched: true });
  const configBytes = await fetchBlob({
    ...transport,
    digest: configDescriptor.digest,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  if (configBytes.length !== configDescriptor.size) {
    throw new Error(`${registry}/${repository}@${digest} config size does not match its descriptor`);
  }
  const config = parseJsonBytes(configBytes, "artifact config");

  if (layers.profile.mediaType !== PROFILE_MEDIA_TYPE) {
    throw new Error(`${registry}/${repository}@${digest} has an unexpected profile layer`);
  }
  const profileDescriptor = layers.profile;
  assertDescriptor(profileDescriptor, "profile", { fetched: true });
  const profileBytes = await fetchBlob({
    ...transport,
    digest: profileDescriptor.digest,
    maxBytes: MAX_RESPONSE_BYTES,
  });
  if (profileBytes.length !== profileDescriptor.size) {
    throw new Error(`${registry}/${repository}@${digest} profile size does not match its descriptor`);
  }
  const profile = parseJsonBytes(profileBytes, "published profile");
  assertConfigMatchesProfile({ config, profileBytes, profile, repository: `${registry}/${repository}@${digest}` });

  if (config.connector_key !== connectorKey || profile.connector_key !== connectorKey) {
    throw new Error(
      `${registry}/${repository}@${digest} declares connector_key inconsistent with allowlist '${connectorKey}'`,
    );
  }
  for (const field of ["display_name"]) {
    assertSameArtifactField(config, profile, field, `${registry}/${repository}@${digest}`);
  }
  if (config.version !== version) {
    throw new Error(
      `${registry}/${repository}@${digest} config.version '${config.version}' does not match published tag '${version}'`,
    );
  }
  if (typeof config.connector_id !== "string" || config.connector_id.length === 0) {
    throw new Error(`${registry}/${repository}@${digest} has no connector_id`);
  }
  if (typeof config.display_name !== "string" || config.display_name.length === 0) {
    throw new Error(`${registry}/${repository}@${digest} has no display_name`);
  }
  if (!["development", "preview", "supported"].includes(config.tier)) {
    throw new Error(`${registry}/${repository}@${digest} has an invalid tier '${config.tier}'`);
  }

  const bindings = profile.runtime_requirements?.bindings;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) {
    throw new Error(`${registry}/${repository}@${digest} profile has no runtime_requirements.bindings`);
  }
  const modality = profile.setup?.modality;
  if (modality !== undefined && (typeof modality !== "string" || modality.length === 0)) {
    throw new Error(`${registry}/${repository}@${digest} profile has an invalid setup.modality`);
  }
  if (profile.capabilities?.public_listing?.tier !== undefined &&
      profile.capabilities.public_listing.tier !== config.tier) {
    throw new Error(`${registry}/${repository}@${digest} config.tier disagrees with profile public listing tier`);
  }
  if (config.runtime !== undefined &&
      (!config.runtime || typeof config.runtime !== "object" || Array.isArray(config.runtime) ||
       !Array.isArray(config.runtime.bindings) ||
       !config.runtime.bindings.every((binding) => typeof binding === "string" && binding.length > 0))) {
    throw new Error(`${registry}/${repository}@${digest} config runtime bindings must be an array of strings`);
  }
  if (config.runtime !== undefined) {
    const configBindings = [...config.runtime.bindings].sort();
    const profileBindings = Object.keys(bindings).sort();
    if (JSON.stringify(configBindings) !== JSON.stringify(profileBindings)) {
      throw new Error(`${registry}/${repository}@${digest} config runtime bindings disagree with profile`);
    }
  }

  return {
    connector_key: connectorKey,
    connector_id: config.connector_id,
    display_name: config.display_name,
    tier: config.tier,
    runtime_requirements: { bindings },
    setup: { modality: modality ?? null },
    version: config.version,
  };
}

export async function generateConnectorCatalog({
  registry = DEFAULT_REGISTRY,
  namespace = DEFAULT_NAMESPACE,
  sourceCommit,
  generatedAt,
  previousCatalog = null,
  connectors = PUBLISHABLE_CONNECTORS,
  scheme = "https",
  timeoutMs,
  allowInsecureLoopback = false,
  requestImpl = requestText,
  lookupImpl = lookupManifest,
  fetchImpl = fetch,
}) {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit ?? "")) {
    throw new Error("source commit must be a 40-character lowercase hexadecimal Git object ID");
  }
  if (!isCatalogTimestamp(generatedAt)) {
    throw new Error("generated at must be an RFC 3339 timestamp");
  }

  const inputs = [...connectors].sort((a, b) =>
    a.connectorKey < b.connectorKey ? -1 : a.connectorKey > b.connectorKey ? 1 : 0,
  );
  const catalogConnectors = [];
  for (const connector of inputs) {
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
    const latest = versions.at(-1);
    const metadata = await readPublishedMetadata({
      registry,
      repository: name,
      connectorKey: connector.connectorKey,
      version: latest.version,
      digest: latest.digest,
      scheme,
      timeoutMs,
      fetchImpl,
    });
    catalogConnectors.push({
      ...metadata,
      latest: { version: metadata.version, digest: latest.digest },
      versions,
    });
  }
  const catalog = {
    catalog_version: "1.0",
    generated_at: new Date(Date.parse(generatedAt)).toISOString(),
    source_commit: sourceCommit,
    connectors: catalogConnectors.map(({ version, ...connector }) => connector),
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

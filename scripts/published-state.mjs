// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// What GHCR holds for one connector, and whether a local build matches it.
//
// For each artifact this reads, with an authenticated pull token:
//   1. the tag list: the published versions, their max, and whether this
//      version is one of them. A repository GHCR does not know (404
//      NAME_UNKNOWN on the authenticated read) is a new connector with no
//      versions. Anonymously, GHCR answers a missing repository with a
//      token-endpoint 403, which is `unknown`, not absent.
//   2. if the version is present, its manifest. The
//      `dev.pdpp.connector.content-digest` annotation (written by the publisher, not verified here) is the published digest.
//   3. otherwise the config blob, and each layer's diff_id. A layer whose
//      compressed digest equals the local one has the local diff_id; only a
//      differing layer is downloaded and gunzipped.
//
// Rules (design §4.4): R1 a present version must keep its content; R2 a new
// version must be higher than every published version; R4 a read that is still
// unknown after retries is never read as absent. R3 (an unpublished version
// already on the base) needs a build of the base and is not checked here.
//
// The CLI is advisory: it writes a JSON report and a `::warning::` per flagged
// connector, and exits 0 whatever it finds.

import { appendFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { fetchWithRetry } from "../packages/connector-installer-core/retry.mjs";
import {
  canonicalJson,
  CONTENT_DIGEST_ANNOTATION,
  configWithoutRevision,
  contentDigestOf,
  diffId,
  digestArtifact,
  lockfileEsbuildVersion,
  PROVENANCE_MEDIA_TYPE,
} from "./connector-content-digest.mjs";
import { checkTokenRealm, parseBearerChallenge, parseDistributionErrorCodes } from "./lookup-manifest.mjs";

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MAX_TAG_PAGES = 20;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_BLOB_BYTES = 64 * 1024 * 1024;

export const FLAGGED_VERDICTS = new Set(["present-differs", "non-monotonic", "unknown", "refused"]);

/** A registry answer that is neither present nor absent. */
export class RegistryUnknown extends Error {}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

// ---- semver ---------------------------------------------------------------

export function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}

/** Semver precedence (build metadata cannot occur: `+` is not a legal tag). */
export function compareSemver(a, b) {
  const [, ...pa] = SEMVER.exec(a);
  const [, ...pb] = SEMVER.exec(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return Math.sign(diff);
  }
  if (pa[3] === pb[3]) return 0;
  if (pa[3] === undefined) return 1;
  if (pb[3] === undefined) return -1;
  const ia = pa[3].split(".");
  const ib = pb[3].split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i += 1) {
    if (ia[i] === undefined) return -1;
    if (ib[i] === undefined) return 1;
    const na = /^\d+$/.test(ia[i]);
    const nb = /^\d+$/.test(ib[i]);
    if (na && nb && Number(ia[i]) !== Number(ib[i])) return Math.sign(Number(ia[i]) - Number(ib[i]));
    if (na !== nb) return na ? -1 : 1;
    if (ia[i] !== ib[i]) return ia[i] < ib[i] ? -1 : 1;
  }
  return 0;
}

// ---- registry client ------------------------------------------------------

/**
 * A pull client for one registry. `credential` is base64 `user:token`; it is
 * sent only to a token realm that `checkTokenRealm` accepts, and the token
 * request does not follow redirects. Each request gets `attempts` tries with a
 * `timeoutMs` deadline and jittered backoff; 429, 5xx and transport failures
 * are retried, every other status is returned to the caller to classify.
 */
export function createRegistryClient({
  registry = "ghcr.io",
  credential,
  scheme = "https",
  fetchImpl = fetch,
  attempts = 3,
  timeoutMs = 10_000,
  sleep,
  random,
  onRetry = () => {},
} = {}) {
  const tokens = new Map();

  async function send(url, headers, { redirect = "follow", maxBytes = MAX_JSON_BYTES } = {}) {
    let response;
    try {
      response = await fetchWithRetry(url, {
        fetchImpl,
        attempts,
        baseDelayMs: 1000,
        maxDelayMs: 8000,
        jitter: true,
        ...(sleep ? { sleep } : {}),
        ...(random ? { random } : {}),
        onRetry,
        fetchOptions: () => ({
          headers: { "user-agent": "pdpp-published-state/1", ...headers },
          signal: AbortSignal.timeout(timeoutMs),
          redirect,
        }),
      });
    } catch (error) {
      throw new RegistryUnknown(`request to ${url} failed after ${attempts} attempts: ${error.message}`);
    }
    let buffer;
    try {
      buffer = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      throw new RegistryUnknown(`reading ${url} failed: ${error.message}`);
    }
    if (buffer.length > maxBytes) throw new RegistryUnknown(`${url} returned more than ${maxBytes} bytes`);
    const headerObject = {};
    response.headers?.forEach?.((value, key) => {
      headerObject[key.toLowerCase()] = value;
    });
    return { status: response.status, headers: headerObject, buffer, body: buffer.toString("utf8") };
  }

  async function token(repository, challengeHeader) {
    const challenge = parseBearerChallenge(challengeHeader);
    if (!challenge) throw new RegistryUnknown("the registry returned 401 without a usable Bearer challenge");
    let realm;
    try {
      realm = new URL(challenge.realm);
    } catch (error) {
      throw new RegistryUnknown(`the 401 challenge names an unparseable token realm (${error.message})`);
    }
    const refusal = checkTokenRealm(realm, registry, { allowInsecureLoopback: scheme === "http" });
    if (refusal) throw new RegistryUnknown(refusal);
    if (challenge.service) realm.searchParams.set("service", challenge.service);
    realm.searchParams.set("scope", `repository:${repository}:pull`);
    const response = await send(realm.toString(), credential ? { authorization: `Basic ${credential}` } : {}, {
      redirect: "manual",
    });
    if (response.status !== 200) {
      throw new RegistryUnknown(
        `the token endpoint returned HTTP ${response.status}; this says nothing about the repository`,
      );
    }
    let value;
    try {
      const parsed = JSON.parse(response.body);
      value = parsed?.token ?? parsed?.access_token;
    } catch {
      throw new RegistryUnknown("the token endpoint returned a body that is not JSON");
    }
    if (typeof value !== "string" || value === "") throw new RegistryUnknown("the token endpoint returned no token");
    return value;
  }

  /** GET `/v2/<repository>/<path>`, completing the Bearer handshake once per repository. */
  async function get(repository, path, { accept, maxBytes } = {}) {
    const url = `${scheme}://${registry}/v2/${repository}/${path}`;
    const base = accept ? { accept } : {};
    const cached = tokens.get(repository);
    let response = await send(url, cached ? { ...base, authorization: `Bearer ${cached}` } : base, { maxBytes });
    if (response.status !== 401) return response;
    const fresh = await token(repository, response.headers["www-authenticate"]);
    tokens.set(repository, fresh);
    response = await send(url, { ...base, authorization: `Bearer ${fresh}` }, { maxBytes });
    return response;
  }

  return { registry, get };
}

function errorCodes(response) {
  const codes = parseDistributionErrorCodes(response.body);
  return codes === null ? "unreadable" : codes.join(",") || "none";
}

/** Every tag in the repository, or `null` when GHCR does not know the repository. */
export async function listTags(client, repository) {
  const tags = [];
  let path = "tags/list?n=1000";
  for (let page = 0; page < MAX_TAG_PAGES; page += 1) {
    const response = await client.get(repository, path);
    if (response.status === 404) {
      const codes = parseDistributionErrorCodes(response.body);
      if (page === 0 && codes?.length > 0 && codes.every((code) => code === "NAME_UNKNOWN")) return null;
      throw new RegistryUnknown(`tag list returned 404 without NAME_UNKNOWN (codes: ${errorCodes(response)})`);
    }
    if (response.status !== 200) {
      throw new RegistryUnknown(`tag list returned HTTP ${response.status} (codes: ${errorCodes(response)})`);
    }
    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new RegistryUnknown("tag list is not JSON");
    }
    if (parsed?.tags !== null && !Array.isArray(parsed?.tags)) throw new RegistryUnknown("tag list has no tags array");
    tags.push(...(parsed.tags ?? []));
    const next = /<([^>]+)>\s*;\s*rel="?next"?/.exec(response.headers.link ?? "");
    if (!next) return tags;
    const url = new URL(next[1], `https://${client.registry}`);
    const prefix = `/v2/${repository}/`;
    if (!url.pathname.startsWith(prefix)) throw new RegistryUnknown("tag list next link leaves the repository");
    path = `${url.pathname.slice(prefix.length)}${url.search}`;
  }
  throw new RegistryUnknown(`tag list exceeded ${MAX_TAG_PAGES} pages`);
}

async function fetchVerified(client, repository, path, digest, options) {
  const response = await client.get(repository, path, options);
  if (response.status !== 200) {
    throw new RegistryUnknown(`${path} returned HTTP ${response.status} (codes: ${errorCodes(response)})`);
  }
  const actual = sha256(response.buffer);
  if (digest && actual !== digest) throw new RegistryUnknown(`${path} returned bytes that hash to ${actual}`);
  return { response, digest: actual };
}

/**
 * The published side for one reference: `new-repository`, `absent`, or
 * `present` with the manifest. Throws `RegistryUnknown` for anything else.
 */
export async function readPublishedState(client, { repository, version }) {
  const tags = await listTags(client, repository);
  if (tags === null) return { state: "new-repository", versions: [], max: null };
  const versions = tags.filter(isSemver).sort(compareSemver);
  const max = versions.at(-1) ?? null;
  if (!versions.includes(version)) return { state: "absent", versions, max };

  const { response, digest } = await fetchVerified(client, repository, `manifests/${encodeURIComponent(version)}`, null, {
    accept: MANIFEST_ACCEPT,
  });
  const header = response.headers["docker-content-digest"];
  if (header && header.trim() !== digest) {
    throw new RegistryUnknown(`manifest ${version} hashes to ${digest}, but the registry named ${header}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(response.body);
  } catch {
    throw new RegistryUnknown(`manifest ${version} is not JSON`);
  }
  if (!DIGEST.test(manifest?.config?.digest ?? "") || !Array.isArray(manifest?.layers)) {
    throw new RegistryUnknown(`manifest ${version} has no config digest or layer list`);
  }
  return { state: "present", versions, max, manifest_digest: digest, manifest };
}

/**
 * The published content digest of a present version. Prefers the publisher
 * annotation; otherwise derives it, downloading only the layers whose
 * compressed digest differs from the local build's.
 */
export async function readPublishedContent(client, { repository, manifest, local }) {
  const annotated = manifest.annotations?.[CONTENT_DIGEST_ANNOTATION];
  if (typeof annotated === "string" && DIGEST.test(annotated)) {
    return { source: "annotation", content_digest: annotated, blobs_downloaded: 0 };
  }

  const { response: configResponse } = await fetchVerified(
    client,
    repository,
    `blobs/${manifest.config.digest}`,
    manifest.config.digest,
  );
  const config = configWithoutRevision(configResponse.buffer);
  let downloaded = 1;
  const layers = [];
  for (const descriptor of manifest.layers) {
    if (!DIGEST.test(descriptor?.digest ?? "") || typeof descriptor?.mediaType !== "string") {
      throw new RegistryUnknown("manifest has a layer without a digest or media type");
    }
    if (descriptor.mediaType === PROVENANCE_MEDIA_TYPE) continue;
    const title = descriptor.annotations?.["org.opencontainers.image.title"] ?? null;
    const same = local?.layers.find(
      (layer) => layer.digest === descriptor.digest && layer.mediaType === descriptor.mediaType,
    );
    if (same) {
      layers.push({ title, mediaType: descriptor.mediaType, digest: descriptor.digest, diff_id: same.diff_id });
      continue;
    }
    const { response } = await fetchVerified(client, repository, `blobs/${descriptor.digest}`, descriptor.digest, {
      maxBytes: MAX_BLOB_BYTES,
    });
    downloaded += 1;
    layers.push({
      title,
      mediaType: descriptor.mediaType,
      digest: descriptor.digest,
      diff_id: diffId(descriptor.mediaType, response.buffer),
    });
  }
  return {
    source: "derived",
    content_digest: contentDigestOf({ config, layers }),
    config,
    layers,
    blobs_downloaded: downloaded,
  };
}

/** What differs between a local build and a derived published artifact. */
export function describeDifferences(local, published) {
  if (published.source !== "derived") return ["content digest (annotation)"];
  const differences = [];
  const localConfig = local.config;
  const keys = new Set([...Object.keys(localConfig), ...Object.keys(published.config)]);
  for (const key of [...keys].sort()) {
    if (canonicalJson(localConfig[key]) !== canonicalJson(published.config[key])) differences.push(`config.${key}`);
  }
  const localLayers = local.layers.filter(({ mediaType }) => mediaType !== PROVENANCE_MEDIA_TYPE);
  for (let i = 0; i < Math.max(localLayers.length, published.layers.length); i += 1) {
    const mine = localLayers[i];
    const theirs = published.layers[i];
    const name = mine?.file ?? theirs?.title ?? theirs?.mediaType;
    if (!mine || !theirs) differences.push(`layer ${name} ${mine ? "not published" : "not built"}`);
    else if (mine.mediaType !== theirs.mediaType) differences.push(`layer ${i} media type`);
    else if (mine.diff_id !== theirs.diff_id) differences.push(`layer ${name}`);
  }
  return differences;
}

/**
 * Check one built artifact against GHCR. Never throws: every failure becomes a
 * verdict, so one connector cannot hide the others' results.
 */
export async function checkArtifact({ artifactDir, esbuildVersion, client, owner }) {
  let local;
  try {
    local = digestArtifact(artifactDir, { esbuildVersion });
  } catch (error) {
    return { artifact: artifactDir, verdict: "refused", flagged: true, reason: error.message };
  }
  const row = {
    connector_key: local.connector_key,
    version: local.version,
    local_content_digest: local.content_digest,
  };
  const verdict = (name, extra = {}) => ({ ...row, verdict: name, flagged: FLAGGED_VERDICTS.has(name), ...extra });
  if (!isSemver(local.version)) return verdict("refused", { reason: `version ${local.version} is not semver` });

  const repository = `${owner}/connector/${local.connector_key}`;
  try {
    const state = await readPublishedState(client, { repository, version: local.version });
    if (state.state === "new-repository") return verdict("new-repository", { max_published: null });
    if (state.state === "absent") {
      if (state.max === null || compareSemver(local.version, state.max) > 0) {
        return verdict("absent", { max_published: state.max });
      }
      return verdict("non-monotonic", {
        max_published: state.max,
        reason: `${local.version} is not published and is not higher than ${state.max}; roll forward with a new version`,
      });
    }
    const published = await readPublishedContent(client, { repository, manifest: state.manifest, local });
    const extra = {
      max_published: state.max,
      manifest_digest: state.manifest_digest,
      published_content_digest: published.content_digest,
      published_source: published.source,
      blobs_downloaded: published.blobs_downloaded,
    };
    if (published.content_digest === local.content_digest) return verdict("present-equal", extra);
    return verdict("present-differs", {
      ...extra,
      differences: describeDifferences(local, published),
      reason: `${local.version} is already published with different content; bump the version`,
    });
  } catch (error) {
    if (error instanceof RegistryUnknown) return verdict("unknown", { reason: error.message });
    return verdict("unknown", { reason: `unexpected error: ${error.message}` });
  }
}

function summaryLine(result) {
  const name = result.connector_key ? `${result.connector_key}@${result.version}` : result.artifact;
  const detail = result.differences?.length ? ` (${result.differences.join(", ")})` : "";
  return `${name}: ${result.verdict}${detail}${result.reason ? ` - ${result.reason}` : ""}`;
}

async function main() {
  const args = process.argv.slice(2);
  const artifacts = [];
  let reportPath = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--artifact" && args[i + 1]) artifacts.push(args[i + 1]);
    else if (args[i] === "--report" && args[i + 1]) reportPath = args[i + 1];
    else {
      console.error("usage: node scripts/published-state.mjs --artifact <dir> [--artifact <dir> ...] [--report <file>]");
      process.exit(2);
    }
  }

  const username = process.env.LOOKUP_USERNAME ?? "";
  const password = process.env.LOOKUP_PASSWORD ?? "";
  const client = createRegistryClient({
    credential: password ? Buffer.from(`${username}:${password}`).toString("base64") : undefined,
    onRetry: ({ url, nextAttempt, attempts, status, error }) =>
      console.log(`retrying ${url} (${status ?? error?.message}); attempt ${nextAttempt}/${attempts}`),
  });
  const owner = (process.env.GITHUB_REPOSITORY_OWNER || "pdp-connect").toLowerCase();
  let esbuildVersion;
  try {
    esbuildVersion = lockfileEsbuildVersion(join(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (error) {
    esbuildVersion = "";
    console.log(`::warning::cannot read the lockfile esbuild version: ${error.message}`);
  }

  const results = [];
  for (const artifactDir of artifacts) {
    const result = await checkArtifact({ artifactDir, esbuildVersion, client, owner });
    results.push(result);
    console.log(summaryLine(result));
    if (result.flagged) console.log(`::warning::advisory content check: ${summaryLine(result)}`);
  }

  const counts = {};
  for (const { verdict } of results) counts[verdict] = (counts[verdict] ?? 0) + 1;
  const report = {
    schema: "pdpp.connector-content-check.v1",
    commit: process.env.GITHUB_SHA ?? null,
    authenticated: Boolean(password),
    counts,
    results,
  };
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (reportPath) writeFileSync(reportPath, text);
  else process.stdout.write(text);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Advisory content check\n\n${results.map((result) => `- ${summaryLine(result)}`).join("\n")}\n\n`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    // Advisory: report and exit 0.
    console.log(`::warning::advisory content check did not complete: ${error.message}`);
  });
}

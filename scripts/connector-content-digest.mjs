// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The content identity of one built connector artifact.
//
//   content_digest = "sha256:" + sha256(sorted-key JSON of {
//     "v": 1,
//     "config": config.json with source.revision deleted,
//     "layers": [{ "mediaType", "diff_id" } for each layer in manifest order,
//                except provenance],
//   })
//
// `diff_id` is the sha256 of the UNCOMPRESSED layer bytes. One tar compressed
// by GNU gzip, pigz and zlib gives three different blob digests; the identity
// must not depend on which compressor the runner had.
//
// The config already carries `profile_digest` and `source_declaration_digest`,
// so the declaration is covered without its referrer. Provenance is excluded:
// it records the revision and host-provided package versions, which change on
// every commit without changing a shipped byte.
//
// This module reads files and computes. It makes no network call and runs no
// build. `digestArtifact` refuses an artifact built with an esbuild other than
// the lockfile's, which closes the builder's `--esbuild <path>` override.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const CONTENT_DIGEST_VERSION = 1;
export const PROVENANCE_MEDIA_TYPE = "application/vnd.pdpp.connector.provenance.v1+json";
export const CONTENT_DIGEST_ANNOTATION = "dev.pdpp.connector.content-digest";

// Far above any layer the builder emits; a bound so a hostile blob cannot
// inflate without limit.
const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export class ContentDigestError extends Error {}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** JSON with object keys sorted at every depth; arrays keep their order. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** sha256 of the uncompressed layer content. */
export function diffId(mediaType, bytes) {
  if (!mediaType.endsWith("+gzip")) return sha256(bytes);
  try {
    return sha256(gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED_BYTES }));
  } catch (error) {
    throw new ContentDigestError(`cannot gunzip a ${mediaType} layer: ${error.message}`);
  }
}

/** Parsed config.json with `source.revision` removed. */
export function configWithoutRevision(configBytes) {
  let config;
  try {
    config = JSON.parse(Buffer.from(configBytes).toString("utf8"));
  } catch (error) {
    throw new ContentDigestError(`config is not JSON: ${error.message}`);
  }
  if (config?.source && typeof config.source === "object") {
    const { revision: _revision, ...source } = config.source;
    config = { ...config, source };
  }
  return config;
}

/**
 * The digest over an already-reduced artifact. `layers` is every layer in
 * manifest order; provenance is dropped here so callers cannot forget it.
 */
export function contentDigestOf({ config, layers }) {
  const document = {
    v: CONTENT_DIGEST_VERSION,
    config,
    layers: layers
      .filter(({ mediaType }) => mediaType !== PROVENANCE_MEDIA_TYPE)
      .map(({ mediaType, diff_id }) => ({ mediaType, diff_id })),
  };
  return sha256(canonicalJson(document));
}

/** The esbuild version the root lockfile pins; the builder imports that one. */
export function lockfileEsbuildVersion(repoRoot) {
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
  const version = lock.packages?.["node_modules/esbuild"]?.version;
  if (typeof version !== "string") {
    throw new ContentDigestError("package-lock.json does not pin node_modules/esbuild");
  }
  return version;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ContentDigestError(`cannot read ${path}: ${error.message}`);
  }
}

/**
 * Digest a directory written by `build-connector-oci-artifact.mjs`.
 *
 * Returns the digest and the per-layer facts a comparison needs: the
 * compressed blob digest (the fast path against a registry) and the diff_id.
 */
export function digestArtifact(artifactDir, { esbuildVersion }) {
  if (typeof esbuildVersion !== "string" || esbuildVersion === "") {
    throw new ContentDigestError("the expected esbuild version is required");
  }
  const descriptor = readJson(join(artifactDir, "layers.json"));
  const provenance = readJson(join(artifactDir, "provenance.json"));
  const built = provenance?.build?.esbuild_version;
  if (built !== esbuildVersion) {
    throw new ContentDigestError(
      `artifact was built with esbuild ${JSON.stringify(built)}, but the lockfile pins ${esbuildVersion}; ` +
        "refusing to digest a build from an overridden bundler",
    );
  }

  const configBytes = readFileSync(join(artifactDir, descriptor.config.file));
  const config = configWithoutRevision(configBytes);
  const layers = descriptor.layers.map(({ file, mediaType }) => {
    const bytes = readFileSync(join(artifactDir, file));
    return { file, mediaType, digest: sha256(bytes), diff_id: diffId(mediaType, bytes) };
  });
  return {
    connector_key: config.connector_key,
    version: config.version,
    content_digest: contentDigestOf({ config, layers }),
    config,
    config_digest: sha256(configBytes),
    layers,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const index = args.indexOf("--artifact");
  if (index === -1 || !args[index + 1]) {
    console.error("usage: node scripts/connector-content-digest.mjs --artifact <dir>");
    process.exit(2);
  }
  try {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const result = digestArtifact(args[index + 1], { esbuildVersion: lockfileEsbuildVersion(repoRoot) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

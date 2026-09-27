// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The advisory content check, end to end against an in-memory GHCR.
//
// Each fixture is a built-artifact directory (the builder's output shape) and a
// registry that holds what a publish would have pushed. The registry enforces
// the Bearer handshake, and it answers a missing repository the way GHCR does:
// 403 at the token endpoint when anonymous, 404 NAME_UNKNOWN when authenticated.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  canonicalJson,
  ContentDigestError,
  CONTENT_DIGEST_ANNOTATION,
  digestArtifact,
} from "./connector-content-digest.mjs";
import { checkArtifact, compareSemver, createRegistryClient } from "./published-state.mjs";

const ESBUILD = "0.28.2";
const OWNER = "pdp-connect";
const CREDENTIAL = Buffer.from("actor:token").toString("base64");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The builder's compressor, and two others that must give the same content.
function gnuGzip(bytes) {
  const result = spawnSync("gzip", ["-n", "-9"], { input: bytes });
  assert.equal(result.status, 0, "gzip is required for this test");
  return result.stdout;
}
const pigzAvailable = spawnSync("pigz", ["--version"]).status === 0;
const pigz = (bytes) => spawnSync("pigz", ["-n", "-9"], { input: bytes }).stdout;
const zlibFast = (bytes) => gzipSync(bytes, { level: 1 });

const LAYERS = [
  ["collection-profile.json", "application/vnd.pdpp.connector.profile.v1+json"],
  ["code.tar.gz", "application/vnd.pdpp.connector.code.v1.tar+gzip"],
  ["licenses.tar.gz", "application/vnd.pdpp.connector.licenses.v1.tar+gzip"],
  ["provenance.json", "application/vnd.pdpp.connector.provenance.v1+json"],
];

const root = mkdtempSync(join(tmpdir(), "published-state-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
let counter = 0;

/** Write a directory in the shape `build-connector-oci-artifact.mjs` emits. */
function makeArtifact({
  key = "example",
  version = "0.1.2",
  code = "export const collect = 1;\n",
  licenses = "Apache-2.0\n",
  profile = { connector_key: "example" },
  displayName = "Example",
  revision = "a".repeat(40),
  esbuild = ESBUILD,
} = {}) {
  const dir = join(root, `artifact-${(counter += 1)}`);
  mkdirSync(dir);
  const files = {
    "collection-profile.json": Buffer.from(`${JSON.stringify(profile)}\n`),
    "code.tar.gz": gnuGzip(Buffer.from(code)),
    "licenses.tar.gz": gnuGzip(Buffer.from(licenses)),
    "provenance.json": Buffer.from(JSON.stringify({ source: { revision }, build: { esbuild_version: esbuild } })),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes);
  const config = {
    connector_key: key,
    version,
    display_name: displayName,
    profile_digest: sha256(files["collection-profile.json"]),
    source: { repository: "https://github.com/PDP-Connect/data-connectors", revision },
  };
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(dir, "layers.json"),
    JSON.stringify({
      config: { file: "config.json", mediaType: "application/vnd.pdpp.connector.config.v1+json" },
      layers: LAYERS.map(([file, mediaType]) => ({ file, mediaType })),
    }),
  );
  return dir;
}

/** An in-memory GHCR with the token handshake and the error shapes GHCR uses. */
function fakeRegistry({ failWith = null } = {}) {
  const repositories = new Map();
  const requests = [];
  const json = (status, value, headers = {}) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  const error = (status, code) => json(status, { errors: [{ code, message: code.toLowerCase() }] });

  async function fetchImpl(url, options = {}) {
    const target = new URL(url);
    const auth = options.headers?.authorization ?? "";
    requests.push(target.pathname);
    if (failWith) return failWith(target);

    if (target.pathname === "/token") {
      const repository = /^repository:(.+):pull$/.exec(target.searchParams.get("scope"))?.[1];
      if (!repositories.has(repository) && auth !== `Basic ${CREDENTIAL}`) return error(403, "DENIED");
      return json(200, { token: `t-${repository}` });
    }
    const match = /^\/v2\/(.+)\/(tags\/list|manifests\/[^/]+|blobs\/[^/]+)$/.exec(target.pathname);
    if (!auth.startsWith("Bearer ")) {
      return new Response("", {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${match?.[1]}:pull"`,
        },
      });
    }
    const repository = repositories.get(match[1]);
    if (!repository) return error(404, "NAME_UNKNOWN");
    const [kind, ref] = match[2].split("/");
    if (kind === "tags") return json(200, { name: match[1], tags: [...repository.tags.keys()] });
    if (kind === "manifests") {
      const bytes = repository.tags.get(decodeURIComponent(ref));
      if (!bytes) return error(404, "MANIFEST_UNKNOWN");
      return new Response(bytes, { status: 200, headers: { "docker-content-digest": sha256(bytes) } });
    }
    const blob = repository.blobs.get(ref);
    return blob ? new Response(blob, { status: 200 }) : error(404, "BLOB_UNKNOWN");
  }

  /** Push an artifact directory, optionally recompressing its gzip layers. */
  function publish(dir, { recompress = null, annotation = null, extraTags = [] } = {}) {
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    const name = `${OWNER}/connector/${config.connector_key}`;
    if (!repositories.has(name)) repositories.set(name, { tags: new Map(), blobs: new Map() });
    const repository = repositories.get(name);
    const put = (bytes) => {
      repository.blobs.set(sha256(bytes), bytes);
      return { digest: sha256(bytes), size: bytes.length };
    };
    const layers = LAYERS.map(([file, mediaType]) => {
      let bytes = readFileSync(join(dir, file));
      if (recompress && file.endsWith(".tar.gz")) bytes = recompress(zlibGunzip(bytes));
      return { mediaType, ...put(bytes), annotations: { "org.opencontainers.image.title": file } };
    });
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.pdpp.connector.config.v1+json", ...put(readFileSync(join(dir, "config.json"))) },
      layers,
      ...(annotation ? { annotations: { [CONTENT_DIGEST_ANNOTATION]: annotation } } : {}),
    };
    repository.tags.set(config.version, Buffer.from(JSON.stringify(manifest)));
    for (const tag of extraTags) repository.tags.set(tag, Buffer.from("{}"));
  }

  const manifestOf = (name, tag) => repositories.get(name).tags.get(tag).toString("utf8");
  return { fetchImpl, publish, requests, manifestOf };
}

function zlibGunzip(bytes) {
  return spawnSync("gzip", ["-d", "-c"], { input: bytes }).stdout;
}

function check(dir, registry, { credential = CREDENTIAL } = {}) {
  const client = createRegistryClient({
    credential,
    fetchImpl: registry.fetchImpl,
    sleep: async () => {},
  });
  return checkArtifact({ artifactDir: dir, esbuildVersion: ESBUILD, client, owner: OWNER });
}

test("a repository GHCR does not know is a new connector when the read is authenticated", async () => {
  const result = await check(makeArtifact({ key: "brand-new" }), fakeRegistry());
  assert.equal(result.verdict, "new-repository");
  assert.equal(result.flagged, false);
});

test("the same missing repository read anonymously is unknown, never absent", async () => {
  const result = await check(makeArtifact({ key: "brand-new" }), fakeRegistry(), { credential: null });
  assert.equal(result.verdict, "unknown");
  assert.match(result.reason, /token endpoint returned HTTP 403/);
});

test("an unpublished version higher than every published one is absent", async () => {
  const registry = fakeRegistry();
  registry.publish(makeArtifact({ version: "0.1.9" }), { extraTags: ["sha256-" + "b".repeat(64) + ".sig"] });
  const result = await check(makeArtifact({ version: "0.1.10", code: "changed" }), registry);
  assert.equal(result.verdict, "absent");
  assert.equal(result.max_published, "0.1.9");
});

test("an unpublished version at or below the published max is non-monotonic", async () => {
  const registry = fakeRegistry();
  registry.publish(makeArtifact({ version: "0.1.3" }));
  registry.publish(makeArtifact({ version: "0.1.5" }));
  const result = await check(makeArtifact({ version: "0.1.4" }), registry);
  assert.equal(result.verdict, "non-monotonic");
  assert.equal(result.flagged, true);
  assert.match(result.reason, /roll forward/);
});

test("a present version with the same content is present-equal, whatever the revision and provenance", async () => {
  const registry = fakeRegistry();
  registry.publish(makeArtifact({ revision: "1".repeat(40) }));
  const result = await check(makeArtifact({ revision: "2".repeat(40) }), registry);
  assert.equal(result.verdict, "present-equal");
  assert.equal(result.flagged, false);
  // Fast path: every layer matched by its compressed digest; only the config was read.
  assert.equal(result.blobs_downloaded, 1);
});

for (const [name, change, expected] of [
  ["code layer", { code: "export const collect = 2;\n" }, ["layer code.tar.gz"]],
  ["licenses layer", { licenses: "MIT\n" }, ["layer licenses.tar.gz"]],
  [
    "profile layer",
    { profile: { connector_key: "example", streams: [] } },
    ["config.profile_digest", "layer collection-profile.json"],
  ],
  ["config", { displayName: "Renamed" }, ["config.display_name"]],
]) {
  test(`a present version whose ${name} changed is present-differs, naming what changed`, async () => {
    const registry = fakeRegistry();
    registry.publish(makeArtifact());
    const result = await check(makeArtifact(change), registry);
    assert.equal(result.verdict, "present-differs");
    assert.equal(result.flagged, true);
    assert.deepEqual(result.differences, expected);
  });
}

test("a registry that keeps failing is unknown after three attempts", async () => {
  const registry = fakeRegistry({ failWith: () => new Response("busy", { status: 503 }) });
  const result = await check(makeArtifact(), registry);
  assert.equal(result.verdict, "unknown");
  assert.equal(result.flagged, true);
  assert.equal(registry.requests.length, 3);
});

test("a denied read is unknown, not absent", async () => {
  const registry = fakeRegistry({
    failWith: () => new Response(JSON.stringify({ errors: [{ code: "DENIED" }] }), { status: 403 }),
  });
  const result = await check(makeArtifact(), registry);
  assert.equal(result.verdict, "unknown");
  assert.match(result.reason, /HTTP 403/);
});

test("a 404 on the tag list without NAME_UNKNOWN is unknown", async () => {
  const registry = fakeRegistry({ failWith: () => new Response("<html>not found</html>", { status: 404 }) });
  assert.equal((await check(makeArtifact(), registry)).verdict, "unknown");
});

test("the signed annotation, when present, equals the derived digest and saves the blob reads", async () => {
  const published = makeArtifact({ revision: "1".repeat(40) });
  const derived = fakeRegistry();
  derived.publish(published);
  const viaDerivation = await check(makeArtifact(), derived);

  const annotated = fakeRegistry();
  annotated.publish(published, { annotation: digestArtifact(published, { esbuildVersion: ESBUILD }).content_digest });
  const viaAnnotation = await check(makeArtifact(), annotated);

  assert.equal(viaDerivation.published_source, "derived");
  assert.equal(viaAnnotation.published_source, "annotation");
  assert.equal(viaAnnotation.published_content_digest, viaDerivation.published_content_digest);
  assert.equal(viaAnnotation.verdict, "present-equal");
  assert.equal(viaAnnotation.blobs_downloaded, 0);
});

for (const [name, compress, skip] of [
  ["pigz", pigz, !pigzAvailable && "pigz is not installed"],
  ["zlib level 1", zlibFast, false],
]) {
  test(`a layer published through ${name} has the same content as the GNU gzip build`, { skip }, async () => {
    // Large enough that the compressors disagree (pigz works in 128 KiB blocks).
    const code = Array.from({ length: 8000 }, (_, i) => `export const v${i} = ${(i * 7919) % 1000};\n`).join("");
    const registry = fakeRegistry();
    registry.publish(makeArtifact({ code }), { recompress: compress });
    const local = makeArtifact({ code });
    const published = JSON.parse(registry.manifestOf(`${OWNER}/connector/example`, "0.1.2"));
    const localCode = digestArtifact(local, { esbuildVersion: ESBUILD }).layers.find((l) => l.file === "code.tar.gz");
    assert.notEqual(published.layers[1].digest, localCode.digest, "the compressors must produce different blobs");
    const result = await check(local, registry);
    assert.equal(result.verdict, "present-equal");
    // The config and the code layer were downloaded; the code layer was gunzipped.
    assert.ok(result.blobs_downloaded >= 2);
  });
}

test("an artifact built with an esbuild other than the lockfile's is refused", async () => {
  const dir = makeArtifact({ esbuild: "0.27.0" });
  assert.throws(() => digestArtifact(dir, { esbuildVersion: ESBUILD }), ContentDigestError);
  const result = await check(dir, fakeRegistry());
  assert.equal(result.verdict, "refused");
  assert.match(result.reason, /lockfile pins 0\.28\.2/);
});

test("the digest ignores JSON key order and formatting in the config", () => {
  const dir = makeArtifact();
  const before = digestArtifact(dir, { esbuildVersion: ESBUILD }).content_digest;
  const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  const reordered = Object.fromEntries(Object.entries(config).reverse());
  writeFileSync(join(dir, "config.json"), JSON.stringify(reordered));
  assert.equal(digestArtifact(dir, { esbuildVersion: ESBUILD }).content_digest, before);
  assert.equal(canonicalJson({ b: [2, { d: 1, c: 0 }], a: null }), '{"a":null,"b":[2,{"c":0,"d":1}]}');
});

test("semver precedence orders numerically and puts pre-releases first", () => {
  const sorted = ["0.1.10", "0.1.9", "0.2.0-rc.1", "0.2.0", "0.2.0-alpha", "0.2.0-rc.10", "0.2.0-rc.2"].sort(
    compareSemver,
  );
  assert.deepEqual(sorted, ["0.1.9", "0.1.10", "0.2.0-alpha", "0.2.0-rc.1", "0.2.0-rc.2", "0.2.0-rc.10", "0.2.0"]);
});

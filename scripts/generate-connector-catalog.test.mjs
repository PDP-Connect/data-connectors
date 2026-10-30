// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { FixtureRegistry, publishArtifact } from "../packages/connector-installer-core/oci-fixture.mjs";
import { assertCatalog } from "../packages/connector-installer-core/catalog-schema.mjs";
import {
  generateConnectorCatalog,
  serializeConnectorCatalog,
  projectCatalogBindings,
} from "./generate-connector-catalog.mjs";

const SOURCE_COMMIT = "a".repeat(40);
const GENERATED_AT = "2026-09-15T16:34:18Z";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixtureManifest(root, manifestName = "source_name", connectorKey = "public-name") {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${manifestName}.json`),
    `${JSON.stringify({
      connector_id: `https://registry.pdpp.dev/connectors/${connectorKey}`,
      connector_key: connectorKey,
      display_name: "Public Name",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: { modality: "static_secret" },
      capabilities: { public_listing: { tier: "supported" } },
    }, null, 2)}\n`,
  );
}

function fixtureManifestWithMetadata(root, {
  manifestName = "source_name",
  connectorKey = "public-name",
  connectorId = `https://registry.pdpp.dev/connectors/${connectorKey}`,
  displayName = "Public Name",
  bindings = { network: { required: true } },
  modality = "static_secret",
  tier = "supported",
} = {}) {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${manifestName}.json`),
    `${JSON.stringify({
      connector_id: connectorId,
      connector_key: connectorKey,
      display_name: displayName,
      runtime_requirements: { bindings },
      setup: { modality },
      capabilities: { public_listing: { tier } },
    }, null, 2)}\n`,
  );
}

async function startRegistry({
  malformedPagination = false,
  manifestFault = null,
  tagsFault = null,
  tokenFault = null,
  publishedRepository = "acme/connector/public-name",
  publishedVersions = ["1.1.0", "1.1.0-beta.1", "1.0.0"],
  runtimeBindings = undefined,
} = {}) {
  const registry = new FixtureRegistry({ challenge: true });
  registry.digests = new Map();
  for (const version of ["1.0.0", "1.1.0-beta.1", "1.1.0"]) {
    const artifact = publishArtifact(registry, {
      version,
      connectorKey: publishedRepository.split("/").at(-1),
      ...(runtimeBindings === undefined ? {} : { runtimeBindings }),
    });
    registry.digests.set(version, artifact.digest);
  }
  registry.setPublishedVersions = (versions) => {
    registry.tagLists.set(publishedRepository, {
      tags: [...versions, "latest", `sha256-${"4".repeat(64)}.sig`],
      pageSize: 1,
      ...(malformedPagination ? { nextLink: '</v2/other/repository/tags/list?last=1.0.0&n=100>; rel="next"' } : {}),
    });
  };
  registry.setPublishedVersions(publishedVersions);
  if (manifestFault) {
    registry.faultManifest(manifestFault, {
      status: 503,
      body: JSON.stringify({ errors: [{ code: "UNKNOWN" }] }),
    });
  }
  if (tagsFault) registry.pathFaults.set(`/v2/${publishedRepository}/tags/list`, tagsFault);
  if (tokenFault) registry.pathFaults.set("/token", tokenFault);
  return registry.start();
}

function runCli(registry, output, previousCatalog = null) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/generate-connector-catalog.mjs",
        "--registry", registry,
        "--namespace", "acme",
        "--source-commit", SOURCE_COMMIT,
        "--generated-at", GENERATED_AT,
        "--out", output,
        ...(previousCatalog ? ["--previous-catalog", previousCatalog] : []),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CONNECTOR_CATALOG_SCHEME: "http",
          CONNECTOR_CATALOG_ALLOW_INSECURE_TOKEN_REALM: "1",
        },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function fixtureDirectory() {
  const base = join(homedir(), ".tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, "connector-catalog-"));
}

async function generate(_sourceRoot, registry, overrides = {}) {
  return generateConnectorCatalog({
    registry,
    namespace: "acme",
    sourceCommit: SOURCE_COMMIT,
    generatedAt: GENERATED_AT,
    connectors: [{ manifest: "source_name", connectorKey: "public-name" }],
    scheme: "http",
    allowInsecureLoopback: true,
    ...overrides,
  });
}

test("catalog generation is deterministic, follows anonymous auth, and sorts semver tags", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry();
  try {
    fixtureManifest(root);
    const first = await generate(root, registry.registry);
    const second = await generate(root, registry.registry);
    assert.equal(serializeConnectorCatalog(first), serializeConnectorCatalog(second));
    assert.deepEqual(first.connectors[0].versions, [
      { version: "1.0.0", digest: registry.digests.get("1.0.0") },
      { version: "1.1.0-beta.1", digest: registry.digests.get("1.1.0-beta.1") },
      { version: "1.1.0", digest: registry.digests.get("1.1.0") },
    ]);
    assert.deepEqual(first.connectors[0].latest, {
      version: "1.1.0",
      digest: registry.digests.get("1.1.0"),
    });
    assert.equal(first.connectors[0].connector_key, "public-name");
    assert.equal(first.connectors[0].connector_id, "https://github.com/PDP-Connect/data-connectors/connector/public-name");
    assert.deepEqual(first.connectors[0].runtime_requirements.bindings, { network: { required: true } });
    assert.equal(first.connectors[0].setup.modality, "static_secret");
    assert.ok(registry.requests.some((url) => url.includes("/tags/list?last=")));
    assert.ok(registry.requestHeaders.some((request) =>
      request.url.includes("/manifests/") && request.authorization === "Bearer fixture-token",
    ));
    assert.ok(registry.requestHeaders.some((request) => request.url.startsWith("/token?")));
    assert.ok(registry.requestHeaders.filter((request) => request.url.startsWith("/token?")).every(
      (request) => request.authorization === undefined,
    ));
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("latest metadata comes from the published artifact, not an unpublished source manifest", async () => {
  const root = fixtureDirectory();
  const registry = new FixtureRegistry({ challenge: true });
  const artifact = publishArtifact(registry, {
    connectorKey: "public-name",
    connectorId: "https://registry.pdpp.dev/connectors/published-a",
    version: "1.0.0",
    displayName: "Published A",
    runtimeBindings: { network: { required: true } },
    setupModality: "static_secret",
    tier: "supported",
  });
  registry.tagLists.set("acme/connector/public-name", { tags: ["1.0.0"] });
  try {
    await registry.start();
    fixtureManifestWithMetadata(root, {
      connectorId: "https://registry.pdpp.dev/connectors/unpublished-b",
      displayName: "Unpublished B",
      bindings: { filesystem: { required: true } },
      modality: "manual_or_upload",
      tier: "development",
    });
    const catalog = await generate(root, registry.registry);
    assert.deepEqual(catalog.connectors[0], {
      connector_key: "public-name",
      connector_id: "https://registry.pdpp.dev/connectors/published-a",
      display_name: "Published A",
      tier: "supported",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: { modality: "static_secret" },
      latest: { version: "1.0.0", digest: artifact.digest },
      versions: [{ version: "1.0.0", digest: artifact.digest }],
    });
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalog refuses inconsistent published config metadata", async () => {
  for (const configOverrides of [
    { protocol_version: "9.9" },
    { runtime: { bindings: "filesystem" } },
    { runtime: { bindings: { filesystem: { required: true } } } },
  ]) {
    const root = fixtureDirectory();
    const registry = new FixtureRegistry({ challenge: true });
    publishArtifact(registry, {
      connectorKey: "public-name",
      version: "1.0.0",
      configOverrides,
    });
    registry.tagLists.set("acme/connector/public-name", { tags: ["1.0.0"] });
    try {
      await registry.start();
      fixtureManifest(root);
      await assert.rejects(
        generate(root, registry.registry),
        /config\.protocol_version|config runtime bindings/,
      );
    } finally {
      await registry.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("catalog refuses malformed published artifact layers", async () => {
  for (const mutateManifest of [
    (manifest) => { manifest.layers.push(null); },
    (manifest) => {
      manifest.layers.find((layer) => layer.mediaType.endsWith("code.v1.tar+gzip")).digest = "sha256:not-a-digest";
    },
  ]) {
    const root = fixtureDirectory();
    const registry = new FixtureRegistry({ challenge: true });
    const artifact = publishArtifact(registry, { connectorKey: "public-name", version: "1.0.0" });
    const manifest = structuredClone(artifact.manifest);
    mutateManifest(manifest);
    registry.putManifest(manifest, "1.0.0");
    registry.tagLists.set("acme/connector/public-name", { tags: ["1.0.0"] });
    try {
      await registry.start();
      fixtureManifest(root);
      await assert.rejects(
        generate(root, registry.registry),
        /unrecognised layer media type|code.*invalid digest/,
      );
    } finally {
      await registry.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("large code and asset layers do not trip the metadata download ceiling", async () => {
  // The 1 MiB ceiling protects the config and profile downloads. Code and asset
  // layers are never fetched by the generator and are routinely larger.
  const root = fixtureDirectory();
  const registry = new FixtureRegistry({ challenge: true });
  const artifact = publishArtifact(registry, { connectorKey: "public-name", version: "1.0.0" });
  const manifest = structuredClone(artifact.manifest);
  for (const layer of manifest.layers) {
    if (layer.mediaType.endsWith("code.v1.tar+gzip") || layer.mediaType.includes("assets")) {
      layer.size = 5 * 1024 * 1024;
    }
  }
  registry.putManifest(manifest, "1.0.0");
  registry.tagLists.set("acme/connector/public-name", { tags: ["1.0.0"] });
  try {
    await registry.start();
    fixtureManifest(root);
    const catalog = await generate(root, registry.registry);
    assert.equal(catalog.connectors.length, 1);
    assert.equal(catalog.connectors[0].latest.version, "1.0.0");
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized config or profile descriptor still refuses", async () => {
  for (const mutateManifest of [
    (manifest) => { manifest.config.size = 1024 * 1024 + 1; },
    (manifest) => {
      manifest.layers.find((layer) => layer.mediaType.includes("profile")).size = 1024 * 1024 + 1;
    },
  ]) {
    const root = fixtureDirectory();
    const registry = new FixtureRegistry({ challenge: true });
    const artifact = publishArtifact(registry, { connectorKey: "public-name", version: "1.0.0" });
    const manifest = structuredClone(artifact.manifest);
    mutateManifest(manifest);
    registry.putManifest(manifest, "1.0.0");
    registry.tagLists.set("acme/connector/public-name", { tags: ["1.0.0"] });
    try {
      await registry.start();
      fixtureManifest(root);
      await assert.rejects(generate(root, registry.registry), /invalid digest or size/);
    } finally {
      await registry.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("two full CLI runs write byte-identical catalogs from the same registry and source", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({
    publishedRepository: "acme/connector/apple-photos",
  });
  const firstPath = join(root, "first.json");
  const secondPath = join(root, "second.json");
  try {
    const first = await runCli(registry.registry, firstPath);
    const second = await runCli(registry.registry, secondPath, firstPath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(readFileSync(firstPath), readFileSync(secondPath));
    const catalog = JSON.parse(readFileSync(firstPath, "utf8"));
    assert.deepEqual(catalog.connectors.map((connector) => connector.connector_key), ["apple-photos"]);
    assert.equal(catalog.connectors[0].setup.modality, "static_secret");
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed registry content advances a tied source timestamp and the next retry is stable", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ publishedVersions: ["1.0.0"] });
  try {
    fixtureManifest(root);
    const first = await generate(root, registry.registry);
    registry.setPublishedVersions(["1.0.0", "1.1.0"]);
    const changed = await generate(root, registry.registry, { previousCatalog: first });
    const retry = await generate(root, registry.registry, { previousCatalog: changed });

    assert.ok(Date.parse(changed.generated_at) > Date.parse(first.generated_at));
    assert.equal(changed.generated_at, "2026-09-15T16:34:18.001Z");
    assert.equal(serializeConnectorCatalog(retry), serializeConnectorCatalog(changed));
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a legacy feature in the previous catalog does not block a valid catalog", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ publishedVersions: ["1.0.0"] });
  try {
    fixtureManifest(root);
    const current = await generate(root, registry.registry);
    const previousCatalog = structuredClone(current);
    previousCatalog.connectors[0].runtime_requirements.bindings.browser = {
      required: true,
      features: ["evaluate"],
    };

    assertCatalog(current);
    assert.throws(() => assertCatalog(previousCatalog), /does not match its schema/);

    const next = await generate(root, registry.registry, { previousCatalog });
    assertCatalog(next);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI exits nonzero without writing output when any manifest lookup is unknown", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({
    manifestFault: "1.1.0-beta.1",
    publishedRepository: "acme/connector/apple-photos",
  });
  const output = join(root, "catalog.json");
  try {
    const result = await runCli(registry.registry, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest lookup returned unknown/);
    assert.equal(existsSync(output), false);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI exits nonzero without writing output when published metadata is unavailable", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ publishedRepository: "acme/connector/apple-photos" });
  const latestDigest = registry.digests.get("1.1.0");
  const latestManifest = JSON.parse(registry.manifests.get(latestDigest).toString("utf8"));
  registry.blobs.delete(latestManifest.config.digest);
  const output = join(root, "catalog.json");
  try {
    const result = await runCli(registry.registry, output);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Failed to fetch blob/);
    assert.equal(existsSync(output), false);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unknown manifest lookup aborts the whole catalog", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ manifestFault: "1.1.0-beta.1" });
  try {
    fixtureManifest(root);
    await assert.rejects(
      generate(root, registry.registry),
      /1\.1\.0-beta\.1 was listed but manifest lookup returned unknown/,
    );
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("pagination that leaves the requested repository fails closed", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ malformedPagination: true });
  try {
    fixtureManifest(root);
    await assert.rejects(generate(root, registry.registry), /pagination escaped the registry repository/);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact NAME_UNKNOWN tags response omits a never-published connector", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({
    tagsFault: {
      status: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errors: [{ code: "NAME_UNKNOWN", message: "repository unknown" }] }),
    },
  });
  try {
    fixtureManifest(root);
    const catalog = await generate(root, registry.registry);
    assert.deepEqual(catalog.connectors, []);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bare tags 404 fails closed", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({
    tagsFault: { status: 404, headers: {}, body: "" },
  });
  try {
    fixtureManifest(root);
    await assert.rejects(generate(root, registry.registry), /tags endpoint returned HTTP 404/);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a token endpoint 404 fails closed instead of claiming the repository is absent", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({
    tokenFault: { status: 404, headers: {}, body: "not found" },
  });
  try {
    fixtureManifest(root);
    await assert.rejects(generate(root, registry.registry), /token endpoint returned HTTP 404/);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

const ANONYMOUS_DENIAL = {
  status: 403,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ errors: [{ code: "DENIED", message: "requested access to the resource is denied" }] }),
};
const CREDENTIAL = Buffer.from("publisher:token").toString("base64");

test("a never-created repository is omitted when the registry credential is sent, though anonymous auth answers 403", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry();
  try {
    registry.tagLists.delete("acme/connector/public-name");
    registry.anonymousTokenFault = ANONYMOUS_DENIAL;
    fixtureManifest(root);
    const catalog = await generate(root, registry.registry, { credential: CREDENTIAL });
    assert.deepEqual(catalog.connectors, []);
    assert.ok(registry.requestHeaders.some((request) =>
      request.url.startsWith("/token?") && request.authorization === `Basic ${CREDENTIAL}`,
    ), "the credential must reach the token endpoint");
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a never-created repository without the credential fails closed on the anonymous 403", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry();
  try {
    registry.tagLists.delete("acme/connector/public-name");
    registry.anonymousTokenFault = ANONYMOUS_DENIAL;
    fixtureManifest(root);
    await assert.rejects(generate(root, registry.registry), /token endpoint returned HTTP 403/);
    assert.ok(registry.requestHeaders.every((request) => request.authorization === undefined));
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an authenticated token denial still fails closed rather than omitting the connector", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({
    tokenFault: ANONYMOUS_DENIAL,
  });
  try {
    fixtureManifest(root);
    await assert.rejects(
      generate(root, registry.registry, { credential: CREDENTIAL }),
      /token endpoint returned HTTP 403/,
    );
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a partial publish leaves the last published version as latest, not the failed newer one", async () => {
  // 1.1.0 failed to publish, so GHCR holds only the older tags. The catalog must
  // keep 1.1.0-beta.1 as latest rather than omit the connector or invent 1.1.0.
  const root = fixtureDirectory();
  const registry = await startRegistry({ publishedVersions: ["1.0.0", "1.1.0-beta.1"] });
  try {
    fixtureManifest(root);
    const catalog = await generate(root, registry.registry);
    assert.deepEqual(catalog.connectors[0].latest, {
      version: "1.1.0-beta.1",
      digest: registry.digests.get("1.1.0-beta.1"),
    });
    assert.deepEqual(catalog.connectors[0].versions.map((entry) => entry.version), ["1.0.0", "1.1.0-beta.1"]);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the generated catalog validates against the shared schema", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry();
  try {
    fixtureManifest(root);
    const catalog = await generate(root, registry.registry);
    assert.equal(assertCatalog(catalog), catalog);
    const invalid = structuredClone(catalog);
    invalid.connectors[0].versions[0].digest = "sha256:not-a-digest";
    assert.throws(() => assertCatalog(invalid), /does not match its schema/);
    const impossibleDate = structuredClone(catalog);
    impossibleDate.generated_at = "2026-02-30T00:00:00Z";
    assert.throws(() => assertCatalog(impossibleDate), /does not match its schema/);
    const mismatchedLatest = structuredClone(catalog);
    mismatchedLatest.connectors[0].latest.digest = registry.digests.get("1.0.0");
    assert.throws(() => assertCatalog(mismatchedLatest), /latest entry.*match the last version/);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding-specific profile members stay out of the catalog so bundled catalog schemas still validate", async () => {
  const root = fixtureDirectory();
  const runtimeBindings = {
    filesystem: {
      required: true,
      inputs: [{ env_var: "EXAMPLE_EXPORT_DIR", kind: "dir", access: "read", accepted_extensions: [".zip"] }],
    },
    desktop_session: { required: true, rationale: "The key unwraps only through the session keyring." },
    network: { required: false, features: ["host_http_request"] },
  };
  const registry = await startRegistry({ publishedVersions: ["1.0.0"], runtimeBindings });
  try {
    fixtureManifestWithMetadata(root, { bindings: runtimeBindings });
    const catalog = await generate(root, registry.registry);
    assert.equal(assertCatalog(catalog), catalog);
    assert.deepEqual(catalog.connectors[0].runtime_requirements.bindings, {
      filesystem: { required: true },
      desktop_session: { required: true },
      network: { required: false, features: ["host_http_request"] },
    });

    const unprojected = structuredClone(catalog);
    unprojected.connectors[0].runtime_requirements.bindings.filesystem = runtimeBindings.filesystem;
    assert.throws(() => assertCatalog(unprojected), /does not match its schema/);
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the installer-side catalog schema accepts the real github_browser and strava_browser binding declarations", () => {
  // These two connectors declare host_http_request on both their browser and
  // network bindings (Collection Profile Section 3.3.8's named legacy
  // exception, schemas/connector-manifest.schema.json#/$defs/legacyBrowserFeature).
  // This proves the installer path they actually go through -- the catalog an
  // installer validates its own bundled schema against, not the connector
  // manifest schema directly -- accepts them, because projectCatalogBindings
  // only keeps `required` and `features`, and the catalog schema's feature
  // enum (bindingFeature) was never kind-restricted in the first place.
  for (const connectorKey of ["github_browser", "strava_browser"]) {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "connectors", connectorKey, "manifest.json"), "utf8"),
    );
    const bindings = manifest.runtime_requirements.bindings;
    assert.ok(
      bindings.browser.features.includes("host_http_request"),
      `${connectorKey}: expected host_http_request under browser in the fixture manifest, sources drifted`,
    );
    const digest = `sha256:${"a".repeat(64)}`;
    const catalogKey = connectorKey.replaceAll("_", "-");
    const catalog = {
      catalog_version: "1.0",
      generated_at: GENERATED_AT,
      source_commit: SOURCE_COMMIT,
      connectors: [
        {
          connector_key: catalogKey,
          connector_id: `https://registry.pdpp.dev/connectors/${catalogKey}`,
          display_name: manifest.display_name,
          tier: "development",
          runtime_requirements: { bindings: projectCatalogBindings(bindings) },
          setup: { modality: null },
          latest: { version: "1.0.0", digest },
          versions: [{ version: "1.0.0", digest }],
        },
      ],
    };
    assert.equal(assertCatalog(catalog), catalog, `${connectorKey}: expected the catalog schema to accept it`);
  }
});

test("catalog metadata keeps Loom and Whole Foods at Development", async () => {
  const registry = new FixtureRegistry({ challenge: true });
  const rows = [
    { manifest: "loom", connectorKey: "loom" },
    { manifest: "wholefoods", connectorKey: "wholefoods" },
  ];
  for (const { connectorKey } of rows) {
    const version = connectorKey === "loom" ? "0.1.0" : "0.1.1";
    publishArtifact(registry, {
      connectorKey,
      displayName: connectorKey === "loom" ? "Loom" : "Whole Foods",
      version,
      tier: "development",
    });
    registry.tagLists.set(`acme/connector/${connectorKey}`, { tags: [version] });
  }
  try {
    await registry.start();
    const catalog = await generate(null, registry.registry, { connectors: rows });
    assert.equal(assertCatalog(catalog), catalog);
    assert.deepEqual(
      catalog.connectors.map(({ connector_key, tier }) => ({ connector_key, tier })),
      [
        { connector_key: "loom", tier: "development" },
        { connector_key: "wholefoods", tier: "development" },
      ],
    );
  } finally {
    await registry.stop();
  }
});

test("catalog refuses a known scaffold whose published artifact claims Supported", async () => {
  const registry = new FixtureRegistry({ challenge: true });
  publishArtifact(registry, {
    connectorKey: "loom",
    displayName: "Loom",
    version: "0.1.0",
    tier: "supported",
  });
  registry.tagLists.set("acme/connector/loom", { tags: ["0.1.0"] });
  try {
    await registry.start();
    await assert.rejects(
      generate(null, registry.registry, { connectors: [{ manifest: "loom", connectorKey: "loom" }] }),
      /known scaffold connector 'loom': published tier must remain at Development/,
    );
  } finally {
    await registry.stop();
  }
});

test("identity mismatches and exclusions are refused before any registry request", async () => {
  for (const connector of [
    { manifest: "amazon", connectorKey: "loom" },
    { manifest: "loom", connectorKey: "amazon" },
    { manifest: "youtube_takeout", connectorKey: "youtube-takeout" },
  ]) {
    let requests = 0;
    const refuseRegistry = async () => {
      requests += 1;
      throw new Error("registry contacted");
    };
    await assert.rejects(
      generateConnectorCatalog({
        registry: "registry.invalid",
        namespace: "acme",
        sourceCommit: SOURCE_COMMIT,
        generatedAt: GENERATED_AT,
        connectors: [connector],
        requestImpl: refuseRegistry,
        lookupImpl: refuseRegistry,
        fetchImpl: refuseRegistry,
      }),
      /refusing to publish/,
      JSON.stringify(connector),
    );
    assert.equal(requests, 0, `${JSON.stringify(connector)} reached the registry`);
  }
});

test("ordinary and unknown synthetic identities pass the publish guard", async () => {
  const registry = await startRegistry({ publishedRepository: "acme/connector/apple-photos" });
  try {
    const catalog = await generateConnectorCatalog({
      registry: registry.registry,
      namespace: "acme",
      sourceCommit: SOURCE_COMMIT,
      generatedAt: GENERATED_AT,
      connectors: [
        { manifest: "apple_photos", connectorKey: "apple-photos", exclusionReason: null },
        { manifest: "source_name", connectorKey: "public-name" },
      ],
      scheme: "http",
      allowInsecureLoopback: true,
    });
    assert.deepEqual(catalog.connectors.map((connector) => connector.connector_key), ["apple-photos"]);
  } finally {
    await registry.stop();
  }
});

test("a refresh drops a previously published scaffold entry and the next run is stable", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ publishedVersions: ["1.0.0"] });
  try {
    fixtureManifest(root);
    const current = await generate(root, registry.registry);
    const [synthetic] = current.connectors;
    const previous = {
      ...structuredClone(current),
      connectors: [
        structuredClone(synthetic),
        {
          ...structuredClone(synthetic),
          connector_key: "loom",
          connector_id: "https://registry.pdpp.dev/connectors/loom",
          display_name: "Loom",
        },
      ],
    };

    const refreshed = await generate(root, registry.registry, { previousCatalog: previous });
    assert.deepEqual(refreshed.connectors.map((connector) => connector.connector_key), ["public-name"]);
    assert.deepEqual(refreshed.connectors[0].latest, synthetic.latest);
    assert.equal(refreshed.generated_at, "2026-09-15T16:34:18.001Z");

    const retry = await generate(root, registry.registry, { previousCatalog: refreshed });
    assert.equal(serializeConnectorCatalog(retry), serializeConnectorCatalog(refreshed));
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the CLI refresh drops excluded entries from the previous catalog and repeats byte for byte", async () => {
  const root = fixtureDirectory();
  const registry = await startRegistry({ publishedRepository: "acme/connector/apple-photos" });
  const seedPath = join(root, "seed.json");
  const previousPath = join(root, "previous.json");
  const firstPath = join(root, "first.json");
  const secondPath = join(root, "second.json");
  try {
    const seed = await runCli(registry.registry, seedPath);
    assert.equal(seed.status, 0, seed.stderr);
    const seeded = JSON.parse(readFileSync(seedPath, "utf8"));
    const [photos] = seeded.connectors;
    writeFileSync(previousPath, JSON.stringify({
      ...seeded,
      source_commit: "b".repeat(40),
      connectors: [
        photos,
        { ...photos, connector_key: "loom", connector_id: "https://registry.pdpp.dev/connectors/loom", display_name: "Loom" },
        { ...photos, connector_key: "wholefoods", connector_id: "https://registry.pdpp.dev/connectors/wholefoods", display_name: "Whole Foods" },
      ],
    }));

    const first = await runCli(registry.registry, firstPath, previousPath);
    const second = await runCli(registry.registry, secondPath, firstPath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const refreshed = JSON.parse(readFileSync(firstPath, "utf8"));
    assert.deepEqual(refreshed.connectors.map((connector) => connector.connector_key), ["apple-photos"]);
    assert.equal(refreshed.generated_at, "2026-09-15T16:34:18.001Z");
    assert.deepEqual(readFileSync(firstPath), readFileSync(secondPath));
  } finally {
    await registry.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

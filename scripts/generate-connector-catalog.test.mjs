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
} = {}) {
  const registry = new FixtureRegistry({ challenge: true });
  registry.digests = new Map();
  for (const version of ["1.0.0", "1.1.0-beta.1", "1.1.0"]) {
    const artifact = publishArtifact(registry, { version, connectorKey: publishedRepository.split("/").at(-1) });
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

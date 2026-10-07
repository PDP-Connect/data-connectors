// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Ajv from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

import { DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY } from "../packages/connector-installer-core/index.mjs";
import {
  INDEX_BUNDLE_PATH,
  buildReleaseIndex,
  repositoryArtifactReader,
  repositoryRoot,
  sha256,
} from "./build-connector-release-index.mjs";
import { releaseSubjects, signSubjects } from "./sign-connector-release.mjs";

const schema = JSON.parse(readFileSync(join(repositoryRoot, "schemas/connector-index.schema.json"), "utf8"));
const validate = new Ajv({ strict: false, validateFormats: false }).compile(schema);
const SHA = "f".repeat(40);
const TAG = `connectors-${SHA.slice(0, 12)}`;
const ID = `github-${SHA}`;
const REPO = "PDP-Connect/data-connectors";

function entry(connectorId, version, bytes, overrides = {}) {
  return {
    connectorId,
    company: connectorId.replace(/-playwright$/, ""),
    version,
    name: connectorId,
    status: "stable",
    description: `${connectorId} ${version}`,
    sourceFiles: { script: `${connectorId}.js`, metadata: `${connectorId}.json` },
    publishedAt: "2026-10-07T00:00:00Z",
    sourceTag: "main",
    sourceCommit: "a".repeat(40),
    releaseId: "connectors-aaaaaaaaaaaa",
    pageApiVersion: 1,
    manifestSha256: sha256(Buffer.from("manifest")),
    scriptSha256: sha256(Buffer.from("script")),
    artifactSha256: bytes ? sha256(bytes) : `sha256:${"0".repeat(64)}`,
    artifactPath: `artifacts/${connectorId}/${connectorId}-${version}.tgz`,
    artifactUrl: `https://raw.githubusercontent.com/${REPO}/${"a".repeat(40)}/artifacts/${connectorId}/${connectorId}-${version}.tgz`,
    scopes: [`${connectorId}.scope`],
    ...overrides,
  };
}

function fixture() {
  const local = Buffer.from("local tarball bytes");
  const newer = Buffer.from("newer tarball bytes");
  const files = {
    "artifacts/alpha-playwright/alpha-playwright-2.0.0.tgz": local,
    "artifacts/alpha-playwright/alpha-playwright-1.0.0.tgz": null,
    "artifacts/beta-playwright/beta-playwright-3.1.0.tgz": newer,
  };
  const index = {
    indexVersion: "2.0",
    sourceRepo: `https://github.com/${REPO}`,
    generatedAt: "2026-08-13T00:00:00Z",
    brandIcons: { "https://registry.pdpp.dev/connectors/alpha": { url: "https://example.test/alpha.svg" } },
    connectors: {
      "beta-playwright": [entry("beta-playwright", "3.1.0", newer)],
      "alpha-playwright": [
        entry("alpha-playwright", "2.0.0", local),
        entry("alpha-playwright", "1.0.0", null, {
          releaseId: "github-" + "b".repeat(40),
          artifactUrl: "https://github.com/vana-com/data-connectors/releases/download/connectors-bbbbbbbbbbbb/alpha-playwright-1.0.0.tgz",
          artifactSignature: { type: "sigstoreBundle", bundlePath: "alpha-playwright-1.0.0.tgz.sigstore.json" },
        }),
      ],
    },
  };
  return { index, readArtifact: (path) => files[path] ?? null, local, newer };
}

test("entries with a committed tarball point at the release asset and declare its bundle", () => {
  const { index, readArtifact } = fixture();
  const { doc, published, retained } = buildReleaseIndex({ index, releaseTag: TAG, releaseId: ID, repository: REPO, readArtifact, generatedAt: "2026-10-07T12:00:00Z" });
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.deepEqual(doc.signature, { type: "sigstoreBundle", bundlePath: INDEX_BUNDLE_PATH });
  assert.equal(doc.generatedAt, "2026-10-07T12:00:00Z");
  assert.deepEqual(doc.brandIcons, index.brandIcons);
  const alpha2 = doc.connectors["alpha-playwright"].find((candidate) => candidate.version === "2.0.0");
  assert.equal(alpha2.releaseId, ID);
  assert.equal(alpha2.artifactUrl, `https://github.com/${REPO}/releases/download/${TAG}/alpha-playwright-2.0.0.tgz`);
  assert.deepEqual(alpha2.artifactSignature, {
    type: "sigstoreBundle",
    bundlePath: "alpha-playwright-2.0.0.tgz.sigstore.json",
    bundleUrl: `https://github.com/${REPO}/releases/download/${TAG}/alpha-playwright-2.0.0.tgz.sigstore.json`,
  });
  assert.equal(alpha2.artifactPath, "artifacts/alpha-playwright/alpha-playwright-2.0.0.tgz", "artifactPath stays repository-relative");
  assert.deepEqual(published.map((item) => item.assetName).sort(), ["alpha-playwright-2.0.0.tgz", "beta-playwright-3.1.0.tgz"]);
  assert.deepEqual(retained, [{ connectorId: "alpha-playwright", version: "1.0.0", artifactPath: "artifacts/alpha-playwright/alpha-playwright-1.0.0.tgz" }]);
});

test("entries without a committed tarball are kept exactly as committed", () => {
  const { index, readArtifact } = fixture();
  const { doc } = buildReleaseIndex({ index, releaseTag: TAG, releaseId: ID, repository: REPO, readArtifact });
  const alpha1 = doc.connectors["alpha-playwright"].find((candidate) => candidate.version === "1.0.0");
  assert.deepEqual(alpha1, index.connectors["alpha-playwright"][1]);
});

test("the release index is sorted by connector id and ascending version", () => {
  const { index, readArtifact } = fixture();
  const { doc } = buildReleaseIndex({ index, releaseTag: TAG, releaseId: ID, repository: REPO, readArtifact });
  assert.deepEqual(Object.keys(doc.connectors), ["alpha-playwright", "beta-playwright"]);
  assert.deepEqual(doc.connectors["alpha-playwright"].map((candidate) => candidate.version), ["1.0.0", "2.0.0"]);
});

test("a committed tarball whose digest differs from the index stops the build", () => {
  const { index, local } = fixture();
  const tampered = (path) => (path.endsWith("alpha-playwright-2.0.0.tgz") ? Buffer.concat([local, Buffer.from("!")]) : null);
  assert.throws(
    () => buildReleaseIndex({ index, releaseTag: TAG, releaseId: ID, repository: REPO, readArtifact: tampered }),
    /alpha-playwright@2\.0\.0: .* connector-index\.json says sha256:/,
  );
});

test("release tag, release id and repository are validated", () => {
  const { index, readArtifact } = fixture();
  const base = { index, repository: REPO, readArtifact };
  assert.throws(() => buildReleaseIndex({ ...base, releaseTag: "latest", releaseId: ID }), /connectors-<sha12>/);
  assert.throws(() => buildReleaseIndex({ ...base, releaseTag: TAG, releaseId: "connectors-ffffffffffff" }), /github-<sha40>/);
  assert.throws(() => buildReleaseIndex({ ...base, releaseTag: TAG, releaseId: ID, repository: "https://github.com/x/y" }), /owner\/name/);
});

test("the committed index builds: every committed tarball is published, the rest retained, output validates", () => {
  const index = JSON.parse(readFileSync(join(repositoryRoot, "connector-index.json"), "utf8"));
  const { doc, published, retained } = buildReleaseIndex({
    index,
    releaseTag: TAG,
    releaseId: ID,
    repository: REPO,
    readArtifact: repositoryArtifactReader(),
  });
  assert.ok(validate(doc), JSON.stringify(validate.errors));
  assert.ok(published.length > 0);
  for (const item of published) {
    assert.ok(readFileSync(join(repositoryRoot, item.artifactPath)).length > 0);
  }
  for (const item of retained) {
    assert.equal(repositoryArtifactReader()(item.artifactPath), null, `${item.artifactPath} exists but was retained`);
  }
  const total = Object.values(doc.connectors).reduce((sum, entries) => sum + entries.length, 0);
  assert.equal(published.length + retained.length, total);
});

test("the artifact reader refuses paths outside the repository", () => {
  assert.throws(() => repositoryArtifactReader()("../outside.tgz"), /outside the repository/);
  assert.throws(() => repositoryArtifactReader()("/etc/passwd"), /outside the repository/);
});

test("release subjects are the index, the frozen catalog files and every published tarball, each with an <asset>.sigstore.json bundle", async () => {
  const root = mkdtempSync(join(tmpdir(), "connector-release-lane-"));
  try {
    const output = join(root, "release");
    mkdirSync(join(root, "schemas"), { recursive: true });
    mkdirSync(join(root, "artifacts/alpha-playwright"), { recursive: true });
    mkdirSync(output, { recursive: true });
    writeFileSync(join(root, "scope-catalog.json"), "{}");
    writeFileSync(join(root, "schemas/scope-catalog.schema.json"), "{}");
    writeFileSync(join(root, "artifacts/alpha-playwright/alpha-playwright-2.0.0.tgz"), "tgz");
    writeFileSync(join(output, "connector-index.json"), "{}");
    writeFileSync(
      join(output, "published.json"),
      JSON.stringify({ published: [{ artifactPath: "artifacts/alpha-playwright/alpha-playwright-2.0.0.tgz", assetName: "alpha-playwright-2.0.0.tgz" }] }),
    );
    const subjects = releaseSubjects({ root, output });
    assert.deepEqual(
      subjects.map((subject) => subject.bundlePath.replace(`${output}/`, "")),
      [
        "connector-index.json.sigstore.json",
        "scope-catalog.json.sigstore.json",
        "scope-catalog.schema.json.sigstore.json",
        "alpha-playwright-2.0.0.tgz.sigstore.json",
      ],
    );
    const signed = [];
    const count = await signSubjects(subjects, async (bytes) => {
      signed.push(createHash("sha256").update(bytes).digest("hex"));
      return { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", signed: signed.length };
    });
    assert.equal(count, 4);
    assert.equal(JSON.parse(readFileSync(join(output, "alpha-playwright-2.0.0.tgz.sigstore.json"), "utf8")).signed, 4);
    assert.equal(signed[3], createHash("sha256").update("tgz").digest("hex"), "the tarball bytes are what gets signed");
    rmSync(join(root, "artifacts/alpha-playwright/alpha-playwright-2.0.0.tgz"));
    assert.throws(() => releaseSubjects({ root, output }), /release subject is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the publish workflow is the pinned signing identity, runs only by hand, and signs before it publishes", () => {
  const path = join(repositoryRoot, ".github/workflows/publish-connector-release-index.yml");
  const source = readFileSync(path, "utf8");
  const workflow = parseYaml(source);
  assert.ok(
    DEFAULT_SIGSTORE_CERTIFICATE_IDENTITY.endsWith("/.github/workflows/publish-connector-release-index.yml@refs/heads/main"),
    "the installer pins this workflow file on main",
  );
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"], "dispatch only: a merge never publishes by itself");
  assert.equal(workflow.permissions["id-token"], "write");
  assert.equal(workflow.permissions.contents, "write");
  const steps = workflow.jobs.publish.steps.map((step) => step.name ?? step.uses ?? step.run);
  const indexOf = (pattern) => steps.findIndex((step) => pattern.test(String(step)));
  const build = indexOf(/Build the release index/);
  const sign = indexOf(/Sign the release subjects/);
  const immutable = indexOf(/Publish the immutable release/);
  const latest = indexOf(/Publish the latest signed index/);
  assert.ok(build >= 0 && sign > build && immutable > sign && latest > immutable, `step order: ${steps.join(" | ")}`);
  assert.match(source, /refs\/heads\/main/);
  assert.match(source, /release\/connector-index\.json\.sigstore\.json/);
  for (const uses of workflow.jobs.publish.steps.map((step) => step.uses).filter(Boolean)) {
    assert.match(uses, /@[a-f0-9]{40}( |$)/, `${uses}: actions are pinned to a commit`);
  }
});

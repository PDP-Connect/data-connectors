// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HUB_URL, renderCatalogFeed, TOPIC_URL } from "../static-feed.mjs";

const catalog = {
  catalog_version: "1.0",
  generated_at: "2026-10-29T12:00:00.000Z",
  source_commit: "a".repeat(40),
  connectors: [],
};
const digest = `sha256:${"b".repeat(64)}`;
const hub = "https://hub.example/";

test("a verified catalog produces a deterministic neutral Atom hint", () => {
  const feed = renderCatalogFeed({ catalog, digest, hub });
  assert.equal(feed, renderCatalogFeed({ catalog, digest, hub }));
  assert.equal(TOPIC_URL, "https://registry.pdpp.dev/catalog/updates.atom");
  assert.match(feed, /xmlns="http:\/\/www\.w3\.org\/2005\/Atom"/);
  assert.ok(feed.includes(`<link rel="self" href="${TOPIC_URL}"/>`));
  assert.ok(feed.includes(`<link rel="hub" href="${hub}"/>`));
  assert.ok(feed.includes(`urn:pdpp:connector-catalog:${digest}`));
  assert.ok(feed.includes(catalog.source_commit));
  assert.ok(feed.includes(catalog.generated_at));
  assert.doesNotMatch(feed, /repository_dispatch|client_payload|installationId/);
});

test("malformed catalog metadata, digest, or hub fails closed", () => {
  assert.throws(() => renderCatalogFeed({ catalog, digest: "latest", hub }));
  assert.throws(() => renderCatalogFeed({ catalog: { ...catalog, source_commit: "bad" }, digest, hub }));
  assert.throws(() => renderCatalogFeed({ catalog: { ...catalog, generated_at: "bad" }, digest, hub }));
  assert.throws(() => renderCatalogFeed({ catalog: { ...catalog, connectors: "bad" }, digest, hub }));
  assert.throws(() => renderCatalogFeed({ catalog, digest, hub: "http://hub.example/" }));
});

test("the CLI writes a feed only for valid catalog input", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "catalog-feed-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "catalog.json");
  const output = join(directory, "site", "catalog", "updates.atom");
  const cli = fileURLToPath(new URL("../static-feed.mjs", import.meta.url));
  writeFileSync(source, JSON.stringify(catalog));
  const run = (selectedDigest) => spawnSync(process.execPath, [
    cli, "--catalog", source, "--digest", selectedDigest, "--out", output,
  ], { encoding: "utf8" });
  assert.equal(run(digest).status, 0);
  assert.equal(readFileSync(output, "utf8"), renderCatalogFeed({ catalog, digest, hub: HUB_URL }));
  const rejected = run("sha256:invalid");
  assert.notEqual(rejected.status, 0);
  assert.equal(readFileSync(output, "utf8"), renderCatalogFeed({ catalog, digest, hub: HUB_URL }));
});

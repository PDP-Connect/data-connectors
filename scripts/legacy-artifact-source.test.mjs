// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A legacy connector artifact (`artifacts/<id>/<id>-<version>.tgz`) that has
// its unpacked source committed beside it (`artifacts/<id>/<id>-<version>/`)
// must be exactly that source, packed. The directory is what a reviewer reads
// and what a host vendors; the tarball is what the installer verifies by
// hash. This test keeps the two from drifting, and keeps the committed
// connector-index.json digests pointing at those bytes.
//
// Reproduce the tarball from the directory with GNU tar:
//   tar --sort=name --owner=0 --group=0 --numeric-owner \
//       --mtime='1970-01-01 00:00:00 UTC' -cf - . | gzip -n -9

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { readTarGzEntries } from "../packages/connector-installer-core/tar-stream.mjs";

const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..");
const artifactsDir = join(repoRoot, "artifacts");
const index = JSON.parse(readFileSync(join(repoRoot, "connector-index.json"), "utf8"));
const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

function sha256(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

function walkFiles(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walkFiles(full, root) : [relative(root, full)];
    });
}

// Every `<id>-<version>/` directory under artifacts/<id>/ that sits beside a
// `<id>-<version>.tgz`.
function sourcedArtifacts() {
  const out = [];
  for (const connectorId of readdirSync(artifactsDir)) {
    const dir = join(artifactsDir, connectorId);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const sourceDir = join(dir, name);
      if (!statSync(sourceDir).isDirectory()) continue;
      const match = name.match(/^(.+)-(\d+\.\d+\.\d+)$/);
      assert.ok(match, `${relative(repoRoot, sourceDir)}: source directory must be named <id>-<version>`);
      assert.equal(match[1], connectorId, `${relative(repoRoot, sourceDir)}: must be named after its connector`);
      const tgz = `${sourceDir}.tgz`;
      assert.ok(existsSync(tgz), `${relative(repoRoot, sourceDir)}: no ${name}.tgz beside the source directory`);
      out.push({ connectorId, version: match[2], sourceDir, tgz });
    }
  }
  return out;
}

const sourced = sourcedArtifacts();

test("at least one legacy artifact carries its unpacked source", () => {
  assert.ok(sourced.length > 0);
});

for (const { connectorId, version, sourceDir, tgz } of sourced) {
  const label = `${connectorId}@${version}`;

  test(`${label}: the tarball is exactly the committed source directory`, async () => {
    const entries = await readTarGzEntries(readFileSync(tgz), { maxUnpackedBytes: MAX_UNPACKED_BYTES });
    const packed = new Map(entries.map((entry) => [entry.path.replace(/^\.\//, ""), entry.buffer]));
    const files = walkFiles(sourceDir);
    assert.deepEqual([...packed.keys()].sort(), files, `${label}: tarball members differ from the source files`);
    for (const file of files) {
      assert.ok(
        packed.get(file).equals(readFileSync(join(sourceDir, file))),
        `${label}: ${file} differs between the tarball and the source directory`,
      );
    }
  });

  test(`${label}: connector-index.json digests point at these bytes`, () => {
    const entry = (index.connectors[connectorId] ?? []).find((candidate) => candidate.version === version);
    assert.ok(entry, `${label}: missing from connector-index.json`);
    assert.equal(entry.artifactPath, relative(repoRoot, tgz));
    assert.equal(entry.artifactSha256, sha256(readFileSync(tgz)));
    assert.equal(entry.manifestSha256, sha256(readFileSync(join(sourceDir, "manifest.json"))));
    assert.equal(entry.scriptSha256, sha256(readFileSync(join(sourceDir, "script.js"))));
    const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, version, `${label}: manifest.version must match the artifact version`);
    assert.equal(manifest.connector_id ?? manifest.id, connectorId);
  });
}

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("artifact version overrides preserve pinned inputs and reject invalid versions", () => {
  const temporaryBase = join(homedir(), ".tmp");
  mkdirSync(temporaryBase, { recursive: true });
  const upstreamRoot = mkdtempSync(join(temporaryBase, "pdpp-version-test-"));
  const artifactId = basename(upstreamRoot).toLowerCase();
  const connectorRoot = join(repoRoot, "connectors", artifactId);
  const git = (...args) => execFileSync("git", args, { cwd: upstreamRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const manifestBytes = '{ "version": "0.1.1", "runtime_requirements": { "bindings": {} }, "streams": [] }\n';
  try {
    mkdirSync(connectorRoot);
    mkdirSync(join(upstreamRoot, "runtime"));
    writeFileSync(join(upstreamRoot, "manifest.json"), manifestBytes);
    writeFileSync(join(upstreamRoot, "entry.ts"), 'export { value } from "./runtime/value.ts";\n');
    writeFileSync(join(upstreamRoot, "runtime/value.ts"), 'export const value = "pinned";\n');
    git("init");
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "fixture");
    const specification = {
      artifact_id: artifactId,
      artifact_kind: "pdpp-collection-profile",
      upstream: {
        repository: "https://example.com/fixture",
        commit: git("rev-parse", "HEAD").trim(),
        manifest: "manifest.json",
        entrypoint: "entry.ts",
        connector_files: ["manifest.json", "entry.ts"],
        runtime_root: "runtime",
      },
      build: { format: "esm", platform: "node", target: "node22" },
    };
    const writeDescriptor = (descriptor) => writeFileSync(join(connectorRoot, "artifact.json"), `${JSON.stringify(descriptor, null, 2)}\n`);
    const build = () => spawnSync(process.execPath, ["scripts/build-pdpp-artifact.mjs", "--artifact", artifactId, "--pdpp-root", upstreamRoot], { cwd: repoRoot, encoding: "utf8" });
    writeDescriptor(specification);
    let result = build();
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = join(connectorRoot, "collection-profile.json");
    const provenancePath = join(connectorRoot, "provenance.json");
    const bundlePath = join(connectorRoot, "dist", "collection-profile.mjs");
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
    const originalBundle = readFileSync(bundlePath);

    writeDescriptor({ ...specification, artifact_version: "0.1.2" });
    result = build();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(manifestPath)), { ...JSON.parse(manifestBytes), version: "0.1.2" });
    assert.deepEqual(readFileSync(bundlePath), originalBundle);
    const provenance = JSON.parse(readFileSync(provenancePath));
    assert.equal(provenance.source_inventory.upstream_connector.find((input) => input.path === "manifest.json").sha256, sha256(manifestBytes));
    assert.equal(provenance.source_inventory.maintained_local[0].sha256, sha256(readFileSync(join(connectorRoot, "artifact.json"))));
    assert.equal(provenance.outputs["profile/collection-profile.json"], sha256(readFileSync(manifestPath)));

    const manifestBefore = readFileSync(manifestPath);
    const provenanceBefore = readFileSync(provenancePath);
    for (const artifactVersion of [null, 123, "", "1.2", "01.2.3", "1.2.3-rc.1", "1.2.3\n"]) {
      writeDescriptor({ ...specification, artifact_version: artifactVersion });
      result = build();
      assert.notEqual(result.status, 0, `must reject ${JSON.stringify(artifactVersion)}`);
      assert.match(result.stderr, /artifact_version must be a major.minor.patch version/);
      assert.deepEqual(readFileSync(manifestPath), manifestBefore);
      assert.deepEqual(readFileSync(provenancePath), provenanceBefore);
      assert.deepEqual(readFileSync(bundlePath), originalBundle);
      assert.equal(existsSync(join(connectorRoot, ".pinned-source")), false);
    }
  } finally {
    rmSync(connectorRoot, { recursive: true, force: true });
    rmSync(upstreamRoot, { recursive: true, force: true });
  }
});

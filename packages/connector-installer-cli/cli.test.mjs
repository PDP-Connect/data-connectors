// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The CLI's input contract and exit status, driven through the COMMAND
// ENTRYPOINT as a real subprocess over real lock files. The refusals happen
// before any network request. The exit-status test needs a completed verify,
// so it runs the CLI under fixture-registry-preload.mjs against the in-process
// registry of oci-fixture.mjs; nothing contacts GHCR.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FixtureRegistry,
  createSigner,
  ociLockEntry,
  publishArtifact,
} from "../connector-installer-core/oci-fixture.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "index.mjs");
const PRELOAD = join(HERE, "fixture-registry-preload.mjs");

/** Run the CLI as a subprocess and return status, stdout and stderr. */
async function runCli(args, { env, preload = false } = {}) {
  try {
    const node = preload ? ["--import", PRELOAD, CLI] : [CLI];
    const { stdout, stderr } = await execFileAsync(process.execPath, [...node, ...args], {
      encoding: "utf8",
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "installer-cli-test-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeLock(dir, lock) {
  const path = join(dir, "connectors-lock.json");
  writeFileSync(path, JSON.stringify(lock, null, 2));
  return path;
}

/** A tarball-index entry: the shape the removed index transport installed. */
function entryWithoutOci() {
  return {
    connectorId: "acme-playwright",
    company: "acme",
    version: "1.0.0",
    artifactUrl: "https://example.invalid/acme-1.0.0.tgz",
    artifactSha256: `sha256:${"b".repeat(64)}`,
    manifestSha256: `sha256:${"c".repeat(64)}`,
    scriptSha256: `sha256:${"d".repeat(64)}`,
  };
}

for (const command of ["install", "verify"]) {
  test(`${command} refuses a lock entry that is not an OCI Collection Profile`, async () => {
    await withTempDir(async (dir) => {
      const lockPath = writeLock(dir, { lockVersion: "2.0", connectors: [entryWithoutOci()] });
      const result = await runCli([
        command,
        "--lock",
        lockPath,
        "--install-root",
        join(dir, "install"),
        "--layout",
        "snapshot",
      ]);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /acme-playwright has no oci block/);
    });
  });

  test(`${command} refuses an option it does not define`, async () => {
    await withTempDir(async (dir) => {
      const lockPath = writeLock(dir, { lockVersion: "2.0", connectors: [] });
      const result = await runCli([
        command,
        "--lock",
        lockPath,
        "--install-root",
        join(dir, "install"),
        "--layout",
        "snapshot",
        "--index-url",
        "https://example.invalid/connector-index.json",
      ]);

      assert.equal(result.code, 1);
      assert.match(result.stderr, /Unknown option --index-url/);
    });
  });
}

for (const command of ["lock", "updates"]) {
  test(`\`${command}\` is not a command`, async () => {
    const result = await runCli([command]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Usage:/);
  });
}

test("verify of an empty lock reports ok and exits 0", async () => {
  await withTempDir(async (dir) => {
    const lockPath = writeLock(dir, { lockVersion: "2.0", connectors: [] });
    const result = await runCli([
      "verify",
      "--lock",
      lockPath,
      "--install-root",
      join(dir, "install"),
      "--layout",
      "snapshot",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"ok": true/);
  });
});

test("verify reports an `ok:false` result as a failed process", async () => {
  // A gate that prints `"ok": false` and exits 0 reports every tampered tree
  // as a pass. This needs a verify that COMPLETES and disagrees, so the CLI
  // installs and verifies a real signed artifact from the fixture registry.
  const registry = await new FixtureRegistry({}).start();
  try {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });
    const env = {
      CLI_FIXTURE_REGISTRY: registry.registry,
      CLI_FIXTURE_PUBLIC_KEY: signer.publicKey.export({ type: "spki", format: "pem" }),
    };
    const entry = ociLockEntry(registry, digest);
    entry.oci.registry = "ghcr.io";

    await withTempDir(async (dir) => {
      const lockPath = writeLock(dir, { lockVersion: "2.0", connectors: [entry] });
      const installRoot = join(dir, "install");
      const args = (command) => [command, "--lock", lockPath, "--install-root", installRoot, "--layout", "snapshot"];

      const installed = await runCli(args("install"), { env, preload: true });
      assert.equal(installed.code, 0, `install must succeed: ${installed.stderr}`);

      const clean = await runCli(args("verify"), { env, preload: true });
      assert.equal(clean.code, 0, `a matching tree verifies and exits 0: ${clean.stderr}`);
      assert.match(clean.stdout, /"ok": true/);

      writeFileSync(join(installRoot, "collection-profiles/ynab-pdpp/dist/collection-profile.mjs"), "tampered\n");

      const mismatched = await runCli(args("verify"), { env, preload: true });
      assert.match(mismatched.stdout, /"ok": false/, "the result itself reports the mismatch");
      assert.match(mismatched.stdout, /collection-profiles\/ynab-pdpp\/dist\/collection-profile\.mjs/);
      assert.equal(mismatched.code, 1, "an `ok:false` verification must exit nonzero");
    });
  } finally {
    await registry.stop();
  }
});

test("an explicit OCI pull refuses an escaping connector ID before installing", async () => {
  await withTempDir(async (dir) => {
    const installRoot = join(dir, "install");
    const result = await runCli([
      "install", "--oci", `ghcr.io/pdp-connect/connector/ynab@sha256:${"a".repeat(64)}`,
      "--connector-id", "../outside", "--install-root", installRoot,
      "--layout", "snapshot", "--prune",
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /invalid connector id/i);
    assert.equal(existsSync(installRoot), false);
    assert.equal(existsSync(join(dir, "outside")), false);
  });
});

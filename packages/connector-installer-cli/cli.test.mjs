// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The CLI's index-source decision and exit status, driven through the COMMAND
// ENTRYPOINT.
//
// These spawn `connector-installer` as a real subprocess over real lock files,
// because the defect they pin was not in `installFromLock()` — that function
// already dispatches per entry and never consults `source` for an OCI entry.
// The defect was in the command, which chose the index source from whether
// `--oci` was typed and so loaded the index for a lock of digest-pinned OCI
// entries anyway. A test calling the core directly cannot see that; only one
// that runs the command can.
//
// The index server here counts requests. That count IS the assertion: an
// OCI-only lock must produce zero, and must still produce zero when the server
// is failing every request, because a pinned lock that stops working when an
// unrelated service is down is the thing being fixed.

import assert from "node:assert/strict";
import test from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");

/**
 * A stand-in for the signed-index service that records every request.
 *
 * `mode: "fail"` answers 500, which is how "the old index is unavailable" is
 * expressed: the point of a digest-pinned lock is that this server's health
 * stops mattering.
 */
async function startIndexServer({ mode = "serve", doc = { connectors: {} } } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (mode === "fail") {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("index unavailable");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(doc));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/connector-index.json`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Run the CLI as a subprocess and return status, stdout and stderr. */
async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
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

const DIGEST = `sha256:${"a".repeat(64)}`;

function ociOnlyLock() {
  return {
    lockVersion: "2.0",
    connectors: [
      {
        connectorId: "https://github.com/PDP-Connect/data-connectors/connector/ynab",
        connectorKey: "ynab",
        version: "0.3.0",
        artifactKind: "pdpp-collection-profile",
        manifestPath: "profile/collection-profile.json",
        entrypointPath: "dist/collection-profile.mjs",
        provenancePath: "provenance.json",
        oci: { registry: "ghcr.io", repository: "pdp-connect/connector/ynab", digest: DIGEST },
      },
    ],
  };
}

/** One legacy tarball entry — the twelve `*-playwright` connectors' shape. */
function legacyEntry() {
  return {
    connectorId: "https://github.com/PDP-Connect/data-connectors/connector/acme-playwright",
    company: "acme",
    version: "1.0.0",
    artifactUrl: "https://example.invalid/acme-1.0.0.tgz",
    artifactSha256: `sha256:${"b".repeat(64)}`,
    manifestSha256: `sha256:${"c".repeat(64)}`,
    scriptSha256: `sha256:${"d".repeat(64)}`,
  };
}

/**
 * A local index holding one real, installable legacy connector.
 *
 * Local mode reads the artifact off disk and checks it against the lock's
 * digests, so this is a complete install with no network and no signature
 * service — which is what makes a COMPLETED verification, and therefore an
 * honest `ok:false`, reachable from a test.
 */
function buildLocalIndex(dir) {
  const root = join(dir, "index-root");
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });

  const manifest = JSON.stringify({ name: "acme", version: "1.0.0" });
  const script = "module.exports = {};\n";
  writeFileSync(join(bundle, "manifest.json"), manifest);
  writeFileSync(join(bundle, "script.js"), script);

  const artifactPath = join(root, "artifact.tgz");
  execFileSync("tar", ["-czf", artifactPath, "-C", bundle, "."]);
  const artifactBuffer = readFileSync(artifactPath);
  const sha = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

  const entry = {
    connectorId: "acme-playwright",
    company: "acme",
    version: "1.0.0",
    artifactPath: "artifact.tgz",
    artifactUrl: "https://example.invalid/acme-1.0.0.tgz",
    artifactSha256: sha(artifactBuffer),
    manifestSha256: sha(Buffer.from(manifest)),
    scriptSha256: sha(Buffer.from(script)),
  };

  writeFileSync(
    join(root, "connector-index.json"),
    JSON.stringify({ indexVersion: "1.0", connectors: { [entry.connectorId]: [entry] } })
  );

  // The snapshot layout the installer writes for a legacy entry.
  return { root, entry, installedFile: join("scripts", "acme-playwright.js") };
}

function writeLock(dir, lock) {
  const path = join(dir, "connectors-lock.json");
  writeFileSync(path, JSON.stringify(lock, null, 2));
  return path;
}

for (const command of ["install", "verify"]) {
  test(`${command} of an OCI-only lock never contacts the index`, async () => {
    await withTempDir(async (dir) => {
      const index = await startIndexServer();
      try {
        const lockPath = writeLock(dir, ociOnlyLock());
        const result = await runCli([
          command,
          "--lock",
          lockPath,
          "--install-root",
          join(dir, "install"),
          "--layout",
          "snapshot",
          "--index-url",
          index.url,
        ]);

        assert.deepEqual(
          index.requests,
          [],
          `${command} must not request the index for a digest-pinned OCI lock`
        );
        // The pull itself fails — there is no registry at ghcr.io serving this
        // fixture digest — and that is fine: the claim under test is which
        // services the command depends on, and the failure must be the
        // REGISTRY's, never the index's.
        assert.doesNotMatch(
          `${result.stdout}${result.stderr}`,
          /connector-index\.json|index unavailable/,
          `${command} must not fail at the index`
        );
      } finally {
        await index.stop();
      }
    });
  });

  test(`${command} of an OCI-only lock is unaffected by a failing index`, async () => {
    await withTempDir(async (dir) => {
      const index = await startIndexServer({ mode: "fail" });
      try {
        const lockPath = writeLock(dir, ociOnlyLock());
        const result = await runCli([
          command,
          "--lock",
          lockPath,
          "--install-root",
          join(dir, "install"),
          "--layout",
          "snapshot",
          "--index-url",
          index.url,
        ]);

        assert.deepEqual(
          index.requests,
          [],
          `${command} must not reach a failing index for a pinned OCI lock`
        );
        const output = `${result.stdout}${result.stderr}`;
        assert.doesNotMatch(
          output,
          /index unavailable|connector-index\.json/,
          `${command} must not surface the index's failure`
        );
        // It gets as far as the registry, which is the only service a
        // digest-pinned OCI entry legitimately depends on. Before the repair
        // this failed at the index and never reached here.
        assert.match(
          output,
          /pdp-connect\/connector\/ynab/,
          `${command} must fail at the registry, not before it`
        );
      } finally {
        await index.stop();
      }
    });
  });

  test(`${command} of a lock naming a legacy entry still loads the index once`, async () => {
    // The positive control, and the reason this is not simply "never load the
    // index": the twelve legacy `*-playwright` connectors keep the tarball path
    // until they are ported or retired, so a mixed lock must still fetch it.
    await withTempDir(async (dir) => {
      const index = await startIndexServer();
      try {
        const mixed = ociOnlyLock();
        mixed.connectors.push(legacyEntry());
        const lockPath = writeLock(dir, mixed);
        await runCli([
          command,
          "--lock",
          lockPath,
          "--install-root",
          join(dir, "install"),
          "--layout",
          "snapshot",
          "--index-url",
          index.url,
        ]);

        assert.equal(
          index.requests.length,
          1,
          `${command} must load the index exactly once for a mixed lock`
        );
      } finally {
        await index.stop();
      }
    });
  });
}

test("verify exits nonzero when the installed tree does not match the lock", async () => {
  // A command-line gate that prints `"ok": false` and exits 0 reports every
  // tampered tree as a pass to whatever runs it.
  await withTempDir(async (dir) => {
    const index = await startIndexServer();
    try {
      // A lock with no entries verifies an empty expectation against an empty
      // root, which is the `ok: true` control; the mismatch case is driven by a
      // legacy entry whose files are absent from the install root.
      const lockPath = writeLock(dir, { lockVersion: "2.0", connectors: [] });
      const ok = await runCli([
        "verify",
        "--lock",
        lockPath,
        "--install-root",
        join(dir, "install"),
        "--layout",
        "snapshot",
        "--index-url",
        index.url,
      ]);
      assert.equal(ok.code, 0, "a lock that verifies exits 0");
      assert.match(ok.stdout, /"ok": true/);
    } finally {
      await index.stop();
    }
  });
});

test("verify reports an `ok:false` result as a failed process", async () => {
  // The inherited defect exactly: the command printed the result and returned
  // normally, so `{"ok": false}` exited 0 and a gate reading the status saw a
  // pass. This needs a verify that COMPLETES and disagrees — an artifact that
  // fetches fine against a tree that no longer matches it — because a verify
  // that throws exits nonzero for an unrelated reason and would pass this
  // assertion without the repair.
  await withTempDir(async (dir) => {
    const local = buildLocalIndex(dir);
    const lockPath = writeLock(dir, { lockVersion: "2.0", connectors: [local.entry] });
    const installRoot = join(dir, "install");

    const installed = await runCli([
      "install",
      "--lock",
      lockPath,
      "--install-root",
      installRoot,
      "--layout",
      "snapshot",
      "--from-local",
      local.root,
    ]);
    assert.equal(installed.code, 0, `install must succeed: ${installed.stderr}`);

    const clean = await runCli([
      "verify",
      "--lock",
      lockPath,
      "--install-root",
      installRoot,
      "--layout",
      "snapshot",
      "--from-local",
      local.root,
    ]);
    assert.equal(clean.code, 0, "a matching tree verifies and exits 0");
    assert.match(clean.stdout, /"ok": true/);

    // Now the tree stops matching what the lock says it should be.
    rmSync(join(installRoot, local.installedFile), { force: true });

    const mismatched = await runCli([
      "verify",
      "--lock",
      lockPath,
      "--install-root",
      installRoot,
      "--layout",
      "snapshot",
      "--from-local",
      local.root,
    ]);
    assert.match(mismatched.stdout, /"ok": false/, "the result itself reports the mismatch");
    assert.notEqual(mismatched.code, 0, "an `ok:false` verification must exit nonzero");
  });
});

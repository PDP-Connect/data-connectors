// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// End-to-end proof that `verifyOciSignature`'s cosign v3 bundle path works
// against a REAL container registry and a REAL `cosign sign`/`oras push` —
// not this package's own fixtures, which encode this package's own
// understanding of the wire format and therefore cannot catch a mismatch
// between that understanding and what cosign and a real registry actually
// do. That mismatch is exactly what shipped in an earlier revision: the
// fixture served the bundle manifest directly at the fallback tag, matching
// the (wrong) assumption `fetchBundleManifest` made, while a real registry
// resolves that tag to an OCI IMAGE INDEX wrapping the manifest. Both were
// wrong the same way, so the fixture-only test suite passed anyway.
//
// SKIPS BY DEFAULT. This test starts a `registry:3.1.1` container via the
// Docker CLI and shells out to real `cosign` and `oras` binaries, none of
// which this repository's other tests require and none of which this
// repository's CI is set up to provide. It runs only when
// `PDPP_TEST_LIVE_OCI_REGISTRY=1` is set, `docker` is on PATH, and
// `COSIGN_BIN`/`ORAS_BIN` point at real v3.1.3 / v1.3.3 (or later) binaries.
// Run it locally with all three set; do not add it to CI without also
// adding the docker-service infrastructure this repository does not
// currently have (data-connect's managed-connector-oci-e2e.yml is the
// pattern to follow if that infrastructure gets built here).
//
// WHICH DISCOVERY PATH THIS EXERCISES. `registry:3.1.1` does not implement
// the OCI 1.1 `/referrers/` API (confirmed: distribution/distribution has no
// referrers-related source at this tag, and the endpoint returns a bare 404,
// not a distribution-spec-shaped one). So this test proves the TAG-SCHEMA
// FALLBACK path, which is also the only path either of this consumer's two
// real registries (this one and ghcr.io, per the live GHCR test in
// oci-live-ghcr.test.mjs) is actually known to exercise today. The
// referrers-API branch is proven in oci-identity.test.mjs instead, against a
// fixture registry configured to support it, since no real registry
// available to this test suite does.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { verifyOciSignature } from "./oci-verify.mjs";

const RUN = process.env.PDPP_TEST_LIVE_OCI_REGISTRY === "1";
const COSIGN_BIN = process.env.COSIGN_BIN ?? "cosign";
const ORAS_BIN = process.env.ORAS_BIN ?? "oras";

test("live registry:3.1.1 + real cosign v3 + real oras (tag-schema path)", { skip: !RUN }, async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), "oci-live-registry-"));
  let containerName;
  let port;

  t.after(() => {
    if (containerName) {
      try {
        execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
      } catch {
        // best effort; a leaked container from a failed test run is a
        // cleanup nuisance, not a reason to mask the real failure
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  containerName = `oci-live-registry-test-${process.pid}`;
  const psOutput = execFileSync("docker", [
    "run", "-d", "--rm",
    "--name", containerName,
    "-p", "0:5000",
    "registry:3.1.1",
  ]).toString().trim();
  assert.ok(psOutput.length > 0, "docker run produced no container id");

  const portMap = execFileSync("docker", ["port", containerName, "5000/tcp"]).toString().trim();
  const match = /:(\d+)$/.exec(portMap.split("\n")[0]);
  assert.ok(match, `could not parse published port from: ${portMap}`);
  port = match[1];
  const registry = `127.0.0.1:${port}`;

  // Wait for the registry to answer, rather than a fixed sleep: `docker run`
  // returning does not mean the HTTP server inside is accepting connections
  // yet, and a fixed sleep is either too short under load or a wasted wait
  // otherwise.
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      execFileSync("curl", ["-sf", `http://${registry}/v2/`], { stdio: "ignore" });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`registry:3.1.1 did not become ready within 15s`);
      execFileSync("sleep", ["0.3"]);
    }
  }

  const repository = "pdp-connect/connector/live-test";
  const configPath = join(workDir, "config.json");
  const filePath = join(workDir, "file.txt");
  writeFileSync(configPath, JSON.stringify({ connector_key: "live-test" }));
  writeFileSync(filePath, "live registry e2e fixture content\n");

  const pushOutput = execFileSync(ORAS_BIN, [
    "push", "--plain-http",
    `${registry}/${repository}:1.0.0`,
    "--artifact-type", "application/vnd.pdpp.connector.v1+json",
    "--config", `config.json:application/vnd.pdpp.connector.config.v1+json`,
    "--format", "json",
    "file.txt",
  ], { cwd: workDir }).toString();
  const pushed = JSON.parse(pushOutput);
  const digest = pushed.digest;
  assert.match(digest, /^sha256:[0-9a-f]{64}$/, `oras push did not report a usable digest: ${pushed.digest}`);

  execFileSync(COSIGN_BIN, ["generate-key-pair"], {
    cwd: workDir,
    env: { ...process.env, COSIGN_PASSWORD: "" },
  });

  execFileSync(COSIGN_BIN, [
    "sign", "--key", "cosign.key", "--yes", "--allow-http-registry",
    `${registry}/${repository}@${digest}`,
  ], { cwd: workDir, env: { ...process.env, COSIGN_PASSWORD: "" } });

  const publicKeyPath = join(workDir, "cosign.pub");
  const { readFileSync } = await import("node:fs");
  const publicKey = readFileSync(publicKeyPath, "utf8");

  const result = await verifyOciSignature({
    registry,
    repository,
    digest,
    scheme: "http",
    certificateIdentityResolver: () => "unused-for-key-based-trust",
    // `verifyOciSignature`'s bundle path always calls its injected verifier
    // as `sigstoreVerifier(bundleJson, options)` — no separate payload
    // argument, since a DSSE bundle carries its own payload. This mirrors
    // that exact call shape rather than the real `sigstore.verify()`'s
    // 2-or-3-arg public dispatch, which is a different function with a
    // different contract.
    //
    // Key-based trust here, matching this test's key-based `cosign sign`
    // above. A real Actions run signs keylessly against Fulcio/Rekor
    // instead — proven structurally correct by oci-identity.test.mjs's
    // synthetic-CA tests, since neither this environment nor this test can
    // produce a real Fulcio-issued certificate. What THIS test proves is
    // that the discovery and manifest-shape handling work against bytes a
    // real `cosign sign` actually wrote, which the synthetic tests cannot:
    // they build the bundle by hand.
    sigstoreVerifier: async (bundle) => {
      const { verify } = await import("sigstore");
      return verify(bundle, { keySelector: () => publicKey });
    },
  });

  assert.equal(result.certificateIdentityURI, "unused-for-key-based-trust");
});

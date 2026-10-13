// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The lock-entry contract of index.mjs: what it refuses, and that it refuses
// before any registry request. Runs against the in-process fixture registry
// in oci-fixture.mjs; nothing contacts GHCR.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FixtureRegistry,
  PINNED_IDENTITY,
  createFixtureVerifier,
  createSigner,
  ociLockEntry,
  publishArtifact,
} from "./oci-fixture.mjs";
import { fetchResolvedArtifact, installFromLock, verifyInstalled } from "./index.mjs";

function fixtureOptions(registry, signer) {
  return {
    ociScheme: "http",
    allowedOciRegistries: new Set([registry.registry]),
    ociCertificateIdentityResolver: () => PINNED_IDENTITY,
    sigstoreVerifier: createFixtureVerifier(signer),
    retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
  };
}

async function withRegistry(run) {
  const registry = await new FixtureRegistry({}).start();
  try {
    return await run(registry);
  } finally {
    await registry.stop();
  }
}

test("a lock entry that is not a signed OCI Collection Profile is refused before any request", async () => {
  await withRegistry(async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });
    const installRoot = mkdtempSync(join(tmpdir(), "oci-refuse-"));
    const { oci: _oci, ...withoutOci } = ociLockEntry(registry, digest);
    const { artifactKind: _kind, ...withoutKind } = ociLockEntry(registry, digest);

    try {
      for (const [label, entry, pattern] of [
        ["no oci block", withoutOci, /has no oci block/],
        ["no artifact kind", withoutKind, /Unsupported artifact kind "undefined"/],
        ["another artifact kind", ociLockEntry(registry, digest, { artifactKind: "legacy" }), /Unsupported artifact kind "legacy"/],
        ["an escaping manifest path", ociLockEntry(registry, digest, { manifestPath: "../manifest.json" }), /Invalid pdpp manifest path/],
        ["an absolute entrypoint path", ociLockEntry(registry, digest, { entrypointPath: "/dist/collection-profile.mjs" }), /Invalid pdpp entrypoint path/],
        ["a backslash provenance path", ociLockEntry(registry, digest, { provenancePath: "dist\\provenance.json" }), /Invalid pdpp provenance path/],
      ]) {
        registry.requests.length = 0;
        await assert.rejects(
          () =>
            installFromLock({
              lock: { connectors: [entry] },
              source: null,
              installRoot,
              layout: "snapshot",
              ...fixtureOptions(registry, signer),
            }),
          pattern,
          label
        );
        assert.deepEqual(registry.requests, [], `${label}: refused before any registry request`);
      }
      assert.deepEqual(readdirSync(installRoot), [], "nothing is written for a refused entry");
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

test("an index source is refused rather than ignored", async () => {
  await withRegistry(async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });
    const entry = ociLockEntry(registry, digest);
    const source = { mode: "local", rootDir: tmpdir() };
    registry.requests.length = 0;

    await assert.rejects(
      () => fetchResolvedArtifact(source, entry, fixtureOptions(registry, signer)),
      /index sources are not supported/
    );
    for (const run of [installFromLock, verifyInstalled]) {
      await assert.rejects(
        () =>
          run({
            lock: { connectors: [entry] },
            source,
            installRoot: join(tmpdir(), "never-written"),
            layout: "snapshot",
            ...fixtureOptions(registry, signer),
          }),
        /index sources are not supported/
      );
    }
    assert.deepEqual(registry.requests, []);
  });
});

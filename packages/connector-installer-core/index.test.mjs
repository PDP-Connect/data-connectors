// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Native filesystem safety and lock-entry refusal contracts. OCI tests use
// the in-process fixture registry; nothing contacts GHCR.

import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import test, { after } from "node:test";
import {
  FixtureRegistry,
  PINNED_IDENTITY,
  createFixtureVerifier,
  createSigner,
  ociLockEntry,
  publishArtifact,
} from "./oci-fixture.mjs";
import { fetchResolvedArtifact, installFromLock, pruneInstalled, toPortableArtifactPath, verifyInstalled } from "./index.mjs";

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

const temporaryRoots = [];
after(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

function createTempDir(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

test("normalizes extracted artifact paths to the portable POSIX contract", () => {
  const windowsRelativePath = win32.relative(
    "D:\\artifact\\bundle",
    "D:\\artifact\\bundle\\profile\\collection-profile.json",
  );
  const posixRelativePath = posix.relative(
    "/artifact/bundle",
    "/artifact/bundle/profile/collection-profile.json",
  );

  assert.equal(windowsRelativePath, "profile\\collection-profile.json");
  assert.equal(
    toPortableArtifactPath(windowsRelativePath, win32.sep),
    "profile/collection-profile.json",
  );
  assert.equal(
    toPortableArtifactPath(posixRelativePath, posix.sep),
    "profile/collection-profile.json",
  );
});

test("pruning preserves configured link subtrees and removes only unpreserved links", () => {
  const installRoot = createTempDir("prune-install-test-");
  const externalRoot = createTempDir("prune-external-test-");
  const externalFile = join(externalRoot, "must-survive.txt");
  writeFileSync(externalFile, "outside\n");
  writeFileSync(join(installRoot, "expected.txt"), "expected\n");
  writeFileSync(join(installRoot, ".legacy-file"), "hidden\n");
  mkdirSync(join(installRoot, ".legacy-directory", "nested"), { recursive: true });
  writeFileSync(join(installRoot, ".legacy-directory", "nested", "state.txt"), "hidden\n");
  symlinkSync(externalRoot, join(installRoot, "preserved-link"));
  mkdirSync(join(installRoot, "preserved-subtree"), { recursive: true });
  symlinkSync(externalRoot, join(installRoot, "preserved-subtree", "nested-link"));
  symlinkSync(externalRoot, join(installRoot, "remove-link"));

  pruneInstalled({
    installRoot,
    expectedPaths: ["expected.txt"],
    preserveTopLevel: ["preserved-link", "preserved-subtree"],
  });

  assert.equal(lstatSync(join(installRoot, "preserved-link")).isSymbolicLink(), true);
  assert.equal(lstatSync(join(installRoot, "preserved-subtree", "nested-link")).isSymbolicLink(), true);
  assert.equal(readFileSync(join(installRoot, ".legacy-file"), "utf8"), "hidden\n");
  assert.equal(
    readFileSync(join(installRoot, ".legacy-directory", "nested", "state.txt"), "utf8"),
    "hidden\n",
  );
  assert.equal(existsSync(join(installRoot, "remove-link")), false);
  assert.equal(readFileSync(externalFile, "utf8"), "outside\n");
});

test("direct prune refuses malformed paths, linked roots and expected links without touching outside files", () => {
  const installRoot = createTempDir("prune-destinations-");
  const sentinel = join(installRoot, "keep");
  writeFileSync(sentinel, "unchanged");
  for (const expectedPaths of [["../outside"], ["a/./b"], ["a//b"]]) {
    assert.throws(() => pruneInstalled({ installRoot, expectedPaths }), /destination path/i);
    assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
  }
  const linksRoot = createTempDir("prune-links-");
  const linkedRoot = join(linksRoot, "linked");
  symlinkSync(installRoot, linkedRoot);
  assert.throws(() => pruneInstalled({ installRoot: linkedRoot, expectedPaths: [] }), /symbolic link/i);
  const linkedLeaf = join(linksRoot, "expected");
  symlinkSync(sentinel, linkedLeaf);
  assert.throws(() => pruneInstalled({ installRoot: linksRoot, expectedPaths: ["expected"] }), /symbolic link/i);
  rmSync(linkedRoot);
  pruneInstalled({ installRoot: linksRoot, expectedPaths: [] });
  assert.equal(existsSync(linkedLeaf), false);
  assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
});

test("direct prune refuses noncanonical destination casing before deleting files", () => {
  const installRoot = createTempDir("prune-case-alias-");
  mkdirSync(join(installRoot, "Actual"));
  const sentinel = join(installRoot, "Actual/keep");
  writeFileSync(sentinel, "unchanged");
  assert.throws(() => pruneInstalled({ installRoot, expectedPaths: ["actual/keep"] }), /alias|canonical|case/i);
  assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
});

test("OCI reinstall truncates longer files and refuses hardlinked or directory leaves", async () => {
  await withRegistry(async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });
    const entry = ociLockEntry(registry, digest);
    for (const layout of ["snapshot", "source"]) {
      const installRoot = createTempDir("oci-reinstall-");
      const options = { lock: { connectors: [entry] }, source: null, installRoot, layout, ...fixtureOptions(registry, signer) };
      await installFromLock(options);
      const scriptPath = join(installRoot, "collection-profiles", entry.connectorId, entry.entrypointPath);
      const expected = readFileSync(scriptPath);
      writeFileSync(scriptPath, "longer existing content".repeat(100));
      await installFromLock(options);
      assert.deepEqual(readFileSync(scriptPath), expected);
      assert.equal((await verifyInstalled(options)).ok, true);
      rmSync(scriptPath);
      const sentinel = join(createTempDir("oci-hardlink-sentinel-"), "outside");
      writeFileSync(sentinel, "unchanged");
      linkSync(sentinel, scriptPath);
      for (const run of [installFromLock, verifyInstalled]) {
        await assert.rejects(() => run(options), /single regular file/i);
        assert.equal(readFileSync(sentinel, "utf8"), "unchanged");
      }
      rmSync(scriptPath);
      mkdirSync(scriptPath);
      await assert.rejects(() => installFromLock(options), /single regular file/i);
    }
  });
});

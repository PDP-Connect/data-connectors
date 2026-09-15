// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Acceptance tests A-T1…A-T10 for OCI connector consumption.
//
// Every one runs against a real in-process registry serving a real artifact
// over HTTP — see `oci-fixture.mjs` for why the wire format is reproduced
// rather than mocked. None of them contacts GHCR.
//
// Each test is named for the property it pins, and each is written so that
// removing the guard it covers makes it fail. That last part is not a claim:
// A-T3, A-T5, A-T9 and A-T10 were each run against a reverted guard and
// observed to fail.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FixtureRegistry,
  PINNED_IDENTITY,
  canonicalJson,
  createFixtureVerifier,
  createSigner,
  ociLockEntry,
  publishArtifact,
  sha256,
  tarball,
} from "./oci-fixture.mjs";
import { fetchResolvedArtifact, installFromLock } from "./index.mjs";
import {
  classifyManifestResponse,
  lookupManifest,
  parseOciReference,
  resolveVersionToDigest,
} from "./oci-registry.mjs";
import { indexLayersByMediaType } from "./oci-verify.mjs";

/** Options that point installer-core at the fixture registry. */
function fixtureOptions(registry, signer, overrides = {}) {
  return {
    ociScheme: "http",
    allowedOciRegistries: new Set([registry.registry]),
    ociCertificateIdentityResolver: () => PINNED_IDENTITY,
    sigstoreVerifier: createFixtureVerifier(signer),
    ...overrides,
  };
}

async function withRegistry(options, run) {
  const registry = await new FixtureRegistry(options).start();
  try {
    return await run(registry);
  } finally {
    await registry.stop();
  }
}

function countTempArtifacts() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("connector-oci-layer-")).length;
}

test("A-T1 resolves a version tag to a digest and refuses to re-resolve once pinned", async () => {
  await withRegistry({ challenge: true }, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });

    // Resolution: a version alone is enough to LEARN the digest (C2.1).
    const resolved = await resolveVersionToDigest({
      registry: registry.registry,
      repository: "pdp-connect/connector/ynab",
      version: "0.3.0",
      scheme: "http",
    });
    assert.equal(resolved, digest);

    // Installation: with the digest pinned, the tag is never consulted again.
    // Proven by moving the tag onto DIFFERENT bytes and showing the install is
    // unaffected — a consumer that re-resolved would pick up the new artifact
    // (C2.3).
    registry.requests.length = 0;
    const moved = publishArtifact(registry, { signer, version: "0.3.0", connectorKey: "ynab", withAssets: true });
    assert.notEqual(moved.digest, digest, "the fixture must actually move the tag");

    const artifact = await fetchResolvedArtifact(
      null,
      ociLockEntry(registry, digest),
      fixtureOptions(registry, signer)
    );

    assert.equal(artifact.oci.digest, digest);
    const tagRequests = registry.requests.filter((url) => url.includes("/manifests/0.3.0"));
    assert.deepEqual(tagRequests, [], "a pinned install must not request the version tag");
  });
});

test("A-T2 classifies present/absent/unknown and refuses on unknown", async () => {
  // The decision table, driven directly. `unknown` must never read as absence,
  // because absence is what a caller acts on (C2.2, C6.4).
  const cases = [
    {
      label: "404 with MANIFEST_UNKNOWN",
      response: { status: 404, body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }] }) },
      outcome: "absent",
    },
    {
      label: "404 with NAME_UNKNOWN",
      response: { status: 404, body: JSON.stringify({ errors: [{ code: "NAME_UNKNOWN" }] }) },
      outcome: "absent",
    },
    { label: "404 without a distribution error body", response: { status: 404, body: "" }, outcome: "unknown" },
    {
      label: "404 whose prose says not found but carries no code",
      response: { status: 404, body: JSON.stringify({ errors: [{ message: "not found" }] }) },
      outcome: "unknown",
    },
    {
      label: "404 mixing an absence code with a denial",
      response: {
        status: 404,
        body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }, { code: "DENIED" }] }),
      },
      outcome: "unknown",
    },
    {
      label: "404 mixing an absence code with an unreadable entry",
      response: { status: 404, body: JSON.stringify({ errors: [{ code: "MANIFEST_UNKNOWN" }, {}] }) },
      outcome: "unknown",
    },
    { label: "404 with an empty errors array", response: { status: 404, body: JSON.stringify({ errors: [] }) }, outcome: "unknown" },
    { label: "401", response: { status: 401, body: "" }, outcome: "unknown" },
    { label: "403 whose prose says not found", response: { status: 403, body: JSON.stringify({ errors: [{ code: "DENIED", message: "not found" }] }) }, outcome: "unknown" },
    { label: "500", response: { status: 500, body: "" }, outcome: "unknown" },
    { label: "non-JSON body", response: { status: 404, body: "<html>gone</html>" }, outcome: "unknown" },
    { label: "200 without a usable digest header", response: { status: 200, headers: { "docker-content-digest": "not-a-digest" }, body: "{}" }, outcome: "unknown" },
  ];

  for (const { label, response, outcome } of cases) {
    assert.equal(classifyManifestResponse(response).outcome, outcome, `${label} must be ${outcome}`);
  }

  // A transport failure — the registry never answers at all — is unknown, not
  // absence. This is the case that matters most: it is what a down registry
  // looks like.
  const timedOut = await lookupManifest({
    registry: "127.0.0.1:1",
    repository: "pdp-connect/connector/ynab",
    reference: "0.3.0",
    scheme: "http",
    timeoutMs: 250,
  });
  assert.equal(timedOut.outcome, "unknown");

  // And `unknown` refuses at the call site, rather than being reported as a
  // connector that was never published.
  await assert.rejects(
    () =>
      resolveVersionToDigest({
        registry: "127.0.0.1:1",
        repository: "pdp-connect/connector/ynab",
        version: "0.3.0",
        scheme: "http",
        timeoutMs: 250,
      }),
    (error) => error.reason === "unverifiable"
  );

  // A token-endpoint failure never becomes an answer about the manifest.
  await withRegistry({ challenge: true }, async (registry) => {
    registry.faultManifest("0.3.0", { status: 500, body: "" });
    const result = await lookupManifest({
      registry: registry.registry,
      repository: "pdp-connect/connector/ynab",
      reference: "0.3.0",
      scheme: "http",
    });
    assert.equal(result.outcome, "unknown");
  });
});

test("A-T3 refuses a signature minted by a different workflow ref", async () => {
  await withRegistry({}, async (registry) => {
    // Same workflow, same repository — only the trailing ref differs. That
    // suffix is the whole difference between a run on main and a run on an
    // attacker's branch, so matching the identity by prefix would accept this
    // (C3.1, C3.4).
    const attacker = createSigner(
      "https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/attacker"
    );
    const { digest } = publishArtifact(registry, { signer: attacker });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(
          null,
          ociLockEntry(registry, digest),
          fixtureOptions(registry, attacker)
        ),
      (error) => {
        assert.equal(error.reason, "misidentified");
        assert.match(error.message, /refs\/heads\/attacker|does not equal the pinned/);
        return true;
      }
    );
  });
});

test("A-T4 refuses when artifact metadata names a different trust identity", async () => {
  await withRegistry({}, async (registry) => {
    const attacker = createSigner(
      "https://github.com/attacker/data-connectors/.github/workflows/publish.yml@refs/heads/main"
    );
    // The artifact asks, in its own config and annotations, to be judged
    // against the attacker's identity. It must not get a say: the identity is
    // a function of the coordinates the LOCK named (C3.5).
    const { digest } = publishArtifact(registry, {
      signer: attacker,
      configOverrides: { certificate_identity: attacker.identity },
    });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(
          null,
          ociLockEntry(registry, digest),
          fixtureOptions(registry, attacker)
        ),
      (error) => error.reason === "misidentified"
    );

    // And the resolver that decides it never sees the artifact at all — it is
    // called with the coordinates and nothing else.
    const seen = [];
    await assert.rejects(() =>
      fetchResolvedArtifact(
        null,
        ociLockEntry(registry, digest),
        fixtureOptions(registry, attacker, {
          ociCertificateIdentityResolver: (args) => {
            seen.push(args);
            return PINNED_IDENTITY;
          },
        })
      )
    );
    assert.deepEqual(Object.keys(seen[0]).sort(), ["registry", "repository"]);
  });
});

test("A-T5 refuses a layer whose bytes do not match its descriptor digest", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    // The descriptor keeps the clean digest; the blob served is one byte
    // longer. Everything else about the artifact — including its signature —
    // is valid, so only the per-layer digest check can catch this (C4.1).
    const { digest } = publishArtifact(registry, { signer, tamperLayer: "code.tar.gz" });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "tampered");
        assert.match(error.message, /hashes to/);
        return true;
      }
    );
  });
});

test("A-T6 selects layers by media type with assets absent", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();

    // With no brand icon there is no assets layer, so licences and provenance
    // sit at the positions assets and licences would otherwise occupy. A
    // consumer indexing by position would read the wrong blob for both.
    const without = publishArtifact(registry, { signer, withAssets: false });
    assert.equal(without.manifest.layers.length, 4);

    const plain = await fetchResolvedArtifact(
      null,
      ociLockEntry(registry, without.digest),
      fixtureOptions(registry, signer)
    );
    assert.deepEqual(plain.assetFiles.map((file) => file.path).sort(), [
      "licenses/LICENSE",
      "licenses/NOTICE",
    ]);
    assert.match(plain.entrypointBuffer.toString("utf8"), /export const collect/);

    const withAssets = publishArtifact(registry, { signer, withAssets: true, version: "0.4.0" });
    assert.equal(withAssets.manifest.layers.length, 5);
    assert.equal(
      withAssets.manifest.layers[2].mediaType,
      "application/vnd.pdpp.connector.assets.v1.tar+gzip"
    );

    const rich = await fetchResolvedArtifact(
      null,
      ociLockEntry(registry, withAssets.digest, { version: "0.4.0" }),
      fixtureOptions(registry, signer)
    );
    // Same provenance and entrypoint despite every later layer having shifted.
    assert.match(rich.entrypointBuffer.toString("utf8"), /export const collect/);
    assert.deepEqual(rich.assetFiles.map((file) => file.path).sort(), [
      "assets/icon.svg",
      "licenses/LICENSE",
      "licenses/NOTICE",
    ]);
  });
});

test("A-T7 refuses an unrecognised layer media type", async () => {
  // Fail closed: a layer this consumer cannot name is one it cannot reason
  // about, and installing the rest while ignoring it decides on the
  // publisher's behalf that the addition did not matter (C4.3).
  assert.throws(
    () =>
      indexLayersByMediaType({
        layers: [
          {
            mediaType: "application/vnd.pdpp.connector.tools.v1.tar+gzip",
            digest: sha256(Buffer.from("x")),
          },
        ],
      }),
    (error) => {
      assert.equal(error.reason, "unsupported-layer");
      assert.match(error.message, /unrecognised layer media type/);
      return true;
    }
  );

  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, {
      signer,
      extraLayers: [
        {
          mediaType: "application/vnd.pdpp.connector.tools.v1.tar+gzip",
          digest: sha256(Buffer.from("tools")),
          size: 5,
        },
      ],
    });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => error.reason === "unsupported-layer"
    );
  });
});

test("A-T8 refuses when config.profile_digest or any of the four cross-checked fields disagree with the profile", async () => {
  const signer = createSigner();

  // The publisher runs this check too. That does not discharge it: the reason
  // the config restates these fields instead of pointing at them is that two
  // separately stored copies can be compared (C4.4).
  const disagreements = [
    { field: "profile_digest", value: sha256(Buffer.from("something else")) },
    { field: "connector_key", value: "not-ynab" },
    { field: "connector_id", value: "https://github.com/PDP-Connect/data-connectors/connector/other" },
    { field: "protocol_version", value: "9.9" },
    { field: "version", value: "9.9.9" },
  ];

  for (const { field, value } of disagreements) {
    await withRegistry({}, async (registry) => {
      const { digest } = publishArtifact(registry, {
        signer,
        configOverrides: { [field]: value },
      });

      await assert.rejects(
        () =>
          fetchResolvedArtifact(
            null,
            ociLockEntry(registry, digest),
            fixtureOptions(registry, signer)
          ),
        (error) => {
          assert.ok(
            ["tampered", "misidentified"].includes(error.reason),
            `${field} disagreement must refuse, got reason ${error.reason}`
          );
          return true;
        },
        `config.${field} disagreeing with the profile must refuse`
      );
    });
  }
});

test("A-T9 refuses unsafe archive members by type as well as name, and cleans up temp dirs", async () => {
  const signer = createSigner();

  // Each of these is safe by NAME and unsafe by TYPE, or unsafe by name in a
  // way a naive join would miss. A listing check that read only `tar -tzf`
  // would pass the first three (C4.5).
  const hostile = [
    {
      label: "symlink escaping the extraction root",
      build: () =>
        tarball({ "code/collection-profile.mjs": "x\n" }, {
          mode: (root) => symlinkSync("/etc/passwd", join(root, "code", "escape")),
        }),
    },
    {
      label: "hardlink",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        mkdirSync(join(root, "code"), { recursive: true });
        writeFileSync(join(root, "code", "collection-profile.mjs"), "x\n");
        execFileSync("ln", [join(root, "code", "collection-profile.mjs"), join(root, "code", "hard")]);
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czf", out, "-C", root, "code"]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
    {
      label: "FIFO",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        mkdirSync(join(root, "code"), { recursive: true });
        writeFileSync(join(root, "code", "collection-profile.mjs"), "x\n");
        execFileSync("mkfifo", [join(root, "code", "pipe")]);
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czf", out, "-C", root, "code"]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
    {
      label: "parent-directory traversal",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        mkdirSync(join(root, "nested", "code"), { recursive: true });
        writeFileSync(join(root, "nested", "code", "collection-profile.mjs"), "x\n");
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czf", out, "-C", join(root, "nested"), "code", "../nested/code"]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
    {
      label: "absolute path",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        mkdirSync(join(root, "code"), { recursive: true });
        writeFileSync(join(root, "code", "collection-profile.mjs"), "x\n");
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czPf", out, "-C", root, "code", join(root, "code")]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
  ];

  for (const { label, build } of hostile) {
    let hostileBytes;
    try {
      hostileBytes = build();
    } catch {
      continue; // the platform would not build this member; skip rather than pass vacuously
    }

    await withRegistry({}, async (registry) => {
      const before = countTempArtifacts();
      const { digest } = publishArtifact(registry, { signer, codeBytes: hostileBytes });

      // Replace the code layer with the hostile archive, keeping the manifest
      // honest so the ONLY thing that can refuse it is the archive check.
      const codeDigest = registry.putBlob(hostileBytes);
      const manifestObject = JSON.parse(registry.manifests.get(digest).toString("utf8"));
      const codeLayer = manifestObject.layers.find(
        (layer) => layer.mediaType === "application/vnd.pdpp.connector.code.v1.tar+gzip"
      );
      codeLayer.digest = codeDigest;
      codeLayer.size = hostileBytes.length;
      const republished = registry.putManifest(manifestObject, "0.3.0");
      // Re-sign the rewritten manifest so signature verification still passes.
      publishArtifactSignature(registry, republished.digest, signer);

      await assert.rejects(
        () =>
          fetchResolvedArtifact(
            null,
            ociLockEntry(registry, republished.digest),
            fixtureOptions(registry, signer)
          ),
        (error) => {
          assert.match(
            error.message,
            /unsupported archive entry type|unsupported link|archive member path|Invalid/,
            `${label} must be refused by the archive-safety check, got: ${error.message}`
          );
          return true;
        },
        `${label} must be refused`
      );

      // A refusal leaves nothing behind. The unpack temp root is removed in a
      // `finally`, so the failed install does not accumulate directories
      // holding the hostile bytes (C6.1).
      assert.equal(
        countTempArtifacts(),
        before,
        `${label} must not leave a temp directory behind`
      );
    });
  }
});

/** Sign an already-published manifest digest, for tests that rewrite a manifest. */
function publishArtifactSignature(registry, digest, signer, { payloadDigestOverride = null } = {}) {
  const payload = canonicalJson({
    critical: {
      identity: { "docker-reference": `${registry.registry}/pdp-connect/connector/ynab` },
      image: { "docker-manifest-digest": payloadDigestOverride ?? digest },
      type: "cosign container image signature",
    },
    optional: null,
  });
  registry.putManifest(
    {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: registry.putBlob(Buffer.from("{}")),
        size: 2,
      },
      layers: [
        {
          mediaType: "application/vnd.dev.cosign.simplesigning.v1+json",
          digest: registry.putBlob(payload),
          size: payload.length,
          annotations: {
            "dev.cosignproject.cosign/signature": signer.sign(payload),
            "dev.sigstore.cosign/certificate": signer.certificatePem,
          },
        },
      ],
    },
    `${digest.replace(":", "-")}.sig`
  );
}

test("A-T10 refuses a signature whose simple-signing payload names a different manifest digest", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();

    // A REAL signature, by the RIGHT identity, over a payload that names some
    // other artifact — the shape a signature lifted from a different image
    // has. Verifying the cryptography alone accepts it; only comparing the
    // payload's claim against the digest being installed catches it (C3.3).
    const other = publishArtifact(registry, { signer, connectorKey: "other", version: "9.9.9" });
    const { digest } = publishArtifact(registry, {
      signer,
      payloadDigestOverride: other.digest,
    });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "misidentified");
        assert.match(error.message, /covers manifest/);
        return true;
      }
    );
  });
});

test("an entry naming a registry other than GHCR is refused before any request", () => {
  // C1.3, and the fail-closed default that makes the loopback hook in the
  // tests safe: without an explicit allowance, only ghcr.io is accepted.
  assert.throws(
    () => parseOciReference({ registry: "evil.example", repository: "pdp-connect/connector/ynab", version: "0.3.0" }),
    (error) => {
      assert.equal(error.reason, "untrusted-registry");
      return true;
    }
  );
  assert.doesNotThrow(() =>
    parseOciReference({ registry: "ghcr.io", repository: "pdp-connect/connector/ynab", version: "0.3.0" })
  );
});

test("an OCI install writes the layout the existing readers expect", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest, profileBytes } = publishArtifact(registry, { signer, withAssets: true });
    const installRoot = mkdtempSync(join(tmpdir(), "oci-install-"));

    try {
      // C5.1/C5.2: the install root is keyed by connectorId (`ynab-pdpp`), not
      // by connector_key (`ynab`), and the three files the Rust reader opens
      // land at the paths it already opens them at.
      const result = await installFromLock({
        lock: { connectors: [ociLockEntry(registry, digest)] },
        source: null,
        installRoot,
        layout: "source",
        ...fixtureOptions(registry, signer),
      });

      assert.equal(result.connectorCount, 1);
      for (const relativePath of [
        "collection-profiles/ynab-pdpp/profile/collection-profile.json",
        "collection-profiles/ynab-pdpp/dist/collection-profile.mjs",
        "collection-profiles/ynab-pdpp/provenance.json",
      ]) {
        assert.ok(existsSync(join(installRoot, relativePath)), `expected ${relativePath}`);
      }
      assert.ok(!existsSync(join(installRoot, "collection-profiles", "ynab")));

      // C5.4: licences are written, not discarded.
      assert.ok(existsSync(join(installRoot, "collection-profiles/ynab-pdpp/licenses/LICENSE")));

      // The profile is installed byte-for-byte as published.
      const { readFileSync } = await import("node:fs");
      assert.deepEqual(
        readFileSync(join(installRoot, "collection-profiles/ynab-pdpp/profile/collection-profile.json")),
        profileBytes
      );
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

test("adding licence writes does not start installing stray tarball files", async () => {
  // The OCI path writes `assetFiles` so licences land on disk (C5.4), and
  // `buildPdppCollectionProfileWrites` is SHARED with the tarball path — where
  // `assetFiles` is also populated, with every artifact member that is not the
  // manifest, entrypoint, provenance, a schema or the README.
  //
  // So the obvious spelling of that change (spread `assetFiles`
  // unconditionally) silently starts installing files a tarball artifact
  // previously carried and the installer previously ignored. No existing test
  // catches it, because the two published collection profiles happen to carry
  // no such file. This one builds an artifact that does.
  const { createHash } = await import("node:crypto");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const digestOf = (buffer) => `sha256:${createHash("sha256").update(buffer).digest("hex")}`;

  const root = mkdtempSync(join(tmpdir(), "tarball-stray-"));
  try {
    const bundle = join(root, "bundle");
    const members = {
      "profile/collection-profile.json": JSON.stringify({ version: "1.0.0", name: "n", description: "d" }),
      "dist/collection-profile.mjs": "export const x = 1;\n",
      "provenance.json": "{}\n",
      "STRAY.txt": "not one of the three\n",
    };
    for (const [path, content] of Object.entries(members)) {
      const target = join(bundle, path);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
    }

    mkdirSync(join(root, "artifacts", "stray"), { recursive: true });
    const tarPath = join(root, "artifacts", "stray", "stray.tgz");
    execFileSync("tar", ["-czf", tarPath, "-C", bundle, "."]);

    const installRoot = join(root, "install");
    const result = await installFromLock({
      lock: {
        connectors: [
          {
            connectorId: "stray",
            company: "c",
            version: "1.0.0",
            artifactKind: "pdpp-collection-profile",
            artifactPath: "artifacts/stray/stray.tgz",
            artifactSha256: digestOf(readFileSync(tarPath)),
            manifestPath: "profile/collection-profile.json",
            manifestSha256: digestOf(Buffer.from(members["profile/collection-profile.json"])),
            entrypointPath: "dist/collection-profile.mjs",
            entrypointSha256: digestOf(Buffer.from(members["dist/collection-profile.mjs"])),
            provenancePath: "provenance.json",
            provenanceSha256: digestOf(Buffer.from(members["provenance.json"])),
          },
        ],
      },
      source: { mode: "local", rootDir: root },
      installRoot,
      layout: "source",
    });

    assert.deepEqual(result.expectedPaths, [
      "collection-profiles/stray/profile/collection-profile.json",
      "collection-profiles/stray/dist/collection-profile.mjs",
      "collection-profiles/stray/provenance.json",
    ]);
    assert.ok(
      !existsSync(join(installRoot, "collection-profiles/stray/STRAY.txt")),
      "a tarball artifact's extra member must not become an installed file"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unsigned artifact is refused rather than installed unverified", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    // No signature object published at all. Absence of a signature must refuse,
    // never downgrade to an unsigned install (C3.1).
    const { digest } = publishArtifact(registry, { signer: null });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "unsigned");
        return true;
      }
    );
  });
});

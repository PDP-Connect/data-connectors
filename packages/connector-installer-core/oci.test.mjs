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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FixtureRegistry,
  PINNED_IDENTITY,
  canonicalJson,
  cosignSignatureAnnotations,
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
    retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
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

function duplicateMemberTarball(entries) {
  const root = mkdtempSync(join(tmpdir(), "oci-duplicate-member-"));
  const archive = join(root, "layer.tar");
  try {
    for (const [index, { path, content }] of entries.entries()) {
      const source = `member-${index}`;
      writeFileSync(join(root, source), content);
      execFileSync("tar", [
        ...(index === 0 ? ["-cf", archive] : ["--append", "-f", archive]),
        "--transform",
        `s|${source}|${path}|`,
        "-C",
        root,
        source,
      ]);
    }
    return execFileSync("gzip", ["-c", archive]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// A-T1 proves a PINNED entry is not re-resolved. These two prove the other
// half: an UNPINNED entry is refused rather than resolved, and the one path
// whose purpose is to turn a tag into a digest still works and reports what it
// pinned (C1.2, C2.3).
test("A-T1b refuses a lock entry that carries no digest, without contacting the registry", async () => {
  await withRegistry({ challenge: true }, async (registry) => {
    const signer = createSigner();
    publishArtifact(registry, { signer });

    registry.requests.length = 0;
    await assert.rejects(
      () =>
        fetchResolvedArtifact(
          null,
          ociLockEntry(registry, null),
          fixtureOptions(registry, signer)
        ),
      (error) => {
        assert.equal(error.reason, "invalid-reference");
        assert.match(error.message, /carries no digest/);
        return true;
      }
    );

    assert.deepEqual(
      registry.requests,
      [],
      "an unpinned entry must be refused before any request, not resolved and then installed"
    );
  });
});

test("A-T1c resolves a tag only for an explicit first pin, and reports the digest", async () => {
  await withRegistry({ challenge: true }, async (registry) => {
    const signer = createSigner();
    const { digest, config } = publishArtifact(registry, { signer });
    const installRoot = mkdtempSync(join(tmpdir(), "oci-firstpin-"));

    try {
      const result = await installFromLock({
        lock: { lockVersion: "2.0", connectors: [ociLockEntry(registry, null)] },
        source: null,
        installRoot,
        layout: "snapshot",
        ...fixtureOptions(registry, signer),
        allowTagResolution: true,
      });

      assert.equal(result.connectorCount, 1);
      assert.deepEqual(result.pinned, [
        {
          connectorId: "ynab-pdpp",
          version: "0.3.0",
          registry: registry.registry,
          repository: "pdp-connect/connector/ynab",
          digest,
          sourceDeclarationPath: "collection-profiles/ynab-pdpp/source-declaration.json",
          sourceDeclarationSha256: config.source_declaration_digest,
        },
      ]);
      // The retained declaration is the layer the signed config pins.
      const retained = readFileSync(join(installRoot, result.pinned[0].sourceDeclarationPath));
      assert.equal(sha256(retained), config.source_declaration_digest);
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

// D4: the realm in a Bearer challenge is chosen by the PEER. Without a
// destination check the installer issues a GET wherever the registry points,
// including at another port on the machine running the install.
test("a Bearer challenge naming a realm off the registry's origin is refused", async () => {
  // A second loopback server, on a different port from the registry. The
  // registry challenges to it; nothing may be sent there.
  const decoy = await new FixtureRegistry({}).start();
  try {
    await withRegistry(
      { challenge: true, realm: `http://127.0.0.1:${decoy.port}/token` },
      async (registry) => {
        const signer = createSigner();
        const { digest } = publishArtifact(registry, { signer });

        decoy.requests.length = 0;
        await assert.rejects(
          () =>
            fetchResolvedArtifact(
              null,
              ociLockEntry(registry, digest),
              fixtureOptions(registry, signer)
            ),
          /neither the registry origin/
        );

        assert.deepEqual(
          decoy.requests,
          [],
          "the installer must not contact a realm the registry chose off its own origin"
        );
      }
    );
  } finally {
    await decoy.stop();
  }
});

test("a token realm that REDIRECTS to another origin is refused at the hop", async () => {
  // The realm check above is satisfied once, at the first request. With
  // `redirect: "follow"` the runtime then chased any `Location` the realm
  // answered with, so an allowed realm could hand the exchange to an origin the
  // same check would have refused — and since the realm comes from the peer's
  // own 401, the registry chose that destination. Here the registry's OWN
  // origin issues the challenge (so the first check passes) and answers the
  // token request with a 302 to a second loopback server, which must never be
  // contacted.
  const decoy = await new FixtureRegistry({}).start();
  try {
    await withRegistry({ challenge: true }, async (registry) => {
      const signer = createSigner();
      const { digest } = publishArtifact(registry, { signer });

      // The registry's own /token now redirects off-origin.
      registry.redirectTokenTo = `http://127.0.0.1:${decoy.port}/token`;
      decoy.requests.length = 0;

      await assert.rejects(
        () =>
          fetchResolvedArtifact(
            null,
            ociLockEntry(registry, digest),
            fixtureOptions(registry, signer)
          ),
        /redirected to a refused origin/
      );

      assert.deepEqual(
        decoy.requests,
        [],
        "a redirect must not deliver the token exchange to an origin the policy refuses"
      );
    });
  } finally {
    await decoy.stop();
  }
});

test("a token realm may redirect WITHIN the origin the policy already allows", async () => {
  // The control that keeps the repair from being "refuse every redirect": a hop
  // that lands back on an allowed origin is still allowed, so an ordinary
  // same-origin redirect does not break the exchange.
  await withRegistry({ challenge: true }, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });
    registry.redirectTokenTo = `http://127.0.0.1:${registry.port}/token?hop=2`;

    const artifact = await fetchResolvedArtifact(
      null,
      ociLockEntry(registry, digest),
      fixtureOptions(registry, signer)
    );
    assert.ok(artifact, "a same-origin redirect completes the token exchange");
    assert.ok(
      registry.requests.some((url) => url.includes("hop=2")),
      "the redirected token request is the one that was followed"
    );
  });
});

// D5: MAX_BLOB_BYTES bounds the COMPRESSED layer, which bounds nothing useful
// about what lands on disk. This fixture is a real decompression bomb: well
// under the 64 MiB blob cap on the wire, far over it unpacked.
test("a layer that decompresses past the ceiling is refused and cleaned up", async () => {
  await withRegistry({}, async (registry) => {
    const before = countTempArtifacts();
    const signer = createSigner();
    // 200 MB of zeros; gzip takes it to a couple of hundred KB.
    const bombBytes = tarball({ "collection-profile.mjs": Buffer.alloc(200 * 1024 * 1024) });
    assert.ok(
      bombBytes.length < 64 * 1024 * 1024,
      "the fixture must pass the compressed-blob cap, or it proves nothing about the unpacked one"
    );

    const { digest } = publishArtifact(registry, { signer, codeBytes: bombBytes });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(
          null,
          ociLockEntry(registry, digest),
          fixtureOptions(registry, signer)
        ),
      (error) => {
        assert.equal(error.reason, "unsafe-archive");
        assert.match(error.message, /ceiling/);
        return true;
      }
    );

    // Still asserted, though the reader no longer writes a temp dir for a layer
    // at all: the property this pins is that a refusal leaves nothing behind,
    // and "nothing was ever written" satisfies it more strongly than the
    // previous extract-then-clean-up did.
    assert.equal(
      countTempArtifacts(),
      before,
      "a refused bomb must not leave its bytes in the temp dir"
    );
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
    retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
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
        retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
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
      retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
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

    // With no brand icon there is no assets layer, so licences, the source
    // declaration and provenance sit at the positions assets, licences and the
    // source declaration would otherwise occupy. A consumer indexing by
    // position would read the wrong blob for all three.
    const without = publishArtifact(registry, { signer, withAssets: false });
    assert.equal(without.manifest.layers.length, 5);

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
    assert.equal(withAssets.manifest.layers.length, 6);
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
      "assets/icons/ynab.svg",
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

test("W28 refuses an artifact whose source declaration is a provenance-like object rather than a normative PDPP SourceDeclaration", async () => {
  const signer = createSigner();

  // The exact shape scripts/build-connector-oci-artifact.mjs used to emit
  // before this fix — connector_key/connector_id/version/source.repository/
  // canonical_inputs instead of protocol_version/source/publisher/display/
  // streams.
  const provenanceLookalike = {
    declaration_version: "1.0",
    connector_key: "ynab",
    connector_id: "https://github.com/PDP-Connect/data-connectors/connector/ynab",
    version: "0.3.0",
    source: {
      repository: "https://github.com/PDP-Connect/data-connectors",
      revision: "0".repeat(40),
      package: "connectors/ynab",
    },
    canonical_inputs: { manifest: { path: "x", sha256: "sha256:0" }, source_inventory: [] },
  };

  await withRegistry({}, async (registry) => {
    const { digest } = publishArtifact(registry, {
      signer,
      sourceDeclarationOverride: provenanceLookalike,
    });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "tampered");
        assert.match(error.message, /not a valid PDPP SourceDeclaration/);
        return true;
      },
      "a provenance-like source declaration must refuse the install"
    );
  });
});

test("W28 accepts a real, normative PDPP SourceDeclaration derived from the profile", async () => {
  const signer = createSigner();

  await withRegistry({}, async (registry) => {
    const { digest } = publishArtifact(registry, { signer });

    const resolved = await fetchResolvedArtifact(
      null,
      ociLockEntry(registry, digest),
      fixtureOptions(registry, signer)
    );
    // fetchResolvedArtifact does not surface the parsed declaration on its
    // return value today, so this is a proxy for "assertConfigMatchesProfile
    // accepted it": a real derived declaration installs cleanly at all.
    assert.ok(resolved.manifest);
  });
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
        tarball({ "collection-profile.mjs": "x\n" }, {
          mode: (root) => symlinkSync("/etc/passwd", join(root, "escape")),
        }),
    },
    {
      label: "hardlink",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        writeFileSync(join(root, "collection-profile.mjs"), "x\n");
        execFileSync("ln", [join(root, "collection-profile.mjs"), join(root, "hard")]);
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czf", out, "-C", root, "collection-profile.mjs", "hard"]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
    {
      label: "FIFO",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        writeFileSync(join(root, "collection-profile.mjs"), "x\n");
        execFileSync("mkfifo", [join(root, "pipe")]);
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czf", out, "-C", root, "collection-profile.mjs", "pipe"]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
    {
      label: "parent-directory traversal",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        mkdirSync(join(root, "nested"), { recursive: true });
        writeFileSync(join(root, "nested", "collection-profile.mjs"), "x\n");
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czPf", out, "-C", join(root, "nested"), "../nested/collection-profile.mjs"]);
        const buffer = execFileSync("cat", [out]);
        rmSync(root, { recursive: true, force: true });
        return buffer;
      },
    },
    {
      label: "absolute path",
      build: () => {
        const root = mkdtempSync(join(tmpdir(), "oci-hostile-"));
        writeFileSync(join(root, "collection-profile.mjs"), "x\n");
        const out = join(root, "hostile.tar.gz");
        execFileSync("tar", ["-czPf", out, "-C", root, join(root, "collection-profile.mjs")]);
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
    } catch (error) {
      if (label === "parent-directory traversal" || label === "absolute path") throw error;
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
          if (label === "parent-directory traversal" || label === "absolute path") {
            assert.match(error.message, /Invalid archive member path/);
          }
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
          annotations: cosignSignatureAnnotations(signer, payload),
        },
      ],
    },
    `${digest.replace(":", "-")}.sig`
  );
}

test("a candidate that cannot be evaluated does not hide a later valid signature", async () => {
  // A signature object may carry several layers. The loop caught only the
  // cryptographic call, so a candidate that failed EARLIER — fetching its
  // payload blob, or checking which digest that payload names — threw straight
  // out of the loop and the remaining candidates were never tried. An artifact
  // was then refused as unsigned while carrying a valid signature.
  //
  // First candidate: a descriptor for a payload blob the registry does not
  // have, so `fetchBlob` throws. Second: the real, valid signature.
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, { signer });

    const payload = canonicalJson({
      critical: {
        identity: { "docker-reference": `${registry.registry}/pdp-connect/connector/ynab` },
        image: { "docker-manifest-digest": digest },
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
            // Never stored, so fetching it fails.
            digest: `sha256:${"e".repeat(64)}`,
            size: payload.length,
            annotations: cosignSignatureAnnotations(signer, payload),
          },
          {
            mediaType: "application/vnd.dev.cosign.simplesigning.v1+json",
            digest: registry.putBlob(payload),
            size: payload.length,
            annotations: cosignSignatureAnnotations(signer, payload),
          },
        ],
      },
      `${digest.replace(":", "-")}.sig`
    );

    const artifact = await fetchResolvedArtifact(
      null,
      ociLockEntry(registry, digest),
      fixtureOptions(registry, signer)
    );
    assert.ok(artifact, "the later valid signature is reached and accepted");
  });
});

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

test("an OCI install resolves artifact-wide config entrypoint to a code-layer member", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest, codeBytes, config } = publishArtifact(registry, { signer });
    assert.equal(config.entrypoint, "code/collection-profile.mjs");
    assert.equal(
      execFileSync("tar", ["-tzf", "-"], { input: codeBytes, encoding: "utf8" }),
      "collection-profile.mjs\n"
    );
    const installRoot = mkdtempSync(join(tmpdir(), "oci-real-layout-"));

    try {
      const result = await installFromLock({
        lock: { connectors: [ociLockEntry(registry, digest)] },
        source: null,
        installRoot,
        layout: "source",
        ...fixtureOptions(registry, signer),
      });

      assert.equal(result.connectorCount, 1);
      assert.equal(
        readFileSync(
          join(installRoot, "collection-profiles/ynab-pdpp/dist/collection-profile.mjs"),
          "utf8"
        ),
        "export const collect = () => {};\n"
      );
    } finally {
      rmSync(installRoot, { recursive: true, force: true });
    }
  });
});

test("an OCI artifact with two differing entrypoint members is refused", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const codeBytes = duplicateMemberTarball([
      { path: "collection-profile.mjs", content: "export const value = 1;\n" },
      { path: "collection-profile.mjs", content: "export const value = 2;\n" },
    ]);
    const { digest } = publishArtifact(registry, { signer, codeBytes });

    await assert.rejects(
      () => fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "unsafe-archive");
        assert.match(error.message, /duplicate member destination "collection-profile\.mjs"/);
        return true;
      }
    );
  });
});

test("an OCI artifact with x and ./x code members is refused", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const codeBytes = duplicateMemberTarball([
      { path: "x", content: "export const value = 1;\n" },
      { path: "./x", content: "export const value = 2;\n" },
    ]);
    const { digest } = publishArtifact(registry, {
      signer,
      codeBytes,
      configOverrides: { entrypoint: "code/x" },
    });

    await assert.rejects(
      () => fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      /duplicate member destination "x"/
    );
  });
});

test("an OCI artifact with two differing assets at one destination is refused", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const assetsBytes = duplicateMemberTarball([
      { path: "icons/ynab.svg", content: "<svg>first</svg>\n" },
      { path: "./icons/ynab.svg", content: "<svg>second</svg>\n" },
    ]);
    const { digest } = publishArtifact(registry, { signer, withAssets: true, assetsBytes });

    await assert.rejects(
      () => fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      /duplicate member destination "icons\/ynab\.svg"/
    );
  });
});

test("an OCI config entrypoint preserves the exact nested member path", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, {
      signer,
      configOverrides: { entrypoint: "code/nested/collection-profile.mjs" },
      codeFiles: {
        "collection-profile.mjs": "export const wrong = true;\n",
        "nested/collection-profile.mjs": "export const nested = true;\n",
      },
    });
    const artifact = await fetchResolvedArtifact(
      null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)
    );
    assert.equal(artifact.entrypointBuffer.toString("utf8"), "export const nested = true;\n");
  });
});

test("an OCI artifact whose config entrypoint member is absent from the code layer is refused", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, {
      signer,
      codeFiles: {
        "nested/collection-profile.mjs": "export const collect = () => 'wrong';\n",
      },
    });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "tampered");
        assert.match(error.message, /is not present in the code layer/);
        return true;
      }
    );
  });
});

test("an OCI artifact whose config entrypoint names a non-code layer is refused", async () => {
  await withRegistry({}, async (registry) => {
    const signer = createSigner();
    const { digest } = publishArtifact(registry, {
      signer,
      withAssets: true,
      codeFiles: { "icons/ynab.svg": "export const collect = () => {};\n" },
      configOverrides: { entrypoint: "assets/icons/ynab.svg" },
    });

    await assert.rejects(
      () =>
        fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
      (error) => {
        assert.equal(error.reason, "tampered");
        assert.match(error.message, /must name a member of the code layer/);
        return true;
      }
    );
  });
});

test("an OCI artifact whose config entrypoint is not a safe relative path is refused", async () => {
  for (const entrypoint of ["code/../collection-profile.mjs", "code//collection-profile.mjs", "/code/collection-profile.mjs", "code/./collection-profile.mjs", "code/", "", null]) {
    await withRegistry({}, async (registry) => {
      const signer = createSigner();
      const { digest } = publishArtifact(registry, {
        signer,
        configOverrides: { entrypoint },
      });

      await assert.rejects(
        () =>
          fetchResolvedArtifact(null, ociLockEntry(registry, digest), fixtureOptions(registry, signer)),
        (error) => {
          assert.equal(error.reason, "tampered");
          assert.match(error.message, /Invalid config\.entrypoint/);
          return true;
        }
      );
    });
  }
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

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fetchResolvedArtifact } from "../packages/connector-installer-core/index.mjs";
import { FixtureRegistry, PINNED_IDENTITY, createFixtureVerifier, createSigner, publishArtifact } from "../packages/connector-installer-core/oci-fixture.mjs";
import { generateConnectorCatalog, serializeConnectorCatalog } from "./generate-connector-catalog.mjs";
import { verifyCatalogAdditions } from "./verify-catalog-additions.mjs";

const digest = (char) => `sha256:${char.repeat(64)}`;
const connectorId = "https://github.com/PDP-Connect/data-connectors/connector/ynab";
function catalog(versions) {
  return {
    catalog_version: "1.0", generated_at: "2026-10-30T00:00:00.000Z", source_commit: "a".repeat(40),
    connectors: [{
      connector_key: "ynab", connector_id: connectorId, display_name: "YNAB", tier: "supported",
      runtime_requirements: { bindings: { network: { required: true } } }, setup: { modality: "static_secret" },
      versions, latest: versions.at(-1),
    }],
  };
}

test("only new exact versions are verified before they can enter the catalog", async () => {
  const old = { version: "0.3.0", digest: digest("a") };
  const addition = { version: "0.4.0", digest: digest("b") };
  const seen = [];
  await verifyCatalogAdditions(catalog([old, addition]), catalog([old]), {
    fetchArtifact: async (source, entry, options) => {
      seen.push({ source, entry, options });
      return { manifest: { connector_id: connectorId, connector_key: "ynab", version: addition.version } };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, null);
  assert.deepEqual(seen[0].options, { allowTagResolution: false });
  assert.deepEqual(seen[0].entry.oci, { registry: "ghcr.io", repository: "pdp-connect/connector/ynab", digest: addition.digest });
  assert.equal(seen[0].entry.version, addition.version);
});

test("a previously cataloged version cannot change digest or disappear", async () => {
  const old = { version: "0.3.0", digest: digest("a") };
  await assert.rejects(verifyCatalogAdditions(catalog([{ ...old, digest: digest("b") }]), catalog([old])), /different digest/);
  await assert.rejects(verifyCatalogAdditions(catalog([{ version: "0.4.0", digest: digest("b") }]), catalog([old])), /missing/);
});

test("a rejected nonlatest addition prevents publication", async () => {
  const old = { version: "0.3.0", digest: digest("a") };
  const addition = { version: "0.4.0", digest: digest("b") };
  const latest = { version: "0.5.0", digest: digest("c") };
  await assert.rejects(verifyCatalogAdditions(catalog([old, addition, latest]), catalog([old]), {
    fetchArtifact: async (_source, entry) => {
      if (entry.version === addition.version) throw new Error("unsigned artifact");
      return { manifest: { connector_id: connectorId, connector_key: "ynab", version: entry.version } };
    },
  }), /unsigned artifact/);
});

test("catalog additions use the real installer to refuse unsigned and unsigned-declaration artifacts", async (t) => {
  const registry = await new FixtureRegistry({ challenge: true }).start();
  t.after(() => registry.stop());
  const signer = createSigner();
  const fetchArtifact = (source, entry, options) => fetchResolvedArtifact(source, {
    ...entry, oci: { ...entry.oci, registry: registry.registry },
  }, {
    ...options, allowedOciRegistries: new Set([registry.registry]), ociScheme: "http",
    ociCertificateIdentityResolver: () => PINNED_IDENTITY,
    sigstoreVerifier: createFixtureVerifier(signer),
    retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} },
  });
  const good = publishArtifact(registry, { signer, withSourceDeclarationLayer: false, withSourceDeclarationReferrer: true });
  await verifyCatalogAdditions(catalog([{ version: "0.3.0", digest: good.digest }]), null, { fetchArtifact });
  const unsigned = publishArtifact(registry, { version: "0.4.0" });
  await assert.rejects(verifyCatalogAdditions(catalog([{ version: "0.4.0", digest: unsigned.digest }]), null, { fetchArtifact }));
  const noDeclarationSignature = publishArtifact(registry, { version: "0.5.0", signer,
    withSourceDeclarationLayer: false, withSourceDeclarationReferrer: true, sourceDeclarationReferrerSigner: null });
  await assert.rejects(verifyCatalogAdditions(catalog([{ version: "0.5.0", digest: noDeclarationSignature.digest }]), null, { fetchArtifact }));
});

test("a release left behind by a failed publish is reconciled once and verified", async (t) => {
  const registry = await new FixtureRegistry({ challenge: true }).start();
  t.after(() => registry.stop());
  const signer = createSigner();
  const first = publishArtifact(registry, { version: "1.0.0", signer });
  registry.tagLists.set("pdp-connect/connector/ynab", { tags: ["1.0.0"], pageSize: 100 });
  const options = { registry: registry.registry, namespace: "pdp-connect", connectors: [{ manifest: "ynab", connectorKey: "ynab" }],
    sourceCommit: "a".repeat(40), generatedAt: "2026-10-30T00:00:00Z", scheme: "http", allowInsecureLoopback: true };
  const previous = await generateConnectorCatalog(options);
  assert.equal(previous.connectors[0].latest.digest, first.digest);

  // The version tag survived, but the prior catalog was never updated.
  const released = publishArtifact(registry, { version: "1.1.0", signer,
    withSourceDeclarationLayer: false, withSourceDeclarationReferrer: true });
  registry.tagLists.set("pdp-connect/connector/ynab", { tags: ["1.0.0", "1.1.0"], pageSize: 100 });
  const recovered = await generateConnectorCatalog({ ...options, previousCatalog: previous });
  const fetchArtifact = (source, entry, fetchOptions) => fetchResolvedArtifact(source, {
    ...entry, oci: { ...entry.oci, registry: registry.registry },
  }, { ...fetchOptions, allowedOciRegistries: new Set([registry.registry]), ociScheme: "http",
    ociCertificateIdentityResolver: () => PINNED_IDENTITY, sigstoreVerifier: createFixtureVerifier(signer),
    retryOptions: { jitter: false, sleep: async () => {}, onRetry: () => {} } });
  await verifyCatalogAdditions(recovered, previous, { fetchArtifact });
  assert.equal(recovered.connectors[0].latest.digest, released.digest);
  assert.equal(recovered.connectors[0].versions.length, 2);
  const retry = await generateConnectorCatalog({ ...options, previousCatalog: recovered });
  assert.equal(serializeConnectorCatalog(retry), serializeConnectorCatalog(recovered));
});

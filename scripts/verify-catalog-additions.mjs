#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertCatalog } from "../packages/connector-installer-core/catalog-schema.mjs";
import { fetchResolvedArtifact } from "../packages/connector-installer-core/index.mjs";

function releasesByVersion(connector) {
  const releases = new Map();
  for (const release of connector.versions) {
    if (releases.has(release.version)) {
      throw new Error(`${connector.connector_key}: duplicate catalog version ${release.version}`);
    }
    releases.set(release.version, release.digest);
  }
  return releases;
}

/** The previous catalog must already have passed its signature check. */
export async function verifyCatalogAdditions(catalog, previousCatalog, { fetchArtifact = fetchResolvedArtifact } = {}) {
  assertCatalog(catalog);
  if (previousCatalog !== null) assertCatalog(previousCatalog);
  const previousByKey = new Map((previousCatalog?.connectors ?? []).map(connector => [connector.connector_key, connector]));
  for (const connector of catalog.connectors) {
    const before = previousByKey.get(connector.connector_key);
    const prior = before ? releasesByVersion(before) : new Map();
    const next = releasesByVersion(connector);
    for (const [version, digest] of prior) {
      if (!next.has(version)) throw new Error(`${connector.connector_key}@${version} is missing from the new catalog`);
      if (next.get(version) !== digest) throw new Error(`${connector.connector_key}@${version} has a different digest`);
    }
    for (const [version, digest] of next) {
      if (prior.has(version)) continue;
      const key = connector.connector_key;
      const artifact = await fetchArtifact(null, {
        connectorId: key, connectorKey: key, version,
        artifactKind: "pdpp-collection-profile", manifestPath: "profile/collection-profile.json",
        entrypointPath: "dist/collection-profile.mjs", provenancePath: "provenance.json",
        oci: { registry: "ghcr.io", repository: `pdp-connect/connector/${key}`, digest },
      }, { allowTagResolution: false });
      if (artifact.manifest?.connector_id !== connector.connector_id ||
          artifact.manifest?.connector_key !== key || artifact.manifest?.version !== version) {
        throw new Error(`${key}@${version}: verified profile identity differs from the catalog`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (!(args.length === 2 || args.length === 4) || args[0] !== "--catalog" ||
        (args.length === 4 && args[2] !== "--previous-catalog")) {
      throw new Error("usage: verify-catalog-additions.mjs --catalog PATH [--previous-catalog PATH]");
    }
    const catalog = JSON.parse(readFileSync(args[1], "utf8"));
    const previous = args.length === 4 ? JSON.parse(readFileSync(args[3], "utf8")) : null;
    await verifyCatalogAdditions(catalog, previous);
    console.log("New catalog releases passed digest, signature and source declaration verification.");
  } catch (error) {
    console.error(`catalog verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

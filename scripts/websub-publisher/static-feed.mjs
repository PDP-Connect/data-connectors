#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { assertCatalog } from "../../packages/connector-installer-core/catalog-schema.mjs";
import { atom, readyRecord } from "./catalog.mjs";
import { HUB_URL, TOPIC_URL, httpsURL } from "./config.mjs";

export { HUB_URL, TOPIC_URL };
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;

// The caller must verify the OCI signature and digest before using these bytes.
export function renderCatalogFeed({ catalog, digest, hub = HUB_URL }) {
  assertCatalog(catalog);
  const record = readyRecord({
    schema: "pdpp.catalog.ready.v1",
    repository: "ghcr.io/pdp-connect/connector-catalog",
    digest,
    source_commit: catalog.source_commit,
    generated_at: catalog.generated_at,
  });
  return atom(record, { topic: TOPIC_URL, hub: httpsURL(hub) });
}

async function main() {
  const { values } = parseArgs({
    options: {
      catalog: { type: "string" },
      digest: { type: "string" },
      out: { type: "string" },
    },
  });
  if (![values.catalog, values.digest, values.out].every(Boolean))
    throw new Error("usage: static-feed.mjs --catalog FILE --digest DIGEST --out FILE");
  const details = await stat(values.catalog);
  if (!details.isFile() || details.size > MAX_CATALOG_BYTES) throw new Error("invalid catalog file size");
  const catalog = JSON.parse(await readFile(values.catalog, "utf8"));
  const feed = renderCatalogFeed({ catalog, digest: values.digest });
  await mkdir(dirname(values.out), { recursive: true });
  await writeFile(values.out, feed, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

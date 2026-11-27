#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HUB_URL, TOPIC_URL } from "./config.mjs";

export { HUB_URL };
const MAX_FEED_BYTES = 65536;

async function feedHash(response) {
  if (!response.body) throw new Error("topic response has no body");
  const reader = response.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_FEED_BYTES) {
      await reader.cancel();
      throw new Error("topic response is too large");
    }
    hash.update(value);
  }
  return hash.digest("hex");
}

// A successful local read does not prove what a hub's CDN edge will return.
export async function notifyHub({ expectedSha256, fetcher = fetch }) {
  if (typeof expectedSha256 !== "string" || !/^[0-9a-f]{64}$/.test(expectedSha256))
    throw new Error("invalid expected feed hash");
  const topic = await fetcher(TOPIC_URL, {
    headers: { accept: "application/atom+xml" },
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  const contentType = topic.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (topic.status !== 200 || contentType !== "application/atom+xml")
    throw new Error(`canonical topic is unavailable or not Atom (HTTP ${topic.status})`);
  if ((await feedHash(topic)) !== expectedSha256) throw new Error("canonical topic is not the deployed feed");

  const response = await fetcher(HUB_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ "hub.mode": "publish", "hub.url": TOPIC_URL }),
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`hub rejected the publish hint (HTTP ${response.status})`);
}

async function main() {
  const { values } = parseArgs({ options: { sha256: { type: "string" } } });
  await notifyHub({ expectedSha256: values.sha256 });
  console.log("Canonical topic matched the deployed feed; the hub accepted its publish hint.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

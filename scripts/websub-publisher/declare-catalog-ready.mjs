#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { readyRecord } from "./catalog.mjs";
import { httpsURL } from "./config.mjs";

class TransientBodyReadError extends Error {
  constructor(cause) {
    super("response body read failed", { cause });
  }
}

async function jsonBounded(response, limit) {
  if (!response.body) throw new Error("missing response body");
  const reader = response.body.getReader();
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (;;) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch (cause) {
      throw new TransientBodyReadError(cause);
    }
    const { value, done } = chunk;
    if (done) break;
    bytes += value.length;
    if (bytes > limit) {
      await reader.cancel();
      throw new Error("response too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return JSON.parse(text + decoder.decode());
}
export function clientConfig(env) {
  const endpoint = httpsURL(env.CATALOG_PUBLISHER_URL);
  if (
    new URL(endpoint).pathname !== "/ready" ||
    typeof env.CATALOG_PUBLISHER_AUDIENCE !== "string" ||
    !/^[^\s]{8,200}$/.test(env.CATALOG_PUBLISHER_AUDIENCE) ||
    /SET_|CHANGE/.test(env.CATALOG_PUBLISHER_AUDIENCE)
  )
    throw new Error("invalid publisher configuration");
  const tokenURL = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (
    tokenURL.protocol !== "https:" ||
    tokenURL.username ||
    tokenURL.password ||
    tokenURL.hash ||
    !tokenURL.hostname.endsWith(".actions.githubusercontent.com") ||
    tokenURL.port ||
    typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string" ||
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length < 16 ||
    /\s/.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  )
    throw new Error("missing or invalid Actions OIDC credentials");
  tokenURL.searchParams.set("audience", env.CATALOG_PUBLISHER_AUDIENCE);
  return { endpoint, tokenURL };
}
function publisherConfigured(env) {
  if (!env.CATALOG_PUBLISHER_URL && !env.CATALOG_PUBLISHER_AUDIENCE) return false;
  clientConfig(env);
  return true;
}
async function fetchWithRetry(fetcher, url, options, wait, shouldReadBody, bodyLimit) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetcher(url, options());
    } catch (error) {
      if (attempt === 2) throw error;
      await wait(1000 * 2 ** attempt);
      continue;
    }
    const transient = response.status === 408 || response.status === 429 || response.status >= 500;
    if (transient) {
      if (attempt === 2) return { response };
      try {
        await response.body?.cancel();
      } catch {
        /* Preserve retry on a broken response body. */
      }
      await wait(1000 * 2 ** attempt);
      continue;
    }

    if (!shouldReadBody(response)) return { response };
    try {
      return { response, body: await jsonBounded(response, bodyLimit) };
    } catch (error) {
      if (!(error instanceof TransientBodyReadError) || attempt === 2) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}
export async function declareReady(
  record,
  env = process.env,
  fetcher = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  readyRecord(record);
  const { endpoint, tokenURL } = clientConfig(env);
  const { response: tokenResponse, body: tokenBody } = await fetchWithRetry(
    fetcher,
    tokenURL,
    () => ({
      headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }),
    wait,
    (response) => response.ok,
    32_768,
  );
  if (!tokenResponse.ok) throw new Error(`Actions OIDC HTTP ${tokenResponse.status}`);
  const token = tokenBody.value;
  if (
    typeof token !== "string" ||
    token.length > 16_384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw new Error("invalid Actions OIDC response");
  // No echo, shell interpolation, output file, redirect or log contains this JWT.
  const { response, body: result } = await fetchWithRetry(
    fetcher,
    endpoint,
    () => ({
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(record),
    }),
    wait,
    (response) => [200, 202].includes(response.status),
    2048,
  );
  if (![200, 202].includes(response.status))
    throw new Error(
      `publisher declaration HTTP ${response.status}; catalog may already be tagged; run recover-latest on main`,
    );
  if (
    !(response.status === 202 && result.accepted === true) &&
    !(response.status === 200 && result.duplicate === true)
  )
    throw new Error("invalid publisher acknowledgement");
  return result;
}
export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === "--check-config") {
    console.log(
      publisherConfigured(env)
        ? "Catalog publisher configuration valid"
        : "::notice::WebSub publisher not configured",
    );
    return;
  }
  if (args.length !== 4 || args[0] !== "--digest" || args[2] !== "--catalog")
    throw new Error("usage: declare-catalog-ready.mjs --digest sha256:... --catalog catalog.json");
  const catalog = JSON.parse(await readFile(args[3], "utf8"));
  const record = readyRecord({
    schema: "pdpp.catalog.ready.v1",
    repository: "ghcr.io/pdp-connect/connector-catalog",
    digest: args[1],
    source_commit: catalog.source_commit,
    generated_at: catalog.generated_at,
  });
  if (!publisherConfigured(env)) {
    console.log("::notice::WebSub publisher not configured; catalog ready notification was not sent");
    return;
  }
  await declareReady(record, env);
  console.log("Catalog ready declaration durably accepted");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      process.argv[2] === "--check-config"
        ? "Catalog publisher configuration invalid."
        : "Catalog ready declaration failed. Catalog may already be tagged. Check publisher configuration/availability; run recover-latest on main.",
    );
    process.exitCode = 1;
  });
}

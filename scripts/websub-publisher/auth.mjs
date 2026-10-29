// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { ISSUER, JWKS_URL, WORKFLOW, OWNER_ID, REPOSITORY_ID, SUBJECT, HttpError } from "./config.mjs";

class JwksUnavailable extends Error {}
class JwksInvalid extends Error {}

// Bound keyset buffering while distinguishing interrupted streams from invalid JSON.
const MAX_JWKS_BYTES = 64 * 1024;

function discardBody(body) {
  try {
    body?.cancel().catch(() => {});
  } catch {
    // A broken response stream must not replace its status classification.
  }
}

function cancelReader(reader) {
  try {
    reader.cancel().catch(() => {});
  } catch {
    // Cancellation is best-effort; the original error determines the response.
  }
}

async function fetchGitHubJwks(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new JwksUnavailable();
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    discardBody(response.body);
    throw new JwksUnavailable();
  }
  if (response.status !== 200) {
    discardBody(response.body);
    return new Response(null, { status: response.status });
  }

  // Read the bounded body here because jose wraps later stream errors as generic JOSE errors.
  const reader = response.body?.getReader();
  if (!reader) return new Response(null, { status: 200 });
  const chunks = [];
  let size = 0;
  const cancelRead = () => cancelReader(reader);
  if (options.signal.aborted) {
    cancelRead();
    throw new JwksUnavailable();
  }
  options.signal.addEventListener("abort", cancelRead, { once: true });
  if (options.signal.aborted) cancelRead();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (options.signal.aborted) throw new JwksUnavailable();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JWKS_BYTES) {
        cancelReader(reader);
        throw new JwksInvalid();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof JwksInvalid || error instanceof JwksUnavailable) throw error;
    cancelReader(reader);
    throw new JwksUnavailable();
  } finally {
    options.signal.removeEventListener("abort", cancelRead);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

// Only this pinned HTTPS origin supplies production keys. jose refreshes its cache
// on expiration/unknown kid (subject to cooldown); no static deployment snapshot.
const githubKeys = createRemoteJWKSet(new URL(JWKS_URL), {
  timeoutDuration: 5000,
  cooldownDuration: 5000,
  cacheMaxAge: 300_000,
  [customFetch]: fetchGitHubJwks,
});
export async function verifyGitHub(token, audience) {
  try {
    if (typeof token !== "string" || token.length > 16_384) throw new Error("token length");
    const { payload: p } = await jwtVerify(token, githubKeys, {
      issuer: ISSUER,
      audience,
      algorithms: ["RS256"],
      maxTokenAge: "10m",
      clockTolerance: 5,
      requiredClaims: [
        "exp",
        "iat",
        "nbf",
        "sub",
        "repository",
        "repository_id",
        "repository_owner_id",
        "ref",
        "workflow_ref",
        "sha",
        "run_id",
        "run_number",
        "run_attempt",
      ],
    });
    if (
      p.aud !== audience ||
      p.repository !== "PDP-Connect/data-connectors" ||
      p.ref !== "refs/heads/main" ||
      p.repository_id !== REPOSITORY_ID ||
      p.repository_owner_id !== OWNER_ID ||
      p.workflow_ref !== WORKFLOW ||
      p.sub !== SUBJECT ||
      typeof p.sha !== "string" ||
      !/^[0-9a-f]{40}$/.test(p.sha) ||
      p.exp <= p.iat ||
      p.exp - p.iat > 600 ||
      !Number.isFinite(p.nbf) ||
      p.nbf > p.exp ||
      ![p.run_id, p.run_number, p.run_attempt].every(
        (n) => typeof n === "string" && /^[1-9][0-9]{0,15}$/.test(n) && Number.isSafeInteger(Number(n)),
      )
    ) {
      throw new Error("claim policy");
    }
    return { sha: p.sha, runId: p.run_id, run: Number(p.run_number), attempt: Number(p.run_attempt) };
  } catch (error) {
    // No token/claim contents enter logs or responses.
    if (error instanceof JwksUnavailable)
      throw new HttpError(503, "GitHub identity service unavailable");
    throw new HttpError(401, "invalid GitHub identity");
  }
}

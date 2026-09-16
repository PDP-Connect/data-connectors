// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const DEFAULT_RETRY_ATTEMPTS = 6;
export const DEFAULT_RETRY_BASE_DELAY_MS = 1000;
export const DEFAULT_RETRY_MAX_DELAY_MS = 15_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status <= 599);
}

export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string") return null;

  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function getHeader(headers, name) {
  if (headers?.get) return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function retryDelay(attempt, { baseDelayMs, maxDelayMs, jitter, random }) {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  if (!jitter || exponential === 0) return exponential;
  return Math.min(maxDelayMs, exponential * (0.5 + random()));
}

function defaultOnRetry({ url, nextAttempt, attempts, delayMs, status, error }) {
  const reason = status === null
    ? `failed (${error instanceof Error ? error.message : String(error)})`
    : `returned ${status}`;
  console.warn(
    `[connector-installer] fetch ${url} ${reason}; retrying in ${delayMs}ms ` +
      `(attempt ${nextAttempt}/${attempts})`
  );
}

/**
 * Execute one fetch policy for release assets and registry requests.
 *
 * Only HTTP 429, HTTP 5xx, and rejected fetch promises are retried. A response
 * with any other status is returned to the caller so it can preserve its own
 * failure semantics, including the OCI present/absent/unknown distinction.
 */
export async function fetchWithRetry(
  url,
  {
    fetchImpl = fetch,
    fetchOptions = {},
    attempts = DEFAULT_RETRY_ATTEMPTS,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
    jitter = true,
    random = Math.random,
    sleep = defaultSleep,
    now = Date.now,
    onRetry = defaultOnRetry,
  } = {}
) {
  const totalAttempts = Math.max(1, Math.floor(Number(attempts)) || 1);
  const retryBaseDelayMs = Math.max(0, Number(baseDelayMs) || 0);
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, Number(maxDelayMs) || 0);

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    let response;
    try {
      const options = typeof fetchOptions === "function"
        ? fetchOptions(attempt)
        : fetchOptions;
      response = await fetchImpl(url, options);
    } catch (error) {
      if (attempt === totalAttempts) throw error;

      const delayMs = retryDelay(attempt, {
        baseDelayMs: retryBaseDelayMs,
        maxDelayMs: retryMaxDelayMs,
        jitter,
        random,
      });
      await onRetry({
        url,
        attempt,
        nextAttempt: attempt + 1,
        attempts: totalAttempts,
        delayMs,
        status: null,
        error,
        retryAfterMs: null,
      });
      await sleep(delayMs);
      continue;
    }

    if (!isRetryableStatus(response.status) || attempt === totalAttempts) {
      return response;
    }

    const retryAfterMs = parseRetryAfter(
      getHeader(response.headers, "retry-after"),
      now()
    );
    const delayMs = Math.min(
      retryMaxDelayMs,
      Math.max(
        retryDelay(attempt, {
          baseDelayMs: retryBaseDelayMs,
          maxDelayMs: retryMaxDelayMs,
          jitter,
          random,
        }),
        retryAfterMs ?? 0
      )
    );

    try {
      await response.body?.cancel?.();
    } catch {
      // A failed cleanup must not turn a retryable response into a terminal one.
    }
    await onRetry({
      url,
      attempt,
      nextAttempt: attempt + 1,
      attempts: totalAttempts,
      delayMs,
      status: response.status,
      error: null,
      retryAfterMs,
    });
    await sleep(delayMs);
  }
}

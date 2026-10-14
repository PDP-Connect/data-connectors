// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// One retry policy for registry RATE LIMITS, and only for rate limits.
//
// The publish workflow runs many matrix legs against GHCR at once. GHCR answers
// a burst with HTTP 429 TOOMANYREQUESTS ("allowed: 2000/minute"), and the pinned
// clients give up quickly: ORAS 1.3.3 (oras-go v2.6.2) retries 5 times with at
// most 3 seconds between tries, and Cosign 3.1.3 (go-containerregistry v0.21.7)
// retries 3 times at 1s and 3s. Neither exposes a flag or environment variable
// to lengthen that. GHCR states its limit per minute, and waits of a few
// seconds may not outlast a sustained burst, so this policy waits on the scale
// of that window: a minute, then longer, with jitter so legs that were
// throttled together do not return together.
//
// Callers retry ONE request or ONE command, never a sequence of them, and only
// when the failure is unmistakably a rate limit. Authentication failures,
// missing manifests, verification failures and transport errors keep their
// existing meaning and are never retried here.

import { setTimeout as delay } from "node:timers/promises";
import { parseRetryAfter } from "../packages/connector-installer-core/retry.mjs";

export { parseRetryAfter };

export const RATE_LIMIT_POLICY = Object.freeze({
  // Total tries, including the first.
  attempts: 4,
  // First wait. Doubles per retry: 60s, 120s, 240s before jitter.
  baseDelayMs: 60_000,
  // No single wait exceeds this, jitter included.
  maxDelayMs: 300_000,
  // Bound on retry SCHEDULING: time since the first try, including the time
  // tries took to run. A retry whose wait would end past it is not started, and
  // the last failure is returned. It does not stop a try that is running; the
  // job's timeout-minutes bounds that.
  budgetMs: 600_000,
  // Each wait is stretched by a random factor in [1, 1 + jitter).
  jitter: 0.5,
});

/**
 * The policy, optionally shortened for tests.
 *
 * `REGISTRY_RETRY_DELAY_SCALE` multiplies the waits. Only a value in (0, 1] is
 * accepted, so the hook can make the policy faster but never longer or
 * disabled. The attempt count and the scheduling budget are left alone, so a
 * slow test host cannot spend the budget on process start-up and end retries
 * early. The publish workflow does not set it.
 */
export function policyFromEnv(env = process.env) {
  const scale = Number(env.REGISTRY_RETRY_DELAY_SCALE);
  if (!(scale > 0 && scale <= 1)) return RATE_LIMIT_POLICY;
  return Object.freeze({
    ...RATE_LIMIT_POLICY,
    baseDelayMs: RATE_LIMIT_POLICY.baseDelayMs * scale,
    maxDelayMs: RATE_LIMIT_POLICY.maxDelayMs * scale,
  });
}

/**
 * Did the client FAIL because the registry rate-limited it?
 *
 * Reads only the last non-empty line of stderr, which is where the pinned
 * clients print their terminal error. Earlier lines are not evidence: the
 * clients log their own retries (go-containerregistry prints
 * `retrying <error>` for each one), so a 429 that was retried away can be
 * followed by a different, final failure, such as a 401, that must not be
 * retried.
 *
 * Matches only the renderings the pinned clients produce for HTTP 429:
 *
 *   ORAS 1.3.3, error from the target registry with an error body
 *   (cmd/oras/internal/option/target.go, remote.go):
 *                                `Error response from registry: toomanyrequests: ...`
 *   oras-go v2.6.2 errcode.ErrorResponse otherwise:
 *                                `... response status code 429: ...`
 *   go-containerregistry v0.21.7 transport.Error, as Cosign 3.1.3 prints it
 *   (twice: `Error: ...` and `error during command execution: ...`):
 *                                `...: TOOMANYREQUESTS: ...`
 *   and without an error body:   `unexpected status code 429 Too Many Requests`
 *
 * The codes are matched in the exact case and position each formatter writes
 * them, so a repository or message that merely contains the word does not
 * qualify.
 */
export function failedOnRegistryRateLimit(stderr) {
  const terminal = stderr.split(/\r?\n/).filter((line) => line.trim() !== "").at(-1) ?? "";
  return (
    /^Error response from registry: toomanyrequests:/.test(terminal) ||
    /\bresponse status code 429\b/.test(terminal) ||
    /: TOOMANYREQUESTS:/.test(terminal) ||
    /\bunexpected status code 429 Too Many Requests\b/.test(terminal)
  );
}

/**
 * The wait before retry number `retry` (1 = first retry), or null to stop.
 *
 * `retryAfterMs` is a delay the server stated in a Retry-After HEADER. It is a
 * floor, never a ceiling: the policy still waits at least its own backoff. If
 * the server asks for longer than one wait may be, or longer than the budget
 * has left, this returns null and the caller keeps the rate-limited result.
 */
export function rateLimitDelayMs(
  retry,
  { policy = RATE_LIMIT_POLICY, retryAfterMs = null, elapsedMs = 0, random = Math.random } = {},
) {
  if (retry >= policy.attempts) return null;
  const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1));
  const jittered = Math.min(policy.maxDelayMs, backoff * (1 + policy.jitter * random()));
  const delay = Math.max(jittered, retryAfterMs ?? 0);
  if (delay > policy.maxDelayMs) return null;
  if (elapsedMs + delay > policy.budgetMs) return null;
  return Math.ceil(delay);
}

// Resolves early, without throwing, when `abortSignal` fires; callers check it.
export const sleep = (ms, abortSignal) =>
  delay(ms, undefined, { signal: abortSignal }).catch(() => {});

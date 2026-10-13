// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The registry rate-limit retry: the shared policy, the `oras`/`cosign`
// command wrapper, the manifest lookup's HTTP boundary, and the workflow wiring.
//
// The wrapper checks run the real wrapper against a substitute client that
// makes a real HTTP request to a loopback registry and fails the way the pinned
// clients do. The workflow's own shell, with the wrapper sourced, is exercised
// in publish-tag-guard.test.mjs.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { lookupManifest } from "./lookup-manifest.mjs";
import {
  RATE_LIMIT_POLICY,
  failedOnRegistryRateLimit,
  policyFromEnv,
  rateLimitDelayMs,
} from "./registry-rate-limit.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrapper = join(repoRoot, "scripts", "registry-command.mjs");
const DIGEST = "sha256:" + "a".repeat(64);

// Verbatim from the failed GHCR publish run this change responds to.
const COSIGN_429 =
  "Error: signing [ghcr.io/pdp-connect/connector/claude-code@sha256:1ca688019dadd4f387995b56cdf2cb0c59727a58f78f7e9d27a612084178f6bb]: " +
  "signing digest: PUT https://ghcr.io/v2/pdp-connect/connector/claude-code/blobs/upload/3.51980d30-6d68-4f1b-975c-1a916a2f36f7" +
  "?digest=sha256%3A76aed46f65b180ddd304fbf9e39375a8a91e7cfa90fa238728a6877478f1c2b3: " +
  "TOOMANYREQUESTS: retry-after: 18.556833ms, allowed: 2000/minute";

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

test("only the pinned clients' terminal renderings of HTTP 429 count as a rate limit", () => {
  for (const text of [
    COSIGN_429,
    // Cosign prints its terminal error twice; the last line decides.
    `${COSIGN_429}\nerror during command execution: ${COSIGN_429.slice("Error: ".length)}\n`,
    "Error response from registry: toomanyrequests: retry-after: 700.652µs, allowed: 2000/minute",
    'Error: PUT "https://ghcr.io/v2/x/manifests/sha256:abc": response status code 429: toomanyrequests: rate limited',
    'Error: GET "https://ghcr.io/token?scope=x": response status code 429: Too Many Requests',
    "GET https://ghcr.io/v2/x/manifests/1: unexpected status code 429 Too Many Requests\r\n\n",
  ]) {
    assert.equal(failedOnRegistryRateLimit(text), true, text);
  }
  for (const text of [
    "Error: signing [x]: GET https://ghcr.io/token: UNAUTHORIZED: authentication required",
    'Error: GET "https://ghcr.io/v2/x/manifests/1": response status code 401: unauthorized: authentication required',
    "Error response from registry: denied: denied",
    "Error response from registry: unauthorized: authentication required",
    "GET https://ghcr.io/v2/x/manifests/1: MANIFEST_UNKNOWN: manifest unknown",
    "Error: no matching signatures: none of the expected identities matched",
    'Error: GET "https://ghcr.io/v2/x/blobs/y": response status code 503: Service Unavailable',
    // A repository or message that merely contains the word is not a 429.
    "Error: GET https://ghcr.io/v2/toomanyrequests/manifests/1: DENIED: denied",
    "Error: response status code 4290: nonsense",
    // An earlier, retried-away 429 is history; the terminal error is a 401.
    "retrying GET https://ghcr.io/v2/x/manifests/1: TOOMANYREQUESTS: rate limited\n" +
      "Error: signing [x]: GET https://ghcr.io/token: UNAUTHORIZED: authentication required\n",
    "",
  ]) {
    assert.equal(failedOnRegistryRateLimit(text), false, text);
  }
});

test("waits are minute-scale, jittered, bounded and finite", () => {
  const p = RATE_LIMIT_POLICY;
  assert.equal(rateLimitDelayMs(1, { random: () => 0 }), 60_000);
  assert.equal(rateLimitDelayMs(1, { random: () => 0.999 }), Math.ceil(60_000 * (1 + p.jitter * 0.999)));
  assert.equal(rateLimitDelayMs(2, { random: () => 0 }), 120_000);
  assert.equal(rateLimitDelayMs(3, { random: () => 0.999 }), p.maxDelayMs, "jitter never passes the cap");
  assert.equal(rateLimitDelayMs(p.attempts, { random: () => 0 }), null, "the last attempt is not retried");

  // The worst case of every scheduled wait fits the scheduling budget.
  let total = 0;
  for (let retry = 1; retry < p.attempts; retry += 1) {
    total += rateLimitDelayMs(retry, { random: () => 0.999 });
  }
  assert.ok(total <= p.budgetMs, `worst-case waits ${total}ms exceed the budget ${p.budgetMs}ms`);
  assert.equal(rateLimitDelayMs(1, { elapsedMs: p.budgetMs - 1000, random: () => 0 }), null);
});

test("a Retry-After header raises the wait but cannot lower it or exceed the cap", () => {
  assert.equal(rateLimitDelayMs(1, { retryAfterMs: 90_000, random: () => 0 }), 90_000);
  assert.equal(rateLimitDelayMs(1, { retryAfterMs: 1, random: () => 0 }), 60_000);
  assert.equal(rateLimitDelayMs(1, { retryAfterMs: 3_600_000, random: () => 0 }), null);
});

test("the test scale hook can only shorten the policy", () => {
  assert.equal(policyFromEnv({}), RATE_LIMIT_POLICY);
  assert.equal(policyFromEnv({ REGISTRY_RETRY_DELAY_SCALE: "10" }), RATE_LIMIT_POLICY);
  assert.equal(policyFromEnv({ REGISTRY_RETRY_DELAY_SCALE: "0" }), RATE_LIMIT_POLICY);
  assert.equal(policyFromEnv({ REGISTRY_RETRY_DELAY_SCALE: "nope" }), RATE_LIMIT_POLICY);
  const fast = policyFromEnv({ REGISTRY_RETRY_DELAY_SCALE: "0.001" });
  assert.equal(fast.baseDelayMs, 60);
  assert.equal(fast.attempts, RATE_LIMIT_POLICY.attempts);
  assert.equal(fast.budgetMs, RATE_LIMIT_POLICY.budgetMs, "a slow host must not spend a scaled budget");
});

// ---------------------------------------------------------------------------
// The command wrapper, against a substitute client speaking real HTTP
// ---------------------------------------------------------------------------

/**
 * A stand-in for `oras` and `cosign`. It makes one HTTP request to the
 * loopback registry, sending what it read from stdin, and then behaves as the
 * pinned client does for the status it got back: JSON on stdout for success;
 * for a failure, a partial stdout and the client's own error text.
 */
const FAKE_CLIENT = String.raw`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { basename } from "node:path";

const tool = basename(process.argv[1], ".mjs");
writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const args = process.argv.slice(2);
let secret = "";
if (args.includes("--password-stdin")) {
  for await (const chunk of process.stdin) secret += chunk;
}
const response = await fetch(process.env.FAKE_REGISTRY + "/v2/connector/x/blobs/uploads/", {
  method: "POST",
  headers: { "x-argv": JSON.stringify(args), "x-secret": secret },
});
const status = response.status;
const url = process.env.FAKE_REGISTRY + "/v2/connector/x/blobs/uploads/";
if (process.env.FAKE_NATIVE_429_WARNING === "1") {
  // go-containerregistry logs each of its own 429 retries before it goes on.
  console.error("retrying POST " + url + ": TOOMANYREQUESTS: rate limited");
}
if (status === 200) {
  process.stdout.write(JSON.stringify({ digest: "${DIGEST}" }) + "\n");
  process.exit(0);
}
// What a client that failed part-way may already have printed.
process.stdout.write('{"digest":');
// ORAS 1.3.3 prints an error from the target registry with this prefix.
const oras = (code, text) => "Error response from registry: " + code + ": " + text;
// Cosign 3.1.3 prints its terminal error twice.
const ggcr = (code, text) => {
  const error = "signing [x]: POST " + url + ": " + code + ": " + text;
  return "Error: " + error + "\nerror during command execution: " + error;
};
const render = {
  429: ["toomanyrequests", "TOOMANYREQUESTS", "retry-after: 700.652µs, allowed: 2000/minute"],
  401: ["unauthorized", "UNAUTHORIZED", "authentication required"],
  403: ["denied", "DENIED", "denied"],
  404: ["manifest unknown", "MANIFEST_UNKNOWN", "manifest unknown"],
}[status];
if (render) {
  console.error(tool === "oras" ? oras(render[0], render[2]) : ggcr(render[1], render[2]));
  process.exit(1);
}
console.error("Error: no matching signatures: none of the expected identities matched");
process.exit(10);
`;

async function withFakeRegistry(statuses, body) {
  const dir = mkdtempSync(join(tmpdir(), "registry-rate-limit-"));
  const bin = join(dir, "bin");
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ argv: JSON.parse(req.headers["x-argv"]), secret: req.headers["x-secret"] });
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    if (status === "hang") return; // accepted, never answered
    res.writeHead(status, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    mkdirSync(bin);
    for (const tool of ["oras", "cosign"]) {
      // Each tool is its own copy, so the client can tell which one it is.
      writeFileSync(join(dir, `${tool}.mjs`), FAKE_CLIENT);
      const shim = join(bin, tool);
      writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, `${tool}.mjs`)}" "$@"\n`);
      chmodSync(shim, 0o755);
    }
    return await body({
      requests,
      run: (tool, args, { input, env = {}, onSpawn } = {}) =>
        runWrapper(tool, args, {
          input,
          onSpawn,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            FAKE_REGISTRY: `http://127.0.0.1:${server.address().port}`,
            FAKE_PID_FILE: join(dir, "client.pid"),
            REGISTRY_RETRY_DELAY_SCALE: "0.0001",
            ...env,
          },
        }),
      clientPid: () => Number(readFileSync(join(dir, "client.pid"), "utf8")),
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}

function runWrapper(tool, args, { input, env, onSpawn }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, tool, ...args], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(input ?? "");
    onSpawn?.(child);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("a rate-limited command is retried, and only the successful attempt's stdout is kept", async () => {
  await withFakeRegistry([429, 429, 200], async ({ requests, run }) => {
    const args = ["sign", "--yes", `ghcr.io/pdp-connect/connector/x@${DIGEST}`];
    const result = await run("cosign", args);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 3, "two rate-limited tries and one success");
    for (const request of requests) {
      assert.deepEqual(request.argv, args, "every retry is the identical command, by digest");
    }
    // A caller redirecting `--format json` into a file must get one document.
    assert.deepEqual(JSON.parse(result.stdout), { digest: DIGEST });
    assert.match(result.stderr, /TOOMANYREQUESTS/);
    assert.equal((result.stderr.match(/::warning::cosign sign was rate-limited/g) ?? []).length, 2);
  });
});

test("the oras rendering of a 429 is retried the same way", async () => {
  await withFakeRegistry([429, 200], async ({ requests, run }) => {
    const result = await run("oras", ["tag", `ghcr.io/pdp-connect/connector/x@${DIGEST}`, "0.3.0"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
  });
});

test("a login's stdin is replayed to every attempt and never printed", async () => {
  const secret = "ghs_substitute-secret-value";
  await withFakeRegistry([429, 429, 200], async ({ requests, run }) => {
    const result = await run("oras", ["login", "ghcr.io", "--username", "actor", "--password-stdin"], {
      input: secret,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.secret), [secret, secret, secret]);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  });
});

test("a rate limit that outlasts the policy fails with the client's status and no stdout", async () => {
  await withFakeRegistry([429], async ({ requests, run }) => {
    const result = await run("cosign", ["sign", "--yes", `ghcr.io/pdp-connect/connector/x@${DIGEST}`]);
    assert.equal(result.status, 1);
    assert.equal(requests.length, RATE_LIMIT_POLICY.attempts);
    assert.equal(result.stdout, "", "a failed attempt's partial JSON must not reach stdout");
    assert.match(result.stderr, /::error::cosign sign was rate-limited by the registry on 4 attempt/);
  });
});

for (const { status, label, exit } of [
  { status: 401, label: "an authentication failure", exit: 1 },
  { status: 404, label: "a missing manifest", exit: 1 },
  { status: 400, label: "a failed signature verification", exit: 10 },
]) {
  test(`${label} is not retried and keeps its exit status`, async () => {
    await withFakeRegistry([status, 200], async ({ requests, run }) => {
      const result = await run("cosign", ["verify", `ghcr.io/pdp-connect/connector/x@${DIGEST}`]);
      assert.equal(result.status, exit, result.stderr);
      assert.equal(requests.length, 1, `${label} must not be retried`);
      assert.equal(result.stdout, "");
      assert.doesNotMatch(result.stderr, /::warning::/);
    });
  });
}

// The defect this pins: go-containerregistry logs `retrying ...: TOOMANYREQUESTS`
// for its own retries, so a 429 it retried away can precede a different final
// failure. Only the terminal error decides; the earlier line is history.
for (const { tool, status, label, exit } of [
  { tool: "cosign", status: 401, label: "an authentication failure", exit: 1 },
  { tool: "cosign", status: 403, label: "a denial", exit: 1 },
  { tool: "cosign", status: 400, label: "a failed verification", exit: 10 },
  { tool: "oras", status: 401, label: "an ORAS authentication failure", exit: 1 },
]) {
  test(`${label} after a native 429 retry warning is not retried`, async () => {
    await withFakeRegistry([status, 200], async ({ requests, run }) => {
      const result = await run(tool, ["sign", "--yes", `x@${DIGEST}`], {
        env: { FAKE_NATIVE_429_WARNING: "1" },
      });
      assert.match(result.stderr, /retrying POST .*: TOOMANYREQUESTS/, "the warning was printed");
      assert.equal(result.status, exit, result.stderr);
      assert.equal(requests.length, 1, `${label} must not be retried`);
      assert.doesNotMatch(result.stderr, /::(warning|error)::/);
    });
  });
}

test("a terminal 429 after a native 429 retry warning is still retried", async () => {
  await withFakeRegistry([429, 200], async ({ requests, run }) => {
    const result = await run("cosign", ["sign", "--yes", `x@${DIGEST}`], {
      env: { FAKE_NATIVE_429_WARNING: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(requests.length, 2);
  });
});

// Bounded: without forwarding, the wrapper would wait on the client forever.
test("SIGTERM stops the running client and every later retry", { timeout: 15_000 }, async () => {
  await withFakeRegistry(["hang"], async ({ requests, run, clientPid }) => {
    const result = await run("cosign", ["sign", "--yes", `x@${DIGEST}`], {
      onSpawn: (child) => {
        const poll = setInterval(() => {
          if (requests.length > 0) {
            clearInterval(poll);
            child.kill("SIGTERM");
          }
        }, 10);
      },
    });
    assert.equal(result.status, 143, result.stderr);
    const pid = clientPid();
    assert.throws(() => process.kill(pid, 0), /ESRCH/, "the client must not outlive the wrapper");
    assert.equal(requests.length, 1, "no retry after cancellation");
  });
});

test("a client that cannot be started says why", async () => {
  const result = await runWrapper("oras", ["version"], {
    env: { PATH: join(tmpdir(), "registry-rate-limit-no-such-dir") },
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /oras: spawn oras ENOENT/);
});

// ---------------------------------------------------------------------------
// The manifest lookup's HTTP boundary
// ---------------------------------------------------------------------------

const errorBody = (code, message) => JSON.stringify({ errors: [{ code, message }] });
const challenge = {
  status: 401,
  headers: { "www-authenticate": 'Bearer realm="https://registry.invalid/token",service="registry"' },
  body: errorBody("UNAUTHORIZED", "authentication required"),
};
const tooMany = (headers = {}) => ({ status: 429, headers, body: errorBody("TOOMANYREQUESTS", "slow down") });

/** A scripted registry: each URL kind answers from its own queue. */
function scripted({ manifest, token = [{ status: 200, headers: {}, body: '{"token":"t"}' }] }) {
  const seen = [];
  const queues = { manifest: [...manifest], token: [...token] };
  const fetchImpl = async (url, options) => {
    const kind = url.includes("/token") ? "token" : "manifest";
    seen.push({ kind, url, authorization: options.headers.authorization });
    const queue = queues[kind];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { seen, fetchImpl };
}

function clock() {
  let t = 1_700_000_000_000;
  const waits = [];
  return {
    waits,
    rateLimit: {
      now: () => t,
      random: () => 0,
      wait: async (ms) => {
        waits.push(ms);
        t += ms;
      },
    },
  };
}

const lookup = (fetchImpl, rateLimit) =>
  lookupManifest({ registry: "registry.invalid", name: "connector/x", tag: "0.3.0", credential: "Y3JlZA==", fetchImpl, rateLimit });

test("a rate-limited manifest request waits at least its Retry-After seconds, then answers", async () => {
  const ok = { status: 200, headers: { "docker-content-digest": DIGEST }, body: "{}" };
  const { seen, fetchImpl } = scripted({ manifest: [tooMany({ "retry-after": "90" }), challenge, ok] });
  const { waits, rateLimit } = clock();

  const result = await lookup(fetchImpl, rateLimit);

  assert.deepEqual(result, { outcome: "present", digest: DIGEST });
  assert.deepEqual(waits, [90_000], "Retry-After 90 beats the 60s floor");
  assert.equal(seen[0].url, seen[1].url, "the retry asks about the same reference");
});

test("a rate-limited token request honors an HTTP-date Retry-After and resends the same credential", async () => {
  const { waits, rateLimit } = clock();
  const later = new Date(rateLimit.now() + 120_000).toUTCString();
  const ok = { status: 200, headers: { "docker-content-digest": DIGEST }, body: "{}" };
  const { seen, fetchImpl } = scripted({
    manifest: [challenge, ok],
    token: [tooMany({ "retry-after": later }), { status: 200, headers: {}, body: '{"token":"t"}' }],
  });

  const result = await lookup(fetchImpl, rateLimit);

  assert.deepEqual(result, { outcome: "present", digest: DIGEST });
  assert.deepEqual(waits, [120_000]);
  const tokens = seen.filter((request) => request.kind === "token");
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].url, tokens[1].url);
  assert.equal(tokens[1].authorization, "Basic Y3JlZA==");
});

test("a rate limit that outlasts the policy is unknown, never absent", async () => {
  for (const script of [
    { manifest: [tooMany()] },
    { manifest: [challenge, tooMany()] },
    { manifest: [challenge], token: [tooMany()] },
  ]) {
    const { seen, fetchImpl } = scripted(script);
    const { waits, rateLimit } = clock();
    const result = await lookup(fetchImpl, rateLimit);
    assert.equal(result.outcome, "unknown", JSON.stringify(result));
    assert.match(result.reason, /429/);
    assert.equal(waits.length, RATE_LIMIT_POLICY.attempts - 1);
    assert.ok(seen.length >= RATE_LIMIT_POLICY.attempts);
  }
});

test("a Retry-After longer than the policy allows fails closed at once", async () => {
  const { seen, fetchImpl } = scripted({ manifest: [tooMany({ "retry-after": "3600" })] });
  const { waits, rateLimit } = clock();
  const result = await lookup(fetchImpl, rateLimit);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(waits, []);
  assert.equal(seen.length, 1);
});

test("a non-429 failure is not retried", async () => {
  for (const response of [
    { status: 503, headers: { "retry-after": "1" }, body: "" },
    { status: 403, headers: {}, body: errorBody("DENIED", "denied") },
    { status: 404, headers: {}, body: errorBody("MANIFEST_UNKNOWN", "manifest unknown") },
  ]) {
    const { seen, fetchImpl } = scripted({ manifest: [response] });
    const { waits, rateLimit } = clock();
    await lookup(fetchImpl, rateLimit);
    assert.deepEqual(waits, [], `HTTP ${response.status}`);
    assert.equal(seen.length, 1, `HTTP ${response.status}`);
  }
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("connect ECONNREFUSED");
  };
  const { waits, rateLimit } = clock();
  const result = await lookup(failing, rateLimit);
  assert.equal(result.outcome, "unknown");
  assert.deepEqual(waits, [], "a transport error is not retried");
  assert.equal(calls, 1);
});

test("the lookup entrypoint recovers from a real HTTP 429 with Retry-After", async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (requests === 1) {
      res.writeHead(429, { "retry-after": "1", "content-type": "application/json" });
      return res.end(errorBody("TOOMANYREQUESTS", "slow down"));
    }
    res.writeHead(200, { "docker-content-digest": DIGEST });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const started = Date.now();
    const result = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [join(repoRoot, "scripts", "lookup-manifest.mjs"), "--reference", `127.0.0.1:${server.address().port}/connector/x:0.3.0`],
        { env: { ...process.env, LOOKUP_SCHEME: "http", REGISTRY_RETRY_DELAY_SCALE: "0.01" } },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", () => resolve(stdout));
    });
    assert.deepEqual(JSON.parse(result), { outcome: "present", digest: DIGEST });
    assert.equal(requests, 2);
    assert.ok(Date.now() - started >= 1000, "the Retry-After second was waited out");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// The workflow wiring
// ---------------------------------------------------------------------------

test("every workflow step that runs oras or cosign sources the wrapper first", () => {
  const lines = readFileSync(
    join(repoRoot, ".github", "workflows", "publish-polyfill-connectors.yml"),
    "utf8",
  ).split("\n");
  const command = /^\s*(?:\S.*\|\s*)?(oras|cosign)\s/;
  const steps = [];
  for (const [index, line] of lines.entries()) {
    if (/^\s*-\s*(name|uses):/.test(line)) steps.push({ start: index, lines: [] });
    else if (steps.length > 0) steps.at(-1).lines.push(line);
  }

  let checked = 0;
  for (const step of steps) {
    const body = step.lines.filter((line) => !/^\s*#/.test(line));
    const first = body.findIndex((line) => command.test(line));
    if (first === -1) continue;
    checked += 1;
    const source = body.findIndex((line) => /^\s*source\s+\S*scripts\/registry-command\.sh"?\s*$/.test(line));
    assert.ok(
      source !== -1 && source < first,
      `step at workflow line ${step.start + 1} runs \`${body[first].trim()}\` without sourcing scripts/registry-command.sh first`,
    );
  }
  assert.equal(checked, 3, "expected the publish, verify and catalog steps");
});

test("the publish matrix is bounded and does not fail fast", () => {
  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "publish-polyfill-connectors.yml"),
    "utf8",
  );
  const strategy = workflow.match(/\n {4}strategy:\n((?: {6}.*\n|\s*\n)+)/)?.[1] ?? "";
  assert.match(strategy, /^ {6}fail-fast: false$/m);
  assert.match(strategy, /^ {6}max-parallel: 4$/m);
});

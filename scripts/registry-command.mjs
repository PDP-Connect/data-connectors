// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runs one `oras` or `cosign` command and retries it ONLY when the registry
// rate-limited it. Usage: node registry-command.mjs <oras|cosign> [args...]
//
// The publish steps reach this through the shell functions in
// registry-command.sh, so their command lines read exactly as before.
//
// Why a wrapper. The pinned clients retry 429 themselves, but for seconds, and
// expose no flag or environment variable to wait longer (see
// registry-rate-limit.mjs). GHCR counts its limit per minute.
//
// What it keeps:
//   - The command and its arguments are unchanged. One command is retried, not
//     the step: a retry of `cosign sign ...@DIGEST` signs the same digest, and
//     a retry of the untagged push or `oras tag ...@DIGEST` writes the same
//     content-addressed state.
//   - Any other failure (authentication, a missing manifest, a failed
//     verification, a transport error) returns at once with the client's own
//     exit status. Only the client's terminal error line is classified, never
//     its earlier log of its own retries.
//   - stdout is written only from the attempt that succeeded, so a caller that
//     redirects `--format json` into a file never gets a failed attempt's
//     partial output in front of it. Failed attempts' stdout goes to stderr.
//   - stdin is read into memory once when the command takes `--password-stdin`
//     and replayed to every attempt. It is never written anywhere else.
//
// What it cannot do: the clients print GHCR's `retry-after: <duration>` only as
// text inside the registry's error message, not as an HTTP Retry-After header,
// and the only way to see headers is debug logging, which would print request
// credentials. This script therefore does not read a server delay and always
// waits on the policy's minute scale.
//
// Removal condition. Released oras-go (through v2.6.3) still caps a retry wait
// at 3s, and ORAS CLI 1.3.3 and 1.3.4 pin v2.6.2. oras-go main has an
// unreleased change (02bcbc32d353, aimed at v3) that honors Retry-After up to
// 60s. Drop `oras` from this wrapper once the pinned ORAS CLI ships that
// policy and a burst publish to GHCR passes without the wrapper. `cosign`
// stays until go-containerregistry or Cosign offers a comparable policy.

import { spawn } from "node:child_process";
import { constants } from "node:os";
import {
  failedOnRegistryRateLimit,
  policyFromEnv,
  rateLimitDelayMs,
  sleep,
} from "./registry-rate-limit.mjs";

const TOOLS = new Set(["oras", "cosign"]);
// Enough of the error tail to hold the client's final message.
const STDERR_TAIL_BYTES = 64 * 1024;

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function runOnce(tool, args, input, abortSignal) {
  return new Promise((resolve) => {
    const child = spawn(tool, args, {
      stdio: [input === null ? "inherit" : "pipe", "pipe", "pipe"],
    });
    // A cancelled job signals this process; pass the same signal on, so the
    // client is not left running after the step has been told to stop.
    const forward = () => child.kill(abortSignal.reason);
    abortSignal?.addEventListener("abort", forward, { once: true });
    const stdout = [];
    let stderrTail = "";
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      // Live, so the job log shows progress as it happens.
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    if (input !== null) {
      // A client that exits without reading its input closes the pipe; that
      // EPIPE is the client's business, not a reason to crash the wrapper.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    const finish = (result) => {
      abortSignal?.removeEventListener("abort", forward);
      resolve(result);
    };
    child.on("error", (error) => {
      // Not started at all, e.g. the binary is not on PATH.
      process.stderr.write(`${tool}: ${error.message}\n`);
      finish({ status: 127, stdout: Buffer.alloc(0), stderrTail: "" });
    });
    child.on("close", (code, signal) => {
      finish({
        status: code ?? 128 + (constants.signals[signal] ?? 0),
        stdout: Buffer.concat(stdout),
        stderrTail,
      });
    });
  });
}

export async function runRegistryCommand(
  tool,
  args,
  {
    input = null,
    policy = policyFromEnv(),
    now = Date.now,
    random = Math.random,
    wait = sleep,
    abortSignal,
  } = {},
) {
  const started = now();
  const aborted = () => ({
    status: 128 + (constants.signals[abortSignal.reason] ?? 0),
    stdout: Buffer.alloc(0),
    stderrTail: "",
  });
  for (let attempt = 1; ; attempt += 1) {
    if (abortSignal?.aborted) return aborted();
    const result = await runOnce(tool, args, input, abortSignal);
    if (abortSignal?.aborted) return aborted();
    if (result.status === 0) return result;

    const rateLimited = failedOnRegistryRateLimit(result.stderrTail);
    const delayMs = rateLimited
      ? rateLimitDelayMs(attempt, { policy, elapsedMs: now() - started, random })
      : null;

    if (result.stdout.length > 0) process.stderr.write(result.stdout);
    if (delayMs === null) {
      if (rateLimited) {
        process.stderr.write(
          `::error::${tool} ${args[0] ?? ""} was rate-limited by the registry on ${attempt} ` +
            `attempt(s); the retry budget is spent\n`,
        );
      }
      return { ...result, stdout: Buffer.alloc(0) };
    }
    process.stderr.write(
      `::warning::${tool} ${args[0] ?? ""} was rate-limited by the registry (HTTP 429); ` +
        `retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${policy.attempts})\n`,
    );
    await wait(delayMs, abortSignal);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [tool, ...args] = process.argv.slice(2);
  if (!TOOLS.has(tool)) {
    process.stderr.write("usage: registry-command.mjs <oras|cosign> [args...]\n");
    process.exit(2);
  }
  const controller = new AbortController();
  for (const name of ["SIGTERM", "SIGINT"]) {
    process.once(name, () => controller.abort(name));
  }
  const input = args.includes("--password-stdin") ? await readAll(process.stdin) : null;
  const result = await runRegistryCommand(tool, args, { input, abortSignal: controller.signal });
  process.stdout.write(result.stdout);
  process.exitCode = result.status;
}

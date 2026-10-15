// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SCOPES = [
  "packages/polyfill-connectors/src/",
  "packages/polyfill-connectors/bin/scenario-",
  "packages/polyfill-connectors/docs/scenario-consumer-contract.md",
  "packages/polyfill-connectors/test-fixtures/scenario-consumer/",
  "packages/polyfill-connectors/scripts/scenario-compatibility",
  ".github/workflows/scenario-compatibility.yml",
  "package.json",
  "package-lock.json",
  "packages/polyfill-connectors/package.json",
  "packages/polyfill-connectors/package-lock.json",
];
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;
const ZERO_SHA_RE = /^0{40}$/;
const GIT_PATH_SEPARATOR = "\0";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function validCommit(ref, cwd) {
  if (!COMMIT_SHA_RE.test(ref)) {
    return false;
  }
  try {
    return git(["cat-file", "-t", ref], cwd) === "commit";
  } catch {
    return false;
  }
}

export function relevantPath(path) {
  return SCOPES.some((scope) =>
    scope.endsWith("/") ? path.startsWith(scope) : path === scope || path.startsWith(scope)
  );
}

export function changedPaths({ eventName, baseSha, headSha, cwd }) {
  if (!validCommit(headSha, cwd)) {
    throw new Error("invalid head commit");
  }
  if (eventName === "push" && ZERO_SHA_RE.test(baseSha ?? "")) {
    return null;
  }
  if (!validCommit(baseSha, cwd)) {
    throw new Error("invalid base commit");
  }
  const base = eventName === "pull_request" ? git(["merge-base", baseSha, headSha], cwd) : baseSha;
  if (!validCommit(base, cwd)) {
    throw new Error("invalid comparison commit");
  }
  const output = git(["diff", "--name-status", "-z", "-M", base, headSha], cwd);
  const paths = [];
  const fields = output ? output.split(GIT_PATH_SEPARATOR) : [];
  if (fields.at(-1) === "") {
    fields.pop();
  }
  for (let index = 0; index < fields.length; ) {
    const status = fields[index];
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      paths.push(fields[index], fields[index + 1]);
      index += 2;
    } else {
      paths.push(fields[index]);
      index += 1;
    }
  }
  return paths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const isPush = eventName === "push";
    if (!isPush && eventName !== "pull_request") {
      throw new Error("unsupported event");
    }
    const headSha = process.env.HEAD_SHA;
    const baseSha = isPush ? process.env.BEFORE_SHA : process.env.BASE_SHA;
    const baseline = isPush && ZERO_SHA_RE.test(baseSha ?? "") ? "c0c6f1e4faa7015cf6447230b0c17a5f9769b09b" : baseSha;
    const paths = changedPaths({ eventName, baseSha, headSha, cwd: process.cwd() });
    const relevant = paths === null || paths.some(relevantPath);
    if (process.env.GITHUB_OUTPUT) {
      const fs = await import("node:fs");
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `relevant=${relevant}\nbaseline=${baseline}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ relevant, baseline })}\n`);
    }
  } catch (error) {
    process.stderr.write(`scenario compatibility admission failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

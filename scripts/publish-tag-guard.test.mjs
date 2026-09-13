// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Guards the ORDER of the republication check against the mutable version tag,
// by EXECUTING the workflow's real `Push and sign` shell and then observing what
// the registry actually holds.
//
// This suite exists because the assertion it replaces could not have caught the
// defect it was written for. `publish-ref-gate.test.mjs` asserted that the
// workflow text contained `oras manifest fetch --descriptor` and a digest
// comparison — both of which were present, and both of which ran AFTER the push
// that had already overwritten the released version tag. The workflow refused,
// exited 1, and had by then redefined the version to different unsigned bytes.
// A claim about which strings appear in a file is strictly narrower than the
// claim anyone cares about, which is about registry state:
//
//   Given a published version tag at digest C and a candidate at digest A,
//   the publish must refuse AND the tag must still resolve to C.
//   Given a published version tag at A and a candidate at A, it must succeed.
//
// So the checks here run the shell and then read the tag back, independently of
// anything the shell reported about itself. A workflow that reorders the guard
// back after the tag write passes every text assertion and fails these.
//
// SUBSTITUTES, and what stays real. The registry is a directory (below) and
// `oras`/`cosign`/`git` are small stand-ins on PATH — no Docker, no network,
// nothing reachable off-box, so this runs anywhere `node --test` does. What is
// NOT substituted is the thing under test: the shell body is extracted VERBATIM
// from the workflow file, so its sequencing, its digest parsing and its refusal
// are the workflow's own. `cosign` never signs; it records that it was called,
// which is itself an assertion target (a refusal must not sign).

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, ".github", "workflows", "publish-polyfill-connectors.yml");

/**
 * Lift the `Push and sign` step's `run:` block out of the workflow, verbatim.
 *
 * Verbatim is the point: a paraphrase of the shell would test the paraphrase.
 * The only transformation is on `${{ }}` — those are Actions expressions
 * interpolated before bash ever sees the script, so leaving them in would test
 * bash's handling of a syntax bash does not have.
 */
function extractPushAndSign() {
  const lines = readFileSync(workflowPath, "utf8").split("\n");
  const stepIndex = lines.findIndex((line) => /^\s*-\s*name:\s*Push and sign\s*$/.test(line));
  assert.notEqual(stepIndex, -1, "expected a `Push and sign` step to extract");

  const runIndex = lines.findIndex((line, i) => i > stepIndex && /^\s*run:\s*\|\s*$/.test(line));
  assert.notEqual(runIndex, -1, "expected `Push and sign` to carry a block `run:` script");

  const indent = lines[runIndex].match(/^\s*/)[0].length + 2;
  const body = [];
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }

  // `github.actor` is the only expression in this step's body. Replacing it with
  // a literal is what the Actions runner does before invoking bash.
  return body.join("\n").replace(/\$\{\{\s*github\.actor\s*\}\}/g, "substitute-actor");
}

/**
 * A minimal substitute registry, backed by a directory.
 *
 * It implements only what this step exercises — store a manifest by digest,
 * point a tag at a digest, resolve a tag — but it models faithfully the one fact
 * the whole property rests on: writing to `:tag` MOVES that tag, writing by
 * digest moves nothing, and the result is readable afterwards by someone who did
 * not perform the write. A substitute that did not model that would prove
 * nothing about the ordering.
 *
 * It is a directory rather than an HTTP server on 127.0.0.1 because the shell
 * under test must be run synchronously: a server in this process cannot answer a
 * child process that this process is blocked waiting on. Files have no such
 * problem, and the stored state is if anything easier to inspect.
 */
function startRegistry(root) {
  const manifestDir = join(root, "manifests");
  const tagDir = join(root, "tags");
  mkdirSync(manifestDir, { recursive: true });
  mkdirSync(tagDir, { recursive: true });

  // A tag is one file whose contents are a digest, which is what a tag IS.
  const tagFile = (name, tag) => join(tagDir, `${name}:${tag}`.replace(/\//g, "__"));

  return {
    root,
    /** The independent read: it never asks the shell what it thinks it did. */
    resolveTag(name, tag) {
      const file = tagFile(name, tag);
      return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    },
    close: () => {},
    manifestDir,
    tagDir,
  };
}

/**
 * A substitute `oras` implementing the three verbs this step uses, against the
 * registry above. It is a stand-in for the client, not for the workflow: the
 * decision of WHICH verb runs WHEN belongs entirely to the extracted shell.
 *
 * `push` deliberately reproduces the ORAS behaviour that makes the same-digest
 * retry non-trivial — an absent `org.opencontainers.image.created` annotation is
 * filled in with the current time, so a workflow that does not pin it produces a
 * fresh digest on every run.
 */
const ORAS_STUB = String.raw`#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
appendFileSync(process.env.ARGV_LOG, JSON.stringify(argv) + "\n");
const verb = argv[0];
const flagAll = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const flag = (name) => flagAll(name)[0];

const root = process.env.SUBSTITUTE_REGISTRY;
const manifestFile = (digest) => join(root, "manifests", digest.replace(":", "_"));
const tagFile = (name, tag) => join(root, "tags", (name + ":" + tag).replace(/\//g, "__"));

// Split "host/name[:tag|@digest]" into the repository name and the reference.
// An absent reference is the untagged, content-addressed form.
const split = (ref) => {
  const at = ref.indexOf("@");
  if (at !== -1) return { name: ref.slice(0, at).split("/").slice(1).join("/"), ref: ref.slice(at + 1) };
  const slash = ref.lastIndexOf("/");
  const colon = ref.indexOf(":", slash);
  if (colon !== -1) return { name: ref.slice(0, colon).split("/").slice(1).join("/"), ref: ref.slice(colon + 1) };
  return { name: ref.split("/").slice(1).join("/"), ref: null };
};

const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

if (verb === "login") {
  // The substitute registry is unauthenticated. Drain the piped token so the
  // writer never sees EPIPE, then exit.
  await new Promise((resolve) => {
    process.stdin.on("data", () => {});
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
    process.stdin.resume();
  });
  process.exit(0);
}

if (verb === "push") {
  const { name, ref } = split(argv[1]);
  const annotations = {};
  for (const a of flagAll("--annotation")) {
    const eq = a.indexOf("=");
    annotations[a.slice(0, eq)] = a.slice(eq + 1);
  }
  // The ORAS behaviour that forces the workflow to pin created explicitly: left
  // unset, the manifest is a function of the clock and no retry can match.
  if (!annotations["org.opencontainers.image.created"]) {
    annotations["org.opencontainers.image.created"] = new Date().toISOString();
  }

  const [configFile, configType] = flag("--config").split(":");
  const configBytes = readFileSync(configFile);
  const config = { mediaType: configType, digest: sha256(configBytes), size: configBytes.length };

  const layers = [];
  for (const spec of argv.slice(2)) {
    if (spec.startsWith("-")) continue;
    const idx = spec.lastIndexOf(":");
    if (idx === -1) continue;
    const file = spec.slice(0, idx);
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    layers.push({
      mediaType: spec.slice(idx + 1),
      digest: sha256(bytes),
      size: bytes.length,
      annotations: { "org.opencontainers.image.title": file },
    });
  }

  const manifest = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: flag("--artifact-type"),
    config, layers, annotations,
  }));
  const digest = sha256(manifest);
  writeFileSync(manifestFile(digest), manifest);
  // THE fact under test: pushing to a tag MOVES that tag. An untagged reference
  // writes content-addressed bytes and moves nothing.
  if (ref) writeFileSync(tagFile(name, ref), digest);

  process.stdout.write(JSON.stringify({ reference: argv[1], digest, size: manifest.length }) + "\n");
  process.exit(0);
}

if (verb === "tag") {
  const { name, ref } = split(argv[1]);
  const digest = ref.startsWith("sha256:")
    ? ref
    : (existsSync(tagFile(name, ref)) ? readFileSync(tagFile(name, ref), "utf8").trim() : null);
  if (!digest || !existsSync(manifestFile(digest))) {
    console.error("tag: source not found");
    process.exit(1);
  }
  for (const newTag of argv.slice(2)) {
    if (newTag.startsWith("-")) continue;
    writeFileSync(tagFile(name, newTag), digest);
  }
  process.exit(0);
}

if (verb === "manifest" && argv[1] === "fetch") {
  const { name, ref } = split(argv[argv.length - 1]);
  const digest = ref.startsWith("sha256:")
    ? ref
    : (existsSync(tagFile(name, ref)) ? readFileSync(tagFile(name, ref), "utf8").trim() : null);
  if (!digest || !existsSync(manifestFile(digest))) process.exit(1);
  const body = readFileSync(manifestFile(digest));
  if (argv.includes("--descriptor")) {
    process.stdout.write(JSON.stringify({
      mediaType: "application/vnd.oci.image.manifest.v1+json", digest, size: body.length,
    }) + "\n");
  } else {
    process.stdout.write(body);
  }
  process.exit(0);
}

console.error("substitute oras: unsupported: " + argv.join(" "));
process.exit(1);
`;

const COSIGN_STUB = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ARGV_LOG, JSON.stringify(["cosign", ...process.argv.slice(2)]) + "\\n");
process.exit(0);
`;

// The workflow derives the manifest's `created` from the source commit. In the
// harness that is a fixed value: the property under test is that it is a
// FUNCTION OF THE COMMIT rather than of wall-clock time, which a constant
// captures exactly.
const GIT_STUB = `#!/usr/bin/env node
process.stdout.write("2026-01-02T03:04:05+00:00\\n");
process.exit(0);
`;

/**
 * Run the extracted shell once, pushing `code` to `repository:0.3.0`.
 * Returns the exit status, the recorded argv, and — separately — what the
 * registry holds afterwards.
 */
function runPublish({ registry, dir, name, code }) {
  const scratch = mkdtempSync(join(dir, "run-"));
  const artifact = join(scratch, "artifact");
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, "config.json"), '{"connector":"ynab","version":"0.3.0"}\n');
  writeFileSync(join(artifact, "code.tgz"), `${code}\n`);
  writeFileSync(
    join(artifact, "layers.json"),
    JSON.stringify({
      layers: [{ file: "code.tgz", mediaType: "application/vnd.pdpp.connector.code.v1+gzip" }],
    }),
  );

  // Each stub is a real .mjs file plus a tiny shim on PATH, so the extracted
  // shell invokes `oras`/`cosign`/`git` by name exactly as the runner would.
  const bin = join(scratch, "bin");
  mkdirSync(bin, { recursive: true });
  for (const [tool, source] of [["oras", ORAS_STUB], ["cosign", COSIGN_STUB], ["git", GIT_STUB]]) {
    const impl = join(bin, `${tool}.mjs`);
    writeFileSync(impl, source);
    const shim = join(bin, tool);
    writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${impl}" "$@"\n`);
    chmodSync(shim, 0o755);
  }

  const script = join(scratch, "push-and-sign.sh");
  writeFileSync(script, extractPushAndSign());

  const argvLog = join(scratch, "argv.jsonl");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: scratch,
    ARGV_LOG: argvLog,
    SUBSTITUTE_REGISTRY: registry.root,
    RUNNER_TEMP: scratch,
    GITHUB_WORKSPACE: repoRoot,
    GITHUB_OUTPUT: join(scratch, "github_output"),
    GITHUB_STEP_SUMMARY: join(scratch, "step_summary"),
    GH_TOKEN: "substitute-token",
    // The host is a placeholder: the substitute client resolves by repository
    // name against the directory above, so only the name after it matters.
    REPOSITORY: `substitute.invalid/${name}`,
    VERSION: "0.3.0",
    CONNECTOR: "ynab",
    GITHUB_REPOSITORY: "PDP-Connect/data-connectors",
    GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
  };
  writeFileSync(argvLog, "");

  let status = 0;
  let output = "";
  try {
    output = execFileSync("bash", [script], { cwd: artifact, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    status = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }

  const calls = readFileSync(argvLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return { status, output, calls };
}

function withRegistry(body) {
  const dir = mkdtempSync(join(tmpdir(), "publish-tag-guard-"));
  const registry = startRegistry(join(dir, "registry"));
  try {
    return body({ registry, dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a conflicting republication leaves the released version tag pointing at the published digest", () => {
  // THE regression. The defective ordering pushed straight to `:VERSION`, then
  // compared, then exited 1 — so it reported a refusal it had not performed. The
  // exit code is checked here, but it is the SECOND assertion: a workflow can
  // exit 1 and still have destroyed the release, which is exactly what happened.
  withRegistry(({ registry, dir }) => {
    const name = "connector/ynab";

    const published = runPublish({ registry, dir, name, code: "CODE-C-RELEASED" });
    assert.equal(published.status, 0, `the first publish should succeed\n${published.output}`);
    const digestC = registry.resolveTag(name, "0.3.0");
    assert.ok(digestC, "the first publish must leave the version tag resolvable");

    const conflicting = runPublish({ registry, dir, name, code: "CODE-A-DIFFERENT" });

    assert.equal(conflicting.status, 1, `a differing republication must fail\n${conflicting.output}`);
    assert.match(
      conflicting.output,
      /refusing to redefine it/,
      "the refusal should annotate the Actions run",
    );

    // The assertion the text-only check could not make. Read the registry, not
    // the shell's account of itself.
    assert.equal(
      registry.resolveTag(name, "0.3.0"),
      digestC,
      "the released version tag must still resolve to the digest it was published as — " +
        "a guard that runs after the tag write refuses and redefines in the same breath",
    );

    // A refusal must not put the org's signing identity behind anything, and
    // must not have moved the tag by any route.
    assert.deepEqual(
      conflicting.calls.filter((call) => call[0] === "cosign"),
      [],
      "a refused republication must not sign",
    );
    assert.deepEqual(
      conflicting.calls.filter((call) => call[0] === "tag"),
      [],
      "a refused republication must not reach the tag write at all",
    );
  });
});

test("an identical-byte retry republishes the same version successfully", () => {
  // The other half of the guard, and the reason it compares digests instead of
  // testing existence: re-running a release after a transient failure is
  // legitimate and must not need a version bump.
  //
  // This runs the real shell TWICE rather than seeding a tag, because that is
  // what a retry is. It also pins the property that makes a retry possible at
  // all: the manifest digest must be a function of the inputs. ORAS stamps
  // `org.opencontainers.image.created` with wall-clock time unless the push sets
  // it, and with that annotation unpinned every retry produces a new digest and
  // the guard refuses all of them.
  withRegistry(({ registry, dir }) => {
    const name = "connector/ynab";

    const first = runPublish({ registry, dir, name, code: "CODE-A" });
    assert.equal(first.status, 0, `the first publish should succeed\n${first.output}`);
    const digestA = registry.resolveTag(name, "0.3.0");

    const retry = runPublish({ registry, dir, name, code: "CODE-A" });
    assert.equal(
      retry.status,
      0,
      `an identical-byte retry must succeed — if this fails, the manifest is not a ` +
        `function of its inputs and no retry can ever pass the guard\n${retry.output}`,
    );
    assert.equal(
      registry.resolveTag(name, "0.3.0"),
      digestA,
      "an identical retry must leave the version tag on the same digest",
    );
    assert.ok(
      retry.calls.some((call) => call[0] === "cosign"),
      "a successful retry still signs the digest it published",
    );
  });
});

test("a first publish of a new version tags and signs the digest it pushed", () => {
  // The path that must stay working. Without it, the two checks above are also
  // satisfied by a workflow that refuses everything.
  withRegistry(({ registry, dir }) => {
    const name = "connector/ynab";
    const result = runPublish({ registry, dir, name, code: "CODE-NEW" });

    assert.equal(result.status, 0, `a first publish must succeed\n${result.output}`);

    const tagged = registry.resolveTag(name, "0.3.0");
    assert.ok(tagged, "a first publish must create the version tag");

    // The step announces `published <repo>@<digest>` using the value it captured
    // from the push. The tag must resolve to that same value.
    const reported = result.output.match(/published \S+@(sha256:[0-9a-f]{64})/)?.[1];
    assert.ok(reported, `expected the step to report a published digest\n${result.output}`);
    assert.equal(tagged, reported, "the tag must resolve to the digest the push reported");

    const signed = result.calls.filter((call) => call[0] === "cosign");
    assert.equal(signed.length, 1, "a publish signs exactly once");
    assert.ok(
      signed[0].some((arg) => arg.endsWith(`@${tagged}`)),
      `cosign must sign the published digest by digest, not by tag: ${signed[0].join(" ")}`,
    );
  });
});

test("the push that precedes the guard writes no tag", () => {
  // Why the ordering is achievable at all. The guard can only run before the
  // mutable write if the bytes can be written WITHOUT it — an untagged,
  // content-addressed push. If the workflow ever goes back to pushing directly
  // to `:VERSION`, the guard cannot be in front of it, so this pins the shape
  // rather than only the outcome.
  const shell = extractPushAndSign();
  const lines = shell.split("\n").filter((line) => !/^\s*#/.test(line));

  const pushLine = lines.findIndex((line) => /^\s*oras push\b/.test(line));
  assert.notEqual(pushLine, -1, "expected an `oras push`");
  assert.doesNotMatch(
    lines[pushLine],
    /oras push\s+"\$\{REPOSITORY\}:\$\{VERSION\}"/,
    "the push must not target the mutable version tag — the republication guard cannot precede it",
  );

  const lookupLine = lines.findIndex((line) => /oras manifest fetch --descriptor/.test(line));
  const tagLine = lines.findIndex((line) => /^\s*oras tag\b/.test(line));
  const refusalLine = lines.findIndex((line) => /refusing to redefine it/.test(line));

  assert.notEqual(lookupLine, -1, "expected the existing-digest lookup");
  assert.notEqual(tagLine, -1, "expected an explicit `oras tag` for the version");
  assert.notEqual(refusalLine, -1, "expected the refusal");

  assert.ok(
    lookupLine < refusalLine && refusalLine < tagLine,
    `the lookup and refusal must both precede the tag write ` +
      `(lookup ${lookupLine}, refusal ${refusalLine}, tag ${tagLine})`,
  );
});

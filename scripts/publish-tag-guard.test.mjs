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
// SUBSTITUTES, and what stays real. `oras`/`cosign`/`git` are small stand-ins
// on PATH and the stored registry state is a directory, but the REPUBLICATION
// LOOKUP is a real HTTP exchange: a loopback registry runs in its own process
// and the workflow's real `scripts/lookup-manifest.mjs` queries it, including
// the Bearer token handshake. That matters because the defect this suite now
// also covers is about WHICH REQUEST an answer came from, and a lookup that
// never makes a request cannot exhibit it. No Docker and nothing reachable
// off-box, so this still runs anywhere `node --test` does.
//
// What is NOT substituted is the thing under test: the shell body is extracted
// VERBATIM from the workflow file, so its sequencing, its classification and
// its refusal are the workflow's own. `cosign` never signs; it records that it
// was called, which is itself an assertion target (a refusal must not sign).

import { execFileSync, spawn } from "node:child_process";
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

  // The HTTP half. It serves `/v2/<name>/manifests/<tag>` and `/token` out of
  // the same directory the substitute client writes, so the lookup and the
  // stored state cannot disagree. It runs in its OWN PROCESS because the shell
  // under test is executed synchronously: a server in this process could not
  // answer a child this process is blocked waiting on.
  const serverSource = join(root, "registry-server.mjs");
  writeFileSync(serverSource, REGISTRY_SERVER);
  const server = spawnSync_detached(serverSource, root);

  return {
    root,
    url: server.url,
    host: server.host,
    /** Which manifest references the lookup actually asked the registry about. */
    manifestRequests() {
      const log = join(root, "manifest-requests.log");
      return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    },
    /** The independent read: it never asks the shell what it thinks it did. */
    resolveTag(name, tag) {
      const file = tagFile(name, tag);
      return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    },
    close: () => server.close(),
    manifestDir,
    tagDir,
  };
}

/**
 * The loopback registry, as source for a child process.
 *
 * It implements only the two endpoints the lookup touches, and it implements
 * the FAULTS as HTTP responses rather than as text — which is the whole point
 * of the new cases. The cases are:
 *
 *   token-404       the TOKEN endpoint 404s. The manifest is never asked about.
 *                   The pinned ORAS client renders this as `...404: Not Found`,
 *                   which is what the old stderr grep read as an absence.
 *   denied          HTTP 403 DENIED, carrying none of the trigger text.
 *   denied-notfound HTTP 403 DENIED whose message contains "not found".
 *   error-notfound  HTTP 500 UNKNOWN whose message contains "not found".
 *   timeout         the connection is accepted and never answered.
 *   html            HTTP 200 with an HTML body and no digest header.
 *
 * The harness selects one by writing `<root>/fault` before a run.
 *
 * The three message-bearing faults all carry the literal string the old
 * classifier matched, so a suite that passes with them is a suite in which
 * that string genuinely no longer decides anything.
 */
const REGISTRY_SERVER = String.raw`#!/usr/bin/env node
import { createServer } from "node:http";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
// Read per REQUEST, not at startup: one registry serves a healthy first publish
// and then the faulted attempt against it, which is what makes an overwrite
// visible. The file is written by the harness immediately before each run.
const faultFile = join(root, "fault");
const currentFault = () => (existsSync(faultFile) ? readFileSync(faultFile, "utf8").trim() : "");
const manifestFile = (digest) => join(root, "manifests", digest.replace(":", "_"));
const tagFile = (name, tag) => join(root, "tags", (name + ":" + tag).replace(/\//g, "__"));

const json = (res, status, body, headers = {}) => {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(payload);
};

// A distribution-spec error body. The message is free text, and these faults
// put "not found" in it deliberately: the classifier must read the code field,
// never the prose.
const distError = (code, message) => ({ errors: [{ code, message, detail: null }] });

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://" + req.headers.host);

  if (url.pathname === "/token") {
    if (currentFault() === "token-404") {
      // The reviewer's first counterexample. This endpoint knows nothing about
      // any manifest, and its 404 must never be read as one.
      return json(res, 404, distError("NOT_FOUND", "token service: realm not found"));
    }
    return json(res, 200, { token: "substitute-token" });
  }

  const match = url.pathname.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
  if (!match) return json(res, 404, distError("UNSUPPORTED", "no such endpoint"));

  // Record WHICH reference was asked about. The whole repair is that an answer
  // is attributable to one manifest request, so the test can assert on the
  // request rather than only on the outcome.
  appendFileSync(join(root, "manifest-requests.log"), url.pathname + "\n");

  const name = match[1];
  const tag = decodeURIComponent(match[2]);

  // Every real registry challenges first; the lookup's token handshake is
  // exercised on every single case, including the faults.
  if (!req.headers.authorization) {
    res.writeHead(401, {
      "www-authenticate": 'Bearer realm="http://' + req.headers.host + '/token",service="substitute",scope="repository:' + name + ':pull"',
      "content-type": "application/json",
    });
    return res.end(JSON.stringify(distError("UNAUTHORIZED", "authentication required")));
  }

  if (currentFault() === "denied") {
    // A plain denial, carrying none of the trigger text. The original control,
    // preserved: it must still refuse for the ordinary reason.
    return json(res, 403, distError("DENIED", "requested access to the resource is denied"));
  }
  if (currentFault() === "denied-notfound") {
    // 403 whose MESSAGE contains the old classifier's trigger string. The
    // status must win over the prose.
    return json(res, 403, distError("DENIED", "repository not found or access denied"));
  }
  if (currentFault() === "error-notfound") {
    return json(res, 500, distError("UNKNOWN", "backend error: upstream object not found"));
  }
  if (currentFault() === "html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<html><head><title>503 Service Unavailable</title></head></html>");
  }
  if (currentFault() === "timeout") {
    return; // accepted, never answered
  }

  const digest = existsSync(tagFile(name, tag)) ? readFileSync(tagFile(name, tag), "utf8").trim() : null;
  if (!digest || !existsSync(manifestFile(digest))) {
    // A genuine absence, stated the way the spec states it: a 404 carrying
    // MANIFEST_UNKNOWN. This is the ONLY shape that permits a first publish.
    return json(res, 404, distError("MANIFEST_UNKNOWN", "manifest unknown"));
  }

  const body = readFileSync(manifestFile(digest));
  res.writeHead(200, {
    "content-type": "application/vnd.oci.image.manifest.v1+json",
    "docker-content-digest": digest,
  });
  res.end(body);
});

server.listen(0, "127.0.0.1", () => {
  writeFileSync(join(root, "port"), String(server.address().port));
});
`;

/**
 * Start the registry server process and wait for it to publish its port.
 *
 * Port 0 plus a file handshake rather than a fixed port: these checks run
 * concurrently under `node --test` and a fixed port would make them collide.
 */
function spawnSync_detached(serverSource, root) {
  const child = spawn(process.execPath, [serverSource, root], { stdio: "ignore" });
  // Unreferenced so a server that somehow outlives its check cannot hold the
  // test runner's event loop open; `close()` below is still the intended exit.
  child.unref();

  const portFile = join(root, "port");
  const deadline = Date.now() + 10000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("the substitute registry did not start");
    }
    // Block this thread: the suite is synchronous by construction, so there is
    // no event loop turn in which an async wait could resolve.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  const port = readFileSync(portFile, "utf8").trim();

  return {
    host: `127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}`,
    close: () => child.kill(),
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

// NOTE: there is deliberately no "manifest fetch" verb. The republication
// lookup no longer goes through this client at all — it is lookup-manifest.mjs
// speaking HTTP to the loopback registry above. If the workflow ever regresses
// to asking the client and reading its stderr, it lands here and fails loudly
// instead of quietly classifying a client error as an absence.

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
function runPublish({ registry, dir, name, code, lookupFault = "" }) {
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

  // Arm the registry for THIS run. Written immediately before the shell starts
  // and read per request by the server, so a case can publish A healthily and
  // then attempt B under a fault against the very same registry.
  writeFileSync(join(registry.root, "fault"), lookupFault);

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
    // The REAL loopback host. The lookup resolves this over HTTP, so the host
    // has to be reachable; the substitute client still resolves by name against
    // the directory, which is how both halves see one registry.
    REPOSITORY: `${registry.host}/${name}`,
    // Loopback has no certificate. Publication is https; this is the only
    // concession the harness makes to running without one.
    LOOKUP_SCHEME: "http",
    // The loopback registry also challenges to a plaintext token realm on
    // itself, which the credential-destination policy refuses by default. This
    // is the named hook that permits it, and it permits it only for a loopback
    // host. A real publish never sets it, so the policy that protects the
    // registry credential is not weakened by the existence of these checks.
    LOOKUP_ALLOW_INSECURE_TOKEN_REALM: "1",
    // Keeps the never-answered case cheap; it changes only how long the
    // unknown takes to be reached, never which outcome is reached.
    LOOKUP_TIMEOUT_MS: "1500",
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
    // Stop the server FIRST. It is a child process holding a listening socket,
    // and leaving it alive outlives the check that started it.
    registry.close();
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

// THE UNKNOWN LOOKUP. One check per way the lookup can fail to establish an
// absence, separate tests rather than a loop because each models a different
// real failure and each must be able to fail on its own.
//
// The property is the same in all of them, and it is a REGISTRY-STATE property,
// not an exit-code one: a released version A must still be A afterwards. A
// revision that exits 1 after tagging satisfies a status assertion and destroys
// the release — that is the shape of the defect this whole file exists for, and
// the reason the tag read below is the first assertion and not an afterthought.
//
// Each runs a real first publish to establish A, then a DIFFERENT candidate B
// under the fault. Different bytes matter: if the guard fails open, B replaces
// A and the tag read shows it. With identical bytes an overwrite would be
// invisible, and the check would pass for the wrong reason.
//
// THE LAST THREE ARE THE NEW ONES, and they are the reason the lookup stopped
// reading stderr prose. Every one of them carries the literal text `not found`
// in a message the registry supplies, or produces the client rendering
// `404: Not Found`, and every one of them is a response that says NOTHING about
// whether this manifest exists. Under the previous classifier all three read as
// a confirmed absence and authorised moving a released version tag onto new
// bytes and signing them. They are HTTP responses here, not injected strings,
// so what is being tested is the classification of a real exchange.
for (const { fault, label, expected } of [
  {
    fault: "timeout",
    label: "a lookup that times out",
    // Must name the outcome, not just fail. An operator reading the log has to
    // be able to tell "the registry says this version is taken" from "the
    // registry did not answer", because the two need different responses.
    expected: /UNKNOWN/,
  },
  {
    fault: "denied",
    label: "a lookup the registry denies outright",
    expected: /UNKNOWN/,
  },
  {
    fault: "html",
    label: "a lookup answered with HTML where a manifest was promised",
    expected: /UNKNOWN/,
  },
  {
    fault: "token-404",
    label: "a 404 from the TOKEN endpoint, which never asked about the manifest",
    // The reviewer's counterexample. The pinned ORAS client renders this as
    // `response status code 404: Not Found`; the old classifier matched it and
    // republished. Absence must come from the manifest endpoint or not at all.
    expected: /UNKNOWN/,
  },
  {
    fault: "denied-notfound",
    label: "an HTTP 403 DENIED whose message happens to contain \"not found\"",
    // Status beats prose. A registry that will not say is not a registry
    // saying no.
    expected: /UNKNOWN/,
  },
  {
    fault: "error-notfound",
    label: "an HTTP 500 UNKNOWN whose message happens to contain \"not found\"",
    expected: /UNKNOWN/,
  },
]) {
  test(`${label} refuses before the version tag moves`, () => {
    withRegistry(({ registry, dir }) => {
      const name = "connector/ynab";

      const released = runPublish({ registry, dir, name, code: "CODE-A-RELEASED" });
      assert.equal(released.status, 0, `the first publish should succeed\n${released.output}`);
      const digestA = registry.resolveTag(name, "0.3.0");
      assert.ok(digestA, "the first publish must leave the version tag resolvable");

      const unknown = runPublish({
        registry, dir, name, code: "CODE-B-DIFFERENT", lookupFault: fault,
      });

      // FIRST, and deliberately: what does the registry hold? Before the defect
      // was repaired this read returned B's digest — the released version had
      // been redefined, by a run that reported success.
      assert.equal(
        registry.resolveTag(name, "0.3.0"),
        digestA,
        `an unknown lookup (${fault}) must leave the released version tag on its published ` +
          `digest — mapping "I could not find out" to "nothing is there" republishes over a release`,
      );

      assert.equal(
        unknown.status,
        1,
        `an unknown lookup (${fault}) must exit non-zero\n${unknown.output}`,
      );
      assert.match(
        unknown.output,
        expected,
        `the refusal must say the existing state is unknown rather than reporting a conflict it did not observe\n${unknown.output}`,
      );

      // No mutable write by any route, and nothing signed. A signature over
      // bytes the workflow was not entitled to publish is the durable half of
      // this defect: the tag can be repointed, a Rekor entry cannot be unlogged.
      assert.deepEqual(
        unknown.calls.filter((call) => call[0] === "tag"),
        [],
        `an unknown lookup (${fault}) must not reach the tag write`,
      );
      assert.deepEqual(
        unknown.calls.filter((call) => call[0] === "cosign"),
        [],
        `an unknown lookup (${fault}) must not sign`,
      );
    });
  });
}

test("a confirmed-absent lookup still publishes, and is observed as absent rather than as silence", () => {
  // The other side of the repair, and the one that keeps it from being "refuse
  // everything". A first release has to go out, and the ONLY thing separating
  // it from the three refusals above is that the registry gave a definite "not
  // found" — so this pins that the classification reads the answer rather than
  // treating any unproductive lookup as permission.
  withRegistry(({ registry, dir }) => {
    const name = "connector/ynab";
    const result = runPublish({ registry, dir, name, code: "CODE-FIRST" });

    assert.equal(result.status, 0, `a confirmed-absent version must publish\n${result.output}`);

    // Asked about THE reference, at the manifest endpoint. Under the challenge
    // handshake the unauthenticated probe and the authenticated retry are both
    // recorded, and both must name the same reference — an answer about any
    // other reference is not an answer about this version.
    const requested = registry.manifestRequests();
    assert.ok(requested.length > 0, "the guard must consult the registry's manifest endpoint");
    assert.deepEqual(
      [...new Set(requested)],
      [`/v2/${name}/manifests/0.3.0`],
      "the lookup must ask about exactly the reference it is about to publish",
    );

    const tagged = registry.resolveTag(name, "0.3.0");
    assert.ok(tagged, "a confirmed-absent publish must create the version tag");
    assert.ok(
      result.calls.some((call) => call[0] === "cosign" && call.some((a) => a.endsWith(`@${tagged}`))),
      "a confirmed-absent publish signs the digest it tagged",
    );
  });
});

test("absence is decided by the typed lookup, never by matching error prose", () => {
  // A shape check, kept deliberately narrow. The registry-state checks above are
  // the real evidence; this one exists because BOTH defects in this guard's
  // history were shell idioms that a substitute can happen not to model.
  //
  // The first was `|| true` plus a swallowing `catch`, which mapped every
  // failure onto the same empty value a genuine absence produced. The second was
  // the repair for it: a `grep` over the client's stderr, which let an error
  // from a DIFFERENT request authorise a republication because the text happened
  // to contain "not found". Both are pinned out here, because both can be
  // reintroduced in a form that still passes every fault the harness models.
  const shell = extractPushAndSign();
  const lines = shell.split("\n").filter((line) => !/^\s*#/.test(line));
  const code = lines.join("\n");

  const lookupLine = lines.findIndex((line) => /lookup-manifest\.mjs/.test(line));
  assert.notEqual(lookupLine, -1, "expected the typed manifest lookup");

  assert.doesNotMatch(
    code,
    /\|\|\s*true/,
    "the lookup must not discard its exit status with `|| true` — that is what mapped " +
      "a timed-out or denied lookup onto the same empty result as a genuinely absent version",
  );
  assert.doesNotMatch(
    code,
    /2>\s*\/dev\/null/,
    "the lookup must not discard its stderr",
  );
  assert.doesNotMatch(
    code,
    /catch\s*\{\s*\}/,
    "an empty catch around the descriptor parse turns malformed output into an absent version",
  );

  // THE new pin. No branch of this step may reach a publish decision by matching
  // text against the client's output. Absence is a typed outcome attributable to
  // one manifest request, or it is not an absence.
  assert.doesNotMatch(
    code,
    /grep[^\n]*(not found|NAME_UNKNOWN|MANIFEST_UNKNOWN)/i,
    "absence must not be classified by grepping error text — an error from the token " +
      "endpoint, a 403 or a 500 can all carry that wording while saying nothing about " +
      "whether this manifest exists",
  );
  assert.doesNotMatch(
    code,
    /^\s*(elif|if)\b[^\n]*\bgrep\b/m,
    "no publish decision may branch on a grep over the lookup's output",
  );

  // And the outcome the step acts on must be the typed one, read from the
  // lookup's structured result rather than reconstructed from prose.
  assert.match(
    code,
    /LOOKUP_OUTCOME[^\n]*outcome/,
    "the step must read the lookup's typed outcome",
  );
  assert.match(
    code,
    /"\$LOOKUP_OUTCOME"\s*!=\s*present[\s\S]*"\$LOOKUP_OUTCOME"\s*!=\s*absent/,
    "anything that is not exactly present or absent must be refused",
  );
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

  const lookupLine = lines.findIndex((line) => /lookup-manifest\.mjs/.test(line));
  const tagLine = lines.findIndex((line) => /^\s*oras tag\b/.test(line));
  const refusalLine = lines.findIndex((line) => /refusing to redefine it/.test(line));

  assert.notEqual(lookupLine, -1, "expected the typed manifest lookup");
  assert.notEqual(tagLine, -1, "expected an explicit `oras tag` for the version");
  assert.notEqual(refusalLine, -1, "expected the refusal");

  assert.ok(
    lookupLine < refusalLine && refusalLine < tagLine,
    `the lookup and refusal must both precede the tag write ` +
      `(lookup ${lookupLine}, refusal ${refusalLine}, tag ${tagLine})`,
  );

  // AND the signature precedes the tag. Both act on the same captured digest,
  // so this costs nothing and it decides what an interrupted run leaves behind:
  // signing first, an interruption leaves an unreferenced signed manifest that
  // nothing resolves by name; tagging first, it leaves a resolvable version on
  // unsigned bytes, which a consumer can install and cannot verify.
  const signLine = lines.findIndex((line) => /^\s*cosign sign\b/.test(line));
  assert.notEqual(signLine, -1, "expected the publish to sign");
  assert.ok(
    signLine < tagLine,
    `the signature must precede the version tag (sign ${signLine}, tag ${tagLine})`,
  );
});

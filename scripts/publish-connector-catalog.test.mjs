// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = join(repoRoot, ".github", "workflows", "publish-polyfill-connectors.yml");
const workflow = readFileSync(workflowPath, "utf8");
const catalogDigest = `sha256:${"a".repeat(64)}`;
const previousCatalogDigest = `sha256:${"b".repeat(64)}`;

// A named step of the publish workflow: its `if`, its run script (block or
// single line) and its raw text, so tests can execute the real shell.
function extractStep(name) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `expected workflow step '${name}'`);
  let end = start + 1;
  while (end < lines.length && !/^ {6}- |^ {2}\S/.test(lines[end])) end += 1;
  const section = lines.slice(start, end);

  const ifLine = section.find((line) => /^        if: /.test(line));
  const runIndex = section.findIndex((line) => /^        run: /.test(line));
  assert.notEqual(runIndex, -1, `workflow step '${name}' has no run`);
  let shell;
  if (section[runIndex] === "        run: |") {
    const body = [];
    for (const line of section.slice(runIndex + 1)) {
      if (line.trim() === "") body.push("");
      else if (/^ {10}/.test(line)) body.push(line.slice(10));
      else break;
    }
    shell = body.join("\n");
  } else {
    shell = section[runIndex].replace(/^        run: /, "");
  }
  return {
    condition: ifLine?.replace(/^ *if: /, "") ?? "",
    shell,
    text: section.join("\n"),
  };
}

function extractCatalogPublishStep() {
  return extractStep("Publish and verify the connector catalog");
}

function writeCommand(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

// REAL_GENERATOR=1 runs scripts/generate-connector-catalog.mjs from `cwd`
// instead of the stub, so a test can observe the generator's own refusal.
function runCatalogPublish(overrides = {}, { cwd = repoRoot, shell } = {}) {
  shell ??= `${extractStep("Reconcile the connector catalog").shell}\n` +
    `if grep -qx 'changed=true' "$GITHUB_OUTPUT"; then\n${extractCatalogPublishStep().shell}\nfi`;
  const root = mkdtempSync(join(tmpdir(), "connector-catalog-publish-"));
  const bin = join(root, "bin");
  const runnerTemp = join(root, "runner-temp");
  const commandLog = join(root, "commands.log");
  const tagPointer = join(root, "latest-tag");
  mkdirSync(bin);
  mkdirSync(runnerTemp);
  writeFileSync(tagPointer, previousCatalogDigest);

  writeCommand(
    join(bin, "node"),
    `#!/bin/bash
set -u
printf 'node\t%s\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = "scripts/lookup-manifest.mjs" ] || [ "\${1:-}" = "$GITHUB_WORKSPACE/scripts/lookup-manifest.mjs" ]; then
  outcome="\${LOOKUP_OUTCOME:-absent}"
  if [ -e "$LOOKUP_CALLED" ]; then outcome="\${LOOKUP_SECOND_OUTCOME:-$outcome}"; fi
  touch "$LOOKUP_CALLED"
  case "$outcome" in
    absent) printf '%s\n' '{"outcome":"absent"}' ;;
    present) printf '%s\n' '{"outcome":"present","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' ;;
    unknown) printf '%s\n' '{"outcome":"unknown"}' ;;
    *) exit 40 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "scripts/generate-connector-catalog.mjs" ] && [ "\${REAL_GENERATOR:-}" != "1" ]; then
  if [ "\${FAIL_COMMAND:-}" = "generate" ]; then exit 41; fi
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--out" ]; then
      mkdir -p "$(dirname "$2")"
      if [ "\${SAME_CONTENT:-}" = "1" ]; then
        cp "$RUNNER_TEMP/connector-catalog/previous/catalog.json" "$2"
      else
        printf '{"connectors":[]}' > "$2"
      fi
      exit 0
    fi
    shift
  done
  exit 42
fi
if [ "\${1:-}" = "scripts/verify-catalog-additions.mjs" ]; then
  if [ "\${FAIL_COMMAND:-}" = "additions-verify" ]; then exit 52; fi
  exit 0
fi
exec "$REAL_NODE" "$@"
`,
  );
  writeCommand(
    join(bin, "git"),
    `#!/bin/bash
set -u
printf 'git\t%s\n' "$*" >> "$COMMAND_LOG"
if [ "\${FAIL_COMMAND:-}" = "git" ]; then exit 43; fi
if [ "\${1:-}" = "merge-base" ]; then
  if [ "\${FAIL_COMMAND:-}" = "stale-source" ]; then exit 1; fi
  exit 0
fi
if [ "\${1:-}" = "diff" ]; then
  printf '%s' "\${POLICY_DIFF:-}"
  exit 0
fi
printf '%s\n' '2026-09-15T12:34:56-05:00'
`,
  );
  writeCommand(
    join(bin, "oras"),
    `#!/bin/bash
set -u
printf 'oras\t%s\n' "$*" >> "$COMMAND_LOG"
if [ "\${1:-}" = "login" ]; then
  if [ "\${FAIL_COMMAND:-}" = "login" ]; then exit 44; fi
  cat >/dev/null
  exit 0
fi
if [ "\${1:-}" = "push" ]; then
  if [ "\${FAIL_COMMAND:-}" = "push" ]; then exit 45; fi
  if [ -n "\${PUSH_RESULT:-}" ]; then
    printf '%s\n' "$PUSH_RESULT"
  else
    printf '%s\n' '{"digest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
  fi
  exit 0
fi
if [ "\${1:-}" = "pull" ]; then
  if [ "\${FAIL_COMMAND:-}" = "pull" ]; then exit 49; fi
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output" ]; then
      mkdir -p "$2"
      if [ "\${MALFORMED_PREVIOUS:-}" = "1" ]; then
        printf '{"source_commit":"bad","connectors":[]}' > "$2/catalog.json"
      else
        printf '{"source_commit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","connectors":[]}' > "$2/catalog.json"
      fi
      exit 0
    fi
    shift
  done
  exit 50
fi
if [ "\${1:-}" = "tag" ]; then
  printf '%s\n' "\${2#*@}" > "$TAG_POINTER"
  exit 0
fi
exit 46
`,
  );
  writeCommand(
    join(bin, "cosign"),
    `#!/bin/bash
set -u
printf 'cosign\t%s\n' "$*" >> "$COMMAND_LOG"
if [ "\${FAIL_COMMAND:-}" = "previous-verify" ] &&
   [ "\${1:-}" = "verify" ] && [[ "$*" == *"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"* ]]; then
  exit 51
fi
if [ "\${FAIL_COMMAND:-}" = "\${1:-}" ]; then exit 47; fi
case "\${1:-}" in sign|verify) exit 0 ;; *) exit 48 ;; esac
`,
  );

  const result = spawnSync("bash", ["-c", shell], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      COMMAND_LOG: commandLog,
      TAG_POINTER: tagPointer,
      RUNNER_TEMP: runnerTemp,
      GITHUB_WORKSPACE: cwd,
      GITHUB_OUTPUT: join(root, "github-output"),
      LOOKUP_CALLED: join(root, "lookup-called"),
      GH_TOKEN: "fixture-token",
      GITHUB_ACTOR: "fixture-actor",
      GITHUB_REPOSITORY: "PDP-Connect/data-connectors",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      ...overrides,
    },
  });

  const commands = readFileSync(commandLog, "utf8").trim().split("\n").filter(Boolean);
  return {
    commands,
    result,
    tagDigest: () => (existsSync(tagPointer) ? readFileSync(tagPointer, "utf8").trim() : null),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the catalog is generated, pushed with its media type, then signs and verifies the pushed digest", () => {
  const run = runCatalogPublish();
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.ok(
      run.commands.includes(
        "node\tscripts/lookup-manifest.mjs --reference ghcr.io/pdp-connect/connector-catalog:latest",
      ),
      "the workflow must check for a prior catalog before generating",
    );

    const generateIndex = run.commands.findIndex((line) =>
      line.startsWith("node\tscripts/generate-connector-catalog.mjs "),
    );
    const pushIndex = run.commands.findIndex((line) => line.startsWith("oras\tpush "));
    assert.notEqual(generateIndex, -1, "expected the catalog generator to run");
    assert.notEqual(pushIndex, -1, "expected the catalog push to run");
    assert.ok(generateIndex < pushIndex, "the catalog must be generated before it is pushed");
    assert.doesNotMatch(
      run.commands[generateIndex],
      /--previous-catalog/,
      "a first publish must not claim a previous catalog",
    );
    assert.ok(
      run.commands.includes("git\tshow -s --format=%cI 0123456789abcdef0123456789abcdef01234567"),
      "the catalog timestamp must come from the source commit",
    );
    assert.ok(
      run.commands.includes("oras\tlogin ghcr.io --username fixture-actor --password-stdin"),
      "the publish must authenticate to the catalog registry",
    );

    const push = run.commands[pushIndex];
    assert.match(push, /^oras\tpush ghcr\.io\/pdp-connect\/connector-catalog /);
    assert.doesNotMatch(
      push,
      /connector-catalog:latest/,
      "the push must not move the public tag before signing and verification",
    );
    assert.match(push, /--artifact-type application\/vnd\.pdpp\.connector-catalog\.v1\+json/);
    assert.match(push, /catalog\.json:application\/vnd\.pdpp\.connector-catalog\.v1\+json/);
    assert.match(push, /--format json/);

    const sign = run.commands.find((line) => line.startsWith("cosign\tsign "));
    const verify = run.commands.find((line) => line.startsWith("cosign\tverify "));
    const signIndex = run.commands.findIndex((line) => line === sign);
    const verifyIndex = run.commands.findIndex((line) => line === verify);
    const tagIndex = run.commands.findIndex((line) => line.startsWith("oras\ttag "));
    const digestReference = `ghcr.io/pdp-connect/connector-catalog@${catalogDigest}`;
    assert.match(sign ?? "", new RegExp(`^cosign\\tsign --yes ${digestReference}$`));
    assert.match(verify ?? "", new RegExp(`^cosign\\tverify ${digestReference} `));
    assert.match(
      verify ?? "",
      /--certificate-identity https:\/\/github\.com\/PDP-Connect\/data-connectors\/\.github\/workflows\/publish-polyfill-connectors\.yml@refs\/heads\/main/,
    );
    assert.match(
      verify ?? "",
      /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com$/,
    );
    assert.equal(
      run.commands[tagIndex],
      `oras\ttag ${digestReference} latest`,
      "latest must move to the digest returned by the untagged push",
    );
    assert.ok(
      pushIndex < signIndex && signIndex < verifyIndex && verifyIndex < tagIndex,
      "the untagged push must be signed and verified before latest moves",
    );
    assert.equal(run.tagDigest(), catalogDigest, "the successful publish must move latest");
    assert.equal(
      run.commands.some((line) => /^oras\t(resolve|manifest fetch)\b/.test(line)),
      false,
      "signing and verification must use the push result without resolving the mutable tag",
    );
  } finally {
    run.cleanup();
  }
});

test("a verified prior catalog is pulled by digest and passed to the generator", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present" });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);

    const priorReference = `ghcr.io/pdp-connect/connector-catalog@${previousCatalogDigest}`;
    const priorVerify = run.commands.findIndex((line) =>
      line.startsWith(`cosign\tverify ${priorReference} `),
    );
    const pull = run.commands.findIndex((line) => line.startsWith(`oras\tpull ${priorReference} `));
    const generate = run.commands.findIndex((line) =>
      line.startsWith("node\tscripts/generate-connector-catalog.mjs "),
    );
    const ancestry = run.commands.findIndex((line) => line.startsWith("git\tmerge-base --is-ancestor "));
    const push = run.commands.findIndex((line) => line.startsWith("oras\tpush "));

    assert.notEqual(priorVerify, -1, "the previous catalog digest must be verified");
    assert.equal(
      run.commands[priorVerify],
      `cosign\tverify ${priorReference} ` +
        "--certificate-identity https://github.com/PDP-Connect/data-connectors/.github/workflows/publish-polyfill-connectors.yml@refs/heads/main " +
        "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
      "the prior catalog must carry the exact trusted main-branch workflow identity",
    );
    assert.notEqual(pull, -1, "the verified previous catalog must be pulled by digest");
    assert.match(
      run.commands[pull],
      /--output \/.*\/runner-temp\/connector-catalog\/previous$/,
    );
    assert.notEqual(generate, -1, "the generator must run after retrieving the prior catalog");
    assert.match(
      run.commands[generate],
      /--previous-catalog \/.*\/runner-temp\/connector-catalog\/previous\/catalog\.json$/,
    );
    assert.notEqual(push, -1, "the updated catalog must be pushed");
    assert.ok(
      priorVerify < pull && pull < ancestry && ancestry < generate && generate < push,
      "the prior catalog must be verified, pulled and checked before publication",
    );
  } finally {
    run.cleanup();
  }
});

test("a queued older source cannot replace the latest catalog", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", FAIL_COMMAND: "stale-source" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stdout + run.result.stderr, /previous catalog source is not an ancestor/);
    assert.equal(run.commands.some((line) => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")), false);
    assert.equal(run.commands.some((line) => line.startsWith("oras\ttag ")), false);
    assert.equal(run.tagDigest(), previousCatalogDigest);
  } finally {
    run.cleanup();
  }
});

test("a previous catalog without a valid source commit cannot move latest", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", MALFORMED_PREVIOUS: "1" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.equal(run.commands.some((line) => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")), false);
    assert.equal(run.commands.some((line) => line.startsWith("oras\ttag ")), false);
    assert.equal(run.tagDigest(), previousCatalogDigest);
  } finally {
    run.cleanup();
  }
});

test("unchanged reconciliation does not push, sign, or move the catalog tag", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", SAME_CONTENT: "1" });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.ok(run.commands.some(line => line.startsWith("node\tscripts/verify-catalog-additions.mjs ")));
    assert.doesNotMatch(run.commands.find(line => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")), /--refresh-metadata/);
    assert.equal(run.commands.some(line => line.startsWith("oras\tpush ")), false);
    assert.equal(run.commands.some(line => line.startsWith("oras\ttag ")), false);
    assert.equal(run.tagDigest(), previousCatalogDigest);
  } finally { run.cleanup(); }
});

test("a policy change since the last catalog forces metadata refresh", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", POLICY_DIFF: "scripts/generate-connector-catalog.mjs" });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.commands.find(line => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")), /--refresh-metadata true/);
    assert.equal(run.tagDigest(), catalogDigest);
  } finally { run.cleanup(); }
});

test("manual reconciliation re-reads published metadata", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", GITHUB_EVENT_NAME: "workflow_dispatch" });
  try {
    assert.equal(run.result.status, 0, run.result.stderr);
    assert.match(run.commands.find(line => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")), /--refresh-metadata true/);
  } finally { run.cleanup(); }
});

test("failed addition verification keeps the previous catalog tag", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", FAIL_COMMAND: "additions-verify" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.equal(run.commands.some(line => line.startsWith("oras\tpush ")), false);
    assert.equal(run.commands.some(line => line.startsWith("oras\ttag ")), false);
    assert.equal(run.tagDigest(), previousCatalogDigest);
  } finally { run.cleanup(); }
});

test("a changed or unknown latest at publication cannot move the catalog tag", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "present", LOOKUP_SECOND_OUTCOME: "unknown" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stderr, /catalog latest changed or became unknown/);
    assert.equal(run.commands.some(line => line.startsWith("oras\ttag ")), false);
    assert.equal(run.tagDigest(), previousCatalogDigest);
  } finally { run.cleanup(); }
});

test("an unknown prior-catalog lookup aborts before generation or publication", () => {
  const run = runCatalogPublish({ LOOKUP_OUTCOME: "unknown" });
  try {
    assert.notEqual(run.result.status, 0);
    assert.match(run.result.stdout + run.result.stderr, /previous catalog lookup is unknown/);
    assert.equal(
      run.commands.some((line) => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")),
      false,
    );
    assert.equal(run.commands.some((line) => line.startsWith("oras\tpush ")), false);
    assert.equal(run.commands.some((line) => line.startsWith("oras\ttag ")), false);
    assert.equal(run.tagDigest(), previousCatalogDigest);
  } finally {
    run.cleanup();
  }
});

for (const priorFailure of [
  { label: "signature verification", command: "previous-verify" },
  { label: "pull", command: "pull" },
]) {
  test(`a prior catalog ${priorFailure.label} failure aborts before generation or publication`, () => {
    const run = runCatalogPublish({
      LOOKUP_OUTCOME: "present",
      FAIL_COMMAND: priorFailure.command,
    });
    try {
      assert.notEqual(run.result.status, 0);
      assert.equal(
        run.commands.some((line) => line.startsWith("node\tscripts/generate-connector-catalog.mjs ")),
        false,
      );
      assert.equal(run.commands.some((line) => line.startsWith("oras\tpush ")), false);
      assert.equal(run.commands.some((line) => line.startsWith("oras\ttag ")), false);
      assert.equal(run.tagDigest(), previousCatalogDigest);
    } finally {
      run.cleanup();
    }
  });
}

for (const failure of [
  { label: "generator", env: { FAIL_COMMAND: "generate" } },
  { label: "push", env: { FAIL_COMMAND: "push" } },
  { label: "malformed push digest", env: { PUSH_RESULT: '{"digest":"latest"}' } },
  { label: "sign", env: { FAIL_COMMAND: "sign" } },
  { label: "verify", env: { FAIL_COMMAND: "verify" } },
]) {
  test(`${failure.label} failure fails the catalog publish step`, () => {
    const run = runCatalogPublish(failure.env);
    try {
      assert.notEqual(run.result.status, 0, "the workflow shell must propagate the failure");
      assert.equal(
        run.commands.some((line) => line.startsWith("oras\ttag ")),
        false,
        "a failed publish transaction must not move latest",
      );
      assert.equal(
        run.tagDigest(),
        previousCatalogDigest,
        "a failed publish transaction must preserve the prior latest digest",
      );
    } finally {
      run.cleanup();
    }
  });
}

test("catalog reconciliation follows main release events and publication only runs for changes", () => {
  const { condition } = extractCatalogPublishStep();
  assert.match(condition, /!inputs\.dry-run/);
  assert.match(condition, /steps\.reconcile\.outputs\.changed\s*==\s*'true'/);

  const catalog = workflow.match(/\n  catalog:\n([\s\S]*)$/)?.[1];
  assert.ok(catalog, "expected the catalog fan-in job");
  assert.match(catalog, /^    needs: \[prepare, publish\]$/m);
  assert.match(catalog, /^    if: .*always\(\)/m);
  assert.match(catalog, /!cancelled\(\)/);
  assert.match(catalog, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.equal(
    workflow.match(/^      - name: Publish and verify the connector catalog$/gm)?.length,
    1,
    "the catalog path must exist once, outside the connector matrix",
  );
});

test("all publishes remain serialized by one workflow-wide concurrency group", () => {
  assert.equal(
    workflow.match(/^concurrency:\s*$/gm)?.length ?? 0,
    1,
    "expected exactly one top-level concurrency policy",
  );
  assert.match(workflow, /^  group:\s*publish-polyfill-connectors\s*$/m);
  assert.match(workflow, /^  cancel-in-progress:\s*false\s*$/m);
});

function evaluateCondition(expression, { catalogOnly, dryRun = false, selected = false, changed = true, cancelled = false, ref = "refs/heads/main", needs = {} }) {
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("inputs.catalog-only", "inputs['catalog-only']")
    .replaceAll("inputs.dry-run", "inputs['dry-run']")
    .replace(/needs\.(\w+)\.outputs\.([a-z-]+)/g, "needs.$1.outputs['$2']");
  return Function("inputs", "steps", "github", "needs", "always", "cancelled", `return (${source});`)(
    { "catalog-only": catalogOnly, "dry-run": dryRun },
    { target: { outputs: { selected: selected ? "true" : "false" } }, reconcile: { outputs: { changed: changed ? "true" : "false" } } },
    { ref },
    needs,
    () => true,
    () => cancelled,
  );
}

function stepCondition(name) {
  const section = workflow.split(`      - name: ${name}\n`)[1]?.split("\n      - ")[0];
  assert.ok(section, `missing workflow step ${name}`);
  return section.match(/^        if: (.+)$/m)?.[1] ?? "true";
}

test("catalog-only dispatch skips connector selection and publication but runs catalog tools", () => {
  const catalogOnly = { catalogOnly: true };
  for (const name of [
    "Select the connector and version this run publishes",
    "Build the artifact layers",
    "Prove the built bundle imports before publishing it",
    "Push and sign",
  ]) {
    assert.equal(evaluateCondition(stepCondition(name), catalogOnly), false, name);
  }
  for (const name of ["Install dependencies", "Install ORAS", "Install Cosign", "Publish and verify the connector catalog"]) {
    assert.equal(evaluateCondition(stepCondition(name), catalogOnly), true, name);
  }
  const condition = stepCondition("Publish and verify the connector catalog");
  assert.equal(evaluateCondition(condition, { ...catalogOnly, dryRun: true }), false);
  assert.equal(evaluateCondition(condition, { ...catalogOnly, dryRun: false }), true);
  assert.equal(
    evaluateCondition(condition, { ...catalogOnly, dryRun: false, ref: "refs/heads/feature" }),
    false,
  );
  assert.equal(
    evaluateCondition(condition, { ...catalogOnly, dryRun: false, ref: "refs/tags/connector-ynab-v0.3.0" }),
    false,
  );
  const catalog = workflow.match(/\n  catalog:\n([\s\S]*)$/)?.[1] ?? "";
  assert.match(catalog, /github\.ref\s*==\s*'refs\/heads\/main'/);
});

test("the publish matrix consumes the prepared selection and catalog has no matrix", () => {
  const expression = workflow.match(/^      matrix: \$\{\{ (fromJSON\(.+\)) \}\}$/m)?.[1];
  assert.ok(expression);
  const matrix = { include: [{ connector: "ynab" }, { connector: "github" }] };
  const evaluate = Function("inputs", "needs", "fromJSON", `return (${expression.replaceAll("inputs.catalog-only", "inputs['catalog-only']")});`);
  const needs = { prepare: { outputs: { matrix: JSON.stringify(matrix) } } };
  assert.deepEqual(evaluate({ "catalog-only": false }, needs, JSON.parse), matrix);
  assert.doesNotMatch(
    workflow.match(/\n  catalog:\n([\s\S]*)$/)?.[1] ?? "",
    /^      matrix:/m,
    "the catalog fan-in must run once, not as a connector matrix",
  );
});

const PREPARE_GUARD_STEP = "Validate publish inventory identities and exclusions";

function catalogJobCondition() {
  const catalog = workflow.match(/\n  catalog:\n([\s\S]*)$/)?.[1];
  assert.ok(catalog, "expected the catalog fan-in job");
  const condition = catalog.match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition, "expected the catalog job to carry an if condition");
  return condition;
}

function catalogScheduled({
  ref = "refs/heads/main",
  dryRun = false,
  publish = "skipped",
  hasPublishableChanges = "false",
  prepare = "success",
  cancelled = false,
} = {}) {
  return evaluateCondition(catalogJobCondition(), {
    dryRun,
    cancelled,
    ref,
    needs: {
      prepare: {
        result: prepare,
        outputs: { "has-publishable-changes": hasPublishableChanges },
      },
      publish: { result: publish },
    },
  });
}

test("a policy-only main push schedules reconciliation without publishing a connector", () => {
  assert.equal(catalogScheduled(), true);
});

test("a failed publish can be reconciled, but a cancelled workflow cannot", () => {
  assert.equal(catalogScheduled({ publish: "failure", hasPublishableChanges: "true" }), true);
  assert.equal(catalogScheduled({ publish: "failure", cancelled: true }), false);
});

test("an otherwise unchanged main push still checks for missed catalog releases", () => {
  assert.equal(catalogScheduled({}), true);
});

test("an artifact publish still schedules the catalog, and only main ever does", () => {
  assert.equal(catalogScheduled({ publish: "success", hasPublishableChanges: "true" }), true);
  assert.equal(catalogScheduled({ ref: "refs/tags/connector-ynab-v0.3.0" }), false);
  assert.equal(catalogScheduled({ publish: "success", hasPublishableChanges: "true", ref: "refs/heads/feature" }), false);
  assert.equal(catalogScheduled({ dryRun: true }), false);
});

test("policy changes are detected since the last published catalog, including after an unrelated push", () => {
  const step = extractStep("Reconcile the connector catalog");
  const policyDiff = step.shell.match(/CHANGED="\$\(git diff[\s\S]*?\)"/)?.[0];
  assert.ok(policyDiff, "expected the workflow's policy diff");

  const repo = mkdtempSync(join(tmpdir(), "catalog-policy-"));
  try {
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout.trim();
    };
    git("init", "-q");
    git("config", "user.name", "fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(repo, "scripts"));
    writeFileSync(join(repo, "scripts", "connector-publish-allowlist.mjs"), "export const v = 1;\n");
    writeFileSync(join(repo, "README.md"), "one\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "two\n");
    git("commit", "-q", "-am", "docs only");
    const docsOnly = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "scripts", "connector-publish-allowlist.mjs"), "export const v = 2;\n");
    git("commit", "-q", "-am", "policy edit");
    const policyEdit = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "README.md"), "three\n");
    git("commit", "-q", "-am", "unrelated follow-up");
    const followUp = git("rev-parse", "HEAD");

    const run = (previous, current) => {
      const result = spawnSync("bash", ["-c", `set -euo pipefail\n${policyDiff}\nprintf '%s' "$CHANGED"`], {
        cwd: repo,
        encoding: "utf8",
        env: { PATH: process.env.PATH, PREVIOUS_SOURCE: previous, GITHUB_SHA: current },
      });
      return result;
    };

    const unchanged = run(base, docsOnly);
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(unchanged.stdout, "");

    const changed = run(base, followUp);
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(changed.stdout, "scripts/connector-publish-allowlist.mjs");
    assert.equal(run(policyEdit, followUp).stdout, "", "the last-push range alone would miss the policy edit");
    assert.notEqual(run("f".repeat(40), followUp).status, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the prepare job pins Node 24 and runs the inventory guard before selection", () => {
  const prepare = workflow.match(/\n  prepare:\n([\s\S]*?)\n  publish:\n/)?.[1];
  assert.ok(prepare, "expected the prepare job");
  const position = (text) => {
    const index = prepare.indexOf(text);
    assert.notEqual(index, -1, `prepare job must contain ${text}`);
    return index;
  };
  const nodeSetup = position("uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0");
  const guard = position(`- name: ${PREPARE_GUARD_STEP}`);
  assert.match(prepare.slice(nodeSetup, guard), /node-version: "24"/);
  assert.ok(guard > nodeSetup, "Node 24 must be set up before the guard runs");
  assert.ok(guard < position("- name: Derive the publish matrix from the reviewed allowlist"));
  assert.ok(guard < position("- name: Select connector versions missing from GHCR"));
});

// A copy of the publish scripts for tests that must exercise the real guard
// and generator. Republishing Loom reproduces the pre-fix inventory. The copied
// generator's registry is a closed loopback port, so a generator that failed to
// refuse would fail at connect time and never reach GHCR.
function replaceOnce(path, from, to) {
  const source = readFileSync(path, "utf8");
  assert.equal(source.split(from).length, 2, `expected one occurrence of ${from} in ${path}`);
  writeFileSync(path, source.replace(from, to));
}

function copyPublishScripts() {
  const root = mkdtempSync(join(tmpdir(), "catalog-guard-"));
  cpSync(join(repoRoot, "scripts"), join(root, "scripts"), { recursive: true });
  cpSync(join(repoRoot, "packages", "connector-installer-core"), join(root, "packages", "connector-installer-core"), {
    recursive: true,
  });
  mkdirSync(join(root, "packages", "polyfill-connectors", "src"), { recursive: true });
  for (const file of [
    "package.json",
    join("packages", "polyfill-connectors", "package.json"),
    join("packages", "polyfill-connectors", "src", "connector-conformance-roster.ts"),
  ]) {
    cpSync(join(repoRoot, file), join(root, file));
  }
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "dir");
  replaceOnce(
    join(root, "scripts", "generate-connector-catalog.mjs"),
    `const DEFAULT_REGISTRY = "ghcr.io";`,
    `const DEFAULT_REGISTRY = "127.0.0.1:1";`,
  );
  return root;
}

test("the publish inventory guard passes on the reviewed inventory", () => {
  const step = extractStep(PREPARE_GUARD_STEP);
  assert.match(step.shell, /node scripts\/assert-publishable-readiness\.mjs/);
  const result = spawnSync("bash", ["-c", step.shell], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("the publish inventory guard admits canonical Development entries", () => {
  const root = copyPublishScripts();
  try {
    const result = spawnSync("bash", ["-c", extractStep(PREPARE_GUARD_STEP).shell], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /connectors pass identity and exclusion checks/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a manual dispatch of an excluded connector is refused before anything publishes", () => {
  const root = mkdtempSync(join(tmpdir(), "excluded-dispatch-"));
  try {
    const output = join(root, "github-output");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["-c", extractStep("Select the connector and version this run publishes").shell], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        EVENT_NAME: "workflow_dispatch",
        GIT_REF_NAME: "main",
        GIT_REF_TYPE: "branch",
        INPUT_CONNECTOR: "slack",
        MATRIX_CONNECTOR: "ynab",
        MATRIX_VERSION: "",
        GITHUB_OUTPUT: output,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in the publish allowlist/);
    assert.doesNotMatch(readFileSync(output, "utf8"), /selected=true/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

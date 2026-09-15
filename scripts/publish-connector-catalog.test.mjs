// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
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

function extractCatalogPublishStep() {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) =>
    /^\s*-\s*name:\s*Publish and verify the connector catalog\s*$/.test(line),
  );
  assert.notEqual(stepIndex, -1, "expected the connector catalog publish step");

  const ifLine = lines.slice(stepIndex).find((line) => /^\s*if:\s*/.test(line));
  const runIndex = lines.findIndex((line, index) =>
    index > stepIndex && /^\s*run:\s*\|\s*$/.test(line),
  );
  assert.notEqual(runIndex, -1, "expected the catalog step to carry a block `run:` script");

  const indent = lines[runIndex].match(/^\s*/)[0].length + 2;
  const body = [];
  for (let index = runIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    if (line.match(/^\s*/)[0].length < indent) break;
    body.push(line.slice(indent));
  }

  return {
    condition: ifLine?.replace(/^\s*if:\s*/, "") ?? "",
    shell: body.join("\n"),
  };
}

function writeCommand(path, source) {
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function runCatalogPublish(overrides = {}) {
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
if [ "\${1:-}" = "scripts/lookup-manifest.mjs" ]; then
  case "\${LOOKUP_OUTCOME:-absent}" in
    absent) printf '%s\n' '{"outcome":"absent"}' ;;
    present) printf '%s\n' '{"outcome":"present","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' ;;
    unknown) printf '%s\n' '{"outcome":"unknown"}' ;;
    *) exit 40 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "scripts/generate-connector-catalog.mjs" ]; then
  if [ "\${FAIL_COMMAND:-}" = "generate" ]; then exit 41; fi
  shift
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--out" ]; then
      mkdir -p "$(dirname "$2")"
      printf '{"connectors":[]}' > "$2"
      exit 0
    fi
    shift
  done
  exit 42
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
      printf '{"connectors":[]}' > "$2/catalog.json"
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

  const result = spawnSync("bash", ["-c", extractCatalogPublishStep().shell], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      REAL_NODE: process.execPath,
      COMMAND_LOG: commandLog,
      TAG_POINTER: tagPointer,
      RUNNER_TEMP: runnerTemp,
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
      priorVerify < pull && pull < generate && generate < push,
      "the prior catalog must be verified and pulled before generation and publication",
    );
  } finally {
    run.cleanup();
  }
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

test("the catalog publish remains gated to a selected main-branch non-dry run", () => {
  const { condition } = extractCatalogPublishStep();
  assert.match(condition, /steps\.target\.outputs\.selected\s*==\s*'true'/);
  assert.match(condition, /github\.ref\s*==\s*'refs\/heads\/main'/);
  assert.match(condition, /!inputs\.dry-run/);
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

function evaluateCondition(expression, { catalogOnly, dryRun = false, selected = false, ref = "refs/heads/main" }) {
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "")
    .replaceAll("inputs.catalog-only", "inputs['catalog-only']")
    .replaceAll("inputs.dry-run", "inputs['dry-run']");
  return Function("inputs", "steps", "github", `return (${source});`)(
    { "catalog-only": catalogOnly, "dry-run": dryRun },
    { target: { outputs: { selected: selected ? "true" : "false" } } },
    { ref },
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
    "Verify the published signature",
  ]) {
    assert.equal(evaluateCondition(stepCondition(name), catalogOnly), false, name);
  }
  for (const name of ["Install dependencies", "Install ORAS", "Install Cosign", "Publish and verify the connector catalog"]) {
    assert.equal(evaluateCondition(stepCondition(name), catalogOnly), true, name);
  }
  const condition = stepCondition("Publish and verify the connector catalog");
  for (const options of [
    { ...catalogOnly, dryRun: true },
    { ...catalogOnly, ref: "refs/heads/feature" },
    { ...catalogOnly, ref: "refs/tags/connector-ynab-v0.3.0" },
    { catalogOnly: false, selected: false },
  ]) {
    assert.equal(evaluateCondition(condition, options), false);
  }
  assert.equal(evaluateCondition(condition, { catalogOnly: false, selected: true }), true);
});

test("catalog-only dispatch selects exactly one matrix leg and normal dispatch preserves the allowlist", () => {
  const expression = workflow.match(/^      matrix: \$\{\{ (.+fromJSON.+) \}\}$/m)?.[1];
  assert.ok(expression);
  const matrix = { include: [{ connector: "ynab" }, { connector: "github" }] };
  const evaluate = Function("inputs", "needs", "fromJSON", `return (${expression.replaceAll("inputs.catalog-only", "inputs['catalog-only']")});`);
  const needs = { prepare: { outputs: { matrix: JSON.stringify(matrix) } } };
  assert.deepEqual(evaluate({ "catalog-only": true }, needs, JSON.parse), { include: [{ connector: "catalog" }] });
  assert.deepEqual(evaluate({ "catalog-only": false }, needs, JSON.parse), matrix);
});

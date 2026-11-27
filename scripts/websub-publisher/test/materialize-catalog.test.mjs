// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const digest = `sha256:${"a".repeat(64)}`;

function runMaterializer(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "catalog-materialize-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const temp = join(dir, "runner");
  const output = join(dir, "site", "catalog", "updates.atom");
  const log = join(dir, "commands");
  mkdirSync(bin);
  mkdirSync(temp);
  writeFileSync(log, "");
  writeFileSync(join(dir, "catalog.json"), JSON.stringify({
    catalog_version: "1.0", generated_at: "2026-10-29T12:00:00.000Z",
    source_commit: "a".repeat(40), connectors: [],
  }));
  function command(name, source) {
    const path = join(bin, name);
    writeFileSync(path, source);
    chmodSync(path, 0o755);
  }
  command("node", `#!/bin/bash
set -eu
if [[ "\${1:-}" == */lookup-manifest.mjs ]]; then
  echo lookup >> "$COMMAND_LOG"
  if [[ -e "$LOOKED_UP" && "\${MOVED:-}" == 1 ]]; then
    echo '{"outcome":"present","digest":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
  else
    touch "$LOOKED_UP"
    echo "\${LOOKUP_RESULT}"
  fi
  exit 0
fi
exec "$REAL_NODE" "$@"
`);
  command("oras", `#!/bin/bash
set -eu
printf 'oras %s\n' "$*" >> "$COMMAND_LOG"
case "$1" in
  login) cat >/dev/null ;;
  pull) mkdir -p "$4"; cp "$FIXTURE_CATALOG" "$4/catalog.json" ;;
  *) exit 1 ;;
esac
`);
  command("cosign", `#!/bin/bash
set -eu
printf 'cosign %s\n' "$*" >> "$COMMAND_LOG"
[[ "\${FAIL_VERIFY:-}" != 1 ]]
`);
  const result = spawnSync("bash", [join(root, "scripts/websub-publisher/materialize-catalog.sh"), output], {
    cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, REAL_NODE: process.execPath,
      COMMAND_LOG: log, LOOKED_UP: join(dir, "looked-up"), FIXTURE_CATALOG: join(dir, "catalog.json"),
      LOOKUP_RESULT: JSON.stringify({ outcome: "present", digest }),
      GITHUB_WORKSPACE: root, RUNNER_TEMP: temp, GITHUB_ACTOR: "fixture", GH_TOKEN: "fixture-token",
      ...options,
    },
  });
  return { result, commands: readFileSync(log, "utf8").trim().split("\n"), output };
}

test("materialization verifies and pulls one digest, then rechecks latest before writing", (t) => {
  const { result, commands, output } = runMaterializer(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(commands[0], "lookup");
  assert.match(commands[1], /^oras login /);
  assert.equal(commands.filter((line) => line.startsWith("cosign verify ")).length, 2);
  assert.ok(commands[2].includes(`connector-catalog@${digest}`));
  assert.ok(commands[3].includes(`connector-catalog@${digest}`));
  assert.ok(commands[4].startsWith(`oras pull ghcr.io/pdp-connect/connector-catalog@${digest}`));
  assert.equal(commands[5], "lookup");
  assert.ok(readFileSync(output, "utf8").includes(`urn:pdpp:connector-catalog:${digest}`));
});

test("unknown or unsigned latest and a moved tag cannot create a feed", async (t) => {
  for (const options of [
    { LOOKUP_RESULT: '{"outcome":"unknown"}' },
    { LOOKUP_RESULT: '{"outcome":"present","digest":"latest"}' },
    { FAIL_VERIFY: "1" },
    { MOVED: "1" },
  ]) {
    await t.test(JSON.stringify(options), (subtest) => {
      const { result, commands, output } = runMaterializer(subtest, options);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(output), false);
      if (options.FAIL_VERIFY) assert.equal(commands.some((line) => line.startsWith("oras pull")), false);
    });
  }
});

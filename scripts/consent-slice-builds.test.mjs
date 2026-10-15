// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The real Core and PageShim builders bundle one connector's consent-time-field
// slice, never the aggregate or another connector's slice. A hash test alone
// cannot show this: the hash could be right while the bundle still carries
// every connector's fields.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPageshim } from "./pageshim/build.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATED = "packages/polyfill-connectors/src/generated";
const AGGREGATE = `${GENERATED}/consent-time-fields.generated.ts`;
const slice = (dir) => `${GENERATED}/consent-time-fields/${dir}.generated.ts`;

function scratchDirectory(t) {
  const root = process.env.RUNNER_TEMP || process.env.TMPDIR || join(homedir(), ".tmp");
  mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, "consent-slice-builds-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const connector of ["amazon", "reddit", "strava_browser"]) {
  test(`the ${connector} Core artifact bundles only its own consent slice`, (t) => {
    const out = join(scratchDirectory(t), connector);
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "scripts/build-connector-oci-artifact.mjs"),
        "--connector", connector, "--out", out,
        "--esbuild", join(repoRoot, "node_modules/esbuild/lib/main.js"),
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 300_000 },
    );
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const inventory = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8")).source_inventory;
    const consentInputs = inventory.map(({ path }) => path).filter((path) => path.includes("consent-time-fields"));
    assert.deepEqual(consentInputs, [slice(connector)]);
  });
}

test("the strava_browser PageShim bundle carries only its own consent slice", async (t) => {
  const outfile = join(scratchDirectory(t), "strava_browser.js");
  await buildPageshim({ connector: "strava_browser", outfile, minify: false });
  const text = readFileSync(outfile, "utf8");
  assert.match(text, /\bstrava_browser:\s*\{/, "the bundle must carry its own consent table");
  const others = [...text.matchAll(/^\s*(?:"?)([a-z][a-z0-9_]*)(?:"?):\s*\{\s*$/gm)]
    .map((match) => match[1])
    .filter((name) => ["anthropic_live", "chatgpt", "reddit", "amazon", "fitbit", "strava"].includes(name));
  assert.deepEqual(others, [], "the bundle must not carry another connector's consent table");
});

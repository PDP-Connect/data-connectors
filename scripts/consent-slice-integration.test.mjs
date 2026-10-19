// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The actual Core CLI and the actual PageShim entrypoint, run in an isolated
// fixture checkout, must refuse a missing, stale or tampered consent-time-field
// slice and must not leave a valid artifact. These tests exercise the real
// builder scripts end to end, so a builder that loses its slice wiring fails
// here even when the esbuild plugin and the hash are still correct.
//
// strava_browser supports both builder modes (Core and PageShim). It shares a
// source with strava, and reddit is an unrelated connector, so one fixture
// also shows which artifacts a slice-policy change moves.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { artifactInputHash } from "./connector-artifact-inputs.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SELECTED = "strava_browser";
const FULL_DIRECTORIES = new Set([SELECTED, "strava", "reddit"]);
const SKIPPED = new Set(["node_modules", ".git", "fixtures", "artifacts", "docs", "reports", "registry-site", "bench"]);
const GENERATED = "packages/polyfill-connectors/src/generated";
const slice = (dir) => `${GENERATED}/consent-time-fields/${dir}.generated.ts`;
const RENDERER = "packages/polyfill-connectors/scripts/consent-time-fields-render.mjs";
const GENERATOR = "packages/polyfill-connectors/scripts/generate-consent-time-fields.ts";

function makeFixture(t) {
  const base = process.env.RUNNER_TEMP || process.env.TMPDIR || join(homedir(), ".tmp");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "consent-slice-integration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(repoRoot, root, {
    recursive: true,
    filter: (source) => {
      const path = source.slice(repoRoot.length + 1);
      const parts = path.split("/");
      if (parts.some((part) => SKIPPED.has(part))) return false;
      // Other connectors contribute only what source slicing and hashing read.
      if (parts[0] === "connectors" && parts.length > 2 && !FULL_DIRECTORIES.has(parts[1])) {
        return parts.length === 3 && (parts[2] === "manifest.json" || parts[2].endsWith(".svg"));
      }
      return true;
    },
  });
  // Dependencies are read from the real checkout; build outputs stay out of commits.
  symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  writeFileSync(join(root, ".git/info/exclude"), "node_modules\n.out\n");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Consent Slice Integration Test");
  const read = (path) => readFileSync(join(root, path), "utf8");
  const write = (path, content) => writeFileSync(join(root, path), content);
  const fixture = {
    root,
    read,
    write,
    commit(message) {
      git("add", "-A");
      git("commit", "--quiet", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
    regenerate() {
      execFileSync("node", ["--experimental-strip-types", join(root, GENERATOR)], {
        cwd: join(root, "packages/polyfill-connectors"),
        stdio: "pipe",
      });
    },
    hash: (commit, manifest) => artifactInputHash({ commit, manifest, cwd: root }),
    // The real Core CLI and the real PageShim entrypoint, each into a fresh output.
    build(kind, connector, label) {
      const out = join(root, ".out", label, kind);
      mkdirSync(dirname(out), { recursive: true });
      const args =
        kind === "core"
          ? [
              join(root, "scripts/build-connector-oci-artifact.mjs"),
              "--connector", connector, "--out", out,
              "--esbuild", join(repoRoot, "node_modules/esbuild/lib/main.js"),
            ]
          : [join(root, "scripts/pageshim/build.mjs"), "--connector", connector, "--out", `${out}.js`];
      const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 300_000 });
      const artifact = kind === "core" ? join(out, "code.tar.gz") : `${out}.js`;
      return {
        status: result.status,
        output: `${result.error ?? ""}${result.stdout}${result.stderr}`,
        built: existsSync(artifact),
        out,
        artifact,
      };
    },
  };
  git("add", "-A");
  git("commit", "--quiet", "-m", "fixture checkout");
  return fixture;
}

const BUILDERS = ["core", "pageshim"];

function assertRefused(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label}: the builder must exit non-zero\n${result.output}`);
  assert.match(result.output, pattern, `${label}: the builder must name the slice problem`);
  assert.equal(result.built, false, `${label}: no valid artifact may be left behind`);
}

function assertBuilt(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.output}`);
  assert.equal(result.built, true, `${label}: the artifact must exist`);
}

const SCENARIOS = [
  {
    name: "a missing slice",
    pattern: /consent-time-field slice .*strava_browser\.generated\.ts is missing/,
    damage(fx) {
      rmSync(join(fx.root, slice(SELECTED)));
    },
  },
  {
    name: "a manifest changed without regenerating",
    pattern: /consent-time-field slice .*strava_browser\.generated\.ts is stale/,
    damage(fx) {
      // strava shares the source, and a shared stream must be declared the same
      // way by both, so the valid edit changes both manifests.
      for (const dir of [SELECTED, "strava"]) {
        const manifest = fx.read(`connectors/${dir}/manifest.json`);
        assert.ok(manifest.includes('"consent_time_field": "start_date_local"'));
        fx.write(
          `connectors/${dir}/manifest.json`,
          manifest.replace('"consent_time_field": "start_date_local"', '"consent_time_field": "start_date"'),
        );
      }
    },
  },
  {
    name: "a hand-edited slice",
    pattern: /consent-time-field slice .*strava_browser\.generated\.ts is stale/,
    damage(fx) {
      fx.write(slice(SELECTED), `${fx.read(slice(SELECTED))}// hand edit\n`);
    },
  },
];

for (const scenario of SCENARIOS) {
  test(`the real builders refuse ${scenario.name}, and regenerating recovers`, (t) => {
    const fx = makeFixture(t);
    for (const kind of BUILDERS) assertBuilt(fx.build(kind, SELECTED, `${kind}-baseline`), `${kind} baseline`);
    scenario.damage(fx);
    for (const kind of BUILDERS) {
      assertRefused(fx.build(kind, SELECTED, `${kind}-damaged`), scenario.pattern, `${kind} with ${scenario.name}`);
    }
    fx.regenerate();
    for (const kind of BUILDERS) assertBuilt(fx.build(kind, SELECTED, `${kind}-recovered`), `${kind} after regenerating`);
  });
}

test("another connector's missing slice does not stop the selected connector building", (t) => {
  const fx = makeFixture(t);
  rmSync(join(fx.root, slice("reddit")));
  for (const kind of BUILDERS) assertBuilt(fx.build(kind, SELECTED, kind), `${kind} without reddit's slice`);
  // Reddit itself, which needs its slice, still refuses.
  assertRefused(fx.build("core", "reddit", "reddit"), /reddit\.generated\.ts is missing/, "core reddit");
});

test("a date-bound policy change is refused until regenerated, then moves only the affected artifacts", async (t) => {
  const fx = makeFixture(t);
  const before = fx.commit("baseline");
  const peers = [SELECTED, "strava", "reddit"];
  const beforeHashes = Object.fromEntries(await Promise.all(peers.map(async (name) => [name, await fx.hash(before, name)])));
  const baseline = {
    core: fx.build("core", SELECTED, "core-before"),
    pageshim: fx.build("pageshim", SELECTED, "pageshim-before"),
    reddit: fx.build("core", "reddit", "reddit-before"),
  };
  assertBuilt(baseline.core, "baseline core");
  assertBuilt(baseline.pageshim, "baseline pageshim");
  assertBuilt(baseline.reddit, "baseline reddit");

  // The policy lists strava_browser.activities as compared by calendar day;
  // dropping it makes that stream's slice entry null. No manifest changes.
  const renderer = fx.read(RENDERER);
  assert.ok(renderer.includes('"strava_browser.activities",'));
  fx.write(RENDERER, renderer.replace('\t"strava_browser.activities",\n', ""));
  const mutated = fx.commit("policy: strava_browser.activities no longer date-bound");

  // Before regeneration the committed slice no longer matches what the policy renders.
  await assert.rejects(fx.hash(mutated, SELECTED), /strava_browser\.generated\.ts is stale/);
  for (const kind of BUILDERS) {
    assertRefused(fx.build(kind, SELECTED, `${kind}-policy-stale`), /strava_browser\.generated\.ts is stale/, `${kind} with a stale slice`);
  }

  fx.regenerate();
  const regenerated = fx.commit("regenerate slices under the new policy");
  assert.match(fx.read(slice(SELECTED)), /activities: null/);
  const afterHashes = Object.fromEntries(await Promise.all(peers.map(async (name) => [name, await fx.hash(regenerated, name)])));
  assert.notEqual(afterHashes[SELECTED], beforeHashes[SELECTED]);
  assert.equal(afterHashes.strava, beforeHashes.strava, "a source-declaration peer is not moved by another connector's slice");
  assert.equal(afterHashes.reddit, beforeHashes.reddit);

  const after = {
    core: fx.build("core", SELECTED, "core-after"),
    pageshim: fx.build("pageshim", SELECTED, "pageshim-after"),
    reddit: fx.build("core", "reddit", "reddit-after"),
  };
  assertBuilt(after.core, "regenerated core");
  assertBuilt(after.pageshim, "regenerated pageshim");
  assertBuilt(after.reddit, "regenerated reddit");
  const bytes = (result) => readFileSync(result.artifact);
  const inventory = (result) => readFileSync(join(result.out, "provenance.json"), "utf8").match(/"source_inventory":[\s\S]*?\n {2}\]/)?.[0];
  assert.notDeepEqual(bytes(after.core), bytes(baseline.core));
  assert.notDeepEqual(bytes(after.pageshim), bytes(baseline.pageshim));
  assert.notEqual(inventory(after.core), inventory(baseline.core));
  assert.deepEqual(bytes(after.reddit), bytes(baseline.reddit), "an unaffected connector's code payload is unchanged");
  assert.equal(inventory(after.reddit), inventory(baseline.reddit), "an unaffected connector's input inventory is unchanged");
  assert.ok(readdirSync(join(fx.root, ".out")).length > 0);
});

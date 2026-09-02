#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));
const rootAuthoringPath = "AUTHORING.md";
const githubAuthoringPath = "connectors/github-pdpp/AUTHORING.md";
const legacySkillPath = "skills/pdp-connect/SKILL.md";
const legacyCreatePath = "skills/pdp-connect/CREATE.md";
const collectionProfilePath = "docs/spec/collection-profile.md";
const collectionProfileRuntimePath =
  "packages/polyfill-connectors/docs/collection-profile-runtime.md";
const checkedMarkdownPaths = [
  "README.md",
  rootAuthoringPath,
  githubAuthoringPath,
  legacySkillPath,
  legacyCreatePath,
  collectionProfilePath,
  collectionProfileRuntimePath,
];
const README = read("README.md");
const rootAuthoring = read(rootAuthoringPath);
const githubAuthoring = read(githubAuthoringPath);
const legacySkill = read(legacySkillPath);
const legacyCreate = read(legacyCreatePath);
const collectionProfile = read(collectionProfilePath);
const standardBindings = [
  "browser",
  "desktop_session",
  "filesystem",
  "interactive",
  "network",
];
const coverageStrategies = [
  "checkpoint_window",
  "full_inventory",
  "parent_detail_accounting",
  "snapshot_import_receipt",
  "singleton_presence",
];
const polyfillManifestPaths = readdirSync(
  join(root, "packages/polyfill-connectors/manifests"),
)
  .filter((name) => name.endsWith(".json"))
  .map((name) => `packages/polyfill-connectors/manifests/${name}`);
const polyfillManifests = polyfillManifestPaths.map(readJson);
const githubManifest = readJson(
  "connectors/github-pdpp/collection-profile.json",
);
const index = readJson("connector-index.json");

function headingFragments(content) {
  const fragments = new Set();
  const counts = new Map();
  for (const [, heading] of content.matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
    const base = heading
      .replace(/<[^>]*>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = counts.get(base) ?? 0;
    fragments.add(count === 0 ? base : `${base}-${count}`);
    counts.set(base, count + 1);
  }
  return fragments;
}

function assertLocalMarkdownLinksResolve(path) {
  const content = read(path);
  const sourceDirectory = dirname(join(root, path));
  for (const [, target] of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [relativePath, encodedFragment] = target.split("#", 2);
    const localPath = relativePath
      ? resolve(sourceDirectory, relativePath)
      : join(root, path);
    assert.ok(existsSync(localPath), `${path} links to missing ${target}`);
    if (!encodedFragment) continue;
    const fragment = decodeURIComponent(encodedFragment);
    const fragments = headingFragments(readFileSync(localPath, "utf8"));
    assert.ok(
      fragments.has(fragment),
      `${path} links to missing fragment ${target}`,
    );
  }
}

assert.match(
  README,
  /For new connector work, start with \[Connector authoring\]/,
);
assert.match(README, /GitHub and ChatGPT are the current PDPP artifact examples/);
assert.match(
  README,
  /New connector work belongs here by default, not in `PDP-Connect\/pdpp`/,
);
assert.match(
  README,
  /checked-in `connector-index\.json` intentionally marks both artifacts with `releaseId: "unpublished"` until CI regenerates the source-tree index/,
);
assert.match(README, /connectors-48440fead534/);
assert.match(README, /connectors-latest/);
assert.match(
  README,
  /DataConnect v0\.7\.54.*includes both PDPP profiles/,
);
assert.match(rootAuthoring, /This repository is the single home of PDPP connector content/);
assert.match(
  rootAuthoring,
  /\[PDPP Collection Profile\]\(docs\/spec\/collection-profile\.md\)/,
);
assert.match(rootAuthoring, /Add an `artifact\.json` descriptor/);
assert.match(rootAuthoring, /scripts\/build-pdpp-artifact\.mjs/);
assert.match(rootAuthoring, /requires both `network` and `browser`/);
assert.match(
  rootAuthoring,
  /DataConnect v0\.7\.54.*provide this browser host/,
);
assert.match(rootAuthoring, /checked-in index entry intentionally has `releaseId: "unpublished"`/);
assert.match(rootAuthoring, /connectors-48440fead534/);
assert.match(rootAuthoring, /connectors-latest/);
assert.match(githubAuthoring, /requires only the `network` binding/);
assert.match(githubAuthoring, /releaseId: "unpublished"/);
assert.match(githubAuthoring, /source-tree placeholder metadata/);
assert.match(githubAuthoring, /connectors-48440fead534/);
assert.match(githubAuthoring, /connectors-latest/);
assert.match(legacySkill, /New connector requests route to PDP-Connect\/pdpp/);
assert.match(
  legacySkill,
  /Do not create a legacy Playwright connector unless a maintainer approves an explicit exception/,
);
assert.match(
  legacyCreate,
  /only after a maintainer approves a legacy Playwright exception/,
);
assert.match(
  legacyCreate,
  /node skills\/pdp-connect\/scripts\/scaffold\.cjs --legacy-exception <platform> \[company\]/,
);
assert.doesNotMatch(
  `${legacyCreate}\n${legacySkill}`,
  /node scripts\/(?:validate|generate-schemas|register)\.cjs/,
);
for (const path of [
  "skills/pdp-connect/scripts/scaffold.cjs",
  "skills/pdp-connect/scripts/validate.cjs",
  "skills/pdp-connect/scripts/generate-schemas.cjs",
  "skills/pdp-connect/scripts/register.cjs",
]) {
  assert.ok(existsSync(join(root, path)), `documented command is missing ${path}`);
}
assert.match(read("create-connector.sh"), /without --legacy-exception/);
assert.match(read("scripts/create-connector.sh"), /without --legacy-exception/);
assert.match(
  read("skills/pdp-connect/scripts/scaffold.cjs"),
  /without --legacy-exception/,
);
assert.deepEqual(githubManifest.runtime_requirements.bindings, {
  network: { required: true },
});
assert.equal(
  index.connectors["github-pdpp"][0].artifactKind,
  "pdpp-collection-profile",
);
assert.equal(index.connectors["github-pdpp"][0].releaseId, "unpublished");

for (const binding of standardBindings) {
  assert.match(
    collectionProfile,
    new RegExp("\\| `" + binding + "` \\|"),
    `Collection Profile must define the ${binding} binding`,
  );
}
for (const legacyBinding of [
  "browser_automation",
  "browser_profile",
  "loopback_listen",
]) {
  assert.doesNotMatch(
    collectionProfile,
    new RegExp(`\\b${legacyBinding}\\b`),
    `Collection Profile must not publish the rejected ${legacyBinding} binding`,
  );
}
for (const strategy of coverageStrategies) {
  assert.match(
    collectionProfile,
    new RegExp("\\| `" + strategy + "` \\|"),
    `Collection Profile must define the ${strategy} coverage strategy`,
  );
}
assert.match(
  collectionProfile,
  /`DONE\.status` has two values:\s+`succeeded` and `failed`/,
);
assert.doesNotMatch(
  collectionProfile,
  /`DONE\.status`[^\n]*(?:`cancelled`|`abandoned`)/,
);
assert.match(
  collectionProfile,
  /The response status is `success`, `cancelled`, or `timeout`/,
);
for (const startField of ["run_id", "bindings", "fields"]) {
  assert.match(
    collectionProfile,
    new RegExp("`" + startField + "`"),
    `Collection Profile must define START.${startField}`,
  );
}

assert.ok(polyfillManifests.length > 0, "polyfill manifests must be present");
for (const manifest of polyfillManifests) {
  assert.equal(manifest.protocol_version, "0.1.0");
  assert.match(manifest.connector_key, /^[a-z0-9][a-z0-9._-]*$/);
  if (manifest.protocol_capabilities !== undefined) {
    assert.ok(Array.isArray(manifest.protocol_capabilities));
  }
  for (const binding of Object.keys(
    manifest.runtime_requirements?.bindings ?? {},
  )) {
    assert.ok(
      standardBindings.includes(binding),
      `${manifest.connector_key} uses non-standard binding ${binding}`,
    );
  }
  for (const stream of manifest.streams) {
    assert.ok(
      coverageStrategies.includes(stream.coverage_strategy),
      `${manifest.connector_key}.${stream.name} uses unknown coverage_strategy`,
    );
  }
}

const chatgptPaths = [
  "connectors/chatgpt-pdpp/artifact.json",
  "connectors/chatgpt-pdpp/collection-profile.json",
  "scripts/build-pdpp-artifact.mjs",
];
const presentChatgptPaths = chatgptPaths.filter((path) =>
  existsSync(join(root, path)),
);
if (presentChatgptPaths.length > 0) {
  assert.deepEqual(
    presentChatgptPaths,
    chatgptPaths,
    "ChatGPT generic artifact tooling must land as one contract",
  );
  const chatgptArtifact = readJson(chatgptPaths[0]);
  const chatgptManifest = readJson(chatgptPaths[1]);
  assert.equal(chatgptArtifact.artifact_kind, "pdpp-collection-profile");
  assert.deepEqual(chatgptManifest.runtime_requirements.bindings, {
    network: { required: true },
    browser: { required: true },
  });
  assert.deepEqual(chatgptArtifact.build.external_packages, [
    { name: "p-queue", version: "^9.3.3" },
    { name: "patchright", version: "^1.61.1" },
    { name: "@pdpp/connector-protocol", version: "^1.0.0" },
    { name: "@pdpp/connector-protocol/auth", version: "^1.0.0" },
    { name: "@pdpp/connector-protocol/http-retry", version: "^1.0.0" },
    { name: "@pdpp/connector-protocol/pdpp-safe-text", version: "^1.0.0" },
  ]);
} else {
  assert.fail(
    "The authoring docs require the complete ChatGPT PDPP artifact contract",
  );
}

for (const path of checkedMarkdownPaths) {
  assertLocalMarkdownLinksResolve(path);
  assert.doesNotMatch(
    read(path),
    /\u2014/,
    `${path} must not contain em dashes`,
  );
}
for (const path of [
  "create-connector.sh",
  "scripts/create-connector.sh",
  "scripts/check-pdpp-authoring-docs.mjs",
  "skills/pdp-connect/scripts/scaffold.cjs",
]) {
  assert.doesNotMatch(
    read(path),
    /\u2014/,
    `${path} must not contain em dashes`,
  );
}

console.log(
  "PDPP authoring routes, links, fragments, manifests, and publication status are consistent.",
);

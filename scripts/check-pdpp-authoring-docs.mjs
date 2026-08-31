#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const readJson = (path) => JSON.parse(read(path));
const rootAuthoringPath = "AUTHORING.md";
const githubAuthoringPath = "connectors/github-pdpp/AUTHORING.md";
const legacySkillPath = "skills/pdp-connect/SKILL.md";
const legacyCreatePath = "skills/pdp-connect/CREATE.md";
const checkedMarkdownPaths = [
  "README.md",
  rootAuthoringPath,
  githubAuthoringPath,
  legacySkillPath,
  legacyCreatePath,
];
const README = read("README.md");
const rootAuthoring = read(rootAuthoringPath);
const githubAuthoring = read(githubAuthoringPath);
const legacySkill = read(legacySkillPath);
const legacyCreate = read(legacyCreatePath);
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
  /New connector work belongs in `PDP-Connect\/pdpp` by default/,
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
assert.match(rootAuthoring, /Use PDPP for new connector work by default/);
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
  "PDPP authoring routes, links, fragments, bindings, and publication status are consistent.",
);

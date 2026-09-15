#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0


import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const rootAuthoringPath = "AUTHORING.md";
const legacySkillPath = "skills/pdp-connect/SKILL.md";
const legacyCreatePath = "skills/pdp-connect/CREATE.md";
const checkedMarkdownPaths = [
  "README.md",
  rootAuthoringPath,
  legacySkillPath,
  legacyCreatePath,
];
const README = read("README.md");
const rootAuthoring = read(rootAuthoringPath);
const legacySkill = read(legacySkillPath);
const legacyCreate = read(legacyCreatePath);

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
assert.match(
  README,
  /New connector work belongs here by default, not in `PDP-Connect\/pdpp`/,
);
assert.match(rootAuthoring, /This repository is the single home of PDPP connector content/);
assert.match(rootAuthoring, /production does not build from it/);
assert.doesNotMatch(
  `${README}\n${rootAuthoring}`,
  /runs the product/,
);
assert.match(
  legacySkill,
  /New connector requests route to this repository/,
);
assert.match(
  legacySkill,
  /start the work here, in this repository/,
);
assert.match(
  legacyCreate,
  /New connector work belongs here by default, not in `PDP-Connect\/pdpp`/,
);
assert.match(
  read("skills/pdp-connect/scripts/scaffold.cjs"),
  /Start new connector work here, in this repository/,
);
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
  "PDPP authoring routes, links, fragments, and legacy exception wording are consistent.",
);

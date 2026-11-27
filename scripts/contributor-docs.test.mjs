// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Contributor docs name files, links and npm scripts that a reader (often an
// agent) runs verbatim. This test fails when one of them stops existing.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = "packages/polyfill-connectors";

export const CONTRIBUTOR_DOCS = [
	"README.md",
	"AGENTS.md",
	"AUTHORING.md",
	"CONNECTOR-GUIDELINES.md",
	"CONNECTOR-REVIEW.md",
	"TESTING.md",
	"docs/add-a-connector-to-mobile.md",
	"docs/publishing.md",
	`${pkg}/AGENTS.md`,
	`${pkg}/CONNECTOR-CHECKLIST.md`,
	`${pkg}/README.md`,
	`${pkg}/docs/aggregation-declarations.md`,
	`${pkg}/docs/collection-profile-runtime.md`,
	`${pkg}/docs/connector-authoring-guide.md`,
];

const PATH_ROOTS = /^(?:connectors|packages|scripts|docs|\.github|bin|src)\//;

/** Backticked tokens that look like repository paths, minus placeholders. */
export function pathTokens(markdown) {
	const out = new Set();
	for (const [, token] of markdown.matchAll(/`([^`\s]+)`/g)) {
		const path = token.replace(/[),.:;]+$/, "").replace(/#.*$/, "");
		if (!PATH_ROOTS.test(path)) continue;
		if (/[<>*{}$]|\.\.\./.test(path)) continue;
		out.add(path);
	}
	return [...out];
}

/** Relative markdown link targets, without anchors. */
export function linkTargets(markdown) {
	const out = new Set();
	for (const [, target] of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
		if (/^(?:[a-z]+:|#)/i.test(target)) continue;
		out.add(target.replace(/#.*$/, ""));
	}
	return [...out];
}

/** `npm run <name>` invocations. */
export function npmScripts(markdown) {
	return [
		...new Set(
			[...markdown.matchAll(/npm run ([a-z0-9:_-]+)/gi)].map((m) => m[1]),
		),
	];
}

function scriptsOf(path) {
	return Object.keys(
		JSON.parse(readFileSync(join(root, path), "utf8")).scripts,
	);
}

/** A path a tool creates at run time, such as `runs/`, is git-ignored. */
function ignoredByGit(path) {
	try {
		execFileSync("git", ["check-ignore", "-q", path], { cwd: root });
		return true;
	} catch {
		return false;
	}
}

function resolves(doc, path) {
	const bases = [root, join(root, dirname(doc))];
	if (doc.startsWith(`${pkg}/`)) bases.push(join(root, pkg));
	return (
		bases.some((base) => existsSync(join(base, path))) || ignoredByGit(path)
	);
}

test("every repository path a contributor doc names exists", () => {
	const missing = [];
	for (const doc of CONTRIBUTOR_DOCS) {
		const text = readFileSync(join(root, doc), "utf8");
		for (const path of pathTokens(text)) {
			if (!resolves(doc, path)) missing.push(`${doc}: ${path}`);
		}
	}
	assert.deepEqual(missing, []);
});

test("every relative link in a contributor doc resolves", () => {
	const broken = [];
	for (const doc of CONTRIBUTOR_DOCS) {
		const text = readFileSync(join(root, doc), "utf8");
		for (const target of linkTargets(text)) {
			if (!existsSync(join(root, dirname(doc), target))) {
				broken.push(`${doc}: ${target}`);
			}
		}
	}
	assert.deepEqual(broken, []);
});

test("every npm script a contributor doc runs is defined", () => {
	const defined = new Set([
		...scriptsOf("package.json"),
		...scriptsOf(`${pkg}/package.json`),
	]);
	const missing = [];
	for (const doc of CONTRIBUTOR_DOCS) {
		const text = readFileSync(join(root, doc), "utf8");
		for (const name of npmScripts(text)) {
			if (!defined.has(name)) missing.push(`${doc}: npm run ${name}`);
		}
	}
	assert.deepEqual(missing, []);
});

test("the extractors skip placeholders and external links", () => {
	const sample =
		"Run `connectors/<key>/manifest.json` and `scripts/real.mjs`, see [x](https://a.b) and [y](AUTHORING.md#loop); npm run conformance -- steam";
	assert.deepEqual(pathTokens(sample), ["scripts/real.mjs"]);
	assert.deepEqual(linkTargets(sample), ["AUTHORING.md"]);
	assert.deepEqual(npmScripts(sample), ["conformance"]);
});

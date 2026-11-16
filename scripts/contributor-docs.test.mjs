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


test("authoring names checkout steps, refresh defaults and generated outputs", () => {
	const text = readFileSync(join(root, "AUTHORING.md"), "utf8");
	const before = text.split("## Before you start\n")[1].split("## Steps\n")[0];
	assert.deepEqual([...before.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1])), [1, 2, 3, 4]);
	assert.ok(before.includes("1. Fork `PDP-Connect/data-connectors` on GitHub."));
	assert.ok(before.includes("git clone https://github.com/<your-user>/data-connectors.git"));
	assert.ok(before.includes("cd data-connectors && git switch -c <key>-connector"));
	assert.match(before, /^2\. Install Node\.js/m);
	assert.match(before, /^3\. Choose the existing connector/m);
	assert.match(before, /^4\. List what the platform holds/m);
	const refresh = text.split("3. Choose the refresh policy")[1].split("4. Give the connector")[0];
	for (const interval of [
		"`minimum_interval_seconds` to 3600 (one hour)",
		"`recommended_interval_seconds` to 21600 (six hours)",
		"`maximum_staleness_seconds` to 86400 (one day)",
	]) assert.ok(refresh.includes(interval), interval);
	const registration = text.split("5. Register the connector in the shared files.")[1].split("6. Record a scenario.")[0];
	const consent = registration.split("   6. ")[1].split("   7. ")[0];
	const secrets = registration.split("   7. ")[1].split("   8. ")[0];
	assert.ok(consent.includes("packages/polyfill-connectors/src/generated/consent-time-fields.generated.ts"));
	assert.ok(consent.includes("packages/polyfill-connectors/src/generated/consent-time-fields/"));
	assert.ok(secrets.includes("packages/polyfill-connectors/src/generated/static-secret-registry.generated.ts"));
});

test("registration precedes replay evidence and numbered references follow the order", () => {
	const text = readFileSync(join(root, "AUTHORING.md"), "utf8");
	const steps = text.split("## Steps\n")[1].split("## Change an existing connector")[0];
	const headings = [...steps.matchAll(/^(\d+)\. (.+)$/gm)];
	assert.deepEqual(headings.map((match) => Number(match[1])), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	const section = (number) => steps.slice(headings[number - 1].index,
		headings[number]?.index ?? steps.length);
	assert.match(section(4), /^4\. Give the connector its inputs/);
	assert.match(section(5), /^5\. Register the connector in the shared files/);
	assert.match(section(6), /^6\. Record a scenario/);
	assert.match(section(7), /^7\. Replay the scenario/);
	assert.match(section(8), /^8\. Write the claim/);
	assert.match(section(9), /^9\. Run the conformance report/);
	assert.deepEqual([...section(5).matchAll(/^   (\d+)\. /gm)].map((match) => Number(match[1])),
		[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.ok(section(5).trimEnd().endsWith("Then run `npm test`. It fails until each of these is done, and each failing test names the file to change."));
	assert.ok(section(8).includes("Commit `claim.json`, and nothing else from steps 6 to 8."));
	assert.ok(section(8).includes("do steps 6 to 8 again."));
	assert.ok(section(10).includes("Run `npm test` again after the claim is written."));
	assert.ok(section(5).includes("The scaffold creates `connectors/<key>/pilot-fixture.test.ts` for this. A connector with its own collection test names that file instead."));
	assert.ok(section(10).includes("line from step 7."));
	assert.ok(text.includes("Make the change, then do step 4 and steps 6 to 9 for that connector."));
	assert.doesNotMatch(text, /steps 5 to 7|steps 4 to 8|line from step 6/);
});

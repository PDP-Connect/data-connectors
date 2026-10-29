// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The legacy data connectors (the `*-playwright` scripts, their frozen
// indexes and signing lane) are gone. This repository is the home of PDPP
// Collection Profile connectors only. The one thing kept from the old format
// is its permanent shape reference: `legacy-shapes.json`, the scope schemas it
// lists, `SCOPES.md` and the sha-pinned checker. Each check below names one
// thing that must not come back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "scripts/no-legacy-connectors.test.mjs";

const tracked = execFileSync("git", ["ls-files", "-z"], {
	cwd: root,
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
})
	.split("\0")
	.filter(Boolean)
	.filter((file) => existsSync(path.join(root, file)));

const FROZEN_SHAPE_SCRIPTS = new Set([
	"scripts/check-frozen-legacy-contracts.mjs",
	"scripts/frozen-legacy-contracts.sha256.json",
	"scripts/frozen-legacy-contracts.test.mjs",
	"scripts/generate-legacy-scopes.mjs",
	"scripts/generate-legacy-scopes.test.mjs",
]);

const read = (file) => readFileSync(path.join(root, file), "utf8");
const offenders = (predicate) => tracked.filter((file) => file !== SELF && predicate(file));

test("no legacy artifact, index or catalog file is tracked", () => {
	const legacyPaths = [
		/(^|\/)[^/]*-playwright(?:[-.][^/]*)?(\/|$)/, // oura-playwright.js, oura-playwright-3.1.3.tgz
		/(^|\/)claude-code-local[^/]*$/,
		/^artifacts\//,
		/^docs\/migration\//,
		/^(registry|scope-catalog|connector-index|fixture-index)\.json$/,
		/^packages\/polyfill-connectors\/connector-index\.json$/,
		/^scripts\/[^/]*(legacy|frozen)[^/]*$/,
	];
	assert.deepEqual(
		offenders(
			(file) =>
				!FROZEN_SHAPE_SCRIPTS.has(file) &&
				legacyPaths.some((pattern) => pattern.test(file)),
		),
		[],
	);
});

test("every connector directory is a Collection Profile connector or a frozen shape folder", () => {
	const directories = new Set(
		tracked
			.filter((file) => file.startsWith("connectors/"))
			.map((file) => file.split("/")[1]),
	);
	// A directory with only `schemas/*.json` holds frozen old-format shapes.
	const onlyFrozenSchemas = (directory) =>
		tracked
			.filter((file) => file.startsWith(`connectors/${directory}/`))
			.every((file) =>
				new RegExp(`^connectors/${directory}/schemas/[^/]+\\.json$`).test(file),
			);
	const withoutManifest = [...directories].filter(
		(directory) =>
			directory !== "_conformance" &&
			!tracked.includes(`connectors/${directory}/manifest.json`) &&
			!onlyFrozenSchemas(directory),
	);
	assert.deepEqual(withoutManifest, [], "connector directories with no manifest.json");
});

test("per-scope JSON schemas under connectors/ are exactly the frozen shapes", () => {
	const frozen = new Set(
		JSON.parse(read("legacy-shapes.json")).scopes.map((scope) => scope.schemaPath),
	);
	assert.deepEqual(
		offenders(
			(file) =>
				/^connectors\/[^/]+\/schemas\/[^/]+\.json$/.test(file) &&
				!frozen.has(file),
		),
		[],
	);
});

test("no workflow or package script restores a legacy lane", () => {
	const lane =
		/connectors-latest|publish-connector-release-index|scope-catalog|connector-index\.json|legacy-retention|oura-retention|-playwright\.(?:js|json)/;
	const workflows = tracked.filter((file) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(file));
	assert.deepEqual(
		workflows.filter((file) => lane.test(read(file))),
		[],
	);
	const scripts = JSON.parse(read("package.json")).scripts;
	assert.deepEqual(
		Object.entries(scripts)
			.filter(
				([name, command]) =>
					(/legacy|retention/.test(name) && !name.startsWith("legacy-shapes:")) ||
					lane.test(command),
			)
			.map(([name]) => name),
		[],
	);
});

test("connector sources do not speak the legacy page API", () => {
	// Connectors emit protocol records. Only the PageShim host adapter maps
	// those onto the old `page.setData("result", ...)` shape.
	const sources = offenders(
		(file) =>
			/^connectors\/[^/]+\/.*\.(?:ts|js|mjs|cjs)$/.test(file) &&
			!/\.test\.(?:ts|mjs|cjs)$/.test(file) &&
			!file.includes("/__fixtures__/") &&
			!file.includes("/fixtures/"),
	);
	assert.deepEqual(
		sources.filter((file) => /\bpage\.setData\(/.test(read(file))),
		[],
	);
});

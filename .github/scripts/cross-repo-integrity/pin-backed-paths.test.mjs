// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";

import { isPinBackedPath, touchesPinBackedPaths } from "./pin-backed-paths.mjs";

const fixtures = [
	{
		name: "the pin file is actionable for either producer",
		paths: [".github/cross-repo-pins.json"],
		dataConnect: true,
		pdpp: true,
	},
	{
		name: "the collector registry backs data-connect freshness",
		paths: ["packages/polyfill-connectors/src/collector-registry.ts"],
		dataConnect: true,
		pdpp: false,
	},
	{
		name: "a compared bundled connector source backs data-connect freshness",
		paths: ["packages/polyfill-connectors/connectors/codex/parsers.ts"],
		dataConnect: true,
		pdpp: false,
	},
	{
		name: "test-only and fixture-only connector changes do not back the drift job",
		paths: [
			"packages/polyfill-connectors/connectors/codex/parsers.test.ts",
			"packages/polyfill-connectors/connectors/codex/__fixtures__/sample.json",
		],
		dataConnect: false,
		pdpp: false,
	},
	{
		name: "an unbundled connector does not back data-connect freshness",
		paths: ["packages/polyfill-connectors/connectors/signal/parsers.ts"],
		dataConnect: false,
		pdpp: false,
	},
	{
		name: "data-connect tarball inputs back the data-connect pin",
		paths: ["packages/polyfill-connectors/vendor/pdpp-collector-runtime-0.0.1.tgz"],
		dataConnect: true,
		pdpp: false,
	},
	{
		name: "the reference-contract stand-in tarball backs the pdpp pin",
		paths: ["packages/polyfill-connectors/vendor/pdpp-reference-contract-0.0.1.tgz"],
		dataConnect: false,
		pdpp: true,
	},
	{
		name: "unrelated repository files are not pin-backed",
		paths: ["README.md", ".github/workflows/cross-repo-integrity.yml"],
		dataConnect: false,
		pdpp: false,
	},
];

for (const fixture of fixtures) {
	test(fixture.name, () => {
		assert.equal(touchesPinBackedPaths(fixture.paths, "data-connect"), fixture.dataConnect);
		assert.equal(touchesPinBackedPaths(fixture.paths, "pdpp"), fixture.pdpp);
	});
}

test("single-path predicate is strict about non-path inputs", () => {
	assert.equal(isPinBackedPath("packages/polyfill-connectors/vendor/README.md", "data-connect"), false);
	assert.equal(isPinBackedPath("packages/polyfill-connectors/connectors/codex/fixtures.ts", "data-connect"), true);
});

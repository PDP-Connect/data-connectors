// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import {
	connectorDir,
	connectorEntrypoint,
	connectorsDir,
	fixturesDir,
	fixturesRootDir,
	iconPath,
	iconsDir,
	manifestPath,
	manifestsDir,
	packageRoot,
	repoRoot,
} from "./connector-paths.ts";

test("packageRoot is this package's own root, containing package.json", () => {
	assert.equal(basename(packageRoot), "polyfill-connectors");
	assert.ok(existsSync(`${packageRoot}/package.json`));
});

test("repoRoot is the repository root, containing the root package.json", () => {
	assert.ok(existsSync(`${repoRoot}/package.json`));
	assert.ok(existsSync(`${repoRoot}/packages/polyfill-connectors/package.json`));
});

test("manifestsDir and connectorsDir point at the real, current-layout directories", () => {
	assert.ok(existsSync(manifestsDir));
	assert.ok(existsSync(connectorsDir));
	assert.ok(readdirSync(manifestsDir).some((f) => f.endsWith(".json")));
});

test("iconsDir is manifestsDir/icons", () => {
	assert.ok(existsSync(iconsDir));
	assert.equal(iconsDir, `${manifestsDir}/icons`);
});

test("connectorDir(key) and connectorEntrypoint(key) resolve a real connector", () => {
	assert.ok(existsSync(connectorDir("amazon")));
	assert.ok(existsSync(connectorEntrypoint("amazon")));
});

test("manifestPath(key) resolves a real shipped manifest", () => {
	assert.ok(existsSync(manifestPath("amazon")));
});

test("iconPath resolves both a bare filename and a manifest-style 'icons/x.svg' value the same way", () => {
	assert.equal(iconPath("amazon.svg"), iconPath("icons/amazon.svg"));
	assert.ok(existsSync(iconPath("amazon.svg")));
});

test("fixturesDir(key) and fixturesRootDir agree", () => {
	assert.equal(fixturesDir("amazon"), `${fixturesRootDir}/amazon`);
});

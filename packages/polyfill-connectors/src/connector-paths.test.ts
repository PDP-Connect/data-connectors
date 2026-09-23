// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import test from "node:test";
import {
	connectorDir,
	connectorEntrypoint,
	connectorsDir,
	fixturesDir,
	iconPath,
	manifestFileNames,
	manifestPath,
	packageRoot,
	repoRoot,
} from "./connector-paths.ts";

test("packageRoot is this package's own root, containing package.json", () => {
	assert.equal(basename(packageRoot), "polyfill-connectors");
	assert.ok(existsSync(`${packageRoot}/package.json`));
});

test("repoRoot is the repository root, containing the root package.json", () => {
	assert.ok(existsSync(`${repoRoot}/package.json`));
	assert.ok(
		existsSync(`${repoRoot}/packages/polyfill-connectors/package.json`),
	);
});

test("connectorsDir holds shipped manifests", () => {
	assert.ok(existsSync(connectorsDir));
	assert.ok(manifestFileNames().includes("amazon.json"));
});

test("each connector icon is beside its manifest", () => {
	assert.equal(
		iconPath("amazon", "icon.svg"),
		`${connectorDir("amazon")}/icon.svg`,
	);
});

test("connectorDir(key) and connectorEntrypoint(key) resolve a real connector", () => {
	assert.ok(existsSync(connectorDir("amazon")));
	assert.ok(existsSync(connectorEntrypoint("amazon")));
});

test("manifestPath(key) resolves a real shipped manifest", () => {
	assert.ok(existsSync(manifestPath("amazon")));
});

test("iconPath resolves the manifest's icon filename", () => {
	assert.ok(existsSync(iconPath("amazon", "icon.svg")));
});

test("fixturesDir(key) is within the connector directory", () => {
	assert.equal(fixturesDir("amazon"), `${connectorDir("amazon")}/fixtures`);
});

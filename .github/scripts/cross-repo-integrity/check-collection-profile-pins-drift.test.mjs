// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { compareCollectionProfilePins } from "./check-collection-profile-pins-drift.mjs";

const SCRIPT = fileURLToPath(new URL("./check-collection-profile-pins-drift.mjs", import.meta.url));
// A copy of data-connect's real pins file (data-connect@40dfeb5), kept so the CLI test reads
// the same file shape the workflow does without a data-connect checkout.
const REAL_PINS_FILE = fileURLToPath(new URL("./fixtures/collection-profile-pins.generated.ts", import.meta.url));
const PINS_RELATIVE_PATH = "packages/local-collector/src/generated/collection-profile-pins.generated.ts";

const definitions = [{ connector_id: "alpha" }, { connector_id: "beta" }, { connector_id: "gamma" }];
const inventory = [
	{ manifest: "alpha", connectorKey: "alpha", exclusionReason: null },
	{ manifest: "beta", connectorKey: "beta-key", exclusionReason: null },
	{ manifest: "gamma", connectorKey: "gamma", exclusionReason: "No profile is published yet." },
	{ manifest: "unregistered", connectorKey: "unregistered", exclusionReason: null },
];
const pins = [
	{ connectorId: "alpha", connectorKey: "alpha" },
	{ connectorId: "beta", connectorKey: "beta-key" },
];

function compare(overrides = {}) {
	return compareCollectionProfilePins({ definitions, inventory, pins, ...overrides });
}

test("a consistent registry, inventory and pin set passes and notes the excluded connector", () => {
	const { failures, notes } = compare();
	assert.deepEqual(failures, []);
	assert.equal(notes.length, 1);
	assert.match(notes[0], /gamma.*No profile is published yet\./);
});

test("rule a: a publishable registry connector without a pin fails", () => {
	const { failures } = compare({ pins: pins.filter((pin) => pin.connectorId !== "beta") });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /^beta: .*no Collection Profile pin/);
});

test("rule a: a pin whose connectorKey differs from the inventory fails", () => {
	const { failures } = compare({
		pins: [{ connectorId: "alpha", connectorKey: "alpha" }, { connectorId: "beta", connectorKey: "beta" }],
	});
	assert.equal(failures.length, 1);
	assert.match(failures[0], /^beta: .*'beta'.*'beta-key'/);
});

test("rule b: a pin for an excluded connector fails and names the reason", () => {
	const { failures, notes } = compare({ pins: [...pins, { connectorId: "gamma", connectorKey: "gamma" }] });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /^gamma: .*No profile is published yet\./);
	assert.deepEqual(notes, []);
});

test("rule c: a registry connector missing from the inventory fails", () => {
	const { failures } = compare({ definitions: [...definitions, { connector_id: "delta" }] });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /^delta: .*not in the publish inventory/);
});

test("rule d: a pin for a connector outside the registry fails", () => {
	const { failures } = compare({ pins: [...pins, { connectorId: "unregistered", connectorKey: "unregistered" }] });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /^unregistered: .*not declared in the collector registry/);
});

test("rule e: duplicate pins for one connector fail", () => {
	const { failures } = compare({ pins: [...pins, { connectorId: "alpha", connectorKey: "alpha" }] });
	assert.equal(failures.length, 1);
	assert.match(failures[0], /^alpha: pinned 2 times/);
});

test("every violation is reported, not just the first", () => {
	const { failures } = compare({
		definitions: [...definitions, { connector_id: "delta" }],
		pins: [{ connectorId: "alpha", connectorKey: "wrong" }, { connectorId: "ghost", connectorKey: "ghost" }],
	});
	assert.equal(failures.length, 4);
	assert.ok(failures.some((failure) => failure.startsWith("alpha:")));
	assert.ok(failures.some((failure) => failure.startsWith("beta:")));
	assert.ok(failures.some((failure) => failure.startsWith("delta:")));
	assert.ok(failures.some((failure) => failure.startsWith("ghost:")));
});

// The CLI test builds both checkouts in a temp dir, so it does not depend on the real
// registry growing a connector: only the pins file is real, the other two inputs are the
// smallest modules that export what the CLI imports.
function withFixtureCheckouts(editPins, run) {
	const root = mkdtempSync(join(tmpdir(), "pins-drift-"));
	try {
		const dataConnect = join(root, "data-connect");
		const dataConnectors = join(root, "data-connectors");

		const pinsText = readFileSync(REAL_PINS_FILE, "utf8");
		const editedPins = editPins(pinsText);
		mkdirSync(join(dataConnect, dirname(PINS_RELATIVE_PATH)), { recursive: true });
		writeFileSync(join(dataConnect, PINS_RELATIVE_PATH), editedPins);

		const ids = ["claude_code", "codex", "google_takeout", "imessage", "apple_photos", "google_messages"];
		mkdirSync(join(dataConnectors, "packages/polyfill-connectors/src"), { recursive: true });
		writeFileSync(
			join(dataConnectors, "packages/polyfill-connectors/src/collector-registry.ts"),
			`export const LOCAL_COLLECTOR_DEFINITIONS: readonly { connector_id: string }[] = ${JSON.stringify(ids.map((connector_id) => ({ connector_id })))};\n`,
		);
		mkdirSync(join(dataConnectors, "scripts"), { recursive: true });
		const inventory = ids.map((manifest) => ({
			manifest,
			connectorKey: manifest.replaceAll("_", "-"),
			exclusionReason: manifest === "google_messages" ? "No profile is published yet." : null,
		}));
		writeFileSync(
			join(dataConnectors, "scripts/connector-publish-allowlist.mjs"),
			`export const CONNECTOR_PUBLISH_INVENTORY = ${JSON.stringify(inventory)};\n`,
		);

		return { pinsText, editedPins, result: run(dataConnect, dataConnectors) };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function runCli(dataConnectDir, dataConnectorsDir) {
	return spawnSync(process.execPath, [SCRIPT, dataConnectDir, dataConnectorsDir], { encoding: "utf8" });
}

test("CLI passes on the real pins file and notes the unpinned excluded connector", () => {
	const { result } = withFixtureCheckouts((text) => text, runCli);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /^NOTE: google_messages: excluded from publishing/m);
	assert.match(result.stdout, /^OK: 5 Collection Profile pins match the 6 registry connectors/m);
});

test("CLI exits 1 and names the connector when a pin is removed", () => {
	const { pinsText, editedPins, result } = withFixtureCheckouts(
		(text) => text.replace(/\s*\{\s*"connectorId": "codex",[^}]*\},?/, ""),
		runCli,
	);
	// Without this the CLI could exit 0 on an untouched file and the test would say so for the wrong reason.
	assert.notEqual(editedPins, pinsText, "the string edit did not remove the codex pin");
	assert.ok(!editedPins.includes('"connectorId": "codex"'));
	assert.equal(result.status, 1);
	assert.match(result.stderr, /FAIL:/);
	assert.match(result.stderr, /codex: .*no Collection Profile pin/);
});

test("CLI exits 1 with a clear message when an input file is missing", () => {
	const root = mkdtempSync(join(tmpdir(), "pins-drift-empty-"));
	try {
		const result = runCli(root, root);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /^FAIL: data-connect Collection Profile pins not found at /m);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

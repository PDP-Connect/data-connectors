// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the seam does what the guard alone cannot: not just that every file
 * ROUTES through connector-paths.ts, but that the routing is real — point the
 * seam at a different on-disk layout (`PDPP_CONNECTOR_PATHS_TEST_ROOT`, a
 * test-only override documented in connector-paths.ts) and confirm every
 * consumer the guard protects actually follows it to the new location:
 * manifest-registry's manifest discovery, the scrubber's connector-rule
 * loading, and connector-entrypoint resolution.
 *
 * The alternate layout mirrors the real one one level down:
 * `<tmp>/connectors/<key>/` and `<tmp>/manifests/<key>.json`, so a future
 * real layout move (root `connectors/<key>/`) is exactly the shape this test
 * already exercises.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	connectorDir,
	connectorEntrypoint,
	manifestPath,
} from "./connector-paths.ts";
import { readPolyfillManifests } from "./manifest-registry.ts";
import { loadConnectorScrubRules } from "./scrubber.ts";

const ENV_VAR = "PDPP_CONNECTOR_PATHS_TEST_ROOT";

function withRelocatedRoot(root: string, fn: () => void): void {
	const previous = process.env[ENV_VAR];
	process.env[ENV_VAR] = root;
	try {
		fn();
	} finally {
		if (previous === undefined) {
			delete process.env[ENV_VAR];
		} else {
			process.env[ENV_VAR] = previous;
		}
	}
}

async function withRelocatedRootAsync(
	root: string,
	fn: () => Promise<void>,
): Promise<void> {
	const previous = process.env[ENV_VAR];
	process.env[ENV_VAR] = root;
	try {
		await fn();
	} finally {
		if (previous === undefined) {
			delete process.env[ENV_VAR];
		} else {
			process.env[ENV_VAR] = previous;
		}
	}
}

function makeAlternateLayout(): string {
	const root = mkdtempSync(join(tmpdir(), "connector-paths-relocation-"));
	const probeDir = join(root, "connectors", "probe_connector");
	mkdirSync(probeDir, { recursive: true });
	writeFileSync(
		join(probeDir, "index.ts"),
		"export const marker = 'relocated-probe-connector';\n",
	);
	writeFileSync(
		join(probeDir, "scrub-rules.ts"),
		[
			"export const scrubRules = [",
			"  { pattern: /RELOCATED_SECRET/g, replacement: '[REDACTED_PROBE]', scope: 'all' },",
			"];",
			"",
		].join("\n"),
	);
	mkdirSync(join(root, "manifests"), { recursive: true });
	writeFileSync(
		join(root, "manifests", "probe_connector.json"),
		JSON.stringify({ key: "probe_connector", streams: [] }, null, 2),
	);
	return root;
}

test("connectorDir/connectorEntrypoint/manifestPath resolve under a relocated root", () => {
	const root = makeAlternateLayout();
	try {
		withRelocatedRoot(root, () => {
			assert.equal(
				connectorDir("probe_connector"),
				join(root, "connectors", "probe_connector"),
			);
			assert.equal(
				connectorEntrypoint("probe_connector"),
				join(root, "connectors", "probe_connector", "index.ts"),
			);
			assert.equal(
				manifestPath("probe_connector"),
				join(root, "manifests", "probe_connector.json"),
			);
		});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("manifest-registry discovers manifests from the relocated root", () => {
	const root = makeAlternateLayout();
	try {
		withRelocatedRoot(root, () => {
			const entries = readPolyfillManifests();
			assert.equal(entries.length, 1);
			assert.equal(entries[0]?.file, "probe_connector.json");
			assert.deepEqual(entries[0]?.manifest, {
				key: "probe_connector",
				streams: [],
			});
		});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("the scrubber loads a connector's scrub-rules.ts from the relocated root", async () => {
	const root = makeAlternateLayout();
	try {
		await withRelocatedRootAsync(root, async () => {
			const rules = await loadConnectorScrubRules("probe_connector");
			assert.equal(rules.length, 1);
			assert.equal(rules[0]?.replacement, "[REDACTED_PROBE]");
			assert.ok(rules[0]?.pattern.test("RELOCATED_SECRET"));
		});
	} finally {
		rmSync(root, { force: true, recursive: true });
	}
});

test("the override does not affect the real, unrelocated defaults once unset", () => {
	assert.ok(!connectorDir("amazon").includes("connector-paths-relocation-"));
});

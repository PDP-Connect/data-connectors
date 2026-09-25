// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Build-time guardrail: every top-level connector manifest stream declares how
 * coverage and freshness evidence are established. These fields are strategy
 * declarations, not owner-facing state. The runtime/projection still needs
 * observed facts before it can classify a stream complete/current.
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	manifestFileNames,
	manifestPath,
	repoRoot,
} from "./connector-paths.ts";

const MANIFEST_DIRS = [
	{
		label: "reference",
		path: join(
			repoRoot,
			"reference-implementation",
			"fixtures",
			"seed-manifests",
		),
	},
];

const VALID_COVERAGE_STRATEGIES = new Set([
	"checkpoint_window",
	"full_inventory",
	"parent_detail_accounting",
	"snapshot_import_receipt",
	"singleton_presence",
]);

const VALID_FRESHNESS_STRATEGIES = new Set([
	"device_heartbeat",
	"manual_as_of",
	"not_trackable",
	"scheduled_window",
	"source_reported_as_of",
]);

const VALID_STREAM_SEMANTICS = new Set(["append_only", "mutable_state"]);

interface ManifestStream {
	coverage_strategy?: unknown;
	freshness_strategy?: unknown;
	name?: unknown;
	semantics?: unknown;
	[key: string]: unknown;
}

interface ConnectorManifest {
	streams?: ManifestStream[];
	[key: string]: unknown;
}

function readManifests(): Array<{
	connectorKey: string;
	manifest: ConnectorManifest;
}> {
	const manifests: Array<{
		connectorKey: string;
		manifest: ConnectorManifest;
	}> = [];
	for (const filename of manifestFileNames()) {
		const key = filename.replace(/\.json$/, "");
		manifests.push({
			connectorKey: `polyfill/${key}`,
			manifest: JSON.parse(
				readFileSync(manifestPath(key), "utf8"),
			) as ConnectorManifest,
		});
	}
	for (const dir of MANIFEST_DIRS) {
		if (!existsSync(dir.path)) {
			continue;
		}
		for (const filename of readdirSync(dir.path).sort()) {
			if (!filename.endsWith(".json")) {
				continue;
			}
			const manifestPath = join(dir.path, filename);
			manifests.push({
				connectorKey: `${dir.label}/${filename.replace(/\.json$/, "")}`,
				manifest: JSON.parse(
					readFileSync(manifestPath, "utf8"),
				) as ConnectorManifest,
			});
		}
	}
	return manifests;
}

function streamSemanticsViolations(
	manifests = readManifests(),
): string[] {
	const violations: string[] = [];
	for (const { connectorKey, manifest } of manifests) {
		for (const stream of manifest.streams ?? []) {
			const streamName = String(stream.name ?? "<missing>");
			if (!VALID_STREAM_SEMANTICS.has(stream.semantics as string)) {
				violations.push(
					`${connectorKey}.${streamName}: semantics must be one of ${[...VALID_STREAM_SEMANTICS].join(" | ")}`,
				);
			}
		}
	}
	return violations;
}

test("connector manifest streams declare valid coverage and freshness evidence strategies", () => {
	const violations: string[] = [];
	for (const { connectorKey, manifest } of readManifests()) {
		for (const stream of manifest.streams ?? []) {
			const streamName = String(stream.name ?? "<missing>");
			if (!VALID_COVERAGE_STRATEGIES.has(stream.coverage_strategy as string)) {
				violations.push(
					`${connectorKey}.${streamName}: coverage_strategy must be one of ${[...VALID_COVERAGE_STRATEGIES].join(" | ")}`,
				);
			}
			if (
				!VALID_FRESHNESS_STRATEGIES.has(stream.freshness_strategy as string)
			) {
				violations.push(
					`${connectorKey}.${streamName}: freshness_strategy must be one of ${[...VALID_FRESHNESS_STRATEGIES].join(" | ")}`,
				);
			}
		}
	}

	assert.deepEqual(
		violations,
		[],
		"Every top-level manifest stream must declare coverage/freshness strategy",
	);
});

test("connector manifest streams declare valid stream semantics", () => {
	assert.deepEqual(
		streamSemanticsViolations(),
		[],
		"Every top-level manifest stream must declare valid stream semantics",
	);
});

test("connector manifest stream semantics reject unknown values such as append", () => {
	const root = mkdtempSync(join(tmpdir(), "pdpp-manifest-semantics-"));
	const prior = process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
	try {
		const connectorDir = join(root, "connectors", "probe");
		mkdirSync(connectorDir, { recursive: true });
		writeFileSync(
			join(connectorDir, "manifest.json"),
			JSON.stringify({
				streams: [
					{
						name: "items",
						semantics: "append",
						coverage_strategy: "full_inventory",
						freshness_strategy: "scheduled_window",
					},
				],
			}),
		);
		process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT = root;

		assert.deepEqual(streamSemanticsViolations(), [
			"polyfill/probe.items: semantics must be one of append_only | mutable_state",
		]);
	} finally {
		if (prior === undefined) {
			delete process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT;
		} else {
			process.env.PDPP_CONNECTOR_PATHS_TEST_ROOT = prior;
		}
		rmSync(root, { force: true, recursive: true });
	}
});

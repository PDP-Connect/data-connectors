// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `capabilities.proven.local_collector: true` is a claim that this connector's
// local (device-side) collection path exists and runs. The thing that makes it
// run is membership in {@link LOCAL_COLLECTOR_DEFINITIONS} — the registry the
// published `@pdpp/local-collector` runtime discovers definitions from. A
// connector outside that registry has no collector at run time, whatever its
// source tree contains.
//
// So file presence is the wrong oracle. `connectors/<id>/collector-definition.ts`
// can exist, export a complete and valid definition, and still never reach the
// runtime, because the registry is deliberately gated: a definition is only
// added once `data-connect`'s vendored snapshot can accept it (see the Signal
// note in `collector-registry.ts`). A test that asserted the file exists would
// have passed while the manifest advertised a collector no owner could run.
//
// `src/collector-scope-manifest-honesty.test.ts` pins registry -> manifest.
// This file pins the other direction, manifest -> registry, so a `proven`
// claim cannot outrun the registration that makes it true. Both directions are
// discovered rather than named, so a future local collector is covered the day
// it ships.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LOCAL_COLLECTOR_DEFINITIONS } from "./collector-registry.ts";

interface ConnectorManifest {
	capabilities?: {
		proven?: {
			local_collector?: unknown;
		};
	};
}

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "..", "manifests");

const manifestNames = readdirSync(MANIFESTS_DIR)
	.filter((name) => name.endsWith(".json"))
	.sort();

function readManifest(name: string): ConnectorManifest {
	return JSON.parse(
		readFileSync(join(MANIFESTS_DIR, name), "utf8"),
	) as ConnectorManifest;
}

/**
 * The connector id a manifest filename stands for. The registry keys on
 * `connector_id`, and every shipped manifest is named `<connector_id>.json`.
 */
function connectorId(manifestName: string): string {
	return manifestName.slice(0, -".json".length);
}

const registeredIds = new Set(
	LOCAL_COLLECTOR_DEFINITIONS.map((definition) => definition.connector_id),
);

test("every manifest claiming a proven local collector is wired into the registry", () => {
	assert.ok(manifestNames.length > 0, "no manifests were discovered");
	assert.ok(
		registeredIds.size > 0,
		"no local collector definitions were discovered",
	);

	const unbacked: string[] = [];
	for (const name of manifestNames) {
		const claim = readManifest(name).capabilities?.proven?.local_collector;
		if (claim !== true) {
			continue;
		}
		if (!registeredIds.has(connectorId(name))) {
			unbacked.push(connectorId(name));
		}
	}

	assert.deepEqual(
		unbacked,
		[],
		"capabilities.proven.local_collector=true declared with no LOCAL_COLLECTOR_DEFINITIONS entry: " +
			`${unbacked.join(", ")}. A proven claim must name a collector the runtime can actually ` +
			"discover — register the definition, or drop the claim until it lands.",
	);
});

test("every registered local collector's manifest declares the proven claim", () => {
	// The reverse leak: a registered collector whose manifest stays silent
	// under-reports a capability owners can already use, and lets the pair drift
	// apart from the other side.
	const claimedIds = new Set(
		manifestNames
			.filter(
				(name) =>
					readManifest(name).capabilities?.proven?.local_collector === true,
			)
			.map(connectorId),
	);

	const unclaimed = [...registeredIds]
		.filter((id) => !claimedIds.has(id))
		.sort();

	assert.deepEqual(
		unclaimed,
		[],
		`registered in LOCAL_COLLECTOR_DEFINITIONS but missing capabilities.proven.local_collector=true: ${unclaimed.join(", ")}`,
	);
});

test("the proven local_collector claim is a boolean, never a truthy stand-in", () => {
	// `proven` is not uniformly boolean across keys — `static_secret_live` is an
	// object with its own nested `proven` field. Pinning the type here keeps a
	// future author from writing `local_collector: { proven: true }` and slipping
	// past the strict `=== true` membership checks above unnoticed.
	for (const name of manifestNames) {
		const claim = readManifest(name).capabilities?.proven?.local_collector;
		if (claim === undefined) {
			continue;
		}
		assert.equal(
			typeof claim,
			"boolean",
			`${connectorId(name)}: capabilities.proven.local_collector must be a boolean, got ${typeof claim}`,
		);
	}
});
